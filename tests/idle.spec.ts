import { describe, expect, it } from "vitest";
import type { Issue, PluginCapability } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { createExecutor } from "../src/executor.js";
import manifest from "../src/manifest.js";
import { decide } from "../src/scheduler/decide.js";
import { IDLE_SQL } from "../src/snapshot.js";
import { createStore } from "../src/state/store.js";
import type { Action } from "../src/types.js";
import { hold, run, snapshot, task, upHost } from "./fixtures/snapshot.js";

const short = (a: Action[]) => a.filter((x) => x.kind !== "alert").map((x) =>
  x.kind === "release" ? `release ${x.issueId} ${x.reason}` : x.kind === "hold" ? `hold ${x.issueId}` : x.kind);

describe("idle tasks", () => {
  const full = { runs: [run("busy")], hosts: { "gpu~h": upHost("gpu~h") } };

  it("aren't held when the pool is full; a task with something new still is", () => {
    const out = short(decide(snapshot({ ...full, tasks: [task("busy", { hasActiveRun: true }), task("rev", { status: "in_review", idle: true }), task("new", { status: "in_review" })] })));
    expect(out).toEqual(["hold new"]);
  });

  it("drop a hold they still have, without a wake-up, and never take the free slot", () => {
    const out = short(decide(snapshot({ holds: [hold("rev"), hold("next")], tasks: [task("rev", { status: "blocked", idle: true }), task("next", { status: "blocked" })], hosts: { "gpu~h": upHost("gpu~h") } })));
    expect(out).toEqual(["release rev idle", "release next capacity"]);
  });

  it("are let go by the executor with their status put back and no run started", async () => {
    const CAPS: PluginCapability[] = [...manifest.capabilities, "issues.read", "issues.update", "issues.wakeup", "issue.relations.read", "issue.relations.write", "issue.comments.create"];
    const harness = createTestHarness({ manifest, capabilities: CAPS });
    harness.seed({ issues: [{ id: "t1", companyId: "c1", title: "t1", status: "in_review", priority: "medium", assigneeAgentId: "a1", labelIds: [] } as unknown as Issue] });
    const store = createStore(harness.ctx.state);
    const exec = createExecutor({ ctx: harness.ctx, store, queueLabelId: async () => undefined, now: new Date() });
    const snap = snapshot({ tasks: [task("t1", { status: "in_review" })] });
    await exec.execute([{ kind: "hold", issueId: "t1", companyId: "c1", poolId: "gpu", position: 1 }], snap);
    // Paperclip blocks a task when a blocker is added; the test harness doesn't.
    await harness.ctx.issues.update("t1", { status: "blocked" }, "c1");
    expect((await store.holds.get()).t1?.statusBefore).toBe("in_review");
    await exec.execute([{ kind: "release", issueId: "t1", companyId: "c1", poolId: "gpu", reason: "idle" }], snap);
    expect((await harness.ctx.issues.get("t1", "c1"))?.status).toBe("in_review");
    expect(await store.holds.get()).toEqual({});
    expect(await store.released.get()).toEqual({});
  });

  it("reads only comments from someone other than the assignee and children closed after the last run", () => {
    expect(IDLE_SQL).toContain("c.author_type IN ('user', 'agent') AND c.author_agent_id IS DISTINCT FROM i.assignee_agent_id AND c.created_at > lr.ended");
    expect(IDLE_SQL).toContain("ch.completed_at > lr.ended");
    expect(manifest.database?.coreReadTables).toEqual(expect.arrayContaining(["heartbeat_runs", "issues", "issue_comments"]));
  });
});
