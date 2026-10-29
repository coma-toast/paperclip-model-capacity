import { useEffect, useState } from "react";
import { Spinner, usePluginAction, usePluginData, usePluginToast, type PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";

import type { EngineKind, HostConfig, PoolConfig } from "../types.js";
import { Button, Card, Choice, Field, MUTED, Pill, SectionTitle, inputStyle } from "./components/form.js";

type FieldError = { field: string; message: string };
type Result = { ok: boolean; error?: string; errors?: FieldError[] };

const ENGINES: { value: EngineKind; label: string }[] = [
  { value: "llamacpp", label: "llama.cpp server" },
  { value: "ollama", label: "Ollama" },
  { value: "openai", label: "OpenAI-compatible (LiteLLM, oMLX…)" },
  { value: "vllm", label: "vLLM" },
  { value: "lmstudio", label: "LM Studio" },
];

const PLACED = /^pools\[\d+\]\.(name|id|limit|alertAfterMinutes|patterns|mode|privacy|scope|hosts\[\d+\]\.(id|name|engine|baseUrl|declaredSlots))$/;

// Blank pattern lines are kept while typing (so Enter starts a new line) and dropped on save.
const cleaned = (pools: PoolConfig[]) => pools.map((p) => ({ ...p, patterns: p.patterns.map((x) => x.trim()).filter(Boolean) }));

// A9: a new pool starts in observe mode.
const newPool = (n: number): PoolConfig => ({
  id: `pool-${n}`, name: `Pool ${n}`, patterns: [], limit: 1, privacy: "shared", mode: "observe", scope: "instance", hosts: [], alertAfterMinutes: 30,
});
const newHost = (n: number): HostConfig => ({ id: `host-${n}`, name: `Host ${n}`, engine: "llamacpp", baseUrl: "http://", declaredSlots: 1 });

const HostRow = ({ host, error, onChange, onRemove }: { host: HostConfig; error: (f: string) => string | undefined; onChange: (p: Partial<HostConfig>) => void; onRemove: () => void }) => (
  <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 1.6fr 2.2fr 0.6fr auto", gap: 8, alignItems: "start" }}>
    <Field label="Id" error={error("id")}><input style={inputStyle} value={host.id} onChange={(e) => onChange({ id: e.target.value })} /></Field>
    <Field label="Name" error={error("name")}><input style={inputStyle} value={host.name} onChange={(e) => onChange({ name: e.target.value })} /></Field>
    <Field label="Server type" error={error("engine")}>
      <select style={inputStyle} value={host.engine} onChange={(e) => onChange({ engine: e.target.value as EngineKind })}>
        {ENGINES.map((en) => <option key={en.value} value={en.value}>{en.label}</option>)}
      </select>
    </Field>
    <Field label="Address" error={error("baseUrl")}><input style={inputStyle} value={host.baseUrl} placeholder="http://host:8080" onChange={(e) => onChange({ baseUrl: e.target.value })} /></Field>
    <Field label="Slots" error={error("declaredSlots")}>
      <input style={inputStyle} type="number" min={1} value={host.declaredSlots} onChange={(e) => onChange({ declaredSlots: Number(e.target.value) })} />
    </Field>
    <div style={{ paddingTop: 20 }}><Button kind="danger" onClick={onRemove}>Remove</Button></div>
  </div>
);

const PoolCard = ({ pool, index, errorsFor, onChange, onRemove }: {
  pool: PoolConfig; index: number; errorsFor: (path: string) => string | undefined; onChange: (p: Partial<PoolConfig>) => void; onRemove: () => void;
}) => {
  const err = (f: string) => errorsFor(`pools[${index}].${f}`);
  const hostErr = (k: number) => (f: string) => errorsFor(`pools[${index}].hosts[${k}].${f}`);
  const setHost = (k: number, patch: Partial<HostConfig>) => onChange({ hosts: pool.hosts.map((h, j) => (j === k ? { ...h, ...patch } : h)) });
  return (
    <Card>
      <header style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 16 }}>{pool.name || pool.id || "New pool"}</strong>
        <Pill tone={pool.mode === "enforce" ? "warn" : "info"}>{pool.mode === "enforce" ? "Enforcing" : "Observing only"}</Pill>
        <Pill>{pool.limit} run{pool.limit === 1 ? "" : "s"} at once</Pill>
        <Pill>{pool.privacy}</Pill>
        <span style={{ flex: 1 }} />
        <Button kind="danger" onClick={onRemove}>Remove pool</Button>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 12 }}>
        <Field label="Name" error={err("name")}><input style={inputStyle} value={pool.name} onChange={(e) => onChange({ name: e.target.value })} /></Field>
        <Field label="Id" hint="Short, unique, no spaces" error={err("id")}><input style={inputStyle} value={pool.id} onChange={(e) => onChange({ id: e.target.value })} /></Field>
        <Field label="Max runs at once" hint="0 holds everything" error={err("limit")}>
          <input style={inputStyle} type="number" min={0} value={pool.limit} onChange={(e) => onChange({ limit: Number(e.target.value) })} />
        </Field>
        <Field label="Alert after waiting" hint="Minutes" error={err("alertAfterMinutes")}>
          <input style={inputStyle} type="number" min={1} value={pool.alertAfterMinutes} onChange={(e) => onChange({ alertAfterMinutes: Number(e.target.value) })} />
        </Field>
      </div>

      <Field label="Models in this pool" error={err("patterns")}
        hint="One per line. A task counts here when its model matches a line. * matches anything, ? one character. Example: litellm/pc-omo-local-*">
        <textarea style={{ ...inputStyle, minHeight: 64, fontFamily: "ui-monospace, monospace" }} value={pool.patterns.join("\n")}
          onChange={(e) => onChange({ patterns: e.target.value.split("\n") })} />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Field label="Mode" error={err("mode")}>
          <Choice value={pool.mode} onChange={(mode) => onChange({ mode })} options={[
            { value: "observe", label: "Observe", hint: "Log what it would hold; change nothing" },
            { value: "enforce", label: "Enforce", hint: "Hold and release tasks for real" },
          ]} />
        </Field>
        <Field label="Privacy" error={err("privacy")}>
          <Choice value={pool.privacy} onChange={(privacy) => onChange({ privacy })} options={[
            { value: "private", label: "Private", hint: "Never moves work to a shared pool" },
            { value: "shared", label: "Shared", hint: "Cloud or third-party models" },
          ]} />
        </Field>
        <Field label="Limit applies to" error={err("scope")}>
          <Choice value={pool.scope} onChange={(scope) => onChange({ scope })} options={[
            { value: "instance", label: "All companies", hint: "One limit shared by everyone" },
            { value: "company", label: "Each company", hint: "Every company gets its own limit" },
          ]} />
        </Field>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <SectionTitle title="Model servers" hint="Optional. With servers listed, the pool also stops releasing work when they are down or busy with work from outside Paperclip." />
        {pool.hosts.length === 0 ? <span style={MUTED}>No servers: only the limit above applies.</span> : null}
        {pool.hosts.map((h, k) => (
          <HostRow key={k} host={h} error={hostErr(k)} onChange={(p) => setHost(k, p)} onRemove={() => onChange({ hosts: pool.hosts.filter((_, j) => j !== k) })} />
        ))}
        <div><Button onClick={() => onChange({ hosts: [...pool.hosts, newHost(pool.hosts.length + 1)] })}>+ Add server</Button></div>
      </div>
    </Card>
  );
};

// H4: edit pools and their servers. Per-company settings (queue label, alert task, secret refs) are on the host's plugin config form.
export const SettingsPage = (_props: PluginSettingsPageProps) => {
  const config = usePluginData<{ pools: PoolConfig[] }>("pools-config");
  const save = usePluginAction("save-pools");
  const toast = usePluginToast();
  const [pools, setPools] = useState<PoolConfig[] | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (config.data && pools === null) {
      setPools(config.data.pools);
      setSaved(JSON.stringify(config.data.pools));
    }
  }, [config.data, pools]);

  if (!pools) return <Spinner />;
  const dirty = JSON.stringify(cleaned(pools)) !== saved;
  const update = (i: number, patch: Partial<PoolConfig>) => setPools(pools.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const errorsFor = (path: string) => errors.find((e) => e.field === path)?.message;
  // Errors for fields shown on a card appear under the field; the rest (overflow, company lists, unknown keys) go on top.
  const unplaced = errors.filter((e) => !PLACED.test(e.field));
  const onSave = async () => {
    setSaving(true);
    const r = (await save({ pools: cleaned(pools) })) as Result;
    setSaving(false);
    setErrors(r.errors ?? []);
    if (r.ok) {
      setPools(cleaned(pools));
      setSaved(JSON.stringify(cleaned(pools)));
      config.refresh();
    }
    toast(r.ok ? { title: "Pools saved", tone: "success" } : { title: r.error ?? "Some settings need fixing (marked in red)", tone: "error" });
  };

  // Shown above and below the pools, so Save is in reach without a floating bar over the form.
  const actions = (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <Button onClick={() => setPools([...pools, newPool(pools.length + 1)])}>+ Add pool</Button>
      <span style={{ flex: 1 }} />
      <span style={MUTED}>{dirty ? "Unsaved changes" : "All changes saved"}</span>
      <Button disabled={!dirty || saving} onClick={() => { setPools(JSON.parse(saved)); setErrors([]); }}>Discard</Button>
      <Button kind="primary" disabled={!dirty || saving} onClick={() => void onSave()}>{saving ? "Saving…" : "Save changes"}</Button>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 16, padding: 16, maxWidth: 1000 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <strong style={{ fontSize: 18 }}>Model capacity pools</strong>
        <span style={{ ...MUTED, fontSize: 13 }}>
          A pool caps how many agent runs can use a group of models at once. Extra tasks wait in a queue and start in priority order when a slot frees.
          New pools start in <strong>Observe</strong>: the plugin only logs what it would hold until you switch the pool to <strong>Enforce</strong>.
        </span>
      </div>
      {actions}
      {unplaced.length ? (
        <ul role="alert" style={{ color: "#ef4444", margin: 0, fontSize: 13 }}>
          {unplaced.map((e) => <li key={`${e.field}:${e.message}`}>{e.message} <span style={MUTED}>({e.field})</span></li>)}
        </ul>
      ) : null}
      {pools.length === 0 ? <span style={MUTED}>No pools yet. Add one to start.</span> : null}
      {pools.map((p, i) => (
        <PoolCard key={i} pool={p} index={i} errorsFor={errorsFor} onChange={(patch) => update(i, patch)} onRemove={() => setPools(pools.filter((_, j) => j !== i))} />
      ))}
      {actions}
    </div>
  );
};
