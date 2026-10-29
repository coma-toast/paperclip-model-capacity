import type { EngineKind } from "../types.js";
import { getJson, getText, request, type ProbeContext } from "./http.js";
import { sumGauge } from "./vllm.js";

export interface InspectedModel {
  name: string;
  state?: string;
  detail?: string;
}

export interface InspectedSlot {
  id: number;
  busy: boolean;
  detail?: string;
}

// What a model server says it is running right now, for the operator's "Check server" button.
export interface InspectResult {
  up: boolean;
  engine: EngineKind;
  error?: string;
  summary: string;
  models: InspectedModel[];
  slots?: InspectedSlot[];
  requests?: { running: number; waiting?: number };
}

const MAX_MODELS = 50;
const fileName = (path: unknown) => (typeof path === "string" ? path.split("/").pop() : undefined);
const gb = (bytes: unknown) => (typeof bytes === "number" && bytes > 0 ? `${(bytes / 1e9).toFixed(1)} GB` : undefined);
const tokens = (n: unknown) => (typeof n === "number" ? `${Math.round(n / 1000)}k` : undefined);

const inspectLlamaCpp = async (pc: ProbeContext): Promise<Omit<InspectResult, "engine" | "up">> => {
  await request(pc, "/health");
  const props = await getJson<{ model_alias?: string; model_path?: string; total_slots?: number }>(pc, "/props").catch(() => undefined);
  const raw = await getJson<{ id: number; is_processing?: boolean; n_ctx?: number; n_prompt_tokens?: number; next_token?: { n_decoded?: number }[] }[]>(pc, "/slots").catch(() => undefined);
  const slots = Array.isArray(raw)
    ? raw.map((s) => ({
      id: s.id, busy: Boolean(s.is_processing),
      detail: s.is_processing
        ? [tokens(s.n_prompt_tokens) && `prompt ${tokens(s.n_prompt_tokens)} tokens`, s.next_token?.[0]?.n_decoded !== undefined && `${s.next_token[0].n_decoded} generated`].filter(Boolean).join(", ")
        : tokens(s.n_ctx) && `context ${tokens(s.n_ctx)}`,
    }))
    : undefined;
  const model = props?.model_alias || fileName(props?.model_path);
  const busy = slots?.filter((s) => s.busy).length;
  return {
    models: model ? [{ name: model, state: "loaded", detail: fileName(props?.model_path) !== model ? fileName(props?.model_path) : undefined }] : [],
    slots,
    summary: slots ? `${busy} of ${slots.length} slot${slots.length === 1 ? "" : "s"} busy${model ? ` · ${model}` : ""}` : `Up${model ? ` · ${model}` : ""} (slot details are turned off on this server)`,
  };
};

const inspectOllama = async (pc: ProbeContext): Promise<Omit<InspectResult, "engine" | "up">> => {
  const ps = await getJson<{ models?: { name: string; size_vram?: number; expires_at?: string }[] }>(pc, "/api/ps");
  const tags = await getJson<{ models?: unknown[] }>(pc, "/api/tags").catch(() => undefined);
  const loaded = ps.models ?? [];
  return {
    models: loaded.slice(0, MAX_MODELS).map((m) => ({ name: m.name, state: "loaded", detail: [gb(m.size_vram) && `${gb(m.size_vram)} in GPU`, m.expires_at && `unloads ${new Date(m.expires_at).toLocaleTimeString()}`].filter(Boolean).join(", ") || undefined })),
    summary: `${loaded.length} model${loaded.length === 1 ? "" : "s"} loaded${tags?.models ? ` of ${tags.models.length} installed` : ""} (Ollama doesn't report busy slots)`,
  };
};

const inspectOpenAi = async (pc: ProbeContext): Promise<Omit<InspectResult, "engine" | "up">> => {
  const body = await getJson<{ data?: { id: string }[] }>(pc, "/v1/models");
  const ids = (body.data ?? []).map((m) => m.id);
  return {
    models: ids.slice(0, MAX_MODELS).map((name) => ({ name })),
    summary: `${ids.length} model${ids.length === 1 ? "" : "s"} offered (this server type doesn't report what's busy)`,
  };
};

const inspectVllm = async (pc: ProbeContext): Promise<Omit<InspectResult, "engine" | "up">> => {
  const metrics = await getText(pc, "/metrics");
  const running = Math.round(sumGauge(metrics, "vllm:num_requests_running") ?? 0);
  const waiting = Math.round(sumGauge(metrics, "vllm:num_requests_waiting") ?? 0);
  const body = await getJson<{ data?: { id: string }[] }>(pc, "/v1/models").catch(() => undefined);
  return {
    models: (body?.data ?? []).slice(0, MAX_MODELS).map((m) => ({ name: m.id, state: "loaded" })),
    requests: { running, waiting },
    summary: `${running} request${running === 1 ? "" : "s"} running, ${waiting} waiting`,
  };
};

const inspectLmStudio = async (pc: ProbeContext): Promise<Omit<InspectResult, "engine" | "up">> => {
  const body = await getJson<{ data?: { id: string; state?: string; type?: string }[] }>(pc, "/api/v0/models");
  const all = body.data ?? [];
  const loaded = all.filter((m) => m.state === "loaded");
  return {
    models: [...loaded, ...all.filter((m) => m.state !== "loaded")].slice(0, MAX_MODELS).map((m) => ({ name: m.id, state: m.state, detail: m.type })),
    summary: `${loaded.length} of ${all.length} model${all.length === 1 ? "" : "s"} loaded (LM Studio doesn't report busy slots)`,
  };
};

const INSPECTORS: Readonly<Record<EngineKind, (pc: ProbeContext) => Promise<Omit<InspectResult, "engine" | "up">>>> = {
  llamacpp: inspectLlamaCpp, ollama: inspectOllama, openai: inspectOpenAi, vllm: inspectVllm, lmstudio: inspectLmStudio,
};

// GET-only, like the probes (E7); a failure is reported, never thrown.
export const inspectHost = async (engine: EngineKind, pc: ProbeContext): Promise<InspectResult> => {
  try {
    return { up: true, engine, ...(await INSPECTORS[engine](pc)) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // A 401/403 means the server is up but wants a (different) key, which is the likely fix.
    const summary = /returned 40[13]\b/.test(error) ? `Refused the request (${error}): check the API key` : "Not answering";
    return { up: false, engine, error, summary, models: [] };
  }
};
