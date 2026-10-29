import type { PluginContext } from "@paperclipai/plugin-sdk";

// Credentials live in fixed company-config slots because Paperclip only treats named properties as secret fields
// (a pasted token becomes a company secret), never items in a list. A pool endpoint or a backend refers to one by name.
export const CREDENTIAL_SLOTS = ["credential1", "credential2", "credential3", "credential4"] as const;
export const AUTH_CACHE_MS = 5 * 60_000;

export interface CredentialSummary {
  slot: string;
  name: string;
  header: string;
  scheme: string;
  hasToken: boolean;
}

interface RawSlot {
  name?: unknown;
  header?: unknown;
  scheme?: unknown;
  token?: unknown;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const slotSchema = (n: number) => ({
  type: "object",
  title: `Credential ${n}`,
  description: "An API key or token. Pools and backends on the Model capacity page refer to it by name.",
  additionalProperties: false,
  properties: {
    name: { type: "string", title: "Name", description: "Any short name, e.g. proxy-key. Use it in a pool's or backend's Credential field." },
    header: { type: "string", title: "Header", description: "Defaults to Authorization." },
    scheme: { type: "string", title: "Scheme", description: "Put before the token, e.g. Bearer (the default). Set to a single space for none." },
    token: { type: "string", format: "secret-ref", title: "Token", description: "Paste the token (stored as a company secret) or pick an existing secret." },
  },
});

export const credentialsConfigSchema = Object.fromEntries(CREDENTIAL_SLOTS.map((key, i) => [key, slotSchema(i + 1)]));

// What the settings page may show: which credential names exist, never the token.
export const summarizeCredentials = (config: Record<string, unknown>): CredentialSummary[] =>
  CREDENTIAL_SLOTS.flatMap((slot) => {
    const raw = config[slot] as RawSlot | undefined;
    const name = text(raw?.name);
    if (!raw || !name) return [];
    return [{ slot, name, header: text(raw.header) ?? "Authorization", scheme: typeof raw.scheme === "string" ? raw.scheme.trim() : "Bearer", hasToken: raw.token !== undefined && raw.token !== null && raw.token !== "" }];
  });

export const createCredentials = (ctx: PluginContext, clock: () => number = Date.now) => {
  const cache = new Map<string, { at: number; headers: Record<string, string> }>();
  // Headers for a named credential in one company's config; undefined when the name isn't set up or has no token.
  const headersFor = async (companyId: string, name: string | undefined): Promise<Record<string, string> | undefined> => {
    if (!name) return undefined;
    const config = await ctx.config.get(companyId);
    const slot = CREDENTIAL_SLOTS.find((key) => text((config[key] as RawSlot | undefined)?.name) === name);
    if (!slot) return undefined;
    const raw = config[slot] as RawSlot;
    if (!raw.token) return undefined;
    const key = `${companyId}:${slot}:${JSON.stringify(raw)}`;
    const hit = cache.get(key);
    if (hit && clock() - hit.at < AUTH_CACHE_MS) return hit.headers;
    // Cached briefly: the host rate-limits secret resolution and health checks run every 30 s.
    const token = await ctx.secrets.resolve(raw.token as Parameters<PluginContext["secrets"]["resolve"]>[0], { companyId, configPath: `${slot}.token` });
    const scheme = typeof raw.scheme === "string" ? raw.scheme.trim() : "Bearer";
    const headers = { [text(raw.header) ?? "Authorization"]: scheme ? `${scheme} ${token}` : token };
    cache.set(key, { at: clock(), headers });
    return headers;
  };
  return { headersFor };
};

export type Credentials = ReturnType<typeof createCredentials>;
