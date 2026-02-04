import { getDb } from "../database/db.js";
import {
  Trader,
  TraderTrade,
  TraderAlert,
  WalletTransfer,
  WalletCluster,
  TokenTrade,
  Chain,
  TRANSFER_THRESHOLDS,
} from "./types.js";

// Initialize trader tables
export function initTraderTables(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_wallets (
      address TEXT NOT NULL,
      chain TEXT NOT NULL,
      score REAL NOT NULL,
      win_rate REAL NOT NULL,
      profit_factor REAL NOT NULL,
      consistency REAL NOT NULL,
      total_trades INTEGER NOT NULL,
      winning_trades INTEGER NOT NULL,
      losing_trades INTEGER NOT NULL,
      total_pnl_usd REAL NOT NULL,
      avg_hold_time_ms INTEGER NOT NULL,
      largest_win_pct REAL NOT NULL,
      discovered_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (address, chain)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_trades (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      type TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      price REAL NOT NULL,
      pnl_usd REAL,
      pnl_pct REAL,
      tx_hash TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_trader_trades_wallet ON trader_trades(wallet_address, chain)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_trader_trades_timestamp ON trader_trades(timestamp)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_alerts (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      wallet_score REAL NOT NULL,
      wallet_win_rate REAL NOT NULL,
      sent_at INTEGER NOT NULL,
      FOREIGN KEY (trade_id) REFERENCES trader_trades(id)
    )
  `);

  // Wallet transfers - track when traders move funds
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_transfers (
      id TEXT PRIMARY KEY,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      tx_hash TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_wallet_transfers_from ON wallet_transfers(from_address, chain)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_wallet_transfers_to ON wallet_transfers(to_address, chain)
  `);

  // Wallet clusters - group related wallets
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_clusters (
      id TEXT PRIMARY KEY,
      primary_wallet TEXT NOT NULL,
      chain TEXT NOT NULL,
      total_transferred REAL NOT NULL DEFAULT 0,
      discovered_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_members (
      cluster_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (cluster_id, wallet_address),
      FOREIGN KEY (cluster_id) REFERENCES wallet_clusters(id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cluster_members_wallet ON cluster_members(wallet_address, chain)
  `);

  // Token trades - detailed trade history per token
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_token_trades (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      buy_amount_usd REAL NOT NULL,
      sell_amount_usd REAL NOT NULL,
      pnl_usd REAL NOT NULL,
      pnl_pct REAL NOT NULL,
      first_buy_timestamp INTEGER NOT NULL,
      last_sell_timestamp INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_trades_wallet ON trader_token_trades(wallet_address, chain)
  `);

  console.log("[Traders] Database tables initialized");
}

// Insert or update trader wallet
export function upsertTrader(trader: Trader): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO trader_wallets (
      address, chain, score, win_rate, profit_factor, consistency,
      total_trades, winning_trades, losing_trades, total_pnl_usd,
      avg_hold_time_ms, largest_win_pct, discovered_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address, chain) DO UPDATE SET
      score = excluded.score,
      win_rate = excluded.win_rate,
      profit_factor = excluded.profit_factor,
      consistency = excluded.consistency,
      total_trades = excluded.total_trades,
      winning_trades = excluded.winning_trades,
      losing_trades = excluded.losing_trades,
      total_pnl_usd = excluded.total_pnl_usd,
      avg_hold_time_ms = excluded.avg_hold_time_ms,
      largest_win_pct = excluded.largest_win_pct,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    trader.address.toLowerCase(),
    trader.chain,
    trader.score,
    trader.winRate,
    trader.profitFactor,
    trader.consistency,
    trader.totalTrades,
    trader.winningTrades,
    trader.losingTrades,
    trader.totalPnlUsd,
    trader.avgHoldTimeMs,
    trader.largestWinPct,
    trader.discoveredAt,
    trader.updatedAt
  );
}

// Get trader wallet
export function getTrader(address: string, chain: Chain): Trader | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM trader_wallets WHERE address = ? AND chain = ?");
  const row = stmt.get(address.toLowerCase(), chain) as Record<string, unknown> | undefined;

  if (!row) return null;

  return mapRowToTrader(row);
}

// Get all trader wallets
export function getAllTraders(chain?: Chain): Trader[] {
  const db = getDb();

  let query = "SELECT * FROM trader_wallets";
  const params: unknown[] = [];

  if (chain) {
    query += " WHERE chain = ?";
    params.push(chain);
  }

  query += " ORDER BY score DESC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map(mapRowToTrader);
}

// Get top traders by score
export function getTopTraders(limit: number = 50, chain?: Chain): Trader[] {
  const db = getDb();

  let query = "SELECT * FROM trader_wallets";
  const params: unknown[] = [];

  if (chain) {
    query += " WHERE chain = ?";
    params.push(chain);
  }

  query += " ORDER BY score DESC LIMIT ?";
  params.push(limit);

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map(mapRowToTrader);
}

export type TraderSortBy = "score" | "pnl" | "pnl_pct";

export interface TraderWithPnlPct extends Trader {
  totalInvested: number;
  pnlPct: number;
}

// Get traders with calculated PnL % and flexible sorting
export function getTopTradersSorted(
  limit: number = 50,
  sortBy: TraderSortBy = "score",
  chain?: Chain
): TraderWithPnlPct[] {
  const db = getDb();

  // Get all traders first
  let query = "SELECT * FROM trader_wallets";
  const params: unknown[] = [];

  if (chain) {
    query += " WHERE chain = ?";
    params.push(chain);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Record<string, unknown>[];
  const traders = rows.map(mapRowToTrader);

  // Calculate PnL % for each trader from their token trades
  const tradersWithPct: TraderWithPnlPct[] = traders.map((trader) => {
    const tokenTrades = db
      .prepare("SELECT SUM(buy_amount_usd) as total_invested FROM trader_token_trades WHERE wallet_address = ? AND chain = ?")
      .get(trader.address.toLowerCase(), trader.chain) as { total_invested: number | null } | undefined;

    const totalInvested = tokenTrades?.total_invested || 0;
    const pnlPct = totalInvested > 0 ? (trader.totalPnlUsd / totalInvested) * 100 : 0;

    return {
      ...trader,
      totalInvested,
      pnlPct,
    };
  });

  // Sort based on criteria
  if (sortBy === "pnl") {
    tradersWithPct.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
  } else if (sortBy === "pnl_pct") {
    tradersWithPct.sort((a, b) => b.pnlPct - a.pnlPct);
  } else {
    tradersWithPct.sort((a, b) => b.score - a.score);
  }

  return tradersWithPct.slice(0, limit);
}

// Insert trader trade
export function insertTraderTrade(trade: TraderTrade): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO trader_trades (
      id, wallet_address, chain, token_address, token_symbol,
      type, amount_usd, price, pnl_usd, pnl_pct, tx_hash, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    trade.id,
    trade.walletAddress,
    trade.chain,
    trade.tokenAddress,
    trade.tokenSymbol || null,
    trade.type,
    trade.amountUsd,
    trade.price,
    trade.pnlUsd || null,
    trade.pnlPct || null,
    trade.txHash,
    trade.timestamp
  );
}

// Get trader trades
export function getTraderTrades(
  walletAddress: string,
  chain: Chain,
  sinceTimestamp?: number
): TraderTrade[] {
  const db = getDb();

  let query = "SELECT * FROM trader_trades WHERE wallet_address = ? AND chain = ?";
  const params: unknown[] = [walletAddress, chain];

  if (sinceTimestamp) {
    query += " AND timestamp >= ?";
    params.push(sinceTimestamp);
  }

  query += " ORDER BY timestamp DESC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map(mapRowToTraderTrade);
}

// Get recent trader trades across all tracked wallets
export function getRecentTraderTrades(limit: number = 100, chain?: Chain): TraderTrade[] {
  const db = getDb();

  let query = "SELECT * FROM trader_trades";
  const params: unknown[] = [];

  if (chain) {
    query += " WHERE chain = ?";
    params.push(chain);
  }

  query += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map(mapRowToTraderTrade);
}

// Insert alert record
export function insertTraderAlert(alert: TraderAlert): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO trader_alerts (id, wallet_address, trade_id, wallet_score, wallet_win_rate, sent_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    alert.id,
    alert.walletAddress,
    alert.trade.id,
    alert.walletScore,
    alert.walletWinRate,
    alert.sentAt
  );
}

// Check if alert was already sent for this trade
export function alertExists(tradeId: string): boolean {
  const db = getDb();
  const stmt = db.prepare("SELECT 1 FROM trader_alerts WHERE trade_id = ?");
  const row = stmt.get(tradeId);
  return row !== undefined;
}

// Remove trader wallet
export function removeTrader(address: string, chain: Chain): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM trader_wallets WHERE address = ? AND chain = ?");
  stmt.run(address, chain);
}

// Helper: map row to Trader
function mapRowToTrader(row: Record<string, unknown>): Trader {
  return {
    address: row.address as string,
    chain: row.chain as Chain,
    score: row.score as number,
    winRate: row.win_rate as number,
    profitFactor: row.profit_factor as number,
    consistency: row.consistency as number,
    totalTrades: row.total_trades as number,
    winningTrades: row.winning_trades as number,
    losingTrades: row.losing_trades as number,
    totalPnlUsd: row.total_pnl_usd as number,
    avgHoldTimeMs: row.avg_hold_time_ms as number,
    largestWinPct: row.largest_win_pct as number,
    discoveredAt: row.discovered_at as number,
    updatedAt: row.updated_at as number,
  };
}

// Helper: map row to TraderTrade
function mapRowToTraderTrade(row: Record<string, unknown>): TraderTrade {
  return {
    id: row.id as string,
    walletAddress: row.wallet_address as string,
    chain: row.chain as Chain,
    tokenAddress: row.token_address as string,
    tokenSymbol: row.token_symbol as string | undefined,
    type: row.type as "BUY" | "SELL",
    amountUsd: row.amount_usd as number,
    price: row.price as number,
    pnlUsd: row.pnl_usd as number | undefined,
    pnlPct: row.pnl_pct as number | undefined,
    txHash: row.tx_hash as string,
    timestamp: row.timestamp as number,
  };
}

// ===== WALLET TRANSFER TRACKING =====

// Record a wallet transfer
export function insertWalletTransfer(transfer: WalletTransfer): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO wallet_transfers (
      id, from_address, to_address, chain, amount_usd, tx_hash, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    transfer.id,
    transfer.fromAddress,
    transfer.toAddress,
    transfer.chain,
    transfer.amountUsd,
    transfer.txHash,
    transfer.timestamp
  );

  // Check if we should link these wallets
  checkAndLinkWallets(transfer.fromAddress, transfer.toAddress, transfer.chain);
}

// Get transfers from a wallet
export function getTransfersFrom(address: string, chain: Chain): WalletTransfer[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM wallet_transfers WHERE from_address = ? AND chain = ? ORDER BY timestamp DESC"
  );
  const rows = stmt.all(address, chain) as Record<string, unknown>[];
  return rows.map(mapRowToTransfer);
}

// Get transfers to a wallet
export function getTransfersTo(address: string, chain: Chain): WalletTransfer[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM wallet_transfers WHERE to_address = ? AND chain = ? ORDER BY timestamp DESC"
  );
  const rows = stmt.all(address, chain) as Record<string, unknown>[];
  return rows.map(mapRowToTransfer);
}

// Check transfer patterns and link wallets if criteria met
function checkAndLinkWallets(fromAddress: string, toAddress: string, chain: Chain): void {
  const db = getDb();

  // Get recent transfers between these wallets
  const cutoffTime = Date.now() - TRANSFER_THRESHOLDS.MAX_TIME_BETWEEN_TRANSFERS;

  const stmt = db.prepare(`
    SELECT COUNT(*) as count, SUM(amount_usd) as total
    FROM wallet_transfers
    WHERE from_address = ? AND to_address = ? AND chain = ? AND timestamp >= ?
  `);

  const result = stmt.get(fromAddress, toAddress, chain, cutoffTime) as {
    count: number;
    total: number;
  };

  // Check if transfer pattern indicates same owner
  if (
    result.count >= TRANSFER_THRESHOLDS.MIN_TRANSFERS_TO_LINK ||
    result.total >= TRANSFER_THRESHOLDS.MIN_TRANSFER_USD * 5 // One large transfer also qualifies
  ) {
    // Check if fromAddress is a tracked trader
    const trader = getTrader(fromAddress, chain);
    if (trader) {
      linkWalletToCluster(fromAddress, toAddress, chain, result.total);
      console.log(
        `[Traders] Linked wallet ${toAddress.slice(0, 8)}... to trader ${fromAddress.slice(0, 8)}... (${result.count} transfers, $${result.total.toFixed(0)})`
      );
    }
  }
}

// ===== WALLET CLUSTERS =====

// Get or create cluster for a primary wallet
function getOrCreateCluster(primaryWallet: string, chain: Chain): string {
  const db = getDb();

  // Check if wallet is already in a cluster
  const existingStmt = db.prepare(
    "SELECT cluster_id FROM cluster_members WHERE wallet_address = ? AND chain = ?"
  );
  const existing = existingStmt.get(primaryWallet, chain) as { cluster_id: string } | undefined;

  if (existing) {
    return existing.cluster_id;
  }

  // Create new cluster
  const clusterId = `cluster_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  const insertCluster = db.prepare(`
    INSERT INTO wallet_clusters (id, primary_wallet, chain, total_transferred, discovered_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `);
  insertCluster.run(clusterId, primaryWallet, chain, now, now);

  // Add primary wallet as first member
  const insertMember = db.prepare(`
    INSERT INTO cluster_members (cluster_id, wallet_address, chain, added_at)
    VALUES (?, ?, ?, ?)
  `);
  insertMember.run(clusterId, primaryWallet, chain, now);

  return clusterId;
}

// Link a new wallet to an existing trader's cluster
function linkWalletToCluster(
  primaryWallet: string,
  linkedWallet: string,
  chain: Chain,
  transferAmount: number
): void {
  const db = getDb();
  const clusterId = getOrCreateCluster(primaryWallet, chain);

  // Check if already linked
  const checkStmt = db.prepare(
    "SELECT 1 FROM cluster_members WHERE cluster_id = ? AND wallet_address = ?"
  );
  const exists = checkStmt.get(clusterId, linkedWallet);

  if (!exists) {
    // Add to cluster
    const insertMember = db.prepare(`
      INSERT INTO cluster_members (cluster_id, wallet_address, chain, added_at)
      VALUES (?, ?, ?, ?)
    `);
    insertMember.run(clusterId, linkedWallet, chain, Date.now());

    // Also add linked wallet as a tracked trader (inherits primary's trust)
    const primaryTrader = getTrader(primaryWallet, chain);
    if (primaryTrader) {
      // Create trader entry for linked wallet with reduced score (needs to prove itself)
      upsertTrader({
        ...primaryTrader,
        address: linkedWallet,
        score: Math.max(60, primaryTrader.score * 0.8), // 80% of primary's score
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalPnlUsd: 0,
        discoveredAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  // Update cluster total transferred
  const updateStmt = db.prepare(`
    UPDATE wallet_clusters SET total_transferred = total_transferred + ?, updated_at = ?
    WHERE id = ?
  `);
  updateStmt.run(transferAmount, Date.now(), clusterId);
}

// Get all wallets in a cluster
export function getClusterWallets(walletAddress: string, chain: Chain): string[] {
  const db = getDb();

  // Find cluster ID for this wallet
  const findCluster = db.prepare(
    "SELECT cluster_id FROM cluster_members WHERE wallet_address = ? AND chain = ?"
  );
  const result = findCluster.get(walletAddress, chain) as { cluster_id: string } | undefined;

  if (!result) return [walletAddress]; // Not in a cluster, return itself

  // Get all members
  const getMembers = db.prepare(
    "SELECT wallet_address FROM cluster_members WHERE cluster_id = ?"
  );
  const members = getMembers.all(result.cluster_id) as { wallet_address: string }[];

  return members.map((m) => m.wallet_address);
}

// Get cluster info
export function getWalletCluster(walletAddress: string, chain: Chain): WalletCluster | null {
  const db = getDb();

  const findCluster = db.prepare(
    "SELECT cluster_id FROM cluster_members WHERE wallet_address = ? AND chain = ?"
  );
  const memberResult = findCluster.get(walletAddress, chain) as { cluster_id: string } | undefined;

  if (!memberResult) return null;

  const getCluster = db.prepare("SELECT * FROM wallet_clusters WHERE id = ?");
  const cluster = getCluster.get(memberResult.cluster_id) as Record<string, unknown> | undefined;

  if (!cluster) return null;

  const linkedWallets = getClusterWallets(walletAddress, chain);

  return {
    id: cluster.id as string,
    primaryWallet: cluster.primary_wallet as string,
    linkedWallets,
    chain,
    totalTransferred: cluster.total_transferred as number,
    discoveredAt: cluster.discovered_at as number,
    updatedAt: cluster.updated_at as number,
  };
}

// Get all clusters
export function getAllClusters(chain?: Chain): WalletCluster[] {
  const db = getDb();

  let query = "SELECT * FROM wallet_clusters";
  const params: unknown[] = [];

  if (chain) {
    query += " WHERE chain = ?";
    params.push(chain);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map((row) => {
    const linkedWallets = getClusterWallets(row.primary_wallet as string, row.chain as Chain);
    return {
      id: row.id as string,
      primaryWallet: row.primary_wallet as string,
      linkedWallets,
      chain: row.chain as Chain,
      totalTransferred: row.total_transferred as number,
      discoveredAt: row.discovered_at as number,
      updatedAt: row.updated_at as number,
    };
  });
}

// Check if wallet is linked to any tracked trader
export function isLinkedToTrader(address: string, chain: Chain): boolean {
  const cluster = getWalletCluster(address, chain);
  if (!cluster) return false;

  // Check if primary wallet is a trader
  const trader = getTrader(cluster.primaryWallet, chain);
  return trader !== null;
}

// Helper: map row to WalletTransfer
function mapRowToTransfer(row: Record<string, unknown>): WalletTransfer {
  return {
    id: row.id as string,
    fromAddress: row.from_address as string,
    toAddress: row.to_address as string,
    chain: row.chain as Chain,
    amountUsd: row.amount_usd as number,
    txHash: row.tx_hash as string,
    timestamp: row.timestamp as number,
  };
}

// ===== TOKEN TRADE HISTORY =====

// Insert or update token trade
export function upsertTokenTrade(trade: TokenTrade): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO trader_token_trades (
      id, wallet_address, chain, token_address, token_symbol,
      buy_amount_usd, sell_amount_usd, pnl_usd, pnl_pct,
      first_buy_timestamp, last_sell_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    trade.id,
    trade.walletAddress.toLowerCase(),
    trade.chain,
    trade.tokenAddress.toLowerCase(),
    trade.tokenSymbol,
    trade.buyAmountUsd,
    trade.sellAmountUsd,
    trade.pnlUsd,
    trade.pnlPct,
    trade.firstBuyTimestamp,
    trade.lastSellTimestamp
  );
}

// Get token trades for a wallet
export function getTokenTrades(walletAddress: string, chain: Chain): TokenTrade[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT * FROM trader_token_trades
    WHERE wallet_address = ? AND chain = ?
    ORDER BY pnl_usd DESC
  `);

  const rows = stmt.all(walletAddress.toLowerCase(), chain) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    walletAddress: row.wallet_address as string,
    chain: row.chain as Chain,
    tokenAddress: row.token_address as string,
    tokenSymbol: row.token_symbol as string,
    buyAmountUsd: row.buy_amount_usd as number,
    sellAmountUsd: row.sell_amount_usd as number,
    pnlUsd: row.pnl_usd as number,
    pnlPct: row.pnl_pct as number,
    firstBuyTimestamp: row.first_buy_timestamp as number,
    lastSellTimestamp: row.last_sell_timestamp as number,
  }));
}

// Delete token trades for a wallet (for re-analysis)
export function deleteTokenTrades(walletAddress: string, chain: Chain): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM trader_token_trades WHERE wallet_address = ? AND chain = ?");
  stmt.run(walletAddress.toLowerCase(), chain);
}

// Delete stale traders (no update in last N days)
export function deleteStaleTraders(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;

  // Get stale traders first for cleanup
  const staleTraders = db
    .prepare("SELECT address, chain FROM trader_wallets WHERE updated_at < ?")
    .all(cutoff) as { address: string; chain: string }[];

  if (staleTraders.length === 0) return 0;

  // Delete their token trades
  for (const trader of staleTraders) {
    db.prepare("DELETE FROM trader_token_trades WHERE wallet_address = ? AND chain = ?")
      .run(trader.address, trader.chain);
  }

  // Delete the traders
  const result = db
    .prepare("DELETE FROM trader_wallets WHERE updated_at < ?")
    .run(cutoff);

  if (result.changes > 0) {
    console.log(`[Traders] Cleaned ${result.changes} stale traders (no activity in 30 days)`);
  }

  return result.changes;
}

// Delete traders that don't meet quality criteria (negative PnL, low score)
export function deleteInvalidTraders(): number {
  const db = getDb();

  // Get invalid traders (negative PnL)
  const invalidTraders = db
    .prepare("SELECT address, chain, total_pnl_usd, score FROM trader_wallets WHERE total_pnl_usd <= 0")
    .all() as { address: string; chain: string; total_pnl_usd: number; score: number }[];

  if (invalidTraders.length === 0) return 0;

  // Delete their token trades
  for (const trader of invalidTraders) {
    db.prepare("DELETE FROM trader_token_trades WHERE wallet_address = ? AND chain = ?")
      .run(trader.address, trader.chain);
  }

  // Delete the traders
  const result = db
    .prepare("DELETE FROM trader_wallets WHERE total_pnl_usd <= 0")
    .run();

  if (result.changes > 0) {
    console.log(`[Traders] Removed ${result.changes} traders with negative/zero PnL`);
  }

  return result.changes;
}
