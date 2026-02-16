import { getDb } from "../database/db.js";
import type { GemHit, InsiderWallet, ScanChain } from "./types.js";

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS insider_gem_analyses (
      id TEXT PRIMARY KEY,
      token_symbol TEXT NOT NULL,
      chain TEXT NOT NULL,
      score INTEGER NOT NULL,
      summary TEXT NOT NULL,
      analyzed_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS insider_gem_paper_trades (
      id TEXT PRIMARY KEY,
      token_symbol TEXT NOT NULL,
      chain TEXT NOT NULL,
      buy_pump_multiple REAL NOT NULL,
      current_pump_multiple REAL NOT NULL,
      buy_timestamp INTEGER NOT NULL,
      amount_usd REAL NOT NULL DEFAULT 10,
      pnl_pct REAL NOT NULL DEFAULT 0,
      ai_score INTEGER,
      status TEXT NOT NULL DEFAULT 'open'
    )
  `);

  // Add price columns for accurate P&L (safe if already exist)
  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN buy_price_usd REAL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN current_price_usd REAL DEFAULT 0"); } catch { /* already exists */ }

  // Delete paper trades with no buy price (failed price fetch)
  db.exec("DELETE FROM insider_gem_paper_trades WHERE buy_price_usd = 0 OR buy_price_usd IS NULL");

  // Add live trade columns (safe if already exist)
  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN tx_hash TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN tokens_received TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN sell_tx_hash TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN is_live INTEGER DEFAULT 0"); } catch { /* already exists */ }

  // One-time: clear old GoPlus-based analyses so insider scoring takes over
  const oldAnalyses = db.prepare("SELECT COUNT(*) as cnt FROM insider_gem_analyses WHERE score = -1 OR score = 50").get() as { cnt: number };
  if (oldAnalyses.cnt > 0) {
    db.exec("DELETE FROM insider_gem_analyses");
    console.log(`[InsiderScanner] Cleared ${oldAnalyses.cnt} old GoPlus-based analyses`);
  }

  // Clean emojis from existing token symbols
  const dirtySymbols = db.prepare("SELECT DISTINCT token_symbol FROM insider_gem_hits").all() as Array<{ token_symbol: string }>;
  for (const row of dirtySymbols) {
    const clean = row.token_symbol.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\u{E0067}\u{E0062}\u{E007F}\u{1F3F4}]/gu, "").trim();
    if (clean !== row.token_symbol) {
      db.prepare("UPDATE insider_gem_hits SET token_symbol = ? WHERE token_symbol = ?").run(clean, row.token_symbol);
    }
  }

  console.log("[InsiderScanner] Database tables initialized");
}

// Solana base58 is case-sensitive; only lowercase EVM hex addresses
function normalizeAddr(addr: string, chain: string): string {
  return chain === "solana" ? addr : addr.toLowerCase();
}

export function upsertGemHit(hit: GemHit): void {
  const db = getDb();
  const wa = normalizeAddr(hit.walletAddress, hit.chain);
  const ta = normalizeAddr(hit.tokenAddress, hit.chain);
  const id = `${wa}_${ta}_${hit.chain}`;

  db.prepare(`
    INSERT OR IGNORE INTO insider_gem_hits (
      id, wallet_address, chain, token_address, token_symbol,
      buy_tx_hash, buy_timestamp, pump_multiple, max_pump_multiple
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    wa,
    hit.chain,
    ta,
    hit.tokenSymbol,
    hit.buyTxHash,
    hit.buyTimestamp,
    hit.pumpMultiple,
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
    normalizeAddr(wallet.address, wallet.chain),
    wallet.chain,
    wallet.gemHitCount,
    JSON.stringify(wallet.gems),
    wallet.score,
    wallet.firstSeenAt,
    wallet.lastSeenAt
  );
}

export function getInsiderWallets(chain?: ScanChain, minHits?: number): InsiderWallet[] {
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
  `).run(buyTokens, sellTokens, status, buyDate, sellDate, normalizeAddr(walletAddress, chain), normalizeAddr(tokenAddress, chain), chain);
}

export function getGemHitsForWallet(address: string, chain: string): GemHit[] {
  const db = getDb();

  const rows = db.prepare(
    "SELECT * FROM insider_gem_hits WHERE wallet_address = ? AND chain = ?"
  ).all(normalizeAddr(address, chain), chain) as Record<string, unknown>[];

  return rows.map((row) => ({
    walletAddress: row.wallet_address as string,
    chain: row.chain as ScanChain,
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
  let query = "SELECT * FROM insider_gem_hits WHERE (status = 'holding' OR status = 'unknown' OR status IS NULL)";
  const params: unknown[] = [];
  if (chain) {
    query += " AND chain = ?";
    params.push(chain);
  }
  query += " ORDER BY pump_multiple DESC";
  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    walletAddress: row.wallet_address as string,
    chain: row.chain as ScanChain,
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

export function getGemHolderCount(symbol: string, chain: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(DISTINCT wallet_address) as count FROM insider_gem_hits WHERE token_symbol = ? AND chain = ? AND status = 'holding'"
  ).get(symbol, chain) as { count: number };
  return row.count;
}

export function updateGemHitPumpMultiple(tokenAddress: string, chain: string, pumpMultiple: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE insider_gem_hits
     SET pump_multiple = ?,
         max_pump_multiple = MAX(COALESCE(max_pump_multiple, 0), ?)
     WHERE token_address = ? AND chain = ?`
  ).run(pumpMultiple, pumpMultiple, normalizeAddr(tokenAddress, chain), chain);
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
    chain: row.chain as ScanChain,
    gemHitCount: row.gem_hit_count as number,
    gems,
    score: row.score as number,
    firstSeenAt: row.first_seen_at as number,
    lastSeenAt: row.last_seen_at as number,
  };
}

export interface GemAnalysis {
  tokenSymbol: string;
  chain: string;
  score: number;
  analyzedAt: number;
}

export function getCachedGemAnalysis(symbol: string, chain: string): GemAnalysis | null {
  const db = getDb();
  const id = `${symbol.toLowerCase()}_${chain}`;
  const CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

  const row = db.prepare("SELECT * FROM insider_gem_analyses WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const analyzedAt = row.analyzed_at as number;
  if (Date.now() - analyzedAt > CACHE_TTL_MS) return null;

  return {
    tokenSymbol: row.token_symbol as string,
    chain: row.chain as string,
    score: row.score as number,
    analyzedAt,
  };
}

export function saveGemAnalysis(analysis: GemAnalysis): void {
  const db = getDb();
  const id = `${analysis.tokenSymbol.toLowerCase()}_${analysis.chain}`;

  db.prepare(`
    INSERT OR REPLACE INTO insider_gem_analyses (id, token_symbol, chain, score, summary, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, analysis.tokenSymbol, analysis.chain, analysis.score, "", analysis.analyzedAt);
}

export interface GemPaperTrade {
  id: string;
  tokenSymbol: string;
  chain: string;
  buyTimestamp: number;
  amountUsd: number;
  pnlPct: number;
  aiScore: number | null;
  status: "open" | "closed";
  buyPriceUsd: number;
  currentPriceUsd: number;
  txHash?: string | null;
  tokensReceived?: string | null;
  sellTxHash?: string | null;
  isLive?: boolean;
  buyPumpMultiple?: number;
  currentPumpMultiple?: number;
}

export function insertGemPaperTrade(trade: Omit<GemPaperTrade, "id">): void {
  const db = getDb();
  const id = `${trade.tokenSymbol.toLowerCase()}_${trade.chain}`;

  db.prepare(`
    INSERT OR IGNORE INTO insider_gem_paper_trades (
      id, token_symbol, chain, buy_pump_multiple, current_pump_multiple,
      buy_timestamp, amount_usd, pnl_pct, ai_score, status,
      buy_price_usd, current_price_usd, tx_hash, tokens_received, is_live
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    trade.tokenSymbol,
    trade.chain,
    trade.buyPumpMultiple ?? 0,
    trade.currentPumpMultiple ?? 0,
    trade.buyTimestamp,
    trade.amountUsd,
    trade.pnlPct,
    trade.aiScore,
    trade.status,
    trade.buyPriceUsd,
    trade.currentPriceUsd,
    trade.txHash ?? null,
    trade.tokensReceived ?? null,
    trade.isLive ? 1 : 0
  );
}

export function getGemPaperTrade(symbol: string, chain: string): GemPaperTrade | null {
  const db = getDb();
  const id = `${symbol.toLowerCase()}_${chain}`;

  const row = db.prepare("SELECT * FROM insider_gem_paper_trades WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    id: row.id as string,
    tokenSymbol: row.token_symbol as string,
    chain: row.chain as string,
    buyTimestamp: row.buy_timestamp as number,
    amountUsd: row.amount_usd as number,
    pnlPct: row.pnl_pct as number,
    aiScore: (row.ai_score as number | null),
    status: row.status as "open" | "closed",
    buyPriceUsd: (row.buy_price_usd as number) || 0,
    currentPriceUsd: (row.current_price_usd as number) || 0,
    txHash: (row.tx_hash as string) || null,
    tokensReceived: (row.tokens_received as string) || null,
    sellTxHash: (row.sell_tx_hash as string) || null,
    isLive: (row.is_live as number) === 1,
    buyPumpMultiple: (row.buy_pump_multiple as number) || 0,
    currentPumpMultiple: (row.current_pump_multiple as number) || 0,
  };
}

export function getOpenGemPaperTrades(): GemPaperTrade[] {
  const db = getDb();

  const rows = db.prepare("SELECT * FROM insider_gem_paper_trades WHERE status = 'open' ORDER BY pnl_pct DESC").all() as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    tokenSymbol: row.token_symbol as string,
    chain: row.chain as string,
    buyTimestamp: row.buy_timestamp as number,
    amountUsd: row.amount_usd as number,
    pnlPct: row.pnl_pct as number,
    aiScore: (row.ai_score as number | null),
    status: row.status as "open" | "closed",
    buyPriceUsd: (row.buy_price_usd as number) || 0,
    currentPriceUsd: (row.current_price_usd as number) || 0,
    txHash: (row.tx_hash as string) || null,
    tokensReceived: (row.tokens_received as string) || null,
    sellTxHash: (row.sell_tx_hash as string) || null,
    isLive: (row.is_live as number) === 1,
    buyPumpMultiple: (row.buy_pump_multiple as number) || 0,
    currentPumpMultiple: (row.current_pump_multiple as number) || 0,
  }));
}

export function updateGemPaperTradePrice(symbol: string, chain: string, currentPriceUsd: number): void {
  const db = getDb();
  const id = `${symbol.toLowerCase()}_${chain}`;

  db.prepare(`
    UPDATE insider_gem_paper_trades
    SET current_price_usd = ?,
        current_pump_multiple = CASE
          WHEN buy_price_usd > 0 AND ? > 0 THEN (? / buy_price_usd)
          ELSE current_pump_multiple
        END,
        pnl_pct = CASE
          WHEN buy_price_usd > 0 AND ? > 0 THEN ((? / buy_price_usd - 1) * 100)
          ELSE 0
        END
    WHERE id = ?
  `).run(currentPriceUsd, currentPriceUsd, currentPriceUsd, currentPriceUsd, currentPriceUsd, id);
}

export function closeGemPaperTrade(symbol: string, chain: string, sellTxHash?: string): void {
  const db = getDb();
  const id = `${symbol.toLowerCase()}_${chain}`;

  if (sellTxHash) {
    db.prepare("UPDATE insider_gem_paper_trades SET status = 'closed', sell_tx_hash = ? WHERE id = ?").run(sellTxHash, id);
  } else {
    db.prepare("UPDATE insider_gem_paper_trades SET status = 'closed' WHERE id = ?").run(id);
  }
}

export function getTokenAddressForGem(symbol: string, chain: string): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT token_address FROM insider_gem_hits WHERE token_symbol = ? AND chain = ? LIMIT 1"
  ).get(symbol, chain) as { token_address: string } | undefined;
  return row?.token_address ?? null;
}

export function getPeakPumpForToken(symbol: string, chain: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT MAX(COALESCE(max_pump_multiple, pump_multiple)) as peak FROM insider_gem_hits WHERE token_symbol = ? AND chain = ?"
  ).get(symbol, chain) as { peak: number } | undefined;
  return row?.peak || 0;
}

export function getInsiderStatsForToken(tokenAddress: string, chain: string): { insiderCount: number; avgInsiderQuality: number; holdRate: number } {
  const db = getDb();
  const ta = normalizeAddr(tokenAddress, chain);

  // Get insider count and avg quality
  const statsRow = db.prepare(`
    SELECT COUNT(DISTINCT h.wallet_address) as insider_count,
           COALESCE(AVG(w.gem_hit_count), 0) as avg_quality
    FROM insider_gem_hits h
    JOIN insider_wallets w ON h.wallet_address = w.address AND h.chain = w.chain
    WHERE h.token_address = ? AND h.chain = ?
      AND w.gem_hit_count >= 5
  `).get(ta, chain) as { insider_count: number; avg_quality: number } | undefined;

  const insiderCount = statsRow?.insider_count ?? 0;
  const avgInsiderQuality = statsRow?.avg_quality ?? 0;

  // Get hold rate
  const holdRow = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'holding' OR status IS NULL OR status = 'unknown' THEN 1 ELSE 0 END) as holding_count,
      COUNT(*) as total_count
    FROM insider_gem_hits
    WHERE token_address = ? AND chain = ?
  `).get(ta, chain) as { holding_count: number; total_count: number } | undefined;

  const holdingCount = holdRow?.holding_count ?? 0;
  const totalCount = holdRow?.total_count ?? 0;
  const holdRate = totalCount > 0 ? (holdingCount / totalCount) * 100 : 0;

  return { insiderCount, avgInsiderQuality, holdRate };
}

export function deleteInsiderWalletsBelow(minScore: number): number {
  const db = getDb();
  const result = db.prepare("DELETE FROM insider_wallets WHERE score < ?").run(minScore);
  return result.changes;
}

export interface InsiderWalletStats {
  address: string;
  chain: ScanChain;
  score: number;
  gemHitCount: number;
  avgGainPct: number;
  avgPnlUsd: number;
}

export function getInsiderWalletsWithStats(chain?: ScanChain): InsiderWalletStats[] {
  const db = getDb();
  let query = `
    SELECT w.address, w.chain, w.score, w.gem_hit_count,
           COALESCE(AVG(h.pump_multiple), 0) as avg_pump,
           COUNT(h.id) as hit_count
    FROM insider_wallets w
    LEFT JOIN insider_gem_hits h ON w.address = h.wallet_address AND w.chain = h.chain
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (chain) {
    query += " AND w.chain = ?";
    params.push(chain);
  }
  query += " GROUP BY w.address, w.chain ORDER BY w.score DESC LIMIT 50";

  const rows = db.prepare(query).all(...params) as Array<{
    address: string; chain: string; score: number; gem_hit_count: number;
    avg_pump: number; hit_count: number;
  }>;

  return rows.map(r => ({
    address: r.address,
    chain: r.chain as ScanChain,
    score: r.score,
    gemHitCount: r.gem_hit_count,
    avgGainPct: r.avg_pump > 0 ? (r.avg_pump - 1) * 100 : 0,
    avgPnlUsd: r.avg_pump > 0 ? (r.avg_pump - 1) * 10 : 0,
  }));
}
