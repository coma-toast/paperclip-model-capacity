import { AsyncLocalStorage } from "node:async_hooks";

import type { PluginContext } from "@paperclipai/plugin-sdk";

import { DEFAULT_PROBE_INTERVAL_MS, DEFAULT_USAGE_INTERVAL_MS, HISTORY_RETENTION_DAYS, RUN_EVENT_DEBOUNCE_MS } from "./constants.js";
import { LEVEL_KINDS, createAlerter } from "./alerts.js";
import { createBackendAuth, readBackends } from "./backends.js";
import { createExecutor } from "./executor.js";
import { loadScopedPools, splitPoolKey } from "./pools.js";
import { probeAll } from "./probes/index.js";
import { decide } from "./scheduler/decide.js";
import { buildSnapshot, createAgentCache, createBlockerCache, createCompanyDirectory, dbRunReader, type RunReader } from "./snapshot.js";
import { createStore } from "./state/store.js";
import type { AlertEvent, HostConfig, Snapshot } from "./types.js";
import { sampleUsage, type BackendUsage } from "./usage.js";

export interface RuntimeOptions {
  debounceMs?: number;
  // 0 turns the probe loop off (tests).
  probeIntervalMs?: number;
  // 0 turns usage sampling off; defaults to off when probing is off.
  usageIntervalMs?: number;
  readRuns?: RunReader;
  now?: () => Date;
}

// Captured at module load, before any host invocation. The SDK tags each host call with the current invocation id
// from AsyncLocalStorage, and a timer set inside an event handler would carry that id after the invocation ended,
// so the host rejects it as expired. Timer work runs in this clean context instead, as proactive work that the host
// allows for the plugin's configured companies.
const outsideInvocation = AsyncLocalStorage.snapshot();

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
  const backendAuth = createBackendAuth(ctx);
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
  let lastCycleAt: string | undefined;
  let lastError: string | undefined;
  // A failure alert can outlive a restart (lastError resets), so the first good cycle after start clears it too.
  let clearAfterStart = true;
  let lastSnapshot: Snapshot | undefined;

  // One cycle at a time, so two triggers never read the same state and both act on it.
  const cycle = (reason: string) => {
    chain = chain.then(async () => {
      try {
        let snapshot = await buildSnapshot({ ctx, store, agents, readRuns, listCompanies: companies.list, backendsFor, blockers, now: now() });
        companies.markDenied(snapshot.diagnostics?.skippedCompanies ?? []);
        await executor.reconcileHolds(snapshot);
        await executor.confirmWakes(snapshot);
        snapshot = { ...snapshot, holds: Object.values(await store.holds.get()), released: Object.values(await store.released.get()) };
        lastSnapshot = snapshot;
        const actions = decide(snapshot, now());
        await executor.execute(actions, snapshot);
        const alerts = actions.flatMap((a) => (a.kind === "alert" ? [a.alert] : []));
        await alerter.sync(LEVEL_KINDS, alerts, now().toISOString());
        lastCycleAt = now().toISOString();
        if (lastError || clearAfterStart) await alerter.apply([pluginError("clear", "Capacity cycles are running again")]);
        lastError = undefined;
        clearAfterStart = false;
      } catch (e) {
        lastError = errText(e);
        ctx.logger.warn("Model capacity cycle failed", { reason, error: lastError });
        await alerter.apply([pluginError("start", "A capacity cycle failed; see the plugin logs")]).catch(() => undefined);
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
  const sampleCompany = async (companyId: string) => {
    const samples = await Promise.all((await backendsFor(companyId)).map(async (b): Promise<BackendUsage> => {
      let headers: Record<string, string> | undefined;
      try {
        headers = await backendAuth.headersFor(companyId, b.id);
      } catch (e) {
        return { backendId: b.id, sampledAt: now().toISOString(), ok: false, meters: [], notes: [], error: `Couldn't read the key: ${errText(e)}` };
      }
      return sampleUsage(b, { fetch: (url, init) => ctx.http.fetch(url, init), headers, now });
    }));
    await store.companyUsage(companyId).set(Object.fromEntries(samples.map((s) => [s.backendId, s])));
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
