import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import { loadScopedPools } from "../src/pools.js";
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
    expect(pools.map((p) => [p.id, p.api])).toEqual([["with:p", "litellm"], ["legacy:p", "litellm"]]);
  });
});
