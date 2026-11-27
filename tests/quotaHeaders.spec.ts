import { afterEach, describe, expect, it } from "vitest";
import { probeQuotaHeaders, HEADER_PROBE_INTERVAL_MS } from "../src/quota/headers.js";
import { startFake } from "./fakes/server.js";

const NOW = new Date("2026-11-03T17:00:00Z");
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((f) => f.close())); });
const q = (s: { source: string; value: number; resetAt?: string }[]) => s.map((x) => [x.source, x.value, x.resetAt ?? null]);
const target = (baseUrl: string) => ({ id: "v", baseUrl, model: "some/model", headers: { Authorization: "Bearer k" } });

describe("header probes (opt-in, E4/AC10)", () => {
  it("off by default: nothing leaves the plugin", async () => {
    const f = await startFake({ "/v1/chat/completions": { body: {} } });
    open.push(f);
    expect(await probeQuotaHeaders({ fetch, enabled: false, targets: [target(`${f.baseUrl}/v1`)], now: () => NOW })).toEqual([]);
    expect(await probeQuotaHeaders({ fetch, targets: [target(`${f.baseUrl}/v1`)], now: () => NOW })).toEqual([]);
    expect(await probeQuotaHeaders({ fetch, enabled: true, targets: [], now: () => NOW })).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it("a minimal ping reads x-ratelimit-* into quota", async () => {
    const f = await startFake({ "/v1/chat/completions": { body: { choices: [] }, headers: { "x-ratelimit-remaining": "99", "x-ratelimit-limit": "100", "x-ratelimit-reset": "1793894400" } } });
    const res = await probeQuotaHeaders({ fetch, enabled: true, targets: [target(`${f.baseUrl}/v1`)], now: () => NOW });
    const reset = new Date(1793894400 * 1000).toISOString();
    expect(q(res)).toEqual([["header:v:remaining", 99, reset], ["header:v:limit", 100, reset]]);
    // The request that went out is the smallest legal one — one token, a fixed "ping", never a task's content.
    const req = f.requests[0];
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer k");
    expect(JSON.parse(req.body)).toEqual({ model: "some/model", max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
    expect(HEADER_PROBE_INTERVAL_MS).toBe(15 * 60_000);
  });

  it("reset reads three ways: epoch, seconds-until-reset, and an ISO date", async () => {
    const withReset = (headers: Record<string, string>) => startFake({ "/v1/chat/completions": { body: {}, headers: { "x-ratelimit-remaining": "1", "x-ratelimit-limit": "2", ...headers } } });
    const epoch = await withReset({ "x-ratelimit-reset": "1793894400" });
    const rel = await withReset({ "x-ratelimit-reset": "60" });
    const iso = await withReset({ "x-ratelimit-reset": "2026-11-04T00:00:00Z" });
    open.push(epoch, rel, iso);
    // epoch seconds → that instant; seconds → now + 60 s; ISO → the moment itself.
    expect(q(await probeQuotaHeaders({ fetch, enabled: true, targets: [target(`${epoch.baseUrl}/v1`)], now: () => NOW }))).toEqual([["header:v:remaining", 1, new Date(1793894400 * 1000).toISOString()], ["header:v:limit", 2, new Date(1793894400 * 1000).toISOString()]]);
    expect(q(await probeQuotaHeaders({ fetch, enabled: true, targets: [target(`${rel.baseUrl}/v1`)], now: () => NOW }))).toEqual([["header:v:remaining", 1, "2026-11-03T17:01:00.000Z"], ["header:v:limit", 2, "2026-11-03T17:01:00.000Z"]]);
    expect(q(await probeQuotaHeaders({ fetch, enabled: true, targets: [target(`${iso.baseUrl}/v1`)], now: () => NOW }))).toEqual([["header:v:remaining", 1, "2026-11-04T00:00:00.000Z"], ["header:v:limit", 2, "2026-11-04T00:00:00.000Z"]]);
  });

  it("a provider that doesn't answer is reported as unprobed, never as exhausted", async () => {
    const f = await startFake({ "/v1/chat/completions": { status: 500, text: "boom" } });
    open.push(f);
    expect(await probeQuotaHeaders({ fetch, enabled: true, targets: [target(`${f.baseUrl}/v1`)], now: () => NOW })).toEqual([]);
    expect(f.requests.length).toBe(1);
  });
});
