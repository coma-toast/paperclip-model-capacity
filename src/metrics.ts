import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";

import type { PoolSummary } from "./api.js";
import { summarize } from "./api.js";
import { loadHeldPoolKeys, loadScopedPools } from "./pools.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./state/store.js";
import type { Snapshot } from "./types.js";
import type { BackendUsage } from "./usage.js";

const escapeLabel = (val: string) =>
  val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export interface MetricsData {
  summaries: PoolSummary[];
  counters: {
    overLimit: Record<string, number>;
    overflow: Record<string, number>;
  };
  usages?: Record<string, BackendUsage>[];
}

export const formatPrometheusMetrics = (data: MetricsData): string => {
  const { summaries, counters, usages } = data;
  const lines: string[] = [];

  const addGauge = (
    name: string,
    help: string,
    series: { labels: Record<string, string>; value: number }[],
  ) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    for (const s of series) {
      const labelStr = Object.entries(s.labels)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(",");
      lines.push(`${name}${labelStr ? `{${labelStr}}` : ""} ${s.value}`);
    }
  };

  const addCounter = (
    name: string,
    help: string,
    series: { labels: Record<string, string>; value: number }[],
  ) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const s of series) {
      const labelStr = Object.entries(s.labels)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(",");
      lines.push(`${name}${labelStr ? `{${labelStr}}` : ""} ${s.value}`);
    }
  };

  // 1. pool_limit
  addGauge(
    "paperclip_model_capacity_pool_limit",
    "Configured run limit for the model pool.",
    summaries.map((p) => ({
      labels: {
        company: p.companyId ?? "",
        pool: p.id,
        pool_name: p.name,
      },
      value: p.limit,
    })),
  );

  // 2. pool_available
  addGauge(
    "paperclip_model_capacity_pool_available",
    "Available capacity slots in the model pool.",
    summaries.map((p) => ({
      labels: {
        company: p.companyId ?? "",
        pool: p.id,
        pool_name: p.name,
      },
      value: p.available,
    })),
  );

  // 3. pool_running
  addGauge(
    "paperclip_model_capacity_pool_running",
    "Number of runs occupying capacity in the model pool.",
    summaries.map((p) => ({
      labels: {
        company: p.companyId ?? "",
        pool: p.id,
        pool_name: p.name,
      },
      value: p.inUse,
    })),
  );

  // 4. pool_held
  addGauge(
    "paperclip_model_capacity_pool_held",
    "Number of tasks queued in the model pool.",
    summaries.map((p) => ({
      labels: {
        company: p.companyId ?? "",
        pool: p.id,
        pool_name: p.name,
      },
      value: p.queued,
    })),
  );

  // 5. pool_oldest_wait_seconds
  addGauge(
    "paperclip_model_capacity_pool_oldest_wait_seconds",
    "Wait time in seconds of the oldest queued task in the pool.",
    summaries.map((p) => ({
      labels: {
        company: p.companyId ?? "",
        pool: p.id,
        pool_name: p.name,
      },
      value: p.oldestWaitSeconds ?? 0,
    })),
  );

  // 6. host metrics
  const hostUpSeries: { labels: Record<string, string>; value: number }[] = [];
  const hostSlotsTotalSeries: { labels: Record<string, string>; value: number }[] = [];
  const hostSlotsBusySeries: { labels: Record<string, string>; value: number }[] = [];
  for (const p of summaries) {
    for (const h of p.hosts) {
      const labels = {
        company: p.companyId ?? "",
        pool: p.id,
        host: h.id,
        host_name: h.name,
        engine: h.engine,
      };
      hostUpSeries.push({ labels, value: h.up ? 1 : 0 });
      if (typeof h.slotsTotal === "number") {
        hostSlotsTotalSeries.push({ labels, value: h.slotsTotal });
      }
      if (typeof h.slotsBusy === "number") {
        hostSlotsBusySeries.push({ labels, value: h.slotsBusy });
      }
    }
  }
  addGauge(
    "paperclip_model_capacity_host_up",
    "Whether the host/engine is reachable (1) or down (0).",
    hostUpSeries,
  );
  if (hostSlotsTotalSeries.length > 0) {
    addGauge(
      "paperclip_model_capacity_host_slots_total",
      "Total capacity slots on the host.",
      hostSlotsTotalSeries,
    );
  }
  if (hostSlotsBusySeries.length > 0) {
    addGauge(
      "paperclip_model_capacity_host_slots_busy",
      "Busy capacity slots on the host.",
      hostSlotsBusySeries,
    );
  }

  // 7. quota_remaining (if any)
  if (usages && usages.length > 0) {
    const quotaSeries: { labels: Record<string, string>; value: number }[] = [];
    for (const usageMap of usages) {
      for (const [backendId, usage] of Object.entries(usageMap)) {
        for (const meter of usage?.meters ?? []) {
          if (typeof meter.remaining === "number") {
            quotaSeries.push({
              labels: {
                backend: backendId,
                meter: meter.label,
                unit: meter.unit,
              },
              value: meter.remaining,
            });
          }
        }
      }
    }
    if (quotaSeries.length > 0) {
      addGauge(
        "paperclip_model_capacity_quota_remaining",
        "Remaining quota for an upstream provider or backend meter.",
        quotaSeries,
      );
    }
  }

  // 8. over_limit_total
  addCounter(
    "paperclip_model_capacity_over_limit_total",
    "Total over-limit events observed for the pool.",
    summaries.map((p) => ({
      labels: {
        company: p.companyId ?? "",
        pool: p.id,
        pool_name: p.name,
      },
      value: counters.overLimit[p.id] ?? 0,
    })),
  );

  // 9. overflow_total
  addCounter(
    "paperclip_model_capacity_overflow_total",
    "Total overflow events observed for the pool.",
    summaries.map((p) => ({
      labels: {
        company: p.companyId ?? "",
        pool: p.id,
        pool_name: p.name,
      },
      value: counters.overflow[p.id] ?? 0,
    })),
  );

  return lines.join("\n") + "\n";
};

export const countEventsFromHistory = async (
  store: Store,
  companyId?: string,
): Promise<{ overLimit: Record<string, number>; overflow: Record<string, number> }> => {
  const days = await store.historyDays();
  const overLimit: Record<string, number> = {};
  const overflow: Record<string, number> = {};
  for (const day of days) {
    const entries = await store.history(day);
    for (const e of entries) {
      if (e.action.kind === "alert" && e.action.alert.kind === "overLimit" && e.action.alert.state === "start") {
        const cId = e.action.alert.companyId;
        if (!companyId || cId === companyId) {
          const poolId = e.action.alert.poolId;
          if (poolId) overLimit[poolId] = (overLimit[poolId] ?? 0) + 1;
        }
      } else if (e.action.kind === "overflow") {
        const cId = e.action.companyId;
        if (!companyId || cId === companyId) {
          const poolId = e.action.fromPoolId;
          if (poolId) overflow[poolId] = (overflow[poolId] ?? 0) + 1;
        }
      }
    }
  }
  return { overLimit, overflow };
};

export const collectMetrics = async (
  runtime: Runtime,
  companyId?: string,
  now: () => Date = () => new Date(),
): Promise<string> => {
  const { store } = runtime;
  const knownCompanies = (await store.companies.get()).map((c) => c.id);
  const companyIds = companyId ? [companyId] : (knownCompanies.length ? knownCompanies : [""]);

  const last = runtime.snapshot();
  const snapshot: Snapshot = {
    now: last?.now ?? now().toISOString(),
    hosts: await store.hosts.get(),
    runs: last?.runs ?? [],
    tasks: last?.tasks ?? [],
    released: last?.released ?? Object.values(await store.released.get()),
    diagnostics: last?.diagnostics,
    exhausted: await store.exhausted.get(),
    pools: await loadScopedPools(store, companyIds, runtime.backendsFor),
    holds: Object.values(await store.holds.get()).filter((h) => !companyId || h.companyId === companyId),
    heldPools: await loadHeldPoolKeys(store, companyIds),
  };

  const activeAlerts = await store.alerts.get();
  const openAlertPools = Object.values(activeAlerts.active).map((a) => a.poolId).filter(Boolean) as string[];
  const allSummaries = summarize(snapshot, openAlertPools, now());
  const summaries = companyId ? allSummaries.filter((p) => !p.companyId || p.companyId === companyId) : allSummaries;

  const counters = await countEventsFromHistory(store, companyId);

  const usages: Record<string, BackendUsage>[] = [];
  for (const cId of companyIds) {
    if (cId) {
      const usage = await store.companyUsage(cId).get();
      if (usage && Object.keys(usage).length) usages.push(usage);
    }
  }

  return formatPrometheusMetrics({ summaries, counters, usages });
};

export const resolveMetricsToken = async (
  ctx: PluginContext,
  companyId?: string,
): Promise<string | undefined> => {
  const config = await ctx.config.get();
  const raw = config.metricsToken;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const token = raw.trim();
  if (token.startsWith("secret:")) {
    try {
      const resolved = await ctx.secrets.resolve(
        token as Parameters<PluginContext["secrets"]["resolve"]>[0],
        { companyId: companyId ?? "", configPath: "metricsToken" },
      );
      return resolved || undefined;
    } catch {
      return undefined;
    }
  }
  return token;
};

export const authorizeMetricsRequest = async (
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<{ authorized: boolean; reason?: string }> => {
  const expectedToken = await resolveMetricsToken(ctx, input.companyId);
  // If no metricsToken is configured in settings, Paperclip's host auth (board-or-agent)
  // already verified the caller's credentials.
  if (!expectedToken) {
    return { authorized: true };
  }

  const authHeader = input.headers?.authorization ?? "";
  const match = authHeader.match(/^bearer\s+(\S+)$/i);
  const headerToken = match ? match[1] : undefined;
  const queryToken = typeof input.query?.token === "string" ? input.query.token : undefined;

  const providedToken = headerToken || queryToken;
  if (!providedToken) {
    return { authorized: false, reason: "Missing metrics bearer token" };
  }
  if (providedToken !== expectedToken) {
    return { authorized: false, reason: "Invalid metrics bearer token" };
  }
  return { authorized: true };
};
