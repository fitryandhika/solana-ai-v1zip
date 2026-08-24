// lib/solana/rpc-throttle.js
//
// Shared, cross-module rate limiter for every Solana RPC call this app
// makes. Helius' free plan allows 10 requests/second TOTAL — but this app
// has three independent RPC-consuming modules (blockchain discovery in
// websocket.js, rug-checks in rug-check.js, whale-transaction scanning in
// whale-transactions.js), each of which used to throttle itself
// separately. Individually safe, but with no coordination between them,
// their combined worst-case rate could still exceed the shared budget when
// more than one is active at the same moment. This module is the single
// choke point all of them go through instead, so the COMBINED rate across
// every RPC caller is what's actually bounded.

const MAX_CONCURRENT_RPC_CALLS = Number(process.env.MAX_CONCURRENT_RPC_CALLS || 2);
// ~3.3 req/sec ceiling — well under Helius' 10/sec, leaving headroom for
// the fact that a single "call" here can still involve brief internal
// overhead beyond just the RPC round-trip.
const MIN_RPC_CALL_INTERVAL_MS = Number(process.env.MIN_RPC_CALL_INTERVAL_MS || 300);

let activeCalls = 0;
let lastCallStartedAt = 0;

/**
 * Call and await this immediately before making any Solana RPC request.
 * Blocks until both a concurrency slot and the minimum time gap since the
 * last call are available.
 */
async function waitForRpcSlot() {
  while (activeCalls >= MAX_CONCURRENT_RPC_CALLS) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  const now = Date.now();
  const wait = lastCallStartedAt + MIN_RPC_CALL_INTERVAL_MS - now;
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  lastCallStartedAt = Date.now();
  activeCalls += 1;
}

/**
 * Call this in a `finally` block after the RPC request completes (success
 * or failure) to free the concurrency slot for the next caller.
 */
function releaseRpcSlot() {
  activeCalls = Math.max(0, activeCalls - 1);
}

module.exports = { waitForRpcSlot, releaseRpcSlot };
