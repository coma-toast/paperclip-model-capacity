import type { CSSProperties, ReactNode } from "react";

// The host's CSS reset strips borders and backgrounds from inputs and buttons, so the plugin styles its own.
// Colors use translucent grays and currentColor so they read in both light and dark themes.
const BORDER = "1px solid rgba(128, 128, 128, 0.45)";
export const MUTED: CSSProperties = { opacity: 0.7, fontSize: 12, lineHeight: 1.4 };

export const inputStyle: CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "6px 8px", border: BORDER, borderRadius: 6,
  background: "rgba(128, 128, 128, 0.08)", color: "inherit", font: "inherit", fontSize: 13,
};

const buttonBase: CSSProperties = {
  padding: "6px 12px", borderRadius: 6, border: BORDER, background: "transparent", color: "inherit",
  font: "inherit", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap",
};

export const Button = ({ kind = "secondary", onClick, disabled, children }: { kind?: "primary" | "secondary" | "danger"; onClick: () => void; disabled?: boolean; children: ReactNode }) => {
  const look: CSSProperties =
    kind === "primary" ? { background: "#2563eb", borderColor: "#2563eb", color: "#fff", fontWeight: 600 }
      : kind === "danger" ? { color: "#ef4444", borderColor: "rgba(239, 68, 68, 0.5)" }
        : {};
  return <button type="button" disabled={disabled} onClick={onClick} style={{ ...buttonBase, ...look, opacity: disabled ? 0.5 : 1 }}>{children}</button>;
};

export const Card = ({ children }: { children: ReactNode }) => (
  <section style={{ border: BORDER, borderRadius: 10, padding: 16, display: "grid", gap: 16 }}>{children}</section>
);

export const SectionTitle = ({ title, hint }: { title: string; hint?: string }) => (
  <div style={{ display: "grid", gap: 2 }}>
    <strong style={{ fontSize: 13 }}>{title}</strong>
    {hint ? <span style={MUTED}>{hint}</span> : null}
  </div>
);

// A labelled field with an optional hint and an inline error.
export const Field = ({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) => (
  <label style={{ display: "grid", gap: 4, alignContent: "start" }}>
    <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
    {children}
    {error ? <span style={{ color: "#ef4444", fontSize: 12 }}>{error}</span> : hint ? <span style={MUTED}>{hint}</span> : null}
  </label>
);

// Two-option choice shown as buttons, each with its own one-line explanation.
export const Choice = <T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; hint: string }[]; onChange: (v: T) => void }) => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(${options.length}, 1fr)`, gap: 6 }}>
    {options.map((o) => {
      const on = o.value === value;
      return (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={on}
          style={{ ...buttonBase, textAlign: "left", whiteSpace: "normal", padding: "8px 10px", display: "grid", gap: 2,
            borderColor: on ? "#2563eb" : "rgba(128, 128, 128, 0.45)", background: on ? "rgba(37, 99, 235, 0.15)" : "transparent" }}>
          <span style={{ fontWeight: 600 }}>{on ? "● " : "○ "}{o.label}</span>
          <span style={MUTED}>{o.hint}</span>
        </button>
      );
    })}
  </div>
);

export const Pill = ({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "info" | "warn" | "ok" }) => {
  const colors = { neutral: "rgba(128,128,128,0.2)", info: "rgba(37,99,235,0.2)", warn: "rgba(234,179,8,0.25)", ok: "rgba(34,197,94,0.2)" };
  return <span style={{ background: colors[tone], borderRadius: 999, padding: "2px 8px", fontSize: 12, whiteSpace: "nowrap" }}>{children}</span>;
};
