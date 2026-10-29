import type { PluginContext } from "@paperclipai/plugin-sdk";

import { apiInfo } from "./apis.js";
import { backendBaseUrl, type Backend } from "./backends.js";
import { getJson } from "./probes/http.js";

export const MAX_LISTED_MODELS = 1000;

export type ListModelsResult =
  | { ok: true; source: string; models: string[] }
  | { ok: false; error: string };

// OpenAI-style lists live at <base>/v1/models; a base that already ends in /v1 just adds /models.
export const modelsPath = (baseUrl: string) => {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(base) ? { base, path: "/models" } : { base, path: "/v1/models" };
};

// Lists what a backend offers. GET only; never changes the backend.
export const listBackendModels = async (ctx: PluginContext, backend: Pick<Backend, "type" | "baseUrl" | "name">, headers?: Record<string, string>): Promise<ListModelsResult> => {
  const info = apiInfo(backend.type);
  if (info.listing === "none") return { ok: false, error: `${info.label} has no endpoint to ask.` };
  const baseUrl = backendBaseUrl(backend);
  if (!baseUrl) return { ok: false, error: `Enter ${backend.name || "the backend"}'s address (e.g. ${info.placeholderUrl}).` };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, error: "The address isn't a valid URL." };
  }
  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: "The address must start with http:// or https://" };
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
    return { ok: false, error: /returned 401|returned 403/.test(msg) ? `${backend.name || info.label} refused the request (${msg}): check the API key.` : `Couldn't list models: ${msg}` };
  }
};
