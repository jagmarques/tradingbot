import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db: Database.Database | null = null;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../../data/trades.db");

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function initDb(dbPath?: string): Database.Database {
  const finalPath = dbPath || DB_PATH;

  // Ensure directory exists before creating database
  const dir = path.dirname(finalPath);
  if (!dbPath?.includes(":memory:")) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  db = new Database(finalPath);
  db.pragma("journal_mode = WAL");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      strategy TEXT NOT NULL,
      type TEXT NOT NULL,
      token_address TEXT,
      token_symbol TEXT,
      amount_usd REAL NOT NULL,
      amount_tokens REAL,
      price REAL NOT NULL,
      pnl REAL DEFAULT 0,
      pnl_percentage REAL DEFAULT 0,
      fees REAL DEFAULT 0,
      tx_hash TEXT,
      order_id TEXT,
      confidence REAL,
      slippage REAL,
      is_paper INTEGER DEFAULT 1,
      status TEXT DEFAULT 'completed',
      error_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      strategy TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      entry_price REAL NOT NULL,
      current_price REAL,
      amount_tokens REAL NOT NULL,
      amount_usd REAL NOT NULL,
      unrealized_pnl REAL DEFAULT 0,
      realized_pnl REAL DEFAULT 0,
      status TEXT DEFAULT 'open',
      opened_at TEXT DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY,
      total_trades INTEGER DEFAULT 0,
      winning_trades INTEGER DEFAULT 0,
      losing_trades INTEGER DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      pumpfun_pnl REAL DEFAULT 0,
      polymarket_pnl REAL DEFAULT 0,
      total_fees REAL DEFAULT 0,
      starting_balance REAL,
      ending_balance REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_timezones (
      telegram_user_id TEXT PRIMARY KEY,
      timezone TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS arbitrage_positions (
      id TEXT PRIMARY KEY,
      polymarket_token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      size REAL NOT NULL,
      order_id TEXT,
      entry_timestamp INTEGER NOT NULL,
      status TEXT NOT NULL,
      target_profit REAL NOT NULL,
      estimated_fees REAL NOT NULL,
      spot_symbol TEXT,
      spot_side TEXT,
      spot_entry_price REAL,
      spot_size REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
    CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
    CREATE INDEX IF NOT EXISTS idx_trades_type ON trades(type);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_arbitrage_positions_status ON arbitrage_positions(status);
  `);

  console.log("[Database] Initialized at", finalPath);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    console.log("[Database] Closed");
  }
}

export function isDbInitialized(): boolean {
  return db !== null;
}
