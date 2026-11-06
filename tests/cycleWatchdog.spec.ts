import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const runtimes: Runtime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((r) => r.stop())); });

describe("cycle watchdog", () => {
  it("abandons a cycle stuck on a call that never returns, names the step, and runs the next one", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    let calls = 0;
    const readRuns = async () => {
      calls += 1;
      if (calls === 1) await new Promise(() => {});
      return [];
    };
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, debounceMs: 10_000, readRuns, cycleTimeoutMs: 50 });
    runtimes.push(runtime);
    await runtime.store.companies.set([{ id: "c1", name: "c1" }]);
    await runtime.cycle("first");
    expect(runtime.health().lastError).toBe("cycle stuck 0 s at: building the snapshot");
    await runtime.cycle("second");
    expect(runtime.health()).toMatchObject({ lastError: undefined });
    expect(runtime.health().lastCycleAt).toBeDefined();
    expect(calls).toBe(2);
  });
});

describe("sweep timer", () => {
  it("starts cycles on its own when no cycle has run for a while", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    let calls = 0;
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, usageIntervalMs: 0, debounceMs: 10_000, readRuns: async () => { calls += 1; return []; }, sweepIntervalMs: 40 });
    runtimes.push(runtime);
    await runtime.store.companies.set([{ id: "c1", name: "c1" }]);
    runtime.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBeGreaterThan(0);
    expect(runtime.health().lastCycleAt).toBeDefined();
  });
});
