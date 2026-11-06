import { ProbeError, getJson, request, type ProbeContext, type ProbeResult } from "./http.js";

interface Slot {
  id?: number;
  is_processing?: boolean;
  n_prompt_tokens?: number;
  n_prompt_tokens_processed?: number;
  next_token?: { n_decoded?: number }[];
}

// A busy slot that hasn't produced a token yet is still reading its prompt (prefill); one that has is decoding.
export const slotStages = (slots: Slot[]) => {
  const busy = slots.filter((s) => s.is_processing);
  const decoded = (s: Slot) => (s.next_token ?? []).reduce((n, t) => n + (t.n_decoded ?? 0), 0);
  const prefilling = busy.filter((s) => decoded(s) === 0);
  return {
    prefill: prefilling.length, decode: busy.length - prefilling.length,
    ...(prefilling.some((s) => s.n_prompt_tokens) ? {
      prefillDone: prefilling.reduce((n, s) => n + (s.n_prompt_tokens_processed ?? 0), 0),
      prefillTotal: prefilling.reduce((n, s) => n + (s.n_prompt_tokens ?? 0), 0),
    } : {}),
  };
};

// /health is 200 when the model is loaded; /slots lists each slot and whether it is busy.
// /slots can be disabled on the server (--no-slots), so it is optional.
export const probeLlamaCpp = async (pc: ProbeContext): Promise<ProbeResult> => {
  await request(pc, "/health");
  try {
    const slots = await getJson<Slot[]>(pc, "/slots");
    if (!Array.isArray(slots)) throw new ProbeError("/slots is not a list");
    return { up: true, slotsTotal: slots.length, slotsBusy: slots.filter((s) => s.is_processing).length, stages: slotStages(slots) };
  } catch (e) {
    if (e instanceof ProbeError && /returned (404|501)/.test(e.message)) return { up: true };
    throw e;
  }
};
