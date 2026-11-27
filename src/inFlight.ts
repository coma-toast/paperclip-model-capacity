import { AsyncLocalStorage } from "node:async_hooks";

// Paperclip 1127 refuses a worker call that names no company (http.fetch, db.query, companies.list) whenever the
// plugin has any host request in flight. The plugin's background work (the cycle, probes, usage sampling) makes such
// calls, so it waits here until none of the plugin's own requests is running, instead of being refused and retrying.
// Work inside a request carries that request's scope and doesn't wait.

const insideRequest = new AsyncLocalStorage<true>();
let count = 0;
let waiters: (() => void)[] = [];

export const requestsInFlight = () => count;

// Wraps one host request handler (event, data, action, job, route) so it counts while it runs.
export const trackRequest = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  count++;
  try {
    return await insideRequest.run(true, fn);
  } finally {
    count--;
    if (count === 0) {
      const ready = waiters;
      waiters = [];
      for (const w of ready) w();
    }
  }
};

export const WAIT_FOR_QUIET_MS = 20_000;

// Resolves when no request is in flight, or after maxMs (a host that is never quiet still gets the call, which then
// leans on the retry). Work inside a request, or with none running, goes straight through.
export const waitForQuiet = (maxMs: number = WAIT_FOR_QUIET_MS, random: () => number = Math.random): Promise<void> => {
  if (count === 0 || insideRequest.getStore()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      waiters = waiters.filter((w) => w !== finish);
      // A short spread, so the calls released together don't all land in the same instant.
      setTimeout(resolve, Math.round(random() * 100));
    };
    const timer = setTimeout(finish, maxMs);
    waiters.push(finish);
  });
};

// Wraps the host-facing handlers on a plugin context: whatever function is passed to these registration calls counts
// as a request while it runs.
// Jobs are left out: the host registers no invocation for a job, and the sweep job awaits the whole cycle, which
// would make the cycle wait for itself.
const TRACKED = new Set(["data.register", "actions.register", "events.on"]);
export const trackedContext = <C extends object>(ctx: C): C => {
  const wrap = (target: object, path: string): unknown =>
    new Proxy(target, {
      get(obj, key) {
        const value = Reflect.get(obj, key);
        const here = path ? `${path}.${String(key)}` : String(key);
        if (typeof value === "function") {
          if (!TRACKED.has(here)) return value.bind(obj);
          return (...args: unknown[]) =>
            value.apply(obj, args.map((a) => (typeof a === "function" ? (...inner: unknown[]) => trackRequest(() => (a as (...x: unknown[]) => unknown)(...inner)) : a)));
        }
        if (value && typeof value === "object" && !Array.isArray(value)) return wrap(value, here);
        return value;
      },
    });
  return wrap(ctx, "") as C;
};
