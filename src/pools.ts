import type { Store } from "./state/store.js";
import type { PoolConfig } from "./types.js";

// Each company sets up its own pools. The scheduler works on one flat list, so a company's pool becomes its own pool
// keyed "<companyId>:<poolId>" (its servers likewise), and limits never mix across companies.
export const poolKey = (companyId: string, localId: string) => `${companyId}:${localId}`;

export const splitPoolKey = (key: string): { companyId: string; poolId: string } | undefined => {
  const i = key.indexOf(":");
  return i > 0 ? { companyId: key.slice(0, i), poolId: key.slice(i + 1) } : undefined;
};

export const scopedPools = (companyId: string, pools: PoolConfig[]): PoolConfig[] =>
  pools.map((p) => ({
    ...p, id: poolKey(companyId, p.id), localId: p.id, companyId, scope: "instance",
    hosts: p.hosts.map((h) => ({ ...h, id: poolKey(companyId, h.id) })),
  }));

export const loadScopedPools = async (store: Store, companyIds: string[]) =>
  (await Promise.all(companyIds.map(async (id) => scopedPools(id, await store.companyPools(id).get())))).flat();

export const loadHeldPoolKeys = async (store: Store, companyIds: string[]) =>
  (await Promise.all(companyIds.map(async (id) => (await store.companyHeldPools(id).get()).map((p) => poolKey(id, p))))).flat();
