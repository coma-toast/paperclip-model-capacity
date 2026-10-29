import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { backendBaseUrl, backendPrefix, createBackendAuth, readBackends, summarizeBackends } from "../src/backends.js";
import manifest from "../src/manifest.js";

const KEY = { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" };

describe("backends", () => {
  it("reads only well-formed backends and never shows the key to the UI", () => {
    const config = { backends: [{ id: "p", name: "Proxy", type: "litellm", baseUrl: "https://p", key: KEY }, { name: "broken" }, null] };
    expect(readBackends(config).map((b) => b.id)).toEqual(["p"]);
    expect(summarizeBackends(config)).toEqual([{ id: "p", name: "Proxy", type: "litellm", baseUrl: "https://p", hasKey: true }]);
    expect(readBackends({})).toEqual([]);
  });

  it("falls back to the type's prefix and address", () => {
    expect(backendPrefix({ type: "litellm" })).toBe("litellm/");
    expect(backendPrefix({ type: "litellm", prefix: "" })).toBe("");
    expect(backendBaseUrl({ type: "openrouter" })).toMatch(/^https:\/\/openrouter\.ai/);
    expect(backendBaseUrl({ type: "ollama", baseUrl: " http://box:11434 " })).toBe("http://box:11434");
  });

  it("builds auth headers from the backend's secret, with its own header and scheme", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ backends: [
      { id: "a", name: "A", type: "openai", key: KEY },
      { id: "b", name: "B", type: "openai", key: KEY, header: "x-api-key", scheme: "" },
      { id: "c", name: "C", type: "ollama" },
    ] });
    const auth = createBackendAuth(harness.ctx);
    expect(Object.keys((await auth.headersFor("c1", "a"))!)).toEqual(["Authorization"]);
    expect((await auth.headersFor("c1", "a"))!.Authorization.startsWith("Bearer ")).toBe(true);
    const b = (await auth.headersFor("c1", "b"))!;
    expect(Object.keys(b)).toEqual(["x-api-key"]);
    expect(b["x-api-key"].startsWith("Bearer")).toBe(false);
    expect(await auth.headersFor("c1", "c")).toBeUndefined();
    expect(await auth.headersFor("c1", undefined)).toBeUndefined();
  });
});
