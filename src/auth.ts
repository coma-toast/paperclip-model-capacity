import type { PluginContext } from "@paperclipai/plugin-sdk";

// Paperclip only treats named properties as secret fields (a pasted token becomes a company secret), never items in a
// list, so server auth lives in fixed company-config slots rather than on the pool's server rows.
export const AUTH_SLOTS = ["serverAuth1", "serverAuth2", "serverAuth3", "serverAuth4"] as const;
export const AUTH_CACHE_MS = 5 * 60_000;

export interface AuthSlotSummary {
  slot: string;
  server: string;
  header: string;
  scheme: string;
  hasToken: boolean;
}

interface RawSlot {
  server?: unknown;
  header?: unknown;
  scheme?: unknown;
  token?: unknown;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const slotSchema = (n: number) => ({
  type: "object",
  title: `Server auth ${n}`,
  description: "Credentials for one model server (a LiteLLM backend), used by health checks and Check server.",
  additionalProperties: false,
  properties: {
    server: { type: "string", title: "Server id", description: "The server's Id on this company's Model capacity page, e.g. ct118." },
    header: { type: "string", title: "Header", description: "Defaults to Authorization." },
    scheme: { type: "string", title: "Scheme", description: "Put before the token, e.g. Bearer (the default). Leave as a single space for none." },
    token: { type: "string", format: "secret-ref", title: "Token", description: "Paste the token (stored as a company secret) or pick an existing secret." },
  },
});

export const authConfigSchema = Object.fromEntries(AUTH_SLOTS.map((key, i) => [key, slotSchema(i + 1)]));

// What the settings page may show: which servers have auth, never the token.
export const summarizeAuth = (config: Record<string, unknown>): AuthSlotSummary[] =>
  AUTH_SLOTS.flatMap((slot) => {
    const raw = config[slot] as RawSlot | undefined;
    const server = text(raw?.server);
    if (!raw || !server) return [];
    return [{ slot, server, header: text(raw.header) ?? "Authorization", scheme: typeof raw.scheme === "string" ? raw.scheme.trim() : "Bearer", hasToken: raw.token !== undefined && raw.token !== null && raw.token !== "" }];
  });

export const createServerAuth = (ctx: PluginContext, clock: () => number = Date.now) => {
  const cache = new Map<string, { at: number; headers: Record<string, string> }>();
  // Headers for one company's server (its id on that company's settings page), or undefined when it has no auth.
  const headersFor = async (companyId: string, serverId: string): Promise<Record<string, string> | undefined> => {
    const config = await ctx.config.get(companyId);
    const slot = AUTH_SLOTS.find((key) => text((config[key] as RawSlot | undefined)?.server) === serverId);
    if (!slot) return undefined;
    const raw = config[slot] as RawSlot;
    if (!raw.token) return undefined;
    const key = `${companyId}:${slot}:${JSON.stringify(raw)}`;
    const hit = cache.get(key);
    if (hit && clock() - hit.at < AUTH_CACHE_MS) return hit.headers;
    // Resolved values are cached briefly: the host rate-limits secret resolution and probes run every 30 s.
    const token = await ctx.secrets.resolve(raw.token as Parameters<PluginContext["secrets"]["resolve"]>[0], { companyId, configPath: `${slot}.token` });
    const scheme = typeof raw.scheme === "string" ? raw.scheme.trim() : "Bearer";
    const headers = { [text(raw.header) ?? "Authorization"]: scheme ? `${scheme} ${token}` : token };
    cache.set(key, { at: clock(), headers });
    return headers;
  };
  return { headersFor };
};

export type ServerAuth = ReturnType<typeof createServerAuth>;
