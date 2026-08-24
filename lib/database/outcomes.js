// lib/database/outcomes.js
// All reads/writes to the `token_outcomes` table — the evaluation dataset
// described in migration_004_outcomes.sql.

const { getServiceClient } = require("./supabase");

/**
 * Create the initial outcome row at the moment a token is discovered,
 * capturing the conditions that will later be evaluated against.
 */
async function insertInitialOutcome({
  address,
  discoveredAt,
  discoveryPrice,
  discoveryLiquidity,
  discoveryMarketCap,
  discoveryOpportunityScore,
  discoverySignal
}) {
  const supabase = getServiceClient();

  const row = {
    token_address: address,
    discovered_at: discoveredAt,
    discovery_price: discoveryPrice ?? null,
    discovery_liquidity: discoveryLiquidity ?? null,
    discovery_market_cap: discoveryMarketCap ?? null,
    discovery_opportunity_score: discoveryOpportunityScore ?? null,
    discovery_signal: discoverySignal ?? null
  };

  const { error } = await supabase.from("token_outcomes").upsert(row, { onConflict: "token_address" });

  if (error) {
    throw new Error(`insertInitialOutcome failed for ${address}: ${error.message}`);
  }
}

/**
 * Patch in the fields for one (or more) horizons once they're computed.
 * Partial — only overwrites the keys present in `patch`.
 */
async function updateOutcome(address, patch) {
  const supabase = getServiceClient();

  const { error } = await supabase
    .from("token_outcomes")
    .update(patch)
    .eq("token_address", address);

  if (error) {
    throw new Error(`updateOutcome failed for ${address}: ${error.message}`);
  }
}

/**
 * Addresses whose outcome record is already fully finalized (24h horizon
 * computed) — used at startup so a restart doesn't re-check tokens that
 * will never need another update.
 */
async function getFinalizedAddresses() {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("token_outcomes")
    .select("token_address")
    .not("finalized_at", "is", null);

  if (error) {
    throw new Error(`getFinalizedAddresses failed: ${error.message}`);
  }

  return (data || []).map((row) => row.token_address);
}

/**
 * Fetches full outcome rows for tokens that aren't finalized yet, for the
 * given addresses. Used at startup to rebuild the in-memory discovery
 * price/liquidity and already-computed-horizons state — without this, a
 * restart would silently stop outcome tracking for every token still
 * mid-way through its 24h window.
 */
async function getInProgressOutcomes(addresses) {
  if (!addresses || addresses.length === 0) return [];
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("token_outcomes")
    .select("*")
    .in("token_address", addresses)
    .is("finalized_at", null);

  if (error) {
    throw new Error(`getInProgressOutcomes failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Fetches outcome rows for statistical analysis (AI Performance, chart,
 * accuracy-by-horizon, observed patterns), with discovery-time token
 * context embedded via the foreign key relationship. Bounded by `limit` —
 * generous enough for the current data volume without risking an
 * unbounded payload as the dataset grows for months.
 */
async function getOutcomesForAnalysis({ limit = 5000 } = {}) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("token_outcomes")
    .select("*, tokens(source, mint_authority_revoked, top10_holder_pct, creator_prior_rug_count)")
    .order("discovered_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`getOutcomesForAnalysis failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Paginated prediction history for the "Riwayat AI" table — one row per
 * token with its discovery-time prediction and actual outcome so far.
 */
async function getPredictionHistory({ limit = 50, offset = 0 } = {}) {
  const supabase = getServiceClient();

  const { data, error, count } = await supabase
    .from("token_outcomes")
    .select("*, tokens(symbol, name, image_url)", { count: "exact" })
    .order("discovered_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`getPredictionHistory failed: ${error.message}`);
  }

  return { rows: data || [], total: count || 0 };
}

module.exports = {
  insertInitialOutcome,
  updateOutcome,
  getFinalizedAddresses,
  getInProgressOutcomes,
  getOutcomesForAnalysis,
  getPredictionHistory
};
