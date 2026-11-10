import { apiInfo } from "./apis.js";
import { backendBaseUrl, probeBaseUrl, type Backend } from "./backends.js";
import { getJson, type EngineStages, type FetchFn } from "./probes/http.js";
import { PROBES } from "./probes/index.js";
import { catalogPrices, liteLlmPrices, openRouterPrices, type ModelPrice } from "./prices.js";
import { dayStart, readUpstreamLimit, type UpstreamLimit } from "./upstreamLimits.js";

// One number a backend reports about its own use: money spent against a budget, or local slots busy.
export interface UsageMeter {
  label: string;
  unit: "usd" | "slots" | "requests";
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  period?: string;
  // Shown when there is no limit, e.g. "no budget set"; a plain tally (spent today) has none.
  noLimit?: string;
  // used was counted from the runs Paperclip sent there, because the server doesn't report it.
  derived?: boolean;
  // Which models it limits when not all of them: "free" (ids ending in ":free") or "paid" (the rest).
  appliesTo?: "free" | "paid";
  // A short line shown under it, e.g. which upstream deployments it leaves out.
  detail?: string;
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
  // Each model's price, keyed by the backend's own model id (best effort; missing when the backend doesn't say).
  prices?: Record<string, ModelPrice>;
  // Limits the backend sets per model (requests or tokens per minute, requests per day). "*:free" applies to every
  // model whose id ends in ":free".
  modelLimits?: Record<string, ModelLimits>;
  // Local engines: what their requests are doing right now, when the server reports it.
  stages?: EngineStages;
  // A proxy's aliases and the upstream model each of their deployments calls (LiteLLM's litellm_params.model, like
  // "openrouter/x:free"), so their quota can be read from the upstream's own backend.
  upstreams?: Record<string, string[]>;
  // LiteLLM: each upstream model's quota, from its deployments' model_info.
  upstreamLimits?: Record<string, UpstreamLimit>;
  // Prepaid credit per upstream provider (LiteLLM's provider name): spent since it was loaded, against the credit.
  upstreamPrepaid?: Record<string, { used: number; credit: number; since: string }>;
  // Requests each upstream model (the provider's own model, across every alias that calls it) has had since its
  // provider's daily reset, counted in LiteLLM's logs (needs the backend's admin logs key).
  upstreamRequests?: Record<string, number>;
}

export interface ModelLimits {
  rpm?: number;
  tpm?: number;
  rpd?: number;
  // How many deployments share the name (a LiteLLM alias); rpm and tpm are their total.
  deployments?: number;
}

export interface UsageDeps {
  fetch: FetchFn;
  headers?: Record<string, string>;
  // LiteLLM: an admin key's headers for reading its logs (upstream request counts).
  logsHeaders?: Record<string, string>;
  // LiteLLM: prepaid credit per upstream provider, read against LiteLLM's spend on it (needs logsHeaders).
  prepaid?: { provider: string; credit: number; since: string }[];
  // A backend with no usage API: what Paperclip's own runs through it cost and used, from its cost records.
  paperclipSpend?: () => Promise<PaperclipSpend | undefined>;
  now?: () => Date;
  timeoutMs?: number;
}

// cost_events has one row per run; a model id with "free" in it is a free model (OpenCode's end in "-free").
export const PAPERCLIP_SPEND_SQL =
  "SELECT COALESCE(SUM(cost_cents) FILTER (WHERE occurred_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) / 100.0 AS month_usd, " +
  "COUNT(*) FILTER (WHERE model ILIKE '%free%' AND occurred_at > now() - interval '24 hours') AS free_runs, " +
  "COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) FILTER (WHERE model ILIKE '%free%' AND occurred_at > now() - interval '24 hours'), 0) AS free_tokens " +
  "FROM public.cost_events WHERE company_id = $1 AND model LIKE $2";

export interface PaperclipSpend {
  monthUsd: number;
  // Runs on free models in the last 24 hours, and their tokens.
  freeRuns: number;
  freeTokens: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// A meter with what's left worked out when the backend gives a limit but not the remainder.
const meter = (m: UsageMeter): UsageMeter =>
  m.remaining === undefined && m.limit !== undefined && m.used !== undefined ? { ...m, remaining: Math.max(0, m.limit - m.used) } : m;

type Sample = Pick<BackendUsage, "meters" | "notes" | "source" | "prices" | "modelLimits" | "stages" | "upstreams" | "upstreamLimits" | "upstreamRequests" | "upstreamPrepaid">;

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
  // Each model's price and the rpm/tpm limits LiteLLM enforces on its deployments (summed over an alias).
  const deployments = await getJson<{ data?: (Parameters<typeof liteLlmPrices>[0][number] & { litellm_params?: { rpm?: unknown; tpm?: unknown; model?: unknown }; model_info?: Record<string, unknown> & { id?: unknown } })[] }>(pc, "/model/info").catch(() => undefined);
  const modelLimits: Record<string, ModelLimits> = {};
  const upstreams: Record<string, string[]> = {};
  const upstreamLimits: Record<string, UpstreamLimit> = {};
  for (const d of deployments?.data ?? []) {
    if (typeof d.model_name !== "string") continue;
    const upstream = str(d.litellm_params?.model);
    if (upstream) upstreams[d.model_name] = [...(upstreams[d.model_name] ?? []), upstream];
    const quota = readUpstreamLimit(d.model_info);
    if (upstream && quota) upstreamLimits[upstream] = { ...upstreamLimits[upstream], ...quota };
    const l = modelLimits[d.model_name] ?? { deployments: 0 };
    const rpm = num(d.litellm_params?.rpm);
    const tpm = num(d.litellm_params?.tpm);
    modelLimits[d.model_name] = { deployments: (l.deployments ?? 0) + 1, ...(rpm !== undefined || l.rpm !== undefined ? { rpm: (l.rpm ?? 0) + (rpm ?? 0) } : {}), ...(tpm !== undefined || l.tpm !== undefined ? { tpm: (l.tpm ?? 0) + (tpm ?? 0) } : {}) };
  }
  const upstreamRequests = deps.logsHeaders && deployments ? await countUpstreamRequests(base, deployments.data ?? [], upstreamLimits, deps) : undefined;
  const upstreamPrepaid = deps.logsHeaders && deps.prepaid?.length ? await prepaidSpend(base, deps.prepaid, deps) : undefined;
  return {
    meters, notes, source: `${base}/key/info`, ...(deployments ? { prices: liteLlmPrices(deployments.data ?? []), modelLimits, upstreams, upstreamLimits } : {}),
    ...(upstreamRequests ? { upstreamRequests } : {}),
    ...(upstreamPrepaid && Object.keys(upstreamPrepaid).length ? { upstreamPrepaid } : {}),
  };
};

// Each upstream model with a quota in LiteLLM: its requests since the quota's daily reset, from LiteLLM's logs (one count
// per deployment, filtered by its id; the logs endpoint reports the total). OpenRouter reports its own count.
const countUpstreamRequests = async (
  base: string, deployments: { model_info?: { id?: unknown }; litellm_params?: { model?: unknown } }[], limits: Record<string, UpstreamLimit>, deps: UsageDeps,
) => {
  const pc = { baseUrl: base, fetch: deps.fetch, headers: deps.logsHeaders, timeoutMs: deps.timeoutMs };
  const now = deps.now?.() ?? new Date();
  const stamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  const out: Record<string, number> = {};
  for (const d of deployments) {
    const model = str(d.litellm_params?.model);
    const id = str(d.model_info?.id);
    // Only upstreams LiteLLM has a quota for; local engines and OpenRouter (which reports its own) aren't counted.
    if (!model || !id || !limits[model]) continue;
    const since = dayStart(now, limits[model].timeZone);
    const q = new URLSearchParams({ start_date: stamp(since), end_date: stamp(now), page: "1", page_size: "1", model_id: id });
    const r = await getJson<{ total?: unknown }>(pc, `/spend/logs/ui?${q}`).catch(() => undefined);
    if (num(r?.total) !== undefined) out[model] = (out[model] ?? 0) + num(r!.total)!;
  }
  return out;
};

// OpenRouter: the account's prepaid credits (/credits, no reset), the key's own limit when it has one, today's spend,
// and the free-model requests used today (/key free_model_daily_requests, reset at midnight UTC).
const openRouter = async (base: string, deps: UsageDeps): Promise<Sample> => {
  const pc = { baseUrl: base, fetch: deps.fetch, headers: deps.headers, timeoutMs: deps.timeoutMs };
  const { data = {} } = await getJson<{ data?: Record<string, unknown> }>(pc, "/key");
  const credits = await getJson<{ data?: Record<string, unknown> }>(pc, "/credits").then((b) => b.data).catch(() => undefined);
  const free = (data.free_model_daily_requests ?? {}) as Record<string, unknown>;
  const now = deps.now?.() ?? new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const meters: UsageMeter[] = [
    ...(credits && num(credits.total_credits) !== undefined
      ? [meter({ label: "Account credits", unit: "usd", used: num(credits.total_usage), limit: num(credits.total_credits), period: "prepaid, no reset", appliesTo: "paid" })]
      : []),
    ...(num(data.limit) !== undefined || !credits
      ? [meter({ label: "Key limit", unit: "usd", used: num(data.usage), limit: num(data.limit), remaining: num(data.limit_remaining), period: str(data.limit_reset), noLimit: "no limit on this key", appliesTo: "paid" })]
      : []),
    { label: "Spent today", unit: "usd" as const, used: num(data.usage_daily) },
    ...(num(free.limit) !== undefined
      ? [meter({ label: "Free requests today", unit: "requests", used: num(free.used), limit: num(free.limit), remaining: num(free.remaining), resetAt: midnight, appliesTo: "free" })]
      : []),
  ].filter((m) => m.used !== undefined || m.limit !== undefined);
  const freePerDay = num(free.limit) ?? (typeof data.is_free_tier === "boolean" ? (data.is_free_tier ? 50 : 1000) : undefined);
  const notes = num(free.limit) !== undefined ? ["Free models: 20 requests/min"] : freePerDay ? [`Free models: ${freePerDay} requests/day, 20/min (not counted by the API)`] : [];
  const list = await getJson<{ data?: Parameters<typeof openRouterPrices>[0] }>(pc, "/models").catch(() => undefined);
  return {
    meters, notes, source: `${base}/key`,
    ...(list ? { prices: openRouterPrices(list.data ?? []) } : {}),
    modelLimits: { "*:free": { rpm: 20, ...(freePerDay ? { rpd: freePerDay } : {}) } },
  };
};

// GitHub Copilot: the subscription's premium requests for the month (api.github.com/copilot_internal/user, read with a
// GitHub token). Chat and completions are unlimited on paid plans; premium models use premium requests.
interface CopilotQuota { entitlement?: number; remaining?: number; unlimited?: boolean; overage_permitted?: boolean }
const copilot = async (deps: UsageDeps): Promise<Sample> => {
  const body = await getJson<{ copilot_plan?: string; quota_reset_date?: string; quota_snapshots?: Record<string, CopilotQuota> }>(
    { baseUrl: "https://api.github.com", fetch: deps.fetch, headers: { Accept: "application/json", "User-Agent": "paperclip-model-capacity", ...deps.headers }, timeoutMs: deps.timeoutMs },
    "/copilot_internal/user",
  );
  const premium = body.quota_snapshots?.premium_interactions;
  const meters: UsageMeter[] = premium && !premium.unlimited && premium.entitlement !== undefined
    ? [meter({ label: "Premium requests", unit: "requests", used: premium.entitlement - (premium.remaining ?? 0), limit: premium.entitlement, remaining: premium.remaining, resetAt: body.quota_reset_date ? `${body.quota_reset_date}T00:00:00Z` : undefined, period: "month" })]
    : [];
  const unlimited = Object.entries(body.quota_snapshots ?? {}).filter(([, q]) => q.unlimited).map(([k]) => k);
  return {
    meters,
    notes: [
      ...(body.copilot_plan ? [`Plan: ${body.copilot_plan}`] : []),
      ...(unlimited.length ? [`Unlimited: ${unlimited.join(", ")}`] : []),
      ...(premium?.overage_permitted ? ["Overage billing is on: past the allowance GitHub charges per request, so the pool pauses at 0 left unless it's set to go over quota"] : []),
    ],
    source: "https://api.github.com/copilot_internal/user",
  };
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
    notes: [
      ...(r.slotsBusy === undefined ? [`${info.label} doesn't report busy slots here; counted from the runs Paperclip sends it`] : []),
      ...(r.waiting ? [`${r.waiting} request${r.waiting === 1 ? "" : "s"} waiting on the server`] : []),
    ],
    source: baseUrl,
    ...(r.stages ? { stages: r.stages } : {}),
  };
};

interface ConsoleBudget { limitDollars?: unknown; spentDollars?: unknown; scope?: unknown; coverage?: unknown; resetsAt?: unknown }
interface ConsoleUsage { model?: unknown; provider?: unknown; totalRequests?: unknown; totalCostMicroCents?: unknown }
const count = (v: unknown) => (typeof v === "string" || typeof v === "number" ? Number(v) : NaN);
// Console costs are in micro-cents (10^-8 dollars).
const dollars = (microCents: unknown) => count(microCents) / 1e8;

// OpenCode Console, with a personal API key (it refuses service-account keys): the workspace's budgets, what it spent
// this month and its free-model requests today (a free model costs nothing on OpenCode's own provider). Its API has no
// account balance, and OpenCode doesn't publish the free limit.
const opencodeConsole = async (url: string, deps: UsageDeps): Promise<UsageMeter[]> => {
  const pc = { baseUrl: `${new URL(url || "https://opencode.ai/zen/v1").origin}/console/api`, fetch: deps.fetch, headers: deps.headers, timeoutMs: deps.timeoutMs };
  const now = (deps.now ?? (() => new Date()))();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const today = day(now);
  const tomorrow = day(new Date(now.getTime() + 86_400_000));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const [budgets, month, models] = await Promise.all([
    getJson<ConsoleBudget[]>(pc, "/policies/current-budgets"),
    getJson<{ totalCostMicroCents?: unknown }>(pc, `/usage/summary?from=${today.slice(0, 8)}01&to=${tomorrow}`),
    getJson<{ items?: ConsoleUsage[] }>(pc, `/usage/models?from=${today}&to=${tomorrow}&pageSize=100`),
  ]);
  const list = Array.isArray(budgets) ? budgets : [];
  const meters: UsageMeter[] = list.map((b) => meter({
    label: b.scope === "combined" || !str(b.scope) ? "Budget" : `Budget (${b.scope})`, unit: "usd", used: num(b.spentDollars), limit: num(b.limitDollars),
    resetAt: str(b.resetsAt), period: "month", detail: b.coverage === "all" ? "all models" : `${String(b.coverage ?? "some")} models`,
  }));
  // A budget covering every model already shows the month's spend.
  if (!list.some((b) => b.coverage === "all")) {
    meters.push({ label: "Spent this month", unit: "usd", used: dollars(month.totalCostMicroCents), period: "month", resetAt: nextMonth, detail: "balance is in its console" });
  }
  const free = (models.items ?? []).filter((m) => m.provider === "opencode" && count(m.totalCostMicroCents) === 0);
  meters.push({
    label: "Free model requests today", unit: "requests", used: free.reduce((n, m) => n + (count(m.totalRequests) || 0), 0), appliesTo: "free",
    detail: "limit not published; paused when OpenCode says it's used up",
  });
  return meters;
};

const NO_USAGE_API: Partial<Record<Backend["type"], string>> = {
  opencode: "OpenCode Zen has no usage API; its balance and free limit are in its console",
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
    else if (backend.type === "copilot") sample = await copilot(deps);
    else if (apiInfo(backend.type).group === "local") sample = await localSlots(backend, deps);
    else if (backend.type === "opencode") {
      // With a personal key, the Console reports the workspace's spend and requests. Without one (free models need no
      // key at all), the meters count Paperclip's own runs. Its free limit isn't published; a run that hits it pauses
      // the free models until it resets.
      const catalogue = await catalogPrices(deps.fetch).catch(() => undefined);
      const prices = catalogue ? { prices: catalogue } : {};
      let consoleError: string | undefined;
      if (deps.headers) {
        try {
          return { ...base, ok: true, meters: await opencodeConsole(url, deps), notes: [], source: "OpenCode Console", ...prices };
        } catch (e) {
          consoleError = `OpenCode Console: ${e instanceof Error ? e.message : String(e)} (it needs a personal API key, not a service account's)`;
        }
      }
      const spend = await deps.paperclipSpend?.().catch(() => undefined);
      const now = (deps.now ?? (() => new Date()))();
      const meters: UsageMeter[] = spend ? [
        { label: "Spent this month", unit: "usd", used: spend.monthUsd, derived: true, period: "month",
          resetAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(), detail: "Paperclip's runs · balance is in its console" },
        { label: "Free model runs (24 h)", unit: "requests", used: spend.freeRuns, derived: true, appliesTo: "free",
          detail: `${spend.freeTokens.toLocaleString()} tokens · limit not published; paused when OpenCode says it's used up` },
      ] : [];
      return { ...base, ok: true, meters, notes: [...(consoleError ? [consoleError] : []), ...(spend ? [] : [NO_USAGE_API.opencode!])], ...prices };
    } else return { ...base, ok: true, meters: [], notes: [NO_USAGE_API[backend.type] ?? "No usage API"] };
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

// LiteLLM's spend per upstream provider since each prepaid credit was loaded (/global/spend/provider, admin key).
// Its dates are whole days, so a credit loaded mid-day also counts that day's earlier spend (a conservative reading).
export const prepaidSpend = async (base: string, prepaid: NonNullable<UsageDeps["prepaid"]>, deps: UsageDeps) => {
  const pc = { baseUrl: base, fetch: deps.fetch, headers: deps.logsHeaders, timeoutMs: deps.timeoutMs };
  const tomorrow = new Date((deps.now?.() ?? new Date()).getTime() + 86_400_000).toISOString().slice(0, 10);
  const out: Record<string, { used: number; credit: number; since: string }> = {};
  for (const p of prepaid) {
    const since = p.since.slice(0, 10);
    const rows = await getJson<{ provider?: unknown; spend?: unknown }[]>(pc, `/global/spend/provider?start_date=${since}&end_date=${tomorrow}`).catch(() => undefined);
    if (!Array.isArray(rows)) continue;
    const used = rows.filter((r) => r.provider === p.provider).reduce((n, r) => n + (num(r.spend) ?? 0), 0);
    out[p.provider] = { used, credit: p.credit, since: p.since };
  }
  return out;
};
