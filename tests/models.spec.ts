import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { registerApi } from "../src/api.js";
import { createServerAuth } from "../src/auth.js";
import manifest from "../src/manifest.js";
import { listApiModels, modelsPath } from "../src/models.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { startFake } from "./fakes/server.js";

const KEY = { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" };
const open: { close: () => Promise<void> }[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all([...open.splice(0).map((f) => f.close()), ...runtimes.splice(0).map((r) => r.stop())]);
});

const fakeApi = async (ids: string[], status = 200) => {
  const f = await startFake({ "/v1/models": { status, body: { object: "list", data: ids.map((id) => ({ id })) } } });
  open.push(f);
  return f;
};

describe("modelsPath", () => {
  it("adds /v1/models, or just /models when the base already ends in /v1", () => {
    expect(modelsPath("https://ai.example.com/")).toEqual({ base: "https://ai.example.com", path: "/v1/models" });
    expect(modelsPath("https://opencode.ai/zen/v1")).toEqual({ base: "https://opencode.ai/zen/v1", path: "/models" });
  });
});

describe("listApiModels", () => {
  it("lists LiteLLM models from its configured address with its key, sorted and de-duplicated", async () => {
    const f = await fakeApi(["vm", "free", "vm", "pc-omo-local-qwen"]);
    const harness = createTestHarness({ manifest });
    harness.setConfig({ apiEndpoints: { litellm: { baseUrl: f.baseUrl, key: KEY } } });
    const r = await listApiModels(harness.ctx, createServerAuth(harness.ctx), "c1", "litellm");
    expect(r).toEqual({ ok: true, api: "litellm", source: `${f.baseUrl}/v1/models`, models: ["free", "pc-omo-local-qwen", "vm"] });
    expect(f.requests[0].headers.authorization?.startsWith("Bearer ")).toBe(true);
  });

  it("asks for LiteLLM's address when it isn't set, and explains 'Other'", async () => {
    const harness = createTestHarness({ manifest });
    const auth = createServerAuth(harness.ctx);
    expect(await listApiModels(harness.ctx, auth, "c1", "litellm")).toEqual({ ok: false, error: "Set LiteLLM's address (and key) in the plugin's config under API endpoints → LiteLLM." });
    expect(await listApiModels(harness.ctx, auth, "c1", "other")).toMatchObject({ ok: false });
  });

  it("explains a refused key", async () => {
    const f = await fakeApi([], 401);
    const harness = createTestHarness({ manifest });
    harness.setConfig({ apiEndpoints: { litellm: { baseUrl: f.baseUrl } } });
    const r = await listApiModels(harness.ctx, createServerAuth(harness.ctx), "c1", "litellm");
    expect(r).toEqual({ ok: false, error: "LiteLLM refused the request (/v1/models returned 401): check the API key in API endpoints." });
  });

  it("uses an overridden base URL for a public API", async () => {
    const f = await fakeApi(["nemotron-3.5-super-vl-free"]);
    const harness = createTestHarness({ manifest });
    harness.setConfig({ apiEndpoints: { opencode: { baseUrl: f.baseUrl } } });
    expect(await listApiModels(harness.ctx, createServerAuth(harness.ctx), "c1", "opencode")).toMatchObject({ ok: true, models: ["nemotron-3.5-super-vl-free"] });
  });
});

describe("list-api-models action", () => {
  it("is board-only and needs a company and a known API", async () => {
    const harness = createTestHarness({ manifest });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(runtime);
    registerApi(harness.ctx, runtime);
    const user = { actor: { type: "user" as const, userId: "u1" } };
    expect(await harness.performAction("list-api-models", { companyId: "c1", api: "litellm" }, { actor: { type: "agent", agentId: "a1" } })).toMatchObject({ ok: false });
    expect(await harness.performAction("list-api-models", { api: "litellm" }, user)).toEqual({ ok: false, error: "Open this from a company's settings" });
    expect(await harness.performAction("list-api-models", { companyId: "c1", api: "bedrock" }, user)).toEqual({ ok: false, error: "Pick the pool's API first" });
  });

  it("declares API endpoint keys as secret fields", () => {
    const props = manifest.instanceConfigSchema?.properties as Record<string, { properties: Record<string, { properties: Record<string, { format?: string }> }> }>;
    for (const api of ["litellm", "opencode", "openrouter"]) expect(props.apiEndpoints.properties[api].properties.key.format).toBe("secret-ref");
  });
});
