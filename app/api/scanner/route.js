// app/api/scanner/route.js
// GET /api/scanner — current scanner_status row, for the dashboard's status
// badge (spec section 26). Read-only: the scanner worker process is the only
// writer to this table.

import { NextResponse } from "next/server";
import { getServiceClient } from "../../../lib/database/supabase";

// Vercel/Next.js treats a route with no request-derived input as static and
// caches its output at build time — so without this, scanner status would
// permanently show whatever it was the moment of deployment, never live
// data. This forces the route to run fresh on every request.
export const dynamic = "force-dynamic";

// Must match SCANNER_STATUS_ROW_ID in worker/scanner.js — scanner_status is
// a singleton table, and querying this exact row (rather than "whichever
// row was updated most recently") means a stray leftover row from before
// the singleton fix can never cause this endpoint to return stale data.
const SCANNER_STATUS_ROW_ID = "00000000-0000-0000-0000-000000000001";

export async function GET() {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("scanner_status")
      .select("*")
      .eq("id", SCANNER_STATUS_ROW_ID)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return NextResponse.json({
        success: true,
        status: "OFFLINE",
        lastEventAt: null,
        lastTokenDiscoveredAt: null,
        tokensDiscovered: 0,
        tokensAnalyzed: 0,
        lastError: null
      });
    }

    return NextResponse.json({
      success: true,
      status: data.status,
      lastEventAt: data.last_event_at,
      lastTokenDiscoveredAt: data.last_token_discovered_at,
      lastSuccessfulApiCall: data.last_successful_api_call,
      tokensDiscovered: data.tokens_discovered,
      tokensAnalyzed: data.tokens_analyzed,
      lastError: data.last_error
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}