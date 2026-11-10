import { AsyncLocalStorage } from "node:async_hooks";

import type { PluginContext } from "@paperclipai/plugin-sdk";

import { DEFAULT_PROBE_INTERVAL_MS, DEFAULT_USAGE_INTERVAL_MS, HISTORY_RETENTION_DAYS, RUN_EVENT_DEBOUNCE_MS } from "./constants.js";
import { LEVEL_KINDS, createAlerter } from "./alerts.js";
import { apiInfo } from "./apis.js";
import { backendPrefix, createBackendAuth, readBackends, type Backend } from "./backends.js";
import { convertPools } from "./convert.js";
import { drainingRuns, drainStep, type DrainingRun } from "./drain.js";
import { createExecutor } from "./executor.js";
import { loadScopedPools, splitPoolKey } from "./pools.js";
import { probeAll } from "./probes/index.js";
import { reachCandidates } from "./reach.js";
import { fetchProxyRoutes } from "./routes.js";
import { decide } from "./scheduler/decide.js";
import { buildSnapshot, countRuns, createAgentCache, createBlockerCache, createCompanyDirectory, dbRunReader, type FailureReader, type RunReader } from "./snapshot.js";
import { createStore } from "./state/store.js";
import type { AlertEvent, HostConfig, Snapshot } from "./types.js";
import { opencodeCopilotToken } from "./opencodeAuth.js";
import { quotaTokenFor, readSubscriptionWindows } from "./subscriptions.js";
import { PAPERCLIP_SPEND_SQL, sampleUsage, type BackendUsage, type PaperclipSpend } from "./usage.js";

export interface RuntimeOptions {
  debounceMs?: number;
  // 0 turns the probe loop off (tests).
  probeIntervalMs?: number;
  // 0 turns usage sampling off; defaults to off when probing is off.
  usageIntervalMs?: number;
  readRuns?: RunReader;
  readFailures?: FailureReader;
  // A cycle running longer than this is abandoned so later ones aren't held up (tests shorten it).
  cycleTimeoutMs?: number;
  // How often the plugin's own timer starts a sweep cycle; 0 turns it off (defaults to off when probing is off).
  sweepIntervalMs?: number;
  now?: () => Date;
}

// Captured at module load, before any host invocation. The SDK tags each host call with the current invocation id
// from AsyncLocalStorage, and a timer set inside an event handler would carry that id after the invocation ended,
// so the host rejects it as expired. Timer work runs in this clean context instead, as proactive work that the host
// allows for the plugin's configured companies.
const outsideInvocation = AsyncLocalStorage.snapshot();

const CYCLE_TIMEOUT_MS = 3 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const createRuntime = (ctx: PluginContext, opts: RuntimeOptions = {}) => {
  const now = opts.now ?? (() => new Date());
  const store = createStore(ctx.state);
  const companies = createCompanyDirectory(ctx, store);
  const agents = createAgentCache(ctx);
  const blockers = createBlockerCache(ctx);
  const readRuns = opts.readRuns ?? dbRunReader(ctx);
  const configId = async (companyId: string, key: string) => {
    const value = (await ctx.config.get(companyId))[key];
    return typeof value === "string" && value ? value : undefined;
  };
  const backendAuth = createBackendAuth(ctx, Date.now, opencodeCopilotToken);
  const backendsFor = async (companyId: string) => readBackends(await ctx.config.get(companyId));
  // Hosts in the scheduler's list carry "<companyId>:<id>" ids; their key belongs to their backend in that company.
  const hostHeaders = async (host: HostConfig) => {
    const parts = splitPoolKey(host.id);
    return parts ? backendAuth.headersFor(parts.companyId, host.backendId) : undefined;
  };
  const executor = createExecutor({ ctx, store, queueLabelId: (companyId) => configId(companyId, "queueLabelId") });
  // Alerts without a company (plugin errors) go only to companies that use the plugin.
  const companiesWithPools = async () => {
    const all = await companies.list();
    const used = await Promise.all(all.map(async (c) => (await store.companyPools(c.id).get()).length > 0));
    return all.filter((_, i) => used[i]);
  };
  const alerter = createAlerter({ ctx, store, alertIssueId: (companyId) => configId(companyId, "alertIssueId"), listCompanies: companiesWithPools });
  const pluginError = (state: "start" | "clear", message: string): AlertEvent =>
    ({ kind: "pluginError", subject: "cycle", state, message, at: now().toISOString() });
  let chain: Promise<void> = Promise.resolve();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let lastCycleAt: string | undefined;
  let lastError: string | undefined;
  // A failure alert can outlive a restart (lastError resets), so the first good cycle after start clears it too.
  let clearAfterStart = true;
  let lastSnapshot: Snapshot | undefined;

  // P2.7.4: the earlier pool settings are converted to engine and quota pools once, with a note for the settings page.
  const convertSavedPools = async () => {
    for (const c of await companies.list()) {
      const saved = await store.companyPools(c.id).get();
      if (!saved.length || saved.every((p) => p.kind)) continue;
      const { pools, converted } = convertPools(saved);
      if (!converted) continue;
      await store.companyPools(c.id).set(pools);
      await store.poolsConvertedAt(c.id).set(now().toISOString());
      ctx.logger.info("Model capacity converted pools to engine and quota pools", { companyId: c.id, pools: pools.map((p) => `${p.id}:${p.kind}`) });
    }
  };

  // Runs started today per model, per company, for daily caps and the pool usage view.
  const countTodayRuns = async (snapshot: Snapshot) => {
    for (const companyId of new Set(snapshot.runs.map((r) => r.companyId))) {
      const tally = store.runCounts(companyId);
      await tally.set(countRuns(await tally.get(), snapshot.runs.filter((r) => r.companyId === companyId && r.status === "running"), now()));
    }
  };

  // Runs on draining engines: each gets DRAIN_GRACE_MS from when it was first seen there, then its task moves to
  // another engine of the pool that placed it; a board user can move one sooner.
  const drainEngines = async (snapshot: Snapshot) => {
    const [since, force, records] = await Promise.all([store.drainSince.get(), store.forceDrain.get(), store.overrides.get()]);
    const draining: DrainingRun[] = [];
    for (const companyId of new Set(snapshot.runs.map((r) => r.companyId))) {
      const [backends, pools] = await Promise.all([backendsFor(companyId), store.companyPools(companyId).get()]);
      draining.push(...drainingRuns(snapshot, companyId, backends, pools, since));
    }
    const next = drainStep(draining, since, force, now());
    await store.drainSince.set(next.since);
    if (Object.keys(force).length) await store.forceDrain.set({});
    for (const d of next.move) {
      try {
        const pool = snapshot.pools.find((p) => p.id === records[d.run.issueId]?.toPoolId);
        if (!pool) throw new Error("the pool that placed it no longer exists");
        await executor.drainRun(d.run, d.engine.name, pool, snapshot, Boolean(force[d.run.runId]));
      } catch (e) {
        await alerter.apply([{ kind: "pluginError", subject: `drain:${d.run.issueId}`, companyId: d.run.companyId, state: "start", message: `Couldn't move a run off ${d.engine.name}: ${errText(e)}`, at: now().toISOString() }]);
      }
    }
  };

  // One cycle at a time, so two triggers never read the same state and both act on it. A cycle stuck on a call that
  // never returns would hold up every later one, so after CYCLE_TIMEOUT_MS it's abandoned (it stops at its next step)
  // with an alert naming the step it hung on, and the next cycle runs.
  let cycleGeneration = 0;
  const runCycle = async (reason: string, generation: number, at: { step: string }) => {
    const step = (name: string) => {
      if (generation !== cycleGeneration) throw new Error(`abandoned at ${at.step}`);
      at.step = name;
    };
    step("converting saved pools");
    await convertSavedPools();
    // Moves first, so this cycle's snapshot sees the tasks in their new pools.
    step("applying moves");
    for (const f of await executor.applyPendingMoves((companyId) => loadScopedPools(store, [companyId], backendsFor))) {
      await alerter.apply([{ kind: "pluginError", subject: `move:${f.issueId}`, companyId: f.companyId, state: "start", message: `Couldn't move a waiting task: ${f.message}`, at: now().toISOString() }]);
    }
    step("building the snapshot");
    let snapshot = await buildSnapshot({ ctx, store, agents, readRuns, readFailures: opts.readFailures, listCompanies: companies.list, backendsFor, blockers, now: now() });
    companies.markDenied(snapshot.diagnostics?.skippedCompanies ?? []);
    step("retiring stale routine copies");
    await executor.retireStaleRoutineCopies(snapshot);
    step("reconciling holds");
    await executor.reconcileHolds(snapshot);
    step("confirming wakes");
    await executor.confirmWakes(snapshot);
    step("clearing placements");
    await executor.clearPlacements(snapshot);
    snapshot = { ...snapshot, holds: Object.values(await store.holds.get()), released: Object.values(await store.released.get()) };
    lastSnapshot = snapshot;
    step("counting today's runs");
    await countTodayRuns(snapshot);
    const actions = decide(snapshot, now());
    step("applying decisions");
    await executor.execute(actions, snapshot);
    const alerts = actions.flatMap((a) => (a.kind === "alert" ? [a.alert] : []));
    // After the decisions, so a task held here is placed on another engine by the next cycle, once its run is gone.
    step("draining engines");
    await drainEngines(snapshot);
    step("syncing alerts");
    await alerter.sync(LEVEL_KINDS, alerts, now().toISOString());
    step("done");
    lastCycleAt = now().toISOString();
    if (lastError || clearAfterStart) await alerter.apply([pluginError("clear", "Capacity cycles are running again")]);
    lastError = undefined;
    clearAfterStart = false;
    void reason;
  };

  const cycle = (reason: string) => {
    chain = chain.then(async () => {
      const generation = ++cycleGeneration;
      const at = { step: "starting" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stuck = new Promise<"stuck">((resolve) => { timer = setTimeout(() => resolve("stuck"), opts.cycleTimeoutMs ?? CYCLE_TIMEOUT_MS); });
      try {
        const outcome = await Promise.race([runCycle(reason, generation, at).then(() => "done" as const), stuck]);
        if (outcome === "stuck") {
          cycleGeneration++;
          lastError = `cycle stuck ${Math.round((opts.cycleTimeoutMs ?? CYCLE_TIMEOUT_MS) / 1000)} s at: ${at.step}`;
          ctx.logger.warn("Model capacity cycle stuck; abandoned", { reason, step: at.step });
          await alerter.apply([pluginError("start", `A capacity cycle got stuck while ${at.step}; it was abandoned and cycles continue`)]).catch(() => undefined);
        }
      } catch (e) {
        lastError = errText(e);
        ctx.logger.warn("Model capacity cycle failed", { reason, step: at.step, error: lastError });
        await alerter.apply([pluginError("start", "A capacity cycle failed; see the plugin logs")]).catch(() => undefined);
      } finally {
        clearTimeout(timer);
      }
    });
    return chain;
  };

  // Run events arrive in bursts; one cycle per burst is enough and keeps the 10 s release target (C3).
  const schedule = (reason: string) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => outsideInvocation(() => void cycle(reason)), opts.debounceMs ?? RUN_EVENT_DEBOUNCE_MS);
  };

  const probeTick = async () => {
    try {
      const pools = await loadScopedPools(store, (await companies.list()).map((c) => c.id), backendsFor);
      const { statuses, changes } = await probeAll(pools, await store.hosts.get(), { fetch: (url, init) => ctx.http.fetch(url, init), headers: hostHeaders, now });
      await store.hosts.set(statuses);
      for (const change of changes) ctx.logger.info("Model capacity host changed", { hostId: change.hostId, up: change.up });
      const names = new Map(pools.flatMap((p) => p.hosts.map((h) => [h.id, { host: h.name, pool: p.id, companyId: p.companyId }] as const)));
      // Host down opens an alert and coming back up clears it (G1: host down/up).
      await alerter.apply(changes.map((c) => ({
        kind: "hostDown" as const, subject: c.hostId, state: c.up ? ("clear" as const) : ("start" as const), poolId: names.get(c.hostId)?.pool,
        companyId: names.get(c.hostId)?.companyId,
        message: `${names.get(c.hostId)?.host ?? c.hostId} is ${c.up ? "back up" : "not answering health checks"}`, at: now().toISOString(),
      })));
      if (changes.length) schedule("host change");
    } catch (e) {
      ctx.logger.warn("Model capacity probe tick failed", { error: errText(e) });
    }
  };

  // Spend, credits and busy slots for every backend of every company with pools, for the widget (GET-only).
  // A backend that only reports a running total (LiteLLM's key spend) also gets today's share: the total now minus the
  // first total seen this UTC day. Backends that report their own daily figure (OpenRouter) are left alone.
  const withSpentToday = async (companyId: string, samples: BackendUsage[]) => {
    const day = now().toISOString().slice(0, 10);
    const baseline = store.spendBaseline(companyId);
    const prev = await baseline.get();
    const values = prev.day === day ? { ...prev.values } : {};
    const out = samples.map((s) => {
      if (!s.ok || s.meters.some((m) => /today/i.test(m.label))) return s;
      const total = s.meters.find((m) => m.unit === "usd" && m.used !== undefined);
      if (!total) return s;
      const key = `${s.backendId}|${total.label}`;
      values[key] ??= total.used!;
      return { ...s, meters: [...s.meters, { label: "Spent today", unit: "usd" as const, used: Math.max(0, total.used! - values[key]), derived: true }] };
    });
    await baseline.set({ day, values });
    return out;
  };

  // What the company's runs through a backend cost this month and used on free models in the last 24 hours, from
  // Paperclip's cost records, for a backend that reports neither.
  const readPaperclipSpend = async (companyId: string, b: Backend): Promise<PaperclipSpend | undefined> => {
    const [row] = await ctx.db.query<{ month_usd: string | number | null; free_runs: string | number | null; free_tokens: string | number | null }>(PAPERCLIP_SPEND_SQL, [companyId, `${backendPrefix(b)}%`]);
    return row ? { monthUsd: Number(row.month_usd ?? 0), freeRuns: Number(row.free_runs ?? 0), freeTokens: Number(row.free_tokens ?? 0) } : undefined;
  };

  const sampleCompany = async (companyId: string) => {
    const samples = await Promise.all((await backendsFor(companyId)).map(async (b): Promise<BackendUsage> => {
      let headers: Record<string, string> | undefined;
      try {
        headers = await backendAuth.headersFor(companyId, b.id);
      } catch (e) {
        return { backendId: b.id, sampledAt: now().toISOString(), ok: false, meters: [], notes: [], error: `Couldn't read the key: ${errText(e)}` };
      }
      const logsHeaders = b.type === "litellm" ? await backendAuth.logsHeadersFor(companyId, b.id).catch(() => undefined) : undefined;
      const paperclipSpend = b.type === "opencode" ? () => readPaperclipSpend(companyId, b) : undefined;
      return sampleUsage(b, { fetch: (url, init) => ctx.http.fetch(url, init), headers, logsHeaders, ...(b.prepaid?.length ? { prepaid: b.prepaid } : {}), paperclipSpend, now });
    }));
    await store.companyUsage(companyId).set(Object.fromEntries((await withSpentToday(companyId, samples)).map((s) => [s.backendId, s])));
    await refreshEngineAliases(companyId);
    await refreshSubscriptions(companyId);
  };
  // Subscription pools: read the company's Claude/ChatGPT windows with the board token, when one is saved.
  const refreshSubscriptions = async (companyId: string) => {
    if (!(await store.companyPools(companyId).get()).some((p) => p.subscription)) return;
    const auth = await quotaTokenFor(ctx, companyId).catch((e) => { ctx.logger.warn("Model capacity couldn't read the quota token", { companyId, error: errText(e) }); return undefined; });
    if (!auth) return;
    await store.subscriptionWindows(companyId).set(await readSubscriptionWindows(companyId, { fetch: (u, init) => ctx.http.fetch(u, init), baseUrl: auth.baseUrl, token: auth.token, now: now() }));
  };
  // Engine pools also count runs on other names a proxy routes only to one of their engines; keep that list fresh.
  const refreshEngineAliases = async (companyId: string) => {
    const pools = await store.companyPools(companyId).get();
    if (!pools.some((p) => p.kind === "engine")) return;
    const backends = await backendsFor(companyId);
    const engines = backends.filter((b) => apiInfo(b.type).group === "local");
    const aliases: Record<string, string[]> = {};
    for (const proxyId of new Set(engines.flatMap((e) => (e.reachVia && e.reachVia !== "direct" ? [e.reachVia] : [])))) {
      const proxy = backends.find((b) => b.id === proxyId);
      if (!proxy) continue;
      const routes = await fetchProxyRoutes(ctx, proxy, engines, await backendAuth.headersFor(companyId, proxy.id).catch(() => undefined));
      if (!routes.ok) continue;
      for (const engine of engines.filter((e) => e.reachVia === proxyId)) aliases[engine.id] = reachCandidates(engine.id, routes.routes);
    }
    await store.companyEngineAliases(companyId).set(aliases);
  };
  const usageTick = async () => {
    for (const c of await companiesWithPools().catch(() => [])) {
      await sampleCompany(c.id).catch((e) => ctx.logger.warn("Model capacity usage sample failed", { companyId: c.id, error: errText(e) }));
    }
  };

  const start = () => {
    // Jobs run in a host invocation with no company, where per-company calls (config.get) are refused; as proactive
    // work they're allowed for the plugin's configured companies.
    ctx.jobs.register("sweep", async () => outsideInvocation(() => cycle("sweep")));
    ctx.jobs.register("prune", async () => {
      const removed = await store.pruneHistory(now(), HISTORY_RETENTION_DAYS);
      ctx.logger.info("Model capacity pruned history", { days: removed });
    });
    for (const type of ["agent.run.started", "agent.run.finished", "agent.run.failed", "agent.run.cancelled"] as const) {
      ctx.events.on(type, async (event) => {
        await companies.noteFromEvent(event.companyId);
        schedule(type);
      });
    }
    ctx.events.on("issue.updated", async (event) => {
      await companies.noteFromEvent(event.companyId);
      schedule("issue.updated");
    });
    ctx.events.on("agent.updated", async (event) => {
      agents.invalidate(event.companyId);
      await companies.noteFromEvent(event.companyId);
      schedule("agent.updated");
    });
    const interval = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    if (interval > 0) {
      probeTimer = setInterval(() => outsideInvocation(() => void probeTick()), interval);
      probeTimer.unref?.();
    }
    // The plugin's own sweep timer: the host's "sweep" job didn't run at all on Paperclip 2026.1103.0-nightly.0 (its
    // next run stayed in the past), and with only events left to start cycles, quiet stretches froze scheduling. A
    // sweep starts only when no cycle has finished for most of a minute, so it doesn't double up with the host job.
    const sweepInterval = opts.sweepIntervalMs ?? (interval > 0 ? SWEEP_INTERVAL_MS : 0);
    if (sweepInterval > 0) {
      sweepTimer = setInterval(() => {
        if (!lastCycleAt || now().getTime() - Date.parse(lastCycleAt) > sweepInterval * 0.8) outsideInvocation(() => void cycle("sweep timer"));
      }, sweepInterval);
      sweepTimer.unref?.();
    }
    const usageInterval = opts.usageIntervalMs ?? (interval > 0 ? DEFAULT_USAGE_INTERVAL_MS : 0);
    if (usageInterval > 0) {
      usageTimer = setInterval(() => outsideInvocation(() => void usageTick()), usageInterval);
      usageTimer.unref?.();
      setTimeout(() => outsideInvocation(() => void usageTick()), 5_000).unref?.();
    }
  };

  const stop = async () => {
    clearInterval(probeTimer);
    clearInterval(usageTimer);
    clearInterval(sweepTimer);
    clearTimeout(debounce);
    await chain;
  };

  // Waits for a pending debounce to fire and the cycle chain to drain (tests and shutdown).
  const idle = async () => {
    await new Promise((resolve) => setTimeout(resolve, (opts.debounceMs ?? RUN_EVENT_DEBOUNCE_MS) + 5));
    await chain;
  };

  const health = () => ({ lastCycleAt, lastError });

  return { start, stop, cycle, schedule, companies, probeTick, usageTick, sampleCompany, idle, health, store, executor, backendAuth, backendsFor, snapshot: () => lastSnapshot };
};

export type Runtime = ReturnType<typeof createRuntime>;
