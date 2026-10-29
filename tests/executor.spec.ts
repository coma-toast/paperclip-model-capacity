import { describe, expect, it } from "vitest";
import type { Issue, PluginCapability } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { QUEUE_ORIGIN_KIND, createExecutor } from "../src/executor.js";
import manifest from "../src/manifest.js";
import { createStore } from "../src/state/store.js";
import type { Action, Snapshot } from "../src/types.js";
import { NOW, minutesAgo, pool, run, snapshot, task } from "./fixtures/snapshot.js";

const CAPS: PluginCapability[] = [
  ...manifest.capabilities, "issues.read", "issues.create", "issues.update", "issues.wakeup",
  "issue.relations.read", "issue.relations.write", "issue.comments.read", "issue.comments.create", "activity.log.write",
];
const issue = (id: string, over: Partial<Issue> = {}) =>
  ({ id, companyId: "c1", title: id, status: "todo", priority: "medium", assigneeAgentId: "a1", labelIds: [], ...over }) as unknown as Issue;

const setup = (mode: "observe" | "enforce" = "enforce", opts: { label?: string; seconds?: number } = {}) => {
  const harness = createTestHarness({ manifest, capabilities: CAPS });
  harness.seed({ issues: [issue("t1"), issue("t2")] });
  const store = createStore(harness.ctx.state);
  const now = new Date(Date.parse(NOW) + (opts.seconds ?? 0) * 1000);
  const exec = createExecutor({ ctx: harness.ctx, store, queueLabelId: async () => opts.label, now });
  const snap: Snapshot = snapshot({ pools: [pool("gpu", { mode })], tasks: [task("t1"), task("t2")] });
  return { harness, store, exec, snap, ctx: harness.ctx };
};

const holdAction = (issueId: string, position = 1): Action => ({ kind: "hold", issueId, companyId: "c1", poolId: "gpu", position });
const releaseAction = (issueId: string): Action => ({ kind: "release", issueId, companyId: "c1", poolId: "gpu", reason: "capacity" });
const blockerIds = async (ctx: ReturnType<typeof setup>["ctx"], issueId: string) => (await ctx.issues.relations.get(issueId, "c1")).blockedBy.map((b) => b.id);

describe("hold", () => {
  it("creates one queue blocker, blocks the task, labels it and comments once", async () => {
    const { ctx, exec, store, snap } = setup("enforce", { label: "lbl-queue" });
    await exec.execute([holdAction("t1", 1), holdAction("t2", 2)], snap);
    const blockerId = (await store.queueBlockers("c1").get()).gpu;
    const blocker = await ctx.issues.get(blockerId, "c1");
    expect(blocker).toMatchObject({ title: "gpu queue", status: "todo", originKind: QUEUE_ORIGIN_KIND, originId: "gpu" });
    expect(await blockerIds(ctx, "t1")).toEqual([blockerId]);
    expect(await blockerIds(ctx, "t2")).toEqual([blockerId]);
    expect((await ctx.issues.get("t1", "c1"))?.labelIds).toEqual(["lbl-queue"]);
    expect((await ctx.issues.listComments("t2", "c1")).map((c) => c.body)).toEqual(["Waiting for gpu (position 2). Model capacity plugin."]);
    expect(await store.holds.get()).toMatchObject({ t1: { poolId: "gpu", position: 1, blockerId }, t2: { position: 2 } });
  });

  it("doesn't comment again when an existing hold's position changes", async () => {
    const { ctx, exec, store, snap } = setup();
    await exec.execute([holdAction("t1", 2)], snap);
    await exec.execute([holdAction("t1", 1)], snap);
    expect(await ctx.issues.listComments("t1", "c1")).toHaveLength(1);
    expect((await store.holds.get()).t1.position).toBe(1);
  });
});

describe("release", () => {
  it("removes the blocker and label, wakes the task and records the run", async () => {
    const { ctx, exec, store, snap } = setup("enforce", { label: "lbl-queue" });
    await exec.execute([holdAction("t1")], snap);
    await exec.execute([releaseAction("t1")], snap);
    expect(await blockerIds(ctx, "t1")).toEqual([]);
    expect((await ctx.issues.get("t1", "c1"))?.labelIds).toEqual([]);
    expect(await store.holds.get()).toEqual({});
    const released = (await store.released.get()).t1;
    expect(released.runId).toMatch(/[0-9a-f-]{36}/);
    expect(released.poolId).toBe("gpu");
  });

  it("never closes the queue blocker", async () => {
    const { ctx, exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    await exec.execute([releaseAction("t1")], snap);
    const blocker = await ctx.issues.get((await store.queueBlockers("c1").get()).gpu, "c1");
    expect(blocker?.status).toBe("todo");
  });

  it("records a failed wake as unapplied and keeps going", async () => {
    const { harness, exec, store, snap } = setup();
    harness.seed({ issues: [issue("t1", { assigneeAgentId: null })] });
    const entries = await exec.execute([releaseAction("t1"), holdAction("t2")], snap);
    expect(entries.map((e) => e.applied)).toEqual([false, true]);
    expect(await store.released.get()).toEqual({});
    expect(harness.logs.some((l) => l.message === "Model capacity action failed")).toBe(true);
  });
});

describe("observe mode (C6)", () => {
  it("writes nothing to tasks and records the decision in history", async () => {
    const { ctx, exec, store, snap } = setup("observe");
    const entries = await exec.execute([holdAction("t1"), releaseAction("t2")], snap);
    expect(entries.map((e) => e.applied)).toEqual([false, false]);
    expect(await blockerIds(ctx, "t1")).toEqual([]);
    expect(await ctx.issues.listComments("t1", "c1")).toEqual([]);
    expect(await store.queueBlockers("c1").get()).toEqual({});
    expect(await store.holds.get()).toEqual({});
    expect((await store.history(NOW.slice(0, 10))).map((e) => e.action.kind)).toEqual(["hold", "release"]);
  });
});

describe("history dedupe", () => {
  it("records an observe-mode decision once while it repeats, and again after it stops and comes back", async () => {
    const { exec, store, snap } = setup("observe");
    for (let i = 0; i < 3; i++) await exec.execute([holdAction("t1")], snap);
    await exec.execute([], snap);
    await exec.execute([holdAction("t1")], snap);
    expect((await store.history(NOW.slice(0, 10))).map((e) => e.action.kind)).toEqual(["hold", "hold"]);
  });

  it("still records every applied action", async () => {
    const { exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    await exec.execute([releaseAction("t1")], snap);
    await exec.execute([holdAction("t1")], snap);
    expect((await store.history(NOW.slice(0, 10))).map((e) => [e.action.kind, e.applied])).toEqual([["hold", true], ["release", true], ["hold", true]]);
  });
});

describe("blocker recreation (C1a)", () => {
  it("recreates a blocker closed as done and re-points held tasks", async () => {
    const { ctx, harness, exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    const oldId = (await store.queueBlockers("c1").get()).gpu;
    harness.seed({ issues: [{ ...(await ctx.issues.get(oldId, "c1"))!, status: "done" } as Issue] });
    await exec.execute([holdAction("t2", 2)], snap);
    const newId = (await store.queueBlockers("c1").get()).gpu;
    expect(newId).not.toBe(oldId);
    expect(await blockerIds(ctx, "t1")).toEqual([newId]);
    expect(await blockerIds(ctx, "t2")).toEqual([newId]);
    expect((await store.holds.get()).t1.blockerId).toBe(newId);
  });

  it("recreates a blocker that was deleted", async () => {
    const { exec, store, snap } = setup();
    await store.queueBlockers("c1").set({ gpu: "gone" });
    await exec.execute([holdAction("t1")], snap);
    expect((await store.queueBlockers("c1").get()).gpu).not.toBe("gone");
  });
});

describe("manual changes win (C5, C7)", () => {
  it("drops a hold whose blocker a person removed, and logs it", async () => {
    const { ctx, harness, exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    const blockerId = (await store.queueBlockers("c1").get()).gpu;
    await ctx.issues.relations.removeBlockers("t1", [blockerId], "c1");
    await exec.reconcileHolds(snap);
    expect(await store.holds.get()).toEqual({});
    expect(harness.activity.map((a) => a.message)).toEqual(["Model capacity: left the gpu queue (queue blocker removed by a person)"]);
  });

  it("drops a hold whose task closed", async () => {
    const { exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    await exec.reconcileHolds({ ...snap, tasks: snap.tasks.filter((t) => t.issueId !== "t1") });
    expect(await store.holds.get()).toEqual({});
  });

  it("keeps a hold that is still in place", async () => {
    const { exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    await exec.reconcileHolds(snap);
    expect(Object.keys(await store.holds.get())).toEqual(["t1"]);
  });
});

describe("wake confirmation (C3)", () => {
  const seedReleased = async (store: ReturnType<typeof setup>["store"], at: string, over = {}) =>
    store.released.set({ t1: { issueId: "t1", companyId: "c1", poolId: "gpu", runId: "r-old", releasedAt: at, ...over } });

  it("forgets a released task once its run shows up", async () => {
    const { exec, store, snap } = setup();
    await seedReleased(store, minutesAgo(0));
    await exec.confirmWakes({ ...snap, runs: [run("t1")] });
    expect(await store.released.get()).toEqual({});
  });

  it("wakes once more after 30 s with no run, then not again", async () => {
    const { exec, store, snap } = setup("enforce", { seconds: 40 });
    await seedReleased(store, NOW);
    await exec.confirmWakes(snap);
    const after = (await store.released.get()).t1;
    expect(after.wakeRetried).toBe(true);
    expect(after.runId).not.toBe("r-old");
    await exec.confirmWakes(snap);
    expect((await store.released.get()).t1.runId).toBe(after.runId);
  });

  it("stops counting a released task whose run never appears", async () => {
    const { exec, store, snap } = setup("enforce", { seconds: 6 * 60 });
    await seedReleased(store, NOW, { wakeRetried: true });
    await exec.confirmWakes(snap);
    expect(await store.released.get()).toEqual({});
  });
});
