import { describe, expect, it } from "vitest";

import { providerQuotas, upstreamQuota } from "../src/upstream.js";
import { dayStart } from "../src/upstreamLimits.js";
import type { BackendUsage } from "../src/usage.js";

const NOW = "2026-11-03T12:00:00.000Z";
const backends = [{ id: "or", type: "openrouter" as const, name: "OpenRouter" }, { id: "ll", type: "litellm" as const, name: "LiteLLM" }];
const usage = (used: number): Record<string, BackendUsage> => ({
  or: {
    backendId: "or", sampledAt: NOW, ok: true, notes: [], meters: [
      { label: "Account credits", unit: "usd", used: 1, limit: 10, remaining: 9, appliesTo: "paid" },
      { label: "Free requests today", unit: "requests", used, limit: 1000, remaining: 1000 - used, resetAt: "2026-11-04T00:00:00.000Z", appliesTo: "free" },
    ],
  },
});

describe("upstreamQuota", () => {
  it("counts a shared upstream quota once and names the deployments that report none", () => {
    const q = upstreamQuota(["openrouter/a:free", "openrouter/b:free", "nvidia_nim/x"], backends, usage(640));
    expect(q).toEqual({
      meter: { label: "Free requests today (OpenRouter)", unit: "requests", used: 640, limit: 1000, remaining: 360, resetAt: "2026-11-04T00:00:00.000Z" },
      uncovered: ["nvidia_nim not counted"], exhausted: false,
    });
  });

  it("is used up only when every deployment's upstream is used up", () => {
    expect(upstreamQuota(["openrouter/a:free", "openrouter/b:free"], backends, usage(1000)).exhausted).toBe(true);
    expect(upstreamQuota(["openrouter/a:free", "nvidia_nim/x"], backends, usage(1000)).exhausted).toBe(false);
  });

  it("uses the paid meter for a paid upstream model, and reports nothing for unknown providers", () => {
    expect(upstreamQuota(["openrouter/paid-model"], backends, usage(0)).meter).toMatchObject({ label: "Account credits (OpenRouter)", unit: "usd", remaining: 9 });
    expect(upstreamQuota(["groq/x"], backends, usage(0))).toEqual({ uncovered: ["groq not counted"], exhausted: false });
  });
});

// The quotas LiteLLM holds in its deployments' model_info.
const LIMITS = {
  "groq/openai/gpt-oss-120b": { rpd: 1000, rpm: 30 },
  "gemini/gemini-2.5-flash-lite": { rpd: 1000, rpm: 15, timeZone: "America/Los_Angeles" },
  "gemini/gemini-flash-lite-latest": { rpd: 1000, rpm: 15, timeZone: "America/Los_Angeles" },
  "nvidia_nim/x": { rpm: 40 },
  "nvidia_nim/y": { rpm: 40 },
};

describe("upstream quotas counted from LiteLLM's logs", () => {
  const now = new Date("2026-11-03T17:00:00.000Z");
  it("adds a counted upstream with a published daily limit to the combined quota, and describes one with no daily cap", () => {
    const q = upstreamQuota(["openrouter/a:free", "groq/openai/gpt-oss-120b", "nvidia_nim/x"], backends, usage(640), { "groq/openai/gpt-oss-120b": 120, "nvidia_nim/x": 451 }, now, LIMITS);
    expect(q.meter).toMatchObject({ label: "Upstream quota (OpenRouter + groq openai/gpt-oss-120b)", unit: "requests", used: 760, limit: 2000, remaining: 1240 });
    expect(q.uncovered).toEqual(["nvidia_nim: 451 today, no daily cap (40/min)"]);
    expect(q.exhausted).toBe(false);
  });

  it("resets a Gemini count at midnight Pacific, and is used up when every counted upstream is", () => {
    const q = upstreamQuota(["gemini/gemini-2.5-flash-lite"], backends, {}, { "gemini/gemini-2.5-flash-lite": 1000 }, now, LIMITS);
    expect(q.meter).toMatchObject({ used: 1000, limit: 1000, remaining: 0, resetAt: "2026-11-04T08:00:00.000Z" });
    expect(q.exhausted).toBe(true);
  });
});

describe("dayStart", () => {
  it("finds the last midnight in a time zone", () => {
    expect(dayStart(new Date("2026-11-03T17:00:00Z")).toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(dayStart(new Date("2026-11-03T17:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-11-03T08:00:00.000Z");
    expect(dayStart(new Date("2026-11-03T05:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });
});

describe("providerQuotas", () => {
  it("gives one quota per upstream provider across all aliases: reported, counted against daily limits, or a bare count", () => {
    const upstreams = {
      free: ["openrouter/a:free", "openrouter/b:free", "nvidia_nim/x"],
      cmo: ["openrouter/c:free"],
      cfo: ["gemini/gemini-flash-lite-latest"],
      beard: ["gemini/gemini-2.5-flash-lite"],
      gina: ["nvidia_nim/y"],
      vm: ["strata:fast"],
    };
    const requests = { "nvidia_nim/x": 452, "nvidia_nim/y": 21, "gemini/gemini-flash-lite-latest": 3, "gemini/gemini-2.5-flash-lite": 0 };
    expect(providerQuotas(upstreams, backends, usage(852), requests, new Date("2026-11-03T17:00:00Z"), LIMITS)).toEqual([
      { label: "OpenRouter: Free requests today", unit: "requests", used: 852, limit: 1000, remaining: 148, resetAt: "2026-11-04T00:00:00.000Z", appliesTo: "free" },
      { label: "NVIDIA NIM: requests today", unit: "requests", used: 473, detail: "no daily cap · 40/min" },
      { label: "Gemini: requests today", unit: "requests", used: 3, limit: 2000, remaining: 1997, resetAt: "2026-11-04T08:00:00.000Z" },
    ]);
  });

  it("counts nothing for a provider LiteLLM holds no quota for", () => {
    expect(providerQuotas({ free: ["groq/openai/gpt-oss-120b"] }, backends, {}, { "groq/openai/gpt-oss-120b": 5 })).toEqual([]);
  });
});

