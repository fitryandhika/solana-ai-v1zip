// lib/database/snapshots.js
// All reads/writes to the `token_snapshots` table.

const { getServiceClient } = require("./supabase");

/**
 * Insert one snapshot row. Snapshots are append-only — we never update or
 * delete old ones (see spec section 11 / 48: history is preserved for future
 * AI training).
 */
async function insertSnapshot(snapshot) {
  const supabase = getServiceClient();

  const row = {
    token_address: snapshot.address,
    price: snapshot.price ?? null,
    liquidity: snapshot.liquidity ?? null,
    market_cap: snapshot.marketCap ?? null,

    volume_1m: snapshot.volume1m ?? null,
    volume_5m: snapshot.volume5m ?? null,
    volume_15m: snapshot.volume15m ?? null,

    // NOTE: DexScreener's public API only exposes 5-minute buy/sell counts,
    // never true 1-minute data — these columns are named accordingly. See
    // migration_003_fix_buy_sell_naming.sql for why they replaced buys_1m/
    // sells_1m, which held the same data under a misleading name.
    buys_5m: snapshot.buys5m ?? null,
    sells_5m: snapshot.sells5m ?? null,

    buy_volume_1m: snapshot.buyVolume1m ?? null,
    sell_volume_1m: snapshot.sellVolume1m ?? null,

    price_change_1m: snapshot.priceChange1m ?? null,
    price_change_5m: snapshot.priceChange5m ?? null,
    price_change_15m: snapshot.priceChange15m ?? null,

    momentum_score: snapshot.momentumScore ?? null,
    opportunity_score: snapshot.opportunityScore ?? null,

    signal: snapshot.signal ?? null,
    data_status: snapshot.dataStatus || "ok",

    source: snapshot.source || "dexscreener",

    sol_price_usd: snapshot.solPriceUsd ?? null
  };

  const { data, error } = await supabase.from("token_snapshots").insert(row).select().single();

  if (error) {
    throw new Error(`insertSnapshot failed for ${snapshot.address}: ${error.message}`);
  }

  return data;
}

/**
 * Get the most recent snapshot for a token.
 */
async function getLatestSnapshot(address) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("token_snapshots")
    .select("*")
    .eq("token_address", address)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`getLatestSnapshot failed for ${address}: ${error.message}`);
  }

  return data;
}

/**
 * Get recent snapshots for a token (oldest -> newest), for charting/backtesting.
 */
async function getRecentSnapshots(address, limit = 200) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("token_snapshots")
    .select("*")
    .eq("token_address", address)
    .order("timestamp", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`getRecentSnapshots failed for ${address}: ${error.message}`);
  }

  return (data || []).reverse();
}

/**
 * Get the latest snapshot for a specific set of tokens (used for the main
 * dashboard table). Scoped to `addresses` so the query cost stays bounded by
 * how many tokens the dashboard actually displays, not by how large
 * token_snapshots has grown overall — a table-wide scan gets slower and
 * slower as the scanner keeps writing snapshots, eventually timing out.
 */
async function getLatestSnapshotsForAllTokens({ addresses = [], perTokenBudget = 5 } = {}) {
  const supabase = getServiceClient();

  if (addresses.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("token_snapshots")
    .select("*")
    .in("token_address", addresses)
    .order("timestamp", { ascending: false })
    .limit(addresses.length * perTokenBudget);

  if (error) {
    throw new Error(`getLatestSnapshotsForAllTokens failed: ${error.message}`);
  }

  const latestByAddress = new Map();
  for (const row of data || []) {
    if (!latestByAddress.has(row.token_address)) {
      latestByAddress.set(row.token_address, row);
    }
  }

  return Array.from(latestByAddress.values());
}

/**
 * Find the snapshot closest to `minutesAgo` minutes before now for a token,
 * used as a volume baseline for acceleration calculations.
 */
async function getBaselineSnapshot(address, minutesAgo) {
  const supabase = getServiceClient();
  const cutoff = new Date(Date.now() - minutesAgo * 60000).toISOString();

  const { data, error } = await supabase
    .from("token_snapshots")
    .select("*")
    .eq("token_address", address)
    .lte("timestamp", cutoff)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`getBaselineSnapshot failed for ${address}: ${error.message}`);
  }

  return data;
}

/**
 * Find the earliest snapshot at or after `targetTimestamp` for a token —
 * used to evaluate "what was the price/liquidity around X time after
 * discovery" for the outcome horizons in lib/analyzer/outcomes.js. Given
 * how densely snapshots are taken in a token's first 24h (see
 * DENSE_SNAPSHOT_WINDOW_MS in worker/scanner.js), this lands within a few
 * seconds of the true target time.
 */
async function getSnapshotAtOrAfter(address, targetTimestamp) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("token_snapshots")
    .select("*")
    .eq("token_address", address)
    .gte("timestamp", targetTimestamp)
    .order("timestamp", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`getSnapshotAtOrAfter failed for ${address}: ${error.message}`);
  }

  return data;
}

/**
 * The earliest snapshot recorded for a token — used as the discovery
 * baseline when backfilling token_outcomes for tokens that were already
 * being tracked before outcome tracking existed.
 */
async function getFirstSnapshot(address) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("token_snapshots")
    .select("*")
    .eq("token_address", address)
    .order("timestamp", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`getFirstSnapshot failed for ${address}: ${error.message}`);
  }

  return data;
}

/**
 * Total number of successful ("ok") snapshots ever recorded — used to
 * resume the in-memory analyzed-count after a scanner restart, matching
 * getTotalTokenCount in lib/database/tokens.js.
 */
async function getTotalAnalyzedCount() {
  const supabase = getServiceClient();

  const { count, error } = await supabase
    .from("token_snapshots")
    .select("*", { count: "exact", head: true })
    .eq("data_status", "ok");

  if (error) {
    throw new Error(`getTotalAnalyzedCount failed: ${error.message}`);
  }

  return count || 0;
}

module.exports = {
  insertSnapshot,
  getLatestSnapshot,
  getRecentSnapshots,
  getLatestSnapshotsForAllTokens,
  getBaselineSnapshot,
  getSnapshotAtOrAfter,
  getFirstSnapshot,
  getTotalAnalyzedCount
};
