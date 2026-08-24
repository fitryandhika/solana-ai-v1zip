// lib/analyzer/whale-stats.js
//
// Pure computation over wallet_trades rows for the Whale Tracker dashboard.
// No DB or network calls here. See migration_008_whale_tracker.sql for the
// honesty notes on how "smart money" is determined — every score here
// comes from our own recorded trade + outcome evidence, never an external
// unverified label.

// A wallet needs at least this many tracked early buys before it gets a
// smart_score at all — below this, we don't have enough evidence either
// way, and showing a score would overstate confidence in a tiny sample.
const MIN_WALLET_TRADES_FOR_SCORE = 3;

// An early buy counts as a "win" if the token's price was up at least this
// much by the reference horizon. A token merely being flat isn't a win.
const WIN_THRESHOLD_PCT = 20;

/**
 * Net smart-money flow within a time window: total buy $ vs sell $ across
 * all given trades, plus a simple bullish/bearish label.
 */
function computeSmartMoneyFlow(trades) {
  let inflow = 0;
  let outflow = 0;

  for (const t of trades) {
    if (t.usd_value === null || t.usd_value === undefined) continue;
    if (t.direction === "buy") inflow += t.usd_value;
    else if (t.direction === "sell") outflow += t.usd_value;
  }

  const netFlow = inflow - outflow;

  return {
    inflowUsd: inflow,
    outflowUsd: outflow,
    netFlowUsd: netFlow,
    label: netFlow > 0 ? "BULLISH" : netFlow < 0 ? "BEARISH" : "NEUTRAL"
  };
}

/**
 * Tokens with the most net whale buy $ within the window, most-bought
 * first. `trades` rows are expected to have a nested `tokens` object with
 * { symbol, name } from the embedded Supabase select.
 */
function computeTopTokensBought(trades, limit = 10) {
  const byToken = new Map();

  for (const t of trades) {
    if (t.usd_value === null || t.usd_value === undefined) continue;
    const signedValue = t.direction === "buy" ? t.usd_value : -t.usd_value;

    if (!byToken.has(t.token_address)) {
      byToken.set(t.token_address, {
        tokenAddress: t.token_address,
        symbol: t.tokens?.symbol || null,
        name: t.tokens?.name || null,
        imageUrl: t.tokens?.image_url || null,
        netUsd: 0
      });
    }
    byToken.get(t.token_address).netUsd += signedValue;
  }

  return Array.from(byToken.values())
    .filter((t) => t.netUsd > 0)
    .sort((a, b) => b.netUsd - a.netUsd)
    .slice(0, limit);
}

/**
 * Computes a wallet's smart_score from its early-buy trades joined with
 * each token's recorded outcome. `earlyBuysWithOutcome` rows are expected
 * to have { price_change_pct_1h } (or whichever reference horizon) from
 * the embedded token_outcomes select. Returns null score (not 0) when
 * there isn't enough evidence yet.
 */
function computeWalletScore(earlyBuysWithOutcome) {
  const withKnownOutcome = earlyBuysWithOutcome.filter(
    (t) => t.outcome && t.outcome.price_change_pct_1h !== null && t.outcome.price_change_pct_1h !== undefined
  );

  const earlyBuyCount = earlyBuysWithOutcome.length;

  if (withKnownOutcome.length < MIN_WALLET_TRADES_FOR_SCORE) {
    return { smartScore: null, earlyBuyCount, earlyWinCount: null };
  }

  const wins = withKnownOutcome.filter((t) => t.outcome.price_change_pct_1h >= WIN_THRESHOLD_PCT).length;
  const smartScore = Math.round((wins / withKnownOutcome.length) * 100);

  return { smartScore, earlyBuyCount, earlyWinCount: wins };
}

/**
 * "AI Whale Insight" for the top-accumulated token — deliberately NOT an
 * opaque black-box number. aiScore is the average smart_score of the
 * distinct wallets buying this token (when any have a score yet), so it's
 * always traceable back to real wallet evidence. Null (not a fabricated
 * default) when none of the buyers have a score yet.
 */
function computeAiWhaleInsight(topToken, buyTrades, walletScoreByAddress) {
  if (!topToken) return null;

  const distinctWallets = new Set(buyTrades.map((t) => t.wallet_address));
  const scores = Array.from(distinctWallets)
    .map((w) => walletScoreByAddress.get(w))
    .filter((s) => s !== null && s !== undefined);

  const aiScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  return {
    tokenAddress: topToken.tokenAddress,
    symbol: topToken.symbol,
    name: topToken.name,
    imageUrl: topToken.imageUrl,
    walletCount: distinctWallets.size,
    totalUsd: topToken.netUsd,
    aiScore,
    label: aiScore === null ? null : aiScore >= 60 ? "POSITIVE" : aiScore >= 40 ? "NEUTRAL" : "CAUTION"
  };
}

module.exports = {
  MIN_WALLET_TRADES_FOR_SCORE,
  WIN_THRESHOLD_PCT,
  computeSmartMoneyFlow,
  computeTopTokensBought,
  computeWalletScore,
  computeAiWhaleInsight
};
