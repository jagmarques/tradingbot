import { getDb } from "../database/db.js";
import type { CopyTrade, CopyExitReason, InsiderWallet, ScanChain } from "./types.js";
import { COPY_TRADE_CONFIG } from "./types.js";

export function initInsiderTables(): void {
  const db = getDb();

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS insider_copy_trades (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'buy',
      buy_price_usd REAL NOT NULL,
      current_price_usd REAL NOT NULL,
      amount_usd REAL NOT NULL DEFAULT 10,
      pnl_pct REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      liquidity_ok INTEGER NOT NULL DEFAULT 1,
      liquidity_usd REAL NOT NULL DEFAULT 0,
      skip_reason TEXT DEFAULT NULL,
      buy_timestamp INTEGER NOT NULL,
      close_timestamp INTEGER DEFAULT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_copy_trades_wallet ON insider_copy_trades(wallet_address)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_copy_trades_status ON insider_copy_trades(status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_copy_trades_chain ON insider_copy_trades(chain)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_copy_trades_token ON insider_copy_trades(token_address, chain)
  `);

  // Add insider_count and peak_pnl_pct columns (safe if already exist)
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN insider_count INTEGER NOT NULL DEFAULT 1"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN peak_pnl_pct REAL NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN exit_reason TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN pair_address TEXT DEFAULT NULL"); } catch { /* already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_rug_counts (
      token_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      rug_count INTEGER NOT NULL DEFAULT 0,
      last_rugged_at INTEGER NOT NULL,
      PRIMARY KEY (token_address, chain)
    )
  `);

  console.log("[InsiderScanner] Database tables initialized");
}

function normalizeAddr(addr: string): string {
  return addr.toLowerCase();
}

export function incrementRugCount(tokenAddress: string, chain: string): void {
  const db = getDb();
  const ta = normalizeAddr(tokenAddress);
  const now = Date.now();

  db.prepare(`
    INSERT INTO token_rug_counts (token_address, chain, rug_count, last_rugged_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(token_address, chain) DO UPDATE SET
      rug_count = rug_count + 1,
      last_rugged_at = ?
  `).run(ta, chain, now, now);
}

export function getRugCount(tokenAddress: string, chain: string): number {
  const db = getDb();
  const ta = normalizeAddr(tokenAddress);

  const row = db.prepare(
    "SELECT rug_count FROM token_rug_counts WHERE token_address = ? AND chain = ?"
  ).get(ta, chain) as { rug_count: number } | undefined;

  return row?.rug_count ?? 0;
}

export function upsertInsiderWallet(wallet: InsiderWallet): void {
  const db = getDb();

  db.prepare(`
    INSERT OR REPLACE INTO insider_wallets (
      address, chain, gem_hit_count, gems, score,
      first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    normalizeAddr(wallet.address),
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
    chain: row.chain as ScanChain,
    gemHitCount: row.gem_hit_count as number,
    gems,
    score: row.score as number,
    firstSeenAt: row.first_seen_at as number,
    lastSeenAt: row.last_seen_at as number,
  };
}

export function getInsiderStatsForToken(_tokenAddress: string, _chain: string): { insiderCount: number; avgInsiderQuality: number; holdRate: number } {
  return { insiderCount: 0, avgInsiderQuality: 0, holdRate: 0 };
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
      COALESCE(s.avg_pnl_pct, 0) AS avg_pnl_pct,
      COALESCE(s.avg_pnl_usd, 0) AS avg_pnl_usd
    FROM insider_wallets w
    LEFT JOIN (
      SELECT wallet_address, chain,
        AVG(pnl_pct) AS avg_pnl_pct,
        AVG(pnl_pct / 100.0 * amount_usd) AS avg_pnl_usd
      FROM insider_copy_trades
      WHERE status IN ('open', 'closed')
      GROUP BY wallet_address, chain
    ) s ON s.wallet_address = w.address AND s.chain = w.chain
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (chain) {
    query += " AND w.chain = ?";
    params.push(chain);
  }
  query += " ORDER BY w.score DESC LIMIT 50";

  const rows = db.prepare(query).all(...params) as Array<{
    address: string; chain: string; score: number; gem_hit_count: number;
    avg_pnl_pct: number; avg_pnl_usd: number;
  }>;

  return rows.map(r => ({
    address: r.address,
    chain: r.chain as ScanChain,
    score: r.score,
    gemHitCount: r.gem_hit_count,
    avgGainPct: r.avg_pnl_pct,
    avgPnlUsd: r.avg_pnl_usd,
  }));
}

function mapRowToCopyTrade(row: Record<string, unknown>): CopyTrade {
  return {
    id: row.id as string,
    walletAddress: row.wallet_address as string,
    tokenSymbol: row.token_symbol as string,
    tokenAddress: row.token_address as string,
    chain: row.chain as string,
    pairAddress: (row.pair_address as string) || null,
    side: row.side as "buy" | "sell",
    buyPriceUsd: row.buy_price_usd as number,
    currentPriceUsd: row.current_price_usd as number,
    amountUsd: row.amount_usd as number,
    pnlPct: row.pnl_pct as number,
    status: row.status as "open" | "closed" | "skipped",
    liquidityOk: (row.liquidity_ok as number) === 1,
    liquidityUsd: row.liquidity_usd as number,
    skipReason: (row.skip_reason as string) || null,
    buyTimestamp: row.buy_timestamp as number,
    closeTimestamp: (row.close_timestamp as number) || null,
    exitReason: (row.exit_reason as CopyTrade["exitReason"]) || null,
    insiderCount: (row.insider_count as number) || 1,
    peakPnlPct: (row.peak_pnl_pct as number) || 0,
  };
}

export function insertCopyTrade(trade: Omit<CopyTrade, "id">): void {
  const db = getDb();
  const wa = normalizeAddr(trade.walletAddress);
  const ta = normalizeAddr(trade.tokenAddress);
  const id = `${wa}_${ta}_${trade.chain}`;

  db.prepare(`
    INSERT OR IGNORE INTO insider_copy_trades (
      id, wallet_address, token_symbol, token_address, chain, side,
      buy_price_usd, current_price_usd, amount_usd, pnl_pct, status,
      liquidity_ok, liquidity_usd, skip_reason, buy_timestamp, close_timestamp,
      exit_reason, insider_count, peak_pnl_pct, pair_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    wa,
    trade.tokenSymbol,
    ta,
    trade.chain,
    trade.side,
    trade.buyPriceUsd,
    trade.currentPriceUsd,
    trade.amountUsd,
    trade.pnlPct,
    trade.status,
    trade.liquidityOk ? 1 : 0,
    trade.liquidityUsd,
    trade.skipReason ?? null,
    trade.buyTimestamp,
    trade.closeTimestamp ?? null,
    trade.exitReason ?? null,
    trade.insiderCount ?? 1,
    trade.peakPnlPct ?? 0,
    trade.pairAddress ?? null
  );
}

export function getCopyTrade(walletAddress: string, tokenAddress: string, chain: string): CopyTrade | null {
  const db = getDb();
  const id = `${normalizeAddr(walletAddress)}_${normalizeAddr(tokenAddress)}_${chain}`;

  const row = db.prepare("SELECT * FROM insider_copy_trades WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  return mapRowToCopyTrade(row);
}

export function getOpenCopyTrades(): CopyTrade[] {
  const db = getDb();

  const rows = db.prepare("SELECT * FROM insider_copy_trades WHERE status = 'open' ORDER BY pnl_pct DESC").all() as Record<string, unknown>[];
  return rows.map(mapRowToCopyTrade);
}

export function updateCopyTradePrice(walletAddress: string, tokenAddress: string, chain: string, currentPriceUsd: number): void {
  const db = getDb();
  const id = `${normalizeAddr(walletAddress)}_${normalizeAddr(tokenAddress)}_${chain}`;
  const feePct = COPY_TRADE_CONFIG.ESTIMATED_FEE_PCT;

  db.prepare(`
    UPDATE insider_copy_trades
    SET current_price_usd = ?,
        pnl_pct = CASE
          WHEN buy_price_usd > 0 AND ? > 0 THEN ((? / buy_price_usd - 1) * 100 - ?)
          ELSE 0
        END
    WHERE id = ?
  `).run(currentPriceUsd, currentPriceUsd, currentPriceUsd, feePct, id);
}

export function updateCopyTradePriceWithRugFee(walletAddress: string, tokenAddress: string, chain: string, currentPriceUsd: number): void {
  const db = getDb();
  const id = `${normalizeAddr(walletAddress)}_${normalizeAddr(tokenAddress)}_${chain}`;
  const feePct = COPY_TRADE_CONFIG.ESTIMATED_RUG_FEE_PCT;

  db.prepare(`
    UPDATE insider_copy_trades
    SET current_price_usd = ?,
        pnl_pct = CASE
          WHEN buy_price_usd > 0 AND ? > 0 THEN ((? / buy_price_usd - 1) * 100 - ?)
          ELSE 0
        END
    WHERE id = ?
  `).run(currentPriceUsd, currentPriceUsd, currentPriceUsd, feePct, id);
}

export function closeCopyTrade(walletAddress: string, tokenAddress: string, chain: string, exitReason: CopyExitReason): void {
  const db = getDb();
  const id = `${normalizeAddr(walletAddress)}_${normalizeAddr(tokenAddress)}_${chain}`;

  db.prepare("UPDATE insider_copy_trades SET status = 'closed', close_timestamp = ?, exit_reason = ? WHERE id = ?").run(Date.now(), exitReason, id);
}

export function updateCopyTradePairAddress(walletAddress: string, tokenAddress: string, chain: string, pairAddress: string): void {
  const db = getDb();
  const id = `${normalizeAddr(walletAddress)}_${normalizeAddr(tokenAddress)}_${chain}`;
  db.prepare("UPDATE insider_copy_trades SET pair_address = ? WHERE id = ? AND pair_address IS NULL").run(pairAddress, id);
}

export function cleanupOldClosedCopyTrades(): number {
  const db = getDb();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const result = db.prepare(
    "DELETE FROM insider_copy_trades WHERE status = 'closed' AND close_timestamp < ?"
  ).run(cutoff);
  return result.changes;
}

export function getClosedCopyTrades(): CopyTrade[] {
  const db = getDb();

  const rows = db.prepare("SELECT * FROM insider_copy_trades WHERE status = 'closed' ORDER BY close_timestamp DESC").all() as Record<string, unknown>[];
  return rows.map(mapRowToCopyTrade);
}

export function getOpenCopyTradeByToken(tokenAddress: string, chain: string): CopyTrade | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM insider_copy_trades WHERE token_address = ? AND chain = ? AND status = 'open' LIMIT 1"
  ).get(normalizeAddr(tokenAddress), chain) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRowToCopyTrade(row);
}

export function increaseCopyTradeAmount(id: string, additionalAmount: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE insider_copy_trades SET amount_usd = amount_usd + ?, insider_count = insider_count + 1 WHERE id = ?"
  ).run(additionalAmount, id);
}

export function updateCopyTradePeakPnl(id: string, peakPnlPct: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE insider_copy_trades SET peak_pnl_pct = ? WHERE id = ? AND ? > peak_pnl_pct"
  ).run(peakPnlPct, id, peakPnlPct);
}

export function getAllCopyTrades(): CopyTrade[] {
  const db = getDb();

  const rows = db.prepare("SELECT * FROM insider_copy_trades ORDER BY buy_timestamp DESC").all() as Record<string, unknown>[];
  return rows.map(mapRowToCopyTrade);
}

export function getRugStats(): { count: number; lostUsd: number } {
  const db = getDb();

  // Copy trade rugs: exit_reason = 'liquidity_rug', full amount_usd is the loss
  const copyRow = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(amount_usd), 0) as lost
    FROM insider_copy_trades
    WHERE exit_reason = 'liquidity_rug'
  `).get() as { count: number; lost: number };

  return {
    count: copyRow.count ?? 0,
    lostUsd: copyRow.lost ?? 0,
  };
}
