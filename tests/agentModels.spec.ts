import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { apiForPrefix, collectAgentModels, endpointOf, modelPrefix } from "../src/agentModels.js";
import { registerApi } from "../src/api.js";
import manifest from "../src/manifest.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const agent = (name: string, adapterConfig: Record<string, unknown>, status = "idle") => ({ name, status, adapterConfig }) as unknown as Agent;
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});

describe("agent model detection", () => {
  it("groups agents by model, most used first, with the API from the prefix", () => {
    const uses = collectAgentModels([
      agent("a", { model: "litellm/fast" }), agent("b", { model: "litellm/fast" }), agent("c", { model: "opencode/x-free" }),
      agent("d", { model: "claude-sonnet-5-5" }), agent("e", { model: "lab/qwen3" }), agent("f", {}), agent("g", { model: "litellm/fast" }, "terminated"),
    ]);
    expect(uses.map((u) => [u.model, u.api, u.agents])).toEqual([
      ["litellm/fast", "litellm", ["a", "b"]],
      ["claude-sonnet-5-5", "other", ["d"]],
      ["lab/qwen3", "openai", ["e"]],
      ["opencode/x-free", "opencode", ["c"]],
    ]);
  });

  it("reads a model endpoint from adapter config or plain env, never secret refs or agent gateways", () => {
    expect(endpointOf({ baseUrl: "https://proxy.example.com/v1/" })).toBe("https://proxy.example.com/v1");
    expect(endpointOf({ env: { OPENAI_BASE_URL: { type: "plain", value: "http://lab:8000/v1" } } })).toBe("http://lab:8000/v1");
    expect(endpointOf({ env: { OLLAMA_HOST: { type: "plain", value: "laptop:11434" } } })).toBe("http://laptop:11434");
    expect(endpointOf({ env: { OPENAI_BASE_URL: { type: "secret_ref", secretId: "x" } } })).toBeUndefined();
    expect(endpointOf({ apiBaseUrl: "http://127.0.0.1:8642/" })).toBeUndefined();
  });

  it("maps prefixes to APIs", () => {
    expect([modelPrefix("ollama/qwen3:8b"), modelPrefix("plain")]).toEqual(["ollama/", ""]);
    expect([apiForPrefix("openrouter/"), apiForPrefix("custom/"), apiForPrefix("")]).toEqual(["openrouter", "openai", "other"]);
  });

  it("serves the company's agent models to the settings page", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ agents: [{ id: "a1", companyId: "c1", name: "Ada", status: "idle", adapterConfig: { model: "ollama/qwen3:8b" } } as unknown as Agent, { id: "a2", companyId: "c2", name: "Bo", status: "idle", adapterConfig: { model: "x/y" } } as unknown as Agent] });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(runtime);
    registerApi(harness.ctx, runtime);
    expect(await harness.getData("agent-models", { companyId: "c1" })).toEqual({ uses: [{ model: "ollama/qwen3:8b", prefix: "ollama/", api: "ollama", agents: ["Ada"] }] });
  });
});
