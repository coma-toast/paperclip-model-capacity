import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import { checkEngineReach, reachCandidates } from "../src/reach.js";
import { startFake } from "./fakes/server.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

describe("reachCandidates", () => {
  it("lists names routed only to the engine, shortest first", () => {
    const routes = [
      { model: "litellm/pc-local-a", targets: [{ engine: "gpu" }] },
      { model: "litellm/vm", targets: [{ engine: "gpu" }] },
      { model: "litellm/local", targets: [{ engine: "gpu" }, { engine: "mac" }] },
      { model: "litellm/free", targets: [{}] },
    ];
    expect(reachCandidates("gpu", routes)).toEqual(["litellm/vm", "litellm/pc-local-a"]);
  });
});

describe("checkEngineReach", () => {
  it("checks proxy-reached and direct engines and flags balanced proxy models", async () => {
    const proxy = await startFake({ "/model/info": { body: { data: [
      { model_name: "mbp", litellm_params: { api_base: "http://10.0.0.5:1235/v1" } },
      { model_name: "vm", litellm_params: { api_base: "http://10.0.0.6:8091/v1" } },
      { model_name: "local", litellm_params: { api_base: "http://10.0.0.6:8091/v1" } },
      { model_name: "local", litellm_params: { api_base: "http://10.0.0.5:1235/v1" } },
    ] } } });
    const ollama = await startFake({ "/api/tags": { body: { models: [{ name: "qwen3:8b" }] } } });
    open.push(proxy, ollama);
    const { ctx } = createTestHarness({ manifest });
    const r = await checkEngineReach(ctx, [
      { id: "proxy", name: "Proxy", type: "litellm", baseUrl: proxy.baseUrl },
      { id: "mac", name: "Mac", type: "omlx", baseUrl: "http://10.0.0.5:1235", reachVia: "proxy", reachModel: "litellm/mbp" },
      { id: "gpu", name: "GPU", type: "llamacpp", baseUrl: "http://10.0.0.6:8091", reachVia: "proxy", reachModel: "litellm/old" },
      { id: "laptop", name: "Laptop", type: "ollama", baseUrl: ollama.baseUrl, reachVia: "direct", reachModel: "ollama/qwen3:8b" },
      { id: "spare", name: "Spare", type: "vllm", baseUrl: "http://10.0.0.9:8000" },
    ], async () => undefined);
    expect(r.engines.map((e) => [e.engineId, e.ok, e.candidates])).toEqual([
      ["mac", true, ["litellm/mbp"]],
      ["gpu", false, ["litellm/vm"]],
      ["laptop", true, ["ollama/qwen3:8b"]],
      ["spare", false, []],
    ]);
    expect(r.engines[1].problem).toBe("The proxy no longer sends litellm/old only here");
    expect(r.engines[3].problem).toBe("Not set: pick how agents reach this engine");
    expect(r.balanced).toEqual([{ proxyId: "proxy", model: "litellm/local", engines: ["gpu", "mac"] }]);
  });
});
