// app/api/whale-tracker/wallets/route.js
// POST /api/whale-tracker/wallets — add a manually-curated wallet to the
// watchlist (e.g. copied from Kolscan/MemeMoves). Always tagged
// source='manual' so the UI can show it's user-supplied, not something our
// own system verified — see migration_008_whale_tracker.sql.

import { NextResponse } from "next/server";
import { addManualWallet } from "../../../../lib/database/whales";

export const dynamic = "force-dynamic";

function isValidSolanaAddress(address) {
  return typeof address === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

export async function POST(request) {
  try {
    const body = await request.json();
    const address = (body.address || "").trim();
    const label = (body.label || "").trim();

    if (!isValidSolanaAddress(address)) {
      return NextResponse.json({ success: false, error: "Alamat wallet Solana tidak valid" }, { status: 400 });
    }

    await addManualWallet(address, label || null);

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
} 
