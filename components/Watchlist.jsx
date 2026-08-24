"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { formatCompactUsd, formatPrice, formatPercent, formatTokenAge } from "../lib/utils/format";
import { ScoreBadge, SignalBadge } from "./ScoreBadge";
import { TokenLogo } from "./TokenLogo";

export default function Watchlist() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formStatus, setFormStatus] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/watchlist").then((r) => r.json());
      if (res.success) {
        setItems(res.watchlist);
        setError(null);
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleAdd(e) {
    e.preventDefault();
    setSubmitting(true);
    setFormStatus(null);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: address.trim(), note: note.trim() })
      }).then((r) => r.json());

      if (res.success) {
        setFormStatus({ ok: true, message: "Token ditambahkan ke watchlist." });
        setAddress("");
        setNote("");
        load();
      } else {
        setFormStatus({ ok: false, message: res.error });
      }
    } catch (err) {
      setFormStatus({ ok: false, message: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove(tokenAddress) {
    try {
      await fetch("/api/watchlist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: tokenAddress })
      });
      load();
    } catch (err) {
      setFormStatus({ ok: false, message: err.message });
    }
  }

  return (
    <div className="container" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="card">
        <div style={{ fontSize: 20, fontWeight: 700 }}>⭐ WATCHLIST</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
          Tambahkan alamat token yang mau kamu pantau secara khusus. Token baru akan otomatis mulai dilacak penuh
          (harga, rug-check, hasil outcome) seperti token yang ditemukan otomatis.
        </div>

        <form onSubmit={handleAdd} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            type="text"
            placeholder="Alamat token Solana"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
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
            placeholder="Catatan (opsional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{
              padding: 8,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--text-primary)"
            }}
          />
          <button type="submit" className="copy-btn" disabled={submitting}>
            {submitting ? "Menambahkan..." : "+ Tambah ke Watchlist"}
          </button>
          {formStatus && (
            <div style={{ fontSize: 12, color: formStatus.ok ? "var(--green)" : "var(--red)" }}>{formStatus.message}</div>
          )}
        </form>
      </section>

      {loading && <div className="card">Memuat...</div>}

      {error && <div className="card">Gagal memuat data: {error}</div>}

      {!loading && !error && items.length === 0 && (
        <div className="card" style={{ color: "var(--text-muted)", textAlign: "center" }}>
          Belum ada token di watchlist kamu.
        </div>
      )}

      {items.map((token) => (
        <div key={token.address} className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <Link href={`/token/${token.address}`} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <TokenLogo imageUrl={token.imageUrl} symbol={token.symbol} size={32} />
              <div>
                <strong>{token.symbol || "?"}</strong>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{token.name || "Unknown"}</div>
              </div>
            </Link>
            <ScoreBadge score={token.opportunityScore} />
          </div>

          {token.note && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, fontStyle: "italic" }}>
              &quot;{token.note}&quot;
            </div>
          )}

          <div className="stat-row" style={{ marginTop: 10 }}>
            <div className="stat">
              <div className="stat-label">Age</div>
              <div className="stat-value">{formatTokenAge(token.ageMinutes)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Price</div>
              <div className="stat-value">{formatPrice(token.price)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Liq</div>
              <div className="stat-value">{formatCompactUsd(token.liquidity)}</div>
            </div>
          </div>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-label">Vol 5m</div>
              <div className="stat-value">{formatCompactUsd(token.volume5m)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Change 5m</div>
              <div className="stat-value">{formatPercent(token.priceChange5m)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Signal</div>
              <div className="stat-value">
                <SignalBadge signal={token.signal} />
              </div>
            </div>
          </div>

          <button className="copy-btn" style={{ marginTop: 10 }} onClick={() => handleRemove(token.address)}>
            Hapus dari Watchlist
          </button>
        </div>
      ))}
    </div>
  );
}
