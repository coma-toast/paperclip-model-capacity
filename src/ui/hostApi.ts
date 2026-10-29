// The plugin's UI runs inside Paperclip's own page (loaded from /_plugins/<pluginId>/ui/…), so it can call Paperclip's
// API as the signed-in board user. The backend form uses this to store a key as a company secret and save the backend
// list in the plugin's company config in one step: the worker can only read secrets, never create them.
const pluginId = () => decodeURIComponent(new URL(import.meta.url).pathname.split("/")[2] ?? "");

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

export type SecretBinding = { type: "secret_ref"; secretId: string; version?: number | "latest" };

export const readPluginConfig = async (companyId: string): Promise<Record<string, unknown>> => {
  const row = await call<{ configJson?: Record<string, unknown> } | null>(`/plugins/${encodeURIComponent(pluginId())}/config?companyId=${encodeURIComponent(companyId)}`);
  return row?.configJson ?? {};
};

export const savePluginConfig = (companyId: string, configJson: Record<string, unknown>) =>
  call(`/plugins/${encodeURIComponent(pluginId())}/config`, { method: "POST", body: JSON.stringify({ companyId, configJson }) });

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
