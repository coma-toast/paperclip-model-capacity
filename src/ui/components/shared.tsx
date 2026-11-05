import { useEffect } from "react";
import { StatusBadge, useHostNavigation } from "@paperclipai/plugin-sdk/ui";

import type { PoolSummary } from "../../api.js";
import { untilText } from "./usage.js";

export const POLL_MS = 15_000;

// Polls like Aperture: refresh every 15 s while the view is open.
export const usePoll = (refresh: () => void, ms = POLL_MS) => {
  useEffect(() => {
    const timer = setInterval(refresh, ms);
    return () => clearInterval(timer);
  }, [refresh, ms]);
};

export const formatWait = (seconds: number | null) => {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

export const HostDots = ({ hosts }: { hosts: PoolSummary["hosts"] }) =>
  hosts.length ? (
    <span aria-label="hosts">
      {hosts.map((h) => (
        <span key={h.id} title={`${h.name}: ${h.up ? "up" : "down"}`} style={{ color: h.up ? "#22c55e" : "#ef4444", marginRight: 2 }}>●</span>
      ))}
    </span>
  ) : (
    <span title="No hosts: limited by the pool limit only">—</span>
  );

// What a pool's paused models ran out of, for its badge: money, a subscription's limit, or a request quota.
export const usedUpLabel = (reasons: string[]) =>
  reasons.some((r) => /subscription/i.test(r) && /used up/i.test(r)) ? "subscription limit"
    : reasons.some((r) => /credit|spend|budget|key limit/i.test(r) && /used up/i.test(r)) ? "out of credit"
      : reasons.some((r) => /requests/i.test(r) && /used up/i.test(r)) ? "requests used up"
        : undefined;

export const PoolBadges = ({ pool, onAlerts, pausedUntil, usedUp }: { pool: PoolSummary; onAlerts?: () => void; pausedUntil?: string; usedUp?: string }) => (
  <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
    {pool.mode === "observe" ? <StatusBadge label="observe" status="info" /> : null}
    {pool.disabled ? <StatusBadge label={pool.inUse ? `disabled · ${pool.inUse} draining` : "disabled · drained"} status={pool.inUse ? "pending" : "info"} /> : null}
    {pool.onHold ? <StatusBadge label="on hold" status="pending" /> : null}
    {usedUp ? <StatusBadge label={usedUp} status="error" /> : null}
    {pool.pausedModels ? <StatusBadge label={`${pool.pausedModels} paused${pausedUntil ? ` · next back in ${untilText(pausedUntil)}` : ""}`} status="pending" /> : null}
    {pool.openAlerts ? (
      onAlerts ? (
        <button type="button" onClick={onAlerts} title="Show alerts and what to do"
          style={{ border: "1px solid rgba(239, 68, 68, 0.5)", background: "rgba(239, 68, 68, 0.12)", color: "#ef4444", borderRadius: 999, padding: "1px 8px", font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
          {pool.openAlerts} alert{pool.openAlerts > 1 ? "s" : ""}
        </button>
      ) : <StatusBadge label={`${pool.openAlerts} alert${pool.openAlerts > 1 ? "s" : ""}`} status="error" />
    ) : null}
  </span>
);

export const ErrorList = ({ errors }: { errors?: { field: string; message: string }[] }) =>
  errors?.length ? (
    <ul role="alert" style={{ color: "#ef4444", margin: 0 }}>
      {errors.map((e) => <li key={`${e.field}:${e.message}`}><code>{e.field}</code>: {e.message}</li>)}
    </ul>
  ) : null;

// Pools are edited on the company settings page (manifest slot "capacity-settings", routePath "model-capacity").
export const settingsPath = (companyPrefix: string | null) => (companyPrefix ? `/${companyPrefix}/company/settings/model-capacity` : undefined);

export const EditPoolsLink = ({ companyPrefix, label = "Edit pools" }: { companyPrefix: string | null; label?: string }) => {
  const nav = useHostNavigation();
  const to = settingsPath(companyPrefix);
  return to ? <a {...nav.linkProps(to)} style={{ color: "#3b82f6", fontSize: 13 }}>{label} →</a> : null;
};
