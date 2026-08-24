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
const {
  upsertToken,
  listRecentTokens,
  getCreatorHistory,
  getTotalTokenCount,
  getTokensMissingImage,
  updateTokenImage,
  getWatchlistedAddresses
} = require("../lib/database/tokens");
const { insertSnapshot, getBaselineSnapshot, getSnapshotAtOrAfter, getFirstSnapshot, getTotalAnalyzedCount } = require("../lib/database/snapshots");
const { getServiceClient } = require("../lib/database/supabase");
const { calculateVolumeRatio, calculateMomentumScore, calculateBuyPressureScore } = require("../lib/analyzer/momentum");
const { calculateOpportunityScore, classifySignal } = require("../lib/analyzer/opportunity");
const { computeTokenAgeMinutes } = require("../lib/utils/format");
const { runDiscoveryChecks } = require("../lib/solana/rug-check");
const { insertInitialOutcome, updateOutcome, getFinalizedAddresses, getInProgressOutcomes } = require("../lib/database/outcomes");
const { HORIZONS, getDueHorizons, buildHorizonPatch } = require("../lib/analyzer/outcomes");
const { scanForWhaleTrades } = require("../lib/solana/whale-transactions");
const {
  insertWalletTrade,
  getTokenWhaleScanCursor,
  setTokenWhaleScanCursor,
  getWalletsToScore,
  getEarlyBuysWithOutcomes,
  updateWalletScore
} = require("../lib/database/whales");
const { computeWalletScore } = require("../lib/analyzer/whale-stats");

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

// Tracks when we first started tracking each token and when it last got a
// snapshot written — used to throttle snapshot frequency for older tokens
// (see SPARSE_SNAPSHOT_INTERVAL_MS below), so months of continuous scanning
// doesn't silently blow past Supabase's storage limit.
const trackedSince = new Map();
const lastSnapshotAt = new Map();

// Snapshots stay at full MARKET_POLL_INTERVAL_MS frequency for a token's
// first 24h — that's the window where momentum/signal evaluation matters
// most. After that, drop to one snapshot every few minutes; the token is
// still tracked forever, just not at full density once its early window
// has passed. This keeps storage growth bounded without ever deleting
// history.
const DENSE_SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000;
const SPARSE_SNAPSHOT_INTERVAL_MS = Number(process.env.SPARSE_SNAPSHOT_INTERVAL_MS || 5 * 60 * 1000);

// Discovery-time price/liquidity for each token, needed to compute
// price_change_pct_<horizon> without an extra DB read on every outcome
// check. Populated once, at discovery, in handleCandidate.
const discoverySnapshotByAddress = new Map();

// Which outcome horizons have already been computed for each token, and
// which tokens are fully finalized (24h horizon done — never need checking
// again). Both populated from the DB at startup so a restart doesn't
// re-walk months of already-finalized tokens.
const computedHorizonsByAddress = new Map();
const finalizedAddresses = new Set();

const OUTCOME_CHECK_INTERVAL_MS = Number(process.env.OUTCOME_CHECK_INTERVAL_MS || 60000);

// Whale tracking — pair address cache (needed to scan for swap
// transactions), plus config for how much of each cycle's RPC budget this
// feature is allowed to use. Deliberately conservative: this shares the
// same 10 req/sec Helius budget as blockchain discovery and rug-checks,
// which matter more for the core product.
const pairAddressByAddress = new Map();
const WHALE_SCAN_INTERVAL_MS = Number(process.env.WHALE_SCAN_INTERVAL_MS || 120000);
const WHALE_SCAN_BATCH_SIZE = Number(process.env.WHALE_SCAN_BATCH_SIZE || 5);
const WHALE_EARLY_BUY_WINDOW_MS = Number(process.env.WHALE_EARLY_BUY_WINDOW_MS || 2 * 60 * 60 * 1000); // 2h
const WALLET_RESCORE_INTERVAL_MS = Number(process.env.WALLET_RESCORE_INTERVAL_MS || 30 * 60 * 1000); // 30 min

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

// scanner_status is meant to hold exactly one row. Using a fixed, known id
// with upsert (instead of "select the existing row, then insert or update")
// makes that a real guarantee enforced by the database's primary key,
// rather than a race between whatever processes happen to call this at the
// same time — which is what created duplicate rows before.
const SCANNER_STATUS_ROW_ID = "00000000-0000-0000-0000-000000000001";

async function updateStatus(patch) {
  try {
    const supabase = getServiceClient();
    await supabase.from("scanner_status").upsert(
      { id: SCANNER_STATUS_ROW_ID, ...patch },
      { onConflict: "id" }
    );
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

async function handleCandidate(address, meta = {}) {
  if (!address || trackedAddresses.has(address)) return;

  const marketData = await dexscreener.getTokenByAddress(address);

  if (!marketData || marketData.dataStatus === "unavailable" || !marketData.pairAddress) {
    // No tradable pair confirmed yet — do not store as a discovered token.
    return;
  }

  trackedAddresses.add(address);
  const discoveredAt = Date.now();
  trackedSince.set(address, discoveredAt);
  pairAddressByAddress.set(address, marketData.pairAddress);

  // One-time rug-risk checks (mint/freeze authority, holder concentration).
  // Best-effort — a failure here shouldn't block storing the token itself,
  // since that would mean losing a real discovery over a diagnostic check.
  let rugCheck = { mintAuthorityRevoked: null, freezeAuthorityRevoked: null, rugCheckError: "not checked", top10HolderPct: null };
  try {
    rugCheck = await runDiscoveryChecks(address);
  } catch (err) {
    rugCheck.rugCheckError = errMsg(err);
  }

  const creator = meta.creator || marketData.creator || null;

  // Creator history is computed from our OWN data (see
  // migration_005_creator_history.sql) — no extra external calls. Best-
  // effort: a failure here shouldn't block storing the token itself.
  let creatorHistory = { priorTokenCount: null, priorRugCount: null, priorAvgPriceChangePct24h: null };
  if (creator) {
    try {
      creatorHistory = await getCreatorHistory(creator, address);
    } catch (err) {
      log("creator history lookup failed for", creator, errMsg(err));
    }
  }

  try {
    await upsertToken({
      ...marketData,
      creator,
      source: meta.source || "trending",
      ageAtDiscoveryMinutes: computeTokenAgeMinutes(marketData.pairCreatedAt),
      mintAuthorityRevoked: rugCheck.mintAuthorityRevoked,
      freezeAuthorityRevoked: rugCheck.freezeAuthorityRevoked,
      rugCheckAt: new Date().toISOString(),
      rugCheckError: rugCheck.rugCheckError,
      top10HolderPct: rugCheck.top10HolderPct,
      creatorPriorTokenCount: creatorHistory.priorTokenCount,
      creatorPriorRugCount: creatorHistory.priorRugCount,
      creatorPriorAvgPriceChangePct24h: creatorHistory.priorAvgPriceChangePct24h
    });
    tokensDiscoveredCount += 1;
    log("discovered token", marketData.symbol || address, address, `source=${meta.source || "trending"}`);
    await updateStatus({
      last_token_discovered_at: new Date().toISOString(),
      tokens_discovered: tokensDiscoveredCount
    });
  } catch (err) {
    log("failed to store token", address, errMsg(err));
    return;
  }

  await analyzeAndSnapshot(address).then(async (initialSnapshot) => {
    if (!initialSnapshot) return; // Confirmed as a token but no market data yet — outcome tracking starts once we have a real price to compare against.

    discoverySnapshotByAddress.set(address, {
      price: initialSnapshot.price,
      liquidity: initialSnapshot.liquidity
    });
    computedHorizonsByAddress.set(address, new Set());

    try {
      await insertInitialOutcome({
        address,
        discoveredAt: new Date(discoveredAt).toISOString(),
        discoveryPrice: initialSnapshot.price,
        discoveryLiquidity: initialSnapshot.liquidity,
        discoveryMarketCap: initialSnapshot.marketCap,
        discoveryOpportunityScore: initialSnapshot.opportunityScore,
        discoverySignal: initialSnapshot.signal
      });
    } catch (err) {
      log("failed to create initial outcome row for", address, errMsg(err));
    }
  });
}

async function analyzeAndSnapshot(address, solPriceUsd = null) {
  const marketData = await dexscreener.getTokenByAddress(address);

  if (!marketData || marketData.dataStatus === "unavailable") {
    // Provider error handling (spec section 33): keep previous snapshot,
    // record an "unavailable" snapshot marker rather than fabricating data.
    await insertSnapshot({ address, dataStatus: "unavailable", solPriceUsd });
    return null;
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
    buys5m: marketData.buys5m,
    sells5m: marketData.sells5m,
    momentumScore,
    opportunityScore,
    signal,
    dataStatus: "ok",
    solPriceUsd
  });

  tokensAnalyzedCount += 1;
  await updateStatus({
    last_successful_api_call: new Date().toISOString(),
    tokens_analyzed: tokensAnalyzedCount
  });

  return {
    price: marketData.price,
    liquidity: marketData.liquidity,
    marketCap: marketData.marketCap,
    opportunityScore,
    signal
  };
}

// ---------------------------------------------------------------------------
// Polling loop for already-tracked tokens
// ---------------------------------------------------------------------------

async function pollTrackedTokens() {
  const now = Date.now();
  const solPriceUsd = await dexscreener.getSolPriceUsd().catch(() => null);

  for (const address of trackedAddresses) {
    const since = trackedSince.get(address) || now;
    const isDense = now - since < DENSE_SNAPSHOT_WINDOW_MS;
    const requiredIntervalMs = isDense ? 0 : SPARSE_SNAPSHOT_INTERVAL_MS;
    const last = lastSnapshotAt.get(address) || 0;

    if (!isDense && now - last < requiredIntervalMs) {
      continue; // Older token, not due for its next (sparser) snapshot yet.
    }

    try {
      await analyzeAndSnapshot(address, solPriceUsd);
      lastSnapshotAt.set(address, now);
    } catch (err) {
      log("snapshot failed for", address, errMsg(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Outcome tracking — computes price_change_pct_<horizon> for every token
// once each horizon (1m, 5m, 15m, 30m, 1h, 4h, 24h since discovery) is
// reached. This is what turns raw snapshots into a ready-to-query
// evaluation dataset (see database/migration_004_outcomes.sql).
// ---------------------------------------------------------------------------

async function checkOutcomesDue() {
  const now = Date.now();

  for (const address of trackedAddresses) {
    if (finalizedAddresses.has(address)) continue;

    const discoveredAt = trackedSince.get(address);
    const discovery = discoverySnapshotByAddress.get(address);
    if (!discoveredAt || !discovery) continue; // Not yet confirmed with real market data.

    const alreadyComputed = computedHorizonsByAddress.get(address) || new Set();
    const due = getDueHorizons(discoveredAt, now, alreadyComputed);
    if (due.length === 0) continue;

    for (const horizon of due) {
      try {
        const targetTimestamp = new Date(discoveredAt + horizon.ms).toISOString();
        const outcomeSnapshot = await getSnapshotAtOrAfter(address, targetTimestamp);
        const patch = buildHorizonPatch(horizon.label, discovery, outcomeSnapshot);

        if (!patch) continue; // No snapshot reached that far yet — try again next cycle.

        await updateOutcome(address, patch);
        alreadyComputed.add(horizon.label);
        computedHorizonsByAddress.set(address, alreadyComputed);

        if (horizon.label === "24h") {
          await updateOutcome(address, { finalized_at: new Date().toISOString() });
          finalizedAddresses.add(address);
          // Free the in-memory caches for a finalized token — they're only
          // needed while outcome computation is still in progress.
          discoverySnapshotByAddress.delete(address);
          computedHorizonsByAddress.delete(address);
        }
      } catch (err) {
        log("outcome check failed for", address, horizon.label, errMsg(err));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Whale tracking — detects buy/sell trades from real transaction data for a
// small rotating batch of tracked tokens each cycle (see
// lib/solana/whale-transactions.js for the detection method and its
// documented limitations). Deliberately bounded in scope and RPC usage —
// this is a secondary feature sharing the same rate-limited RPC budget as
// core token discovery.
// ---------------------------------------------------------------------------

async function checkWhaleActivityBatch(solPriceUsd) {
  const now = Date.now();
  const candidates = Array.from(trackedAddresses).filter((address) => {
    const since = trackedSince.get(address);
    return since && now - since < DENSE_SNAPSHOT_WINDOW_MS && pairAddressByAddress.get(address);
  });

  const batch = candidates.slice(0, WHALE_SCAN_BATCH_SIZE);

  for (const tokenAddress of batch) {
    try {
      const pairAddress = pairAddressByAddress.get(tokenAddress);
      const sinceSignature = await getTokenWhaleScanCursor(tokenAddress);
      const discoveredAt = trackedSince.get(tokenAddress);

      const { trades, newestSignature } = await scanForWhaleTrades({
        pairAddress,
        tokenAddress,
        sinceSignature,
        solPriceUsd
      });

      for (const trade of trades) {
        const isEarlyBuy =
          trade.direction === "buy" && discoveredAt && new Date(trade.tradedAt).getTime() - discoveredAt <= WHALE_EARLY_BUY_WINDOW_MS;

        await insertWalletTrade({ ...trade, isEarlyBuy });
      }

      if (newestSignature && newestSignature !== sinceSignature) {
        await setTokenWhaleScanCursor(tokenAddress, newestSignature);
      }
    } catch (err) {
      log("whale scan failed for", tokenAddress, errMsg(err));
    }
  }
}

async function rescoreWallets() {
  try {
    const addresses = await getWalletsToScore();
    for (const address of addresses) {
      try {
        const earlyBuys = await getEarlyBuysWithOutcomes(address);
        const { smartScore, earlyBuyCount, earlyWinCount } = computeWalletScore(earlyBuys);
        const totalBuyUsd = earlyBuys.reduce((sum, t) => sum + (t.usd_value || 0), 0);
        await updateWalletScore(address, { smartScore, earlyBuyCount, earlyWinCount, totalBuyUsd });
      } catch (err) {
        log("wallet scoring failed for", address, errMsg(err));
      }
    }
    log(`wallet scoring pass: ${addresses.length} wallets checked`);
  } catch (err) {
    log("wallet rescore pass failed:", errMsg(err));
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
        await handleCandidate(address, { source: "trending" });
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
// Trending discovery — finds tokens that are ALREADY established but showing
// renewed activity, not just brand-new ones. The blockchain WebSocket stream
// above only ever sees a token at the moment its pool is first created, so
// on its own it can never surface "this 3-day-old token just started picking
// up volume again." This runs continuously (not just when the realtime
// stream is degraded) alongside it, feeding the same confirm → track →
// score pipeline. The scoring itself already supports this — classifySignal
// has a MOMENTUM category specifically for non-new tokens with strong
// renewed volume/price movement (see lib/analyzer/opportunity.js) — the gap
// was purely that we never looked at anything but freshly created tokens.
const TRENDING_POLL_INTERVAL_MS = Number(process.env.TRENDING_POLL_INTERVAL_MS || 300000); // 5 min default
let trendingTimer = null;

function startTrendingPolling() {
  if (trendingTimer) return;
  log("starting trending-token discovery polling");
  trendingTimer = setInterval(async () => {
    try {
      const addresses = await dexscreener.pollRecentSolanaPairs();
      for (const address of addresses) {
        await handleCandidate(address, { source: "trending" });
      }
    } catch (err) {
      log("trending polling error:", errMsg(err));
    }
  }, TRENDING_POLL_INTERVAL_MS);
}

function stopTrendingPolling() {
  if (trendingTimer) {
    clearInterval(trendingTimer);
    trendingTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Logo backfill — tokens discovered before the image feature existed (or
// where DexScreener simply hadn't indexed artwork yet at discovery time)
// never get an image_url otherwise, since a token's own upsert only runs
// once, at discovery. This periodically checks a small batch and fills in
// any that have since gotten a logo. Uses dexscreener.js's own built-in
// request throttle — no extra rate-limit handling needed here.
// ---------------------------------------------------------------------------

const IMAGE_BACKFILL_INTERVAL_MS = Number(process.env.IMAGE_BACKFILL_INTERVAL_MS || 30 * 60 * 1000);
const IMAGE_BACKFILL_BATCH_SIZE = Number(process.env.IMAGE_BACKFILL_BATCH_SIZE || 50);

async function backfillMissingImages() {
  try {
    const addresses = await getTokensMissingImage(IMAGE_BACKFILL_BATCH_SIZE);
    if (addresses.length === 0) return;

    let filled = 0;
    for (const address of addresses) {
      const marketData = await dexscreener.getTokenByAddress(address);
      if (marketData?.imageUrl) {
        await updateTokenImage(address, marketData.imageUrl);
        filled += 1;
      }
    }
    log(`image backfill: checked ${addresses.length}, filled ${filled}`);
  } catch (err) {
    log("image backfill failed:", errMsg(err));
  }
}

// ---------------------------------------------------------------------------
// Watchlist sync — picks up tokens added to the watchlist via the API
// (app/api/watchlist/route.js) while the scanner is already running, so
// they start getting full tracking (snapshots, outcome checks, whale scan)
// without needing a restart. Cheap: just a DB query, no RPC calls.
// ---------------------------------------------------------------------------

const WATCHLIST_SYNC_INTERVAL_MS = Number(process.env.WATCHLIST_SYNC_INTERVAL_MS || 2 * 60 * 1000);

async function syncWatchlistedTokens() {
  try {
    const watchlisted = await getWatchlistedAddresses();
    let added = 0;

    for (const { address, pair_address: pairAddress } of watchlisted) {
      if (trackedAddresses.has(address)) continue;

      trackedAddresses.add(address);
      trackedSince.set(address, Date.now());
      if (pairAddress) pairAddressByAddress.set(address, pairAddress);
      added += 1;

      // Give it a baseline snapshot + outcome tracking right away, same as
      // any other newly-tracked token.
      const initialSnapshot = await analyzeAndSnapshot(address).catch((err) => {
        log("watchlist sync: initial snapshot failed for", address, errMsg(err));
        return null;
      });

      if (initialSnapshot) {
        discoverySnapshotByAddress.set(address, { price: initialSnapshot.price, liquidity: initialSnapshot.liquidity });
        computedHorizonsByAddress.set(address, new Set());
      }
    }

    if (added > 0) {
      log(`watchlist sync: started tracking ${added} newly watchlisted token(s)`);
    }
  } catch (err) {
    log("watchlist sync failed:", errMsg(err));
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
      const firstSeenMs = token.first_seen_at ? new Date(token.first_seen_at).getTime() : Date.now();
      trackedSince.set(token.address, firstSeenMs);
      if (token.pair_address) pairAddressByAddress.set(token.address, token.pair_address);
    }
    log(`resumed tracking ${trackedAddresses.size} existing tokens`);
  } catch (err) {
    log("failed to load existing tokens:", errMsg(err));
  }

  // tokensDiscoveredCount/tokensAnalyzedCount are in-memory counters that
  // otherwise reset to 0 on every restart even though the underlying data
  // in Supabase is untouched — resuming them here keeps the dashboard's
  // "Tokens Discovered"/"Tokens Analyzed" figures accurate across restarts.
  try {
    tokensDiscoveredCount = await getTotalTokenCount();
    tokensAnalyzedCount = await getTotalAnalyzedCount();
    await updateStatus({ tokens_discovered: tokensDiscoveredCount, tokens_analyzed: tokensAnalyzedCount });
    log(`resumed counters: ${tokensDiscoveredCount} discovered, ${tokensAnalyzedCount} analyzed`);
  } catch (err) {
    log("failed to resume discovered/analyzed counters:", errMsg(err));
  }

  try {
    const finalized = await getFinalizedAddresses();
    for (const address of finalized) {
      finalizedAddresses.add(address);
    }
    log(`${finalizedAddresses.size} tokens already have finalized outcomes`);
  } catch (err) {
    log("failed to load finalized outcome addresses:", errMsg(err));
  }

  try {
    const inProgressAddresses = Array.from(trackedAddresses).filter((a) => !finalizedAddresses.has(a));
    const inProgress = await getInProgressOutcomes(inProgressAddresses);
    for (const row of inProgress) {
      discoverySnapshotByAddress.set(row.token_address, {
        price: row.discovery_price,
        liquidity: row.discovery_liquidity
      });
      const computed = new Set(HORIZONS.filter((h) => row[`price_change_pct_${h.label}`] !== null).map((h) => h.label));
      computedHorizonsByAddress.set(row.token_address, computed);
    }
    log(`resumed outcome tracking for ${inProgress.length} in-progress tokens`);
  } catch (err) {
    log("failed to resume in-progress outcome tracking:", errMsg(err));
  }

  // Backfill: tokens discovered before outcome tracking existed have no
  // token_outcomes row yet. Use their earliest snapshot as the discovery
  // baseline so they still end up in the evaluation dataset going forward,
  // instead of being silently excluded forever.
  const missingOutcome = Array.from(trackedAddresses).filter(
    (a) => !finalizedAddresses.has(a) && !discoverySnapshotByAddress.has(a)
  );
  for (const address of missingOutcome) {
    try {
      const firstSnapshot = await getFirstSnapshot(address);
      if (!firstSnapshot || firstSnapshot.data_status !== "ok") continue;

      const discoveredAt = trackedSince.get(address) || Date.now();
      await insertInitialOutcome({
        address,
        discoveredAt: new Date(discoveredAt).toISOString(),
        discoveryPrice: firstSnapshot.price,
        discoveryLiquidity: firstSnapshot.liquidity,
        discoveryMarketCap: firstSnapshot.market_cap,
        discoveryOpportunityScore: firstSnapshot.opportunity_score,
        discoverySignal: firstSnapshot.signal
      });
      discoverySnapshotByAddress.set(address, { price: firstSnapshot.price, liquidity: firstSnapshot.liquidity });
      computedHorizonsByAddress.set(address, new Set());
    } catch (err) {
      log("failed to backfill outcome baseline for", address, errMsg(err));
    }
  }
  if (missingOutcome.length > 0) {
    log(`backfilled outcome baseline for ${missingOutcome.length} pre-existing tokens`);
  }
}

// Wraps handleCandidate with a concurrency cap (see MAX_CONCURRENT_CANDIDATES
// above) so a burst of noisy candidates can't open unbounded outbound
// connections. Candidates arriving over the cap are dropped, not queued —
// they're speculative addresses extracted from raw logs, so losing a few
// under load is safe and expected.
function tryHandleCandidate(address, meta) {
  if (activeCandidateCount >= MAX_CONCURRENT_CANDIDATES) {
    return;
  }
  activeCandidateCount += 1;
  handleCandidate(address, meta)
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

  stream.on("candidate", ({ address, creator, source }) => {
    tryHandleCandidate(address, { creator, source: source || "blockchain" });
  });

  // Temporary diagnostic visibility into the discovery pipeline — shows
  // whether transaction lookups are succeeding and how many candidate
  // addresses each one yields, so "zero tokens discovered" can be traced to
  // a specific stage instead of failing silently.
  stream.on("debug", (message) => {
    log("debug:", message);
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

  // Trending-token discovery runs continuously alongside the realtime
  // stream — it's not a fallback, it's a second, independent discovery
  // source for tokens that already exist but are showing renewed activity.
  startTrendingPolling();

  // Fill in logos for tokens that didn't have one yet, then keep checking
  // periodically for tokens whose artwork becomes available later.
  backfillMissingImages();
  setInterval(() => {
    backfillMissingImages();
  }, IMAGE_BACKFILL_INTERVAL_MS);

  // Pick up tokens added to the watchlist via the API — checked right away
  // at startup, then periodically so additions don't wait for a restart.
  syncWatchlistedTokens();
  setInterval(() => {
    syncWatchlistedTokens();
  }, WATCHLIST_SYNC_INTERVAL_MS);

  // Periodically refresh snapshots for everything we're already tracking.
  setInterval(() => {
    pollTrackedTokens().catch((err) => log("poll loop error:", errMsg(err)));
  }, MARKET_POLL_INTERVAL_MS);

  // Periodically compute due outcome horizons (1m/5m/15m/30m/1h/4h/24h).
  // Runs on its own, coarser interval — horizons don't need checking as
  // often as snapshots do.
  setInterval(() => {
    checkOutcomesDue().catch((err) => log("outcome check loop error:", errMsg(err)));
  }, OUTCOME_CHECK_INTERVAL_MS);

  // Whale tracking: scan a small rotating batch of tracked tokens for
  // buy/sell activity, then periodically recompute wallet scores from
  // whatever's been detected so far.
  setInterval(() => {
    dexscreener
      .getSolPriceUsd()
      .catch(() => null)
      .then((solPriceUsd) => checkWhaleActivityBatch(solPriceUsd))
      .catch((err) => log("whale scan loop error:", errMsg(err)));
  }, WHALE_SCAN_INTERVAL_MS);

  setInterval(() => {
    rescoreWallets().catch((err) => log("wallet rescore loop error:", errMsg(err)));
  }, WALLET_RESCORE_INTERVAL_MS);

  process.on("SIGINT", () => {
    log("shutting down");
    stream.stop();
    stopFallbackPolling();
    stopTrendingPolling();
    setStatus("OFFLINE").finally(() => process.exit(0));
  });
}

main().catch((err) => {
  log("fatal error, exiting:", err);
  process.exit(1);
});
