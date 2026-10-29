import { useEffect, useState } from "react";
import { Spinner, usePluginAction, usePluginData, usePluginToast, type PluginCompanySettingsPageProps } from "@paperclipai/plugin-sdk/ui";

import type { InspectHostResult } from "../api.js";
import { APIS, addPrefix, apiInfo, inferApi, poolPrefix, stripPrefix, type ApiInfo, type ApiKind } from "../apis.js";
import type { CredentialSummary } from "../auth.js";
import { patternMatches } from "../scheduler/match.js";
import type { EngineKind, HostConfig, PoolConfig } from "../types.js";
import { Button, Card, Choice, Field, MUTED, Pill, SectionTitle, inputStyle } from "./components/form.js";

type FieldError = { field: string; message: string };
type Result = { ok: boolean; error?: string; errors?: FieldError[] };

const ENGINES: { value: EngineKind; label: string }[] = [
  { value: "llamacpp", label: "llama.cpp server" },
  { value: "ollama", label: "Ollama" },
  { value: "openai", label: "OpenAI-compatible (/v1/models)" },
  { value: "vllm", label: "vLLM" },
  { value: "lmstudio", label: "LM Studio" },
];

const PLACED = /^pools\[\d+\]\.(name|id|api|prefix|hosts|limit|alertAfterMinutes|patterns|mode|privacy|endpoint\.(baseUrl|credential|slots)|hosts\[\d+\]\.(id|name|engine|baseUrl|declaredSlots|credential))$/;

// Blank pattern lines are kept while typing (so Enter starts a new line) and dropped on save.
const cleaned = (pools: PoolConfig[]) => pools.map((p) => ({ ...p, patterns: p.patterns.map((x) => x.trim()).filter(Boolean) }));

// A9: a new pool starts in observe mode.
const newPool = (n: number): PoolConfig => ({
  id: `pool-${n}`, name: `Pool ${n}`, api: "openai", patterns: [], limit: 1, privacy: "shared", mode: "observe", hosts: [], alertAfterMinutes: 30, scope: "instance",
});
const newHost = (n: number): HostConfig => ({ id: `host-${n}`, name: `Host ${n}`, engine: "llamacpp", baseUrl: "http://", declaredSlots: 1 });

const since = (iso?: string) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

// The result of "Check server": what the server says it runs, and the Paperclip runs counted on this pool.
const ServerReport = ({ report }: { report: InspectHostResult }) => {
  const { server, poolRuns, countedAt } = report;
  return (
    <div style={{ border: "1px dashed rgba(128,128,128,0.45)", borderRadius: 8, padding: 12, display: "grid", gap: 10, fontSize: 13 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone={server.up ? "ok" : "warn"}>{server.up ? "Answering" : "Not answering"}</Pill>
        <span>{server.summary}</span>
        {report.usedAuth ? <Pill>with auth</Pill> : null}
        {server.error ? <span style={{ color: "#ef4444" }}>{server.error}</span> : null}
      </div>
      {server.slots?.length ? (
        <div style={{ display: "grid", gap: 2 }}>
          <strong style={{ fontSize: 12 }}>Slots</strong>
          {server.slots.map((sl) => (
            <span key={sl.id}>Slot {sl.id}: {sl.busy ? <strong>busy</strong> : "idle"}{sl.detail ? <span style={MUTED}> · {sl.detail}</span> : null}</span>
          ))}
        </div>
      ) : null}
      {server.requests ? <span>Requests: {server.requests.running} running, {server.requests.waiting ?? 0} waiting</span> : null}
      {server.models.length ? (
        <div style={{ display: "grid", gap: 2 }}>
          <strong style={{ fontSize: 12 }}>Models</strong>
          {server.models.map((m) => (
            <span key={m.name}><code>{m.name}</code>{m.state ? <span style={MUTED}> · {m.state}</span> : null}{m.detail ? <span style={MUTED}> · {m.detail}</span> : null}</span>
          ))}
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 2 }}>
        <strong style={{ fontSize: 12 }}>Paperclip runs counted on this pool{countedAt ? ` (as of ${new Date(countedAt).toLocaleTimeString()})` : ""}</strong>
        {poolRuns.length === 0 ? <span style={MUTED}>None. Save the pool first if you just created it.</span> : poolRuns.map((r) => (
          <span key={r.runId}>
            {r.agentName ?? "Agent"} · {r.issueIdentifier ?? "no task"} · <code>{r.model ?? "?"}</code>
            <span style={MUTED}> · {r.status}{r.startedAt ? ` for ${since(r.startedAt)}` : ""}</span>
          </span>
        ))}
      </div>
    </div>
  );
};

// Where a credential name points: shown under an endpoint or backend so it's clear whether a key is sent.
const CredentialNote = ({ name, credentials }: { name?: string; credentials: CredentialSummary[] }) => {
  if (!name) return <span style={MUTED}>No credential: requests are sent without a key. Add one in the plugin's config (Credential 1–4) and enter its name here.</span>;
  const c = credentials.find((x) => x.name === name);
  if (!c) return <span style={{ color: "#ef4444", fontSize: 12 }}>No credential named “{name}” in the plugin's config (Credential 1–4).</span>;
  return <span style={MUTED}>Sends <code>{c.header}: {c.scheme ? `${c.scheme} ` : ""}{c.hasToken ? "••••" : "(no token yet)"}</code> from {c.slot.replace("credential", "Credential ")}.</span>;
};

const CredentialInput = ({ value, credentials, onChange }: { value?: string; credentials: CredentialSummary[]; onChange: (v: string | undefined) => void }) => (
  <select style={inputStyle} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
    <option value="">None</option>
    {credentials.map((c) => <option key={c.slot} value={c.name}>{c.name}</option>)}
    {value && !credentials.some((c) => c.name === value) ? <option value={value}>{value} (not set up)</option> : null}
  </select>
);

// "Load models": lists what the pool's API offers; ticking a model adds it to the pool (exact name), unticking removes it.
const ModelPicker = ({ pool, api, prefix, companyId, onChange }: { pool: PoolConfig; api: ApiInfo; prefix: string; companyId: string; onChange: (p: Partial<PoolConfig>) => void }) => {
  const list = usePluginAction("list-api-models");
  const [models, setModels] = useState<string[] | null>(null);
  const [source, setSource] = useState("");
  const [problem, setProblem] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const load = async () => {
    setLoading(true);
    setProblem(undefined);
    const r = (await list({ companyId, pool: { api: api.kind, patterns: pool.patterns, endpoint: pool.endpoint } }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok: boolean; error?: string; models?: string[]; source?: string };
    setLoading(false);
    if (r.ok) {
      setModels(r.models ?? []);
      setSource(r.source ?? "");
    } else setProblem(r.error ?? "Couldn't load models");
  };
  const lines = pool.patterns.filter((p) => p.trim());
  const full = (id: string) => addPrefix(prefix, id);
  const toggle = (id: string) => {
    const name = full(id);
    onChange({ patterns: lines.includes(name) ? lines.filter((p) => p !== name) : [...lines, name] });
  };
  const shown = (models ?? []).filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
  if (api.listing === "none") return null;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : models ? "Reload models" : `Load models from ${api.label}`}</Button>
        {models ? <Button onClick={() => setModels(null)}>Hide list</Button> : null}
        {problem ? <span style={{ color: "#ef4444", fontSize: 12 }}>{problem}</span> : null}
      </div>
      {models ? (
        <div style={{ border: "1px dashed rgba(128,128,128,0.45)", borderRadius: 8, padding: 10, display: "grid", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input style={{ ...inputStyle, maxWidth: 280 }} placeholder="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span style={MUTED}>{shown.length} of {models.length} from {source}</span>
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto", display: "grid", gap: 2 }}>
            {shown.map((id) => {
              const exact = lines.includes(full(id));
              const covered = !exact && lines.some((p) => patternMatches(p, full(id)));
              return (
                <label key={id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={exact || covered} disabled={covered} onChange={() => toggle(id)} />
                  <code>{id}</code>
                  {covered ? <span style={MUTED}>already covered by a wildcard line</span> : null}
                </label>
              );
            })}
            {shown.length === 0 ? <span style={MUTED}>No models match.</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const HostRow = ({ host, poolId, companyId, credentials, error, onChange, onRemove }: { host: HostConfig; poolId: string; companyId: string; credentials: CredentialSummary[]; error: (f: string) => string | undefined; onChange: (p: Partial<HostConfig>) => void; onRemove: () => void }) => {
  const inspect = usePluginAction("inspect-host");
  const [report, setReport] = useState<InspectHostResult | null>(null);
  const [problem, setProblem] = useState<string>();
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    setProblem(undefined);
    const r = (await inspect({ host, poolId, companyId }).catch((e: Error) => ({ ok: false, error: e.message }))) as InspectHostResult | { ok: false; error?: string };
    setChecking(false);
    if (r.ok) setReport(r);
    else {
      setReport(null);
      setProblem(r.error ?? "Couldn't check the server");
    }
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "0.9fr 1.2fr 1.5fr 2fr 0.6fr 1.1fr auto auto", gap: 8, alignItems: "start" }}>
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
        <Field label="Credential" error={error("credential")}><CredentialInput value={host.credential} credentials={credentials} onChange={(credential) => onChange({ credential })} /></Field>
        <div style={{ paddingTop: 20 }}><Button onClick={() => void check()} disabled={checking}>{checking ? "Checking…" : "Check server"}</Button></div>
        <div style={{ paddingTop: 20 }}><Button kind="danger" onClick={onRemove}>Remove</Button></div>
      </div>
      <CredentialNote name={host.credential} credentials={credentials} />
      {problem ? <span style={{ color: "#ef4444", fontSize: 12 }}>{problem}</span> : null}
      {report ? <ServerReport report={report} /> : null}
    </div>
  );
};

const PoolCard = ({ pool, companyId, credentials, index, errorsFor, onChange, onRemove }: {
  pool: PoolConfig; companyId: string; credentials: CredentialSummary[]; index: number; errorsFor: (path: string) => string | undefined; onChange: (p: Partial<PoolConfig>) => void; onRemove: () => void;
}) => {
  const err = (f: string) => errorsFor(`pools[${index}].${f}`);
  const hostErr = (k: number) => (f: string) => errorsFor(`pools[${index}].hosts[${k}].${f}`);
  const setHost = (k: number, patch: Partial<HostConfig>) => onChange({ hosts: pool.hosts.map((h, j) => (j === k ? { ...h, ...patch } : h)) });
  const api = apiInfo(pool.api ?? inferApi(pool.patterns.filter((p) => p.trim())));
  const prefix = poolPrefix({ api: api.kind, prefix: pool.prefix });
  // Changing the prefix (or the API's suggested one) keeps the names typed and moves them under the new prefix.
  const reprefix = (next: string) => pool.patterns.map((p) => (p.trim() ? addPrefix(next, stripPrefix(prefix, p)) : p));
  const switchApi = (kind: ApiKind) => onChange({ api: kind, prefix: undefined, patterns: reprefix(apiInfo(kind).defaultPrefix) });
  const setPrefix = (next: string) => onChange({ prefix: next, patterns: reprefix(next) });
  const setEndpoint = (patch: Partial<NonNullable<PoolConfig["endpoint"]>>) => onChange({ endpoint: { ...pool.endpoint, ...patch } });
  return (
    <Card>
      <header style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 16 }}>{pool.name || pool.id || "New pool"}</strong>
        <Pill tone="ok">{api.label}</Pill>
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

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
        <Field label="API" hint={api.hint} error={err("api")}>
          <select style={inputStyle} value={api.kind} onChange={(e) => switchApi(e.target.value as ApiKind)}>
            {(["gateway", "cloud", "local", "names"] as const).map((group) => (
              <optgroup key={group} label={{ gateway: "Proxies and gateways", cloud: "Cloud APIs", local: "Local engines (checked directly)", names: "Other" }[group]}>
                {APIS.filter((a) => a.group === group).map((a) => <option key={a.kind} value={a.kind}>{a.label}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Model name prefix" hint={`How agents start this API's model names${api.defaultPrefix ? `; suggested ${api.defaultPrefix}` : ""}. Leave empty for full names.`} error={err("prefix")}>
          <input style={{ ...inputStyle, fontFamily: "ui-monospace, monospace" }} value={prefix} placeholder="none" onChange={(e) => setPrefix(e.target.value)} />
        </Field>
      </div>

      {api.group !== "names" ? (
        <div style={{ display: "grid", gridTemplateColumns: api.group === "local" ? "2fr 1fr 0.6fr" : "2fr 1fr", gap: 12 }}>
          <Field label={api.group === "local" ? "Server address" : "API address"} error={err("endpoint.baseUrl")}
            hint={api.group === "local" ? "The engine itself: the plugin checks its health and load here." : api.defaultBaseUrl ? `Leave empty for ${api.defaultBaseUrl}. Used by Load models.` : "Used by Load models; the plugin only reads from it."}>
            <input style={inputStyle} value={pool.endpoint?.baseUrl ?? ""} placeholder={api.placeholderUrl} onChange={(e) => setEndpoint({ baseUrl: e.target.value || undefined })} />
          </Field>
          <Field label="Credential" error={err("endpoint.credential")}>
            <CredentialInput value={pool.endpoint?.credential} credentials={credentials} onChange={(credential) => setEndpoint({ credential })} />
          </Field>
          {api.group === "local" ? (
            <Field label="Slots" hint="If it doesn't report them" error={err("endpoint.slots")}>
              <input style={inputStyle} type="number" min={1} value={pool.endpoint?.slots ?? 1} onChange={(e) => setEndpoint({ slots: Number(e.target.value) })} />
            </Field>
          ) : null}
          <div style={{ gridColumn: "1 / -1" }}><CredentialNote name={pool.endpoint?.credential} credentials={credentials} /></div>
        </div>
      ) : null}

      <Field label={prefix ? `Models in this pool (after ${prefix})` : "Models in this pool (full names)"} error={err("patterns")}
        hint={`One per line${prefix ? `, without the ${prefix} prefix` : ", exactly as agents name them"}. A task counts here when its model matches a line (* matches anything, ? one character). This only matches names; it changes nothing in the API.`}>
        <textarea style={{ ...inputStyle, minHeight: 64, fontFamily: "ui-monospace, monospace" }} value={pool.patterns.map((p) => stripPrefix(prefix, p)).join("\n")}
          onChange={(e) => onChange({ patterns: e.target.value.split("\n").map((line) => (line.trim() ? addPrefix(prefix, line) : line)) })} />
      </Field>
      <ModelPicker pool={pool} api={api} prefix={prefix} companyId={companyId} onChange={onChange} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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
      </div>

      {api.group === "gateway" || api.group === "names" ? <div style={{ display: "grid", gap: 8 }}>
        <SectionTitle title="Backends behind these models (read-only)" hint="Optional. The model servers this API sends these models to (for a proxy, the backends in its config). The plugin only reads their health and busy slots, so the pool stops releasing work while they are down or busy with work from outside Paperclip; Check server shows what one is running now. It never changes the API or the servers, so keep this list in step with the API's own config." />
        {pool.hosts.length === 0 ? <span style={MUTED}>No backends listed: only the limit above applies.</span> : null}
        {pool.hosts.map((h, k) => (
          <HostRow key={k} host={h} poolId={pool.id} companyId={companyId} credentials={credentials} error={hostErr(k)} onChange={(p) => setHost(k, p)} onRemove={() => onChange({ hosts: pool.hosts.filter((_, j) => j !== k) })} />
        ))}
        <div><Button onClick={() => onChange({ hosts: [...pool.hosts, newHost(pool.hosts.length + 1)] })}>+ Add backend</Button></div>
      </div> : <span style={MUTED}>
        {api.group === "local" ? `${api.label} is checked directly at the server address above, so there are no separate backends.` : `${api.label} is a cloud API, so there are no backends to watch: only the limit above applies.`}
        {pool.hosts.length ? " Remove this pool's backends or switch its API before saving." : ""}
      </span>}
    </Card>
  );
};

// H4: edit pools and their servers. Per-company settings (queue label, alert task, secret refs) are on the host's plugin config form.
export const SettingsPage = ({ context }: PluginCompanySettingsPageProps) => {
  const companyId = context.companyId;
  const config = usePluginData<{ pools: PoolConfig[]; credentials: CredentialSummary[] }>("pools-config", { companyId });
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

  if (!companyId) return <div style={{ padding: 16 }}>Pools are set per company: open a company's settings, then Model capacity.</div>;
  if (!pools) return <Spinner />;
  const dirty = JSON.stringify(cleaned(pools)) !== saved;
  const update = (i: number, patch: Partial<PoolConfig>) => setPools(pools.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const errorsFor = (path: string) => errors.find((e) => e.field === path)?.message;
  // Errors for fields shown on a card appear under the field; the rest (overflow, company lists, unknown keys) go on top.
  const unplaced = errors.filter((e) => !PLACED.test(e.field));
  const onSave = async () => {
    setSaving(true);
    const r = (await save({ companyId, pools: cleaned(pools) })) as Result;
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
          These pools apply to this company only. Each pool covers one model API: a proxy (such as LiteLLM or any OpenAI-compatible endpoint), a cloud API, or a local engine (Ollama, LM Studio, oMLX, vLLM, llama.cpp). It groups that API's models and caps how many of this company's agent runs can use them at once. A local engine is checked directly; for a proxy, the pool can also watch the backends behind it. Extra tasks wait in a queue and start in priority order when a slot frees.
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
        <PoolCard key={i} pool={p} companyId={companyId} credentials={config.data?.credentials ?? []} index={i} errorsFor={errorsFor} onChange={(patch) => update(i, patch)} onRemove={() => setPools(pools.filter((_, j) => j !== i))} />
      ))}
      {actions}
    </div>
  );
};
