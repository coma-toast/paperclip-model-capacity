import type { PluginContext } from "@paperclipai/plugin-sdk";

import { apiInfo, type ApiKind } from "./apis.js";

// A backend is one model endpoint (a proxy, a cloud API or a local engine), defined once per company in the plugin's
// company config. Pools pick a backend; a proxy pool can also watch local-engine backends. The key is a company secret
// bound at backends.<n>.key, so the worker can resolve it and nothing sensitive sits in plugin state.
export interface Backend {
  id: string;
  name: string;
  type: ApiKind;
  baseUrl?: string;
  // Model-name prefix agents use for this backend; defaults to the type's suggestion.
  prefix?: string;
  // Local engines: concurrent requests when the server doesn't report slots.
  slots?: number;
  header?: string;
  scheme?: string;
  key?: unknown;
}

// What the UI may see: never the key binding.
export interface BackendSummary extends Omit<Backend, "key"> {
  hasKey: boolean;
}

export const backendPrefix = (b: Pick<Backend, "type" | "prefix">) => b.prefix ?? apiInfo(b.type).defaultPrefix;
export const backendBaseUrl = (b: Pick<Backend, "type" | "baseUrl">) => b.baseUrl?.trim() || apiInfo(b.type).defaultBaseUrl;

export const readBackends = (config: Record<string, unknown>): Backend[] =>
  Array.isArray(config.backends) ? (config.backends as Backend[]).filter((b) => b && typeof b.id === "string" && typeof b.type === "string") : [];

export const summarizeBackends = (config: Record<string, unknown>): BackendSummary[] =>
  readBackends(config).map(({ key, ...rest }) => ({ ...rest, hasKey: Boolean(key) }));

export const backendsConfigSchema = {
  backends: {
    type: "array",
    title: "Backends",
    description: "Model endpoints for this company. Add and edit them on Company settings → Model capacity.",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        baseUrl: { type: "string" },
        prefix: { type: "string" },
        slots: { type: "number" },
        header: { type: "string" },
        scheme: { type: "string" },
        key: { type: "string", format: "secret-ref" },
      },
    },
  },
};

export const AUTH_CACHE_MS = 5 * 60_000;

// Request headers for a company's backend: resolves its key secret (cached briefly; the host rate-limits resolution).
export const createBackendAuth = (ctx: PluginContext, clock: () => number = Date.now) => {
  const cache = new Map<string, { at: number; headers: Record<string, string> }>();
  const headersFor = async (companyId: string, backendId: string | undefined): Promise<Record<string, string> | undefined> => {
    if (!backendId) return undefined;
    const backends = readBackends(await ctx.config.get(companyId));
    const index = backends.findIndex((b) => b.id === backendId);
    const backend = backends[index];
    if (!backend?.key) return undefined;
    const cacheKey = `${companyId}:${index}:${JSON.stringify(backend)}`;
    const hit = cache.get(cacheKey);
    if (hit && clock() - hit.at < AUTH_CACHE_MS) return hit.headers;
    const token = await ctx.secrets.resolve(backend.key as Parameters<PluginContext["secrets"]["resolve"]>[0], { companyId, configPath: `backends.${index}.key` });
    const scheme = backend.scheme === undefined ? "Bearer" : backend.scheme.trim();
    const headers = { [backend.header?.trim() || "Authorization"]: scheme ? `${scheme} ${token}` : token };
    cache.set(cacheKey, { at: clock(), headers });
    return headers;
  };
  return { headersFor };
};

export type BackendAuth = ReturnType<typeof createBackendAuth>;
