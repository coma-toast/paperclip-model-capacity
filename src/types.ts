import type { Issue } from "@paperclipai/plugin-sdk";

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
  // Path in company config holding the secret ref for the host's auth header (A5); never the value.
  authSecretPath?: string;
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
  patterns: string[];
  limit: number;
  privacy: PoolPrivacy;
  mode: PoolMode;
  scope: PoolScope;
  companies?: CompanyFilter;
  hosts: HostConfig[];
  overflow?: OverflowConfig;
  // Model a task gets when it overflows into this pool (D2).
  overflowModel?: string;
  alertAfterMinutes: number;
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
}

// A task the plugin released whose run hasn't started yet; it still counts against the pool (B2).
export interface ReleasedTask {
  issueId: string;
  companyId: string;
  poolId: string;
  runId?: string;
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
  // Agents an operator exempted (F4): their tasks never wait but still count (B5). Task exemptions are on OpenTask.
  exemptAgentIds?: string[];
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

export type Action =
  | { kind: "hold"; issueId: string; companyId: string; poolId: string; position: number }
  | { kind: "release"; issueId: string; companyId: string; poolId: string; reason: "capacity" | "manual" }
  | { kind: "overflow"; issueId: string; companyId: string; fromPoolId: string; toPoolId: string; model: string; reason: OverflowReason }
  | { kind: "restore"; issueId: string; companyId: string; original: IssueAssigneeAdapterOverrides | null }
  | { kind: "alert"; alert: AlertEvent };
