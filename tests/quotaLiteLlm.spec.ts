import { afterEach, describe, expect, it } from "vitest";
import { readLiteLlmQuota } from "../src/quota/litellm.js";
import { startFake, type Routes } from "./fakes/server.js";

const NOW = new Date("2026-11-03T17:00:00Z");
const at = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((f) => f.close())); });

// Recorded response shapes; every value is a fake.
const routes = (): Routes => ({
  "/model/info": { body: { data: [
    { model_name: "free", litellm_params: { model: "openrouter/a:free" }, model_info: { quota_remaining: 48, quota_reset_at: "2026-11-04T00:00:00Z" } },
    { model_name: "mbp", litellm_params: { model: "ollama/mbp" }, model_info: { cooldown_until: "2026-11-03T18:00:00Z" } },
    { model_name: "quiet", litellm_params: { model: "groq/x" }, model_info: {} },
  ] } },
  "/spend/logs/ui": { body: { data: [
    { model: "free", status_code: 429, end_time: at(120) },
    { model: "free", status: "rate limit exceeded", message: "Upstream returned 429", end_time: at(10) },
    { model: "mbp", exception_class: "RateLimitError", status_code: 429, end_time: at(30) },
    { model: "ok", status: "success", end_time: at(5) },
    { model: "old", status_code: 429, end_time: at(1500) },
  ] } },
});

const q = (s: { source: string; value: number; resetAt?: string }[]): [string, number, string | null][] => s.map((x) => [x.source, x.value, x.resetAt ?? null]);

describe("LiteLLM quota", () => {
  it("pool members' recorded quota and recent 429s, each with its source and sample time", async () => {
    const f = await startFake(routes());
    const res = await readLiteLlmQuota({ baseUrl: f.baseUrl, fetch, now: () => NOW, headers: { Authorization: "Bearer admin" } });
    expect(q(res)).toEqual(expect.arrayContaining([
      ["litellm:free:remaining", 48, "2026-11-04T00:00:00Z"],
      ["litellm:mbp:cooldown", 0, "2026-11-03T18:00:00Z"],
      ["litellm:free:rateLimited24h", 2, null],
      ["litellm:free:rateLimited1h", 1, null],
      ["litellm:mbp:rateLimited24h", 1, null],
      ["litellm:mbp:rateLimited1h", 1, null],
    ]));
    // A quiet member, a success, and a failure outside the 24 h window produce no sample — no number is invented.
    expect(q(res).filter((x) => /^litellm:(quiet|ok|old):/.test(x[0]))).toEqual([]);
    expect(res.every((s) => s.sampledAt === NOW.toISOString())).toBe(true);
    expect(f.requests.map((r) => r.path.split("?")[0])).toEqual(["/model/info", "/spend/logs/ui"]);
    expect(f.requests[1].path).toContain("status_filter=failure");
    expect(f.requests[1].headers.authorization).toBe("Bearer admin");
  });

  it("reports a refused admin key instead of inventing quota", async () => {
    const f = await startFake({ "/model/info": { status: 403, body: {} } });
    await expect(readLiteLlmQuota({ baseUrl: f.baseUrl, fetch, now: () => NOW, headers: { Authorization: "Bearer bad" } })).rejects.toThrow(/returned 403/);
  });
});
