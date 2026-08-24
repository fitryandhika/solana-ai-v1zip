"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AiPerformanceChart from "./AiPerformanceChart";
import { TokenLogo } from "./TokenLogo";

function formatPct(value) {
  if (value === null || value === undefined) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function pctClass(value) {
  if (value === null || value === undefined) return "";
  return value > 0 ? "positive" : value < 0 ? "negative" : "";
}

export default function AiHistoryDashboard() {
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [predictions, setPredictions] = useState([]);
  const [predictionsTotal, setPredictionsTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const limit = 25;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ai-history")
      .then((r) => r.json())
      .then((res) => {
        if (cancelled) return;
        if (res.success) setStats(res);
        else setStatsError(res.error);
      })
      .catch((err) => !cancelled && setStatsError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ai-history/predictions?limit=${limit}&offset=${offset}`)
      .then((r) => r.json())
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setPredictions(res.predictions);
          setPredictionsTotal(res.total);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [offset]);

  if (statsError) {
    return (
      <div className="container">
        <div className="card">Gagal memuat data: {statsError}</div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="container">
        <div className="card">Memuat...</div>
      </div>
    );
  }

  const { performance, performanceOverTime, accuracy, patterns } = stats;

  return (
    <div className="container" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>🧠 AI Performance</h3>
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Berdasarkan skor/sinyal berbasis rumus (bukan model machine learning) yang dihitung saat token ditemukan,
          dibandingkan dengan hasil harga aktual 24 jam kemudian.
        </p>
        <div className="stat-row">
          <div className="stat">
            <div className="stat-label">Win Rate (24h)</div>
            <div className="stat-value">{performance.winRate === null ? "Belum ada data" : `${performance.winRate.toFixed(1)}%`}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Avg Return (24h)</div>
            <div className={`stat-value ${pctClass(performance.avgReturn)}`}>{formatPct(performance.avgReturn)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Total Predictions</div>
            <div className="stat-value">{performance.totalPredictions}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Improvement (7 hari vs 7 hari sebelumnya)</div>
            <div className={`stat-value ${pctClass(performance.improvementPct)}`}>
              {performance.improvementPct === null ? "Belum cukup histori" : formatPct(performance.improvementPct)}
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>📈 Performance Chart</h3>
        <div style={{ display: "grid", gap: 16 }}>
          <AiPerformanceChart daily={performanceOverTime.daily} field="winRate" label="Win Rate per Hari (%)" />
          <AiPerformanceChart daily={performanceOverTime.daily} field="avgReturn" label="Avg Return per Hari (%)" />
        </div>
        <div className="stat" style={{ marginTop: 12 }}>
          <div className="stat-label">
            Simulated Max Drawdown — asumsi taruhan setara di setiap sinyal secara berurutan, BUKAN portofolio nyata
          </div>
          <div className="stat-value negative">
            {performanceOverTime.maxDrawdownPct === null ? "—" : `-${performanceOverTime.maxDrawdownPct.toFixed(1)}%`}
          </div>
        </div>
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>🎯 Prediction Accuracy per Horizon</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Horizon</th>
                <th>Win Rate</th>
                <th>Avg Return</th>
                <th>Sampel</th>
              </tr>
            </thead>
            <tbody>
              {accuracy.map((a) => (
                <tr key={a.horizon}>
                  <td>{a.horizon}</td>
                  <td>{a.winRate === null ? "—" : `${a.winRate.toFixed(1)}%`}</td>
                  <td className={pctClass(a.avgReturn)}>{formatPct(a.avgReturn)}</td>
                  <td>{a.sampleSize}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>🔍 Observed Patterns</h3>
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Statistik nyata dari data yang sudah terkumpul — pengelompokan data historis, bukan hasil AI yang
          &quot;belajar&quot; sendiri. Kelompok dengan sampel di bawah 5 token disembunyikan supaya tidak
          menyesatkan.
        </p>
        <PatternGroup title="Berdasarkan Signal" groups={patterns.bySignal} />
        <PatternGroup title="Berdasarkan Sumber Penemuan" groups={patterns.bySource} />
        <PatternGroup title="Berdasarkan Status Mint Authority" groups={patterns.byMintAuthority} />
        <PatternGroup title="Berdasarkan Konsentrasi Holder" groups={patterns.byHolderConcentration} />
        <PatternGroup title="Berdasarkan Riwayat Creator" groups={patterns.byCreatorHistory} />
      </section>

      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ marginTop: 0 }}>📋 Prediction History</h3>
          <a href="/api/ai-history/predictions/export" download className="copy-btn">
            ⬇ Export CSV
          </a>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Prediksi</th>
                <th>Aktual</th>
                <th>Hasil</th>
                <th>Catatan</th>
              </tr>
            </thead>
            <tbody>
              {predictions.map((p) => (
                <tr key={p.tokenAddress}>
                  <td>
                    <Link href={`/token/${p.tokenAddress}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <TokenLogo imageUrl={p.imageUrl} symbol={p.symbol} size={20} />
                      <span>{p.symbol || "?"}</span>
                    </Link>
                  </td>
                  <td>
                    {p.prediction.signal || "—"} ({p.prediction.opportunityScore ?? "—"})
                  </td>
                  <td className={pctClass(p.actual?.priceChangePct)}>
                    {p.actual ? `${formatPct(p.actual.priceChangePct)} (${p.actual.horizon})` : "Pending"}
                  </td>
                  <td>
                    <span className={`badge ${p.result === "WIN" ? "positive" : p.result === "LOSS" ? "negative" : ""}`}>
                      {p.result}
                    </span>
                  </td>
                  <td style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.note || "—"}</td>
                </tr>
              ))}
              {predictions.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: 24, color: "var(--text-muted)" }}>
                    Belum ada data prediksi.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 12 }}>
          <button className="copy-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
            ← Sebelumnya
          </button>
          <span style={{ color: "var(--text-muted)" }}>
            {predictionsTotal === 0 ? 0 : offset + 1}-{Math.min(offset + limit, predictionsTotal)} dari {predictionsTotal}
          </span>
          <button className="copy-btn" disabled={offset + limit >= predictionsTotal} onClick={() => setOffset(offset + limit)}>
            Berikutnya →
          </button>
        </div>
      </section>
    </div>
  );
}

function PatternGroup({ title, groups }) {
  if (!groups || groups.length === 0) {
    return (
      <div style={{ marginTop: 12 }}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Belum cukup data (minimal 5 token per kelompok).</div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Kelompok</th>
              <th>Jumlah</th>
              <th>Win Rate</th>
              <th>Avg Return (24h)</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.group}>
                <td>{g.group}</td>
                <td>{g.count}</td>
                <td>{g.winRate.toFixed(1)}%</td>
                <td className={pctClass(g.avgReturn)}>{formatPct(g.avgReturn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
