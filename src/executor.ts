import type { PluginContext } from "@paperclipai/plugin-sdk";

import { RELEASE_EXPIRY_MS, WAKE_CONFIRM_MS } from "./constants.js";
import manifest from "./manifest.js";
import type { HistoryEntry, Store } from "./state/store.js";
import type { Action, HeldTask, PoolConfig, ReleasedTask, Snapshot } from "./types.js";

// Queue blockers are found again after a restart by this origin (C4); originId is the pool id.
export const QUEUE_ORIGIN_KIND = `plugin:${manifest.id}:queue` as const;
const CLOSED = new Set(["done", "cancelled"]);

export interface ExecutorDeps {
  ctx: PluginContext;
  store: Store;
  // The operator-chosen existing label for held tasks, if any (plugins can't create labels).
  queueLabelId?: (companyId: string) => Promise<string | undefined>;
  now?: Date;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const createExecutor = ({ ctx, store, queueLabelId = async () => undefined, now: fixedNow }: ExecutorDeps) => {
  const now = () => fixedNow ?? new Date();

  const createBlocker = (companyId: string, pool: PoolConfig) =>
    ctx.issues.create({
      companyId, title: `${pool.name} queue`, status: "todo", originKind: QUEUE_ORIGIN_KIND, originId: pool.id,
      description: `Model capacity plugin: tasks waiting for the ${pool.name} pool are blocked by this task. Don't close it as done: that would start every waiting task at once.`,
    });

  // C1a: create the pool's blocker on first use, and recreate it if it was deleted or closed, re-pointing held tasks.
  const ensureBlocker = async (companyId: string, pool: PoolConfig) => {
    const blockers = store.queueBlockers(companyId);
    const map = await blockers.get();
    const existing = map[pool.id] ? await ctx.issues.get(map[pool.id], companyId) : null;
    if (existing && !CLOSED.has(existing.status)) return existing.id;
    const fresh = await createBlocker(companyId, pool);
    await blockers.set({ ...map, [pool.id]: fresh.id });
    if (map[pool.id]) {
      const holds = await store.holds.get();
      for (const hold of Object.values(holds)) {
        if (hold.companyId !== companyId || hold.poolId !== pool.id) continue;
        await ctx.issues.relations.removeBlockers(hold.issueId, [map[pool.id]], companyId);
        await ctx.issues.relations.addBlockers(hold.issueId, [fresh.id], companyId);
        holds[hold.issueId] = { ...hold, blockerId: fresh.id };
      }
      await store.holds.set(holds);
      ctx.logger.warn("Queue blocker was missing or closed; recreated it", { companyId, poolId: pool.id });
    }
    return fresh.id;
  };

  const setLabel = async (issueId: string, companyId: string, add: boolean) => {
    const labelId = await queueLabelId(companyId);
    if (!labelId) return;
    const issue = await ctx.issues.get(issueId, companyId);
    const current = issue?.labelIds ?? [];
    const next = add ? [...new Set([...current, labelId])] : current.filter((id) => id !== labelId);
    if (next.length !== current.length) await ctx.issues.update(issueId, { labelIds: next }, companyId);
  };

  const hold = async (a: Extract<Action, { kind: "hold" }>, pool: PoolConfig, snapshot: Snapshot) => {
    const holds = await store.holds.get();
    if (holds[a.issueId]) {
      await store.holds.set({ ...holds, [a.issueId]: { ...holds[a.issueId], position: a.position } });
      return;
    }
    const blockerId = await ensureBlocker(a.companyId, pool);
    await ctx.issues.relations.addBlockers(a.issueId, [blockerId], a.companyId);
    await setLabel(a.issueId, a.companyId, true);
    // One comment per hold, never one per position change (C1).
    await ctx.issues.createComment(a.issueId, `Waiting for ${pool.name} (position ${a.position}). Model capacity plugin.`, a.companyId);
    const task = snapshot.tasks.find((t) => t.issueId === a.issueId);
    const held: HeldTask = { issueId: a.issueId, companyId: a.companyId, poolId: a.poolId, priority: task?.priority ?? "medium", heldAt: now().toISOString(), position: a.position, blockerId };
    await store.holds.set({ ...(await store.holds.get()), [a.issueId]: held });
  };

  const wake = async (issueId: string, companyId: string) => {
    const result = await ctx.issues.requestWakeup(issueId, companyId, { reason: "Model capacity: a slot is free" });
    return result.runId ?? undefined;
  };

  const release = async (a: Extract<Action, { kind: "release" }>) => {
    const holds = await store.holds.get();
    const held = holds[a.issueId];
    const blockerId = held?.blockerId ?? (await store.queueBlockers(a.companyId).get())[a.poolId];
    if (blockerId) await ctx.issues.relations.removeBlockers(a.issueId, [blockerId], a.companyId);
    await setLabel(a.issueId, a.companyId, false);
    delete holds[a.issueId];
    await store.holds.set(holds);
    // Removing a blocker doesn't wake the task, so wake it; store the run so it counts until it starts (B2).
    const runId = await wake(a.issueId, a.companyId);
    const released: ReleasedTask = { issueId: a.issueId, companyId: a.companyId, poolId: a.poolId, runId, releasedAt: now().toISOString() };
    await store.released.set({ ...(await store.released.get()), [a.issueId]: released });
  };

  // Applies decide()'s actions. Observe-mode pools record the decision and change nothing (C6). Overflow, restore
  // (P2) and alerts (P1.10) are recorded here and handled elsewhere.
  // Observe mode and alerts produce the same unapplied action every cycle while nothing changes; history records each
  // once, until it stops being decided.
  const repeatKey = (a: Action) =>
    a.kind === "alert" ? `alert:${a.alert.kind}:${a.alert.subject}` : `${a.kind}:${"issueId" in a ? a.issueId : ""}:${"poolId" in a ? a.poolId : ""}`;

  const execute = async (actions: Action[], snapshot: Snapshot): Promise<HistoryEntry[]> => {
    const pools = new Map(snapshot.pools.map((p) => [p.id, p]));
    const seenBefore = new Set(await store.observed.get());
    const seenNow: string[] = [];
    const entries: HistoryEntry[] = [];
    for (const action of actions) {
      const poolId = action.kind === "alert" ? action.alert.poolId : action.kind === "overflow" ? action.fromPoolId : "poolId" in action ? action.poolId : undefined;
      const pool = poolId ? pools.get(poolId) : undefined;
      const apply = pool?.mode === "enforce" && (action.kind === "hold" || action.kind === "release");
      try {
        if (apply && action.kind === "hold") await hold(action, pool, snapshot);
        if (apply && action.kind === "release") await release(action);
        if (!apply) {
          const key = repeatKey(action);
          seenNow.push(key);
          if (seenBefore.has(key)) continue;
        }
        entries.push({ at: now().toISOString(), applied: apply, action });
      } catch (e) {
        ctx.logger.warn("Model capacity action failed", { kind: action.kind, poolId, error: errText(e) });
        entries.push({ at: now().toISOString(), applied: false, action });
      }
    }
    await store.observed.set(seenNow);
    if (entries.length) await store.appendHistory(entries);
    return entries;
  };

  // C5/C7: a person removed our blocker, or the task closed: it leaves the queue and the plugin doesn't fight it.
  const reconcileHolds = async (snapshot: Snapshot) => {
    const holds = await store.holds.get();
    const open = new Set(snapshot.tasks.map((t) => t.issueId));
    let changed = false;
    for (const held of Object.values(holds)) {
      let reason: string | undefined;
      if (!open.has(held.issueId)) reason = "task closed or no longer in the pool";
      else if (held.blockerId) {
        const relations = await ctx.issues.relations.get(held.issueId, held.companyId);
        if (!relations.blockedBy.some((b) => b.id === held.blockerId)) reason = "queue blocker removed by a person";
      }
      if (!reason) continue;
      delete holds[held.issueId];
      changed = true;
      await ctx.activity.log({ companyId: held.companyId, message: `Model capacity: left the ${held.poolId} queue (${reason})`, entityType: "issue", entityId: held.issueId, metadata: { poolId: held.poolId } });
    }
    if (changed) await store.holds.set(holds);
  };

  // C3: once a released task's run shows up it counts as a run; if none shows up, wake once more, then let it go.
  const confirmWakes = async (snapshot: Snapshot) => {
    const released = await store.released.get();
    const running = new Set(snapshot.runs.map((r) => r.issueId));
    let changed = false;
    for (const entry of Object.values(released)) {
      const age = now().getTime() - Date.parse(entry.releasedAt);
      if (running.has(entry.issueId) || age > RELEASE_EXPIRY_MS) {
        delete released[entry.issueId];
        changed = true;
      } else if (age > WAKE_CONFIRM_MS && !entry.wakeRetried) {
        try {
          released[entry.issueId] = { ...entry, runId: (await wake(entry.issueId, entry.companyId)) ?? entry.runId, wakeRetried: true };
        } catch (e) {
          ctx.logger.warn("Model capacity wake retry failed", { issueId: entry.issueId, error: errText(e) });
          released[entry.issueId] = { ...entry, wakeRetried: true };
        }
        changed = true;
      }
    }
    if (changed) await store.released.set(released);
  };

  // F1: release one held task now, ignoring the limit and the pool's mode.
  const releaseNow = (issueId: string, companyId: string, poolId: string) => release({ kind: "release", issueId, companyId, poolId, reason: "manual" });

  return { execute, reconcileHolds, confirmWakes, ensureBlocker, releaseNow };
};

export type Executor = ReturnType<typeof createExecutor>;
