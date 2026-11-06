import type { PoolConfig } from "../types.js";

type PoolPatterns = Pick<PoolConfig, "id" | "patterns">;

interface PatternScore {
  exact: boolean;
  literal: number;
}

const WILDCARD = /[*?]/;
const regexCache = new Map<string, RegExp>();

const escapeRegExp = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const globToRegExp = (pattern: string): RegExp => {
  let re = regexCache.get(pattern);
  if (re) return re;
  const body = [...pattern].map((c) => (c === "*" ? ".*" : c === "?" ? "." : escapeRegExp(c))).join("");
  re = new RegExp(`^${body}$`);
  regexCache.set(pattern, re);
  return re;
};

const literalLength = (pattern: string) => pattern.replace(/[*?]/g, "").length;

// Only `*` and `?` are wildcards; everything else, `[` included, matches itself.
export const patternMatches = (pattern: string, model: string) =>
  WILDCARD.test(pattern) ? globToRegExp(pattern).test(model) : pattern === model;

const scorePattern = (pattern: string, model: string): PatternScore | undefined => {
  if (!patternMatches(pattern, model)) return undefined;
  return { exact: !WILDCARD.test(pattern), literal: literalLength(pattern) };
};

const better = (a: PatternScore, b: PatternScore) => (a.exact !== b.exact ? a.exact : a.literal > b.literal);

// Most specific pool wins (PRD A2): exact beats glob, then the longest literal text, then pool order.
export const matchPool = <P extends PoolPatterns>(model: string | null | undefined, pools: readonly P[]): P | undefined => {
  if (!model) return undefined;
  let best: { pool: P; score: PatternScore } | undefined;
  for (const pool of pools) {
    for (const pattern of pool.patterns) {
      const score = scorePattern(pattern, model);
      if (score && (!best || better(score, best.score))) best = { pool, score };
    }
  }
  return best?.pool;
};
