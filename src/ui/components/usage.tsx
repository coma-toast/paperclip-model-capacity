import { useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";

import type { BackendUsageRow } from "../../api.js";
import { apiInfo } from "../../apis.js";
import { usedShare, type UsageMeter } from "../../usage.js";

const MUTED = { opacity: 0.65, fontSize: 12 } as const;

const money = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
};

const resets = (m: UsageMeter) => {
  if (m.resetAt) return `resets ${new Date(m.resetAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  if (!m.period) return "";
  return /ly$/.test(m.period) ? `resets ${m.period}` : `per ${m.period}`;
};

// Green while there's room, amber past 70 %, red past 90 %.
const Bar = ({ share }: { share: number }) => (
  <span style={{ display: "inline-block", width: 64, height: 6, borderRadius: 3, background: "rgba(128,128,128,0.3)", verticalAlign: "middle", marginRight: 6 }}>
    <span style={{ display: "block", width: `${Math.round(share * 100)}%`, height: "100%", borderRadius: 3, background: share >= 0.9 ? "#ef4444" : share >= 0.7 ? "#f59e0b" : "#22c55e" }} />
  </span>
);

const meterText = (m: UsageMeter) => {
  if (m.unit === "slots") return `${m.used ?? "?"} of ${m.limit ?? "?"} slot${m.limit === 1 ? "" : "s"} busy`;
  if (m.limit !== undefined) return `${money(m.used ?? m.limit - (m.remaining ?? 0))} of ${money(m.limit)} · ${money(m.remaining ?? 0)} left`;
  if (m.remaining !== undefined) return `${money(m.remaining)} left`;
  return `${money(m.used ?? 0)}${m.noLimit ? ` spent · ${m.noLimit}` : ""}`;
};

const Meter = ({ m }: { m: UsageMeter }) => {
  const share = usedShare(m);
  const extra = resets(m);
  return (
    <div>
      {share !== undefined ? <Bar share={share} /> : null}
      <span style={MUTED}>{m.label}: </span>
      <span>{meterText(m)}</span>
      {extra ? <span style={MUTED}> · {extra}</span> : null}
    </div>
  );
};

// Used and remaining spend, credits or slots per backend, as each backend last reported them.
export const BackendUsageTable = ({ rows, companyId, onRefreshed }: { rows: BackendUsageRow[]; companyId: string | null; onRefreshed: () => void }) => {
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
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong style={{ fontSize: 13 }}>Usage</strong>
        <span style={MUTED}>
          {sampled ? `checked ${ago(sampled)} · ` : "not checked yet · "}
          <button type="button" onClick={() => void refresh()} disabled={busy} style={{ color: "#3b82f6", cursor: "pointer", fontSize: 12 }}>
            {busy ? "checking…" : "check now"}
          </button>
        </span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ verticalAlign: "top", borderTop: "1px solid rgba(128,128,128,0.2)" }}>
              <td style={{ padding: "4px 8px 4px 0", whiteSpace: "nowrap" }}>
                {r.name}
                <div style={MUTED}>{apiInfo(r.type).label}</div>
                <div style={MUTED}>{r.pools.length ? `used by ${r.pools.join(", ")}` : "no pool"}</div>
              </td>
              <td style={{ padding: "4px 0" }}>
                {!r.usage ? <span style={MUTED}>Waiting for the first check</span> : null}
                {r.usage?.error ? <span style={{ color: "#ef4444", fontSize: 12 }}>{r.usage.error}</span> : null}
                {r.usage?.meters.map((m) => <Meter key={m.label} m={m} />)}
                {r.usage?.notes.map((n) => <div key={n} style={MUTED}>{n}</div>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
