// lib/solana/websocket.js
//
// Realtime Solana blockchain discovery. This is BLOCKCHAIN REALTIME, distinct
// from the market-data POLLING that happens elsewhere (DexScreener). See spec
// section 54 — the two must never be conflated.
//
// Subscribes to program logs for well-known Solana AMM/DEX program IDs so we
// observe pool/pair creation activity as it happens, rather than requesting a
// "trending tokens" list and calling it new.
//
// This module is transport-only: it emits candidate addresses. It does NOT
// call DexScreener and does NOT touch Supabase — that orchestration lives in
// worker/scanner.js, per the separation required in spec section 29.

const { Connection, PublicKey } = require("@solana/web3.js");
const EventEmitter = require("events");

// Well-known Solana DEX/AMM program IDs whose logs indicate pool/pair activity.
// This list is intentionally conservative for V1 and can be extended later.
const WATCHED_PROGRAM_IDS = [
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM V4
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpools
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" // Pump.fun
];

// Heuristic strings that show up in program log lines when a new pool/pair or
// mint-related instruction is processed. Used only to decide whether an event
// is *worth investigating further* (i.e. worth the cost of fetching the full
// transaction below) — never used to assert a token is real or tradable.
// That confirmation always comes from DexScreener. Kept fairly specific to
// avoid triggering on every routine swap/instruction these programs log.
const CANDIDATE_LOG_HINTS = [
  "InitializeMint",
  "initialize2", // Raydium AMM V4 pool creation
  "InitializePool", // Orca Whirlpool pool creation
  "Instruction: Create" // pump.fun mint+bonding-curve creation
];

// pump.fun in particular creates new tokens at a very high rate, so a naive
// "fetch the transaction for every matching log line" approach can fire off
// many concurrent RPC calls in a burst — that's what was flooding the RPC
// provider with requests and triggering sustained 429 rate limiting. Capping
// concurrent transaction lookups (and dropping the rest — same reasoning as
// MAX_CONCURRENT_CANDIDATES in worker/scanner.js) keeps RPC usage bounded
// regardless of how bursty token creation gets.
const MAX_CONCURRENT_TX_LOOKUPS = Number(process.env.MAX_CONCURRENT_TX_LOOKUPS || 2);

// Helius' free plan allows 10 RPC requests/second total, shared across every
// call type (getTransaction, the health-check getSlot, WS overhead, etc).
// Capping concurrency alone doesn't prevent bursts from exceeding that —
// e.g. several pump.fun creations landing in the same second can still fire
// off more than 10 requests before any of them finish. Spacing out the
// *start* of each transaction lookup by a minimum interval keeps our actual
// request rate safely under the limit regardless of how bursty the chain
// gets. ~4/sec leaves real headroom for the other RPC traffic sharing the
// same budget.
const MIN_TX_LOOKUP_INTERVAL_MS = Number(process.env.MIN_TX_LOOKUP_INTERVAL_MS || 500);

// Addresses that are never themselves a newly created token/pool — filtering
// them out keeps candidate lists smaller and avoids wasting a DexScreener
// lookup on accounts we already know aren't a token.
const KNOWN_NON_TOKEN_ADDRESSES = new Set([
  "11111111111111111111111111111111", // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token Program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account Program
  "SysvarRent111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "So11111111111111111111111111111111111111112", // Wrapped SOL — a pool's "other side", never the new token
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  ...WATCHED_PROGRAM_IDS
]);

function looksLikeCandidateEvent(logs) {
  return (logs || []).some((line) => CANDIDATE_LOG_HINTS.some((hint) => line.includes(hint)));
}

// Program log TEXT (the human-readable `msg!()` lines a Solana program
// prints) essentially never contains the actual new mint/pool address — that
// address lives in the transaction's account list, not in the log message.
// So the only reliable way to get real candidate addresses is to fetch the
// full transaction (by the signature the log subscription gives us) and read
// its account keys directly, rather than pattern-matching the log text.
// Each matched transaction can list 20-50+ accounts, and blindly checking
// all (or even just "the first few") wastes our throttled DexScreener/RPC
// budget on accounts that are almost certainly not the new token — PDAs,
// vaults, authorities, etc. Instead we target the EXACT account index that
// holds the mint/token address for each specific instruction, verified
// against each program's public source/IDL:
//   - pump.fun "create":            account[0]      = mint
//     https://github.com/pump-fun/pump-public-docs (idl/pump.json)
//   - Raydium AMM V4 "initialize2":  account[8], [9] = coin mint, pc mint
//     https://github.com/raydium-io/raydium-amm/blob/master/program/src/instruction.rs
//   - Orca Whirlpool "initializePool": account[1],[2] = token_mint_a, token_mint_b
//     https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/instructions/initialize_pool.rs
// This is far more precise than guessing, and keeps our limited lookup
// budget spent almost entirely on addresses that are actually candidates.
const PROGRAM_MINT_ACCOUNT_INDICES = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": [8, 9], // Raydium AMM V4
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": [1, 2], // Orca Whirlpools
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": [0] // pump.fun
};

// Creator/deployer wallet index, from the same verified IDL sources as
// PROGRAM_MINT_ACCOUNT_INDICES above. Extracted from the transaction we
// already fetch for candidate discovery — no extra RPC call needed.
//   - pump.fun "create":              account[7]  = user (creator wallet)
//   - Raydium AMM V4 "initialize2":    account[17] = user_wallet (signer)
//   - Orca Whirlpool "initializePool": account[3]  = funder (signer)
const PROGRAM_CREATOR_ACCOUNT_INDEX = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": 17,
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": 3,
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": 7
};

// Fallback cap for any program not in the precise-index map above (or if
// account extraction otherwise can't use the precise indices).
const MAX_CANDIDATES_PER_TRANSACTION = Number(process.env.MAX_CANDIDATES_PER_TRANSACTION || 6);

function extractCandidateAddressesFromTransaction(tx, programId) {
  if (!tx || !tx.transaction || !tx.transaction.message) return [];

  const message = tx.transaction.message;
  let keys = [];

  if (typeof message.getAccountKeys === "function") {
    // Versioned (v0) transaction message.
    const accountKeys = message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
    keys = accountKeys.staticAccountKeys.concat(
      accountKeys.accountKeysFromLookups?.writable || [],
      accountKeys.accountKeysFromLookups?.readonly || []
    );
  } else if (Array.isArray(message.accountKeys)) {
    // Legacy transaction message.
    keys = message.accountKeys.map((k) => (k && k.pubkey ? k.pubkey : k));
  }

  const toAddress = (key) => (typeof key === "string" ? key : key?.toBase58());
  const excluded = new Set(KNOWN_NON_TOKEN_ADDRESSES);
  excluded.add(programId);

  const preciseIndices = PROGRAM_MINT_ACCOUNT_INDICES[programId];
  const seen = new Set();
  const result = [];

  if (preciseIndices) {
    // We know exactly which account index holds the mint(s) for this
    // program's instruction — use those and nothing else. This is a small,
    // high-confidence candidate set instead of a wide speculative one.
    for (const idx of preciseIndices) {
      const key = keys[idx];
      if (!key) continue;
      const address = toAddress(key);
      if (!address || excluded.has(address) || seen.has(address)) continue;
      seen.add(address);
      result.push(address);
    }
    return result;
  }

  // Fallback for any program without a known precise layout: take the
  // first few non-excluded accounts, capped to bound lookup cost.
  for (const key of keys) {
    if (!key) continue;
    const address = toAddress(key);
    if (!address || excluded.has(address) || seen.has(address)) continue;
    seen.add(address);
    result.push(address);
    if (result.length >= MAX_CANDIDATES_PER_TRANSACTION) break;
  }
  return result;
}

// Extracts the creator/deployer wallet from a transaction we've already
// fetched, using the verified index for the matched program. Returns null
// if the program isn't in the map or the account isn't present.
function extractCreatorAddress(tx, programId) {
  if (!tx || !tx.transaction || !tx.transaction.message) return null;
  const idx = PROGRAM_CREATOR_ACCOUNT_INDEX[programId];
  if (idx === undefined) return null;

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

  const key = keys[idx];
  if (!key) return null;
  return typeof key === "string" ? key : key?.toBase58() || null;
}

class SolanaDiscoveryStream extends EventEmitter {
  constructor({ wsUrl, httpUrl, reconnectDelayMs = 5000 } = {}) {
    super();
    this.wsUrl = wsUrl || process.env.SOLANA_WS_URL || deriveWsUrl(process.env.SOLANA_RPC_URL);
    this.httpUrl = httpUrl || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    this.baseReconnectDelayMs = Number(reconnectDelayMs);
    this.reconnectAttempt = 0;
    this.connection = null;
    this.subscriptionIds = [];
    this.connected = false;
    this._stopped = false;
    this._activeTxLookups = 0;
    this._lastTxLookupStartedAt = 0;
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._teardown();
  }

  _connect() {
    if (this._stopped) return;

    try {
      this.connection = new Connection(this.httpUrl, {
        wsEndpoint: this.wsUrl,
        commitment: "confirmed",
        // @solana/web3.js retries 429s internally by default, with its own
        // backoff — completely independent of MIN_TX_LOOKUP_INTERVAL_MS
        // above. Those internal retries still count against Helius' rate
        // limit, so they were silently multiplying our real request volume
        // far past what our own throttle intended. Disabling this makes our
        // external rate limiting the only thing in control: a 429 fails
        // once and is handled by our own catch block below.
        disableRetryOnRateLimit: true
      });

      this.subscriptionIds = WATCHED_PROGRAM_IDS.map((programId) =>
        this.connection.onLogs(
          new PublicKey(programId),
          (logInfo) => this._handleLogs(programId, logInfo),
          "confirmed"
        )
      );

      this.connected = true;
      this.reconnectAttempt = 0;
      this.emit("connected");

      // @solana/web3.js manages the underlying WS connection internally and
      // does not expose a simple public "close" event across versions, so we
      // proactively health-check the connection on an interval and reconnect
      // if it appears to have died.
      this._startHealthCheck();
    } catch (err) {
      this.emit("error", err);
      this._scheduleReconnect();
    }
  }

  _startHealthCheck() {
    clearInterval(this._healthInterval);
    this._healthInterval = setInterval(async () => {
      if (this._stopped) return;
      try {
        await this.connection.getSlot();
        this.emit("heartbeat");
      } catch (err) {
        this.emit("error", err);
        this._teardown();
        this._scheduleReconnect();
      }
    }, 30000);
  }

  async _handleLogs(programId, logInfo) {
    const logs = logInfo?.logs || [];
    const signature = logInfo?.signature;
    this.emit("event", { programId, signature });

    if (!looksLikeCandidateEvent(logs) || !signature) return;

    if (this._activeTxLookups >= MAX_CONCURRENT_TX_LOOKUPS) {
      // Too many transaction lookups already in flight — drop this one
      // rather than queueing it. This is what actually bounds RPC request
      // concurrency; without it, a burst of pump.fun creations alone can
      // flood the provider regardless of any downstream limiter.
      return;
    }

    const now = Date.now();
    if (now - this._lastTxLookupStartedAt < MIN_TX_LOOKUP_INTERVAL_MS) {
      // Spaces out request *starts* so we can't exceed the provider's
      // requests-per-second budget even when several candidates land in the
      // same instant (see MIN_TX_LOOKUP_INTERVAL_MS above).
      return;
    }
    this._lastTxLookupStartedAt = now;

    this._activeTxLookups += 1;
    try {
      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });

      const candidates = extractCandidateAddressesFromTransaction(tx, programId);
      const creator = extractCreatorAddress(tx, programId);
      this.emit("debug", `tx ${signature} matched a candidate hint, extracted ${candidates.length} account(s) to check`);
      for (const address of candidates) {
        this.emit("candidate", { address, programId, signature, creator, source: "blockchain" });
      }
    } catch (err) {
      // Transaction lookup can fail transiently (not yet indexed by the RPC
      // node, rate limited, etc). Discovery is best-effort — skip this one
      // event rather than treating it as a connection-level error. Still
      // surface it via "debug" so it's visible in logs instead of silently
      // vanishing, which made earlier "zero tokens discovered" hard to
      // diagnose.
      this.emit("debug", `tx fetch failed for ${signature}: ${err?.message || err}`);
    } finally {
      this._activeTxLookups -= 1;
    }
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    this.connected = false;
    // Exponential backoff, capped at ~2 minutes.
    const delay = Math.min(this.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempt), 120000);
    this.reconnectAttempt += 1;
    this.emit("reconnecting", { delay, attempt: this.reconnectAttempt });
    setTimeout(() => this._connect(), delay);
  }

  _teardown() {
    clearInterval(this._healthInterval);
    this.subscriptionIds = [];
    this.connection = null;
    this.connected = false;
  }
}

function deriveWsUrl(httpUrl) {
  if (!httpUrl) return "wss://api.mainnet-beta.solana.com";
  return httpUrl.replace(/^http/, "ws");
}

module.exports = {
  SolanaDiscoveryStream,
  extractCandidateAddressesFromTransaction,
  extractCreatorAddress,
  looksLikeCandidateEvent,
  WATCHED_PROGRAM_IDS
};
