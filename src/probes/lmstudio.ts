import { ProbeError, getJson, type ProbeContext, type ProbeResult } from "./http.js";

interface LmStudioModel {
  state?: string;
}

// LM Studio's REST API lists models with a load state; up means the server answers and at least one model is loaded.
export const probeLmStudio = async (pc: ProbeContext): Promise<ProbeResult> => {
  const body = await getJson<{ data?: LmStudioModel[] }>(pc, "/api/v0/models");
  if (!Array.isArray(body.data)) throw new ProbeError("/api/v0/models has no data list");
  if (!body.data.some((m) => m.state === "loaded")) throw new ProbeError("no model is loaded");
  return { up: true };
};
