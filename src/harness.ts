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

// Each pinning pool's virtual model becomes a model of one "pool" provider whose `id` is the real model of the pool's
// first-choice engine, so a run that starts before the plugin places its task still lands on a real engine (OpenCode
// sends `id` instead of the map key). One provider has one address, so pools reached through different endpoints
// can't all fall back; those get a warning instead.
export const harnessConfig = (pools: PoolConfig[], backends: Backend[]): HarnessConfig => {
  const warnings: string[] = [];
  const models: Record<string, unknown> = {};
  let endpoint: { baseUrl: string; backend: Backend } | undefined;
  const engineProviders: Record<string, unknown> = {};
  for (const pool of pools) {
    const first = pool.sticky?.[0];
    const backend = backends.find((b) => b.id === pool.backend);
    if (!first || !backend) continue;
    // Direct to engines: the fallback goes to the first engine itself, and each engine needs a provider of its own so
    // the engine models tasks are placed on resolve too.
    const direct = backend.type === "direct";
    const via = direct ? backends.find((b) => b.id === first.engine) : backend;
    if (!via) continue;
    const baseUrl = backendBaseUrl(via);
    if (!baseUrl) {
      warnings.push(`${pool.name}: ${via.name} has no address.`);
      continue;
    }
    if (direct) {
      for (const target of pool.sticky ?? []) {
        const engine = backends.find((b) => b.id === target.engine);
        const providerId = engine ? backendPrefix(engine).replace(/\/$/, "") : "";
        if (!engine || !providerId || !backendBaseUrl(engine)) continue;
        const existing = (engineProviders[providerId] as { models: Record<string, unknown> } | undefined)?.models ?? {};
        engineProviders[providerId] = {
          npm: "@ai-sdk/openai-compatible", name: engine.name,
          options: { baseURL: withV1(backendBaseUrl(engine)), apiKey: `{env:${envName(engine)}}` },
          models: { ...existing, [stripPrefix(backendPrefix(engine), target.model)]: { name: target.model, limit: DEFAULT_LIMIT } },
        };
      }
    }
    if (endpoint && endpoint.baseUrl !== baseUrl) {
      warnings.push(`${pool.name} goes through ${via.name}, but the pool provider already points at ${endpoint.backend.name}; give it a separate harness provider or use the same first engine.`);
      continue;
    }
    endpoint ??= { baseUrl, backend: via };
    models[pool.id] = { name: `${pool.name} (model capacity pool)`, id: stripPrefix(backendPrefix(via), first.model), limit: DEFAULT_LIMIT };
  }
  if (!endpoint) return { provider: {}, warnings };
  const keyVar = envName(endpoint.backend);
  return {
    provider: {
      ...engineProviders,
      [HARNESS_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Model capacity pools",
        options: { baseURL: withV1(endpoint.baseUrl), apiKey: `{env:${keyVar}}` },
        models,
      },
    },
    warnings: [
      ...warnings,
      `Set ${[keyVar, ...Object.values(engineProviders).map((p) => String((p as { options: { apiKey: string } }).options.apiKey).slice(5, -1))].filter((v, i, a) => a.indexOf(v) === i).join(", ")} in the agents' environment (each backend's key; ${apiInfo(endpoint.backend.type).label} for the pool provider). Adjust each model's context limit if it differs.`,
    ],
  };
};
