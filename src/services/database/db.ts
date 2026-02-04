import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database | null = null;

const DB_PATH = process.env.DB_PATH || "/data/trades.db";

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

    CREATE TABLE IF NOT EXISTS pumpfun_positions (
      mint TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      entry_price REAL NOT NULL,
      total_tokens TEXT NOT NULL,
      total_cost_lamports TEXT NOT NULL,
      buy_phase INTEGER NOT NULL,
      peak_price REAL NOT NULL,
      trailing_stop_active INTEGER NOT NULL,
      sold_first INTEGER NOT NULL,
      sold_second INTEGER NOT NULL,
      sold_third INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bot_settings (
      telegram_user_id TEXT PRIMARY KEY,
      auto_snipe_enabled INTEGER DEFAULT 1,
      auto_copy_enabled INTEGER DEFAULT 0,
      copy_percentage REAL DEFAULT 1.0,
      min_trader_score INTEGER DEFAULT 70,
      max_copy_per_day INTEGER DEFAULT 10,
      daily_copy_count INTEGER DEFAULT 0,
      daily_copy_reset TEXT,
      copy_amount_sol REAL DEFAULT 0.02,
      copy_amount_eth REAL DEFAULT 0.001,
      copy_amount_matic REAL DEFAULT 2,
      copy_amount_default REAL DEFAULT 0.005,
      polymarket_copy_usd REAL DEFAULT 5,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS aibetting_positions (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      market_title TEXT NOT NULL,
      market_end_date TEXT,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      size REAL NOT NULL,
      ai_probability REAL NOT NULL,
      confidence REAL NOT NULL,
      expected_value REAL NOT NULL,
      status TEXT NOT NULL,
      entry_timestamp INTEGER NOT NULL,
      exit_timestamp INTEGER,
      exit_price REAL,
      pnl REAL,
      exit_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS aibetting_analyses (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      market_title TEXT NOT NULL,
      probability REAL NOT NULL,
      confidence REAL NOT NULL,
      reasoning TEXT NOT NULL,
      key_factors TEXT,
      analyzed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
    CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
    CREATE INDEX IF NOT EXISTS idx_trades_type ON trades(type);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_arbitrage_positions_status ON arbitrage_positions(status);
    CREATE INDEX IF NOT EXISTS idx_pumpfun_positions_created ON pumpfun_positions(created_at);
    CREATE INDEX IF NOT EXISTS idx_aibetting_positions_status ON aibetting_positions(status);
    CREATE INDEX IF NOT EXISTS idx_aibetting_positions_market ON aibetting_positions(market_id);
  `);

  // Migration: Add new copy amount columns to bot_settings (for existing DBs)
  const columns = db.pragma("table_info(bot_settings)") as Array<{ name: string }>;
  const columnNames = columns.map((c) => c.name);

  if (!columnNames.includes("copy_amount_sol")) {
    db.exec(`
      ALTER TABLE bot_settings ADD COLUMN copy_amount_sol REAL DEFAULT 0.02;
      ALTER TABLE bot_settings ADD COLUMN copy_amount_eth REAL DEFAULT 0.001;
      ALTER TABLE bot_settings ADD COLUMN copy_amount_matic REAL DEFAULT 2;
      ALTER TABLE bot_settings ADD COLUMN copy_amount_default REAL DEFAULT 0.005;
      ALTER TABLE bot_settings ADD COLUMN polymarket_copy_usd REAL DEFAULT 5;
    `);
    console.log("[Database] Migrated bot_settings: added copy amount columns");
  }

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
