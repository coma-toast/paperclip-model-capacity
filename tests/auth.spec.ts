import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { registerApi, type InspectHostResult } from "../src/api.js";
import { AUTH_SLOTS, createServerAuth, summarizeAuth } from "../src/auth.js";
import manifest from "../src/manifest.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import plugin from "../src/worker.js";
import { openAiRoutes } from "./fakes/openai.js";
import { startFake } from "./fakes/server.js";

const TOKEN = { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" };
const open: { close: () => Promise<void> }[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all([...open.splice(0).map((f) => f.close()), ...runtimes.splice(0).map((r) => r.stop())]);
});

describe("server auth slots", () => {
  it("declares four slots whose token is a secret field the host converts and binds", () => {
    const props = manifest.instanceConfigSchema?.properties as Record<string, { properties: Record<string, { format?: string }> }>;
    for (const slot of AUTH_SLOTS) expect(props[slot].properties.token.format).toBe("secret-ref");
  });

  it("summarizes which servers have auth without exposing the token", () => {
    const summary = summarizeAuth({ serverAuth1: { server: "ct118", token: TOKEN }, serverAuth2: { server: "mbp", header: "X-Api-Key", scheme: "" }, serverAuth3: {} });
    expect(summary).toEqual([
      { slot: "serverAuth1", server: "ct118", header: "Authorization", scheme: "Bearer", hasToken: true },
      { slot: "serverAuth2", server: "mbp", header: "X-Api-Key", scheme: "", hasToken: false },
    ]);
    expect(JSON.stringify(summary)).not.toContain(TOKEN.secretId);
  });

  it("resolves the token at its slot's config path and builds the header", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ serverAuth2: { server: "ct118", token: TOKEN }, serverAuth3: { server: "mbp", header: "X-Api-Key", scheme: "", token: TOKEN } });
    const auth = createServerAuth(harness.ctx);
    const bearer = await auth.headersFor("c1", "ct118");
    expect(Object.keys(bearer!)).toEqual(["Authorization"]);
    expect(bearer!.Authorization.startsWith("Bearer ")).toBe(true);
    const raw = await auth.headersFor("c1", "mbp");
    expect(Object.keys(raw!)).toEqual(["X-Api-Key"]);
    expect(raw!["X-Api-Key"].startsWith("Bearer")).toBe(false);
    expect(await auth.headersFor("c1", "other")).toBeUndefined();
  });

  it("caches a resolved token for a few minutes", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ serverAuth1: { server: "ct118", token: TOKEN } });
    let calls = 0;
    const resolve = harness.ctx.secrets.resolve;
    harness.ctx.secrets.resolve = async (ref, opts) => { calls += 1; expect(opts?.configPath).toBe("serverAuth1.token"); return resolve(ref, opts); };
    let now = 0;
    const auth = createServerAuth(harness.ctx, () => now);
    await auth.headersFor("c1", "ct118");
    await auth.headersFor("c1", "ct118");
    now = 6 * 60_000;
    await auth.headersFor("c1", "ct118");
    expect(calls).toBe(2);
  });

  it("accepts slot objects in config validation and still rejects unknown keys", async () => {
    expect(await plugin.definition.onValidateConfig!({ serverAuth1: { server: "ct118", token: TOKEN }, queueLabelId: "l" })).toEqual({ ok: true });
    expect(await plugin.definition.onValidateConfig!({ serverAuth1: "x", serverAuth9: {} })).toEqual({ ok: false, errors: ["serverAuth1: must be an object", "serverAuth9: unknown setting"] });
  });
});

describe("Check server with auth", () => {
  it("sends the backend's auth header and reports that it did", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ serverAuth1: { server: "ct118", token: TOKEN } });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(runtime);
    registerApi(harness.ctx, runtime);
    const f = await startFake(openAiRoutes());
    open.push(f);
    const r = await harness.performAction<InspectHostResult>("inspect-host", { companyId: "c1", poolId: "vm", host: { id: "ct118", engine: "openai", baseUrl: f.baseUrl } }, { actor: { type: "user", userId: "u1" } });
    expect(r).toMatchObject({ ok: true, usedAuth: true, server: { up: true } });
    expect(f.requests[0].headers.authorization?.startsWith("Bearer ")).toBe(true);
    const noAuth = await harness.performAction<InspectHostResult>("inspect-host", { companyId: "c1", host: { id: "other", engine: "openai", baseUrl: f.baseUrl } }, { actor: { type: "user", userId: "u1" } });
    expect(noAuth.usedAuth).toBe(false);
    expect(f.requests[1].headers.authorization).toBeUndefined();
  });

  it("the background health check uses the same auth", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ serverAuth4: { server: "ct118", token: TOKEN } });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(runtime);
    const f = await startFake(openAiRoutes());
    open.push(f);
    await runtime.store.companies.set([{ id: "c1", name: "c1" }]);
    await runtime.store.companyPools("c1").set([{ id: "vm", name: "vm", patterns: ["litellm/vm"], limit: 1, privacy: "private", mode: "observe", scope: "instance", alertAfterMinutes: 30,
      hosts: [{ id: "ct118", name: "CT118", engine: "openai", baseUrl: f.baseUrl, declaredSlots: 1 }] }]);
    await runtime.probeTick();
    expect(f.requests[0].headers.authorization?.startsWith("Bearer ")).toBe(true);
  });
});
