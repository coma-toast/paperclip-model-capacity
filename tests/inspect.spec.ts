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

  it("reports a server that isn't answering instead of throwing", async () => {
    const f = await startFake({});
    await f.close();
    const r = await inspectHost("openai", { baseUrl: f.baseUrl, fetch, timeoutMs: 1000 });
    expect(r).toMatchObject({ up: false, summary: "Not answering", models: [] });
  });
});

describe("inspect-host action", () => {
  const setup = async () => {
    const harness = createTestHarness({ manifest });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(runtime);
    registerApi(harness.ctx, runtime);
    return harness;
  };
  const user = { actor: { type: "user" as const, userId: "u1" } };

  it("is board-only and checks the address", async () => {
    const harness = await setup();
    expect(await harness.performAction("inspect-host", { host: { engine: "openai", baseUrl: "http://x" } }, { actor: { type: "agent", agentId: "a1" } })).toMatchObject({ ok: false });
    expect(await harness.performAction("inspect-host", { host: { engine: "openai", baseUrl: "file:///etc/passwd" } }, user)).toEqual({ ok: false, error: "The address must start with http:// or https://" });
    expect(await harness.performAction("inspect-host", { host: { engine: "nope", baseUrl: "http://x" } }, user)).toEqual({ ok: false, error: "Pick a server type first" });
  });

  it("returns what the server runs, for an unsaved host", async () => {
    const harness = await setup();
    const f = await startFake(openAiRoutes());
    open.push(f);
    const r = await harness.performAction<InspectHostResult>("inspect-host", { host: { engine: "openai", baseUrl: `${f.baseUrl}/` }, poolId: "gpu" }, user);
    expect(r).toMatchObject({ ok: true, server: { up: true, models: [{ name: "gpu" }] }, poolRuns: [] });
  });
});
