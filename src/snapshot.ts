import type { Agent, Issue, PluginContext } from "@paperclipai/plugin-sdk";

import { AGENT_CACHE_TTL_MS, OPEN_TASK_STATUSES, PRIORITY_RANK } from "./constants.js";
import { matchPool } from "./scheduler/match.js";
import { agentModel, effectiveModel, isPinned } from "./scheduler/model.js";
import type { Store } from "./state/store.js";
import type { OpenTask, PoolConfig, RunningRun, Snapshot, TaskPriority } from "./types.js";

export const PAGE_SIZE = 200;

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

export interface SnapshotDeps {
  ctx: PluginContext;
  store: Store;
  agents: AgentCache;
  readRuns: RunReader;
  now?: Date;
}

export const buildSnapshot = async ({ ctx, store, agents, readRuns, now = new Date() }: SnapshotDeps): Promise<Snapshot> => {
  const [pools, hosts, holds, released, overrides, heldPools, exemptions] = await Promise.all([
    store.pools.get(), store.hosts.get(), store.holds.get(), store.released.get(), store.overrides.get(), store.heldPools.get(), store.exemptions.get(),
  ]);
  const companies = await pageAll((offset) => ctx.companies.list({ limit: PAGE_SIZE, offset }));
  const exemptIssues = new Set(exemptions.issueIds);
  const issuesById = new Map<string, Issue>();
  const agentsByCompany = new Map<string, Map<string, Agent>>();
  for (const company of companies) {
    agentsByCompany.set(company.id, await agents.get(company.id));
    for (const status of OPEN_TASK_STATUSES) {
      const page = await pageAll((offset) => ctx.issues.list({ companyId: company.id, status, limit: PAGE_SIZE, offset }));
      for (const issue of page) issuesById.set(issue.id, issue);
    }
  }

  const poolOf = (model: string | undefined): PoolConfig | undefined => matchPool(model, pools);
  const rows = (await readRuns()) ?? activeRunRows([...issuesById.values()]);
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
      poolId: poolOf(model)?.id, model, status: row.status as RunningRun["status"], startedAt: toIso(row.started_at),
    });
  }

  const runIssues = new Set(runs.map((r) => r.issueId).filter(Boolean));
  const tasks: OpenTask[] = [];
  for (const issue of issuesById.values()) {
    const agent = issue.assigneeAgentId ? agentsByCompany.get(issue.companyId)?.get(issue.assigneeAgentId) : undefined;
    if (!agent) continue;
    const pool = poolOf(effectiveModel(issue, agent));
    if (!pool) continue;
    tasks.push({
      issueId: issue.id, companyId: issue.companyId, agentId: agent.id, poolId: pool.id, priority: toPriority(issue.priority),
      status: issue.status, hasActiveRun: runIssues.has(issue.id), exempt: exemptIssues.has(issue.id), pinned: isPinned(issue, overrides),
    });
  }

  return {
    now: now.toISOString(), pools, hosts, runs, tasks, holds: Object.values(holds), released: Object.values(released),
    heldPools, exemptAgentIds: exemptions.agentIds,
  };
};
