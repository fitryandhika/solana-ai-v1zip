const test = require("node:test");
const assert = require("node:assert/strict");

const { calculateOpportunityScore, classifySignal } = require("../lib/analyzer/opportunity");

// Spec section 45: predictable, deterministic scoring test cases.

test("strong signals across the board produce a high opportunity score", () => {
  const { opportunityScore, components } = calculateOpportunityScore({
    priceChangePercent: 40,
    volumeRatio: 3,
    buyVolume: 900,
    sellVolume: 100,
    buyCount: 50,
    sellCount: 5,
    liquidityUsd: 150_000,
    ageMinutes: 8,
    hasActivity: true
  });

  assert.ok(opportunityScore >= 75, `expected high score, got ${opportunityScore}`);
  assert.ok(components.earlyStage === 100);
});

test("weak signals across the board produce a low opportunity score", () => {
  const { opportunityScore } = calculateOpportunityScore({
    priceChangePercent: -10,
    volumeRatio: 0.3,
    buyVolume: 50,
    sellVolume: 200,
    buyCount: 3,
    sellCount: 15,
    liquidityUsd: 2_000,
    ageMinutes: 500,
    hasActivity: true
  });

  assert.ok(opportunityScore <= 40, `expected low score, got ${opportunityScore}`);
});

test("missing data (no baseline) does not crash and excludes that component", () => {
  const { opportunityScore, components } = calculateOpportunityScore({
    priceChangePercent: 10,
    volumeRatio: null,
    buyVolume: null,
    sellVolume: null,
    buyCount: null,
    sellCount: null,
    liquidityUsd: 30_000,
    ageMinutes: 20,
    hasActivity: true
  });

  assert.equal(components.volumeAcceleration, null);
  assert.equal(components.buySellPressure, null);
  assert.ok(typeof opportunityScore === "number");
});

test("classifySignal: very young token with activity is VERY_EARLY", () => {
  const signal = classifySignal({
    ageMinutes: 5,
    volumeRatio: 1.2,
    buyPressureScore: 60,
    priceChangePercent: 5,
    hasActivity: true
  });
  assert.equal(signal, "VERY_EARLY");
});

test("classifySignal: large recent price increase is PUMPING regardless of age", () => {
  const signal = classifySignal({
    ageMinutes: 200,
    volumeRatio: 2,
    buyPressureScore: 70,
    priceChangePercent: 300,
    hasActivity: true
  });
  assert.equal(signal, "PUMPING");
});

test("classifySignal: no activity is LOW_ACTIVITY", () => {
  const signal = classifySignal({
    ageMinutes: 30,
    volumeRatio: null,
    buyPressureScore: null,
    priceChangePercent: null,
    hasActivity: false
  });
  assert.equal(signal, "LOW_ACTIVITY");
});

test("classifySignal: older token with sustained positive momentum is MOMENTUM", () => {
  const signal = classifySignal({
    ageMinutes: 300,
    volumeRatio: 1.5,
    buyPressureScore: 65,
    priceChangePercent: 20,
    hasActivity: true
  });
  assert.equal(signal, "MOMENTUM");
});
