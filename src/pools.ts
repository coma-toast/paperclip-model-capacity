import { apiInfo } from "./apis.js";
import { backendBaseUrl, backendPrefix, probeBaseUrl, type Backend } from "./backends.js";
import type { Store } from "./state/store.js";
import type { HostConfig, PoolConfig } from "./types.js";

// Each company sets up its own pools. The scheduler works on one flat list, so a company's pool becomes its own pool
// keyed "<companyId>:<poolId>" (its servers likewise), and limits never mix across companies.
export const poolKey = (companyId: string, localId: string) => `${companyId}:${localId}`;

export const splitPoolKey = (key: string): { companyId: string; poolId: string } | undefined => {
  const i = key.indexOf(":");
  return i > 0 ? { companyId: key.slice(0, i), poolId: key.slice(i + 1) } : undefined;
};

// A local-engine backend is a server the plugin can check; anything else isn't.
export const backendHost = (b: Backend): HostConfig[] => {
  const info = apiInfo(b.type);
  const baseUrl = probeBaseUrl(b);
  if (info.group !== "local" || !info.engine || !baseUrl) return [];
  return [{ id: `backend~${b.id}`, name: b.name, engine: info.engine, baseUrl, declaredSlots: b.slots ?? 1, backendId: b.id }];
};

// A pool with a backend takes its API, prefix and address from it, and checks the backend itself (a local engine)
// or the local-engine backends it watches (a proxy).
export const resolvePool = (pool: PoolConfig, backends: Backend[]): PoolConfig => {
  const b = pool.backend ? backends.find((x) => x.id === pool.backend) : undefined;
  if (!b) return pool;
  const watched = (pool.watch ?? []).map((id) => backends.find((x) => x.id === id)).filter((x): x is Backend => Boolean(x));
  return {
    ...pool, api: b.type, prefix: backendPrefix(b), endpoint: { baseUrl: backendBaseUrl(b), backendId: b.id, slots: b.slots },
    hosts: [...backendHost(b), ...watched.flatMap(backendHost)],
  };
};

export const scopedPools = (companyId: string, pools: PoolConfig[], backends: Backend[] = []): PoolConfig[] =>
  pools.map((raw) => resolvePool(raw, backends)).map((p) => ({
    ...p, id: poolKey(companyId, p.id), localId: p.id, companyId, scope: "instance",
    hosts: p.hosts.map((h) => ({ ...h, id: poolKey(companyId, h.id) })),
  }));

export type BackendsFor = (companyId: string) => Promise<Backend[]>;

// Reads a company's backends (its plugin config) only when one of its pools uses a backend. The host refuses proactive
// config reads for companies without a plugin config row, and one refusal would fail the whole cycle.
export const loadScopedPools = async (store: Store, companyIds: string[], backendsFor: BackendsFor = async () => []) =>
  (await Promise.all(companyIds.map(async (id) => {
    const pools = await store.companyPools(id).get();
    const needsBackends = pools.some((p) => p.backend || p.watch?.length);
    return scopedPools(id, pools, needsBackends ? await backendsFor(id) : []);
  }))).flat();

export const loadHeldPoolKeys = async (store: Store, companyIds: string[]) =>
  (await Promise.all(companyIds.map(async (id) => (await store.companyHeldPools(id).get()).map((p) => poolKey(id, p))))).flat();
