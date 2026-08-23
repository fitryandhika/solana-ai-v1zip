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

  const excluded = new Set(KNOWN_NON_TOKEN_ADDRESSES);
  excluded.add(programId);

  const seen = new Set();
  const result = [];
  for (const key of keys) {
    if (!key) continue;
    const address = typeof key === "string" ? key : key.toBase58();
    if (excluded.has(address) || seen.has(address)) continue;
    seen.add(address);
    result.push(address);
  }
  return result;
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
        commitment: "confirmed"
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

    try {
      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });

      const candidates = extractCandidateAddressesFromTransaction(tx, programId);
      for (const address of candidates) {
        this.emit("candidate", { address, programId, signature });
      }
    } catch (err) {
      // Transaction lookup can fail transiently (not yet indexed by the RPC
      // node, rate limited, etc). Discovery is best-effort — skip this one
      // event rather than treating it as a connection-level error.
    }
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    this.connected = false;
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
  looksLikeCandidateEvent,
  WATCHED_PROGRAM_IDS
};