import type { PluginContext } from "@paperclipai/plugin-sdk";

import { addPrefix, apiInfo } from "./apis.js";
import { backendPrefix, type Backend } from "./backends.js";
import { listBackendModels } from "./models.js";
import { fetchProxyRoutes, type ProxyRoute } from "./routes.js";

// How agents reach one engine, checked against what the proxy (or the engine itself) offers now.
export interface EngineReach {
  engineId: string;
  reachVia?: string;
  reachModel?: string;
  // Names that reach this engine and nothing else (proxy routing), or the engine's own models with its prefix (direct).
  candidates: string[];
  // reachModel is still one of the candidates.
  ok: boolean;
  problem?: string;
}

export interface ReachReport {
  engines: EngineReach[];
  // Proxy model names that route to more than one engine: the plugin's pools replace these, so remove them from the proxy.
  balanced: { proxyId: string; model: string; engines: string[] }[];
}

// Names a proxy routes only to this engine, shortest first (the usual short alias, like "vm", before longer ones).
export const reachCandidates = (engineId: string, routes: ProxyRoute[]) =>
  routes.filter((r) => r.targets.length > 0 && r.targets.every((t) => t.engine === engineId)).map((r) => r.model)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));

export const checkEngineReach = async (
  ctx: PluginContext,
  backends: Backend[],
  headersFor: (backendId: string) => Promise<Record<string, string> | undefined>,
): Promise<ReachReport> => {
  const engines = backends.filter((b) => apiInfo(b.type).group === "local");
  const routesByProxy = new Map<string, ProxyRoute[] | string>();
  const routesOf = async (proxyId: string) => {
    if (!routesByProxy.has(proxyId)) {
      const proxy = backends.find((b) => b.id === proxyId);
      const result = proxy
        ? await fetchProxyRoutes(ctx, proxy, engines, await headersFor(proxy.id).catch(() => undefined))
        : { ok: false as const, error: "That proxy backend no longer exists" };
      routesByProxy.set(proxyId, result.ok ? result.routes : result.error);
    }
    return routesByProxy.get(proxyId)!;
  };
  const report: EngineReach[] = [];
  for (const engine of engines) {
    const base = { engineId: engine.id, reachVia: engine.reachVia, reachModel: engine.reachModel };
    if (!engine.reachVia) {
      report.push({ ...base, candidates: [], ok: false, problem: "Not set: pick how agents reach this engine" });
      continue;
    }
    if (engine.reachVia === "direct") {
      const list = await listBackendModels(ctx, engine, await headersFor(engine.id).catch(() => undefined));
      const candidates = list.ok ? list.models.map((m) => addPrefix(backendPrefix(engine), m)) : [];
      report.push({
        ...base, candidates, ok: Boolean(engine.reachModel && candidates.includes(engine.reachModel)),
        ...(list.ok ? (engine.reachModel && !candidates.includes(engine.reachModel) ? { problem: `${engine.name} doesn't serve ${engine.reachModel}` } : {}) : { problem: list.error }),
      });
      continue;
    }
    const routes = await routesOf(engine.reachVia);
    if (typeof routes === "string") {
      report.push({ ...base, candidates: [], ok: false, problem: routes });
      continue;
    }
    const candidates = reachCandidates(engine.id, routes);
    const ok = Boolean(engine.reachModel && candidates.includes(engine.reachModel));
    report.push({
      ...base, candidates, ok,
      ...(ok ? {} : { problem: !candidates.length ? "The proxy routes no model only to this engine" : engine.reachModel ? `The proxy no longer sends ${engine.reachModel} only here` : "Pick the model name agents use" }),
    });
  }
  const balanced = [...routesByProxy.entries()].flatMap(([proxyId, routes]) => (typeof routes === "string" ? [] : routes
    .map((r) => ({ proxyId, model: r.model, engines: [...new Set(r.targets.flatMap((t) => (t.engine ? [t.engine] : [])))] }))
    .filter((r) => r.engines.length > 1)));
  return { engines: report, balanced };
};
