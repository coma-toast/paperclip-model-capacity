import { apiInfo } from "./apis.js";
import { backendBaseUrl, probeBaseUrl, type Backend } from "./backends.js";
import { getJson, type FetchFn } from "./probes/http.js";
import { PROBES } from "./probes/index.js";

// One number a backend reports about its own use: money spent against a budget, or local slots busy.
export interface UsageMeter {
  label: string;
  unit: "usd" | "slots";
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  period?: string;
  // Shown when there is no limit, e.g. "no budget set"; a plain tally (spent today) has none.
  noLimit?: string;
}

// What a backend said about its use at sampledAt. GET-only, like the probes; nothing is ever spent to find out.
export interface BackendUsage {
  backendId: string;
  sampledAt: string;
  ok: boolean;
  meters: UsageMeter[];
  // Limits the backend states but doesn't count against (e.g. a request rate), or why it reports nothing.
  notes: string[];
  source?: string;
  error?: string;
}

export interface UsageDeps {
  fetch: FetchFn;
  headers?: Record<string, string>;
  now?: () => Date;
  timeoutMs?: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// A meter with what's left worked out when the backend gives a limit but not the remainder.
const meter = (m: UsageMeter): UsageMeter =>
  m.remaining === undefined && m.limit !== undefined && m.used !== undefined ? { ...m, remaining: Math.max(0, m.limit - m.used) } : m;

type Sample = Pick<BackendUsage, "meters" | "notes" | "source">;

// LiteLLM: the key's own spend and budget (/key/info), plus its team's when the key belongs to one.
const liteLlm = async (base: string, deps: UsageDeps): Promise<Sample> => {
  const pc = { baseUrl: base, fetch: deps.fetch, headers: deps.headers, timeoutMs: deps.timeoutMs };
  let body: { info?: Record<string, unknown> };
  try {
    body = await getJson<{ info?: Record<string, unknown> }>(pc, "/key/info");
  } catch (e) {
    // A master key or a key from the proxy's config file has no spend record of its own (404). /global/spend would
    // cover the whole proxy but takes 20 s+ on a busy proxy, too slow to sample.
    if (e instanceof Error && /returned 404\b/.test(e.message)) {
      throw new Error("This key isn't a LiteLLM virtual key (master or config key), so LiteLLM keeps no spend for it. Save the virtual key your agents use to see spend.");
    }
    throw e;
  }
  const info = body.info ?? (body as Record<string, unknown>);
  const meters: UsageMeter[] = [meter({
    label: "Key spend", unit: "usd", used: num(info.spend), limit: num(info.max_budget), resetAt: str(info.budget_reset_at), period: str(info.budget_duration), noLimit: "no budget set",
  })];
  const notes: string[] = [];
  if (num(info.rpm_limit)) notes.push(`${info.rpm_limit} requests/min`);
  if (num(info.tpm_limit)) notes.push(`${info.tpm_limit} tokens/min`);
  if (num(info.max_parallel_requests)) notes.push(`${info.max_parallel_requests} requests at once`);
  const teamId = str(info.team_id);
  if (teamId) {
    const team = await getJson<{ team_info?: Record<string, unknown> }>(pc, `/team/info?team_id=${encodeURIComponent(teamId)}`).catch(() => undefined);
    const t = team?.team_info;
    if (t && num(t.max_budget) !== undefined) {
      meters.push(meter({ label: "Team spend", unit: "usd", used: num(t.spend), limit: num(t.max_budget), resetAt: str(t.budget_reset_at), period: str(t.budget_duration) }));
    }
  }
  return { meters, notes, source: `${base}/key/info` };
};

// OpenRouter: the key's credits (/key). Free models have a daily request cap OpenRouter doesn't count in the API.
const openRouter = async (base: string, deps: UsageDeps): Promise<Sample> => {
  const pc = { baseUrl: base, fetch: deps.fetch, headers: deps.headers, timeoutMs: deps.timeoutMs };
  const { data = {} } = await getJson<{ data?: Record<string, unknown> }>(pc, "/key");
  const meters = [
    meter({ label: "Credits", unit: "usd", used: num(data.usage), limit: num(data.limit), remaining: num(data.limit_remaining), period: str(data.limit_reset), noLimit: "no limit on this key" }),
    { label: "Spent today", unit: "usd" as const, used: num(data.usage_daily) },
  ].filter((m) => m.used !== undefined || m.limit !== undefined);
  const notes = typeof data.is_free_tier === "boolean"
    ? [`Free models: ${data.is_free_tier ? 50 : 1000} requests/day (not reported by the API)`]
    : [];
  return { meters, notes, source: `${base}/key` };
};

// Local engines: busy slots right now, against what the server reports or the backend's declared slots.
const localSlots = async (backend: Backend, deps: UsageDeps): Promise<Sample> => {
  const info = apiInfo(backend.type);
  const baseUrl = probeBaseUrl(backend);
  const r = await PROBES[info.engine ?? "openai"]({ baseUrl, fetch: deps.fetch, headers: deps.headers, timeoutMs: deps.timeoutMs });
  if (!r.up) throw new Error(r.error ?? "not answering");
  const limit = r.slotsTotal ?? backend.slots ?? 1;
  return {
    meters: [meter({ label: "Slots busy", unit: "slots", used: r.slotsBusy, limit })],
    notes: r.slotsBusy === undefined ? [`${info.label} doesn't report busy slots; Paperclip's own runs are counted on the pool`] : [],
    source: baseUrl,
  };
};

const NO_USAGE_API: Partial<Record<Backend["type"], string>> = {
  opencode: "OpenCode Zen has no usage API; balance and limits are in its console",
  direct: "Routes straight to the engines; see each engine's row",
  openai: "This endpoint has no standard usage API",
  other: "Names only; nothing to ask",
};

// Samples one backend. A failure is reported in the result, never thrown.
export const sampleUsage = async (backend: Backend, deps: UsageDeps): Promise<BackendUsage> => {
  const sampledAt = (deps.now ?? (() => new Date()))().toISOString();
  const base = { backendId: backend.id, sampledAt };
  try {
    const url = backendBaseUrl(backend).replace(/\/+$/, "");
    let sample: Sample;
    if (backend.type === "litellm") sample = await liteLlm(probeBaseUrl(backend), deps);
    else if (backend.type === "openrouter") sample = await openRouter(url || "https://openrouter.ai/api/v1", deps);
    else if (apiInfo(backend.type).group === "local") sample = await localSlots(backend, deps);
    else return { ...base, ok: true, meters: [], notes: [NO_USAGE_API[backend.type] ?? "No usage API"] };
    return { ...base, ok: true, ...sample };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const hint = /returned 40[13]\b/.test(error) ? " (check the backend's API key)" : "";
    return { ...base, ok: false, meters: [], notes: [], error: `${error}${hint}` };
  }
};

// The share of a meter that's used, 0-1, when it has a limit.
export const usedShare = (m: UsageMeter) =>
  m.limit && m.limit > 0 ? Math.min(1, (m.used ?? (m.remaining !== undefined ? m.limit - m.remaining : 0)) / m.limit) : undefined;
