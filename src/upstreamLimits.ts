// An upstream model's quota behind LiteLLM: the provider's published free-tier limits, which no provider reports through
// an API. LiteLLM holds them in each deployment's model_info (quota_rpd, quota_rpm, quota_timezone), so they're set in
// one place and the plugin only reads them. OpenRouter needs none: it reports its own free requests per day.
export interface UpstreamLimit {
  rpd?: number;
  rpm?: number;
  // Where the daily count restarts: UTC unless the provider resets in another zone.
  timeZone?: string;
}
// By upstream model id ("groq/openai/gpt-oss-120b").
export type UpstreamLimits = Readonly<Record<string, UpstreamLimit>>;

const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

// One deployment's quota from its model_info, when it has one.
export const readUpstreamLimit = (info: Record<string, unknown> | undefined): UpstreamLimit | undefined => {
  const rpd = positive(info?.quota_rpd);
  const rpm = positive(info?.quota_rpm);
  const timeZone = typeof info?.quota_timezone === "string" && info.quota_timezone ? info.quota_timezone : undefined;
  return rpd || rpm ? { ...(rpd ? { rpd } : {}), ...(rpm ? { rpm } : {}), ...(timeZone ? { timeZone } : {}) } : undefined;
};

// When the current count started (the last reset), as a UTC timestamp, for a daily limit that resets at midnight in
// timeZone (UTC when unset).
export const dayStart = (now: Date, timeZone = "UTC"): Date => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const sinceMidnightMs = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000;
  return new Date(Math.floor((now.getTime() - sinceMidnightMs) / 1000) * 1000);
};

export const nextReset = (now: Date, timeZone = "UTC"): Date => {
  const start = dayStart(now, timeZone);
  // A day later in that zone (25 h then back to its midnight covers daylight-saving shifts).
  return dayStart(new Date(start.getTime() + 25 * 3600_000), timeZone);
};
