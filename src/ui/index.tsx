import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
  lastCycleAt?: string;
  lastError?: string;
};

// Placeholder until the capacity widget (P1.11): shows that the worker is cycling.
export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");

  if (loading) return <div>Loading plugin health...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>Model capacity</strong>
      <div>Last cycle: {data?.lastCycleAt ?? "not yet"}</div>
      {data?.lastError ? <div>Last error: {data.lastError}</div> : null}
    </div>
  );
}
