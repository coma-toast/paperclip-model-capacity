import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SubscriptionAccount, SubscriptionSample, SubscriptionWindow } from "./subscriptions.js";

// JD-1245: Claude's 5-hour and weekly windows, read from Claude Code's own run output on the Paperclip host.
// Paperclip can't read them for a setup token (its /api/oauth/usage call needs user:profile and gets 403), but every
// Claude Code run reports them in a `rate_limit_info` event, which Paperclip keeps in the run's log
// (<run-logs>/<companyId>/<agentId>/<runId>.ndjson). Nothing is spent to read them; they're as fresh as the latest run.

export const RUN_LOG_LABEL = "from Claude Code runs";
// Only the end of a log is read: the event repeats through a run, and the last one is the newest.
const TAIL_BYTES = 256 * 1024;
// Logs older than a week can't say anything about the current weekly window.
const MAX_AGE_MS = 7 * 86_400_000;
const MAX_FILES = 30;

export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageResetsAt?: number;
  isUsingOverage?: boolean;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }>;
}

const WINDOW_LABELS: Record<string, string> = { five_hour: "5-hour", seven_day: "Weekly" };

// The newest rate_limit_info anywhere in some log text. Lines are JSON whose string fields may hold Claude Code's own
// JSON lines (stdout chunks), so strings that look like JSON are opened too.
export const findRateLimitInfo = (text: string): RateLimitInfo | undefined => {
  let found: RateLimitInfo | undefined;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null) return;
    if (typeof value === "string") {
      if (!value.includes("rate_limit_info")) return;
      for (const line of value.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          visit(JSON.parse(t), depth + 1);
        } catch {
          // Not JSON: skip.
        }
      }
      return;
    }
    if (Array.isArray(value)) return value.forEach((v) => visit(v, depth + 1));
    if (typeof value === "object") {
      const o = value as Record<string, unknown>;
      if (o.rate_limit_info && typeof o.rate_limit_info === "object") found = o.rate_limit_info as RateLimitInfo;
      for (const [k, v] of Object.entries(o)) if (k !== "rate_limit_info") visit(v, depth + 1);
    }
  };
  for (const line of text.split("\n")) {
    if (!line.includes("rate_limit_info")) continue;
    try {
      visit(JSON.parse(line), 0);
    } catch {
      // A line cut by the tail read, or not JSON.
    }
  }
  return found;
};

const iso = (unixSeconds: number | undefined) => (typeof unixSeconds === "number" && unixSeconds > 0 ? new Date(unixSeconds * 1000).toISOString() : null);

// The windows one rate_limit_info reports, as subscription windows (percent used, reset time), plus overage.
export const windowsFromInfo = (info: RateLimitInfo, asOf: string): SubscriptionWindow[] => {
  const windows: SubscriptionWindow[] = Object.entries(info.unifiedWindows ?? {})
    .filter(([, w]) => typeof w?.utilization === "number")
    .map(([key, w]) => ({ label: `${WINDOW_LABELS[key] ?? key} (${RUN_LOG_LABEL})`, usedPercent: Math.round(w.utilization! * 1000) / 10, resetsAt: iso(w.resetsAt), asOf }));
  // Older runs report only the window that limits them now.
  if (!windows.length && info.rateLimitType && info.status) {
    windows.push({ label: `${WINDOW_LABELS[info.rateLimitType] ?? info.rateLimitType} (${RUN_LOG_LABEL})`, usedPercent: info.status === "rejected" ? 100 : null, resetsAt: iso(info.resetsAt), asOf });
  }
  if (info.overageStatus) {
    windows.push({
      label: `Extra usage ${info.isUsingOverage ? "in use" : info.overageStatus} (${RUN_LOG_LABEL})`,
      usedPercent: null, resetsAt: iso(info.overageResetsAt), asOf, overage: { status: info.overageStatus, inUse: Boolean(info.isUsingOverage) },
    });
  }
  return windows;
};

export const defaultRunLogsDir = () => join(process.env.PAPERCLIP_HOME || join(homedir(), ".paperclip"), "instances", process.env.PAPERCLIP_INSTANCE || "default", "data", "run-logs");

const tail = async (path: string, size: number) => {
  const fh = await open(path, "r");
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
};

// The company's newest Claude Code windows from its agents' run logs, as an anthropic account; undefined when no
// recent run reported any. Errors (no such directory, no permission) come back in the account, never thrown.
export const readRunLogWindows = async (companyId: string, opts: { dir?: string; now: Date }): Promise<SubscriptionAccount | undefined> => {
  const dir = join(opts.dir ?? defaultRunLogsDir(), companyId);
  try {
    const files: { path: string; mtime: number; size: number }[] = [];
    for (const agent of await readdir(dir, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      for (const f of await readdir(join(dir, agent.name), { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".ndjson")) continue;
        const path = join(dir, agent.name, f.name);
        const s = await stat(path);
        if (opts.now.getTime() - s.mtimeMs <= MAX_AGE_MS) files.push({ path, mtime: s.mtimeMs, size: s.size });
      }
    }
    for (const f of files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES)) {
      const info = findRateLimitInfo(await tail(f.path, f.size));
      if (!info) continue;
      const windows = windowsFromInfo(info, new Date(f.mtime).toISOString());
      if (windows.length) return { provider: "anthropic", accountLabel: `Claude (${RUN_LOG_LABEL})`, ok: true, windows };
    }
    return undefined;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return undefined;
    return { provider: "anthropic", accountLabel: `Claude (${RUN_LOG_LABEL})`, ok: false, windows: [], error: e instanceof Error ? e.message : String(e) };
  }
};

// Which window a label names, across Paperclip's and the run logs' wording ("5h limit" / "5-hour", "Current week" / "Weekly").
const windowKey = (label: string) => {
  const l = label.replace(` (${RUN_LOG_LABEL})`, "").toLowerCase();
  const named = /\(([^)]+)\)\s*$/.exec(l)?.[1];
  const family = named && named !== "all models" ? named : "";
  return /extra usage/.test(l) ? "extra" : /5.?h/.test(l) ? "5h" : /week|7.?d/.test(l) ? `week${family}` : l;
};

// Adds the run-log windows to what Paperclip reported: Paperclip's own windows win; run-log windows fill in the ones
// Paperclip couldn't read (Claude's 5-hour and weekly with a setup token).
export const withRunLogWindows = (sample: SubscriptionSample, account: SubscriptionAccount | undefined): SubscriptionSample => {
  if (!account) return sample;
  const anthropic = sample.accounts.filter((a) => a.ok && a.provider === "anthropic");
  const hasOwn = (w: SubscriptionWindow) => anthropic.some((a) => a.windows.some((x) => !x.label.includes(RUN_LOG_LABEL) && windowKey(x.label) === windowKey(w.label)));
  const windows = account.windows.filter((w) => !hasOwn(w));
  if (!windows.length && account.ok) return sample;
  // One Claude account in Paperclip is the same login the runs use (agents share one token): its windows join it, so a
  // pool pauses when that account is at its limit. Otherwise they stand as an account of their own.
  if (account.ok && anthropic.length === 1) {
    return { ...sample, accounts: sample.accounts.map((a) => (a === anthropic[0] ? { ...a, windows: [...a.windows, ...windows] } : a)) };
  }
  return { ...sample, ok: sample.ok || account.ok, accounts: [...sample.accounts.filter((a) => a.accountLabel !== account.accountLabel), { ...account, windows }] };
};
