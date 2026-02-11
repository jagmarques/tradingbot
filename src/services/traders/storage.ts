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

export function getTopInsiders(limit: number): InsiderWallet[] {
  const db = getDb();

  const rows = db.prepare(
    "SELECT * FROM insider_wallets ORDER BY gem_hit_count DESC, score DESC LIMIT ?"
  ).all(limit) as Record<string, unknown>[];

  return rows.map(mapRowToInsiderWallet);
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
    buyBlockNumber: 0, // Not stored in DB
    pumpMultiple: row.pump_multiple as number,
  }));
}

export function getInsiderCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM insider_wallets").get() as { count: number };
  return row.count;
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
