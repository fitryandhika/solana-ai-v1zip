// worker/scanner.js
//
// Standalone Node process — NOT a Vercel serverless function (spec section
// 29/30). Run locally with `npm run scanner`. In production this must run
// somewhere that supports a long-lived process (a small VM, Railway, Fly.io,
// a Render background worker, etc). It writes to the SAME Supabase project
// as the Next.js app, which only ever reads from Supabase.
//
// Flow per spec section 30:
//   1. Connect to Solana WebSocket.
//   2. Listen for relevant events.
//   3. Identify candidate token/pair activity.
//   4. Query DexScreener.
//   5. Confirm tradable pair.
//   6. Insert token if new.
//   7. Start collecting snapshots.
//   8. Calculate score.
//   9. Store snapshot.
//   10. Continue monitoring.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env.local") });
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const { SolanaDiscoveryStream } = require("../lib/solana/websocket");
const dexscreener = require("../lib/providers/dexscreener");
const { upsertToken, listRecentTokens } = require("../lib/database/tokens");
const { insertSnapshot, getBaselineSnapshot } = require("../lib/database/snapshots");
const { getServiceClient } = require("../lib/database/supabase");
const { calculateVolumeRatio, calculateMomentumScore, calculateBuyPressureScore } = require("../lib/analyzer/momentum");
const { calculateOpportunityScore, classifySignal } = require("../lib/analyzer/opportunity");
const { computeTokenAgeMinutes } = require("../lib/utils/format");

const MARKET_POLL_INTERVAL_MS = Number(process.env.MARKET_POLL_INTERVAL_MS || 10000);
const RECONNECT_DELAY_MS = Number(process.env.SCANNER_RECONNECT_DELAY_MS || 5000);
const FALLBACK_POLL_INTERVAL_MS = 60000; // conservative, per spec section 5

// Raw Solana program logs are noisy — the candidate-address heuristic in
// lib/solana/websocket.js can match many non-token substrings per log line.
// Without a cap, a burst of candidates each opens an outbound DexScreener
// request, which can exhaust the container's ephemeral ports and get the
// process killed. Capping concurrent candidate handling (and simply
// dropping candidates over the cap — they're speculative anyway) keeps
// outbound connections bounded regardless of how bursty the chain gets.
const MAX_CONCURRENT_CANDIDATES = Number(process.env.MAX_CONCURRENT_CANDIDATES || 3);
let activeCandidateCount = 0;

// last_event_at fires on every single program-log event, which on a busy
// Solana program can be hundreds per second. Writing to Supabase that often
// floods the database and the process's own connection pool. Throttle it to
// at most once every few seconds — it only feeds a "last scan" display, so
// sub-second freshness isn't needed.
const EVENT_STATUS_THROTTLE_MS = 5000;
let lastEventStatusUpdate = 0;

const trackedAddresses = new Set();
let tokensDiscoveredCount = 0;
let tokensAnalyzedCount = 0;

function log(...args) {
  console.log(`[scanner ${new Date().toISOString()}]`, ...args);
}

// Rejections aren't always Error instances (a caught non-Error throw, or a
// rejection value that's undefined), so never assume err.message exists.
function errMsg(err) {
  if (!err) return "unknown error";
  return err.message || String(err);
}

// ---------------------------------------------------------------------------
// scanner_status helpers
// ---------------------------------------------------------------------------

async function updateStatus(patch) {
  try {
    const supabase = getServiceClient();
    const { data: existing } = await supabase.from("scanner_status").select("id").limit(1).maybeSingle();

    if (existing) {
      await supabase.from("scanner_status").update(patch).eq("id", existing.id);
    } else {
      await supabase.from("scanner_status").insert(patch);
    }
  } catch (err) {
    log("failed to update scanner_status:", errMsg(err));
  }
}

function setStatus(status) {
  return updateStatus({ status });
}

// ---------------------------------------------------------------------------
// Candidate confirmation + snapshot pipeline
// ---------------------------------------------------------------------------

async function handleCandidate(address) {
  if (!address || trackedAddresses.has(address)) return;

  const marketData = await dexscreener.getTokenByAddress(address);

  if (!marketData || marketData.dataStatus === "unavailable" || !marketData.pairAddress) {
    // No tradable pair confirmed yet — do not store as a discovered token.
    return;
  }

  trackedAddresses.add(address);

  try {
    await upsertToken(marketData);
    tokensDiscoveredCount += 1;
    log("discovered token", marketData.symbol || address, address);
    await updateStatus({
      last_token_discovered_at: new Date().toISOString(),
      tokens_discovered: tokensDiscoveredCount
    });
  } catch (err) {
    log("failed to store token", address, errMsg(err));
    return;
  }

  await analyzeAndSnapshot(address);
}

async function analyzeAndSnapshot(address) {
  const marketData = await dexscreener.getTokenByAddress(address);

  if (!marketData || marketData.dataStatus === "unavailable") {
    // Provider error handling (spec section 33): keep previous snapshot,
    // record an "unavailable" snapshot marker rather than fabricating data.
    await insertSnapshot({ address, dataStatus: "unavailable" });
    return;
  }

  let baseline = null;
  try {
    baseline = await getBaselineSnapshot(address, 5);
  } catch (err) {
    log("baseline lookup failed", address, errMsg(err));
  }

  const volumeRatio = baseline ? calculateVolumeRatio(marketData.volume5m, baseline.volume_5m) : null;

  const buyPressureScore = calculateBuyPressureScore({
    buyVolume: marketData.buyVolume5m,
    sellVolume: marketData.sellVolume5m,
    buyCount: marketData.buys5m,
    sellCount: marketData.sells5m
  });

  const ageMinutes = computeTokenAgeMinutes(marketData.pairCreatedAt);
  const hasActivity = (marketData.volume5m || 0) > 0 || (marketData.buys5m || 0) + (marketData.sells5m || 0) > 0;

  const momentumScore = calculateMomentumScore({
    priceChangePercent: marketData.priceChange5m,
    volumeRatio,
    buyPressureScore
  });

  const { opportunityScore } = calculateOpportunityScore({
    priceChangePercent: marketData.priceChange5m,
    volumeRatio,
    buyVolume: marketData.buyVolume5m,
    sellVolume: marketData.sellVolume5m,
    buyCount: marketData.buys5m,
    sellCount: marketData.sells5m,
    liquidityUsd: marketData.liquidity,
    ageMinutes,
    hasActivity
  });

  const signal = classifySignal({
    ageMinutes,
    volumeRatio,
    buyPressureScore,
    priceChangePercent: marketData.priceChange5m,
    hasActivity
  });

  await insertSnapshot({
    address,
    price: marketData.price,
    liquidity: marketData.liquidity,
    marketCap: marketData.marketCap,
    volume5m: marketData.volume5m,
    priceChange5m: marketData.priceChange5m,
    buys1m: marketData.buys5m,
    sells1m: marketData.sells5m,
    momentumScore,
    opportunityScore,
    signal,
    dataStatus: "ok"
  });

  tokensAnalyzedCount += 1;
  await updateStatus({
    last_successful_api_call: new Date().toISOString(),
    tokens_analyzed: tokensAnalyzedCount
  });
}

// ---------------------------------------------------------------------------
// Polling loop for already-tracked tokens
// ---------------------------------------------------------------------------

async function pollTrackedTokens() {
  for (const address of trackedAddresses) {
    try {
      await analyzeAndSnapshot(address);
    } catch (err) {
      log("snapshot failed for", address, errMsg(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback discovery (spec section 5) — only used while realtime is degraded
// ---------------------------------------------------------------------------

let fallbackTimer = null;

function startFallbackPolling() {
  if (fallbackTimer) return;
  log("starting fallback discovery polling (degraded mode)");
  fallbackTimer = setInterval(async () => {
    try {
      const addresses = await dexscreener.pollRecentSolanaPairs();
      for (const address of addresses) {
        await handleCandidate(address);
      }
    } catch (err) {
      log("fallback polling error:", errMsg(err));
    }
  }, FALLBACK_POLL_INTERVAL_MS);
}

function stopFallbackPolling() {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap: resume tracking tokens already discovered in past runs
// ---------------------------------------------------------------------------

async function loadExistingTokens() {
  try {
    const tokens = await listRecentTokens(500);
    for (const token of tokens) {
      trackedAddresses.add(token.address);
    }
    log(`resumed tracking ${trackedAddresses.size} existing tokens`);
  } catch (err) {
    log("failed to load existing tokens:", errMsg(err));
  }
}

// Wraps handleCandidate with a concurrency cap (see MAX_CONCURRENT_CANDIDATES
// above) so a burst of noisy candidates can't open unbounded outbound
// connections. Candidates arriving over the cap are dropped, not queued —
// they're speculative addresses extracted from raw logs, so losing a few
// under load is safe and expected.
function tryHandleCandidate(address) {
  if (activeCandidateCount >= MAX_CONCURRENT_CANDIDATES) {
    return;
  }
  activeCandidateCount += 1;
  handleCandidate(address)
    .catch((err) => log("candidate handling error:", errMsg(err)))
    .finally(() => {
      activeCandidateCount -= 1;
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Solana AI scanner starting");
  await setStatus("OFFLINE");
  await loadExistingTokens();

  const stream = new SolanaDiscoveryStream({ reconnectDelayMs: RECONNECT_DELAY_MS });

  stream.on("connected", () => {
    log("WebSocket connected — scanner is LIVE");
    stopFallbackPolling();
    setStatus("LIVE");
  });

  stream.on("event", () => {
    const now = Date.now();
    if (now - lastEventStatusUpdate < EVENT_STATUS_THROTTLE_MS) return;
    lastEventStatusUpdate = now;
    updateStatus({ last_event_at: new Date().toISOString() });
  });

  stream.on("candidate", ({ address }) => {
    tryHandleCandidate(address);
  });

  stream.on("reconnecting", ({ delay, attempt }) => {
    log(`WebSocket disconnected — reconnecting in ${delay}ms (attempt ${attempt})`);
    setStatus("DEGRADED");
    startFallbackPolling();
  });

  stream.on("error", (err) => {
    log("WebSocket error:", errMsg(err));
    updateStatus({ last_error: errMsg(err), status: "DEGRADED" });
    startFallbackPolling();
  });

  stream.start();

  // Periodically refresh snapshots for everything we're already tracking.
  setInterval(() => {
    pollTrackedTokens().catch((err) => log("poll loop error:", errMsg(err)));
  }, MARKET_POLL_INTERVAL_MS);

  process.on("SIGINT", () => {
    log("shutting down");
    stream.stop();
    stopFallbackPolling();
    setStatus("OFFLINE").finally(() => process.exit(0));
  });
}

main().catch((err) => {
  log("fatal error, exiting:", err);
  process.exit(1);
});