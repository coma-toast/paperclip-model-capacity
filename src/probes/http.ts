import { PROBE_TIMEOUT_MS } from "../constants.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProbeContext {
  baseUrl: string;
  fetch: FetchFn;
  // Sent as Authorization; `headers` takes any header name (from a server auth slot).
  authHeader?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ProbeResult {
  up: boolean;
  slotsTotal?: number;
  slotsBusy?: number;
  error?: string;
}

export class ProbeError extends Error {}

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

// Probes send nothing but a GET (E7). The host fetch may ignore AbortSignal, so the timeout also races the request.
export const request = async (pc: ProbeContext, path: string): Promise<Response> => {
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
    const headers: Record<string, string> = { ...(pc.authHeader ? { Authorization: pc.authHeader } : {}), ...pc.headers };
    const res = await Promise.race([pc.fetch(joinUrl(pc.baseUrl, path), { method: "GET", headers, signal: controller.signal }), timeout]);
    if (!res.ok) throw new ProbeError(`${path} returned ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
};

export const getJson = async <T>(pc: ProbeContext, path: string): Promise<T> => {
  const res = await request(pc, path);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProbeError(`${path} returned invalid JSON`);
  }
};

export const getText = async (pc: ProbeContext, path: string) => (await request(pc, path)).text();
