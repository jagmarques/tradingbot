import { getDb } from "./db.js";
import type { MarketCategory } from "../aibetting/types.js";

export interface CalibrationScore {
  category: string;
  totalPredictions: number;
  avgBrierScore: number;
  trustScore: number;
  lastUpdated: string;
}

let lastNoDataLogAt = 0;

// Update calibration scores for all categories based on 30-day window
export function updateCalibrationScores(
  predictionType: "market" | "token" = "market"
): number {
  const db = getDb();

  try {
    // Calculate 30 days ago timestamp
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffDate = thirtyDaysAgo.toISOString();

    // Get category-level statistics from resolved predictions
    const categoryStats = db
      .prepare(
        `
      SELECT
        category,
        COUNT(*) as total_predictions,
        AVG(brier_score) as avg_brier_score
      FROM calibration_predictions
      WHERE resolved_at IS NOT NULL
        AND resolved_at >= ?
        AND prediction_type = ?
      GROUP BY category
      HAVING COUNT(*) > 0
    `
      )
      .all(cutoffDate, predictionType) as Array<{
      category: string;
      total_predictions: number;
      avg_brier_score: number;
    }>;

    if (categoryStats.length === 0) {
      const now = Date.now();
      if (now - lastNoDataLogAt >= 3600000) {
        console.log("[Calibration] No resolved predictions in 30-day window");
        lastNoDataLogAt = now;
      }
      return 0;
    }

    const now = new Date().toISOString();
    let categoriesUpdated = 0;

    // Update or insert calibration scores for each category
    const upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO calibration_scores (
        category, total_predictions, avg_brier_score, trust_score, last_updated
      ) VALUES (?, ?, ?, ?, ?)
    `);

    for (const stat of categoryStats) {
      // trust_score = 1.0 - avg_brier_score (inverted, clamped to [0, 1])
      const trustScore = Math.max(0, Math.min(1, 1.0 - stat.avg_brier_score));

      upsertStmt.run(
        stat.category,
        stat.total_predictions,
        stat.avg_brier_score,
        trustScore,
        now
      );

      categoriesUpdated++;

      console.log(
        `[Calibration] ${stat.category}: ${stat.total_predictions} predictions, Brier=${stat.avg_brier_score.toFixed(3)}, trust=${trustScore.toFixed(2)}`
      );
    }

    return categoriesUpdated;
  } catch (error) {
    console.error("[Calibration] Error updating scores:", error);
    throw error;
  }
}

// Get trust score for a specific category (0.0-1.0, higher = better)
export function getTrustScore(
  category: MarketCategory,
  predictionType: "market" | "token" = "market"
): number {
  const db = getDb();

  try {
    const result = db
      .prepare(
        `
      SELECT trust_score FROM calibration_scores WHERE category = ?
    `
      )
      .get(category) as { trust_score: number } | undefined;

    if (result) {
      return result.trust_score;
    }

    // Default to neutral 0.5 if no historical data
    console.log(
      `[Calibration] No data for ${category} (${predictionType}), using default trust 0.5`
    );
    return 0.5;
  } catch (error) {
    console.error("[Calibration] Error getting trust score:", error);
    return 0.5;
  }
}

// Get all calibration statistics for debugging/display
export function getCalibrationStats(): CalibrationScore[] {
  const db = getDb();

  try {
    const rows = db
      .prepare(
        `
      SELECT
        category,
        total_predictions,
        avg_brier_score,
        trust_score,
        last_updated
      FROM calibration_scores
      ORDER BY trust_score DESC
    `
      )
      .all() as Array<{
      category: string;
      total_predictions: number;
      avg_brier_score: number;
      trust_score: number;
      last_updated: string;
    }>;

    return rows.map((row) => ({
      category: row.category,
      totalPredictions: row.total_predictions,
      avgBrierScore: row.avg_brier_score,
      trustScore: row.trust_score,
      lastUpdated: row.last_updated,
    }));
  } catch (error) {
    console.error("[Calibration] Error getting stats:", error);
    return [];
  }
}
