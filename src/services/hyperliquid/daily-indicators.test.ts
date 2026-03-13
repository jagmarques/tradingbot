import { describe, it, expect } from "vitest";
import { ADX } from "technicalindicators";
import { computeDailyAdx, computeDailySma, type DailyCandle } from "./daily-indicators.js";

function makeCandles(closes: number[]): DailyCandle[] {
  return closes.map((close, i) => ({
    timestamp: i * 86400_000,
    close,
    high: close * 1.01,
    low: close * 0.99,
  }));
}

function makeTrendingCandles(n: number): DailyCandle[] {
  const candles: DailyCandle[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + i * 0.5;
    candles.push({
      timestamp: i * 86400_000,
      close,
      high: close + 0.3,
      low: close - 0.3,
    });
  }
  return candles;
}

describe("computeDailyAdx", () => {
  it("returns null when insufficient bars for stabilisation", () => {
    const candles = makeCandles(Array.from({ length: 27 }, (_, i) => 100 + i));
    // period=14 requires idx >= period*2 = 28, so idx 27 (0-indexed) = 28 bars is exactly the boundary
    const result = computeDailyAdx(candles, 26, 14);
    expect(result).toBeNull();
  });

  it("returns a positive number for candles with sufficient history", () => {
    const candles = makeTrendingCandles(60);
    const result = computeDailyAdx(candles, 59, 14);
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(0);
  });

  it("matches the technicalindicators library ADX value", () => {
    const candles = makeTrendingCandles(60);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);

    const libResult = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const libAdx = libResult[libResult.length - 1]?.adx ?? null;

    const ourAdx = computeDailyAdx(candles, candles.length - 1, 14);

    expect(ourAdx).not.toBeNull();
    expect(libAdx).not.toBeNull();
    // Values must be equal (same computation)
    expect(ourAdx).toBeCloseTo(libAdx as number, 4);
  });

  it("gives lower ADX than old formula on sideways market", () => {
    // Flat market: old formula overestimates, library formula gives lower value
    const n = 60;
    const flatCandles: DailyCandle[] = Array.from({ length: n }, (_, i) => ({
      timestamp: i * 86400_000,
      close: 100 + Math.sin(i * 0.3) * 0.5, // oscillating flat
      high: 100 + Math.sin(i * 0.3) * 0.5 + 0.2,
      low: 100 + Math.sin(i * 0.3) * 0.5 - 0.2,
    }));

    const ourAdx = computeDailyAdx(flatCandles, n - 1, 14);

    // Old formula (manual re-implementation to verify it gives higher value)
    function oldComputeDailyAdx(idx: number, period: number): number | null {
      if (idx < period * 2) return null;
      let trSum = 0, plusDmSum = 0, minusDmSum = 0;
      for (let i = idx - period + 1; i <= idx; i++) {
        if (i <= 0) return null;
        const highDiff = flatCandles[i].high - flatCandles[i - 1].high;
        const lowDiff = flatCandles[i - 1].low - flatCandles[i].low;
        const tr = Math.max(
          flatCandles[i].high - flatCandles[i].low,
          Math.abs(flatCandles[i].high - flatCandles[i - 1].close),
          Math.abs(flatCandles[i].low - flatCandles[i - 1].close),
        );
        trSum += tr;
        plusDmSum += highDiff > lowDiff && highDiff > 0 ? highDiff : 0;
        minusDmSum += lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0;
      }
      if (trSum === 0) return null;
      const plusDi = (plusDmSum / trSum) * 100;
      const minusDi = (minusDmSum / trSum) * 100;
      const diSum = plusDi + minusDi;
      if (diSum === 0) return null;
      return (Math.abs(plusDi - minusDi) / diSum) * 100;
    }

    const oldAdx = oldComputeDailyAdx(n - 1, 14);
    expect(ourAdx).not.toBeNull();
    expect(oldAdx).not.toBeNull();
    // The old formula overestimates on flat markets
    // Our proper ADX should be lower or equal
    expect(ourAdx as number).toBeLessThanOrEqual((oldAdx as number) + 0.01);
  });
});

describe("computeDailySma", () => {
  it("returns null when insufficient data", () => {
    const closes = [100, 101, 102];
    expect(computeDailySma(closes, 5, 2)).toBeNull();
  });

  it("computes correct SMA", () => {
    const closes = [10, 20, 30, 40, 50];
    const result = computeDailySma(closes, 3, 4);
    // SMA(3) of last 3 values: (30+40+50)/3 = 40
    expect(result).toBeCloseTo(40, 5);
  });

  it("computes SMA at exact period boundary", () => {
    const closes = [10, 20, 30];
    const result = computeDailySma(closes, 3, 2);
    expect(result).toBeCloseTo(20, 5);
  });
});
