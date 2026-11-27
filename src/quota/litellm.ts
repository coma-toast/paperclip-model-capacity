import { getJson } from "../probes/http.js";
import type { QuotaContext, QuotaSample } from "./types.js";
import { num, stamp } from "./types.js";

// LiteLLM quota, read-only with an admin key (role proxy_admin_viewer) resolved from a secret ref. Two sources:
// /model/info for the pool members and the quota values LiteLLM already records per deployment, and the spend logs for
// the failures it has seen. Nothing is written and no request is spent to ask (E4).

// One deployment from /model/info. LiteLLM's fields vary by version, so the readers below take the names it uses rather
// than betting on one, and ignore anything they don't recognise.
interface LiteLlmDeployment {
  model_name?: unknown;
  litellm_params?: { model?: unknown } | null;
  model_info?: Record<string, unknown> | null;
}

// The upstream model a deployment calls, and the name the pool sees (its alias). The quota is read against the upstream.
const nameOf = (d: LiteLlmDeployment): string | undefined => (typeof d.model_name === "string" && d.model_name ? d.model_name : undefined);

const remainingOf = (info: Record<string, unknown> | undefined): number | undefined =>
  num(info?.quota_remaining) ?? num(info?.remaining_quota) ?? num(info?.remaining_requests);

const resetOf = (info: Record<string, unknown> | undefined): string | undefined => {
  const at = info?.quota_reset_at ?? info?.reset_at;
  if (typeof at === "string" && at) return at;
  const n = num(at);
  return n && n > 1e9 ? new Date(n * 1000).toISOString() : undefined;
};

// A deployment LiteLLM has put in cooldown (it stopped routing to it): exhausted until the reset it names.
const cooldownUntilOf = (info: Record<string, unknown> | undefined): string | undefined => {
  const until = info?.cooldown_until ?? info?.blocked_until;
  if (typeof until === "string" && until) return until;
  const n = num(until);
  return n && n > 0 ? new Date(n * 1000).toISOString() : undefined;
};

// Pool members and their recorded quota from /model/info: one sample per member with a number, plus a cooldown member as
// value 0 (exhausted until its reset). A member with neither contributes nothing — no number is invented for it.
const members = async (ctx: QuotaContext, sampledAt: string): Promise<QuotaSample[]> => {
  const body = await getJson<{ data?: LiteLlmDeployment[] }>(ctx, "/model/info");
  const out: QuotaSample[] = [];
  for (const d of body.data ?? []) {
    const name = nameOf(d);
    if (!name) continue;
    const info = d.model_info ?? undefined;
    const remaining = remainingOf(info);
    if (remaining !== undefined) out.push({ source: `litellm:${name}:remaining`, value: remaining, resetAt: resetOf(info), sampledAt });
    const cooldown = cooldownUntilOf(info);
    if (cooldown) out.push({ source: `litellm:${name}:cooldown`, value: 0, resetAt: cooldown, sampledAt });
  }
  return out;
};

// A failure row counts as a 429 when its status code is 429, or its text says rate-limited. LiteLLM's own failure log
// uses a status code, but a proxy that folds the reason into the message is still caught by the text (E4 counts 429s).
const isRateLimited = (row: Record<string, unknown>): boolean => {
  if (num(row.status_code) === 429) return true;
  const text = `${row.status ?? ""} ${row.message ?? ""} ${row.exception_class ?? ""}`;
  return /429|rate.?limit/i.test(text);
};

// When a log row happened, in milliseconds, from whichever timestamp field LiteLLM used in that version.
const rowTime = (row: Record<string, unknown>): number | undefined => {
  const at = row.end_time ?? row.startTime ?? row.timestamp ?? row.created_at;
  if (typeof at === "number") return at > 1e9 ? at * 1000 : at;
  if (typeof at === "string") {
    const t = Date.parse(at);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
};

// 429s over the last 24 h from the failure log, grouped by model; the last hour is the same rows within the hour, so one
// request serves both windows (E7, the smallest request that answers the question).
const failures = async (ctx: QuotaContext, sampledAt: string): Promise<QuotaSample[]> => {
  const now = ctx.now?.() ?? new Date();
  const lib = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  const body = await getJson<{ data?: Record<string, unknown>[] }>(
    ctx,
    `/spend/logs/ui?status_filter=failure&start_date=${lib(new Date(now.getTime() - 24 * 3600_000))}&end_date=${lib(now)}`,
  );
  const day: Record<string, number> = {};
  const recent: Record<string, number> = {};
  const sinceDay = now.getTime() - 24 * 3600_000;
  const sinceHour = now.getTime() - 3600_000;
  for (const row of body.data ?? []) {
    if (!isRateLimited(row)) continue;
    const model = typeof row.model === "string" && row.model ? row.model : undefined;
    const t = rowTime(row);
    // The query asks for the window, but the count is bounded here too — a row outside it, or with no stamp to place it,
    // is dropped rather than widening the figure.
    if (!model || t === undefined || t < sinceDay) continue;
    day[model] = (day[model] ?? 0) + 1;
    if (t >= sinceHour) recent[model] = (recent[model] ?? 0) + 1;
  }
  // A model is reported only when it actually hit a wall; a quiet model has no sample, and no sample is not "exhausted".
  const out: QuotaSample[] = [];
  for (const [model, value] of Object.entries(day)) out.push({ source: `litellm:${model}:rateLimited24h`, value, sampledAt });
  for (const [model, value] of Object.entries(recent)) out.push({ source: `litellm:${model}:rateLimited1h`, value, sampledAt });
  return out;
};

// LiteLLM's quota for one backend: its pool members' recorded quota and its recent 429s. A transport failure is thrown
// (the sweep records the backend as unreadable); a backend without the admin logs key just yields no failure samples.
export const readLiteLlmQuota = async (ctx: QuotaContext): Promise<QuotaSample[]> => {
  const sampledAt = stamp(ctx);
  const [m, f] = await Promise.all([members(ctx, sampledAt), failures(ctx, sampledAt)]);
  return [...m, ...f];
};
