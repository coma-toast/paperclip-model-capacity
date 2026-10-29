import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { registerApi } from "../src/api.js";
import manifest from "../src/manifest.js";
import { listBackendModels, modelsPath } from "../src/models.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { startFake, type Routes } from "./fakes/server.js";

const KEY = { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" };
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
const openAi = (ids: string[], status = 200): Routes => ({ "/v1/models": { status, body: { object: "list", data: ids.map((id) => ({ id })) } } });
const user = { actor: { type: "user" as const, userId: "u1" } };
const withApi = () => {
  const harness = createTestHarness({ manifest });
  const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
  runtimes.push(runtime);
  registerApi(harness.ctx, runtime);
  return harness;
};

describe("modelsPath", () => {
  it("adds /v1/models, or just /models when the base already ends in /v1", () => {
    expect(modelsPath("https://proxy.example.com/")).toEqual({ base: "https://proxy.example.com", path: "/v1/models" });
    expect(modelsPath("https://api.example.com/v1")).toEqual({ base: "https://api.example.com/v1", path: "/models" });
  });
});

describe("listBackendModels", () => {
  it("lists a proxy's models with the given headers, sorted and de-duplicated", async () => {
    const f = await fake(openAi(["b", "a", "b"]));
    const { ctx } = createTestHarness({ manifest });
    const r = await listBackendModels(ctx, { type: "litellm", name: "Proxy", baseUrl: f.baseUrl }, { Authorization: "Bearer k" });
    expect(r).toEqual({ ok: true, source: `${f.baseUrl}/v1/models`, models: ["a", "b"] });
    expect(f.requests[0].headers.authorization).toBe("Bearer k");
  });

  it("lists a generic OpenAI-compatible endpoint and a local engine", async () => {
    const f = await fake(openAi(["m1"]));
    const { ctx } = createTestHarness({ manifest });
    expect(await listBackendModels(ctx, { type: "openai", name: "API", baseUrl: `${f.baseUrl}/v1` })).toMatchObject({ ok: true, models: ["m1"] });
    expect(await listBackendModels(ctx, { type: "lmstudio", name: "Laptop", baseUrl: f.baseUrl })).toMatchObject({ ok: true, models: ["m1"] });
  });

  it("lists Ollama models from /api/tags", async () => {
    const f = await fake({ "/api/tags": { body: { models: [{ name: "qwen3:8b" }, { name: "llama3.3:70b" }] } } });
    const { ctx } = createTestHarness({ manifest });
    expect(await listBackendModels(ctx, { type: "ollama", name: "Ollama", baseUrl: f.baseUrl })).toEqual({ ok: true, source: `${f.baseUrl}/api/tags`, models: ["llama3.3:70b", "qwen3:8b"] });
  });

  it("asks for an address when the type has no default, and explains names-only backends", async () => {
    const { ctx } = createTestHarness({ manifest });
    expect(await listBackendModels(ctx, { type: "litellm", name: "Proxy" })).toEqual({ ok: false, error: "Enter Proxy's address (e.g. https://litellm.example.com)." });
    expect(await listBackendModels(ctx, { type: "other", name: "Names" })).toMatchObject({ ok: false });
  });

  it("explains a refused request", async () => {
    const f = await fake(openAi([], 401));
    const { ctx } = createTestHarness({ manifest });
    expect(await listBackendModels(ctx, { type: "openai", name: "API", baseUrl: f.baseUrl })).toEqual({
      ok: false, error: "API refused the request (/v1/models returned 401): check the API key.",
    });
  });
});

describe("list-backend-models action", () => {
  it("is board-only and needs a company and a saved backend", async () => {
    const harness = withApi();
    expect(await harness.performAction("list-backend-models", { companyId: "c1", backendId: "p" }, { actor: { type: "agent", agentId: "a1" } })).toMatchObject({ ok: false });
    expect(await harness.performAction("list-backend-models", { backendId: "p" }, user)).toEqual({ ok: false, error: "Open this from a company's settings" });
    expect(await harness.performAction("list-backend-models", { companyId: "c1", backendId: "p" }, user)).toEqual({ ok: false, error: "Pick a backend for this pool first" });
  });

  it("lists a saved backend's models with its saved key", async () => {
    const f = await fake(openAi(["litellm/a"]));
    const harness = withApi();
    harness.setConfig({ backends: [{ id: "p", name: "Proxy", type: "litellm", baseUrl: f.baseUrl, key: KEY }] });
    expect(await harness.performAction("list-backend-models", { companyId: "c1", backendId: "p" }, user)).toMatchObject({ ok: true, models: ["litellm/a"] });
    expect(f.requests[0].headers.authorization?.startsWith("Bearer ")).toBe(true);
  });
});
