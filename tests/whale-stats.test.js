const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeSmartMoneyFlow,
  computeTopTokensBought,
  computeWalletScore,
  computeAiWhaleInsight,
  MIN_WALLET_TRADES_FOR_SCORE,
  WIN_THRESHOLD_PCT
} = require("../lib/analyzer/whale-stats");

test("computeSmartMoneyFlow sums buys and sells and labels bullish", () => {
  const trades = [
    { direction: "buy", usd_value: 1000 },
    { direction: "buy", usd_value: 500 },
    { direction: "sell", usd_value: 300 }
  ];
  const result = computeSmartMoneyFlow(trades);
  assert.equal(result.inflowUsd, 1500);
  assert.equal(result.outflowUsd, 300);
  assert.equal(result.netFlowUsd, 1200);
  assert.equal(result.label, "BULLISH");
});

test("computeSmartMoneyFlow labels bearish when sells exceed buys", () => {
  const trades = [
    { direction: "buy", usd_value: 100 },
    { direction: "sell", usd_value: 900 }
  ];
  const result = computeSmartMoneyFlow(trades);
  assert.equal(result.netFlowUsd, -800);
  assert.equal(result.label, "BEARISH");
});

test("computeSmartMoneyFlow ignores trades with unknown usd_value", () => {
  const trades = [
    { direction: "buy", usd_value: 100 },
    { direction: "buy", usd_value: null }
  ];
  const result = computeSmartMoneyFlow(trades);
  assert.equal(result.inflowUsd, 100);
});

test("computeTopTokensBought ranks by net buy usd and excludes net-negative tokens", () => {
  const trades = [
    { token_address: "A", direction: "buy", usd_value: 1000, tokens: { symbol: "AAA" } },
    { token_address: "A", direction: "sell", usd_value: 200, tokens: { symbol: "AAA" } },
    { token_address: "B", direction: "buy", usd_value: 5000, tokens: { symbol: "BBB" } },
    { token_address: "C", direction: "sell", usd_value: 500, tokens: { symbol: "CCC" } } // net negative — excluded
  ];
  const result = computeTopTokensBought(trades);
  assert.equal(result.length, 2);
  assert.equal(result[0].tokenAddress, "B");
  assert.equal(result[0].netUsd, 5000);
  assert.equal(result[1].tokenAddress, "A");
  assert.equal(result[1].netUsd, 800);
});

test("computeTopTokensBought respects the limit", () => {
  const trades = Array.from({ length: 15 }, (_, i) => ({
    token_address: `T${i}`,
    direction: "buy",
    usd_value: 100 + i,
    tokens: {}
  }));
  const result = computeTopTokensBought(trades, 5);
  assert.equal(result.length, 5);
});

test("computeWalletScore returns null when below the minimum sample size", () => {
  const buys = [
    { outcome: { price_change_pct_1h: 50 } },
    { outcome: { price_change_pct_1h: 30 } }
  ];
  assert.ok(buys.length < MIN_WALLET_TRADES_FOR_SCORE);
  const result = computeWalletScore(buys);
  assert.equal(result.smartScore, null);
});

test("computeWalletScore computes win rate using the win threshold", () => {
  const buys = [
    { outcome: { price_change_pct_1h: 50 } }, // win (>= 20%)
    { outcome: { price_change_pct_1h: 25 } }, // win
    { outcome: { price_change_pct_1h: 10 } }, // not a win
    { outcome: { price_change_pct_1h: -30 } } // not a win
  ];
  assert.ok(WIN_THRESHOLD_PCT === 20);
  const result = computeWalletScore(buys);
  assert.equal(result.smartScore, 50); // 2/4 wins = 50%
  assert.equal(result.earlyBuyCount, 4);
  assert.equal(result.earlyWinCount, 2);
});

test("computeWalletScore excludes buys with unknown outcome from the score calc", () => {
  const buys = [
    { outcome: { price_change_pct_1h: 50 } },
    { outcome: { price_change_pct_1h: 30 } },
    { outcome: { price_change_pct_1h: 25 } },
    { outcome: null } // outcome not known yet — shouldn't count toward denominator
  ];
  const result = computeWalletScore(buys);
  assert.equal(result.earlyBuyCount, 4); // total tracked buys still 4
  assert.equal(result.smartScore, 100); // but score is out of the 3 with known outcomes, all wins
});

test("computeAiWhaleInsight returns null when there is no top token", () => {
  assert.equal(computeAiWhaleInsight(null, [], new Map()), null);
});

test("computeAiWhaleInsight averages known wallet scores and labels accordingly", () => {
  const topToken = { tokenAddress: "A", symbol: "AAA", netUsd: 5000 };
  const buyTrades = [
    { wallet_address: "w1" },
    { wallet_address: "w2" },
    { wallet_address: "w3" } // no score yet
  ];
  const scores = new Map([
    ["w1", 80],
    ["w2", 60]
  ]);
  const result = computeAiWhaleInsight(topToken, buyTrades, scores);
  assert.equal(result.walletCount, 3);
  assert.equal(result.aiScore, 70); // avg(80,60)
  assert.equal(result.label, "POSITIVE");
});

test("computeAiWhaleInsight returns null aiScore when no buyers have a score yet", () => {
  const topToken = { tokenAddress: "A", symbol: "AAA", netUsd: 1000 };
  const buyTrades = [{ wallet_address: "w1" }];
  const result = computeAiWhaleInsight(topToken, buyTrades, new Map());
  assert.equal(result.aiScore, null);
  assert.equal(result.label, null);
}); 
