import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { registerApi, type InspectHostResult } from "../src/api.js";
import manifest from "../src/manifest.js";
import { inspectHost } from "../src/probes/inspect.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { EngineKind } from "../src/types.js";
import { llamaCppRoutes } from "./fakes/llamacpp.js";
import { lmStudioRoutes } from "./fakes/lmstudio.js";
import { ollamaRoutes } from "./fakes/ollama.js";
import { openAiRoutes } from "./fakes/openai.js";
import { startFake, type Routes } from "./fakes/server.js";
import { vllmRoutes } from "./fakes/vllm.js";

const open: { close: () => Promise<void> }[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all([...open.splice(0).map((f) => f.close()), ...runtimes.splice(0).map((r) => r.stop())]);
});

const inspect = async (engine: EngineKind, routes: Routes) => {
  const f = await startFake(routes);
  open.push(f);
  return inspectHost(engine, { baseUrl: f.baseUrl, fetch });
};

describe("inspectHost", () => {
  it("llama.cpp: loaded model and each slot", async () => {
    const routes: Routes = {
      ...llamaCppRoutes([true, false]),
      "/props": { body: { model_alias: "vaultbox/strata:fast", model_path: "/root/models/Qwen3.6-35B-Q4.gguf", total_slots: 2 } },
      "/slots": { body: [{ id: 0, is_processing: true, n_prompt_tokens: 98_000, next_token: [{ n_decoded: 120 }] }, { id: 1, is_processing: false, n_ctx: 131_072 }] },
    };
    const r = await inspect("llamacpp", routes);
    expect(r).toMatchObject({ up: true, summary: "1 of 2 slots busy · vaultbox/strata:fast" });
    expect(r.models).toEqual([{ name: "vaultbox/strata:fast", state: "loaded", detail: "Qwen3.6-35B-Q4.gguf" }]);
    expect(r.slots).toEqual([{ id: 0, busy: true, detail: "prompt 98k tokens, 120 generated" }, { id: 1, busy: false, detail: "context 131k" }]);
  });

  it("llama.cpp: still answers when slots and props are turned off", async () => {
    const r = await inspect("llamacpp", { "/health": { body: { status: "ok" } } });
    expect(r).toMatchObject({ up: true, models: [], summary: "Up (slot details are turned off on this server)" });
  });

  it("ollama: loaded models with GPU memory", async () => {
    const r = await inspect("ollama", { ...ollamaRoutes(), "/api/ps": { body: { models: [{ name: "strata:fast", size_vram: 21_500_000_000 }] } } });
    expect(r.summary).toBe("1 model loaded of 1 installed (Ollama doesn't report busy slots)");
    expect(r.models).toEqual([{ name: "strata:fast", state: "loaded", detail: "21.5 GB in GPU" }]);
  });

  it("vllm: running and waiting requests", async () => {
    const r = await inspect("vllm", vllmRoutes([2]));
    expect(r).toMatchObject({ up: true, requests: { running: 2, waiting: 4 }, summary: "2 requests running, 4 waiting" });
  });

  it("lm studio: loaded models first", async () => {
    const r = await inspect("lmstudio", lmStudioRoutes(["not-loaded", "loaded"]));
    expect(r.models.map((m) => [m.name, m.state])).toEqual([["m1", "loaded"], ["m0", "not-loaded"]]);
  });

  it("openai-compatible: the model list", async () => {
    expect((await inspect("openai", openAiRoutes())).models).toEqual([{ name: "gpu" }]);
  });

  it("says a refused request needs a key, not that the server is down", async () => {
    const r = await inspect("openai", { "/v1/models": { status: 401, body: { error: "API key required" } } });
    expect(r).toMatchObject({ up: false, summary: "Refused the request (/v1/models returned 401): check the API key" });
  });

  it("reports a server that isn't answering instead of throwing", async () => {
    const f = await startFake({});
    await f.close();
    const r = await inspectHost("openai", { baseUrl: f.baseUrl, fetch, timeoutMs: 1000 });
    expect(r).toMatchObject({ up: false, summary: "Not answering", models: [] });
  });
});

describe("backend check actions", () => {
  const KEY = { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" };
  const setup = async () => {
    const harness = createTestHarness({ manifest });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(runtime);
    registerApi(harness.ctx, runtime);
    return harness;
  };
  const user = { actor: { type: "user" as const, userId: "u1" } };
  const fake = async (routes: Routes) => {
    const f = await startFake(routes);
    open.push(f);
    return f;
  };

  it("test-backend is board-only and checks the type and address", async () => {
    const harness = await setup();
    const backend = { name: "API", type: "openai", baseUrl: "http://x" };
    expect(await harness.performAction("test-backend", { companyId: "c1", backend }, { actor: { type: "agent", agentId: "a1" } })).toMatchObject({ ok: false });
    expect(await harness.performAction("test-backend", { companyId: "c1", backend: { ...backend, baseUrl: "file:///etc/passwd" } }, user)).toEqual({ ok: false, error: "The address must start with http:// or https://" });
    expect(await harness.performAction("test-backend", { companyId: "c1", backend: { ...backend, type: "nope" } }, user)).toEqual({ ok: false, error: "Pick the backend's type" });
  });

  it("test-backend lists an unsaved backend's models with the typed key, and inspects a local engine", async () => {
    const harness = await setup();
    const f = await fake(openAiRoutes());
    const r = await harness.performAction<{ ok: boolean; models: unknown; server?: unknown }>("test-backend", { companyId: "c1", backend: { name: "Box", type: "omlx", baseUrl: `${f.baseUrl}/` }, key: "typed" }, user);
    expect(r).toMatchObject({ ok: true, models: { ok: true, models: ["gpu"] }, server: { up: true } });
    expect(f.requests.every((q) => q.headers.authorization === "Bearer typed")).toBe(true);
  });

  it("test-backend never sends a saved key to a new address", async () => {
    const harness = await setup();
    const saved = await fake(openAiRoutes());
    const other = await fake(openAiRoutes());
    harness.setConfig({ backends: [{ id: "p", name: "Proxy", type: "litellm", baseUrl: saved.baseUrl, key: KEY }] });
    await harness.performAction("test-backend", { companyId: "c1", backend: { id: "p", name: "Proxy", type: "litellm", baseUrl: saved.baseUrl } }, user);
    expect(saved.requests[0].headers.authorization?.startsWith("Bearer ")).toBe(true);
    await harness.performAction("test-backend", { companyId: "c1", backend: { id: "p", name: "Proxy", type: "litellm", baseUrl: other.baseUrl } }, user);
    expect(other.requests[0].headers.authorization).toBeUndefined();
  });

  it("inspect-backend returns what a saved backend runs", async () => {
    const harness = await setup();
    const f = await fake(openAiRoutes());
    harness.setConfig({ backends: [{ id: "box", name: "Box", type: "openai", baseUrl: f.baseUrl }] });
    expect(await harness.performAction("inspect-backend", { companyId: "c1", backendId: "nope" }, user)).toEqual({ ok: false, error: "No such backend" });
    const r = await harness.performAction<InspectHostResult>("inspect-backend", { companyId: "c1", backendId: "box" }, user);
    expect(r).toMatchObject({ ok: true, server: { up: true, models: [{ name: "gpu" }] }, usedAuth: false, poolRuns: [] });
  });
});
