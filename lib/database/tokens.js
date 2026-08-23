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

    top10_holder_pct: token.top10HolderPct ?? null
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

module.exports = { upsertToken, getTokenByAddress, listRecentTokens };
