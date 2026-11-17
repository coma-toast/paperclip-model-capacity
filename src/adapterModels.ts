import { getJson, type FetchFn } from "./probes/http.js";

// JD-1245: what a CLI agent adapter (agy_local, ...) can run on this host. Paperclip asks the adapter (which runs e.g.
// `agy models`) and serves the list to a board user; an empty list means the CLI isn't signed in. Read with the board
// token saved for subscriptions. GET only.
export interface AdapterModelsSample {
  sampledAt: string;
  ok: boolean;
  models: string[];
  error?: string;
  // Reads in a row that failed or listed nothing; the CLI's pool counts as down after ADAPTER_DOWN_AFTER of them.
  failures: number;
}

export const ADAPTER_DOWN_AFTER = 3;
// "auto" lets the CLI pick; the plugin pins real models only.
const NOT_A_MODEL = new Set(["auto"]);

export const readAdapterModels = async (companyId: string, adapterType: string, prev: AdapterModelsSample | undefined, deps: { fetch: FetchFn; baseUrl: string; token: string; now: Date }): Promise<AdapterModelsSample> => {
  const sampledAt = deps.now.toISOString();
  try {
    const body = await getJson<unknown>(
      { baseUrl: deps.baseUrl.replace(/\/+$/, ""), fetch: deps.fetch, headers: { Authorization: `Bearer ${deps.token}` }, timeoutMs: 40_000 },
      `/api/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(adapterType)}/models`,
    );
    const list = Array.isArray(body) ? body : [];
    const models = [...new Set(list.map((m) => (typeof m === "string" ? m : (m as { id?: unknown })?.id)).filter((id): id is string => typeof id === "string" && !NOT_A_MODEL.has(id)))];
    if (!models.length) return { sampledAt, ok: false, models: prev?.models ?? [], error: `${adapterType} lists no models (is the CLI signed in on the host?)`, failures: (prev?.failures ?? 0) + 1 };
    return { sampledAt, ok: true, models, failures: 0 };
  } catch (e) {
    return { sampledAt, ok: false, models: prev?.models ?? [], error: e instanceof Error ? e.message : String(e), failures: (prev?.failures ?? 0) + 1 };
  }
};

export const adapterDown = (sample: AdapterModelsSample | undefined) => Boolean(sample && sample.failures >= ADAPTER_DOWN_AFTER);
