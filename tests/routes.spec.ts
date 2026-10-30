import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import { fetchProxyRoutes, sameEndpoint } from "../src/routes.js";
import { startFake } from "./fakes/server.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

describe("sameEndpoint", () => {
  it("matches by scheme, host and port, ignoring /v1 and slashes", () => {
    expect(sameEndpoint("http://10.0.0.5:1235/v1", "http://10.0.0.5:1235")).toBe(true);
    expect(sameEndpoint("http://10.0.0.5:1235/v1/", "http://10.0.0.5:1235/v1")).toBe(true);
    expect(sameEndpoint("http://10.0.0.5:1235", "http://10.0.0.5:8091")).toBe(false);
    expect(sameEndpoint(undefined, "http://x")).toBe(false);
  });
});

describe("fetchProxyRoutes", () => {
  it("reads LiteLLM's routing and matches each deployment to an engine backend", async () => {
    const f = await startFake({ "/model/info": { body: { data: [
      { model_name: "mbp", litellm_params: { model: "openai/qwen", api_base: "http://10.0.0.5:1235/v1" } },
      { model_name: "local", litellm_params: { model: "strata", api_base: "http://10.0.0.6:8091/v1" } },
      { model_name: "local", litellm_params: { model: "openai/qwen", api_base: "http://10.0.0.5:1235/v1" } },
      { model_name: "free", litellm_params: { model: "openrouter/x" } },
    ] } } });
    open.push(f);
    const { ctx } = createTestHarness({ manifest });
    const engines = [
      { id: "mac", name: "Mac", type: "omlx" as const, baseUrl: "http://10.0.0.5:1235" },
      { id: "gpu", name: "GPU", type: "llamacpp" as const, baseUrl: "http://10.0.0.6:8091" },
    ];
    const r = await fetchProxyRoutes(ctx, { id: "proxy", name: "Proxy", type: "litellm", baseUrl: f.baseUrl }, engines);
    expect(r).toEqual({ ok: true, routes: [
      { model: "litellm/mbp", targets: [{ apiBase: "http://10.0.0.5:1235/v1", upstream: "openai/qwen", engine: "mac" }] },
      { model: "litellm/local", targets: [{ apiBase: "http://10.0.0.6:8091/v1", upstream: "strata", engine: "gpu" }, { apiBase: "http://10.0.0.5:1235/v1", upstream: "openai/qwen", engine: "mac" }] },
      { model: "litellm/free", targets: [{ apiBase: undefined, upstream: "openrouter/x", engine: undefined }] },
    ] });
  });

  it("says when a backend type doesn't expose routing", async () => {
    const { ctx } = createTestHarness({ manifest });
    expect(await fetchProxyRoutes(ctx, { id: "o", name: "O", type: "openai", baseUrl: "http://x" }, [])).toMatchObject({ ok: false });
  });
});
