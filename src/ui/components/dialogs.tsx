import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Spinner, useHostNavigation, usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";

import type { AlertRow, BackendUsageRow, PoolSummary, QueueRow } from "../../api.js";
import { formatPerMillion, priceRating, type ModelPrice } from "../../prices.js";
import type { BackendUsage, ModelLimits } from "../../usage.js";
import { Button, MUTED, inputStyle } from "./form.js";
import { formatWait, settingsPath } from "./shared.js";
import { meterText, stageText } from "./usage.js";

const BORDER = "1px solid rgba(128, 128, 128, 0.35)";

type Result = { ok: boolean; error?: string; errors?: { message: string }[] };

// One overlay dialog for the widget and page. Plugins get no dialog component from the SDK, so it draws its own and
// takes the host's popover colors when they exist.
export const Dialog = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div role="presentation" onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0, 0, 0, 0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", boxSizing: "border-box" }}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 680, maxHeight: "88vh", overflow: "auto", boxSizing: "border-box", borderRadius: 12, border: BORDER,
          background: "var(--popover, var(--card, Canvas))", color: "var(--popover-foreground, CanvasText)", boxShadow: "0 12px 40px rgba(0, 0, 0, 0.35)", display: "grid", gap: 12, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 15 }}>{title}</strong>
          <Button onClick={onClose}>Close</Button>
        </div>
        {children}
      </div>
    </div>
  );
};

// Runs a plugin action, toasts the result and refreshes the caller's data.
const useRun = (onChanged: () => void) => {
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      const r = (await fn()) as Result;
      if (r.ok) toast({ title: done, tone: "success" });
      else toast({ title: r.error ?? r.errors?.map((e) => e.message).join("; ") ?? "Failed", tone: "error" });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return { run, busy };
};

const waitedSince = (at: string) => formatWait(Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000)));

// hover: shown when the link is hovered (a task's first post).
const TaskLink = ({ companyPrefix, identifier, title, hover }: { companyPrefix: string | null; identifier?: string; title?: string; hover?: string }) => {
  const nav = useHostNavigation();
  const label = <><strong>{identifier ?? "Task"}</strong>{title ? <span style={{ opacity: 0.8 }}> {title}</span> : null}</>;
  return identifier && companyPrefix ? <a {...nav.linkProps(`/${companyPrefix}/issues/${identifier}`)} title={hover} style={{ color: "inherit" }}>{label}</a> : <span title={hover}>{label}</span>;
};

// A local engine's runs: what holds its slots now, what's queued behind its own agent, and what the server reports.
// A run on a draining engine moves to another engine DRAIN_GRACE_MS after the engine stopped taking work; "Move now"
// skips the wait (its run is cancelled and the task restarts elsewhere).
export const EngineRunsDialog = ({ row, companyId, companyPrefix, onClose, onChanged }: {
  row: BackendUsageRow; companyId: string; companyPrefix: string | null; onClose: () => void; onChanged: () => void;
}) => {
  const drainRun = usePluginAction("drain-run");
  const { run, busy } = useRun(onChanged);
  const [moved, setMoved] = useState<Set<string>>(new Set());
  const moveNow = (runId: string) => {
    setMoved((m) => new Set([...m, runId]));
    void run(() => drainRun({ companyId, runId }), "Moving it within a minute");
  };
  const runs = [...(row.runList ?? [])].sort((a, b) => Number(b.occupiesSlot) - Number(a.occupiesSlot) || (a.startedAt ?? a.queuedAt ?? "").localeCompare(b.startedAt ?? b.queuedAt ?? ""));
  const holding = runs.filter((r) => r.occupiesSlot).length;
  const stages = row.usage?.stages;
  return (
    <Dialog title={`${row.name} runs`} onClose={onClose}>
      <span style={MUTED}>
        {runs.some((r) => r.draining) ? "Draining: takes no new work; runs move to another engine 30 min after it stopped, or now with Move now. " : ""}
        {holding} Paperclip run{holding === 1 ? "" : "s"} holding a slot{row.cap !== undefined ? ` · capped at ${row.cap}` : ""}{!row.pools.length ? " · not in a pool" : ""}
        {stages ? ` · server: ${stageText(stages)}` : ""}
      </span>
      {runs.length ? (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ textAlign: "left", ...MUTED }}><th style={{ padding: "4px 6px" }}>Task</th><th style={{ padding: "4px 6px" }}>Agent</th><th style={{ padding: "4px 6px" }}>Model</th><th style={{ padding: "4px 6px" }}>State</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId} style={{ borderTop: BORDER }}>
                <td style={{ padding: "6px" }}><TaskLink companyPrefix={companyPrefix} identifier={r.identifier} title={r.title} hover={r.description} /></td>
                <td style={{ padding: "6px" }}>{r.agentName ?? "?"}</td>
                <td style={{ padding: "6px", ...MUTED }}>{r.model ?? "?"}</td>
                <td style={{ padding: "6px", whiteSpace: "nowrap" }}>
                  {r.status === "running" ? `running ${r.startedAt ? waitedSince(r.startedAt) : ""}` : `queued ${r.queuedAt ? waitedSince(r.queuedAt) : ""}`}
                  {!r.occupiesSlot ? <span style={MUTED}> · no slot (waits on its agent)</span> : null}
                  {r.draining ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, whiteSpace: "normal" }}>
                      <span style={MUTED}>
                        {moved.has(r.runId) ? "moving…" : r.moveAt ? (Date.parse(r.moveAt) > Date.now() ? `moves in ${formatWait(Math.round((Date.parse(r.moveAt) - Date.now()) / 1000))}` : "moving…") : "finishes here (not placed by the plugin)"}
                      </span>
                      {r.moveAt && !moved.has(r.runId) ? <Button onClick={() => moveNow(r.runId)} disabled={busy}>Move now</Button> : null}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <span style={MUTED}>No Paperclip runs on it now.</span>}
    </Dialog>
  );
};

// Pools a waiting task can move to: the company's other pools that aren't disabled.
const targetsFor = (pools: PoolSummary[], from?: PoolSummary) => pools.filter((p) => p.id !== from?.id && !p.disabled);
const targetLabel = (p: PoolSummary) => `${p.name}${p.privacy === "shared" ? " (shared)" : ""} · ${p.inUse}/${p.available} in use, ${p.queued} waiting`;

// Moving from a private pool to a shared one sends the tasks' work to cloud models, so it needs a confirming tick.
const MovePicker = ({ pools, from, count, busy, onMove }: { pools: PoolSummary[]; from?: PoolSummary; count: number; busy: boolean; onMove: (poolId: string, allowShared: boolean) => void }) => {
  const targets = targetsFor(pools, from);
  const [to, setTo] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const target = targets.find((p) => p.id === to);
  const toShared = from?.privacy === "private" && target?.privacy === "shared";
  if (!targets.length) return <span style={MUTED}>No other pool to move to.</span>;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <select aria-label="Move to pool" value={to} onChange={(e) => { setTo(e.target.value); setConfirmed(false); }} style={{ ...inputStyle, width: "auto", flex: "1 1 200px", minWidth: 0 }}>
          <option value="">Move to pool…</option>
          {targets.map((p) => <option key={p.id} value={p.id}>{targetLabel(p)}</option>)}
        </select>
        <Button kind="primary" disabled={!to || !count || busy || (toShared && !confirmed)} onClick={() => onMove(to, toShared)}>{count > 1 ? `Move ${count}` : "Move"}</Button>
      </div>
      {toShared ? (
        <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12, color: "#f59e0b" }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>{from!.name} is private. Run {count > 1 ? "these tasks" : "this task"} on {target!.name}'s shared (cloud) models anyway?</span>
        </label>
      ) : null}
    </div>
  );
};

// The tasks waiting for one pool, with release, move-to-front and move-to-another-pool (one or several).
export const WaitingDialog = ({ companyId, companyPrefix, pool, pools, onClose, onChanged }: {
  companyId: string; companyPrefix: string | null; pool: PoolSummary; pools: PoolSummary[]; onClose: () => void; onChanged: () => void;
}) => {
  const queue = usePluginData<{ rows: QueueRow[] }>("queue", { companyId, poolId: pool.id });
  const actions = { releaseNow: usePluginAction("release-now"), moveToFront: usePluginAction("move-to-front"), moveToPool: usePluginAction("move-to-pool") };
  const refresh = () => { queue.refresh(); onChanged(); };
  const { run, busy } = useRun(refresh);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rows = queue.data?.rows ?? [];
  const live = new Set(rows.map((r) => r.issueId));
  const chosen = [...selected].filter((id) => live.has(id));
  const allOn = rows.length > 0 && chosen.length === rows.length;
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const move = (poolId: string, ids: string[], allowShared: boolean) =>
    void run(() => actions.moveToPool({ companyId, poolId, issueIds: ids, allowShared }), `Moving ${ids.length} task${ids.length > 1 ? "s" : ""} to ${pools.find((p) => p.id === poolId)?.name} (within a minute)`).then(() => setSelected(new Set()));

  return (
    <Dialog title={`Waiting for ${pool.name} · ${rows.length}`} onClose={onClose}>
      <span style={MUTED}>{pool.inUse} of {pool.available} slots in use. Tasks start in this order as slots free up; move some to another pool to start them sooner.</span>
      {queue.loading && !queue.data ? <Spinner /> : rows.length === 0 ? <span>Nothing is waiting.</span> : (
        <>
          <div style={{ display: "grid", gap: 8, padding: 10, border: BORDER, borderRadius: 8 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.issueId)))} />
              {chosen.length ? `${chosen.length} selected` : "Select all"}
            </label>
            <MovePicker pools={pools} from={pool} count={chosen.length} busy={busy} onMove={(to, allowShared) => move(to, chosen, allowShared)} />
          </div>
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {rows.map((r) => (
              <li key={r.issueId} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, padding: "8px 10px", border: BORDER, borderRadius: 8, alignItems: "start" }}>
                <input type="checkbox" aria-label={`Select ${r.identifier ?? r.issueId}`} checked={selected.has(r.issueId)} onChange={() => toggle(r.issueId)} style={{ marginTop: 3 }} />
                <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
                  <div style={{ overflowWrap: "anywhere", fontSize: 13 }}>
                    <span style={{ opacity: 0.6 }}>#{r.position} </span>
                    <TaskLink companyPrefix={companyPrefix} identifier={r.identifier} title={r.title} />
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={MUTED}>{r.priority} · waiting {waitedSince(r.heldAt)}</span>
                    <span style={{ flex: 1 }} />
                    <Button disabled={busy} onClick={() => void run(() => actions.releaseNow({ issueId: r.issueId }), "Released")} title="Start it now, over the pool's limit">Start now</Button>
                    <Button disabled={busy || r.position === 1} onClick={() => void run(() => actions.moveToFront({ issueId: r.issueId }), "Moved to the front")}>To front</Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </Dialog>
  );
};

const KIND_LABEL: Record<AlertRow["kind"], string> = {
  waitedTooLong: "Waiting too long", overLimit: "Over the limit", hostDown: "Engine down", hostUp: "Engine back",
  quotaExhausted: "Quota used up", overrideRestoreFailed: "Model not restored", pluginError: "Plugin error",
};
const DISMISSABLE = new Set<AlertRow["kind"]>(["overrideRestoreFailed", "pluginError", "hostUp"]);

const card: CSSProperties = { display: "grid", gap: 8, padding: "10px 12px", border: BORDER, borderRadius: 8 };

// Open alerts with what each means and buttons for what to do about it. Alerts clear on their own once the cause is gone.
export const AlertsDialog = ({ companyId, companyPrefix, pool, pools, onClose, onChanged }: {
  companyId: string; companyPrefix: string | null; pool?: PoolSummary; pools: PoolSummary[]; onClose: () => void; onChanged: () => void;
}) => {
  const alerts = usePluginData<{ active: AlertRow[] }>("alerts", { companyId });
  const nav = useHostNavigation();
  const actions = {
    releaseNow: usePluginAction("release-now"), moveToFront: usePluginAction("move-to-front"), moveToPool: usePluginAction("move-to-pool"),
    holdPool: usePluginAction("hold-pool"), resumePool: usePluginAction("resume-pool"), refreshUsage: usePluginAction("refresh-usage"), dismiss: usePluginAction("dismiss-alert"),
  };
  const refresh = () => { alerts.refresh(); onChanged(); };
  const { run, busy } = useRun(refresh);
  const settings = settingsPath(companyPrefix);
  const all = alerts.data?.active ?? [];
  const mine = pool ? all.filter((a) => a.poolId === pool.id) : all;
  const others = pool ? all.filter((a) => a.poolId !== pool.id) : [];
  const poolOf = (a: AlertRow) => pools.find((p) => p.id === a.poolId);
  const waitingIds = mine.filter((a) => a.kind === "waitedTooLong" && a.waiting).map((a) => a.subject);

  // A plain render function, not a component: a component declared here would remount (and lose a picked pool) on every poll.
  const alertCard = (a: AlertRow) => {
    const p = poolOf(a);
    let explain: ReactNode = a.message;
    let buttons: ReactNode = null;
    if (a.kind === "waitedTooLong") {
      explain = <><TaskLink companyPrefix={companyPrefix} identifier={a.identifier} title={a.title} /> has been waiting for {p?.name ?? "its pool"} for {waitedSince(a.at)} or more.{a.waiting ? "" : " It isn't waiting any more; this clears on the next check."}</>;
      buttons = a.waiting ? (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button disabled={busy} onClick={() => void run(() => actions.releaseNow({ issueId: a.subject }), "Started")} title="Start it now, over the pool's limit">Start now</Button>
            <Button disabled={busy} onClick={() => void run(() => actions.moveToFront({ issueId: a.subject }), "Moved to the front")}>To front</Button>
          </div>
          <MovePicker pools={pools} from={p} count={1} busy={busy} onMove={(to, allowShared) => void run(() => actions.moveToPool({ companyId, poolId: to, issueIds: [a.subject], allowShared }), "Moving (within a minute)")} />
        </>
      ) : null;
    } else if (a.kind === "overLimit") {
      explain = <>{a.message}. Runs already going aren't stopped; nothing new starts in {p?.name ?? "this pool"} until it's back under the limit. Usually runs that started outside the plugin or were started by hand.</>;
      buttons = p ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {p.onHold ? <Button disabled={busy} onClick={() => void run(() => actions.resumePool({ poolId: p.id }), `${p.name} resumed`)}>Resume pool</Button>
            : <Button disabled={busy} onClick={() => void run(() => actions.holdPool({ poolId: p.id }), `${p.name} on hold`)} title="Start nothing new in this pool until you resume it">Hold pool</Button>}
          {settings ? <a {...nav.linkProps(settings)} style={{ color: "#3b82f6", fontSize: 13, alignSelf: "center" }}>Change its limit →</a> : null}
        </div>
      ) : null;
    } else if (a.kind === "hostDown") {
      explain = <>{a.message}. Tasks pinned to it wait; if the pool has a fallback they move there after its wait time. Check the engine is running and reachable.</>;
      buttons = (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button disabled={busy} onClick={() => void run(() => actions.refreshUsage({ companyId }), "Checked")}>Check now</Button>
          {settings ? <a {...nav.linkProps(settings)} style={{ color: "#3b82f6", fontSize: 13, alignSelf: "center" }}>Edit backend →</a> : null}
        </div>
      );
    } else if (a.kind === "quotaExhausted") {
      explain = <>{a.message}. Tasks in {p?.name ?? "this pool"} go to its next model with quota left, or wait for the reset.</>;
      buttons = settings ? <a {...nav.linkProps(settings)} style={{ color: "#3b82f6", fontSize: 13 }}>Edit pool →</a> : null;
    }
    return (
      <li key={a.key} style={card}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 12, color: a.kind === "hostUp" ? "#22c55e" : "#ef4444" }}>{KIND_LABEL[a.kind]}</strong>
          <span style={MUTED}>since {new Date(a.at).toLocaleString()}</span>
          <span style={{ flex: 1 }} />
          {DISMISSABLE.has(a.kind) ? <Button disabled={busy} onClick={() => void run(() => actions.dismiss({ key: a.key }), "Dismissed")}>Dismiss</Button> : null}
        </div>
        <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>{explain}</div>
        {buttons}
      </li>
    );
  };

  return (
    <Dialog title={pool ? `${pool.name} alerts · ${mine.length}` : `Alerts · ${all.length}`} onClose={onClose}>
      {alerts.loading && !alerts.data ? <Spinner /> : mine.length === 0 && others.length === 0 ? <span>No open alerts.</span> : (
        <>
          {waitingIds.length > 1 ? (
            <div style={{ ...card, background: "rgba(128, 128, 128, 0.06)" }}>
              <span style={{ fontSize: 13 }}>{waitingIds.length} tasks have waited too long. Move them all:</span>
              <MovePicker pools={pools} from={pool} count={waitingIds.length} busy={busy} onMove={(to, allowShared) => void run(() => actions.moveToPool({ companyId, poolId: to, issueIds: waitingIds, allowShared }), `Moving ${waitingIds.length} tasks (within a minute)`)} />
            </div>
          ) : null}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>{mine.map(alertCard)}</ul>
          {others.length ? (
            <>
              <strong style={{ fontSize: 13, marginTop: 4 }}>Other alerts</strong>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>{others.map(alertCard)}</ul>
            </>
          ) : null}
        </>
      )}
    </Dialog>
  );
};

interface PoolUsage {
  found: boolean;
  pool?: PoolSummary;
  kind?: "engine" | "quota";
  dailyRunCap?: number;
  backends?: BackendUsageRow[];
  models?: { model: string; price?: ModelPrice; runsNow: number; runsToday: number; limits?: ModelLimits; paused?: { until?: string; reason: string } }[];
  engines?: { id: string; name: string; cap?: number; reachModel?: string; up?: boolean; usage?: BackendUsage; runsNow: number; runsToday: number }[];
}

const limitText = (l?: ModelLimits) => [l?.rpm ? `${l.rpm}/min` : "", l?.tpm ? `${Math.round(l.tpm / 1000)}k tok/min` : "", l?.rpd ? `${l.rpd}/day` : ""].filter(Boolean).join(" · ") || "—";
const untilText = (until?: string) => (until ? new Date(until).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "reset unknown");

const UsageGrid = ({ cols, head, rows }: { cols: string; head: string[]; rows: ReactNode[][] }) => (
  <div style={{ border: BORDER, borderRadius: 8, fontSize: 13, overflowX: "auto" }}>
    <div style={{ display: "grid", gridTemplateColumns: cols, gap: 8, padding: "6px 10px", background: "rgba(128, 128, 128, 0.1)", minWidth: 520 }}>
      {head.map((h) => <span key={h} style={MUTED}>{h}</span>)}
    </div>
    {rows.map((r, i) => (
      <div key={i} style={{ display: "grid", gridTemplateColumns: cols, gap: 8, padding: "6px 10px", alignItems: "center", borderTop: BORDER, minWidth: 520 }}>{r}</div>
    ))}
  </div>
);

// Everything that limits one pool: its own slots, its backend's spend and quotas, and per model or engine the price,
// limits, runs now and today, and whether the scheduler has paused it.
export const PoolUsageDialog = ({ companyId, pool, onClose }: { companyId: string; pool: PoolSummary; onClose: () => void }) => {
  const usage = usePluginData<PoolUsage>("pool-usage", { companyId, poolId: pool.id });
  const refreshUsage = usePluginAction("refresh-usage");
  const { run, busy } = useRun(() => usage.refresh());
  const u = usage.data;
  // One backend-wide limit pausing every model (e.g. free requests used up) is said once, not per model.
  const first = u?.models?.[0]?.paused;
  const shared = first && u?.models && u.models.length > 1 && u.models.every((m) => m.paused?.reason === first.reason && m.paused?.until === first.until) ? first : undefined;
  return (
    <Dialog title={`${pool.name} · usage and limits`} onClose={onClose}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
        <span><strong>{pool.inUse}</strong> of {pool.available} running</span>
        <span><strong>{pool.queued}</strong> waiting</span>
        {u?.dailyRunCap ? <span>cap {u.dailyRunCap} runs per model per day</span> : null}
        {pool.pausedModels ? <span style={{ color: "#f59e0b" }}>{pool.pausedModels} model{pool.pausedModels === 1 ? "" : "s"} paused</span> : null}
        <span style={{ flex: 1 }} />
        <Button disabled={busy} onClick={() => void run(() => refreshUsage({ companyId }), "Usage checked")}>Check now</Button>
      </div>
      {usage.loading && !u ? <Spinner /> : !u?.found ? <span>This pool isn't set up any more.</span> : (
        <>
          {(u.backends ?? []).map((b) => (
            <div key={b.id} style={{ display: "grid", gap: 4, padding: "8px 10px", border: BORDER, borderRadius: 8, fontSize: 13 }}>
              <strong>{b.name}</strong>
              {b.usage?.error ? <span style={{ color: "#ef4444" }}>{b.usage.error}</span> : null}
              {(b.usage?.meters ?? []).map((m) => <span key={m.label}><span style={MUTED}>{m.label}: </span>{meterText(m)}{m.resetAt ? <span style={MUTED}> · resets {untilText(m.resetAt)}</span> : m.period ? <span style={MUTED}> · per {m.period}</span> : null}</span>)}
              {(b.usage?.notes ?? []).map((n) => <span key={n} style={MUTED}>{n}</span>)}
              {b.usage?.sampledAt ? <span style={MUTED}>checked {new Date(b.usage.sampledAt).toLocaleTimeString()}</span> : null}
            </div>
          ))}
          {u.kind === "engine" ? (
            <UsageGrid cols="minmax(120px, 1.4fr) 70px 110px 70px 80px" head={["Engine", "Status", "Slots busy", "Now", "Today"]}
              rows={(u.engines ?? []).map((e) => {
                const slots = e.usage?.meters.find((m) => m.unit === "slots");
                return [
                  <span key="n" style={{ overflowWrap: "anywhere" }}>{e.name}{e.reachModel ? <><br /><code style={{ ...MUTED, fontSize: 11 }}>{e.reachModel}</code></> : null}</span>,
                  <span key="s" style={{ color: e.up === false ? "#ef4444" : "#22c55e" }}>{e.up === false ? "down" : "up"}</span>,
                  <span key="b">{slots ? `${slots.used ?? "?"} / ${e.cap ? Math.min(e.cap, slots.limit ?? e.cap) : slots.limit ?? "?"}` : "—"}{slots?.derived ? <span style={MUTED}> (counted)</span> : null}</span>,
                  <span key="r">{e.runsNow}</span>,
                  <span key="t">{e.runsToday} runs</span>,
                ];
              })} />
          ) : (
            <>
            {shared ? <span style={{ color: "#f59e0b", fontSize: 13 }}>All models paused until {untilText(shared.until)}: {shared.reason}</span> : null}
            <UsageGrid cols="minmax(140px, 2fr) 100px 48px 120px 70px minmax(110px, 1fr)" head={["Model", "In / out per 1M", "Cost", "Limits", "Today", "Status"]}
              rows={(u.models ?? []).map((m) => {
                const rating = priceRating(m.price);
                return [
                  <code key="m" style={{ overflowWrap: "anywhere", fontSize: 12 }}>{m.model}</code>,
                  <span key="p" style={{ ...MUTED, fontVariantNumeric: "tabular-nums" }}>{m.price?.included ? "in plan" : m.price?.free ? "free" : m.price ? `${formatPerMillion(m.price.input)} / ${formatPerMillion(m.price.output)}` : "?"}</span>,
                  <span key="c" style={{ fontWeight: 600, fontSize: 12 }}>{rating}</span>,
                  <span key="l" style={MUTED}>{limitText(m.limits)}</span>,
                  <span key="t">{m.runsToday}{u.dailyRunCap ? ` / ${u.dailyRunCap}` : ""}</span>,
                  m.paused
                    ? shared
                      ? <span key="s" style={{ color: "#f59e0b", fontSize: 12 }}>paused</span>
                      : <span key="s" style={{ color: "#f59e0b", fontSize: 12 }} title={m.paused.reason}>paused until {untilText(m.paused.until)}<br /><span style={MUTED}>{m.paused.reason}</span></span>
                    : <span key="s" style={{ fontSize: 12 }}>{m.runsNow ? `${m.runsNow} running` : "ready"}</span>,
                ];
              })} />
            </>
          )}
          <span style={MUTED}>Paused models get no new tasks until their reset; tasks go to the pool's next model with room. Today counts runs since midnight UTC.</span>
        </>
      )}
    </Dialog>
  );
};
