// lib/solana/whale-parser.js
//
// Pure parsing logic for detecting a buy/sell of a specific token mint from
// a transaction object — no network calls, no @solana/web3.js dependency.
// Kept separate from lib/solana/whale-transactions.js (which does the
// actual RPC fetching) so this logic is trivially unit-testable.
//
// Method: compare pre/post SPL token balances for the mint we care about.
// Whichever SIGNER's balance increased is the buyer; whichever decreased is
// the seller. Trade USD size is approximated from that same wallet's own
// native SOL balance change — accurate for direct SOL-paired swaps (the
// common case for new pump.fun/Raydium/Orca pairs), less accurate for
// multi-hop or stablecoin-routed swaps, where it will under/overstate the
// real size. That limitation is real and worth knowing, not hidden.

function getAccountKeysList(tx) {
  const message = tx.transaction.message;
  let keys = [];

  if (typeof message.getAccountKeys === "function") {
    const accountKeys = message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
    keys = accountKeys.staticAccountKeys.concat(
      accountKeys.accountKeysFromLookups?.writable || [],
      accountKeys.accountKeysFromLookups?.readonly || []
    );
  } else if (Array.isArray(message.accountKeys)) {
    keys = message.accountKeys.map((k) => (k && k.pubkey ? k.pubkey : k));
  }

  return keys.map((k) => (typeof k === "string" ? k : k?.toBase58())).filter(Boolean);
}

function getSignerAddresses(tx, keys) {
  const count = tx.transaction.message.header?.numRequiredSignatures || 0;
  return new Set(keys.slice(0, count));
}

/**
 * Parses a single transaction for a buy/sell of `tokenMintAddress`. Returns
 * null if the transaction failed, or if no signer's balance for that mint
 * changed (not a simple swap we can attribute to a specific wallet).
 */
function parseSwapFromTransaction(tx, tokenMintAddress, solPriceUsd) {
  if (!tx || !tx.meta || tx.meta.err) return null;

  const keys = getAccountKeysList(tx);
  const signers = getSignerAddresses(tx, keys);

  const byIndex = new Map();
  for (const b of tx.meta.preTokenBalances || []) {
    if (b.mint !== tokenMintAddress) continue;
    byIndex.set(b.accountIndex, { owner: b.owner, pre: b.uiTokenAmount?.uiAmount || 0, post: 0 });
  }
  for (const b of tx.meta.postTokenBalances || []) {
    if (b.mint !== tokenMintAddress) continue;
    const existing = byIndex.get(b.accountIndex) || { owner: b.owner, pre: 0, post: 0 };
    existing.post = b.uiTokenAmount?.uiAmount || 0;
    existing.owner = existing.owner || b.owner;
    byIndex.set(b.accountIndex, existing);
  }

  let best = null;
  for (const info of byIndex.values()) {
    if (!info.owner || !signers.has(info.owner)) continue;
    const delta = info.post - info.pre;
    if (delta === 0) continue;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { owner: info.owner, delta };
    }
  }

  if (!best) return null;

  const direction = best.delta > 0 ? "buy" : "sell";

  // Use the WALLET's own account (not the token account's PDA) for its SOL
  // balance change — the token-account index is a different, near-empty
  // account and would give a meaningless SOL delta.
  const ownerIndex = keys.indexOf(best.owner);
  if (ownerIndex < 0) return null;

  const solDeltaLamports =
    (tx.meta.postBalances?.[ownerIndex] ?? 0) - (tx.meta.preBalances?.[ownerIndex] ?? 0);
  const solDelta = Math.abs(solDeltaLamports) / 1e9;
  const usdValue = solPriceUsd ? solDelta * solPriceUsd : null;

  return {
    wallet: best.owner,
    direction,
    tokenAmount: Math.abs(best.delta),
    usdValue
  };
}

module.exports = {
  getAccountKeysList,
  getSignerAddresses,
  parseSwapFromTransaction
}; 
