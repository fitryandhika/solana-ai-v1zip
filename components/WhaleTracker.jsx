"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { formatCompactUsd, shortenAddress } from "../lib/utils/format";
import { TokenLogo } from "./TokenLogo";

function timeAgo(iso) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "baru saja";
  if (mins < 60) return `${mins}m lalu`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h lalu`;
  return `${Math.floor(hours / 24)}d lalu`;
}

export default function WhaleTracker() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [addStatus, setAddStatus] = useState(null);

  const load = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    try {
      const res = await fetch("/api/whale-tracker").then((r) => r.json());
      if (res.success) {
        setData(res);
        setError(null);
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      if (isManualRefresh) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAddWallet(e) {
    e.preventDefault();
    setAddStatus(null);
    try {
      const res = await fetch("/api/whale-tracker/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: newAddress.trim(), label: newLabel.trim() })
      }).then((r) => r.json());

      if (res.success) {
        setAddStatus({ ok: true, message: "Wallet ditambahkan ke watchlist." });
        setNewAddress("");
        setNewLabel("");
        load();
      } else {
        setAddStatus({ ok: false, message: res.error });
      }
    } catch (err) {
      setAddStatus({ ok: false, message: err.message });
    }
  }

  if (loading) {
    return (
      <div className="container">
        <div className="card">Memuat...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container">
        <div className="card">Gagal memuat data: {error}</div>
      </div>
    );
  }

  const { flow, topTokensBought, insight, recentActivity, topSmartMoney } = data;

  return (
    <div className="container" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>🐋 WHALE TRACKER</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Pantau pergerakan uang besar di Solana</div>
        </div>
        <button className="copy-btn" onClick={() => load(true)} disabled={refreshing}>
          {refreshing ? "⏳ Memuat..." : "🔄 Refresh"}
        </button>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
        &quot;Smart money&quot; di sini murni dihitung dari bukti kita sendiri: wallet yang terbukti membeli token
        kita di masa awal dan tokennya benar-benar naik. Wallet dari daftar manual ditandai terpisah — belum tentu
        terverifikasi oleh sistem kita.
      </p>

      <section className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span>{flow.label === "BULLISH" ? "🟢" : flow.label === "BEARISH" ? "🔴" : "⚪"}</span>
          <strong>SMART MONEY FLOW (24 jam)</strong>
        </div>
        <div className="stat-row">
          <div className="stat">
            <div className="stat-label">Uang masuk</div>
            <div className="stat-value positive">{formatCompactUsd(flow.inflowUsd)} ↑</div>
          </div>
          <div className="stat">
            <div className="stat-label">Uang keluar</div>
            <div className="stat-value negative">{formatCompactUsd(flow.outflowUsd)} ↓</div>
          </div>
        </div>
        <div className="stat" style={{ marginTop: 8 }}>
          <div className="stat-label">NET FLOW</div>
          <div className={`stat-value ${flow.netFlowUsd >= 0 ? "positive" : "negative"}`}>
            {flow.netFlowUsd >= 0 ? "+" : ""}
            {formatCompactUsd(flow.netFlowUsd)} {flow.label === "BULLISH" ? "🟢 BULLISH" : flow.label === "BEARISH" ? "🔴 BEARISH" : ""}
          </div>
        </div>
      </section>

      <section className="card">
        <strong>🔥 TOKEN YANG DIBELI WHALE</strong>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          {topTokensBought.length === 0 && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Belum ada aktivitas whale terdeteksi.</div>}
          {topTokensBought.map((t) => (
            <Link
              key={t.tokenAddress}
              href={`/token/${t.tokenAddress}`}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <TokenLogo imageUrl={t.imageUrl} symbol={t.symbol} size={22} />
                <span>${t.symbol || "?"}</span>
              </div>
              <span className="positive">+{formatCompactUsd(t.netUsd)} 🟢</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="card">
        <strong>🐋 AKTIVITAS WHALE TERBARU</strong>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          {recentActivity.length === 0 && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Belum ada aktivitas.</div>}
          {recentActivity.map((a) => (
            <div key={a.signature} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <TokenLogo imageUrl={a.imageUrl} symbol={a.symbol} size={20} />
                <span>
                  {a.direction === "buy" ? "🟢 BUY " : "🔴 SELL "}
                  ${a.symbol || "?"}
                </span>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className={a.direction === "buy" ? "positive" : "negative"}>{formatCompactUsd(a.usdValue)}</div>
                <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  {a.walletLabel || shortenAddress(a.walletAddress)} · {timeAgo(a.tradedAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {insight && (
        <section className="card">
          <strong>🧠 AI WHALE INSIGHT</strong>
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
            <TokenLogo imageUrl={insight.imageUrl} symbol={insight.symbol} size={36} />
            <div>
              <div style={{ fontWeight: 600 }}>Whale mulai mengakumulasi ${insight.symbol || "?"}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {insight.walletCount} whale membeli · Total: {formatCompactUsd(insight.totalUsd)}
              </div>
            </div>
          </div>
          <div className="stat" style={{ marginTop: 12 }}>
            <div className="stat-label">AI Score (rata-rata skor wallet yang membeli)</div>
            <div className="stat-value">
              {insight.aiScore === null
                ? "Belum cukup wallet dengan skor"
                : `${insight.aiScore}/100 ${insight.label === "POSITIVE" ? "🟢 POSITIVE" : insight.label === "CAUTION" ? "🟡 CAUTION" : "⚪ NEUTRAL"}`}
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>⭐ TOP SMART MONEY</strong>
          <button className="copy-btn" onClick={() => setShowAddWallet((s) => !s)}>
            {showAddWallet ? "Tutup" : "+ Tambah Wallet"}
          </button>
        </div>

        {showAddWallet && (
          <form onSubmit={handleAddWallet} style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="text"
              placeholder="Alamat wallet Solana"
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              style={{
                padding: 8,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-elevated)",
                color: "var(--text-primary)"
              }}
              required
            />
            <input
              type="text"
              placeholder="Label (opsional, misal: dari Kolscan)"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              style={{
                padding: 8,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-elevated)",
                color: "var(--text-primary)"
              }}
            />
            <button type="submit" className="copy-btn">
              Tambahkan
            </button>
            {addStatus && <div style={{ fontSize: 12, color: addStatus.ok ? "var(--green)" : "var(--red)" }}>{addStatus.message}</div>}
          </form>
        )}

        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {topSmartMoney.length === 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Belum ada wallet dengan skor — perlu waktu untuk terkumpul bukti.</div>
          )}
          {topSmartMoney.map((w) => (
            <div key={w.address} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
              <div>
                <div>{w.label || shortenAddress(w.address)}</div>
                <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  {w.source === "manual" ? "📋 Manual watchlist" : `${w.earlyBuyCount ?? 0} early buy, ${w.earlyWinCount ?? 0} win`}
                </div>
              </div>
              <span>{w.smartScore === null || w.smartScore === undefined ? "—" : `Score ${w.smartScore}`}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
