import { useEffect, useState } from "react";
import { Spinner, usePluginAction, usePluginData, usePluginToast, type PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";

import type { EngineKind, HostConfig, PoolConfig } from "../types.js";
import { ErrorList } from "./components/shared.js";

const ENGINES: EngineKind[] = ["llamacpp", "ollama", "openai", "vllm", "lmstudio"];
type Result = { ok: boolean; error?: string; errors?: { field: string; message: string }[] };

// A9: a new pool starts in observe mode.
const newPool = (n: number): PoolConfig => ({
  id: `pool-${n}`, name: `Pool ${n}`, patterns: [], limit: 1, privacy: "shared", mode: "observe", scope: "instance", hosts: [], alertAfterMinutes: 30,
});
const newHost = (n: number): HostConfig => ({ id: `host-${n}`, name: `Host ${n}`, engine: "llamacpp", baseUrl: "http://", declaredSlots: 1 });

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label style={{ display: "grid", gap: 2, fontSize: 13 }}>{label}{children}</label>
);

// H4: edit pools and hosts. Per-company settings (label, alert task, secret refs) are on the host's plugin config form.
export const SettingsPage = (_props: PluginSettingsPageProps) => {
  const config = usePluginData<{ pools: PoolConfig[] }>("pools-config");
  const save = usePluginAction("save-pools");
  const toast = usePluginToast();
  const [pools, setPools] = useState<PoolConfig[] | null>(null);
  const [errors, setErrors] = useState<Result["errors"]>();
  useEffect(() => {
    if (config.data && pools === null) setPools(config.data.pools);
  }, [config.data, pools]);

  if (!pools) return <Spinner />;
  const update = (i: number, patch: Partial<PoolConfig>) => setPools(pools.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const updateHost = (i: number, k: number, patch: Partial<HostConfig>) =>
    update(i, { hosts: pools[i].hosts.map((h, j) => (j === k ? { ...h, ...patch } : h)) });
  const onSave = async () => {
    const r = (await save({ pools })) as Result;
    setErrors(r.errors);
    toast(r.ok ? { title: "Pools saved", tone: "success" } : { title: r.error ?? "Fix the highlighted settings", tone: "error" });
    if (r.ok) config.refresh();
  };

  return (
    <div style={{ display: "grid", gap: 16, padding: 16, maxWidth: 900 }}>
      <p style={{ margin: 0 }}>
        Pools cap concurrent agent runs per model. New pools start in <strong>observe</strong> mode: the plugin records what it would do and
        changes no task until you switch the pool to <strong>enforce</strong>.
      </p>
      <ErrorList errors={errors} />
      {pools.map((p, i) => (
        <fieldset key={i} style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(4, 1fr)" }}>
          <legend>{p.name || p.id}</legend>
          <Field label="Id"><input value={p.id} onChange={(e) => update(i, { id: e.target.value })} /></Field>
          <Field label="Name"><input value={p.name} onChange={(e) => update(i, { name: e.target.value })} /></Field>
          <Field label="Model patterns (comma separated, * and ?)">
            <input value={p.patterns.join(", ")} onChange={(e) => update(i, { patterns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
          </Field>
          <Field label="Limit (concurrent runs)"><input type="number" min={0} value={p.limit} onChange={(e) => update(i, { limit: Number(e.target.value) })} /></Field>
          <Field label="Privacy">
            <select value={p.privacy} onChange={(e) => update(i, { privacy: e.target.value as PoolConfig["privacy"] })}>
              <option value="private">private</option><option value="shared">shared</option>
            </select>
          </Field>
          <Field label="Mode">
            <select value={p.mode} onChange={(e) => update(i, { mode: e.target.value as PoolConfig["mode"] })}>
              <option value="observe">observe</option><option value="enforce">enforce</option>
            </select>
          </Field>
          <Field label="Scope">
            <select value={p.scope} onChange={(e) => update(i, { scope: e.target.value as PoolConfig["scope"] })}>
              <option value="instance">instance (one limit)</option><option value="company">company (limit per company)</option>
            </select>
          </Field>
          <Field label="Alert after (minutes waiting)">
            <input type="number" min={1} value={p.alertAfterMinutes} onChange={(e) => update(i, { alertAfterMinutes: Number(e.target.value) })} />
          </Field>
          <div style={{ gridColumn: "1 / -1", display: "grid", gap: 6 }}>
            <strong style={{ fontSize: 13 }}>Hosts (optional; without hosts the pool is limited by its limit only)</strong>
            {p.hosts.map((h, k) => (
              <div key={k} style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr 1fr 1fr 2fr 80px auto" }}>
                <input aria-label="Host id" value={h.id} onChange={(e) => updateHost(i, k, { id: e.target.value })} />
                <input aria-label="Host name" value={h.name} onChange={(e) => updateHost(i, k, { name: e.target.value })} />
                <select aria-label="Engine" value={h.engine} onChange={(e) => updateHost(i, k, { engine: e.target.value as EngineKind })}>
                  {ENGINES.map((en) => <option key={en} value={en}>{en}</option>)}
                </select>
                <input aria-label="Base URL" value={h.baseUrl} onChange={(e) => updateHost(i, k, { baseUrl: e.target.value })} />
                <input aria-label="Slots" type="number" min={1} value={h.declaredSlots} onChange={(e) => updateHost(i, k, { declaredSlots: Number(e.target.value) })} />
                <button onClick={() => update(i, { hosts: p.hosts.filter((_, j) => j !== k) })}>Remove</button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => update(i, { hosts: [...p.hosts, newHost(p.hosts.length + 1)] })}>Add host</button>
              <button onClick={() => setPools(pools.filter((_, j) => j !== i))}>Remove pool</button>
            </div>
          </div>
        </fieldset>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setPools([...pools, newPool(pools.length + 1)])}>Add pool</button>
        <button onClick={() => void onSave()}><strong>Save</strong></button>
      </div>
    </div>
  );
};
