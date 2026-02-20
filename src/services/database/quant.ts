import { getDb } from "./db.js";
import type { QuantTrade, QuantPosition, TradeType } from "../hyperliquid/types.js";

export function generateQuantId(): string {
  return `qt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function saveQuantTrade(trade: QuantTrade): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO quant_trades (
      id, pair, direction, entry_price, exit_price, size, leverage,
      pnl, fees, mode, status, ai_confidence, ai_reasoning, exit_reason,
      trade_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
    null,
    trade.tradeType ?? "directional",
    trade.createdAt,
  );
}

export function saveQuantPosition(position: QuantPosition): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO quant_positions (
      id, pair, direction, entry_price, size, leverage,
      unrealized_pnl, mode, status, trade_type, opened_at, closed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
  const whereClause = tradeType
    ? `WHERE status = 'closed' AND trade_type = '${tradeType}'`
    : `WHERE status = 'closed'`;
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
      SUM(pnl) as total_pnl
    FROM quant_trades
    ${whereClause}
  `).get() as {
    total: number;
    wins: number;
    losses: number;
    total_pnl: number;
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
