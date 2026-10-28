import type { PluginStateClient, ScopeKey } from "@paperclipai/plugin-sdk";

import { HISTORY_MAX_PER_DAY, STATE_SCHEMA_VERSION } from "../constants.js";
import type { Action, HeldTask, HostStatus, OverrideRecord, PoolConfig, ReleasedTask } from "../types.js";

export interface HistoryEntry {
  at: string;
  // Observe-mode decisions are recorded but never applied (C6).
  applied: boolean;
  action: Action;
}

// Migrations step a blob from version N to N + 1. Version 0 means a blob written before versioning existed.
export type Migrations = Readonly<Record<number, (data: unknown) => unknown>>;

interface VersionedBlob {
  version: number;
  data: unknown;
}

export class StateVersionError extends Error {}

const isVersioned = (value: unknown): value is VersionedBlob =>
  typeof value === "object" && value !== null && typeof (value as VersionedBlob).version === "number" && "data" in value;

const instanceKey = (stateKey: string): ScopeKey => ({ scopeKind: "instance", stateKey });
const companyKey = (companyId: string, stateKey: string): ScopeKey => ({ scopeKind: "company", scopeId: companyId, stateKey });
const historyKey = (day: string) => instanceKey(`history:${day}`);
const dayOf = (iso: string) => iso.slice(0, 10);

// Unversioned blobs predate versioning and already have the v1 shape.
const DEFAULT_MIGRATIONS: Migrations = { 0: (data) => data };

export const readVersioned = async <T>(
  state: PluginStateClient,
  key: ScopeKey,
  fallback: T,
  migrations: Migrations = DEFAULT_MIGRATIONS,
  current = STATE_SCHEMA_VERSION,
): Promise<T> => {
  const raw = await state.get(key);
  if (raw === null || raw === undefined) return fallback;
  let { version, data } = isVersioned(raw) ? raw : { version: 0, data: raw };
  // A newer blob came from a newer plugin; refuse rather than overwrite it with an older shape.
  if (version > current) throw new StateVersionError(`${key.stateKey} is version ${version}, plugin understands ${current}`);
  while (version < current) {
    const step = migrations[version];
    if (!step) throw new StateVersionError(`${key.stateKey}: no migration from version ${version}`);
    data = step(data);
    version += 1;
  }
  if (version !== (isVersioned(raw) ? raw.version : 0)) await state.set(key, { version, data });
  return data as T;
};

export const writeVersioned = (state: PluginStateClient, key: ScopeKey, data: unknown, current = STATE_SCHEMA_VERSION) =>
  state.set(key, { version: current, data });

const blob = <T>(state: PluginStateClient, key: ScopeKey, fallback: () => T) => ({
  get: () => readVersioned<T>(state, key, fallback()),
  set: (value: T) => writeVersioned(state, key, value),
});

export const createStore = (state: PluginStateClient) => {
  // ctx.state can't list keys, so the day keys of history live in an index blob.
  const historyIndex = blob<string[]>(state, instanceKey("historyIndex"), () => []);

  const appendHistory = async (entries: HistoryEntry[]) => {
    const byDay = new Map<string, HistoryEntry[]>();
    for (const e of entries) byDay.set(dayOf(e.at), [...(byDay.get(dayOf(e.at)) ?? []), e]);
    const index = await historyIndex.get();
    for (const [day, add] of byDay) {
      const dayBlob = blob<HistoryEntry[]>(state, historyKey(day), () => []);
      // Capped ring: the newest entries win.
      await dayBlob.set([...(await dayBlob.get()), ...add].slice(-HISTORY_MAX_PER_DAY));
      if (!index.includes(day)) index.push(day);
    }
    await historyIndex.set(index.sort());
  };

  const pruneHistory = async (now: Date, retentionDays: number) => {
    const cutoff = dayOf(new Date(now.getTime() - retentionDays * 86_400_000).toISOString());
    const index = await historyIndex.get();
    const keep = index.filter((day) => day >= cutoff);
    for (const day of index) if (day < cutoff) await state.delete(historyKey(day));
    await historyIndex.set(keep);
    return index.length - keep.length;
  };

  return {
    pools: blob<PoolConfig[]>(state, instanceKey("pools"), () => []),
    hosts: blob<Record<string, HostStatus>>(state, instanceKey("hosts"), () => ({})),
    holds: blob<Record<string, HeldTask>>(state, instanceKey("holds"), () => ({})),
    released: blob<Record<string, ReleasedTask>>(state, instanceKey("released"), () => ({})),
    overrides: blob<Record<string, OverrideRecord>>(state, instanceKey("overrides"), () => ({})),
    heldPools: blob<string[]>(state, instanceKey("heldPools"), () => []),
    queueBlockers: (companyId: string) => blob<Record<string, string>>(state, companyKey(companyId, "queueBlockers"), () => ({})),
    historyDays: () => historyIndex.get(),
    history: (day: string) => blob<HistoryEntry[]>(state, historyKey(day), () => []).get(),
    appendHistory,
    pruneHistory,
  };
};

export type Store = ReturnType<typeof createStore>;
