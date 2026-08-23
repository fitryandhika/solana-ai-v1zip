// app/api/health/route.js
// GET /api/health — lightweight dependency check. Never exposes secrets.

import { NextResponse } from "next/server";
import { getServiceClient } from "../../../lib/database/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = { success: true, database: "unknown", dexscreener: "unknown", scanner: "unknown" };
  let overallOk = true;

  try {
    const supabase = getServiceClient();
    const { error } = await supabase.from("scanner_status").select("id").limit(1);
    if (error) throw error;
    result.database = "ok";
  } catch (err) {
    result.database = "error";
    overallOk = false;
  }

  try {
    const base = process.env.DEXSCREENER_API_BASE_URL || "https://api.dexscreener.com";
    const res = await fetch(`${base}/latest/dex/search?q=SOL`, { headers: { Accept: "application/json" } });
    result.dexscreener = res.ok ? "ok" : "error";
    if (!res.ok) overallOk = false;
  } catch (err) {
    result.dexscreener = "error";
    overallOk = false;
  }

  try {
    const supabase = getServiceClient();
    const { data } = await supabase
      .from("scanner_status")
      .select("status, updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) {
      result.scanner = "not_running";
    } else {
      const ageMs = Date.now() - new Date(data.updated_at).getTime();
      result.scanner = data.status === "LIVE" && ageMs < 5 * 60 * 1000 ? "ok" : data.status || "error";
    }
  } catch (err) {
    result.scanner = "error";
  }

  result.success = overallOk;
  return NextResponse.json(result, { status: overallOk ? 200 : 503 });
}