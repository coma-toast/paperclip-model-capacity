import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Company, Issue } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { RunRow } from "../src/snapshot.js";
import plugin from "../src/worker.js";
import { NOW, host, pool } from "./fixtures/snapshot.js";
import { openAiRoutes } from "./fakes/openai.js";
import { startFake } from "./fakes/server.js";

const company = { id: "c1", name: "c1" } as unknown as Company;
const agent = { id: "a1", companyId: "c1", name: "a1", status: "idle", adapterConfig: { model: "gateway/gpu" } } as unknown as Agent;
const issue = (id: string, over: Partial<Issue> = {}) =>
  ({ id, companyId: "c1", title: id, status: "todo", priority: "medium", assigneeAgentId: "a1", assigneeAdapterOverrides: null, labelIds: [], ...over }) as unknown as Issue;
const busyRun: RunRow = { id: "r0", company_id: "c1", agent_id: "a1", issue_id: "i0", status: "running", started_at: NOW };

const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});

const setup = async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [company], agents: [agent], issues: [issue("i0", { status: "in_progress" }), issue("t1")] });
  let runs: RunRow[] = [busyRun];
  const make = () => {
    const rt = createRuntime(harness.ctx, { debounceMs: 20, probeIntervalMs: 0, readRuns: async () => runs });
    runtimes.push(rt);
    return rt;
  };
  const runtime = make();
  await runtime.store.companies.set([{ id: "c1", name: "c1" }]);
  await runtime.store.companyPools("c1").set([pool("gpu", { patterns: ["gateway/gpu"] })]);
  return { harness, runtime, make, setRuns: (r: RunRow[]) => { runs = r; } };
};

const blockedBy = async (harness: ReturnType<typeof createTestHarness>, id: string) =>
  (await harness.ctx.issues.relations.get(id, "c1")).blockedBy.map((b) => b.id);

describe("event wiring", () => {
  it("holds while full, then releases within one debounce of agent.run.finished", async () => {
    const { harness, runtime, setRuns } = await setup();
    runtime.start();
    await runtime.cycle("sweep");
    expect(Object.keys(await runtime.store.holds.get())).toEqual(["t1"]);
    expect(await blockedBy(harness, "t1")).toHaveLength(1);

    // The run finished and its task closed, so only t1 is waiting.
    setRuns([]);
    harness.seed({ issues: [issue("i0", { status: "done" })] });
    await harness.emit("agent.run.finished", { runId: "r0", agentId: "a1", issueId: "i0", status: "succeeded" }, { companyId: "c1" });
    await runtime.idle();
    expect(await runtime.store.holds.get()).toEqual({});
    expect(await blockedBy(harness, "t1")).toEqual([]);
    expect((await runtime.store.released.get()).t1.runId).toBeTruthy();
  });

  it("collapses a burst of run events into one cycle", async () => {
    const { harness, runtime } = await setup();
    runtime.start();
    for (let i = 0; i < 5; i++) await harness.emit("agent.run.started", { runId: `r${i}` }, { companyId: "c1" });
    await runtime.idle();
    expect(harness.dbQueries).toHaveLength(0);
    expect((await runtime.store.historyDays()).length).toBe(1);
    expect((await runtime.store.history(new Date().toISOString().slice(0, 10))).filter((e) => e.action.kind === "hold")).toHaveLength(1);
  });
});

describe("invocation context (live-install bug, 2026-10-29)", () => {
  it("runs a debounced cycle outside the event's async context, so it carries no expired invocation id", async () => {
    const { harness } = await setup();
    const sdkLike = new AsyncLocalStorage<{ id: string }>();
    const seen: (string | undefined)[] = [];
    const rt = createRuntime(harness.ctx, { debounceMs: 20, probeIntervalMs: 0, readRuns: async () => { seen.push(sdkLike.getStore()?.id); return []; } });
    runtimes.push(rt);
    await rt.store.companyPools("c1").set([pool("gpu", { patterns: ["gateway/gpu"] })]);
    sdkLike.run({ id: "event-invocation" }, () => rt.schedule("agent.run.finished"));
    await rt.idle();
    expect(seen).toEqual([undefined]);
  });

  it("learns companies from events and lists them for timer work without calling companies.list", async () => {
    const { harness, runtime } = await setup();
    const { createCompanyDirectory } = await import("../src/snapshot.js");
    let now = 0;
    await runtime.store.companies.set([]);
    const dir = createCompanyDirectory(harness.ctx, runtime.store, () => now);
    expect(await dir.list()).toEqual([]);
    await dir.noteFromEvent("c1");
    expect((await dir.list()).map((c) => [c.id, c.name])).toEqual([["c1", "c1"]]);
    const calls: string[] = [];
    const original = harness.ctx.companies.list;
    harness.ctx.companies.list = async (input) => { calls.push("list"); return original(input); };
    now = 6 * 60_000;
    await dir.noteFromEvent("c1");
    await dir.list();
    await dir.list();
    expect(calls).toEqual(["list"]);
    harness.ctx.companies.list = async () => { throw new Error("invocation scope"); };
    now = 12 * 60_000;
    await dir.noteFromEvent("c9");
    expect((await dir.list()).map((c) => c.id).sort()).toEqual(["c1", "c9"]);
  });

  it("stops listing a refused company until the backoff passes", async () => {
    const { harness, runtime } = await setup();
    const { createCompanyDirectory, DENIED_COMPANY_BACKOFF_MS } = await import("../src/snapshot.js");
    let now = 0;
    await runtime.store.companies.set([{ id: "c1", name: "c1" }, { id: "c2", name: "c2" }]);
    const dir = createCompanyDirectory(harness.ctx, runtime.store, () => now);
    dir.markDenied(["c2"]);
    expect((await dir.list()).map((c) => c.id)).toEqual(["c1"]);
    now = DENIED_COMPANY_BACKOFF_MS + 1;
    expect((await dir.list()).map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("a sweep with no known companies yet finishes cleanly with an empty snapshot", async () => {
    const harness = createTestHarness({ manifest });
    const rt = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(rt);
    await rt.cycle("sweep");
    expect(rt.health().lastError).toBeUndefined();
  });
});

describe("restart (AC9 part 1)", () => {
  it("a new worker picks up holds from state on the sweep job, without re-commenting", async () => {
    const { harness, runtime, make, setRuns } = await setup();
    runtime.start();
    await runtime.cycle("sweep");
    await runtime.stop();

    const restarted = make();
    restarted.start();
    await harness.runJob("sweep");
    expect(Object.keys(await restarted.store.holds.get())).toEqual(["t1"]);
    expect(await harness.ctx.issues.listComments("t1", "c1")).toHaveLength(1);

    setRuns([]);
    harness.seed({ issues: [issue("i0", { status: "done" })] });
    await harness.runJob("sweep");
    expect(await restarted.store.holds.get()).toEqual({});
    expect(await blockedBy(harness, "t1")).toEqual([]);
  });
});

describe("probe tick", () => {
  it("writes host status and logs up/down changes", async () => {
    const { harness, runtime } = await setup();
    const fake = await startFake(openAiRoutes());
    try {
      await runtime.store.companyPools("c1").set([pool("gpu", { patterns: ["gateway/gpu"], hosts: [host("h1", { engine: "openai", baseUrl: fake.baseUrl })] })]);
      await runtime.probeTick();
      await runtime.probeTick();
      expect((await runtime.store.hosts.get())["c1:h1"].up).toBe(true);
      await fake.close();
      for (let i = 0; i < 3; i++) await runtime.probeTick();
      expect((await runtime.store.hosts.get())["c1:h1"].up).toBe(false);
      expect(harness.logs.filter((l) => l.message === "Model capacity host changed").map((l) => l.meta)).toEqual([{ hostId: "c1:h1", up: true }, { hostId: "c1:h1", up: false }]);
    } finally {
      await fake.close().catch(() => undefined);
    }
  });
});

describe("manifest and plugin hooks", () => {
  it("declares the jobs, capabilities and database read the worker uses", () => {
    expect(manifest.jobs?.map((j) => [j.jobKey, j.schedule])).toEqual([["sweep", "* * * * *"], ["prune", "0 4 * * *"]]);
    expect(manifest.database).toEqual({ migrationsDir: "migrations", coreReadTables: ["heartbeat_runs"] });
    for (const cap of ["jobs.schedule", "issues.wakeup", "issue.relations.write", "database.namespace.read", "http.outbound"] as const) {
      expect(manifest.capabilities).toContain(cap);
    }
  });

  it("every migration statement names the plugin's own schema", () => {
    const schema = `plugin_${manifest.id.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 36)}_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;
    for (const file of readdirSync("migrations")) {
      const sql = readFileSync(`migrations/${file}`, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("--"));
      for (const statement of sql) expect(statement).toContain(`${schema}.`);
    }
  });

  it("rejects unknown and non-text settings", async () => {
    expect(await plugin.definition.onValidateConfig!({ queueLabelId: "lbl" })).toEqual({ ok: true });
    expect(await plugin.definition.onValidateConfig!({ queueLabel: "x", alertIssueId: 3 })).toEqual({
      ok: false, errors: ["queueLabel: unknown setting", "alertIssueId: must be a text id"],
    });
  });
});
