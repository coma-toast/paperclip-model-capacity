import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { registerApi, type BackendUsageRow } from "../src/api.js";
import manifest from "../src/manifest.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { sampleUsage, usedShare } from "../src/usage.js";
import { llamaCppRoutes } from "./fakes/llamacpp.js";
import { startFake, type Routes } from "./fakes/server.js";

const NOW = new Date("2026-10-29T12:00:00Z");
const open: { close: () => Promise<void> }[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all([...open.splice(0).map((f) => f.close()), ...runtimes.splice(0).map((r) => r.stop())]);
});
const fake = async (routes: Routes) => {
  const f = await startFake(routes);
  open.push(f);
  return f;
};
const deps = { fetch, now: () => NOW, headers: { Authorization: "Bearer k" } };

describe("sampleUsage", () => {
  it("LiteLLM: key spend against its budget, with the reset date and rate limits", async () => {
    const f = await fake({ "/key/info": { body: { key: "sk-...", info: { spend: 12.5, max_budget: 50, budget_reset_at: "2026-11-01T00:00:00Z", budget_duration: "30d", rpm_limit: 60 } } } });
    const r = await sampleUsage({ id: "p", name: "Proxy", type: "litellm", baseUrl: f.baseUrl }, deps);
    expect(r).toEqual({
      backendId: "p", sampledAt: NOW.toISOString(), ok: true, source: `${f.baseUrl}/key/info`, notes: ["60 requests/min"],
      meters: [{ label: "Key spend", unit: "usd", used: 12.5, limit: 50, remaining: 37.5, resetAt: "2026-11-01T00:00:00Z", period: "30d", noLimit: "no budget set" }],
    });
    expect(f.requests[0].headers.authorization).toBe("Bearer k");
  });

  it("LiteLLM: spend with no budget, plus the team's budget when the key has a team", async () => {
    const f = await fake({
      "/key/info": { body: { info: { spend: 42.6, max_budget: null, team_id: "t1" } } },
      "/team/info?team_id=t1": { body: { team_info: { spend: 80, max_budget: 100 } } },
    });
    const r = await sampleUsage({ id: "p", name: "Proxy", type: "litellm", baseUrl: `${f.baseUrl}/v1` }, deps);
    expect(r.meters).toEqual([
      { label: "Key spend", unit: "usd", used: 42.6, limit: undefined, resetAt: undefined, period: undefined, noLimit: "no budget set" },
      { label: "Team spend", unit: "usd", used: 80, limit: 100, remaining: 20, resetAt: undefined, period: undefined },
    ]);
  });

  it("OpenRouter: credits left, today's spend and the free-model daily cap", async () => {
    const f = await fake({ "/api/v1/key": { body: { data: { usage: 25.5, limit: 100, limit_remaining: 74.5, limit_reset: "monthly", usage_daily: 1.25, is_free_tier: false } } } });
    const r = await sampleUsage({ id: "or", name: "OpenRouter", type: "openrouter", baseUrl: `${f.baseUrl}/api/v1` }, deps);
    expect(r.meters).toEqual([
      { label: "Credits", unit: "usd", used: 25.5, limit: 100, remaining: 74.5, period: "monthly", noLimit: "no limit on this key" },
      { label: "Spent today", unit: "usd", used: 1.25 },
    ]);
    expect(r.notes).toEqual(["Free models: 1000 requests/day (not reported by the API)"]);
  });

  it("local engines: busy slots now", async () => {
    const f = await fake(llamaCppRoutes([true, false]));
    const r = await sampleUsage({ id: "gpu", name: "GPU", type: "llamacpp", baseUrl: f.baseUrl }, deps);
    expect(r.meters).toEqual([{ label: "Slots busy", unit: "slots", used: 1, limit: 2, remaining: 1 }]);
  });

  it("says when a backend has no usage API, and reports a refused key instead of throwing", async () => {
    expect(await sampleUsage({ id: "z", name: "Zen", type: "opencode" }, deps)).toMatchObject({ ok: true, meters: [], notes: [expect.stringContaining("no usage API")] });
    const f = await fake({ "/key/info": { status: 401, body: {} } });
    const r = await sampleUsage({ id: "p", name: "Proxy", type: "litellm", baseUrl: f.baseUrl }, deps);
    expect(r).toMatchObject({ ok: false, meters: [], error: "/key/info returned 401 (check the backend's API key)" });
  });

  it("LiteLLM: explains a key with no spend record (master or config key)", async () => {
    const f = await fake({ "/key/info": { status: 404, body: { error: { message: "Key not found in database" } } } });
    const r = await sampleUsage({ id: "p", name: "Proxy", type: "litellm", baseUrl: f.baseUrl }, deps);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("isn't a LiteLLM virtual key") });
  });

  it("usedShare", () => {
    expect(usedShare({ label: "x", unit: "usd", used: 45, limit: 50 })).toBe(0.9);
    expect(usedShare({ label: "x", unit: "usd", used: 42 })).toBeUndefined();
    expect(usedShare({ label: "x", unit: "usd", limit: 100, remaining: 25 })).toBe(0.75);
  });
});

describe("capacity-summary backends", () => {
  it("lists each backend with its latest sample and the pools using it", async () => {
    const f = await fake(llamaCppRoutes([true]));
    const harness = createTestHarness({ manifest });
    harness.setConfig({ backends: [{ id: "gpu", name: "GPU", type: "llamacpp", baseUrl: f.baseUrl }, { id: "zen", name: "Zen", type: "opencode" }] });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(runtime);
    registerApi(harness.ctx, runtime);
    await runtime.store.companyPools("c1").set([{ id: "local", name: "Local", backend: "gpu", patterns: ["llamacpp/m"], limit: 1, privacy: "private", mode: "observe", hosts: [], alertAfterMinutes: 30, scope: "instance" }]);
    expect(await harness.performAction("refresh-usage", { companyId: "c1" }, { actor: { type: "user", userId: "u1" } })).toEqual({ ok: true });
    const data = await harness.getData<{ backends: BackendUsageRow[] }>("capacity-summary", { companyId: "c1" });
    expect(data.backends.map((b) => [b.id, b.pools, b.usage?.meters[0]?.used])).toEqual([["gpu", ["Local"], 1], ["zen", [], undefined]]);
  });
});
