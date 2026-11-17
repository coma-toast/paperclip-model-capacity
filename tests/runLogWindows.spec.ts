import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findRateLimitInfo, readRunLogWindows, RUN_LOG_LABEL, windowsFromInfo, withRunLogWindows } from "../src/runLogWindows.js";
import { subscriptionExhausted, type SubscriptionSample } from "../src/subscriptions.js";

// JD-1245: Claude's 5-hour and weekly windows from Claude Code run logs. The line shape is Paperclip's run log as seen
// on the host on 2026-11-17: {ts, attemptId, stream, chunk, seq}, where chunk holds Claude Code's own JSON line.
const NOW = new Date("2026-11-17T12:00:00.000Z");
const RESET_5H = Date.parse("2026-11-17T15:00:00.000Z") / 1000;
const RESET_7D = Date.parse("2026-11-18T17:00:00.000Z") / 1000;

const event = (five: number, seven: number, extra: Record<string, unknown> = {}) => ({
  type: "rate_limit_event", uuid: "u", session_id: "s",
  rate_limit_info: {
    status: "allowed", resetsAt: RESET_5H, rateLimitType: "five_hour", overageStatus: "allowed", overageResetsAt: Date.parse("2026-12-01T00:00:00Z") / 1000, isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: five, resetsAt: RESET_5H, status: "allowed" }, seven_day: { utilization: seven, resetsAt: RESET_7D, status: "allowed" } },
    ...extra,
  },
});
const logLine = (inner: unknown, seq = 1) => JSON.stringify({ ts: NOW.toISOString(), attemptId: "a", stream: "stdout", chunk: `${JSON.stringify(inner)}\n`, seq });

describe("findRateLimitInfo", () => {
  it("finds the newest event inside stdout chunks", () => {
    const text = [logLine({ type: "system", subtype: "init" }), logLine(event(0.04, 0.3)), logLine({ type: "assistant" }), logLine(event(0.65, 0.37), 4)].join("\n");
    expect(findRateLimitInfo(text)?.unifiedWindows?.five_hour?.utilization).toBe(0.65);
  });

  it("ignores a line cut by the tail read", () => {
    expect(findRateLimitInfo(logLine(event(0.5, 0.5)).slice(20))).toBeUndefined();
  });
});

describe("windowsFromInfo", () => {
  it("gives the 5-hour and weekly windows as percentages, plus overage", () => {
    const w = windowsFromInfo(event(0.645, 0.37).rate_limit_info, NOW.toISOString());
    expect(w.map((x) => [x.label, x.usedPercent, x.resetsAt])).toEqual([
      [`5-hour (${RUN_LOG_LABEL})`, 64.5, "2026-11-17T15:00:00.000Z"],
      [`Weekly (${RUN_LOG_LABEL})`, 37, "2026-11-18T17:00:00.000Z"],
      [`Extra usage allowed (${RUN_LOG_LABEL})`, null, "2026-12-01T00:00:00.000Z"],
    ]);
  });

  it("reads a rejected window over 100 % and overage in use", () => {
    const w = windowsFromInfo(event(1.05, 0.9, { status: "rejected", isUsingOverage: true }).rate_limit_info, NOW.toISOString());
    expect(w[0].usedPercent).toBe(105);
    expect(w[2]).toMatchObject({ label: `Extra usage in use (${RUN_LOG_LABEL})`, overage: { status: "allowed", inUse: true } });
  });
});

describe("readRunLogWindows", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const write = async (agent: string, run: string, lines: string[], mtime: Date) => {
    const folder = join(dir!, "c1", agent);
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${run}.ndjson`);
    await writeFile(path, `${lines.join("\n")}\n`);
    await utimes(path, mtime, mtime);
  };

  it("takes the newest run that reported windows, across agents", async () => {
    dir = await mkdtemp(join(tmpdir(), "runlogs-"));
    await write("monica", "r1", [logLine(event(0.2, 0.3))], new Date("2026-11-17T10:00:00Z"));
    await write("holt", "r2", [logLine(event(0.64, 0.37))], new Date("2026-11-17T11:48:00Z"));
    await write("holt", "r3", [logLine({ type: "assistant" })], new Date("2026-11-17T11:59:00Z"));
    const account = await readRunLogWindows("c1", { dir, now: NOW });
    expect(account).toMatchObject({ provider: "anthropic", ok: true });
    expect(account?.windows[0]).toMatchObject({ usedPercent: 64, asOf: "2026-11-17T11:48:00.000Z" });
  });

  it("returns nothing for a company with no logs, and an error account when it can't read", async () => {
    dir = await mkdtemp(join(tmpdir(), "runlogs-"));
    expect(await readRunLogWindows("c1", { dir, now: NOW })).toBeUndefined();
    await writeFile(join(dir, "c2"), "not a folder");
    expect(await readRunLogWindows("c2", { dir, now: NOW })).toMatchObject({ ok: false });
  });
});

describe("withRunLogWindows and pausing", () => {
  // Slide on 2026-11-17: Paperclip shows the Claude account with only its extra-usage pool.
  const paperclip: SubscriptionSample = {
    sampledAt: NOW.toISOString(), ok: true,
    accounts: [
      { provider: "anthropic", ok: true, windows: [{ label: "Extra usage", usedPercent: 0, resetsAt: "2026-12-01T00:00:00Z" }] },
      { provider: "openai", ok: true, windows: [{ label: "5h limit", usedPercent: 6, resetsAt: "2026-11-17T21:12:00Z" }] },
    ],
  };
  const fromRuns = (five: number) => ({ provider: "anthropic", accountLabel: "Claude (runs)", ok: true, windows: windowsFromInfo(event(five, 0.37).rate_limit_info, NOW.toISOString()) });

  it("adds the 5-hour and weekly windows to Paperclip's Claude account, without a second extra-usage window", () => {
    const merged = withRunLogWindows(paperclip, fromRuns(0.5));
    expect(merged.accounts).toHaveLength(2);
    expect(merged.accounts[0].windows.map((w) => w.label)).toEqual(["Extra usage", `5-hour (${RUN_LOG_LABEL})`, `Weekly (${RUN_LOG_LABEL})`]);
  });

  it("leaves out a run-log window Paperclip already reports", () => {
    const withWeek: SubscriptionSample = { ...paperclip, accounts: [{ ...paperclip.accounts[0], windows: [...paperclip.accounts[0].windows, { label: "Current week (all models)", usedPercent: 40, resetsAt: null }] }, paperclip.accounts[1]] };
    expect(withRunLogWindows(withWeek, fromRuns(0.5)).accounts[0].windows.map((w) => w.label)).toEqual(["Extra usage", "Current week (all models)", `5-hour (${RUN_LOG_LABEL})`]);
  });

  it("pauses a Claude pool at 90 % by default, not at 85 %, and says so", () => {
    expect(subscriptionExhausted(withRunLogWindows(paperclip, fromRuns(0.85)), "anthropic", NOW, { atPercent: 90 })).toBeUndefined();
    const at92 = subscriptionExhausted(withRunLogWindows(paperclip, fromRuns(0.92)), "anthropic", NOW, { atPercent: 90 });
    expect(at92).toMatchObject({ until: "2026-11-17T15:00:00.000Z", reason: `Claude subscription 5-hour (${RUN_LOG_LABEL}) at 92 % (pauses at 90 %)` });
    expect(subscriptionExhausted(withRunLogWindows(paperclip, fromRuns(1)), "anthropic", NOW, { atPercent: 90 })?.reason).toMatch(/used up$/);
  });

  it("limits every Claude model, not a model family named after the source", () => {
    expect(subscriptionExhausted(withRunLogWindows(paperclip, fromRuns(0.95)), "anthropic", NOW, { model: "claude-opus-5-5", atPercent: 90 })).toBeDefined();
  });

  it("ignores a reading whose window has already reset", () => {
    const later = new Date("2026-11-17T15:30:00.000Z");
    expect(subscriptionExhausted(withRunLogWindows(paperclip, fromRuns(0.99)), "anthropic", later, { atPercent: 90 })).toBeUndefined();
  });

  it("keeps a model allowed on extra usage running until the extra-usage pool is used up", () => {
    expect(subscriptionExhausted(withRunLogWindows(paperclip, fromRuns(0.99)), "anthropic", NOW, { atPercent: 90, overQuota: true })).toBeUndefined();
  });
});
