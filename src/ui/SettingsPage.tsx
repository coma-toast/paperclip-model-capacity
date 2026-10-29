import { useEffect, useState } from "react";
import { Spinner, usePluginAction, usePluginData, usePluginToast, type PluginCompanySettingsPageProps } from "@paperclipai/plugin-sdk/ui";

import type { AgentModelUse } from "../agentModels.js";
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

// Pools set up from what the agents already run: each agent's model, grouped by API prefix. Host-level provider
// settings (addresses, keys in the server's env) aren't visible to plugins, so those are set on the pool once.
const AgentModelsPanel = ({ uses, pools, onAdd, onNewPool }: {
  uses: AgentModelUse[]; pools: PoolConfig[]; onAdd: (poolIndex: number, model: string) => void; onNewPool: (group: AgentModelUse[]) => void;
}) => {
  if (!uses.length) return null;
  const coveredBy = (model: string) => pools.find((p) => p.patterns.some((pt) => pt.trim() && patternMatches(pt.trim(), model)));
  const uncovered = uses.filter((u) => !coveredBy(u.model));
  const groups = [...new Set(uncovered.map((u) => u.prefix))].map((prefix) => uncovered.filter((u) => u.prefix === prefix));
  return (
    <Card>
      <SectionTitle title="Models your agents use" hint="From each agent's model setting in this company. Models not in any pool aren't limited. Add them to a pool, or start a pool from them. Paperclip doesn't share the server's own provider settings (addresses and keys in its environment) with plugins, so set a pool's address and credential once." />
      <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
        {uses.map((u) => {
          const pool = coveredBy(u.model);
          const targets = pools.map((p, i) => ({ p, i })).filter(({ p }) => poolPrefix({ api: p.api ?? inferApi(p.patterns), prefix: p.prefix }) === u.prefix);
          return (
            <div key={u.model} style={{ display: "grid", gridTemplateColumns: "2.2fr 1fr 1.6fr", gap: 8, alignItems: "center" }}>
              <code>{u.model}</code>
              <span style={MUTED} title={u.agents.join(", ")}>{u.agents.length} agent{u.agents.length === 1 ? "" : "s"}</span>
              {pool ? <span style={MUTED}>in {pool.name}</span> : (
                <select style={inputStyle} value="" onChange={(e) => (e.target.value === "new" ? onNewPool([u]) : onAdd(Number(e.target.value), u.model))}>
                  <option value="">Not in a pool: add to…</option>
                  {targets.map(({ p, i }) => <option key={i} value={i}>{p.name}</option>)}
                  <option value="new">New pool</option>
                </select>
              )}
            </div>
          );
        })}
      </div>
      {groups.length ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {groups.map((g) => (
            <Button key={g[0].prefix || "none"} onClick={() => onNewPool(g)}>
              New {apiInfo(g[0].api).label} pool with {g.length} unpooled model{g.length === 1 ? "" : "s"}{g[0].prefix ? ` (${g[0].prefix}…)` : ""}
            </Button>
          ))}
        </div>
      ) : <span style={MUTED}>Every agent model is in a pool.</span>}
    </Card>
  );
};

// A pool started from agents' models: API from the prefix, the address an agent's config had (if any), observe mode.
const poolFromAgents = (group: AgentModelUse[], taken: PoolConfig[]): PoolConfig => {
  const first = group[0];
  const info = apiInfo(first.api);
  const base = (first.prefix.replace(/\/$/, "") || "models").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  let id = base;
  for (let n = 2; taken.some((p) => p.id === id); n++) id = `${base}-${n}`;
  return {
    id, name: `${info.label}${first.prefix ? ` (${first.prefix})` : ""}${id === base ? "" : ` ${id.slice(base.length + 1)}`}`,
    api: first.api, prefix: first.prefix === info.defaultPrefix ? undefined : first.prefix,
    endpoint: group.find((u) => u.baseUrl) ? { baseUrl: group.find((u) => u.baseUrl)!.baseUrl } : undefined,
    patterns: group.map((u) => u.model), limit: 1, privacy: info.group === "cloud" ? "shared" : "private", mode: "observe", hosts: [], alertAfterMinutes: 30, scope: "instance",
  };
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
// The pool's models are picked from the list its endpoint returns (plus models already in the pool and the agents'
// models with this prefix); nothing is typed. A model already in another pool can't be ticked, so no model is in two.
interface PickerRow {
  id: string;
  full: string;
  onEndpoint: boolean;
  agents: number;
  otherPool?: string;
}

const isWildcard = (pattern: string) => /[*?]/.test(pattern);

const ModelPicker = ({ pool, api, prefix, companyId, uses, otherPools, error, onChange }: {
  pool: PoolConfig; api: ApiInfo; prefix: string; companyId: string; uses: AgentModelUse[]; otherPools: PoolConfig[]; error?: string; onChange: (p: Partial<PoolConfig>) => void;
}) => {
  const list = usePluginAction("list-api-models");
  const [models, setModels] = useState<string[] | null>(null);
  const [source, setSource] = useState("");
  const [problem, setProblem] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const loadKey = `${api.kind}|${pool.endpoint?.baseUrl ?? ""}|${pool.endpoint?.credential ?? ""}`;
  const load = async () => {
    if (api.listing === "none") return setModels([]);
    setLoading(true);
    setProblem(undefined);
    const r = (await list({ companyId, pool: { api: api.kind, patterns: pool.patterns, endpoint: pool.endpoint } }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok: boolean; error?: string; models?: string[]; source?: string };
    setLoading(false);
    if (r.ok) {
      setModels(r.models ?? []);
      setSource(r.source ?? "");
    } else {
      setModels([]);
      setProblem(r.error ?? "Couldn't load models");
    }
  };
  useEffect(() => {
    void load();
  }, [loadKey]);

  const selected = pool.patterns.map((p) => p.trim()).filter(Boolean);
  const candidates = [...new Set([
    ...(models ?? []).map((id) => addPrefix(prefix, id)),
    ...uses.filter((u) => u.prefix === prefix).map((u) => u.model),
    ...selected.filter((p) => !isWildcard(p)),
  ])];
  // Wildcard lines from before are replaced, once, by the models they match today.
  useEffect(() => {
    if (models === null) return;
    const wild = selected.filter(isWildcard);
    if (!wild.length) return;
    const matched = candidates.filter((m) => wild.some((w) => patternMatches(w, m)));
    onChange({ patterns: [...new Set([...selected.filter((p) => !isWildcard(p)), ...matched])] });
    setExpanded(`Replaced ${wild.join(", ")} with the ${matched.length} model${matched.length === 1 ? "" : "s"} ${wild.length === 1 ? "it matches" : "they match"} now.`);
  }, [models]);

  const endpointSet = new Set((models ?? []).map((id) => addPrefix(prefix, id)));
  const rows: PickerRow[] = candidates.map((full) => ({
    id: stripPrefix(prefix, full), full, onEndpoint: endpointSet.has(full),
    agents: uses.find((u) => u.model === full)?.agents.length ?? 0,
    otherPool: otherPools.find((p) => p.patterns.some((pt) => pt.trim() && patternMatches(pt.trim(), full)))?.name,
  })).sort((a, b) => Number(selected.includes(b.full)) - Number(selected.includes(a.full)) || b.agents - a.agents || a.id.localeCompare(b.id));
  const shown = rows.filter((r) => r.id.toLowerCase().includes(filter.toLowerCase()) && (!selectedOnly || selected.includes(r.full)));
  const toggle = (full: string) => onChange({ patterns: selected.includes(full) ? selected.filter((p) => p !== full) : [...selected, full] });
  const cols = "28px minmax(0, 1fr) 90px 150px";

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input style={{ ...inputStyle, maxWidth: 240 }} placeholder={`Filter ${rows.length} models`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={selectedOnly} onChange={(e) => setSelectedOnly(e.target.checked)} /> In pool only
        </label>
        <span style={{ flex: 1 }} />
        <span style={MUTED}>{selected.filter((p) => !isWildcard(p)).length} in pool</span>
        {api.listing !== "none" ? <Button onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Reload"}</Button> : null}
      </div>
      {problem ? <span style={{ color: "#ef4444", fontSize: 12 }}>{problem} Showing models already in the pool and your agents' models.</span> : null}
      {expanded ? <span style={{ ...MUTED, color: "#eab308" }}>{expanded} Save to keep it.</span> : null}
      {error ? <span style={{ color: "#ef4444", fontSize: 12 }}>{error}</span> : null}
      <div style={{ border: "1px solid rgba(128,128,128,0.45)", borderRadius: 8, fontSize: 13, maxHeight: 280, overflowY: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: cols, gap: 8, padding: "6px 10px", position: "sticky", top: 0, background: "rgba(128,128,128,0.12)", backdropFilter: "blur(6px)" }}>
          <span /><span style={MUTED}>{prefix ? `Model (after ${prefix})` : "Model"}</span><span style={MUTED}>Agents</span><span style={MUTED}>Note</span>
        </div>
        {shown.map((r) => {
          const inPool = selected.includes(r.full);
          const blocked = !inPool && Boolean(r.otherPool);
          return (
            <label key={r.full} style={{ display: "grid", gridTemplateColumns: cols, gap: 8, padding: "5px 10px", alignItems: "center", cursor: blocked ? "default" : "pointer", opacity: blocked ? 0.55 : 1 }}>
              <input type="checkbox" checked={inPool} disabled={blocked} onChange={() => toggle(r.full)} />
              <code style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{r.id}</code>
              <span style={MUTED}>{r.agents ? `${r.agents} agent${r.agents === 1 ? "" : "s"}` : "none"}</span>
              <span style={{ ...MUTED, color: !r.onEndpoint && models && api.listing !== "none" ? "#eab308" : undefined }}>
                {blocked ? `in ${r.otherPool}` : !r.onEndpoint && models?.length && api.listing !== "none" ? "not on endpoint" : ""}
              </span>
            </label>
          );
        })}
        {loading && !rows.length ? <div style={{ padding: 10, ...MUTED }}>Loading models…</div> : null}
        {!loading && !shown.length ? <div style={{ padding: 10, ...MUTED }}>{rows.length ? "No models match." : api.listing === "none" ? "No agents use a model with this prefix yet." : "The endpoint returned no models."}</div> : null}
      </div>
      {source ? <span style={MUTED}>From {source}.</span> : null}
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

const PoolCard = ({ pool, companyId, credentials, uses, otherPools, index, errorsFor, onChange, onRemove }: {
  pool: PoolConfig; companyId: string; credentials: CredentialSummary[]; uses: AgentModelUse[]; otherPools: PoolConfig[]; index: number; errorsFor: (path: string) => string | undefined; onChange: (p: Partial<PoolConfig>) => void; onRemove: () => void;
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

      <div style={{ display: "grid", gap: 6 }}>
        <SectionTitle title="Models in this pool" hint="Tick the models this pool covers. A task counts here when its model is one of them. This changes nothing in the API." />
        <ModelPicker pool={pool} api={api} prefix={prefix} companyId={companyId} uses={uses} otherPools={otherPools} error={err("patterns")} onChange={onChange} />
      </div>

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
  const agentModels = usePluginData<{ uses: AgentModelUse[] }>("agent-models", { companyId });
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
  // Functional update: several pool cards can change in the same render (e.g. wildcard expansion on load).
  const update = (i: number, patch: Partial<PoolConfig>) => setPools((prev) => (prev ?? []).map((p, j) => (j === i ? { ...p, ...patch } : p)));
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
      <AgentModelsPanel uses={agentModels.data?.uses ?? []} pools={pools}
        onAdd={(i, model) => update(i, { patterns: [...pools[i].patterns.filter((p) => p.trim()), model] })}
        onNewPool={(group) => setPools([...pools, poolFromAgents(group, pools)])} />
      {pools.length === 0 ? <span style={MUTED}>No pools yet. Start one from your agents' models above, or add one.</span> : null}
      {pools.map((p, i) => (
        <PoolCard key={i} pool={p} companyId={companyId} credentials={config.data?.credentials ?? []} uses={agentModels.data?.uses ?? []} otherPools={pools.filter((_, j) => j !== i)} index={i} errorsFor={errorsFor} onChange={(patch) => update(i, patch)} onRemove={() => setPools(pools.filter((_, j) => j !== i))} />
      ))}
      {actions}
    </div>
  );
};
