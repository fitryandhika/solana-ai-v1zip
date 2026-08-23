// lib/solana/rug-check.js
//
// One-time, at-discovery checks for the two most common rug-pull risk
// indicators that are cheaply and reliably readable on-chain:
//   1. Mint authority — if NOT revoked (null), the deployer can mint
//      unlimited new supply at any time.
//   2. Freeze authority — if NOT revoked (null), the deployer can freeze
//      any holder's tokens, preventing them from selling.
//   3. Top-10 holder concentration — what % of total supply the 10 largest
//      wallets hold. High concentration is a strong dump-risk signal.
//
// IMPORTANT — what this module does NOT check: LP lock/burn status.
// Determining whether liquidity is genuinely locked or burned requires
// tracking which specific vesting/lock contract (if any) holds the LP
// tokens, which varies by provider (Streamflow, Raydium's own locker,
// manual burn, etc) and is not reliable to infer generically without a
// dedicated indexer. Reporting a guess here would be worse than reporting
// nothing — it could read as a false safety signal on something that
// influences real trading decisions. LP lock stays a manual check for now.
//
// Every function here is best-effort: on any failure it returns nulls
// (unknown), never a fabricated or default-safe value.

const { Connection, PublicKey } = require("@solana/web3.js");

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

async function checkMintAndFreezeAuthority(mintAddress) {
  try {
    const connection = getConnection();
    const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    const parsed = info?.value?.data?.parsed?.info;

    if (!parsed) {
      return { mintAuthorityRevoked: null, freezeAuthorityRevoked: null, error: "mint account data not parseable" };
    }

    return {
      mintAuthorityRevoked: parsed.mintAuthority === null,
      freezeAuthorityRevoked: parsed.freezeAuthority === null,
      error: null
    };
  } catch (err) {
    return {
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      error: err?.message || String(err)
    };
  }
}

async function getTop10HolderPercent(mintAddress) {
  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(mintAddress);

    const [largest, supply] = await Promise.all([
      connection.getTokenLargestAccounts(mintPubkey),
      connection.getTokenSupply(mintPubkey)
    ]);

    const totalSupply = Number(supply?.value?.uiAmount);
    if (!totalSupply || totalSupply <= 0) return null;

    const top10 = (largest?.value || []).slice(0, 10);
    const top10Sum = top10.reduce((sum, acc) => sum + Number(acc.uiAmount || 0), 0);

    return (top10Sum / totalSupply) * 100;
  } catch (err) {
    return null;
  }
}

async function runDiscoveryChecks(mintAddress) {
  const [authorities, top10HolderPct] = await Promise.all([
    checkMintAndFreezeAuthority(mintAddress),
    getTop10HolderPercent(mintAddress)
  ]);

  return {
    mintAuthorityRevoked: authorities.mintAuthorityRevoked,
    freezeAuthorityRevoked: authorities.freezeAuthorityRevoked,
    rugCheckError: authorities.error,
    top10HolderPct
  };
}

module.exports = {
  checkMintAndFreezeAuthority,
  getTop10HolderPercent,
  runDiscoveryChecks
};