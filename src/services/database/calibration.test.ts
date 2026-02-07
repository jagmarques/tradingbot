import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, closeDb, getDb } from "./db.js";
import {
  updateCalibrationScores,
  getTrustScore,
  getCalibrationStats,
} from "./calibration.js";
import type { MarketCategory } from "../aibetting/types.js";

describe("Calibration Scoring", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  // Helper to insert test predictions
  function insertPrediction(
    category: MarketCategory,
    brierScore: number,
    resolvedAt: string | null = new Date().toISOString()
  ): void {
    const db = getDb();
    const id = `test_${Date.now()}_${Math.random()}`;
    db.prepare(
      `
      INSERT INTO calibration_predictions (
        id, market_id, market_title, token_id, side, predicted_probability,
        confidence, category, brier_score, predicted_at, resolved_at, actual_outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      "market-1",
      "Test Market",
      "token-1",
      "YES",
      0.7,
      0.8,
      category,
      brierScore,
      new Date().toISOString(),
      resolvedAt,
      resolvedAt ? 1 : null
    );
  }

  describe("updateCalibrationScores", () => {
    it("returns 0 when no resolved predictions", () => {
      const result = updateCalibrationScores();
      expect(result).toBe(0);
    });

    it("calculates scores for single category", () => {
      // Insert 3 crypto predictions with Brier scores 0.1, 0.2, 0.3
      insertPrediction("crypto", 0.1);
      insertPrediction("crypto", 0.2);
      insertPrediction("crypto", 0.3);

      const result = updateCalibrationScores();
      expect(result).toBe(1);

      // Verify stored values
      const db = getDb();
      const score = db
        .prepare("SELECT * FROM calibration_scores WHERE category = ?")
        .get("crypto") as {
        total_predictions: number;
        avg_brier_score: number;
        trust_score: number;
      };

      expect(score.total_predictions).toBe(3);
      expect(score.avg_brier_score).toBeCloseTo(0.2, 2);
      expect(score.trust_score).toBeCloseTo(0.8, 2);
    });

    it("handles multiple categories with different performance", () => {
      // Good category: low Brier scores
      insertPrediction("crypto", 0.05);
      insertPrediction("crypto", 0.10);
      insertPrediction("crypto", 0.15);

      // Poor category: high Brier scores
      insertPrediction("sports", 0.70);
      insertPrediction("sports", 0.80);
      insertPrediction("sports", 0.90);

      const result = updateCalibrationScores();
      expect(result).toBe(2);

      const cryptoScore = getTrustScore("crypto");
      const sportsScore = getTrustScore("sports");

      // Crypto should have high trust (avg Brier ~0.1 = trust ~0.9)
      expect(cryptoScore).toBeGreaterThan(0.8);

      // Sports should have low trust (avg Brier ~0.8 = trust ~0.2)
      expect(sportsScore).toBeLessThan(0.3);

      // Crypto should be trusted more than sports
      expect(cryptoScore).toBeGreaterThan(sportsScore);
    });

    it("only considers resolved predictions", () => {
      // Resolved predictions
      insertPrediction("politics", 0.2, new Date().toISOString());
      insertPrediction("politics", 0.3, new Date().toISOString());

      // Unresolved prediction (should be ignored)
      insertPrediction("politics", 0.9, null);

      updateCalibrationScores();

      const db = getDb();
      const score = db
        .prepare("SELECT * FROM calibration_scores WHERE category = ?")
        .get("politics") as { total_predictions: number; avg_brier_score: number };

      // Should only count the 2 resolved predictions
      expect(score.total_predictions).toBe(2);
      expect(score.avg_brier_score).toBeCloseTo(0.25, 2);
    });

    it("only considers predictions within 30-day window", () => {
      const now = new Date();

      // Recent prediction (within 30 days)
      const recent = new Date(now);
      recent.setDate(recent.getDate() - 10);
      insertPrediction("crypto", 0.2, recent.toISOString());

      // Old prediction (outside 30-day window)
      const old = new Date(now);
      old.setDate(old.getDate() - 35);
      insertPrediction("crypto", 0.8, old.toISOString());

      updateCalibrationScores();

      const db = getDb();
      const score = db
        .prepare("SELECT * FROM calibration_scores WHERE category = ?")
        .get("crypto") as { total_predictions: number; avg_brier_score: number };

      // Should only count recent prediction
      expect(score.total_predictions).toBe(1);
      expect(score.avg_brier_score).toBeCloseTo(0.2, 2);
    });

    it("clamps trust score to [0, 1] range", () => {
      // Perfect predictions (Brier = 0.0)
      insertPrediction("politics", 0.0);
      insertPrediction("politics", 0.0);

      updateCalibrationScores();

      const trustScore = getTrustScore("politics");
      expect(trustScore).toBe(1.0);

      // Worst predictions (Brier = 1.0)
      insertPrediction("sports", 1.0);
      insertPrediction("sports", 1.0);

      updateCalibrationScores();

      const worstScore = getTrustScore("sports");
      expect(worstScore).toBe(0.0);
    });
  });

  describe("getTrustScore", () => {
    it("returns stored trust score for known category", () => {
      insertPrediction("politics", 0.3);
      updateCalibrationScores();

      const score = getTrustScore("politics");
      expect(score).toBeCloseTo(0.7, 2);
    });

    it("returns 0.5 default for unknown category", () => {
      const score = getTrustScore("entertainment");
      expect(score).toBe(0.5);
    });

    it("returns 0.5 when database is empty", () => {
      const score = getTrustScore("crypto");
      expect(score).toBe(0.5);
    });
  });

  describe("prediction type filtering", () => {
    // Helper to insert prediction with explicit prediction_type
    function insertTypedPrediction(
      category: MarketCategory,
      brierScore: number,
      predictionType: "market" | "token",
      resolvedAt: string | null = new Date().toISOString()
    ): void {
      const db = getDb();
      const id = `test_${predictionType}_${Date.now()}_${Math.random()}`;
      db.prepare(
        `
        INSERT INTO calibration_predictions (
          id, market_id, market_title, token_id, side, predicted_probability,
          confidence, category, brier_score, predicted_at, resolved_at, actual_outcome, prediction_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        id,
        "market-1",
        "Test Market",
        "token-1",
        "YES",
        0.7,
        0.8,
        category,
        brierScore,
        new Date().toISOString(),
        resolvedAt,
        resolvedAt ? 1 : null,
        predictionType
      );
    }

    it("scores only token predictions when type is token", () => {
      // Insert market predictions with low Brier (good)
      insertTypedPrediction("crypto", 0.1, "market");
      insertTypedPrediction("crypto", 0.1, "market");

      // Insert token predictions with high Brier (bad)
      insertTypedPrediction("crypto", 0.8, "token");
      insertTypedPrediction("crypto", 0.8, "token");

      // Score token predictions only
      const result = updateCalibrationScores("token");
      expect(result).toBe(1);

      const db = getDb();
      const score = db
        .prepare("SELECT * FROM calibration_scores WHERE category = ?")
        .get("crypto") as { avg_brier_score: number; total_predictions: number };

      // Should only count the 2 token predictions (Brier 0.8)
      expect(score.total_predictions).toBe(2);
      expect(score.avg_brier_score).toBeCloseTo(0.8, 2);
    });

    it("scores only market predictions when type is market", () => {
      // Insert market predictions with low Brier (good)
      insertTypedPrediction("crypto", 0.1, "market");
      insertTypedPrediction("crypto", 0.1, "market");

      // Insert token predictions with high Brier (bad)
      insertTypedPrediction("crypto", 0.8, "token");
      insertTypedPrediction("crypto", 0.8, "token");

      // Score market predictions only
      const result = updateCalibrationScores("market");
      expect(result).toBe(1);

      const db = getDb();
      const score = db
        .prepare("SELECT * FROM calibration_scores WHERE category = ?")
        .get("crypto") as { avg_brier_score: number; total_predictions: number };

      // Should only count the 2 market predictions (Brier 0.1)
      expect(score.total_predictions).toBe(2);
      expect(score.avg_brier_score).toBeCloseTo(0.1, 2);
    });
  });

  describe("getCalibrationStats", () => {
    it("returns empty array when no scores", () => {
      const stats = getCalibrationStats();
      expect(stats).toEqual([]);
    });

    it("returns all category scores ordered by trust", () => {
      insertPrediction("crypto", 0.1);
      insertPrediction("politics", 0.5);
      insertPrediction("sports", 0.8);

      updateCalibrationScores();

      const stats = getCalibrationStats();
      expect(stats).toHaveLength(3);

      // Should be ordered by trust score DESC
      expect(stats[0].category).toBe("crypto");
      expect(stats[0].trustScore).toBeCloseTo(0.9, 2);

      expect(stats[1].category).toBe("politics");
      expect(stats[1].trustScore).toBeCloseTo(0.5, 2);

      expect(stats[2].category).toBe("sports");
      expect(stats[2].trustScore).toBeCloseTo(0.2, 2);
    });

    it("includes all required fields", () => {
      insertPrediction("crypto", 0.2);
      insertPrediction("crypto", 0.3);

      updateCalibrationScores();

      const stats = getCalibrationStats();
      expect(stats).toHaveLength(1);

      const cryptoStats = stats[0];
      expect(cryptoStats).toHaveProperty("category");
      expect(cryptoStats).toHaveProperty("totalPredictions");
      expect(cryptoStats).toHaveProperty("avgBrierScore");
      expect(cryptoStats).toHaveProperty("trustScore");
      expect(cryptoStats).toHaveProperty("lastUpdated");

      expect(cryptoStats.totalPredictions).toBe(2);
      expect(cryptoStats.avgBrierScore).toBeCloseTo(0.25, 2);
    });
  });
});
