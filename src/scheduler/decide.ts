import { OPEN_TASK_STATUSES, PRIORITY_RANK } from "../constants.js";
import { occupiesSlot, type Action, type HeldTask, type OpenTask, type PoolConfig, type Snapshot, type TaskPriority } from "../types.js";

interface Group {
  key: string;
  pool: PoolConfig;
  companyId?: string;
}

interface QueueEntry {
  issueId: string;
  companyId: string;
  priority: TaskPriority;
  heldAt: string;
}

const OPEN = new Set<string>(OPEN_TASK_STATUSES);

const companyAllowed = (pool: PoolConfig, companyId: string) => {
  const { include, exclude } = pool.companies ?? {};
  if (include?.length && !include.includes(companyId)) return false;
  return !exclude?.includes(companyId);
};

// Instance pools share one limit across companies; company pools get one limit per company (A3).
const groupKey = (pool: PoolConfig, companyId: string) => (pool.scope === "company" ? `${pool.id}:${companyId}` : pool.id);

const byQueueOrder = (a: QueueEntry, b: QueueEntry) =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.heldAt.localeCompare(b.heldAt) || a.issueId.localeCompare(b.issueId);

// B3: min(limit, slots of up hosts - outside busy), floored at 0. A pool with no hosts is bounded by its limit only.
// Hosts don't report which run is theirs, so outside load is the pool's probed busy slots minus all its Paperclip runs.
export const availableCapacity = (pool: PoolConfig, snapshot: Snapshot, paperclipRunsInPool: number) => {
  if (pool.hosts.length === 0) return Math.max(0, pool.limit);
  let slots = 0;
  let probedBusy = 0;
  for (const host of pool.hosts) {
    const status = snapshot.hosts[host.id];
    if (!status?.up) continue;
    slots += status.slotsTotal ?? host.declaredSlots;
    probedBusy += status.slotsBusy ?? 0;
  }
  const outsideBusy = Math.max(0, probedBusy - paperclipRunsInPool);
  return Math.max(0, Math.min(pool.limit, slots - outsideBusy));
};

const anyHostUp = (pool: PoolConfig, snapshot: Snapshot) => pool.hosts.length === 0 || pool.hosts.some((h) => snapshot.hosts[h.id]?.up);

const minutesSince = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / 60_000;

// P2 adds overflow (D1). Until then held tasks only queue.
const overflowActions = (): Action[] => [];

// Pure: the same snapshot always gives the same actions. Observe mode is the executor's concern (C6), so pool mode
// doesn't change what is decided here.
export const decide = (snapshot: Snapshot, now: Date = new Date(snapshot.now)): Action[] => {
  const poolsById = new Map(snapshot.pools.map((p) => [p.id, p]));
  const exemptAgents = new Set(snapshot.exemptAgentIds ?? []);
  const heldPools = new Set(snapshot.heldPools);
  const holdsByIssue = new Map(snapshot.holds.map((h) => [h.issueId, h]));
  const runIssues = new Set(snapshot.runs.map((r) => r.issueId));
  const groups = new Map<string, Group>();
  const counts = new Map<string, number>();
  const runsPerPool = new Map<string, number>();
  const groupFor = (poolId: string | undefined, companyId: string) => {
    const pool = poolId ? poolsById.get(poolId) : undefined;
    if (!pool || !companyAllowed(pool, companyId)) return undefined;
    const key = groupKey(pool, companyId);
    if (!groups.has(key)) groups.set(key, { key, pool, companyId: pool.scope === "company" ? companyId : undefined });
    return groups.get(key);
  };
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  // B2: running and queued runs, plus released tasks whose run hasn't shown up yet. A run queued behind its own agent
  // doesn't hold a model slot.
  for (const run of snapshot.runs) {
    if (!occupiesSlot(run)) continue;
    const group = groupFor(run.poolId, run.companyId);
    if (!group) continue;
    bump(counts, group.key);
    bump(runsPerPool, group.pool.id);
  }
  for (const released of snapshot.released) {
    const group = groupFor(released.poolId, released.companyId);
    if (group && !runIssues.has(released.issueId)) bump(counts, group.key);
  }

  const tasksByGroup = new Map<string, OpenTask[]>();
  for (const task of snapshot.tasks) {
    const group = groupFor(task.poolId, task.companyId);
    if (group) tasksByGroup.set(group.key, [...(tasksByGroup.get(group.key) ?? []), task]);
  }
  for (const hold of snapshot.holds) groupFor(hold.poolId, hold.companyId);

  const actions: Action[] = [];
  for (const group of groups.values()) {
    const { pool, key } = group;
    const count = counts.get(key) ?? 0;
    const available = availableCapacity(pool, snapshot, runsPerPool.get(pool.id) ?? 0);
    const tasks = tasksByGroup.get(key) ?? [];
    const isExempt = (t: OpenTask) => t.exempt || exemptAgents.has(t.agentId);
    const waiting = tasks.filter((t) => OPEN.has(t.status) && !t.hasActiveRun);
    const held: HeldTask[] = snapshot.holds.filter((h) => groupKey(pool, h.companyId) === key && h.poolId === pool.id);

    // B5: an exempt task never waits, so drop any hold it still has.
    for (const t of waiting) {
      if (isExempt(t) && holdsByIssue.has(t.issueId)) actions.push({ kind: "release", issueId: t.issueId, companyId: t.companyId, poolId: pool.id, reason: "manual" });
    }
    const queue: QueueEntry[] = held
      .filter((h) => waiting.some((t) => t.issueId === h.issueId && !isExempt(t)))
      .map((h) => ({ issueId: h.issueId, companyId: h.companyId, priority: h.priority, heldAt: h.heldAt }));

    if (count > available) {
      actions.push({
        kind: "alert",
        alert: { kind: "overLimit", subject: key, state: "start", poolId: pool.id, companyId: pool.companyId ?? group.companyId, at: snapshot.now, message: `${pool.name}: ${count} runs, limit ${available}` },
      });
    }

    // C2/C3: release the head of the queue into free slots. Nothing is released while over the limit (B4), while an
    // operator holds the pool (F2), or while every host is down (E3).
    let used = count;
    queue.sort(byQueueOrder);
    if (!heldPools.has(pool.id) && anyHostUp(pool, snapshot)) {
      for (const entry of queue.splice(0, Math.max(0, available - used))) {
        actions.push({ kind: "release", issueId: entry.issueId, companyId: entry.companyId, poolId: pool.id, reason: "capacity" });
        used += 1;
      }
    }

    // C1: once the pool is full (or held), every other open, non-exempt task without a run waits behind the queue.
    if (used >= available || heldPools.has(pool.id)) {
      const fresh = waiting
        .filter((t) => !isExempt(t) && !holdsByIssue.has(t.issueId))
        .map((t) => ({ issueId: t.issueId, companyId: t.companyId, priority: t.priority, heldAt: snapshot.now }));
      const order = [...queue, ...fresh].sort(byQueueOrder);
      for (const entry of fresh) {
        actions.push({ kind: "hold", issueId: entry.issueId, companyId: entry.companyId, poolId: pool.id, position: order.indexOf(entry) + 1 });
      }
    }

    for (const entry of queue) {
      if (minutesSince(entry.heldAt, now) > pool.alertAfterMinutes) {
        actions.push({
          kind: "alert",
          alert: { kind: "waitedTooLong", subject: entry.issueId, state: "start", poolId: pool.id, companyId: entry.companyId, at: snapshot.now, message: `Waiting for ${pool.name} over ${pool.alertAfterMinutes} min` },
        });
      }
    }
  }
  return [...actions, ...overflowActions()];
};
