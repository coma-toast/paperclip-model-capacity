import type { Agent, Company, Issue, PluginContext } from "@paperclipai/plugin-sdk";

import { AGENT_CACHE_TTL_MS, OPEN_TASK_STATUSES, PARK_EXPIRY_MS, PRIORITY_RANK, STALLED_QUEUED_MS, virtualModel } from "./constants.js";
import { loadHeldPoolKeys, loadScopedPools, type BackendsFor } from "./pools.js";
import { stripPrefix } from "./apis.js";
import { backendPrefix } from "./backends.js";
import { matchPool } from "./scheduler/match.js";
import { agentModel, effectiveModel, isPinned, modelProvider } from "./scheduler/model.js";
import type { RunCounts, Store } from "./state/store.js";
import { subscriptionExhausted, subscriptionLeft } from "./subscriptions.js";
import { upstreamQuota } from "./upstream.js";
import type { ExhaustedModel, OpenTask, PoolAgent, PoolConfig, RunningRun, Snapshot, TaskPriority } from "./types.js";

export const PAGE_SIZE = 200;

// The host refuses company-scoped calls for a company the plugin isn't configured for.
export const isScopeDenied = (e: unknown) =>
  e instanceof Error && (e.name === "InvocationScopeDeniedError" || /company context is required|invocation scope|is not allowed to perform/.test(e.message));

export interface RunRow {
  id: string;
  company_id: string;
  agent_id: string;
  issue_id: string | null;
  status: string;
  started_at: string | Date | null;
  created_at?: string | Date | null;
}

// Returns undefined when the core table can't be read, so the builder falls back to Issue.activeRun.
export type RunReader = () => Promise<RunRow[] | undefined>;

// Needs `database.coreReadTables: ["heartbeat_runs"]` (spike check 4). Older runs keep the issue only in context_snapshot.
export const RUNS_SQL =
  "SELECT id, company_id, agent_id, COALESCE(issue_id::text, context_snapshot->>'issueId') AS issue_id, status, started_at, created_at " +
  "FROM public.heartbeat_runs WHERE status IN ('queued', 'running')";

// Provider failures in the last 30 minutes, for spotting rate limits and used-up quota per model.
export interface FailureRow {
  company_id: string;
  agent_id: string;
  issue_id: string | null;
  error: string | null;
  finished_at: string | Date | null;
}
export type FailureReader = () => Promise<FailureRow[] | undefined>;
export const FAILURES_SQL =
  "SELECT company_id, agent_id, COALESCE(issue_id::text, context_snapshot->>'issueId') AS issue_id, error, finished_at " +
  "FROM public.heartbeat_runs WHERE status = 'failed' AND error_code = 'adapter_failed' AND finished_at > now() - interval '30 minutes'";
export const dbFailureReader = (ctx: PluginContext): FailureReader => async () => {
  try {
    return await ctx.db.query<FailureRow>(FAILURES_SQL);
  } catch {
    return undefined;
  }
};
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|quota|usage.?limit|limit reached|insufficient.?(credit|balance|funds)|out of credits|FreeUsageLimit/i;
export const RATE_LIMIT_FAILURES = 2;
const DAILY_LIMIT = /per.?day|daily|requests? a day|free-models-per-day|RPD\b/i;

export const nextMidnightUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
// When a provider's rate-limit error says the limit resets: an epoch reset header, a retry-after in seconds, "try again
// in 5 minutes", or a daily limit (midnight UTC). Undefined when the error doesn't say.
export const resetFromError = (error: string, now: Date): string | undefined => {
  const epoch = error.match(/ratelimit-reset["'\\:\s=]+(\d{10,13})\b/i) ?? error.match(/limit reached\s*\|\s*(\d{10,13})\b/i);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const after = error.match(/retry.?after["'\\:\s=]+(\d+)\b/i);
  if (after) return new Date(now.getTime() + Number(after[1]) * 1000).toISOString();
  // "try again in 3 days 4 hours 5 minutes", "resets in 2h 30m", "retry in 90 seconds"
  const span = error.match(/(?:try again|retry|resets?)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)\b[\s,]*(?:and\s+)?)+)/i);
  if (span) {
    let ms = 0;
    for (const [, n, u] of span[1].matchAll(/(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)\b/gi)) ms += Number(n) * UNIT_MS[u[0].toLowerCase()];
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }
  // "resets at Nov 4th, 2026 8:05 AM" / "try again at 2026-11-04T08:05:27Z"
  const at = error.match(/(?:try again|resets?|available again)\s+(?:at|on)\s+([A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?(?:\s*(?:UTC|GMT|Z))?|\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
  if (at) {
    const t = Date.parse(at[1].replace(/(\d)(st|nd|rd|th)/, "$1"));
    if (!Number.isNaN(t) && t > now.getTime()) return new Date(t).toISOString();
  }
  if (DAILY_LIMIT.test(error)) return nextMidnightUtc(now);
  return undefined;
};

// Adds runs not yet counted today to the per-model tally; a new UTC day starts from zero.
export const countRuns = (prev: RunCounts, runs: { runId: string; model?: string }[], now: Date): RunCounts => {
  const day = now.toISOString().slice(0, 10);
  const base = prev.day === day ? prev : { day, counts: {}, seen: [] };
  const seen = new Set(base.seen);
  const counts = { ...base.counts };
  for (const r of runs) {
    if (!r.model || seen.has(r.runId)) continue;
    seen.add(r.runId);
    counts[r.model] = (counts[r.model] ?? 0) + 1;
  }
  return { day, counts, seen: [...seen] };
};
export const RATE_LIMIT_WINDOW_MS = 15 * 60_000;

// How much of a running task's first post the engine runs dialog shows on hover.
const RUN_DESCRIPTION_CHARS = 600;

export const dbRunReader = (ctx: PluginContext): RunReader => async () => {
  try {
    return await ctx.db.query<RunRow>(RUNS_SQL);
  } catch (e) {
    ctx.logger.warn("heartbeat_runs read failed; using Issue.activeRun", { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
};

const pageAll = async <T>(fetchPage: (offset: number) => Promise<T[]>): Promise<T[]> => {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchPage(offset);
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
  }
};

export const createAgentCache = (ctx: PluginContext, ttlMs = AGENT_CACHE_TTL_MS, clock: () => number = Date.now) => {
  const cache = new Map<string, { at: number; agents: Map<string, Agent> }>();
  return {
    get: async (companyId: string) => {
      const hit = cache.get(companyId);
      if (hit && clock() - hit.at < ttlMs) return hit.agents;
      const list = await pageAll((offset) => ctx.agents.list({ companyId, limit: PAGE_SIZE, offset }));
      const agents = new Map(list.map((a) => [a.id, a]));
      cache.set(companyId, { at: clock(), agents });
      return agents;
    },
    // Called on agent.updated so a model change counts at once.
    invalidate: (companyId?: string) => (companyId ? cache.delete(companyId) : cache.clear()),
  };
};

export type AgentCache = ReturnType<typeof createAgentCache>;

const toPriority = (p: unknown): TaskPriority => (typeof p === "string" && p in PRIORITY_RANK ? (p as TaskPriority) : "medium");
const toIso = (d: string | Date | null | undefined) => (d ? new Date(d).toISOString() : undefined);
const ACTIVE = new Set(["queued", "running"]);

const activeRunRows = (issues: Issue[]): RunRow[] =>
  issues.flatMap((i) =>
    i.activeRun && ACTIVE.has(i.activeRun.status)
      ? [{ id: i.activeRun.id, company_id: i.companyId, agent_id: i.activeRun.agentId, issue_id: i.id, status: i.activeRun.status, started_at: i.activeRun.startedAt }]
      : [],
  );

// Keeps the last good company list: the host can refuse a proactive companies.list while another invocation is in
// flight, and one refused call shouldn't stop a cycle.
// The host refuses a proactive (timer or sweep) companies.list whenever any other host invocation is registered, which
// is nearly always on a live instance. Inside an event handler the call carries a valid invocation id and is allowed,
// so companies are learned there and saved; timer work reads the saved list.
export const COMPANY_REFRESH_MS = 5 * 60_000;

// A company the host refused is not asked about again for this long, so the host log doesn't fill with denials. Kept
// short because the host also refuses briefly while it loads the plugin's companies after a restart.
export const DENIED_COMPANY_BACKOFF_MS = 2 * 60_000;

export const createCompanyDirectory = (ctx: PluginContext, store: Store, clock: () => number = Date.now) => {
  let refreshedAt = 0;
  const deniedUntil = new Map<string, number>();
  const save = async (list: { id: string; name: string }[]) => {
    const current = await store.companies.get();
    // A placeholder name (the id) never replaces a real one.
    const byId = new Map(current.map((c) => [c.id, c]));
    for (const c of list) if (!byId.has(c.id)) byId.set(c.id, c);
    if (byId.size !== current.length) await store.companies.set([...byId.values()]);
  };
  return {
    // Call from inside an event handler: records the event's company, and refreshes the full list now and then.
    noteFromEvent: async (companyId: string | undefined) => {
      if (companyId) await save([{ id: companyId, name: companyId }]).catch(() => undefined);
      if (clock() - refreshedAt < COMPANY_REFRESH_MS) return;
      refreshedAt = clock();
      try {
        // Merged, never replaced: inside one company's event the host lists only that company, and replacing the
        // saved list with it dropped every other company (their pools stopped being enforced).
        const list = await pageAll((offset) => ctx.companies.list({ limit: PAGE_SIZE, offset }));
        const byId = new Map((await store.companies.get()).map((c) => [c.id, c]));
        for (const c of list) byId.set(c.id, { id: c.id, name: c.name });
        await store.companies.set([...byId.values()]);
      } catch (e) {
        ctx.logger.warn("companies.list failed inside an event; keeping the saved list", { error: e instanceof Error ? e.message : String(e) });
      }
    },
    // Records a company known from a board action (e.g. saving its pools).
    note: (companyId: string) => save([{ id: companyId, name: companyId }]),
    list: async () => ((await store.companies.get()) as unknown as Company[]).filter((c) => (deniedUntil.get(c.id) ?? 0) <= clock()),
    markDenied: (companyIds: string[]) => {
      for (const id of companyIds) deniedUntil.set(id, clock() + DENIED_COMPANY_BACKOFF_MS);
    },
  };
};

// Blocked tasks' blockers, cached briefly: issue lists don't include them, and reading each one every cycle is costly.
export const BLOCKER_CACHE_TTL_MS = 120_000;
const DONE_STATUSES = new Set(["done", "cancelled"]);
export const createBlockerCache = (ctx: PluginContext, ttlMs = BLOCKER_CACHE_TTL_MS, clock: () => number = Date.now) => {
  const cache = new Map<string, { at: number; ids: string[] }>();
  return {
    // Ids of the task's blockers that aren't done or cancelled.
    unresolved: async (issueId: string, companyId: string) => {
      const hit = cache.get(issueId);
      if (hit && clock() - hit.at < ttlMs) return hit.ids;
      const relations = await ctx.issues.relations.get(issueId, companyId);
      const ids = relations.blockedBy.filter((b) => !DONE_STATUSES.has(String(b.status))).map((b) => b.id);
      cache.set(issueId, { at: clock(), ids });
      return ids;
    },
  };
};
export type BlockerCache = ReturnType<typeof createBlockerCache>;

export interface SnapshotDeps {
  ctx: PluginContext;
  store: Store;
  agents: AgentCache;
  readRuns: RunReader;
  readFailures?: FailureReader;
  listCompanies?: () => Promise<Company[]>;
  backendsFor?: BackendsFor;
  blockers?: BlockerCache;
  now?: Date;
}

// Agent statuses Paperclip won't start a run for.
export const NOT_RUNNABLE_AGENT: ReadonlySet<string> = new Set(["paused", "pausing", "terminated", "pending_approval"]);

// The agents of each switching pool, with the adapter they run on now: those on the pool's virtual model or on one of
// its models (Claude Code and Codex agents keep a real model so a run started before placement still works).
const poolAgentsOf = (pools: PoolConfig[], agentsByCompany: Map<string, Map<string, Agent>>): PoolAgent[] =>
  pools.filter((p) => p.switchAdapters && p.companyId).flatMap((p) => {
    const virtual = virtualModel(p.localId ?? p.id);
    return [...(agentsByCompany.get(p.companyId!)?.values() ?? [])]
      .filter((a) => !NOT_RUNNABLE_AGENT.has(String(a.status)) && matchPool(agentModel(a), [p]) !== undefined)
      .map((a) => ({ id: a.id, companyId: p.companyId!, model: virtual, adapterType: a.adapterType }));
  });

// Each subscription's quota left, for companies with a switching pool.
const subscriptionLeftOf = async (store: Store, pools: PoolConfig[], now: Date) => {
  const out: NonNullable<Snapshot["subscriptionLeft"]> = {};
  for (const companyId of new Set(pools.filter((p) => p.switchAdapters && p.companyId).map((p) => p.companyId!))) {
    const sample = (await store.subscriptionWindows(companyId).get()) ?? undefined;
    const left = { anthropic: subscriptionLeft(sample, "anthropic", now), openai: subscriptionLeft(sample, "openai", now) };
    out[companyId] = Object.fromEntries(Object.entries(left).filter(([, v]) => v !== undefined));
  }
  return out;
};

// Quota pool models whose quota is used up, keyed "<companyId>|<model>". Two sources: the pool backend's usage sample
// reports a meter with nothing left (until its reset), or the model's runs failed with rate-limit or quota errors at
// least RATE_LIMIT_FAILURES times in RATE_LIMIT_WINDOW_MS (until the window passes). When a model first became used up
// is kept in state, so "used up for reassignAfterMinutes" can be told apart from "just now".
const exhaustedModels = async (input: {
  store: Store;
  pools: PoolConfig[];
  backendsFor?: BackendsFor;
  failures: FailureRow[] | undefined;
  issuesById: Map<string, Issue>;
  agentsByCompany: Map<string, Map<string, Agent>>;
  now: Date;
}): Promise<Record<string, ExhaustedModel>> => {
  const { store, pools, backendsFor, failures, issuesById, agentsByCompany, now } = input;
  const current: Record<string, { until?: string; reason: string }> = {};
  // Each model pauses on its own backend's limits, and a proxy alias also when every upstream it calls is used up.
  for (const pool of pools.filter((p) => p.kind === "quota" && p.companyId && !p.allowOverQuota)) {
    const usage = await store.companyUsage(pool.companyId!).get();
    const backends = backendsFor ? await backendsFor(pool.companyId!) : [];
    // A pool that keeps its name has no placement; its own models (not the pool name) are what pause.
    const targets = pool.placement ?? pool.patterns.filter((m) => m !== virtualModel(pool.localId ?? pool.id)).map((model) => ({ model, backendId: undefined as string | undefined }));
    for (const t of targets) {
      const backendId = t.backendId ?? pool.endpoint?.backendId;
      const proxy = backends.find((b) => b.id === backendId);
      const upstreams = proxy ? usage[proxy.id]?.upstreams?.[stripPrefix(backendPrefix(proxy), t.model)] : undefined;
      const upstream = upstreams ? upstreamQuota(upstreams, backends, usage, proxy ? usage[proxy.id]?.upstreamRequests : undefined, now, proxy ? usage[proxy.id]?.upstreamLimits : undefined, proxy ? usage[proxy.id]?.upstreamPrepaid : undefined) : undefined;
      if (upstream?.exhausted && upstream.meter) {
        current[`${pool.companyId}|${t.model}`] = { until: upstream.meter.resetAt, reason: `${upstream.meter.label} used up` };
        continue;
      }
      const empty = (backendId ? usage[backendId]?.meters : undefined)?.filter((m) => m.limit !== undefined && (m.remaining ?? m.limit - (m.used ?? 0)) <= 0) ?? [];
      const kind = t.model.endsWith(":free") ? "free" : "paid";
      const m = empty.find((e) => !e.appliesTo || e.appliesTo === kind);
      if (m) current[`${pool.companyId}|${t.model}`] = { until: m.resetAt, reason: `${m.label} used up` };
    }
  }
  // A subscription pool pauses while every account of its provider has a window at 100 % (read with the board token).
  // A pool on both subscriptions pauses each model with its own provider.
  for (const pool of pools.filter((p) => p.kind === "quota" && p.companyId && p.subscription && !p.allowOverQuota)) {
    const windows = (await store.subscriptionWindows(pool.companyId!).get()) ?? undefined;
    for (const t of pool.placement ?? []) {
      const provider = pool.subscription === "both" ? modelProvider(t.model) : pool.subscription;
      const used = provider ? subscriptionExhausted(windows, provider, now) : undefined;
      const key = `${pool.companyId}|${t.model}`;
      if (used && !current[key]) current[key] = used;
    }
  }
  // A model at its pool's daily run cap waits for midnight UTC.
  const today = now.toISOString().slice(0, 10);
  for (const pool of pools.filter((p) => p.kind === "quota" && p.companyId && p.dailyRunCap)) {
    const tally = await store.runCounts(pool.companyId!).get();
    if (tally.day !== today) continue;
    for (const t of pool.placement ?? []) {
      const key = `${pool.companyId}|${t.model}`;
      const n = tally.counts[t.model] ?? 0;
      if (!current[key] && n >= pool.dailyRunCap!) current[key] = { until: nextMidnightUtc(now), reason: `${n} runs today (cap ${pool.dailyRunCap})` };
    }
  }
  const recent = new Map<string, number[]>();
  // A failure that names its reset (a daily limit, a reset time) pauses the model until then on its own.
  const named = new Map<string, string>();
  for (const f of failures ?? []) {
    if (!f.error || !RATE_LIMITED.test(f.error)) continue;
    const agent = agentsByCompany.get(f.company_id)?.get(f.agent_id);
    if (!agent) continue;
    const issue = f.issue_id ? issuesById.get(f.issue_id) : undefined;
    const model = issue ? effectiveModel(issue, agent) : agentModel(agent);
    const at = f.finished_at ? Date.parse(new Date(f.finished_at).toISOString()) : NaN;
    if (!model || Number.isNaN(at)) continue;
    const key = `${f.company_id}|${model}`;
    const reset = resetFromError(f.error, new Date(at));
    if (reset && Date.parse(reset) > now.getTime() && (!named.has(key) || reset > named.get(key)!)) named.set(key, reset);
    if (now.getTime() - at > RATE_LIMIT_WINDOW_MS) continue;
    recent.set(key, [...(recent.get(key) ?? []), at]);
  }
  for (const [key, until] of named) {
    if (!current[key]) current[key] = { until, reason: `rate-limited until ${until}` };
  }
  for (const [key, times] of recent) {
    if (times.length < RATE_LIMIT_FAILURES || current[key]) continue;
    current[key] = { until: new Date(Math.max(...times) + RATE_LIMIT_WINDOW_MS).toISOString(), reason: `${times.length} rate-limit failures` };
  }
  const before = await store.exhausted.get();
  // A named reset outlasts the 30 minutes of failures read each cycle, so it's kept until its time.
  for (const [key, e] of Object.entries(before)) {
    if (!current[key] && e.until && Date.parse(e.until) > now.getTime() && /^rate-limited until/.test(e.reason)) current[key] = { until: e.until, reason: e.reason };
  }
  const next: Record<string, ExhaustedModel> = Object.fromEntries(Object.entries(current).map(([key, v]) => [key, { since: before[key]?.since ?? now.toISOString(), ...v }]));
  if (JSON.stringify(next) !== JSON.stringify(before)) await store.exhausted.set(next);
  return next;
};

export const buildSnapshot = async ({ ctx, store, agents, readRuns, readFailures = dbFailureReader(ctx), listCompanies, backendsFor, blockers = createBlockerCache(ctx), now = new Date() }: SnapshotDeps): Promise<Snapshot> => {
  const [hosts, holds, released, overrides, exemptions] = await Promise.all([
    store.hosts.get(), store.holds.get(), store.released.get(), store.overrides.get(), store.exemptions.get(),
  ]);
  const known = listCompanies ? await listCompanies() : await pageAll((offset) => ctx.companies.list({ limit: PAGE_SIZE, offset }));
  const pools = await loadScopedPools(store, known.map((c) => c.id), backendsFor);
  const heldPools = await loadHeldPoolKeys(store, known.map((c) => c.id));
  // A company with no pools has nothing to limit, so its tasks and agents aren't read at all.
  const companies = known.filter((c) => pools.some((p) => p.companyId === c.id));
  const exemptIssues = new Set(exemptions.issueIds);
  const issuesById = new Map<string, Issue>();
  const agentsByCompany = new Map<string, Map<string, Agent>>();
  const skippedCompanies: string[] = [];
  for (const company of companies) {
    try {
      const companyAgents = await agents.get(company.id);
      const companyIssues: Issue[] = [];
      for (const status of OPEN_TASK_STATUSES) {
        companyIssues.push(...(await pageAll((offset) => ctx.issues.list({ companyId: company.id, status, limit: PAGE_SIZE, offset }))));
      }
      agentsByCompany.set(company.id, companyAgents);
      for (const issue of companyIssues) issuesById.set(issue.id, issue);
    } catch (e) {
      if (!isScopeDenied(e)) throw e;
      // The plugin only acts on companies that have its config saved; others are left out, not an error.
      skippedCompanies.push(company.id);
    }
  }
  if (skippedCompanies.length) ctx.logger.debug("Model capacity skipped companies without plugin config", { companies: skippedCompanies });

  // A task or run only ever counts against its own company's pools.
  const poolOf = (companyId: string, model: string | undefined, issueId?: string): PoolConfig | undefined => {
    // A task the plugin placed stays in the pool that placed it while it's on that model, even when another pool lists
    // the same model (a pool across subscriptions listing Haiku, next to a Haiku-only pool).
    const record = issueId ? overrides[issueId] : undefined;
    const placedBy = record && record.model === model ? pools.find((p) => p.id === record.toPoolId && p.companyId === companyId) : undefined;
    return placedBy ?? matchPool(model, pools.filter((p) => p.companyId === companyId));
  };
  const dbRows = await readRuns();
  const rows = dbRows ?? activeRunRows([...issuesById.values()]);
  const runs: RunningRun[] = [];
  for (const row of rows) {
    if (!ACTIVE.has(row.status)) continue;
    const agent = agentsByCompany.get(row.company_id)?.get(row.agent_id);
    if (!agent) continue;
    const issue = row.issue_id ? issuesById.get(row.issue_id) : undefined;
    // A run with no open task (a timer heartbeat, or a task closed mid-run) still uses the agent's own model.
    const model = issue ? effectiveModel(issue, agent) : agentModel(agent);
    runs.push({
      runId: row.id, issueId: row.issue_id ?? "", agentId: row.agent_id, companyId: row.company_id,
      poolId: poolOf(row.company_id, model, issue?.id)?.id, model, status: row.status as RunningRun["status"], startedAt: toIso(row.started_at), queuedAt: toIso(row.created_at),
      agentName: agent.name, issueIdentifier: issue?.identifier ?? undefined, issueTitle: issue?.title ?? undefined,
      ...(issue?.description ? { issueDescription: issue.description.slice(0, RUN_DESCRIPTION_CHARS) } : {}),
    });
  }

  // Paperclip runs one run per agent at a time (by default), so a queued run whose agent is already running waits for
  // the agent, not for the engine.
  // An idle agent starts only its oldest queued run next, so its later queued runs wait for the agent too.
  const busyAgents = new Set(runs.filter((r) => r.status === "running").map((r) => `${r.companyId}:${r.agentId}`));
  const byQueuedAt = (a: RunningRun, b: RunningRun) => (a.queuedAt ?? "").localeCompare(b.queuedAt ?? "");
  for (const run of runs.filter((r) => r.status === "queued").sort(byQueuedAt)) {
    const agentKey = `${run.companyId}:${run.agentId}`;
    if (busyAgents.has(agentKey)) run.waitingOnAgent = true;
    else if (run.queuedAt && now.getTime() - Date.parse(run.queuedAt) > STALLED_QUEUED_MS) run.stalled = true;
    else busyAgents.add(agentKey);
  }

  const runIssues = new Set(runs.map((r) => r.issueId).filter(Boolean));
  const tasks: OpenTask[] = [];
  const queueBlockerIds = new Map<string, Set<string>>();
  for (const issue of issuesById.values()) {
    const agent = issue.assigneeAgentId ? agentsByCompany.get(issue.companyId)?.get(issue.assigneeAgentId) : undefined;
    // A paused or stopped agent can't be woken, so its tasks neither queue nor take a slot: holding them would only
    // release, fail to start and hold again every cycle.
    if (!agent || NOT_RUNNABLE_AGENT.has(String(agent.status))) continue;
    const model = effectiveModel(issue, agent);
    const pool = poolOf(issue.companyId, model, issue.id);
    if (!pool) continue;
    // A task waiting on its own unfinished blockers can't run, so it neither queues nor takes a slot. Our queue blocker
    // doesn't count.
    if (issue.status === "blocked") {
      if (!queueBlockerIds.has(issue.companyId)) queueBlockerIds.set(issue.companyId, new Set(Object.values(await store.queueBlockers(issue.companyId).get())));
      const own = await blockers.unresolved(issue.id, issue.companyId).catch(() => []);
      if (own.some((id) => !queueBlockerIds.get(issue.companyId)?.has(id))) continue;
    }
    tasks.push({
      issueId: issue.id, companyId: issue.companyId, agentId: agent.id, poolId: pool.id, priority: toPriority(issue.priority),
      status: issue.status, hasActiveRun: runIssues.has(issue.id), exempt: exemptIssues.has(issue.id), pinned: isPinned(issue, overrides),
      model, adapterType: agent.adapterType, agentModel: agentModel(agent), ...(issue.parentId ? { parentId: issue.parentId } : {}),
      ...(issue.originKind === "routine_execution" && issue.originId ? { routineKey: `${issue.originId}|${issue.originFingerprint ?? ""}` } : {}),
      ...(issue.createdAt ? { createdAt: new Date(issue.createdAt).toISOString() } : {}),
    });
  }

  return {
    now: now.toISOString(), pools, hosts, runs, tasks, holds: Object.values(holds), released: Object.values(released),
    wakeCooldown: Object.fromEntries(Object.entries(await store.wakeCooldown.get()).filter(([, until]) => Date.parse(until) > now.getTime())),
    // A parked task rejoins the queue once it runs, closes, or has been parked a day.
    parked: Object.fromEntries(Object.entries(await store.parked.get()).filter(([id, p]) =>
      now.getTime() - Date.parse(p.since) < PARK_EXPIRY_MS && tasks.some((t) => t.issueId === id && !t.hasActiveRun))),
    heldPools, exemptAgentIds: exemptions.agentIds,
    poolAgents: poolAgentsOf(pools, agentsByCompany),
    subscriptionLeft: await subscriptionLeftOf(store, pools, now),
    // Placements are the plugin's own overrides within one pool (overflow ones move a task between pools).
    placements: Object.fromEntries(Object.values(overrides).filter((o) => o.fromPoolId === o.toPoolId).map((o) => [o.issueId, o.model])),
    // Failures are only read when a quota pool can use them.
    exhausted: await exhaustedModels({
      store, pools, backendsFor, failures: pools.some((p) => p.kind === "quota") ? await readFailures().catch(() => undefined) : undefined, issuesById, agentsByCompany, now,
    }),
    diagnostics: {
      runSource: dbRows ? "heartbeat_runs" : "activeRun", activeRunRows: rows.filter((r) => ACTIVE.has(r.status)).length,
      unmatchedRunModels: [...new Set(runs.filter((r) => !r.poolId).map((r) => r.model ?? "(none)"))].slice(0, 20),
      runsWithoutAgent: rows.filter((r) => ACTIVE.has(r.status) && !agentsByCompany.get(r.company_id)?.get(r.agent_id)).length,
      skippedCompanies,
    },
  };
};
