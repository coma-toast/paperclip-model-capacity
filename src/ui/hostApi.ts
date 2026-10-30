import { PLUGIN_KEY } from "../constants.js";

// The plugin's UI runs inside Paperclip's own page, so it can call Paperclip's API as the signed-in board user. The
// backend form uses this to store a key as a company secret and save the backend list in the plugin's company config
// in one step: the worker can only read secrets, never create them.

const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`/api${path}`, { credentials: "include", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.text();
  if (!res.ok) {
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      // not JSON
    }
    throw new Error(`${res.status}: ${message || res.statusText}`);
  }
  return (body ? JSON.parse(body) : null) as T;
};

// The config API wants the install id. The host loads this bundle from a blob: URL, so the id can't be read from
// import.meta.url; it's looked up once by the manifest key.
let installId: Promise<string> | undefined;
const pluginId = () => (installId ??= call<{ id: string; pluginKey: string }[]>("/plugins")
  .then((list) => {
    const hit = list.find((p) => p.pluginKey === PLUGIN_KEY);
    if (!hit) throw new Error(`Plugin ${PLUGIN_KEY} isn't installed`);
    return hit.id;
  })
  .catch((e: unknown) => {
    installId = undefined;
    throw e;
  }));

export type SecretBinding = { type: "secret_ref"; secretId: string; version?: number | "latest" };

export const readPluginConfig = async (companyId: string): Promise<Record<string, unknown>> => {
  const row = await call<{ configJson?: Record<string, unknown> } | null>(`/plugins/${encodeURIComponent(await pluginId())}/config?companyId=${encodeURIComponent(companyId)}`);
  return row?.configJson ?? {};
};

export const savePluginConfig = async (companyId: string, configJson: Record<string, unknown>) =>
  call(`/plugins/${encodeURIComponent(await pluginId())}/config`, { method: "POST", body: JSON.stringify({ companyId, configJson }) });

export const createCompanySecret = async (companyId: string, name: string, value: string): Promise<SecretBinding> => {
  const created = await call<{ id: string }>(`/companies/${encodeURIComponent(companyId)}/secrets`, { method: "POST", body: JSON.stringify({ name, value }) });
  return { type: "secret_ref", secretId: created.id, version: "latest" };
};

// Subscription usage windows Paperclip tracks per provider account (e.g. Codex's 5-hour and weekly limits). Board-only
// on the host, so only the UI (running as the board user) can read it, not the worker.
export interface QuotaWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  valueLabel: string | null;
  detail: string | null;
}

export interface QuotaAccount {
  provider: string;
  accountLabel?: string;
  ok: boolean;
  errorFamily?: string;
  windows: QuotaWindow[];
  capturedAt?: string;
  error?: string;
}

export const readQuotaWindows = (companyId: string) =>
  call<QuotaAccount[]>(`/companies/${encodeURIComponent(companyId)}/costs/quota-windows`);

export interface AiConnection {
  id: string;
  grantId?: string;
  provider: string;
  method: string;
  name: string;
  status?: string;
  routing?: { kind?: string; baseUrl?: string } | null;
}

export const listAiConnections = async (companyId: string) =>
  (await call<{ connections?: AiConnection[] }>(`/companies/${encodeURIComponent(companyId)}/ai-connections`)).connections ?? [];

// A connection's key is the company secret its grant points at, named "ai-<grantId>"; a backend can bind the same
// secret, so nothing is copied.
export const connectionKeyBinding = async (companyId: string, grantId: string): Promise<SecretBinding | undefined> => {
  const list = await call<{ id: string; name: string }[] | { secrets?: { id: string; name: string }[] }>(`/companies/${encodeURIComponent(companyId)}/secrets`);
  const hit = (Array.isArray(list) ? list : list.secrets ?? []).find((s) => s.name === `ai-${grantId}`);
  return hit ? { type: "secret_ref", secretId: hit.id, version: "latest" } : undefined;
};
