import { ProbeError, getJson, type ProbeContext, type ProbeResult } from "./http.js";

interface Models {
  models?: unknown[];
}

// Ollama reports loaded models but not parallel slots, so the pool uses the host's declared slots (PRD Q4).
export const probeOllama = async (pc: ProbeContext): Promise<ProbeResult> => {
  const tags = await getJson<Models>(pc, "/api/tags");
  if (!Array.isArray(tags.models)) throw new ProbeError("/api/tags has no models list");
  const ps = await getJson<Models>(pc, "/api/ps");
  if (!Array.isArray(ps.models)) throw new ProbeError("/api/ps has no models list");
  return { up: true };
};
