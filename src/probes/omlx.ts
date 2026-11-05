import { getJson, type EngineStages, type ProbeContext, type ProbeResult } from "./http.js";
import { probeOpenAi } from "./openai.js";
import { readOmlxStages } from "./omlxActivity.js";

// oMLX's /api/status (needs the server's API key) counts requests being served and waiting across its loaded models.
export interface OmlxStatus {
  active_requests?: number;
  waiting_requests?: number;
  loaded_models?: string[];
  default_model?: string;
  model_memory_used_formatted?: string;
  model_memory_max_formatted?: string;
}

export const readOmlxStatus = (pc: ProbeContext) => getJson<OmlxStatus>(pc, "/api/status");

// The activity view can list one request twice while it moves from prefill to generating (and keep a finished prefill
// a moment longer), so its counts are trimmed to /api/status's request count, prefill first.
export const fitStages = (stages: EngineStages, active: number): EngineStages => {
  const decode = Math.min(stages.decode, active);
  const prefill = Math.min(stages.prefill, active - decode);
  if (decode === stages.decode && prefill === stages.prefill) return stages;
  const { prefillDone, prefillTotal, ...rest } = stages;
  return { ...rest, decode, prefill, ...(prefill ? { prefillDone, prefillTotal } : {}), ...(decode ? {} : { decodeTps: undefined }) };
};

// Busy slots from /api/status; a server without that endpoint (older oMLX) or a key it refuses is still checked for
// reachability, and its busy slots are then counted from the runs Paperclip sends it.
export const probeOmlx = async (pc: ProbeContext): Promise<ProbeResult> => {
  const status = await readOmlxStatus(pc).catch(() => undefined);
  if (status && typeof status.active_requests === "number") {
    const raw = await readOmlxStages(pc.fetch, pc.baseUrl, { ...(pc.authHeader ? { Authorization: pc.authHeader } : {}), ...pc.headers });
    const stages = raw ? fitStages(raw, status.active_requests) : undefined;
    return { up: true, slotsBusy: status.active_requests, ...(typeof status.waiting_requests === "number" ? { waiting: status.waiting_requests } : {}), ...(stages ? { stages } : {}) };
  }
  return probeOpenAi(pc);
};
