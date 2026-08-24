// lib/solana/whale-transactions.js
//
// RPC-fetching side of whale detection: pulls new transaction signatures
// for a token's pair address and hands each one to the pure parser in
// whale-parser.js. See that file for the actual buy/sell detection logic
// and its documented limitations.

const { Connection, PublicKey } = require("@solana/web3.js");
const { parseSwapFromTransaction } = require("./whale-parser");
const { waitForRpcSlot, releaseRpcSlot } = require("./rpc-throttle");

const WHALE_MIN_USD_VALUE = Number(process.env.WHALE_MIN_USD_VALUE || 500);

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

async function throttledCall(fn) {
  await waitForRpcSlot();
  try {
    return await fn();
  } finally {
    releaseRpcSlot();
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

  const signatures = await throttledCall(() => connection.getSignaturesForAddress(new PublicKey(address), options));
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
  const connection = getConnection();

  for (const signature of ordered) {
    const tx = await throttledCall(() =>
      connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    );
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
