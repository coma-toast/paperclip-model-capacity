import { useEffect, useState, type CSSProperties } from "react";

import { apiInfo } from "../../apis.js";
import type { PoolSummary } from "../../api.js";
import { HostDots, PoolBadges, formatWait, usedUpLabel } from "./shared.js";
import { untilText, type PausedModel } from "./usage.js";

// Below this widget width the pool table doesn't fit (a phone is ~390 px), so the widget shows tiles instead.
export const NARROW_WIDTH = 520;

// The widget can't use media queries (styles are inline), so it measures its own width.
export const useNarrow = (el: HTMLElement | null, breakpoint = NARROW_WIDTH) => {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? breakpoint) < breakpoint));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, breakpoint]);
  return narrow;
};

// Open alerts across all pools, for the one banner above the tiles.
export const alertSummary = (pools: Pick<PoolSummary, "openAlerts">[]) => {
  const withAlerts = pools.filter((p) => p.openAlerts > 0);
  return { total: withAlerts.reduce((sum, p) => sum + p.openAlerts, 0), pools: withAlerts.length };
};

export const AlertBanner = ({ pools, onOpen }: { pools: PoolSummary[]; onOpen: () => void }) => {
  const { total, pools: count } = alertSummary(pools);
  if (!total) return null;
  return (
    <button type="button" onClick={onOpen} title="Show alerts and what to do"
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", border: "1px solid rgba(239, 68, 68, 0.5)",
        background: "rgba(239, 68, 68, 0.12)", color: "#ef4444", borderRadius: 8, padding: "6px 10px", font: "inherit", fontWeight: 600, cursor: "pointer", textAlign: "left" }}>
      <span>{total} alert{total > 1 ? "s" : ""} in {count} pool{count > 1 ? "s" : ""}</span>
      <span aria-hidden>›</span>
    </button>
  );
};

const tile: CSSProperties = { display: "grid", gap: 4, alignContent: "start", minWidth: 0, overflow: "hidden", padding: "8px 10px", border: "1px solid rgba(128, 128, 128, 0.25)", borderRadius: 8 };
const linkButton: CSSProperties = { border: "none", background: "none", padding: 0, font: "inherit", cursor: "pointer", textAlign: "left" };

const UseBar = ({ inUse, available }: { inUse: number; available: number }) => {
  const share = available > 0 ? Math.min(1, inUse / available) : inUse > 0 ? 1 : 0;
  return (
    <div aria-hidden style={{ height: 4, borderRadius: 2, background: "rgba(128, 128, 128, 0.25)", overflow: "hidden" }}>
      <div style={{ width: `${Math.round(share * 100)}%`, height: "100%", background: share >= 1 ? "#f59e0b" : "#3b82f6" }} />
    </div>
  );
};

// H1 on a phone: one tile per pool in two columns. Alerts move to the banner above, so tiles only show other badges.
export const PoolTiles = ({ pools, paused, onUsage, onWaiting }: {
  pools: PoolSummary[];
  paused: PausedModel[];
  onUsage: (poolId: string) => void;
  onWaiting: (poolId: string) => void;
}) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
    {pools.map((p, i) => {
      const pausedUntil = paused.filter((x) => x.poolId === p.id && x.until).map((x) => x.until!).sort()[0];
      // An odd last tile takes the whole row, so its badges have room.
      const wide = pools.length % 2 === 1 && i === pools.length - 1;
      return (
        <div key={p.id} style={wide ? { ...tile, gridColumn: "1 / -1" } : tile}>
          <button type="button" onClick={() => onUsage(p.id)} title={`${p.name} · ${apiInfo(p.api).label}: usage and limits`}
            style={{ ...linkButton, color: "inherit", minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
            <div style={{ fontSize: 12, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{apiInfo(p.api).label}</div>
          </button>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }} title={`limit ${p.limit}`}>
            <span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{p.inUse}/{p.available}</span>
            <span style={{ fontSize: 12, opacity: 0.6 }}>in use</span>
            <span style={{ flex: 1 }} />
            {p.hosts.length ? <HostDots hosts={p.hosts} /> : null}
          </div>
          <UseBar inUse={p.inUse} available={p.available} />
          {p.queued ? (
            <button type="button" onClick={() => onWaiting(p.id)} title="Show waiting tasks and move them"
              style={{ ...linkButton, color: "#3b82f6", fontSize: 13, textDecoration: "underline" }}>
              {p.queued} waiting · {formatWait(p.oldestWaitSeconds)}
            </button>
          ) : <span style={{ fontSize: 13, opacity: 0.6 }}>No queue</span>}
          <div style={{ minWidth: 0, overflow: "hidden" }} title={pausedUntil ? `${p.pausedModels} paused · next back in ${untilText(pausedUntil)}` : undefined}>
            <PoolBadges pool={{ ...p, openAlerts: 0 }} pausedUntil={wide ? pausedUntil : undefined}
              usedUp={usedUpLabel(paused.filter((x) => x.poolId === p.id).map((x) => x.reason))} />
          </div>
        </div>
      );
    })}
  </div>
);
