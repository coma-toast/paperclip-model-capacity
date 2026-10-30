import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import { loadScopedPools, resolvePool } from "../src/pools.js";
import { createStore } from "../src/state/store.js";
import type { PoolConfig } from "../src/types.js";

const pool = (patch: Partial<PoolConfig>): PoolConfig => ({
  id: "p", name: "P", patterns: ["litellm/a"], limit: 1, privacy: "private", mode: "observe", hosts: [], alertAfterMinutes: 30, scope: "instance", ...patch,
});

describe("loadScopedPools", () => {
  it("reads backends only for companies whose pools use one", async () => {
    const store = createStore(createTestHarness({ manifest }).ctx.state);
    await store.companyPools("with").set([pool({ backend: "proxy" })]);
    await store.companyPools("legacy").set([pool({ api: "litellm" })]);
    const asked: string[] = [];
    const pools = await loadScopedPools(store, ["with", "legacy", "none"], async (id) => {
      asked.push(id);
      return [{ id: "proxy", name: "Proxy", type: "litellm", baseUrl: "https://p" }];
    });
    expect(asked).toEqual(["with"]);
    expect(pools.find((p) => p.id === "with:p")?.patterns).toEqual(["litellm/a", "pool/p"]);
    expect(pools.map((p) => [p.id, p.api])).toEqual([["with:p", "litellm"], ["legacy:p", "litellm"]]);
  });
});

describe("resolvePool", () => {
  const backends = [
    { id: "proxy", name: "Proxy", type: "litellm" as const, baseUrl: "https://p" },
    { id: "gpu", name: "GPU", type: "llamacpp" as const, baseUrl: "http://gpu:8080", slots: 1 },
    { id: "mac", name: "Mac", type: "omlx" as const, baseUrl: "http://mac:1235", slots: 4 },
  ];
  it("sets the limit to the engines' total slots when the pool matches its engines, and leaves it otherwise", () => {
    expect(resolvePool(pool({ backend: "proxy", watch: ["gpu", "mac"], limit: 2, limitFromEngines: true }), backends).limit).toBe(5);
    expect(resolvePool(pool({ backend: "proxy", watch: ["gpu", "mac"], limit: 2 }), backends).limit).toBe(2);
    expect(resolvePool(pool({ backend: "proxy", limit: 2, limitFromEngines: true }), backends).limit).toBe(2);
  });

  it("resolves a sticky pool's engines to hosts it also watches", () => {
    const r = resolvePool(pool({ backend: "proxy", patterns: ["litellm/local", "litellm/mbp", "litellm/vm"], sticky: [{ model: "litellm/mbp", engine: "mac" }, { model: "litellm/vm", engine: "gpu" }] }), backends);
    expect(r.placement).toEqual([{ model: "litellm/mbp", hostId: "backend~mac" }, { model: "litellm/vm", hostId: "backend~gpu" }]);
    expect(r.hosts.map((h) => h.id)).toEqual(["backend~mac", "backend~gpu"]);
  });
});
