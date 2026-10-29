import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { registerApi } from "../src/api.js";
import { createCredentials } from "../src/auth.js";
import manifest from "../src/manifest.js";
import { listApiModels, modelsPath } from "../src/models.js";
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
const setup = () => {
  const harness = createTestHarness({ manifest });
  return { harness, creds: createCredentials(harness.ctx) };
};

describe("modelsPath", () => {
  it("adds /v1/models, or just /models when the base already ends in /v1", () => {
    expect(modelsPath("https://proxy.example.com/")).toEqual({ base: "https://proxy.example.com", path: "/v1/models" });
    expect(modelsPath("https://api.example.com/v1")).toEqual({ base: "https://api.example.com/v1", path: "/models" });
  });
});

describe("listApiModels", () => {
  it("lists a proxy's models at the pool's address with the pool's credential, sorted and de-duplicated", async () => {
    const f = await fake(openAi(["b", "a", "b"]));
    const { harness, creds } = setup();
    harness.setConfig({ credential1: { name: "proxy-key", token: KEY } });
    const r = await listApiModels(harness.ctx, creds, "c1", { api: "litellm", patterns: [], endpoint: { baseUrl: f.baseUrl, credential: "proxy-key" } });
    expect(r).toEqual({ ok: true, source: `${f.baseUrl}/v1/models`, models: ["a", "b"] });
    expect(f.requests[0].headers.authorization?.startsWith("Bearer ")).toBe(true);
  });

  it("lists a generic OpenAI-compatible endpoint and a local engine", async () => {
    const f = await fake(openAi(["m1"]));
    const { harness, creds } = setup();
    expect(await listApiModels(harness.ctx, creds, "c1", { api: "openai", patterns: [], endpoint: { baseUrl: `${f.baseUrl}/v1` } })).toMatchObject({ ok: true, models: ["m1"] });
    expect(await listApiModels(harness.ctx, creds, "c1", { api: "lmstudio", patterns: [], endpoint: { baseUrl: f.baseUrl } })).toMatchObject({ ok: true, models: ["m1"] });
  });

  it("lists Ollama models from /api/tags", async () => {
    const f = await fake({ "/api/tags": { body: { models: [{ name: "qwen3:8b" }, { name: "llama3.3:70b" }] } } });
    const { harness, creds } = setup();
    expect(await listApiModels(harness.ctx, creds, "c1", { api: "ollama", patterns: [], endpoint: { baseUrl: f.baseUrl } })).toEqual({ ok: true, source: `${f.baseUrl}/api/tags`, models: ["llama3.3:70b", "qwen3:8b"] });
  });

  it("asks for an address when the API has no default, and explains names-only pools", async () => {
    const { harness, creds } = setup();
    expect(await listApiModels(harness.ctx, creds, "c1", { api: "litellm", patterns: [] })).toEqual({ ok: false, error: "Enter the pool's address first (e.g. https://litellm.example.com)." });
    expect(await listApiModels(harness.ctx, creds, "c1", { api: "other", patterns: [] })).toMatchObject({ ok: false });
  });

  it("explains a refused request", async () => {
    const f = await fake(openAi([], 401));
    const { harness, creds } = setup();
    expect(await listApiModels(harness.ctx, creds, "c1", { api: "openai", patterns: [], endpoint: { baseUrl: f.baseUrl } })).toEqual({
      ok: false, error: "OpenAI-compatible endpoint refused the request (/v1/models returned 401): set the pool's credential.",
    });
  });
});

describe("list-api-models action", () => {
  it("is board-only and needs a company and a known API", async () => {
    const harness = createTestHarness({ manifest });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(runtime);
    registerApi(harness.ctx, runtime);
    const user = { actor: { type: "user" as const, userId: "u1" } };
    expect(await harness.performAction("list-api-models", { companyId: "c1", pool: { api: "openai" } }, { actor: { type: "agent", agentId: "a1" } })).toMatchObject({ ok: false });
    expect(await harness.performAction("list-api-models", { pool: { api: "openai" } }, user)).toEqual({ ok: false, error: "Open this from a company's settings" });
    expect(await harness.performAction("list-api-models", { companyId: "c1", pool: { api: "bedrock" } }, user)).toEqual({ ok: false, error: "Pick the pool's API first" });
  });
});
