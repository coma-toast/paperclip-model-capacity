import { describe, expect, it } from "vitest";
import type { Agent, Company, Issue, PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import type { PoolSummary } from "../src/api.js";
import manifest from "../src/manifest.js";
import {
  authorizeMetricsRequest,
  collectMetrics,
  countEventsFromHistory,
  formatPrometheusMetrics,
  type MetricsData,
} from "../src/metrics.js";
import { createRuntime } from "../src/runtime.js";
import type { RunRow } from "../src/snapshot.js";
import plugin from "../src/worker.js";
import { NOW, host, pool } from "./fixtures/snapshot.js";

const company = { id: "c1", name: "c1" } as unknown as Company;
const agent = { id: "a1", companyId: "c1", name: "a1", status: "idle", adapterConfig: { model: "gateway/gpu" } } as unknown as Agent;
const issue = (id: string, over: Partial<Issue> = {}) =>
  ({ id, companyId: "c1", title: id, status: "todo", priority: "medium", assigneeAgentId: "a1", assigneeAdapterOverrides: null, labelIds: [], ...over }) as unknown as Issue;

describe("formatPrometheusMetrics", () => {
  it("formats gauges per pool and per host, and counters for over-limit and overflow", () => {
    const summary: PoolSummary = {
      id: "c1:gpu",
      companyId: "c1",
      localId: "gpu",
      name: "gpu",
      api: "llamacpp",
      mode: "enforce",
      privacy: "private",
      limit: 2,
      available: 1,
      inUse: 1,
      queued: 2,
      oldestWaitSeconds: 45,
      onHold: false,
      disabled: false,
      openAlerts: 0,
      hosts: [
        { id: "h1", name: "gpu-node-1", engine: "llamacpp", up: true, slotsTotal: 4, slotsBusy: 1 },
        { id: "h2", name: "gpu-node-2", engine: "llamacpp", up: false },
      ],
    };

    const data: MetricsData = {
      summaries: [summary],
      counters: {
        overLimit: { "c1:gpu": 3 },
        overflow: { "c1:gpu": 1 },
      },
      usages: [
        {
          openrouter: {
            backendId: "openrouter",
            sampledAt: NOW,
            ok: true,
            notes: [],
            meters: [
              { label: "Free requests", unit: "requests", used: 10, limit: 100, remaining: 90 },
            ],
          },
        },
      ],
    };

    const text = formatPrometheusMetrics(data);

    // Verify HELP and TYPE definitions
    expect(text).toContain("# HELP paperclip_model_capacity_pool_limit Configured run limit for the model pool.");
    expect(text).toContain("# TYPE paperclip_model_capacity_pool_limit gauge");
    expect(text).toContain('paperclip_model_capacity_pool_limit{company="c1",pool="c1:gpu",pool_name="gpu"} 2');

    expect(text).toContain("# HELP paperclip_model_capacity_pool_available Available capacity slots in the model pool.");
    expect(text).toContain("# TYPE paperclip_model_capacity_pool_available gauge");
    expect(text).toContain('paperclip_model_capacity_pool_available{company="c1",pool="c1:gpu",pool_name="gpu"} 1');

    expect(text).toContain("# HELP paperclip_model_capacity_pool_running Number of runs occupying capacity in the model pool.");
    expect(text).toContain("# TYPE paperclip_model_capacity_pool_running gauge");
    expect(text).toContain('paperclip_model_capacity_pool_running{company="c1",pool="c1:gpu",pool_name="gpu"} 1');

    expect(text).toContain("# HELP paperclip_model_capacity_pool_held Number of tasks queued in the model pool.");
    expect(text).toContain("# TYPE paperclip_model_capacity_pool_held gauge");
    expect(text).toContain('paperclip_model_capacity_pool_held{company="c1",pool="c1:gpu",pool_name="gpu"} 2');

    expect(text).toContain("# HELP paperclip_model_capacity_pool_oldest_wait_seconds Wait time in seconds of the oldest queued task in the pool.");
    expect(text).toContain("# TYPE paperclip_model_capacity_pool_oldest_wait_seconds gauge");
    expect(text).toContain('paperclip_model_capacity_pool_oldest_wait_seconds{company="c1",pool="c1:gpu",pool_name="gpu"} 45');

    // Host gauges
    expect(text).toContain("# HELP paperclip_model_capacity_host_up Whether the host/engine is reachable (1) or down (0).");
    expect(text).toContain("# TYPE paperclip_model_capacity_host_up gauge");
    expect(text).toContain('paperclip_model_capacity_host_up{company="c1",pool="c1:gpu",host="h1",host_name="gpu-node-1",engine="llamacpp"} 1');
    expect(text).toContain('paperclip_model_capacity_host_up{company="c1",pool="c1:gpu",host="h2",host_name="gpu-node-2",engine="llamacpp"} 0');

    expect(text).toContain("# HELP paperclip_model_capacity_host_slots_total Total capacity slots on the host.");
    expect(text).toContain("# TYPE paperclip_model_capacity_host_slots_total gauge");
    expect(text).toContain('paperclip_model_capacity_host_slots_total{company="c1",pool="c1:gpu",host="h1",host_name="gpu-node-1",engine="llamacpp"} 4');

    expect(text).toContain("# HELP paperclip_model_capacity_host_slots_busy Busy capacity slots on the host.");
    expect(text).toContain("# TYPE paperclip_model_capacity_host_slots_busy gauge");
    expect(text).toContain('paperclip_model_capacity_host_slots_busy{company="c1",pool="c1:gpu",host="h1",host_name="gpu-node-1",engine="llamacpp"} 1');

    // Quota remaining gauge
    expect(text).toContain("# HELP paperclip_model_capacity_quota_remaining Remaining quota for an upstream provider or backend meter.");
    expect(text).toContain("# TYPE paperclip_model_capacity_quota_remaining gauge");
    expect(text).toContain('paperclip_model_capacity_quota_remaining{backend="openrouter",meter="Free requests",unit="requests"} 90');

    // Counters
    expect(text).toContain("# HELP paperclip_model_capacity_over_limit_total Total over-limit events observed for the pool.");
    expect(text).toContain("# TYPE paperclip_model_capacity_over_limit_total counter");
    expect(text).toContain('paperclip_model_capacity_over_limit_total{company="c1",pool="c1:gpu",pool_name="gpu"} 3');

    expect(text).toContain("# HELP paperclip_model_capacity_overflow_total Total overflow events observed for the pool.");
    expect(text).toContain("# TYPE paperclip_model_capacity_overflow_total counter");
    expect(text).toContain('paperclip_model_capacity_overflow_total{company="c1",pool="c1:gpu",pool_name="gpu"} 1');

    // Ends with trailing newline
    expect(text.endsWith("\n")).toBe(true);
  });

  it("escapes quotes and newlines in labels", () => {
    const summary: PoolSummary = {
      id: 'c1:test"pool\n1',
      companyId: "c1",
      name: 'Special "Quotes" & \nNewlines',
      api: "openai",
      mode: "observe",
      privacy: "shared",
      limit: 5,
      available: 5,
      inUse: 0,
      queued: 0,
      oldestWaitSeconds: null,
      onHold: false,
      disabled: false,
      openAlerts: 0,
      hosts: [],
    };
    const text = formatPrometheusMetrics({
      summaries: [summary],
      counters: { overLimit: {}, overflow: {} },
    });
    expect(text).toContain('pool="c1:test\\"pool\\n1"');
    expect(text).toContain('pool_name="Special \\"Quotes\\" & \\nNewlines"');
    expect(text).toContain('paperclip_model_capacity_pool_oldest_wait_seconds{company="c1",pool="c1:test\\"pool\\n1",pool_name="Special \\"Quotes\\" & \\nNewlines"} 0');
  });
});

describe("countEventsFromHistory", () => {
  it("tallies overLimit and overflow events from history entries", async () => {
    const harness = createTestHarness({ manifest });
    const rt = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    await rt.store.appendHistory([
      {
        at: NOW,
        applied: true,
        action: {
          kind: "alert",
          alert: {
            kind: "overLimit",
            subject: "c1:gpu",
            state: "start",
            poolId: "c1:gpu",
            companyId: "c1",
            at: NOW,
            message: "over limit",
          },
        },
      },
      {
        at: NOW,
        applied: true,
        action: {
          kind: "alert",
          alert: {
            kind: "overLimit",
            subject: "c1:gpu",
            state: "clear",
            poolId: "c1:gpu",
            companyId: "c1",
            at: NOW,
            message: "cleared",
          },
        },
      },
      {
        at: NOW,
        applied: true,
        action: {
          kind: "overflow",
          issueId: "t1",
          companyId: "c1",
          fromPoolId: "c1:gpu",
          toPoolId: "c1:cloud",
          model: "gateway/cloud",
          reason: "waited",
        },
      },
    ]);

    const counts = await countEventsFromHistory(rt.store);
    expect(counts.overLimit).toEqual({ "c1:gpu": 1 });
    expect(counts.overflow).toEqual({ "c1:gpu": 1 });

    const countsForC2 = await countEventsFromHistory(rt.store, "c2");
    expect(countsForC2.overLimit).toEqual({});
    expect(countsForC2.overflow).toEqual({});
  });
});

describe("collectMetrics", () => {
  it("collects live snapshot metrics into Prometheus format", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      companies: [company],
      agents: [agent],
      issues: [issue("i0", { status: "in_progress" }), issue("t1")],
    });
    const busyRun: RunRow = { id: "r0", company_id: "c1", agent_id: "a1", issue_id: "i0", status: "running", started_at: NOW };
    const rt = createRuntime(harness.ctx, { debounceMs: 20, probeIntervalMs: 0, readRuns: async () => [busyRun] });
    await rt.store.companies.set([{ id: "c1", name: "c1" }]);
    await rt.store.companyPools("c1").set([
      pool("gpu", {
        patterns: ["gateway/gpu"],
        limit: 1,
        hosts: [host("h1", { engine: "llamacpp" })],
      }),
    ]);
    await rt.store.hosts.set({ "c1:h1": { hostId: "c1:h1", up: true, consecutiveFailures: 0, consecutiveSuccesses: 1, slotsTotal: 4, slotsBusy: 1 } });
    await rt.cycle("sweep");

    const text = await collectMetrics(rt, "c1");
    expect(text).toContain('paperclip_model_capacity_pool_limit{company="c1",pool="c1:gpu",pool_name="gpu"} 1');
    expect(text).toContain('paperclip_model_capacity_pool_available{company="c1",pool="c1:gpu",pool_name="gpu"} 1');
    expect(text).toContain('paperclip_model_capacity_pool_running{company="c1",pool="c1:gpu",pool_name="gpu"} 1');
    expect(text).toContain('paperclip_model_capacity_pool_held{company="c1",pool="c1:gpu",pool_name="gpu"} 1');
    expect(text).toContain('paperclip_model_capacity_host_up{company="c1",pool="c1:gpu",host="c1:h1",host_name="h1",engine="llamacpp"} 1');
    expect(text).toContain('paperclip_model_capacity_host_slots_total{company="c1",pool="c1:gpu",host="c1:h1",host_name="h1",engine="llamacpp"} 4');
    expect(text).toContain('paperclip_model_capacity_host_slots_busy{company="c1",pool="c1:gpu",host="c1:h1",host_name="h1",engine="llamacpp"} 1');

    await rt.stop();
  });
});

describe("authorizeMetricsRequest", () => {
  it("allows access when no metricsToken is configured", async () => {
    const harness = createTestHarness({ manifest });
    const req: PluginApiRequestInput = {
      routeKey: "metrics",
      method: "GET",
      path: "/metrics",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "user", actorId: "u1" },
      companyId: "c1",
      headers: {},
    };
    const res = await authorizeMetricsRequest(harness.ctx, req);
    expect(res.authorized).toBe(true);
  });

  it("checks Authorization header when metricsToken is configured", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ metricsToken: "secret-token-123" });

    const unauthed: PluginApiRequestInput = {
      routeKey: "metrics",
      method: "GET",
      path: "/metrics",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "user", actorId: "u1" },
      companyId: "c1",
      headers: {},
    };
    expect(await authorizeMetricsRequest(harness.ctx, unauthed)).toEqual({
      authorized: false,
      reason: "Missing metrics bearer token",
    });

    const badToken: PluginApiRequestInput = {
      ...unauthed,
      headers: { authorization: "Bearer wrong-token" },
    };
    expect(await authorizeMetricsRequest(harness.ctx, badToken)).toEqual({
      authorized: false,
      reason: "Invalid metrics bearer token",
    });

    const goodToken: PluginApiRequestInput = {
      ...unauthed,
      headers: { authorization: "Bearer secret-token-123" },
    };
    expect(await authorizeMetricsRequest(harness.ctx, goodToken)).toEqual({
      authorized: true,
    });
  });

  it("checks query parameter token when metricsToken is configured", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ metricsToken: "token-abc" });

    const queryReq: PluginApiRequestInput = {
      routeKey: "metrics",
      method: "GET",
      path: "/metrics",
      params: {},
      query: { token: "token-abc" },
      body: null,
      actor: { actorType: "user", actorId: "u1" },
      companyId: "c1",
      headers: {},
    };
    expect(await authorizeMetricsRequest(harness.ctx, queryReq)).toEqual({
      authorized: true,
    });
  });

  it("resolves secret references for metricsToken", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ metricsToken: "secret:my-token" });

    const goodReq: PluginApiRequestInput = {
      routeKey: "metrics",
      method: "GET",
      path: "/metrics",
      params: {},
      query: { token: "resolved:secret:my-token" },
      body: null,
      actor: { actorType: "user", actorId: "u1" },
      companyId: "c1",
      headers: {},
    };
    expect(await authorizeMetricsRequest(harness.ctx, goodReq)).toEqual({
      authorized: true,
    });
  });
});

describe("worker onApiRequest integration", () => {
  it("serves Prometheus metrics on GET /metrics", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      companies: [company],
      agents: [agent],
      issues: [issue("t1")],
    });

    // Initialize worker plugin
    await plugin.definition.setup!(harness.ctx);

    const res = await plugin.definition.onApiRequest!({
      routeKey: "metrics",
      method: "GET",
      path: "/metrics",
      params: {},
      query: { companyId: "c1" },
      body: null,
      actor: { actorType: "user", actorId: "u1" },
      companyId: "c1",
      headers: {},
    });

    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    expect(typeof res.body).toBe("string");
    const body = res.body as string;

    expect(body).toContain("# HELP paperclip_model_capacity_pool_limit Configured run limit for the model pool.");
    expect(body).toContain("# TYPE paperclip_model_capacity_pool_limit gauge");
    expect(body).toContain("# HELP paperclip_model_capacity_over_limit_total Total over-limit events observed for the pool.");
    expect(body).toContain("# TYPE paperclip_model_capacity_over_limit_total counter");
    expect(body).toContain("# HELP paperclip_model_capacity_overflow_total Total overflow events observed for the pool.");
    expect(body).toContain("# TYPE paperclip_model_capacity_overflow_total counter");
  });

  it("enforces bearer token when metricsToken is configured", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ metricsToken: "auth-token-xyz" });
    await plugin.definition.setup!(harness.ctx);

    const unauthorized = await plugin.definition.onApiRequest!({
      routeKey: "metrics",
      method: "GET",
      path: "/metrics",
      params: {},
      query: { companyId: "c1" },
      body: null,
      actor: { actorType: "user", actorId: "u1" },
      companyId: "c1",
      headers: {},
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await plugin.definition.onApiRequest!({
      routeKey: "metrics",
      method: "GET",
      path: "/metrics",
      params: {},
      query: { companyId: "c1" },
      body: null,
      actor: { actorType: "user", actorId: "u1" },
      companyId: "c1",
      headers: { authorization: "Bearer auth-token-xyz" },
    });
    expect(authorized.status).toBe(200);
  });

  it("returns 404 for unknown route keys", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup!(harness.ctx);

    const res = await plugin.definition.onApiRequest!({
      routeKey: "unknown",
      method: "GET",
      path: "/unknown",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "user", actorId: "u1" },
      companyId: "c1",
      headers: {},
    });
    expect(res.status).toBe(404);
  });
});
