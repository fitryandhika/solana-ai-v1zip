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
// is *worth investigating further* — never used to assert a token is real or
// tradable. That confirmation always comes from DexScreener.
const CANDIDATE_LOG_HINTS = ["InitializeMint", "initialize2", "initialize", "CreatePool", "create_pool"];

function extractCandidateAddressesFromLogs(logs) {
  // Program log lines don't reliably embed base58 addresses in a fixed spot,
  // so as a conservative V1 heuristic we scan for base58-looking tokens in
  // the log text itself. The scanner treats these purely as *candidates* —
  // every candidate still must be confirmed against DexScreener before being
  // stored as a discovered token (spec section 4, steps 3-5).
  const base58Pattern = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const found = new Set();

  for (const line of logs || []) {
    const matches = line.match(base58Pattern);
    if (matches) {
      matches.forEach((m) => found.add(m));
    }
  }

  return Array.from(found);
}

function looksLikeCandidateEvent(logs) {
  return (logs || []).some((line) => CANDIDATE_LOG_HINTS.some((hint) => line.includes(hint)));
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

  _handleLogs(programId, logInfo) {
    const logs = logInfo?.logs || [];
    this.emit("event", { programId, signature: logInfo?.signature });

    if (!looksLikeCandidateEvent(logs)) return;

    const candidates = extractCandidateAddressesFromLogs(logs);
    for (const address of candidates) {
      this.emit("candidate", { address, programId, signature: logInfo?.signature });
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
  extractCandidateAddressesFromLogs,
  looksLikeCandidateEvent,
  WATCHED_PROGRAM_IDS
};
