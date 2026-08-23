// app/api/token/[address]/route.js
// GET /api/token/:address — token info, latest snapshot, recent snapshots.

import { NextResponse } from "next/server";
import { getTokenByAddress } from "../../../../lib/database/tokens";
import { getLatestSnapshot, getRecentSnapshots } from "../../../../lib/database/snapshots";
import { computeTokenAgeMinutes } from "../../../../lib/utils/format";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  try {
    const { address } = params;

    const token = await getTokenByAddress(address);
    if (!token) {
      return NextResponse.json({ success: false, error: "Token not found" }, { status: 404 });
    }

    const [latestSnapshot, recentSnapshots] = await Promise.all([
      getLatestSnapshot(address),
      getRecentSnapshots(address, 200)
    ]);

    return NextResponse.json({
      success: true,
      token: {
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        dex: token.dex,
        pairAddress: token.pair_address,
        creator: token.creator,
        pairCreatedAt: token.pair_created_at,
        firstSeenAt: token.first_seen_at,
        ageMinutes: computeTokenAgeMinutes(token.pair_created_at, token.first_seen_at)
      },
      latestSnapshot,
      recentSnapshots
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}