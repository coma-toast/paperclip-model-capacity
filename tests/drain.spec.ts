import { describe, expect, it } from "vitest";

import { DRAIN_GRACE_MS, drainStep, drainingRuns, isDraining } from "../src/drain.js";
import type { PoolConfig } from "../src/types.js";
import { NOW, minutesAgo, run, snapshot } from "./fixtures/snapshot.js";

const backends = [
  { id: "proxy", name: "Proxy", type: "litellm" as const, baseUrl: "https://proxy" },
  { id: "mac", name: "Mac", type: "omlx" as const, baseUrl: "http://mac:1235", slots: 4, reachVia: "proxy", reachModel: "l/mbp" },
  { id: "gpu", name: "GPU", type: "llamacpp" as const, baseUrl: "http://gpu:8091", slots: 1, reachVia: "proxy", reachModel: "l/vm" },
];
const local = (engines: PoolConfig["engines"], over: Partial<PoolConfig> = {}): PoolConfig => ({
  id: "local", name: "Local", kind: "engine", engines, patterns: [], limit: 0, privacy: "private", mode: "enforce", scope: "instance", hosts: [], alertAfterMinutes: 30, ...over,
});

describe("draining engines", () => {
  it("drains an engine capped at 0 or in no enabled engine pool, never a proxy", () => {
    expect(isDraining(backends[1], [local([{ engine: "mac", cap: 0 }, { engine: "gpu" }])])).toBe(true);
    expect(isDraining(backends[2], [local([{ engine: "mac", cap: 0 }, { engine: "gpu" }])])).toBe(false);
    expect(isDraining(backends[1], [local([{ engine: "gpu" }])])).toBe(true);
    expect(isDraining(backends[2], [local([{ engine: "gpu" }], { disabled: true })])).toBe(true);
    expect(isDraining(backends[1], [local([{ engine: "mac", cap: 0 }]), local([{ engine: "mac", cap: 1 }], { id: "other" })])).toBe(false);
    expect(isDraining(backends[0], [])).toBe(false);
  });

  it("moves only a run the plugin placed there, 30 min after it was first seen draining", () => {
    const snap = snapshot({
      runs: [run("t1", { model: "l/mbp" }), run("t2", { model: "l/mbp" }), run("t3", { model: "l/vm" })],
      placements: { t1: "l/mbp", t3: "l/vm" },
    });
    const pools = [local([{ engine: "mac", cap: 0 }, { engine: "gpu" }])];
    const draining = drainingRuns(snap, "c1", backends, pools, {});
    expect(draining.map((d) => [d.run.issueId, d.moveAt])).toEqual([["t1", new Date(Date.parse(NOW) + DRAIN_GRACE_MS).toISOString()], ["t2", undefined]]);
    const first = drainStep(draining, {}, {}, new Date(NOW));
    expect(first.since).toEqual({ "run-t1": NOW, "run-t2": NOW });
    expect(first.move).toEqual([]);

    const later = drainingRuns(snap, "c1", backends, pools, { "run-t1": minutesAgo(31), "run-t2": minutesAgo(31), "run-gone": minutesAgo(5) });
    const step = drainStep(later, { "run-t1": minutesAgo(31), "run-t2": minutesAgo(31), "run-gone": minutesAgo(5) }, {}, new Date(NOW));
    expect(step.move.map((d) => d.run.issueId)).toEqual(["t1"]);
    expect(Object.keys(step.since)).toEqual(["run-t1", "run-t2"]);
  });

  it("moves a run at once when a board user asks", () => {
    const snap = snapshot({ runs: [run("t1", { model: "l/mbp" })], placements: { t1: "l/mbp" } });
    const draining = drainingRuns(snap, "c1", backends, [local([{ engine: "gpu" }])], {});
    expect(drainStep(draining, {}, { "run-t1": { userId: "u", at: NOW } }, new Date(NOW)).move.map((d) => d.run.issueId)).toEqual(["t1"]);
  });
});
