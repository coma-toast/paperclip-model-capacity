import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGY_CACHE_MS, agyEnv, agyExhausted, agyModelGroup, clearAgyCache, parseAgyUsage, readAgyUsage } from "../src/agyUsage.js";
import { meterText } from "../src/ui/components/usage.js";
import { sampleUsage } from "../src/usage.js";

const FIXTURE = readFileSync(new URL("./fixtures/agy-usage.json", import.meta.url), "utf8");
const NOW = new Date("2026-11-22T00:00:00Z");
const backend = { id: "agy", name: "Antigravity", type: "cli", adapterType: "agy_local" } as const;

beforeEach(() => clearAgyCache());

describe("parseAgyUsage", () => {
  it("makes one percent meter per bucket, labelled group · window", () => {
    const m = parseAgyUsage(FIXTURE);
    expect(m.map((x) => x.label)).toEqual([
      "Gemini Models · weekly", "Gemini Models · 5 h", "Claude and GPT models · weekly", "Claude and GPT models · 5 h", "Gemini 4 Argon · weekly",
    ]);
    expect(m[0]).toMatchObject({ unit: "percent", limit: 100, group: "Gemini Models", resetAt: "2026-11-28T13:35:47Z" });
    expect(m[0].remaining).toBeCloseTo(83.17);
    expect(m[0].used).toBeCloseTo(16.83);
    expect(m[2].remaining).toBeCloseTo(0.255);
  });
  it("ignores text before the JSON and rejects other output", () => {
    expect(parseAgyUsage(`warning\n${FIXTURE}`)).toHaveLength(5);
    expect(() => parseAgyUsage("nope")).toThrow(/no JSON/);
    expect(() => parseAgyUsage("{bad")).toThrow(/couldn't be read/);
    expect(() => parseAgyUsage('{"status":"ERROR"}')).toThrow(/status ERROR/);
    expect(() => parseAgyUsage('{"status":"SUCCESS","command":{"data":{"groups":[]}}}')).toThrow(/no limits/);
  });
  it("shows the share left and when it resets", () => {
    const [m] = parseAgyUsage(FIXTURE);
    expect(meterText({ ...m, resetAt: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString() })).toMatch(/^83\.2% left · resets in /);
  });
});

describe("sampleUsage for agy", () => {
  it("reports the meters from agy's output", async () => {
    const runAgy = vi.fn(async () => FIXTURE);
    const r = await sampleUsage({ ...backend, command: "/opt/agy" }, { fetch, now: () => NOW, runAgy });
    expect(r.ok).toBe(true);
    expect(r.meters).toHaveLength(5);
    expect(runAgy).toHaveBeenCalledWith("/opt/agy", ["-p", "/usage", "--output-format", "json"], 30_000);
  });
  it("says usage is unavailable, with the error, instead of throwing", async () => {
    const r = await sampleUsage(backend, { fetch, now: () => NOW, runAgy: async () => { throw new Error("agy not found on the worker's PATH"); } });
    expect(r).toMatchObject({ ok: false, meters: [], error: "usage unavailable: agy not found on the worker's PATH" });
    clearAgyCache();
    const bad = await sampleUsage(backend, { fetch, now: () => NOW, runAgy: async () => "garbage" });
    expect(bad.error).toBe("usage unavailable: agy printed no JSON");
  });
  it("starts agy at most once per cache window, failures included", async () => {
    let t = NOW.getTime();
    const now = () => new Date(t);
    const run = vi.fn(async () => FIXTURE);
    await readAgyUsage(undefined, { now, run });
    t += AGY_CACHE_MS - 1;
    await readAgyUsage(undefined, { now, run });
    expect(run).toHaveBeenCalledTimes(1);
    t += 1;
    await readAgyUsage(undefined, { now, run });
    expect(run).toHaveBeenCalledTimes(2);
    clearAgyCache();
    const fail = vi.fn(async () => { throw new Error("boom"); });
    await expect(readAgyUsage("x", { now, run: fail })).rejects.toThrow("boom");
    await expect(readAgyUsage("x", { now, run: fail })).rejects.toThrow("boom");
    expect(fail).toHaveBeenCalledTimes(1);
  });
});

describe("agy model groups and pausing", () => {
  it("maps model ids to groups; auto has none", () => {
    expect(agyModelGroup("gemini-4-neon-high")).toBe("Gemini Models");
    expect(agyModelGroup("agy/gemini-4-hydrogen")).toBe("Gemini Models");
    expect(agyModelGroup("gemini-3.8-flash-low")).toBe("Gemini Models");
    expect(agyModelGroup("claude-opus-5-5-thinking")).toBe("Claude and GPT models");
    expect(agyModelGroup("gpt-oss-120b-medium")).toBe("Claude and GPT models");
    expect(agyModelGroup("gemini-4-argon")).toBe("Gemini 4 Argon");
    expect(agyModelGroup("auto")).toBeUndefined();
  });
  it("pauses a model whose group has a bucket near zero, until it resets", () => {
    const meters = parseAgyUsage(FIXTURE);
    const claude = agyExhausted(meters, "claude-sonnet-5-5", NOW, 90);
    expect(claude).toMatchObject({ until: "2026-11-25T15:02:43.000Z" });
    expect(claude?.reason).toContain("Claude and GPT models · weekly");
    expect(agyExhausted(meters, "gemini-4-neon", NOW, 90)).toBeUndefined();
    expect(agyExhausted(meters, "gemini-4-argon", NOW, 90)).toBeUndefined();
    expect(agyExhausted(meters, "auto", NOW, 90)).toBeUndefined();
  });
  it("uses the pool's pauseAtPercent as the share used", () => {
    const meters = parseAgyUsage(FIXTURE);
    // Gemini's tightest bucket has 12.5 % ... 16.8 % used, so 90 % used is far off, 15 % used is past.
    expect(agyExhausted(meters, "gemini-4-neon", NOW, 90)).toBeUndefined();
    expect(agyExhausted(meters, "gemini-4-neon", NOW, 15)?.until).toBe("2026-11-28T13:35:47.000Z");
    const low = meters.map((m) => (m.label === "Gemini Models · 5 h" ? { ...m, remaining: 9, used: 91 } : m));
    expect(agyExhausted(low, "gemini-4-neon", NOW, 90)?.until).toBe("2026-11-22T06:24:39.000Z");
    expect(agyExhausted(low, "gemini-4-neon", NOW, 95)).toBeUndefined();
    const zero = meters.map((m) => (m.group === "Gemini Models" ? { ...m, remaining: 0, used: 100 } : m));
    expect(agyExhausted(zero, "gemini-4-neon", NOW, 100)?.reason).toMatch(/used up/);
  });
  it("ignores a bucket that has already reset", () => {
    const meters = parseAgyUsage(FIXTURE);
    expect(agyExhausted(meters, "claude-sonnet-5-5", new Date("2026-11-26T00:00:00Z"), 90)).toBeUndefined();
  });
});

describe("agyEnv", () => {
  it("adds the account home when the worker has no HOME", () => {
    expect(agyEnv({ PATH: "/bin" }, () => "/home/paperclip")).toEqual({ PATH: "/bin", HOME: "/home/paperclip" });
    expect(agyEnv({ HOME: "" }, () => "/home/paperclip").HOME).toBe("/home/paperclip");
  });
  it("keeps a HOME that is set", () => {
    const env = { HOME: "/x", PATH: "/bin" };
    expect(agyEnv(env, () => "/home/paperclip")).toBe(env);
  });
});
