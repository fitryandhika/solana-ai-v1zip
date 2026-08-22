"use client";

const STATUS_META = {
  LIVE: { dot: "🟢", label: "LIVE", color: "var(--green)" },
  DEGRADED: { dot: "🟡", label: "DEGRADED", color: "var(--yellow)" },
  OFFLINE: { dot: "🔴", label: "OFFLINE", color: "var(--red)" }
};

export default function ScannerStatus({ status }) {
  const meta = STATUS_META[status?.status] || STATUS_META.OFFLINE;

  return (
    <div className="stat-row">
      <div className="stat">
        <div className="stat-label">Scanner</div>
        <div className="stat-value" style={{ color: meta.color }}>
          {meta.dot} {meta.label}
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">Last scan</div>
        <div className="stat-value">{formatRelative(status?.lastEventAt)}</div>
      </div>
      <div className="stat">
        <div className="stat-label">Tokens discovered</div>
        <div className="stat-value">{status?.tokensDiscovered ?? 0}</div>
      </div>
      <div className="stat">
        <div className="stat-label">Tokens analyzed</div>
        <div className="stat-value">{status?.tokensAnalyzed ?? 0}</div>
      </div>
    </div>
  );
}

function formatRelative(iso) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}
