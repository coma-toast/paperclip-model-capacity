import type { Agent } from "@paperclipai/plugin-sdk";

import { APIS, type ApiKind } from "./apis.js";

// What the company's agents already run, so pools can be set up from it instead of retyped. Paperclip doesn't give
// plugins the host's provider settings (env files, gateway keys), so only what agents' own configs hold is used.
export interface AgentModelUse {
  model: string;
  prefix: string;
  api: ApiKind;
  agents: string[];
  // A model-endpoint address found in an agent's config, if any.
  baseUrl?: string;
}

// Keys in adapter configs and plain env vars that hold a model endpoint (not an agent gateway).
const ENDPOINT_KEYS = ["baseUrl", "baseURL", "apiBase", "openaiBaseUrl", "modelBaseUrl"];
const ENDPOINT_ENV = ["OPENAI_BASE_URL", "OPENAI_API_BASE", "OLLAMA_HOST", "ANTHROPIC_BASE_URL", "LITELLM_BASE_URL"];

export const modelPrefix = (model: string) => (model.includes("/") ? model.slice(0, model.indexOf("/") + 1) : "");

export const apiForPrefix = (prefix: string): ApiKind => APIS.find((a) => a.defaultPrefix && a.defaultPrefix === prefix)?.kind ?? (prefix ? "openai" : "other");

const asUrl = (v: unknown) => {
  if (typeof v !== "string") return undefined;
  const value = /^https?:\/\//.test(v) ? v : /^[\w.-]+:\d+$/.test(v) ? `http://${v}` : undefined;
  try {
    return value && ["http:", "https:"].includes(new URL(value).protocol) ? value.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
};

export const endpointOf = (adapterConfig: Record<string, unknown> | undefined): string | undefined => {
  if (!adapterConfig) return undefined;
  for (const key of ENDPOINT_KEYS) {
    const url = asUrl(adapterConfig[key]);
    if (url) return url;
  }
  const env = (adapterConfig.env ?? {}) as Record<string, { type?: string; value?: unknown } | undefined>;
  for (const key of ENDPOINT_ENV) {
    const entry = env[key];
    const url = entry?.type === "plain" ? asUrl(entry.value) : undefined;
    if (url) return url;
  }
  return undefined;
};

export const collectAgentModels = (agents: Pick<Agent, "name" | "status" | "adapterConfig">[]): AgentModelUse[] => {
  const byModel = new Map<string, AgentModelUse>();
  for (const agent of agents) {
    if (agent.status === "terminated") continue;
    const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined;
    if (!model) continue;
    const prefix = modelPrefix(model);
    const use = byModel.get(model) ?? { model, prefix, api: apiForPrefix(prefix), agents: [] };
    use.agents.push(agent.name);
    use.baseUrl ??= endpointOf(config);
    byModel.set(model, use);
  }
  return [...byModel.values()].sort((a, b) => b.agents.length - a.agents.length || a.model.localeCompare(b.model));
};
