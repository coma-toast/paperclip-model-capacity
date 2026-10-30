import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { registerApi } from "../src/api.js";
import manifest from "../src/manifest.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});
const agent = (id: string, model: string) => ({ id, companyId: "c1", name: id, status: "idle", adapterConfig: { model } }) as unknown as Agent;

describe("agents on a pool", () => {
  it("lists agents with models and says which pool an agent is on", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "agents.read"] });
    harness.seed({ agents: [agent("ada", "l/local"), agent("bo", "l/vm")] });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(runtime);
    registerApi(harness.ctx, runtime);
    await runtime.store.companyPools("c1").set([{ id: "local", name: "Local", backend: "proxy", patterns: ["l/local", "l/vm"], agentModel: "l/local", limit: 4, privacy: "private", mode: "enforce", hosts: [], alertAfterMinutes: 30, scope: "instance" }]);
    expect(await harness.getData("agents", { companyId: "c1" })).toEqual({ agents: [{ id: "ada", name: "ada", model: "l/local" }, { id: "bo", name: "bo", model: "l/vm" }] });
    expect(await harness.getData("agent-pool", { companyId: "c1", agentId: "ada" })).toMatchObject({ model: "l/local", currentPoolId: "local", pools: [{ id: "local", agentModel: "l/local" }] });
    expect(await harness.getData("agent-pool", { companyId: "c1", agentId: "bo" })).toMatchObject({ model: "l/vm", currentPoolId: undefined });
  });
});
