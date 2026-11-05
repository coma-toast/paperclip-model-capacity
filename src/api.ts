import type { Agent, PluginContext } from "@paperclipai/plugin-sdk";

import { collectAgentModels } from "./agentModels.js";
import { alertKey } from "./alerts.js";
import { APIS, addPrefix, apiInfo, inferApi, stripPrefix, type ApiKind } from "./apis.js";
import { backendBaseUrl, backendForModel, backendPrefix, probeBaseUrl, readBackends, summarizeBackends, type Backend } from "./backends.js";
import { PRIORITY_RANK, virtualModel } from "./constants.js";
import { harnessConfig } from "./harness.js";
import { checkEngineReach } from "./reach.js";
import { fetchProxyRoutes } from "./routes.js";
import { listBackendModels } from "./models.js";
import { backendPrices } from "./prices.js";
import { drainingRuns, engineModels } from "./drain.js";
import { backendHostId, loadHeldPoolKeys, loadScopedPools, poolKey, splitPoolKey } from "./pools.js";
import { inspectHost, type InspectResult } from "./probes/inspect.js";
import type { Runtime } from "./runtime.js";
import { availableCapacity } from "./scheduler/decide.js";
import { validatePools, type FieldError } from "./settings.js";
import { providerQuotas } from "./upstream.js";
import { occupiesSlot, type Action, type AlertEvent, type EngineKind, type HeldTask, type PlacementTarget, type PoolConfig, type Snapshot } from "./types.js";
import type { BackendUsage, UsageMeter } from "./usage.js";

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
  disabled: boolean;
  openAlerts: number;
  // Quota pools: models paused because their quota, daily cap or rate limit is used up.
  pausedModels?: number;
  hosts: { id: string; name: string; engine: string; up: boolean; slotsTotal?: number; slotsBusy?: number; lastProbeAt?: string }[];
}

// A company's backend with its latest usage sample and the pools that use or watch it (widget and page).
export interface BackendUsageRow {
  id: string;
  name: string;
  type: ApiKind;
  pools: string[];
  usage?: BackendUsage;
  // Local engines: Paperclip runs on it now (what its pool's limit counts), including runs on a pool's agent model
  // the plugin hasn't placed yet, which the harness sends to the pool's first engine.
  runs?: number;
  // Local engines: the cap its engine pool sets on it, when lower than the server's own slots.
  cap?: number;
  // Local engines: the Paperclip runs on it now, for the engine's runs dialog.
  runList?: EngineRun[];
}

export interface EngineRun {
  runId: string;
  identifier?: string;
  title?: string;
  // The start of the task's first post, shown when its title is hovered.
  description?: string;
  agentName?: string;
  model?: string;
  status: string;
  startedAt?: string;
  queuedAt?: string;
  // Whether it takes one of the engine's slots (a run queued behind its own agent doesn't).
  occupiesSlot: boolean;
  // On an engine that takes no new work.
  draining?: boolean;
  // When the plugin moves it to another engine; absent on a draining engine when its task wasn't placed by the plugin.
  moveAt?: string;
}

// An open alert for the alerts dialog: its dedupe key and, for a waiting task, the task.
export interface AlertRow extends AlertEvent {
  key: string;
  identifier?: string;
  title?: string;
  waiting?: boolean;
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

type ActionResult = { ok: true } | { ok: false; error?: string; errors?: FieldError[]; needsConfirm?: boolean };

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

const ENGINES: readonly EngineKind[] = ["llamacpp", "ollama", "openai", "vllm", "lmstudio", "omlx"];

const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const queueOrder = (a: HeldTask, b: HeldTask) =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.heldAt.localeCompare(b.heldAt) || a.issueId.localeCompare(b.issueId);

export const summarize = (snapshot: Snapshot, openAlertPools: string[], now: Date): PoolSummary[] =>
  snapshot.pools.map((pool) => {
    const runs = snapshot.runs.filter((r) => r.poolId === pool.id && occupiesSlot(r)).length;
    const pending = snapshot.released.filter((r) => r.poolId === pool.id && !snapshot.runs.some((x) => x.issueId === r.issueId)).length;
    const holds = snapshot.holds.filter((h) => h.poolId === pool.id);
    const oldest = holds.reduce<string | undefined>((min, h) => (!min || h.heldAt < min ? h.heldAt : min), undefined);
    return {
      id: pool.id, companyId: pool.companyId, localId: pool.localId, name: pool.name, api: pool.api ?? inferApi(pool.patterns), mode: pool.mode, privacy: pool.privacy, limit: pool.limit,
      available: availableCapacity(pool, snapshot, runs), inUse: runs + pending, queued: holds.length,
      oldestWaitSeconds: oldest ? Math.max(0, Math.round((now.getTime() - Date.parse(oldest)) / 1000)) : null,
      onHold: snapshot.heldPools.includes(pool.id), disabled: pool.disabled === true, openAlerts: openAlertPools.filter((p) => p === pool.id).length,
      ...(pool.kind === "quota" ? { pausedModels: (pool.placement ?? []).filter((t) => snapshot.exhausted?.[`${pool.companyId}|${t.model}`]).length } : {}),
      hosts: pool.hosts.map((h) => {
        const s = snapshot.hosts[h.id];
        return { id: h.id, name: h.name, engine: h.engine, up: Boolean(s?.up), slotsTotal: s?.slotsTotal, slotsBusy: s?.slotsBusy, lastProbeAt: s?.lastProbeAt };
      }),
    };
  });

// Whether a pool uses a backend: its own backend, one it watches or places on, or (quota pools) one of its models' backends.
const usesBackend = (p: PoolConfig, backendId: string, backends: Backend[]) =>
  p.backend === backendId || Boolean(p.watch?.includes(backendId)) || Boolean(p.engines?.some((e) => e.engine === backendId))
  || (p.kind === "quota" && p.patterns.some((m) => backendForModel(m, backends)?.id === backendId));

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
      released: last?.released ?? Object.values(await store.released.get()), diagnostics: last?.diagnostics, exhausted: await store.exhausted.get(),
      pools: await loadScopedPools(store, ids, runtime.backendsFor), holds: Object.values(await store.holds.get()).filter((h) => !companyId || h.companyId === companyId),
      heldPools: await loadHeldPoolKeys(store, ids),
    };
  };

  const backendRows = async (companyId: string, snapshot?: Snapshot): Promise<BackendUsageRow[]> => {
    const [backends, pools, usage, since] = await Promise.all([runtime.backendsFor(companyId), store.companyPools(companyId).get(), store.companyUsage(companyId).get(), store.drainSince.get()]);
    // Paperclip's runs on an engine: those on its reach model or any alias that only reaches it, or on the virtual model
    // of an engine pool whose first engine it is (the harness sends unplaced runs there).
    const runListOn = (b: Backend) => {
      if (!snapshot) return undefined;
      const models = engineModels(snapshot, companyId, b);
      const unplaced = snapshot.pools.filter((p) => p.kind === "engine" && p.engines?.[0]?.engine === b.id).map((p) => virtualModel(p.localId ?? p.id));
      return snapshot.runs.filter((r) => r.companyId === companyId && r.model && (models.has(r.model) || unplaced.includes(r.model)));
    };
    const runsOn = (b: Backend) => runListOn(b)?.filter(occupiesSlot).length;
    // When each run on a draining engine moves to another engine.
    const moveAt = new Map((snapshot ? drainingRuns(snapshot, companyId, backends, pools, since) : []).map((d) => [d.run.runId, d]));
    // A server that doesn't report busy slots (or whose key it refuses) shows the runs Paperclip sent it instead.
    const withDerived = (sample: BackendUsage | undefined, busy: number | undefined): BackendUsage | undefined =>
      !sample || busy === undefined ? sample : {
        ...sample, meters: sample.meters.map((m) => (m.unit === "slots" && m.used === undefined
          ? { ...m, used: busy, derived: true, ...(m.limit !== undefined ? { remaining: Math.max(0, m.limit - busy) } : {}) } : m)),
      };
    // A proxy's upstream providers get one quota each (OpenRouter's free requests, Gemini's and Groq's requests today
    // against their daily limits, NVIDIA NIM's count), added to its own meters.
    const withUpstream = (sample: BackendUsage | undefined): BackendUsage | undefined =>
      !sample?.upstreams ? sample : { ...sample, meters: [...sample.meters, ...providerQuotas(sample.upstreams, backends, usage, sample.upstreamRequests, now(), sample.upstreamLimits)] };
    return backends.map((b) => ({
      id: b.id, name: b.name, type: b.type,
      usage: apiInfo(b.type).group === "local" ? withDerived(usage[b.id], runsOn(b)) : withUpstream(usage[b.id]),
      ...(apiInfo(b.type).group === "local" && snapshot ? {
        runs: runsOn(b),
        runList: (runListOn(b) ?? []).map((r) => ({
          runId: r.runId, identifier: r.issueIdentifier, title: r.issueTitle, description: r.issueDescription, agentName: r.agentName, model: r.model, status: r.status, startedAt: r.startedAt, queuedAt: r.queuedAt, occupiesSlot: occupiesSlot(r),
          ...(moveAt.has(r.runId) ? { draining: true, ...(moveAt.get(r.runId)!.moveAt ? { moveAt: moveAt.get(r.runId)!.moveAt } : {}) } : {}),
        })),
      } : {}),
      ...(() => {
        const cap = pools.flatMap((p) => p.engines ?? []).find((e) => e.engine === b.id)?.cap;
        return cap !== undefined ? { cap } : {};
      })(),
      pools: pools.filter((p) => usesBackend(p, b.id, backends)).map((p) => p.name),
    }));
  };

  ctx.data.register("capacity-summary", async (params) => {
    const companyId = companyOf(params);
    const snapshot = await currentSnapshot(companyId);
    const alerts = Object.values((await store.alerts.get()).active).filter((a) => !companyId || !a.companyId || a.companyId === companyId);
    return {
      pools: summarize(snapshot, alerts.flatMap((a) => (a.poolId ? [a.poolId] : [])), now()),
      backends: companyId ? await backendRows(companyId, snapshot) : [],
      // Models the scheduler has paused (quota used up, daily cap, rate limit), with when they come back.
      paused: Object.entries(snapshot.exhausted ?? {}).filter(([key]) => !companyId || key.startsWith(`${companyId}|`)).map(([key, e]) => {
        const model = key.slice(key.indexOf("|") + 1);
        const pool = snapshot.pools.find((p) => p.companyId === key.slice(0, key.indexOf("|")) && (p.placement ?? []).some((t) => t.model === model));
        return { model, poolId: pool?.id, poolName: pool?.name, until: e.until, since: e.since, reason: e.reason };
      }),
      lastCycleAt: runtime.health().lastCycleAt, lastError: runtime.health().lastError, diagnostics: snapshot.diagnostics,
    };
  });

  // One pool's usage and limits: its backend's meters and notes, and per model (quota) or engine (engine pool) the
  // price, limits, runs now and today, and whether it's paused and until when.
  ctx.data.register("pool-usage", async (params) => {
    const companyId = companyOf(params);
    if (!companyId) return { found: false };
    const snapshot = await currentSnapshot(companyId);
    const pool = snapshot.pools.find((p) => p.id === text(params.poolId));
    if (!pool) return { found: false };
    const alerts = Object.values((await store.alerts.get()).active).filter((a) => a.companyId === companyId);
    const summary = summarize({ ...snapshot, pools: [pool] }, alerts.flatMap((a) => (a.poolId ? [a.poolId] : [])), now())[0];
    const [rows, backends, tally] = await Promise.all([backendRows(companyId, snapshot), runtime.backendsFor(companyId), store.runCounts(companyId).get()]);
    const today = tally.day === now().toISOString().slice(0, 10) ? tally.counts : {};
    const running = (models: string[]) => snapshot.runs.filter((r) => r.poolId === pool.id && occupiesSlot(r) && r.model && models.includes(r.model)).length;
    const paused = (model: string) => snapshot.exhausted?.[`${companyId}|${model}`];
    // The pool's runs now, and whether each takes a slot (a queued run waiting for its agent doesn't).
    const runs = snapshot.runs.filter((r) => r.poolId === pool.id).map((r) => ({
      identifier: r.issueIdentifier, agentName: r.agentName, model: r.model, status: r.status, occupiesSlot: occupiesSlot(r), waitingOnAgent: r.waitingOnAgent, stalled: r.stalled,
    }));
    if (pool.kind === "engine") {
      const engines = (pool.engines ?? []).map((e) => {
        const b = backends.find((x) => x.id === e.engine);
        const target = (pool.placement ?? []).find((t) => t.hostId === poolKey(companyId, backendHostId(e.engine)));
        const models = target ? [target.model, ...(target.aliases ?? [])] : b?.reachModel ? [b.reachModel] : [];
        const host = snapshot.hosts[poolKey(companyId, backendHostId(e.engine))];
        return {
          id: e.engine, name: b?.name ?? e.engine, cap: e.cap, reachModel: b?.reachModel, up: host ? host.up : undefined,
          usage: rows.find((r) => r.id === e.engine)?.usage, runsNow: running(models), runsToday: models.reduce((n, m) => n + (today[m] ?? 0), 0),
        };
      });
      return { found: true, pool: summary, kind: "engine", engines, runs };
    }
    // Each model's price, limits and the meters shown come from its own backend.
    const targets: PlacementTarget[] = pool.placement ?? pool.patterns.map((model) => ({ model }));
    const models = targets.map((t) => {
      const backend = backends.find((b) => b.id === (t.backendId ?? pool.backend));
      const row = rows.find((r) => r.id === backend?.id);
      const id = stripPrefix(backend ? backendPrefix(backend) : "", t.model);
      return {
        model: t.model, backendName: backend?.name, price: backend?.type === "copilot" ? { included: true } : row?.usage?.prices?.[id], runsNow: running([t.model]), runsToday: today[t.model] ?? 0,
        limits: row?.usage?.modelLimits?.[id] ?? (id.endsWith(":free") ? row?.usage?.modelLimits?.["*:free"] : undefined), paused: paused(t.model),
      };
    });
    const ids = [...new Set(targets.map((t) => t.backendId ?? pool.backend).filter((x): x is string => Boolean(x)))];
    return { found: true, pool: summary, kind: pool.kind ?? "quota", dailyRunCap: pool.dailyRunCap, backends: rows.filter((r) => ids.includes(r.id)), models, runs };
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
    // Alerts about one task name it, so the alerts dialog can show and act on the task.
    const withTask = async (a: AlertEvent): Promise<AlertRow> => {
      const issue = a.kind === "waitedTooLong" && a.companyId ? await ctx.issues.get(a.subject, a.companyId).catch(() => null) : null;
      return { ...a, key: alertKey(a), ...(issue ? { identifier: issue.identifier ?? undefined, title: issue.title, waiting: Boolean(holds[a.subject]) } : {}) };
    };
    const holds = await store.holds.get();
    const open = await Promise.all(Object.values(active).filter(mine).sort((x, y) => y.at.localeCompare(x.at)).map(withTask));
    return { active: open, recent: recent.filter(mine).reverse() };
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

  // Agents with their models, for picking which agents use a pool.
  const listAgents = async (companyId: string) => {
    const agents: Agent[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await ctx.agents.list({ companyId, limit: 200, offset });
      agents.push(...page);
      if (page.length < 200) break;
    }
    return agents.filter((a) => a.status !== "terminated");
  };
  const agentModelOf = (a: Agent) => {
    const model = (a.adapterConfig as Record<string, unknown> | null)?.model;
    return typeof model === "string" && model ? model : undefined;
  };

  // The OpenCode provider that makes pinning pools' virtual models work even before a task is placed.
  ctx.data.register("harness-config", async (params) => {
    const companyId = companyOf(params);
    if (!companyId) return { provider: {}, warnings: [] };
    return harnessConfig(await store.companyPools(companyId).get(), await runtime.backendsFor(companyId));
  });

  ctx.data.register("agents", async (params) => {
    const companyId = companyOf(params);
    if (!companyId) return { agents: [] };
    return { agents: (await listAgents(companyId)).map((a) => ({ id: a.id, name: a.name, model: agentModelOf(a), adapterType: a.adapterType })).sort((a, b) => a.name.localeCompare(b.name)) };
  });

  // One agent's pool, for the agent page's Model capacity tab: its model and the pools it can be put on.
  ctx.data.register("agent-pool", async (params) => {
    const companyId = companyOf(params);
    const agentId = text(params.agentId);
    if (!companyId || !agentId) return { pools: [] };
    const agent = await ctx.agents.get(agentId, companyId);
    const model = agent ? agentModelOf(agent) : undefined;
    const pools = (await store.companyPools(companyId).get()).filter((p) => p.agentModel).map((p) => ({ id: p.id, name: p.name, agentModel: p.agentModel!, disabled: p.disabled === true }));
    return { name: agent?.name, model, pools, currentPoolId: pools.find((p) => p.agentModel === model)?.id };
  });

  // The settings page edits one company's pools, with their own ids (not the scheduler's keys).
  ctx.data.register("pools-config", async (params) => {
    const companyId = companyOf(params);
    if (!companyId) return { pools: [], heldPools: [], exemptions: await store.exemptions.get(), backends: [] };
    return {
      pools: await store.companyPools(companyId).get(), heldPools: await store.companyHeldPools(companyId).get(), exemptions: await store.exemptions.get(),
      convertedAt: await store.poolsConvertedAt(companyId).get(),
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
    // Direct to engines: the local engines' models, each with its engine's prefix.
    if (backend.type === "direct") {
      const engines = readBackends(await ctx.config.get(companyId)).filter((b) => apiInfo(b.type).group === "local");
      if (!engines.length) return { ok: false, error: "Add a local engine backend first" };
      const lists = await Promise.all(engines.map(async (e) => ({
        engine: e, list: await listBackendModels(ctx, e, await runtime.backendAuth.headersFor(companyId, e.id).catch(() => undefined)),
      })));
      const models = lists.flatMap(({ engine, list }) => (list.ok ? list.models.map((m) => addPrefix(backendPrefix(engine), m)) : []));
      const failed = lists.filter(({ list }) => !list.ok).map(({ engine }) => engine.name);
      if (!models.length) return { ok: false, error: `Couldn't list any engine's models${failed.length ? ` (${failed.join(", ")} didn't answer)` : ""}` };
      const unique = [...new Set(models)].sort();
      return { ok: true, source: "local engines", models: unique, prices: Object.fromEntries(unique.map((m) => [m, { free: true }])) };
    }
    try {
      const headers = await runtime.backendAuth.headersFor(companyId, backend.id);
      const list = await listBackendModels(ctx, backend, headers);
      if (!list.ok) return list;
      // Prices are best effort: a backend that doesn't say still lists its models.
      const prices = { ...(await backendPrices(backend, list.models, { fetch: (u, init) => ctx.http.fetch(u, init), headers })), ...list.prices };
      return { ...list, prices };
    } catch (e) {
      return { ok: false, error: `Couldn't read ${backend.name}'s key: ${errText(e)}` };
    }
  });

  // Samples the company's backends now instead of waiting for the next usage tick.
  ctx.actions.register("refresh-usage", async (params, context) => {
    if (!forUser(context)) return { ok: false, error: "Only board users can refresh usage" };
    const companyId = companyFor(params, context);
    if (!companyId) return { ok: false, error: "Open this from a company's dashboard" };
    await runtime.sampleCompany(companyId);
    return { ok: true };
  });

  // Where a proxy backend sends each of its models, matched to the company's local engines (for checking which
  // engines a pool should watch or pin tasks to).
  ctx.actions.register("proxy-routes", async (params, context) => {
    if (!forUser(context)) return { ok: false, error: "Only board users can read routing" };
    const companyId = companyFor(params, context);
    if (!companyId) return { ok: false, error: "Open this from a company's settings" };
    const backend = await savedBackend(companyId, params.backendId);
    if (!backend) return { ok: false, error: "No such backend" };
    const engines = readBackends(await ctx.config.get(companyId)).filter((b) => apiInfo(b.type).group === "local");
    try {
      return await fetchProxyRoutes(ctx, backend, engines, await runtime.backendAuth.headersFor(companyId, backend.id));
    } catch (e) {
      return { ok: false, error: `Couldn't read ${backend.name}'s key: ${errText(e)}` };
    }
  });

  // How agents reach each local engine, checked against the proxy's routing or the engine's own models.
  ctx.actions.register("engine-reach", async (params, context) => {
    if (!forUser(context)) return { ok: false, error: "Only board users can check engines" };
    const companyId = companyFor(params, context);
    if (!companyId) return { ok: false, error: "Open this from a company's settings" };
    const backends = readBackends(await ctx.config.get(companyId));
    return { ok: true, ...(await checkEngineReach(ctx, backends, (id) => runtime.backendAuth.headersFor(companyId, id))) };
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
    const companyBackends = await runtime.backendsFor(companyId);
    const pools = new Set((await store.companyPools(companyId).get()).filter((p) => usesBackend(p, backend.id, companyBackends)).map((p) => poolKey(companyId, p.id)));
    const poolRuns: PoolRunRow[] = (snapshot?.runs ?? []).filter((r) => r.poolId && pools.has(r.poolId))
      .map((r) => ({ runId: r.runId, status: r.status, agentName: r.agentName, issueIdentifier: r.issueIdentifier, model: r.model, startedAt: r.startedAt }));
    return { ok: true, server, usedAuth: Boolean(headers), poolRuns, countedAt: snapshot?.now } satisfies InspectHostResult;
  });

  boardAction("dismiss-conversion-note", async (_params, _userId, companyId) => {
    if (companyId) await store.poolsConvertedAt(companyId).set(null);
    return { ok: true };
  });

  boardAction("save-pools", async (params, _userId, companyId) => {
    if (!companyId) return { ok: false, error: "Open this from a company's settings" };
    const result = validatePools(params.pools);
    if (!result.ok) return { ok: false, errors: result.errors };
    const companyBackends = readBackends(await ctx.config.get(companyId));
    const backendIds = new Set(companyBackends.map((b) => b.id));
    const engineIds = new Set(companyBackends.filter((b) => apiInfo(b.type).group === "local").map((b) => b.id));
    const missing = result.pools.flatMap((p, i) => [
      ...(p.backend && !backendIds.has(p.backend) ? [{ field: `pools[${i}].backend`, message: "That backend no longer exists" }] : []),
      ...(p.watch ?? []).filter((id) => !backendIds.has(id)).map(() => ({ field: `pools[${i}].watch`, message: "A watched backend no longer exists" })),
      ...(p.sticky ?? []).filter((t) => !backendIds.has(t.engine)).map(() => ({ field: `pools[${i}].sticky`, message: "An engine this pool places tasks on no longer exists" })),
      ...(p.engines ?? []).filter((e) => !engineIds.has(e.engine)).map(() => ({ field: `pools[${i}].engines`, message: "An engine in this pool isn't a local engine backend (or no longer exists)" })),
    ]);
    if (missing.length) return { ok: false, errors: missing };
    await store.companyPools(companyId).set(result.pools);
    await runtime.companies.note(companyId);
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
  // A person moves waiting tasks (one or several) to another pool of the same company.
  // Moving takes several host calls per task, too slow for one request on a busy host, so the request is saved and the
  // next cycle (scheduled right away) applies it. Moving a task out of a private pool into a shared one sends its work
  // to that pool's cloud models, so it needs allowShared.
  boardAction("move-to-pool", async (params, userId, companyId) => {
    const ids = Array.isArray(params.issueIds) ? params.issueIds.map(String) : text(params.issueId) ? [String(params.issueId)] : [];
    if (!companyId || !ids.length) return { ok: false, error: "companyId and issueIds are required" };
    const pools = await loadScopedPools(store, [companyId], runtime.backendsFor);
    const target = pools.find((p) => p.id === text(params.poolId) || p.localId === text(params.poolId));
    if (!target) return { ok: false, error: "That pool doesn't exist" };
    if (target.disabled) return { ok: false, error: `${target.name} is disabled` };
    const holds = await store.holds.get();
    const waiting = ids.filter((id) => holds[id]?.companyId === companyId);
    const fromPrivate = waiting.filter((id) => pools.find((p) => p.id === holds[id].poolId)?.privacy === "private");
    if (fromPrivate.length && target.privacy === "shared" && params.allowShared !== true) {
      return { ok: false, needsConfirm: true, error: `${fromPrivate.length === 1 ? "That task is" : `${fromPrivate.length} tasks are`} in a private pool; confirm to run on ${target.name}'s shared models` };
    }
    const moves = await store.pendingMoves.get();
    for (const id of waiting) moves[id] = { issueId: id, companyId, poolId: target.id, userId, at: now().toISOString() };
    await store.pendingMoves.set(moves);
    const gone = ids.length - waiting.length;
    return gone ? { ok: false, error: `${gone} of ${ids.length} aren't waiting any more${waiting.length ? "; the rest move within a minute" : ""}` } : { ok: true };
  });

  // A person moves a run off a draining engine without waiting for its grace period; the next cycle (scheduled right
  // away) cancels it and queues its task for another engine.
  boardAction("drain-run", async (params, userId, companyId) => {
    const runId = text(params.runId);
    if (!companyId || !runId) return { ok: false, error: "companyId and runId are required" };
    const snapshot = await currentSnapshot(companyId);
    const [backends, pools, since] = await Promise.all([runtime.backendsFor(companyId), store.companyPools(companyId).get(), store.drainSince.get()]);
    const d = drainingRuns(snapshot, companyId, backends, pools, since).find((x) => x.run.runId === runId);
    if (!d) return { ok: false, error: "That run isn't on a draining engine any more" };
    if (!d.moveAt) return { ok: false, error: "The plugin didn't put this task on that engine (its agent or a person did), so it can't move it" };
    await store.forceDrain.set({ ...(await store.forceDrain.get()), [runId]: { userId, at: now().toISOString() } });
    return { ok: true };
  });

  // One-off alerts (a failed restore, a plugin error) can be dismissed; level alerts clear when their cause does.
  boardAction("dismiss-alert", async (params) => {
    const key = text(params.key);
    const state = await store.alerts.get();
    if (!key || !state.active[key]) return { ok: false, error: "That alert isn't open" };
    delete state.active[key];
    await store.alerts.set(state);
    return { ok: true };
  });

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
