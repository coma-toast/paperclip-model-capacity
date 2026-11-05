import { apiInfo } from "./apis.js";
import type { Backend } from "./backends.js";
import { backendHostId, poolKey } from "./pools.js";
import type { PoolConfig, RunningRun, Snapshot } from "./types.js";

// A run on a draining engine (taken out of its pool, or capped at 0) gets this long to finish before the plugin moves
// its task to another engine.
export const DRAIN_GRACE_MS = 30 * 60_000;

// The models that reach one engine: its reach model and the aliases routed only to it.
export const engineModels = (snapshot: Snapshot, companyId: string, b: Backend) => {
  const hostId = poolKey(companyId, backendHostId(b.id));
  const models = new Set(snapshot.pools.flatMap((p) => (p.placement ?? []).filter((t) => t.hostId === hostId).flatMap((t) => [t.model, ...(t.aliases ?? [])])));
  if (b.reachModel) models.add(b.reachModel);
  return models;
};

// A local engine takes no new work when no enabled engine pool has it, or every one that does caps it at 0.
export const isDraining = (b: Backend, pools: PoolConfig[]) =>
  apiInfo(b.type).group === "local" &&
  pools.filter((p) => p.kind === "engine" && !p.disabled).flatMap((p) => p.engines ?? []).filter((e) => e.engine === b.id).every((e) => e.cap === 0);

export interface DrainingRun {
  run: RunningRun;
  engine: Backend;
  // When the plugin moves it; absent when it can't (the plugin didn't put the task there).
  moveAt?: string;
}

// Runs on a company's draining engines. Only a task the plugin placed there can move: one whose agent or a person set
// that model would just come back to it.
export const drainingRuns = (snapshot: Snapshot, companyId: string, backends: Backend[], pools: PoolConfig[], since: Record<string, string>): DrainingRun[] =>
  backends.filter((b) => isDraining(b, pools)).flatMap((b) => {
    const models = engineModels(snapshot, companyId, b);
    return snapshot.runs
      .filter((r) => r.companyId === companyId && r.model !== undefined && models.has(r.model))
      .map((run) => {
        const placed = snapshot.placements?.[run.issueId] === run.model;
        const first = since[run.runId] ?? snapshot.now;
        return { run, engine: b, ...(placed ? { moveAt: new Date(Date.parse(first) + DRAIN_GRACE_MS).toISOString() } : {}) };
      });
  });

// Keeps the first time each run was seen draining (dropping runs that finished or whose engine is back), and picks
// the runs to move now: those past the grace period, and those a board user asked to move.
export const drainStep = (draining: DrainingRun[], since: Record<string, string>, force: Record<string, unknown>, now: Date) => {
  const nextSince = Object.fromEntries(draining.map((d) => [d.run.runId, since[d.run.runId] ?? now.toISOString()]));
  const move = draining.filter((d) => d.moveAt && (force[d.run.runId] || Date.parse(d.moveAt) <= now.getTime()));
  return { since: nextSince, move };
};
