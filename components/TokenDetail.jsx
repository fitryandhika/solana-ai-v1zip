"use client";

import { useEffect, useState } from "react";
import { formatCompactUsd, formatPrice, formatPercent, formatTokenAge, shortenAddress } from "../lib/utils/format";
import { ScoreBadge, SignalBadge } from "./ScoreBadge";
import PriceChart from "./PriceChart";

export default function TokenDetail({ address }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/token/${address}`).then((r) => r.json());
        if (cancelled) return;
        if (res.success) setData(res);
        else setError(res.error);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    load();
    const interval = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address]);

  if (error) return <div className="container negative">Error: {error}</div>;
  if (!data) return <div className="container">Loading…</div>;

  const { token, latestSnapshot, recentSnapshots } = data;

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(token.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  return (
    <div className="container">
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0 }}>
              {token.name || "Unknown"} ({token.symbol || "?"})
            </h2>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
              {shortenAddress(token.address, 6, 6)}{" "}
              <button className="copy-btn" onClick={copyAddress}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <ScoreBadge score={latestSnapshot?.opportunity_score} />
        </div>

        <div className="stat-row">
          <div className="stat">
            <div className="stat-label">DEX</div>
            <div className="stat-value">{token.dex || "—"}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Pair address</div>
            <div className="stat-value" style={{ fontSize: 12 }}>
              {shortenAddress(token.pairAddress, 6, 6)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Token age</div>
            <div className="stat-value">{formatTokenAge(token.ageMinutes)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Signal</div>
            <div className="stat-value">
              <SignalBadge signal={latestSnapshot?.signal} />
            </div>
          </div>
        </div>
      </div>

      <div className="section-title">Market Metrics</div>
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Price</div>
          <div className="stat-value">{formatPrice(latestSnapshot?.price)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Liquidity</div>
          <div className="stat-value">{formatCompactUsd(latestSnapshot?.liquidity)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Market Cap</div>
          <div className="stat-value">{formatCompactUsd(latestSnapshot?.market_cap)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Volume 5m</div>
          <div className="stat-value">{formatCompactUsd(latestSnapshot?.volume_5m)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Buys / Sells (5m)</div>
          <div className="stat-value">
            {latestSnapshot?.buys_5m ?? "—"} / {latestSnapshot?.sells_5m ?? "—"}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Price change 5m</div>
          <div
            className={
              (latestSnapshot?.price_change_5m ?? 0) > 0
                ? "stat-value positive"
                : (latestSnapshot?.price_change_5m ?? 0) < 0
                ? "stat-value negative"
                : "stat-value"
            }
          >
            {formatPercent(latestSnapshot?.price_change_5m)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Momentum Score</div>
          <div className="stat-value">{latestSnapshot?.momentum_score ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Opportunity Score</div>
          <div className="stat-value">
            {latestSnapshot?.opportunity_score !== null && latestSnapshot?.opportunity_score !== undefined
              ? `${latestSnapshot.opportunity_score}/100`
              : "—"}
          </div>
        </div>
      </div>

      {latestSnapshot?.data_status === "unavailable" && (
        <div className="warning" style={{ marginTop: 8 }}>
          Market data temporarily unavailable — showing last known snapshot.
        </div>
      )}

      <div className="section-title">Charts</div>
      <div className="card" style={{ marginBottom: 12 }}>
        <PriceChart snapshots={recentSnapshots} field="price" label="Price over time" color="#7c8cff" />
      </div>
      <div className="card">
        <PriceChart snapshots={recentSnapshots} field="volume_5m" label="Volume over time" color="#22c55e" />
      </div>

      <div className="disclaimer">
        Solana AI provides market analytics and experimental signals. It does not guarantee future price
        performance and is not financial advice. Newly launched tokens can be extremely volatile and may
        lose most or all of their value.
      </div>
    </div>
  );
}
