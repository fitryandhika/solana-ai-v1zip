// lib/database/whales.js
// All reads/writes to `wallet_trades` and `wallets` — see
// migration_008_whale_tracker.sql for the honesty notes on how "smart
// money" is determined here.

const { getServiceClient } = require("./supabase");

/**
 * Records a detected trade. Idempotent on signature — rescanning the same
 * transaction (e.g. after a restart) never creates a duplicate row.
 */
async function insertWalletTrade(trade) {
  const supabase = getServiceClient();

  // The wallets row must exist BEFORE inserting into wallet_trades, since
  // wallet_trades.wallet_address has a foreign key to wallets.address.
  // Touching it here also keeps last_trade_at current without waiting for
  // the separate periodic scoring pass.
  await supabase
    .from("wallets")
    .upsert({ address: trade.walletAddress, last_trade_at: trade.tradedAt }, { onConflict: "address", ignoreDuplicates: false });

  const row = {
    wallet_address: trade.walletAddress,
    token_address: trade.tokenAddress,
    signature: trade.signature,
    direction: trade.direction,
    token_amount: trade.tokenAmount ?? null,
    usd_value: trade.usdValue ?? null,
    is_early_buy: trade.isEarlyBuy ?? false,
    traded_at: trade.tradedAt
  };

  const { error } = await supabase.from("wallet_trades").upsert(row, { onConflict: "signature", ignoreDuplicates: true });

  if (error) {
    throw new Error(`insertWalletTrade failed for ${trade.signature}: ${error.message}`);
  }
}

/**
 * Adds (or updates the label of) a manually-curated watchlist wallet — see
 * migration_008_whale_tracker.sql's `source` column. Never overwrites an
 * existing system-computed score; only sets source/label.
 */
async function addManualWallet(address, label) {
  const supabase = getServiceClient();

  const { error } = await supabase
    .from("wallets")
    .upsert({ address, source: "manual", label: label || null }, { onConflict: "address" });

  if (error) {
    throw new Error(`addManualWallet failed for ${address}: ${error.message}`);
  }
}

async function getTokenWhaleScanCursor(tokenAddress) {
  const supabase = getServiceClient();

  const { data, error } = await supabase.from("tokens").select("whale_scan_cursor").eq("address", tokenAddress).maybeSingle();

  if (error) {
    throw new Error(`getTokenWhaleScanCursor failed for ${tokenAddress}: ${error.message}`);
  }

  return data?.whale_scan_cursor || null;
}

async function setTokenWhaleScanCursor(tokenAddress, cursor) {
  const supabase = getServiceClient();

  const { error } = await supabase.from("tokens").update({ whale_scan_cursor: cursor }).eq("address", tokenAddress);

  if (error) {
    throw new Error(`setTokenWhaleScanCursor failed for ${tokenAddress}: ${error.message}`);
  }
}

/**
 * Trades within the last `hours`, with token symbol/name/image embedded —
 * used for the Smart Money Flow and Top Tokens Bought sections.
 */
async function getRecentTrades({ hours = 24, limit = 2000 } = {}) {
  const supabase = getServiceClient();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("wallet_trades")
    .select("*, tokens(symbol, name, image_url)")
    .gte("traded_at", since)
    .order("traded_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`getRecentTrades failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Most recent trades for the "Aktivitas Whale Terbaru" feed, restricted to
 * wallets that already have a computed smart_score OR are manually
 * watchlisted — random small buys from unscored wallets aren't "whale
 * activity" worth surfacing.
 */
async function getRecentWhaleActivity(limit = 20) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("wallet_trades")
    .select("*, tokens(symbol, name, image_url), wallets!inner(smart_score, source, label)")
    .or("smart_score.gte.1,source.eq.manual", { foreignTable: "wallets" })
    .order("traded_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`getRecentWhaleActivity failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Top-ranked wallets by smart_score. Only wallets with a non-null score
 * (i.e. enough evidence) or manual watchlist wallets are returned.
 */
async function getTopSmartMoney(limit = 20) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("wallets")
    .select("*")
    .or("smart_score.not.is.null,source.eq.manual")
    .order("smart_score", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new Error(`getTopSmartMoney failed: ${error.message}`);
  }

  return data || [];
}

/**
 * All wallets with at least one trade, for the periodic scoring pass.
 */
async function getWalletsToScore() {
  const supabase = getServiceClient();

  const { data, error } = await supabase.from("wallets").select("address").not("last_trade_at", "is", null);

  if (error) {
    throw new Error(`getWalletsToScore failed: ${error.message}`);
  }

  return (data || []).map((w) => w.address);
}

/**
 * A wallet's early-buy trades joined with each token's recorded outcome —
 * the input to computeWalletScore in lib/analyzer/whale-stats.js.
 */
async function getEarlyBuysWithOutcomes(walletAddress) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("wallet_trades")
    .select("*, outcome:token_outcomes(price_change_pct_1h)")
    .eq("wallet_address", walletAddress)
    .eq("direction", "buy")
    .eq("is_early_buy", true);

  if (error) {
    throw new Error(`getEarlyBuysWithOutcomes failed for ${walletAddress}: ${error.message}`);
  }

  return (data || []).map((row) => ({
    ...row,
    outcome: Array.isArray(row.outcome) ? row.outcome[0] : row.outcome
  }));
}

async function updateWalletScore(address, { smartScore, earlyBuyCount, earlyWinCount, totalBuyUsd }) {
  const supabase = getServiceClient();

  const { error } = await supabase
    .from("wallets")
    .update({
      smart_score: smartScore,
      early_buy_count: earlyBuyCount,
      early_win_count: earlyWinCount,
      total_buy_usd: totalBuyUsd
    })
    .eq("address", address);

  if (error) {
    throw new Error(`updateWalletScore failed for ${address}: ${error.message}`);
  }
}

async function getWalletScoresByAddresses(addresses) {
  if (!addresses || addresses.length === 0) return new Map();
  const supabase = getServiceClient();

  const { data, error } = await supabase.from("wallets").select("address, smart_score").in("address", addresses);

  if (error) {
    throw new Error(`getWalletScoresByAddresses failed: ${error.message}`);
  }

  return new Map((data || []).map((w) => [w.address, w.smart_score]));
}

module.exports = {
  insertWalletTrade,
  addManualWallet,
  getTokenWhaleScanCursor,
  setTokenWhaleScanCursor,
  getRecentTrades,
  getRecentWhaleActivity,
  getTopSmartMoney,
  getWalletsToScore,
  getEarlyBuysWithOutcomes,
  updateWalletScore,
  getWalletScoresByAddresses
};
