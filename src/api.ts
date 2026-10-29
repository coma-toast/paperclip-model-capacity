import type { PluginContext } from "@paperclipai/plugin-sdk";

import { PRIORITY_RANK } from "./constants.js";
import type { Runtime } from "./runtime.js";
import { availableCapacity } from "./scheduler/decide.js";
import { summarizeAuth } from "./auth.js";
import { loadHeldPoolKeys, loadScopedPools, poolKey, splitPoolKey } from "./pools.js";
import { inspectHost, type InspectResult } from "./probes/inspect.js";
import { validatePools, type FieldError } from "./settings.js";
import type { Action, AlertEvent, EngineKind, HeldTask, PoolConfig, Snapshot } from "./types.js";

export interface PoolSummary {
  // The scheduler's key, "<companyId>:<poolId>"; pass it back to set-limit, hold-pool and resume-pool.
  id: string;
  companyId?: string;
  localId?: string;
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

export interface PoolRunRow {
  runId: string;
  status: string;
  agentName?: string;
  issueIdentifier?: string;
  model?: string;
  startedAt?: string;
}

export interface InspectHostResult {
  ok: true;
  server: InspectResult;
  // Whether a server auth slot supplied credentials for this check.
  usedAuth: boolean;
  // Paperclip runs the plugin counts on this pool at its last cycle.
  poolRuns: PoolRunRow[];
  countedAt?: string;
}

const ENGINES: readonly EngineKind[] = ["llamacpp", "ollama", "openai", "vllm", "lmstudio"];

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
      id: pool.id, companyId: pool.companyId, localId: pool.localId, name: pool.name, mode: pool.mode, privacy: pool.privacy, limit: pool.limit,
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
  const companyOf = (params: Record<string, unknown>) => text(params.companyId);
  const knownCompanyIds = async (only?: string) => (only ? [only] : (await store.companies.get()).map((c) => c.id));

  // The latest cycle's snapshot, with pools, holds and pool holds re-read so a just-saved change shows at once.
  const currentSnapshot = async (companyId?: string): Promise<Snapshot> => {
    const ids = await knownCompanyIds(companyId);
    const last = runtime.snapshot();
    return {
      now: last?.now ?? now().toISOString(), hosts: await store.hosts.get(), runs: last?.runs ?? [], tasks: last?.tasks ?? [],
      released: last?.released ?? Object.values(await store.released.get()), diagnostics: last?.diagnostics,
      pools: await loadScopedPools(store, ids), holds: Object.values(await store.holds.get()).filter((h) => !companyId || h.companyId === companyId),
      heldPools: await loadHeldPoolKeys(store, ids),
    };
  };

  ctx.data.register("capacity-summary", async (params) => {
    const companyId = companyOf(params);
    const snapshot = await currentSnapshot(companyId);
    const alerts = Object.values((await store.alerts.get()).active).filter((a) => !companyId || !a.companyId || a.companyId === companyId);
    return {
      pools: summarize(snapshot, alerts.flatMap((a) => (a.poolId ? [a.poolId] : [])), now()),
      lastCycleAt: runtime.health().lastCycleAt, lastError: runtime.health().lastError, diagnostics: snapshot.diagnostics,
    };
  });

  ctx.data.register("queue", async (params) => {
    const companyId = companyOf(params);
    const poolId = text(params.poolId);
    const holds = Object.values(await store.holds.get()).filter((h) => (!poolId || h.poolId === poolId) && (!companyId || h.companyId === companyId));
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

  const actionCompany = (a: Action) => (a.kind === "alert" ? a.alert.companyId : a.companyId);
  ctx.data.register("history", async (params) => {
    const companyId = companyOf(params);
    const day = text(params.day) ?? now().toISOString().slice(0, 10);
    const entries = (await store.history(day)).filter((e) => !companyId || !actionCompany(e.action) || actionCompany(e.action) === companyId);
    return { day, days: await store.historyDays(), entries: entries.reverse() };
  });

  ctx.data.register("alerts", async (params) => {
    const companyId = companyOf(params);
    const mine = (a: AlertEvent) => !companyId || !a.companyId || a.companyId === companyId;
    const { active, recent } = await store.alerts.get();
    return { active: Object.values(active).filter(mine), recent: recent.filter(mine).reverse() };
  });

  // The settings page edits one company's pools, with their own ids (not the scheduler's keys).
  ctx.data.register("pools-config", async (params) => {
    const companyId = companyOf(params);
    if (!companyId) return { pools: [], heldPools: [], exemptions: await store.exemptions.get(), auth: [] };
    return {
      pools: await store.companyPools(companyId).get(), heldPools: await store.companyHeldPools(companyId).get(), exemptions: await store.exemptions.get(),
      auth: summarizeAuth(await ctx.config.get(companyId)),
    };
  });

  // A6: only people change settings or use the controls; agents and system calls are refused.
  const boardAction = (key: string, fn: (params: Record<string, unknown>, userId: string, companyId?: string) => Promise<ActionResult>) =>
    ctx.actions.register(key, async (params, context) => {
      if (context.actor.type !== "user" || !context.actor.userId) return { ok: false, error: "Only board users can change model capacity settings" };
      const result = await fn(params, context.actor.userId, text(params.companyId) ?? context.companyId ?? undefined);
      if (result.ok) {
        runtime.schedule(key);
        ctx.logger.info("Model capacity setting changed", { action: key, userId: context.actor.userId });
      }
      return result;
    });

  // "Check server": asks the server what it is running now. Takes the host as edited on the settings page, so it works
  // before saving; only http(s) addresses, GET-only, and only for board users since it reaches out to the network.
  ctx.actions.register("inspect-host", async (params, context) => {
    if (context.actor.type !== "user" || !context.actor.userId) return { ok: false, error: "Only board users can check servers" };
    const host = (params.host ?? {}) as { engine?: unknown; baseUrl?: unknown };
    const engine = host.engine as EngineKind;
    if (!ENGINES.includes(engine)) return { ok: false, error: "Pick a server type first" };
    let url: URL;
    try {
      url = new URL(String(host.baseUrl));
    } catch {
      return { ok: false, error: "Enter the server's address, like http://host:8080" };
    }
    if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: "The address must start with http:// or https://" };
    const companyId = text(params.companyId) ?? context.companyId ?? undefined;
    const serverId = text((params.host as { id?: unknown } | undefined)?.id);
    let headers: Record<string, string> | undefined;
    try {
      headers = companyId && serverId ? await runtime.serverAuth.headersFor(companyId, serverId) : undefined;
    } catch (e) {
      return { ok: false, error: `Couldn't read this server's auth secret: ${e instanceof Error ? e.message : String(e)}` };
    }
    const server = await inspectHost(engine, { baseUrl: url.toString().replace(/\/+$/, ""), fetch: (u, init) => ctx.http.fetch(u, init), headers });
    const snapshot = runtime.snapshot();
    const poolId = text(params.poolId) && companyId ? poolKey(companyId, String(params.poolId)) : undefined;
    const poolRuns: PoolRunRow[] = (snapshot?.runs ?? [])
      .filter((r) => poolId && r.poolId === poolId)
      .map((r) => ({ runId: r.runId, status: r.status, agentName: r.agentName, issueIdentifier: r.issueIdentifier, model: r.model, startedAt: r.startedAt }));
    return { ok: true, server, usedAuth: Boolean(headers), poolRuns, countedAt: snapshot?.now } satisfies InspectHostResult;
  });

  boardAction("save-pools", async (params, _userId, companyId) => {
    if (!companyId) return { ok: false, error: "Open this from a company's settings" };
    const result = validatePools(params.pools);
    if (!result.ok) return { ok: false, errors: result.errors };
    await store.companyPools(companyId).set(result.pools);
    return { ok: true };
  });

  // The capacity page sends the scheduler's pool key, which names the company.
  const poolFromKey = async (key: unknown) => {
    const parts = typeof key === "string" ? splitPoolKey(key) : undefined;
    if (!parts) return undefined;
    const pools = await store.companyPools(parts.companyId).get();
    return pools.some((p) => p.id === parts.poolId) ? { ...parts, pools } : undefined;
  };

  boardAction("set-limit", async (params) => {
    const found = await poolFromKey(params.poolId);
    if (!found) return { ok: false, error: "No such pool" };
    if (typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit < 0) return { ok: false, errors: [{ field: "limit", message: "Must be a whole number, 0 or more" }] };
    await store.companyPools(found.companyId).set(found.pools.map((p) => (p.id === found.poolId ? { ...p, limit: params.limit as number } : p)));
    return { ok: true };
  });

  boardAction("hold-pool", async (params) => {
    const found = await poolFromKey(params.poolId);
    if (!found) return { ok: false, error: "No such pool" };
    const held = store.companyHeldPools(found.companyId);
    await held.set([...new Set([...(await held.get()), found.poolId])]);
    return { ok: true };
  });

  boardAction("resume-pool", async (params) => {
    const found = await poolFromKey(params.poolId);
    if (!found) return { ok: false, error: "No such pool" };
    const held = store.companyHeldPools(found.companyId);
    await held.set((await held.get()).filter((p) => p !== found.poolId));
    return { ok: true };
  });

  boardAction("release-now", async (params, userId) => {
    const held = (await store.holds.get())[String(params.issueId)];
    if (!held) return { ok: false, error: "That task isn't waiting" };
    await runtime.executor.releaseNow(held.issueId, held.companyId, held.poolId);
    await ctx.activity.log({ companyId: held.companyId, message: `Model capacity: released now by a board user, bypassing the ${splitPoolKey(held.poolId)?.poolId ?? held.poolId} pool limit`, entityType: "issue", entityId: held.issueId, metadata: { userId } });
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
