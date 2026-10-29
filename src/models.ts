import type { PluginContext } from "@paperclipai/plugin-sdk";

import { apiInfo, inferApi } from "./apis.js";
import type { Credentials } from "./auth.js";
import { getJson } from "./probes/http.js";
import type { PoolConfig } from "./types.js";

export const MAX_LISTED_MODELS = 1000;

export type ListModelsResult =
  | { ok: true; source: string; models: string[] }
  | { ok: false; error: string };

// OpenAI-style lists live at <base>/v1/models; a base that already ends in /v1 just adds /models.
export const modelsPath = (baseUrl: string) => {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(base) ? { base, path: "/models" } : { base, path: "/v1/models" };
};

// "Load models": lists what a pool's API offers at the pool's address. GET only; never changes the API.
export const listApiModels = async (ctx: PluginContext, credentials: Credentials, companyId: string, pool: Pick<PoolConfig, "api" | "patterns" | "endpoint">): Promise<ListModelsResult> => {
  const info = apiInfo(pool.api ?? inferApi(pool.patterns ?? []));
  if (info.listing === "none") return { ok: false, error: `${info.label} has no endpoint to ask; type the model names.` };
  const baseUrl = pool.endpoint?.baseUrl?.trim() || info.defaultBaseUrl;
  if (!baseUrl) return { ok: false, error: `Enter the pool's address first (e.g. ${info.placeholderUrl}).` };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, error: "The pool's address isn't a valid URL." };
  }
  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: "The pool's address must start with http:// or https://" };
  let headers: Record<string, string> | undefined;
  try {
    headers = await credentials.headersFor(companyId, pool.endpoint?.credential);
  } catch (e) {
    return { ok: false, error: `Couldn't read credential "${pool.endpoint?.credential}": ${e instanceof Error ? e.message : String(e)}` };
  }
  const fetch = (u: string, init?: RequestInit) => ctx.http.fetch(u, init);
  try {
    let ids: unknown[];
    let source: string;
    if (info.listing === "ollama") {
      const base = url.toString().replace(/\/+$/, "");
      const body = await getJson<{ models?: { name?: unknown }[] }>({ baseUrl: base, fetch, headers, timeoutMs: 15_000 }, "/api/tags");
      ids = (body.models ?? []).map((m) => m.name);
      source = `${base}/api/tags`;
    } else {
      const { base, path } = modelsPath(url.toString());
      const body = await getJson<{ data?: { id?: unknown }[] }>({ baseUrl: base, fetch, headers, timeoutMs: 15_000 }, path);
      ids = (body.data ?? []).map((m) => m.id);
      source = `${base}${path}`;
    }
    const models = [...new Set(ids.filter((id): id is string => typeof id === "string"))].sort();
    return { ok: true, source, models: models.slice(0, MAX_LISTED_MODELS) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /returned 401|returned 403/.test(msg) ? `${info.label} refused the request (${msg}): set the pool's credential.` : `Couldn't list ${info.label} models: ${msg}` };
  }
};
