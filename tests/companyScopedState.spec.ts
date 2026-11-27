import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import type { PluginStateClient, ScopeKey } from "@paperclipai/plugin-sdk";

import { companyScopedState } from "../src/state/companyScoped.js";

const denied = () => Object.assign(new Error("Missing or unknown invocation scope"), { code: -32005 });
const id = (k: ScopeKey) => `${k.scopeKind}|${"scopeId" in k ? k.scopeId : ""}|${k.stateKey}`;

// Applies Paperclip 1127's rule for a worker call made outside any invocation: while the plugin has a request in
// flight (`busy`), a call naming no company is refused; a call naming a configured company is admitted.
// A call made inside a request carries its id (the `request` store); instance state is admitted then, busy or not.
const request = new AsyncLocalStorage<string>();
const fakeHost = (configured: string[]) => {
  const rows = new Map<string, unknown>();
  const host = {
    busy: false,
    rows,
    calls: [] as string[],
    client: {
      get: async (k: ScopeKey) => { host.calls.push(`get ${id(k)}`); gate(k); return rows.get(id(k)) ?? null; },
      set: async (k: ScopeKey, v: unknown) => { host.calls.push(`set ${id(k)}`); gate(k); rows.set(id(k), v); },
      delete: async (k: ScopeKey) => { host.calls.push(`delete ${id(k)}`); gate(k); rows.delete(id(k)); },
    } as unknown as PluginStateClient,
  };
  const gate = (k: ScopeKey) => {
    if (k.scopeKind === "company") {
      if (!configured.includes(k.scopeId as string)) throw denied();
    } else if (host.busy && !request.getStore()) throw denied();
  };
  return host;
};

describe("state under a company's scope (Paperclip 1127)", () => {
  it("reads and writes while the plugin has a request in flight, which instance scope can't, once past the first look", async () => {
    const host = fakeHost(["jd", "slide"]);
    const state = companyScopedState(host.client, async () => ["slide", "jd"]);
    // A key never seen is looked for once under the old instance scope, which needs a quiet moment.
    host.busy = true;
    await expect(state.get({ scopeKind: "instance", stateKey: "pools" })).rejects.toThrow(/invocation scope/);
    host.busy = false;
    expect(await state.get({ scopeKind: "instance", stateKey: "pools" })).toBeNull();
    // After that, and for anything written, a busy host doesn't matter.
    host.busy = true;
    await state.set({ scopeKind: "instance", stateKey: "pools" }, { a: 1 });
    expect(await state.get({ scopeKind: "instance", stateKey: "pools" })).toEqual({ a: 1 });
    expect(host.rows.get("company|jd|pools")).toEqual({ a: 1 });
  });

  it("keeps the anchor it chose, even when a company that sorts earlier is configured later", async () => {
    const host = fakeHost(["jd"]);
    await companyScopedState(host.client, async () => ["jd"]).set({ scopeKind: "instance", stateKey: "holds" }, { x: 1 });
    expect(host.rows.get("company|jd|stateAnchor")).toBe(true);
    // A restart, with a company "aaa" now configured that sorts before "jd".
    const later = fakeHost(["aaa", "jd"]);
    for (const [k, v] of host.rows) later.rows.set(k, v);
    later.busy = true;
    const second = companyScopedState(later.client, async () => ["aaa", "jd"]);
    expect(await second.get({ scopeKind: "instance", stateKey: "holds" })).toEqual({ x: 1 });
    expect(later.rows.has("company|aaa|stateAnchor")).toBe(false);
  });

  it("skips a company the plugin isn't configured for when choosing the anchor", async () => {
    const host = fakeHost(["slide"]);
    const state = companyScopedState(host.client, async () => ["jd", "slide"]);
    await state.set({ scopeKind: "instance", stateKey: "k" }, 1);
    expect(host.rows.get("company|slide|k")).toBe(1);
    expect(host.rows.get("company|slide|stateAnchor")).toBe(true);
  });

  it("carries data written under the instance scope over, once", async () => {
    const host = fakeHost(["jd"]);
    host.rows.set("instance||overrides", { version: 1, data: { t: "m" } });
    const state = companyScopedState(host.client, async () => ["jd"]);
    expect(await state.get({ scopeKind: "instance", stateKey: "overrides" })).toEqual({ version: 1, data: { t: "m" } });
    expect(host.rows.get("company|jd|overrides")).toEqual({ version: 1, data: { t: "m" } });
    // The new copy wins from now on; the old one isn't read again.
    await state.set({ scopeKind: "instance", stateKey: "overrides" }, { version: 1, data: { t: "n" } });
    host.calls.length = 0;
    expect(await state.get({ scopeKind: "instance", stateKey: "overrides" })).toEqual({ version: 1, data: { t: "n" } });
    expect(host.calls).toEqual(["get company|jd|overrides"]);
  });

  it("inside a request, the first look under the old scope works while the host is busy", async () => {
    const host = fakeHost(["jd", "slide"]);
    host.rows.set("instance||holds", { version: 1, data: { h: 1 } });
    host.busy = true;
    const state = companyScopedState(host.client, async () => ["jd"]);
    const got = await request.run("req-1", () => state.get({ scopeKind: "instance", stateKey: "holds" }));
    expect(got).toEqual({ version: 1, data: { h: 1 } });
    expect(await request.run("req-1", () => state.get({ scopeKind: "instance", stateKey: "never" }))).toBeNull();
  });

  it("a deleted key doesn't come back from the old copy", async () => {
    const host = fakeHost(["jd"]);
    host.rows.set("instance||drainSince", { a: "b" });
    const state = companyScopedState(host.client, async () => ["jd"]);
    await state.delete({ scopeKind: "instance", stateKey: "drainSince" });
    expect(host.rows.has("instance||drainSince")).toBe(false);
    expect(await companyScopedState(host.client, async () => ["jd"]).get({ scopeKind: "instance", stateKey: "drainSince" })).toBeNull();
  });

  it("keeps company-scoped keys as they are, and uses the instance scope while no company is known", async () => {
    const host = fakeHost(["jd"]);
    const none = companyScopedState(host.client, async () => []);
    await none.set({ scopeKind: "instance", stateKey: "early" }, 1);
    expect(host.rows.get("instance||early")).toBe(1);
    const state = companyScopedState(host.client, async () => ["jd"]);
    await state.set({ scopeKind: "company", scopeId: "jd", stateKey: "queueBlockers" }, 2);
    expect(host.rows.get("company|jd|queueBlockers")).toBe(2);
    expect(await state.get({ scopeKind: "instance", stateKey: "early" })).toBe(1);
  });
});
