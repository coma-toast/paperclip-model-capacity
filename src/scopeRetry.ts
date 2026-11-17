import { AsyncResource } from "node:async_hooks";

// Paperclip 2026.1110+ ties every worker→host call to the host call (invocation) it was made in. Two kinds of our
// calls get "Missing or unknown invocation scope":
// - background work (timers, debounced cycles) that calls the host while some other invocation is running: a call
//   that names no company is refused until nothing else is running;
// - work started inside an event or data handler that outlives it: it still carries that handler's invocation id,
//   which the host has already forgotten.
// So a refused call is retried outside any invocation context, with a short backoff.

// Bound at module load, before any invocation exists: runs a function in that empty async context.
const detached = AsyncResource.bind(<T>(fn: () => T): T => fn());

const SCOPE_DENIED = -32005;
export const isScopeDenied = (e: unknown) => {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === SCOPE_DENIED || (typeof err?.message === "string" && err.message.includes("Missing or unknown invocation scope"));
};

export const RETRY_DELAYS_MS = [50, 150, 400, 1000, 2000, 4000, 8000];
const sleep = (ms: number) => new Promise<void>((resolve) => detached(() => setTimeout(resolve, ms)));

// Calls fn; on a scope refusal, calls it again outside any invocation, backing off between attempts.
export const withScopeRetry = async <T>(fn: () => Promise<T>, delays: readonly number[] = RETRY_DELAYS_MS): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (!isScopeDenied(e)) throw e;
    let last: unknown = e;
    for (const ms of delays) {
      await sleep(ms);
      try {
        return await detached(fn);
      } catch (again) {
        if (!isScopeDenied(again)) throw again;
        last = again;
      }
    }
    throw last;
  }
};

// Wraps the plugin context so every host call that returns a promise retries on a scope refusal. Nested namespaces
// (ctx.issues.relations) are wrapped too; registration calls (ctx.data.register, ctx.events.on) pass through as they
// return no promise. Functions keep their `this`.
export const scopeRetryContext = <C extends object>(ctx: C, delays: readonly number[] = RETRY_DELAYS_MS): C => {
  const cache = new WeakMap<object, unknown>();
  const wrap = (target: object): unknown => {
    const hit = cache.get(target);
    if (hit) return hit;
    const proxy = new Proxy(target, {
      get(obj, key) {
        const value = Reflect.get(obj, key);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            const first = value.apply(obj, args);
            if (!(first instanceof Promise)) return first;
            let used = false;
            // The first attempt already ran; a retry re-issues the same call.
            return withScopeRetry(() => (used ? value.apply(obj, args) : ((used = true), first)), delays);
          };
        }
        if (value && typeof value === "object" && !Array.isArray(value)) return wrap(value);
        return value;
      },
    });
    cache.set(target, proxy);
    return proxy;
  };
  return wrap(ctx) as C;
};
