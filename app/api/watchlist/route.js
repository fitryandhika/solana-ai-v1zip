// app/api/watchlist/route.js
//
// GET    /api/watchlist         — list watchlisted tokens with live data
// POST   /api/watchlist         — add a token address to the watchlist
// DELETE /api/watchlist         — remove a token from the watchlist
//
// Watchlisting is a flag on the `tokens` table (see
// migration_009_watchlist.sql) — a watchlisted token gets the SAME full
// tracking (snapshots, rug-check, outcome tracking) as an auto-discovered
// one. If the address isn't already tracked, this route confirms it via
// DexScreener and runs the same one-time checks the scanner would.

import { NextResponse } from "next/server";
import {
  getTokenByAddress,
  upsertToken,
  setTokenWatchlisted,
  removeTokenFromWatchlist
} from "../../../lib/database/tokens";
import { getLatestSnapshotsForAllTokens } from "../../../lib/database/snapshots";
import { insertInitialOutcome } from "../../../lib/database/outcomes";
import { getServiceClient } from "../../../lib/database/supabase";
import { getTokenByAddress as fetchTokenFromDexscreener } from "../../../lib/providers/dexscreener";
import { runDiscoveryChecks } from "../../../lib/solana/rug-check";
import { computeTokenAgeMinutes } from "../../../lib/utils/format";

export const dynamic = "force-dynamic";

function isValidSolanaAddress(address) {
  return typeof address === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

export async function GET() {
  try {
    const supabase = getServiceClient();
    const { data: tokens, error } = await supabase
      .from("tokens")
      .select("*")
      .eq("watchlisted", true)
      .order("watchlisted_at", { ascending: false });

    if (error) throw error;

    const addresses = (tokens || []).map((t) => t.address);
    const snapshots = await getLatestSnapshotsForAllTokens({ addresses });
    const snapshotByAddress = new Map(snapshots.map((s) => [s.token_address, s]));

    const watchlist = (tokens || []).map((token) => {
      const snapshot = snapshotByAddress.get(token.address) || null;
      return {
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        imageUrl: token.image_url,
        dex: token.dex,
        note: token.watchlist_note,
        watchlistedAt: token.watchlisted_at,
        ageMinutes: computeTokenAgeMinutes(token.pair_created_at, token.first_seen_at),
        price: snapshot?.price ?? null,
        liquidity: snapshot?.liquidity ?? null,
        marketCap: snapshot?.market_cap ?? null,
        volume5m: snapshot?.volume_5m ?? null,
        priceChange5m: snapshot?.price_change_5m ?? null,
        opportunityScore: snapshot?.opportunity_score ?? null,
        signal: snapshot?.signal ?? null,
        dataStatus: snapshot?.data_status ?? "unavailable"
      };
    });

    return NextResponse.json({ success: true, watchlist });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const address = (body.address || "").trim();
    const note = (body.note || "").trim();

    if (!isValidSolanaAddress(address)) {
      return NextResponse.json({ success: false, error: "Alamat token Solana tidak valid" }, { status: 400 });
    }

    const existing = await getTokenByAddress(address);

    if (existing) {
      await setTokenWatchlisted(address, note);
      return NextResponse.json({ success: true, alreadyTracked: true });
    }

    // Not tracked yet — confirm it's a real tradable token via DexScreener,
    // the same way the scanner would when discovering one, before adding
    // it to the watchlist.
    const marketData = await fetchTokenFromDexscreener(address);

    if (!marketData || marketData.dataStatus === "unavailable" || !marketData.pairAddress) {
      return NextResponse.json(
        { success: false, error: "Token tidak ditemukan atau belum punya pair trading di DexScreener" },
        { status: 404 }
      );
    }

    let rugCheck = { mintAuthorityRevoked: null, freezeAuthorityRevoked: null, rugCheckError: "not checked", top10HolderPct: null };
    try {
      rugCheck = await runDiscoveryChecks(address);
    } catch (err) {
      rugCheck.rugCheckError = err.message;
    }

    await upsertToken({
      ...marketData,
      source: "watchlist",
      ageAtDiscoveryMinutes: computeTokenAgeMinutes(marketData.pairCreatedAt),
      mintAuthorityRevoked: rugCheck.mintAuthorityRevoked,
      freezeAuthorityRevoked: rugCheck.freezeAuthorityRevoked,
      rugCheckAt: new Date().toISOString(),
      rugCheckError: rugCheck.rugCheckError,
      top10HolderPct: rugCheck.top10HolderPct
    });

    await setTokenWatchlisted(address, note);

    try {
      await insertInitialOutcome({
        address,
        discoveredAt: new Date().toISOString(),
        discoveryPrice: marketData.price,
        discoveryLiquidity: marketData.liquidity,
        discoveryMarketCap: marketData.marketCap,
        discoveryOpportunityScore: null,
        discoverySignal: null
      });
    } catch (err) {
      // Best-effort — outcome tracking baseline missing isn't fatal to
      // adding the token to the watchlist itself.
    }

    return NextResponse.json({ success: true, alreadyTracked: false });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const body = await request.json();
    const address = (body.address || "").trim();

    if (!isValidSolanaAddress(address)) {
      return NextResponse.json({ success: false, error: "Alamat token Solana tidak valid" }, { status: 400 });
    }

    await removeTokenFromWatchlist(address);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
