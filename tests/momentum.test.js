const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateVolumeRatio,
  calculateBuySellRatio,
  calculateBuyPressureScore,
  calculateLiquidityScore,
  calculatePriceMomentumScore,
  calculateMomentumScore
} = require("../lib/analyzer/momentum");

test("calculateVolumeRatio returns null without a baseline", () => {
  assert.equal(calculateVolumeRatio(100, null), null);
  assert.equal(calculateVolumeRatio(100, undefined), null);
  assert.equal(calculateVolumeRatio(100, 0), null);
});

test("calculateVolumeRatio computes acceleration correctly", () => {
  assert.equal(calculateVolumeRatio(200, 100), 2);
  assert.equal(calculateVolumeRatio(50, 100), 0.5);
});

test("calculateBuySellRatio handles division by zero safely", () => {
  assert.equal(calculateBuySellRatio(100, 0), Infinity);
  assert.equal(calculateBuySellRatio(0, 0), null);
  assert.equal(calculateBuySellRatio(null, 100), null);
});

test("calculateBuySellRatio computes normal ratios", () => {
  assert.equal(calculateBuySellRatio(150, 50), 3);
});

test("calculateBuyPressureScore blends volume and count ratios", () => {
  const score = calculateBuyPressureScore({
    buyVolume: 800,
    sellVolume: 200,
    buyCount: 40,
    sellCount: 10
  });
  assert.ok(score > 60, `expected strong buy pressure score, got ${score}`);
});

test("calculateBuyPressureScore returns null with no data", () => {
  assert.equal(calculateBuyPressureScore({}), null);
});

test("calculateLiquidityScore ramps from 0 to 100", () => {
  assert.equal(calculateLiquidityScore(0), 0);
  assert.equal(calculateLiquidityScore(200_000), 100);
  assert.ok(calculateLiquidityScore(10_000) < calculateLiquidityScore(50_000));
});

test("calculatePriceMomentumScore centers at 50 for 0% change", () => {
  assert.equal(calculatePriceMomentumScore(0), 50);
  assert.ok(calculatePriceMomentumScore(50) > 50);
  assert.ok(calculatePriceMomentumScore(-50) < 50);
});

test("calculateMomentumScore averages available components", () => {
  const score = calculateMomentumScore({
    priceChangePercent: 30,
    volumeRatio: 2,
    buyPressureScore: 70
  });
  assert.ok(score > 50 && score <= 100);
});

test("calculateMomentumScore returns null when nothing is available", () => {
  assert.equal(
    calculateMomentumScore({ priceChangePercent: null, volumeRatio: null, buyPressureScore: null }),
    null
  );
});
