// app/api/ai-history/route.js
// GET /api/ai-history — aggregate stats for the "Riwayat AI" dashboard:
// AI Performance, Performance Over Time, Prediction Accuracy by horizon,
// and Observed Patterns. Every number here is a real aggregate over
// token_outcomes — see lib/analyzer/ai-stats.js for the honesty notes on
// what these figures do and don't represent.

import { NextResponse } from "next/server";
import { getOutcomesForAnalysis } from "../../../lib/database/outcomes";
import {
  computeAiPerformance,
  computePerformanceOverTime,
  computePredictionAccuracy,
  computeObservedPatterns
} from "../../../lib/analyzer/ai-stats";

export const dynamic = "force-dynamic";

const ACCURACY_HORIZONS = ["5m", "15m", "1h", "6h", "24h"];

export async function GET() {
  try {
    const rows = await getOutcomesForAnalysis();

    return NextResponse.json({
      success: true,
      performance: computeAiPerformance(rows, "24h"),
      performanceOverTime: computePerformanceOverTime(rows, "24h"),
      accuracy: computePredictionAccuracy(rows, ACCURACY_HORIZONS),
      patterns: computeObservedPatterns(rows)
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
