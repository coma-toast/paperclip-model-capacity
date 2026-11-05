import { describe, expect, it } from "vitest";

import { convertPools } from "../src/convert.js";
import type { PoolConfig } from "../src/types.js";

const pool = (over: Partial<PoolConfig>): PoolConfig => ({
  id: "p", name: "P", patterns: [], limit: 1, privacy: "private", mode: "enforce", scope: "instance", hosts: [], alertAfterMinutes: 30, ...over,
});

describe("convertPools (P2.7.4)", () => {
  it("turns a pool that pinned engines into an engine pool and the rest into quota pools, once", () => {
    const local = pool({
      id: "local", name: "Local", backend: "litellm", patterns: ["litellm/mbp", "litellm/vm"], watch: ["mbp", "ct118"], limitFromEngines: true, disabled: true,
      sticky: [{ model: "litellm/mbp", engine: "mbp" }, { model: "litellm/vm", engine: "ct118" }], agentModel: "pool/local",
    });
    const free = pool({ id: "free", name: "free", backend: "litellm", patterns: ["litellm/free"], limit: 4, privacy: "shared" });
    const { pools, converted } = convertPools([local, free]);
    expect(converted).toBe(true);
    expect(pools[0]).toEqual({
      id: "local", name: "Local", privacy: "private", mode: "enforce", scope: "instance", hosts: [], alertAfterMinutes: 30, disabled: true,
      kind: "engine", engines: [{ engine: "mbp" }, { engine: "ct118" }], patterns: [], limit: 0, agentModel: "pool/local",
    });
    expect(pools[1]).toMatchObject({ id: "free", kind: "quota", backend: "litellm", patterns: ["litellm/free"], limit: 4, privacy: "shared", agentModel: "pool/free" });
    expect(convertPools(pools).converted).toBe(false);
  });
});
