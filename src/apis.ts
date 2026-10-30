import type { EngineKind } from "./types.js";

// A pool belongs to one model API, the logical boundary between pools. Agents name a model by the API it goes
// through, usually with a prefix (e.g. "openrouter/…", "ollama/…"), so each pool keeps that API's prefix.
export type ApiKind = "litellm" | "openai" | "opencode" | "openrouter" | "ollama" | "lmstudio" | "omlx" | "vllm" | "llamacpp" | "other";

// gateway: routes to backends the pool can watch. cloud: nothing to watch. local: the endpoint is itself the model
// server, checked directly. names: only model names, no endpoint.
export type ApiGroup = "gateway" | "cloud" | "local" | "names";

export interface ApiInfo {
  kind: ApiKind;
  label: string;
  group: ApiGroup;
  // Suggested model-name prefix; each pool can change it to match how its agents name models.
  defaultPrefix: string;
  // Used when the pool leaves the address empty.
  defaultBaseUrl: string;
  placeholderUrl: string;
  // How "Load models" lists models: OpenAI-style /v1/models, Ollama's /api/tags, or not at all.
  listing: "openai" | "ollama" | "none";
  // For local engines: which health check the endpoint gets.
  engine?: EngineKind;
  hint: string;
}

export const APIS: readonly ApiInfo[] = [
  { kind: "litellm", label: "LiteLLM proxy", group: "gateway", defaultPrefix: "litellm/", defaultBaseUrl: "", placeholderUrl: "https://litellm.example.com", listing: "openai", hint: "A LiteLLM proxy. It can also watch the backends the proxy routes to." },
  { kind: "openai", label: "OpenAI-compatible endpoint", group: "gateway", defaultPrefix: "", defaultBaseUrl: "", placeholderUrl: "https://api.example.com/v1", listing: "openai", hint: "Any API that speaks the OpenAI format (/v1/models, /v1/chat/completions)." },
  { kind: "opencode", label: "OpenCode Zen", group: "cloud", defaultPrefix: "opencode/", defaultBaseUrl: "https://opencode.ai/zen/v1", placeholderUrl: "https://opencode.ai/zen/v1", listing: "openai", hint: "OpenCode's hosted models. Cloud: only the limit applies." },
  { kind: "openrouter", label: "OpenRouter", group: "cloud", defaultPrefix: "openrouter/", defaultBaseUrl: "https://openrouter.ai/api/v1", placeholderUrl: "https://openrouter.ai/api/v1", listing: "openai", hint: "OpenRouter's models. Cloud: only the limit applies." },
  { kind: "ollama", label: "Ollama", group: "local", defaultPrefix: "ollama/", defaultBaseUrl: "", placeholderUrl: "http://localhost:11434", listing: "ollama", engine: "ollama", hint: "A local Ollama server, checked directly." },
  { kind: "lmstudio", label: "LM Studio", group: "local", defaultPrefix: "lmstudio/", defaultBaseUrl: "", placeholderUrl: "http://localhost:1234", listing: "openai", engine: "lmstudio", hint: "A local LM Studio server, checked directly." },
  { kind: "omlx", label: "oMLX", group: "local", defaultPrefix: "omlx/", defaultBaseUrl: "", placeholderUrl: "http://localhost:8000", listing: "openai", engine: "openai", hint: "A local oMLX server (OpenAI-compatible), checked directly." },
  { kind: "vllm", label: "vLLM", group: "local", defaultPrefix: "vllm/", defaultBaseUrl: "", placeholderUrl: "http://localhost:8000", listing: "openai", engine: "vllm", hint: "A local vLLM server, checked directly." },
  { kind: "llamacpp", label: "llama.cpp server", group: "local", defaultPrefix: "llamacpp/", defaultBaseUrl: "", placeholderUrl: "http://localhost:8080", listing: "openai", engine: "llamacpp", hint: "A local llama.cpp server, checked directly (slots included)." },
  { kind: "other", label: "Other (names only)", group: "names", defaultPrefix: "", defaultBaseUrl: "", placeholderUrl: "", listing: "none", hint: "Model names written in full, with no endpoint to ask or check." },
];

export const apiInfo = (kind: ApiKind | undefined) => APIS.find((a) => a.kind === kind) ?? APIS[APIS.length - 1];

// The prefix a pool uses: its own setting, else its API's suggestion.
export const poolPrefix = (pool: { api?: ApiKind; prefix?: string }) => pool.prefix ?? apiInfo(pool.api).defaultPrefix;

// Pools saved before APIs existed get the API their patterns already name.
export const inferApi = (patterns: string[]): ApiKind => {
  const match = APIS.find((a) => a.defaultPrefix && patterns.length > 0 && patterns.every((p) => p.startsWith(a.defaultPrefix)));
  return match?.kind ?? "other";
};

export const stripPrefix = (prefix: string, pattern: string) => (prefix && pattern.startsWith(prefix) ? pattern.slice(prefix.length) : pattern);
export const addPrefix = (prefix: string, name: string) => (!prefix || name.startsWith(prefix) ? name : `${prefix}${name}`);

// A Paperclip AI connection ("Connections" in company settings), as far as a backend needs it.
export interface AiConnectionLike {
  provider: string;
  method: string;
  routing?: { kind?: string; baseUrl?: string } | null;
}

// What a connection becomes as a backend, or why it can't be one. Subscriptions (ChatGPT, Claude plans) aren't API
// endpoints; their usage windows show under Subscriptions instead.
export const backendFromConnection = (c: AiConnectionLike): { type: ApiKind; baseUrl: string } | { reason: string } => {
  if (c.method === "subscription") return { reason: "a subscription; its usage shows under Subscriptions" };
  if (c.provider === "openrouter" || c.routing?.kind === "openrouter") return { type: "openrouter", baseUrl: c.routing?.baseUrl || apiInfo("openrouter").defaultBaseUrl };
  if (c.routing?.baseUrl) return { type: "openai", baseUrl: c.routing.baseUrl };
  if (c.provider === "openai") return { type: "openai", baseUrl: "https://api.openai.com/v1" };
  return { reason: "not an OpenAI-compatible API" };
};
