import { getDb } from "./db.js";
import type { Position } from "../polygon/positions.js";

// Save position to database
export function savePosition(position: Position): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO arbitrage_positions (
      id,
      polymarket_token_id,
      side,
      entry_price,
      size,
      order_id,
      entry_timestamp,
      status,
      target_profit,
      estimated_fees,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  stmt.run(
    position.id,
    position.polymarketTokenId,
    position.side,
    position.entryPrice,
    position.size,
    position.orderId || null,
    position.entryTimestamp,
    position.status,
    position.targetProfit,
    position.estimatedFees
  );
}

// Load all open positions from database
export function loadOpenPositions(): Position[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT * FROM arbitrage_positions
    WHERE status IN ('pending', 'active', 'exiting')
    ORDER BY entry_timestamp ASC
  `);

  const rows = stmt.all() as Array<{
    id: string;
    polymarket_token_id: string;
    side: "BUY" | "SELL";
    entry_price: number;
    size: number;
    order_id: string | null;
    entry_timestamp: number;
    status: "pending" | "active" | "exiting" | "closed";
    target_profit: number;
    estimated_fees: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    polymarketTokenId: row.polymarket_token_id,
    side: row.side,
    entryPrice: row.entry_price,
    size: row.size,
    orderId: row.order_id || undefined,
    entryTimestamp: row.entry_timestamp,
    status: row.status,
    targetProfit: row.target_profit,
    estimatedFees: row.estimated_fees,
  }));
}

// Mark position as closed
export function markPositionClosed(id: string): void {
  const db = getDb();

  const stmt = db.prepare(`
    UPDATE arbitrage_positions
    SET status = 'closed', updated_at = datetime('now')
    WHERE id = ?
  `);

  stmt.run(id);
}

// Delete position from database
export function deletePosition(id: string): void {
  const db = getDb();

  const stmt = db.prepare(`
    DELETE FROM arbitrage_positions WHERE id = ?
  `);

  stmt.run(id);
}
