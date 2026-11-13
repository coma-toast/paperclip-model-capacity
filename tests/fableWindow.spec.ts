import { describe, expect, it } from "vitest";

import { validatePools } from "../src/settings.js";
import { subscriptionExhausted, windowFamily, type SubscriptionSample } from "../src/subscriptions.js";

const NOW = new Date("2026-11-10T15:00:00Z");
const sample = (week: number, fable: number, extra: number): SubscriptionSample => ({
  sampledAt: NOW.toISOString(), ok: true,
  accounts: [{
    ok: true, provider: "anthropic", accountLabel: "Anthropic",
    windows: [
      { label: "Current session", usedPercent: 40, resetsAt: "2026-11-10T18:00:00Z" },
      { label: "Current week (all models)", usedPercent: week, resetsAt: "2026-11-13T16:00:00Z" },
      { label: "Current week (Fable)", usedPercent: fable, resetsAt: "2026-11-12T16:00:00Z" },
      { label: "Extra usage", usedPercent: extra, resetsAt: "2026-12-01T00:00:00Z", detail: "Monthly extra usage pool" },
    ],
  }],
} as unknown as SubscriptionSample);

describe("model-scoped subscription windows", () => {
  it("reads the family from a window's label", () => {
    expect(windowFamily("Current week (Fable)")).toBe("fable");
    expect(windowFamily("Current week (all models)")).toBeUndefined();
    expect(windowFamily("Current session")).toBeUndefined();
  });

  it("pauses Fable on its own window, and not Opus", () => {
    const s = sample(60, 100, 0);
    expect(subscriptionExhausted(s, "anthropic", NOW, { model: "claude-fable-5-2" })).toMatchObject({ reason: "Claude subscription Current week (Fable) used up", until: "2026-11-12T16:00:00.000Z" });
    expect(subscriptionExhausted(s, "anthropic", NOW, { model: "claude-opus-5-5" })).toBeUndefined();
  });

  it("pauses Fable on the shared weekly limit while Opus keeps going on extra usage until that's used up", () => {
    expect(subscriptionExhausted(sample(100, 0, 0), "anthropic", NOW, { model: "claude-fable-5-2" })).toMatchObject({ reason: "Claude subscription Current week (all models) used up" });
    expect(subscriptionExhausted(sample(100, 0, 0), "anthropic", NOW, { model: "claude-opus-5-5", overQuota: true })).toBeUndefined();
    expect(subscriptionExhausted(sample(100, 0, 100), "anthropic", NOW, { model: "claude-opus-5-5", overQuota: true })).toMatchObject({ reason: "Claude subscription Extra usage used up" });
  });

  it("doesn't pause ordinary models because the extra-usage pool is used up", () => {
    expect(subscriptionExhausted(sample(50, 0, 100), "anthropic", NOW, { model: "claude-opus-5-5" })).toBeUndefined();
  });

  it("validates the pool's extra-usage model list", () => {
    const pool = { id: "orch", name: "Orchestrators", kind: "quota", patterns: ["claude-fable-5-2", "claude-opus-5-5"], limit: 2, privacy: "shared", mode: "enforce", scope: "company", subscription: "anthropic" };
    expect(validatePools([{ ...pool, overQuotaModels: ["claude-opus-5-5"] }]).ok).toBe(true);
    expect(validatePools([{ ...pool, overQuotaModels: "claude-opus-5-5" }]).ok).toBe(false);
  });
});
