import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database | null = null;

const DB_PATH = process.env.DB_PATH || "/app/data/trades.db";

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

    CREATE TABLE IF NOT EXISTS bot_settings (
      telegram_user_id TEXT PRIMARY KEY,
      auto_copy_enabled INTEGER DEFAULT 0,
      copy_percentage REAL DEFAULT 1.0,
      min_trader_score INTEGER DEFAULT 70,
      max_copy_per_day INTEGER DEFAULT 10,
      daily_copy_count INTEGER DEFAULT 0,
      daily_copy_reset TEXT,
      copy_amount_eth REAL DEFAULT 0.001,
      copy_amount_matic REAL DEFAULT 2,
      copy_amount_default REAL DEFAULT 0.005,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
    CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
    CREATE INDEX IF NOT EXISTS idx_trades_type ON trades(type);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

    CREATE TABLE IF NOT EXISTS quant_trades (
      id TEXT PRIMARY KEY,
      pair TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL,
      size REAL NOT NULL,
      leverage INTEGER NOT NULL DEFAULT 1,
      pnl REAL DEFAULT 0,
      fees REAL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'paper',
      status TEXT NOT NULL DEFAULT 'open',
      ai_confidence REAL,
      ai_reasoning TEXT,
      exit_reason TEXT,
      indicators_at_entry TEXT,
      trade_type TEXT NOT NULL DEFAULT 'directional',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS quant_positions (
      id TEXT PRIMARY KEY,
      pair TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price REAL NOT NULL,
      size REAL NOT NULL,
      leverage INTEGER NOT NULL DEFAULT 1,
      unrealized_pnl REAL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'paper',
      status TEXT NOT NULL DEFAULT 'open',
      trade_type TEXT NOT NULL DEFAULT 'directional',
      opened_at TEXT DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_quant_trades_pair ON quant_trades(pair);
    CREATE INDEX IF NOT EXISTS idx_quant_trades_status ON quant_trades(status);
    CREATE INDEX IF NOT EXISTS idx_quant_trades_mode ON quant_trades(mode);
    CREATE INDEX IF NOT EXISTS idx_quant_trades_created ON quant_trades(created_at);
    CREATE INDEX IF NOT EXISTS idx_quant_positions_status ON quant_positions(status);

    CREATE TABLE IF NOT EXISTS quant_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS daily_alt_data (
      date TEXT PRIMARY KEY,
      fear_greed INTEGER,
      sopr REAL,
      nupl REAL,
      collected_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

  `);

  // Migration: Add new copy amount columns to bot_settings (for existing DBs)
  const botSettingsColumns = db.pragma("table_info(bot_settings)") as Array<{ name: string }>;
  const botSettingsColumnNames = botSettingsColumns.map((c) => c.name);

  if (!botSettingsColumnNames.includes("copy_amount_eth")) {
    db.exec(`
      ALTER TABLE bot_settings ADD COLUMN copy_amount_eth REAL DEFAULT 0.001;
      ALTER TABLE bot_settings ADD COLUMN copy_amount_matic REAL DEFAULT 2;
      ALTER TABLE bot_settings ADD COLUMN copy_amount_default REAL DEFAULT 0.005;
    `);
    console.log("[Database] Migrated bot_settings: added copy amount columns");
  }

  // Migration: Add quant/insider/rug P&L breakdown columns to daily_stats
  const dailyStatsColumns = db.pragma("table_info(daily_stats)") as Array<{ name: string }>;
  const dailyStatsColumnNames = dailyStatsColumns.map((c) => c.name);

  if (!dailyStatsColumnNames.includes("quant_pnl")) {
    db.exec(`
      ALTER TABLE daily_stats ADD COLUMN quant_pnl REAL DEFAULT 0;
      ALTER TABLE daily_stats ADD COLUMN insider_copy_pnl REAL DEFAULT 0;
      ALTER TABLE daily_stats ADD COLUMN rug_pnl REAL DEFAULT 0;
    `);
    console.log("[Database] Migrated daily_stats: added quant/insider/rug P&L columns");
  }

  // Migration: Add trade_type column to quant_trades and quant_positions (for funding arb tracking)
  const quantTradesCols = db.pragma("table_info(quant_trades)") as Array<{ name: string }>;
  const qtColNames = quantTradesCols.map((c) => c.name);
  if (!qtColNames.includes("trade_type")) {
    db.exec(`ALTER TABLE quant_trades ADD COLUMN trade_type TEXT NOT NULL DEFAULT 'directional'`);
    console.log("[Database] Migrated quant_trades: added trade_type column");
  }
  if (!qtColNames.includes("indicators_at_entry")) {
    db.exec(`ALTER TABLE quant_trades ADD COLUMN indicators_at_entry TEXT`);
    console.log("[Database] Migrated quant_trades: added indicators_at_entry column");
  }
  const quantPosCols = db.pragma("table_info(quant_positions)") as Array<{ name: string }>;
  const qpColNames = quantPosCols.map((c) => c.name);
  if (!qpColNames.includes("trade_type")) {
    db.exec(`ALTER TABLE quant_positions ADD COLUMN trade_type TEXT NOT NULL DEFAULT 'directional'`);
    console.log("[Database] Migrated quant_positions: added trade_type column");
  }
  if (!qpColNames.includes("stop_loss")) {
    db.exec(`ALTER TABLE quant_positions ADD COLUMN stop_loss REAL`);
    db.exec(`ALTER TABLE quant_positions ADD COLUMN take_profit REAL`);
    console.log("[Database] Migrated quant_positions: added stop_loss, take_profit columns");
  }
  if (!qpColNames.includes("max_unrealized_pnl_pct")) {
    db.exec(`ALTER TABLE quant_positions ADD COLUMN max_unrealized_pnl_pct REAL`);
    console.log("[Database] Migrated quant_positions: added max_unrealized_pnl_pct column");
  }

  // Migration: Add ai_agreed column to quant_positions
  if (!qpColNames.includes("ai_agreed")) {
    db.exec(`ALTER TABLE quant_positions ADD COLUMN ai_agreed INTEGER`);
    console.log("[Database] Migrated quant_positions: added ai_agreed column");
  }

  // Migration: Add ai_agreed column to quant_trades
  if (!qtColNames.includes("ai_agreed")) {
    db.exec(`ALTER TABLE quant_trades ADD COLUMN ai_agreed INTEGER`);
    console.log("[Database] Migrated quant_trades: added ai_agreed column");
  }

  // Migration: Add exchange column to quant_positions and quant_trades
  const qpColsFresh = (db.pragma("table_info(quant_positions)") as Array<{ name: string }>).map(c => c.name);
  if (!qpColsFresh.includes("exchange")) {
    db.exec(`ALTER TABLE quant_positions ADD COLUMN exchange TEXT DEFAULT 'hyperliquid'`);
    console.log("[Database] Migrated quant_positions: added exchange column");
  }
  const qtColsFresh = (db.pragma("table_info(quant_trades)") as Array<{ name: string }>).map(c => c.name);
  if (!qtColsFresh.includes("exchange")) {
    db.exec(`ALTER TABLE quant_trades ADD COLUMN exchange TEXT DEFAULT 'hyperliquid'`);
    console.log("[Database] Migrated quant_trades: added exchange column");
  }
  if (!qtColsFresh.includes("max_unrealized_pnl_pct")) {
    db.exec(`ALTER TABLE quant_trades ADD COLUMN max_unrealized_pnl_pct REAL`);
    console.log("[Database] Migrated quant_trades: added max_unrealized_pnl_pct column");
  }

  // Migration: Add indicators_at_entry to quant_positions
  const qpColsLatest = (db.pragma("table_info(quant_positions)") as Array<{ name: string }>).map(c => c.name);
  if (!qpColsLatest.includes("indicators_at_entry")) {
    db.exec(`ALTER TABLE quant_positions ADD COLUMN indicators_at_entry TEXT`);
    console.log("[Database] Migrated quant_positions: added indicators_at_entry column");
  }

  // Migration: Add backtest improvement columns to quant_positions
  const qpCols2 = db.prepare("PRAGMA table_info(quant_positions)").all() as Array<{ name: string }>;
  const qpColNames2 = qpCols2.map(c => c.name);
  if (!qpColNames2.includes("btc_price_at_entry")) {
    db.exec(`ALTER TABLE quant_positions ADD COLUMN btc_price_at_entry REAL`);
    db.exec(`ALTER TABLE quant_positions ADD COLUMN equity_at_entry REAL`);
    console.log("[Database] Migrated quant_positions: added btc_price_at_entry, equity_at_entry");
  }

  // Migration: Add backtest improvement columns to quant_trades
  const qtCols2 = db.prepare("PRAGMA table_info(quant_trades)").all() as Array<{ name: string }>;
  const qtColNames2 = qtCols2.map(c => c.name);
  if (!qtColNames2.includes("btc_price_at_entry")) {
    db.exec(`ALTER TABLE quant_trades ADD COLUMN btc_price_at_entry REAL`);
    db.exec(`ALTER TABLE quant_trades ADD COLUMN event_timestamp TEXT`);
    db.exec(`ALTER TABLE quant_trades ADD COLUMN news_source TEXT`);
    db.exec(`ALTER TABLE quant_trades ADD COLUMN hold_duration_ms INTEGER`);
    db.exec(`ALTER TABLE quant_trades ADD COLUMN slippage_pct REAL`);
    db.exec(`ALTER TABLE quant_trades ADD COLUMN equity_at_entry REAL`);
    db.exec(`ALTER TABLE quant_trades ADD COLUMN event_position_count INTEGER`);
    console.log("[Database] Migrated quant_trades: added backtest columns");
  }

  // Fix insider tables: drop old schemas and let initInsiderTables recreate with correct columns
  const iwCols = (db.pragma("table_info(insider_wallets)") as Array<{ name: string }>).map(c => c.name);
  if (iwCols.length > 0 && !iwCols.includes("gems")) {
    db.exec(`DROP TABLE IF EXISTS insider_wallets`);
    console.log("[Database] Dropped old insider_wallets (missing gems column)");
  }
  const ictCols = (db.pragma("table_info(insider_copy_trades)") as Array<{ name: string }>).map(c => c.name);
  if (ictCols.length > 0 && !ictCols.includes("buy_price_usd")) {
    db.exec(`DROP TABLE IF EXISTS insider_copy_trades`);
    console.log("[Database] Dropped old insider_copy_trades (wrong schema)");
  }
  const gemCols = db.prepare("PRAGMA table_info(insider_gem_hits)").all() as Array<{ name: string }>;
  if (gemCols.length > 0 && !gemCols.map(c => c.name).includes("wallet_address")) {
    db.exec(`DROP TABLE IF EXISTS insider_gem_hits`);
    db.exec(`DROP TABLE IF EXISTS insider_gem_analyses`);
    db.exec(`DROP TABLE IF EXISTS insider_gem_paper_trades`);
    db.exec(`DROP TABLE IF EXISTS insider_copy_trades`);
    db.exec(`DROP TABLE IF EXISTS insider_wallets`);
    console.log("[Database] Dropped old insider tables (will be recreated with correct schema)");
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
