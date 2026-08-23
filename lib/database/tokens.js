// lib/database/tokens.js
// All reads/writes to the `tokens` table go through here. Nothing else in the
// app should touch Supabase directly for token records.

const { getServiceClient } = require("./supabase");

/**
 * Insert a token if it doesn't already exist (by address). Idempotent.
 * Returns the token row (existing or newly created).
 */
async function upsertToken(token) {
  const supabase = getServiceClient();

  const row = {
    address: token.address,
    name: token.name || null,
    symbol: token.symbol || null,
    pair_address: token.pairAddress || null,
    dex: token.dex || null,
    creator: token.creator || null,
    pair_created_at: token.pairCreatedAt || null,

    source: token.source || null,
    age_at_discovery_minutes: token.ageAtDiscoveryMinutes ?? null,

    mint_authority_revoked: token.mintAuthorityRevoked ?? null,
    freeze_authority_revoked: token.freezeAuthorityRevoked ?? null,
    rug_check_at: token.rugCheckAt || null,
    rug_check_error: token.rugCheckError || null,

    website_url: token.websiteUrl || null,
    twitter_url: token.twitterUrl || null,
    telegram_url: token.telegramUrl || null,

    top10_holder_pct: token.top10HolderPct ?? null,

    creator_prior_token_count: token.creatorPriorTokenCount ?? null,
    creator_prior_rug_count: token.creatorPriorRugCount ?? null,
    creator_prior_avg_price_change_pct_24h: token.creatorPriorAvgPriceChangePct24h ?? null
  };

  const { data, error } = await supabase
    .from("tokens")
    .upsert(row, { onConflict: "address", ignoreDuplicates: false })
    .select()
    .single();

  if (error) {
    throw new Error(`upsertToken failed for ${token.address}: ${error.message}`);
  }

  return data;
}

/**
 * Fetch a single token by address.
 */
async function getTokenByAddress(address) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("tokens")
    .select("*")
    .eq("address", address)
    .maybeSingle();

  if (error) {
    throw new Error(`getTokenByAddress failed for ${address}: ${error.message}`);
  }

  return data;
}

/**
 * List recently discovered tokens, most recent first.
 */
async function listRecentTokens(limit = 200) {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("tokens")
    .select("*")
    .order("first_seen_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`listRecentTokens failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Aggregates how tokens previously made by this creator address turned out,
 * using our own data (tokens.creator joined with token_outcomes via the
 * foreign key relationship). Only counts FINALIZED outcomes (24h reached)
 * for the rug-rate/price-change averages, since in-progress tokens don't
 * have a reliable 24h result yet. Returns nulls (not zeros) when there's no
 * prior history to draw from, so "no history" is never confused with
 * "clean history."
 */
async function getCreatorHistory(creatorAddress, excludeAddress) {
  if (!creatorAddress) {
    return { priorTokenCount: null, priorRugCount: null, priorAvgPriceChangePct24h: null };
  }

  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("tokens")
    .select("address, token_outcomes(price_change_pct_24h, is_rug_24h, finalized_at)")
    .eq("creator", creatorAddress)
    .neq("address", excludeAddress || "");

  if (error) {
    throw new Error(`getCreatorHistory failed for ${creatorAddress}: ${error.message}`);
  }

  const rows = data || [];
  const priorTokenCount = rows.length;

  const finalizedOutcomes = rows
    .map((row) => (Array.isArray(row.token_outcomes) ? row.token_outcomes[0] : row.token_outcomes))
    .filter((outcome) => outcome && outcome.finalized_at);

  if (finalizedOutcomes.length === 0) {
    return { priorTokenCount, priorRugCount: null, priorAvgPriceChangePct24h: null };
  }

  const priorRugCount = finalizedOutcomes.filter((o) => o.is_rug_24h === true).length;
  const priceChanges = finalizedOutcomes.map((o) => o.price_change_pct_24h).filter((v) => v !== null && v !== undefined);
  const priorAvgPriceChangePct24h =
    priceChanges.length > 0 ? priceChanges.reduce((sum, v) => sum + v, 0) / priceChanges.length : null;

  return { priorTokenCount, priorRugCount, priorAvgPriceChangePct24h };
}

/**
 * Total number of tokens ever discovered — used to resume the in-memory
 * counter after a scanner restart, so the dashboard doesn't drop back to 0
 * even though the underlying data is untouched.
 */
async function getTotalTokenCount() {
  const supabase = getServiceClient();

  const { count, error } = await supabase.from("tokens").select("*", { count: "exact", head: true });

  if (error) {
    throw new Error(`getTotalTokenCount failed: ${error.message}`);
  }

  return count || 0;
}

module.exports = { upsertToken, getTokenByAddress, listRecentTokens, getCreatorHistory, getTotalTokenCount };
