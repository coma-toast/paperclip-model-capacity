import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { backendBaseUrl, backendPrefix, backendsConfigSchema, probeBaseUrl, backendForModel, createBackendAuth, readBackends, summarizeBackends } from "../src/backends.js";
import { opencodeCopilotToken } from "../src/opencodeAuth.js";
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
    expect(probeBaseUrl({ type: "opencode" })).toBe("https://opencode.ai/zen");
    expect(probeBaseUrl({ type: "openai", baseUrl: "https://api.example.com/v1/" })).toBe("https://api.example.com");
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

  it("uses opencode's Copilot login for a Copilot backend with no key", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ backends: [{ id: "gh", name: "Copilot", type: "copilot" }] });
    expect(await createBackendAuth(harness.ctx, Date.now, async () => "gho_x").headersFor("c1", "gh")).toEqual({ Authorization: "Bearer gho_x" });
    expect(await createBackendAuth(harness.ctx, Date.now, async () => undefined).headersFor("c1", "gh")).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), "oc-"));
    await writeFile(join(dir, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", refresh: "gho_file", access: "tid=short" } }));
    expect(await opencodeCopilotToken(join(dir, "auth.json"))).toBe("gho_file");
    expect(await opencodeCopilotToken(join(dir, "missing.json"))).toBeUndefined();
  });

  it("gives the host's config form a type select and its secret picker for the key", () => {
    const item = backendsConfigSchema.backends.items.properties;
    expect(item.type.enum).toContain("litellm");
    expect(item.key).toMatchObject({ format: "secret-ref" });
    expect("type" in item.key).toBe(false);
  });
});

describe("backendForModel", () => {
  it("picks the backend whose prefix the model starts with (longest first); bare names match none", () => {
    const backends = [
      { id: "litellm", type: "litellm" as const, prefix: "litellm/" },
      { id: "or", type: "openrouter" as const },
      { id: "or-free", type: "openrouter" as const, prefix: "openrouter/free/" },
      { id: "sub", type: "other" as const },
    ];
    expect(backendForModel("litellm/free", backends)?.id).toBe("litellm");
    expect(backendForModel("openrouter/qwen/x", backends)?.id).toBe("or");
    expect(backendForModel("openrouter/free/x", backends)?.id).toBe("or-free");
    expect(backendForModel("claude-haiku-5-5", backends)).toBeUndefined();
  });
});

