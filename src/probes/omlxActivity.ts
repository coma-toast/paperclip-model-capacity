import type { EngineStages, FetchFn } from "./http.js";

// oMLX's admin activity view says which requests are in prefill (with progress), which are generating and how many
// wait. It needs an admin session, which oMLX grants for its main API key (POST /admin/api/login); the session cookie
// is kept per server and renewed when refused. Best effort: any failure just means no stages.
interface Activity {
  active_models?: {
    models?: {
      waiting_requests?: number;
      prefilling?: { processed?: number; total?: number }[];
      generating?: { tokens_per_second?: number }[];
    }[];
  };
}

const sessions = new Map<string, string>();

const login = async (fetch: FetchFn, base: string, apiKey: string) => {
  const res = await fetch(`${base}/admin/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: apiKey, remember: true }) });
  if (!res.ok) return undefined;
  const cookie = (res.headers.get("set-cookie") ?? "").match(/omlx_admin_session=[^;]+/)?.[0];
  if (cookie) sessions.set(base, cookie);
  return cookie;
};

export const readOmlxStages = async (fetch: FetchFn, baseUrl: string, headers: Record<string, string> | undefined): Promise<EngineStages | undefined> => {
  const apiKey = (headers?.Authorization ?? headers?.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!apiKey) return undefined;
  const base = baseUrl.replace(/\/+$/, "");
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cookie = sessions.get(base) ?? (await login(fetch, base, apiKey));
      if (!cookie) return undefined;
      const res = await fetch(`${base}/admin/api/activity`, { method: "GET", headers: { Cookie: cookie, Accept: "application/json" } });
      if (res.status === 401) {
        sessions.delete(base);
        continue;
      }
      if (!res.ok) return undefined;
      const models = ((await res.json()) as Activity).active_models?.models ?? [];
      const prefilling = models.flatMap((m) => m.prefilling ?? []);
      const generating = models.flatMap((m) => m.generating ?? []);
      return {
        prefill: prefilling.length, decode: generating.length, waiting: models.reduce((n, m) => n + (m.waiting_requests ?? 0), 0),
        ...(prefilling.length ? { prefillDone: prefilling.reduce((n, p) => n + (p.processed ?? 0), 0), prefillTotal: prefilling.reduce((n, p) => n + (p.total ?? 0), 0) } : {}),
        ...(generating.length ? { decodeTps: generating.reduce((n, g) => n + (g.tokens_per_second ?? 0), 0) } : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
};
