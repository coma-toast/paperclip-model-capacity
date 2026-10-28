import type { HeldTask, HostConfig, OpenTask, PoolConfig, ReleasedTask, RunningRun, Snapshot } from "../../src/types.js";

export const NOW = "2026-10-28T12:00:00.000Z";
export const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

export const host = (id: string, over: Partial<HostConfig> = {}): HostConfig => ({
  id, name: id, engine: "llamacpp", baseUrl: `http://${id}:8080`, declaredSlots: 1, ...over,
});

export const pool = (id: string, over: Partial<PoolConfig> = {}): PoolConfig => ({
  id, name: id, patterns: [`${id}/*`], limit: 1, privacy: "shared", mode: "enforce", scope: "instance",
  hosts: [], alertAfterMinutes: 30, ...over,
});

export const task = (issueId: string, over: Partial<OpenTask> = {}): OpenTask => ({
  issueId, companyId: "c1", agentId: "a1", poolId: "gpu", priority: "medium", status: "todo",
  hasActiveRun: false, exempt: false, pinned: false, ...over,
});

export const run = (issueId: string, over: Partial<RunningRun> = {}): RunningRun => ({
  runId: `run-${issueId}`, issueId, agentId: "a1", companyId: "c1", poolId: "gpu", status: "running", ...over,
});

export const hold = (issueId: string, over: Partial<HeldTask> = {}): HeldTask => ({
  issueId, companyId: "c1", poolId: "gpu", priority: "medium", heldAt: minutesAgo(5), ...over,
});

export const released = (issueId: string, over: Partial<ReleasedTask> = {}): ReleasedTask => ({
  issueId, companyId: "c1", poolId: "gpu", releasedAt: minutesAgo(0), ...over,
});

// A held task is also an open task with no run, so list it in both places.
export const heldTask = (issueId: string, over: Partial<HeldTask> = {}) => ({
  hold: hold(issueId, over),
  task: task(issueId, { status: "blocked", priority: over.priority ?? "medium", companyId: over.companyId ?? "c1", poolId: over.poolId ?? "gpu" }),
});

export const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW, pools: [pool("gpu")], hosts: {}, runs: [], tasks: [], holds: [], released: [], heldPools: [], ...over,
});

export const upHost = (hostId: string, slotsTotal?: number, slotsBusy?: number) => ({
  hostId, up: true, consecutiveFailures: 0, consecutiveSuccesses: 2, slotsTotal, slotsBusy,
});

export const downHost = (hostId: string) => ({ hostId, up: false, consecutiveFailures: 3, consecutiveSuccesses: 0 });
