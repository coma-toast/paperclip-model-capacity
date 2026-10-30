import type { PluginContext } from "@paperclipai/plugin-sdk";

import { addPrefix } from "./apis.js";
import { backendBaseUrl, backendPrefix, type Backend } from "./backends.js";
import { getJson } from "./probes/http.js";

// Where a proxy sends one of its model names: the upstream address (and model) of each deployment behind it.
export interface ProxyRoute {
  model: string;
  targets: { apiBase?: string; upstream?: string; engine?: string }[];
}

export type ProxyRoutesResult = { ok: true; routes: ProxyRoute[] } | { ok: false; error: string };

// Compares two addresses by scheme, host and port, ignoring a trailing /v1 and slashes.
export const sameEndpoint = (a: string | undefined, b: string | undefined) => {
  const norm = (u: string | undefined) => {
    if (!u) return undefined;
    try {
      const url = new URL(u.trim());
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`.toLowerCase();
    } catch {
      return undefined;
    }
  };
  const x = norm(a);
  return x !== undefined && x === norm(b);
};

// Reads a LiteLLM proxy's routing (/model/info, readable with an ordinary key) and matches each deployment's address
// to the company's engine backends. Other backend types don't say where their models go.
export const fetchProxyRoutes = async (ctx: PluginContext, backend: Backend, engines: Backend[], headers?: Record<string, string>): Promise<ProxyRoutesResult> => {
  if (backend.type !== "litellm") return { ok: false, error: "Only a LiteLLM proxy says where its models go" };
  const base = backendBaseUrl(backend).replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const body = await getJson<{ data?: { model_name?: unknown; litellm_params?: { model?: unknown; api_base?: unknown } }[] }>(
      { baseUrl: base, fetch: (u, init) => ctx.http.fetch(u, init), headers, timeoutMs: 20_000 }, "/model/info");
    const byModel = new Map<string, ProxyRoute>();
    for (const d of body.data ?? []) {
      if (typeof d.model_name !== "string") continue;
      const model = addPrefix(backendPrefix(backend), d.model_name);
      const apiBase = typeof d.litellm_params?.api_base === "string" ? d.litellm_params.api_base : undefined;
      const upstream = typeof d.litellm_params?.model === "string" ? d.litellm_params.model : undefined;
      const engine = engines.find((e) => sameEndpoint(apiBase, backendBaseUrl(e)))?.id;
      const route = byModel.get(model) ?? { model, targets: [] };
      route.targets.push({ apiBase, upstream, engine });
      byModel.set(model, route);
    }
    return { ok: true, routes: [...byModel.values()] };
  } catch (e) {
    return { ok: false, error: `Couldn't read the proxy's routing: ${e instanceof Error ? e.message : String(e)}` };
  }
};
