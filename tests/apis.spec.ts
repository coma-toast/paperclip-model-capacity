import { describe, expect, it } from "vitest";

import { addPrefix, backendFromConnection, inferApi, poolPrefix, stripPrefix } from "../src/apis.js";

describe("API prefixes", () => {
  it("adds and strips a prefix, leaving other names alone", () => {
    expect(addPrefix("litellm/", "m")).toBe("litellm/m");
    expect(addPrefix("litellm/", "litellm/m")).toBe("litellm/m");
    expect(addPrefix("", "model-x")).toBe("model-x");
    expect(stripPrefix("litellm/", "litellm/a-*")).toBe("a-*");
    expect(stripPrefix("opencode/", "litellm/m")).toBe("litellm/m");
  });

  it("uses a pool's own prefix over its API's suggestion", () => {
    expect(poolPrefix({ api: "ollama" })).toBe("ollama/");
    expect(poolPrefix({ api: "ollama", prefix: "local/" })).toBe("local/");
    expect(poolPrefix({ api: "openai" })).toBe("");
  });

  it("infers an API only when every pattern names it", () => {
    expect(inferApi(["openrouter/a", "openrouter/b"])).toBe("openrouter");
    expect(inferApi(["litellm/a", "opencode/x"])).toBe("other");
    expect(inferApi([])).toBe("other");
  });
});

describe("backendFromConnection", () => {
  it("maps API-key connections to backends and explains the rest", () => {
    expect(backendFromConnection({ provider: "openrouter", method: "api_key" })).toEqual({ type: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    expect(backendFromConnection({ provider: "acme", method: "api_key", routing: { kind: "gateway", baseUrl: "https://gw.example.com/v1" } })).toEqual({ type: "openai", baseUrl: "https://gw.example.com/v1" });
    expect(backendFromConnection({ provider: "openai", method: "api_key" })).toEqual({ type: "openai", baseUrl: "https://api.openai.com/v1" });
    expect(backendFromConnection({ provider: "openai", method: "subscription" })).toEqual({ reason: "a subscription; its usage shows under Subscriptions" });
    expect(backendFromConnection({ provider: "anthropic", method: "api_key" })).toEqual({ reason: "not an OpenAI-compatible API" });
  });
});
