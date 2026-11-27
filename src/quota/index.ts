// The quota module (P3.1): one number from one source, `{ source, value, resetAt?, sampledAt }` (E6), fed to the
// scheduler in P3.2 and the quota UI in P3.3. Four sources, all read-only and adding no load beyond what the plan allows:
//   litellm   — pool members and their recorded quota, plus the 429s in its failure log (admin key, secret ref)
//   openrouter— key remaining, used today, free-tier flag (GET /api/v1/key)
//   paperclip — failed runs matching quota patterns, per model, over 1 h and 24 h (host data, via a reader)
//   headers   — provider rate limits from `x-ratelimit-*`, on an opt-in minimal probe (off by default)
export type { QuotaSample, QuotaContext } from "./types.js";
export { num } from "./types.js";
export { readLiteLlmQuota } from "./litellm.js";
export { readOpenRouterQuota } from "./openrouter.js";
export { readPaperclipQuota, DEFAULT_QUOTA_ERROR_PATTERNS, type QuotaFailureRow, type QuotaFailureReader, type PaperclipQuotaOptions } from "./paperclip.js";
export { probeQuotaHeaders, HEADER_PROBE_INTERVAL_MS, type HeaderProbeTarget, type HeaderProbeOptions } from "./headers.js";
