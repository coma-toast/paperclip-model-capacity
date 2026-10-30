import { useState } from "react";
import { Spinner, usePluginData, usePluginToast, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";

import { MUTED, inputStyle } from "./components/form.js";
import { EditPoolsLink } from "./components/shared.js";
import { setAgentModel } from "./hostApi.js";

interface AgentPool {
  name?: string;
  model?: string;
  pools: { id: string; name: string; agentModel: string; disabled: boolean }[];
  currentPoolId?: string;
}

// The agent page's Model capacity tab: put the agent on a pool instead of a specific model. Choosing a pool points the
// agent at the pool's agent model; the pool then limits its runs and, if it pins tasks, picks the engine.
export const AgentPoolTab = ({ context }: PluginDetailTabProps) => {
  const data = usePluginData<AgentPool>("agent-pool", { companyId: context.companyId, agentId: context.entityId });
  const toast = usePluginToast();
  const [saving, setSaving] = useState(false);
  if (data.loading && !data.data) return <Spinner />;
  const info = data.data;
  if (!info) return null;
  const choose = async (poolId: string) => {
    const pool = info.pools.find((p) => p.id === poolId);
    if (!pool) return;
    setSaving(true);
    try {
      await setAgentModel(context.entityId, pool.agentModel);
      toast({ title: `${info.name ?? "Agent"} now uses ${pool.name}`, tone: "success" });
      data.refresh();
    } catch (e) {
      toast({ title: `Couldn't change the model: ${e instanceof Error ? e.message : String(e)}`, tone: "error" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: 10, padding: 16, maxWidth: 640 }}>
      <strong>Model capacity pool</strong>
      <span style={{ ...MUTED, fontSize: 13 }}>
        Put this agent on a pool instead of a specific model. The pool limits how many of its runs go at once and, if it pins tasks to engines, picks the engine for each task.
      </span>
      {info.pools.length ? (
        <select style={inputStyle} value={info.currentPoolId ?? ""} disabled={saving} onChange={(e) => void choose(e.target.value)}>
          <option value="" disabled>{info.model ? `Not on a pool (model ${info.model})` : "Not on a pool"}</option>
          {info.pools.map((p) => <option key={p.id} value={p.id}>{p.name}{p.disabled ? " (disabled)" : ""} — {p.agentModel}</option>)}
        </select>
      ) : (
        <span style={MUTED}>No pool has an agent model yet. Set one on a pool first.</span>
      )}
      {info.currentPoolId ? <span style={MUTED}>Its model is {info.model}. To leave the pool, change the agent's model in its settings.</span> : null}
      <EditPoolsLink companyPrefix={context.companyPrefix} label="Edit pools" />
    </div>
  );
};
