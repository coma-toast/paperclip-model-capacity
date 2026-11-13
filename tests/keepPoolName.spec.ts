import { describe, expect, it } from "vitest";

import { resolvePool, scopedPools } from "../src/pools.js";
import { decide } from "../src/scheduler/decide.js";
import { validatePools } from "../src/settings.js";
import type { Action, PoolConfig } from "../src/types.js";
import { hold, snapshot, task, upHost } from "./fixtures/snapshot.js";

const short = (a: Action[]) => a.filter((x) => x.kind !== "alert").map((x) =>
  x.kind === "place" ? `place ${x.issueId} ${x.model}` : x.kind === "release" ? `release ${x.issueId}` : x.kind === "hold" ? `hold ${x.issueId}` : x.kind);

const backends = [
  { id: "proxy", name: "Proxy", type: "litellm" as const, baseUrl: "https://proxy" },
  { id: "gpu", name: "GPU", type: "llamacpp" as const, baseUrl: "http://gpu:8091", slots: 4, reachVia: "proxy", reachModel: "l/vm" },
];
const base = (over: Partial<PoolConfig>): PoolConfig => ({
  id: "gpu", name: "Pool", patterns: [], limit: 0, privacy: "shared", mode: "enforce", scope: "instance", hosts: [], alertAfterMinutes: 30, ...over,
});
const quota = (over: Partial<PoolConfig> = {}) => base({ kind: "quota", backend: "proxy", patterns: ["l/free"], limit: 2, agentModel: "pool/gpu", ...over });
const engine = (over: Partial<PoolConfig> = {}) => base({ kind: "engine", engines: [{ engine: "gpu" }], privacy: "private", ...over });

describe("keepPoolName", () => {
  it("drops placement for quota and engine pools that keep the pool name, and keeps it otherwise", () => {
    const [pinnedQuota, keptQuota, pinnedEngine, keptEngine] = scopedPools("c1", [
      quota(), quota({ id: "q2", keepPoolName: true }), engine({ id: "e1" }), engine({ id: "e2", keepPoolName: true }),
    ], backends);
    expect(pinnedQuota.placement?.length).toBe(1);
    expect(keptQuota.placement).toBeUndefined();
    expect(pinnedEngine.placement?.length).toBe(1);
    expect(keptEngine.placement).toBeUndefined();
    // Still counted by its own name, and an engine pool keeps its slot-based limit.
    expect(keptQuota.patterns).toContain("pool/q2");
    expect(keptEngine.limit).toBe(4);
  });

  it("releases a waiting task without pinning it to a model", () => {
    const pinned = { ...resolvePool(quota(), backends), companyId: "c1", patterns: ["l/free", "pool/gpu"] };
    const kept = { ...pinned, keepPoolName: true, placement: undefined };
    const waiting = { holds: [hold("t1")], tasks: [task("t1", { model: "pool/gpu", status: "blocked" })], hosts: { "backend~gpu": upHost("backend~gpu") } };
    expect(short(decide(snapshot({ pools: [pinned], ...waiting })))).toEqual(["place t1 l/free", "release t1"]);
    expect(short(decide(snapshot({ pools: [kept], ...waiting })))).toEqual(["release t1"]);
  });

  it("validates the setting and refuses it on a pool that switches adapters", () => {
    expect(validatePools([quota({ keepPoolName: true })]).ok).toBe(true);
    const bad = validatePools([quota({ keepPoolName: "yes" as unknown as boolean })]);
    expect(bad.ok).toBe(false);
    const switching = validatePools([quota({ keepPoolName: true, switchAdapters: true, subscription: "both", patterns: ["claude-sonnet-5-5"], agentModel: "pool/gpu" })]);
    expect(switching.ok).toBe(false);
  });
});

describe("prepaid credit", () => {
  const proxy = [{ id: "proxy", name: "Proxy", type: "litellm" as const }];
  it("shows the provider's prepaid credit on its own line", async () => {
    const { providerQuotas } = await import("../src/upstream.js");
    const meters = providerQuotas({ "gemini-pro": ["gemini/gemini-4-argon"] }, proxy, {}, {}, new Date(), {}, { gemini: { used: 1.82, credit: 5 } });
    expect(meters).toEqual([expect.objectContaining({ label: "Gemini: prepaid credit", unit: "usd", used: 1.82, limit: 5 })]);
    expect(meters[0].remaining).toBeCloseTo(3.18);
    // A capped free model on the same provider doesn't add a requests-today line next to the credit.
    const withFree = providerQuotas({ "gemini-pro": ["gemini/gemini-4-argon"], free: ["gemini/gemma-4"] }, proxy, {}, { "gemini/gemma-4": 3 }, new Date(), { "gemini/gemma-4": { rpd: 14400 } }, { gemini: { used: 1, credit: 5 } });
    expect(withFree.map((m) => m.label)).toEqual(["Gemini: prepaid credit"]);
  });

  it("pauses a provider's models once the credit is used up", async () => {
    const { upstreamQuota } = await import("../src/upstream.js");
    expect(upstreamQuota(["gemini/gemini-4-argon"], proxy, {}, {}, new Date(), {}, { gemini: { used: 1, credit: 5 } }).exhausted).toBe(false);
    const out = upstreamQuota(["gemini/gemini-4-argon", "gemini/gemini-3.1-pro-preview"], proxy, {}, {}, new Date(), {}, { gemini: { used: 5.01, credit: 5 } });
    expect(out.exhausted).toBe(true);
    expect(out.meter?.label).toBe("Prepaid credit (Gemini)");
  });

  it("holds a keep-pool-name pool's tasks while every one of its models is paused", () => {
    const kept = { ...resolvePool(quota({ keepPoolName: true }), backends), companyId: "c1", patterns: ["l/free", "pool/gpu"], placement: undefined };
    const waiting = { holds: [hold("t1")], tasks: [task("t1", { model: "pool/gpu", status: "blocked" })] };
    expect(short(decide(snapshot({ pools: [kept], ...waiting })))).toEqual(["release t1"]);
    const out = short(decide(snapshot({ pools: [kept], ...waiting, exhausted: { "c1|l/free": { since: new Date().toISOString(), reason: "Prepaid credit used up" } } })));
    expect(out).not.toContain("release t1");
  });
});
