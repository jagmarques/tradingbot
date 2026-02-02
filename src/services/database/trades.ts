import { getDb } from "./db.js";
import { isPaperMode } from "../../config/env.js";

export interface TradeRecord {
  id: string;
  strategy: "pumpfun" | "polymarket";
  type: "BUY" | "SELL";
  tokenAddress?: string;
  tokenSymbol?: string;
  amountUsd: number;
  amountTokens?: number;
  price: number;
  pnl: number;
  pnlPercentage: number;
  fees: number;
  txHash?: string;
  orderId?: string;
  confidence?: number;
  slippage?: number;
  isPaper: boolean;
  status: "pending" | "completed" | "failed" | "cancelled";
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PositionRecord {
  id: string;
  strategy: "pumpfun" | "polymarket";
  tokenAddress: string;
  tokenSymbol?: string;
  entryPrice: number;
  currentPrice?: number;
  amountTokens: number;
  amountUsd: number;
  unrealizedPnl: number;
  realizedPnl: number;
  status: "open" | "closed" | "partial";
  openedAt: string;
  closedAt?: string;
  updatedAt: string;
}

export interface DailyStats {
  date: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnl: number;
  pumpfunPnl: number;
  polymarketPnl: number;
  totalFees: number;
  startingBalance?: number;
  endingBalance?: number;
}

// Generate unique ID
function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Insert a new trade
export function insertTrade(trade: Omit<TradeRecord, "id" | "createdAt" | "updatedAt" | "isPaper">): TradeRecord {
  const db = getDb();
  const id = generateId();
  const now = new Date().toISOString();
  const isPaper = isPaperMode();

  const stmt = db.prepare(`
    INSERT INTO trades (
      id, strategy, type, token_address, token_symbol, amount_usd, amount_tokens,
      price, pnl, pnl_percentage, fees, tx_hash, order_id, confidence, slippage,
      is_paper, status, error_message, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  stmt.run(
    id,
    trade.strategy,
    trade.type,
    trade.tokenAddress || null,
    trade.tokenSymbol || null,
    trade.amountUsd,
    trade.amountTokens || null,
    trade.price,
    trade.pnl,
    trade.pnlPercentage,
    trade.fees,
    trade.txHash || null,
    trade.orderId || null,
    trade.confidence || null,
    trade.slippage || null,
    isPaper ? 1 : 0,
    trade.status,
    trade.errorMessage || null,
    now,
    now
  );

  console.log(`[Database] Trade inserted: ${id}`);

  return {
    ...trade,
    id,
    isPaper,
    createdAt: now,
    updatedAt: now,
  };
}

// Get trade by ID
export function getTrade(id: string): TradeRecord | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM trades WHERE id = ?");
  const row = stmt.get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return mapRowToTrade(row);
}

// Get trades with filters
export function getTrades(options: {
  strategy?: "pumpfun" | "polymarket";
  type?: "BUY" | "SELL";
  startDate?: string;
  endDate?: string;
  isPaper?: boolean;
  limit?: number;
  offset?: number;
}): TradeRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.strategy) {
    conditions.push("strategy = ?");
    params.push(options.strategy);
  }

  if (options.type) {
    conditions.push("type = ?");
    params.push(options.type);
  }

  if (options.startDate) {
    conditions.push("created_at >= ?");
    params.push(options.startDate);
  }

  if (options.endDate) {
    conditions.push("created_at <= ?");
    params.push(options.endDate);
  }

  if (options.isPaper !== undefined) {
    conditions.push("is_paper = ?");
    params.push(options.isPaper ? 1 : 0);
  }

  let query = "SELECT * FROM trades";
  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }
  query += " ORDER BY created_at DESC";

  if (options.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }

  if (options.offset) {
    query += " OFFSET ?";
    params.push(options.offset);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map(mapRowToTrade);
}

// Get today's trades
export function getTodayTrades(): TradeRecord[] {
  const today = new Date().toISOString().split("T")[0];
  return getTrades({ startDate: today + "T00:00:00.000Z" });
}

// Update trade
export function updateTrade(
  id: string,
  updates: Partial<Omit<TradeRecord, "id" | "createdAt">>
): TradeRecord | null {
  const db = getDb();
  const fields: string[] = [];
  const params: unknown[] = [];

  const fieldMap: Record<string, string> = {
    pnl: "pnl",
    pnlPercentage: "pnl_percentage",
    status: "status",
    txHash: "tx_hash",
    errorMessage: "error_message",
    currentPrice: "current_price",
  };

  for (const [key, value] of Object.entries(updates)) {
    const dbField = fieldMap[key] || key;
    fields.push(`${dbField} = ?`);
    params.push(value);
  }

  if (fields.length === 0) return getTrade(id);

  fields.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);

  const stmt = db.prepare(`UPDATE trades SET ${fields.join(", ")} WHERE id = ?`);
  stmt.run(...params);

  return getTrade(id);
}

// Insert position
export function insertPosition(
  position: Omit<PositionRecord, "id" | "openedAt" | "updatedAt">
): PositionRecord {
  const db = getDb();
  const id = generateId();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO positions (
      id, strategy, token_address, token_symbol, entry_price, current_price,
      amount_tokens, amount_usd, unrealized_pnl, realized_pnl, status, opened_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    position.strategy,
    position.tokenAddress,
    position.tokenSymbol || null,
    position.entryPrice,
    position.currentPrice || null,
    position.amountTokens,
    position.amountUsd,
    position.unrealizedPnl,
    position.realizedPnl,
    position.status,
    now,
    now
  );

  return { ...position, id, openedAt: now, updatedAt: now };
}

// Get open positions
export function getOpenPositions(strategy?: "pumpfun" | "polymarket"): PositionRecord[] {
  const db = getDb();
  let query = "SELECT * FROM positions WHERE status = 'open'";
  const params: unknown[] = [];

  if (strategy) {
    query += " AND strategy = ?";
    params.push(strategy);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map(mapRowToPosition);
}

// Close position
export function closePosition(id: string, realizedPnl: number): PositionRecord | null {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    UPDATE positions SET status = 'closed', realized_pnl = ?, closed_at = ?, updated_at = ?
    WHERE id = ?
  `);

  stmt.run(realizedPnl, now, now, id);

  const row = db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapRowToPosition(row) : null;
}

// Get daily stats
export function getDailyStats(date: string): DailyStats | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM daily_stats WHERE date = ?");
  const row = stmt.get(date) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    date: row.date as string,
    totalTrades: row.total_trades as number,
    winningTrades: row.winning_trades as number,
    losingTrades: row.losing_trades as number,
    totalPnl: row.total_pnl as number,
    pumpfunPnl: row.pumpfun_pnl as number,
    polymarketPnl: row.polymarket_pnl as number,
    totalFees: row.total_fees as number,
    startingBalance: row.starting_balance as number | undefined,
    endingBalance: row.ending_balance as number | undefined,
  };
}

// Update daily stats
export function updateDailyStats(date: string): DailyStats {
  const db = getDb();
  const startOfDay = date + "T00:00:00.000Z";
  const endOfDay = date + "T23:59:59.999Z";

  // Calculate stats from trades
  const trades = getTrades({ startDate: startOfDay, endDate: endOfDay });

  const stats: DailyStats = {
    date,
    totalTrades: trades.length,
    winningTrades: trades.filter((t) => t.pnl > 0).length,
    losingTrades: trades.filter((t) => t.pnl < 0).length,
    totalPnl: trades.reduce((sum, t) => sum + t.pnl, 0),
    pumpfunPnl: trades.filter((t) => t.strategy === "pumpfun").reduce((sum, t) => sum + t.pnl, 0),
    polymarketPnl: trades.filter((t) => t.strategy === "polymarket").reduce((sum, t) => sum + t.pnl, 0),
    totalFees: trades.reduce((sum, t) => sum + t.fees, 0),
  };

  const stmt = db.prepare(`
    INSERT INTO daily_stats (date, total_trades, winning_trades, losing_trades, total_pnl, pumpfun_pnl, polymarket_pnl, total_fees)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      total_trades = excluded.total_trades,
      winning_trades = excluded.winning_trades,
      losing_trades = excluded.losing_trades,
      total_pnl = excluded.total_pnl,
      pumpfun_pnl = excluded.pumpfun_pnl,
      polymarket_pnl = excluded.polymarket_pnl,
      total_fees = excluded.total_fees
  `);

  stmt.run(
    stats.date,
    stats.totalTrades,
    stats.winningTrades,
    stats.losingTrades,
    stats.totalPnl,
    stats.pumpfunPnl,
    stats.polymarketPnl,
    stats.totalFees
  );

  return stats;
}

// Get stats for date range
export function getStatsRange(startDate: string, endDate: string): DailyStats[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM daily_stats WHERE date >= ? AND date <= ? ORDER BY date");
  const rows = stmt.all(startDate, endDate) as Record<string, unknown>[];

  return rows.map((row) => ({
    date: row.date as string,
    totalTrades: row.total_trades as number,
    winningTrades: row.winning_trades as number,
    losingTrades: row.losing_trades as number,
    totalPnl: row.total_pnl as number,
    pumpfunPnl: row.pumpfun_pnl as number,
    polymarketPnl: row.polymarket_pnl as number,
    totalFees: row.total_fees as number,
    startingBalance: row.starting_balance as number | undefined,
    endingBalance: row.ending_balance as number | undefined,
  }));
}

// Helper to map database row to TradeRecord
function mapRowToTrade(row: Record<string, unknown>): TradeRecord {
  return {
    id: row.id as string,
    strategy: row.strategy as "pumpfun" | "polymarket",
    type: row.type as "BUY" | "SELL",
    tokenAddress: row.token_address as string | undefined,
    tokenSymbol: row.token_symbol as string | undefined,
    amountUsd: row.amount_usd as number,
    amountTokens: row.amount_tokens as number | undefined,
    price: row.price as number,
    pnl: row.pnl as number,
    pnlPercentage: row.pnl_percentage as number,
    fees: row.fees as number,
    txHash: row.tx_hash as string | undefined,
    orderId: row.order_id as string | undefined,
    confidence: row.confidence as number | undefined,
    slippage: row.slippage as number | undefined,
    isPaper: row.is_paper === 1,
    status: row.status as TradeRecord["status"],
    errorMessage: row.error_message as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// Helper to map database row to PositionRecord
function mapRowToPosition(row: Record<string, unknown>): PositionRecord {
  return {
    id: row.id as string,
    strategy: row.strategy as "pumpfun" | "polymarket",
    tokenAddress: row.token_address as string,
    tokenSymbol: row.token_symbol as string | undefined,
    entryPrice: row.entry_price as number,
    currentPrice: row.current_price as number | undefined,
    amountTokens: row.amount_tokens as number,
    amountUsd: row.amount_usd as number,
    unrealizedPnl: row.unrealized_pnl as number,
    realizedPnl: row.realized_pnl as number,
    status: row.status as PositionRecord["status"],
    openedAt: row.opened_at as string,
    closedAt: row.closed_at as string | undefined,
    updatedAt: row.updated_at as string,
  };
}
