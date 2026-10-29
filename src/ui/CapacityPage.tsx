import { useState } from "react";
import { DataTable, MetricCard, StatusBadge, usePluginAction, usePluginData, usePluginToast, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";

import { apiInfo } from "../apis.js";
import type { PoolSummary, QueueRow } from "../api.js";
import type { HistoryEntry } from "../state/store.js";
import type { AlertEvent } from "../types.js";
import { Button, inputStyle } from "./components/form.js";
import { EditPoolsLink, HostDots, PoolBadges, formatWait, usePoll } from "./components/shared.js";

type Result = { ok: boolean; error?: string; errors?: { field: string; message: string }[] };

const describe = (e: HistoryEntry) => {
  const a = e.action;
  if (a.kind === "hold") return `hold ${a.issueId} in ${a.poolId} (position ${a.position})`;
  if (a.kind === "release") return `release ${a.issueId} from ${a.poolId}${a.reason === "manual" ? " (manual)" : ""}`;
  if (a.kind === "alert") return `alert: ${a.alert.kind} ${a.alert.subject}`;
  return a.kind;
};

// H2: pools and hosts, the queue with controls, recent alerts and today's decisions.
export const CapacityPage = ({ context }: PluginPageProps) => {
  const scope = { companyId: context.companyId };
  const summary = usePluginData<{ pools: PoolSummary[]; lastCycleAt?: string }>("capacity-summary", scope);
  const queue = usePluginData<{ rows: QueueRow[] }>("queue", scope);
  const alerts = usePluginData<{ active: AlertEvent[]; recent: AlertEvent[] }>("alerts", scope);
  const history = usePluginData<{ entries: HistoryEntry[] }>("history", scope);
  const refreshAll = () => [summary, queue, alerts, history].forEach((d) => d.refresh());
  usePoll(refreshAll);
  const toast = usePluginToast();
  const [limits, setLimits] = useState<Record<string, string>>({});
  const actions = {
    releaseNow: usePluginAction("release-now"),
    moveToFront: usePluginAction("move-to-front"),
    holdPool: usePluginAction("hold-pool"),
    resumePool: usePluginAction("resume-pool"),
    setLimit: usePluginAction("set-limit"),
  };
  const run = async (fn: () => Promise<unknown>, done: string) => {
    const r = (await fn()) as Result;
    if (r.ok) toast({ title: done, tone: "success" });
    else toast({ title: r.error ?? r.errors?.map((e) => e.message).join("; ") ?? "Failed", tone: "error" });
    refreshAll();
  };

  const pools = summary.data?.pools ?? [];
  return (
    <div style={{ display: "grid", gap: 16, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>Model capacity</h2>
        <EditPoolsLink companyPrefix={context.companyPrefix} label="Edit this company's pools" />
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <MetricCard label="Runs in use" value={pools.reduce((n, p) => n + p.inUse, 0)} />
        <MetricCard label="Waiting" value={pools.reduce((n, p) => n + p.queued, 0)} />
        <MetricCard label="Open alerts" value={alerts.data?.active.length ?? 0} />
      </div>
      {summary.data && pools.length === 0 ? <div>No pools for this company yet. <EditPoolsLink companyPrefix={context.companyPrefix} label="Set up pools" /></div> : null}

      <section>
        <h3>Pools</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", opacity: 0.7 }}>
              <th>Pool</th><th>In use</th><th>Limit</th><th>Waiting</th><th>Oldest</th><th>Hosts</th><th /><th>Controls</th>
            </tr>
          </thead>
          <tbody>
            {pools.map((p) => (
              <tr key={p.id}>
                <td>{p.name} <span style={{ opacity: 0.6 }}>· {apiInfo(p.api).label} · {p.privacy}</span></td>
                <td>{p.inUse}/{p.available}</td>
                <td>
                  <input aria-label={`${p.name} limit`} type="number" min={0} style={{ ...inputStyle, width: 64, marginRight: 6 }} value={limits[p.id] ?? String(p.limit)}
                    onChange={(e) => setLimits({ ...limits, [p.id]: e.target.value })} />
                  <Button onClick={() => void run(() => actions.setLimit({ poolId: p.id, limit: Number(limits[p.id] ?? p.limit) }), `${p.name} limit saved`)}>Set</Button>
                </td>
                <td>{p.queued}</td>
                <td>{formatWait(p.oldestWaitSeconds)}</td>
                <td><HostDots hosts={p.hosts} /></td>
                <td><PoolBadges pool={p} /></td>
                <td>
                  {p.onHold
                    ? <Button onClick={() => void run(() => actions.resumePool({ poolId: p.id }), `${p.name} resumed`)}>Resume</Button>
                    : <Button onClick={() => void run(() => actions.holdPool({ poolId: p.id }), `${p.name} on hold`)}>Hold pool</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Queue</h3>
        <DataTable
          rows={(queue.data?.rows ?? []) as unknown as Record<string, unknown>[]}
          loading={queue.loading && !queue.data}
          emptyMessage="Nothing is waiting."
          columns={[
            { key: "poolId", header: "Pool", render: (v) => pools.find((p) => p.id === v)?.name ?? String(v) },
            { key: "position", header: "#" },
            { key: "identifier", header: "Task", render: (_v, row) => { const r = row as unknown as QueueRow; return `${r.identifier ?? r.issueId}${r.title ? ` ${r.title}` : ""}`; } },
            { key: "priority", header: "Priority" },
            { key: "heldAt", header: "Waiting since", render: (v) => new Date(String(v)).toLocaleString() },
            {
              key: "issueId", header: "", render: (_v, row) => { const r = row as unknown as QueueRow; return (
                <span style={{ display: "inline-flex", gap: 4 }}>
                  <Button onClick={() => void run(() => actions.releaseNow({ issueId: r.issueId }), "Released")}>Release now</Button>
                  <Button disabled={r.position === 1} onClick={() => void run(() => actions.moveToFront({ issueId: r.issueId }), "Moved to front")}>Move to front</Button>
                </span>
              ); },
            },
          ]}
        />
      </section>

      <section>
        <h3>Alerts</h3>
        {(alerts.data?.recent ?? []).length === 0 ? <div>No alerts.</div> : (
          <ul style={{ margin: 0 }}>
            {alerts.data!.recent.slice(0, 20).map((a) => (
              <li key={`${a.kind}:${a.subject}:${a.at}:${a.state}`}>
                <StatusBadge label={a.state === "start" ? "open" : "cleared"} status={a.state === "start" ? "error" : "ok"} /> {new Date(a.at).toLocaleString()} {a.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Today's decisions</h3>
        {(history.data?.entries ?? []).length === 0 ? <div>None yet.</div> : (
          <ul style={{ margin: 0 }}>
            {history.data!.entries.slice(0, 50).map((e, i) => (
              <li key={`${e.at}:${i}`}>{new Date(e.at).toLocaleTimeString()} {describe(e)} {e.applied ? "" : <em>(observe)</em>}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
