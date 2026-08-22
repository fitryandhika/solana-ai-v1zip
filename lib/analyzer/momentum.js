// lib/analyzer/momentum.js
//
// Simple, deterministic momentum engine (spec section 12). No ML, no
// randomness. Considers: price momentum, volume growth, buy/sell pressure,
// liquidity. Every function here is a pure function of its inputs so it is
// trivially unit-testable.

/**
 * Volume acceleration: current volume relative to a prior baseline.
 * Returns null (not 0) when there isn't enough history — spec section 13.
 */
function calculateVolumeRatio(currentVolume, baselineVolume) {
  if (currentVolume === null || currentVolume === undefined) return null;
  if (baselineVolume === null || baselineVolume === undefined) return null;
  if (baselineVolume <= 0) return null;
  return currentVolume / baselineVolume;
}

/**
 * Buy/sell volume ratio, division-by-zero safe (spec section 14).
 * Returns null if we don't have both figures.
 */
function calculateBuySellRatio(buyVolume, sellVolume) {
  if (buyVolume === null || buyVolume === undefined) return null;
  if (sellVolume === null || sellVolume === undefined) return null;
  if (sellVolume === 0) {
    return buyVolume > 0 ? Number.POSITIVE_INFINITY : null;
  }
  return buyVolume / sellVolume;
}

/**
 * Buy pressure score (0-100): combines buy/sell volume AND buy/sell counts,
 * since transaction count alone is not sufficient (spec section 14).
 */
function calculateBuyPressureScore({ buyVolume, sellVolume, buyCount, sellCount }) {
  const volumeRatio = calculateBuySellRatio(buyVolume, sellVolume);
  const totalCount = (buyCount || 0) + (sellCount || 0);
  const countRatio = totalCount > 0 ? (buyCount || 0) / totalCount : null;

  if (volumeRatio === null && countRatio === null) return null;

  // Normalize volumeRatio (which can range 0..Infinity) into 0..1 via a soft cap.
  let volumeComponent = 0.5;
  if (volumeRatio !== null) {
    const capped = Number.isFinite(volumeRatio) ? Math.min(volumeRatio, 5) : 5;
    volumeComponent = capped / (capped + 1); // maps 0->0, 1->0.5, 5->0.83
  }

  const countComponent = countRatio === null ? 0.5 : countRatio;

  // Weight volume higher than raw count, per spec section 14.
  const blended = volumeComponent * 0.7 + countComponent * 0.3;
  return Math.round(blended * 100);
}

/**
 * Liquidity quality score (0-100). Deliberately simple in V1: rewards
 * healthy absolute liquidity, penalizes very thin pools.
 */
function calculateLiquidityScore(liquidityUsd) {
  if (liquidityUsd === null || liquidityUsd === undefined) return null;
  if (liquidityUsd <= 0) return 0;

  // Piecewise-linear ramp: $0 -> 0, $10k -> 40, $50k -> 70, $200k+ -> 100.
  if (liquidityUsd < 10_000) return Math.round((liquidityUsd / 10_000) * 40);
  if (liquidityUsd < 50_000) return Math.round(40 + ((liquidityUsd - 10_000) / 40_000) * 30);
  if (liquidityUsd < 200_000) return Math.round(70 + ((liquidityUsd - 50_000) / 150_000) * 30);
  return 100;
}

/**
 * Price momentum score (0-100) from a recent price-change percentage.
 * Symmetric around 0% change = 50. Caps extreme moves rather than scaling
 * linearly forever (a token already up 2000% isn't "more momentum" than one
 * up 300% for ranking purposes here — see PUMPING classification).
 */
function calculatePriceMomentumScore(priceChangePercent) {
  if (priceChangePercent === null || priceChangePercent === undefined) return null;

  const capped = Math.max(-100, Math.min(priceChangePercent, 150));
  // Map -100%..+150% onto 0..100, centered so 0% change = 50.
  const score = 50 + (capped / 150) * 50;
  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * Overall momentum score (0-100): blends price momentum, volume growth, and
 * buy/sell pressure. Liquidity is intentionally excluded here (it's scored
 * and weighted separately in the opportunity score) to keep this a pure
 * "is trading interest increasing" measure.
 */
function calculateMomentumScore({ priceChangePercent, volumeRatio, buyPressureScore }) {
  const priceScore = calculatePriceMomentumScore(priceChangePercent);

  let volumeScore = null;
  if (volumeRatio !== null && volumeRatio !== undefined) {
    const capped = Number.isFinite(volumeRatio) ? Math.min(volumeRatio, 5) : 5;
    volumeScore = Math.round((capped / 5) * 100);
  }

  const parts = [priceScore, volumeScore, buyPressureScore].filter(
    (v) => v !== null && v !== undefined && !Number.isNaN(v)
  );

  if (parts.length === 0) return null;

  const sum = parts.reduce((acc, v) => acc + v, 0);
  return Math.round(sum / parts.length);
}

module.exports = {
  calculateVolumeRatio,
  calculateBuySellRatio,
  calculateBuyPressureScore,
  calculateLiquidityScore,
  calculatePriceMomentumScore,
  calculateMomentumScore
};
