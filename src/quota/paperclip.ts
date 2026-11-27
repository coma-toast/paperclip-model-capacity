import type { QuotaSample } from "./types.js";
import { num } from "./types.js";

// Paperclip's own data: runs that failed against a rate limit, credit wall or quota, per effective model, over 1 h and
// 24 h (E4). This is not an HTTP call — it reads the host's failed runs, so the adapter takes a reader rather than a
// backend and stays pure and testable. The real reader is wired in P3.2 against heartbeat_runs, joined to the issue's
// effective model; it supplies each row already carrying the model it ran on.

// The patterns that mark a failure as quota. Kept in config so the out-of-credit text (PRD open Q1) is added the moment
// a real one appears, without a code change.
export const DEFAULT_QUOTA_ERROR_PATTERNS = ["rate.?limit", "429", "quota", "credit", "insufficient"];

// One failed run, as the quota reader returns it: the model it ran on, the error, and when it finished.
export interface QuotaFailureRow {
  model?: string | null;
  error?: string | null;
  occurredAt?: string | number | null;
}
export type QuotaFailureReader = () => Promise<QuotaFailureRow[] | undefined>;

export interface PaperclipQuotaOptions {
  readRuns: QuotaFailureReader;
  // Pattern strings; compiled case-insensitively here. An invalid one is dropped, never allowed to break the read.
  patterns?: string[];
  now?: () => Date;
}

// Reads only the first valid pattern's match of a hostile error string against safe, pre-approved patterns; nothing is
// executed against it and a pattern that fails to compile is ignored, so a bad config can't wedge the sweep.
const compilePatterns = (patterns: string[]): RegExp[] => {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      // A pattern that won't compile is dropped, not trusted.
    }
  }
  return out;
};

const occurredAtMs = (v: string | number | null | undefined): number | undefined => {
  if (typeof v === "number") return v > 1e9 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
};

// Failed quota runs per effective model over the last hour and last 24 hours. A model only appears when it actually hit
// one, so an absent model means no evidence, not an unlimited model (E5 pauses only on a report of exhausted).
export const readPaperclipQuota = async (opts: PaperclipQuotaOptions): Promise<QuotaSample[]> => {
  const now = opts.now?.() ?? new Date();
  const sampledAt = now.toISOString();
  const patterns = compilePatterns(opts.patterns ?? DEFAULT_QUOTA_ERROR_PATTERNS);
  const rows = (await opts.readRuns().catch(() => undefined)) ?? [];
  const hour = now.getTime() - 3600_000;
  const day = now.getTime() - 24 * 3600_000;
  const recent: Record<string, number> = {};
  const recentDay: Record<string, number> = {};
  for (const row of rows) {
    if (!row?.error || !patterns.some((re) => re.test(row.error!))) continue;
    const model = typeof row.model === "string" && row.model ? row.model : undefined;
    const t = occurredAtMs(row.occurredAt);
    // A row without a usable timestamp can't be placed in a window, so it's skipped rather than guessed into one.
    if (!model || t === undefined || t < day) continue;
    recentDay[model] = (recentDay[model] ?? 0) + 1;
    if (t >= hour) recent[model] = (recent[model] ?? 0) + 1;
  }
  const out: QuotaSample[] = [];
  for (const [model, value] of Object.entries(recentDay)) out.push({ source: `paperclip:${model}:quotaFailed24h`, value, sampledAt });
  for (const [model, value] of Object.entries(recent)) out.push({ source: `paperclip:${model}:quotaFailed1h`, value, sampledAt });
  return out;
};
