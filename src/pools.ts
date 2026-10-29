import { apiInfo, inferApi } from "./apis.js";
import type { Store } from "./state/store.js";
import type { HostConfig, PoolConfig } from "./types.js";

// Each company sets up its own pools. The scheduler works on one flat list, so a company's pool becomes its own pool
// keyed "<companyId>:<poolId>" (its servers likewise), and limits never mix across companies.
export const poolKey = (companyId: string, localId: string) => `${companyId}:${localId}`;

export const splitPoolKey = (key: string): { companyId: string; poolId: string } | undefined => {
  const i = key.indexOf(":");
  return i > 0 ? { companyId: key.slice(0, i), poolId: key.slice(i + 1) } : undefined;
};

// A pool pointed straight at a local engine checks that engine as its one server.
export const endpointHost = (pool: PoolConfig): HostConfig[] => {
  const info = apiInfo(pool.api ?? inferApi(pool.patterns));
  const baseUrl = pool.endpoint?.baseUrl;
  if (info.group !== "local" || !info.engine || !baseUrl) return [];
  return [{ id: `${pool.id}~endpoint`, name: `${info.label} (${pool.name})`, engine: info.engine, baseUrl, declaredSlots: pool.endpoint?.slots ?? 1, credential: pool.endpoint?.credential }];
};

export const scopedPools = (companyId: string, pools: PoolConfig[]): PoolConfig[] =>
  pools.map((p) => ({
    ...p, id: poolKey(companyId, p.id), localId: p.id, companyId, scope: "instance",
    hosts: [...p.hosts, ...endpointHost(p)].map((h) => ({ ...h, id: poolKey(companyId, h.id) })),
  }));

export const loadScopedPools = async (store: Store, companyIds: string[]) =>
  (await Promise.all(companyIds.map(async (id) => scopedPools(id, await store.companyPools(id).get())))).flat();

export const loadHeldPoolKeys = async (store: Store, companyIds: string[]) =>
  (await Promise.all(companyIds.map(async (id) => (await store.companyHeldPools(id).get()).map((p) => poolKey(id, p))))).flat();
