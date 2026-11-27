import { OPEN_TASK_STATUSES, PRIORITY_RANK, VIRTUAL_MODEL_PREFIX, virtualModel } from "../constants.js";
import { ADAPTER_PROVIDER, PROVIDER_ADAPTER, canAgentRun, canRun, cannotRunKey, poolAcceptsAdapter, type RunLimits } from "./model.js";
import { occupiesSlot, type Action, type OverflowReason, type HeldTask, type OpenTask, type PlaceReason, type PlacementTarget, type PoolConfig, type Snapshot, type TaskPriority } from "../types.js";

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
  // Every open task of the pool without a run, whether or not it waits for a slot (idle, exempt and parked ones too).
  open?: OpenTask[];
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
  // JD-1245: a CLI adapter runs only the models it lists, and an agent never gets a model its runs proved it can't use.
  const limits: RunLimits = { adapterModels: snapshot.adapterModels, cannotRun: snapshot.cannotRun };
  const runs = (t: OpenTask, model: string) => canAgentRun(t, model, limits);
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

  // An agent's adapter changed: a model override the plugin put on its tasks for the old adapter (Claude on a Codex agent,
  // or the reverse) would fail the next time a comment wakes the task, and the host wakes it without asking the plugin.
  // So every open task of such an agent that isn't a person's pin is moved onto a model of the adapter it will have, now,
  // whether or not it waits for a slot (placing only sets the override; it neither wakes nor holds the task). Tasks of an
  // agent that is switching this cycle go to the new adapter's models at once instead of waiting a cycle.
  const switchTo = new Map(out.flatMap((a) => (a.kind === "switchAdapter" ? [[a.agentId, a.toAdapterType] as const] : [])));
  const waitingIds = new Set(waiting.map((t) => t.issueId));
  for (const t of input.open ?? []) {
    const adapterType = switchTo.get(t.agentId) ?? t.adapterType;
    // Waiting tasks of an agent that isn't switching are re-placed by the queue pass below, with capacity counted.
    if (waitingIds.has(t.issueId) && !switchTo.has(t.agentId)) continue;
    // Only a plugin-written override (t.model differs from the agent's own, and isn't a pool's own name) that the adapter can't run, never a pin.
    if (t.pinned || !t.model || t.model === t.agentModel || t.model.startsWith(VIRTUAL_MODEL_PREFIX) || canAgentRun({ agentId: t.agentId, adapterType }, t.model, limits)) continue;
    const fitsNow = (x: PlacementTarget | undefined) => x !== undefined && canAgentRun({ agentId: t.agentId, adapterType }, x.model, limits);
    const parentTarget = byModel.get(parentModel(t) ?? "");
    const target = fitsNow(parentTarget) ? parentTarget : targets.find((x) => fitsNow(x) && !exhausted(x.model)) ?? targets.find((x) => fitsNow(x));
    if (target) out.push({ kind: "place", issueId: t.issueId, companyId: t.companyId, poolId: pool.id, model: target.model, reason: "adapterChanged" });
  }

  // Out of quota for a task: every model its agent can run is used up (or on a down engine), and in a switching pool
  // the other subscription's models are too.
  const unavailable = (x: PlacementTarget) => (x.hostId ? !snapshot.hosts[x.hostId]?.up : Boolean(exhausted(x.model)));
  const outOfQuota = (t: OpenTask) => {
    const usable = targets.filter((x) => runs(t, x.model) || pool.switchAdapters);
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
    const fits = (x: PlacementTarget | undefined) => x !== undefined && runs(t, x.model);
    let target = t.model ? byModel.get(t.model) : undefined;
    // A task the plugin put on a model its agent's runs then failed on ("not available for this API key") moves off it.
    // A model a person set stays.
    const learned = target !== undefined && !t.pinned && Boolean(snapshot.cannotRun?.[cannotRunKey(t.agentId, target.model)]);
    if (!fits(target)) target = undefined;
    // In a quota pool, a task still on its agent's own model (no override) may go to another of the agent's models when
    // that one is used up or full; a model someone set on the task stays.
    if (pool.kind === "quota" && target && t.model === t.agentModel && (exhausted(target.model) || (free.get(target.model) ?? 0) <= 0)) target = undefined;
    let reason: PlaceReason | undefined = learned ? "agentCannotRun" : undefined;
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

// D1: a held task leaves a pool that can't run it for the first pool on its overflow list that takes the task and has a
// slot. The pool's own triggers fire the move: no host of it is up (E3), `immediately` is on, or the task has waited past
// `afterMinutes` — with none of them on, held tasks only queue. A person's pin never leaves its pool (D4), and a pool an
// operator holds or disables releases nothing, so it overflows nothing either. A task the pool could run this cycle, or whose
// last wake-up started no run, doesn't move.
// Privacy is the PRD's A10: private work never moves to a shared pool, while shared work may join a private one.
// The model comes from the target pool the way placement picks one (its overflow model, else a placement target its
// agent can run and that is free, so an engine target still gets an up engine and a quota target a model with quota
// left, else the pool's own name for a pool that keeps names, else one of its patterns). A pool takes at most its own
// free slots of overflowed tasks in one cycle.
const overflowActions = (input: {
  snapshot: Snapshot;
  now: Date;
  scopes: { pool: PoolConfig; queue: QueueEntry[]; tasks: OpenTask[] }[];
  // Issue ids the pool gave a run slot to this cycle: the task can run where it is, so it doesn't move. A task it
  // only placed (a model inside the pool, still no room) keeps waiting, and may still go elsewhere after the wait.
  taken: Set<string>;
  runsPerPool: Map<string, number>;
}): Action[] => {
  const { snapshot, now, scopes, taken, runsPerPool } = input;
  const heldPools = new Set(snapshot.heldPools);
  const limits: RunLimits = { adapterModels: snapshot.adapterModels, cannotRun: snapshot.cannotRun };
  // Room in each target pool, the way the main loop measures a pool: its capacity less what already sits on it
  // (runs holding a slot, plus released tasks whose run hasn't shown up), and less the tasks overflowing into it this cycle.
  const runIssues = new Set(snapshot.runs.map((r) => r.issueId));
  const usedOn = (p: PoolConfig) => snapshot.runs.filter((r) => r.poolId === p.id && occupiesSlot(r)).length
    + snapshot.released.filter((r) => r.poolId === p.id && !runIssues.has(r.issueId)).length;
  const room = new Map<string, number>();
  const freeIn = (p: PoolConfig) => room.get(p.id) ?? Math.max(0, availableCapacity(p, snapshot, runsPerPool.get(p.id) ?? 0) - usedOn(p));
  const exhausted = (p: PoolConfig, model: string) => snapshot.exhausted?.[`${p.companyId ?? ""}|${model}`];
  // Whether a pool takes this task: privacy allows the move, the task's company may use the pool, the pool takes its
  // agent's adapter at all, and the pool isn't disabled (a disabled pool keeps work out).
  const takes = (from: PoolConfig, to: PoolConfig, t: OpenTask) =>
    !(from.privacy === "private" && to.privacy === "shared")
    && (!to.companyId || to.companyId === t.companyId)
    && companyAllowed(to, t.companyId)
    && poolAcceptsAdapter(to, t.adapterType)
    && !to.disabled;
  // The model a task gets on the target pool, chosen the way placement chooses one.
  const modelFor = (t: OpenTask, p: PoolConfig) => {
    const runs = (m: string | undefined) => m !== undefined && canAgentRun({ agentId: t.agentId, adapterType: t.adapterType }, m, limits);
    if (runs(p.overflowModel)) return p.overflowModel;
    const targets = p.placement ?? [];
    const open = (x: PlacementTarget) => (x.hostId ? Boolean(snapshot.hosts[x.hostId]?.up) : !exhausted(p, x.model));
    return targets.find((x) => runs(x.model) && open(x))?.model
      ?? (runs(p.agentModel) ? p.agentModel : undefined) ?? p.patterns.find((m) => runs(m) && !m.includes("*"));
  };
  // The first pool on the overflow list that takes the task and has a slot and a model for it.
  const firstTarget = (from: PoolConfig, t: OpenTask, ids: string[]) => {
    for (const id of ids) {
      const p = snapshot.pools.find((x) => (x.id === id || x.localId === id) && takes(from, x, t));
      const model = p ? modelFor(t, p) : undefined;
      if (p && model !== undefined && freeIn(p) > 0) return { pool: p, model };
    }
    return undefined;
  };
  const out: Action[] = [];
  for (const scope of scopes) {
    const { pool, queue, tasks } = scope;
    const overflow = pool.overflow;
    if (!overflow?.pools?.length || heldPools.has(pool.id) || pool.disabled) continue;
    const tasksById = new Map(tasks.map((t) => [t.issueId, t]));
    // E3: a pool with no host up can run nothing, so its whole queue may go elsewhere.
    const hostsDown = overflow.whenHostsDown && !anyHostUp(pool, snapshot);
    for (const entry of queue) {
      const t = tasksById.get(entry.issueId);
      if (!t || t.pinned || taken.has(t.issueId) || snapshot.wakeCooldown?.[t.issueId]) continue;
      let reason: OverflowReason | undefined;
      if (hostsDown) reason = "hostsDown";
      else if (overflow.immediately) reason = "immediate";
      else if (overflow.afterMinutes !== undefined && minutesSince(entry.heldAt, now) > overflow.afterMinutes) reason = "waited";
      if (!reason) continue;
      const hit = firstTarget(pool, t, overflow.pools);
      if (!hit) continue;
      room.set(hit.pool.id, freeIn(hit.pool) - 1);
      out.push({ kind: "overflow", issueId: t.issueId, companyId: t.companyId, fromPoolId: pool.id, toPoolId: hit.pool.id, model: hit.model, reason });
    }
  }
  return out;
};

// D3: an override the plugin wrote to overflow a task is put back once that run is over (finished, failed or cancelled).
// The snapshot only tells whether a run is going now, so a run counts as ended when the task is open with no run, no hold,
// and no release of its own waiting for a run to appear. A model a person has since set is left alone (D4), and so is a
// task that left the board. `original` null is the plugin's own first override, which comes off rather than a value.
// The executor deletes the record as it restores, so a task is never restored twice.
const restoreActions = (snapshot: Snapshot): Action[] => {
  const tasksById = new Map(snapshot.tasks.map((t) => [t.issueId, t]));
  const runIssues = new Set(snapshot.runs.map((r) => r.issueId));
  const held = new Set(snapshot.holds.map((h) => h.issueId));
  const awaitingRun = new Set(snapshot.released.filter((r) => !runIssues.has(r.issueId)).map((r) => r.issueId));
  const out: Action[] = [];
  for (const record of Object.values(snapshot.overflowOverrides ?? {})) {
    const t = tasksById.get(record.issueId);
    if (!t || t.pinned || held.has(t.issueId) || awaitingRun.has(t.issueId) || runIssues.has(t.issueId) || !OPEN.has(t.status)) continue;
    out.push({ kind: "restore", issueId: t.issueId, companyId: t.companyId, original: record.original });
  }
  return out;
};

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
  // Each pool's queue as the loop found it, so overflow can run over it afterwards (a task the pool released this cycle
  // is already out of the queue, or in `taken` below for a sticky pool).
  const overflowScopes: { pool: PoolConfig; queue: QueueEntry[]; tasks: OpenTask[] }[] = [];
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
    overflowScopes.push({ pool, queue, tasks });

    if (count > available) {
      actions.push({
        kind: "alert",
        alert: { kind: "overLimit", subject: key, state: "start", poolId: pool.id, companyId: pool.companyId ?? group.companyId, at: snapshot.now, message: `${pool.name}: ${count} runs, limit ${available}` },
      });
    }

    if (pool.placement?.length) {
      actions.push(...stickyActions({
        pool, snapshot, now, waiting: waiting.filter((t) => !isExempt(t)), holdsByIssue,
        open: tasks.filter((t) => OPEN.has(t.status) && !t.hasActiveRun),
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
  // JD-1245: each agent + model pair learned from failed runs is reported until it expires.
  for (const c of Object.values(snapshot.cannotRun ?? {})) {
    actions.push({
      kind: "alert",
      alert: {
        kind: "agentCannotRun", subject: cannotRunKey(c.agentId, c.model), state: "start", companyId: c.companyId, at: snapshot.now,
        message: `An agent's runs on ${c.model} failed because it can't use that model (${c.error.slice(0, 120)}); not placing it there until ${c.until}`,
      },
    });
  }
  // A task the pool gave a slot to this cycle runs where it is, so it doesn't leave the pool. A task it only placed
  // (a model inside the pool, still no room) waits, and after the wait it may still go elsewhere.
  const taken = new Set(actions.flatMap((a) => (a.kind === "release" ? [a.issueId] : [])));
  return [...actions, ...restoreActions(snapshot), ...overflowActions({ snapshot, now, scopes: overflowScopes, taken, runsPerPool })];
};
