import type { PluginStateClient, ScopeKey } from "@paperclipai/plugin-sdk";

import { detached } from "../scopeRetry.js";

// Paperclip 2026.1127 refuses a worker→host call that names no company whenever the plugin has any host request in
// flight ("Missing or unknown invocation scope"), and all of this plugin's state was instance-scoped, so under load its
// cycle could never read its own state. A call that names one of the plugin's configured companies is admitted as
// proactive work, so every state call here is made outside any invocation, scoped to one anchor company.
//
// The anchor is chosen once and marked with a key under its own scope, so it never moves when companies are added.
// Data written before this change stays under the old instance scope: a key missing from the company scope is read
// from there once, and copied over.

const ANCHOR_MARKER = "stateAnchor";

class NoCompanyYet extends Error {}

const isInstance = (key: ScopeKey) => key.scopeKind === "instance";
const present = (v: unknown) => v !== null && v !== undefined;

export const companyScopedState = (state: PluginStateClient, candidates: () => Promise<string[]>): PluginStateClient => {
  let anchor: Promise<string> | undefined;
  const legacyChecked = new Set<string>();

  const chooseAnchor = async (): Promise<string> => {
    const ids = [...new Set(await candidates())].sort();
    if (!ids.length) throw new NoCompanyYet();
    let last: unknown = new Error("no company admitted for the plugin's state");
    let firstAdmitted: string | undefined;
    for (const id of ids) {
      let marker: unknown;
      try {
        // Only a company the plugin is configured for is admitted; this read tells which, and finds the marker an
        // earlier start left on the anchor, which keeps it from moving when a company that sorts earlier is added.
        marker = await detached(() => state.get({ scopeKind: "company", scopeId: id, stateKey: ANCHOR_MARKER }));
      } catch (e) {
        last = e;
        continue;
      }
      if (present(marker)) return id;
      firstAdmitted ??= id;
    }
    if (!firstAdmitted) throw last;
    await detached(() => state.set({ scopeKind: "company", scopeId: firstAdmitted!, stateKey: ANCHOR_MARKER }, true));
    return firstAdmitted;
  };
  const anchorId = () => {
    anchor ??= chooseAnchor().catch((e) => {
      anchor = undefined;
      throw e;
    });
    return anchor;
  };
  // With no company known yet (a new install) the state stays instance-scoped for now, and moves on the first call
  // after one is known.
  const scoped = async (key: ScopeKey): Promise<ScopeKey> => {
    if (!isInstance(key)) return key;
    try {
      return { scopeKind: "company", scopeId: await anchorId(), stateKey: key.stateKey };
    } catch (e) {
      if (e instanceof NoCompanyYet) return key;
      throw e;
    }
  };

  return {
    get: async (key) => {
      const k = await scoped(key);
      const value = await detached(() => state.get(k));
      if (present(value) || !isInstance(key) || legacyChecked.has(key.stateKey)) return value;
      const old = await detached(() => state.get(key));
      legacyChecked.add(key.stateKey);
      if (present(old)) await detached(() => state.set(k, old));
      return old;
    },
    set: async (key, value) => {
      const k = await scoped(key);
      return detached(() => state.set(k, value));
    },
    delete: async (key) => {
      const k = await scoped(key);
      await detached(() => state.delete(k));
      // The old copy would otherwise come back on the next read of a deleted key.
      if (isInstance(key)) {
        await detached(() => state.delete(key));
        legacyChecked.add(key.stateKey);
      }
    },
  } as PluginStateClient;
};
