import { describe, expect, it } from "vitest";

import { backendPrices, costRating, liteLlmPrices, openRouterPrices, taskCost } from "../src/prices.js";

describe("prices", () => {
  it("reads OpenRouter's per-token strings as dollars per million, and marks zero-priced models free", () => {
    expect(openRouterPrices([
      { id: "anthropic/claude", pricing: { prompt: "0.000003", completion: "0.000015" } },
      { id: "meta/llama:free", pricing: { prompt: "0", completion: "0" } },
      { id: "no-price" },
    ])).toEqual({ "anthropic/claude": { input: 3, output: 15 }, "meta/llama:free": { input: 0, output: 0, free: true } });
  });

  it("prices a LiteLLM alias at its most expensive deployment, free only when all are, unknown if any is unpriced", () => {
    expect(liteLlmPrices([
      { model_name: "mbp", model_info: { input_cost_per_token: 0, output_cost_per_token: 0 } },
      { model_name: "free", model_info: { input_cost_per_token: 0, output_cost_per_token: 0 } },
      { model_name: "free", model_info: { input_cost_per_token: 0.0000003, output_cost_per_token: 0.0000025 } },
      { model_name: "gpt", model_info: {} },
      { model_name: "gpt", model_info: { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 } },
    ])).toEqual({ mbp: { input: 0, output: 0, free: true }, free: { input: 0.3, output: 2.5 } });
  });

  it("counts unpriced LiteLLM deployments as free when they're free models or local engines", () => {
    expect(liteLlmPrices([
      { model_name: "free", litellm_params: { model: "openrouter/nvidia/nemotron:free" } },
      { model_name: "free", litellm_params: { model: "nvidia_nim/nvidia/nemotron-120b" } },
      { model_name: "mbp", litellm_params: { model: "openai/Qwen", api_base: "http://100.109.155.63:1235/v1" } },
      { model_name: "paid", litellm_params: { model: "openai/gpt-5" } },
    ])).toEqual({ free: { input: 0, output: 0, free: true }, mbp: { input: 0, output: 0, free: true } });
  });

  it("rates the estimated cost of a task", () => {
    expect(costRating(taskCost({ free: true }))).toBe("Free");
    expect(costRating(taskCost({ input: 0.05, output: 0.2 }))).toBe("$");
    expect(costRating(taskCost({ input: 0.27, output: 1.1 }))).toBe("$$");
    expect(costRating(taskCost({ input: 1, output: 4 }))).toBe("$$$");
    expect(costRating(taskCost({ input: 3, output: 15 }))).toBe("$$$$");
    expect(costRating(taskCost({}))).toBe("?");
    expect(costRating(taskCost(undefined))).toBe("?");
  });

  it("treats every local engine model as free and never throws on a failing backend", async () => {
    expect(await backendPrices({ type: "llamacpp", baseUrl: "http://x" }, ["a"], { fetch: async () => { throw new Error("down"); } })).toEqual({ a: { free: true } });
    expect(await backendPrices({ type: "litellm", baseUrl: "http://x" }, ["a"], { fetch: async () => { throw new Error("down"); } })).toEqual({});
  });
});
