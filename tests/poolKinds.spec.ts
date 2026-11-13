import { describe, expect, it } from "vitest";

import { resolvePool } from "../src/pools.js";
import { decide } from "../src/scheduler/decide.js";
import type { Action, PoolConfig, Snapshot } from "../src/types.js";
import { downHost, hold, minutesAgo, run, snapshot, task, upHost } from "./fixtures/snapshot.js";

const short = (a: Action[]) => a.filter((x) => x.kind !== "alert").map((x) =>
  x.kind === "place" ? `place ${x.issueId} ${x.model} ${x.reason}` : x.kind === "release" ? `release ${x.issueId}${x.model ? ` ${x.model}` : ""}` : x.kind === "hold" ? `hold ${x.issueId}` : x.kind);

const backends = [
  { id: "proxy", name: "Proxy", type: "litellm" as const, baseUrl: "https://proxy" },
  { id: "mac", name: "Mac", type: "omlx" as const, baseUrl: "http://mac:1235", slots: 4, reachVia: "proxy", reachModel: "l/mbp" },
  { id: "gpu", name: "GPU", type: "llamacpp" as const, baseUrl: "http://gpu:8091", slots: 1, reachVia: "proxy", reachModel: "l/vm" },
];
const base = (over: Partial<PoolConfig>): PoolConfig => ({
  id: "gpu", name: "Local", patterns: [], limit: 0, privacy: "private", mode: "enforce", scope: "instance", hosts: [], alertAfterMinutes: 30, ...over,
});

describe("engine pools (P2.7)", () => {
  const local = (caps: { mac?: number } = {}) => ({
    ...resolvePool(base({ kind: "engine", engines: [{ engine: "mac", ...(caps.mac ? { cap: caps.mac } : {}) }, { engine: "gpu" }] }), backends, { gpu: ["l/vm", "l/pc-local-a"] }),
    patterns: ["l/mbp", "l/vm", "l/pc-local-a", "pool/gpu"],
  });
  const up = { "backend~mac": upHost("backend~mac"), "backend~gpu": upHost("backend~gpu") };

  it("resolves engines into pin targets with aliases and caps, and a limit from the capped slots", () => {
    const p = resolvePool(base({ kind: "engine", engines: [{ engine: "mac", cap: 2 }, { engine: "gpu" }] }), backends, { gpu: ["l/vm", "l/pc-local-a"] });
    expect(p.placement).toEqual([{ model: "l/mbp", hostId: "backend~mac", aliases: [], cap: 2 }, { model: "l/vm", hostId: "backend~gpu", aliases: ["l/pc-local-a"] }]);
    expect(p.patterns).toEqual(["l/mbp", "l/vm", "l/pc-local-a"]);
    expect(p.limit).toBe(3);
  });

  it("pins a pool task to the first engine with room, respecting that engine's cap", () => {
    expect(short(decide(snapshot({ pools: [local()], hosts: up, tasks: [task("t1", { model: "pool/gpu" })] })))).toEqual(["place t1 l/mbp new"]);
    const capped = snapshot({ pools: [local({ mac: 1 })], hosts: up, runs: [run("r1", { model: "l/mbp" })], tasks: [task("r1", { model: "l/mbp", hasActiveRun: true }), task("t1", { model: "pool/gpu" })] });
    expect(short(decide(capped))).toEqual(["place t1 l/vm new"]);
  });

  it("counts a run on another name for an engine against that engine, and treats such a task as already pinned", () => {
    const s = snapshot({
      pools: [local()], hosts: up, runs: [run("r1", { model: "l/pc-local-a" })],
      holds: [hold("t2")],
      tasks: [task("r1", { model: "l/pc-local-a", hasActiveRun: true }), task("t2", { model: "l/pc-local-a", status: "blocked" })],
    });
    expect(short(decide(s))).toEqual([]);
  });
});

describe("quota pools (P2.7)", () => {
  const free = (over: Partial<PoolConfig> = {}) => ({
    ...resolvePool(base({ kind: "quota", backend: "proxy", patterns: ["l/free-a", "l/free-b"], limit: 2, privacy: "shared", ...over }), backends),
    companyId: "c1", patterns: ["l/free-a", "l/free-b", "pool/gpu"],
  });
  const usedUp = (model: string, since = minutesAgo(1)) => ({ [`c1|${model}`]: { since, reason: "rate limited" } });

  it("pins a pool task to the first model with quota left", () => {
    expect(short(decide(snapshot({ pools: [free()], tasks: [task("t1", { model: "pool/gpu" })] })))).toEqual(["place t1 l/free-a new"]);
    expect(short(decide(snapshot({ pools: [free()], exhausted: usedUp("l/free-a"), tasks: [task("t1", { model: "pool/gpu" })] })))).toEqual(["place t1 l/free-b new"]);
  });

  it("holds when every model is used up, and within the pool limit", () => {
    const all = { ...usedUp("l/free-a"), ...usedUp("l/free-b") };
    expect(short(decide(snapshot({ pools: [free()], exhausted: all, tasks: [task("t1", { model: "pool/gpu" })] })))).toEqual(["hold t1"]);
    const full = snapshot({ pools: [free({ limit: 1 })], runs: [run("r1", { model: "l/free-a" })], tasks: [task("r1", { model: "l/free-a", hasActiveRun: true }), task("t1", { model: "pool/gpu" })] });
    expect(short(decide({ ...full, pools: [{ ...free(), limit: 1 }] }))).toEqual(["hold t1"]);
  });

  it("a task waits for its own used-up model, and moves only after it's been used up 30 minutes", () => {
    const s = (since: string) => snapshot({ pools: [free()], exhausted: usedUp("l/free-a", since), placements: { t1: "l/free-a" }, holds: [hold("t1")], tasks: [task("t1", { model: "l/free-a", status: "blocked" })] });
    expect(short(decide(s(minutesAgo(5))))).toEqual([]);
    expect(short(decide(s(minutesAgo(40))))).toEqual(["place t1 l/free-b engineDown", "release t1 l/free-b"]);
  });
});

describe("fallback pools (P2.7.3)", () => {
  const local = (over: Partial<PoolConfig> = {}) => ({
    ...resolvePool(base({ kind: "engine", engines: [{ engine: "gpu" }], fallbackPool: "free", ...over }), backends),
    patterns: ["l/vm", "pool/gpu"],
  });
  const waiting = (hosts: Snapshot["hosts"], model = "pool/gpu") => snapshot({
    pools: [local()], hosts, runs: [run("r1", { model: "l/vm" })], holds: [hold("t1", { heldAt: minutesAgo(90) })],
    tasks: [task("r1", { model: "l/vm", hasActiveRun: true }), task("t1", { model, status: "blocked" })],
  });

  it("doesn't move a task that only waits for room, however long", () => {
    expect(short(decide(waiting({ "backend~gpu": upHost("backend~gpu") })))).toEqual([]);
  });

  it("moves a task when the pool can't run it: its engines are down", () => {
    expect(short(decide(waiting({ "backend~gpu": downHost("backend~gpu") })))).toEqual(["place t1 pool/free fallback", "release t1"]);
  });

  it("never moves a task while the pool is disabled", () => {
    const disabled = waiting({ "backend~gpu": downHost("backend~gpu") });
    expect(short(decide({ ...disabled, pools: [{ ...disabled.pools[0], disabled: true }] }))).toEqual([]);
  });

  it("moves a quota pool's task once every model its agent can run is out of quota, not before", () => {
    const quota = (exhausted: Record<string, { since: string; reason: string }>) => snapshot({
      pools: [{ ...resolvePool(base({ kind: "quota", backend: "proxy", patterns: ["l/claude-haiku-5-5", "l/gpt-5.6-luna"], limit: 2, privacy: "shared", fallbackPool: "free" }), backends), companyId: "c1", patterns: ["l/claude-haiku-5-5", "l/gpt-5.6-luna", "pool/gpu"] }],
      exhausted, tasks: [task("t1", { model: "pool/gpu", agentId: "a1", adapterType: "claude_local" })],
    });
    const out = (m: string) => ({ [`c1|${m}`]: { since: minutesAgo(1), reason: "used up" } });
    expect(short(decide(quota(out("l/gpt-5.6-luna"))))).toEqual(["place t1 l/claude-haiku-5-5 new"]);
    expect(short(decide(quota(out("l/claude-haiku-5-5"))))).toEqual(["place t1 pool/free fallback"]);
  });
});

describe("pools across two subscriptions that switch agents' adapters", () => {
  // A cheap pool: Terra (ChatGPT) listed first, Haiku (Claude). a1 is a Claude Code agent on pool/gpu.
  const cheap = (over: Partial<PoolConfig> = {}) => ({
    ...resolvePool(base({ kind: "quota", backend: "proxy", patterns: ["l/gpt-5.6-terra", "l/claude-haiku-5-5"], limit: 2, privacy: "shared", ...over }), backends),
    companyId: "c1", patterns: ["l/gpt-5.6-terra", "l/claude-haiku-5-5", "pool/gpu"], ...over,
  });
  const agents = [{ id: "a1", companyId: "c1", model: "pool/gpu", adapterType: "claude_local" }];
  const claudeTask = task("t1", { model: "pool/gpu", agentId: "a1", adapterType: "claude_local" });
  const claudeOut = { "c1|l/claude-haiku-5-5": { since: minutesAgo(1), reason: "Claude subscription used up" } };
  const switches = (s: ReturnType<typeof snapshot>) => decide(s).filter((a) => a.kind === "switchAdapter");

  it("gives each agent only a model its adapter can run", () => {
    expect(short(decide(snapshot({ pools: [cheap()], tasks: [claudeTask] })))).toEqual(["place t1 l/claude-haiku-5-5 new"]);
    expect(short(decide(snapshot({ pools: [cheap()], tasks: [task("t2", { model: "pool/gpu", agentId: "a2", adapterType: "codex_local" })] })))).toEqual(["place t2 l/gpt-5.6-terra new"]);
  });

  it("gives a task moved to the pool (its model the pool's own name) a real model", () => {
    const moved = task("t1", { model: "pool/gpu", agentId: "a1", adapterType: "claude_local", pinned: false });
    expect(short(decide(snapshot({ pools: [cheap()], holds: [hold("t1")], tasks: [{ ...moved, status: "blocked" }] })))).toEqual(["place t1 l/claude-haiku-5-5 new", "release t1 l/claude-haiku-5-5"]);
  });

  it("switches an idle agent to Codex when Claude is used up, and its task waits that cycle", () => {
    const s = snapshot({ pools: [cheap({ switchAdapters: true })], poolAgents: agents, exhausted: claudeOut, tasks: [claudeTask] });
    expect(short(decide(s))).toEqual(["switchAdapter", "hold t1"]);
    expect(switches(s)).toEqual([{ kind: "switchAdapter", agentId: "a1", companyId: "c1", poolId: "gpu", fromAdapterType: "claude_local", toAdapterType: "codex_local", model: "pool/gpu", reason: "own subscription used up" }]);
  });

  it("switches when the other subscription has 20 points more quota left, not for less", () => {
    const at = (anthropic: number, openai: number) => snapshot({ pools: [cheap({ switchAdapters: true })], poolAgents: agents, subscriptionLeft: { c1: { anthropic, openai } }, tasks: [claudeTask] });
    expect(switches(at(30, 60))).toMatchObject([{ toAdapterType: "codex_local", reason: "60% left vs 30%" }]);
    expect(short(decide(at(50, 60)))).toEqual(["place t1 l/claude-haiku-5-5 new"]);
  });

  it("doesn't switch when switching is off, the agent is busy, it has nothing waiting, or the other side is used up too", () => {
    expect(short(decide(snapshot({ pools: [cheap()], poolAgents: agents, exhausted: claudeOut, tasks: [claudeTask] })))).toEqual(["hold t1"]);
    const busy = snapshot({ pools: [cheap({ switchAdapters: true })], poolAgents: agents, exhausted: claudeOut, runs: [run("x", { agentId: "a1", poolId: "elsewhere" })], tasks: [claudeTask] });
    expect(switches(busy)).toEqual([]);
    expect(switches(snapshot({ pools: [cheap({ switchAdapters: true })], poolAgents: agents, exhausted: claudeOut, tasks: [] }))).toEqual([]);
    const both = { ...claudeOut, "c1|l/gpt-5.6-terra": { since: minutesAgo(1), reason: "ChatGPT subscription used up" } };
    expect(short(decide(snapshot({ pools: [cheap({ switchAdapters: true })], poolAgents: agents, exhausted: both, tasks: [claudeTask] })))).toEqual(["hold t1"]);
  });
});

describe("quota pool tasks on their agent's own model", () => {
  const sota = () => ({
    ...resolvePool(base({ kind: "quota", backend: "proxy", patterns: ["l/gpt-5.6-sol", "l/gpt-6-astra"], limit: 2, privacy: "shared" }), backends),
    companyId: "c1", patterns: ["l/gpt-5.6-sol", "l/gpt-6-astra", "pool/gpu"],
  });
  const onSol = task("t1", { model: "l/gpt-5.6-sol", agentModel: "l/gpt-5.6-sol", agentId: "a1", adapterType: "codex_local" });
  const solOut = { "c1|l/gpt-5.6-sol": { since: minutesAgo(1), reason: "used up" } };

  it("stays on the agent's model while it has quota", () => {
    expect(short(decide(snapshot({ pools: [sota()], tasks: [onSol] })))).toEqual([]);
  });

  it("goes to the agent's next model when its own is used up, but a model set on the task waits", () => {
    expect(short(decide(snapshot({ pools: [sota()], exhausted: solOut, tasks: [onSol] })))).toEqual(["place t1 l/gpt-6-astra new"]);
    const pinned = { ...onSol, agentModel: "pool/gpu", pinned: true };
    expect(short(decide(snapshot({ pools: [sota()], exhausted: solOut, tasks: [pinned] })))).toEqual(["hold t1"]);
  });
});

