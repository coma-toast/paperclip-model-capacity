import type { PluginContext } from "@paperclipai/plugin-sdk";

import { RECENT_ALERTS_MAX } from "./constants.js";
import type { Store } from "./state/store.js";
import type { AlertEvent, AlertKind } from "./types.js";

// Kinds decide() reports every cycle while the condition holds; one missing from a cycle has cleared.
export const LEVEL_KINDS: readonly AlertKind[] = ["overLimit", "waitedTooLong"];

const TITLES: Readonly<Record<AlertKind, string>> = {
  hostDown: "Host down",
  hostUp: "Host up",
  waitedTooLong: "Task waiting too long",
  overLimit: "Pool over its limit",
  overrideRestoreFailed: "Model override not restored",
  quotaExhausted: "Quota exhausted",
  pluginError: "Model capacity plugin error",
};

export const alertKey = (e: Pick<AlertEvent, "kind" | "subject">) => `${e.kind}:${e.subject}`;

// Alert text is built from names and counts only, never URLs, headers or task content (A5, E7).
export const alertText = (e: AlertEvent) => `${e.state === "start" ? "⚠️" : "✅"} ${TITLES[e.kind]}${e.state === "clear" ? " (cleared)" : ""}: ${e.message}`;

export interface AlerterDeps {
  ctx: PluginContext;
  store: Store;
  // The company's standing alert task (company config `alertIssueId`).
  alertIssueId?: (companyId: string) => Promise<string | undefined>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const createAlerter = ({ ctx, store, alertIssueId = async () => undefined }: AlerterDeps) => {
  // An instance-wide alert (a host, an instance pool) goes to every company's channels.
  const companiesFor = async (e: AlertEvent) => (e.companyId ? [e.companyId] : (await ctx.companies.list({ limit: 200 })).map((c) => c.id));

  const deliver = async (e: AlertEvent) => {
    const text = alertText(e);
    for (const companyId of await companiesFor(e)) {
      try {
        await ctx.activity.log({ companyId, message: text, metadata: { kind: e.kind, subject: e.subject, state: e.state, poolId: e.poolId } });
        const issueId = await alertIssueId(companyId);
        if (!issueId) continue;
        const issue = await ctx.issues.get(issueId, companyId);
        // A comment on an assigned task would wake its assignee (G2), so skip it and say why.
        if (!issue || issue.assigneeAgentId || issue.assigneeUserId) {
          ctx.logger.warn("Alert task is missing or assigned; not commenting", { companyId, issueId });
          continue;
        }
        await ctx.issues.createComment(issueId, text, companyId);
      } catch (err) {
        ctx.logger.warn("Alert delivery failed", { companyId, kind: e.kind, error: errText(err) });
      }
    }
  };

  // Applies start/clear events with dedupe (G3): a start for an open alert or a clear for a closed one does nothing.
  const apply = async (events: AlertEvent[]) => {
    const state = await store.alerts.get();
    const fired: AlertEvent[] = [];
    for (const e of events) {
      const key = alertKey(e);
      if (e.state === "start" && !state.active[key]) state.active[key] = e;
      else if (e.state === "clear" && state.active[key]) delete state.active[key];
      else continue;
      fired.push(e);
    }
    if (!fired.length) return [];
    state.recent = [...state.recent, ...fired].slice(-RECENT_ALERTS_MAX);
    await store.alerts.set(state);
    for (const e of fired) await deliver(e);
    return fired;
  };

  // For level kinds: the current start events open alerts, and open ones absent this cycle clear.
  const sync = async (kinds: readonly AlertKind[], current: AlertEvent[], at: string) => {
    const state = await store.alerts.get();
    const seen = new Set(current.map(alertKey));
    const clears: AlertEvent[] = Object.values(state.active)
      .filter((a) => kinds.includes(a.kind) && !seen.has(alertKey(a)))
      .map((a) => ({ ...a, state: "clear", at }));
    return apply([...current.filter((e) => kinds.includes(e.kind)), ...clears]);
  };

  return { apply, sync };
};

export type Alerter = ReturnType<typeof createAlerter>;
