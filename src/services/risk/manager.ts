import { isPaperMode } from "../../config/env.js";
import {
  STARTING_CAPITAL_USD,
} from "../../config/constants.js";
import {
  insertTrade as dbInsertTrade,
  getTodayTrades as dbGetTodayTrades,
} from "../database/trades.js";
import { getDb } from "../database/db.js";

export interface RiskStatus {
  tradingEnabled: boolean;
  killSwitchActive: boolean;
  dailyPnl: number;
  dailyPnlPercentage: number;
  isPaperMode: boolean;
  pauseReason?: string;
}

export interface Trade {
  id: string;
  strategy: string;
  type: "BUY" | "SELL";
  amount: number;
  price: number;
  pnl: number;
  timestamp: number;
}

// State
let killSwitchActive = false;
let tradingPaused = false;
let pauseReason: string | undefined;

let dailyStartBalance = STARTING_CAPITAL_USD;
let lastDayReset = new Date().toISOString().split("T")[0];

// Reset daily stats at midnight
function checkDayReset(): void {
  const today = new Date().toISOString().split("T")[0];
  if (today !== lastDayReset) {
    // Database automatically handles day separation via timestamps
    lastDayReset = today;
    console.log("[Risk] Daily stats reset");
  }
}

// Set initial balance (call once at startup)
export function setDailyStartBalance(balanceSol: number): void {
  dailyStartBalance = balanceSol;
  console.log(`[Risk] Daily balance baseline set to ${balanceSol}`);
}

// Calculate daily P&L (from database)
export function getDailyPnl(): number {
  checkDayReset();
  const trades = dbGetTodayTrades();
  return trades.reduce((sum, trade) => sum + trade.pnl, 0);
}

// Get daily P&L breakdown by source
export function getDailyPnlBreakdown(): {
  total: number;
  quantPnl: number;
  insiderCopyPnl: number;
  rugLosses: number;
} {
  checkDayReset();
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];
  const startOfDay = today + "T00:00:00.000Z";

  // Quant trading (from quant_trades, closed today)
  const quantResult = db.prepare(`
    SELECT SUM(pnl) as total
    FROM quant_trades
    WHERE status = 'closed'
      AND updated_at >= ?
  `).get(startOfDay) as { total: number | null };
  const quantPnl = quantResult.total || 0;

  const insiderResult = db.prepare(`
    SELECT COALESCE(SUM(amount_usd * pnl_pct / 100), 0) as total
    FROM insider_copy_trades
    WHERE status = 'closed'
      AND close_timestamp >= ?
      AND exit_reason NOT IN ('liquidity_rug', 'honeypot')
  `).get(new Date(startOfDay).getTime()) as { total: number | null };
  const insiderCopyPnl = insiderResult.total || 0;

  const rugResult = db.prepare(`
    SELECT -COALESCE(SUM(amount_usd), 0) as total
    FROM insider_copy_trades
    WHERE status = 'closed'
      AND close_timestamp >= ?
      AND exit_reason IN ('liquidity_rug', 'honeypot')
  `).get(new Date(startOfDay).getTime()) as { total: number | null };
  const rugLosses = rugResult.total || 0;

  return {
    total: quantPnl + insiderCopyPnl + rugLosses,
    quantPnl,
    insiderCopyPnl,
    rugLosses,
  };
}

// Calculate daily P&L percentage
export function getDailyPnlPercentage(): number {
  const pnl = getDailyPnl();
  return dailyStartBalance > 0 ? (pnl / dailyStartBalance) * 100 : 0;
}

// Record a trade (persisted to database)
export function recordTrade(trade: Omit<Trade, "id" | "timestamp">): void {
  checkDayReset();

  // Save to database for persistence
  dbInsertTrade({
    strategy: trade.strategy,
    type: trade.type,
    amountUsd: trade.amount,
    price: trade.price,
    pnl: trade.pnl,
    pnlPercentage: trade.amount > 0 ? (trade.pnl / trade.amount) * 100 : 0,
    fees: 0,
    status: "completed",
  });

  console.log(`[Risk] Trade recorded: ${trade.type} ${trade.amount} (P&L: ${trade.pnl})`);

  // Check if we hit daily loss limit
  checkDailyLossLimit();
}

function checkDailyLossLimit(): void {
  // Daily loss limit disabled - let strategies run
}

// Pause trading
export function pauseTrading(reason: string): void {
  tradingPaused = true;
  pauseReason = reason;
  console.log(`[Risk] Trading paused: ${reason}`);
}

// Resume trading
export function resumeTrading(): void {
  tradingPaused = false;
  pauseReason = undefined;
  console.log("[Risk] Trading resumed");
}

// Activate kill switch
export function activateKillSwitch(): void {
  killSwitchActive = true;
  tradingPaused = true;
  pauseReason = "Kill switch activated";
  console.log("[Risk] KILL SWITCH ACTIVATED - All trading stopped");
}

// Deactivate kill switch
export function deactivateKillSwitch(): void {
  killSwitchActive = false;
  tradingPaused = false;
  pauseReason = undefined;
  console.log("[Risk] Kill switch deactivated");
}

// Check if trading is allowed
export function canTrade(): boolean {
  if (killSwitchActive) return false;
  if (tradingPaused) return false;
  return true;
}

// Get full risk status
export async function getRiskStatus(): Promise<RiskStatus> {
  checkDayReset();

  const dailyPnl = getDailyPnl();
  const dailyPnlPercentage = getDailyPnlPercentage();

  return {
    tradingEnabled: canTrade(),
    killSwitchActive,
    dailyPnl,
    dailyPnlPercentage,
    isPaperMode: isPaperMode(),
    pauseReason,
  };
}

// Get today's trades (from database)
export function getTodayTrades(): Trade[] {
  checkDayReset();
  const dbTrades = dbGetTodayTrades();
  return dbTrades.map((t): Trade => ({
    id: t.id,
    strategy: t.strategy,
    type: t.type,
    amount: t.amountUsd,
    price: t.price,
    pnl: t.pnl,
    timestamp: new Date(t.createdAt).getTime(),
  }));
}

