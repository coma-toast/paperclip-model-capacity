import { describe, expect, it } from "vitest";

import { effectiveModel, isPinned } from "../src/scheduler/model.js";
import { canRun, modelProvider } from "../src/scheduler/model.js";
import type { OverrideRecord } from "../src/types.js";

const agent = { id: "agent-1", adapterConfig: { model: "gateway/gpu" } };
const issue = (assigneeAgentId: string | null, model?: unknown) => ({
  id: "issue-1",
  assigneeAgentId,
  assigneeAdapterOverrides: model === undefined ? null : { adapterConfig: { model } },
});
const record = (over: Partial<OverrideRecord> = {}): OverrideRecord => ({
  issueId: "issue-1",
  agentId: "agent-1",
  model: "free/llama",
  original: null,
  fromPoolId: "gpu",
  toPoolId: "free",
  at: "2026-10-28T12:00:00.000Z",
  ...over,
});

describe("effectiveModel", () => {
  it("uses the agent's model with no override", () => {
    expect(effectiveModel(issue("agent-1"), agent)).toBe("gateway/gpu");
  });

  it("uses the override when the agent is the assignee", () => {
    expect(effectiveModel(issue("agent-1", "free/llama"), agent)).toBe("free/llama");
  });

  it("ignores an override when the agent isn't the assignee", () => {
    expect(effectiveModel(issue("agent-2", "free/llama"), agent)).toBe("gateway/gpu");
  });

  it("ignores an override with no model, or a non-string one", () => {
    expect(effectiveModel({ ...issue("agent-1"), assigneeAdapterOverrides: { adapterConfig: { effort: "high" } } }, agent)).toBe("gateway/gpu");
    expect(effectiveModel(issue("agent-1", 42), agent)).toBe("gateway/gpu");
    expect(effectiveModel(issue("agent-1", ""), agent)).toBe("gateway/gpu");
  });

  it("returns undefined when neither has a model", () => {
    expect(effectiveModel(issue("agent-1"), { id: "agent-1", adapterConfig: {} })).toBeUndefined();
  });
});

describe("isPinned", () => {
  it("is not pinned with no override", () => {
    expect(isPinned(issue("agent-1"), {})).toBe(false);
  });

  it("is pinned when a person set the override", () => {
    expect(isPinned(issue("agent-1", "gateway/private"), {})).toBe(true);
  });

  it("is not pinned when the override is a pool's own name (a task moved to that pool)", () => {
    expect(isPinned(issue("agent-1", "pool/sota"), {})).toBe(false);
  });

  it("is not pinned when the plugin set the override", () => {
    expect(isPinned(issue("agent-1", "free/llama"), { "issue-1": record() })).toBe(false);
  });

  it("is pinned when a person changed the plugin's override to another model", () => {
    expect(isPinned(issue("agent-1", "gateway/private"), { "issue-1": record() })).toBe(true);
  });

  it("is pinned when the task moved to another agent after the plugin's override", () => {
    expect(isPinned(issue("agent-2", "free/llama"), { "issue-1": record() })).toBe(true);
  });

  it("is not pinned when there is no agent assignee, so the override never applies", () => {
    expect(isPinned(issue(null, "gateway/private"), {})).toBe(false);
  });
});

describe("modelProvider and canRun", () => {
  it("tells a model's subscription from its name, and which adapters can run it", () => {
    expect(["claude-haiku-5-5", "litellm/claude-sonnet-5-5", "gpt-5.6-terra", "openai/o4-mini", "gpt-5.3-codex", "litellm/vm"].map(modelProvider))
      .toEqual(["anthropic", "anthropic", "openai", "openai", "openai", undefined]);
    expect(canRun("claude_local", "claude-haiku-5-5")).toBe(true);
    expect(canRun("claude_local", "gpt-5.6-terra")).toBe(false);
    expect(canRun("codex_local", "gpt-5.6-terra")).toBe(true);
    expect(canRun("opencode_local", "gpt-5.6-terra")).toBe(true);
    expect(canRun(undefined, "claude-haiku-5-5")).toBe(true);
  });
});

