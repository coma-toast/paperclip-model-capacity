import { describe, expect, it } from "vitest";
import { readPaperclipQuota, DEFAULT_QUOTA_ERROR_PATTERNS, type QuotaFailureRow } from "../src/quota/paperclip.js";

const NOW = new Date("2026-11-03T17:00:00Z");
const at = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();
const q = (s: { source: string; value: number }[]): [string, number][] => s.map((x) => [x.source, x.value]);
const read = (rows: QuotaFailureRow[] | undefined | (() => Promise<QuotaFailureRow[] | undefined>), extra: Record<string, unknown> = {}) =>
  readPaperclipQuota({ readRuns: typeof rows === "function" ? (rows as () => Promise<QuotaFailureRow[] | undefined>) : async () => rows, now: () => NOW, ...extra });

// Host data via a fake reader, so the adapter is tested without a database (the real reader lands in P3.2).
const rows: QuotaFailureRow[] = [
  { model: "free", error: "HTTP 429: rate limit exceeded", occurredAt: at(10) },
  { model: "free", error: "insufficient credit", occurredAt: at(180) },
  { model: "mbp", error: "some unrelated crash", occurredAt: at(5) },
  { model: "gone", error: "429 rate limit", occurredAt: at(1500) },
  { model: "timeless", error: "quota exceeded", occurredAt: null },
];

describe("Paperclip quota (host failed runs)", () => {
  it("counts quota failures per model over 1 h and 24 h, naming each source", async () => {
    // free hits twice within 24 h (once inside the hour); mbp's crash is not quota; gone is past the window;
    // timeless has no stamp, so it's dropped rather than guessed into a window.
    expect(q(await read(rows))).toEqual([
      ["paperclip:free:quotaFailed24h", 2],
      ["paperclip:free:quotaFailed1h", 1],
    ]);
    expect(q(await read(rows)).some((x) => /mbp|gone|timeless/.test(x[0]))).toBe(false);
  });

  it("a model with no evidence is absent, not zero — exhausted is a report, not an absence (E5)", async () => {
    const res = await read([{ model: "free", error: "429", occurredAt: at(1) }]);
    expect(q(res)).toEqual([["paperclip:free:quotaFailed24h", 1], ["paperclip:free:quotaFailed1h", 1]]);
  });

  it("patterns are configurable: the out-of-credit text (open Q1) is addable without a code change", async () => {
    const withQuota = await read([{ model: "x", error: "quota exceeded", occurredAt: at(1) }]);
    expect(q(withQuota)).toEqual([["paperclip:x:quotaFailed24h", 1], ["paperclip:x:quotaFailed1h", 1]]);
    // Dropping the quota word means this no longer matches, so the model disappears entirely.
    expect(q(await read([{ model: "x", error: "quota exceeded", occurredAt: at(1) }], { patterns: ["429"] }))).toEqual([]);
    expect(DEFAULT_QUOTA_ERROR_PATTERNS).toContain("quota");
  });

  it("an invalid pattern is dropped, never allowed to wedge the sweep", async () => {
    // "(" won't compile; it's ignored so the valid "429" still decides.
    const res = await read([
      { model: "a", error: "rate limit", occurredAt: at(1) },
      { model: "b", error: "429", occurredAt: at(1) },
    ], { patterns: ["(", "429"] });
    expect(q(res)).toEqual([["paperclip:b:quotaFailed24h", 1], ["paperclip:b:quotaFailed1h", 1]]);
  });

  it("a failing or empty reader yields no samples, not a fabricated count", async () => {
    expect(await read(async () => { throw new Error("db down"); })).toEqual([]);
    expect(await read(undefined)).toEqual([]);
    expect(await read([])).toEqual([]);
  });
});
