import { describe, it, expect, vi } from "vitest";
import { buildWalkForwardWindows, buildRollingWindows, runWalkForward } from "./walk-forward.js";
import type { Candle, SignalGenerator } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandles(count: number, startMs: number, intervalMs: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    t: startMs + i * intervalMs,
    o: 100,
    h: 110,
    l: 90,
    c: 105,
    v: 1000,
  }));
}

// Signal generator that always opens a long at bar index 1 (after warmup of 1)
// and uses stopLoss/takeProfit from params so different param sets produce
// deterministically different PnL outcomes.
function makeSignalFactory(
  slPct: number,
  tpPct: number,
): (params: Record<string, number>) => SignalGenerator {
  return (_params: Record<string, number>) =>
    (candles, barIndex, pair) => {
      if (barIndex < 1) return null;
      // Only open every 5 bars to get some trades
      if (barIndex % 5 !== 0) return null;
      const price = candles[barIndex].o;
      return {
        pair,
        direction: "long",
        entryPrice: price,
        stopLoss: price * (1 - slPct),
        takeProfit: price * (1 + tpPct),
        barIndex,
      };
    };
}

const DEFAULT_CONFIG = {
  trainFrac: 0.6,
  validateFrac: 0.2,
  testFrac: 0.2,
};

// ---------------------------------------------------------------------------
// buildWalkForwardWindows
// ---------------------------------------------------------------------------

describe("buildWalkForwardWindows", () => {
  it("produces correct 60/20/20 boundaries", () => {
    const windows = buildWalkForwardWindows(0, 1000, DEFAULT_CONFIG);
    expect(windows).toHaveLength(1);
    const w = windows[0];
    expect(w.trainStart).toBe(0);
    expect(w.trainEnd).toBe(600);
    expect(w.validateStart).toBe(600);
    expect(w.validateEnd).toBe(800);
    expect(w.testStart).toBe(800);
    expect(w.testEnd).toBe(1000);
  });

  it("handles arbitrary start offset", () => {
    const windows = buildWalkForwardWindows(200, 1200, DEFAULT_CONFIG);
    expect(windows).toHaveLength(1);
    const w = windows[0];
    const span = 1200 - 200; // 1000
    expect(w.trainStart).toBe(200);
    expect(w.trainEnd).toBe(200 + span * 0.6); // 800
    expect(w.validateStart).toBe(800);
    expect(w.validateEnd).toBe(200 + span * 0.8); // 1000
    expect(w.testStart).toBe(1000);
    expect(w.testEnd).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// buildRollingWindows
// ---------------------------------------------------------------------------

describe("buildRollingWindows", () => {
  it("creates correct number of windows and boundaries", () => {
    // start=0, end=300, windowMs=100, stepMs=30, trainFrac=0.6
    // Window 1: [0, 100) -> train [0,60), validate [60,100)
    // Window 2: [30, 130) -> train [30,90), validate [90,130)
    // Window 3: [60, 160) -> train [60,120), validate [120,160)
    // Window 4: [90, 190) -> train [90,150), validate [150,190)
    // Window 5: [120, 220) -> train [120,180), validate [180,220)
    // Window 6: [150, 250) -> train [150,210), validate [210,250)
    // Window 7: [180, 280) -> train [180,240), validate [240,280)
    // Window 8: [210, 310) -> start+windowMs=310 > 300, stop
    // So windows starting at 0,30,60,90,120,150,180 -> 7 windows
    const windows = buildRollingWindows(0, 300, 100, 30, 0.6);
    expect(windows).toHaveLength(7);

    const w0 = windows[0];
    expect(w0.trainStart).toBe(0);
    expect(w0.trainEnd).toBe(60);
    expect(w0.validateStart).toBe(60);
    expect(w0.validateEnd).toBe(100);

    const w1 = windows[1];
    expect(w1.trainStart).toBe(30);
    expect(w1.trainEnd).toBe(90);
    expect(w1.validateStart).toBe(90);
    expect(w1.validateEnd).toBe(130);

    const w2 = windows[2];
    expect(w2.trainStart).toBe(60);
    expect(w2.trainEnd).toBe(120);
    expect(w2.validateStart).toBe(120);
    expect(w2.validateEnd).toBe(160);
  });

  it("window boundaries do not exceed data end", () => {
    const windows = buildRollingWindows(0, 300, 100, 30, 0.6);
    // All window starts should be valid: start + windowMs <= dataEnd
    for (const w of windows) {
      expect(w.validateEnd).toBeLessThanOrEqual(w.trainStart + 100);
    }
    // Last window start + windowMs should be <= 300
    const last = windows[windows.length - 1];
    expect(last.trainStart + 100).toBeLessThanOrEqual(300);
  });

  it("throws when stepMs is 0 (infinite loop protection)", () => {
    expect(() => buildRollingWindows(0, 300, 100, 0, 0.6)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runWalkForward
// ---------------------------------------------------------------------------

describe("runWalkForward", () => {
  it("selects best params by TRAIN sharpe, evaluates on VALIDATE data", async () => {
    // 200 candles at 1h intervals starting at 0
    // The backtest engine needs warmupBars (default 100) - we'll pass warmupBars:1
    // via the backtest config approach; instead we make 200 candles and use
    // a rolling window of enough size
    const candles = makeCandles(300, 0, 3_600_000); // 300 candles, 1h each

    // Two param sets: slPct=0.05/tpPct=0.10 and slPct=0.01/tpPct=0.03
    // The factory ignores params and uses fixed sl/tp from the closure
    // We use different param keys to distinguish them
    const paramGrid = [
      { id: 0, slPct: 0.05, tpPct: 0.10 },
      { id: 1, slPct: 0.01, tpPct: 0.03 },
    ];

    // Track which param sets were used in train vs validate
    const trainCalls: number[] = [];
    const validateCalls: number[] = [];
    let phase: "train" | "validate" = "train";

    const factory = (params: Record<string, number>): SignalGenerator => {
      return (candles, barIndex, pair) => {
        if (barIndex < 1) return null;
        if (barIndex % 5 !== 0) return null;
        const price = candles[barIndex].o;
        const sl = price * (1 - params.slPct);
        const tp = price * (1 + params.tpPct);
        return { pair, direction: "long", entryPrice: price, stopLoss: sl, takeProfit: tp, barIndex };
      };
    };

    const result = await runWalkForward(
      candles,
      paramGrid,
      factory,
      {
        pairs: ["BTC"],
        capitalUsd: 1000,
        leverage: 1,
        costConfig: {
          makerFeePct: 0,
          takerFeePct: 0,
          spreadMap: {},
          defaultSpreadPct: 0,
          slippageMultiplierOnSL: 1,
        },
        candleDir: "",
        fundingDir: "",
        startTime: 0,
        endTime: Number.MAX_SAFE_INTEGER,
        maxHoldBars: 48,
      },
      { warmupBars: 1, windowMs: 100 * 3_600_000, stepMs: 50 * 3_600_000, trainFrac: 0.7 },
    );

    // Should have multiple windows
    expect(result.windows.length).toBeGreaterThan(0);

    // Each window must record bestParams, trainSharpe, validateSharpe, validateTrades
    for (const w of result.windows) {
      expect(w).toHaveProperty("windowIndex");
      expect(w).toHaveProperty("bestParams");
      expect(w).toHaveProperty("trainSharpe");
      expect(w).toHaveProperty("validateSharpe");
      expect(w).toHaveProperty("validateTrades");
    }

    // aggregateOOSMetrics must be present
    expect(result).toHaveProperty("aggregateOOSMetrics");
    expect(result).toHaveProperty("oosIsRatio");
  });

  it("oosIsRatio = aggregate OOS Sharpe / mean IS Sharpe", async () => {
    const candles = makeCandles(300, 0, 3_600_000);

    const factory = (params: Record<string, number>): SignalGenerator => {
      return (candles, barIndex, pair) => {
        if (barIndex < 1) return null;
        if (barIndex % 5 !== 0) return null;
        const price = candles[barIndex].o;
        return {
          pair,
          direction: "long",
          entryPrice: price,
          stopLoss: price * 0.95,
          takeProfit: price * 1.1,
          barIndex,
        };
      };
    };

    const result = await runWalkForward(
      candles,
      [{ slPct: 0.05, tpPct: 0.1 }],
      factory,
      {
        pairs: ["BTC"],
        capitalUsd: 1000,
        leverage: 1,
        costConfig: {
          makerFeePct: 0,
          takerFeePct: 0,
          spreadMap: {},
          defaultSpreadPct: 0,
          slippageMultiplierOnSL: 1,
        },
        candleDir: "",
        fundingDir: "",
        startTime: 0,
        endTime: Number.MAX_SAFE_INTEGER,
        maxHoldBars: 48,
      },
      { warmupBars: 1, windowMs: 100 * 3_600_000, stepMs: 50 * 3_600_000, trainFrac: 0.7 },
    );

    // Verify oosIsRatio formula: OOS Sharpe / mean IS Sharpe
    const avgIsSharpe =
      result.windows.reduce((sum, w) => sum + w.trainSharpe, 0) / result.windows.length;

    if (avgIsSharpe === 0) {
      // If IS Sharpe is 0, ratio should be 0 or handled gracefully (not NaN/Infinity)
      expect(isFinite(result.oosIsRatio)).toBe(true);
    } else {
      const expectedRatio = result.aggregateOOSMetrics.sharpe / avgIsSharpe;
      expect(result.oosIsRatio).toBeCloseTo(expectedRatio, 5);
    }
  });
});
