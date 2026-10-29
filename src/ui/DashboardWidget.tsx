import { Spinner, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

import { apiInfo } from "../apis.js";
import type { PoolSummary } from "../api.js";
import { EditPoolsLink, HostDots, PoolBadges, formatWait, usePoll } from "./components/shared.js";

interface Summary {
  pools: PoolSummary[];
  lastCycleAt?: string;
}

// H1: one row per pool with use, queue, oldest wait, host dots and alerts.
export const DashboardWidget = ({ context }: PluginWidgetProps) => {
  const { data, loading, error, refresh } = usePluginData<Summary>("capacity-summary", { companyId: context.companyId });
  usePoll(refresh);

  if (loading && !data) return <Spinner />;
  if (error) return <div>Model capacity: {error.message}</div>;
  // A company that hasn't set up pools isn't using the plugin, so the widget stays out of its dashboard.
  if (!data?.pools.length) return null;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>Model capacity</strong>
        <EditPoolsLink companyPrefix={context.companyPrefix} />
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", opacity: 0.7 }}>
            <th>Pool</th><th>In use</th><th>Waiting</th><th>Oldest</th><th>Hosts</th><th />
          </tr>
        </thead>
        <tbody>
          {data.pools.map((p) => (
            <tr key={p.id}>
              <td>{p.name} <span style={{ opacity: 0.6 }}>· {apiInfo(p.api).label}</span></td>
              <td title={`limit ${p.limit}`}>{p.inUse}/{p.available}</td>
              <td>{p.queued}</td>
              <td>{formatWait(p.oldestWaitSeconds)}</td>
              <td><HostDots hosts={p.hosts} /></td>
              <td><PoolBadges pool={p} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
