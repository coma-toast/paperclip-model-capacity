import type { Agent, Issue } from "@paperclipai/plugin-sdk";

import { VIRTUAL_MODEL_PREFIX } from "../constants.js";
import type { OverrideRecord } from "../types.js";

type IssueModelFields = Pick<Issue, "id" | "assigneeAgentId" | "assigneeAdapterOverrides">;
type AgentModelFields = Pick<Agent, "id" | "adapterConfig">;

const stringModel = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

const overrideModel = (issue: Pick<Issue, "assigneeAdapterOverrides">) =>
  stringModel(issue.assigneeAdapterOverrides?.adapterConfig?.model);

export const agentModel = (agent: Pick<Agent, "adapterConfig">) => stringModel(agent.adapterConfig?.model);

// Mirrors the host (heartbeat.js): the task's override applies only when the run's agent is the task's assignee.
export const effectiveModel = (issue: IssueModelFields, agent: AgentModelFields): string | undefined =>
  (issue.assigneeAgentId === agent.id ? overrideModel(issue) : undefined) ?? stringModel(agent.adapterConfig?.model);

// A pin is a model override the plugin didn't write (PRD D4). An override the plugin wrote but a person has since
// changed to another model is a pin too: the plugin never fights a human change.
export const isPinned = (issue: IssueModelFields, overrides: Readonly<Record<string, OverrideRecord>>): boolean => {
  if (!issue.assigneeAgentId) return false;
  const model = overrideModel(issue);
  // A pool's own name (pool/<id>, set when a task is moved to a pool) only says which pool; the pool still picks the model.
  if (!model || model.startsWith(VIRTUAL_MODEL_PREFIX)) return false;
  const record = overrides[issue.id];
  return !(record && record.agentId === issue.assigneeAgentId && record.model === model);
};

// Which subscription a model belongs to, from its name alone (Claude Code and Codex agents use bare names like
// "claude-haiku-5-5" or "gpt-5.6-terra"). Undefined for models of neither.
export const modelProvider = (model: string): "anthropic" | "openai" | undefined => {
  const name = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  if (/claude|haiku|sonnet|opus/.test(name)) return "anthropic";
  if (/^(gpt|o\d)|codex/.test(name)) return "openai";
  return undefined;
};

// Adapters that can only run one provider's models: a Claude Code agent can't run a GPT model, nor Codex a Claude one.
export const ADAPTER_PROVIDER: Record<string, "anthropic" | "openai"> = { claude_local: "anthropic", codex_local: "openai" };
export const PROVIDER_ADAPTER: Record<"anthropic" | "openai", string> = { anthropic: "claude_local", openai: "codex_local" };
export const canRun = (adapterType: string | undefined, model: string) => {
  const only = adapterType ? ADAPTER_PROVIDER[adapterType] : undefined;
  return !only || modelProvider(model) === only;
};
