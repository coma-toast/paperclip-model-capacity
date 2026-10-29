import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Company, Issue, PluginCapability } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { LEVEL_KINDS, alertText, createAlerter } from "../src/alerts.js";
import manifest from "../src/manifest.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { RunRow } from "../src/snapshot.js";
import { createStore } from "../src/state/store.js";
import type { AlertEvent } from "../src/types.js";
import { NOW, host, minutesAgo, pool } from "./fixtures/snapshot.js";
import { openAiRoutes } from "./fakes/openai.js";
import { startFake } from "./fakes/server.js";

const CAPS: PluginCapability[] = [...manifest.capabilities];
const company = (id: string) => ({ id, name: id }) as unknown as Company;
const issue = (id: string, companyId: string, over: Partial<Issue> = {}) =>
  ({ id, companyId, title: id, status: "todo", priority: "medium", assigneeAgentId: null, assigneeUserId: null, assigneeAdapterOverrides: null, labelIds: [], ...over }) as unknown as Issue;
const ev = (kind: AlertEvent["kind"], subject: string, state: AlertEvent["state"] = "start", over: Partial<AlertEvent> = {}): AlertEvent =>
  ({ kind, subject, state, message: `${subject} message`, at: NOW, companyId: "c1", ...over });

const setup = (alertIssues: Record<string, string> = { c1: "alerts-c1" }) => {
  const harness = createTestHarness({ manifest, capabilities: CAPS });
  harness.seed({ companies: [company("c1"), company("c2")], issues: [issue("alerts-c1", "c1"), issue("alerts-c2", "c2"), issue("assigned", "c1", { assigneeAgentId: "a1" })] });
  const store = createStore(harness.ctx.state);
  const alerter = createAlerter({ ctx: harness.ctx, store, alertIssueId: async (c) => alertIssues[c] });
  const comments = async (id = "alerts-c1", c = "c1") => (await harness.ctx.issues.listComments(id, c)).map((x) => x.body);
  return { harness, store, alerter, comments };
};

describe("dedupe (G3)", () => {
  it("comments once on start and once on clear, however often a condition repeats", async () => {
    const { alerter, comments, store } = setup();
    await alerter.apply([ev("hostDown", "h1")]);
    await alerter.apply([ev("hostDown", "h1")]);
    await alerter.apply([ev("hostDown", "h1", "clear")]);
    await alerter.apply([ev("hostDown", "h1", "clear")]);
    expect(await comments()).toEqual(["⚠️ Host down: h1 message", "✅ Host down (cleared): h1 message"]);
    expect((await store.alerts.get()).active).toEqual({});
    expect((await store.alerts.get()).recent.map((a) => a.state)).toEqual(["start", "clear"]);
  });

  it("level kinds stay open across sweeps and clear when they stop being reported", async () => {
    const { alerter, comments } = setup();
    const over = ev("overLimit", "gpu");
    for (let sweep = 0; sweep < 3; sweep++) await alerter.sync(LEVEL_KINDS, [over], NOW);
    expect(await comments()).toHaveLength(1);
    await alerter.sync(LEVEL_KINDS, [], NOW);
    await alerter.sync(LEVEL_KINDS, [], NOW);
    expect(await comments()).toEqual(["⚠️ Pool over its limit: gpu message", "✅ Pool over its limit (cleared): gpu message"]);
  });

  it("sync only clears its own kinds", async () => {
    const { alerter, store } = setup();
    await alerter.apply([ev("hostDown", "h1")]);
    await alerter.sync(LEVEL_KINDS, [], NOW);
    expect(Object.keys((await store.alerts.get()).active)).toEqual(["hostDown:h1"]);
  });

  it("keys by subject, so two tasks waiting too long are two alerts", async () => {
    const { alerter, comments } = setup();
    await alerter.sync(LEVEL_KINDS, [ev("waitedTooLong", "t1"), ev("waitedTooLong", "t2")], NOW);
    expect(await comments()).toHaveLength(2);
  });
});

describe("channels (G2)", () => {
  it("logs activity and comments for the alert's company", async () => {
    const { alerter, harness, comments } = setup({ c1: "alerts-c1", c2: "alerts-c2" });
    await alerter.apply([ev("overLimit", "gpu:c2", "start", { companyId: "c2" })]);
    expect(await comments("alerts-c2", "c2")).toHaveLength(1);
    expect(await comments()).toEqual([]);
    expect(harness.activity.map((a) => a.message)).toEqual(["⚠️ Pool over its limit: gpu:c2 message"]);
  });

  it("sends an instance-wide alert to every company", async () => {
    const { alerter, harness, comments } = setup({ c1: "alerts-c1", c2: "alerts-c2" });
    await alerter.apply([ev("hostDown", "h1", "start", { companyId: undefined })]);
    expect(await comments()).toHaveLength(1);
    expect(await comments("alerts-c2", "c2")).toHaveLength(1);
    expect(harness.activity).toHaveLength(2);
  });

  it("won't comment on an assigned task, because that would wake its assignee", async () => {
    const { alerter, harness, comments } = setup({ c1: "assigned" });
    await alerter.apply([ev("hostDown", "h1")]);
    expect(await comments("assigned")).toEqual([]);
    expect(harness.logs.some((l) => l.message === "Alert task is missing or assigned; not commenting")).toBe(true);
    expect(harness.activity).toHaveLength(1);
  });

  it("still logs activity when no alert task is configured", async () => {
    const { alerter, harness } = setup({});
    await alerter.apply([ev("hostDown", "h1")]);
    expect(harness.activity).toHaveLength(1);
  });
});

describe("worker integration", () => {
  const runtimes: Runtime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  });

  const agent = { id: "a1", companyId: "c1", name: "a1", status: "idle", adapterConfig: { model: "gateway/gpu" } } as unknown as Agent;

  it("alerts once for a held task past alertAfterMinutes, across sweeps, and clears when it is released", async () => {
    const harness = createTestHarness({ manifest, capabilities: CAPS });
    harness.seed({ companies: [company("c1")], agents: [agent], issues: [issue("alerts-c1", "c1"), issue("i0", "c1", { assigneeAgentId: "a1", status: "in_progress" }), issue("t1", "c1", { assigneeAgentId: "a1" })] });
    harness.setConfig({ alertIssueId: "alerts-c1" });
    let runs: RunRow[] = [{ id: "r0", company_id: "c1", agent_id: "a1", issue_id: "i0", status: "running", started_at: NOW }];
    const rt = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => runs });
    runtimes.push(rt);
    await rt.store.companies.set([{ id: "c1", name: "c1" }]);
    await rt.store.pools.set([pool("gpu", { patterns: ["gateway/gpu"], alertAfterMinutes: 30 })]);
    await rt.cycle("sweep");
    await rt.store.holds.set({ t1: { ...(await rt.store.holds.get()).t1, heldAt: minutesAgo(45) } });
    await rt.cycle("sweep");
    await rt.cycle("sweep");
    const bodies = async () => (await harness.ctx.issues.listComments("alerts-c1", "c1")).map((c) => c.body);
    expect(await bodies()).toEqual(["⚠️ Task waiting too long: Waiting for gpu over 30 min"]);
    runs = [];
    harness.seed({ issues: [issue("i0", "c1", { assigneeAgentId: "a1", status: "done" })] });
    await rt.cycle("sweep");
    expect((await bodies()).at(-1)).toBe("✅ Task waiting too long (cleared): Waiting for gpu over 30 min");
  });

  it("alerts host down from the probe loop, opens no alert for a first come-up, and never shows the host URL", async () => {
    const harness = createTestHarness({ manifest, capabilities: CAPS });
    harness.seed({ companies: [company("c1")], issues: [issue("alerts-c1", "c1")] });
    harness.setConfig({ alertIssueId: "alerts-c1" });
    const fake = await startFake(openAiRoutes());
    const rt = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(rt);
    await rt.store.pools.set([pool("gpu", { hosts: [host("h1", { name: "gpu box", engine: "openai", baseUrl: fake.baseUrl })] })]);
    await rt.probeTick();
    await rt.probeTick();
    await fake.close();
    for (let i = 0; i < 3; i++) await rt.probeTick();
    const bodies = (await harness.ctx.issues.listComments("alerts-c1", "c1")).map((c) => c.body);
    // The first down -> up isn't an alert (nothing was open); the later up -> down is.
    expect(bodies).toEqual(["⚠️ Host down: gpu box is not answering health checks"]);
    for (const text of [...bodies, ...harness.activity.map((a) => a.message)]) expect(text).not.toContain(new URL(fake.baseUrl).host);
  });
});

describe("alertText", () => {
  it("formats start and clear", () => {
    expect(alertText(ev("pluginError", "cycle", "start", { message: "A capacity cycle failed" }))).toBe("⚠️ Model capacity plugin error: A capacity cycle failed");
    expect(alertText(ev("hostDown", "h1", "clear", { message: "gpu is back up" }))).toBe("✅ Host down (cleared): gpu is back up");
  });
});
