import { getDb } from "./db.js";
import type { HFMakerTrade } from "../aibetting/hf-maker.js";

export function saveHFMakerTrade(trade: HFMakerTrade): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO hf_maker_trades (
      id, coin, side, entry_price, shares, size, entry_time, window_end,
      window_start_price, binance_price_at_entry, binance_price_at_close,
      momentum_magnitude, order_id, status, pnl, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    trade.id, trade.coin, trade.side, trade.entryPrice, trade.shares,
    trade.size, trade.entryTime, trade.windowEnd, trade.windowStartPrice,
    trade.binancePriceAtEntry, trade.binancePriceAtClose ?? null,
    trade.momentumMagnitude, trade.orderId ?? null, trade.status, trade.pnl,
  );
}

export function loadOpenHFMakerTrades(): HFMakerTrade[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM hf_maker_trades WHERE status IN ('pending', 'open')
    ORDER BY entry_time ASC
  `).all() as Array<Record<string, unknown>>;

  return rows.map(row => ({
    id: row.id as string,
    coin: row.coin as string,
    side: row.side as "up" | "down",
    entryPrice: row.entry_price as number,
    shares: row.shares as number,
    size: row.size as number,
    entryTime: row.entry_time as number,
    windowEnd: row.window_end as number,
    windowStartPrice: row.window_start_price as number,
    binancePriceAtEntry: row.binance_price_at_entry as number,
    binancePriceAtClose: row.binance_price_at_close as number | undefined,
    momentumMagnitude: row.momentum_magnitude as number,
    orderId: row.order_id as string | undefined,
    status: row.status as "pending" | "open" | "won" | "lost" | "cancelled",
    pnl: row.pnl as number,
  }));
}

export function loadAllHFMakerTrades(): HFMakerTrade[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM hf_maker_trades ORDER BY entry_time DESC LIMIT 500
  `).all() as Array<Record<string, unknown>>;

  return rows.map(row => ({
    id: row.id as string,
    coin: row.coin as string,
    side: row.side as "up" | "down",
    entryPrice: row.entry_price as number,
    shares: row.shares as number,
    size: row.size as number,
    entryTime: row.entry_time as number,
    windowEnd: row.window_end as number,
    windowStartPrice: row.window_start_price as number,
    binancePriceAtEntry: row.binance_price_at_entry as number,
    binancePriceAtClose: row.binance_price_at_close as number | undefined,
    momentumMagnitude: row.momentum_magnitude as number,
    orderId: row.order_id as string | undefined,
    status: row.status as "pending" | "open" | "won" | "lost" | "cancelled",
    pnl: row.pnl as number,
  }));
}

export function saveHFMakerBalance(balance: number): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO hf_maker_balance (id, balance, updated_at)
    VALUES ('current', ?, CURRENT_TIMESTAMP)
  `).run(balance);
}

export function loadHFMakerBalance(): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT balance FROM hf_maker_balance WHERE id = 'current'
  `).get() as { balance: number } | undefined;
  return row?.balance ?? null;
}

export function getHFMakerDbStats(): {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  winRate: number;
} {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as losses,
      COALESCE(SUM(CASE WHEN status IN ('won', 'lost') THEN pnl ELSE 0 END), 0) as total_pnl
    FROM hf_maker_trades
    WHERE status IN ('won', 'lost')
  `).get() as { total: number; wins: number; losses: number; total_pnl: number };

  return {
    totalTrades: row.total,
    wins: row.wins,
    losses: row.losses,
    totalPnl: row.total_pnl,
    winRate: row.total > 0 ? (row.wins / row.total) * 100 : 0,
  };
}
