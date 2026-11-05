import { virtualModel } from "./constants.js";
import type { PoolConfig } from "./types.js";

// P2.7.4: one-time conversion of the earlier pool settings (models + backend + watched engines + engine ties) into the
// two kinds. A pool that pinned tasks to engines, or watched engines, becomes an engine pool with those engines (pin
// order first); any other pool on a backend becomes a quota pool with its backend, models and limit. Settings both
// kinds share are kept. Pools from before backends (hosts listed inline) can't be mapped and keep working as they are.
export const convertPool = (pool: PoolConfig): PoolConfig => {
  if (pool.kind || !pool.backend) return pool;
  const shared = {
    id: pool.id, name: pool.name, privacy: pool.privacy, mode: pool.mode, scope: pool.scope, hosts: [], alertAfterMinutes: pool.alertAfterMinutes,
    ...(pool.disabled ? { disabled: true } : {}),
    ...(pool.companies ? { companies: pool.companies } : {}),
    ...(pool.reassignAfterMinutes ? { reassignAfterMinutes: pool.reassignAfterMinutes } : {}),
  };
  const engines = [...new Set([...(pool.sticky ?? []).map((t) => t.engine), ...(pool.watch ?? [])])];
  if (engines.length) {
    return { ...shared, kind: "engine", engines: engines.map((engine) => ({ engine })), patterns: [], limit: 0, agentModel: virtualModel(pool.id) };
  }
  return {
    ...shared, kind: "quota", patterns: pool.patterns, limit: pool.limit,
    ...(pool.backend ? { backend: pool.backend } : {}),
    ...(pool.agentModel && pool.agentModel !== virtualModel(pool.id) ? {} : { agentModel: virtualModel(pool.id) }),
  };
};

export const convertPools = (pools: PoolConfig[]): { pools: PoolConfig[]; converted: boolean } => {
  const next = pools.map(convertPool);
  return { pools: next, converted: next.some((p, i) => p !== pools[i]) };
};
