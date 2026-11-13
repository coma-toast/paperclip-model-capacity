import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";

import { isScopeDenied, scopeRetryContext, withScopeRetry } from "../src/scopeRetry.js";

const denied = () => Object.assign(new Error("Missing or unknown invocation scope"), { code: -32005 });

describe("invocation-scope retry", () => {
  it("recognises the host's refusal by code or message", () => {
    expect(isScopeDenied(denied())).toBe(true);
    expect(isScopeDenied(new Error("Missing or unknown invocation scope"))).toBe(true);
    expect(isScopeDenied(new Error("boom"))).toBe(false);
  });

  it("retries a refused call and returns its result; other errors aren't retried", async () => {
    let n = 0;
    expect(await withScopeRetry(async () => { if (++n < 3) throw denied(); return "ok"; }, [1, 1, 1])).toBe("ok");
    expect(n).toBe(3);
    let m = 0;
    await expect(withScopeRetry(async () => { m++; throw new Error("boom"); }, [1, 1])).rejects.toThrow("boom");
    expect(m).toBe(1);
    await expect(withScopeRetry(async () => { throw denied(); }, [1, 1])).rejects.toThrow(/invocation scope/);
  });

  it("retries outside the async context the call was made in (a stale invocation id)", async () => {
    // Stands in for the SDK's invocation store: the host refuses calls that still carry a finished invocation's id.
    const invocation = new AsyncLocalStorage<string>();
    const call = async () => { if (invocation.getStore()) throw denied(); return "proactive"; };
    const out = await invocation.run("stale-id", () => withScopeRetry(call, [1]));
    expect(out).toBe("proactive");
  });

  it("wraps nested namespaces, keeps `this`, and passes non-promise calls through", async () => {
    let tries = 0;
    const ctx = {
      issues: {
        relations: { prefix: "rel", async get(this: { prefix: string }, id: string) { if (++tries < 2) throw denied(); return `${this.prefix}:${id}`; } },
      },
      data: { registered: [] as string[], register(key: string) { this.registered.push(key); } },
    };
    const wrapped = scopeRetryContext(ctx, [1, 1]);
    expect(await wrapped.issues.relations.get("t1")).toBe("rel:t1");
    expect(tries).toBe(2);
    wrapped.data.register("health");
    expect(ctx.data.registered).toEqual(["health"]);
  });
});
