const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeAiPerformance,
  computePerformanceOverTime,
  computePredictionAccuracy,
  computeObservedPatterns,
  MIN_PATTERN_SAMPLE_SIZE
} = require("../lib/analyzer/ai-stats");

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

test("computeAiPerformance returns nulls when there is no data", () => {
  const result = computeAiPerformance([], "24h");
  assert.equal(result.winRate, null);
  assert.equal(result.avgReturn, null);
  assert.equal(result.totalPredictions, 0);
  assert.equal(result.improvementPct, null);
});

test("computeAiPerformance computes win rate and avg return correctly", () => {
  const rows = [
    { price_change_pct_24h: 50, discovered_at: daysAgo(1) },
    { price_change_pct_24h: -20, discovered_at: daysAgo(1) },
    { price_change_pct_24h: 30, discovered_at: daysAgo(1) },
    { price_change_pct_24h: -10, discovered_at: daysAgo(1) }
  ];
  const result = computeAiPerformance(rows, "24h");
  assert.equal(result.totalPredictions, 4);
  assert.equal(result.winRate, 50);
  assert.equal(result.avgReturn, 12.5);
});

test("computeAiPerformance ignores rows missing that horizon's field", () => {
  const rows = [
    { price_change_pct_24h: 50, discovered_at: daysAgo(1) },
    { price_change_pct_24h: null, discovered_at: daysAgo(1) },
    { discovered_at: daysAgo(1) } // field entirely absent
  ];
  const result = computeAiPerformance(rows, "24h");
  assert.equal(result.totalPredictions, 1);
});

test("computeAiPerformance returns null improvement without two full periods", () => {
  const rows = [{ price_change_pct_24h: 10, discovered_at: daysAgo(1) }];
  const result = computeAiPerformance(rows, "24h");
  assert.equal(result.improvementPct, null);
});

test("computeAiPerformance computes improvement when both periods have data", () => {
  const rows = [
    // Prior period (8-14 days ago): 1/2 win = 50%
    { price_change_pct_24h: 10, discovered_at: daysAgo(10) },
    { price_change_pct_24h: -10, discovered_at: daysAgo(10) },
    // Recent period (last 7 days): 2/2 win = 100%
    { price_change_pct_24h: 5, discovered_at: daysAgo(2) },
    { price_change_pct_24h: 5, discovered_at: daysAgo(2) }
  ];
  const result = computeAiPerformance(rows, "24h");
  assert.equal(result.improvementPct, 50); // 100% - 50%
});

test("computePerformanceOverTime buckets by day and computes drawdown", () => {
  const rows = [
    { price_change_pct_24h: 100, discovered_at: daysAgo(3) }, // equity: 1 -> 2
    { price_change_pct_24h: -50, discovered_at: daysAgo(2) }, // equity: 2 -> 1
    { price_change_pct_24h: 10, discovered_at: daysAgo(1) } // equity: 1 -> 1.1
  ];
  const result = computePerformanceOverTime(rows, "24h");
  assert.equal(result.daily.length, 3);
  // Peak was 2 (after +100%), trough was 1 (after -50%) => 50% drawdown.
  assert.equal(result.maxDrawdownPct, 50);
});

test("computePerformanceOverTime handles empty input", () => {
  const result = computePerformanceOverTime([], "24h");
  assert.deepEqual(result.daily, []);
  assert.equal(result.maxDrawdownPct, null);
});

test("computePredictionAccuracy reports per-horizon stats with sample sizes", () => {
  const rows = [
    { price_change_pct_5m: 10, price_change_pct_24h: 20 },
    { price_change_pct_5m: -10, price_change_pct_24h: null }
  ];
  const result = computePredictionAccuracy(rows, ["5m", "24h"]);
  const fiveMin = result.find((r) => r.horizon === "5m");
  const day = result.find((r) => r.horizon === "24h");

  assert.equal(fiveMin.sampleSize, 2);
  assert.equal(fiveMin.winRate, 50);
  assert.equal(day.sampleSize, 1);
  assert.equal(day.winRate, 100);
});

test("computeObservedPatterns excludes groups below the minimum sample size", () => {
  const rows = [
    { discovery_signal: "EARLY", price_change_pct_24h: 10, tokens: {} },
    { discovery_signal: "EARLY", price_change_pct_24h: 20, tokens: {} }
    // Only 2 rows — below MIN_PATTERN_SAMPLE_SIZE, should be excluded.
  ];
  const result = computeObservedPatterns(rows);
  assert.equal(result.bySignal.length, 0);
  assert.ok(MIN_PATTERN_SAMPLE_SIZE > 2);
});

test("computeObservedPatterns includes groups at or above the minimum sample size", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    discovery_signal: "EARLY",
    price_change_pct_24h: i % 2 === 0 ? 10 : -5,
    tokens: {}
  }));
  const result = computeObservedPatterns(rows);
  assert.equal(result.bySignal.length, 1);
  assert.equal(result.bySignal[0].group, "EARLY");
  assert.equal(result.bySignal[0].count, 6);
});

test("computeObservedPatterns buckets holder concentration and excludes unknowns", () => {
  const rows = [
    ...Array.from({ length: 5 }, () => ({ price_change_pct_24h: -20, tokens: { top10_holder_pct: 80 } })),
    ...Array.from({ length: 5 }, () => ({ price_change_pct_24h: 15, tokens: { top10_holder_pct: 10 } })),
    { price_change_pct_24h: 5, tokens: {} } // unknown holder pct — excluded, not lumped in
  ];
  const result = computeObservedPatterns(rows);
  const highConcentration = result.byHolderConcentration.find((g) => g.group === "Top10 holders 75%+");
  const lowConcentration = result.byHolderConcentration.find((g) => g.group === "Top10 holders <25%");

  assert.equal(highConcentration.count, 5);
  assert.equal(highConcentration.avgReturn, -20);
  assert.equal(lowConcentration.count, 5);
  assert.equal(lowConcentration.avgReturn, 15);
});
