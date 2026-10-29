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
  // OpenAI-style base URL whose /models lists this API's models; empty when it must be configured (or can't be listed).
  defaultBaseUrl: string;
}

export const APIS: readonly ApiInfo[] = [
  { kind: "litellm", label: "LiteLLM", prefix: "litellm/", hasBackends: true, hint: "Your LiteLLM gateway; models like litellm/vm. Can watch the backends LiteLLM routes to.", defaultBaseUrl: "" },
  { kind: "opencode", label: "OpenCode", prefix: "opencode/", hasBackends: false, hint: "OpenCode's hosted models, like opencode/…-free. Cloud: only the limit applies.", defaultBaseUrl: "https://opencode.ai/zen/v1" },
  { kind: "openrouter", label: "OpenRouter", prefix: "openrouter/", hasBackends: false, hint: "OpenRouter called directly, like openrouter/…. Cloud: only the limit applies.", defaultBaseUrl: "https://openrouter.ai/api/v1" },
  { kind: "other", label: "Other", prefix: "", hasBackends: true, hint: "Any other model names, written in full (e.g. a direct Ollama or Claude model).", defaultBaseUrl: "" },
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

// Company config for listing each API's models: base URL and an optional key (a secret field, so a pasted key is
// stored as a company secret). Nested properties are fine: the host finds secret fields by property path.
export const LISTABLE_APIS = APIS.filter((a) => a.kind !== "other");

export const apiEndpointsSchema = {
  apiEndpoints: {
    type: "object",
    title: "API endpoints",
    description: "Where Load models lists each API's models. OpenCode and OpenRouter work without settings; LiteLLM needs your gateway's address and a key.",
    additionalProperties: false,
    properties: Object.fromEntries(LISTABLE_APIS.map((a) => [a.kind, {
      type: "object",
      title: a.label,
      additionalProperties: false,
      properties: {
        baseUrl: { type: "string", title: "Base URL", description: a.defaultBaseUrl ? `Defaults to ${a.defaultBaseUrl}` : "e.g. https://litellm.example.com (the plugin calls /v1/models)" },
        key: { type: "string", format: "secret-ref", title: "API key", description: "Optional for public lists. Paste a key (stored as a company secret) or pick a secret." },
      },
    }])),
  },
};
