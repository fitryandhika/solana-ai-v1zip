"use client";

import Link from "next/link";
import { formatCompactUsd, formatPrice, formatTokenAge } from "../lib/utils/format";
import { ScoreBadge, SignalBadge } from "./ScoreBadge";
import { TokenLogo } from "./TokenLogo";

export default function TokenTable({ tokens }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Token</th>
            <th>Age</th>
            <th>Price</th>
            <th>Liquidity</th>
            <th>Volume 5m</th>
            <th>Buy/Sell (5m)</th>
            <th>Momentum</th>
            <th>Score</th>
            <th>Signal</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((token, idx) => (
            <tr key={token.address}>
              <td>{idx + 1}</td>
              <td>
                <Link href={`/token/${token.address}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <TokenLogo imageUrl={token.imageUrl} symbol={token.symbol} size={24} />
                  <div>
                    <strong>{token.symbol || "?"}</strong>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{token.name || "Unknown"}</div>
                  </div>
                </Link>
              </td>
              <td>{formatTokenAge(token.ageMinutes)}</td>
              <td>{formatPrice(token.price)}</td>
              <td>{formatCompactUsd(token.liquidity)}</td>
              <td>{formatCompactUsd(token.volume5m)}</td>
              <td>
                {token.buys5m ?? "—"}/{token.sells5m ?? "—"}
              </td>
              <td className={momentumClass(token.momentumScore)}>{token.momentumScore ?? "—"}</td>
              <td>
                <ScoreBadge score={token.opportunityScore} />
              </td>
              <td>
                <SignalBadge signal={token.signal} />
              </td>
            </tr>
          ))}
          {tokens.length === 0 && (
            <tr>
              <td colSpan={10} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>
                No tokens match the current filters yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function momentumClass(score) {
  if (score === null || score === undefined) return "";
  if (score >= 60) return "positive";
  if (score <= 40) return "negative";
  return "";
}
