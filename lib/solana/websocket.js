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

const CANDIDATE_LOG_HINTS = [
  "InitializeMint",
  "initialize2",
  "InitializePool",
  "Instruction: Create"
];

// pump.fun in particular creates new tokens at a very high rate, so a naive
// "fetch the transaction for every matching log line" approach can fire off
// many concurrent RPC calls in a burst — that's what was flooding the RPC
// provider with requests and triggering sustained 429 rate limiting. Capping
// concurrent transaction lookups (and dropping the rest) keeps RPC usage
// bounded regardless of how bursty token creation gets.
const MAX_CONCURRENT_TX_LOOKUPS = Number(process.env.MAX_CONCURRENT_TX_LOOKUPS || 2);

const KNOWN_NON_TOKEN_ADDRESSES = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  ...WATCHED_PROGRAM_IDS
]);

function looksLikeCandidateEvent(logs) {
  return (logs || []).some((line) => CANDIDATE_LOG_HINTS.some((hint) => line.includes(hint)));
}

function extractCandidateAddressesFromTransaction(tx, programId) {
  if (!tx || !tx.transaction || !tx.transaction.message) return [];

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
    this._activeTxLookups = 0;
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

    if (this._activeTxLookups >= MAX_CONCURRENT_TX_LOOKUPS) {
      return;
    }

    this._activeTxLookups += 1;
    try {
      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });

      const candidates = extractCandidateAddressesFromTransaction(tx, programId);
      this.emit("debug", `tx ${signature} matched a candidate hint, extracted ${candidates.length} account(s) to check`);
      for (const address of candidates) {
        this.emit("candidate", { address, programId, signature });
      }
    } catch (err) {
      this.emit("debug", `tx fetch failed for ${signature}: ${err?.message || err}`);
    } finally {
      this._activeTxLookups -= 1;
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