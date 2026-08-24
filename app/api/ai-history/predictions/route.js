// app/api/ai-history/predictions/export/route.js
// GET /api/ai-history/predictions/export — downloads the FULL prediction
// history (not just one page) as a CSV file, so it can be checked manually
// outside the dashboard (Excel/Google Sheets/etc).

import { NextResponse } from "next/server";
import { getPredictionHistory } from "../../../../../lib/database/outcomes";

export const dynamic = "force-dynamic";

const EXPORT_ROW_LIMIT = 5000;

function pickLatestOutcome(row) {
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

  return notes.length > 0 ? notes.join(" | ") : "";
}

// Wraps a value for safe CSV inclusion — quotes it and escapes any
// internal quotes if it contains a comma, quote, or newline.
function csvCell(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET() {
  try {
    const { rows } = await getPredictionHistory({ limit: EXPORT_ROW_LIMIT, offset: 0 });

    const header = [
      "token_address",
      "symbol",
      "name",
      "discovered_at",
      "signal",
      "opportunity_score",
      "actual_horizon",
      "actual_price_change_pct",
      "result",
      "finalized",
      "note"
    ];

    const lines = [header.join(",")];

    for (const row of rows) {
      const latest = pickLatestOutcome(row);
      const result = !latest ? "PENDING" : latest.value > 0 ? "WIN" : "LOSS";

      lines.push(
        [
          csvCell(row.token_address),
          csvCell(row.tokens?.symbol),
          csvCell(row.tokens?.name),
          csvCell(row.discovered_at),
          csvCell(row.discovery_signal),
          csvCell(row.discovery_opportunity_score),
          csvCell(latest?.horizon),
          csvCell(latest?.value),
          csvCell(result),
          csvCell(row.finalized_at ? "yes" : "no"),
          csvCell(buildNote(row, latest))
        ].join(",")
      );
    }

    const csv = lines.join("\n");
    const filename = `prediction-history-${new Date().toISOString().slice(0, 10)}.csv`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`
      }
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
