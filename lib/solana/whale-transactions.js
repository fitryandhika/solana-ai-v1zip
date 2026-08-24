// lib/solana/whale-transactions.js
//
// RPC-fetching side of whale detection: pulls new transaction signatures
// for a token's pair address and hands each one to the pure parser in
// whale-parser.js. See that file for the actual buy/sell detection logic
// and its documented limitations.

const { Connection, PublicKey } = require("@solana/web3.js");
const { parseSwapFromTransaction } = require("./whale-parser");

const WHALE_MIN_USD_VALUE = Number(process.env.WHALE_MIN_USD_VALUE || 500);
const MAX_CONCURRENT_WHALE_LOOKUPS = Number(process.env.MAX_CONCURRENT_WHALE_LOOKUPS || 1);
const MIN_WHALE_LOOKUP_INTERVAL_MS = Number(process.env.MIN_WHALE_LOOKUP_INTERVAL_MS || 500);

// This shares the same Helius RPC budget (10 req/sec total) as
// lib/solana/websocket.js and lib/solana/rug-check.js. Its own throttle is
// deliberately conservative to leave headroom for the discovery pipeline,
// which matters more for the core product than whale detection does.
let sharedConnection = null;
function getConnection() {
  if (!sharedConnection) {
    sharedConnection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      { commitment: "confirmed", disableRetryOnRateLimit: true }
    );
  }
  return sharedConnection;
}

let activeLookups = 0;
let lastLookupStartedAt = 0;

async function throttledGetTransaction(signature) {
  while (activeLookups >= MAX_CONCURRENT_WHALE_LOOKUPS) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const now = Date.now();
  const wait = lastLookupStartedAt + MIN_WHALE_LOOKUP_INTERVAL_MS - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastLookupStartedAt = Date.now();

  activeLookups += 1;
  try {
    const connection = getConnection();
    return await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  } finally {
    activeLookups -= 1;
  }
}

/**
 * Fetches transaction signatures for an address newer than `sinceSignature`
 * (or the most recent `limit` if none given yet).
 */
async function getNewSignatures(address, sinceSignature, limit = 20) {
  const connection = getConnection();
  const options = { limit };
  if (sinceSignature) options.until = sinceSignature;

  const signatures = await connection.getSignaturesForAddress(new PublicKey(address), options);
  return signatures.filter((s) => !s.err).map((s) => s.signature);
}

/**
 * Scans new signatures for a token's pair address, parses each as a
 * potential swap, and returns only trades at or above WHALE_MIN_USD_VALUE.
 * Returns { trades, newestSignature } — newestSignature should be saved as
 * the cursor for the next scan so signatures aren't reprocessed.
 */
async function scanForWhaleTrades({ pairAddress, tokenAddress, sinceSignature, solPriceUsd, maxToCheck = 10 }) {
  const signatures = await getNewSignatures(pairAddress, sinceSignature, maxToCheck);
  const trades = [];

  // getSignaturesForAddress returns newest-first; process oldest-first so
  // the cursor logic (newest processed = new cursor) stays straightforward.
  const ordered = [...signatures].reverse();

  for (const signature of ordered) {
    const tx = await throttledGetTransaction(signature);
    const parsed = parseSwapFromTransaction(tx, tokenAddress, solPriceUsd);

    if (parsed && parsed.usdValue !== null && parsed.usdValue >= WHALE_MIN_USD_VALUE) {
      trades.push({
        walletAddress: parsed.wallet,
        tokenAddress,
        signature,
        direction: parsed.direction,
        tokenAmount: parsed.tokenAmount,
        usdValue: parsed.usdValue,
        tradedAt: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString()
      });
    }
  }

  return {
    trades,
    newestSignature: signatures.length > 0 ? signatures[0] : sinceSignature
  };
}

module.exports = {
  WHALE_MIN_USD_VALUE,
  getNewSignatures,
  scanForWhaleTrades
}; 
