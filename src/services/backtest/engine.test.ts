import { describe, it, expect, beforeEach } from "vitest";
import {
  BacktestEngine,
  createSMAStrategy,
  generateMockCandles,
  type PriceCandle,
  type StrategyFunction,
} from "./engine.js";

describe("Backtest Engine", () => {
  let engine: BacktestEngine;

  beforeEach(() => {
    engine = new BacktestEngine(1000);
  });

  describe("generateMockCandles", () => {
    it("should generate correct number of candles", () => {
      const candles = generateMockCandles(30);
      expect(candles.length).toBe(30);
    });

    it("should generate valid OHLC data", () => {
      const candles = generateMockCandles(10, 100, 0.01);

      for (const candle of candles) {
        expect(candle.high).toBeGreaterThanOrEqual(candle.open);
        expect(candle.high).toBeGreaterThanOrEqual(candle.close);
        expect(candle.low).toBeLessThanOrEqual(candle.open);
        expect(candle.low).toBeLessThanOrEqual(candle.close);
        expect(candle.volume).toBeGreaterThan(0);
        expect(candle.timestamp).toBeGreaterThan(0);
      }
    });

    it("should respect start price", () => {
      const candles = generateMockCandles(5, 50, 0.001);
      expect(candles[0].open).toBeCloseTo(50, 0);
    });
  });

  describe("BacktestEngine.run", () => {
    it("should run backtest with simple strategy", () => {
      const candles = generateMockCandles(100, 100, 0.02);

      // Simple strategy that always holds
      const holdStrategy: StrategyFunction = () => ({
        action: "HOLD",
        confidence: 50,
        price: 0,
      });

      const result = engine.run(candles, holdStrategy, "pumpfun");

      expect(result.totalTrades).toBe(0);
      expect(result.initialCapital).toBe(1000);
      expect(result.finalCapital).toBe(1000);
    });

    it("should execute trades correctly", () => {
      const candles: PriceCandle[] = [
        { timestamp: 1, open: 100, high: 105, low: 95, close: 102, volume: 1000 },
        { timestamp: 2, open: 102, high: 110, low: 100, close: 108, volume: 1000 },
        { timestamp: 3, open: 108, high: 115, low: 105, close: 110, volume: 1000 },
      ];

      // Buy on first candle, sell on third
      let callCount = 0;
      const testStrategy: StrategyFunction = (candle, position) => {
        callCount++;
        if (callCount === 1) {
          return { action: "BUY", confidence: 90, price: candle.close, amount: 100 };
        }
        if (callCount === 3 && position) {
          return { action: "SELL", confidence: 90, price: candle.close };
        }
        return { action: "HOLD", confidence: 50, price: candle.close };
      };

      const result = engine.run(candles, testStrategy, "pumpfun");

      expect(result.totalTrades).toBe(2); // 1 buy + 1 sell
      expect(result.trades[0].type).toBe("BUY");
      expect(result.trades[1].type).toBe("SELL");
    });

    it("should calculate P&L correctly", () => {
      const candles: PriceCandle[] = [
        { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { timestamp: 2, open: 100, high: 110, low: 95, close: 110, volume: 1000 },
      ];

      // Buy at 100, sell at 110 = 10% gain
      let bought = false;
      const testStrategy: StrategyFunction = (candle, position) => {
        if (!bought && !position) {
          bought = true;
          return { action: "BUY", confidence: 90, price: 100, amount: 100 };
        }
        if (position && candle.close === 110) {
          return { action: "SELL", confidence: 90, price: 110 };
        }
        return { action: "HOLD", confidence: 50, price: candle.close };
      };

      const result = engine.run(candles, testStrategy, "polymarket");

      const sellTrade = result.trades.find((t) => t.type === "SELL");
      expect(sellTrade).toBeDefined();
      expect(sellTrade?.pnl).toBeCloseTo(10, 0); // $10 profit on $100
      expect(sellTrade?.pnlPercentage).toBeCloseTo(10, 0); // 10%
    });

    it("should track equity curve", () => {
      const candles = generateMockCandles(10, 100, 0.01);

      const holdStrategy: StrategyFunction = () => ({
        action: "HOLD",
        confidence: 50,
        price: 0,
      });

      const result = engine.run(candles, holdStrategy, "pumpfun");

      expect(result.equityCurve.length).toBe(10);
      expect(result.equityCurve[0].equity).toBe(1000);
    });

    it("should calculate win rate", () => {
      const candles: PriceCandle[] = [
        { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { timestamp: 2, open: 100, high: 110, low: 95, close: 110, volume: 1000 },
        { timestamp: 3, open: 110, high: 115, low: 105, close: 112, volume: 1000 },
        { timestamp: 4, open: 112, high: 120, low: 110, close: 120, volume: 1000 },
      ];

      let tradeNum = 0;
      const testStrategy: StrategyFunction = (candle, _position) => {
        tradeNum++;
        if (tradeNum === 1) return { action: "BUY", confidence: 90, price: 100, amount: 100 };
        if (tradeNum === 2) return { action: "SELL", confidence: 90, price: 110 }; // Win
        if (tradeNum === 3) return { action: "BUY", confidence: 90, price: 112, amount: 100 };
        if (tradeNum === 4) return { action: "SELL", confidence: 90, price: 120 }; // Win
        return { action: "HOLD", confidence: 50, price: candle.close };
      };

      const result = engine.run(candles, testStrategy, "pumpfun");

      expect(result.winRate).toBe(100); // Both trades were winners
    });
  });

  describe("SMA Strategy", () => {
    it("should create SMA strategy", () => {
      const strategy = createSMAStrategy(5, 20);
      expect(typeof strategy).toBe("function");
    });

    it("should return HOLD when not enough history", () => {
      const strategy = createSMAStrategy(5, 20);
      const candle: PriceCandle = {
        timestamp: 1,
        open: 100,
        high: 105,
        low: 95,
        close: 100,
        volume: 1000,
      };

      const signal = strategy(candle, null, [candle]);
      expect(signal.action).toBe("HOLD");
    });

    it("should run full backtest with SMA strategy", () => {
      const candles = generateMockCandles(100, 100, 0.03);
      const strategy = createSMAStrategy(5, 20);

      const result = engine.run(candles, strategy, "polymarket");

      expect(result.startDate).toBeDefined();
      expect(result.endDate).toBeDefined();
      expect(typeof result.sharpeRatio).toBe("number");
    });
  });

  describe("engine.reset", () => {
    it("should reset engine state", () => {
      const candles = generateMockCandles(10);
      const buyStrategy: StrategyFunction = (candle, position) => {
        if (!position) return { action: "BUY", confidence: 90, price: candle.close, amount: 100 };
        return { action: "HOLD", confidence: 50, price: candle.close };
      };

      engine.run(candles, buyStrategy, "pumpfun");

      // Reset
      engine.reset();

      // Run again - should start fresh
      const holdStrategy: StrategyFunction = () => ({
        action: "HOLD",
        confidence: 50,
        price: 0,
      });

      const result = engine.run(candles, holdStrategy, "pumpfun");
      expect(result.totalTrades).toBe(0);
      expect(result.finalCapital).toBe(1000);
    });
  });
});
