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
});
