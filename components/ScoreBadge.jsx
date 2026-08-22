"use client";

const SIGNAL_COLORS = {
  VERY_EARLY: "#22c55e",
  EARLY: "#4ade80",
  MOMENTUM: "#7c8cff",
  PUMPING: "#eab308",
  LOW_ACTIVITY: "#5b6270"
};

export function ScoreBadge({ score }) {
  if (score === null || score === undefined) {
    return <span className="badge">—</span>;
  }

  let color = "var(--text-secondary)";
  if (score >= 75) color = "var(--green)";
  else if (score >= 50) color = "var(--yellow)";
  else color = "var(--red)";

  return (
    <span className="badge" style={{ color, borderColor: color }}>
      {Math.round(score)}/100
    </span>
  );
}

export function SignalBadge({ signal }) {
  if (!signal) return <span className="badge">—</span>;
  const color = SIGNAL_COLORS[signal] || "var(--text-secondary)";
  return (
    <span className="badge" style={{ color, borderColor: color }}>
      {signal.replace("_", " ")}
    </span>
  );
}
