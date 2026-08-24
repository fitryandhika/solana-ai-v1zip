// lib/analyzer/ai-stats.js
//
// Pure computation over token_outcomes rows for the "Riwayat AI" dashboard.
// No DB or network calls here — everything is a straightforward aggregate
// over real recorded outcomes, which keeps it easy to test and easy to
// verify there's no fabricated number anywhere in this file.
//
// Honesty notes (read before changing any of this):
//   - Every stat here is a REAL aggregate of stored data. There is no
//     machine-learning model behind "AI Performance" — the underlying
//     "prediction" is the rule-based opportunityScore/signal computed at
//     discovery (lib/analyzer/opportunity.js), and "actual" is the real
//     price_change_pct recorded later. This module scores how well that
//     fixed rule-based formula has performed, nothing more.
//   - "Improvement" compares recent vs prior performance — it does NOT mean
//     the system learned or adjusted itself. Returns null (not 0) when
//     there isn't enough history yet, so the UI can honestly show
//     "not enough data" instead of a misleading number.
//   - The simulated equity curve / drawdown is a simplified backtest
//     convention (equal-weight, sequential, compounding) — not a real
//     managed portfolio. It ignores position sizing and time-overlap
//     between concurrent trades.
//   - Pattern breakdowns exclude any group with fewer than
//     MIN_PATTERN_SAMPLE_SIZE data points, so a noisy 2-token sample never
//     gets presented as if it were a reliable pattern.

const MIN_PATTERN_SAMPLE_SIZE = 5;

/**
 * Overall performance at one horizon: win rate, average return, sample
 * size, and a recent-vs-prior-period improvement delta (null if there
 * isn't enough history on both sides yet).
 */
function computeAiPerformance(rows, horizonLabel = "24h") {
  const field = `price_change_pct_${horizonLabel}`;
  const valid = rows.filter((r) => r[field] !== null && r[field] !== undefined);
  const totalPredictions = valid.length;

  if (totalPredictions === 0) {
    return { winRate: null, avgReturn: null, totalPredictions: 0, improvementPct: null };
  }

  const wins = valid.filter((r) => r[field] > 0).length;
  const winRate = (wins / totalPredictions) * 100;
  const avgReturn = valid.reduce((sum, r) => sum + r[field], 0) / totalPredictions;
  const improvementPct = computeImprovement(valid, field);

  return { winRate, avgReturn, totalPredictions, improvementPct };
}

function computeImprovement(rows, field, recentDays = 7) {
  const now = Date.now();
  const recentCutoff = now - recentDays * 24 * 60 * 60 * 1000;
  const priorCutoff = now - 2 * recentDays * 24 * 60 * 60 * 1000;

  const recent = rows.filter((r) => new Date(r.discovered_at).getTime() >= recentCutoff);
  const prior = rows.filter((r) => {
    const t = new Date(r.discovered_at).getTime();
    return t >= priorCutoff && t < recentCutoff;
  });

  if (recent.length === 0 || prior.length === 0) return null;

  const recentWinRate = (recent.filter((r) => r[field] > 0).length / recent.length) * 100;
  const priorWinRate = (prior.filter((r) => r[field] > 0).length / prior.length) * 100;

  return recentWinRate - priorWinRate;
}

/**
 * Daily win rate / average return, plus a simulated max-drawdown figure
 * from a simplified equal-weight sequential equity curve. See the honesty
 * note at the top of this file about what that drawdown does and doesn't
 * represent.
 */
function computePerformanceOverTime(rows, horizonLabel = "24h") {
  const field = `price_change_pct_${horizonLabel}`;
  const valid = rows
    .filter((r) => r[field] !== null && r[field] !== undefined && r.discovered_at)
    .sort((a, b) => new Date(a.discovered_at) - new Date(b.discovered_at));

  if (valid.length === 0) return { daily: [], maxDrawdownPct: null };

  const byDate = new Map();
  for (const row of valid) {
    const date = row.discovered_at.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row[field]);
  }

  const daily = Array.from(byDate.entries()).map(([date, values]) => ({
    date,
    winRate: (values.filter((v) => v > 0).length / values.length) * 100,
    avgReturn: values.reduce((s, v) => s + v, 0) / values.length,
    count: values.length
  }));

  let equity = 1;
  let peak = 1;
  let maxDrawdownPct = 0;
  for (const row of valid) {
    equity *= 1 + row[field] / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }

  return { daily, maxDrawdownPct };
}

/**
 * Win rate / avg return / sample size at each horizon. Uses every row that
 * has that horizon's field populated — not just fully-finalized (24h)
 * rows — so 5m/15m/1h stats reflect fresher data than waiting for 24h.
 */
function computePredictionAccuracy(rows, horizonLabels) {
  return horizonLabels.map((label) => {
    const field = `price_change_pct_${label}`;
    const valid = rows.filter((r) => r[field] !== null && r[field] !== undefined);

    if (valid.length === 0) {
      return { horizon: label, winRate: null, avgReturn: null, sampleSize: 0 };
    }

    return {
      horizon: label,
      winRate: (valid.filter((r) => r[field] > 0).length / valid.length) * 100,
      avgReturn: valid.reduce((s, r) => s + r[field], 0) / valid.length,
      sampleSize: valid.length
    };
  });
}

function groupStats(rows, groupFn, field = "price_change_pct_24h") {
  const groups = new Map();

  for (const row of rows) {
    if (row[field] === null || row[field] === undefined) continue;
    const key = groupFn(row);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row[field]);
  }

  return Array.from(groups.entries())
    .map(([group, values]) => ({
      group,
      count: values.length,
      winRate: (values.filter((v) => v > 0).length / values.length) * 100,
      avgReturn: values.reduce((s, v) => s + v, 0) / values.length
    }))
    .filter((g) => g.count >= MIN_PATTERN_SAMPLE_SIZE)
    .sort((a, b) => b.avgReturn - a.avgReturn);
}

/**
 * Statistical breakdowns of real outcome data by discovery-time
 * conditions — an honest replacement for "AI learned patterns": these are
 * observed correlations in the data, not something a model discovered on
 * its own. `rows` are expected to be token_outcomes rows with a nested
 * `tokens` object (source, mint_authority_revoked, top10_holder_pct,
 * creator_prior_rug_count) from the embedded Supabase select.
 */
function computeObservedPatterns(rows) {
  return {
    bySignal: groupStats(rows, (r) => r.discovery_signal || "UNKNOWN"),
    bySource: groupStats(rows, (r) => r.tokens?.source || "unknown"),
    byMintAuthority: groupStats(rows, (r) => {
      const v = r.tokens?.mint_authority_revoked;
      if (v === true) return "Mint revoked (safer)";
      if (v === false) return "Mint NOT revoked (risk)";
      return null;
    }),
    byHolderConcentration: groupStats(rows, (r) => {
      const pct = r.tokens?.top10_holder_pct;
      if (pct === null || pct === undefined) return null;
      if (pct < 25) return "Top10 holders <25%";
      if (pct < 50) return "Top10 holders 25-50%";
      if (pct < 75) return "Top10 holders 50-75%";
      return "Top10 holders 75%+";
    }),
    byCreatorHistory: groupStats(rows, (r) => {
      const count = r.tokens?.creator_prior_rug_count;
      if (count === null || count === undefined) return null;
      return count === 0 ? "Creator: 0 prior rugs" : "Creator: 1+ prior rugs";
    })
  };
}

module.exports = {
  MIN_PATTERN_SAMPLE_SIZE,
  computeAiPerformance,
  computePerformanceOverTime,
  computePredictionAccuracy,
  computeObservedPatterns
};
