// app/api/whale-tracker/route.js
// GET /api/whale-tracker — aggregate Whale Tracker dashboard data.
// Everything here comes from real detected transactions (wallet_trades) and
// real recorded outcomes (token_outcomes) — see
// database/migration_008_whale_tracker.sql and lib/analyzer/whale-stats.js
// for what "smart money" means in this app and its limitations.

import { NextResponse } from "next/server";
import { getRecentTrades, getRecentWhaleActivity, getTopSmartMoney, getWalletScoresByAddresses } from "../../../lib/database/whales";
import { computeSmartMoneyFlow, computeTopTokensBought, computeAiWhaleInsight } from "../../../lib/analyzer/whale-stats";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const recentTrades = await getRecentTrades({ hours: 24 });

    const flow = computeSmartMoneyFlow(recentTrades);
    const topTokensBought = computeTopTokensBought(recentTrades, 10);

    const topToken = topTokensBought[0] || null;
    const topTokenBuyTrades = topToken
      ? recentTrades.filter((t) => t.token_address === topToken.tokenAddress && t.direction === "buy")
      : [];
    const distinctBuyerAddresses = Array.from(new Set(topTokenBuyTrades.map((t) => t.wallet_address)));
    const walletScores = await getWalletScoresByAddresses(distinctBuyerAddresses);
    const insight = computeAiWhaleInsight(topToken, topTokenBuyTrades, walletScores);

    const recentActivityRaw = await getRecentWhaleActivity(20);
    const recentActivity = recentActivityRaw.map((t) => ({
      signature: t.signature,
      tokenAddress: t.token_address,
      symbol: t.tokens?.symbol || null,
      imageUrl: t.tokens?.image_url || null,
      direction: t.direction,
      usdValue: t.usd_value,
      tradedAt: t.traded_at,
      walletAddress: t.wallet_address,
      walletLabel: t.wallets?.label || null,
      walletSource: t.wallets?.source || "system"
    }));

    const topSmartMoneyRaw = await getTopSmartMoney(20);
    const topSmartMoney = topSmartMoneyRaw.map((w) => ({
      address: w.address,
      label: w.label,
      source: w.source,
      smartScore: w.smart_score,
      earlyBuyCount: w.early_buy_count,
      earlyWinCount: w.early_win_count,
      totalBuyUsd: w.total_buy_usd,
      lastTradeAt: w.last_trade_at
    }));

    return NextResponse.json({
      success: true,
      flow,
      topTokensBought,
      insight,
      recentActivity,
      topSmartMoney
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
} 
