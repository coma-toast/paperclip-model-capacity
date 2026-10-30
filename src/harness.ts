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
  for (const pool of pools) {
    const first = pool.sticky?.[0];
    const backend = backends.find((b) => b.id === pool.backend);
    if (!first || !backend) continue;
    const baseUrl = backendBaseUrl(backend);
    if (!baseUrl) {
      warnings.push(`${pool.name}: its backend ${backend.name} has no address.`);
      continue;
    }
    if (endpoint && endpoint.baseUrl !== baseUrl) {
      warnings.push(`${pool.name} goes through ${backend.name}, but the pool provider already points at ${endpoint.backend.name}; give it a separate harness provider or use the same backend.`);
      continue;
    }
    endpoint ??= { baseUrl, backend };
    models[pool.id] = {
      name: `${pool.name} (model capacity pool)`,
      id: stripPrefix(backendPrefix(backend), first.model),
      limit: { context: 131072, output: 8192 },
    };
  }
  if (!endpoint) return { provider: {}, warnings };
  const keyVar = endpoint.backend.type === "litellm" ? "LITELLM_API_KEY" : "MODEL_CAPACITY_API_KEY";
  return {
    provider: {
      [HARNESS_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Model capacity pools",
        options: { baseURL: withV1(endpoint.baseUrl), apiKey: `{env:${keyVar}}` },
        models,
      },
    },
    warnings: [
      ...warnings,
      `Set ${keyVar} in the agents' environment to ${apiInfo(endpoint.backend.type).label}'s key. Adjust each model's context limit if it differs.`,
    ],
  };
};
