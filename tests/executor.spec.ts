import { describe, expect, it } from "vitest";
import type { Agent, Issue, PluginCapability } from "@paperclipai/plugin-sdk";
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

  it("drops a hold whose task left the pool, and takes our blocker off it", async () => {
    const { ctx, exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    const blockerId = (await store.queueBlockers("c1").get()).gpu;
    await exec.reconcileHolds({ ...snap, tasks: snap.tasks.filter((t) => t.issueId !== "t1") });
    expect(await store.holds.get()).toEqual({});
    expect((await ctx.issues.relations.get("t1", "c1")).blockedBy.map((b) => b.id)).not.toContain(blockerId);
  });

  it("keeps a hold that is still in place", async () => {
    const { exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    await exec.reconcileHolds(snap);
    expect(Object.keys(await store.holds.get())).toEqual(["t1"]);
  });

  it("frees and wakes a task whose pool was removed, then cancels that pool's queue task", async () => {
    const { ctx, exec, store, snap, harness } = setup("enforce", { label: "lbl-queue" });
    await exec.execute([holdAction("t1")], snap);
    const blockerId = (await store.queueBlockers("c1").get()).gpu;
    await exec.reconcileHolds({ ...snap, pools: [pool("other", { companyId: "c1" })] });
    expect(await store.holds.get()).toEqual({});
    expect(await blockerIds(ctx, "t1")).toEqual([]);
    expect((await ctx.issues.get("t1", "c1"))?.labelIds).toEqual([]);
    expect(harness.activity.map((a) => a.message)).toContain("Model capacity: left the gpu queue (its pool was removed)");
    expect((await ctx.issues.get(blockerId, "c1"))?.status).toBe("cancelled");
    expect(await store.queueBlockers("c1").get()).toEqual({});
  });

  it("keeps the queue of a pool the snapshot missed but the saved config still lists", async () => {
    const { exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    await store.companyPools("c1").set([pool("gpu")]);
    await exec.reconcileHolds({ ...snap, pools: [] });
    expect(Object.keys(await store.holds.get())).toEqual(["t1"]);
    expect(Object.keys(await store.queueBlockers("c1").get())).toEqual(["gpu"]);
  });

  it("moves a waiting task to another pool: new model, that pool's queue, same place in line", async () => {
    const { ctx, exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    const before = (await store.holds.get()).t1;
    await store.overrides.set({ t1: { issueId: "t1", agentId: "a1", model: "gpu/a", original: null, fromPoolId: "gpu", toPoolId: "gpu", at: NOW } });
    await exec.moveToPool("t1", "c1", pool("cpu", { agentModel: "pool/cpu" }));
    const after = (await store.holds.get()).t1;
    const cpuBlocker = (await store.queueBlockers("c1").get()).cpu;
    expect(after).toMatchObject({ poolId: "cpu", blockerId: cpuBlocker, heldAt: before.heldAt });
    expect(await blockerIds(ctx, "t1")).toEqual([cpuBlocker]);
    expect((await ctx.issues.get("t1", "c1"))?.assigneeAdapterOverrides?.adapterConfig?.model).toBe("pool/cpu");
    expect(await store.overrides.get()).toEqual({});
  });

  it("applies queued moves from board users, drops them once tried, and returns the ones that failed", async () => {
    const { ctx, exec, store, snap } = setup("enforce");
    await exec.execute([holdAction("t1")], snap);
    await store.pendingMoves.set({
      t1: { issueId: "t1", companyId: "c1", poolId: "cpu", userId: "u1", at: NOW },
      t2: { issueId: "t2", companyId: "c1", poolId: "cpu", userId: "u1", at: NOW },
    });
    const failed = await exec.applyPendingMoves(async () => [pool("cpu", { agentModel: "pool/cpu" })]);
    expect((await store.holds.get()).t1.poolId).toBe("cpu");
    expect((await ctx.issues.get("t1", "c1"))?.assigneeAdapterOverrides?.adapterConfig?.model).toBe("pool/cpu");
    expect(failed).toEqual([{ issueId: "t2", companyId: "c1", message: "That task isn't waiting" }]);
    expect(await store.pendingMoves.get()).toEqual({});
  });

  it("refuses to move a task that isn't waiting", async () => {
    const { exec } = setup();
    await expect(exec.moveToPool("t2", "c1", pool("cpu", { agentModel: "pool/cpu" }))).rejects.toThrow("isn't waiting");
  });

  it("cancels an older copy of a routine still waiting in the queue, keeping the newest", async () => {
    const { ctx, exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    const copies = {
      ...snap,
      tasks: [
        task("t1", { routineKey: "r1|fp", createdAt: "2026-11-01T13:00:00.000Z" }),
        task("t2", { routineKey: "r1|fp", createdAt: "2026-11-02T17:00:00.000Z" }),
      ],
    };
    await exec.retireStaleRoutineCopies(copies);
    expect((await ctx.issues.get("t1", "c1"))?.status).toBe("cancelled");
    expect((await ctx.issues.get("t2", "c1"))?.status).not.toBe("cancelled");
    expect(await store.holds.get()).toEqual({});
    expect(await blockerIds(ctx, "t1")).toEqual([]);
  });

  it("leaves routine copies alone when the older one has a run or isn't held", async () => {
    const { ctx, exec, snap } = setup();
    await exec.retireStaleRoutineCopies({
      ...snap,
      tasks: [task("t1", { routineKey: "r1|fp", createdAt: "2026-11-01T13:00:00.000Z" }), task("t2", { routineKey: "r1|fp", createdAt: "2026-11-02T17:00:00.000Z" })],
    });
    expect((await ctx.issues.get("t1", "c1"))?.status).toBe("todo");
  });

  it("keeps the queue of a company the snapshot skipped", async () => {
    const { exec, store, snap } = setup();
    await exec.execute([holdAction("t1")], snap);
    const diagnostics = { runSource: "heartbeat_runs" as const, activeRunRows: 0, unmatchedRunModels: [], runsWithoutAgent: 0, skippedCompanies: ["c1"] };
    await exec.reconcileHolds({ ...snap, pools: [], diagnostics });
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

describe("placement (P2.6)", () => {
  const placeAction = (issueId: string, model: string): Action => ({ kind: "place", issueId, companyId: "c1", poolId: "c1:gpu", model, reason: "new" });
  const setupSticky = () => {
    const harness = createTestHarness({ manifest, capabilities: CAPS });
    harness.seed({ issues: [issue("t1", { assigneeAdapterOverrides: { useProjectWorkspace: true } } as Partial<Issue>), issue("t2")] });
    const store = createStore(harness.ctx.state);
    const exec = createExecutor({ ctx: harness.ctx, store, queueLabelId: async () => undefined, now: new Date(NOW) });
    const snap: Snapshot = snapshot({ pools: [pool("c1:gpu", { mode: "enforce" })], tasks: [task("t1", { poolId: "c1:gpu" }), task("t2", { poolId: "c1:gpu" })] });
    return { ctx: harness.ctx, store, exec, snap };
  };

  it("sets the task's model override, keeps its other override keys, and records it as the plugin's", async () => {
    const { ctx, store, exec, snap } = setupSticky();
    await exec.execute([placeAction("t1", "l/mbp")], snap);
    expect((await ctx.issues.get("t1", "c1"))?.assigneeAdapterOverrides).toEqual({ useProjectWorkspace: true, adapterConfig: { model: "l/mbp" } });
    expect((await store.overrides.get()).t1).toMatchObject({ model: "l/mbp", original: { useProjectWorkspace: true }, fromPoolId: "c1:gpu", toPoolId: "c1:gpu" });
  });

  it("undoes a placement once the task is done, but not while it's still open", async () => {
    const { ctx, store, exec, snap } = setupSticky();
    await exec.execute([placeAction("t1", "l/mbp")], snap);
    await exec.clearPlacements({ ...snap, tasks: [] });
    expect(Object.keys(await store.overrides.get())).toEqual(["t1"]);
    await ctx.issues.update("t1", { status: "done" }, "c1");
    await exec.clearPlacements({ ...snap, tasks: [] });
    expect(await store.overrides.get()).toEqual({});
    expect((await ctx.issues.get("t1", "c1"))?.assigneeAdapterOverrides).toEqual({ useProjectWorkspace: true });
  });

  it("only records a placement in observe mode", async () => {
    const { ctx, store, exec, snap } = setupSticky();
    await exec.execute([placeAction("t2", "l/vm")], { ...snap, pools: [pool("c1:gpu", { mode: "observe" })] });
    expect((await ctx.issues.get("t2", "c1"))?.assigneeAdapterOverrides ?? null).toBeNull();
    expect(await store.overrides.get()).toEqual({});
  });
});

describe("release puts a held task's status back", () => {
  it("sets a task left blocked by the hold back to its status from before, and wakes it", async () => {
    const { ctx, exec, store, snap } = setup("enforce");
    await exec.execute([holdAction("t1")], snap);
    expect((await store.holds.get()).t1.statusBefore).toBe("todo");
    await ctx.issues.update("t1", { status: "blocked" }, "c1");
    await exec.execute([releaseAction("t1")], snap);
    expect((await ctx.issues.get("t1", "c1"))?.status).toBe("todo");
    expect(Object.keys(await store.released.get())).toEqual(["t1"]);
  });

  it("leaves a task blocked by something else blocked, and reserves no slot when no run starts", async () => {
    const { ctx, exec, store, snap } = setup("enforce");
    await exec.execute([holdAction("t1")], snap);
    await ctx.issues.relations.addBlockers("t1", ["t2"], "c1");
    await ctx.issues.update("t1", { status: "blocked" }, "c1");
    (ctx.issues as { requestWakeup: unknown }).requestWakeup = async () => ({ queued: false });
    await exec.execute([releaseAction("t1")], snap);
    expect((await ctx.issues.get("t1", "c1"))?.status).toBe("blocked");
    expect(await store.released.get()).toEqual({});
    expect(Object.keys(await store.holds.get())).toEqual(["t1"]);
    expect(Object.keys(await store.wakeCooldown.get())).toEqual(["t1"]);
  });

  it("puts the hold back without a new comment and skips the task for a while when its wake-up starts no run", async () => {
    const { ctx, exec, store, snap } = setup("enforce");
    await exec.execute([holdAction("t1")], snap);
    (ctx.issues as { requestWakeup: unknown }).requestWakeup = async () => ({ queued: false });
    const comments = (await ctx.issues.listComments("t1", "c1")).length;
    await exec.execute([releaseAction("t1")], snap);
    expect((await store.holds.get()).t1).toBeDefined();
    expect((await ctx.issues.relations.get("t1", "c1")).blockedBy).toHaveLength(1);
    expect((await ctx.issues.listComments("t1", "c1")).length).toBe(comments);
    expect(Date.parse((await store.wakeCooldown.get()).t1)).toBeGreaterThan(Date.parse(NOW));
  });
});

describe("switchAdapter", () => {
  const agents = [
    { id: "a1", companyId: "c1", name: "Raymond", status: "idle", adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-5-5", instructionsFilePath: "/i/a1/AGENTS.md", paperclipSkillSync: { desiredSkills: ["x"] }, env: { AST_MCP_PORT: "7822", CLAUDE_CONFIG_DIR: "/c" } } },
    { id: "a2", companyId: "c1", name: "Patrick", status: "idle", adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.6-terra", instructionsFilePath: "/i/a2/AGENTS.md", engine: "cli", extraArgs: ["--skip-git-repo-check"], env: { PATH: "/p" } } },
  ] as unknown as Agent[];
  const action: Action = { kind: "switchAdapter", agentId: "a1", companyId: "c1", poolId: "gpu", fromAdapterType: "claude_local", toAdapterType: "codex_local", model: "gpt-5.6-terra", reason: "own subscription used up" };

  it("moves an agent to Codex and that side's model with its own instructions and skills, and keeps its Claude settings to switch back", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...CAPS, "agents.read"] });
    harness.seed({ agents, issues: [] });
    harness.setConfig({ quotaToken: { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" } });
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    (harness.ctx as { http: { fetch: unknown } }).http = { fetch: async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    } };
    const store = createStore(harness.ctx.state);
    const exec = createExecutor({ ctx: harness.ctx, store, queueLabelId: async () => undefined, now: new Date(NOW) });
    const entries = await exec.execute([action], snapshot({ pools: [pool("gpu", { mode: "enforce" })] }));
    expect(entries[0]).toMatchObject({ applied: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("http://127.0.0.1:3100/api/agents/a1");
    expect(sent[0].body).toEqual({
      adapterType: "codex_local", replaceAdapterConfig: true,
      adapterConfig: { model: "gpt-5.6-terra", instructionsFilePath: "/i/a1/AGENTS.md", paperclipSkillSync: { desiredSkills: ["x"] }, engine: "cli", extraArgs: ["--skip-git-repo-check"], env: { PATH: "/p", AST_MCP_PORT: "7822" } },
    });
    expect((await store.adapterProfiles("c1").get()).a1.claude_local).toEqual(agents[0].adapterConfig);
  });

  it("doesn't switch without the board token", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...CAPS, "agents.read"] });
    harness.seed({ agents, issues: [] });
    const store = createStore(harness.ctx.state);
    const exec = createExecutor({ ctx: harness.ctx, store, queueLabelId: async () => undefined, now: new Date(NOW) });
    const entries = await exec.execute([action], snapshot({ pools: [pool("gpu", { mode: "enforce" })] }));
    expect(entries[0]).toMatchObject({ applied: false });
    expect(await store.adapterProfiles("c1").get()).toEqual({});
  });
});

describe("drainRun", () => {
  it("cancels the run with the board token and holds its task first in line, saying why", async () => {
    const { harness, store, ctx } = setup();
    harness.setConfig({ quotaToken: { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" } });
    const sent: string[] = [];
    (harness.ctx as { http: { fetch: unknown } }).http = { fetch: async (url: string) => {
      sent.push(url);
      return new Response("{}", { status: 200 });
    } };
    const exec = createExecutor({ ctx: harness.ctx, store, queueLabelId: async () => undefined, now: new Date(NOW) });
    const r = run("t1", { model: "l/mbp", startedAt: minutesAgo(45) });
    await exec.drainRun(r, "MBP", pool("gpu"), snapshot({ tasks: [task("t1", { status: "in_progress" })] }), false);
    expect(sent).toEqual(["http://127.0.0.1:3100/api/heartbeat-runs/run-t1/cancel"]);
    const held = (await store.holds.get()).t1;
    expect(held).toMatchObject({ poolId: "gpu", heldAt: minutesAgo(45), statusBefore: "in_progress" });
    expect(await blockerIds(ctx, "t1")).toHaveLength(1);
    const comments = await ctx.issues.listComments("t1", "c1");
    expect(comments.at(-1)?.body).toMatch(/^Moved off MBP \(its run hadn't finished 30 min/);
  });

  it("leaves the task alone when Paperclip refuses the cancel", async () => {
    const { harness, store } = setup();
    harness.setConfig({ quotaToken: { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" } });
    (harness.ctx as { http: { fetch: unknown } }).http = { fetch: async () => new Response("nope", { status: 403 }) };
    const exec = createExecutor({ ctx: harness.ctx, store, queueLabelId: async () => undefined, now: new Date(NOW) });
    await expect(exec.drainRun(run("t1", { model: "l/mbp" }), "MBP", pool("gpu"), snapshot(), true)).rejects.toThrow(/refused to cancel the run \(403\)/);
    expect((await store.holds.get()).t1).toBeUndefined();
  });
});
