import type { Agent, Company, Issue, PluginContext } from "@paperclipai/plugin-sdk";

import { AGENT_CACHE_TTL_MS, OPEN_TASK_STATUSES, PRIORITY_RANK } from "./constants.js";
import { loadHeldPoolKeys, loadScopedPools } from "./pools.js";
import { matchPool } from "./scheduler/match.js";
import { agentModel, effectiveModel, isPinned } from "./scheduler/model.js";
import type { Store } from "./state/store.js";
import type { OpenTask, PoolConfig, RunningRun, Snapshot, TaskPriority } from "./types.js";

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
}

// Returns undefined when the core table can't be read, so the builder falls back to Issue.activeRun.
export type RunReader = () => Promise<RunRow[] | undefined>;

// Needs `database.coreReadTables: ["heartbeat_runs"]` (spike check 4). Older runs keep the issue only in context_snapshot.
export const RUNS_SQL =
  "SELECT id, company_id, agent_id, COALESCE(issue_id::text, context_snapshot->>'issueId') AS issue_id, status, started_at " +
  "FROM public.heartbeat_runs WHERE status IN ('queued', 'running')";

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

// A company the host refused is not asked about again for this long, so the host log doesn't fill with denials.
export const DENIED_COMPANY_BACKOFF_MS = 10 * 60_000;

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
        const list = await pageAll((offset) => ctx.companies.list({ limit: PAGE_SIZE, offset }));
        await store.companies.set(list.map((c) => ({ id: c.id, name: c.name })));
      } catch (e) {
        ctx.logger.warn("companies.list failed inside an event; keeping the saved list", { error: e instanceof Error ? e.message : String(e) });
      }
    },
    list: async () => ((await store.companies.get()) as unknown as Company[]).filter((c) => (deniedUntil.get(c.id) ?? 0) <= clock()),
    markDenied: (companyIds: string[]) => {
      for (const id of companyIds) deniedUntil.set(id, clock() + DENIED_COMPANY_BACKOFF_MS);
    },
  };
};

export interface SnapshotDeps {
  ctx: PluginContext;
  store: Store;
  agents: AgentCache;
  readRuns: RunReader;
  listCompanies?: () => Promise<Company[]>;
  now?: Date;
}

export const buildSnapshot = async ({ ctx, store, agents, readRuns, listCompanies, now = new Date() }: SnapshotDeps): Promise<Snapshot> => {
  const [hosts, holds, released, overrides, exemptions] = await Promise.all([
    store.hosts.get(), store.holds.get(), store.released.get(), store.overrides.get(), store.exemptions.get(),
  ]);
  const known = listCompanies ? await listCompanies() : await pageAll((offset) => ctx.companies.list({ limit: PAGE_SIZE, offset }));
  const pools = await loadScopedPools(store, known.map((c) => c.id));
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
  const poolOf = (companyId: string, model: string | undefined): PoolConfig | undefined =>
    matchPool(model, pools.filter((p) => p.companyId === companyId));
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
      poolId: poolOf(row.company_id, model)?.id, model, status: row.status as RunningRun["status"], startedAt: toIso(row.started_at),
      agentName: agent.name, issueIdentifier: issue?.identifier ?? undefined,
    });
  }

  const runIssues = new Set(runs.map((r) => r.issueId).filter(Boolean));
  const tasks: OpenTask[] = [];
  for (const issue of issuesById.values()) {
    const agent = issue.assigneeAgentId ? agentsByCompany.get(issue.companyId)?.get(issue.assigneeAgentId) : undefined;
    if (!agent) continue;
    const pool = poolOf(issue.companyId, effectiveModel(issue, agent));
    if (!pool) continue;
    tasks.push({
      issueId: issue.id, companyId: issue.companyId, agentId: agent.id, poolId: pool.id, priority: toPriority(issue.priority),
      status: issue.status, hasActiveRun: runIssues.has(issue.id), exempt: exemptIssues.has(issue.id), pinned: isPinned(issue, overrides),
    });
  }

  return {
    now: now.toISOString(), pools, hosts, runs, tasks, holds: Object.values(holds), released: Object.values(released),
    heldPools, exemptAgentIds: exemptions.agentIds,
    diagnostics: {
      runSource: dbRows ? "heartbeat_runs" : "activeRun", activeRunRows: rows.filter((r) => ACTIVE.has(r.status)).length,
      unmatchedRunModels: [...new Set(runs.filter((r) => !r.poolId).map((r) => r.model ?? "(none)"))].slice(0, 20),
      runsWithoutAgent: rows.filter((r) => ACTIVE.has(r.status) && !agentsByCompany.get(r.company_id)?.get(r.agent_id)).length,
      skippedCompanies,
    },
  };
};
