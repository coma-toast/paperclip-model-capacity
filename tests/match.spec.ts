import { describe, expect, it } from "vitest";

import { matchPool, patternMatches } from "../src/scheduler/match.js";

const pool = (id: string, ...patterns: string[]) => ({ id, patterns });

describe("patternMatches", () => {
  it.each([
    ["gateway/gpu", "gateway/gpu", true],
    ["gateway/gpu", "gateway/gpu2", false],
    ["gateway/*", "gateway/gpu", true],
    ["gateway/*", "gateway/", true],
    ["gateway/*", "other/gpu", false],
    ["model-?", "model-a", true],
    ["model-?", "model-ab", false],
    ["*", "anything/at-all", true],
    ["a.b", "axb", false],
    ["a+b/*", "a+b/c", true],
    ["[x]", "[x]", true],
  ])("%s vs %s -> %s", (pattern, model, expected) => {
    expect(patternMatches(pattern, model)).toBe(expected);
  });
});

describe("matchPool", () => {
  it.each([
    {
      name: "exact beats a glob listed first",
      pools: [pool("glob", "gateway/*"), pool("exact", "gateway/gpu")],
      model: "gateway/gpu",
      want: "exact",
    },
    {
      name: "exact beats a glob with the same literal text",
      pools: [pool("glob", "gateway/gpu-fast*"), pool("exact", "gateway/gpu-fast")],
      model: "gateway/gpu-fast",
      want: "exact",
    },
    {
      name: "longest literal wins between globs",
      pools: [pool("broad", "opencode/*-free"), pool("narrow", "opencode/nemotron-*-free")],
      model: "opencode/nemotron-3.5-super-free",
      want: "narrow",
    },
    {
      name: "longest literal wins regardless of pool order",
      pools: [pool("narrow", "opencode/nemotron-*-free"), pool("broad", "opencode/*-free")],
      model: "opencode/nemotron-3.5-super-free",
      want: "narrow",
    },
    {
      name: "broad glob still matches what the narrow one doesn't",
      pools: [pool("broad", "opencode/*-free"), pool("narrow", "opencode/nemotron-*-free")],
      model: "opencode/qwen-free",
      want: "broad",
    },
    {
      name: "pool order breaks a literal-length tie",
      pools: [pool("first", "free/*"), pool("second", "*/gpu")],
      model: "free/gpu",
      want: "first",
    },
    {
      name: "the best pattern of a multi-pattern pool counts",
      pools: [pool("multi", "*", "gateway/gpu"), pool("glob", "gateway/*")],
      model: "gateway/gpu",
      want: "multi",
    },
    {
      name: "question mark counts as wildcard, not literal",
      pools: [pool("q", "gpu-??"), pool("star", "gpu-*")],
      model: "gpu-ab",
      want: "q",
    },
  ])("$name", ({ pools, model, want }) => {
    expect(matchPool(model, pools)?.id).toBe(want);
  });

  it.each([
    ["no pattern matches", "gateway/vm"],
    ["empty model", ""],
    ["undefined model", undefined],
    ["null model", null],
  ])("%s -> undefined", (_name, model) => {
    expect(matchPool(model, [pool("gpu", "gateway/gpu"), pool("free", "free/*")])).toBeUndefined();
  });

  it("returns undefined for no pools", () => {
    expect(matchPool("gateway/gpu", [])).toBeUndefined();
  });
});
