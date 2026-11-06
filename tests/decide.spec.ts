import { describe, expect, it } from "vitest";

import { availableCapacity, decide } from "../src/scheduler/decide.js";
import type { Action, Snapshot } from "../src/types.js";
import { downHost, heldTask, host, minutesAgo, pool, released, run, snapshot, task, upHost } from "./fixtures/snapshot.js";

const kinds = (actions: Action[], kind: Action["kind"]) => actions.filter((a) => a.kind === kind);
const holds = (actions: Action[]) => kinds(actions, "hold").map((a) => (a.kind === "hold" ? [a.issueId, a.position] : []));
const releases = (actions: Action[]) => kinds(actions, "release").map((a) => (a.kind === "release" ? a.issueId : ""));
const alerts = (actions: Action[]) => kinds(actions, "alert").map((a) => (a.kind === "alert" ? a.alert.kind : ""));
const withHeld = (s: Partial<Snapshot>, ...entries: ReturnType<typeof heldTask>[]) =>
  snapshot({ ...s, holds: [...(s.holds ?? []), ...entries.map((e) => e.hold)], tasks: [...(s.tasks ?? []), ...entries.map((e) => e.task)] });

describe("limits", () => {
  it("limit 0 holds every waiting task", () => {
    const a = decide(snapshot({ pools: [pool("gpu", { limit: 0 })], tasks: [task("t1"), task("t2")] }));
    expect(holds(a)).toEqual([["t1", 1], ["t2", 2]]);
    expect(releases(a)).toEqual([]);
  });

  it("limit 1 with a free slot holds nothing", () => {
    expect(decide(snapshot({ tasks: [task("t1")] }))).toEqual([]);
  });

  it("limit 1 with one run holds the rest", () => {
    const a = decide(snapshot({ runs: [run("r1")], tasks: [task("r1", { hasActiveRun: true }), task("t1")] }));
    expect(holds(a)).toEqual([["t1", 1]]);
  });

  it("limit 3 with two runs releases one held task and holds the next new one", () => {
    const s = withHeld(
      { pools: [pool("gpu", { limit: 3 })], runs: [run("r1"), run("r2")], tasks: [task("t9")] },
      heldTask("h1"),
    );
    const a = decide(s);
    expect(releases(a)).toEqual(["h1"]);
    expect(holds(a)).toEqual([["t9", 1]]);
  });

  it("counts released tasks whose run hasn't started (B2)", () => {
    const a = decide(snapshot({ released: [released("x1")], tasks: [task("t1")] }));
    expect(holds(a)).toEqual([["t1", 1]]);
  });

  it("doesn't count a released task twice once its run appears", () => {
    const a = decide(snapshot({ pools: [pool("gpu", { limit: 2 })], released: [released("x1")], runs: [run("x1")], tasks: [task("t1")] }));
    expect(holds(a)).toEqual([]);
  });
});

describe("queue order (C2)", () => {
  it("releases high, then medium, then low as slots free (AC2)", () => {
    const entries = [heldTask("low", { priority: "low", heldAt: minutesAgo(30) }), heldTask("med", { priority: "medium", heldAt: minutesAgo(20) }), heldTask("high", { priority: "high", heldAt: minutesAgo(1) })];
    let s = withHeld({ runs: [] }, ...entries);
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [next] = releases(decide(s));
      order.push(next);
      s = { ...s, holds: s.holds.filter((h) => h.issueId !== next), tasks: s.tasks.filter((t) => t.issueId !== next) };
    }
    expect(order).toEqual(["high", "med", "low"]);
  });

  it("critical comes before high", () => {
    const a = decide(withHeld({}, heldTask("h", { priority: "high", heldAt: minutesAgo(9) }), heldTask("c", { priority: "critical", heldAt: minutesAgo(1) })));
    expect(releases(a)).toEqual(["c"]);
  });

  it("breaks a priority tie by oldest hold", () => {
    const a = decide(withHeld({}, heldTask("new", { heldAt: minutesAgo(1) }), heldTask("old", { heldAt: minutesAgo(9) })));
    expect(releases(a)).toEqual(["old"]);
  });

  it("breaks a full tie by issue id so results are stable", () => {
    const a = decide(withHeld({}, heldTask("b", { heldAt: minutesAgo(5) }), heldTask("a", { heldAt: minutesAgo(5) })));
    expect(releases(a)).toEqual(["a"]);
  });

  it("gives a new hold its position behind older holds of the same priority", () => {
    const a = decide(withHeld({ runs: [run("r1")], tasks: [task("r1", { hasActiveRun: true }), task("new")] }, heldTask("old")));
    expect(holds(a)).toEqual([["new", 2]]);
  });

  it("puts a new high-priority task ahead of older medium holds", () => {
    const a = decide(withHeld({ runs: [run("r1")], tasks: [task("r1", { hasActiveRun: true }), task("urgent", { priority: "high" })] }, heldTask("old")));
    expect(holds(a)).toEqual([["urgent", 1]]);
  });
});

describe("exemptions (B5)", () => {
  it("never holds an exempt task, but its run still counts", () => {
    const a = decide(snapshot({ runs: [run("ex")], tasks: [task("ex", { exempt: true, hasActiveRun: true }), task("t1"), task("ex2", { exempt: true })] }));
    expect(holds(a)).toEqual([["t1", 1]]);
  });

  it("never holds a task of an exempt agent", () => {
    const a = decide(snapshot({ pools: [pool("gpu", { limit: 0 })], exemptAgentIds: ["boss"], tasks: [task("t1", { agentId: "boss" }), task("t2")] }));
    expect(holds(a)).toEqual([["t2", 1]]);
  });

  it("releases a held task that became exempt, even when full", () => {
    const entry = heldTask("h1");
    const a = decide(snapshot({ runs: [run("r1")], holds: [entry.hold], tasks: [task("r1", { hasActiveRun: true }), { ...entry.task, exempt: true }] }));
    expect(releases(a)).toEqual(["h1"]);
  });
});

describe("hosts (B3, E3)", () => {
  const gpu = pool("gpu", { limit: 4, hosts: [host("h1", { declaredSlots: 2 }), host("h2", { declaredSlots: 2 })] });

  it("uses probed slots over declared, capped by the limit", () => {
    expect(availableCapacity(gpu, snapshot({ hosts: { h1: upHost("h1", 8), h2: upHost("h2") } }), 0)).toBe(4);
    expect(availableCapacity({ ...gpu, limit: 10 }, snapshot({ hosts: { h1: upHost("h1", 8), h2: upHost("h2") } }), 0)).toBe(10);
  });

  it("drops a down host's slots", () => {
    expect(availableCapacity(gpu, snapshot({ hosts: { h1: upHost("h1"), h2: downHost("h2") } }), 0)).toBe(2);
  });

  it("subtracts outside load, never below 0 (Q5)", () => {
    const s = snapshot({ hosts: { h1: upHost("h1", 2, 2), h2: upHost("h2", 2, 1) } });
    expect(availableCapacity(gpu, s, 1)).toBe(2);
    expect(availableCapacity(gpu, s, 5)).toBe(4);
    expect(availableCapacity({ ...gpu, hosts: [host("h1")] }, snapshot({ hosts: { h1: upHost("h1", 1, 3) } }), 0)).toBe(0);
  });

  it("holds new work and releases nothing when every host is down", () => {
    const s = withHeld({ pools: [gpu], hosts: { h1: downHost("h1"), h2: downHost("h2") }, tasks: [task("t1")] }, heldTask("h0"));
    const a = decide(s);
    expect(releases(a)).toEqual([]);
    expect(holds(a)).toEqual([["t1", 2]]);
  });

  it("treats a host with no status yet as down", () => {
    expect(availableCapacity(gpu, snapshot({ hosts: {} }), 0)).toBe(0);
  });

  it("outside load fills the pool, so new work waits", () => {
    const one = pool("gpu", { limit: 1, hosts: [host("h1")] });
    const a = decide(snapshot({ pools: [one], hosts: { h1: upHost("h1", 1, 1) }, tasks: [task("t1")] }));
    expect(holds(a)).toEqual([["t1", 1]]);
  });
});

describe("over limit (B4) and operator hold (F2)", () => {
  it("alerts and releases nothing when a run started outside the plugin", () => {
    const a = decide(withHeld({ runs: [run("r1"), run("r2")], tasks: [task("r1", { hasActiveRun: true }), task("r2", { hasActiveRun: true })] }, heldTask("h1")));
    expect(alerts(a)).toEqual(["overLimit"]);
    expect(releases(a)).toEqual([]);
  });

  it("releases nothing from a held pool and holds new work there", () => {
    const a = decide(withHeld({ pools: [pool("gpu", { limit: 3 })], heldPools: ["gpu"], tasks: [task("t1")] }, heldTask("h1")));
    expect(releases(a)).toEqual([]);
    expect(holds(a)).toEqual([["t1", 2]]);
  });
});

describe("scope and filters (A3)", () => {
  it("instance scope shares one limit across companies", () => {
    const a = decide(snapshot({ runs: [run("r1", { companyId: "c1" })], tasks: [task("t2", { companyId: "c2" })] }));
    expect(holds(a)).toEqual([["t2", 1]]);
  });

  it("company scope gives each company its own limit", () => {
    const a = decide(snapshot({ pools: [pool("gpu", { scope: "company" })], runs: [run("r1", { companyId: "c1" })], tasks: [task("t1", { companyId: "c1" }), task("t2", { companyId: "c2" })] }));
    expect(holds(a)).toEqual([["t1", 1]]);
  });

  it("ignores excluded companies and those outside an include list", () => {
    const excl = decide(snapshot({ pools: [pool("gpu", { limit: 0, companies: { exclude: ["c2"] } })], tasks: [task("t1"), task("t2", { companyId: "c2" })] }));
    expect(holds(excl)).toEqual([["t1", 1]]);
    const incl = decide(snapshot({ pools: [pool("gpu", { limit: 0, companies: { include: ["c2"] } })], tasks: [task("t1"), task("t2", { companyId: "c2" })] }));
    expect(holds(incl)).toEqual([["t2", 1]]);
  });

  it("ignores tasks in unknown pools and closed tasks", () => {
    const a = decide(snapshot({ pools: [pool("gpu", { limit: 0 })], tasks: [task("x", { poolId: "nope" }), task("done", { status: "done" }), task("t1")] }));
    expect(holds(a)).toEqual([["t1", 1]]);
  });
});

describe("mode and alerts", () => {
  it("decides the same in observe and enforce; the executor skips writes (C6)", () => {
    const s = (mode: "observe" | "enforce") => snapshot({ pools: [pool("gpu", { limit: 0, mode })], tasks: [task("t1")] });
    expect(decide(s("observe"))).toEqual(decide(s("enforce")));
  });

  it("alerts for a task held past alertAfterMinutes", () => {
    const a = decide(withHeld({ runs: [run("r1")], tasks: [task("r1", { hasActiveRun: true })] }, heldTask("old", { heldAt: minutesAgo(45) }), heldTask("new", { heldAt: minutesAgo(5) })));
    expect(kinds(a, "alert").map((x) => (x.kind === "alert" ? [x.alert.kind, x.alert.subject] : []))).toEqual([["waitedTooLong", "old"]]);
  });

  it("returns no overflow actions before P2", () => {
    expect(kinds(decide(snapshot({ pools: [pool("gpu", { limit: 0 })], tasks: [task("t1")] })), "overflow")).toEqual([]);
  });
});
