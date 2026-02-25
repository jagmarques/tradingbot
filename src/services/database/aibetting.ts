import { getDb } from "./db.js";
import type { AIBettingPosition, AIAnalysis } from "../aibetting/types.js";

// Save AI analysis to database
export function saveAnalysis(analysis: AIAnalysis, marketTitle: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO aibetting_analyses (
      id, market_id, market_title, probability, confidence, reasoning, key_factors, analyzed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `${analysis.marketId}_${analysis.timestamp}`,
    analysis.marketId,
    marketTitle,
    analysis.probability,
    analysis.confidence,
    analysis.reasoning,
    JSON.stringify(analysis.keyFactors),
    new Date(analysis.timestamp).toISOString()
  );
}

// Get recent analyses for a market (for AI context)
export function getMarketAnalysisHistory(marketId: string, limit: number = 5): AIAnalysis[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT market_id, probability, confidence, reasoning, key_factors, analyzed_at
    FROM aibetting_analyses
    WHERE market_id = ?
    ORDER BY analyzed_at DESC
    LIMIT ?
  `).all(marketId, limit) as Array<{
    market_id: string;
    probability: number;
    confidence: number;
    reasoning: string;
    key_factors: string;
    analyzed_at: string;
  }>;

  return rows.map((row) => ({
    marketId: row.market_id,
    probability: row.probability,
    confidence: row.confidence,
    reasoning: row.reasoning,
    keyFactors: JSON.parse(row.key_factors || "[]"),
    timestamp: new Date(row.analyzed_at).getTime(),
  }));
}

// Save AI betting position
export function savePosition(position: AIBettingPosition): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO aibetting_positions (
      id, market_id, market_title, market_end_date, token_id, side, entry_price, size,
      ai_probability, confidence, expected_value, status, entry_timestamp,
      exit_timestamp, exit_price, pnl, exit_reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    position.id,
    position.marketId,
    position.marketTitle,
    position.marketEndDate,
    position.tokenId,
    position.side,
    position.entryPrice,
    position.size,
    position.aiProbability,
    position.confidence,
    position.expectedValue,
    position.status,
    position.entryTimestamp,
    position.exitTimestamp || null,
    position.exitPrice || null,
    position.pnl || null,
    position.exitReason || null
  );
}

// Load open positions on startup
export function loadOpenPositions(): AIBettingPosition[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM aibetting_positions WHERE status = 'open'
  `).all() as Array<{
    id: string;
    market_id: string;
    market_title: string;
    market_end_date: string | null;
    token_id: string;
    side: string;
    entry_price: number;
    size: number;
    ai_probability: number;
    confidence: number;
    expected_value: number;
    status: string;
    entry_timestamp: number;
    exit_timestamp: number | null;
    exit_price: number | null;
    pnl: number | null;
    exit_reason: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    marketId: row.market_id,
    marketTitle: row.market_title,
    marketEndDate: row.market_end_date || "2099-12-31T23:59:59Z",
    tokenId: row.token_id,
    side: row.side as "YES" | "NO",
    entryPrice: row.entry_price,
    size: row.size,
    aiProbability: row.ai_probability,
    confidence: row.confidence,
    expectedValue: row.expected_value,
    status: row.status as "open" | "closed",
    entryTimestamp: row.entry_timestamp,
    exitTimestamp: row.exit_timestamp || undefined,
    exitPrice: row.exit_price || undefined,
    pnl: row.pnl || undefined,
    exitReason: row.exit_reason || undefined,
  }));
}

// Load closed positions (most recent first)
export function loadClosedPositions(limit: number = 10): AIBettingPosition[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM aibetting_positions
    WHERE status = 'closed'
    ORDER BY exit_timestamp DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string;
    market_id: string;
    market_title: string;
    market_end_date: string | null;
    token_id: string;
    side: string;
    entry_price: number;
    size: number;
    ai_probability: number;
    confidence: number;
    expected_value: number;
    status: string;
    entry_timestamp: number;
    exit_timestamp: number | null;
    exit_price: number | null;
    pnl: number | null;
    exit_reason: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    marketId: row.market_id,
    marketTitle: row.market_title,
    marketEndDate: row.market_end_date || "2099-12-31T23:59:59Z",
    tokenId: row.token_id,
    side: row.side as "YES" | "NO",
    entryPrice: row.entry_price,
    size: row.size,
    aiProbability: row.ai_probability,
    confidence: row.confidence,
    expectedValue: row.expected_value,
    status: row.status as "open" | "closed",
    entryTimestamp: row.entry_timestamp,
    exitTimestamp: row.exit_timestamp || undefined,
    exitPrice: row.exit_price || undefined,
    pnl: row.pnl || undefined,
    exitReason: row.exit_reason || undefined,
  }));
}

// Get total realized P&L from all closed positions
export function getClosedPositionsTotalPnl(): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(pnl), 0) as total_pnl
    FROM aibetting_positions
    WHERE status = 'closed' AND pnl IS NOT NULL
  `).get() as { total_pnl: number };
  return row.total_pnl;
}

// Get betting performance stats (for AI learning context)
export function getBettingStats(): {
  totalBets: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalInvested: number;
  avgEdge: number;
  bestCategories: string[];
} {
  const db = getDb();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
      SUM(pnl) as total_pnl,
      SUM(size) as total_invested,
      AVG(expected_value) as avg_ev
    FROM aibetting_positions
    WHERE status = 'closed'
  `).get() as {
    total: number;
    wins: number;
    losses: number;
    total_pnl: number;
    total_invested: number;
    avg_ev: number;
  };

  return {
    totalBets: stats.total || 0,
    wins: stats.wins || 0,
    losses: stats.losses || 0,
    winRate: stats.total > 0 ? (stats.wins / stats.total) * 100 : 0,
    totalPnl: stats.total_pnl || 0,
    totalInvested: stats.total_invested || 0,
    avgEdge: stats.avg_ev || 0,
    bestCategories: [],
  };
}

// Get recent bet outcomes (for AI to learn from)
export function getRecentBetOutcomes(limit: number = 20): Array<{
  marketTitle: string;
  side: string;
  aiProbability: number;
  actualOutcome: "win" | "loss";
  pnl: number;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT market_title, side, ai_probability, pnl
    FROM aibetting_positions
    WHERE status = 'closed' AND pnl IS NOT NULL
    ORDER BY exit_timestamp DESC
    LIMIT ?
  `).all(limit) as Array<{
    market_title: string;
    side: string;
    ai_probability: number;
    pnl: number;
  }>;

  return rows.map((row) => ({
    marketTitle: row.market_title,
    side: row.side,
    aiProbability: row.ai_probability,
    actualOutcome: row.pnl > 0 ? "win" : "loss",
    pnl: row.pnl,
  }));
}

export function deleteAllPositions(): number {
  const db = getDb();
  const result = db.prepare("DELETE FROM aibetting_positions").run();
  console.log(`[Database] Deleted ${result.changes} AI betting positions`);
  return result.changes;
}

export function deleteAllAnalyses(): number {
  const db = getDb();
  const result = db.prepare("DELETE FROM aibetting_analyses").run();
  console.log(`[Database] Deleted ${result.changes} AI betting analyses`);
  return result.changes;
}

// Save calibration prediction when analysis is performed
export function savePrediction(
  marketId: string,
  marketTitle: string,
  tokenId: string,
  side: "YES" | "NO",
  predictedProbability: number,
  confidence: number,
  category: string = "other"
): void {
  const db = getDb();
  const id = `${marketId}_${tokenId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  db.prepare(`
    INSERT INTO calibration_predictions (
      id, market_id, market_title, token_id, side, predicted_probability, confidence, predicted_at, category
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    marketId,
    marketTitle,
    tokenId,
    side,
    predictedProbability,
    confidence,
    new Date().toISOString(),
    category
  );
}

// Calculate Brier score: (prediction - outcome)^2
// outcome is 0 (wrong) or 1 (correct)
function calculateBrierScore(prediction: number, outcome: number): number {
  return Math.pow(prediction - outcome, 2);
}

// Record actual outcome when market resolves
export function recordOutcome(
  marketId: string,
  tokenId: string,
  actualOutcome: 0 | 1
): void {
  const db = getDb();

  // Find the most recent prediction for this market/token
  const prediction = db.prepare(`
    SELECT id, predicted_probability
    FROM calibration_predictions
    WHERE market_id = ? AND token_id = ? AND actual_outcome IS NULL
    ORDER BY predicted_at DESC
    LIMIT 1
  `).get(marketId, tokenId) as { id: string; predicted_probability: number } | undefined;

  if (!prediction) {
    console.log(`[Calibration] No prediction found for ${marketId}/${tokenId}`);
    return;
  }

  const brierScore = calculateBrierScore(prediction.predicted_probability, actualOutcome);

  db.prepare(`
    UPDATE calibration_predictions
    SET actual_outcome = ?, brier_score = ?, resolved_at = ?
    WHERE id = ?
  `).run(actualOutcome, brierScore, new Date().toISOString(), prediction.id);

  console.log(
    `[Calibration] Recorded outcome for ${marketId}: predicted=${(prediction.predicted_probability * 100).toFixed(1)}%, actual=${actualOutcome}, Brier=${brierScore.toFixed(4)}`
  );
}

// Get calibration statistics
export function logCalibrationEntry(
  marketId: string,
  marketTitle: string,
  r1RawProbability: number,
  finalProbability: number,
  marketPriceAtPrediction: number
): void {
  try {
    const db = getDb();
    const id = `cal_${marketId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    db.prepare(`
      INSERT INTO calibration_log (
        id, market_id, market_title, r1_raw_probability, final_probability, market_price_at_prediction, predicted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, marketId, marketTitle, r1RawProbability, finalProbability, marketPriceAtPrediction, new Date().toISOString());
  } catch (error) {
    console.error("[Database] Error logging calibration entry:", error);
  }
}

export function getCalibrationStats(): {
  totalPredictions: number;
  resolvedPredictions: number;
  averageBrierScore: number;
  calibrationByConfidence: Array<{
    confidenceRange: string;
    count: number;
    avgBrier: number;
  }>;
} {
  const db = getDb();

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM calibration_predictions
  `).get() as { count: number };

  const resolved = db.prepare(`
    SELECT COUNT(*) as count, AVG(brier_score) as avg_brier
    FROM calibration_predictions
    WHERE actual_outcome IS NOT NULL
  `).get() as { count: number; avg_brier: number | null };

  // Calibration by confidence buckets
  const byConfidence = db.prepare(`
    SELECT
      CASE
        WHEN confidence < 0.6 THEN '<60%'
        WHEN confidence < 0.7 THEN '60-70%'
        WHEN confidence < 0.8 THEN '70-80%'
        WHEN confidence < 0.9 THEN '80-90%'
        ELSE '90%+'
      END as confidence_range,
      COUNT(*) as count,
      AVG(brier_score) as avg_brier
    FROM calibration_predictions
    WHERE actual_outcome IS NOT NULL
    GROUP BY confidence_range
    ORDER BY confidence_range
  `).all() as Array<{ confidence_range: string; count: number; avg_brier: number }>;

  return {
    totalPredictions: total.count,
    resolvedPredictions: resolved.count,
    averageBrierScore: resolved.avg_brier || 0,
    calibrationByConfidence: byConfidence.map((row) => ({
      confidenceRange: row.confidence_range,
      count: row.count,
      avgBrier: row.avg_brier,
    })),
  };
}
