// app/api/ai-history/predictions/route.js
// GET /api/ai-history/predictions?limit=&offset= — paginated prediction
// history: one row per token with its discovery-time prediction and actual
// outcome so far. "Note" is a factual, computed observation (rug detected,
// signal direction matched/missed) — not a claimed AI-derived insight.

import { NextResponse } from "next/server";
import { getPredictionHistory } from "../../../../lib/database/outcomes";

export const dynamic = "force-dynamic";

function pickLatestOutcome(row) {
  // Most-recent-first so we show the freshest available result rather than
  // always waiting for 24h.
  const horizons = ["24h", "6h", "4h", "1h", "30m", "15m", "5m", "1m"];
  for (const h of horizons) {
    const value = row[`price_change_pct_${h}`];
    if (value !== null && value !== undefined) {
      return { horizon: h, value };
    }
  }
  return null;
}

function buildNote(row, latest) {
  const notes = [];
  if (row.is_rug_1h) notes.push("Liquidity dropped 80%+ within 1h");
  else if (row.is_rug_24h) notes.push("Liquidity dropped 80%+ within 24h");

  if (latest && row.discovery_signal) {
    const wasPositive = latest.value > 0;
    notes.push(
      wasPositive
        ? `Price moved up since ${row.discovery_signal} signal`
        : `Price moved down despite ${row.discovery_signal} signal`
    );
  }

  return notes.length > 0 ? notes.join(" · ") : null;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);
    const offset = Number(searchParams.get("offset")) || 0;

    const { rows, total } = await getPredictionHistory({ limit, offset });

    const predictions = rows.map((row) => {
      const latest = pickLatestOutcome(row);
      return {
        tokenAddress: row.token_address,
        symbol: row.tokens?.symbol || null,
        name: row.tokens?.name || null,
        imageUrl: row.tokens?.image_url || null,
        discoveredAt: row.discovered_at,
        prediction: {
          signal: row.discovery_signal,
          opportunityScore: row.discovery_opportunity_score
        },
        actual: latest ? { horizon: latest.horizon, priceChangePct: latest.value } : null,
        result: !latest ? "PENDING" : latest.value > 0 ? "WIN" : "LOSS",
        finalized: Boolean(row.finalized_at),
        note: buildNote(row, latest)
      };
    });

    return NextResponse.json({ success: true, predictions, total, limit, offset });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
