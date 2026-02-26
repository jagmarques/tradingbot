import { getDb } from "../database/db.js";
import type { CopyTrade, CopyExitReason, GemHit, InsiderWallet, EvmChain } from "./types.js";
import { INSIDER_CONFIG, COPY_TRADE_CONFIG, getPositionSize, KNOWN_DEX_ROUTERS, KNOWN_EXCHANGES } from "./types.js";

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
    CREATE INDEX IF NOT EXISTS idx_insider_gem_hits_symbol_chain ON insider_gem_hits(token_symbol, chain)
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

  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN buy_tokens REAL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN sell_tokens REAL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN status TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN buy_date INTEGER DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN sell_date INTEGER DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN max_pump_multiple REAL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN launch_price_usd REAL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_hits ADD COLUMN is_rugged INTEGER DEFAULT 0"); } catch { /* already exists */ }
  db.prepare("UPDATE insider_gem_hits SET max_pump_multiple = pump_multiple WHERE (max_pump_multiple = 0 OR max_pump_multiple IS NULL) AND pump_multiple > 0").run();

  try { db.exec("ALTER TABLE insider_wallets ADD COLUMN rug_gem_count INTEGER DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_wallets ADD COLUMN rug_rate_pct REAL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_wallets ADD COLUMN rug_penalty_applied INTEGER DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_wallets ADD COLUMN scoring_timestamp INTEGER DEFAULT 0"); } catch { /* already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS insider_gem_analyses (
      id TEXT PRIMARY KEY,
      token_symbol TEXT NOT NULL,
      chain TEXT NOT NULL,
      score INTEGER NOT NULL,
      summary TEXT,
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

  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN buy_price_usd REAL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN current_price_usd REAL DEFAULT 0"); } catch { /* already exists */ }

  db.exec("DELETE FROM insider_gem_paper_trades WHERE buy_price_usd = 0 OR buy_price_usd IS NULL");

  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN tx_hash TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN tokens_received TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN sell_tx_hash TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_gem_paper_trades ADD COLUMN is_live INTEGER DEFAULT 0"); } catch { /* already exists */ }

  const dirtySymbols = db.prepare("SELECT DISTINCT token_symbol FROM insider_gem_hits").all() as Array<{ token_symbol: string }>;
  for (const row of dirtySymbols) {
    const clean = row.token_symbol.replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}|\u200d|\ufe0f|\u{E0067}|\u{E0062}|\u{E007F}|\u{1F3F4}/gu, "").trim();
    if (clean !== row.token_symbol) {
      db.prepare("UPDATE insider_gem_hits SET token_symbol = ? WHERE token_symbol = ?").run(clean, row.token_symbol);
    }
  }

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

  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN insider_count INTEGER NOT NULL DEFAULT 1"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN peak_pnl_pct REAL NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN exit_reason TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN pair_address TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN wallet_score_at_buy REAL NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN exit_detail TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN token_created_at INTEGER DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN tx_hash TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN tokens_received TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN sell_tx_hash TEXT DEFAULT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN is_live INTEGER DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE insider_copy_trades ADD COLUMN hold_price_usd REAL DEFAULT NULL"); } catch { /* already exists */ }

  // Backfill hold_price_usd for existing rows
  db.prepare("UPDATE insider_copy_trades SET hold_price_usd = current_price_usd WHERE hold_price_usd IS NULL AND exit_reason NOT IN ('liquidity_rug', 'honeypot')").run();
  db.prepare("UPDATE insider_copy_trades SET hold_price_usd = 0 WHERE hold_price_usd IS NULL AND exit_reason IN ('liquidity_rug', 'honeypot')").run();

  // Clamp any existing rows with insane pnl_pct values
  db.prepare("UPDATE insider_copy_trades SET pnl_pct = 10000 WHERE pnl_pct > 10000").run();
  db.prepare("UPDATE insider_copy_trades SET pnl_pct = -100 WHERE pnl_pct < -100").run();

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_rug_counts (
      token_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      rug_count INTEGER NOT NULL DEFAULT 0,
      last_rugged_at INTEGER NOT NULL,
      PRIMARY KEY (token_address, chain)
    )
  `);

  // Backfill is_rugged for tokens already in token_rug_counts (table now guaranteed to exist)
  db.prepare(`
    UPDATE insider_gem_hits SET is_rugged = 1
    WHERE is_rugged = 0 AND EXISTS (
      SELECT 1 FROM token_rug_counts trc
      WHERE trc.token_address = insider_gem_hits.token_address AND trc.chain = insider_gem_hits.chain
    )
  `).run();

  const burnAddrs = [
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000003",
  ];
  const burnPlaceholders = burnAddrs.map(() => "?").join(",");
  const burnDeleted = db.prepare(`DELETE FROM insider_wallets WHERE address IN (${burnPlaceholders}) OR address LIKE '0x00000000%'`).run(...burnAddrs);
  if (burnDeleted.changes > 0) {
    console.log(`[InsiderScanner] Cleaned ${burnDeleted.changes} burn/bot addresses from insider_wallets`);
  }

  // Remove burn/router/exchange addresses from gem_hits
  const gemBurnDeleted = db.prepare(
    `DELETE FROM insider_gem_hits WHERE wallet_address IN (${burnPlaceholders}) OR wallet_address LIKE '0x00000000%'`
  ).run(...burnAddrs);
  if (gemBurnDeleted.changes > 0) {
    console.log(`[InsiderScanner] Cleaned ${gemBurnDeleted.changes} burn/bot gem hits from insider_gem_hits`);
  }

  // Remove DEX routers
  const allRouters = Object.values(KNOWN_DEX_ROUTERS).flat().map(a => a.toLowerCase());
  if (allRouters.length > 0) {
    const routerPlaceholders = allRouters.map(() => "?").join(",");
    db.prepare(`DELETE FROM insider_wallets WHERE address IN (${routerPlaceholders})`).run(...allRouters);
    const gemRouterDeleted = db.prepare(
      `DELETE FROM insider_gem_hits WHERE wallet_address IN (${routerPlaceholders})`
    ).run(...allRouters);
    if (gemRouterDeleted.changes > 0) {
      console.log(`[InsiderScanner] Cleaned ${gemRouterDeleted.changes} router gem hits from insider_gem_hits`);
    }
  }

  // Remove known exchanges
  const allExchanges = Object.values(KNOWN_EXCHANGES).flat().map(a => a.toLowerCase());
  if (allExchanges.length > 0) {
    const exchangePlaceholders = allExchanges.map(() => "?").join(",");
    db.prepare(`DELETE FROM insider_wallets WHERE address IN (${exchangePlaceholders})`).run(...allExchanges);
    const gemExchangeDeleted = db.prepare(
      `DELETE FROM insider_gem_hits WHERE wallet_address IN (${exchangePlaceholders})`
    ).run(...allExchanges);
    if (gemExchangeDeleted.changes > 0) {
      console.log(`[InsiderScanner] Cleaned ${gemExchangeDeleted.changes} exchange gem hits from insider_gem_hits`);
    }
  }

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

  // Mark gem hits for audit trail
  db.prepare(
    "UPDATE insider_gem_hits SET is_rugged = 1 WHERE token_address = ? AND chain = ?"
  ).run(ta, chain);
}

export function getRugCount(tokenAddress: string, chain: string): number {
  const db = getDb();
  const ta = normalizeAddr(tokenAddress);

  const row = db.prepare(
    "SELECT rug_count FROM token_rug_counts WHERE token_address = ? AND chain = ?"
  ).get(ta, chain) as { rug_count: number } | undefined;

  return row?.rug_count ?? 0;
}

export function upsertGemHit(hit: GemHit): void {
  const db = getDb();
  const wa = normalizeAddr(hit.walletAddress);
  const ta = normalizeAddr(hit.tokenAddress);
  const id = `${wa}_${ta}_${hit.chain}`;

  db.prepare(`
    INSERT OR IGNORE INTO insider_gem_hits (
      id, wallet_address, chain, token_address, token_symbol,
      buy_tx_hash, buy_timestamp, pump_multiple, max_pump_multiple, launch_price_usd, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'holding')
  `).run(
    id,
    wa,
    hit.chain,
    ta,
    hit.tokenSymbol,
    hit.buyTxHash,
    hit.buyTimestamp,
    hit.pumpMultiple,
    hit.pumpMultiple,
    hit.launchPriceUsd || 0
  );
}

export function upsertInsiderWallet(wallet: InsiderWallet): void {
  const db = getDb();

  db.prepare(`
    INSERT OR REPLACE INTO insider_wallets (
      address, chain, gem_hit_count, gems, score,
      first_seen_at, last_seen_at, updated_at,
      rug_gem_count, rug_rate_pct, rug_penalty_applied, scoring_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)
  `).run(
    normalizeAddr(wallet.address),
    wallet.chain,
    wallet.gemHitCount,
    JSON.stringify(wallet.gems),
    wallet.score,
    wallet.firstSeenAt,
    wallet.lastSeenAt,
    wallet.rugGemCount ?? 0,
    wallet.rugRatePct ?? 0,
    wallet.rugPenaltyApplied ?? 0,
    wallet.scoringTimestamp ?? Date.now()
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

export function getInsiderWalletScore(address: string, chain?: string): number {
  const db = getDb();
  const wa = address.toLowerCase();
  let query = "SELECT score FROM insider_wallets WHERE address = ?";
  const params: unknown[] = [wa];
  if (chain) {
    query += " AND chain = ?";
    params.push(chain);
  }
  query += " ORDER BY score DESC LIMIT 1";
  const row = db.prepare(query).get(...params) as { score: number } | undefined;
  return row?.score ?? 0;
}

export function getPromisingWalletsForHistoryScan(
  minHits: number = 3,
  limit: number = 20
): Array<{ address: string; chain: string; hitCount: number }> {
  const db = getDb();

  const rows = db.prepare(`
    SELECT wallet_address as address, chain, COUNT(*) as hit_count
    FROM insider_gem_hits
    GROUP BY wallet_address, chain
    HAVING COUNT(*) >= ?
    ORDER BY COUNT(*) DESC
    LIMIT ?
  `).all(minHits, limit) as Array<{ address: string; chain: string; hit_count: number }>;

  return rows.map(row => ({ address: row.address, chain: row.chain, hitCount: row.hit_count }));
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
  `).run(buyTokens, sellTokens, status, buyDate, sellDate, normalizeAddr(walletAddress), normalizeAddr(tokenAddress), chain);
}

export function getGemHitsForWallet(address: string, chain: string): GemHit[] {
  const db = getDb();

  const rows = db.prepare(
    "SELECT * FROM insider_gem_hits WHERE wallet_address = ? AND chain = ?"
  ).all(normalizeAddr(address), chain) as Record<string, unknown>[];

  return rows.map((row) => ({
    walletAddress: row.wallet_address as string,
    chain: row.chain as EvmChain,
    tokenAddress: row.token_address as string,
    tokenSymbol: row.token_symbol as string,
    buyTxHash: row.buy_tx_hash as string,
    buyTimestamp: row.buy_timestamp as number,
    pumpMultiple: row.pump_multiple as number,
    maxPumpMultiple: (row.max_pump_multiple as number) || undefined,
    buyTokens: (row.buy_tokens as number) || undefined,
    sellTokens: (row.sell_tokens as number) || undefined,
    status: (row.status as GemHit["status"]) || undefined,
    buyDate: (row.buy_date as number) || undefined,
    sellDate: (row.sell_date as number) || undefined,
    launchPriceUsd: (row.launch_price_usd as number) || undefined,
  }));
}


export function getAllHeldGemHits(chain?: string): GemHit[] {
  const db = getDb();
  let query = `SELECT h.* FROM insider_gem_hits h
    INNER JOIN insider_wallets w ON LOWER(h.wallet_address) = LOWER(w.address) AND h.chain = w.chain
    WHERE (h.status = 'holding' OR h.status = 'unknown' OR h.status IS NULL)`;
  const params: unknown[] = [];
  if (chain) {
    query += " AND h.chain = ?";
    params.push(chain);
  }
  query += " ORDER BY h.pump_multiple DESC";
  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    walletAddress: row.wallet_address as string,
    chain: row.chain as EvmChain,
    tokenAddress: row.token_address as string,
    tokenSymbol: row.token_symbol as string,
    buyTxHash: row.buy_tx_hash as string,
    buyTimestamp: row.buy_timestamp as number,
    pumpMultiple: row.pump_multiple as number,
    maxPumpMultiple: (row.max_pump_multiple as number) || undefined,
    buyTokens: (row.buy_tokens as number) || undefined,
    sellTokens: (row.sell_tokens as number) || undefined,
    status: (row.status as GemHit["status"]) || undefined,
    buyDate: (row.buy_date as number) || undefined,
    sellDate: (row.sell_date as number) || undefined,
    launchPriceUsd: (row.launch_price_usd as number) || undefined,
  }));
}


export function updateGemHitPumpMultiple(tokenAddress: string, chain: string, pumpMultiple: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE insider_gem_hits
     SET pump_multiple = ?,
         max_pump_multiple = MAX(COALESCE(max_pump_multiple, 0), ?)
     WHERE token_address = ? AND chain = ?`
  ).run(pumpMultiple, pumpMultiple, normalizeAddr(tokenAddress), chain);
}

export function setLaunchPrice(tokenAddress: string, chain: string, launchPriceUsd: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE insider_gem_hits SET launch_price_usd = ? WHERE token_address = ? AND chain = ? AND launch_price_usd = 0"
  ).run(launchPriceUsd, normalizeAddr(tokenAddress), chain);
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
    rugGemCount: (row.rug_gem_count as number) ?? 0,
    rugRatePct: (row.rug_rate_pct as number) ?? 0,
    rugPenaltyApplied: (row.rug_penalty_applied as number) ?? 0,
    scoringTimestamp: (row.scoring_timestamp as number) ?? 0,
  };
}

export interface GemAnalysis {
  tokenSymbol: string;
  chain: string;
  score: number;
  analyzedAt: number;
}

export function getCachedGemAnalysis(symbol: string, chain: string, skipTtl = false): GemAnalysis | null {
  const db = getDb();
  const id = `${symbol.toLowerCase()}_${chain}`;
  const CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

  const row = db.prepare("SELECT * FROM insider_gem_analyses WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const analyzedAt = row.analyzed_at as number;
  if (!skipTtl && Date.now() - analyzedAt > CACHE_TTL_MS) return null;

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
    VALUES (?, ?, ?, ?, '', ?)
  `).run(id, analysis.tokenSymbol, analysis.chain, analysis.score, analysis.analyzedAt);
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
    INSERT OR REPLACE INTO insider_gem_paper_trades (
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
  const feePct = COPY_TRADE_CONFIG.ESTIMATED_FEE_PCT;

  db.prepare(`
    UPDATE insider_gem_paper_trades
    SET current_price_usd = ?,
        current_pump_multiple = CASE
          WHEN buy_price_usd > 0 AND ? > 0 THEN (? / buy_price_usd)
          ELSE current_pump_multiple
        END,
        pnl_pct = CASE
          WHEN buy_price_usd > 0 AND ? > 0 THEN MAX(((? / buy_price_usd - 1) * 100 - ?), -100)
          ELSE 0
        END
    WHERE id = ?
  `).run(currentPriceUsd, currentPriceUsd, currentPriceUsd, currentPriceUsd, currentPriceUsd, feePct, id);
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
    "SELECT token_address FROM insider_gem_hits WHERE LOWER(token_symbol) = LOWER(?) AND chain = ? LIMIT 1"
  ).get(symbol, chain) as { token_address: string } | undefined;
  return row?.token_address ?? null;
}

export function getInsiderStatsForToken(tokenAddress: string, chain: string): { insiderCount: number; avgInsiderQuality: number; holdRate: number } {
  const db = getDb();
  const ta = normalizeAddr(tokenAddress);

  const statsRow = db.prepare(`
    SELECT COUNT(DISTINCT h.wallet_address) as insider_count,
           COALESCE(AVG(w.gem_hit_count), 0) as avg_quality
    FROM insider_gem_hits h
    JOIN insider_wallets w ON h.wallet_address = w.address AND h.chain = w.chain
    WHERE h.token_address = ? AND h.chain = ?
      AND w.gem_hit_count >= ?
  `).get(ta, chain, INSIDER_CONFIG.QUALITY_GEM_HITS) as { insider_count: number; avg_quality: number } | undefined;

  const insiderCount = statsRow?.insider_count ?? 0;
  const avgInsiderQuality = statsRow?.avg_quality ?? 0;

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

export function deleteInsiderWalletsBelow(minScore: number, minGemHits: number): number {
  const db = getDb();
  const byScore = db.prepare("DELETE FROM insider_wallets WHERE score <= ?").run(minScore);
  const byGems = db.prepare("DELETE FROM insider_wallets WHERE gem_hit_count < ?").run(minGemHits);
  return byScore.changes + byGems.changes;
}

export interface InsiderWalletStats {
  address: string;
  chain: EvmChain;
  score: number;
  gemHitCount: number;
  avgGainPct: number;
  avgPnlUsd: number;
}

export function getInsiderWalletsWithStats(chain?: EvmChain): InsiderWalletStats[] {
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
    chain: r.chain as EvmChain,
    score: r.score,
    gemHitCount: r.gem_hit_count,
    avgGainPct: r.avg_pump > 0 ? (r.avg_pump - 1) * 100 : 0,
    avgPnlUsd: r.avg_pump > 0 ? (r.avg_pump - 1) * getPositionSize(r.score) : 0,
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
    tokenCreatedAt: (row.token_created_at as number | null) ?? null,
    closeTimestamp: (row.close_timestamp as number) || null,
    exitReason: (row.exit_reason as CopyTrade["exitReason"]) || null,
    insiderCount: (row.insider_count as number) || 1,
    peakPnlPct: (row.peak_pnl_pct as number) || 0,
    walletScoreAtBuy: (row.wallet_score_at_buy as number) || 0,
    exitDetail: (row.exit_detail as string) || null,
    txHash: (row.tx_hash as string) || null,
    tokensReceived: (row.tokens_received as string) || null,
    sellTxHash: (row.sell_tx_hash as string) || null,
    isLive: (row.is_live as number) === 1,
    holdPriceUsd: (row.hold_price_usd as number) ?? null,
  };
}

export function insertCopyTrade(trade: Omit<CopyTrade, "id">): void {
  const db = getDb();
  const wa = normalizeAddr(trade.walletAddress);
  const ta = normalizeAddr(trade.tokenAddress);
  // Timestamp in ID allows re-entry
  const id = `${wa}_${ta}_${trade.chain}_${trade.buyTimestamp}`;

  db.prepare(`
    INSERT OR IGNORE INTO insider_copy_trades (
      id, wallet_address, token_symbol, token_address, chain, side,
      buy_price_usd, current_price_usd, amount_usd, pnl_pct, status,
      liquidity_ok, liquidity_usd, skip_reason, buy_timestamp, close_timestamp,
      exit_reason, insider_count, peak_pnl_pct, pair_address, wallet_score_at_buy,
      token_created_at, tx_hash, tokens_received, sell_tx_hash, is_live
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    trade.pairAddress ?? null,
    trade.walletScoreAtBuy ?? 0,
    trade.tokenCreatedAt ?? null,
    trade.txHash ?? null,
    trade.tokensReceived ?? null,
    trade.sellTxHash ?? null,
    trade.isLive ? 1 : 0
  );
}

export function getCopyTrade(walletAddress: string, tokenAddress: string, chain: string): CopyTrade | null {
  const db = getDb();
  const wa = normalizeAddr(walletAddress);
  const ta = normalizeAddr(tokenAddress);

  // Only returns open records - closed/skipped records must not block re-entry
  const row = db.prepare(
    "SELECT * FROM insider_copy_trades WHERE wallet_address = ? AND token_address = ? AND chain = ? AND status = 'open' LIMIT 1"
  ).get(wa, ta, chain) as Record<string, unknown> | undefined;
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
  const wa = normalizeAddr(walletAddress);
  const ta = normalizeAddr(tokenAddress);
  const feePct = COPY_TRADE_CONFIG.ESTIMATED_FEE_PCT;

  db.prepare(`
    UPDATE insider_copy_trades
    SET current_price_usd = ?,
        pnl_pct = CASE
          WHEN buy_price_usd > 0 AND ? > 0 THEN MIN(MAX(((? / buy_price_usd - 1) * 100 - ?), -100), 10000)
          ELSE 0
        END
    WHERE wallet_address = ? AND token_address = ? AND chain = ? AND status = 'open'
  `).run(currentPriceUsd, currentPriceUsd, currentPriceUsd, feePct, wa, ta, chain);
}


export function closeCopyTrade(
  walletAddress: string,
  tokenAddress: string,
  chain: string,
  exitReason: CopyExitReason,
  finalPriceUsd: number,
  pnlPct: number,
  exitDetail?: string,
  sellTxHash?: string,
): boolean {
  const db = getDb();
  const wa = normalizeAddr(walletAddress);
  const ta = normalizeAddr(tokenAddress);
  const clampedPnl = Math.min(10000, Math.max(-100, pnlPct));

  const result = db.prepare(
    "UPDATE insider_copy_trades SET status = 'closed', close_timestamp = ?, exit_reason = ?, exit_detail = ?, current_price_usd = ?, pnl_pct = ?, sell_tx_hash = ? WHERE wallet_address = ? AND token_address = ? AND chain = ? AND status = 'open'",
  ).run(Date.now(), exitReason, exitDetail ?? null, finalPriceUsd, clampedPnl, sellTxHash ?? null, wa, ta, chain);
  if (exitReason === 'liquidity_rug' || exitReason === 'honeypot') {
    db.prepare(
      "UPDATE insider_copy_trades SET hold_price_usd = 0 WHERE token_address = ? AND chain = ? AND exit_reason IN ('liquidity_rug', 'honeypot')"
    ).run(ta, chain);
  }
  return result.changes > 0;
}

export function updateCopyTradePairAddress(walletAddress: string, tokenAddress: string, chain: string, pairAddress: string): void {
  const db = getDb();
  const wa = normalizeAddr(walletAddress);
  const ta = normalizeAddr(tokenAddress);
  db.prepare(
    "UPDATE insider_copy_trades SET pair_address = ? WHERE wallet_address = ? AND token_address = ? AND chain = ? AND status = 'open' AND pair_address IS NULL"
  ).run(pairAddress, wa, ta, chain);
}

export function updateCopyTradeTokenCreatedAt(tokenAddress: string, chain: string, tokenCreatedAt: number): void {
  const db = getDb();
  const ta = normalizeAddr(tokenAddress);
  db.prepare(
    "UPDATE insider_copy_trades SET token_created_at = ? WHERE token_address = ? AND chain = ? AND token_created_at IS NULL"
  ).run(tokenCreatedAt, ta, chain);
}

export interface WalletCopyTradeStats {
  totalTrades: number;
  wins: number;
  grossProfit: number;
  grossLoss: number;
  consecutiveLosses: number;
}

export function getWalletCopyTradeStats(walletAddress: string): WalletCopyTradeStats {
  const db = getDb();
  const wa = normalizeAddr(walletAddress);

  const rows = db.prepare(
    "SELECT pnl_pct FROM insider_copy_trades WHERE wallet_address = ? AND status = 'closed' AND liquidity_ok = 1 AND skip_reason IS NULL ORDER BY close_timestamp DESC"
  ).all(wa) as Array<{ pnl_pct: number }>;

  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let consecutiveLosses = 0;
  let countingLosses = true;

  for (const row of rows) {
    if (row.pnl_pct > 0) {
      wins++;
      grossProfit += row.pnl_pct;
      countingLosses = false;
    } else if (row.pnl_pct < 0) {
      grossLoss += Math.abs(row.pnl_pct);
      if (countingLosses) consecutiveLosses++;
    } else {
      // pnl_pct === 0 (breakeven): not a win or loss, stops loss streak
      countingLosses = false;
    }
  }

  return {
    totalTrades: rows.length,
    wins,
    grossProfit,
    grossLoss,
    consecutiveLosses,
  };
}

export function getAllWalletCopyTradeStats(): Map<string, WalletCopyTradeStats> {
  const db = getDb();
  const recentCutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;

  const groupRows = db.prepare(`
    SELECT wallet_address,
           COUNT(*) as total_trades,
           SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl_pct > 0 THEN pnl_pct ELSE 0 END) as gross_profit,
           SUM(CASE WHEN pnl_pct < 0 THEN ABS(pnl_pct) ELSE 0 END) as gross_loss
    FROM insider_copy_trades
    WHERE status = 'closed' AND liquidity_ok = 1 AND skip_reason IS NULL
      AND close_timestamp > ?
    GROUP BY wallet_address
  `).all(recentCutoff) as Array<{
    wallet_address: string;
    total_trades: number;
    wins: number;
    gross_profit: number;
    gross_loss: number;
  }>;

  const orderRows = db.prepare(`
    SELECT wallet_address, pnl_pct
    FROM insider_copy_trades
    WHERE status = 'closed' AND liquidity_ok = 1 AND skip_reason IS NULL
      AND close_timestamp > ?
    ORDER BY wallet_address, close_timestamp DESC
  `).all(recentCutoff) as Array<{ wallet_address: string; pnl_pct: number }>;

  const consecutiveMap = new Map<string, number>();
  let currentWallet = "";
  let counting = true;
  let count = 0;
  for (const row of orderRows) {
    if (row.wallet_address !== currentWallet) {
      if (currentWallet) consecutiveMap.set(currentWallet, count);
      currentWallet = row.wallet_address;
      counting = true;
      count = 0;
    }
    if (counting) {
      if (row.pnl_pct < 0) {
        count++;
      } else {
        counting = false;
      }
    }
  }
  if (currentWallet) consecutiveMap.set(currentWallet, count);

  const result = new Map<string, WalletCopyTradeStats>();
  for (const row of groupRows) {
    result.set(row.wallet_address, {
      totalTrades: row.total_trades,
      wins: row.wins,
      grossProfit: row.gross_profit,
      grossLoss: row.gross_loss,
      consecutiveLosses: consecutiveMap.get(row.wallet_address) ?? 0,
    });
  }
  return result;
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

export function increaseCopyTradeAmount(id: string, additionalAmount: number, newBuyPriceUsd?: number): void {
  const db = getDb();
  if (newBuyPriceUsd !== undefined && newBuyPriceUsd > 0) {
    // Weighted average entry
    db.prepare(`
      UPDATE insider_copy_trades SET
        buy_price_usd = (amount_usd * buy_price_usd + ? * ?) / (amount_usd + ?),
        amount_usd = amount_usd + ?,
        insider_count = insider_count + 1
      WHERE id = ?
    `).run(additionalAmount, newBuyPriceUsd, additionalAmount, additionalAmount, id);
  } else {
    db.prepare(
      "UPDATE insider_copy_trades SET amount_usd = amount_usd + ?, insider_count = insider_count + 1 WHERE id = ?"
    ).run(additionalAmount, id);
  }
}

export function updateCopyTradePeakPnl(id: string, peakPnlPct: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE insider_copy_trades SET peak_pnl_pct = ? WHERE id = ? AND ? > peak_pnl_pct"
  ).run(peakPnlPct, id, peakPnlPct);
}

export function getRugStats(): { count: number; pnlUsd: number } {
  const db = getDb();

  const copyRow = db.prepare(`
    SELECT COUNT(*) as count, -COALESCE(SUM(amount_usd), 0) as pnl
    FROM insider_copy_trades
    WHERE exit_reason IN ('liquidity_rug', 'honeypot')
  `).get() as { count: number; pnl: number };

  return {
    count: copyRow.count ?? 0,
    pnlUsd: copyRow.pnl ?? 0,
  };
}

export function updateCopyTradeHoldPrice(tokenAddress: string, chain: string, holdPriceUsd: number): void {
  const db = getDb();
  const ta = normalizeAddr(tokenAddress);
  db.prepare(`
    UPDATE insider_copy_trades
    SET hold_price_usd = ?
    WHERE token_address = ? AND chain = ?
      AND (exit_reason IS NULL OR exit_reason NOT IN ('liquidity_rug', 'honeypot'))
  `).run(holdPriceUsd, ta, chain);
}

export function getHoldableClosedTrades(): CopyTrade[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM insider_copy_trades
    WHERE status = 'closed'
      AND exit_reason NOT IN ('liquidity_rug', 'honeypot', 'stale_price')
    ORDER BY close_timestamp DESC
  `).all() as Record<string, unknown>[];
  return rows.map(mapRowToCopyTrade);
}

export function getHoldComparison(): { holdPnlUsd: number; actualPnlUsd: number } {
  const db = getDb();

  const actualRow = db.prepare(`
    SELECT COALESCE(SUM((pnl_pct / 100.0) * amount_usd), 0) as total
    FROM insider_copy_trades
    WHERE status = 'closed' AND liquidity_ok = 1 AND skip_reason IS NULL
      AND exit_reason NOT IN ('stale_price', 'liquidity_rug', 'honeypot')
  `).get() as { total: number };

  const holdRow = db.prepare(`
    SELECT COALESCE(SUM(
      CASE
        WHEN hold_price_usd IS NOT NULL AND hold_price_usd > 0 AND buy_price_usd > 0
          THEN ((hold_price_usd / buy_price_usd - 1) * 100 - 3) / 100.0 * amount_usd
        WHEN hold_price_usd IS NOT NULL AND hold_price_usd = 0
          THEN -1.0 * amount_usd
        WHEN buy_price_usd > 0 AND current_price_usd > 0
          THEN ((current_price_usd / buy_price_usd - 1) * 100 - 3) / 100.0 * amount_usd
        ELSE 0
      END
    ), 0) as total
    FROM insider_copy_trades
    WHERE status = 'closed' AND liquidity_ok = 1 AND skip_reason IS NULL
      AND exit_reason NOT IN ('stale_price', 'liquidity_rug', 'honeypot')
  `).get() as { total: number };

  return {
    holdPnlUsd: holdRow.total,
    actualPnlUsd: actualRow.total,
  };
}
