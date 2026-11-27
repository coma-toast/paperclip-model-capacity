import { describe, expect, it, vi } from "vitest";

import { requestsInFlight, trackRequest, trackedContext, waitForQuiet } from "../src/inFlight.js";
import { scopeRetryContext } from "../src/scopeRetry.js";

const gate = () => {
  let release!: () => void;
  const open = new Promise<void>((r) => { release = r; });
  return { open, release };
};

describe("requests in flight", () => {
  it("counts a request while it runs, and a background wait resumes when the last one ends", async () => {
    const a = gate();
    const b = gate();
    const ra = trackRequest(() => a.open);
    const rb = trackRequest(() => b.open);
    expect(requestsInFlight()).toBe(2);
    let waited = false;
    const w = waitForQuiet(5000, () => 0).then(() => { waited = true; });
    a.release();
    await ra;
    await new Promise((r) => setTimeout(r, 5));
    expect(waited).toBe(false);
    b.release();
    await rb;
    await w;
    expect(waited).toBe(true);
    expect(requestsInFlight()).toBe(0);
  });

  it("counts a request that throws, and gives up waiting after the cap", async () => {
    await expect(trackRequest(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(requestsInFlight()).toBe(0);
    const held = gate();
    const r = trackRequest(() => held.open);
    const t0 = Date.now();
    await waitForQuiet(30, () => 0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    held.release();
    await r;
  });

  it("work inside a request doesn't wait", async () => {
    const held = gate();
    const other = trackRequest(() => held.open);
    const t0 = Date.now();
    await trackRequest(() => waitForQuiet(5000));
    expect(Date.now() - t0).toBeLessThan(500);
    held.release();
    await other;
  });

  it("the plugin context counts its registered handlers as requests", async () => {
    let handler: (() => Promise<string>) | undefined;
    const ctx = { data: { register: (_k: string, h: () => Promise<string>) => { handler = h; } }, other: { x: 1 } };
    const tracked = trackedContext(ctx);
    const held = gate();
    tracked.data.register("k", async () => { await held.open; return "ok"; });
    const run = handler!();
    expect(requestsInFlight()).toBe(1);
    held.release();
    expect(await run).toBe("ok");
    expect(requestsInFlight()).toBe(0);
    expect(tracked.other.x).toBe(1);
  });

  it("company-less host calls wait for a quiet moment first; other calls don't", async () => {
    const quiet = vi.fn(async () => undefined);
    const ctx = { http: { fetch: async () => "fetched" }, db: { query: async () => "rows" }, issues: { list: async () => "issues" } };
    const wrapped = scopeRetryContext(ctx, [1], quiet);
    expect(await wrapped.http.fetch()).toBe("fetched");
    expect(await wrapped.db.query()).toBe("rows");
    expect(quiet).toHaveBeenCalledTimes(2);
    expect(await wrapped.issues.list()).toBe("issues");
    expect(quiet).toHaveBeenCalledTimes(2);
  });
});
