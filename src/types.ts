import type { Issue } from "@paperclipai/plugin-sdk";

import type { ApiKind } from "./apis.js";

// The SDK doesn't re-export the shared type, and the shared package isn't a direct dependency.
export type IssueAssigneeAdapterOverrides = NonNullable<Issue["assigneeAdapterOverrides"]>;

export type PoolPrivacy = "private" | "shared";
export type PoolMode = "observe" | "enforce";
export type PoolScope = "instance" | "company";
export type EngineKind = "llamacpp" | "ollama" | "openai" | "vllm" | "lmstudio";
export type TaskPriority = "critical" | "high" | "medium" | "low";
export type OverflowReason = "waited" | "hostsDown" | "immediate";

export interface HostConfig {
  id: string;
  name: string;
  engine: EngineKind;
  baseUrl: string;
  declaredSlots: number;
  // The backend whose key is sent with health checks (backends.ts).
  backendId?: string;
}

// Where a pool's API lives, taken from its backend: used by Load models, and for a local engine also health-checked.
export interface PoolEndpoint {
  baseUrl?: string;
  backendId?: string;
  slots?: number;
}

export interface OverflowConfig {
  // Ordered target pool ids (A8).
  pools: string[];
  afterMinutes?: number;
  whenHostsDown?: boolean;
  immediately?: boolean;
}

export interface CompanyFilter {
  include?: string[];
  exclude?: string[];
}

export interface PoolConfig {
  id: string;
  name: string;
  // The backend (backends.ts) this pool's models go through; its type, prefix, address and key apply to the pool.
  backend?: string;
  // Proxy pools: local-engine backends behind the proxy whose health and load the pool also watches.
  watch?: string[];
  // Derived from the backend when the scheduler loads pools (pools.ts); older pools may still carry them.
  api?: ApiKind;
  prefix?: string;
  endpoint?: PoolEndpoint;
  patterns: string[];
  limit: number;
  // The limit follows the pool's engines (its backend if that's a local engine, plus the ones it watches): their slots
  // as reported, or as set on the backend. `limit` then shows the backends' total.
  limitFromEngines?: boolean;
  // Disabled (e.g. before shutting an engine down): nothing new is released and new work waits, while runs already
  // going finish. Unlike an operator hold, it's part of the saved settings.
  disabled?: boolean;
  // Keep each task on one engine for its prompt cache (P2.6). Each entry is a model that reaches exactly one engine
  // (a backend id); the order is the preference. Pool models not listed are entry models: a task on one is placed
  // (its model override set) on the first listed engine with room, and stays there; its subtasks follow it.
  sticky?: StickyTarget[];
  // A plugin-placed task whose engine has been down this long may move to another engine (default 30).
  reassignAfterMinutes?: number;
  // Derived from sticky with the engines' scoped host ids (not saved).
  placement?: { model: string; hostId: string }[];
  privacy: PoolPrivacy;
  mode: PoolMode;
  scope: PoolScope;
  companies?: CompanyFilter;
  hosts: HostConfig[];
  overflow?: OverflowConfig;
  // Model a task gets when it overflows into this pool (D2).
  overflowModel?: string;
  alertAfterMinutes: number;
  // Set by the plugin on the scheduler's copy: the owning company and the pool's id within it (see pools.ts).
  companyId?: string;
  localId?: string;
}

export interface HostStatus {
  hostId: string;
  up: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  slotsTotal?: number;
  slotsBusy?: number;
  lastProbeAt?: string;
  lastChangeAt?: string;
  error?: string;
}

export interface StickyTarget {
  model: string;
  engine: string;
}

export interface HeldTask {
  issueId: string;
  companyId: string;
  poolId: string;
  priority: TaskPriority;
  heldAt: string;
  position?: number;
  blockerId?: string;
}

export interface RunningRun {
  runId: string;
  issueId: string;
  agentId: string;
  companyId: string;
  poolId?: string;
  model?: string;
  status: "queued" | "running";
  startedAt?: string;
  // When the run was created (queued).
  queuedAt?: string;
  // Queued behind its own agent's running run: it waits for the agent, not for a model slot, so it doesn't count
  // against the pool (its task still counts as having a run, so it isn't held twice).
  waitingOnAgent?: boolean;
  // Queued over STALLED_QUEUED_MS with its agent idle: Paperclip isn't starting it, so it holds no slot either.
  stalled?: boolean;
  // For display only.
  agentName?: string;
  issueIdentifier?: string;
}

// A task the plugin released whose run hasn't started yet; it still counts against the pool (B2).
export interface ReleasedTask {
  issueId: string;
  companyId: string;
  poolId: string;
  runId?: string;
  // Sticky pools: the model (engine) it was released onto, so it counts against that engine until its run starts.
  model?: string;
  releasedAt: string;
  // The wake is retried once if no run shows up (C3).
  wakeRetried?: boolean;
}

export interface OpenTask {
  issueId: string;
  companyId: string;
  agentId: string;
  poolId: string;
  priority: TaskPriority;
  status: string;
  hasActiveRun: boolean;
  exempt: boolean;
  pinned: boolean;
  // The model a run would use now (the task's override, else its agent's model), and the parent task.
  model?: string;
  parentId?: string;
}

// An override the plugin wrote during overflow, kept so it can be restored exactly (D3) and told apart from a pin (D4).
export interface OverrideRecord {
  issueId: string;
  agentId: string;
  model: string;
  original: IssueAssigneeAdapterOverrides | null;
  fromPoolId: string;
  toPoolId: string;
  at: string;
}

export interface Snapshot {
  now: string;
  pools: PoolConfig[];
  hosts: Record<string, HostStatus>;
  runs: RunningRun[];
  tasks: OpenTask[];
  holds: HeldTask[];
  released: ReleasedTask[];
  // Pools an operator put on hold (F2): nothing new is released.
  heldPools: string[];
  // Models the plugin placed tasks on (sticky pools), by issue id, so subtasks of a closed parent still follow it.
  placements?: Record<string, string>;
  // Agents an operator exempted (F4): their tasks never wait but still count (B5). Task exemptions are on OpenTask.
  exemptAgentIds?: string[];
  // How the snapshot was built, for the operator (not used by decide()).
  diagnostics?: SnapshotDiagnostics;
}

export interface SnapshotDiagnostics {
  runSource: "heartbeat_runs" | "activeRun";
  activeRunRows: number;
  unmatchedRunModels: string[];
  runsWithoutAgent: number;
  skippedCompanies: string[];
}

export type AlertKind =
  | "hostDown"
  | "hostUp"
  | "waitedTooLong"
  | "overLimit"
  | "overrideRestoreFailed"
  | "quotaExhausted"
  | "pluginError";

export interface AlertEvent {
  kind: AlertKind;
  // Dedupe key together with kind (G3), e.g. a host id or an issue id.
  subject: string;
  state: "start" | "clear";
  message: string;
  at: string;
  poolId?: string;
  companyId?: string;
}

// Why a task was put on an engine: first placement, its parent's engine, or its own engine was down too long.
export type PlaceReason = "new" | "parent" | "engineDown";

export type Action =
  | { kind: "hold"; issueId: string; companyId: string; poolId: string; position: number }
  | { kind: "release"; issueId: string; companyId: string; poolId: string; reason: "capacity" | "manual"; model?: string }
  | { kind: "place"; issueId: string; companyId: string; poolId: string; model: string; reason: PlaceReason }
  | { kind: "overflow"; issueId: string; companyId: string; fromPoolId: string; toPoolId: string; model: string; reason: OverflowReason }
  | { kind: "restore"; issueId: string; companyId: string; original: IssueAssigneeAdapterOverrides | null }
  | { kind: "alert"; alert: AlertEvent };

// Whether a run takes one of its pool's model slots.
export const occupiesSlot = (run: Pick<RunningRun, "waitingOnAgent" | "stalled">) => !run.waitingOnAgent && !run.stalled;
