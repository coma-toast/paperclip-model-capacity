import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { HISTORY_MAX_PER_DAY, STATE_SCHEMA_VERSION } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { StateVersionError, createStore, readVersioned, type HistoryEntry } from "../src/state/store.js";
import { hold, pool, upHost } from "./fixtures/snapshot.js";

const setup = () => {
  const harness = createTestHarness({ manifest });
  return { harness, state: harness.ctx.state, store: createStore(harness.ctx.state) };
};

const entry = (at: string, issueId = "t1"): HistoryEntry => ({
  at, applied: false, action: { kind: "hold", issueId, companyId: "c1", poolId: "gpu", position: 1 },
});

describe("store round-trips", () => {
  it("returns defaults when nothing is stored", async () => {
    const { store } = setup();
    expect(await store.pools.get()).toEqual([]);
    expect(await store.holds.get()).toEqual({});
    expect(await store.queueBlockers("c1").get()).toEqual({});
  });

  it("round-trips every instance blob, versioned", async () => {
    const { harness, store } = setup();
    await store.pools.set([pool("gpu")]);
    await store.hosts.set({ h1: upHost("h1", 1, 0) });
    await store.holds.set({ t1: hold("t1") });
    await store.released.set({ t2: { issueId: "t2", companyId: "c1", poolId: "gpu", runId: "r2", releasedAt: "2026-10-28T12:00:00.000Z" } });
    await store.heldPools.set(["gpu"]);
    expect(await store.pools.get()).toEqual([pool("gpu")]);
    expect(await store.hosts.get()).toEqual({ h1: upHost("h1", 1, 0) });
    expect((await store.holds.get()).t1.issueId).toBe("t1");
    expect((await store.released.get()).t2.runId).toBe("r2");
    expect(await store.heldPools.get()).toEqual(["gpu"]);
    expect(harness.getState({ scopeKind: "instance", stateKey: "pools" })).toEqual({ version: STATE_SCHEMA_VERSION, data: [pool("gpu")] });
  });

  it("keeps queue blockers per company", async () => {
    const { store } = setup();
    await store.queueBlockers("c1").set({ gpu: "blocker-1" });
    await store.queueBlockers("c2").set({ gpu: "blocker-2" });
    expect(await store.queueBlockers("c1").get()).toEqual({ gpu: "blocker-1" });
    expect(await store.queueBlockers("c2").get()).toEqual({ gpu: "blocker-2" });
  });
});

describe("history", () => {
  it("appends per day and keeps an index of days", async () => {
    const { store } = setup();
    await store.appendHistory([entry("2026-10-27T23:59:00.000Z"), entry("2026-10-28T00:01:00.000Z")]);
    await store.appendHistory([entry("2026-10-28T09:00:00.000Z", "t2")]);
    expect(await store.historyDays()).toEqual(["2026-10-27", "2026-10-28"]);
    expect((await store.history("2026-10-28")).map((e) => e.at)).toEqual(["2026-10-28T00:01:00.000Z", "2026-10-28T09:00:00.000Z"]);
  });

  it("caps a day at the newest entries", async () => {
    const { store } = setup();
    const many = Array.from({ length: HISTORY_MAX_PER_DAY + 5 }, (_, i) => entry(`2026-10-28T10:00:00.000Z`, `t${i}`));
    await store.appendHistory(many);
    const day = await store.history("2026-10-28");
    expect(day).toHaveLength(HISTORY_MAX_PER_DAY);
    expect(day[0].action.kind === "hold" && day[0].action.issueId).toBe("t5");
  });

  it("prunes days past retention and drops them from the index", async () => {
    const { harness, store } = setup();
    await store.appendHistory([entry("2026-09-20T10:00:00.000Z"), entry("2026-10-20T10:00:00.000Z"), entry("2026-10-28T10:00:00.000Z")]);
    expect(await store.pruneHistory(new Date("2026-10-28T12:00:00.000Z"), 30)).toBe(1);
    expect(await store.historyDays()).toEqual(["2026-10-20", "2026-10-28"]);
    expect(harness.getState({ scopeKind: "instance", stateKey: "history:2026-09-20" })).toBeUndefined();
  });
});

describe("versioning", () => {
  it("migrates an unversioned blob on read and writes it back versioned", async () => {
    const { harness, state, store } = setup();
    await state.set({ scopeKind: "instance", stateKey: "heldPools" }, ["gpu"]);
    expect(await store.heldPools.get()).toEqual(["gpu"]);
    expect(harness.getState({ scopeKind: "instance", stateKey: "heldPools" })).toEqual({ version: STATE_SCHEMA_VERSION, data: ["gpu"] });
  });

  it("runs each migration step in order", async () => {
    const { harness, state } = setup();
    const key = { scopeKind: "instance" as const, stateKey: "pools" };
    await state.set(key, { version: 1, data: [{ id: "gpu", max: 2 }] });
    const migrations = {
      1: (d: unknown) => (d as { id: string; max: number }[]).map(({ id, max }) => ({ id, limit: max })),
      2: (d: unknown) => (d as { id: string; limit: number }[]).map((p) => ({ ...p, mode: "observe" })),
    };
    expect(await readVersioned(state, key, [], migrations, 3)).toEqual([{ id: "gpu", limit: 2, mode: "observe" }]);
    expect(harness.getState(key)).toEqual({ version: 3, data: [{ id: "gpu", limit: 2, mode: "observe" }] });
  });

  it("refuses a blob from a newer plugin instead of overwriting it", async () => {
    const { harness, state, store } = setup();
    const key = { scopeKind: "instance" as const, stateKey: "pools" };
    await state.set(key, { version: STATE_SCHEMA_VERSION + 1, data: "future" });
    await expect(store.pools.get()).rejects.toBeInstanceOf(StateVersionError);
    expect(harness.getState(key)).toEqual({ version: STATE_SCHEMA_VERSION + 1, data: "future" });
  });

  it("fails clearly when a migration step is missing", async () => {
    const { state } = setup();
    const key = { scopeKind: "instance" as const, stateKey: "pools" };
    await state.set(key, { version: 1, data: [] });
    await expect(readVersioned(state, key, [], {}, 2)).rejects.toThrow("no migration from version 1");
  });
});
