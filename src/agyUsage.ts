import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

import type { UsageMeter } from "./usage.js";

// JD-1361: the Antigravity CLI's quota, read from `agy -p "/usage" --output-format json` on the worker's host. The
// command is a slash command: it makes no model call (num_turns 0, no tokens), so it spends no quota. It is cached for
// at least AGY_CACHE_MS so the plugin never starts it more often than that.

export const AGY_CACHE_MS = 5 * 60_000;
export const AGY_TIMEOUT_MS = 30_000;
export const DEFAULT_AGY_COMMAND = "agy";

export type AgyRun = (command: string, args: string[], timeoutMs: number) => Promise<string>;

export const runAgy: AgyRun = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    // Run from the temp dir: agy asks to trust the working folder, and the worker's own folder isn't one it knows.
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd: tmpdir(), windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        const why = e.code === "ENOENT" ? `${command} not found on the worker's PATH` : e.killed ? `timed out after ${timeoutMs / 1000} s` : (stderr || e.message).trim().split("\n")[0];
        reject(new Error(why));
        return;
      }
      resolve(stdout);
    });
  });

interface AgyBucket { id?: unknown; name?: unknown; window?: unknown; remaining_fraction?: unknown; reset_time?: unknown }
interface AgyGroup { name?: unknown; buckets?: unknown }

const WINDOW_WORDS: Record<string, string> = { weekly: "weekly", "5h": "5 h", daily: "daily" };

// The meters in agy's JSON, one per bucket: "<group> · <window>", the share left as a percentage (limit 100).
export const parseAgyUsage = (stdout: string): UsageMeter[] => {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("agy printed no JSON");
  let body: { status?: unknown; command?: { data?: { groups?: unknown } } };
  try {
    body = JSON.parse(stdout.slice(start));
  } catch {
    throw new Error("agy printed JSON that couldn't be read");
  }
  if (body.status !== undefined && body.status !== "SUCCESS") throw new Error(`agy reported status ${String(body.status)}`);
  const groups = body.command?.data?.groups;
  if (!Array.isArray(groups)) throw new Error("agy's /usage has no usage groups");
  const meters: UsageMeter[] = [];
  for (const g of groups as AgyGroup[]) {
    if (typeof g?.name !== "string" || !Array.isArray(g.buckets)) continue;
    for (const b of g.buckets as AgyBucket[]) {
      if (typeof b?.remaining_fraction !== "number" || !Number.isFinite(b.remaining_fraction)) continue;
      const remaining = Math.min(100, Math.max(0, b.remaining_fraction * 100));
      const window = typeof b.window === "string" ? WINDOW_WORDS[b.window] ?? b.window : typeof b.name === "string" ? b.name : "limit";
      meters.push({
        label: `${g.name} · ${window}`, unit: "percent", used: 100 - remaining, limit: 100, remaining, group: g.name,
        ...(typeof b.reset_time === "string" ? { resetAt: b.reset_time } : {}), ...(typeof b.window === "string" ? { period: b.window } : {}),
      });
    }
  }
  if (!meters.length) throw new Error("agy's /usage lists no limits");
  return meters;
};

const cache = new Map<string, { at: number; meters?: UsageMeter[]; error?: string }>();
export const clearAgyCache = () => cache.clear();

// agy's meters, from the cache when it's under AGY_CACHE_MS old (a failure is cached too, so a broken agy isn't
// started again every sample). Throws the cached error.
export const readAgyUsage = async (command: string | undefined, deps: { now?: () => Date; run?: AgyRun } = {}): Promise<UsageMeter[]> => {
  const cmd = command?.trim() || DEFAULT_AGY_COMMAND;
  const now = (deps.now ?? (() => new Date()))().getTime();
  const hit = cache.get(cmd);
  if (!hit || now - hit.at >= AGY_CACHE_MS) {
    try {
      const out = await (deps.run ?? runAgy)(cmd, ["-p", "/usage", "--output-format", "json"], AGY_TIMEOUT_MS);
      cache.set(cmd, { at: now, meters: parseAgyUsage(out) });
    } catch (e) {
      cache.set(cmd, { at: now, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const got = cache.get(cmd)!;
  if (got.error !== undefined) throw new Error(got.error);
  return got.meters!;
};

// The usage group a model draws on, from its id (a provider prefix like "agy/" is ignored); undefined for `auto` and
// anything unknown, which belongs to no single group.
export const agyModelGroup = (model: string): string | undefined => {
  const id = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  if (/^gemini-4-(neon|hydrogen)/.test(id) || /^gemini-3\.8-flash/.test(id)) return "Gemini Models";
  if (/^claude-/.test(id) || /^gpt-oss/.test(id)) return "Claude and GPT models";
  if (/^gemini-4-argon/.test(id)) return "Gemini 4 Argon";
  return undefined;
};

// Why a model is paused, and until when: some bucket of its group has `pauseAtPercent` used or more (or nothing left).
// It resumes when the last of those buckets resets. Undefined when it can run.
export const agyExhausted = (meters: UsageMeter[] | undefined, model: string, now: Date, pauseAtPercent: number): { until?: string; reason: string } | undefined => {
  const group = agyModelGroup(model);
  if (!group) return undefined;
  const leftAtMost = Math.max(0, 100 - Math.min(100, pauseAtPercent));
  const blocking = (meters ?? []).filter((m) => m.group === group && m.remaining !== undefined && m.remaining <= leftAtMost && (!m.resetAt || Date.parse(m.resetAt) > now.getTime()));
  if (!blocking.length) return undefined;
  const resets = blocking.map((m) => (m.resetAt ? Date.parse(m.resetAt) : NaN));
  const until = resets.some(Number.isNaN) ? undefined : new Date(Math.max(...resets)).toISOString();
  const worst = blocking.reduce((a, b) => (a.remaining! <= b.remaining! ? a : b));
  const left = Math.round(worst.remaining! * 10) / 10;
  return { ...(until ? { until } : {}), reason: left <= 0 ? `${worst.label} used up` : `${worst.label}: ${left} % left (pauses at ${leftAtMost} % left)` };
};
