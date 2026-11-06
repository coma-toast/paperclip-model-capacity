import { useState } from "react";
import { Spinner, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

import { apiInfo } from "../apis.js";
import type { BackendUsageRow, PoolSummary } from "../api.js";
import { AlertsDialog, EngineRunsDialog, PoolUsageDialog, WaitingDialog } from "./components/dialogs.js";
import { EditPoolsLink, HostDots, PoolBadges, formatWait, usePoll, usedUpLabel } from "./components/shared.js";
import { AlertBanner, PoolTiles, useNarrow } from "./components/poolTiles.js";
import { BackendUsageTable, PausedModels, SubscriptionUsage, type PausedModel } from "./components/usage.js";

interface Summary {
  pools: PoolSummary[];
  backends?: BackendUsageRow[];
  lastCycleAt?: string;
  paused?: PausedModel[];
}

// H1: one row per pool with use, queue, oldest wait, host dots and alerts (two columns of tiles on a phone); then each
// backend's spend, credits or slots.
export const DashboardWidget = ({ context }: PluginWidgetProps) => {
  const { data, loading, error, refresh } = usePluginData<Summary>("capacity-summary", { companyId: context.companyId });
  usePoll(refresh);
  // The pool whose waiting tasks or alerts are open in a dialog.
  const [open, setOpen] = useState<{ kind: "waiting" | "alerts" | "usage"; poolId: string } | null>(null);
  const [engineId, setEngineId] = useState<string | null>(null);
  // Alerts for every pool, from the banner the phone layout shows instead of per-pool alert badges.
  const [allAlerts, setAllAlerts] = useState(false);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const narrow = useNarrow(box);

  if (loading && !data) return <Spinner />;
  if (error) return <div>Model capacity: {error.message}</div>;
  // A company that hasn't set up pools isn't using the plugin, so the widget stays out of its dashboard.
  if (!data?.pools.length) return null;
  const openPool = open ? data.pools.find((p) => p.id === open.poolId) : undefined;
  // The engine whose runs are open, looked up on each poll so the list stays live.
  const engine = engineId ? data.backends?.find((b) => b.id === engineId) : undefined;

  return (
    <div ref={setBox} style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>Model capacity</strong>
        <EditPoolsLink companyPrefix={context.companyPrefix} />
      </div>
      {narrow ? (
        <>
          <AlertBanner pools={data.pools} onOpen={() => setAllAlerts(true)} />
          <PoolTiles pools={data.pools} paused={data.paused ?? []} onUsage={(poolId) => setOpen({ kind: "usage", poolId })}
            onWaiting={(poolId) => setOpen({ kind: "waiting", poolId })} />
        </>
      ) : (
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", opacity: 0.7 }}>
            <th>Pool</th><th>In use</th><th>Waiting</th><th>Oldest</th><th>Hosts</th><th />
          </tr>
        </thead>
        <tbody>
          {data.pools.map((p) => (
            <tr key={p.id}>
              <td>
                <button type="button" onClick={() => setOpen({ kind: "usage", poolId: p.id })} title="Usage and limits"
                  style={{ border: "none", background: "none", padding: 0, color: "inherit", font: "inherit", cursor: "pointer", textAlign: "left" }}>
                  {p.name} <span style={{ opacity: 0.6 }}>· {apiInfo(p.api).label}</span>
                </button>
              </td>
              <td title={`limit ${p.limit}`}>{p.inUse}/{p.available}</td>
              <td>
                {p.queued ? (
                  <button type="button" onClick={() => setOpen({ kind: "waiting", poolId: p.id })} title="Show waiting tasks and move them"
                    style={{ border: "none", background: "none", padding: 0, color: "#3b82f6", font: "inherit", cursor: "pointer", textDecoration: "underline" }}>{p.queued}</button>
                ) : 0}
              </td>
              <td>{formatWait(p.oldestWaitSeconds)}</td>
              <td><HostDots hosts={p.hosts} /></td>
              <td><PoolBadges pool={p} onAlerts={() => setOpen({ kind: "alerts", poolId: p.id })}
                pausedUntil={(data.paused ?? []).filter((x) => x.poolId === p.id && x.until).map((x) => x.until!).sort()[0]}
                usedUp={usedUpLabel((data.paused ?? []).filter((x) => x.poolId === p.id).map((x) => x.reason))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
      <PausedModels paused={data.paused ?? []} />
      <BackendUsageTable rows={data.backends ?? []} companyId={context.companyId} onRefreshed={refresh} onOpenEngine={(r) => setEngineId(r.id)} />
      {engine ? <EngineRunsDialog row={engine} companyId={context.companyId!} companyPrefix={context.companyPrefix} onClose={() => setEngineId(null)} onChanged={refresh} /> : null}
      <SubscriptionUsage companyId={context.companyId} />
      {openPool && open?.kind === "waiting" ? (
        <WaitingDialog companyId={context.companyId!} companyPrefix={context.companyPrefix} pool={openPool} pools={data.pools} onClose={() => setOpen(null)} onChanged={refresh} />
      ) : null}
      {openPool && open?.kind === "usage" ? <PoolUsageDialog companyId={context.companyId!} pool={openPool} onClose={() => setOpen(null)} /> : null}
      {allAlerts ? (
        <AlertsDialog companyId={context.companyId!} companyPrefix={context.companyPrefix} pools={data.pools} onClose={() => setAllAlerts(false)} onChanged={refresh} />
      ) : null}
      {openPool && open?.kind === "alerts" ? (
        <AlertsDialog companyId={context.companyId!} companyPrefix={context.companyPrefix} pool={openPool} pools={data.pools} onClose={() => setOpen(null)} onChanged={refresh} />
      ) : null}
    </div>
  );
};
