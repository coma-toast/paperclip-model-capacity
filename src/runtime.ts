import type { PluginContext } from "@paperclipai/plugin-sdk";

import { DEFAULT_PROBE_INTERVAL_MS, HISTORY_RETENTION_DAYS, RUN_EVENT_DEBOUNCE_MS } from "./constants.js";
import { LEVEL_KINDS, createAlerter } from "./alerts.js";
import { createExecutor } from "./executor.js";
import { probeAll } from "./probes/index.js";
import { decide } from "./scheduler/decide.js";
import { buildSnapshot, createAgentCache, dbRunReader, type RunReader } from "./snapshot.js";
import { createStore } from "./state/store.js";
import type { AlertEvent } from "./types.js";

export interface RuntimeOptions {
  debounceMs?: number;
  // 0 turns the probe loop off (tests).
  probeIntervalMs?: number;
  readRuns?: RunReader;
  now?: () => Date;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const createRuntime = (ctx: PluginContext, opts: RuntimeOptions = {}) => {
  const now = opts.now ?? (() => new Date());
  const store = createStore(ctx.state);
  const agents = createAgentCache(ctx);
  const readRuns = opts.readRuns ?? dbRunReader(ctx);
  const configId = async (companyId: string, key: string) => {
    const value = (await ctx.config.get(companyId))[key];
    return typeof value === "string" && value ? value : undefined;
  };
  const executor = createExecutor({ ctx, store, queueLabelId: (companyId) => configId(companyId, "queueLabelId") });
  const alerter = createAlerter({ ctx, store, alertIssueId: (companyId) => configId(companyId, "alertIssueId") });
  const pluginError = (state: "start" | "clear", message: string): AlertEvent =>
    ({ kind: "pluginError", subject: "cycle", state, message, at: now().toISOString() });
  let chain: Promise<void> = Promise.resolve();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  let lastCycleAt: string | undefined;
  let lastError: string | undefined;

  // One cycle at a time, so two triggers never read the same state and both act on it.
  const cycle = (reason: string) => {
    chain = chain.then(async () => {
      try {
        let snapshot = await buildSnapshot({ ctx, store, agents, readRuns, now: now() });
        await executor.reconcileHolds(snapshot);
        await executor.confirmWakes(snapshot);
        snapshot = { ...snapshot, holds: Object.values(await store.holds.get()), released: Object.values(await store.released.get()) };
        const actions = decide(snapshot, now());
        await executor.execute(actions, snapshot);
        const alerts = actions.flatMap((a) => (a.kind === "alert" ? [a.alert] : []));
        await alerter.sync(LEVEL_KINDS, alerts, now().toISOString());
        lastCycleAt = now().toISOString();
        if (lastError) await alerter.apply([pluginError("clear", "Capacity cycles are running again")]);
        lastError = undefined;
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
    debounce = setTimeout(() => void cycle(reason), opts.debounceMs ?? RUN_EVENT_DEBOUNCE_MS);
  };

  const probeTick = async () => {
    try {
      const pools = await store.pools.get();
      const { statuses, changes } = await probeAll(pools, await store.hosts.get(), { fetch: (url, init) => ctx.http.fetch(url, init), now });
      await store.hosts.set(statuses);
      for (const change of changes) ctx.logger.info("Model capacity host changed", { hostId: change.hostId, up: change.up });
      const names = new Map(pools.flatMap((p) => p.hosts.map((h) => [h.id, { host: h.name, pool: p.id }] as const)));
      // Host down opens an alert and coming back up clears it (G1: host down/up).
      await alerter.apply(changes.map((c) => ({
        kind: "hostDown" as const, subject: c.hostId, state: c.up ? ("clear" as const) : ("start" as const), poolId: names.get(c.hostId)?.pool,
        message: `${names.get(c.hostId)?.host ?? c.hostId} is ${c.up ? "back up" : "not answering health checks"}`, at: now().toISOString(),
      })));
      if (changes.length) schedule("host change");
    } catch (e) {
      ctx.logger.warn("Model capacity probe tick failed", { error: errText(e) });
    }
  };

  const start = () => {
    ctx.jobs.register("sweep", async () => cycle("sweep"));
    ctx.jobs.register("prune", async () => {
      const removed = await store.pruneHistory(now(), HISTORY_RETENTION_DAYS);
      ctx.logger.info("Model capacity pruned history", { days: removed });
    });
    for (const type of ["agent.run.started", "agent.run.finished", "agent.run.failed", "agent.run.cancelled"] as const) {
      ctx.events.on(type, async () => schedule(type));
    }
    ctx.events.on("issue.updated", async () => schedule("issue.updated"));
    ctx.events.on("agent.updated", async (event) => {
      agents.invalidate(event.companyId);
      schedule("agent.updated");
    });
    const interval = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    if (interval > 0) {
      probeTimer = setInterval(() => void probeTick(), interval);
      probeTimer.unref?.();
    }
  };

  const stop = async () => {
    clearInterval(probeTimer);
    clearTimeout(debounce);
    await chain;
  };

  // Waits for a pending debounce to fire and the cycle chain to drain (tests and shutdown).
  const idle = async () => {
    await new Promise((resolve) => setTimeout(resolve, (opts.debounceMs ?? RUN_EVENT_DEBOUNCE_MS) + 5));
    await chain;
  };

  const health = () => ({ lastCycleAt, lastError });

  return { start, stop, cycle, probeTick, idle, health, store };
};

export type Runtime = ReturnType<typeof createRuntime>;
