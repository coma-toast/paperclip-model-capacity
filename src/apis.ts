// A pool belongs to one model API, the logical boundary between pools: an agent's model name starts with the API it
// goes through (litellm/vm, opencode/…-free, openrouter/…). Self-hosted APIs have backends worth watching; cloud APIs
// don't, so only their limit applies.
export type ApiKind = "litellm" | "opencode" | "openrouter" | "other";

export interface ApiInfo {
  kind: ApiKind;
  label: string;
  // Model-name prefix agents use for this API; "" means names are taken as written.
  prefix: string;
  hasBackends: boolean;
  hint: string;
}

export const APIS: readonly ApiInfo[] = [
  { kind: "litellm", label: "LiteLLM", prefix: "litellm/", hasBackends: true, hint: "Your LiteLLM gateway; models like litellm/vm. Can watch the backends LiteLLM routes to." },
  { kind: "opencode", label: "OpenCode", prefix: "opencode/", hasBackends: false, hint: "OpenCode's hosted models, like opencode/…-free. Cloud: only the limit applies." },
  { kind: "openrouter", label: "OpenRouter", prefix: "openrouter/", hasBackends: false, hint: "OpenRouter called directly, like openrouter/…. Cloud: only the limit applies." },
  { kind: "other", label: "Other", prefix: "", hasBackends: true, hint: "Any other model names, written in full (e.g. a direct Ollama or Claude model)." },
];

export const apiInfo = (kind: ApiKind | undefined) => APIS.find((a) => a.kind === kind) ?? APIS[APIS.length - 1];

// Pools saved before APIs existed get the API their patterns already name.
export const inferApi = (patterns: string[]): ApiKind => {
  const prefixed = APIS.filter((a) => a.prefix);
  const match = prefixed.find((a) => patterns.length > 0 && patterns.every((p) => p.startsWith(a.prefix)));
  return match?.kind ?? "other";
};

export const stripPrefix = (api: ApiKind | undefined, pattern: string) => {
  const { prefix } = apiInfo(api);
  return prefix && pattern.startsWith(prefix) ? pattern.slice(prefix.length) : pattern;
};

export const addPrefix = (api: ApiKind | undefined, name: string) => {
  const { prefix } = apiInfo(api);
  return !prefix || name.startsWith(prefix) ? name : `${prefix}${name}`;
};
