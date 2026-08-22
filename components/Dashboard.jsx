"use client";

import { useEffect, useMemo, useState } from "react";
import TokenTable from "./TokenTable";
import TokenCard from "./TokenCard";
import ScannerStatus from "./ScannerStatus";

const SIGNAL_OPTIONS = ["", "VERY_EARLY", "EARLY", "MOMENTUM", "PUMPING", "LOW_ACTIVITY"];
const SORT_OPTIONS = [
  { value: "score", label: "Score" },
  { value: "volume", label: "Volume" },
  { value: "liquidity", label: "Liquidity" },
  { value: "age", label: "Age" }
];

export default function Dashboard() {
  const [tokens, setTokens] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [minScore, setMinScore] = useState("");
  const [maxAge, setMaxAge] = useState("");
  const [minLiquidity, setMinLiquidity] = useState("");
  const [signal, setSignal] = useState("");
  const [sort, setSort] = useState("score");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (minScore) params.set("minScore", minScore);
    if (maxAge) params.set("maxAge", maxAge);
    if (minLiquidity) params.set("minLiquidity", minLiquidity);
    if (signal) params.set("signal", signal);
    params.set("sort", sort);
    params.set("limit", "100");
    return params.toString();
  }, [minScore, maxAge, minLiquidity, signal, sort]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [tokensRes, statusRes] = await Promise.all([
          fetch(`/api/tokens?${query}`).then((r) => r.json()),
          fetch("/api/scanner").then((r) => r.json())
        ]);
        if (cancelled) return;
        if (tokensRes.success) setTokens(tokensRes.tokens);
        else setError(tokensRes.error);
        setStatus(statusRes);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [query]);

  return (
    <div className="container">
      <ScannerStatus status={status} />

      <div className="section-title">Filters</div>
      <div className="filters card">
        <input
          type="number"
          placeholder="Min score"
          value={minScore}
          onChange={(e) => setMinScore(e.target.value)}
        />
        <input
          type="number"
          placeholder="Max age (min)"
          value={maxAge}
          onChange={(e) => setMaxAge(e.target.value)}
        />
        <input
          type="number"
          placeholder="Min liquidity ($)"
          value={minLiquidity}
          onChange={(e) => setMinLiquidity(e.target.value)}
        />
        <select value={signal} onChange={(e) => setSignal(e.target.value)}>
          {SIGNAL_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt || "All signals"}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              Sort: {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="section-title">Early Opportunities</div>

      {loading && <div style={{ color: "var(--text-muted)" }}>Loading…</div>}
      {error && <div className="negative">Error: {error}</div>}

      {!loading && !error && (
        <>
          <TokenTable tokens={tokens} />
          <div className="token-cards">
            {tokens.map((token, idx) => (
              <TokenCard key={token.address} token={token} rank={idx + 1} />
            ))}
          </div>
        </>
      )}

      <div className="disclaimer">
        Solana AI provides market analytics and experimental signals. It does not guarantee future price
        performance and is not financial advice. Newly launched tokens can be extremely volatile and may
        lose most or all of their value. Opportunity Score is a ranking metric, not a probability.
      </div>
    </div>
  );
}
