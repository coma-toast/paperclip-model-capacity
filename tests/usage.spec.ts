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

  it("LiteLLM: reads each upstream's quota from model_info and counts its requests since its reset with the logs key, summed over aliases", async () => {
    const seen: string[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/key/info") return json({ info: { spend: 0 } });
      if (u.pathname === "/model/info") return json({ data: [
        { model_name: "free", litellm_params: { model: "openrouter/a:free" }, model_info: { id: "d1" } },
        { model_name: "free", litellm_params: { model: "nvidia_nim/x" }, model_info: { id: "d2", quota_rpm: 40 } },
        { model_name: "gina", litellm_params: { model: "nvidia_nim/x" }, model_info: { id: "d3", quota_rpm: 40 } },
        { model_name: "cfo", litellm_params: { model: "gemini/gemini-2.5-flash-lite" }, model_info: { id: "d4", quota_rpd: 1000, quota_timezone: "America/Los_Angeles" } },
        { model_name: "cto", litellm_params: { model: "groq/openai/gpt-oss-20b" }, model_info: { id: "d5" } },
      ] });
      if (u.pathname === "/spend/logs/ui") {
        seen.push(`${u.searchParams.get("model_id")} ${u.searchParams.get("start_date")} ${auth}`);
        return json({ total: { d2: 400, d3: 21, d4: 7 }[u.searchParams.get("model_id")!] ?? 0 });
      }
      return new Response("nope", { status: 404 });
    };
    const r = await sampleUsage({ id: "ll", name: "LiteLLM", type: "litellm", baseUrl: "http://ll" }, { fetch, now: () => new Date("2026-11-03T17:00:00Z"), headers: { Authorization: "Bearer v" }, logsHeaders: { Authorization: "Bearer admin" } });
    expect(r.upstreams).toEqual({ free: ["openrouter/a:free", "nvidia_nim/x"], gina: ["nvidia_nim/x"], cfo: ["gemini/gemini-2.5-flash-lite"], cto: ["groq/openai/gpt-oss-20b"] });
    // A deployment with no quota in LiteLLM (cto) isn't counted.
    expect(r.upstreamLimits).toEqual({ "nvidia_nim/x": { rpm: 40 }, "gemini/gemini-2.5-flash-lite": { rpd: 1000, timeZone: "America/Los_Angeles" } });
    expect(r.upstreamRequests).toEqual({ "nvidia_nim/x": 421, "gemini/gemini-2.5-flash-lite": 7 });
    expect(seen).toEqual(["d2 2026-11-03 00:00:00 Bearer admin", "d3 2026-11-03 00:00:00 Bearer admin", "d4 2026-11-03 08:00:00 Bearer admin"]);
  });

  it("OpenRouter: the key's limit and today's spend; free-model cap from the tier when /key doesn't count it", async () => {
    const f = await fake({ "/api/v1/key": { body: { data: { usage: 25.5, limit: 100, limit_remaining: 74.5, limit_reset: "monthly", usage_daily: 1.25, is_free_tier: false } } } });
    const r = await sampleUsage({ id: "or", name: "OpenRouter", type: "openrouter", baseUrl: `${f.baseUrl}/api/v1` }, deps);
    expect(r.meters).toEqual([
      { label: "Key limit", unit: "usd", used: 25.5, limit: 100, remaining: 74.5, period: "monthly", noLimit: "no limit on this key", appliesTo: "paid" },
      { label: "Spent today", unit: "usd", used: 1.25 },
    ]);
    expect(r.notes).toEqual(["Free models: 1000 requests/day, 20/min (not counted by the API)"]);
    expect(r.modelLimits).toEqual({ "*:free": { rpm: 20, rpd: 1000 } });
  });

  it("OpenRouter: prepaid account credits and the free requests used today, reset at midnight UTC", async () => {
    const f = await fake({
      "/api/v1/key": { body: { data: { usage: 0.24, limit: null, usage_daily: 0.01, is_free_tier: false, free_model_daily_requests: { used: 640, limit: 1000, remaining: 360 } } } },
      "/api/v1/credits": { body: { data: { total_credits: 10, total_usage: 1.05 } } },
    });
    const r = await sampleUsage({ id: "or", name: "OpenRouter", type: "openrouter", baseUrl: `${f.baseUrl}/api/v1` }, { ...deps, now: () => new Date("2026-11-02T15:00:00Z") });
    expect(r.meters).toEqual([
      { label: "Account credits", unit: "usd", used: 1.05, limit: 10, remaining: 8.95, period: "prepaid, no reset", appliesTo: "paid" },
      { label: "Spent today", unit: "usd", used: 0.01 },
      { label: "Free requests today", unit: "requests", used: 640, limit: 1000, remaining: 360, resetAt: "2026-11-03T00:00:00.000Z", appliesTo: "free" },
    ]);
    expect(r.notes).toEqual(["Free models: 20 requests/min"]);
    expect(r.modelLimits).toEqual({ "*:free": { rpm: 20, rpd: 1000 } });
  });

  it("GitHub Copilot: premium requests for the month, read from api.github.com with the saved token", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      return new Response(JSON.stringify({
        copilot_plan: "individual", quota_reset_date: "2026-12-01",
        quota_snapshots: {
          chat: { unlimited: true }, completions: { unlimited: true },
          premium_interactions: { entitlement: 1500, remaining: 1200, unlimited: false, overage_permitted: true },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const r = await sampleUsage({ id: "gh", name: "Copilot", type: "copilot", baseUrl: "https://api.githubcopilot.com" }, { fetch, headers: { Authorization: "Bearer t" } });
    expect(seen).toEqual([{ url: "https://api.github.com/copilot_internal/user", auth: "Bearer t" }]);
    expect(r.meters).toEqual([{ label: "Premium requests", unit: "requests", used: 300, limit: 1500, remaining: 1200, resetAt: "2026-12-01T00:00:00Z", period: "month" }]);
    expect(r.notes).toEqual([
      "Plan: individual", "Unlimited: chat, completions",
      "Overage billing is on: past the allowance GitHub charges per request, so the pool pauses at 0 left unless it's set to go over quota",
    ]);
  });

  it("local engines: busy slots now", async () => {
    const f = await fake(llamaCppRoutes([true, false]));
    const r = await sampleUsage({ id: "gpu", name: "GPU", type: "llamacpp", baseUrl: f.baseUrl }, deps);
    expect(r.meters).toEqual([{ label: "Slots busy", unit: "slots", used: 1, limit: 2, remaining: 1 }]);
  });

  it("OpenCode Zen: with a personal key, the Console's budget and today's free-model requests", async () => {
    const seen: string[] = [];
    const fetch = async (url: string) => {
      const u = new URL(url);
      seen.push(`${u.pathname}${u.search}`);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/console/api/policies/current-budgets") return json([{ limitDollars: 20, spentDollars: 1.5, scope: "combined", coverage: "all", resetsAt: "2026-12-01T00:00:00.000Z" }]);
      if (u.pathname === "/console/api/usage/summary") return json({ totalRequests: "900", totalCostMicroCents: "150000000" });
      if (u.pathname === "/console/api/usage/models") return json({ items: [
        { model: "beam-free", provider: "opencode", totalRequests: "40", totalCostMicroCents: "0" },
        { model: "big-pickle", provider: "opencode", totalRequests: "5", totalCostMicroCents: "0" },
        { model: "qwen3.6-plus", provider: "opencode-go", totalRequests: "12", totalCostMicroCents: "9000" },
      ] });
      return new Response("[]", { status: 200 });
    };
    const r = await sampleUsage({ id: "z", name: "Zen", type: "opencode" }, { fetch, headers: { Authorization: "Bearer k" }, now: () => new Date("2026-11-04T12:00:00Z") });
    expect(r.meters).toEqual([
      { label: "Budget", unit: "usd", used: 1.5, limit: 20, remaining: 18.5, resetAt: "2026-12-01T00:00:00.000Z", period: "month", detail: "all models" },
      { label: "Free model requests today", unit: "requests", used: 45, appliesTo: "free", detail: "limit not published; paused when OpenCode says it's used up" },
    ]);
    expect(seen.filter((s) => s.startsWith("/console"))).toEqual([
      "/console/api/policies/current-budgets", "/console/api/usage/summary?from=2026-11-01&to=2026-11-05", "/console/api/usage/models?from=2026-11-04&to=2026-11-05&pageSize=100",
    ]);
  });

  it("OpenCode Zen: a key the Console refuses falls back to Paperclip's own records, saying why", async () => {
    const fetch = async (url: string) => (new URL(url).pathname.startsWith("/console") ? new Response('{"_tag":"Forbidden"}', { status: 403 }) : new Response("[]", { status: 200 }));
    const r = await sampleUsage({ id: "z", name: "Zen", type: "opencode" }, { fetch, headers: { Authorization: "Bearer sa" }, paperclipSpend: async () => ({ monthUsd: 0, freeRuns: 1, freeTokens: 10 }) });
    expect(r.meters.map((m) => m.label)).toEqual(["Spent this month", "Free model runs (24 h)"]);
    expect(r.notes[0]).toMatch(/^OpenCode Console: .*403.*personal API key/);
  });

  it("OpenCode Zen: counts Paperclip's own spend and free-model runs, since it has no usage API", async () => {
    const at = () => new Date("2026-11-04T12:00:00Z");
    const r = await sampleUsage({ id: "z", name: "Zen", type: "opencode" }, { ...deps, headers: undefined, now: at, paperclipSpend: async () => ({ monthUsd: 1.25, freeRuns: 7, freeTokens: 932000 }) });
    expect(r.meters).toEqual([
      { label: "Spent this month", unit: "usd", used: 1.25, derived: true, period: "month", resetAt: "2026-12-01T00:00:00.000Z", detail: "Paperclip's runs · balance is in its console" },
      { label: "Free model runs (24 h)", unit: "requests", used: 7, derived: true, appliesTo: "free", detail: "932,000 tokens · limit not published; paused when OpenCode says it's used up" },
    ]);
    expect(r.notes).toEqual([]);
  });

  it("says when a backend has no usage API, and reports a refused key instead of throwing", async () => {
    expect(await sampleUsage({ id: "z", name: "Zen", type: "opencode" }, { ...deps, headers: undefined })).toMatchObject({ ok: true, meters: [], notes: [expect.stringContaining("no usage API")] });
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
