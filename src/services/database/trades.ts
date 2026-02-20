import { getDb } from "./db.js";
import { isPaperMode } from "../../config/env.js";

export interface TradeRecord {
  id: string;
  strategy: "polymarket" | "base" | "arbitrum" | "avalanche";
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
  strategy: "polymarket" | "base" | "arbitrum" | "avalanche";
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

// Get trades with filters
function getTrades(options: {
  strategy?: "polymarket" | "base" | "arbitrum" | "avalanche";
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
export function getOpenPositions(strategy?: "polymarket" | "base" | "arbitrum" | "avalanche"): PositionRecord[] {
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

// Helper to map database row to TradeRecord
function mapRowToTrade(row: Record<string, unknown>): TradeRecord {
  return {
    id: row.id as string,
    strategy: row.strategy as TradeRecord["strategy"],
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
    strategy: row.strategy as PositionRecord["strategy"],
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
