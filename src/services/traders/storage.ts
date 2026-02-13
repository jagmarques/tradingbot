import { getDb } from "../database/db.js";
import type { EvmChain, GemHit, InsiderWallet } from "./types.js";

export function initInsiderTables(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS insider_gem_hits (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      buy_tx_hash TEXT,
      buy_timestamp INTEGER,
      pump_multiple REAL,
      discovered_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_insider_gem_hits_wallet ON insider_gem_hits(wallet_address)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_insider_gem_hits_chain ON insider_gem_hits(chain)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_insider_gem_hits_token ON insider_gem_hits(token_address)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS insider_wallets (
      address TEXT NOT NULL,
      chain TEXT NOT NULL,
      gem_hit_count INTEGER NOT NULL,
      gems TEXT NOT NULL,
      score REAL NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (address, chain)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_insider_wallets_score ON insider_wallets(score)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_insider_wallets_gem_count ON insider_wallets(gem_hit_count)
  `);

  // Add P&L columns (safe if already exist)
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN buy_tokens REAL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN sell_tokens REAL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN status TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN buy_date INTEGER DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN sell_date INTEGER DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN max_pump_multiple REAL DEFAULT 0"); } catch { /* already exists */ }
  // Seed max_pump_multiple from existing pump_multiple for old records
  db.prepare("UPDATE insider_gem_hits SET max_pump_multiple = pump_multiple WHERE (max_pump_multiple = 0 OR max_pump_multiple IS NULL) AND pump_multiple > 0").run();

  console.log("[InsiderScanner] Database tables initialized");
}

export function upsertGemHit(hit: GemHit): void {
  const db = getDb();
  const id = `${hit.walletAddress}_${hit.tokenAddress}_${hit.chain}`;

  db.prepare(`
    INSERT OR IGNORE INTO insider_gem_hits (
      id, wallet_address, chain, token_address, token_symbol,
      buy_tx_hash, buy_timestamp, pump_multiple
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    hit.walletAddress.toLowerCase(),
    hit.chain,
    hit.tokenAddress.toLowerCase(),
    hit.tokenSymbol,
    hit.buyTxHash,
    hit.buyTimestamp,
    hit.pumpMultiple
  );
}

export function upsertInsiderWallet(wallet: InsiderWallet): void {
  const db = getDb();

  db.prepare(`
    INSERT OR REPLACE INTO insider_wallets (
      address, chain, gem_hit_count, gems, score,
      first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    wallet.address.toLowerCase(),
    wallet.chain,
    wallet.gemHitCount,
    JSON.stringify(wallet.gems),
    wallet.score,
    wallet.firstSeenAt,
    wallet.lastSeenAt
  );
}

export function getInsiderWallets(chain?: EvmChain, minHits?: number): InsiderWallet[] {
  const db = getDb();

  let query = "SELECT * FROM insider_wallets WHERE 1=1";
  const params: unknown[] = [];

  if (chain) {
    query += " AND chain = ?";
    params.push(chain);
  }

  if (minHits) {
    query += " AND gem_hit_count >= ?";
    params.push(minHits);
  }

  query += " ORDER BY gem_hit_count DESC";

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(mapRowToInsiderWallet);
}


export function updateGemHitPnl(
  walletAddress: string, tokenAddress: string, chain: string,
  buyTokens: number, sellTokens: number, status: string,
  buyDate: number, sellDate: number
): void {
  const db = getDb();
  db.prepare(`
    UPDATE insider_gem_hits SET buy_tokens = ?, sell_tokens = ?, status = ?, buy_date = ?, sell_date = ?
    WHERE wallet_address = ? AND token_address = ? AND chain = ?
  `).run(buyTokens, sellTokens, status, buyDate, sellDate, walletAddress.toLowerCase(), tokenAddress.toLowerCase(), chain);
}

export function getGemHitsForWallet(address: string, chain: string): GemHit[] {
  const db = getDb();

  const rows = db.prepare(
    "SELECT * FROM insider_gem_hits WHERE wallet_address = ? AND chain = ?"
  ).all(address.toLowerCase(), chain) as Record<string, unknown>[];

  return rows.map((row) => ({
    walletAddress: row.wallet_address as string,
    chain: row.chain as EvmChain,
    tokenAddress: row.token_address as string,
    tokenSymbol: row.token_symbol as string,
    buyTxHash: row.buy_tx_hash as string,
    buyTimestamp: row.buy_timestamp as number,
    buyBlockNumber: 0,
    pumpMultiple: row.pump_multiple as number,
    maxPumpMultiple: (row.max_pump_multiple as number) || undefined,
    buyTokens: (row.buy_tokens as number) || undefined,
    sellTokens: (row.sell_tokens as number) || undefined,
    status: (row.status as GemHit["status"]) || undefined,
    buyDate: (row.buy_date as number) || undefined,
    sellDate: (row.sell_date as number) || undefined,
  }));
}


export function getAllHeldGemHits(chain?: string): GemHit[] {
  const db = getDb();
  let query = "SELECT * FROM insider_gem_hits WHERE status = 'holding'";
  const params: unknown[] = [];
  if (chain) {
    query += " AND chain = ?";
    params.push(chain);
  }
  query += " ORDER BY pump_multiple DESC";
  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    walletAddress: row.wallet_address as string,
    chain: row.chain as EvmChain,
    tokenAddress: row.token_address as string,
    tokenSymbol: row.token_symbol as string,
    buyTxHash: row.buy_tx_hash as string,
    buyTimestamp: row.buy_timestamp as number,
    buyBlockNumber: 0,
    pumpMultiple: row.pump_multiple as number,
    maxPumpMultiple: (row.max_pump_multiple as number) || undefined,
    buyTokens: (row.buy_tokens as number) || undefined,
    sellTokens: (row.sell_tokens as number) || undefined,
    status: (row.status as GemHit["status"]) || undefined,
    buyDate: (row.buy_date as number) || undefined,
    sellDate: (row.sell_date as number) || undefined,
  }));
}

export function getInsiderCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM insider_wallets").get() as { count: number };
  return row.count;
}

export function updateGemHitPumpMultiple(tokenAddress: string, chain: string, pumpMultiple: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE insider_gem_hits
     SET pump_multiple = ?,
         max_pump_multiple = MAX(COALESCE(max_pump_multiple, 0), ?)
     WHERE token_address = ? AND chain = ?`
  ).run(pumpMultiple, pumpMultiple, tokenAddress.toLowerCase(), chain);
}

function mapRowToInsiderWallet(row: Record<string, unknown>): InsiderWallet {
  let gems: string[] = [];
  try {
    gems = JSON.parse(row.gems as string);
  } catch {
    gems = [];
  }

  return {
    address: row.address as string,
    chain: row.chain as EvmChain,
    gemHitCount: row.gem_hit_count as number,
    gems,
    score: row.score as number,
    firstSeenAt: row.first_seen_at as number,
    lastSeenAt: row.last_seen_at as number,
  };
}
