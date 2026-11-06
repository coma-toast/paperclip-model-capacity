import { apiInfo } from "./apis.js";
import { probeBaseUrl, type Backend } from "./backends.js";
import { getJson, type FetchFn } from "./probes/http.js";

// What a model costs, in US dollars per million tokens. free: costs nothing to run (a local engine or a free model).
export interface ModelPrice {
  input?: number;
  output?: number;
  free?: boolean;
  // Counted against a subscription's request quota (Copilot premium requests), not billed per token.
  included?: boolean;
}

// A typical agent task re-sends its context on every step, so input dwarfs output. Used only to rank models by cost.
export const TASK_TOKENS = { input: 400_000, output: 20_000 } as const;

// Estimated dollars for one task on this model, or undefined when its price isn't known.
export const taskCost = (p: ModelPrice | undefined) => {
  if (!p) return undefined;
  if (p.free) return 0;
  if (p.input === undefined && p.output === undefined) return undefined;
  return ((p.input ?? 0) * TASK_TOKENS.input + (p.output ?? 0) * TASK_TOKENS.output) / 1_000_000;
};

// Free, then $ (under 5 cents a task), $$ (under 25 cents), $$$ (under $1), $$$$ ($1 or more); "?" when unknown.
export const costRating = (cost: number | undefined) =>
  cost === undefined ? "?" : cost === 0 ? "Free" : cost < 0.05 ? "$" : cost < 0.25 ? "$$" : cost < 1 ? "$$$" : "$$$$";

// The rating shown for a price: "Plan" for a subscription's included models, otherwise the cost of a task.
export const priceRating = (p: ModelPrice | undefined) => (p?.included ? "Plan" : costRating(taskCost(p)));

export const formatPerMillion = (n: number | undefined) =>
  n === undefined ? "?" : n === 0 ? "0" : n < 0.1 ? `$${n.toFixed(3)}` : n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(0)}`;

const perMillion = (perToken: unknown) => {
  const n = typeof perToken === "string" ? Number(perToken) : perToken;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
};

const priced = (input: number | undefined, output: number | undefined): ModelPrice | undefined =>
  input === undefined && output === undefined ? undefined : input === 0 && (output ?? 0) === 0 ? { input: 0, output: 0, free: true } : { input, output };

// OpenRouter puts prices (dollars per token, as strings) on each model in its own /models list.
export const openRouterPrices = (data: { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[]) => {
  const out: Record<string, ModelPrice> = {};
  for (const m of data) {
    const price = typeof m.id === "string" ? priced(perMillion(m.pricing?.prompt), perMillion(m.pricing?.completion)) : undefined;
    if (price) out[m.id as string] = price;
  }
  return out;
};

// LiteLLM: /model/info lists each deployment with its per-token costs. A name with several deployments (a load-balanced
// alias) shows its most expensive one, and is free only when every deployment is; an unpriced deployment makes it unknown.
// LiteLLM often has no cost for a deployment; it still costs nothing when it's a provider's free model (OpenRouter's
// ":free", "-free" names, NVIDIA NIM's free API) or an engine on the local network or tailnet.
const FREE_MODEL = /(:free|-free)$|^nvidia_nim\//;
const LOCAL_BASE = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|[^/:]+\.ts\.net\b)/;
const unpricedButFree = (params: { model?: unknown; api_base?: unknown } | undefined) =>
  (typeof params?.model === "string" && FREE_MODEL.test(params.model)) || (typeof params?.api_base === "string" && LOCAL_BASE.test(params.api_base));

export const liteLlmPrices = (data: { model_name?: unknown; model_info?: { input_cost_per_token?: unknown; output_cost_per_token?: unknown }; litellm_params?: { model?: unknown; api_base?: unknown } }[]) => {
  const byName = new Map<string, (ModelPrice | undefined)[]>();
  for (const d of data) {
    if (typeof d.model_name !== "string") continue;
    const price = priced(perMillion(d.model_info?.input_cost_per_token), perMillion(d.model_info?.output_cost_per_token)) ?? (unpricedButFree(d.litellm_params) ? { input: 0, output: 0, free: true } : undefined);
    byName.set(d.model_name, [...(byName.get(d.model_name) ?? []), price]);
  }
  const out: Record<string, ModelPrice> = {};
  for (const [name, prices] of byName) {
    if (prices.some((p) => !p)) continue;
    const all = prices as ModelPrice[];
    out[name] = all.every((p) => p.free)
      ? { input: 0, output: 0, free: true }
      : { input: Math.max(...all.map((p) => p.input ?? 0)), output: Math.max(...all.map((p) => p.output ?? 0)) };
  }
  return out;
};

// models.dev (OpenCode's model catalogue) has OpenCode Zen's prices per million tokens. It's large, so it's cached.
const CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000;
let catalogue: { at: number; providers: Record<string, { models?: Record<string, { cost?: { input?: number; output?: number }; tool_call?: boolean }> }> } | undefined;
const loadCatalogue = async (fetch: FetchFn, now: number) => {
  if (!catalogue || now - catalogue.at > CATALOGUE_TTL_MS) {
    catalogue = { at: now, providers: await getJson(({ baseUrl: "https://models.dev", fetch, timeoutMs: 20_000 }), "/api.json") };
  }
  return catalogue.providers;
};

export const catalogPrices = async (fetch: FetchFn, provider = "opencode", now = Date.now()) => {
  const out: Record<string, ModelPrice> = {};
  for (const [id, m] of Object.entries((await loadCatalogue(fetch, now))[provider]?.models ?? {})) {
    const price = priced(m.cost?.input, m.cost?.output);
    if (price) out[id] = price;
  }
  return out;
};

// A provider's models in the catalogue that can call tools (agents need them), sorted.
export const catalogModels = async (fetch: FetchFn, provider: string, now = Date.now()) =>
  Object.entries((await loadCatalogue(fetch, now))[provider]?.models ?? {}).filter(([, m]) => m.tool_call !== false).map(([id]) => id).sort();

// Prices for a backend's models, keyed by the backend's own model id. Never throws: a backend whose prices can't be
// read just shows "?".
export const backendPrices = async (backend: Pick<Backend, "type" | "baseUrl">, models: string[], deps: { fetch: FetchFn; headers?: Record<string, string> }) => {
  const free = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { free: true } as ModelPrice]));
  try {
    if (apiInfo(backend.type).group === "local" || backend.type === "direct") return free(models);
    if (backend.type === "litellm") {
      const body = await getJson<{ data?: Parameters<typeof liteLlmPrices>[0] }>({ baseUrl: probeBaseUrl(backend), fetch: deps.fetch, headers: deps.headers, timeoutMs: 15_000 }, "/model/info");
      return liteLlmPrices(body.data ?? []);
    }
    if (backend.type === "opencode") return { ...(await catalogPrices(deps.fetch, "opencode")), ...free(models.filter((id) => /-free$/.test(id))) };
  } catch {
    return {};
  }
  return {};
};
