// lib/analyzer/outcomes.js
//
// Computes the price_change_pct_<horizon> / liquidity_change_pct_<horizon>
// fields for token_outcomes (migration_004_outcomes.sql). Pure calculation
// logic — no Supabase or network calls here, so it's easy to unit test.

const HORIZONS = [
  { label: "1m", ms: 60 * 1000 },
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "30m", ms: 30 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "4h", ms: 4 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 }
];

// Liquidity drop of 80%+ from its value at discovery is treated as an
// observed rug event for this horizon. This is an OUTCOME observation, not
// a prediction — see lib/solana/rug-check.js for the (separate) at-discovery
// risk indicators.
const RUG_LIQUIDITY_DROP_THRESHOLD_PCT = 80;

function percentChange(from, to) {
  if (from === null || from === undefined || from === 0 || to === null || to === undefined) return null;
  return ((to - from) / from) * 100;
}

/**
 * Given how long ago a token was discovered, returns which horizons are now
 * due (elapsed time has passed the horizon) and are not already present in
 * `alreadyComputed` (a Set of horizon labels).
 */
function getDueHorizons(discoveredAt, now, alreadyComputed) {
  const elapsedMs = now - new Date(discoveredAt).getTime();
  return HORIZONS.filter((h) => elapsedMs >= h.ms && !alreadyComputed.has(h.label));
}

/**
 * Builds the field patch for one horizon given the discovery snapshot and
 * the snapshot found nearest that horizon. Returns null if the outcome
 * snapshot is missing (e.g. token stopped reporting data — leave the
 * horizon uncomputed rather than writing a misleading null-derived value).
 */
function buildHorizonPatch(horizonLabel, discovery, outcomeSnapshot) {
  if (!outcomeSnapshot) return null;

  const patch = {
    [`price_change_pct_${horizonLabel}`]: percentChange(discovery.price, outcomeSnapshot.price)
  };

  if (horizonLabel === "1h" || horizonLabel === "24h") {
    const liquidityChangePct = percentChange(discovery.liquidity, outcomeSnapshot.liquidity);
    patch[`liquidity_change_pct_${horizonLabel}`] = liquidityChangePct;
    patch[`is_rug_${horizonLabel}`] = liquidityChangePct !== null ? liquidityChangePct <= -RUG_LIQUIDITY_DROP_THRESHOLD_PCT : null;
  }

  return patch;
}

module.exports = {
  HORIZONS,
  getDueHorizons,
  buildHorizonPatch,
  percentChange
};
