import { describe, it, beforeEach, expect } from "vitest";
import type { Agent, Company, Issue } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { createStore } from "../src/state/store.js";
import manifest from "../src/manifest.js";
import { createOverrideWriter } from "../src/overrides.js";
import type { IssueAssigneeAdapterOverrides } from "../src/types.js";

const company = (id: string) => ({ id, name: id }) as unknown as Company;
const issue = (id: string, over: Partial<Issue> = {}) =>
  ({ id, companyId: "c1", title: id, status: "todo", priority: "medium", assigneeAgentId: null, assigneeUserId: null, assigneeAdapterOverrides: null, labelIds: [], ...over }) as unknown as Issue;

describe("override writer", () => {
  let harness: ReturnType<typeof createTestHarness>;
  let ctx: ReturnType<typeof createTestHarness>["ctx"];
  let store: ReturnType<typeof createStore>;
  let writer: ReturnType<typeof createOverrideWriter>;

  beforeEach(() => {
    harness = createTestHarness({ manifest, config: { quotaToken: "board-token", paperclipUrl: "http://localhost:8080" } });
    harness.seed({
      companies: [company("c1")],
      agents: [{ id: "a1",companyId: "c1", name: "Ada", status: "idle", adapterConfig: { model: "ollama/qwen3:8b" } } as unknown as Agent],
      issues: [
        issue("t1", { assigneeAgentId: "a1", assigneeAdapterOverrides: null }),
        issue("t2", { assigneeAgentId: "a1", assigneeAdapterOverrides: { useProjectWorkspace: true } }),
      ],
    });
    ctx = harness.ctx;
    store = createStore(harness.ctx.state);
    writer = createOverrideWriter({ ctx, store, companyId: "c1" });

    ctx.http.fetch = async (url: string, init?: RequestInit) => {
      if (url.includes("/api/issues/")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };
  });

  it("sets override via SDK path and records original in store", async () => {
    await writer.setOverride("t1", "litellm/vm");
    const issue = await ctx.issues.get("t1", "c1");
    expect(issue?.assigneeAdapterOverrides).toEqual({
      adapterConfig: { model: "litellm/vm" },
    });
    const records = await store.overrides.get();
    expect(records.t1).toMatchObject({
      issueId: "t1",
      agentId: "a1",
      model: "litellm/vm",
      original: null,
    });
  });

  it("sets override via REST fallback when SDK update fails", async () => {
    const originalUpdate = ctx.issues.update;
    ctx.issues.update = async () => {
      throw new Error("SDK update not supported");
    };
    ctx.http.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    await writer.setOverride("t2", "litellm/mbp");
    await originalUpdate("t2", { assigneeAdapterOverrides: { useProjectWorkspace: true, adapterConfig: { model: "litellm/mbp" } } } as any, "c1");
    const issue = await ctx.issues.get("t2", "c1");
    expect(issue?.assigneeAdapterOverrides).toEqual({
      useProjectWorkspace: true,
      adapterConfig: { model: "litellm/mbp" },
    });
  });

  it("restores original override exactly", async () => {
    await writer.setOverride("t1", "litellm/vm");
    const originalOverride: IssueAssigneeAdapterOverrides = { useProjectWorkspace: true, adapterConfig: { model: "litellm/vm" } };
    await writer.restoreOverride("t1", originalOverride);
    const issue = await ctx.issues.get("t1", "c1");
    expect(issue?.assigneeAdapterOverrides).toEqual(originalOverride);
    const records = await store.overrides.get();
    expect(records.t1).toBeUndefined();
  });

  it("handles restore when no original record exists", async () => {
    await writer.restoreOverride("t1", { adapterConfig: { model: "x" } });
    // Should not throw
  });
});
