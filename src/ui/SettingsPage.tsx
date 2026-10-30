import { useEffect, useState } from "react";
import { Spinner, usePluginAction, usePluginData, usePluginToast, type PluginCompanySettingsPageProps } from "@paperclipai/plugin-sdk/ui";

import type { AgentModelUse } from "../agentModels.js";
import type { InspectHostResult } from "../api.js";
import { APIS, addPrefix, apiInfo, backendFromConnection, frontsEngines, hasEndpoint, stripPrefix, type ApiKind } from "../apis.js";
import { backendPrefix, type Backend, type BackendSummary } from "../backends.js";
import { virtualModel } from "../constants.js";
import type { ListModelsResult } from "../models.js";
import type { InspectResult } from "../probes/inspect.js";
import { patternMatches } from "../scheduler/match.js";
import type { PoolConfig } from "../types.js";
import { Button, Card, Choice, Field, MUTED, Pill, SectionTitle, inputStyle } from "./components/form.js";
import { connectionKeyBinding, createCompanySecret, listAiConnections, readPluginConfig, savePluginConfig, setAgentModel, type AiConnection, type SecretBinding } from "./hostApi.js";

type FieldError = { field: string; message: string };
type Result = { ok: boolean; error?: string; errors?: FieldError[] };

const PLACED = /^pools\[\d+\]\.(name|id|backend|watch|sticky|reassignAfterMinutes|agentModel|limit|alertAfterMinutes|patterns|mode|privacy)$/;

const cleaned = (pools: PoolConfig[]) => pools.map((p) => ({ ...p, patterns: p.patterns.map((x) => x.trim()).filter(Boolean) }));

// A9: a new pool starts in observe mode.
const newPool = (n: number, backend?: BackendSummary): PoolConfig => ({
  id: `pool-${n}`, name: `Pool ${n}`, backend: backend?.id, patterns: [], limit: 1, privacy: backend && apiInfo(backend.type).group === "cloud" ? "shared" : "private",
  mode: "observe", hosts: [], alertAfterMinutes: 30, scope: "instance",
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "backend";

const upLabel = (s: Pick<InspectResult, "up" | "error">) => (s.up ? "Answering" : /returned 40[13]\b/.test(s.error ?? "") ? "Needs a key" : "Not answering");

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
        <Pill tone={server.up ? "ok" : "warn"}>{upLabel(server)}</Pill>
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
const AgentModelsPanel = ({ uses, pools, backends, onAdd, onNewPool }: {
  uses: AgentModelUse[]; pools: PoolConfig[]; backends: BackendSummary[]; onAdd: (poolIndex: number, model: string) => void; onNewPool: (group: AgentModelUse[]) => void;
}) => {
  if (!uses.length) return null;
  const coveredBy = (model: string) => pools.find((p) => p.patterns.some((pt) => pt.trim() && patternMatches(pt.trim(), model)));
  const uncovered = uses.filter((u) => !coveredBy(u.model));
  const groups = [...new Set(uncovered.map((u) => u.prefix))].map((prefix) => uncovered.filter((u) => u.prefix === prefix));
  return (
    <Card>
      <SectionTitle title="Models your agents use" hint="From each agent's model setting in this company. Models not in any pool aren't limited. Add them to a pool, or start a pool from them. Paperclip doesn't share the server's own provider settings (addresses and keys in its environment) with plugins, so add each endpoint once under Backends." />
      <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
        {uses.map((u) => {
          const pool = coveredBy(u.model);
          const targets = pools.map((p, i) => ({ p, i })).filter(({ p }) => { const b = backends.find((x) => x.id === p.backend); return (b ? backendPrefix(b) : "") === u.prefix; });
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
              New pool with {g.length} unpooled model{g.length === 1 ? "" : "s"}{g[0].prefix ? ` (${g[0].prefix}…)` : ""}
            </Button>
          ))}
        </div>
      ) : <span style={MUTED}>Every agent model is in a pool.</span>}
    </Card>
  );
};

// A pool started from agents' models, on the backend whose prefix they use (if one is set up), in observe mode.
const poolFromAgents = (group: AgentModelUse[], taken: PoolConfig[], backends: BackendSummary[]): PoolConfig => {
  const first = group[0];
  const backend = backends.find((b) => backendPrefix(b) === first.prefix);
  const base = slug(first.prefix.replace(/\/$/, "") || "models");
  let id = base;
  for (let n = 2; taken.some((p) => p.id === id); n++) id = `${base}-${n}`;
  return { ...newPool(0, backend), id, name: backend ? `${backend.name} models` : `${first.prefix || "Other"} models`, patterns: group.map((u) => u.model) };
};

// The Add/Edit backend form: asks for what the chosen type needs. Save stores a typed key as a company secret and
// writes the backend into the plugin's company config in one step; the key never goes into plugin state.
const BackendForm = ({ companyId, initial, taken, onClose, onSaved }: {
  companyId: string; initial?: BackendSummary; taken: BackendSummary[]; onClose: () => void; onSaved: () => void;
}) => {
  const test = usePluginAction("test-backend");
  const [draft, setDraft] = useState<Omit<Backend, "key">>(initial ? (({ hasKey: _h, ...rest }) => rest)(initial) : { id: "", name: "", type: "litellm" });
  const [key, setKey] = useState("");
  // A key taken from a Paperclip connection: the backend binds the connection's own secret.
  const [connectionKey, setConnectionKey] = useState<{ name: string; binding: SecretBinding }>();
  const [connections, setConnections] = useState<AiConnection[]>([]);
  useEffect(() => {
    listAiConnections(companyId).then(setConnections).catch(() => setConnections([]));
  }, [companyId]);
  const importConnection = async (id: string) => {
    const c = connections.find((x) => x.id === id);
    if (!c) return;
    const target = backendFromConnection(c);
    if ("reason" in target) return setProblem(`${c.name} is ${target.reason}.`);
    const binding = c.grantId ? await connectionKeyBinding(companyId, c.grantId).catch(() => undefined) : undefined;
    if (!binding) return setProblem(`Couldn't find ${c.name}'s key. Enter it below instead.`);
    setProblem(undefined);
    setKey("");
    setConnectionKey({ name: c.name, binding });
    set({ type: target.type, baseUrl: target.baseUrl, prefix: undefined, name: draft.name.trim() || c.name });
  };
  const [advanced, setAdvanced] = useState(Boolean(initial?.header || initial?.scheme !== undefined));
  const [result, setResult] = useState<{ models?: ListModelsResult; server?: InspectResult; error?: string } | null>(null);
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [problem, setProblem] = useState<string>();
  const info = apiInfo(draft.type);
  const set = (patch: Partial<Omit<Backend, "key">>) => { setDraft({ ...draft, ...patch }); setResult(null); };
  const needsAddress = !info.defaultBaseUrl && hasEndpoint(draft.type);

  const runTest = async () => {
    setBusy("test");
    const r = (await test({ companyId, backend: { ...draft, id: initial?.id }, key }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok: boolean; error?: string; models?: ListModelsResult; server?: InspectResult };
    setBusy("");
    setResult(r.ok ? { models: r.models, server: r.server } : { error: r.error });
  };

  const save = async () => {
    const name = draft.name.trim();
    const address = (draft.baseUrl ?? info.defaultBaseUrl).trim();
    if (!name) return setProblem("Give the backend a name.");
    if (needsAddress && !address) return setProblem(`Enter the address, e.g. ${info.placeholderUrl}.`);
    if (address && !/^https?:\/\//.test(address)) return setProblem("The address must start with http:// or https://");
    setBusy("save");
    setProblem(undefined);
    try {
      const config = await readPluginConfig(companyId);
      const current = Array.isArray(config.backends) ? (config.backends as Backend[]) : [];
      let id = initial?.id ?? slug(name);
      if (!initial) for (let n = 2; current.some((b) => b.id === id); n++) id = `${slug(name)}-${n}`;
      const previous = current.find((b) => b.id === id);
      const keyBinding = key.trim()
        ? await createCompanySecret(companyId, `Model capacity: ${name} key (${new Date().toISOString().slice(0, 16)})`, key.trim())
        : connectionKey?.binding ?? previous?.key;
      const backend: Backend = {
        id, name, type: draft.type,
        // Stored explicitly (defaults included) so the host's config form shows them too.
        ...(address ? { baseUrl: address } : {}),
        prefix: (draft.prefix ?? info.defaultPrefix).trim(),
        ...(info.group === "local" ? { slots: draft.slots ?? 1 } : {}),
        ...(advanced && draft.header?.trim() ? { header: draft.header.trim() } : {}),
        ...(advanced && draft.scheme !== undefined ? { scheme: draft.scheme } : {}),
        ...(keyBinding ? { key: keyBinding } : {}),
      };
      const backends = previous ? current.map((b) => (b.id === id ? backend : b)) : [...current, backend];
      await savePluginConfig(companyId, { ...config, backends });
      onSaved();
      onClose();
    } catch (e) {
      setProblem(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1000, overflowY: "auto", padding: "48px 16px" }}>
      <div style={{ background: "var(--background, #1c1c1c)", color: "inherit", border: "1px solid rgba(128,128,128,0.45)", borderRadius: 12, padding: 20, width: "min(640px, 100%)", display: "grid", gap: 14 }}>
        <strong style={{ fontSize: 16 }}>{initial ? `Edit ${initial.name}` : "Add a backend"}</strong>
        {connections.length ? (
          <Field label="Use a Paperclip connection" hint="Fills in the type and address and uses the connection's own key; nothing is copied.">
            <select style={inputStyle} value="" onChange={(e) => void importConnection(e.target.value)}>
              <option value="">Choose a connection…</option>
              {connections.map((c) => {
                const target = backendFromConnection(c);
                return <option key={c.id} value={c.id} disabled={"reason" in target}>{c.name}{"reason" in target ? ` (${target.reason})` : ""}</option>;
              })}
            </select>
          </Field>
        ) : null}
        <Field label="Type" hint={info.hint}>
          <select style={inputStyle} value={draft.type} onChange={(e) => set({ type: e.target.value as ApiKind, prefix: undefined, baseUrl: undefined })}>
            {(["gateway", "virtual", "cloud", "local", "names"] as const).map((group) => (
              <optgroup key={group} label={{ gateway: "Proxies and gateways", virtual: "No proxy", cloud: "Cloud APIs", local: "Local engines", names: "Other" }[group]}>
                {APIS.filter((a) => a.group === group).map((a) => <option key={a.kind} value={a.kind}>{a.label}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Name" hint="Shown on pools, e.g. Home proxy or Laptop Ollama.">
          <input style={inputStyle} value={draft.name} placeholder={info.label} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        {hasEndpoint(draft.type) ? (
          <Field label="Address" hint={info.defaultBaseUrl ? `${info.label}'s usual address; change it only for a different region or proxy.` : info.group === "local" ? "The engine itself; the plugin checks its health and load here." : "The plugin only reads from it (model list, health)."}>
            <input style={inputStyle} value={draft.baseUrl ?? info.defaultBaseUrl} placeholder={info.placeholderUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
          </Field>
        ) : null}
        {hasEndpoint(draft.type) ? (
          connectionKey ? (
            <Field label="API key" hint="Test connection runs without it; Check uses it once saved.">
              <span style={{ fontSize: 13 }}>
                Uses the key from the <strong>{connectionKey.name}</strong> connection.{" "}
                <button type="button" onClick={() => setConnectionKey(undefined)} style={{ color: "#3b82f6", cursor: "pointer" }}>Use a different key</button>
              </span>
            </Field>
          ) : (
            <Field label="API key" hint={initial?.hasKey ? "A key is saved. Leave empty to keep it, or enter a new one to replace it." : info.group === "local" ? "Usually not needed for a local engine." : "Stored as a Paperclip company secret; never shown again."}>
              <input style={inputStyle} type="password" autoComplete="off" value={key} placeholder={initial?.hasKey ? "•••••••• (saved)" : "sk-…"} onChange={(e) => { setKey(e.target.value); setResult(null); }} />
            </Field>
          )
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: info.group === "local" ? "2fr 1fr" : "1fr", gap: 12 }}>
          <Field label="Model name prefix" hint={`How agents start this backend's model names${info.defaultPrefix ? `; suggested ${info.defaultPrefix}` : ""}. Leave empty for full names.`}>
            <input style={{ ...inputStyle, fontFamily: "ui-monospace, monospace" }} value={draft.prefix ?? info.defaultPrefix} placeholder="none" onChange={(e) => set({ prefix: e.target.value })} />
          </Field>
          {info.group === "local" ? (
            <Field label="Slots" hint="Requests at once, if it doesn't report them">
              <input style={inputStyle} type="number" min={1} value={draft.slots ?? 1} onChange={(e) => set({ slots: Number(e.target.value) })} />
            </Field>
          ) : null}
        </div>
        {hasEndpoint(draft.type) ? (
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> Custom auth header
          </label>
        ) : null}
        {advanced && hasEndpoint(draft.type) ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Header" hint="Defaults to Authorization."><input style={inputStyle} value={draft.header ?? ""} placeholder="Authorization" onChange={(e) => set({ header: e.target.value })} /></Field>
            <Field label="Scheme" hint="Put before the key; empty for none."><input style={inputStyle} value={draft.scheme ?? "Bearer"} onChange={(e) => set({ scheme: e.target.value })} /></Field>
          </div>
        ) : null}
        {result ? (
          <div style={{ border: "1px dashed rgba(128,128,128,0.45)", borderRadius: 8, padding: 10, fontSize: 13, display: "grid", gap: 4 }}>
            {result.error ? <span style={{ color: "#ef4444" }}>{result.error}</span> : null}
            {result.models ? (result.models.ok
              ? <span><Pill tone="ok">Models</Pill> {result.models.models.length} found{result.models.models.length ? `: ${result.models.models.slice(0, 6).join(", ")}${result.models.models.length > 6 ? "…" : ""}` : ""}</span>
              : <span style={{ color: "#ef4444" }}>{result.models.error}</span>) : null}
            {result.server ? <span><Pill tone={result.server.up ? "ok" : "warn"}>{upLabel(result.server)}</Pill> {result.server.summary}</span> : null}
          </div>
        ) : null}
        {problem ? <span style={{ color: "#ef4444", fontSize: 13 }}>{problem}</span> : null}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {hasEndpoint(draft.type) ? <Button onClick={() => void runTest()} disabled={busy !== ""}>{busy === "test" ? "Testing…" : "Test connection"}</Button> : null}
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" onClick={() => void save()} disabled={busy !== ""}>{busy === "save" ? "Saving…" : initial ? "Save backend" : "Add backend"}</Button>
        </div>
        {!initial && taken.some((b) => b.name.trim().toLowerCase() === draft.name.trim().toLowerCase()) ? <span style={MUTED}>Another backend already has this name.</span> : null}
      </div>
    </div>
  );
};

// The company's backends: each defined once, used by pools.
const BackendsSection = ({ companyId, backends, pools, onChanged }: { companyId: string; backends: BackendSummary[]; pools: PoolConfig[]; onChanged: () => void }) => {
  const inspect = usePluginAction("inspect-backend");
  const toast = usePluginToast();
  const [editing, setEditing] = useState<BackendSummary | "new" | null>(null);
  const [reports, setReports] = useState<Record<string, InspectHostResult | { ok: false; error?: string }>>({});
  const [checking, setChecking] = useState<string>();
  const usedBy = (id: string) => pools.filter((p) => p.backend === id || p.watch?.includes(id)).map((p) => p.name);
  const check = async (b: BackendSummary) => {
    setChecking(b.id);
    const r = (await inspect({ companyId, backendId: b.id }).catch((e: Error) => ({ ok: false, error: e.message }))) as InspectHostResult | { ok: false; error?: string };
    setChecking(undefined);
    setReports({ ...reports, [b.id]: r });
  };
  const remove = async (b: BackendSummary) => {
    if (usedBy(b.id).length) return toast({ title: `${b.name} is used by ${usedBy(b.id).join(", ")}. Change those pools first.`, tone: "error" });
    try {
      const config = await readPluginConfig(companyId);
      await savePluginConfig(companyId, { ...config, backends: ((config.backends ?? []) as Backend[]).filter((x) => x.id !== b.id) });
      onChanged();
    } catch (e) {
      toast({ title: `Couldn't remove: ${e instanceof Error ? e.message : String(e)}`, tone: "error" });
    }
  };
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SectionTitle title="Backends" hint="Each model endpoint this company uses, set up once: a proxy, a cloud API or a local engine. Pools pick from these." />
        <span style={{ flex: 1 }} />
        <Button kind="primary" onClick={() => setEditing("new")}>+ Add backend</Button>
      </div>
      {backends.length === 0 ? <span style={MUTED}>No backends yet. Add the endpoints your agents' models go through.</span> : null}
      {backends.map((b) => {
        const info = apiInfo(b.type);
        const report = reports[b.id];
        return (
          <div key={b.id} style={{ display: "grid", gap: 8, borderTop: "1px solid rgba(128,128,128,0.25)", paddingTop: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <strong>{b.name}</strong>
              <Pill tone="ok">{info.label}</Pill>
              {b.hasKey ? <Pill>key saved</Pill> : null}
              <code style={MUTED}>{b.baseUrl || info.defaultBaseUrl || "no address"}</code>
              {backendPrefix(b) ? <span style={MUTED}>models {backendPrefix(b)}…</span> : null}
              <span style={{ flex: 1 }} />
              <span style={MUTED}>{usedBy(b.id).length ? `used by ${usedBy(b.id).join(", ")}` : "not used"}</span>
              {hasEndpoint(b.type) ? <Button onClick={() => void check(b)} disabled={checking === b.id}>{checking === b.id ? "Checking…" : "Check"}</Button> : null}
              <Button onClick={() => setEditing(b)}>Edit</Button>
              <Button kind="danger" onClick={() => void remove(b)}>Remove</Button>
            </div>
            {report ? (report.ok ? <ServerReport report={report} /> : <span style={{ color: "#ef4444", fontSize: 12 }}>{report.error}</span>) : null}
          </div>
        );
      })}
      {editing ? <BackendForm companyId={companyId} initial={editing === "new" ? undefined : editing} taken={backends} onClose={() => setEditing(null)} onSaved={onChanged} /> : null}
    </Card>
  );
};

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

const ModelPicker = ({ pool, backend, prefix, companyId, uses, otherPools, error, onChange }: {
  pool: PoolConfig; backend?: BackendSummary; prefix: string; companyId: string; uses: AgentModelUse[]; otherPools: PoolConfig[]; error?: string; onChange: (p: Partial<PoolConfig>) => void;
}) => {
  const list = usePluginAction("list-backend-models");
  const listing = backend ? apiInfo(backend.type).listing : "none";
  const [models, setModels] = useState<string[] | null>(null);
  const [source, setSource] = useState("");
  const [problem, setProblem] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const loadKey = `${backend?.id ?? ""}|${backend?.type ?? ""}|${backend?.baseUrl ?? ""}|${backend?.hasKey ?? ""}`;
  const load = async () => {
    if (!backend || listing === "none") return setModels([]);
    setLoading(true);
    setProblem(undefined);
    const r = (await list({ companyId, backendId: backend.id }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok: boolean; error?: string; models?: string[]; source?: string };
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
        {listing !== "none" ? <Button onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Reload"}</Button> : null}
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
              <span style={{ ...MUTED, color: !r.onEndpoint && models && listing !== "none" ? "#eab308" : undefined }}>
                {blocked ? `in ${r.otherPool}` : !r.onEndpoint && models?.length && listing !== "none" ? "not on endpoint" : ""}
              </span>
            </label>
          );
        })}
        {loading && !rows.length ? <div style={{ padding: 10, ...MUTED }}>Loading models…</div> : null}
        {!loading && !shown.length ? <div style={{ padding: 10, ...MUTED }}>{rows.length ? "No models match." : listing === "none" ? backend ? "No agents use a model with this prefix yet." : "Pick a backend to list its models." : "The endpoint returned no models."}</div> : null}
      </div>
      {source ? <span style={MUTED}>From {source}.</span> : null}
    </div>
  );
};

// P2.6: keep each task (and its subtasks) on one engine so its prompt cache is reused.
const StickySection = ({ pool, engines, error, onChange, defaultEngine }: {
  pool: PoolConfig; engines: BackendSummary[]; error?: string; onChange: (p: Partial<PoolConfig>) => void;
  // Direct-to-engine pools: each model comes from one engine, so turning pinning on ties it there.
  defaultEngine?: (model: string) => string | undefined;
}) => {
  const sticky = pool.sticky;
  const models = pool.patterns.map((m) => m.trim()).filter(Boolean);
  const setEngine = (model: string, engine: string) => {
    const rest = (sticky ?? []).filter((t) => t.model !== model);
    onChange({ sticky: engine ? [...rest, { model, engine }] : rest });
  };
  const moveUp = (model: string) => {
    const list = [...(sticky ?? [])];
    const i = list.findIndex((t) => t.model === model);
    if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    onChange({ sticky: list });
  };
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <SectionTitle title="Keep each task on one engine" hint="For the prompt cache: a task and its subtasks run on the same engine every time instead of starting a new session elsewhere." />
      <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={sticky !== undefined} onChange={(e) => onChange({
          sticky: e.target.checked ? models.flatMap((model) => { const engine = defaultEngine?.(model); return engine ? [{ model, engine }] : []; }) : undefined,
          reassignAfterMinutes: undefined,
        })} />
        Pin tasks to an engine
      </label>
      {sticky !== undefined ? (
        <>
          <span style={MUTED}>Tie each model that reaches exactly one engine to it. A task on a model left as "Any engine" is placed on the first engine with room (top first) and stays there.</span>
          <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {models.map((model) => {
                const index = sticky.findIndex((t) => t.model === model);
                return (
                  <tr key={model}>
                    <td style={{ padding: "3px 8px 3px 0", fontFamily: "ui-monospace, monospace" }}>{model}</td>
                    <td style={{ padding: "3px 8px 3px 0" }}>
                      <select style={{ ...inputStyle, padding: "4px 6px" }} value={index >= 0 ? sticky[index].engine : ""} onChange={(e) => setEngine(model, e.target.value)}>
                        <option value="">Any engine (placed by the plugin)</option>
                        {engines.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "3px 0", whiteSpace: "nowrap" }}>
                      {index >= 0 ? <span style={MUTED}>try #{index + 1} </span> : null}
                      {index > 0 ? <button type="button" onClick={() => moveUp(model)} style={{ color: "#3b82f6", cursor: "pointer" }} title="Try this engine earlier">↑</button> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            Move a task only after its engine has been down
            <input style={{ ...inputStyle, width: 70, padding: "4px 6px" }} type="number" min={1} value={pool.reassignAfterMinutes ?? 30}
              onChange={(e) => onChange({ reassignAfterMinutes: Number(e.target.value) })} />
            minutes
          </label>
        </>
      ) : null}
      {error ? <span style={{ color: "#ef4444", fontSize: 12 }}>{error}</span> : null}
    </div>
  );
};

interface AgentBrief { id: string; name: string; model?: string }

// Agents use a pool instead of a specific model by pointing at its agent model (for a pinning pool, an entry model such
// as a gateway alias, so the pool picks each task's engine). Adding an agent here changes its model.
const AgentsSection = ({ pool, saved, agents, error, onChange, onAgentsChanged }: {
  pool: PoolConfig; saved: boolean; agents: AgentBrief[]; error?: string; onChange: (p: Partial<PoolConfig>) => void; onAgentsChanged: () => void;
}) => {
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);
  const models = pool.patterns.map((m) => m.trim()).filter(Boolean);
  const pinned = new Set((pool.sticky ?? []).map((t) => t.model));
  const on = pool.agentModel ? agents.filter((a) => a.model === pool.agentModel) : [];
  const add = async (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent || !pool.agentModel) return;
    setBusy(true);
    try {
      await setAgentModel(agent.id, pool.agentModel);
      toast({ title: `${agent.name} now uses ${pool.name} (model ${pool.agentModel})`, tone: "success" });
      onAgentsChanged();
    } catch (e) {
      toast({ title: `Couldn't change ${agent.name}'s model: ${e instanceof Error ? e.message : String(e)}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <SectionTitle title="Agents on this pool" hint="Agents use the pool instead of a specific model by pointing at its agent model." />
      <Field label="Agent model" hint={pool.sticky?.length ? `${virtualModel(pool.id)} lets the pool pick each task's engine. Add the harness config below so it also works before a task is placed.` : "The model agents on this pool use."} error={error}>
        <select style={inputStyle} value={pool.agentModel ?? ""} onChange={(e) => onChange({ agentModel: e.target.value || undefined })}>
          <option value="">None</option>
          {pool.sticky?.length ? <option value={virtualModel(pool.id)}>{virtualModel(pool.id)} (virtual: the pool picks the engine)</option> : null}
          {models.map((m) => <option key={m} value={m}>{m}{pinned.has(m) ? " (tied to an engine)" : ""}</option>)}
        </select>
      </Field>
      {pool.agentModel ? (
        <>
          <span style={{ fontSize: 13 }}>{on.length ? on.map((a) => a.name).join(", ") : <span style={MUTED}>No agents use it yet.</span>}</span>
          {saved ? (
            <select style={inputStyle} value="" disabled={busy} onChange={(e) => void add(e.target.value)}>
              <option value="">Add an agent…</option>
              {agents.filter((a) => a.model !== pool.agentModel).map((a) => <option key={a.id} value={a.id}>{a.name}{a.model ? ` (now ${a.model})` : ""}</option>)}
            </select>
          ) : <span style={MUTED}>Save the pool before adding agents.</span>}
        </>
      ) : null}
    </div>
  );
};

// The harness side of virtual models: a provider block to add to the agents' OpenCode configuration.
const HarnessConfigCard = ({ companyId, version }: { companyId: string; version: string }) => {
  const config = usePluginData<{ provider: Record<string, unknown>; warnings: string[] }>("harness-config", { companyId, version });
  const toast = usePluginToast();
  if (!config.data || !Object.keys(config.data.provider).length) return null;
  const text = JSON.stringify(config.data.provider, null, 2);
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SectionTitle title="Harness config" hint="Add this provider to your agents' OpenCode configuration, so a pool's virtual model also works for a run that starts before the plugin places its task." />
        <span style={{ flex: 1 }} />
        <Button onClick={() => void navigator.clipboard.writeText(text).then(() => toast({ title: "Copied", tone: "success" }))}>Copy</Button>
      </div>
      <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: "rgba(128,128,128,0.12)", fontSize: 12, overflowX: "auto" }}>{text}</pre>
      {config.data.warnings.map((w) => <span key={w} style={MUTED}>{w}</span>)}
    </Card>
  );
};

const PoolCard = ({ pool, companyId, backends, uses, agents, saved, onAgentsChanged, otherPools, index, errorsFor, onChange, onRemove }: {
  pool: PoolConfig; companyId: string; backends: BackendSummary[]; uses: AgentModelUse[]; agents: AgentBrief[]; saved: boolean; onAgentsChanged: () => void;
  otherPools: PoolConfig[]; index: number;
  errorsFor: (path: string) => string | undefined; onChange: (p: Partial<PoolConfig>) => void; onRemove: () => void;
}) => {
  const err = (f: string) => errorsFor(`pools[${index}].${f}`);
  const backend = backends.find((b) => b.id === pool.backend);
  const info = backend ? apiInfo(backend.type) : undefined;
  const prefix = backend ? backendPrefix(backend) : "";
  const locals = backends.filter((b) => b.id !== backend?.id && apiInfo(b.type).group === "local");
  // The engines this pool runs on: its backend if that's a local engine, plus the ones it watches.
  const engines = [...(backend && apiInfo(backend.type).group === "local" ? [backend] : []), ...locals.filter((b) => pool.watch?.includes(b.id))];
  const engineSlots = engines.reduce((n, b) => n + (b.slots ?? 1), 0);
  // Switching backend keeps the names picked and moves them under the new backend's prefix.
  const switchBackend = (id: string) => {
    const next = backends.find((b) => b.id === id);
    const nextPrefix = next ? backendPrefix(next) : "";
    onChange({ backend: id || undefined, watch: undefined, sticky: undefined, api: undefined, prefix: undefined, endpoint: undefined, hosts: [],
      patterns: pool.patterns.map((p) => (p.trim() ? addPrefix(nextPrefix, stripPrefix(prefix, p)) : p)) });
  };
  return (
    <Card>
      <header style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 16 }}>{pool.name || pool.id || "New pool"}</strong>
        {backend ? <Pill tone="ok">{backend.name}</Pill> : <Pill tone="warn">no backend</Pill>}
        {pool.disabled ? <Pill tone="warn">Disabled</Pill> : null}
        <Pill tone={pool.mode === "enforce" ? "warn" : "info"}>{pool.mode === "enforce" ? "Enforcing" : "Observing only"}</Pill>
        <Pill>{pool.limit} run{pool.limit === 1 ? "" : "s"} at once</Pill>
        <Pill>{pool.privacy}</Pill>
        <span style={{ flex: 1 }} />
        <Button onClick={() => onChange({ disabled: pool.disabled ? undefined : true })}
          title={pool.disabled ? "Start releasing work again" : "Stop releasing new work; runs already going finish. Use before shutting an engine down."}>
          {pool.disabled ? "Enable" : "Disable (drain)"}
        </Button>
        <Button kind="danger" onClick={onRemove}>Remove pool</Button>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 12 }}>
        <Field label="Name" error={err("name")}><input style={inputStyle} value={pool.name} onChange={(e) => onChange({ name: e.target.value })} /></Field>
        <Field label="Id" hint="Short, unique, no spaces" error={err("id")}><input style={inputStyle} value={pool.id} onChange={(e) => onChange({ id: e.target.value })} /></Field>
        <div style={{ display: "grid", gap: 4, alignContent: "start" }}>
          <Field label="Max runs at once" hint={pool.limitFromEngines && engines.length ? "Follows the engines' slots" : "0 holds everything"} error={err("limit")}>
            <input style={inputStyle} type="number" min={0} disabled={Boolean(pool.limitFromEngines && engines.length)}
              value={pool.limitFromEngines && engines.length ? engineSlots : pool.limit} onChange={(e) => onChange({ limit: Number(e.target.value) })} />
          </Field>
          {engines.length ? (
            <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={pool.limitFromEngines ?? false}
                onChange={(e) => onChange({ limitFromEngines: e.target.checked || undefined, ...(e.target.checked ? { limit: engineSlots } : {}) })} />
              Match its engines ({engineSlots} slot{engineSlots === 1 ? "" : "s"})
            </label>
          ) : null}
        </div>
        <Field label="Alert after waiting" hint="Minutes" error={err("alertAfterMinutes")}>
          <input style={inputStyle} type="number" min={1} value={pool.alertAfterMinutes} onChange={(e) => onChange({ alertAfterMinutes: Number(e.target.value) })} />
        </Field>
      </div>

      <Field label="Backend" hint={backend ? `${info!.label}${backend.baseUrl || info!.defaultBaseUrl ? ` at ${backend.baseUrl || info!.defaultBaseUrl}` : ""}. Edit it under Backends above.` : backends.length ? "The endpoint this pool's models go through." : "Add a backend above first."} error={err("backend")}>
        <select style={inputStyle} value={pool.backend ?? ""} onChange={(e) => switchBackend(e.target.value)}>
          <option value="">Choose a backend…</option>
          {backends.map((b) => <option key={b.id} value={b.id}>{b.name} ({apiInfo(b.type).label})</option>)}
        </select>
      </Field>

      {backend && frontsEngines(backend.type) && locals.length ? (
        <div style={{ display: "grid", gap: 4 }}>
          <SectionTitle title="Also watch these servers" hint={`Local engines ${backend.name} sends these models to. While they're down or busy with work from outside Paperclip, the pool releases nothing new.`} />
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {locals.map((b) => (
              <label key={b.id} style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={pool.watch?.includes(b.id) ?? false}
                  onChange={(e) => onChange({ watch: e.target.checked ? [...(pool.watch ?? []), b.id] : (pool.watch ?? []).filter((x) => x !== b.id) })} />
                {b.name}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {backend && frontsEngines(backend.type) && locals.length && pool.patterns.filter((m) => m.trim()).length ? (
        <StickySection pool={pool} engines={locals} error={err("sticky") ?? err("reassignAfterMinutes")} onChange={onChange}
          defaultEngine={backend.type === "direct" ? (m) => locals.find((b) => backendPrefix(b) && m.startsWith(backendPrefix(b)))?.id : undefined} />
      ) : null}
      {pool.patterns.some((m) => m.trim()) ? (
        <AgentsSection pool={pool} saved={saved} agents={agents} error={err("agentModel")} onChange={onChange} onAgentsChanged={onAgentsChanged} />
      ) : null}

      <div style={{ display: "grid", gap: 6 }}>
        <SectionTitle title="Models in this pool" hint="Tick the models this pool covers. A task counts here when its model is one of them. This changes nothing in the backend." />
        <ModelPicker pool={pool} backend={backend} prefix={prefix} companyId={companyId} uses={uses} otherPools={otherPools} error={err("patterns")} onChange={onChange} />
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
    </Card>
  );
};

// H4: a company's backends and pools. Queue label and alert task are on the host's plugin config form.
export const SettingsPage = ({ context }: PluginCompanySettingsPageProps) => {
  const companyId = context.companyId;
  const config = usePluginData<{ pools: PoolConfig[]; backends: BackendSummary[] }>("pools-config", { companyId });
  const agentModels = usePluginData<{ uses: AgentModelUse[] }>("agent-models", { companyId });
  const agentList = usePluginData<{ agents: AgentBrief[] }>("agents", { companyId });
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
  const backends = config.data?.backends ?? [];
  const dirty = JSON.stringify(cleaned(pools)) !== saved;
  // Functional update: several pool cards can change in the same render (e.g. wildcard expansion on load).
  const update = (i: number, patch: Partial<PoolConfig>) => setPools((prev) => (prev ?? []).map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const errorsFor = (path: string) => errors.find((e) => e.field === path)?.message;
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
      <Button onClick={() => setPools([...pools, newPool(pools.length + 1, backends[0])])}>+ Add pool</Button>
      <span style={{ flex: 1 }} />
      <span style={MUTED}>{dirty ? "Unsaved pool changes" : "Pools saved"}</span>
      <Button disabled={!dirty || saving} onClick={() => { setPools(JSON.parse(saved)); setErrors([]); }}>Discard</Button>
      <Button kind="primary" disabled={!dirty || saving} onClick={() => void onSave()}>{saving ? "Saving…" : "Save pools"}</Button>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 16, padding: 16, maxWidth: 1000 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <strong style={{ fontSize: 18 }}>Model capacity</strong>
        <span style={{ ...MUTED, fontSize: 13 }}>
          Set up this company's model backends once, then group their models into pools. A pool caps how many of this company's agent runs can use its models at once; extra tasks wait in a queue and start in priority order when a slot frees.
          New pools start in <strong>Observe</strong>: the plugin only logs what it would hold until you switch the pool to <strong>Enforce</strong>.
        </span>
      </div>
      <BackendsSection companyId={companyId} backends={backends} pools={pools} onChanged={() => config.refresh()} />
      <HarnessConfigCard companyId={companyId} version={saved} />
      <AgentModelsPanel uses={agentModels.data?.uses ?? []} pools={pools} backends={backends}
        onAdd={(i, model) => update(i, { patterns: [...pools[i].patterns.filter((p) => p.trim()), model] })}
        onNewPool={(group) => setPools([...pools, poolFromAgents(group, pools, backends)])} />
      {actions}
      {unplaced.length ? (
        <ul role="alert" style={{ color: "#ef4444", margin: 0, fontSize: 13 }}>
          {unplaced.map((e) => <li key={`${e.field}:${e.message}`}>{e.message} <span style={MUTED}>({e.field})</span></li>)}
        </ul>
      ) : null}
      {pools.length === 0 ? <span style={MUTED}>No pools yet. Start one from your agents' models above, or add one.</span> : null}
      {pools.map((p, i) => (
        <PoolCard key={i} pool={p} companyId={companyId} backends={backends} uses={agentModels.data?.uses ?? []}
          agents={agentList.data?.agents ?? []} saved={JSON.parse(saved).some((q: PoolConfig) => q.id === p.id && q.agentModel === p.agentModel)}
          onAgentsChanged={() => { agentList.refresh(); agentModels.refresh(); }} otherPools={pools.filter((_, j) => j !== i)} index={i} errorsFor={errorsFor} onChange={(patch) => update(i, patch)} onRemove={() => setPools(pools.filter((_, j) => j !== i))} />
      ))}
      {actions}
    </div>
  );
};
