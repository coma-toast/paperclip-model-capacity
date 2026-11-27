import { afterEach, describe, expect, it } from "vitest";
import { readOpenRouterQuota } from "../src/quota/openrouter.js";
import { startFake } from "./fakes/server.js";

const NOW = new Date("2026-11-03T15:00:00Z");
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((f) => f.close())); });
const q = (s: { source: string; value: number; resetAt?: string }[]) => s.map((x) => [x.source, x.value, x.resetAt ?? null]);

describe("OpenRouter quota", () => {
  it("key remaining, used today and the free-tier flag from GET /api/v1/key", async () => {
    const f = await startFake({ "/api/v1/key": { body: { data: { limit_remaining: 74.5, usage_daily: 1.25, is_free_tier: true, limit_reset: "monthly" } } } });
    const res = await readOpenRouterQuota({ baseUrl: `${f.baseUrl}/api/v1`, fetch, now: () => NOW, headers: { Authorization: "Bearer or" } });
    // A period like "monthly" is no moment, so remaining carries no resetAt; the daily count still resets at midnight.
    expect(q(res)).toEqual([
      ["openrouter:key:remaining", 74.5, null],
      ["openrouter:key:usedToday", 1.25, "2026-11-04T00:00:00.000Z"],
      ["openrouter:key:freeTier", 1, null],
    ]);
    expect(f.requests[0].method).toBe("GET");
    expect(f.requests[0].headers.authorization).toBe("Bearer or");
  });

  it("reports only what the key states: paid tier, and no limit or daily figure when they're absent", async () => {
    const f = await startFake({ "/api/v1/key": { body: { data: { is_free_tier: false, usage_daily: 0 } } } });
    const res = await readOpenRouterQuota({ baseUrl: `${f.baseUrl}/api/v1`, fetch, now: () => NOW });
    expect(q(res)).toEqual([["openrouter:key:usedToday", 0, "2026-11-04T00:00:00.000Z"], ["openrouter:key:freeTier", 0, null]]);
  });

  it("a refused key throws rather than reporting quota", async () => {
    const f = await startFake({ "/api/v1/key": { status: 401, body: {} } });
    await expect(readOpenRouterQuota({ baseUrl: `${f.baseUrl}/api/v1`, fetch })).rejects.toThrow(/returned 401/);
  });
});
