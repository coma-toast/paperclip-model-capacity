import type { ApiKind } from "./apis.js";
import type { Backend } from "./backends.js";
import { nextReset, type UpstreamLimits } from "./upstreamLimits.js";
import type { BackendUsage, UsageMeter } from "./usage.js";

// A proxy alias (LiteLLM "free") spreads requests over deployments that each call an upstream model, like
// "openrouter/x:free". The alias's real quota is its upstreams' quotas, read from the company's backend for each
// upstream provider: one combined meter (used and remaining added up), plus which deployments report nothing.
const PROVIDER_TYPES: Record<string, ApiKind> = { openrouter: "openrouter", github_copilot: "copilot" };

export interface UpstreamQuota {
  // The combined quota, when at least one deployment's upstream has a known one.
  meter?: UsageMeter;
  // Deployments whose upstream has no known daily quota, described ("nvidia_nim: 451 today, no daily cap").
  uncovered: string[];
  // Every deployment's upstream quota is used up, so the alias can't serve anything.
  exhausted: boolean;
}

// requests: each upstream model's requests since its provider's reset (counted in LiteLLM's logs), for providers that
// don't report their own usage; limits: their quotas, from LiteLLM's model_info.
export const upstreamQuota = (
  upstreams: string[],
  backends: readonly Pick<Backend, "id" | "type" | "name">[],
  usage: Readonly<Record<string, BackendUsage>>,
  requests: Readonly<Record<string, number>> = {},
  now: Date = new Date(),
  limits: UpstreamLimits = {},
): UpstreamQuota => {
  const found = new Map<string, { name: string; meter: UsageMeter }>();
  const uncovered: string[] = [];
  let exhausted = upstreams.length > 0;
  const leave = (text: string) => {
    if (!uncovered.includes(text)) uncovered.push(text);
    exhausted = false;
  };
  for (const model of upstreams) {
    const [provider, ...rest] = model.split("/");
    const backend = backends.find((b) => b.type === PROVIDER_TYPES[provider]);
    const kind = model.endsWith(":free") ? "free" : "paid";
    const reported = backend ? usage[backend.id]?.meters.find((m) => m.limit !== undefined && (!m.appliesTo || m.appliesTo === kind)) : undefined;
    let part: { key: string; name: string; meter: UsageMeter } | undefined;
    if (backend && reported) {
      // Deployments on one upstream quota (OpenRouter's free requests per account) share it, so it counts once.
      part = { key: `${backend.id}|${reported.label}`, name: backend.name, meter: reported };
    } else {
      const limit = limits[model];
      const count = requests[model];
      if (limit?.rpd !== undefined && count !== undefined) {
        part = {
          key: `upstream|${model}`, name: `${provider} ${rest.join("/")}`,
          meter: { label: "Requests today", unit: "requests", used: count, limit: limit.rpd, remaining: Math.max(0, limit.rpd - count), resetAt: nextReset(now, limit.timeZone).toISOString() },
        };
      } else {
        leave(count !== undefined ? `${provider}: ${count} today, no daily cap${limit?.rpm ? ` (${limit.rpm}/min)` : ""}` : `${provider} not counted`);
        continue;
      }
    }
    found.set(part.key, { name: part.name, meter: part.meter });
    if ((part.meter.remaining ?? part.meter.limit! - (part.meter.used ?? 0)) > 0) exhausted = false;
  }
  // Only quotas counted in the same unit add up; the first one found sets it.
  const all = [...found.values()];
  const parts = all.filter((p) => p.meter.unit === all[0]?.meter.unit);
  if (!parts.length) return { uncovered, exhausted: false };
  const sum = (f: (m: UsageMeter) => number | undefined) => parts.every((p) => f(p.meter) !== undefined) ? parts.reduce((n, p) => n + f(p.meter)!, 0) : undefined;
  const resets = parts.map((p) => p.meter.resetAt).filter((r): r is string => Boolean(r)).sort();
  const meter: UsageMeter = {
    label: parts.length === 1 ? `${parts[0].meter.label} (${parts[0].name})` : `Upstream quota (${parts.map((p) => p.name).join(" + ")})`,
    unit: parts[0].meter.unit,
    used: sum((m) => m.used),
    limit: sum((m) => m.limit),
    remaining: sum((m) => m.remaining ?? (m.limit !== undefined && m.used !== undefined ? Math.max(0, m.limit - m.used) : undefined)),
    ...(resets[0] ? { resetAt: resets[0] } : {}),
  };
  return { meter, uncovered, exhausted };
};

const PROVIDER_NAMES: Record<string, string> = { openrouter: "OpenRouter", gemini: "Gemini", groq: "Groq", nvidia_nim: "NVIDIA NIM", cloudflare: "Cloudflare" };

// One meter per upstream provider a proxy calls, across all its deployments: the provider's own reported quota
// (OpenRouter), or its models' requests counted today against their published daily limits added up. A provider with
// no daily cap shows its count alone.
export const providerQuotas = (
  upstreams: Readonly<Record<string, string[]>>,
  backends: readonly Pick<Backend, "id" | "type" | "name">[],
  usage: Readonly<Record<string, BackendUsage>>,
  requests: Readonly<Record<string, number>> = {},
  now: Date = new Date(),
  limits: UpstreamLimits = {},
): UsageMeter[] => {
  const models = [...new Set(Object.values(upstreams).flat())];
  const providers = [...new Set(models.map((m) => m.split("/")[0]))].filter((p) => PROVIDER_TYPES[p] || models.some((m) => m.startsWith(`${p}/`) && limits[m]));
  const out: UsageMeter[] = [];
  for (const provider of providers) {
    const own = models.filter((m) => m.startsWith(`${provider}/`));
    const name = PROVIDER_NAMES[provider] ?? provider;
    const backend = backends.find((b) => b.type === PROVIDER_TYPES[provider]);
    if (backend) {
      // The provider reports its own quota: one meter per quota its models draw on (free requests, credits).
      const kinds = [...new Set(own.map((m) => (m.endsWith(":free") ? "free" : "paid")))];
      for (const kind of kinds) {
        const m = usage[backend.id]?.meters.find((x) => x.limit !== undefined && (!x.appliesTo || x.appliesTo === kind));
        if (m && !out.some((o) => o.label === `${name}: ${m.label}`)) out.push({ ...m, label: `${name}: ${m.label}` });
      }
      continue;
    }
    const counted = own.filter((m) => requests[m] !== undefined);
    if (!counted.length) continue;
    const used = counted.reduce((n, m) => n + requests[m], 0);
    const capped = counted.filter((m) => limits[m]?.rpd !== undefined);
    const rpm = Math.max(0, ...own.map((m) => limits[m]?.rpm ?? 0));
    if (!capped.length) {
      out.push({ label: `${name}: requests today`, unit: "requests", used, detail: `no daily cap${rpm ? ` · ${rpm}/min` : ""}` });
      continue;
    }
    const limit = capped.reduce((n, m) => n + limits[m]!.rpd!, 0);
    const cappedUsed = capped.reduce((n, m) => n + requests[m], 0);
    const resets = capped.map((m) => nextReset(now, limits[m]!.timeZone).toISOString()).sort();
    out.push({ label: `${name}: requests today`, unit: "requests", used: cappedUsed, limit, remaining: Math.max(0, limit - cappedUsed), resetAt: resets[0] });
  }
  return out;
};
