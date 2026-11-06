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
  issue("i1", "c1", "a1", { title: "Fix the widget", description: "Long first post. ".repeat(60) }),
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

  it("gives each run its task's title and the start of its first post, for the engine runs dialog", async () => {
    const { deps } = await setup();
    const r1 = (await buildSnapshot(deps)).runs.find((r) => r.runId === "r1")!;
    expect(r1.issueTitle).toBe("Fix the widget");
    expect(r1.issueDescription).toHaveLength(600);
    expect((await buildSnapshot(deps)).runs.find((r) => r.runId === "r3")!.issueDescription).toBeUndefined();
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

  it("marks a queued run whose agent is already running as waiting on the agent", async () => {
    const { deps } = await setup([row("r1", "c1", "a1", "i1"), row("r2", "c1", "a1", "i2", "queued"), row("r3", "c1", "a2", "i4", "queued")]);
    const s = await buildSnapshot(deps);
    expect(s.runs.map((r) => [r.runId, r.waitingOnAgent ?? false])).toEqual([["r1", false], ["r2", true], ["r3", false]]);
  });

  it("marks a run queued over 10 minutes with its agent idle as stalled, not a recent one", async () => {
    const minutesBefore = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
    const { deps } = await setup([{ ...row("old", "c1", "a1", "i1", "queued"), created_at: minutesBefore(30) }, { ...row("new", "c1", "a2", "i4", "queued"), created_at: minutesBefore(2) }]);
    const s = await buildSnapshot(deps);
    expect(s.runs.map((r) => [r.runId, r.stalled ?? false])).toEqual([["old", true], ["new", false]]);
  });

  it("lets only an idle agent's oldest queued run take a slot; its later queued runs wait for the agent", async () => {
    const queued = (id: string, issueId: string, at: string): RunRow => ({ ...row(id, "c1", "a1", issueId, "queued"), started_at: null, created_at: at });
    const { deps } = await setup([queued("late", "i2", new Date(Date.parse(NOW) - 60_000).toISOString()), queued("early", "i1", new Date(Date.parse(NOW) - 120_000).toISOString())]);
    const s = await buildSnapshot(deps);
    expect(Object.fromEntries(s.runs.map((r) => [r.runId, r.waitingOnAgent ?? false]))).toEqual({ early: false, late: true });
  });

  it("marks quota models used up from an empty usage meter and from repeated rate-limit failures", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    harness.seed({ companies: [company("c1")], agents: [agent("a2", "c1", "free/llama"), agent("a9", "c1", "zen/x")], issues: [] });
    const store = createStore(harness.ctx.state);
    await store.companies.set([{ id: "c1", name: "c1" }]);
    await store.companyPools("c1").set([
      pool("free", { kind: "quota", backend: "or", patterns: ["free/llama", "free/qwen"] }),
      pool("zen", { kind: "quota", backend: "zen", patterns: ["zen/x"] }),
    ]);
    await store.companyUsage("c1").set({ or: { backendId: "or", sampledAt: NOW, ok: true, notes: [], meters: [{ label: "Credits", unit: "usd", used: 10, limit: 10, remaining: 0, resetAt: "2026-11-01T00:00:00Z" }] } });
    const failures = [0, 1].map((i) => ({ company_id: "c1", agent_id: "a9", issue_id: null, error: "429 Too Many Requests", finished_at: new Date(Date.parse(NOW) - (2 + i) * 60_000).toISOString() }));
    const s = await buildSnapshot({
      ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => failures, now: new Date(NOW),
      backendsFor: async () => [{ id: "or", name: "OR", type: "openrouter" }, { id: "zen", name: "Zen", type: "opencode" }],
    });
    expect(Object.keys(s.exhausted ?? {}).sort()).toEqual(["c1|free/llama", "c1|free/qwen", "c1|zen/x"]);
    expect(s.exhausted?.["c1|free/llama"]).toMatchObject({ until: "2026-11-01T00:00:00Z", reason: "Credits used up" });
    expect(s.exhausted?.["c1|zen/x"]).toMatchObject({ reason: "2 rate-limit failures" });
  });

  it("pauses only the free models when the free requests are used up, and only the paid ones when credits are", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    harness.seed({ companies: [company("c1")], agents: [], issues: [] });
    const store = createStore(harness.ctx.state);
    await store.companies.set([{ id: "c1", name: "c1" }]);
    await store.companyPools("c1").set([pool("or", { kind: "quota", backend: "or", patterns: ["or/llama:free", "or/jev"] })]);
    const meters = (free: number, credits: number) => [
      { label: "Account credits", unit: "usd" as const, used: 10 - credits, limit: 10, remaining: credits, appliesTo: "paid" as const },
      { label: "Free requests today", unit: "requests" as const, used: 1000 - free, limit: 1000, remaining: free, resetAt: "2026-11-01T00:00:00.000Z", appliesTo: "free" as const },
    ];
    const run = async (free: number, credits: number) => {
      await store.companyUsage("c1").set({ or: { backendId: "or", sampledAt: NOW, ok: true, notes: [], meters: meters(free, credits) } });
      const s = await buildSnapshot({
        ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => [], now: new Date(NOW),
        backendsFor: async () => [{ id: "or", name: "OR", type: "openrouter" }],
      });
      return s.exhausted ?? {};
    };
    const freeOut = await run(0, 9);
    expect(Object.keys(freeOut)).toEqual(["c1|or/llama:free"]);
    expect(freeOut["c1|or/llama:free"]).toMatchObject({ until: "2026-11-01T00:00:00.000Z", reason: "Free requests today used up" });
    expect(Object.keys(await run(500, 0))).toEqual(["c1|or/jev"]);
  });

  it("doesn't pause a pool set to go over quota when its backend reports the quota used up", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    harness.seed({ companies: [company("c1")], agents: [], issues: [] });
    const store = createStore(harness.ctx.state);
    await store.companies.set([{ id: "c1", name: "c1" }]);
    await store.companyPools("c1").set([
      pool("gh", { kind: "quota", backend: "gh", patterns: ["gh/sonnet"], allowOverQuota: true }),
      pool("gh2", { kind: "quota", backend: "gh", patterns: ["gh/haiku"] }),
    ]);
    await store.companyUsage("c1").set({ gh: { backendId: "gh", sampledAt: NOW, ok: true, notes: [], meters: [{ label: "Premium requests", unit: "requests", used: 1500, limit: 1500, remaining: 0 }] } });
    const s = await buildSnapshot({
      ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => [], now: new Date(NOW),
      backendsFor: async () => [{ id: "gh", name: "Copilot", type: "copilot" }],
    });
    expect(Object.keys(s.exhausted ?? {})).toEqual(["c1|gh/haiku"]);
  });

  it("pauses each model of a pool on both subscriptions with its own subscription", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    harness.seed({ companies: [company("c1")], agents: [], issues: [] });
    const store = createStore(harness.ctx.state);
    await store.companies.set([{ id: "c1", name: "c1" }]);
    await store.companyPools("c1").set([pool("cheap", { kind: "quota", backend: "p", patterns: ["p/claude-haiku-5-5", "p/gpt-5.6-terra"], subscription: "both" })]);
    await store.subscriptionWindows("c1").set({
      sampledAt: NOW, ok: true,
      accounts: [{ provider: "anthropic", ok: true, windows: [{ label: "Weekly limit", usedPercent: 100, resetsAt: "2099-01-01T00:00:00Z" }] }, { provider: "openai", ok: true, windows: [{ label: "Weekly limit", usedPercent: 40, resetsAt: "2099-01-01T00:00:00Z" }] }],
    });
    const s = await buildSnapshot({
      ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => [], now: new Date(NOW),
      backendsFor: async () => [{ id: "p", name: "P", type: "openai" }],
    });
    expect(Object.keys(s.exhausted ?? {})).toEqual(["c1|p/claude-haiku-5-5"]);
    await store.companyPools("c1").set([pool("cheap", { kind: "quota", backend: "p", patterns: ["p/claude-haiku-5-5", "p/gpt-5.6-terra"], subscription: "both", allowOverQuota: true })]);
    const over = await buildSnapshot({
      ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => [], now: new Date(NOW),
      backendsFor: async () => [{ id: "p", name: "P", type: "openai" }],
    });
    expect(over.exhausted).toEqual({});
  });

  it("keeps a task the plugin placed in the pool that placed it when another pool lists the same model", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    const placed = { adapterConfig: { model: "claude-haiku-5-5" } };
    harness.seed({
      companies: [company("c1")], agents: [agent("a1", "c1", "pool/cheap"), agent("a2", "c1", "claude-haiku-5-5")],
      issues: [issue("t1", "c1", "a1", { assigneeAdapterOverrides: placed }), issue("t2", "c1", "a2")],
    });
    const store = createStore(harness.ctx.state);
    await store.companies.set([{ id: "c1", name: "c1" }]);
    await store.companyPools("c1").set([
      pool("haiku", { kind: "quota", backend: "s", patterns: ["claude-haiku-5-5"] }),
      pool("cheap", { kind: "quota", backend: "s", patterns: ["gpt-5.6-terra", "claude-haiku-5-5"] }),
    ]);
    await store.overrides.set({ t1: { issueId: "t1", agentId: "a1", model: "claude-haiku-5-5", original: null, fromPoolId: "c1:cheap", toPoolId: "c1:cheap", at: NOW } });
    const s = await buildSnapshot({
      ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => [], now: new Date(NOW),
      backendsFor: async () => [{ id: "s", name: "S", type: "other" }],
    });
    expect(Object.fromEntries(s.tasks.map((t) => [t.issueId, t.poolId]))).toEqual({ t1: "c1:cheap", t2: "c1:haiku" });
  });

  it("pauses each model of a pool without a backend on its own backend's limits", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    harness.seed({ companies: [company("c1")], agents: [], issues: [] });
    const store = createStore(harness.ctx.state);
    await store.companies.set([{ id: "c1", name: "c1" }]);
    await store.companyPools("c1").set([pool("mix", { kind: "quota", patterns: ["openrouter/a:free", "litellm/free", "claude-haiku-5-5"] })]);
    await store.companyUsage("c1").set({
      or: { backendId: "or", sampledAt: NOW, ok: true, notes: [], meters: [{ label: "Free requests today", unit: "requests", used: 1000, limit: 1000, remaining: 0, appliesTo: "free" }] },
      ll: { backendId: "ll", sampledAt: NOW, ok: true, notes: [], meters: [{ label: "Key spend", unit: "usd", used: 3, limit: 20 }] },
    });
    const s = await buildSnapshot({
      ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => [], now: new Date(NOW),
      backendsFor: async () => [{ id: "or", name: "OR", type: "openrouter" }, { id: "ll", name: "LL", type: "litellm" }],
    });
    expect(s.pools[0].placement).toEqual([{ model: "openrouter/a:free", backendId: "or" }, { model: "litellm/free", backendId: "ll" }, { model: "claude-haiku-5-5" }]);
    expect(Object.keys(s.exhausted ?? {})).toEqual(["c1|openrouter/a:free"]);
  });

  it("counts agents on a switching pool's name or on one of its models as its agents", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    harness.seed({ companies: [company("c1")], agents: [agent("a1", "c1", "claude-sonnet-5-5"), agent("a2", "c1", "pool/normal"), agent("a3", "c1", "claude-haiku-5-5")], issues: [] });
    const store = createStore(harness.ctx.state);
    await store.companies.set([{ id: "c1", name: "c1" }]);
    await store.companyPools("c1").set([pool("normal", { kind: "quota", patterns: ["claude-sonnet-5-5", "gpt-5.6-terra"], subscription: "both", switchAdapters: true })]);
    const s = await buildSnapshot({ ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => [], now: new Date(NOW), backendsFor: async () => [] });
    expect((s.poolAgents ?? []).map((a) => a.id).sort()).toEqual(["a1", "a2"]);
  });

  it("pauses a LiteLLM alias when every upstream it calls is used up", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    harness.seed({ companies: [company("c1")], agents: [], issues: [] });
    const store = createStore(harness.ctx.state);
    await store.companies.set([{ id: "c1", name: "c1" }]);
    await store.companyPools("c1").set([pool("free", { kind: "quota", patterns: ["litellm/free", "litellm/mixed"] })]);
    await store.companyUsage("c1").set({
      or: { backendId: "or", sampledAt: NOW, ok: true, notes: [], meters: [{ label: "Free requests today", unit: "requests", used: 1000, limit: 1000, remaining: 0, resetAt: "2026-11-04T00:00:00.000Z", appliesTo: "free" }] },
      ll: { backendId: "ll", sampledAt: NOW, ok: true, notes: [], meters: [], upstreams: { free: ["openrouter/a:free", "openrouter/b:free"], mixed: ["openrouter/a:free", "nvidia_nim/x"] } },
    });
    const s = await buildSnapshot({
      ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => [], now: new Date(NOW),
      backendsFor: async () => [{ id: "or", name: "OpenRouter", type: "openrouter" }, { id: "ll", name: "LiteLLM", type: "litellm" }],
    });
    expect(s.exhausted).toEqual({ "c1|litellm/free": expect.objectContaining({ reason: "Free requests today (OpenRouter) used up", until: "2026-11-04T00:00:00.000Z" }) });
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

describe("parked tasks", () => {
  const park = (issueId: string, companyId: string, hoursAgo: number) => ({
    [issueId]: { issueId, companyId, poolId: "gpu", since: new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString(), failures: 3 },
  });

  it("keeps a recent parked task, and drops one parked over a day ago, one with a run and one that closed", async () => {
    const { deps, store } = await setup();
    // i2: open, no run, parked an hour ago. i8: parked two days ago. i1: has run r1. i5: done.
    await store.parked.set({ ...park("i2", "c1", 1), ...park("i8", "c2", 48), ...park("i1", "c1", 1), ...park("i5", "c1", 1) });
    expect(Object.keys((await buildSnapshot(deps)).parked ?? {})).toEqual(["i2"]);
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
