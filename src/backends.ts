import type { PluginContext } from "@paperclipai/plugin-sdk";

import { APIS, apiInfo, type ApiKind } from "./apis.js";
import type { BigQueryConfig } from "./types.js";

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
  // LiteLLM only: a read-only admin key (role proxy_admin_viewer) for counting each upstream model's requests in
  // LiteLLM's logs, which virtual keys can't read. A company secret bound at backends.<n>.logsKey.
  logsKey?: unknown;
  // Local engines: how agents reach it. A proxy backend's id (the reach model is a name that proxy routes only here,
  // read from its routing) or "direct" (the harness config gets a provider for the engine itself).
  reachVia?: string;
  // The model name agents use to reach this engine, e.g. "litellm/mbp"; the plugin pins tasks onto it.
  reachModel?: string;
  // Prepaid credit for this backend (e.g. Gemini prepaid balance). Stored as a { type: "secret_ref", secretId, version }
  // binding. The worker resolves it during usage sampling and pauses the backend when the credit is exhausted.
  prepaidCredit?: unknown;
  // BigQuery billing config for reading billed costs from a FOCUS export table.
  // Stored as a { serviceAccountKey, projectId, datasetId, tableName } object, each value a secret-ref binding.
  billingConfig?: BigQueryConfig;
}

// What the UI may see: never the key binding.
export interface BackendSummary extends Omit<Backend, "key" | "logsKey" | "prepaidCredit" | "billingConfig"> {
  hasKey: boolean;
  hasLogsKey?: boolean;
  hasPrepaidCredit?: boolean;
  hasBillingConfig?: boolean;
}

export const backendPrefix = (b: Pick<Backend, "type" | "prefix">) => b.prefix ?? apiInfo(b.type).defaultPrefix;
// The backend a model goes through, from its name: the backend with the longest prefix the model starts with. Bare names
// (a Claude Code or Codex subscription model like "claude-haiku-5-5") match none.
export const backendForModel = <B extends Pick<Backend, "id" | "type" | "prefix">>(model: string, backends: readonly B[]): B | undefined =>
  backends
    .filter((b) => backendPrefix(b) && model.startsWith(backendPrefix(b)))
    .sort((a, b) => backendPrefix(b).length - backendPrefix(a).length)[0];
export const backendBaseUrl = (b: Pick<Backend, "type" | "baseUrl">) => b.baseUrl?.trim() || apiInfo(b.type).defaultBaseUrl;
// Health probes add their own /v1/... paths, so an address given as .../v1 (as cloud APIs document it) is trimmed.
export const probeBaseUrl = (b: Pick<Backend, "type" | "baseUrl">) => backendBaseUrl(b).replace(/\/+$/, "").replace(/\/v1$/, "");

export const readBackends = (config: Record<string, unknown>): Backend[] =>
  Array.isArray(config.backends) ? (config.backends as Backend[]).filter((b) => b && typeof b.id === "string" && typeof b.type === "string") : [];

export const summarizeBackends = (config: Record<string, unknown>): BackendSummary[] =>
  readBackends(config).map(({ key, logsKey, prepaidCredit, billingConfig, ...rest }) => ({ ...rest, hasKey: Boolean(key), ...(logsKey ? { hasLogsKey: true } : {}), ...(prepaidCredit ? { hasPrepaidCredit: true } : {}), ...(billingConfig && Object.keys(billingConfig).length > 0 ? { hasBillingConfig: true } : {}) }));

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
        logsKey: {
          format: "secret-ref",
          title: "Admin key for usage logs",
          description: "LiteLLM only, optional: a read-only admin key (role proxy_admin_viewer). Lets the plugin count each upstream model's requests today for the upstream quotas.",
        },
        prepaidCredit: {
          format: "secret-ref",
          title: "Prepaid credit",
          description: "A prepaid balance for this backend (e.g. Gemini prepaid, OpenRouter credits). Stored as a company secret; the plugin reads it during usage sampling and pauses the backend when the credit is exhausted.",
        },
        billingConfig: {
          type: "object",
          title: "BigQuery billing",
          description: "Read billed costs from a Google BigQuery table (FOCUS export). Each field is stored as a company secret.",
          additionalProperties: false,
          properties: {
            serviceAccountKey: {
              format: "secret-ref",
              title: "Service account key",
              description: "BigQuery service account JSON (with private key), stored as a company secret.",
            },
            projectId: {
              format: "secret-ref",
              title: "Project ID",
              description: "Google Cloud project ID that holds the BigQuery dataset.",
            },
            datasetId: {
              format: "secret-ref",
              title: "Dataset ID",
              description: "BigQuery dataset ID (e.g. \"focus_exports\").",
            },
            tableName: {
              format: "secret-ref",
              title: "Table name",
              description: "BigQuery table name with billed cost data (e.g. \"billed_cost_export\").",
            },
          },
        },
        prefix: { type: "string", title: "Model name prefix", description: "How agents start this backend's model names, e.g. litellm/. Empty uses the type's usual prefix." },
        slots: { type: "integer", title: "Slots", minimum: 1, default: 1, description: "Local engines only: requests served at once when the server doesn't report it." },
        reachVia: { type: "string", title: "Reached via", description: "Local engines only: the proxy backend's id agents reach it through, or \"direct\"." },
        reachModel: { type: "string", title: "Reach model", description: "Local engines only: the model name agents use to reach it, e.g. litellm/mbp." },
        id: { type: "string", title: "Id", description: "Short and unique; pools refer to the backend by it." },
        header: { type: "string", title: "Auth header", default: "Authorization", description: "Header the key goes in." },
        scheme: { type: "string", title: "Auth scheme", default: "Bearer", description: "Put before the key; empty for none." },
      },
    },
  },
};

export const AUTH_CACHE_MS = 5 * 60_000;

// Request headers for a company's backend: resolves its key secret (cached briefly; the host rate-limits resolution).
// copilotToken: the GitHub token used for a Copilot backend with no saved key (the worker reads opencode's login).
export const createBackendAuth = (ctx: PluginContext, clock: () => number = Date.now, copilotToken: () => Promise<string | undefined> = async () => undefined) => {
  const cache = new Map<string, { at: number; headers: Record<string, string> }>();
  const headersFor = async (companyId: string, backendId: string | undefined): Promise<Record<string, string> | undefined> => {
    if (!backendId) return undefined;
    const backends = readBackends(await ctx.config.get(companyId));
    const index = backends.findIndex((b) => b.id === backendId);
    const backend = backends[index];
    if (backend && !backend.key && backend.type === "copilot") {
      const token = await copilotToken();
      return token ? { Authorization: `Bearer ${token}` } : undefined;
    }
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
  // The LiteLLM logs key's headers, when one is saved.
  const logsHeadersFor = async (companyId: string, backendId: string): Promise<Record<string, string> | undefined> => {
    const backends = readBackends(await ctx.config.get(companyId));
    const index = backends.findIndex((b) => b.id === backendId);
    const ref = backends[index]?.logsKey;
    if (!ref) return undefined;
    const token = await ctx.secrets.resolve(ref as Parameters<PluginContext["secrets"]["resolve"]>[0], { companyId, configPath: `backends.${index}.logsKey` });
    return { Authorization: `Bearer ${token}` };
  };
  return { headersFor, logsHeadersFor };
};

export type BackendAuth = ReturnType<typeof createBackendAuth>;
