"use client";

import Link from "next/link";
import { formatCompactUsd, formatPrice, formatTokenAge } from "../lib/utils/format";
import { ScoreBadge, SignalBadge } from "./ScoreBadge";

export default function TokenCard({ token, rank }) {
  return (
    <Link href={`/token/${token.address}`} className="card token-card">
      <div className="token-card-top">
        <div>
          <strong>
            #{rank} {token.symbol || "?"}
          </strong>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{token.name || "Unknown"}</div>
        </div>
        <ScoreBadge score={token.opportunityScore} />
      </div>
      <div className="token-card-grid">
        <div>Age: {formatTokenAge(token.ageMinutes)}</div>
        <div>Price: {formatPrice(token.price)}</div>
        <div>Liq: {formatCompactUsd(token.liquidity)}</div>
        <div>Vol 5m: {formatCompactUsd(token.volume5m)}</div>
        <div>
          B/S (5m): {token.buys5m ?? "—"}/{token.sells5m ?? "—"}
        </div>
        <div>Mom: {token.momentumScore ?? "—"}</div>
      </div>
      <SignalBadge signal={token.signal} />
    </Link>
  );
}
