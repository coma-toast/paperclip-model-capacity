import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";

import type { BackendUsageRow } from "../../api.js";
import { apiInfo } from "../../apis.js";
import type { UsageMeter } from "../../usage.js";
import type { EngineStages } from "../../probes/http.js";
import { readQuotaWindows, type QuotaAccount } from "../hostApi.js";

const MUTED = { opacity: 0.65, fontSize: 12 } as const;

const money = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
};

// How long until a time, as "45m", "3h 10m" or "2d 4h"; "now" once it has passed.
export const untilText = (iso: string) => {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const nextMidnightUtc = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
};



export const meterText = (m: UsageMeter) => {
  if (m.unit === "slots") return `${m.used ?? "?"} of ${m.limit ?? "?"} slot${m.limit === 1 ? "" : "s"} busy${m.derived ? " (Paperclip's runs)" : ""}`;
  if (m.unit === "requests" && m.limit === undefined) return `${m.used ?? "?"} used${m.detail ? ` · ${m.detail}` : ""}`;
  if (m.unit === "requests") return `${m.used ?? "?"} of ${m.limit ?? "?"} used · ${m.remaining ?? "?"} left`;
  if (m.limit !== undefined) return `${money(m.used ?? m.limit - (m.remaining ?? 0))} of ${money(m.limit)} · ${money(m.remaining ?? 0)} left`;
  if (m.remaining !== undefined) return `${money(m.remaining)} left`;
  return `${money(m.used ?? 0)}${m.noLimit ? ` spent · ${m.noLimit}` : ""}`;
};

// One usage window in a single shape for every source: money spent, requests or a percentage used, or slots busy.
type WindowUnit = "usd" | "requests" | "percent" | "slots";
interface UsageWindow {
  label: string;
  unit: WindowUnit;
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  // Shown when there's no reset time, e.g. "no limit", "monthly", "20/min".
  note?: string;
  // Slots: what each slot is doing, drawn as one segment per slot.
  segments?: SlotState[];
  // Slots: runs still finishing on an engine that takes no new work (capped at 0 or out of its pool).
  draining?: number;
}
type SlotState = "prefill" | "decode" | "busy" | "free";
type Kind = "money" | "quota" | "slots";
type Status = "ok" | "low" | "out" | "error" | "off";
interface UsageCardData {
  key: string;
  kind: Kind;
  name: string;
  sub: string;
  windows: UsageWindow[];
  error?: string;
  // An engine still connected but in no pool: Paperclip sends it nothing, so it's shown greyed out with 0 slots.
  off?: boolean;
  // An engine that refused the connection: greyed out as offline.
  offline?: boolean;
  // Slot cards: the engine's row, so clicking the card can list its runs.
  row?: BackendUsageRow;
}

const OFFLINE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ETIMEDOUT|timed out|aborted/i;
const COLORS: Record<Status, string> = { ok: "#22c55e", low: "#f59e0b", out: "#ef4444", error: "#ef4444", off: "#9ca3af" };
const KIND_TITLE: Record<Kind, string> = { money: "Money", quota: "Quotas", slots: "Slots" };

const fmt = (n: number | undefined, unit: WindowUnit) =>
  n === undefined ? "?" : unit === "usd" ? money(n) : unit === "percent" ? `${Math.round(n)}%` : n.toLocaleString();
const left = (w: UsageWindow) => (w.remaining ?? (w.limit !== undefined && w.used !== undefined ? Math.max(0, w.limit - w.used) : undefined));
const share = (w: UsageWindow) => (w.limit && w.used !== undefined ? Math.min(1, w.used / w.limit) : undefined);
const statusOf = (c: UsageCardData): Status => {
  if (c.error) return "error";
  if (c.off && c.windows.some((w) => w.draining)) return "low";
  if (c.off) return "off";
  if (c.kind !== "slots" && c.windows.some((w) => w.limit !== undefined && (left(w) ?? 1) <= 0)) return "out";
  return c.windows.some((w) => (share(w) ?? 0) >= 0.8) ? "low" : "ok";
};

// LiteLLM budget durations ("1d", "7d", "1mo") read as words; anything else as "per <period>".
const PERIOD_WORDS: Record<string, string> = { "1d": "daily", "24h": "daily", "7d": "weekly", "1w": "weekly", "1mo": "monthly", "30d": "monthly" };
const periodNote = (p?: string) => (!p ? undefined : PERIOD_WORDS[p] ?? (/ly$|\s/.test(p) ? p : `per ${p}`));
const shortLabel = (label: string) => (/^key spend$/i.test(label) ? "Spend" : /^spent today$/i.test(label) ? "Today" : label.replace(/ busy$/i, ""));

const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
// What the engine is doing now: "1 in prefill (12k / 40k tokens) · 2 decoding (38 tok/s) · 1 waiting", or "idle".
export const stageText = (s: EngineStages) => {
  const parts = [
    s.prefill ? `${s.prefill} in prefill${s.prefillTotal ? ` (${kTokens(s.prefillDone ?? 0)} / ${kTokens(s.prefillTotal)} tokens)` : ""}` : "",
    s.decode ? `${s.decode} decoding${s.decodeTps ? ` (${Math.round(s.decodeTps)} tok/s)` : ""}` : "",
    s.waiting ? `${s.waiting} waiting` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "idle on the server";
};

// Sorts a backend's meters and per-model limits into money, quota and slot cards.
const cardsFor = (r: BackendUsageRow): UsageCardData[] => {
  const u = r.usage;
  const sub = [apiInfo(r.type).label, ...r.pools].join(" · ");
  if (!u) return [{ key: `${r.id}:none`, kind: "money", name: r.name, sub, windows: [], error: "Waiting for the first check" }];
  const local = apiInfo(r.type).group === "local";
  // A local engine that isn't listening (turned off, asleep, or the app quit) is offline, not an error.
  if (u.error && local && OFFLINE.test(u.error)) return [{ key: `${r.id}:off`, kind: "slots", name: r.name, sub, windows: [], off: true, offline: true, row: r }];
  if (u.error) return [{ key: `${r.id}:err`, kind: local ? "slots" : "money", name: r.name, sub, windows: [], error: u.error, ...(local ? { row: r } : {}) }];
  const byKind: Record<Kind, UsageWindow[]> = { money: [], quota: [], slots: [] };
  for (const m of u.meters) {
    if (m.unit === "slots") {
      // A slot is taken by a Paperclip run or by anything the server is working on (prefill or decode), whoever sent it.
      const runs = r.runs ?? (m.derived ? m.used : undefined) ?? 0;
      const prefill = u.stages?.prefill ?? 0;
      const decode = u.stages?.decode ?? 0;
      const serverBusy = u.stages ? prefill + decode : !m.derived ? m.used ?? 0 : 0;
      const used = Math.max(runs, serverBusy);
      const outside = Math.max(0, serverBusy - runs);
      const generating = [u.stages ? stageText(u.stages) : undefined, outside ? `${outside} not from Paperclip` : undefined].filter(Boolean).join(" · ") || undefined;
      const capped = r.pools.length && r.cap !== undefined && m.limit !== undefined && r.cap < m.limit ? `capped at ${r.cap} of the server's ${m.limit} slots` : undefined;
      // The engine pool's cap on this engine, when lower than the server's own slots.
      const limit = !r.pools.length ? 0 : r.cap !== undefined && m.limit !== undefined ? Math.min(r.cap, m.limit) : r.cap ?? m.limit;
      // Taken out of its pool or capped at 0 while Paperclip runs still finish on it: draining.
      const draining = limit === 0 && runs > 0 ? runs : 0;
      const why = !r.pools.length ? "Not in a pool" : limit === 0 ? "Capped at 0" : undefined;
      const note = draining
        ? [`${draining} run${draining === 1 ? "" : "s"} finishing; no new work`, generating].filter(Boolean).join(" · ")
        : why ? [`${why}${m.limit !== undefined ? ` · the server has ${m.limit} slot${m.limit === 1 ? "" : "s"}` : ""}`, generating].filter(Boolean).join(" · ")
          : [generating, capped].filter(Boolean).join(" · ") || undefined;
      const total = Math.max(limit ?? 0, used);
      const segments: SlotState[] | undefined = total > 0 && total <= MAX_SEGMENTS
        ? Array.from({ length: total }, (_, i) => (i < prefill ? "prefill" : i < prefill + decode ? "decode" : i < used ? "busy" : "free"))
        : undefined;
      byKind.slots.push({ label: "Slots", unit: "slots", used, limit, note, segments, ...(draining ? { draining } : {}) });
      continue;
    }
    const kind: Kind = m.unit === "requests" ? "quota" : "money";
    const today = /today/i.test(m.label);
    byKind[kind].push({
      label: shortLabel(m.label), unit: m.unit, used: m.used, limit: m.limit, remaining: m.remaining,
      resetAt: m.resetAt ?? (today ? nextMidnightUtc() : undefined),
      note: m.detail ?? (m.limit === undefined && !today ? "no limit" : m.appliesTo === "free" && u.modelLimits?.["*:free"]?.rpm ? `${u.modelLimits["*:free"].rpm}/min` : periodNote(m.period)),
    });
  }
  const rpd = Math.max(0, ...Object.values(u.modelLimits ?? {}).map((l) => l.rpd ?? 0));
  // A backend that counts its free requests (OpenRouter) has a meter for them already; the rest get the bare cap.
  if (rpd && !u.meters.some((m) => m.appliesTo === "free")) {
    const rpm = Math.max(0, ...Object.values(u.modelLimits ?? {}).map((l) => l.rpm ?? 0));
    byKind.quota.push({ label: "Free models / day", unit: "requests", limit: rpd, resetAt: nextMidnightUtc(), note: rpm ? `${rpm}/min` : undefined });
  }
  return (Object.keys(byKind) as Kind[]).filter((k) => byKind[k].length).map((kind) => ({
    key: `${r.id}:${kind}`, kind, name: r.name, sub, windows: byKind[kind], ...(kind === "slots" ? { row: r } : {}),
    ...(kind === "slots" && (!r.pools.length || byKind.slots.every((w) => w.limit === 0)) ? { off: true } : {}),
  }));
};

const Bar = ({ w }: { w: UsageWindow }) => {
  const s = share(w);
  const dashed = w.limit === undefined || w.used === undefined;
  return (
    <div style={{ height: 6, borderRadius: 3, overflow: "hidden", background: dashed ? "repeating-linear-gradient(90deg, rgba(128,128,128,0.3) 0 6px, transparent 6px 10px)" : "rgba(128,128,128,0.25)" }}>
      {!dashed ? <div style={{ width: `${Math.round((s ?? 0) * 100)}%`, height: "100%", borderRadius: 3, background: (s ?? 0) >= 0.9 ? COLORS.out : (s ?? 0) >= 0.8 ? COLORS.low : COLORS.ok }} /> : null}
    </div>
  );
};

// One segment per slot: blue reading the prompt (prefill), green generating (decode), grey taken by a Paperclip run the
// server doesn't show yet, and empty when free.
const MAX_SEGMENTS = 24;
const SLOT_COLORS: Record<SlotState, string> = { prefill: "#3b82f6", decode: "#22c55e", busy: "#94a3b8", free: "rgba(128,128,128,0.25)" };
const SlotBar = ({ segments }: { segments: SlotState[] }) => (
  <div style={{ display: "grid", gap: 4 }}>
    <div style={{ display: "flex", gap: 3 }}>
      {segments.map((s, i) => <div key={i} title={s === "free" ? "free" : s === "busy" ? "taken by a Paperclip run" : s} style={{ flex: 1, height: 6, borderRadius: 3, background: SLOT_COLORS[s] }} />)}
    </div>
    {segments.some((s) => s === "prefill" || s === "decode") ? (
      <div style={{ display: "flex", gap: 10, fontSize: 11, opacity: 0.7 }}>
        {(["prefill", "decode"] as const).filter((k) => segments.includes(k)).map((k) => (
          <span key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: SLOT_COLORS[k] }} />{k}</span>
        ))}
      </div>
    ) : null}
  </div>
);

const Pill = ({ status, text }: { status: Status; text: string }) => (
  <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 999, whiteSpace: "nowrap", flexShrink: 0, color: COLORS[status], background: `${COLORS[status]}22` }}>{text}</span>
);

const WindowLine = ({ w }: { w: UsageWindow }) => {
  const l = left(w);
  // Past the allowance (Copilot's overage billing) it's shown as how far over, not a negative amount left.
  const over = l !== undefined && l < 0 ? -l : 0;
  const usedText = w.limit !== undefined && w.used !== undefined
    ? <><b>{fmt(w.used, w.unit)}</b> / {fmt(w.limit, w.unit)} used · <b>{fmt(over || l, w.unit)}</b> {over ? "over" : "left"}</>
    : w.limit !== undefined ? <>limit <b>{fmt(w.limit, w.unit)}</b></>
      : <><b>{fmt(w.used, w.unit)}</b> used</>;
  const right = w.resetAt ? `resets in ${untilText(w.resetAt)}` : w.note ?? "";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 3 }}>
      <span style={{ ...MUTED, fontSize: 11 }}>{w.label}</span>
      <Bar w={w} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{usedText}{w.resetAt && w.note ? <span style={MUTED}> · {w.note}</span> : null}</span>
        <span style={MUTED}>{right}</span>
      </div>
    </div>
  );
};

const card: CSSProperties = { border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8, padding: "6px 8px", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 5, alignContent: "start", minWidth: 0 };
const ELLIPSIS: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const UsageCard = ({ c, onOpen }: { c: UsageCardData; onOpen?: (row: BackendUsageRow) => void }) => {
  const status = statusOf(c);
  const slots = c.kind === "slots" ? c.windows[0] : undefined;
  const pillText = c.error ? "Error" : c.offline ? "Offline" : slots?.draining ? `Draining · ${slots.draining}` : slots ? `${fmt(slots.used, "slots")} / ${fmt(slots.limit, "slots")} slots` : status === "out" ? "Out" : status === "low" ? "Low" : "OK";
  const style = c.off && !slots?.draining ? { ...card, opacity: 0.6 } : card;
  // A slot card opens the engine's runs.
  const open = c.row && onOpen ? () => onOpen(c.row!) : undefined;
  return (
    <div style={open ? { ...style, cursor: "pointer" } : style} {...(open ? {
      role: "button", tabIndex: 0, title: "Show its runs", onClick: open,
      onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } },
    } : {})}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, minWidth: 0 }}>
          <strong style={{ fontSize: 13, minWidth: 0, ...ELLIPSIS }} title={c.name}>{c.name}</strong>
          <Pill status={status} text={pillText} />
        </div>
        <span style={{ ...MUTED, fontSize: 11, ...ELLIPSIS }} title={c.sub}>{c.sub}</span>
      </div>
      {c.error ? <span style={{ color: COLORS.error, fontSize: 11 }}>{c.error}</span> : null}
      {c.offline ? <span style={{ ...MUTED, fontSize: 11 }}>Not reachable; Paperclip sends it nothing until it's back.</span> : null}
      {slots ? <>{slots.segments ? <SlotBar segments={slots.segments} /> : <Bar w={slots} />}{slots.note ? <span style={{ ...MUTED, fontSize: 11 }}>{slots.note}</span> : null}</> : c.windows.map((w) => <WindowLine key={w.label} w={w} />)}
    </div>
  );
};

const KindSection = ({ kind, cards, onOpen }: { kind: Kind | "subscriptions"; cards: UsageCardData[]; onOpen?: (row: BackendUsageRow) => void }) =>
  cards.length ? (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", opacity: 0.6 }}>{kind === "subscriptions" ? "Subscriptions" : KIND_TITLE[kind]}</span>
      {/* Two columns of small cards (one on a narrow widget, more on a wide page). */}
      <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 200px), 1fr))" }}>
        {cards.map((c) => <UsageCard key={c.key} c={c} onOpen={onOpen} />)}
      </div>
    </div>
  ) : null;

// Every backend's usage in one shape, grouped by kind: what's used, what's left, and when each window resets.
export const BackendUsageTable = ({ rows, companyId, onRefreshed, onOpenEngine }: {
  rows: BackendUsageRow[]; companyId: string | null; onRefreshed: () => void; onOpenEngine?: (row: BackendUsageRow) => void;
}) => {
  const refreshUsage = usePluginAction("refresh-usage");
  const [busy, setBusy] = useState(false);
  if (!rows.length) return null;
  const refresh = async () => {
    setBusy(true);
    await refreshUsage({ companyId }).catch(() => undefined);
    setBusy(false);
    onRefreshed();
  };
  const sampled = rows.map((r) => r.usage?.sampledAt).filter((s): s is string => Boolean(s)).sort()[0];
  const noData = rows.filter((r) => r.usage?.ok && !r.usage.meters.length && !Object.values(r.usage.modelLimits ?? {}).some((l) => l.rpd));
  const cards = rows.filter((r) => !noData.includes(r)).flatMap(cardsFor);
  // Problems first within each kind, so a used-up limit is the first thing seen.
  const order: Record<Status, number> = { out: 0, error: 1, low: 2, ok: 3, off: 4 };
  const of = (k: Kind) => cards.filter((c) => c.kind === k).sort((a, b) => order[statusOf(a)] - order[statusOf(b)]);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong style={{ fontSize: 14 }}>Usage</strong>
        <span style={MUTED}>
          {sampled ? `checked ${ago(sampled)} · ` : "not checked yet · "}
          <button type="button" onClick={() => void refresh()} disabled={busy} style={{ color: "#3b82f6", cursor: "pointer", fontSize: 12, border: "none", background: "none", padding: 0 }}>
            {busy ? "checking…" : "check now"}
          </button>
        </span>
      </div>
      <KindSection kind="money" cards={of("money")} />
      <KindSection kind="quota" cards={of("quota")} />
      <KindSection kind="slots" cards={of("slots")} onOpen={onOpenEngine} />
      {noData.length ? (
        <span style={{ ...MUTED, borderTop: "1px solid rgba(128,128,128,0.2)", paddingTop: 8 }}>
          No usage data: {noData.map((r) => r.name).join(", ")}{noData.some((r) => r.type === "opencode") ? " (balance is in its console)" : ""}
        </span>
      ) : null}
    </div>
  );
};

// Paperclip asks the providers themselves, so this is read rarely, not on every widget poll.
const QUOTA_POLL_MS = 5 * 60_000;

// Subscription plans (Claude, ChatGPT/Codex): each usage window as a percentage, in the same cards as the backends.
export const SubscriptionUsage = ({ companyId }: { companyId: string | null }) => {
  const [accounts, setAccounts] = useState<QuotaAccount[] | null>(null);
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    // Providers with no connected account (a company that doesn't use that subscription) aren't shown.
    const load = () => readQuotaWindows(companyId)
      .then((a) => live && setAccounts(a.filter((x) => x.errorFamily !== "credentials_unavailable")))
      .catch(() => live && setAccounts([]));
    void load();
    const timer = setInterval(() => void load(), QUOTA_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [companyId]);
  if (!accounts?.length) return null;
  const cards: UsageCardData[] = accounts.map((a) => ({
    key: `${a.provider}:${a.accountLabel ?? ""}`, kind: "quota", name: a.accountLabel ?? a.provider, sub: a.provider,
    error: a.ok ? undefined : a.error ?? "Couldn't read this account's usage",
    windows: a.windows.filter((w) => w.usedPercent !== null).map((w) => ({
      label: w.label, unit: "percent", used: w.usedPercent ?? undefined, limit: 100, resetAt: w.resetsAt ?? undefined, note: w.detail ?? undefined,
    })),
  }));
  return <KindSection kind="subscriptions" cards={cards} />;
};

export interface PausedModel {
  model: string;
  poolId?: string;
  poolName?: string;
  until?: string;
  since: string;
  reason: string;
}

// Models the scheduler stopped giving work to (quota or credit used up, daily cap, rate limit), and when they're back.
export const PausedModels = ({ paused }: { paused: PausedModel[] }) => {
  if (!paused.length) return null;
  // Models of one pool paused for the same reason until the same time (a backend-wide quota) show as one row.
  const groups = new Map<string, PausedModel[]>();
  for (const p of paused) {
    const key = `${p.poolId}|${p.reason}|${p.until ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const sorted = [...groups.values()].sort((a, b) => (a[0].until ?? "9").localeCompare(b[0].until ?? "9"));
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <strong style={{ fontSize: 13 }}>Paused models</strong>
      {sorted.map((g) => (
        <div key={`${g[0].poolId}:${g[0].model}`} style={{ fontSize: 13, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline", borderTop: "1px solid rgba(128,128,128,0.2)", paddingTop: 4 }}>
          {g.length === 1
            ? <code style={{ fontSize: 12, overflowWrap: "anywhere" }}>{g[0].model}</code>
            : <span title={g.map((p) => p.model).join("\n")}>{g.length} models</span>}
          {g[0].poolName ? <span style={MUTED}>{g[0].poolName}</span> : null}
          <span style={{ flex: 1 }} />
          <span style={{ color: "#f59e0b", fontSize: 12, whiteSpace: "nowrap" }}>{g[0].until ? `back in ${untilText(g[0].until)}` : "until it resets"}</span>
          <span style={{ ...MUTED, width: "100%" }}>{g[0].reason}</span>
        </div>
      ))}
    </div>
  );
};
