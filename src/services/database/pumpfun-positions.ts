import { getDb } from "./db.js";

export interface PumpfunPositionRecord {
  mint: string;
  symbol: string;
  entryPrice: number;
  totalTokens: bigint;
  totalCostLamports: bigint;
  buyPhase: 1 | 2 | 3;
  peakPrice: number;
  trailingStopActive: boolean;
  soldPortions: { first: boolean; second: boolean; third: boolean };
  createdAt: number;
}

// Save or update a position
export function savePosition(position: PumpfunPositionRecord): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO pumpfun_positions (
      mint, symbol, entry_price, total_tokens, total_cost_lamports,
      buy_phase, peak_price, trailing_stop_active,
      sold_first, sold_second, sold_third, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      symbol = excluded.symbol,
      entry_price = excluded.entry_price,
      total_tokens = excluded.total_tokens,
      total_cost_lamports = excluded.total_cost_lamports,
      buy_phase = excluded.buy_phase,
      peak_price = excluded.peak_price,
      trailing_stop_active = excluded.trailing_stop_active,
      sold_first = excluded.sold_first,
      sold_second = excluded.sold_second,
      sold_third = excluded.sold_third,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    position.mint,
    position.symbol,
    position.entryPrice,
    position.totalTokens.toString(),
    position.totalCostLamports.toString(),
    position.buyPhase,
    position.peakPrice,
    position.trailingStopActive ? 1 : 0,
    position.soldPortions.first ? 1 : 0,
    position.soldPortions.second ? 1 : 0,
    position.soldPortions.third ? 1 : 0,
    position.createdAt,
    new Date().toISOString()
  );
}

// Delete a position (when closed)
export function deletePosition(mint: string): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM pumpfun_positions WHERE mint = ?");
  stmt.run(mint);
}

// Load all open positions
export function loadAllPositions(): PumpfunPositionRecord[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM pumpfun_positions");
  const rows = stmt.all() as Array<{
    mint: string;
    symbol: string;
    entry_price: number;
    total_tokens: string;
    total_cost_lamports: string;
    buy_phase: number;
    peak_price: number;
    trailing_stop_active: number;
    sold_first: number;
    sold_second: number;
    sold_third: number;
    created_at: number;
  }>;

  return rows.map((row) => ({
    mint: row.mint,
    symbol: row.symbol,
    entryPrice: row.entry_price,
    totalTokens: BigInt(row.total_tokens),
    totalCostLamports: BigInt(row.total_cost_lamports),
    buyPhase: row.buy_phase as 1 | 2 | 3,
    peakPrice: row.peak_price,
    trailingStopActive: row.trailing_stop_active === 1,
    soldPortions: {
      first: row.sold_first === 1,
      second: row.sold_second === 1,
      third: row.sold_third === 1,
    },
    createdAt: row.created_at,
  }));
}

// Get position count
export function getPositionCount(): number {
  const db = getDb();
  const stmt = db.prepare("SELECT COUNT(*) as count FROM pumpfun_positions");
  const row = stmt.get() as { count: number };
  return row.count;
}
