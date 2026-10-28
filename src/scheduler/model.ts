import type { Agent, Issue } from "@paperclipai/plugin-sdk";

import type { OverrideRecord } from "../types.js";

type IssueModelFields = Pick<Issue, "id" | "assigneeAgentId" | "assigneeAdapterOverrides">;
type AgentModelFields = Pick<Agent, "id" | "adapterConfig">;

const stringModel = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

const overrideModel = (issue: Pick<Issue, "assigneeAdapterOverrides">) =>
  stringModel(issue.assigneeAdapterOverrides?.adapterConfig?.model);

// Mirrors the host (heartbeat.js): the task's override applies only when the run's agent is the task's assignee.
export const effectiveModel = (issue: IssueModelFields, agent: AgentModelFields): string | undefined =>
  (issue.assigneeAgentId === agent.id ? overrideModel(issue) : undefined) ?? stringModel(agent.adapterConfig?.model);

// A pin is a model override the plugin didn't write (PRD D4). An override the plugin wrote but a person has since
// changed to another model is a pin too: the plugin never fights a human change.
export const isPinned = (issue: IssueModelFields, overrides: Readonly<Record<string, OverrideRecord>>): boolean => {
  if (!issue.assigneeAgentId) return false;
  const model = overrideModel(issue);
  if (!model) return false;
  const record = overrides[issue.id];
  return !(record && record.agentId === issue.assigneeAgentId && record.model === model);
};
