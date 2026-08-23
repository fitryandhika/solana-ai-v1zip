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

const inFlightOrRecent = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err) {
  if (!err) return "unknown error";
  return err.message || String(err);
}

const MIN_GLOBAL_FETCH_INTERVAL_MS = Number(process.env.DEXSCREENER_MIN_FETCH_INTERVAL_MS || 150);
let lastFetchStartedAt = 0;

async function throttleGlobalFetch() {
  const now = Date.now();
  const wait = lastFetchStartedAt + MIN_GLOBAL_FETCH_INTERVAL_MS - now;
  if (wait > 0) {
    await sleep(wait);
  }
  lastFetchStartedAt = Date.now();
}

async function fetchWithRetry(url, { retries = 2, backoffMs = 500 } = {}) {
  let lastError = new Error(`DexScreener request failed for ${url} (no successful response after retries)`);

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttleGlobalFetch();
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" }
      });

      if (res.status === 429) {
        lastError = new Error(`DexScreener rate limited (429) for ${url}`);
        await sleep(backoffMs * Math.pow(2, attempt));
        continue;
      }

      if (!res.ok) {
        throw new Error(`DexScreener responded ${res.status} for ${url}`);
      }

      return await res.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(errMsg(err));
      if (attempt < retries) {
        await sleep(backoffMs * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

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

    volume1m: null,
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

function pickBestPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  return pairs
    .filter((p) => p.chainId === "solana")
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

async function getTokenByAddress(address) {
  if (!address) {
    return { address, dataStatus: "unavailable" };
  }

  const cached = inFlightOrRecent.get(address);
  const now = Date.now();

  if (cached) {
    if (cached.promise) {
      return cached.promise;
    }
    if (now - cached.timestamp < MIN_REQUEST_INTERVAL_MS) {
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
      const fallback = { address, dataStatus: "unavailable", error: errMsg(err) };
      inFlightOrRecent.set(address, { promise: null, result: fallback, timestamp: Date.now() });
      return fallback;
    }
  })();

  inFlightOrRecent.set(address, { promise: requestPromise, result: null, timestamp: now });
  return requestPromise;
}

async function getPairByAddress(pairAddress) {
  if (!pairAddress) return { dataStatus: "unavailable" };

  try {
    const url = `${BASE_URL}/latest/dex/pairs/solana/${pairAddress}`;
    const json = await fetchWithRetry(url);
    const pair = Array.isArray(json?.pairs) ? json.pairs[0] : json?.pair;
    return pair ? normalizePair(pair) : { dataStatus: "unavailable" };
  } catch (err) {
    return { dataStatus: "unavailable", error: errMsg(err) };
  }
}

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
  normalizePair
};