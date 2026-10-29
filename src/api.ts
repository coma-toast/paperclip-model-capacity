import type { Agent, PluginContext } from "@paperclipai/plugin-sdk";

import { collectAgentModels } from "./agentModels.js";
import { APIS, apiInfo, inferApi, type ApiKind } from "./apis.js";
import { backendBaseUrl, probeBaseUrl, readBackends, summarizeBackends, type Backend } from "./backends.js";
import { PRIORITY_RANK } from "./constants.js";
import { listBackendModels } from "./models.js";
import { loadHeldPoolKeys, loadScopedPools, poolKey, splitPoolKey } from "./pools.js";
import { inspectHost, type InspectResult } from "./probes/inspect.js";
import type { Runtime } from "./runtime.js";
import { availableCapacity } from "./scheduler/decide.js";
import { validatePools, type FieldError } from "./settings.js";
import type { Action, AlertEvent, EngineKind, HeldTask, PoolConfig, Snapshot } from "./types.js";

export interface PoolSummary {
  // The scheduler's key, "<companyId>:<poolId>"; pass it back to set-limit, hold-pool and resume-pool.
  id: string;
  companyId?: string;
  localId?: string;
  name: string;
  api: ApiKind;
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
      id: pool.id, companyId: pool.companyId, localId: pool.localId, name: pool.name, api: pool.api ?? inferApi(pool.patterns), mode: pool.mode, privacy: pool.privacy, limit: pool.limit,
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
      pools: await loadScopedPools(store, ids, runtime.backendsFor), holds: Object.values(await store.holds.get()).filter((h) => !companyId || h.companyId === companyId),
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

  // Models this company's agents run (their default model), to set pools up from.
  ctx.data.register("agent-models", async (params) => {
    const companyId = companyOf(params);
    if (!companyId) return { uses: [] };
    const agents: Agent[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await ctx.agents.list({ companyId, limit: 200, offset });
      agents.push(...page);
      if (page.length < 200) break;
    }
    return { uses: collectAgentModels(agents) };
  });

  // The settings page edits one company's pools, with their own ids (not the scheduler's keys).
  ctx.data.register("pools-config", async (params) => {
    const companyId = companyOf(params);
    if (!companyId) return { pools: [], heldPools: [], exemptions: await store.exemptions.get(), backends: [] };
    return {
      pools: await store.companyPools(companyId).get(), heldPools: await store.companyHeldPools(companyId).get(), exemptions: await store.exemptions.get(),
      backends: summarizeBackends(await ctx.config.get(companyId)),
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

  const forUser = (context: { actor: { type: string; userId: string | null } }) => context.actor.type === "user" && Boolean(context.actor.userId);
  const companyFor = (params: Record<string, unknown>, context: { companyId: string | null }) => text(params.companyId) ?? context.companyId ?? undefined;
  const savedBackend = async (companyId: string, id: unknown) => readBackends(await ctx.config.get(companyId)).find((b) => b.id === id);
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // What a backend is running now (health, loaded models, slots) plus the Paperclip runs counted on a pool using it.
  const inspect = async (backend: Pick<Backend, "type" | "baseUrl">, headers: Record<string, string> | undefined) => {
    const info = apiInfo(backend.type);
    const baseUrl = probeBaseUrl(backend);
    if (!baseUrl) return undefined;
    return inspectHost(info.engine ?? "openai", { baseUrl, fetch: (u, init) => ctx.http.fetch(u, init), headers });
  };

  // The Add/Edit backend form: checks a draft backend before it's saved. The key typed in the form is used for this
  // one check only; it's stored (as a company secret) by the form's save, not here.
  ctx.actions.register("test-backend", async (params, context) => {
    if (!forUser(context)) return { ok: false, error: "Only board users can check backends" };
    const companyId = companyFor(params, context);
    const draft = (params.backend ?? {}) as Backend;
    if (!APIS.some((a) => a.kind === draft.type)) return { ok: false, error: "Pick the backend's type" };
    const address = backendBaseUrl(draft);
    if (address && !/^https?:\/\//i.test(address)) return { ok: false, error: "The address must start with http:// or https://" };
    let headers: Record<string, string> | undefined;
    const key = text(params.key);
    const saved = companyId && draft.id ? await savedBackend(companyId, draft.id) : undefined;
    if (key) {
      const scheme = draft.scheme === undefined ? "Bearer" : draft.scheme.trim();
      headers = { [draft.header?.trim() || "Authorization"]: scheme ? `${scheme} ${key}` : key };
    } else if (companyId && saved && backendBaseUrl(saved) === address) {
      // The saved key only goes to the address it was saved for, never to a new one typed in the form.
      try {
        headers = await runtime.backendAuth.headersFor(companyId, saved.id);
      } catch (e) {
        return { ok: false, error: `Couldn't read the saved key: ${errText(e)}` };
      }
    }
    const models = await listBackendModels(ctx, draft, headers);
    const server = apiInfo(draft.type).group === "local" ? await inspect(draft, headers) : undefined;
    return { ok: true, models, server };
  });

  ctx.actions.register("list-backend-models", async (params, context) => {
    if (!forUser(context)) return { ok: false, error: "Only board users can load models" };
    const companyId = companyFor(params, context);
    if (!companyId) return { ok: false, error: "Open this from a company's settings" };
    const backend = await savedBackend(companyId, params.backendId);
    if (!backend) return { ok: false, error: "Pick a backend for this pool first" };
    try {
      return await listBackendModels(ctx, backend, await runtime.backendAuth.headersFor(companyId, backend.id));
    } catch (e) {
      return { ok: false, error: `Couldn't read ${backend.name}'s key: ${errText(e)}` };
    }
  });

  ctx.actions.register("inspect-backend", async (params, context) => {
    if (!forUser(context)) return { ok: false, error: "Only board users can check backends" };
    const companyId = companyFor(params, context);
    if (!companyId) return { ok: false, error: "Open this from a company's settings" };
    const backend = await savedBackend(companyId, params.backendId);
    if (!backend) return { ok: false, error: "No such backend" };
    let headers: Record<string, string> | undefined;
    try {
      headers = await runtime.backendAuth.headersFor(companyId, backend.id);
    } catch (e) {
      return { ok: false, error: `Couldn't read ${backend.name}'s key: ${errText(e)}` };
    }
    const server = await inspect(backend, headers);
    if (!server) return { ok: false, error: `${backend.name} has no address` };
    const snapshot = runtime.snapshot();
    const pools = new Set((await store.companyPools(companyId).get()).filter((p) => p.backend === backend.id || p.watch?.includes(backend.id)).map((p) => poolKey(companyId, p.id)));
    const poolRuns: PoolRunRow[] = (snapshot?.runs ?? []).filter((r) => r.poolId && pools.has(r.poolId))
      .map((r) => ({ runId: r.runId, status: r.status, agentName: r.agentName, issueIdentifier: r.issueIdentifier, model: r.model, startedAt: r.startedAt }));
    return { ok: true, server, usedAuth: Boolean(headers), poolRuns, countedAt: snapshot?.now } satisfies InspectHostResult;
  });

  boardAction("save-pools", async (params, _userId, companyId) => {
    if (!companyId) return { ok: false, error: "Open this from a company's settings" };
    const result = validatePools(params.pools);
    if (!result.ok) return { ok: false, errors: result.errors };
    const backendIds = new Set(readBackends(await ctx.config.get(companyId)).map((b) => b.id));
    const missing = result.pools.flatMap((p, i) => [
      ...(p.backend && !backendIds.has(p.backend) ? [{ field: `pools[${i}].backend`, message: "That backend no longer exists" }] : []),
      ...(p.watch ?? []).filter((id) => !backendIds.has(id)).map(() => ({ field: `pools[${i}].watch`, message: "A watched backend no longer exists" })),
    ]);
    if (missing.length) return { ok: false, errors: missing };
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
