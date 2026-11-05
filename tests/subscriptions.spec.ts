import { describe, expect, it } from "vitest";

import { subscriptionExhausted, type SubscriptionSample } from "../src/subscriptions.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const sample = (accounts: SubscriptionSample["accounts"]): SubscriptionSample => ({ sampledAt: NOW.toISOString(), ok: true, accounts });
const win = (label: string, usedPercent: number | null, resetsAt: string | null) => ({ label, usedPercent, resetsAt });

describe("subscriptionExhausted", () => {
  it("is used up only when every account of the provider has a window at 100%, until the first account frees up", () => {
    const s = sample([
      { provider: "openai", accountLabel: "A", ok: true, windows: [win("5h limit", 0, "2026-11-02T14:00:00Z"), win("Weekly limit", 100, "2026-11-04T08:05:27Z")] },
      { provider: "openai", accountLabel: "B", ok: true, windows: [win("Weekly limit", 100, "2026-11-03T10:00:00Z")] },
    ]);
    expect(subscriptionExhausted(s, "openai", NOW)).toEqual({ until: "2026-11-03T10:00:00.000Z", reason: "ChatGPT subscription Weekly limit used up" });
  });

  it("isn't used up while any account has room, or for a provider with no accounts", () => {
    const s = sample([
      { provider: "openai", ok: true, windows: [win("Weekly limit", 100, "2026-11-04T08:05:27Z")] },
      { provider: "openai", ok: true, windows: [win("Weekly limit", 40, "2026-11-04T08:05:27Z")] },
    ]);
    expect(subscriptionExhausted(s, "openai", NOW)).toBeUndefined();
    expect(subscriptionExhausted(s, "anthropic", NOW)).toBeUndefined();
  });

  it("ignores a 100% window whose reset has already passed", () => {
    const s = sample([{ provider: "anthropic", ok: true, windows: [win("5h limit", 100, "2026-11-02T11:00:00Z")] }]);
    expect(subscriptionExhausted(s, "anthropic", NOW)).toBeUndefined();
  });
});
