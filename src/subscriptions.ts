import type { PluginContext } from "@paperclipai/plugin-sdk";

import { getJson, type FetchFn } from "./probes/http.js";

// Paperclip tracks subscription usage windows (Claude's and ChatGPT/Codex's 5-hour and weekly limits) per provider
// account, and only shows them to a signed-in board user. With a board token saved in the plugin's config, the worker
// reads them itself so a subscription pool can pause before runs start failing.
export type SubscriptionProvider = "anthropic" | "openai";

export interface SubscriptionWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface SubscriptionAccount {
  provider: string;
  accountLabel?: string;
  ok: boolean;
  windows: SubscriptionWindow[];
}

export interface SubscriptionSample {
  sampledAt: string;
  ok: boolean;
  error?: string;
  accounts: SubscriptionAccount[];
}

export const DEFAULT_PAPERCLIP_URL = "http://127.0.0.1:3100";

export const readSubscriptionWindows = async (companyId: string, deps: { fetch: FetchFn; baseUrl: string; token: string; now: Date }): Promise<SubscriptionSample> => {
  const sampledAt = deps.now.toISOString();
  try {
    const accounts = await getJson<SubscriptionAccount[]>(
      { baseUrl: deps.baseUrl.replace(/\/+$/, ""), fetch: deps.fetch, headers: { Authorization: `Bearer ${deps.token}` }, timeoutMs: 20_000 },
      `/api/companies/${encodeURIComponent(companyId)}/costs/quota-windows`,
    );
    return { sampledAt, ok: true, accounts: Array.isArray(accounts) ? accounts : [] };
  } catch (e) {
    return { sampledAt, ok: false, error: e instanceof Error ? e.message : String(e), accounts: [] };
  }
};

// A provider is used up when every connected account of it has a window at 100 %. It comes back when the first
// account's blocking windows have all reset (an account frees up at its latest blocking reset).
export const subscriptionExhausted = (sample: SubscriptionSample | undefined, provider: SubscriptionProvider, now: Date) => {
  const accounts = (sample?.accounts ?? []).filter((a) => a.ok && a.provider === provider);
  if (!accounts.length) return undefined;
  const freeAt: (number | undefined)[] = [];
  for (const a of accounts) {
    const blocking = a.windows.filter((w) => w.usedPercent !== null && w.usedPercent >= 100 && (!w.resetsAt || Date.parse(w.resetsAt) > now.getTime()));
    if (!blocking.length) return undefined;
    const resets = blocking.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN));
    freeAt.push(resets.some(Number.isNaN) ? undefined : Math.max(...resets));
  }
  const known = freeAt.filter((t): t is number => t !== undefined);
  const until = known.length === freeAt.length ? new Date(Math.min(...known)).toISOString() : undefined;
  const label = accounts.flatMap((a) => a.windows.filter((w) => (w.usedPercent ?? 0) >= 100).map((w) => w.label))[0];
  return { until, reason: `${provider === "anthropic" ? "Claude" : "ChatGPT"} subscription ${label ? `${label} ` : ""}used up` };
};

// How much of a provider's quota is left, 0-100: the best account's tightest window that hasn't reset yet.
export const subscriptionLeft = (sample: SubscriptionSample | undefined, provider: SubscriptionProvider, now: Date) => {
  const accounts = (sample?.accounts ?? []).filter((a) => a.ok && a.provider === provider);
  if (!accounts.length) return undefined;
  return Math.max(...accounts.map((a) => 100 - Math.max(0, ...a.windows
    .filter((w) => w.usedPercent !== null && (!w.resetsAt || Date.parse(w.resetsAt) > now.getTime()))
    .map((w) => w.usedPercent!))));
};

// Resolves the board token from this company's plugin config (a secret ref), or undefined when none is set.
export const quotaTokenFor = async (ctx: PluginContext, companyId: string) => {
  const config = await ctx.config.get(companyId);
  const ref = config.quotaToken;
  if (!ref) return undefined;
  const token = await ctx.secrets.resolve(ref as Parameters<PluginContext["secrets"]["resolve"]>[0], { companyId, configPath: "quotaToken" });
  return { token, baseUrl: typeof config.paperclipUrl === "string" && config.paperclipUrl.trim() ? config.paperclipUrl.trim() : DEFAULT_PAPERCLIP_URL };
};
