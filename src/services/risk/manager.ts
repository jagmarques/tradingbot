import { getDb } from "../database/db.js";
import { isPaperMode } from "../../config/env.js";

export interface Trade {
  id: string;
  strategy: string;
  type: string;
  amount: number;
  price: number;
  pnl: number;
  timestamp: string;
}

export interface RiskStatus {
  killSwitchActive: boolean;
  tradingEnabled: boolean;
  isPaperMode: boolean;
  pauseReason?: string;
}

export interface PnlBreakdown {
  total: number;
  quantPnl: number;
  insiderCopyPnl: number;
  rugLosses: number;
}

let killSwitchActive = false;
let tradingPaused = false;
let _startBalance = 0;

export function setDailyStartBalance(balance: number): void {
  _startBalance = balance;
}

export function canTrade(): boolean {
  return !killSwitchActive && !tradingPaused;
}

export function activateKillSwitch(): void {
  killSwitchActive = true;
}

export function deactivateKillSwitch(): void {
  killSwitchActive = false;
}

export function pauseTrading(reason: string): void {
  console.log(`[Risk] Trading paused: ${reason}`);
  tradingPaused = true;
  _pauseReason = reason;
}

export function resumeTrading(): void {
  tradingPaused = false;
  _pauseReason = undefined;
}

let _pauseReason: string | undefined;

export async function getRiskStatus(): Promise<RiskStatus> {
  return {
    killSwitchActive,
    tradingEnabled: canTrade(),
    isPaperMode: isPaperMode(),
    pauseReason: _pauseReason,
  };
}

export function getDailyPnl(): number {
  try {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const result = db.prepare(`
      SELECT COALESCE(SUM(pnl), 0) as total
      FROM quant_trades
      WHERE status = 'closed' AND DATE(created_at) = ?
    `).get(today) as { total: number };
    return result.total;
  } catch {
    return 0;
  }
}

export function getDailyPnlPercentage(): number {
  if (_startBalance <= 0) return 0;
  return (getDailyPnl() / _startBalance) * 100;
}

export function getDailyPnlBreakdown(): PnlBreakdown {
  try {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];

    const quantResult = db.prepare(`
      SELECT COALESCE(SUM(pnl), 0) as total
      FROM quant_trades
      WHERE status = 'closed' AND DATE(created_at) = ?
    `).get(today) as { total: number };

    const insiderResult = db.prepare(`
      SELECT COALESCE(SUM(amount_usd * pnl_pct / 100), 0) as total
      FROM insider_copy_trades
      WHERE status = 'closed'
        AND exit_reason NOT IN ('liquidity_rug', 'honeypot')
        AND DATE(close_timestamp / 1000, 'unixepoch') = ?
    `).get(today) as { total: number };

    const rugResult = db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) as total
      FROM insider_copy_trades
      WHERE status = 'closed'
        AND exit_reason IN ('liquidity_rug', 'honeypot')
        AND DATE(close_timestamp / 1000, 'unixepoch') = ?
    `).get(today) as { total: number };

    const quantPnl = quantResult.total;
    const insiderCopyPnl = insiderResult.total;
    const rugLosses = -rugResult.total;

    return {
      total: quantPnl + insiderCopyPnl + rugLosses,
      quantPnl,
      insiderCopyPnl,
      rugLosses,
    };
  } catch {
    return { total: 0, quantPnl: 0, insiderCopyPnl: 0, rugLosses: 0 };
  }
}

export function getTodayTrades(): Trade[] {
  try {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const rows = db.prepare(`
      SELECT id, trade_type as strategy, direction as type, size as amount, entry_price as price,
             COALESCE(pnl, 0) as pnl, created_at as timestamp
      FROM quant_trades
      WHERE DATE(created_at) = ?
      ORDER BY created_at DESC
    `).all(today) as Trade[];
    return rows;
  } catch {
    return [];
  }
}

export function recordTrade(trade: Omit<Trade, "id" | "timestamp">): void {
  // Trades are recorded via saveQuantTrade in the database layer.
  // This is a no-op shim kept for test compatibility.
  void trade;
}
