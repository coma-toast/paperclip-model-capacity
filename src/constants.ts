import type { TaskPriority } from "./types.js";

export const STATE_SCHEMA_VERSION = 1;

export const DEFAULT_PROBE_INTERVAL_MS = 30_000;
export const PROBE_TIMEOUT_MS = 5_000;
// Spend and credit endpoints change slowly; local slots are also probed every DEFAULT_PROBE_INTERVAL_MS for gating.
export const DEFAULT_USAGE_INTERVAL_MS = 120_000;
export const HOST_DOWN_AFTER_FAILURES = 3;
export const HOST_UP_AFTER_SUCCESSES = 2;

export const SWEEP_CRON = "* * * * *";
export const PRUNE_CRON = "0 4 * * *";
export const WAKE_CONFIRM_MS = 30_000;
// A released task whose run never appears stops counting against the pool after this long.
export const RELEASE_EXPIRY_MS = 5 * 60_000;
export const RUN_EVENT_DEBOUNCE_MS = 2_000;
export const AGENT_CACHE_TTL_MS = 60_000;
export const HISTORY_RETENTION_DAYS = 30;
export const HISTORY_MAX_PER_DAY = 1_000;
export const RECENT_ALERTS_MAX = 200;

export const DEFAULT_ALERT_AFTER_MINUTES = 30;

// Statuses a task can be held in (C1); anything else is closed or not runnable.
export const OPEN_TASK_STATUSES = ["todo", "in_progress", "blocked", "in_review"] as const;

// Lower rank releases first (C2).
export const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = { critical: 0, high: 1, medium: 2, low: 3 };
