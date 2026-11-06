import { apiInfo, stripPrefix } from "./apis.js";
import { backendBaseUrl, backendPrefix, type Backend } from "./backends.js";
import { VIRTUAL_MODEL_PREFIX } from "./constants.js";
import type { PoolConfig } from "./types.js";

// The provider id agents' "pool/<id>" models resolve to in the harness.
export const HARNESS_PROVIDER = VIRTUAL_MODEL_PREFIX.replace(/\/$/, "");

export interface HarnessConfig {
  // An OpenCode `provider` block to merge into the agents' OpenCode configuration.
  provider: Record<string, unknown>;
  warnings: string[];
}

const DEFAULT_LIMIT = { context: 131072, output: 8192 };
// The environment variable a provider reads its key from: LITELLM_API_KEY for a LiteLLM proxy, else <BACKEND_ID>_API_KEY.
const envName = (b: Backend) => (b.type === "litellm" ? "LITELLM_API_KEY" : `${b.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`);

const withV1 = (url: string) => {
  const base = url.replace(/\/+$/, "");
  return /\/v1$/.test(base) ? base : `${base}/v1`;
};

// Where a pool's virtual model goes when a run starts before the plugin places its task: through `via`, as model `id`.
interface Fallback {
  pool: PoolConfig;
  via: Backend;
  id: string;
}

// Engines reached directly need a provider of their own, so the models tasks are pinned to resolve too.
const directEngineModels = (pools: PoolConfig[], backends: Backend[]) => {
  const out = new Map<string, { engine: Backend; models: Set<string> }>();
  const add = (engine: Backend | undefined, model: string | undefined) => {
    if (!engine || !model || !backendPrefix(engine) || !backendBaseUrl(engine)) return;
    const entry = out.get(engine.id) ?? { engine, models: new Set<string>() };
    entry.models.add(model);
    out.set(engine.id, entry);
  };
  for (const pool of pools) {
    if (pool.kind === "engine") {
      for (const e of pool.engines ?? []) {
        const engine = backends.find((b) => b.id === e.engine);
        if (engine?.reachVia === "direct") add(engine, engine.reachModel);
      }
    } else if (!pool.kind && backends.find((b) => b.id === pool.backend)?.type === "direct") {
      for (const t of pool.sticky ?? []) add(backends.find((b) => b.id === t.engine), t.model);
    }
  }
  return out;
};

const fallbackOf = (pool: PoolConfig, backends: Backend[]): Fallback | string | undefined => {
  const find = (id: string | undefined) => backends.find((b) => b.id === id);
  if (pool.kind === "engine") {
    const engine = (pool.engines ?? []).map((e) => find(e.engine)).find((b) => b?.reachModel);
    if (!engine?.reachModel) return pool.engines?.length ? `${pool.name}: none of its engines has a reach model yet.` : undefined;
    const via = engine.reachVia === "direct" ? engine : find(engine.reachVia);
    return via ? { pool, via, id: stripPrefix(backendPrefix(via), engine.reachModel) } : `${pool.name}: ${engine.name}'s proxy no longer exists.`;
  }
  if (pool.kind === "quota") {
    const via = find(pool.backend);
    const first = pool.patterns.map((m) => m.trim()).find(Boolean);
    return via && first ? { pool, via, id: stripPrefix(backendPrefix(via), first) } : undefined;
  }
  // Earlier settings: a pool that pins engines falls back to its first engine, through its backend (or directly).
  const first = pool.sticky?.[0];
  const backend = find(pool.backend);
  if (!first || !backend) return undefined;
  const via = backend.type === "direct" ? find(first.engine) : backend;
  return via ? { pool, via, id: stripPrefix(backendPrefix(via), first.model) } : undefined;
};

// One "pool" provider maps each pool's virtual model to a real model (OpenCode sends a model's `id` instead of its key,
// verified on 1.18.34), so a run that starts before the plugin places its task still lands somewhere real. A provider
// has one address: it uses the endpoint most pools can fall back through (a LiteLLM proxy on a tie), and the pools it
// can't serve are flagged; their rare early runs fail once and retry after placement.
export const harnessConfig = (pools: PoolConfig[], backends: Backend[]): HarnessConfig => {
  const warnings: string[] = [];
  const fallbacks: Fallback[] = [];
  for (const pool of pools) {
    const f = fallbackOf(pool, backends);
    if (typeof f === "string") warnings.push(f);
    else if (f && !backendBaseUrl(f.via)) warnings.push(`${pool.name}: ${f.via.name} has no address.`);
    else if (f) fallbacks.push(f);
  }
  const engineProviders: Record<string, unknown> = {};
  for (const { engine, models } of directEngineModels(pools, backends).values()) {
    engineProviders[backendPrefix(engine).replace(/\/$/, "")] = {
      npm: "@ai-sdk/openai-compatible", name: engine.name,
      options: { baseURL: withV1(backendBaseUrl(engine)), apiKey: `{env:${envName(engine)}}` },
      models: Object.fromEntries([...models].map((m) => [stripPrefix(backendPrefix(engine), m), { name: m, limit: DEFAULT_LIMIT }])),
    };
  }
  if (!fallbacks.length) return { provider: engineProviders, warnings };
  const count = new Map<string, number>();
  for (const f of fallbacks) count.set(backendBaseUrl(f.via), (count.get(backendBaseUrl(f.via)) ?? 0) + 1);
  const chosen = [...fallbacks].sort((a, b) =>
    (count.get(backendBaseUrl(b.via)) ?? 0) - (count.get(backendBaseUrl(a.via)) ?? 0) || Number(b.via.type === "litellm") - Number(a.via.type === "litellm"))[0].via;
  const models: Record<string, unknown> = {};
  for (const f of fallbacks) {
    if (backendBaseUrl(f.via) !== backendBaseUrl(chosen)) {
      warnings.push(`${f.pool.name} goes through ${f.via.name}, but the pool provider points at ${chosen.name}; its early runs rely on placement (they fail once and retry).`);
      continue;
    }
    models[f.pool.id] = { name: `${f.pool.name} (model capacity pool)`, id: f.id, limit: DEFAULT_LIMIT };
  }
  const keyVars = [envName(chosen), ...Object.values(engineProviders).map((p) => String((p as { options: { apiKey: string } }).options.apiKey).slice(5, -1))];
  return {
    provider: {
      ...engineProviders,
      [HARNESS_PROVIDER]: { npm: "@ai-sdk/openai-compatible", name: "Model capacity pools", options: { baseURL: withV1(backendBaseUrl(chosen)), apiKey: `{env:${envName(chosen)}}` }, models },
    },
    warnings: [
      ...warnings,
      `Set ${[...new Set(keyVars)].join(", ")} in the agents' environment (each backend's key; ${apiInfo(chosen.type).label} for the pool provider). Adjust each model's context limit if it differs.`,
    ],
  };
};
