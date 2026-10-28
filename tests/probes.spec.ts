import { afterEach, describe, expect, it } from "vitest";

import { nextStatus, probeAll, runProbe } from "../src/probes/index.js";
import { sumGauge } from "../src/probes/vllm.js";
import type { EngineKind, HostStatus } from "../src/types.js";
import { host, pool } from "./fixtures/snapshot.js";
import { llamaCppRoutes } from "./fakes/llamacpp.js";
import { lmStudioRoutes } from "./fakes/lmstudio.js";
import { ollamaRoutes } from "./fakes/ollama.js";
import { openAiRoutes } from "./fakes/openai.js";
import { startFake, type Routes } from "./fakes/server.js";
import { vllmRoutes } from "./fakes/vllm.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const fake = async (routes: Routes) => {
  const f = await startFake(routes);
  open.push(f);
  return f;
};
const probe = async (engine: EngineKind, routes: Routes, opts: { authHeader?: string; timeoutMs?: number } = {}) => {
  const f = await fake(routes);
  return { result: await runProbe(host("h1", { engine, baseUrl: f.baseUrl }), { fetch, ...opts }), requests: f.requests };
};

describe("engine probes", () => {
  it("llama.cpp: health plus slot count and busy slots", async () => {
    const { result } = await probe("llamacpp", llamaCppRoutes([true, false, false]));
    expect(result).toEqual({ up: true, slotsTotal: 3, slotsBusy: 1 });
  });

  it("llama.cpp: up without slot data when /slots is disabled", async () => {
    const { result } = await probe("llamacpp", { "/health": { body: { status: "ok" } } });
    expect(result).toEqual({ up: true });
  });

  it("llama.cpp: down while the model is loading (503)", async () => {
    const { result } = await probe("llamacpp", { "/health": { status: 503, body: { error: "loading" } } });
    expect(result).toMatchObject({ up: false, error: "/health returned 503" });
  });

  it("ollama: up from tags and ps, no slot data", async () => {
    expect((await probe("ollama", ollamaRoutes())).result).toEqual({ up: true });
  });

  it("openai-compatible: up from /v1/models", async () => {
    expect((await probe("openai", openAiRoutes())).result).toEqual({ up: true });
  });

  it("vllm: busy slots from running requests across models", async () => {
    expect((await probe("vllm", vllmRoutes([2, 1]))).result).toEqual({ up: true, slotsBusy: 3 });
  });

  it("vllm: down when the metric is missing", async () => {
    expect((await probe("vllm", { "/metrics": { text: "# nothing here\n" } })).result).toMatchObject({ up: false });
  });

  it("lm studio: up when a model is loaded, down when none is", async () => {
    expect((await probe("lmstudio", lmStudioRoutes(["not-loaded", "loaded"]))).result).toEqual({ up: true });
    expect((await probe("lmstudio", lmStudioRoutes(["not-loaded"]))).result).toMatchObject({ up: false, error: "no model is loaded" });
  });

  it("sends only GETs, with the auth header when one is set", async () => {
    const { requests } = await probe("openai", openAiRoutes(), { authHeader: "Bearer test-token" });
    expect(requests).toEqual([expect.objectContaining({ method: "GET", path: "/v1/models", headers: expect.objectContaining({ authorization: "Bearer test-token" }) })]);
  });
});

describe("failures", () => {
  it("times out a slow host", async () => {
    const { result } = await probe("openai", { "/v1/models": { body: { data: [] }, delayMs: 500 } }, { timeoutMs: 50 });
    expect(result).toMatchObject({ up: false, error: "timed out after 50 ms" });
  });

  it("treats malformed JSON as down", async () => {
    const { result } = await probe("ollama", { "/api/tags": { text: "{not json" } });
    expect(result).toMatchObject({ up: false, error: "/api/tags returned invalid JSON" });
  });

  it("treats the wrong JSON shape as down", async () => {
    expect((await probe("openai", { "/v1/models": { body: { models: [] } } })).result).toMatchObject({ up: false });
  });

  it("treats a refused connection as down", async () => {
    const f = await startFake({});
    await f.close();
    const result = await runProbe(host("h1", { engine: "openai", baseUrl: f.baseUrl }), { fetch, timeoutMs: 1000 });
    expect(result.up).toBe(false);
  });
});

describe("hysteresis (E2)", () => {
  const ok = { up: true, slotsTotal: 1, slotsBusy: 0 };
  const fail = { up: false, error: "boom" };
  const run = (results: { up: boolean }[], start?: HostStatus) =>
    results.reduce<HostStatus | undefined>((prev, r, i) => nextStatus("h1", prev, r, `t${i}`), start);

  it("starts down and comes up after 2 successes", () => {
    expect(run([ok])?.up).toBe(false);
    expect(run([ok, ok])?.up).toBe(true);
  });

  it("goes down only after 3 failures in a row", () => {
    const up = run([ok, ok])!;
    expect(run([fail, fail], up)?.up).toBe(true);
    expect(run([fail, fail, fail], up)?.up).toBe(false);
  });

  it("a success in between resets the failure count", () => {
    expect(run([fail, fail, ok, fail, fail], run([ok, ok]))?.up).toBe(true);
  });

  it("keeps the last slot numbers while a probe fails, and records when it changed", () => {
    const s = run([ok, ok, fail, fail, fail])!;
    expect(s).toMatchObject({ up: false, slotsTotal: 1, slotsBusy: 0, lastChangeAt: "t4", error: "boom" });
  });
});

describe("probeAll", () => {
  it("probes every host once and reports up/down changes", async () => {
    const good = await fake(openAiRoutes());
    const bad = await fake({ "/v1/models": { status: 500 } });
    const pools = [
      pool("gpu", { hosts: [host("good", { engine: "openai", baseUrl: good.baseUrl })] }),
      pool("other", { hosts: [host("bad", { engine: "openai", baseUrl: bad.baseUrl }), host("good", { engine: "openai", baseUrl: good.baseUrl })] }),
    ];
    const prev: Record<string, HostStatus> = {
      good: { hostId: "good", up: false, consecutiveFailures: 0, consecutiveSuccesses: 1 },
      bad: { hostId: "bad", up: true, consecutiveFailures: 2, consecutiveSuccesses: 0 },
    };
    const { statuses, changes } = await probeAll(pools, prev, { fetch, authHeader: async () => undefined });
    expect(good.requests).toHaveLength(1);
    expect(statuses.good.up).toBe(true);
    expect(statuses.bad.up).toBe(false);
    expect(changes).toEqual(expect.arrayContaining([{ hostId: "good", up: true }, { hostId: "bad", up: false }]));
  });

  it("probes without auth when resolving the secret fails", async () => {
    const f = await fake(openAiRoutes());
    const { statuses } = await probeAll([pool("gpu", { hosts: [host("h", { engine: "openai", baseUrl: f.baseUrl })] })], {}, {
      fetch, authHeader: async () => { throw new Error("no secret"); },
    });
    expect(statuses.h.consecutiveSuccesses).toBe(1);
    expect(f.requests[0].headers.authorization).toBeUndefined();
  });
});

describe("sumGauge", () => {
  it("ignores comments, other metrics and non-numbers", () => {
    const text = '# x 9\nvllm:num_requests_running{a="1"} 2\nvllm:num_requests_running_total 7\nvllm:num_requests_running{a="2"} NaN\n';
    expect(sumGauge(text, "vllm:num_requests_running")).toBe(2);
    expect(sumGauge("", "vllm:num_requests_running")).toBeUndefined();
  });
});
