import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Company, Issue } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { registerApi, type PoolSummary, type QueueRow } from "../src/api.js";
import manifest from "../src/manifest.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { validatePools } from "../src/settings.js";
import { NOW, minutesAgo } from "./fixtures/snapshot.js";

const raw = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, patterns: [`${id}/*`], limit: 1, privacy: "shared", ...over });
// Valid pools for seeding state; throws if the fixture itself is invalid.
const pools = (...input: unknown[]) => {
  const r = validatePools(input);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.pools;
};
const fields = (input: unknown) => {
  const r = validatePools(input);
  return r.ok ? [] : r.errors.map((e) => e.field);
};

describe("validatePools (A7, A9, A10)", () => {
  it("accepts a valid config and fills safe defaults", () => {
    const r = validatePools([raw("gpu", { hosts: [{ id: "h1", name: "gpu box", engine: "llamacpp", baseUrl: "http://gpu:8091" }] })]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pools[0]).toMatchObject({ mode: "observe", scope: "instance", alertAfterMinutes: 30, hosts: [{ declaredSlots: 1 }] });
  });

  it("rejects private-to-shared overflow, naming the field (AC5 part 1)", () => {
    const r = validatePools([raw("gpu", { privacy: "private", overflow: { pools: ["free"] } }), raw("free")]);
    expect(r).toEqual({ ok: false, errors: [{ field: "pools[0].overflow.pools[0]", message: 'Private pool "gpu" can\'t overflow to shared pool "free"' }] });
  });

  it("allows private-to-private and shared-to-anything overflow", () => {
    expect(fields([raw("gpu", { privacy: "private", overflow: { pools: ["laptop"] } }), raw("laptop", { privacy: "private" })])).toEqual([]);
    expect(fields([raw("free", { overflow: { pools: ["gpu"] } }), raw("gpu", { privacy: "private" })])).toEqual([]);
  });

  it("rejects overlapping pool names and ids, ignoring case", () => {
    expect(fields([raw("gpu", { name: "GPU" }), raw("other", { name: "gpu" })])).toEqual(["pools[1].name"]);
    expect(fields([raw("gpu"), raw("GPU", { name: "second" })])).toEqual(["pools[1].id"]);
  });

  it("rejects a negative or fractional limit", () => {
    expect(fields([raw("gpu", { limit: -1 })])).toEqual(["pools[0].limit"]);
    expect(fields([raw("gpu", { limit: 1.5 })])).toEqual(["pools[0].limit"]);
    expect(fields([raw("gpu", { limit: 0 })])).toEqual([]);
  });

  it("rejects unknown fields, bad enums, missing patterns and bad hosts", () => {
    expect(fields([raw("gpu", { colour: "red", mode: "fast", patterns: [], hosts: [{ id: "h", name: "h", engine: "tgi", baseUrl: "ftp://x", declaredSlots: 0 }] })])).toEqual([
      "pools[0].colour", "pools[0].patterns", "pools[0].mode", "pools[0].hosts[0].engine", "pools[0].hosts[0].baseUrl", "pools[0].hosts[0].declaredSlots",
    ]);
  });

  it("rejects duplicate host ids across pools, unknown overflow targets and self-overflow", () => {
    const h = { id: "h1", name: "h", engine: "openai", baseUrl: "http://h" };
    expect(fields([raw("a", { hosts: [h] }), raw("b", { hosts: [h] })])).toEqual(["pools[1].hosts[0].id"]);
    expect(fields([raw("a", { overflow: { pools: ["nope", "a"] } })])).toEqual(["pools[0].overflow.pools[0]", "pools[0].overflow.pools[1]"]);
  });

  it("rejects something that isn't a list", () => {
    expect(fields({ gpu: {} })).toEqual(["pools"]);
  });
});

describe("board actions and data handlers", () => {
  const runtimes: Runtime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  });
  const user = { actor: { type: "user" as const, userId: "u1" } };

  const setup = async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      companies: [{ id: "c1", name: "c1" } as unknown as Company],
      agents: [{ id: "a1", companyId: "c1", name: "a1", status: "idle", adapterConfig: { model: "gpu/m" } } as unknown as Agent],
      issues: ["t1", "t2"].map((id) => ({ id, identifier: `JD-${id}`, companyId: "c1", title: `Task ${id}`, status: "todo", priority: "medium", assigneeAgentId: "a1", labelIds: [] }) as unknown as Issue),
    });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, debounceMs: 10_000, readRuns: async () => [] });
    runtimes.push(runtime);
    await runtime.store.companies.set([{ id: "c1", name: "c1" }]);
    registerApi(harness.ctx, runtime, () => new Date(NOW));
    return { harness, runtime, store: runtime.store };
  };

  it("refuses agents and system callers (A6)", async () => {
    const { harness, store } = await setup();
    for (const actor of [{ type: "agent" as const, agentId: "a1" }, { type: "system" as const }]) {
      expect(await harness.performAction("save-pools", { pools: [raw("gpu")] }, { actor })).toEqual({ ok: false, error: "Only board users can change model capacity settings" });
    }
    expect(await store.pools.get()).toEqual([]);
  });

  it("save-pools stores a valid config and returns field errors otherwise", async () => {
    const { harness, store } = await setup();
    expect(await harness.performAction("save-pools", { pools: [raw("gpu", { limit: -2 })] }, user)).toEqual({ ok: false, errors: [{ field: "pools[0].limit", message: "Must be a whole number, 0 or more" }] });
    expect(await harness.performAction("save-pools", { pools: [raw("gpu")] }, user)).toEqual({ ok: true });
    expect((await store.pools.get())[0]).toMatchObject({ id: "gpu", mode: "observe" });
  });

  it("set-limit, hold-pool and resume-pool change state", async () => {
    const { harness, store } = await setup();
    await harness.performAction("save-pools", { pools: [raw("gpu")] }, user);
    expect(await harness.performAction("set-limit", { poolId: "gpu", limit: -1 }, user)).toMatchObject({ ok: false });
    await harness.performAction("set-limit", { poolId: "gpu", limit: 3 }, user);
    expect((await store.pools.get())[0].limit).toBe(3);
    await harness.performAction("hold-pool", { poolId: "gpu" }, user);
    expect(await store.heldPools.get()).toEqual(["gpu"]);
    await harness.performAction("resume-pool", { poolId: "gpu" }, user);
    expect(await store.heldPools.get()).toEqual([]);
  });

  it("release-now releases a held task past the limit and logs who did it (F1)", async () => {
    const { harness, store, runtime } = await setup();
    await store.pools.set(pools(raw("gpu", { mode: "enforce", limit: 0 })));
    await runtime.cycle("sweep");
    expect(Object.keys(await store.holds.get()).sort()).toEqual(["t1", "t2"]);
    expect(await harness.performAction("release-now", { issueId: "t1" }, user)).toEqual({ ok: true });
    expect(Object.keys(await store.holds.get())).toEqual(["t2"]);
    expect((await store.released.get()).t1.runId).toBeTruthy();
    expect(harness.activity.at(-1)).toMatchObject({ entityId: "t1", metadata: { userId: "u1" } });
  });

  it("move-to-front puts a task first; exempt records agents and tasks", async () => {
    const { harness, store } = await setup();
    await store.holds.set({
      t1: { issueId: "t1", companyId: "c1", poolId: "gpu", priority: "high", heldAt: minutesAgo(30) },
      t2: { issueId: "t2", companyId: "c1", poolId: "gpu", priority: "low", heldAt: minutesAgo(5) },
    });
    await harness.performAction("move-to-front", { issueId: "t2" }, user);
    const queue = await harness.getData<{ rows: QueueRow[] }>("queue");
    expect(queue.rows.map((r) => [r.issueId, r.position, r.identifier])).toEqual([["t2", 1, "JD-t2"], ["t1", 2, "JD-t1"]]);
    await harness.performAction("exempt", { agentId: "a1" }, user);
    await harness.performAction("exempt", { issueId: "t1" }, user);
    await harness.performAction("exempt", { issueId: "t1", exempt: false }, user);
    expect(await store.exemptions.get()).toEqual({ agentIds: ["a1"], issueIds: [] });
  });

  it("capacity-summary reports use, queue, oldest wait, hosts and alerts per pool", async () => {
    const { harness, store } = await setup();
    await store.pools.set(pools(raw("gpu", { hosts: [{ id: "h1", name: "box", engine: "llamacpp", baseUrl: "http://box" }] })));
    await store.hosts.set({ h1: { hostId: "h1", up: true, consecutiveFailures: 0, consecutiveSuccesses: 2, slotsTotal: 2, slotsBusy: 0 } });
    await store.holds.set({ t1: { issueId: "t1", companyId: "c1", poolId: "gpu", priority: "medium", heldAt: minutesAgo(10) } });
    await store.alerts.set({ active: { "overLimit:gpu": { kind: "overLimit", subject: "gpu", state: "start", message: "m", at: NOW, poolId: "gpu" } }, recent: [] });
    const summary = await harness.getData<{ pools: PoolSummary[] }>("capacity-summary");
    expect(summary.pools).toEqual([expect.objectContaining({ id: "gpu", mode: "observe", limit: 1, available: 1, inUse: 0, queued: 1, oldestWaitSeconds: 600, openAlerts: 1, hosts: [expect.objectContaining({ id: "h1", up: true, slotsTotal: 2 })] })]);
  });
});
