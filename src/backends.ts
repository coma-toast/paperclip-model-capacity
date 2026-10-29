import type { PluginContext } from "@paperclipai/plugin-sdk";

import { APIS, apiInfo, type ApiKind } from "./apis.js";

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
// Health probes add their own /v1/... paths, so an address given as .../v1 (as cloud APIs document it) is trimmed.
export const probeBaseUrl = (b: Pick<Backend, "type" | "baseUrl">) => backendBaseUrl(b).replace(/\/+$/, "").replace(/\/v1$/, "");

export const readBackends = (config: Record<string, unknown>): Backend[] =>
  Array.isArray(config.backends) ? (config.backends as Backend[]).filter((b) => b && typeof b.id === "string" && typeof b.type === "string") : [];

export const summarizeBackends = (config: Record<string, unknown>): BackendSummary[] =>
  readBackends(config).map(({ key, ...rest }) => ({ ...rest, hasKey: Boolean(key) }));

// Rendered by the host's plugin config form too, so every field gets a title, a description and (where one exists)
// a default; the Model capacity page's Add/Edit backend form is the main editor. No x-paperclip-advanced: the host's
// server validates plugin schemas with strict ajv, which rejects that keyword even though its form understands it.
export const backendsConfigSchema = {
  backends: {
    type: "array",
    title: "Backends",
    description: "Model endpoints for this company. Easiest to add and edit on Company settings → Model capacity, which tests the connection and stores the key for you.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "type"],
      properties: {
        name: { type: "string", title: "Name", description: "Shown on pools, e.g. Home proxy or Laptop Ollama." },
        type: {
          type: "string",
          title: "Type",
          enum: APIS.map((a) => a.kind),
          description: APIS.map((a) => `${a.kind}: ${a.label}`).join(" · "),
        },
        baseUrl: { type: "string", title: "Address", description: "Where the plugin reads the model list and health. Cloud types have a built-in default." },
        key: {
          // A { type: "secret_ref", secretId, version } binding. No `type` here: the host form keys its secret picker
          // off the format, and array items aren't converted to strings before validation.
          format: "secret-ref",
          title: "API key",
          description: "A company secret. Leave empty for engines that don't need a key.",
        },
        prefix: { type: "string", title: "Model name prefix", description: "How agents start this backend's model names, e.g. litellm/. Empty uses the type's usual prefix." },
        slots: { type: "integer", title: "Slots", minimum: 1, default: 1, description: "Local engines only: requests served at once when the server doesn't report it." },
        id: { type: "string", title: "Id", description: "Short and unique; pools refer to the backend by it." },
        header: { type: "string", title: "Auth header", default: "Authorization", description: "Header the key goes in." },
        scheme: { type: "string", title: "Auth scheme", default: "Bearer", description: "Put before the key; empty for none." },
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
