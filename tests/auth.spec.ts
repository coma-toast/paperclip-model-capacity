import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { registerApi, type InspectHostResult } from "../src/api.js";
import { CREDENTIAL_SLOTS, createCredentials, summarizeCredentials } from "../src/auth.js";
import manifest from "../src/manifest.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import plugin from "../src/worker.js";
import { openAiRoutes } from "./fakes/openai.js";
import { startFake } from "./fakes/server.js";
import { pool } from "./fixtures/snapshot.js";

const TOKEN = { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" };
const open: { close: () => Promise<void> }[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all([...open.splice(0).map((f) => f.close()), ...runtimes.splice(0).map((r) => r.stop())]);
});

describe("credential slots", () => {
  it("declares four slots whose token is a secret field the host converts and binds", () => {
    const props = manifest.instanceConfigSchema?.properties as Record<string, { properties: Record<string, { format?: string }> }>;
    for (const slot of CREDENTIAL_SLOTS) expect(props[slot].properties.token.format).toBe("secret-ref");
  });

  it("summarizes credential names without exposing the token", () => {
    const summary = summarizeCredentials({ credential1: { name: "proxy-key", token: TOKEN }, credential2: { name: "lab", header: "X-Api-Key", scheme: "" }, credential3: {} });
    expect(summary).toEqual([
      { slot: "credential1", name: "proxy-key", header: "Authorization", scheme: "Bearer", hasToken: true },
      { slot: "credential2", name: "lab", header: "X-Api-Key", scheme: "", hasToken: false },
    ]);
    expect(JSON.stringify(summary)).not.toContain(TOKEN.secretId);
  });

  it("resolves a named credential at its slot's config path and builds the header", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ credential2: { name: "proxy-key", token: TOKEN }, credential3: { name: "lab", header: "X-Api-Key", scheme: "", token: TOKEN } });
    const creds = createCredentials(harness.ctx);
    const bearer = await creds.headersFor("c1", "proxy-key");
    expect(bearer!.Authorization.startsWith("Bearer ")).toBe(true);
    const raw = await creds.headersFor("c1", "lab");
    expect(Object.keys(raw!)).toEqual(["X-Api-Key"]);
    expect(raw!["X-Api-Key"].startsWith("Bearer")).toBe(false);
    expect(await creds.headersFor("c1", "missing")).toBeUndefined();
    expect(await creds.headersFor("c1", undefined)).toBeUndefined();
  });

  it("caches a resolved token for a few minutes", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ credential1: { name: "k", token: TOKEN } });
    let calls = 0;
    const resolve = harness.ctx.secrets.resolve;
    harness.ctx.secrets.resolve = async (ref, opts) => { calls += 1; expect(opts?.configPath).toBe("credential1.token"); return resolve(ref, opts); };
    let now = 0;
    const creds = createCredentials(harness.ctx, () => now);
    await creds.headersFor("c1", "k");
    await creds.headersFor("c1", "k");
    now = 6 * 60_000;
    await creds.headersFor("c1", "k");
    expect(calls).toBe(2);
  });

  it("accepts credential objects in config validation and rejects unknown keys", async () => {
    expect(await plugin.definition.onValidateConfig!({ credential1: { name: "k", token: TOKEN }, queueLabelId: "l" })).toEqual({ ok: true });
    expect(await plugin.definition.onValidateConfig!({ credential1: "x", serverAuth1: {} })).toEqual({ ok: false, errors: ["credential1: must be an object", "serverAuth1: unknown setting"] });
  });
});

describe("credentials in use", () => {
  const setup = async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ credential1: { name: "proxy-key", token: TOKEN } });
    const runtime = createRuntime(harness.ctx, { probeIntervalMs: 0, readRuns: async () => [] });
    runtimes.push(runtime);
    registerApi(harness.ctx, runtime);
    const f = await startFake(openAiRoutes());
    open.push(f);
    return { harness, runtime, f };
  };

  it("Check server sends the backend's credential and says so", async () => {
    const { harness, f } = await setup();
    const user = { actor: { type: "user" as const, userId: "u1" } };
    const r = await harness.performAction<InspectHostResult>("inspect-host", { companyId: "c1", host: { id: "b1", engine: "openai", baseUrl: f.baseUrl, credential: "proxy-key" } }, user);
    expect(r).toMatchObject({ ok: true, usedAuth: true, server: { up: true } });
    expect(f.requests[0].headers.authorization?.startsWith("Bearer ")).toBe(true);
    const noAuth = await harness.performAction<InspectHostResult>("inspect-host", { companyId: "c1", host: { id: "b1", engine: "openai", baseUrl: f.baseUrl } }, user);
    expect(noAuth.usedAuth).toBe(false);
  });

  it("the health check of a local-engine pool uses the pool's own address and credential", async () => {
    const { runtime, f } = await setup();
    await runtime.store.companies.set([{ id: "c1", name: "c1" }]);
    await runtime.store.companyPools("c1").set([pool("local", { api: "omlx", patterns: ["omlx/*"], endpoint: { baseUrl: f.baseUrl, credential: "proxy-key", slots: 2 } })]);
    await runtime.probeTick();
    expect(f.requests[0].headers.authorization?.startsWith("Bearer ")).toBe(true);
    expect(Object.keys(await runtime.store.hosts.get())).toEqual(["c1:local~endpoint"]);
  });
});
