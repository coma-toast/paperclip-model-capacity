import type { PluginContext } from "@paperclipai/plugin-sdk";

import { PRIORITY_RANK } from "./constants.js";
import type { Runtime } from "./runtime.js";
import { availableCapacity } from "./scheduler/decide.js";
import { validatePools, type FieldError } from "./settings.js";
import type { HeldTask, PoolConfig, Snapshot } from "./types.js";

export interface PoolSummary {
  id: string;
  name: string;
  mode: PoolConfig["mode"];
  privacy: PoolConfig["privacy"];
  limit: number;
  available: number;
  inUse: number;
  queued: number;
  oldestWaitSeconds: number | null;
  onHold: boolean;
  openAlerts: number;
  hosts: { id: string; name: string; engine: string; up: boolean; slotsTotal?: number; slotsBusy?: number; lastProbeAt?: string }[];
}

export interface QueueRow {
  position: number;
  issueId: string;
  companyId: string;
  poolId: string;
  priority: HeldTask["priority"];
  heldAt: string;
  identifier?: string;
  title?: string;
}

type ActionResult = { ok: true } | { ok: false; error?: string; errors?: FieldError[] };

const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const queueOrder = (a: HeldTask, b: HeldTask) =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.heldAt.localeCompare(b.heldAt) || a.issueId.localeCompare(b.issueId);

export const summarize = (snapshot: Snapshot, openAlertPools: string[], now: Date): PoolSummary[] =>
  snapshot.pools.map((pool) => {
    const runs = snapshot.runs.filter((r) => r.poolId === pool.id).length;
    const pending = snapshot.released.filter((r) => r.poolId === pool.id && !snapshot.runs.some((x) => x.issueId === r.issueId)).length;
    const holds = snapshot.holds.filter((h) => h.poolId === pool.id);
    const oldest = holds.reduce<string | undefined>((min, h) => (!min || h.heldAt < min ? h.heldAt : min), undefined);
    return {
      id: pool.id, name: pool.name, mode: pool.mode, privacy: pool.privacy, limit: pool.limit,
      available: availableCapacity(pool, snapshot, runs), inUse: runs + pending, queued: holds.length,
      oldestWaitSeconds: oldest ? Math.max(0, Math.round((now.getTime() - Date.parse(oldest)) / 1000)) : null,
      onHold: snapshot.heldPools.includes(pool.id), openAlerts: openAlertPools.filter((p) => p === pool.id).length,
      hosts: pool.hosts.map((h) => {
        const s = snapshot.hosts[h.id];
        return { id: h.id, name: h.name, engine: h.engine, up: Boolean(s?.up), slotsTotal: s?.slotsTotal, slotsBusy: s?.slotsBusy, lastProbeAt: s?.lastProbeAt };
      }),
    };
  });

export const registerApi = (ctx: PluginContext, runtime: Runtime, now: () => Date = () => new Date()) => {
  const { store } = runtime;

  // A snapshot from state alone, for before the first cycle has run.
  const currentSnapshot = async (): Promise<Snapshot> =>
    runtime.snapshot() ?? {
      now: now().toISOString(), pools: await store.pools.get(), hosts: await store.hosts.get(), runs: [], tasks: [],
      holds: Object.values(await store.holds.get()), released: Object.values(await store.released.get()), heldPools: await store.heldPools.get(),
    };

  ctx.data.register("capacity-summary", async () => {
    const snapshot = { ...(await currentSnapshot()), pools: await store.pools.get(), holds: Object.values(await store.holds.get()), heldPools: await store.heldPools.get() };
    const alerts = await store.alerts.get();
    return {
      pools: summarize(snapshot, Object.values(alerts.active).flatMap((a) => (a.poolId ? [a.poolId] : [])), now()),
      lastCycleAt: runtime.health().lastCycleAt, lastError: runtime.health().lastError, diagnostics: runtime.snapshot()?.diagnostics,
    };
  });

  ctx.data.register("queue", async (params) => {
    const poolId = text(params.poolId);
    const holds = Object.values(await store.holds.get()).filter((h) => !poolId || h.poolId === poolId);
    const positions = new Map<string, number>();
    const rows: QueueRow[] = [];
    for (const h of holds.sort(queueOrder)) {
      const position = (positions.get(h.poolId) ?? 0) + 1;
      positions.set(h.poolId, position);
      const issue = await ctx.issues.get(h.issueId, h.companyId).catch(() => null);
      rows.push({ position, issueId: h.issueId, companyId: h.companyId, poolId: h.poolId, priority: h.priority, heldAt: h.heldAt, identifier: issue?.identifier ?? undefined, title: issue?.title });
    }
    return { rows };
  });

  ctx.data.register("history", async (params) => {
    const day = text(params.day) ?? now().toISOString().slice(0, 10);
    return { day, days: await store.historyDays(), entries: (await store.history(day)).slice().reverse() };
  });

  ctx.data.register("alerts", async () => {
    const { active, recent } = await store.alerts.get();
    return { active: Object.values(active), recent: recent.slice().reverse() };
  });

  ctx.data.register("pools-config", async () => ({
    pools: await store.pools.get(), heldPools: await store.heldPools.get(), exemptions: await store.exemptions.get(),
  }));

  // A6: only people change settings or use the controls; agents and system calls are refused.
  const boardAction = (key: string, fn: (params: Record<string, unknown>, userId: string) => Promise<ActionResult>) =>
    ctx.actions.register(key, async (params, context) => {
      if (context.actor.type !== "user" || !context.actor.userId) return { ok: false, error: "Only board users can change model capacity settings" };
      const result = await fn(params, context.actor.userId);
      if (result.ok) {
        runtime.schedule(key);
        ctx.logger.info("Model capacity setting changed", { action: key, userId: context.actor.userId });
      }
      return result;
    });

  boardAction("save-pools", async (params) => {
    const result = validatePools(params.pools);
    if (!result.ok) return { ok: false, errors: result.errors };
    await store.pools.set(result.pools);
    return { ok: true };
  });

  boardAction("set-limit", async (params) => {
    const pools = await store.pools.get();
    const pool = pools.find((p) => p.id === params.poolId);
    if (!pool) return { ok: false, error: "No such pool" };
    if (typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit < 0) return { ok: false, errors: [{ field: "limit", message: "Must be a whole number, 0 or more" }] };
    await store.pools.set(pools.map((p) => (p.id === pool.id ? { ...p, limit: params.limit as number } : p)));
    return { ok: true };
  });

  boardAction("hold-pool", async (params) => {
    const poolId = text(params.poolId);
    if (!poolId) return { ok: false, error: "poolId is required" };
    await store.heldPools.set([...new Set([...(await store.heldPools.get()), poolId])]);
    return { ok: true };
  });

  boardAction("resume-pool", async (params) => {
    await store.heldPools.set((await store.heldPools.get()).filter((p) => p !== params.poolId));
    return { ok: true };
  });

  boardAction("release-now", async (params, userId) => {
    const held = (await store.holds.get())[String(params.issueId)];
    if (!held) return { ok: false, error: "That task isn't waiting" };
    await runtime.executor.releaseNow(held.issueId, held.companyId, held.poolId);
    await ctx.activity.log({ companyId: held.companyId, message: `Model capacity: released now by a board user, bypassing the ${held.poolId} limit`, entityType: "issue", entityId: held.issueId, metadata: { userId } });
    return { ok: true };
  });

  boardAction("exempt", async (params) => {
    const ex = await store.exemptions.get();
    const on = params.exempt !== false;
    const toggle = (list: string[], id: string | undefined) => (!id ? list : on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
    const next = { agentIds: toggle(ex.agentIds, text(params.agentId)), issueIds: toggle(ex.issueIds, text(params.issueId)) };
    if (!text(params.agentId) && !text(params.issueId)) return { ok: false, error: "agentId or issueId is required" };
    await store.exemptions.set(next);
    return { ok: true };
  });

  // F5: the task jumps to position 1 of its pool by taking the top priority and the oldest hold time.
  boardAction("move-to-front", async (params) => {
    const holds = await store.holds.get();
    const held = holds[String(params.issueId)];
    if (!held) return { ok: false, error: "That task isn't waiting" };
    const oldest = Object.values(holds).filter((h) => h.poolId === held.poolId).reduce((min, h) => (h.heldAt < min ? h.heldAt : min), held.heldAt);
    holds[held.issueId] = { ...held, priority: "critical", heldAt: new Date(Date.parse(oldest) - 1).toISOString() };
    await store.holds.set(holds);
    return { ok: true };
  });
};
