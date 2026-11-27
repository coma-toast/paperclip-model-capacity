import { type FetchFn } from "../probes/http.js";

// One quota reading from one source (E6). `value` is what the source reports about a limit — how much is left, how much
// was used, or how many times it was hit — and which one it is is carried by the last segment of `source`, so a number
// never has to be guessed. An exhausted source reports value 0; the reader keys off the source string, not the unit.
export interface QuotaSample {
  source: string;
  value: number;
  // When the count restarts, as an ISO timestamp, when the source says so. Absent when it doesn't reset or doesn't say.
  resetAt?: string;
  sampledAt: string;
}

// A read against a backend's quota API. Reuses the probe context shape so the same resolved fetch and secret-ref headers
// serve both, and nothing sensitive is ever put in the sample itself.
export interface QuotaContext {
  baseUrl: string;
  fetch: FetchFn;
  // Authorization (and any other header) resolved from a company secret ref by the worker.
  headers?: Record<string, string>;
  now?: () => Date;
  timeoutMs?: number;
}

// A number from a field that may be a number or a numeric string (HTTP headers are always strings).
export const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

export const stamp = (ctx: QuotaContext) => (ctx.now?.() ?? new Date()).toISOString();
