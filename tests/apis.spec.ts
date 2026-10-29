import { describe, expect, it } from "vitest";

import { addPrefix, inferApi, stripPrefix } from "../src/apis.js";

describe("API prefixes", () => {
  it("adds and strips the API's prefix, leaving other APIs' names alone", () => {
    expect(addPrefix("litellm", "vm")).toBe("litellm/vm");
    expect(addPrefix("litellm", "litellm/vm")).toBe("litellm/vm");
    expect(addPrefix("other", "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(stripPrefix("litellm", "litellm/pc-omo-local-*")).toBe("pc-omo-local-*");
    expect(stripPrefix("opencode", "litellm/vm")).toBe("litellm/vm");
  });

  it("infers an API only when every pattern names it", () => {
    expect(inferApi(["openrouter/a", "openrouter/b"])).toBe("openrouter");
    expect(inferApi(["litellm/vm", "opencode/x"])).toBe("other");
    expect(inferApi([])).toBe("other");
  });
});
