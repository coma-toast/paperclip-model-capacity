import { PROBE_TIMEOUT_MS } from "../constants.js";
import { type FetchFn, ProbeError } from "../probes/http.js";
import type { QuotaSample } from "./types.js";
import { num } from "./types.js";

// Provider header probes (E4): opt-in per provider, off by default. A provider publishes its live rate limit in
// `x-ratelimit-*` response headers, which only a real call returns. The smallest request the provider accepts is used
// (max_tokens:1, a fixed "ping") and it never carries task content (E7). N1 and AC10: off unless opted in, so with the
// flag unset no request leaves the plugin.

export const HEADER_PROBE_INTERVAL_MS = 15 * 60_000;
const PING_PROMPT = "ping";
const DEFAULT_PATH = "/chat/completions";

// A provider to probe: where to call, the model to name, and the key's headers. Opted in by the caller listing it.
export interface HeaderProbeTarget {
  id: string;
  baseUrl: string;
  path?: string;
  model: string;
  headers?: Record<string, string>;
}

export interface HeaderProbeOptions {
  // Off unless explicitly turned on (E4/N1/AC10).
  enabled?: boolean;
  targets?: HeaderProbeTarget[];
  fetch: FetchFn;
  now?: () => Date;
  timeoutMs?: number;
  // The fixed probe text; "ping" unless a provider needs a different one. Never a task's content.
  ping?: string;
}

// The same race-with-abort the GET probes use, over POST, because the host fetch may ignore AbortSignal.
const post = async (pc: { fetch: FetchFn; headers?: Record<string, string>; timeoutMs?: number }, url: string, body: string): Promise<Response> => {
  const timeoutMs = pc.timeoutMs ?? PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProbeError(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const headers = { "content-type": "application/json", ...(pc.headers ?? {}) };
    return await Promise.race([pc.fetch(url, { method: "POST", headers, body, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

// x-ratelimit-reset comes three ways: epoch seconds, seconds-until-reset, or an ISO date. Read whichever it is.
const resetFromHeader = (v: string | null, now: Date): string | undefined => {
  const n = num(v);
  if (n === undefined) {
    if (v && !Number.isNaN(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
    return undefined;
  }
  return n > 1e9 ? new Date(n * 1000).toISOString() : new Date(now.getTime() + n * 1000).toISOString();
};

// Probes each opted-in provider once and returns the quota it publishes in its headers. A provider that's opted out, or
// that didn't answer, yields nothing (no invented number); a transport failure is swallowed per target so one down
// provider doesn't lose the others, and the sweep reports it as unprobed rather than as exhausted.
export const probeQuotaHeaders = async (opts: HeaderProbeOptions): Promise<QuotaSample[]> => {
  if (!opts.enabled || !opts.targets?.length) return [];
  const now = opts.now?.() ?? new Date();
  const sampledAt = now.toISOString();
  const ping = opts.ping ?? PING_PROMPT;
  const out: QuotaSample[] = [];
  for (const t of opts.targets) {
    // The smallest request that returns the headers: a fixed "ping", one token out, and never a task's content (E7).
    const body = JSON.stringify({ model: t.model, max_tokens: 1, messages: [{ role: "user", content: ping }] });
    try {
      const res = await post({ fetch: opts.fetch, headers: t.headers, timeoutMs: opts.timeoutMs }, `${t.baseUrl.replace(/\/+$/, "")}${t.path ?? DEFAULT_PATH}`, body);
      const remaining = num(res.headers.get("x-ratelimit-remaining"));
      const limit = num(res.headers.get("x-ratelimit-limit"));
      const reset = resetFromHeader(res.headers.get("x-ratelimit-reset"), now);
      if (remaining !== undefined) out.push({ source: `header:${t.id}:remaining`, value: remaining, resetAt: reset, sampledAt });
      if (limit !== undefined) out.push({ source: `header:${t.id}:limit`, value: limit, resetAt: reset, sampledAt });
    } catch {
      // The provider didn't answer; nothing is claimed about its quota.
    }
  }
  return out;
};
