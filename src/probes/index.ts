import { HOST_DOWN_AFTER_FAILURES, HOST_UP_AFTER_SUCCESSES } from "../constants.js";
import type { EngineKind, HostConfig, HostStatus, PoolConfig } from "../types.js";
import type { FetchFn, ProbeContext, ProbeResult } from "./http.js";
import { probeLlamaCpp } from "./llamacpp.js";
import { probeLmStudio } from "./lmstudio.js";
import { probeOllama } from "./ollama.js";
import { probeOpenAi } from "./openai.js";
import { probeVllm } from "./vllm.js";

export const PROBES: Readonly<Record<EngineKind, (pc: ProbeContext) => Promise<ProbeResult>>> = {
  llamacpp: probeLlamaCpp,
  ollama: probeOllama,
  openai: probeOpenAi,
  vllm: probeVllm,
  lmstudio: probeLmStudio,
};

export const runProbe = async (host: HostConfig, pc: Omit<ProbeContext, "baseUrl">): Promise<ProbeResult> => {
  try {
    return await PROBES[host.engine]({ ...pc, baseUrl: host.baseUrl });
  } catch (e) {
    return { up: false, error: e instanceof Error ? e.message : String(e) };
  }
};

// E2: down after 3 failures in a row, up after 2 successes in a row. A host starts down until it proves itself.
export const nextStatus = (hostId: string, prev: HostStatus | undefined, result: ProbeResult, at: string): HostStatus => {
  const failures = result.up ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
  const successes = result.up ? (prev?.consecutiveSuccesses ?? 0) + 1 : 0;
  const wasUp = prev?.up ?? false;
  const up = wasUp ? failures < HOST_DOWN_AFTER_FAILURES : successes >= HOST_UP_AFTER_SUCCESSES;
  return {
    hostId, up, consecutiveFailures: failures, consecutiveSuccesses: successes,
    slotsTotal: result.up ? result.slotsTotal : prev?.slotsTotal,
    slotsBusy: result.up ? result.slotsBusy : prev?.slotsBusy,
    lastProbeAt: at,
    lastChangeAt: up !== wasUp ? at : prev?.lastChangeAt,
    error: result.error,
  };
};

export interface HostChange {
  hostId: string;
  up: boolean;
}

export interface ProbeAllDeps {
  fetch: FetchFn;
  // Resolves a host's auth header from its secret ref; never logged (A5).
  authHeader?: (host: HostConfig) => Promise<string | undefined>;
  // Any auth headers for a host (server auth slots); never logged.
  headers?: (host: HostConfig) => Promise<Record<string, string> | undefined>;
  timeoutMs?: number;
  now?: () => Date;
}

// Probes every host of every pool once, in parallel, and returns the new statuses plus the up/down changes (for alerts).
export const probeAll = async (pools: PoolConfig[], prev: Record<string, HostStatus>, deps: ProbeAllDeps) => {
  const hosts = new Map(pools.flatMap((p) => p.hosts).map((h) => [h.id, h]));
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const results = await Promise.all(
    [...hosts.values()].map(async (host) => {
      const authHeader = await deps.authHeader?.(host).catch(() => undefined);
      const headers = await deps.headers?.(host).catch(() => undefined);
      return [host.id, await runProbe(host, { fetch: deps.fetch, authHeader, headers, timeoutMs: deps.timeoutMs })] as const;
    }),
  );
  const statuses: Record<string, HostStatus> = {};
  const changes: HostChange[] = [];
  for (const [hostId, result] of results) {
    statuses[hostId] = nextStatus(hostId, prev[hostId], result, at);
    if (prev[hostId] && statuses[hostId].up !== prev[hostId].up) changes.push({ hostId, up: statuses[hostId].up });
  }
  return { statuses, changes };
};
