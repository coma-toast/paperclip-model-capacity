import type { PluginContext } from "@paperclipai/plugin-sdk";

import { apiInfo, type ApiKind } from "./apis.js";
import type { ServerAuth } from "./auth.js";
import { getJson } from "./probes/http.js";

export const MAX_LISTED_MODELS = 1000;

export type ListModelsResult =
  | { ok: true; api: ApiKind; source: string; models: string[] }
  | { ok: false; error: string };

// OpenAI-style lists live at <base>/v1/models; a base that already ends in /v1 (OpenCode, OpenRouter) just adds /models.
export const modelsPath = (baseUrl: string) => {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(base) ? { base, path: "/models" } : { base, path: "/v1/models" };
};

// "Load models": lists what an API offers, using the company's API endpoints config. GET only; never changes the API.
export const listApiModels = async (ctx: PluginContext, auth: ServerAuth, companyId: string, api: ApiKind): Promise<ListModelsResult> => {
  const info = apiInfo(api);
  if (api === "other") return { ok: false, error: "Other has no single API to ask; type the model names." };
  const endpoints = ((await ctx.config.get(companyId)).apiEndpoints ?? {}) as Record<string, { baseUrl?: unknown; key?: unknown }>;
  const cfg = endpoints[api] ?? {};
  const baseUrl = typeof cfg.baseUrl === "string" && cfg.baseUrl.trim() ? cfg.baseUrl.trim() : info.defaultBaseUrl;
  if (!baseUrl) return { ok: false, error: `Set ${info.label}'s address (and key) in the plugin's config under API endpoints → ${info.label}.` };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, error: `${info.label}'s address in API endpoints isn't a valid URL.` };
  }
  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: `${info.label}'s address must start with http:// or https://` };
  let headers: Record<string, string> | undefined;
  if (cfg.key) {
    try {
      headers = { Authorization: `Bearer ${await auth.resolveAt(companyId, `apiEndpoints.${api}.key`, cfg.key)}` };
    } catch (e) {
      return { ok: false, error: `Couldn't read ${info.label}'s API key: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const { base, path } = modelsPath(url.toString());
  try {
    const body = await getJson<{ data?: { id?: unknown }[] }>({ baseUrl: base, fetch: (u, init) => ctx.http.fetch(u, init), headers, timeoutMs: 15_000 }, path);
    const models = [...new Set((body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string"))].sort();
    return { ok: true, api, source: `${base}${path}`, models: models.slice(0, MAX_LISTED_MODELS) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /returned 401|returned 403/.test(msg) ? `${info.label} refused the request (${msg}): check the API key in API endpoints.` : `Couldn't list ${info.label} models: ${msg}` };
  }
};
