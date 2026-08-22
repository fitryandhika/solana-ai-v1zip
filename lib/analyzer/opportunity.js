// lib/analyzer/opportunity.js
//
// Deterministic Opportunity Score (0-100) per spec section 15:
//   Volume Acceleration      25%
//   Buy/Sell Pressure        20%
//   Liquidity Quality        20%
//   Price Momentum           20%
//   Early Token Stage        15%
//
// This score is a RANKING METRIC, not a probability (spec section 16) — it
// must never be displayed or described as a percentage chance.
//
// Also implements the signal classifier (spec section 18) and early-stage
// logic that avoids blindly rewarding tokens that already pumped hard
// (spec section 17).

const {
  calculateVolumeRatio,
  calculateBuyPressureScore,
  calculateLiquidityScore,
  calculatePriceMomentumScore
} = require("./momentum");

const WEIGHTS = {
  volumeAcceleration: 0.25,
  buySellPressure: 0.2,
  liquidityQuality: 0.2,
  priceMomentum: 0.2,
  earlyStage: 0.15
};

// Configurable thresholds (spec section 18: "must be configurable").
// Can be overridden via environment variables without code changes.
const THRESHOLDS = {
  veryEarlyMaxAgeMinutes: Number(process.env.SIGNAL_VERY_EARLY_MAX_AGE_MIN || 15),
  earlyMaxAgeMinutes: Number(process.env.SIGNAL_EARLY_MAX_AGE_MIN || 60),
  pumpingPriceChangePercent: Number(process.env.SIGNAL_PUMPING_PRICE_CHANGE_PCT || 150),
  lowActivityVolumeUsd: Number(process.env.SIGNAL_LOW_ACTIVITY_VOLUME_USD || 500)
};

/**
 * Volume acceleration sub-score (0-100). Returns null if we lack a baseline
 * (insufficient history) — a null component is excluded from the weighted
 * average rather than treated as 0 (spec section 13).
 */
function volumeAccelerationScore(volumeRatio) {
  if (volumeRatio === null || volumeRatio === undefined) return null;
  const capped = Number.isFinite(volumeRatio) ? Math.min(volumeRatio, 5) : 5;
  return Math.round((capped / 5) * 100);
}

/**
 * Early-stage sub-score (0-100): favors young tokens with real activity,
 * without rewarding tokens purely for having already spiked in price.
 */
function earlyStageScore({ ageMinutes, hasActivity }) {
  if (ageMinutes === null || ageMinutes === undefined) return null;
  if (!hasActivity) return 10;

  if (ageMinutes <= THRESHOLDS.veryEarlyMaxAgeMinutes) return 100;
  if (ageMinutes <= THRESHOLDS.earlyMaxAgeMinutes) {
    // Linear decay from 100 down to 60 across the "early" window.
    const span = THRESHOLDS.earlyMaxAgeMinutes - THRESHOLDS.veryEarlyMaxAgeMinutes;
    const progress = (ageMinutes - THRESHOLDS.veryEarlyMaxAgeMinutes) / span;
    return Math.round(100 - progress * 40);
  }
  if (ageMinutes <= 24 * 60) {
    // Gentle decay across the rest of day 1.
    const progress = Math.min(1, (ageMinutes - THRESHOLDS.earlyMaxAgeMinutes) / (24 * 60));
    return Math.round(60 - progress * 40);
  }
  return 10;
}

/**
 * Weighted-average combine, skipping any null components and renormalizing
 * weights across whatever is actually available. This keeps the score
 * meaningful even with partial data instead of silently treating missing
 * data as zero.
 */
function weightedCombine(components) {
  let weightSum = 0;
  let scoreSum = 0;

  for (const { score, weight } of components) {
    if (score === null || score === undefined || Number.isNaN(score)) continue;
    weightSum += weight;
    scoreSum += score * weight;
  }

  if (weightSum === 0) return null;
  return Math.round(scoreSum / weightSum);
}

/**
 * Compute the full Opportunity Score (0-100) plus its sub-components, given
 * a normalized token snapshot with derived metrics attached.
 *
 * Input shape:
 * {
 *   priceChangePercent, volumeRatio, buyVolume, sellVolume, buyCount, sellCount,
 *   liquidityUsd, ageMinutes, hasActivity
 * }
 */
function calculateOpportunityScore(input) {
  const buyPressure = calculateBuyPressureScore({
    buyVolume: input.buyVolume,
    sellVolume: input.sellVolume,
    buyCount: input.buyCount,
    sellCount: input.sellCount
  });

  const liquidity = calculateLiquidityScore(input.liquidityUsd);
  const priceMomentum = calculatePriceMomentumScore(input.priceChangePercent);
  const volumeAccel = volumeAccelerationScore(input.volumeRatio);
  const earlyStage = earlyStageScore({ ageMinutes: input.ageMinutes, hasActivity: input.hasActivity });

  const opportunityScore = weightedCombine([
    { score: volumeAccel, weight: WEIGHTS.volumeAcceleration },
    { score: buyPressure, weight: WEIGHTS.buySellPressure },
    { score: liquidity, weight: WEIGHTS.liquidityQuality },
    { score: priceMomentum, weight: WEIGHTS.priceMomentum },
    { score: earlyStage, weight: WEIGHTS.earlyStage }
  ]);

  return {
    opportunityScore,
    components: {
      volumeAcceleration: volumeAccel,
      buySellPressure: buyPressure,
      liquidityQuality: liquidity,
      priceMomentum,
      earlyStage
    }
  };
}

/**
 * Classify a token into one of the basic signals (spec section 18).
 * Thresholds are configurable via THRESHOLDS above.
 */
function classifySignal({ ageMinutes, volumeRatio, buyPressureScore, priceChangePercent, hasActivity }) {
  if (!hasActivity) return "LOW_ACTIVITY";

  if (
    priceChangePercent !== null &&
    priceChangePercent !== undefined &&
    priceChangePercent >= THRESHOLDS.pumpingPriceChangePercent
  ) {
    return "PUMPING";
  }

  const volumeIncreasing = volumeRatio !== null && volumeRatio !== undefined && volumeRatio > 1;
  const buyPressurePositive = buyPressureScore !== null && buyPressureScore !== undefined && buyPressureScore > 55;
  const positiveMomentum =
    priceChangePercent !== null && priceChangePercent !== undefined && priceChangePercent > 0;

  if (ageMinutes !== null && ageMinutes !== undefined && ageMinutes < THRESHOLDS.veryEarlyMaxAgeMinutes) {
    return "VERY_EARLY";
  }

  if (positiveMomentum && volumeIncreasing && buyPressurePositive) {
    if (ageMinutes !== null && ageMinutes !== undefined && ageMinutes <= THRESHOLDS.earlyMaxAgeMinutes) {
      return "EARLY";
    }
    return "MOMENTUM";
  }

  if (volumeIncreasing && positiveMomentum) {
    return "MOMENTUM";
  }

  return "LOW_ACTIVITY";
}

module.exports = {
  calculateOpportunityScore,
  classifySignal,
  volumeAccelerationScore,
  earlyStageScore,
  weightedCombine,
  WEIGHTS,
  THRESHOLDS
};
