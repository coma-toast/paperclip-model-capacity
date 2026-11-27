import { getJson } from "../probes/http.js";
import type { QuotaContext, QuotaSample } from "./types.js";
import { num, stamp } from "./types.js";

// OpenRouter quota from its own key endpoint, GET /api/v1/key (read-only, the backend's key). It reports what's left on the
// key, what was used today, and whether the key is on the free tier (E4). Free requests used today live in usage.ts's UI
// path; this is the scheduler-facing number, kept to what the plan names here.

// A reset like "monthly" is a period, not a moment, so it can't become a resetAt; only a real timestamp is kept.
const resetAt = (v: unknown): string | undefined => {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v;
  const n = num(v);
  return n && n > 1e9 ? new Date(n * 1000).toISOString() : undefined;
};

// Used today resets at midnight UTC even when the key doesn't say, so the scheduler knows when to retry the daily number.
const midnightUtc = (now: Date): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

export const readOpenRouterQuota = async (ctx: QuotaContext): Promise<QuotaSample[]> => {
  const now = ctx.now?.() ?? new Date();
  const sampledAt = stamp(ctx);
  const body = await getJson<{ data?: Record<string, unknown> }>(ctx, "/key");
  const data = body.data ?? {};
  const out: QuotaSample[] = [];

  const remaining = num(data.limit_remaining);
  if (remaining !== undefined) out.push({ source: "openrouter:key:remaining", value: remaining, resetAt: resetAt(data.limit_reset), sampledAt });

  const usedToday = num(data.usage_daily);
  if (usedToday !== undefined) out.push({ source: "openrouter:key:usedToday", value: usedToday, resetAt: midnightUtc(now), sampledAt });

  // The free-tier flag as a number (1 free, 0 paid) so it carries the same shape; it decides whether free requests apply.
  if (typeof data.is_free_tier === "boolean") out.push({ source: "openrouter:key:freeTier", value: data.is_free_tier ? 1 : 0, sampledAt });

  return out;
};
