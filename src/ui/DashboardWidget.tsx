import { Spinner, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

import type { PoolSummary } from "../api.js";
import { HostDots, PoolBadges, formatWait, usePoll } from "./components/shared.js";

interface Summary {
  pools: PoolSummary[];
  lastCycleAt?: string;
}

// H1: one row per pool with use, queue, oldest wait, host dots and alerts.
export const DashboardWidget = (_props: PluginWidgetProps) => {
  const { data, loading, error, refresh } = usePluginData<Summary>("capacity-summary");
  usePoll(refresh);

  if (loading && !data) return <Spinner />;
  if (error) return <div>Model capacity: {error.message}</div>;
  if (!data?.pools.length) return <div>Model capacity: no pools yet. Add them in the plugin settings.</div>;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <strong>Model capacity</strong>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", opacity: 0.7 }}>
            <th>Pool</th><th>In use</th><th>Waiting</th><th>Oldest</th><th>Hosts</th><th />
          </tr>
        </thead>
        <tbody>
          {data.pools.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
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
