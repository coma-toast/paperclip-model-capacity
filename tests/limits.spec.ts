import { describe, expect, it } from "vitest";

import { countRuns, nextMidnightUtc, resetFromError } from "../src/snapshot.js";

const NOW = new Date("2026-11-01T15:30:00.000Z");

describe("resetFromError", () => {
  it("reads an epoch reset header (milliseconds or seconds)", () => {
    expect(resetFromError('429 {"X-RateLimit-Reset":"1793577600000"}', NOW)).toBe("2026-11-02T00:00:00.000Z");
    expect(resetFromError("x-ratelimit-reset: 1793577600", NOW)).toBe("2026-11-02T00:00:00.000Z");
  });

  it("reads retry-after seconds and 'try again in' durations", () => {
    expect(resetFromError("429 Too Many Requests, Retry-After: 90", NOW)).toBe("2026-11-01T15:31:30.000Z");
    expect(resetFromError("Rate limit reached. Please try again in 5 minutes.", NOW)).toBe("2026-11-01T15:35:00.000Z");
    expect(resetFromError("quota exceeded, retry in 2h", NOW)).toBe("2026-11-01T17:30:00.000Z");
  });

  it("treats a daily limit as lasting until midnight UTC", () => {
    expect(resetFromError("Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", NOW)).toBe(nextMidnightUtc(NOW));
  });

  it("says nothing when the error names no reset", () => {
    expect(resetFromError("429 Too Many Requests", NOW)).toBeUndefined();
  });
});

describe("countRuns", () => {
  it("counts each run once per model, and starts over on a new UTC day", () => {
    const first = countRuns({ day: "", counts: {}, seen: [] }, [{ runId: "r1", model: "a" }, { runId: "r2", model: "a" }, { runId: "r3" }], NOW);
    expect(first.counts).toEqual({ a: 2 });
    const again = countRuns(first, [{ runId: "r1", model: "a" }, { runId: "r4", model: "b" }], NOW);
    expect(again.counts).toEqual({ a: 2, b: 1 });
    const tomorrow = countRuns(again, [{ runId: "r1", model: "a" }], new Date("2026-11-02T00:05:00.000Z"));
    expect(tomorrow).toMatchObject({ day: "2026-11-02", counts: { a: 1 } });
  });
});

describe("usage-limit messages from subscriptions", () => {
  it("reads day/hour/minute spans, Claude's |epoch form and 'try again at <date>'", () => {
    expect(resetFromError("You've hit your usage limit. Try again in 2 days 3 hours 5 minutes.", NOW)).toBe("2026-11-03T18:35:00.000Z");
    expect(resetFromError("Claude AI usage limit reached|1793577600", NOW)).toBe("2026-11-02T00:00:00.000Z");
    expect(resetFromError("Usage limit reached. Try again at Nov 4th, 2026 8:05 AM UTC", NOW)).toBe("2026-11-04T08:05:00.000Z");
  });
});
