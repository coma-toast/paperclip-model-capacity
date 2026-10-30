import { describe, expect, it } from "vitest";
import type { Agent, Company, Issue } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import { decide } from "../src/scheduler/decide.js";
import { buildSnapshot, createAgentCache, dbRunReader, type RunRow } from "../src/snapshot.js";
import { createStore } from "../src/state/store.js";
import { NOW, pool } from "./fixtures/snapshot.js";

const company = (id: string) => ({ id, name: id }) as unknown as Company;
const agent = (id: string, companyId: string, model: string) => ({ id, companyId, name: id, status: "idle", adapterConfig: { model } }) as unknown as Agent;
const issue = (id: string, companyId: string, assigneeAgentId: string | null, over: Partial<Issue> = {}) =>
  ({ id, companyId, title: id, status: "todo", priority: "medium", assigneeAgentId, assigneeAdapterOverrides: null, ...over }) as unknown as Issue;
const row = (id: string, companyId: string, agentId: string, issueId: string | null, status = "running"): RunRow =>
  ({ id, company_id: companyId, agent_id: agentId, issue_id: issueId, status, started_at: NOW });

// 2 companies, 5 agents, 12 issues, 3 runs (the plan's done-when).
const AGENTS = [
  agent("a1", "c1", "gateway/gpu"),
  agent("a2", "c1", "free/llama"),
  agent("a3", "c2", "gateway/gpu"),
  agent("a4", "c2", "free/qwen"),
  agent("a5", "c1", "other/model"),
];
const ISSUES = [
  issue("i1", "c1", "a1"),
  issue("i2", "c1", "a1", { priority: "high" }),
  issue("i3", "c1", "a1", { assigneeAdapterOverrides: { adapterConfig: { model: "free/llama" } } }),
  issue("i4", "c1", "a2", { status: "in_progress" }),
  issue("i5", "c1", "a2", { status: "done" }),
  issue("i6", "c1", "a5"),
  issue("i7", "c1", null),
  issue("i8", "c2", "a3", { status: "blocked" }),
  issue("i9", "c2", "a3", { status: "backlog" }),
  issue("i10", "c2", "a4"),
  issue("i11", "c2", "a4", { status: "in_review", priority: "low" }),
  issue("i12", "c2", "a4", { status: "cancelled" }),
];
const RUNS = [row("r1", "c1", "a1", "i1"), row("r2", "c2", "a4", "i10"), row("r3", "c2", "a3", null, "queued")];
const POOLS = [pool("gpu", { patterns: ["gateway/gpu"] }), pool("free", { patterns: ["free/*"], scope: "company", limit: 2 })];

const setup = async (runs: RunRow[] | "unavailable" = RUNS) => {
  const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
  harness.seed({ companies: [company("c1"), company("c2")], agents: AGENTS, issues: ISSUES });
  const store = createStore(harness.ctx.state);
  // Both companies set up the same pools; each gets its own limits.
  await store.companyPools("c1").set(POOLS);
  await store.companyPools("c2").set(POOLS);
  const deps = { ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => (runs === "unavailable" ? undefined : runs), now: new Date(NOW) };
  return { harness, store, deps };
};

const byPool = <T extends { poolId?: string }>(items: T[]) =>
  items.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.poolId ?? "none"]: (acc[x.poolId ?? "none"] ?? 0) + 1 }), {});

describe("buildSnapshot", () => {
  it("counts open tasks and runs per pool", async () => {
    const { deps } = await setup();
    const s = await buildSnapshot(deps);
    // gpu: i1, i2 (c1) and i8 (c2). free: i3 (override), i4 (c1), i10, i11 (c2). Closed, backlog, unassigned and unmatched are left out.
    expect(byPool(s.tasks)).toEqual({ "c1:gpu": 2, "c2:gpu": 1, "c1:free": 2, "c2:free": 2 });
    expect(s.tasks.map((t) => t.issueId).sort()).toEqual(["i1", "i10", "i11", "i2", "i3", "i4", "i8"]);
    // r3 has no task, so it counts on its agent's own model.
    expect(byPool(s.runs)).toEqual({ "c1:gpu": 1, "c2:gpu": 1, "c2:free": 1 });
  });

  it("leaves out tasks of paused or stopped agents, which can't be woken", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    harness.seed({ companies: [company("c1"), company("c2")], agents: AGENTS.map((a) => (a.id === "a1" ? ({ ...a, status: "paused" }) as Agent : a)), issues: ISSUES });
    const store = createStore(harness.ctx.state);
    await store.companyPools("c1").set(POOLS);
    await store.companyPools("c2").set(POOLS);
    const s = await buildSnapshot({ ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => RUNS, now: new Date(NOW) });
    // i1, i2 and i3 belong to a1.
    expect(s.tasks.map((t) => t.issueId).sort()).toEqual(["i10", "i11", "i4", "i8"]);
  });

  it("leaves out blocked tasks waiting on their own blockers, but not ones only behind our queue blocker", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    const issues = [...ISSUES.filter((i) => !["i10", "i11"].includes(i.id)),
      issue("i10", "c2", "a4", { status: "blocked" }), issue("i11", "c2", "a4", { status: "blocked" }), issue("dep", "c2", null), issue("q", "c2", null)];
    harness.seed({ companies: [company("c1"), company("c2")], agents: AGENTS, issues });
    const store = createStore(harness.ctx.state);
    await store.companyPools("c1").set(POOLS);
    await store.companyPools("c2").set(POOLS);
    await store.queueBlockers("c2").set({ "c2:free": "q" });
    await harness.ctx.issues.relations.addBlockers("i10", ["dep"], "c2");
    await harness.ctx.issues.relations.addBlockers("i11", ["q"], "c2");
    const s = await buildSnapshot({ ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => RUNS, now: new Date(NOW) });
    expect(s.tasks.map((t) => t.issueId)).not.toContain("i10");
    expect(s.tasks.map((t) => t.issueId)).toContain("i11");
  });

  it("marks tasks with a run, the override's pool and pins", async () => {
    const { deps } = await setup();
    const s = await buildSnapshot(deps);
    const t = (id: string) => s.tasks.find((x) => x.issueId === id)!;
    expect(t("i1").hasActiveRun).toBe(true);
    expect(t("i2").hasActiveRun).toBe(false);
    expect(t("i2").priority).toBe("high");
    expect(t("i3")).toMatchObject({ poolId: "c1:free", pinned: true });
    expect(t("i1").pinned).toBe(false);
  });

  it("carries holds, released tasks, exemptions and held pools from state", async () => {
    const { deps, store } = await setup();
    await store.holds.set({ i2: { issueId: "i2", companyId: "c1", poolId: "gpu", priority: "high", heldAt: NOW } });
    await store.exemptions.set({ agentIds: ["a3"], issueIds: ["i11"] });
    await store.companyHeldPools("c1").set(["free"]);
    const s = await buildSnapshot(deps);
    expect(s.holds.map((h) => h.issueId)).toEqual(["i2"]);
    expect(s.exemptAgentIds).toEqual(["a3"]);
    expect(s.tasks.find((x) => x.issueId === "i11")?.exempt).toBe(true);
    expect(s.heldPools).toEqual(["c1:free"]);
  });

  it("falls back to Issue.activeRun when the run table can't be read", async () => {
    const { harness, deps } = await setup("unavailable");
    harness.seed({ issues: [issue("i2", "c1", "a1", { activeRun: { id: "r9", status: "running", agentId: "a1", invocationSource: "assignment", triggerDetail: null, startedAt: NOW, finishedAt: null, createdAt: NOW } } as Partial<Issue>)] });
    const s = await buildSnapshot(deps);
    expect(s.runs.map((r) => [r.runId, r.poolId])).toEqual([["r9", "c1:gpu"]]);
  });

  it("feeds decide(): each company's full gpu pool holds its own waiting task", async () => {
    const { deps } = await setup();
    const actions = decide(await buildSnapshot(deps));
    // Each company's gpu pool has limit 1 and one run, so c1's i2 and c2's i8 each wait first in their own queue.
    expect(actions.filter((a) => a.kind === "hold").map((a) => (a.kind === "hold" ? [a.issueId, a.poolId, a.position] : []))).toEqual([["i2", "c1:gpu", 1], ["i8", "c2:gpu", 1]]);
  });
});

describe("per-company pools", () => {
  it("doesn't read a company that has no pools", async () => {
    const { harness, deps, store } = await setup();
    await store.companyPools("c2").set([]);
    const seen: string[] = [];
    const list = harness.ctx.issues.list;
    harness.ctx.issues.list = async (input) => { seen.push(input.companyId); return list(input); };
    const s = await buildSnapshot(deps);
    expect(new Set(seen)).toEqual(new Set(["c1"]));
    expect(s.pools.map((p) => p.id)).toEqual(["c1:gpu", "c1:free"]);
  });

  it("matches a task only against its own company's pools", async () => {
    const { deps, store } = await setup();
    await store.companyPools("c2").set([pool("other", { patterns: ["*"] })]);
    const s = await buildSnapshot(deps);
    expect(s.tasks.find((t) => t.issueId === "i8")?.poolId).toBe("c2:other");
    expect(s.tasks.find((t) => t.issueId === "i1")?.poolId).toBe("c1:gpu");
  });
});

describe("unconfigured companies", () => {
  it("skips a company the host won't let the plugin read, and keeps the others", async () => {
    const { harness, deps } = await setup();
    const list = harness.ctx.issues.list;
    harness.ctx.issues.list = async (input) => {
      if (input.companyId === "c2") throw Object.assign(new Error('Plugin "x" is not allowed to perform "issues.list": company context is required'), { name: "InvocationScopeDeniedError" });
      return list(input);
    };
    const s = await buildSnapshot(deps);
    expect(new Set(s.tasks.map((t) => t.companyId))).toEqual(new Set(["c1"]));
    expect(s.runs.every((r) => r.companyId === "c1")).toBe(true);
  });

  it("still fails the cycle on other errors", async () => {
    const { harness, deps } = await setup();
    harness.ctx.issues.list = async () => { throw new Error("database down"); };
    await expect(buildSnapshot(deps)).rejects.toThrow("database down");
  });
});

describe("agent cache", () => {
  it("serves agents from cache until the TTL passes or it is invalidated", async () => {
    const { harness } = await setup();
    let now = 0;
    const cache = createAgentCache(harness.ctx, 60_000, () => now);
    const first = await cache.get("c1");
    expect(await cache.get("c1")).toBe(first);
    now = 61_000;
    expect(await cache.get("c1")).not.toBe(first);
    const second = await cache.get("c1");
    cache.invalidate("c1");
    expect(await cache.get("c1")).not.toBe(second);
  });
});

describe("dbRunReader", () => {
  it("queries only queued and running runs", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "database.namespace.read"] });
    await dbRunReader(harness.ctx)();
    expect(harness.dbQueries[0].sql).toContain("status IN ('queued', 'running')");
  });

  it("returns undefined instead of throwing when the read fails", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities.filter((c) => !c.startsWith("database")) });
    expect(await dbRunReader(harness.ctx)()).toBeUndefined();
  });
});
