import { describe, expect, it } from "vitest";
import type { Agent, Company, Issue } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { ADAPTER_DOWN_AFTER, readAdapterModels } from "../src/adapterModels.js";
import manifest from "../src/manifest.js";
import { resolvePool } from "../src/pools.js";
import { decide } from "../src/scheduler/decide.js";
import { canAgentRun, cannotRunKey, poolAcceptsAdapter } from "../src/scheduler/model.js";
import { validatePools } from "../src/settings.js";
import { buildSnapshot, CANNOT_RUN, createAgentCache, isRateLimited, type FailureRow } from "../src/snapshot.js";
import { createStore } from "../src/state/store.js";
import type { Action, CannotRun } from "../src/types.js";
import { NOW, pool, snapshot, task } from "./fixtures/snapshot.js";

// JD-1245: terminal-CLI models (agy), and never placing an agent on a model it can't run.

const AGY_MODELS = ["gemini-3.8-flash-medium", "gemini-4-argon-medium", "claude-opus-5-5-high"];
const GINA_ERROR = "The requested model 'gemini-lite' is not available for this API key, or the model name is invalid.";

describe("canAgentRun", () => {
  const limits = { adapterModels: { agy_local: AGY_MODELS } };

  it("lets a CLI agent run only the models its adapter lists", () => {
    expect(canAgentRun({ adapterType: "agy_local" }, "gemini-3.8-flash-medium", limits)).toBe(true);
    expect(canAgentRun({ adapterType: "agy_local" }, "gemini-lite", limits)).toBe(false);
    // agy offers Claude names too; its list decides, not the Claude Code rule.
    expect(canAgentRun({ adapterType: "agy_local" }, "claude-opus-5-5-high", limits)).toBe(true);
  });

  it("keeps the adapter-family rule for Claude Code and Codex", () => {
    expect(canAgentRun({ adapterType: "claude_local" }, "gemini-3.8-flash-medium", limits)).toBe(false);
    expect(canAgentRun({ adapterType: "codex_local" }, "gpt-5.6-terra", limits)).toBe(true);
  });

  it("refuses a model an agent's runs proved it can't use", () => {
    const cannotRun = { [cannotRunKey("gina", "gemini-lite")]: {} };
    expect(canAgentRun({ agentId: "gina", adapterType: "opencode_local" }, "gemini-lite", { cannotRun })).toBe(false);
    expect(canAgentRun({ agentId: "nick", adapterType: "opencode_local" }, "gemini-lite", { cannotRun })).toBe(true);
    expect(canAgentRun({ agentId: "gina", adapterType: "opencode_local" }, "pool/free", { cannotRun })).toBe(true);
  });

  it("filters pools by adapter only when the pool says so", () => {
    expect(poolAcceptsAdapter({}, "opencode_local")).toBe(true);
    expect(poolAcceptsAdapter({ adapterTypes: ["agy_local"] }, "agy_local")).toBe(true);
    expect(poolAcceptsAdapter({ adapterTypes: ["agy_local"] }, "claude_local")).toBe(false);
    expect(poolAcceptsAdapter({ adapterTypes: ["agy_local"] }, undefined)).toBe(false);
  });
});

describe("failure classification", () => {
  it("reads the gemini-lite incident as can't-run, not as a rate limit", () => {
    expect(CANNOT_RUN.test(GINA_ERROR)).toBe(true);
    expect(isRateLimited({ error: GINA_ERROR, error_code: "adapter_failed" })).toBe(false);
  });

  it("treats agy's quota code as a rate limit whatever its text says", () => {
    expect(isRateLimited({ error: "agy exited with code 1", error_code: "agy_quota_exhausted" })).toBe(true);
    expect(isRateLimited({ error: "RESOURCE_EXHAUSTED", error_code: null })).toBe(true);
    expect(isRateLimited({ error: "agy exited with code 1", error_code: "adapter_failed" })).toBe(false);
  });
});

describe("CLI backend pools", () => {
  const agy = { id: "agy", name: "agy", type: "cli" as const, adapterType: "agy_local", concurrency: 1 };
  const base = pool("gemini", { kind: "quota", backend: "agy", patterns: ["gemini-3.8-flash-medium", "gemini-4-argon-medium"], keepPoolName: true });

  it("resolves to a pinning pool that takes only its adapter's agents", () => {
    const p = resolvePool(base, [agy]);
    expect(p.adapterTypes).toEqual(["agy_local"]);
    expect(p.keepPoolName).toBe(false);
    expect(p.api).toBe("cli");
    expect(p.placement?.map((t) => t.model)).toEqual(["gemini-3.8-flash-medium", "gemini-4-argon-medium"]);
  });

  it("accepts adapterTypes and pauseAtPercent in saved pools, and rejects bad values", () => {
    const ok = validatePools([{ ...base, adapterTypes: ["agy_local"], pauseAtPercent: 90 }]);
    expect(ok.ok ? ok.pools[0] : ok.errors).toMatchObject({ adapterTypes: ["agy_local"], pauseAtPercent: 90 });
    const bad = validatePools([{ ...base, adapterTypes: "agy_local", pauseAtPercent: 0 }]);
    expect(bad.ok ? [] : bad.errors.map((e) => e.field.replace(/^.*\./, "")).sort()).toEqual(["adapterTypes", "pauseAtPercent"]);
  });
});

describe("placement with learned can't-run pairs", () => {
  const free = pool("free", { kind: "quota", limit: 4, patterns: ["gemini-lite", "litellm/free"], placement: [{ model: "gemini-lite" }, { model: "litellm/free" }], companyId: "c1" });
  const cannot: CannotRun = { companyId: "c1", agentId: "gina", model: "gemini-lite", since: NOW, until: "2026-10-29T12:00:00.000Z", error: GINA_ERROR };
  const short = (a: Action[]) => a.map((x) => (x.kind === "place" ? `place ${x.issueId} ${x.model} ${x.reason}` : x.kind === "alert" ? `alert ${x.alert.kind} ${x.alert.subject}` : x.kind));

  it("moves a task the plugin placed on a model its agent can't use, and says why", () => {
    const s = snapshot({
      pools: [free],
      tasks: [task("t1", { poolId: "free", agentId: "gina", adapterType: "opencode_local", model: "gemini-lite", agentModel: "pool/free" })],
      cannotRun: { [cannotRunKey("gina", "gemini-lite")]: cannot },
    });
    expect(short(decide(s))).toEqual(["place t1 litellm/free agentCannotRun", "alert agentCannotRun gina|gemini-lite"]);
  });

  it("never places a new task there, but leaves a model a person set", () => {
    const fresh = snapshot({ pools: [free], tasks: [task("t2", { poolId: "free", agentId: "gina", adapterType: "opencode_local", model: "pool/free" })], cannotRun: { [cannotRunKey("gina", "gemini-lite")]: cannot } });
    expect(short(decide(fresh)).filter((x) => x.startsWith("place"))).toEqual(["place t2 litellm/free new"]);
    const pinned = snapshot({ pools: [free], tasks: [task("t3", { poolId: "free", agentId: "gina", adapterType: "opencode_local", model: "gemini-lite", pinned: true })], cannotRun: { [cannotRunKey("gina", "gemini-lite")]: cannot } });
    expect(short(decide(pinned)).filter((x) => x.startsWith("place"))).toEqual([]);
  });

  it("places an agy task only on a model agy lists", () => {
    const gem = pool("gem", { kind: "quota", limit: 1, patterns: ["gemini-pro-x", "gemini-3.8-flash-medium"], placement: [{ model: "gemini-pro-x" }, { model: "gemini-3.8-flash-medium" }], companyId: "c1", adapterTypes: ["agy_local"] });
    const s = snapshot({ pools: [gem], tasks: [task("t1", { poolId: "gem", agentId: "gina", adapterType: "agy_local", model: "pool/gem" })], adapterModels: { agy_local: AGY_MODELS } });
    expect(short(decide(s)).filter((x) => x.startsWith("place"))).toEqual(["place t1 gemini-3.8-flash-medium new"]);
  });
});

describe("snapshot (JD-1245)", () => {
  const company = (id: string) => ({ id, name: id }) as unknown as Company;
  const agentOn = (id: string, adapterType: string, model: string) => ({ id, companyId: "c1", name: id, status: "idle", adapterType, adapterConfig: { model } }) as unknown as Agent;
  const issue = (id: string, assigneeAgentId: string, model?: string) => ({
    id, companyId: "c1", identifier: id, title: id, status: "todo", priority: "medium", assigneeAgentId,
    ...(model ? { assigneeAdapterOverrides: { adapterConfig: { model } } } : {}),
  }) as unknown as Issue;
  const setup = async (agents: Agent[], issues: Issue[]) => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "companies.read", "agents.read", "issues.read"] });
    harness.seed({ companies: [company("c1")], agents, issues });
    const store = createStore(harness.ctx.state);
    await store.companies.set([{ id: "c1", name: "c1" }]);
    return { harness, store };
  };
  const agy = { id: "agy", name: "agy", type: "cli" as const, adapterType: "agy_local" };

  it("learns a can't-run pair from the gemini-lite failure and keeps it a day", async () => {
    const { harness, store } = await setup([agentOn("gina", "opencode_local", "pool/free")], [issue("i1", "gina", "gemini-lite")]);
    await store.companyPools("c1").set([pool("free", { kind: "quota", patterns: ["gemini-lite", "litellm/free"] })]);
    const failures: FailureRow[] = [{ company_id: "c1", agent_id: "gina", issue_id: "i1", error: GINA_ERROR, error_code: "adapter_failed", finished_at: new Date(Date.parse(NOW) - 60_000).toISOString() }];
    const build = (now: string, f: FailureRow[]) => buildSnapshot({ ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => f, now: new Date(now) });
    const s = await build(NOW, failures);
    expect(s.cannotRun?.["gina|gemini-lite"]).toMatchObject({ agentId: "gina", model: "gemini-lite", until: "2026-10-29T11:59:00.000Z" });
    expect(s.exhausted?.["c1|gemini-lite"]).toBeUndefined();
    // The failure is no longer read after 30 minutes; the saved pair stays until it expires.
    expect((await build("2026-10-29T11:00:00.000Z", [])).cannotRun?.["gina|gemini-lite"]).toBeDefined();
    expect((await build("2026-10-29T12:00:00.000Z", [])).cannotRun?.["gina|gemini-lite"]).toBeUndefined();
  });

  it("pauses agy's model after its quota failures, by agy's own error code", async () => {
    const { harness, store } = await setup([agentOn("gina", "agy_local", "gemini-3.8-flash-medium")], []);
    await store.companyPools("c1").set([pool("gem", { kind: "quota", backend: "agy", patterns: ["gemini-3.8-flash-medium"] })]);
    const failures: FailureRow[] = [1, 2].map((i) => ({ company_id: "c1", agent_id: "gina", issue_id: null, error: "agy exited with code 1", error_code: "agy_quota_exhausted", finished_at: new Date(Date.parse(NOW) - i * 60_000).toISOString() }));
    const s = await buildSnapshot({ ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => failures, now: new Date(NOW), backendsFor: async () => [agy] });
    expect(s.exhausted?.["c1|gemini-3.8-flash-medium"]).toMatchObject({ reason: "2 rate-limit failures" });
  });

  it("puts only agy agents' tasks in the agy pool, even for Claude names", async () => {
    const { harness, store } = await setup(
      [agentOn("gina", "agy_local", "claude-opus-5-5-high"), agentOn("monica", "claude_local", "claude-opus-5-5-high")],
      [issue("i1", "gina"), issue("i2", "monica")],
    );
    await store.companyPools("c1").set([
      pool("agy", { kind: "quota", backend: "agy", patterns: ["claude-opus-5-5-high"] }),
      pool("claude", { kind: "quota", patterns: ["claude-opus-5-5-high"], adapterTypes: ["claude_local"] }),
    ]);
    const s = await buildSnapshot({ ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => [], now: new Date(NOW), backendsFor: async () => [agy] });
    expect(Object.fromEntries(s.tasks.map((t) => [t.issueId, t.poolId]))).toEqual({ i1: "c1:agy", i2: "c1:claude" });
  });

  it("pauses the CLI pool's models once its adapter has listed nothing a few times, and exposes the list", async () => {
    const { harness, store } = await setup([agentOn("gina", "agy_local", "gemini-3.8-flash-medium")], []);
    await store.companyPools("c1").set([pool("gem", { kind: "quota", backend: "agy", patterns: ["gemini-3.8-flash-medium"] })]);
    const build = () => buildSnapshot({ ctx: harness.ctx, store, agents: createAgentCache(harness.ctx), readRuns: async () => [], readFailures: async () => [], now: new Date(NOW), backendsFor: async () => [agy] });
    await store.adapterModels("c1").set({ agy_local: { sampledAt: NOW, ok: true, models: AGY_MODELS, failures: 0 } });
    const up = await build();
    expect(up.adapterModels).toEqual({ agy_local: AGY_MODELS });
    expect(up.exhausted?.["c1|gemini-3.8-flash-medium"]).toBeUndefined();
    await store.adapterModels("c1").set({ agy_local: { sampledAt: NOW, ok: false, models: AGY_MODELS, failures: ADAPTER_DOWN_AFTER, error: "agy_local lists no models (is the CLI signed in on the host?)" } });
    expect((await build()).exhausted?.["c1|gemini-3.8-flash-medium"]?.reason).toMatch(/^agy_local unavailable: .*signed in/);
  });
});

describe("readAdapterModels", () => {
  const fetchOf = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const deps = (fetch: () => Promise<Response>) => ({ fetch, baseUrl: "http://127.0.0.1:3100", token: "t", now: new Date(NOW) });

  it("lists the adapter's models without auto", async () => {
    const s = await readAdapterModels("c1", "agy_local", undefined, deps(fetchOf(200, [{ id: "auto" }, { id: "gemini-4-argon-medium" }])));
    expect(s).toEqual({ sampledAt: NOW, ok: true, models: ["gemini-4-argon-medium"], failures: 0 });
  });

  it("counts empty lists and errors, keeping the last good list", async () => {
    const prev = { sampledAt: NOW, ok: true, models: ["gemini-4-argon-medium"], failures: 0 };
    const empty = await readAdapterModels("c1", "agy_local", prev, deps(fetchOf(200, [{ id: "auto" }])));
    expect(empty).toMatchObject({ ok: false, models: ["gemini-4-argon-medium"], failures: 1 });
    const failed = await readAdapterModels("c1", "agy_local", empty, deps(fetchOf(500, { error: "boom" })));
    expect(failed).toMatchObject({ ok: false, failures: 2 });
  });
});
