// app/api/tokens/route.js
// GET /api/tokens?minScore=&maxAge=&minLiquidity=&signal=&sort=&limit=
//
// Returns the latest discovered tokens, joined with their most recent
// snapshot, filtered/sorted per query params (spec section 28).

import { NextResponse } from "next/server";
import { listRecentTokens } from "../../../lib/database/tokens";
import { getLatestSnapshotsForAllTokens } from "../../../lib/database/snapshots";
import { computeTokenAgeMinutes } from "../../../lib/utils/format";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const minScore = searchParams.get("minScore") ? Number(searchParams.get("minScore")) : null;
    const maxAge = searchParams.get("maxAge") ? Number(searchParams.get("maxAge")) : null;
    const minLiquidity = searchParams.get("minLiquidity") ? Number(searchParams.get("minLiquidity")) : null;
    const signalFilter = searchParams.get("signal");
    const sort = searchParams.get("sort") || "score";
    const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : 100;

    const [tokens, snapshots] = await Promise.all([
      listRecentTokens(500),
      getLatestSnapshotsForAllTokens({ windowSize: 2000 })
    ]);

    const snapshotByAddress = new Map(snapshots.map((s) => [s.token_address, s]));

    let merged = tokens.map((token) => {
      const snapshot = snapshotByAddress.get(token.address) || null;
      const ageMinutes = computeTokenAgeMinutes(token.pair_created_at, token.first_seen_at);

      return {
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        dex: token.dex,
        pairAddress: token.pair_address,
        pairCreatedAt: token.pair_created_at,
        firstSeenAt: token.first_seen_at,
        ageMinutes,
        price: snapshot?.price ?? null,
        liquidity: snapshot?.liquidity ?? null,
        marketCap: snapshot?.market_cap ?? null,
        volume5m: snapshot?.volume_5m ?? null,
        buys1m: snapshot?.buys_1m ?? null,
        sells1m: snapshot?.sells_1m ?? null,
        priceChange5m: snapshot?.price_change_5m ?? null,
        momentumScore: snapshot?.momentum_score ?? null,
        opportunityScore: snapshot?.opportunity_score ?? null,
        signal: snapshot?.signal ?? null,
        dataStatus: snapshot?.data_status ?? "unavailable",
        snapshotAt: snapshot?.timestamp ?? null
      };
    });

    if (minScore !== null) {
      merged = merged.filter((t) => (t.opportunityScore ?? -1) >= minScore);
    }
    if (maxAge !== null) {
      merged = merged.filter((t) => t.ageMinutes !== null && t.ageMinutes <= maxAge);
    }
    if (minLiquidity !== null) {
      merged = merged.filter((t) => (t.liquidity ?? -1) >= minLiquidity);
    }
    if (signalFilter) {
      merged = merged.filter((t) => t.signal === signalFilter);
    }

    const sorters = {
      score: (a, b) => (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1),
      volume: (a, b) => (b.volume5m ?? -1) - (a.volume5m ?? -1),
      liquidity: (a, b) => (b.liquidity ?? -1) - (a.liquidity ?? -1),
      age: (a, b) => (a.ageMinutes ?? Infinity) - (b.ageMinutes ?? Infinity)
    };
    merged.sort(sorters[sort] || sorters.score);

    merged = merged.slice(0, limit);

    return NextResponse.json({ success: true, count: merged.length, tokens: merged });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
