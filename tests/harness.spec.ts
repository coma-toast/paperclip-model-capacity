import { describe, expect, it } from "vitest";

import { harnessConfig } from "../src/harness.js";
import type { PoolConfig } from "../src/types.js";

const pool = (id: string, over: Partial<PoolConfig> = {}): PoolConfig => ({
  id, name: id, patterns: ["litellm/mbp", "litellm/vm"], limit: 4, privacy: "private", mode: "enforce", hosts: [], alertAfterMinutes: 30, scope: "instance", ...over,
});
const backends = [
  { id: "proxy", name: "Proxy", type: "litellm" as const, baseUrl: "https://proxy.example.com" },
  { id: "other", name: "Other", type: "openai" as const, baseUrl: "https://api.example.com/v1" },
];

describe("harnessConfig", () => {
  it("maps each pinning pool's virtual model to its first engine's real model through the backend", () => {
    const r = harnessConfig([pool("local", { backend: "proxy", sticky: [{ model: "litellm/mbp", engine: "mac" }, { model: "litellm/vm", engine: "gpu" }] })], backends);
    expect(r.provider).toEqual({
      pool: {
        npm: "@ai-sdk/openai-compatible", name: "Model capacity pools",
        options: { baseURL: "https://proxy.example.com/v1", apiKey: "{env:LITELLM_API_KEY}" },
        models: { local: { name: "local (model capacity pool)", id: "mbp", limit: { context: 131072, output: 8192 } } },
      },
    });
  });

  it("skips pools that don't pin, and warns about a pool behind a different endpoint", () => {
    const r = harnessConfig([
      pool("plain", { backend: "proxy" }),
      pool("a", { backend: "proxy", sticky: [{ model: "litellm/vm", engine: "gpu" }] }),
      pool("b", { backend: "other", patterns: ["x"], sticky: [{ model: "x", engine: "gpu" }] }),
    ], backends);
    expect(Object.keys((r.provider.pool as { models: object }).models)).toEqual(["a"]);
    expect(r.warnings[0]).toContain("b goes through Other");
  });

  it("returns nothing when no pool pins tasks", () => {
    expect(harnessConfig([pool("plain", { backend: "proxy" })], backends)).toEqual({ provider: {}, warnings: [] });
  });

  it("direct to engines: falls back to the first engine itself and adds a provider per engine", () => {
    const engines = [
      { id: "direct", name: "Direct", type: "direct" as const },
      { id: "mac", name: "Mac", type: "omlx" as const, baseUrl: "http://mac:1235", prefix: "omlx/" },
      { id: "gpu", name: "GPU", type: "llamacpp" as const, baseUrl: "http://gpu:8091", prefix: "llamacpp/" },
    ];
    const r = harnessConfig([pool("local", { backend: "direct", patterns: ["omlx/qwen", "llamacpp/strata"], sticky: [{ model: "omlx/qwen", engine: "mac" }, { model: "llamacpp/strata", engine: "gpu" }] })], engines);
    expect(r.provider).toMatchObject({
      omlx: { options: { baseURL: "http://mac:1235/v1", apiKey: "{env:MAC_API_KEY}" }, models: { qwen: { name: "omlx/qwen" } } },
      llamacpp: { options: { baseURL: "http://gpu:8091/v1", apiKey: "{env:GPU_API_KEY}" }, models: { strata: { name: "llamacpp/strata" } } },
      pool: { options: { baseURL: "http://mac:1235/v1", apiKey: "{env:MAC_API_KEY}" }, models: { local: { id: "qwen" } } },
    });
  });

  it("engine and quota pools: one LiteLLM endpoint serves both, and a pool behind another endpoint is flagged", () => {
    const jd = [
      { id: "litellm", name: "LiteLLM", type: "litellm" as const, baseUrl: "https://proxy.example.com", prefix: "litellm/" },
      { id: "zen", name: "OpenCode Zen", type: "opencode" as const, prefix: "opencode/" },
      { id: "mbp", name: "MBP", type: "omlx" as const, baseUrl: "http://mac:1235", reachVia: "litellm", reachModel: "litellm/mbp" },
      { id: "ct118", name: "CT118", type: "llamacpp" as const, baseUrl: "http://gpu:8091", reachVia: "litellm", reachModel: "litellm/vm" },
    ];
    const r = harnessConfig([
      pool("local", { kind: "engine", engines: [{ engine: "mbp" }, { engine: "ct118" }], patterns: [] }),
      pool("free", { kind: "quota", backend: "litellm", patterns: ["litellm/free"] }),
      pool("direct-free", { kind: "quota", backend: "zen", patterns: ["opencode/beam-free"] }),
    ], jd);
    expect(r.provider).toEqual({
      pool: {
        npm: "@ai-sdk/openai-compatible", name: "Model capacity pools",
        options: { baseURL: "https://proxy.example.com/v1", apiKey: "{env:LITELLM_API_KEY}" },
        models: {
          local: { name: "local (model capacity pool)", id: "mbp", limit: { context: 131072, output: 8192 } },
          free: { name: "free (model capacity pool)", id: "free", limit: { context: 131072, output: 8192 } },
        },
      },
    });
    expect(r.warnings[0]).toContain("direct-free goes through OpenCode Zen");
  });

  it("an engine reached directly gets its own provider, and the fallback can go straight to it", () => {
    const r = harnessConfig([pool("local", { kind: "engine", engines: [{ engine: "mac" }], patterns: [] })], [
      { id: "mac", name: "Mac", type: "omlx" as const, baseUrl: "http://mac:1235", prefix: "omlx/", reachVia: "direct", reachModel: "omlx/qwen" },
    ]);
    expect(r.provider).toMatchObject({
      omlx: { options: { baseURL: "http://mac:1235/v1" }, models: { qwen: { name: "omlx/qwen" } } },
      pool: { options: { baseURL: "http://mac:1235/v1", apiKey: "{env:MAC_API_KEY}" }, models: { local: { id: "qwen" } } },
    });
  });
});

