import { getDb } from "./db.js";
import type { HFMakerTrade } from "../aibetting/hf-maker.js";

export function saveHFMakerTrade(trade: HFMakerTrade, instance = 'live-0.1'): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO hf_maker_trades (
      id, coin, side, entry_price, shares, size, entry_time, window_end,
      window_start_price, binance_price_at_entry, binance_price_at_close,
      momentum_magnitude, order_id, status, pnl, instance, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    trade.id, trade.coin, trade.side, trade.entryPrice, trade.shares,
    trade.size, trade.entryTime, trade.windowEnd, trade.windowStartPrice,
    trade.binancePriceAtEntry, trade.binancePriceAtClose ?? null,
    trade.momentumMagnitude, trade.orderId ?? null, trade.status, trade.pnl,
    instance,
  );
}

export function loadOpenHFMakerTrades(instance = 'live-0.1'): HFMakerTrade[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM hf_maker_trades WHERE status IN ('pending', 'open') AND instance = ?
    ORDER BY entry_time ASC
  `).all(instance) as Array<Record<string, unknown>>;

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

export function loadAllHFMakerTrades(instance?: string): HFMakerTrade[] {
  const db = getDb();
  const rows = instance
    ? db.prepare(`
        SELECT * FROM hf_maker_trades WHERE instance = ? ORDER BY entry_time DESC LIMIT 500
      `).all(instance) as Array<Record<string, unknown>>
    : db.prepare(`
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

export function saveHFMakerBalance(balance: number, instance = 'live-0.1'): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO hf_maker_balance (id, balance, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run(instance, balance);
}

export function loadHFMakerBalance(instance = 'live-0.1'): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT balance FROM hf_maker_balance WHERE id = ?
  `).get(instance) as { balance: number } | undefined;
  return row?.balance ?? null;
}

export function getHFMakerDbStats(instance?: string): {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  winRate: number;
} {
  const db = getDb();
  const row = instance
    ? db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as losses,
          COALESCE(SUM(CASE WHEN status IN ('won', 'lost') THEN pnl ELSE 0 END), 0) as total_pnl
        FROM hf_maker_trades
        WHERE status IN ('won', 'lost') AND instance = ?
      `).get(instance) as { total: number; wins: number; losses: number; total_pnl: number }
    : db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as losses,
          COALESCE(SUM(CASE WHEN status IN ('won', 'lost') THEN pnl ELSE 0 END), 0) as total_pnl
        FROM hf_maker_trades
        WHERE status IN ('won', 'lost')
      `).get() as { total: number; wins: number; losses: number; total_pnl: number };

  return {
    totalTrades: row.total ?? 0,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    totalPnl: row.total_pnl ?? 0,
    winRate: (row.total ?? 0) > 0 ? ((row.wins ?? 0) / row.total) * 100 : 0,
  };
}
