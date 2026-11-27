import { describe, expect, it } from "vitest";

import { decide } from "../src/scheduler/decide.js";
import type { Action, HeldTask, OpenTask, OverflowConfig, OverrideRecord, PoolConfig, Snapshot } from "../src/types.js";
import { downHost, hold, host, minutesAgo, pool, released, run, snapshot, task, upHost } from "./fixtures/snapshot.js";

type Row = { id: string; heldAt?: string; task?: Partial<OpenTask>; hold?: Partial<HeldTask> };

const kind = (actions: Action[], k: Action["kind"]) => actions.filter((a) => a.kind === k);
// What one cycle decides for this world.
const overflowed = (s: Snapshot) => kind(decide(s), "overflow") as Extract<Action, { kind: "overflow" }>[];
const moved = (s: Snapshot) => overflowed(s).map((x) => [x.issueId, x.toPoolId, x.model]);
const restored = (s: Snapshot) => kind(decide(s), "restore") as Extract<Action, { kind: "restore" }>[];
const letGo = (s: Snapshot) => kind(decide(s), "release").map((x) => (x.kind === "release" ? x.issueId : ""));

// gpu has one slot on h1, filled by a run, so a held task waits in its queue; free has room.
// An overflow list for gpu, waiting one minute unless the test says otherwise (D1).
const canGo = (pools: string[], over: Partial<OverflowConfig> = {}): OverflowConfig => ({ pools, afterMinutes: 1, ...over });
const gpu = (over: Partial<PoolConfig> = {}) => pool("gpu", { hosts: [host("h1")], limit: 1, overflow: canGo(["free"]), ...over });
const free = (over: Partial<PoolConfig> = {}) => pool("free", { patterns: ["free/gpt-x"], ...over });
const at = (over: Partial<Snapshot> = {}): Snapshot => snapshot({ pools: [gpu(), free()], hosts: { h1: upHost("h1") }, runs: [run("r1")], tasks: [task("r1", { hasActiveRun: true })], ...over });
// Tasks held half an hour ago, so past the pool's one-minute wait.
const waiting = (...rows: Row[]) => ({
  holds: rows.map((r) => hold(r.id, { heldAt: r.heldAt ?? minutesAgo(30), ...r.hold })),
  tasks: rows.map((r) => task(r.id, { status: "blocked", ...r.task })),
});
const held = (over: Partial<Snapshot> = {}, ...rows: Row[]): Snapshot => {
  const s = at(over);
  const w = waiting(...rows);
  return snapshot({ ...s, holds: [...s.holds, ...w.holds], tasks: [...s.tasks, ...w.tasks] });
};

describe("overflow triggers (D1)", () => {
  it("overflows a held task that waited past the pool's afterMinutes", () => {
    expect(moved(held({}, { id: "t1" }))).toEqual([["t1", "free", "free/gpt-x"]]);
    expect(overflowed(held({}, { id: "t1" }))[0].reason).toBe("waited");
  });

  it("keeps a task in the queue while the pool's wait is not past", () => {
    const s = held({ pools: [gpu({ overflow: canGo(["free"], { afterMinutes: 15 }) }), free()] }, { id: "t1", heldAt: minutesAgo(5) });
    expect(overflowed(s)).toEqual([]);
  });

  it("overflows straight away into a free target when the pool says so", () => {
    const s = held({ pools: [gpu({ overflow: canGo(["free"], { immediately: true }) }), free()] }, { id: "t1", heldAt: minutesAgo(2) });
    expect(overflowed(s).map((x) => [x.issueId, x.toPoolId, x.reason])).toEqual([["t1", "free", "immediate"]]);
  });

  it("an immediate overflow waits while every target is full", () => {
    const s = held({
      pools: [gpu({ overflow: canGo(["free"], { immediately: true }) }), free({ limit: 1 })],
      runs: [run("r1"), run("rf", { issueId: "rf", agentId: "a9", poolId: "free" })],
      tasks: [task("r1", { hasActiveRun: true }), task("rf", { hasActiveRun: true, poolId: "free" })],
    }, { id: "t1", heldAt: minutesAgo(2) });
    expect(overflowed(s)).toEqual([]);
  });

  it("sends the whole queue elsewhere while no host of the pool is up", () => {
    const s = held({
      pools: [gpu({ limit: 2, overflow: canGo(["free"], { whenHostsDown: true }) }), free({ limit: 2 })],
      hosts: { h1: downHost("h1") }, runs: [], tasks: [],
    }, { id: "t1", heldAt: minutesAgo(1) }, { id: "t2", heldAt: minutesAgo(2) });
    expect(overflowed(s).map((x) => [x.issueId, x.reason])).toEqual([["t2", "hostsDown"], ["t1", "hostsDown"]]);
  });

  it("the hosts-down trigger alone sends nothing while a host is up", () => {
    const s = held({ pools: [gpu({ overflow: { pools: ["free"], whenHostsDown: true } }), free()] }, { id: "t1", heldAt: minutesAgo(120) });
    expect(overflowed(s)).toEqual([]);
  });

  it("a pool with an empty overflow list only queues", () => {
    expect(overflowed(held({ pools: [gpu({ overflow: canGo([]) }), free()] }, { id: "t1" }))).toEqual([]);
  });

  it("with every trigger off a long wait stays in the queue", () => {
    expect(overflowed(held({ pools: [gpu({ overflow: { pools: ["free"] } }), free()] }, { id: "t1", heldAt: minutesAgo(200) }))).toEqual([]);
  });
});

describe("overflow target (D1, A8)", () => {
  it("takes the first target with a free slot, skipping one that is full", () => {
    const s = held({
      pools: [gpu({ overflow: canGo(["full", "free"]) }), pool("full", { patterns: ["full/m1"], limit: 1 }), free()],
      runs: [run("r1"), run("rf", { issueId: "rf", agentId: "a9", poolId: "full" })],
      tasks: [task("r1", { hasActiveRun: true }), task("rf", { hasActiveRun: true, poolId: "full" })],
    }, { id: "t1" });
    expect(moved(s)).toEqual([["t1", "free", "free/gpt-x"]]);
  });

  it("skips a target that isn't there", () => {
    const s = held({ pools: [gpu({ overflow: canGo(["ghost", "free"]) }), free()] }, { id: "t1" });
    expect(overflowed(s).map((x) => x.toPoolId)).toEqual(["free"]);
  });

  it("takes at most a target's own free slots in one cycle", () => {
    const s = held({ pools: [gpu({ limit: 2, overflow: canGo(["free"]) }), free({ limit: 1 })] }, { id: "t1" }, { id: "t2" });
    expect(overflowed(s).map((x) => x.issueId)).toEqual(["t1"]);
  });

  it("a task the pool could run this cycle is released, not overflowed", () => {
    const s = held({
      pools: [gpu({ hosts: [host("h1")], limit: 2, overflow: canGo(["free"], { afterMinutes: 15 }) }), free()],
      hosts: { h1: upHost("h1", 2) },
    }, { id: "old", heldAt: minutesAgo(30) }, { id: "new", heldAt: minutesAgo(20) });
    expect(letGo(s)).toEqual(["old"]);
    expect(overflowed(s).map((x) => x.issueId)).toEqual(["new"]);
  });

  it("a task whose last wake-up started no run keeps waiting instead of moving", () => {
    expect(overflowed(held({ wakeCooldown: { t1: "2026-10-28T12:30:00.000Z" } }, { id: "t1" }))).toEqual([]);
  });
});

describe("overflow privacy (A10)", () => {
  it("never sends private work to a shared pool", () => {
    expect(overflowed(held({ pools: [gpu({ privacy: "private" }), free({ privacy: "shared" })] }, { id: "t1" }))).toEqual([]);
  });

  it("sends shared work into a private pool", () => {
    expect(moved(held({ pools: [gpu({ privacy: "shared" }), free({ privacy: "private" })] }, { id: "t1" }))).toEqual([["t1", "free", "free/gpt-x"]]);
  });

  it("lets private work overflow into another private pool", () => {
    const s = held({ pools: [gpu({ privacy: "private", overflow: canGo(["vault", "free"]) }), pool("vault", { privacy: "private", patterns: ["vault/m1"] }), free({ privacy: "shared" })] }, { id: "t1" });
    expect(moved(s)).toEqual([["t1", "vault", "vault/m1"]]);
  });

  it("a private pool that only lists shared targets overflows nothing", () => {
    expect(overflowed(held({ pools: [gpu({ privacy: "private", overflow: canGo(["free"]) }), free()] }, { id: "t1" }))).toEqual([]);
  });
});

describe("overflow refusals", () => {
  it("a pinned task never overflows (D4)", () => {
    expect(overflowed(held({ pools: [gpu({ overflow: canGo(["free"], { immediately: true }) }), free()] }, { id: "t1", task: { pinned: true } }))).toEqual([]);
  });

  it("a pool an operator holds overflows nothing (F2)", () => {
    expect(overflowed(held({ pools: [gpu({ overflow: canGo(["free"], { immediately: true }) }), free()], heldPools: ["gpu"] }, { id: "t1" }))).toEqual([]);
  });

  it("a disabled pool overflows nothing", () => {
    expect(overflowed(held({ pools: [gpu({ disabled: true, overflow: canGo(["free"], { immediately: true }) }), free()] }, { id: "t1" }))).toEqual([]);
  });

  it("a disabled target takes nothing", () => {
    expect(overflowed(held({ pools: [gpu(), free({ disabled: true })] }, { id: "t1" }))).toEqual([]);
  });

  it("work doesn't overflow into another company's pool", () => {
    expect(overflowed(held({ pools: [gpu(), free({ companyId: "c2" })] }, { id: "t1" }))).toEqual([]);
  });

  it("a target that excludes the task's company takes nothing", () => {
    expect(overflowed(held({ pools: [gpu(), free({ companies: { exclude: ["c1"] } })] }, { id: "t1" }))).toEqual([]);
  });

  it("a target that only takes another adapter's agents is skipped", () => {
    const s = held({ pools: [gpu({ overflow: canGo(["codex"]) }), pool("codex", { adapterTypes: ["codex_local"], patterns: ["gpt-x"] }), free()] }, { id: "t1", task: { adapterType: "claude_local" } });
    expect(overflowed(s)).toEqual([]);
  });

  it("a target with no model of its own takes nothing", () => {
    expect(overflowed(held({ pools: [gpu(), pool("free", { patterns: ["free/*"] })] }, { id: "t1" }))).toEqual([]);
  });

  it("a model its agent can't run leaves the task waiting", () => {
    expect(overflowed(held({ adapterModels: { agy_local: ["agy/small"] } }, { id: "t1", task: { adapterType: "agy_local" } }))).toEqual([]);
  });
});

describe("overflow model (D2)", () => {
  it("prefers the target pool's overflow model", () => {
    expect(moved(held({ pools: [gpu({ overflow: canGo(["free"]) }), free({ overflowModel: "free/fast" })] }, { id: "t1" }))).toEqual([["t1", "free", "free/fast"]]);
  });

  it("takes a placement target on an up engine", () => {
    const s = held({ pools: [gpu({ overflow: canGo(["free"]) }), free({ hosts: [host("h2")], placement: [{ model: "e2/m", hostId: "h2" }] })], hosts: { h1: upHost("h1"), h2: upHost("h2") } }, { id: "t1" });
    expect(moved(s)).toEqual([["t1", "free", "e2/m"]]);
  });

  it("skips a placement target on a down engine", () => {
    const s = held({ pools: [gpu({ overflow: canGo(["free"]) }), free({ hosts: [host("h2"), host("h3")], placement: [{ model: "e2/m", hostId: "h2" }] })], hosts: { h1: upHost("h1"), h2: downHost("h2"), h3: upHost("h3") } }, { id: "t1" });
    expect(moved(s)).toEqual([["t1", "free", "free/gpt-x"]]);
  });

  it("a quota target gives a model with quota left", () => {
    const s = held({
      pools: [gpu({ overflow: canGo(["free"]) }), free({ kind: "quota", patterns: ["m1", "m2"], placement: [{ model: "m1" }, { model: "m2" }] })],
      exhausted: { "|m1": { since: minutesAgo(10), reason: "quota used up" } },
    }, { id: "t1" });
    expect(moved(s)).toEqual([["t1", "free", "m2"]]);
  });

  it("a pool that keeps its own name overflows tasks onto that name", () => {
    const s = held({ pools: [gpu({ overflow: canGo(["free"]) }), free({ keepPoolName: true, agentModel: "pool/free", placement: undefined })] }, { id: "t1" });
    expect(moved(s)).toEqual([["t1", "free", "pool/free"]]);
  });
});

// The override a previous cycle's overflow wrote, as the store keeps it (D3).
const record = (over: Partial<OverrideRecord> = {}): OverrideRecord => ({
  issueId: "t1", agentId: "a1", model: "free/gpt-x", original: { adapterConfig: { model: "gpu/m" } }, fromPoolId: "gpu", toPoolId: "free", at: minutesAgo(40), ...over,
});
// A task that overflowed earlier and now sits in the target pool.
const overflowedTo = (over: Partial<Snapshot> = {}, rec: Partial<OverrideRecord> = {}): Snapshot =>
  at({ pools: [gpu({ overflow: undefined }), free()], runs: [], tasks: [task("t1", { poolId: "free" })], ...over, overflowOverrides: { t1: record(rec) } });

describe("restore after overflow (D3)", () => {
  it("puts the original model back once the run is over (AC3)", () => {
    // A run that finished, failed or cancelled is gone from the snapshot, its task open again with no run.
    for (const status of ["todo", "in_review", "blocked"] as const) {
      expect(restored(overflowedTo({ tasks: [task("t1", { poolId: "free", status })] }))).toEqual([
        { kind: "restore", issueId: "t1", companyId: "c1", original: { adapterConfig: { model: "gpu/m" } } },
      ]);
    }
  });

  it("removes the plugin's own override when the task had none", () => {
    expect(restored(overflowedTo({}, { original: null })).map((x) => x.original)).toEqual([null]);
  });

  it("leaves the task alone while its run is still going", () => {
    expect(restored(overflowedTo({ runs: [run("t1", { poolId: "free" })], tasks: [task("t1", { poolId: "free", hasActiveRun: true })] }))).toEqual([]);
  });

  it("waits for the run of its own release to show up", () => {
    const s = overflowedTo({ released: [released("t1", { poolId: "free" })] });
    expect(restored(s)).toEqual([]);
  });

  it("leaves a task held in its queue, which wants a run, not a model", () => {
    expect(restored(overflowedTo({ holds: [hold("t1", { poolId: "free" })], tasks: [task("t1", { poolId: "free", status: "blocked" })] }))).toEqual([]);
  });

  it("leaves a model a person set after the overflow (D4)", () => {
    expect(restored(overflowedTo({ tasks: [task("t1", { poolId: "free", pinned: true })] }))).toEqual([]);
  });

  it("says nothing about a task that left the board", () => {
    expect(restored(overflowedTo({ tasks: [task("t1", { poolId: "free", status: "done" })] }))).toEqual([]);
  });

  it("restores only the task whose own run ended", () => {
    const s = overflowedTo({ runs: [run("r9", { poolId: "free", issueId: "r9", agentId: "a9" })], tasks: [task("t1", { poolId: "free" }), task("r9", { poolId: "free", hasActiveRun: true })] });
    expect(restored(s).map((x) => x.issueId)).toEqual(["t1"]);
  });
});
