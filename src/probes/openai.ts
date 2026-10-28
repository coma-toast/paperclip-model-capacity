import { ProbeError, getJson, type ProbeContext, type ProbeResult } from "./http.js";

// Reachability only: OpenAI-compatible servers (LiteLLM, oMLX, others) don't expose slot use.
export const probeOpenAi = async (pc: ProbeContext): Promise<ProbeResult> => {
  const body = await getJson<{ data?: unknown[] }>(pc, "/v1/models");
  if (!Array.isArray(body.data)) throw new ProbeError("/v1/models has no data list");
  return { up: true };
};
