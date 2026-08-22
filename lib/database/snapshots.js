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

    buys_1m: snapshot.buys1m ?? null,
    sells_1m: snapshot.sells1m ?? null,

    buy_volume_1m: snapshot.buyVolume1m ?? null,
    sell_volume_1m: snapshot.sellVolume1m ?? null,

    price_change_1m: snapshot.priceChange1m ?? null,
    price_change_5m: snapshot.priceChange5m ?? null,
    price_change_15m: snapshot.priceChange15m ?? null,

    momentum_score: snapshot.momentumScore ?? null,
    opportunity_score: snapshot.opportunityScore ?? null,

    signal: snapshot.signal ?? null,
    data_status: snapshot.dataStatus || "ok",

    source: snapshot.source || "dexscreener"
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
 * Get the latest snapshot for every token (used for the main dashboard table).
 * Uses a Postgres distinct-on-style query via RPC-free approach: pull latest
 * N snapshots per token by first fetching latest snapshot ids is not directly
 * expressible in the JS client, so we fetch a generous window ordered by time
 * and reduce to one-per-token in application code.
 */
async function getLatestSnapshotsForAllTokens({ windowSize = 1000 } = {}) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("token_snapshots")
    .select("*")
    .order("timestamp", { ascending: false })
    .limit(windowSize);

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

module.exports = {
  insertSnapshot,
  getLatestSnapshot,
  getRecentSnapshots,
  getLatestSnapshotsForAllTokens,
  getBaselineSnapshot
};
