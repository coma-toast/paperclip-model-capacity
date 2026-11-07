import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";

import { PARK_AFTER_FAILED_WAKES, RELEASE_EXPIRY_MS, WAKE_CONFIRM_MS, WAKE_COOLDOWN_MS } from "./constants.js";
import { DRAIN_GRACE_MS } from "./drain.js";
import manifest from "./manifest.js";
import { splitPoolKey } from "./pools.js";
import type { HistoryEntry, Store } from "./state/store.js";
import { quotaTokenFor } from "./subscriptions.js";
import type { Action, HeldTask, PoolConfig, ReleasedTask, RunningRun, Snapshot } from "./types.js";

// Queue blockers are found again after a restart by this origin (C4); originId is the pool id.
export const QUEUE_ORIGIN_KIND = `plugin:${manifest.id}:queue` as const;
const CLOSED = new Set(["done", "cancelled"]);
// An agent's own settings, kept when it switches between Claude Code and Codex; the rest belong to the adapter.
const AGENT_OWN_KEYS = ["model", "instructionsBundleMode", "instructionsEntryFile", "instructionsFilePath", "instructionsRootPath", "paperclipSkillSync"];
// Environment variables that belong to one tool, left behind when an agent moves to the other.
const TOOL_ENV = /^(CLAUDE|ANTHROPIC|CODEX|OPENAI)_/;

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

  const hold = async (a: Extract<Action, { kind: "hold" }>, pool: PoolConfig, snapshot: Snapshot, opts: { heldAt?: string; comment?: string; cancellationSource?: "drain" | "manual" | "other" } = {}) => {
    const holds = await store.holds.get();
    if (holds[a.issueId]) {
      await store.holds.set({ ...holds, [a.issueId]: { ...holds[a.issueId], position: a.position } });
      return;
    }
    const blockerId = await ensureBlocker(a.companyId, pool);
    await ctx.issues.relations.addBlockers(a.issueId, [blockerId], a.companyId);
    await setLabel(a.issueId, a.companyId, true);
    // One comment per hold, never one per position change (C1).
    await ctx.issues.createComment(a.issueId, opts.comment ?? `Waiting for ${pool.name} (position ${a.position}). Model capacity plugin.`, a.companyId);
    const task = snapshot.tasks.find((t) => t.issueId === a.issueId);
    const held: HeldTask = {
      issueId: a.issueId, companyId: a.companyId, poolId: a.poolId, priority: task?.priority ?? "medium", heldAt: opts.heldAt ?? now().toISOString(), position: a.position, blockerId,
      ...(task?.status && task.status !== "blocked" ? { statusBefore: task.status } : {}),
      ...(opts.cancellationSource ? { cancellationSource: opts.cancellationSource } : {}),
    };
    await store.holds.set({ ...(await store.holds.get()), [a.issueId]: held });
  };

  // A released task still "blocked" with no other open blocker gets its status from before the hold (or todo). Returns
  // whether it's still blocked by something else.
  const unblock = async (issueId: string, companyId: string, statusBefore?: string) => {
    const issue = await ctx.issues.get(issueId, companyId);
    if (issue?.status !== "blocked") return false;
    const open = (await ctx.issues.relations.get(issueId, companyId)).blockedBy.filter((b) => !CLOSED.has(String((b as { status?: unknown }).status ?? "")));
    if (open.length) return true;
    await ctx.issues.update(issueId, { status: (statusBefore ?? "todo") as Issue["status"] }, companyId);
    return false;
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
    // Paperclip leaves a task "blocked" when its last blocker is removed, and then drops the wake-up, so the slot sat
    // empty while the task was held again in a loop. With no other open blocker left, put its status back first.
    const stillBlocked = await unblock(a.issueId, a.companyId, held?.statusBefore);
    // Removing a blocker doesn't wake the task, so wake it; store the run so it counts until it starts (B2). A task
    // that can't run (another blocker) reserves nothing, so the slot goes to the next task.
    const runId = await wake(a.issueId, a.companyId);
    if (!runId) {
      const failures = ((await store.wakeFailures.get())[a.issueId] ?? 0) + 1;
      if (held && failures >= PARK_AFTER_FAILED_WAKES) {
        // Its wake-ups keep starting no run, so something only a person can clear stops it (for example, Paperclip
        // wants someone to confirm an earlier run first). Leave it out of the queue, unblocked and unlabelled, and say
        // so, instead of holding and waking it every cycle while it shows as waiting.
        const { [a.issueId]: _failed, ...otherFailures } = await store.wakeFailures.get();
        await store.wakeFailures.set(otherFailures);
        await store.parked.set({ ...(await store.parked.get()), [a.issueId]: { issueId: a.issueId, companyId: a.companyId, poolId: a.poolId, since: now().toISOString(), failures } });
        await ctx.activity.log({ companyId: a.companyId, message: `Model capacity: ${failures} wake-ups started no run, so this task left the queue; it needs a person to continue it`, entityType: "issue", entityId: a.issueId, metadata: { poolId: a.poolId, failures } }).catch(() => undefined);
        return;
      }
      await store.wakeFailures.set({ ...(await store.wakeFailures.get()), [a.issueId]: failures });
      // No run started: the task can't run now. Put the hold back without a new comment, and skip it for a while so
      // the slot goes to the next task instead of this one being released and held again every cycle.
      if (held && blockerId) {
        if (!stillBlocked) await ctx.issues.relations.addBlockers(a.issueId, [blockerId], a.companyId);
        await setLabel(a.issueId, a.companyId, true);
        await store.holds.set({ ...(await store.holds.get()), [a.issueId]: held });
      }
      await store.wakeCooldown.set({ ...(await store.wakeCooldown.get()), [a.issueId]: new Date(now().getTime() + WAKE_COOLDOWN_MS).toISOString() });
      return;
    }
    const failures = await store.wakeFailures.get();
    if (failures[a.issueId] !== undefined) {
      const { [a.issueId]: _ok, ...rest } = failures;
      await store.wakeFailures.set(rest);
    }
    const released: ReleasedTask = { issueId: a.issueId, companyId: a.companyId, poolId: a.poolId, runId, ...(a.model ? { model: a.model } : {}), releasedAt: now().toISOString() };
    await store.released.set({ ...(await store.released.get()), [a.issueId]: released });
  };

  // P2.6: puts a task on one engine by setting its model override (other override keys are kept), and records it as the
  // plugin's own so it isn't mistaken for a person's pin and can be undone when the task closes. The plugin SDK's
  // issues.update type doesn't list assigneeAdapterOverrides, but the host passes the patch through.
  const place = async (a: Extract<Action, { kind: "place" }>) => {
    const issue = await ctx.issues.get(a.issueId, a.companyId);
    if (!issue?.assigneeAgentId) return;
    const records = await store.overrides.get();
    const original = records[a.issueId]?.original ?? issue.assigneeAdapterOverrides ?? null;
    const current = issue.assigneeAdapterOverrides ?? {};
    const next = { ...current, adapterConfig: { ...(current.adapterConfig ?? {}), model: a.model } };
    await ctx.issues.update(a.issueId, { assigneeAdapterOverrides: next } as unknown as Parameters<typeof ctx.issues.update>[1], a.companyId);
    await store.overrides.set({
      ...(await store.overrides.get()),
      [a.issueId]: { issueId: a.issueId, agentId: issue.assigneeAgentId, model: a.model, original, fromPoolId: a.poolId, toPoolId: a.poolId, at: now().toISOString() },
    });
  };

  // Switching pools: moves an idle agent between Claude Code and Codex, onto the model decided for that side. Its own
  // settings (instructions, skills) carry over; the adapter's own come from the agent's last time on it, or else from another agent on that adapter.
  // The settings it leaves are kept for switching back. The SDK can't change an agent, so this uses Paperclip's API with
  // the board token from the plugin's settings.
  const switchAdapter = async (a: Extract<Action, { kind: "switchAdapter" }>) => {
    const agent = await ctx.agents.get(a.agentId, a.companyId);
    if (!agent || agent.adapterType !== a.fromAdapterType) return;
    const auth = await quotaTokenFor(ctx, a.companyId);
    if (!auth) throw new Error("Switching an agent between Claude Code and Codex needs the board token in the plugin's settings");
    const profiles = await store.adapterProfiles(a.companyId).get();
    const current = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    let base = profiles[a.agentId]?.[a.toAdapterType];
    if (!base) {
      const template = (await ctx.agents.list({ companyId: a.companyId })).find((x) => x.adapterType === a.toAdapterType && x.id !== a.agentId);
      if (!template) throw new Error(`No ${a.toAdapterType} agent in this company to copy settings from`);
      const t = (template.adapterConfig ?? {}) as Record<string, unknown>;
      // The template's env plus this agent's own variables, leaving out the other tool's.
      const env = { ...((t.env as Record<string, unknown> | undefined) ?? {}), ...Object.fromEntries(Object.entries((current.env as Record<string, unknown> | undefined) ?? {}).filter(([k]) => !TOOL_ENV.test(k))) };
      base = { ...t, env };
    }
    const own = Object.fromEntries(AGENT_OWN_KEYS.filter((k) => k in current).map((k) => [k, current[k]]));
    const res = await ctx.http.fetch(`${auth.baseUrl}/api/agents/${encodeURIComponent(a.agentId)}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ adapterType: a.toAdapterType, adapterConfig: { ...base, ...own, model: a.model }, replaceAdapterConfig: true }),
    });
    if (!res.ok) throw new Error(`Paperclip refused the switch (${res.status}): ${(await res.text()).slice(0, 200)}`);
    await store.adapterProfiles(a.companyId).set({ ...profiles, [a.agentId]: { ...profiles[a.agentId], [a.fromAdapterType]: current } });
  };

  // A run on a draining engine past its grace period, or one a board user moved: it's cancelled with the board token
  // (the SDK can't cancel runs) and its task held in its pool, so the next cycle places it on another engine and wakes
  // it. It keeps its place in the queue by when its run started.
  const drainRun = async (run: RunningRun, engineName: string, pool: PoolConfig, snapshot: Snapshot, forced: boolean) => {
    const auth = await quotaTokenFor(ctx, run.companyId);
    if (!auth) throw new Error("Moving a run off a draining engine needs the board token in the plugin's settings");
    const res = await ctx.http.fetch(`${auth.baseUrl}/api/heartbeat-runs/${encodeURIComponent(run.runId)}/cancel`, {
      method: "POST", headers: { Authorization: `Bearer ${auth.token}`, "content-type": "application/json" }, body: "{}",
    });
    if (!res.ok) throw new Error(`Paperclip refused to cancel the run (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const why = forced ? "a board user moved it" : `its run hadn't finished ${DRAIN_GRACE_MS / 60_000} min after the engine stopped taking work`;
await hold({ kind: "hold", issueId: run.issueId, companyId: run.companyId, poolId: pool.id, position: 1 }, pool, snapshot, {
       heldAt: run.startedAt ?? run.queuedAt,
       comment: `Moved off ${engineName} (${why}): the run was cancelled and the task restarts on another ${pool.name} engine. Model capacity plugin.`,
       cancellationSource: "drain",
     });
    await ctx.activity.log({ companyId: run.companyId, message: `Model capacity: moved a run off draining ${engineName}`, entityType: "issue", entityId: run.issueId, metadata: { runId: run.runId, forced } });
  };

  // P2.6: a closed task's placement is undone (its original override put back), unless a person changed it since.
  const clearPlacements = async (snapshot: Snapshot) => {
    const records = await store.overrides.get();
    const open = new Set(snapshot.tasks.map((t) => t.issueId));
    let changed = false;
    for (const record of Object.values(records)) {
      if (record.fromPoolId !== record.toPoolId || open.has(record.issueId)) continue;
      const companyId = splitPoolKey(record.toPoolId)?.companyId;
      const issue = companyId ? await ctx.issues.get(record.issueId, companyId).catch(() => null) : null;
      if (issue && !["done", "cancelled"].includes(issue.status)) continue;
      if (issue && issue.assigneeAdapterOverrides?.adapterConfig?.model === record.model) {
        await ctx.issues.update(record.issueId, { assigneeAdapterOverrides: record.original } as unknown as Parameters<typeof ctx.issues.update>[1], issue.companyId);
      }
      delete records[record.issueId];
      changed = true;
    }
    if (changed) await store.overrides.set(records);
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
      const apply = pool?.mode === "enforce" && (action.kind === "hold" || action.kind === "release" || action.kind === "place" || action.kind === "switchAdapter");
      try {
        if (apply && action.kind === "hold") await hold(action, pool, snapshot);
        if (apply && action.kind === "place") await place(action);
        if (apply && action.kind === "switchAdapter") await switchAdapter(action);
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

  // A pool is gone only when the snapshot lacks it and the company's saved pools don't list it either, so a company left
  // out of one cycle's snapshot never loses its queue.
  const poolRemoved = async (poolId: string, companyId: string, snapshot: Snapshot) => {
    if (snapshot.pools.some((p) => p.id === poolId) || snapshot.diagnostics?.skippedCompanies.includes(companyId)) return false;
    const localId = splitPoolKey(poolId)?.poolId ?? poolId;
    return !(await store.companyPools(companyId).get()).some((p) => p.id === localId);
  };

  // C5/C7: a person removed our blocker, or the task closed: it leaves the queue and the plugin doesn't fight it. A task
  // whose pool was removed leaves too and is woken, so its new pool (if any) can count or hold it.
  const reconcileHolds = async (snapshot: Snapshot) => {
    const holds = await store.holds.get();
    const open = new Set(snapshot.tasks.map((t) => t.issueId));
    let changed = false;
    for (const held of Object.values(holds)) {
      let reason: string | undefined;
      if (!open.has(held.issueId)) reason = "task closed or no longer in the pool";
      else if (await poolRemoved(held.poolId, held.companyId, snapshot)) reason = "its pool was removed";
      else if (held.blockerId) {
        const relations = await ctx.issues.relations.get(held.issueId, held.companyId);
        if (!relations.blockedBy.some((b) => b.id === held.blockerId)) reason = "queue blocker removed by a person";
      }
      if (!reason) continue;
      // Our blocker comes off with the hold (unless a person already removed it), so the task isn't left blocked.
      if (held.blockerId && reason !== "queue blocker removed by a person") {
        await ctx.issues.relations.removeBlockers(held.issueId, [held.blockerId], held.companyId).catch((e) =>
          ctx.logger.warn("Couldn't remove a queue blocker", { issueId: held.issueId, error: errText(e) }));
      }
      if (reason === "its pool was removed") {
        await setLabel(held.issueId, held.companyId, false);
        await wake(held.issueId, held.companyId).catch((e) => ctx.logger.warn("Couldn't wake a task whose pool was removed", { issueId: held.issueId, error: errText(e) }));
      }
      delete holds[held.issueId];
      changed = true;
      await ctx.activity.log({ companyId: held.companyId, message: `Model capacity: left the ${held.poolId} queue (${reason})`, entityType: "issue", entityId: held.issueId, metadata: { poolId: held.poolId } });
    }
    if (changed) await store.holds.set(holds);
    await retireRemovedBlockers(snapshot, holds);
  };

  // A removed pool's queue task is cancelled once nothing waits on it, so it doesn't sit open forever.
  const retireRemovedBlockers = async (snapshot: Snapshot, holds: Record<string, HeldTask>) => {
    const waitingOn = new Set(Object.values(holds).map((h) => h.blockerId));
    const companyIds = new Set([...snapshot.pools.flatMap((p) => (p.companyId ? [p.companyId] : [])), ...Object.values(holds).map((h) => h.companyId)]);
    for (const companyId of companyIds) {
      const blockers = store.queueBlockers(companyId);
      const map = await blockers.get();
      let changed = false;
      for (const [poolId, blockerId] of Object.entries(map)) {
        if (waitingOn.has(blockerId) || !(await poolRemoved(poolId, companyId, snapshot))) continue;
        try {
          const issue = await ctx.issues.get(blockerId, companyId);
          if (issue && !CLOSED.has(issue.status)) {
            await ctx.issues.createComment(blockerId, "Model capacity: this pool was removed and nothing waits on it any more, so its queue is closed.", companyId);
            await ctx.issues.update(blockerId, { status: "cancelled" }, companyId);
          }
          delete map[poolId];
          changed = true;
        } catch (e) {
          ctx.logger.warn("Couldn't close a removed pool's queue task", { companyId, poolId, blockerId, error: errText(e) });
        }
      }
      if (changed) await blockers.set(map);
    }
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

  // A person moved a waiting task to another pool: its model becomes that pool's agent model (a person's pin, so the
  // plugin's own placement record is dropped) and it waits in that pool's queue, keeping its place in line by age.
  const moveToPool = async (issueId: string, companyId: string, target: PoolConfig) => {
    const holds = await store.holds.get();
    const held = holds[issueId];
    if (!held || held.companyId !== companyId) throw new Error("That task isn't waiting");
    if (held.poolId === target.id) return;
    const model = target.agentModel ?? target.patterns.find((p) => !p.includes("*"));
    if (!model) throw new Error(`${target.name} has no agent model to move tasks to`);
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) throw new Error("Task not found");
    const current = issue.assigneeAdapterOverrides ?? {};
    const next = { ...current, adapterConfig: { ...(current.adapterConfig ?? {}), model } };
    await ctx.issues.update(issueId, { assigneeAdapterOverrides: next } as unknown as Parameters<typeof ctx.issues.update>[1], companyId);
    const records = await store.overrides.get();
    if (records[issueId]) {
      delete records[issueId];
      await store.overrides.set(records);
    }
    const blockerId = await ensureBlocker(companyId, target);
    if (held.blockerId && held.blockerId !== blockerId) await ctx.issues.relations.removeBlockers(issueId, [held.blockerId], companyId);
    await ctx.issues.relations.addBlockers(issueId, [blockerId], companyId);
    await store.holds.set({ ...(await store.holds.get()), [issueId]: { ...held, poolId: target.id, blockerId } });
    await ctx.issues.createComment(issueId, `Moved to ${target.name} by a board user; waiting there. Model capacity plugin.`, companyId);
  };

  // Applies the moves board users asked for. Each failure is returned to be raised as an alert; the move is dropped.
  const applyPendingMoves = async (poolsOf: (companyId: string) => Promise<PoolConfig[]>) => {
    const moves = Object.values(await store.pendingMoves.get());
    const failed: { issueId: string; companyId: string; message: string }[] = [];
    for (const m of moves) {
      try {
        const target = (await poolsOf(m.companyId)).find((p) => p.id === m.poolId);
        if (!target) throw new Error("the pool no longer exists");
        await moveToPool(m.issueId, m.companyId, target);
        await ctx.activity.log({ companyId: m.companyId, message: `Model capacity: moved to the ${target.name} pool by a board user`, entityType: "issue", entityId: m.issueId, metadata: { userId: m.userId, poolId: target.id } });
      } catch (e) {
        failed.push({ issueId: m.issueId, companyId: m.companyId, message: errText(e) });
      }
      const left = await store.pendingMoves.get();
      delete left[m.issueId];
      await store.pendingMoves.set(left);
    }
    return failed;
  };

  // A routine fires again while its last copy is still waiting in a pool queue, so copies pile up; two open copies of
  // one routine both trying to start break Paperclip's one-open-run-per-routine rule and crash it on startup. Older
  // copies still held here (no run) are cancelled in favour of the newest.
  const retireStaleRoutineCopies = async (snapshot: Snapshot) => {
    const holds = await store.holds.get();
    const byRoutine = new Map<string, typeof snapshot.tasks>();
    for (const t of snapshot.tasks) if (t.routineKey) byRoutine.set(`${t.companyId}|${t.routineKey}`, [...(byRoutine.get(`${t.companyId}|${t.routineKey}`) ?? []), t]);
    let changed = false;
    for (const copies of byRoutine.values()) {
      if (copies.length < 2) continue;
      const newest = [...copies].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
      for (const t of copies) {
        if (t === newest || t.hasActiveRun || !holds[t.issueId]) continue;
        try {
          const newer = await ctx.issues.get(newest.issueId, newest.companyId);
          await ctx.issues.createComment(t.issueId, `Superseded by ${newer?.identifier ?? "a newer run of this routine"}: cancelled while it waited in the queue, so two copies of one routine never start together. Model capacity plugin.`, t.companyId);
          await ctx.issues.update(t.issueId, { status: "cancelled" }, t.companyId);
          const held = holds[t.issueId];
          if (held.blockerId) await ctx.issues.relations.removeBlockers(t.issueId, [held.blockerId], t.companyId).catch(() => undefined);
          delete holds[t.issueId];
          changed = true;
          await ctx.activity.log({ companyId: t.companyId, message: "Model capacity: cancelled a stale routine copy waiting in the queue", entityType: "issue", entityId: t.issueId, metadata: { newerIssueId: newest.issueId } });
        } catch (e) {
          ctx.logger.warn("Couldn't cancel a stale routine copy", { issueId: t.issueId, error: errText(e) });
        }
      }
    }
    if (changed) await store.holds.set(holds);
  };

  return { execute, drainRun, reconcileHolds, confirmWakes, clearPlacements, ensureBlocker, releaseNow, moveToPool, applyPendingMoves, retireStaleRoutineCopies };
};

export type Executor = ReturnType<typeof createExecutor>;
