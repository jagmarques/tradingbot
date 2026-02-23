import { getDb } from "./db.js";
import type { QuantTrade, QuantPosition, TradeType } from "../hyperliquid/types.js";
import { QUANT_DEFAULT_VIRTUAL_BALANCE } from "../../config/constants.js";

export function generateQuantId(): string {
  return `qt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function saveQuantTrade(trade: QuantTrade): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO quant_trades (
      id, pair, direction, entry_price, exit_price, size, leverage,
      pnl, fees, mode, status, ai_confidence, ai_reasoning, exit_reason,
      indicators_at_entry, trade_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    trade.id,
    trade.pair,
    trade.direction,
    trade.entryPrice,
    trade.exitPrice ?? null,
    trade.size,
    trade.leverage,
    trade.pnl,
    trade.fees,
    trade.mode,
    trade.status,
    trade.aiConfidence ?? null,
    trade.aiReasoning ?? null,
    trade.exitReason ?? null,
    trade.indicatorsAtEntry ?? null,
    trade.tradeType ?? "directional",
    trade.createdAt,
  );
}

export function saveQuantPosition(position: QuantPosition): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO quant_positions (
      id, pair, direction, entry_price, size, leverage,
      unrealized_pnl, mode, status, trade_type, opened_at, closed_at,
      stop_loss, take_profit, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    position.id,
    position.pair,
    position.direction,
    position.entryPrice,
    position.size,
    position.leverage,
    position.unrealizedPnl,
    position.mode,
    position.status,
    position.tradeType ?? "directional",
    position.openedAt,
    position.closedAt ?? null,
    position.stopLoss ?? null,
    position.takeProfit ?? null,
  );
}

export function loadOpenQuantPositions(): QuantPosition[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM quant_positions WHERE status = 'open'
  `).all() as Array<{
    id: string;
    pair: string;
    direction: string;
    entry_price: number;
    size: number;
    leverage: number;
    unrealized_pnl: number;
    mode: string;
    status: string;
    opened_at: string;
    closed_at: string | null;
    trade_type: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    pair: row.pair,
    direction: row.direction as "long" | "short",
    entryPrice: row.entry_price,
    size: row.size,
    leverage: row.leverage,
    stopLoss: (row as Record<string, unknown>).stop_loss as number | undefined ?? undefined,
    takeProfit: (row as Record<string, unknown>).take_profit as number | undefined ?? undefined,
    unrealizedPnl: row.unrealized_pnl,
    mode: row.mode as "paper" | "live",
    status: row.status as "open" | "closed",
    openedAt: row.opened_at,
    closedAt: row.closed_at ?? undefined,
    exitPrice: undefined,
    realizedPnl: undefined,
    exitReason: undefined,
    tradeType: (row.trade_type ?? "directional") as TradeType,
  }));
}

export function loadClosedQuantTrades(limit: number = 20): QuantTrade[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM quant_trades
    WHERE status = 'closed'
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string;
    pair: string;
    direction: string;
    entry_price: number;
    exit_price: number | null;
    size: number;
    leverage: number;
    pnl: number;
    fees: number;
    mode: string;
    status: string;
    ai_confidence: number | null;
    ai_reasoning: string | null;
    exit_reason: string | null;
    indicators_at_entry: string | null;
    created_at: string;
    updated_at: string;
    trade_type: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    pair: row.pair,
    direction: row.direction as "long" | "short",
    entryPrice: row.entry_price,
    exitPrice: row.exit_price ?? undefined,
    size: row.size,
    leverage: row.leverage,
    pnl: row.pnl,
    fees: row.fees,
    mode: row.mode as "paper" | "live",
    status: row.status as "open" | "closed" | "failed",
    aiConfidence: row.ai_confidence ?? undefined,
    aiReasoning: row.ai_reasoning ?? undefined,
    exitReason: row.exit_reason ?? undefined,
    indicatorsAtEntry: row.indicators_at_entry ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tradeType: (row.trade_type ?? "directional") as TradeType,
  }));
}

export function getQuantStats(tradeType?: "directional" | "funding"): {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  winRate: number;
} {
  const db = getDb();
  const sql = tradeType
    ? `SELECT COUNT(*) as total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses, SUM(pnl) as total_pnl FROM quant_trades WHERE status = 'closed' AND trade_type = ?`
    : `SELECT COUNT(*) as total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses, SUM(pnl) as total_pnl FROM quant_trades WHERE status = 'closed'`;
  const stats = (tradeType ? db.prepare(sql).get(tradeType) : db.prepare(sql).get()) as {
    total: number;
    wins: number;
    losses: number;
    total_pnl: number | null;
  };

  const total = stats.total || 0;
  const wins = stats.wins || 0;
  return {
    totalTrades: total,
    wins,
    losses: stats.losses || 0,
    totalPnl: stats.total_pnl || 0,
    winRate: total > 0 ? (wins / total) * 100 : 0,
  };
}

export function setPaperStartDate(date: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO quant_config (key, value, updated_at)
    VALUES ('paper_start_date', ?, CURRENT_TIMESTAMP)
  `).run(date);
}

export function getPaperStartDate(): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT value FROM quant_config WHERE key = 'paper_start_date'
  `).get() as { value: string } | undefined;
  return row ? row.value : null;
}

export function getQuantValidationMetrics(): {
  sharpeRatio: number;
  maxDrawdownPct: number;
  avgTradeDurationHours: number;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  paperDaysElapsed: number;
} {
  const db = getDb();

  // Load all closed directional trades ordered chronologically
  const rows = db.prepare(`
    SELECT pnl, size, created_at, updated_at
    FROM quant_trades
    WHERE status = 'closed' AND trade_type = 'directional'
    ORDER BY updated_at ASC
  `).all() as Array<{
    pnl: number;
    size: number;
    created_at: string;
    updated_at: string;
  }>;

  const totalTrades = rows.length;

  // Sharpe ratio: mean(pnl/size) / stddev(pnl/size) * sqrt(252)
  let sharpeRatio = 0;
  if (totalTrades >= 2) {
    const returns = rows.map((r) => (r.size > 0 ? r.pnl / r.size : 0));
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / returns.length;
    const stddev = Math.sqrt(variance);
    if (stddev > 0) {
      sharpeRatio = (mean / stddev) * Math.sqrt(252);
    }
  }

  // Max drawdown %: walk cumulative P&L, record (peak - trough) / starting balance
  let maxDrawdownPct = 0;
  if (totalTrades > 0) {
    const STARTING_BALANCE = QUANT_DEFAULT_VIRTUAL_BALANCE;
    let cumPnl = 0;
    let peak = 0;
    for (const row of rows) {
      cumPnl += row.pnl;
      if (cumPnl > peak) {
        peak = cumPnl;
      }
      const drawdown = peak - cumPnl;
      const drawdownPct = (drawdown / STARTING_BALANCE) * 100;
      if (drawdownPct > maxDrawdownPct) {
        maxDrawdownPct = drawdownPct;
      }
    }
  }

  // Avg trade duration in hours
  let avgTradeDurationHours = 0;
  if (totalTrades > 0) {
    const durations = rows.map((r) => {
      const openMs = new Date(r.created_at).getTime();
      const closeMs = new Date(r.updated_at).getTime();
      return (closeMs - openMs) / (1000 * 60 * 60); // hours
    });
    avgTradeDurationHours = durations.reduce((a, b) => a + b, 0) / durations.length;
  }

  // Paper days elapsed
  let paperDaysElapsed = 0;
  const startDate = getPaperStartDate();
  if (startDate) {
    const startMs = new Date(startDate).getTime();
    const nowMs = Date.now();
    paperDaysElapsed = (nowMs - startMs) / (1000 * 60 * 60 * 24);
  }

  // Win rate and total P&L from stats helper
  const stats = getQuantStats("directional");

  return {
    sharpeRatio,
    maxDrawdownPct,
    avgTradeDurationHours,
    totalTrades: stats.totalTrades,
    winRate: stats.winRate,
    totalPnl: stats.totalPnl,
    paperDaysElapsed,
  };
}

export function sumRecentQuantLosses(withinMs: number): { totalLoss: number; lastLossTs: number } {
  const db = getDb();
  const cutoff = new Date(Date.now() - withinMs).toISOString();
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(ABS(pnl)), 0) as total_loss,
      COALESCE(MAX(updated_at), '') as last_loss_at
    FROM quant_trades
    WHERE status = 'closed' AND pnl < 0 AND updated_at >= ?
  `).get(cutoff) as { total_loss: number; last_loss_at: string };
  const lastLossTs = row.last_loss_at ? new Date(row.last_loss_at).getTime() : 0;
  return { totalLoss: row.total_loss, lastLossTs };
}

export function getTotalRealizedPnl(): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(pnl), 0) as total_pnl
    FROM quant_trades WHERE status = 'closed'
  `).get() as { total_pnl: number };
  return row.total_pnl;
}

export function getFundingIncome(): { totalIncome: number; tradeCount: number } {
  const db = getDb();
  const result = db
    .prepare(
      `
    SELECT COALESCE(SUM(pnl), 0) as total_income, COUNT(*) as trade_count
    FROM quant_trades
    WHERE status = 'closed' AND trade_type = 'funding'
  `,
    )
    .get() as { total_income: number; trade_count: number };
  return {
    totalIncome: result.total_income,
    tradeCount: result.trade_count,
  };
}
