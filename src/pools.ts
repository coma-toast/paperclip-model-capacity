import { apiInfo } from "./apis.js";
import { backendBaseUrl, backendForModel, backendPrefix, probeBaseUrl, type Backend } from "./backends.js";
import { virtualModel } from "./constants.js";
import type { Store } from "./state/store.js";
import type { HostConfig, PlacementTarget, PoolConfig } from "./types.js";

// Each company sets up its own pools. The scheduler works on one flat list, so a company's pool becomes its own pool
// keyed "<companyId>:<poolId>" (its servers likewise), and limits never mix across companies.
export const poolKey = (companyId: string, localId: string) => `${companyId}:${localId}`;
// The local id of the host a backend becomes (scoped with poolKey like any other id).
export const backendHostId = (backendId: string) => `backend~${backendId}`;

export const splitPoolKey = (key: string): { companyId: string; poolId: string } | undefined => {
  const i = key.indexOf(":");
  return i > 0 ? { companyId: key.slice(0, i), poolId: key.slice(i + 1) } : undefined;
};

// A local-engine backend is a server the plugin can check; anything else isn't.
export const backendHost = (b: Backend): HostConfig[] => {
  const info = apiInfo(b.type);
  const baseUrl = probeBaseUrl(b);
  if (info.group !== "local" || !info.engine || !baseUrl) return [];
  return [{ id: backendHostId(b.id), name: b.name, engine: info.engine, baseUrl, declaredSlots: b.slots ?? 1, backendId: b.id }];
};

// A pool with a backend takes its API, prefix and address from it, and checks the backend itself (a local engine)
// or the local-engine backends it watches (a proxy).
// Names (other than its reach model) that reach only one engine, by engine id, from the proxies' routing.
export type EngineAliases = Record<string, string[]>;

// P2.7 engine pool: its engines (first tried first) are where tasks are pinned, each reached by its reach model; any
// other name routed only to that engine counts as already pinned there. Capacity is the engines' slots, each capped if
// set. An engine without a reach model can't take tasks yet, so it's left out.
const resolveEnginePool = (pool: PoolConfig, backends: Backend[], aliases: EngineAliases): PoolConfig => {
  const engines = (pool.engines ?? []).flatMap((entry) => {
    const b = backends.find((x) => x.id === entry.engine);
    const host = b ? backendHost(b)[0] : undefined;
    return b && host ? [{ entry, b, host }] : [];
  });
  const placement: PlacementTarget[] = engines.flatMap(({ entry, b, host }) => (b.reachModel ? [{
    model: b.reachModel, hostId: host.id, aliases: (aliases[b.id] ?? []).filter((m) => m !== b.reachModel), ...(entry.cap !== undefined ? { cap: entry.cap } : {}),
  }] : []));
  return {
    ...pool, hosts: engines.map((e) => e.host), placement,
    patterns: [...new Set(placement.flatMap((t) => [t.model, ...(t.aliases ?? [])]))],
    limit: engines.reduce((n, { entry, b }) => n + Math.min(entry.cap ?? Infinity, b.slots ?? 1), 0),
    // Per-engine room (slots as reported, caps) bounds it in the scheduler.
    limitFromEngines: true,
  };
};

export const resolvePool = (pool: PoolConfig, backends: Backend[], aliases: EngineAliases = {}): PoolConfig => {
  if (pool.kind === "engine") return resolveEnginePool(pool, backends, aliases);
  const b = pool.backend ? backends.find((x) => x.id === pool.backend) : undefined;
  // P2.7 quota pool: its models, in order, are where tasks are pinned (no engines). Each model's backend comes from its
  // prefix, so one pool can mix backends and subscriptions; the pool's own backend (older pools) covers the rest.
  const quota = pool.kind === "quota" ? {
    hosts: [],
    placement: pool.patterns.map((m) => m.trim()).filter(Boolean).map((model) => {
      const backendId = backendForModel(model, backends)?.id ?? b?.id;
      return backendId ? { model, backendId } : { model };
    }),
  } : {};
  if (!b) return { ...pool, ...quota };
  if (pool.kind === "quota") return { ...pool, api: b.type, prefix: backendPrefix(b), endpoint: { baseUrl: backendBaseUrl(b), backendId: b.id }, ...quota };
  const watched = (pool.watch ?? []).map((id) => backends.find((x) => x.id === id)).filter((x): x is Backend => Boolean(x));
  // A sticky pool also watches every engine it places tasks on.
  const targets = (pool.sticky ?? []).flatMap((t) => {
    const engine = backends.find((x) => x.id === t.engine);
    const host = engine ? backendHost(engine)[0] : undefined;
    return engine && host ? [{ model: t.model, engine, host }] : [];
  });
  const engines = [b, ...watched, ...targets.map((t) => t.engine)].filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i);
  const hosts = engines.flatMap(backendHost);
  return {
    ...pool, api: b.type, prefix: backendPrefix(b), endpoint: { baseUrl: backendBaseUrl(b), backendId: b.id, slots: b.slots }, hosts,
    ...(targets.length ? { placement: targets.map((t) => ({ model: t.model, hostId: t.host.id })) } : {}),
    // Changing a backend's slots changes the limit of every pool that matches its engines.
    ...(pool.limitFromEngines && hosts.length ? { limit: hosts.reduce((n, h) => n + h.declaredSlots, 0) } : {}),
  };
};

export const scopedPools = (companyId: string, pools: PoolConfig[], backends: Backend[] = [], aliases: EngineAliases = {}): PoolConfig[] =>
  pools.map((raw) => resolvePool(raw, backends, aliases)).map((p) => ({
    ...p, id: poolKey(companyId, p.id), localId: p.id, companyId, scope: "instance",
    // Tasks on the pool's virtual model belong to it (as an entry model when it pins tasks to engines).
    patterns: [...new Set([...p.patterns, virtualModel(p.id)])],
    hosts: p.hosts.map((h) => ({ ...h, id: poolKey(companyId, h.id) })),
    ...(p.placement ? { placement: p.placement.map((t) => (t.hostId ? { ...t, hostId: poolKey(companyId, t.hostId) } : t)) } : {}),
  }));

export type BackendsFor = (companyId: string) => Promise<Backend[]>;

// Reads a company's backends (its plugin config) only when one of its pools uses a backend. The host refuses proactive
// config reads for companies without a plugin config row, and one refusal would fail the whole cycle.
export const loadScopedPools = async (store: Store, companyIds: string[], backendsFor: BackendsFor = async () => []) =>
  (await Promise.all(companyIds.map(async (id) => {
    const pools = await store.companyPools(id).get();
    const needsBackends = pools.some((p) => p.backend || p.kind === "quota" || p.watch?.length || p.sticky?.length || p.engines?.length);
    // Engine pools also count runs on any name routed only to one of their engines (refreshed from proxy routing).
    const aliases = pools.some((p) => p.kind === "engine") ? await store.companyEngineAliases(id).get() : {};
    return scopedPools(id, pools, needsBackends ? await backendsFor(id) : [], aliases);
  }))).flat();

export const loadHeldPoolKeys = async (store: Store, companyIds: string[]) =>
  (await Promise.all(companyIds.map(async (id) => (await store.companyHeldPools(id).get()).map((p) => poolKey(id, p))))).flat();
