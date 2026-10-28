import { ProbeError, getJson, request, type ProbeContext, type ProbeResult } from "./http.js";

interface Slot {
  id?: number;
  is_processing?: boolean;
}

// /health is 200 when the model is loaded; /slots lists each slot and whether it is busy.
// /slots can be disabled on the server (--no-slots), so it is optional.
export const probeLlamaCpp = async (pc: ProbeContext): Promise<ProbeResult> => {
  await request(pc, "/health");
  try {
    const slots = await getJson<Slot[]>(pc, "/slots");
    if (!Array.isArray(slots)) throw new ProbeError("/slots is not a list");
    return { up: true, slotsTotal: slots.length, slotsBusy: slots.filter((s) => s.is_processing).length };
  } catch (e) {
    if (e instanceof ProbeError && /returned (404|501)/.test(e.message)) return { up: true };
    throw e;
  }
};
