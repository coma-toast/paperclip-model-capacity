import { OPEN_TASK_STATUSES, PRIORITY_RANK, virtualModel } from "../constants.js";
import { ADAPTER_PROVIDER, PROVIDER_ADAPTER, canRun } from "./model.js";
import { occupiesSlot, type Action, type HeldTask, type OpenTask, type PlaceReason, type PlacementTarget, type PoolConfig, type Snapshot, type TaskPriority } from "../types.js";

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
  // A pool matching its engines takes the slots they report now, which may differ from the backends' setting.
  return Math.max(0, Math.min(pool.limitFromEngines ? Infinity : pool.limit, slots - outsideBusy));
};

const anyHostUp = (pool: PoolConfig, snapshot: Snapshot) => pool.hosts.length === 0 || pool.hosts.some((h) => snapshot.hosts[h.id]?.up);

const minutesSince = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / 60_000;

export const DEFAULT_REASSIGN_AFTER_MINUTES = 30;
// Points of quota left by which the other subscription must lead before a switching pool moves an agent to it.
export const SWITCH_MARGIN = 20;

// P2.6: a sticky pool keeps each task on one engine for its prompt cache. Capacity is counted per engine, and the
// pool total still applies. Per task, in queue order:
// - on one of the pool's sticky models: it belongs to that engine and only goes when that engine has room;
// - on an entry model: it's placed on its parent task's engine if the parent has one, else on the first engine (in
//   preference order) with room, and the placement sticks;
// - a task the plugin placed moves only once its engine has been down reassignAfterMinutes;
// - a person's override on an entry model is never replaced; it just waits for room in the pool.
const stickyActions = (input: {
  pool: PoolConfig;
  snapshot: Snapshot;
  now: Date;
  waiting: OpenTask[];
  holdsByIssue: Map<string, HeldTask>;
  poolRoom: number;
  paused: boolean;
}): Action[] => {
  const { pool, snapshot, now, waiting, holdsByIssue, paused } = input;
  const targets = pool.placement ?? [];
  // A target answers to its model and to any alias (another name that reaches only its engine).
  const byModel = new Map(targets.flatMap((t) => [t.model, ...(t.aliases ?? [])].map((m) => [m, t] as const)));
  const namesOf = (t: PlacementTarget) => new Set([t.model, ...(t.aliases ?? [])]);
  const hostConfig = new Map(pool.hosts.map((h) => [h.id, h]));
  const runIssues = new Set(snapshot.runs.map((r) => r.issueId));
  const occupying = snapshot.runs.filter((r) => r.poolId === pool.id && occupiesSlot(r));
  const exhausted = (model: string) => snapshot.exhausted?.[`${pool.companyId ?? ""}|${model}`];
  const free = new Map<string, number>();
  for (const t of targets) {
    // A quota pool's model has no engine: it has room unless its quota is used up (the pool limit still applies).
    if (!t.hostId) {
      free.set(t.model, exhausted(t.model) ? 0 : Infinity);
      continue;
    }
    const status = snapshot.hosts[t.hostId];
    const config = hostConfig.get(t.hostId);
    if (!status?.up || !config) {
      free.set(t.model, 0);
      continue;
    }
    const names = namesOf(t);
    const mine = occupying.filter((r) => r.model !== undefined && names.has(r.model)).length;
    const pending = snapshot.released.filter((r) => r.poolId === pool.id && r.model !== undefined && names.has(r.model) && !runIssues.has(r.issueId)).length;
    const outside = Math.max(0, (status.slotsBusy ?? 0) - mine);
    const slots = Math.min(t.cap ?? Infinity, status.slotsTotal ?? config.declaredSlots);
    free.set(t.model, Math.max(0, slots - outside - mine - pending));
  }
  let poolRoom = input.poolRoom;
  // An engine down, or a quota model used up, for reassignAfterMinutes: a task the plugin pinned there may move.
  const unavailableTooLong = (t: PlacementTarget) => {
    const limit = pool.reassignAfterMinutes ?? DEFAULT_REASSIGN_AFTER_MINUTES;
    if (!t.hostId) {
      const e = exhausted(t.model);
      return Boolean(e && minutesSince(e.since, now) >= limit);
    }
    const status = snapshot.hosts[t.hostId];
    const since = status?.lastChangeAt ?? status?.lastProbeAt;
    return Boolean(status && !status.up && since && minutesSince(since, now) >= limit);
  };
  const taskModel = new Map(snapshot.tasks.map((t) => [t.issueId, t.model]));
  const parentModel = (t: OpenTask) => {
    const model = t.parentId ? taskModel.get(t.parentId) ?? snapshot.placements?.[t.parentId] : undefined;
    return model ? byModel.get(model)?.model : undefined;
  };

  const entries = waiting
    .map((t) => ({ t, held: holdsByIssue.get(t.issueId) }))
    .map((e) => ({ ...e, q: { issueId: e.t.issueId, companyId: e.t.companyId, priority: e.held?.priority ?? e.t.priority, heldAt: e.held?.heldAt ?? snapshot.now } }))
    .sort((a, b) => byQueueOrder(a.q, b.q));
  // Switching pools: an idle agent on the pool's virtual model with a task waiting moves to the other subscription's
  // adapter when its own subscription's models are all used up and the other's aren't, or the other subscription has
  // SWITCH_MARGIN points more quota left. Its tasks wait one cycle while it switches.
  const out: Action[] = [];
  const switching = new Set<string>();
  if (pool.switchAdapters) {
    const agentModelName = virtualModel(pool.localId ?? pool.id);
    const occupied = new Set(snapshot.runs.map((r) => r.agentId));
    for (const a of (snapshot.poolAgents ?? []).filter((x) => x.model === agentModelName && (!pool.companyId || x.companyId === pool.companyId))) {
      const own = a.adapterType ? ADAPTER_PROVIDER[a.adapterType] : undefined;
      if (!own || occupied.has(a.id) || !entries.some((e) => e.t.agentId === a.id)) continue;
      const other = own === "anthropic" ? "openai" : "anthropic";
      const ownModels = targets.filter((x) => canRun(a.adapterType, x.model));
      const otherModels = targets.filter((x) => canRun(PROVIDER_ADAPTER[other], x.model));
      if (!otherModels.some((x) => !exhausted(x.model))) continue;
      const left = snapshot.subscriptionLeft?.[a.companyId];
      const ownOut = !ownModels.some((x) => !exhausted(x.model));
      const more = left?.[own] !== undefined && left?.[other] !== undefined && left[other]! >= left[own]! + SWITCH_MARGIN;
      if (!ownOut && !more) continue;
      out.push({
        // The agent keeps the pool's name: its tasks are placed on `to`'s side's models, and it can switch back later.
        kind: "switchAdapter", agentId: a.id, companyId: a.companyId, poolId: pool.id, fromAdapterType: a.adapterType!, toAdapterType: PROVIDER_ADAPTER[other], model: agentModelName,
        reason: ownOut ? "own subscription used up" : `${left![other]}% left vs ${left![own]}%`,
      });
      switching.add(a.id);
    }
  }

  // Out of quota for a task: every model its agent can run is used up (or on a down engine), and in a switching pool
  // the other subscription's models are too.
  const unavailable = (x: PlacementTarget) => (x.hostId ? !snapshot.hosts[x.hostId]?.up : Boolean(exhausted(x.model)));
  const outOfQuota = (t: OpenTask) => {
    const usable = targets.filter((x) => canRun(t.adapterType, x.model) || pool.switchAdapters);
    return usable.length > 0 && usable.every(unavailable);
  };

  const fresh: QueueEntry[] = [];
  for (const { t, held, q } of entries) {
    // Its last wake-up started no run: it keeps waiting, held, without taking the slot from the next task.
    if (held && snapshot.wakeCooldown?.[t.issueId]) continue;
    if (switching.has(t.agentId)) {
      if (!held) fresh.push(q);
      continue;
    }
    // Only models the task's agent can run (a Claude Code agent can't take a GPT model).
    const fits = (x: PlacementTarget | undefined) => x !== undefined && canRun(t.adapterType, x.model);
    let target = t.model ? byModel.get(t.model) : undefined;
    if (!fits(target)) target = undefined;
    // In a quota pool, a task still on its agent's own model (no override) may go to another of the agent's models when
    // that one is used up or full; a model someone set on the task stays.
    if (pool.kind === "quota" && target && t.model === t.agentModel && (exhausted(target.model) || (free.get(target.model) ?? 0) <= 0)) target = undefined;
    let reason: PlaceReason | undefined;
    // An engine capped at 0 takes no new work: a task the plugin placed there that hasn't started moves at once (a
    // running one finishes where it is).
    if (target && snapshot.placements?.[t.issueId] === t.model && (unavailableTooLong(target) || target.cap === 0)) {
      target = undefined;
      reason = "engineDown";
    }
    const humanPinned = !target && !reason && t.pinned;
    if (!target && !humanPinned) {
      const parentTarget = reason ? undefined : byModel.get(parentModel(t) ?? "");
      const fromParent = fits(parentTarget) ? parentTarget : undefined;
      target = fromParent ?? targets.find((x) => fits(x) && (free.get(x.model) ?? 0) > 0);
      reason ??= fromParent ? "parent" : "new";
    }
    const room = !paused && poolRoom > 0 && (humanPinned || (target !== undefined && (free.get(target.model) ?? 0) > 0));
    if (!room) {
      // P2.7.3: a task goes to the fallback pool (which places or holds it as usual) when this pool can't run it at all:
      // every model its agent can run is out of quota, or every engine is down. A task someone set a model on stays, and
      // so does one whose agent can switch to the other subscription here.
      if (!humanPinned && !paused && pool.fallbackPool && outOfQuota(t)) {
        out.push({ kind: "place", issueId: t.issueId, companyId: t.companyId, poolId: pool.id, model: virtualModel(pool.fallbackPool), reason: "fallback" });
        if (held) out.push({ kind: "release", issueId: t.issueId, companyId: t.companyId, poolId: pool.id, reason: "manual" });
        continue;
      }
      if (!held) fresh.push(q);
      continue;
    }
    // A task on the target's model or one of its aliases is already there.
    const onTarget = target !== undefined && t.model !== undefined && namesOf(target).has(t.model);
    if (target && !onTarget) out.push({ kind: "place", issueId: t.issueId, companyId: t.companyId, poolId: pool.id, model: target.model, reason: reason ?? "new" });
    if (held) out.push({ kind: "release", issueId: t.issueId, companyId: t.companyId, poolId: pool.id, reason: "capacity", ...(target ? { model: target.model } : {}) });
    // Only a task the plugin acts on takes a slot now, as in plain pools: a waiting task nobody wakes mustn't block.
    if (held || (target && !onTarget)) {
      if (target) free.set(target.model, (free.get(target.model) ?? 1) - 1);
      poolRoom -= 1;
    }
  }
  const order = [...entries.filter((e) => e.held).map((e) => e.q), ...fresh].sort(byQueueOrder);
  for (const q of fresh) out.push({ kind: "hold", issueId: q.issueId, companyId: q.companyId, poolId: pool.id, position: order.indexOf(q) + 1 });
  return out;
};

// P2 adds overflow (D1). Until then held tasks only queue.
const overflowActions = (): Action[] => [];

// Pure: the same snapshot always gives the same actions. Observe mode is the executor's concern (C6), so pool mode
// doesn't change what is decided here.
// Waiting is the point of a disabled pool, so it doesn't alert.
const waitAlerts = (pool: PoolConfig, queue: QueueEntry[], now: Date, at: string): Action[] =>
  (pool.disabled ? [] : queue).filter((entry) => minutesSince(entry.heldAt, now) > pool.alertAfterMinutes).map((entry) => ({
    kind: "alert",
    alert: { kind: "waitedTooLong", subject: entry.issueId, state: "start", poolId: pool.id, companyId: entry.companyId, at, message: `Waiting for ${pool.name} over ${pool.alertAfterMinutes} min` },
  }));

// A task taken out of the queue after its wake-ups kept starting no run stays reported until it runs or closes.
const parkedAlerts = (pool: PoolConfig, parked: OpenTask[], snapshot: Snapshot): Action[] =>
  parked.map((t) => ({
    kind: "alert",
    alert: {
      kind: "needsPerson", subject: t.issueId, state: "start", poolId: pool.id, companyId: t.companyId, at: snapshot.now,
      message: `Left the ${pool.name} queue after ${snapshot.parked?.[t.issueId]?.failures ?? 0} wake-ups started no run; open the task and ask it to continue`,
    },
  }));

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
    // A parked task needs a person, not a slot: it neither waits in the queue nor is held again.
    const parkedTasks = tasks.filter((t) => snapshot.parked?.[t.issueId] && OPEN.has(t.status) && !t.hasActiveRun);
    // An idle task (it ran and nothing new arrived) doesn't want a run: it neither waits nor takes a slot, and a hold it
    // still has is dropped without a wake-up.
    for (const t of tasks) {
      if (t.idle && !t.hasActiveRun && holdsByIssue.has(t.issueId)) actions.push({ kind: "release", issueId: t.issueId, companyId: t.companyId, poolId: pool.id, reason: "idle" });
    }
    const waiting = tasks.filter((t) => OPEN.has(t.status) && !t.hasActiveRun && !t.idle && !snapshot.parked?.[t.issueId]);
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

    if (pool.placement?.length) {
      actions.push(...stickyActions({
        pool, snapshot, now, waiting: waiting.filter((t) => !isExempt(t)), holdsByIssue,
        poolRoom: Math.max(0, available - count), paused: heldPools.has(pool.id) || pool.disabled === true,
      }));
      actions.push(...waitAlerts(pool, queue, now, snapshot.now), ...parkedAlerts(pool, parkedTasks, snapshot));
      continue;
    }

    // C2/C3: release the head of the queue into free slots. Nothing is released while over the limit (B4), while an
    // operator holds the pool (F2), or while every host is down (E3).
    let used = count;
    queue.sort(byQueueOrder);
    // A quota pool that keeps its name (no placement) can't move a task to another model, so it holds everything while
    // every one of its models is paused (prepaid credit or quota used up).
    const ownModels = pool.kind === "quota" ? pool.patterns.filter((m) => m !== virtualModel(pool.localId ?? pool.id)) : [];
    const allPaused = ownModels.length > 0 && ownModels.every((m) => snapshot.exhausted?.[`${pool.companyId ?? group.companyId}|${m}`]);
    const paused = heldPools.has(pool.id) || pool.disabled === true || allPaused;
    if (!paused && anyHostUp(pool, snapshot)) {
      // A task whose last wake-up started no run stays queued and is passed over.
      const ready = queue.filter((e) => !snapshot.wakeCooldown?.[e.issueId]);
      for (const entry of ready.splice(0, Math.max(0, available - used))) {
        queue.splice(queue.indexOf(entry), 1);
        actions.push({ kind: "release", issueId: entry.issueId, companyId: entry.companyId, poolId: pool.id, reason: "capacity" });
        used += 1;
      }
    }

    // C1: once the pool is full (or held), every other open, non-exempt task without a run waits behind the queue.
    if (used >= available || paused) {
      const fresh = waiting
        .filter((t) => !isExempt(t) && !holdsByIssue.has(t.issueId))
        .map((t) => ({ issueId: t.issueId, companyId: t.companyId, priority: t.priority, heldAt: snapshot.now }));
      const order = [...queue, ...fresh].sort(byQueueOrder);
      for (const entry of fresh) {
        actions.push({ kind: "hold", issueId: entry.issueId, companyId: entry.companyId, poolId: pool.id, position: order.indexOf(entry) + 1 });
      }
    }

    actions.push(...waitAlerts(pool, queue, now, snapshot.now), ...parkedAlerts(pool, parkedTasks, snapshot));
  }
  return [...actions, ...overflowActions()];
};
