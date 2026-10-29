import { useEffect } from "react";
import { StatusBadge } from "@paperclipai/plugin-sdk/ui";

import type { PoolSummary } from "../../api.js";

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

export const PoolBadges = ({ pool }: { pool: PoolSummary }) => (
  <span style={{ display: "inline-flex", gap: 4 }}>
    {pool.mode === "observe" ? <StatusBadge label="observe" status="info" /> : null}
    {pool.onHold ? <StatusBadge label="on hold" status="pending" /> : null}
    {pool.openAlerts ? <StatusBadge label={`${pool.openAlerts} alert${pool.openAlerts > 1 ? "s" : ""}`} status="error" /> : null}
  </span>
);

export const ErrorList = ({ errors }: { errors?: { field: string; message: string }[] }) =>
  errors?.length ? (
    <ul role="alert" style={{ color: "#ef4444", margin: 0 }}>
      {errors.map((e) => <li key={`${e.field}:${e.message}`}><code>{e.field}</code>: {e.message}</li>)}
    </ul>
  ) : null;
