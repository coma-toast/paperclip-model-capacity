import { describe, expect, it } from "vitest";

import { decide } from "../src/scheduler/decide.js";
import type { Action } from "../src/types.js";
import { downHost, hold, host, minutesAgo, pool, run, snapshot, task, upHost } from "./fixtures/snapshot.js";

// A sticky pool: l/local is an entry model; l/mbp reaches the mbp engine (2 slots, tried first), l/vm the vm (1 slot).
const local = (over = {}) => pool("gpu", {
  limit: 5, patterns: ["l/local", "l/mbp", "l/vm"],
  hosts: [host("mbp", { declaredSlots: 2 }), host("vm", { declaredSlots: 1 })],
  placement: [{ model: "l/mbp", hostId: "mbp" }, { model: "l/vm", hostId: "vm" }],
  ...over,
});
const bothUp = { mbp: upHost("mbp"), vm: upHost("vm") };
const busyMbp = { runs: [run("r1", { model: "l/mbp" }), run("r2", { model: "l/mbp" })], running: [task("r1", { model: "l/mbp", hasActiveRun: true }), task("r2", { model: "l/mbp", hasActiveRun: true })] };
const short = (a: Action[]) => a.filter((x) => x.kind !== "alert").map((x) =>
  x.kind === "place" ? `place ${x.issueId} ${x.model} ${x.reason}` : x.kind === "release" ? `release ${x.issueId}${x.model ? ` ${x.model}` : ""}` : x.kind === "hold" ? `hold ${x.issueId}` : x.kind);

describe("sticky pools (P2.6)", () => {
  it("places a new task on the preferred engine with room", () => {
    expect(short(decide(snapshot({ pools: [local()], hosts: bothUp, tasks: [task("t1", { model: "l/local" })] })))).toEqual(["place t1 l/mbp new"]);
  });

  it("places on the next engine when the preferred one is full", () => {
    const s = snapshot({ pools: [local()], hosts: bothUp, runs: busyMbp.runs, tasks: [...busyMbp.running, task("t1", { model: "l/local" })] });
    expect(short(decide(s))).toEqual(["place t1 l/vm new"]);
  });

  it("a placed task waits for its own full engine even when another is free", () => {
    const s = snapshot({
      pools: [local()], hosts: bothUp, runs: busyMbp.runs,
      holds: [hold("t1")], tasks: [...busyMbp.running, task("t1", { model: "l/mbp", status: "blocked" }), task("t2", { model: "l/mbp" })],
    });
    expect(short(decide(s))).toEqual(["hold t2"]);
  });

  it("releases a placed task onto its engine when that engine frees up", () => {
    const s = snapshot({ pools: [local()], hosts: bothUp, holds: [hold("t1")], tasks: [task("t1", { model: "l/mbp", status: "blocked" })] });
    expect(short(decide(s))).toEqual(["release t1 l/mbp"]);
  });

  it("moves a task the plugin placed only after its engine has been down 30 minutes", () => {
    const base = { pools: [local()], holds: [hold("t1")], tasks: [task("t1", { model: "l/mbp", status: "blocked" })], placements: { t1: "l/mbp" } };
    const downFor = (m: number) => ({ mbp: { ...downHost("mbp"), lastChangeAt: minutesAgo(m) }, vm: upHost("vm") });
    expect(short(decide(snapshot({ ...base, hosts: downFor(10) })))).toEqual([]);
    expect(short(decide(snapshot({ ...base, hosts: downFor(40) })))).toEqual(["place t1 l/vm engineDown", "release t1 l/vm"]);
    // A task on an engine by its agent's default or a person's pin is never moved.
    expect(short(decide(snapshot({ ...base, placements: {}, hosts: downFor(40) })))).toEqual([]);
  });

  it("puts a subtask on its parent's engine, and waits for it rather than using another", () => {
    const parent = task("p1", { model: "l/vm", hasActiveRun: true });
    const child = task("c1", { model: "l/local", parentId: "p1" });
    expect(short(decide(snapshot({ pools: [local()], hosts: bothUp, tasks: [parent, child] })))).toEqual(["place c1 l/vm parent"]);
    const vmBusy = snapshot({ pools: [local()], hosts: bothUp, runs: [run("p1", { model: "l/vm" })], tasks: [parent, child] });
    expect(short(decide(vmBusy))).toEqual(["hold c1"]);
    // A closed parent's placement still counts.
    expect(short(decide(snapshot({ pools: [local()], hosts: bothUp, tasks: [child], placements: { p1: "l/vm" } })))).toEqual(["place c1 l/vm parent"]);
  });

  it("never replaces a person's override on an entry model", () => {
    expect(short(decide(snapshot({ pools: [local()], hosts: bothUp, tasks: [task("t1", { model: "l/local", pinned: true })] })))).toEqual([]);
    expect(short(decide(snapshot({ pools: [local()], hosts: bothUp, holds: [hold("t1")], tasks: [task("t1", { model: "l/local", pinned: true, status: "blocked" })] })))).toEqual(["release t1"]);
  });

  it("keeps the pool limit on top of per-engine room", () => {
    const s = snapshot({ pools: [local({ limit: 1 })], hosts: bothUp, runs: [run("r1", { model: "l/mbp" })], tasks: [task("r1", { model: "l/mbp", hasActiveRun: true }), task("t1", { model: "l/local" })] });
    expect(short(decide(s))).toEqual(["hold t1"]);
  });

  it("counts a released task against its engine until its run starts", () => {
    const s = snapshot({
      pools: [local()], hosts: bothUp, runs: [run("r1", { model: "l/mbp" })],
      released: [{ issueId: "x1", companyId: "c1", poolId: "gpu", model: "l/mbp", releasedAt: minutesAgo(0) }],
      tasks: [task("r1", { model: "l/mbp", hasActiveRun: true }), task("t1", { model: "l/local" })],
    });
    expect(short(decide(s))).toEqual(["place t1 l/vm new"]);
  });

  it("places nothing while the pool is disabled", () => {
    expect(short(decide(snapshot({ pools: [local({ disabled: true })], hosts: bothUp, tasks: [task("t1", { model: "l/local" })] })))).toEqual(["hold t1"]);
  });
});
