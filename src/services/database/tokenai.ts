import { getDb } from "./db.js";

export interface TokenAIPaperStats {
  totalTrades: number;
  openPositions: number;
  closedPositions: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  avgReturnPct: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
  firstTradeTimestamp: number | null;
  daysSinceFirstTrade: number;
  avgHoldTimeHours: number;
}

export function getTokenAIPaperStats(): TokenAIPaperStats {
  const db = getDb();

  const totalRow = db
    .prepare("SELECT COUNT(*) as count FROM tokenai_positions")
    .get() as { count: number };
  const openRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM tokenai_positions WHERE status = 'open'",
    )
    .get() as { count: number };
  const closedRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM tokenai_positions WHERE status = 'closed'",
    )
    .get() as { count: number };

  const winsRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM tokenai_positions WHERE status = 'closed' AND pnl > 0",
    )
    .get() as { count: number };
  const lossesRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM tokenai_positions WHERE status = 'closed' AND pnl <= 0",
    )
    .get() as { count: number };

  const pnlRow = db
    .prepare(
      "SELECT COALESCE(SUM(pnl), 0) as total FROM tokenai_positions WHERE status = 'closed'",
    )
    .get() as { total: number };

  const avgReturnRow = db
    .prepare(
      "SELECT AVG(CASE WHEN size_usd > 0 THEN (pnl / size_usd) * 100 ELSE 0 END) as avg_return FROM tokenai_positions WHERE status = 'closed'",
    )
    .get() as { avg_return: number | null };

  const bestRow = db
    .prepare(
      "SELECT token_symbol, pnl FROM tokenai_positions WHERE status = 'closed' ORDER BY pnl DESC LIMIT 1",
    )
    .get() as { token_symbol: string | null; pnl: number } | undefined;

  const worstRow = db
    .prepare(
      "SELECT token_symbol, pnl FROM tokenai_positions WHERE status = 'closed' ORDER BY pnl ASC LIMIT 1",
    )
    .get() as { token_symbol: string | null; pnl: number } | undefined;

  const firstRow = db
    .prepare("SELECT MIN(entry_timestamp) as first_ts FROM tokenai_positions")
    .get() as { first_ts: number | null };

  const holdRow = db
    .prepare(
      "SELECT AVG(exit_timestamp - entry_timestamp) as avg_hold_ms FROM tokenai_positions WHERE status = 'closed' AND exit_timestamp IS NOT NULL",
    )
    .get() as { avg_hold_ms: number | null };

  const closed = closedRow.count;
  const winRate = closed > 0 ? winsRow.count / closed : 0;
  const daysSinceFirst = firstRow.first_ts
    ? Math.floor((Date.now() - firstRow.first_ts) / (24 * 60 * 60 * 1000))
    : 0;

  return {
    totalTrades: totalRow.count,
    openPositions: openRow.count,
    closedPositions: closed,
    wins: winsRow.count,
    losses: lossesRow.count,
    winRate,
    totalPnlUsd: pnlRow.total,
    avgReturnPct: avgReturnRow.avg_return ?? 0,
    bestTrade: bestRow
      ? { symbol: bestRow.token_symbol || "???", pnl: bestRow.pnl }
      : null,
    worstTrade: worstRow
      ? { symbol: worstRow.token_symbol || "???", pnl: worstRow.pnl }
      : null,
    firstTradeTimestamp: firstRow.first_ts,
    daysSinceFirstTrade: daysSinceFirst,
    avgHoldTimeHours: holdRow.avg_hold_ms
      ? holdRow.avg_hold_ms / (60 * 60 * 1000)
      : 0,
  };
}

export interface TokenAnalysis {
  tokenAddress: string;
  chain: string;
  tokenSymbol?: string;
  probability: number;
  confidence: number;
  reasoning: string;
  keyFactors: string[];
  securityScore?: number;
  analyzedAt: string;
}

export interface TokenSignal {
  tokenAddress: string;
  chain: string;
  signalType: "security" | "onchain" | "social" | "news";
  signalData: Record<string, unknown>;
  collectedAt: string;
}

export interface TokenPosition {
  id: string;
  tokenAddress: string;
  chain: string;
  tokenSymbol?: string;
  side: "long" | "short";
  entryPrice: number;
  currentPrice?: number;
  sizeUsd: number;
  amountTokens: number;
  aiProbability: number;
  confidence: number;
  kellyFraction: number;
  status: "open" | "closed";
  entryTimestamp: number;
  exitTimestamp?: number;
  exitPrice?: number;
  pnl?: number;
  exitReason?: string;
}

// Save AI analysis for a token
export function saveTokenAnalysis(analysis: TokenAnalysis): void {
  const db = getDb();
  const id = `${analysis.tokenAddress}_${analysis.chain}_${Date.now()}`;
  db.prepare(
    `
    INSERT OR REPLACE INTO tokenai_analyses (
      id, token_address, chain, token_symbol, probability, confidence,
      reasoning, key_factors, security_score, analyzed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    analysis.tokenAddress,
    analysis.chain,
    analysis.tokenSymbol || null,
    analysis.probability,
    analysis.confidence,
    analysis.reasoning,
    JSON.stringify(analysis.keyFactors),
    analysis.securityScore ?? null,
    analysis.analyzedAt
  );
}

// Get recent analyses for a token
export function getTokenAnalysisHistory(
  tokenAddress: string,
  chain: string,
  limit: number = 5
): TokenAnalysis[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT token_address, chain, token_symbol, probability, confidence,
           reasoning, key_factors, security_score, analyzed_at
    FROM tokenai_analyses
    WHERE token_address = ? AND chain = ?
    ORDER BY analyzed_at DESC
    LIMIT ?
  `
    )
    .all(tokenAddress, chain, limit) as Array<{
    token_address: string;
    chain: string;
    token_symbol: string | null;
    probability: number;
    confidence: number;
    reasoning: string;
    key_factors: string;
    security_score: number | null;
    analyzed_at: string;
  }>;

  return rows.map((row) => ({
    tokenAddress: row.token_address,
    chain: row.chain,
    tokenSymbol: row.token_symbol || undefined,
    probability: row.probability,
    confidence: row.confidence,
    reasoning: row.reasoning,
    keyFactors: JSON.parse(row.key_factors || "[]"),
    securityScore: row.security_score ?? undefined,
    analyzedAt: row.analyzed_at,
  }));
}

// Save batch of collected signals
export function saveTokenSignals(signals: TokenSignal[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tokenai_signals (
      id, token_address, chain, signal_type, signal_data, collected_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const signal of signals) {
    const id = `${signal.tokenAddress}_${signal.chain}_${signal.signalType}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    stmt.run(
      id,
      signal.tokenAddress,
      signal.chain,
      signal.signalType,
      JSON.stringify(signal.signalData),
      signal.collectedAt
    );
  }
}

// Save or update a token position
export function saveTokenPosition(position: TokenPosition): void {
  const db = getDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO tokenai_positions (
      id, token_address, chain, token_symbol, side, entry_price, current_price,
      size_usd, amount_tokens, ai_probability, confidence, kelly_fraction,
      status, entry_timestamp, exit_timestamp, exit_price, pnl, exit_reason,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `
  ).run(
    position.id,
    position.tokenAddress,
    position.chain,
    position.tokenSymbol || null,
    position.side,
    position.entryPrice,
    position.currentPrice ?? null,
    position.sizeUsd,
    position.amountTokens,
    position.aiProbability,
    position.confidence,
    position.kellyFraction,
    position.status,
    position.entryTimestamp,
    position.exitTimestamp ?? null,
    position.exitPrice ?? null,
    position.pnl ?? null,
    position.exitReason || null
  );
}

// Update specific fields on a token position
export function updateTokenPosition(
  id: string,
  updates: Partial<
    Pick<
      TokenPosition,
      | "currentPrice"
      | "status"
      | "exitTimestamp"
      | "exitPrice"
      | "pnl"
      | "exitReason"
    >
  >
): void {
  const db = getDb();

  const setClauses: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.currentPrice !== undefined) {
    setClauses.push("current_price = ?");
    values.push(updates.currentPrice);
  }
  if (updates.status !== undefined) {
    setClauses.push("status = ?");
    values.push(updates.status);
  }
  if (updates.exitTimestamp !== undefined) {
    setClauses.push("exit_timestamp = ?");
    values.push(updates.exitTimestamp);
  }
  if (updates.exitPrice !== undefined) {
    setClauses.push("exit_price = ?");
    values.push(updates.exitPrice);
  }
  if (updates.pnl !== undefined) {
    setClauses.push("pnl = ?");
    values.push(updates.pnl);
  }
  if (updates.exitReason !== undefined) {
    setClauses.push("exit_reason = ?");
    values.push(updates.exitReason);
  }

  if (setClauses.length === 0) return;

  setClauses.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  db.prepare(
    `UPDATE tokenai_positions SET ${setClauses.join(", ")} WHERE id = ?`
  ).run(...values);
}

// Load all open token positions
export function loadOpenTokenPositions(): TokenPosition[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM tokenai_positions WHERE status = 'open'`)
    .all() as Array<{
    id: string;
    token_address: string;
    chain: string;
    token_symbol: string | null;
    side: string;
    entry_price: number;
    current_price: number | null;
    size_usd: number;
    amount_tokens: number;
    ai_probability: number;
    confidence: number;
    kelly_fraction: number;
    status: string;
    entry_timestamp: number;
    exit_timestamp: number | null;
    exit_price: number | null;
    pnl: number | null;
    exit_reason: string | null;
  }>;

  return rows.map(mapRowToPosition);
}

// Load closed token positions (most recent first)
export function loadClosedTokenPositions(
  limit: number = 10
): TokenPosition[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT * FROM tokenai_positions
    WHERE status = 'closed'
    ORDER BY exit_timestamp DESC
    LIMIT ?
  `
    )
    .all(limit) as Array<{
    id: string;
    token_address: string;
    chain: string;
    token_symbol: string | null;
    side: string;
    entry_price: number;
    current_price: number | null;
    size_usd: number;
    amount_tokens: number;
    ai_probability: number;
    confidence: number;
    kelly_fraction: number;
    status: string;
    entry_timestamp: number;
    exit_timestamp: number | null;
    exit_price: number | null;
    pnl: number | null;
    exit_reason: string | null;
  }>;

  return rows.map(mapRowToPosition);
}

// Map database row to TokenPosition interface
function mapRowToPosition(row: {
  id: string;
  token_address: string;
  chain: string;
  token_symbol: string | null;
  side: string;
  entry_price: number;
  current_price: number | null;
  size_usd: number;
  amount_tokens: number;
  ai_probability: number;
  confidence: number;
  kelly_fraction: number;
  status: string;
  entry_timestamp: number;
  exit_timestamp: number | null;
  exit_price: number | null;
  pnl: number | null;
  exit_reason: string | null;
}): TokenPosition {
  return {
    id: row.id,
    tokenAddress: row.token_address,
    chain: row.chain,
    tokenSymbol: row.token_symbol || undefined,
    side: row.side as "long" | "short",
    entryPrice: row.entry_price,
    currentPrice: row.current_price ?? undefined,
    sizeUsd: row.size_usd,
    amountTokens: row.amount_tokens,
    aiProbability: row.ai_probability,
    confidence: row.confidence,
    kellyFraction: row.kelly_fraction,
    status: row.status as "open" | "closed",
    entryTimestamp: row.entry_timestamp,
    exitTimestamp: row.exit_timestamp ?? undefined,
    exitPrice: row.exit_price ?? undefined,
    pnl: row.pnl ?? undefined,
    exitReason: row.exit_reason || undefined,
  };
}
