// lib/providers/dexscreener.js
//
// The ONLY module in this app that calls the DexScreener API directly.
// Normalizes responses into the internal token-data shape (see spec section 8)
// so nothing downstream (UI, analyzer, DB layer) depends on DexScreener's raw
// response format.
//
// Includes: request throttling/dedup, retry with backoff, and safe error
// handling (spec sections 32-33). On failure it returns { dataStatus:
// "unavailable" } rather than throwing, fake data, or deleting anything.

const BASE_URL = process.env.DEXSCREENER_API_BASE_URL || "https://api.dexscreener.com";
const MIN_REQUEST_INTERVAL_MS = Number(process.env.MARKET_POLL_INTERVAL_MS || 10000);

// address -> { promise, timestamp } — dedupes concurrent/rapid requests for
// the same address so we never hammer the API for one token.
const inFlightOrRecent = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, { retries = 2, backoffMs = 500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" }
      });

      if (res.status === 429) {
        // Rate limited — back off and retry.
        await sleep(backoffMs * Math.pow(2, attempt));
        continue;
      }

      if (!res.ok) {
        throw new Error(`DexScreener responded ${res.status} for ${url}`);
      }

      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(backoffMs * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Normalize a single DexScreener "pair" object into our internal token shape.
 */
function normalizePair(pair) {
  if (!pair) return null;

  const baseToken = pair.baseToken || {};

  return {
    address: baseToken.address || null,
    name: baseToken.name || null,
    symbol: baseToken.symbol || null,
    pairAddress: pair.pairAddress || null,
    dex: pair.dexId || null,
    price: pair.priceUsd !== undefined ? Number(pair.priceUsd) : null,
    liquidity: pair.liquidity && pair.liquidity.usd !== undefined ? Number(pair.liquidity.usd) : null,
    marketCap: pair.fdv !== undefined ? Number(pair.fdv) : pair.marketCap ?? null,

    volume1m: null, // DexScreener does not provide 1m volume directly; derived by analyzer from snapshots.
    volume5m: pair.volume && pair.volume.m5 !== undefined ? Number(pair.volume.m5) : null,
    volume15m: null,

    buys1m: null,
    sells1m: null,
    buys5m: pair.txns && pair.txns.m5 ? Number(pair.txns.m5.buys) : null,
    sells5m: pair.txns && pair.txns.m5 ? Number(pair.txns.m5.sells) : null,

    buyVolume1m: null,
    sellVolume1m: null,

    priceChange1m: null,
    priceChange5m: pair.priceChange && pair.priceChange.m5 !== undefined ? Number(pair.priceChange.m5) : null,
    priceChange15m: null,

    pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,

    dataStatus: "ok"
  };
}

/**
 * Pick the pair with the highest liquidity when a token has multiple pairs.
 */
function pickBestPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  return pairs
    .filter((p) => p.chainId === "solana")
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

/**
 * Look up market data for a Solana token address. Returns the normalized
 * token shape, or { dataStatus: "unavailable" } on failure — never throws
 * for expected failure modes, never returns random/fake values.
 */
async function getTokenByAddress(address) {
  if (!address) {
    return { address, dataStatus: "unavailable" };
  }

  const cached = inFlightOrRecent.get(address);
  const now = Date.now();

  if (cached) {
    if (cached.promise) {
      // A request for this address is already in flight — reuse it.
      return cached.promise;
    }
    if (now - cached.timestamp < MIN_REQUEST_INTERVAL_MS) {
      // Fetched too recently — reuse the last result instead of re-fetching.
      return cached.result;
    }
  }

  const url = `${BASE_URL}/latest/dex/tokens/${address}`;

  const requestPromise = (async () => {
    try {
      const json = await fetchWithRetry(url);
      const best = pickBestPair(json?.pairs);
      const normalized = best ? normalizePair(best) : { address, dataStatus: "unavailable" };

      inFlightOrRecent.set(address, { promise: null, result: normalized, timestamp: Date.now() });
      return normalized;
    } catch (err) {
      const fallback = { address, dataStatus: "unavailable", error: err.message };
      inFlightOrRecent.set(address, { promise: null, result: fallback, timestamp: Date.now() });
      return fallback;
    }
  })();

  inFlightOrRecent.set(address, { promise: requestPromise, result: null, timestamp: now });
  return requestPromise;
}

/**
 * Look up a pair directly by its pair address (used when the scanner has
 * already identified a specific pool/pair from a blockchain event).
 */
async function getPairByAddress(pairAddress) {
  if (!pairAddress) return { dataStatus: "unavailable" };

  try {
    const url = `${BASE_URL}/latest/dex/pairs/solana/${pairAddress}`;
    const json = await fetchWithRetry(url);
    const pair = Array.isArray(json?.pairs) ? json.pairs[0] : json?.pair;
    return pair ? normalizePair(pair) : { dataStatus: "unavailable" };
  } catch (err) {
    return { dataStatus: "unavailable", error: err.message };
  }
}

/**
 * Fallback discovery: poll DexScreener's token-profiles/boosted endpoints for
 * recently active Solana pairs when realtime blockchain discovery is degraded.
 * This is a FALLBACK ONLY (spec section 5) — never the primary discovery path,
 * and it never fabricates tokens.
 */
async function pollRecentSolanaPairs() {
  try {
    const url = `${BASE_URL}/token-boosts/latest/v1`;
    const json = await fetchWithRetry(url);
    const items = Array.isArray(json) ? json : [];
    return items.filter((item) => item.chainId === "solana").map((item) => item.tokenAddress);
  } catch (err) {
    return [];
  }
}

module.exports = {
  getTokenByAddress,
  getPairByAddress,
  pollRecentSolanaPairs,
  normalizePair // exported for tests
};
