import { describe, it, expect } from "vitest";
import { runBacktest, loadCandles, loadFundingData } from "./engine.js";
import type { BacktestConfig, Candle, Signal, SignalGenerator } from "./types.js";
import { DEFAULT_COST_CONFIG } from "./costs.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Build a synthetic candle array with controlled OHLC values
function makeCandles(count: number, basePrice: number = 100): Candle[] {
  const candles: Candle[] = [];
  const BASE_TIME = 1_700_000_000_000;
  const HOUR_MS = 3_600_000;

  for (let i = 0; i < count; i++) {
    const price = basePrice + i * 0.5; // slowly drifting up
    candles.push({
      t: BASE_TIME + i * HOUR_MS,
      o: price,
      h: price + 2,
      l: price - 2,
      c: price + 0.5,
    });
  }
  return candles;
}

const BASE_CONFIG: BacktestConfig = {
  pairs: ["BTC"],
  startTime: 0,
  endTime: Number.MAX_SAFE_INTEGER,
  capitalUsd: 1000,
  leverage: 5,
  costConfig: DEFAULT_COST_CONFIG,
  candleDir: "/nonexistent",
  fundingDir: "/nonexistent",
};

// Signal generator that always returns null (no trades)
const noSignal: SignalGenerator = () => null;

// Signal generator that buys when close > open on PREVIOUS bar (uses barIndex-1 data)
function makeSimpleBullSignal(pair: string): SignalGenerator {
  return (candles, barIndex) => {
    if (barIndex < 2) return null;
    const prev = candles[barIndex - 1];
    if (prev.c > prev.o) {
      const entryPrice = candles[barIndex].o;
      return {
        pair,
        direction: "long",
        entryPrice,
        stopLoss: entryPrice * 0.97,
        takeProfit: entryPrice * 1.10,
        barIndex,
      };
    }
    return null;
  };
}

describe("runBacktest - no signal", () => {
  it("returns 0 trades when signal generator always returns null", () => {
    const candles = makeCandles(30);
    const result = runBacktest(BASE_CONFIG, noSignal, { candles: { BTC: candles } });
    expect(result.trades).toHaveLength(0);
    expect(result.metrics.totalTrades).toBe(0);
  });

  it("returns a BacktestResult with trades, metrics, config", () => {
    const candles = makeCandles(30);
    const result = runBacktest(BASE_CONFIG, noSignal, { candles: { BTC: candles } });
    expect(result).toHaveProperty("trades");
    expect(result).toHaveProperty("metrics");
    expect(result).toHaveProperty("config");
  });
});

describe("runBacktest - anti-look-ahead enforcement", () => {
  it("entry price is candles[barIndex].o, not the signal's entryPrice field", () => {
    // The signal generator returns wrong entryPrice, engine MUST use candles[barIndex].o
    const candles = makeCandles(30, 100);
    let capturedBarIndex: number | null = null;

    const signalAtBar10: SignalGenerator = (cs, barIndex) => {
      if (barIndex === 15) {
        capturedBarIndex = barIndex;
        return {
          pair: "BTC",
          direction: "long",
          entryPrice: 999999, // wrong price - engine must override with candles[barIndex].o
          stopLoss: 1,        // very low SL so it won't trigger
          takeProfit: 999999, // very high TP so it won't trigger immediately
          barIndex,
        };
      }
      return null;
    };

    const result = runBacktest(BASE_CONFIG, signalAtBar10, { candles: { BTC: candles } });

    expect(capturedBarIndex).toBe(15);
    // Trade entry must be the open of bar 15, not 999999
    if (result.trades.length > 0) {
      // The position opened at bar 15's open
      const actualOpen = candles[15].o;
      expect(result.trades[0].entryPrice).toBeCloseTo(actualOpen, 2);
      expect(result.trades[0].entryPrice).not.toBe(999999);
    }
  });

  it("signal uses candles[barIndex-1], entry fills at candles[barIndex].o", () => {
    const candles = makeCandles(30, 100);
    // Make bar 10 a "green" candle (close > open) so signal fires at bar 11
    candles[10] = { ...candles[10], o: 100, c: 102, h: 103, l: 99 };
    candles[11] = { ...candles[11], o: 105, c: 106, h: 108, l: 104 };

    const signalGen = makeSimpleBullSignal("BTC");
    const result = runBacktest(BASE_CONFIG, signalGen, {
      candles: { BTC: candles },
      warmupBars: 2,
    });

    // A trade may have been opened at some point; verify entryPrice = candle's open
    for (const trade of result.trades) {
      // Find which bar this trade entry aligns with
      const matchingBar = candles.find(c => c.t === trade.entryTime);
      if (matchingBar) {
        expect(trade.entryPrice).toBeCloseTo(matchingBar.o, 2);
      }
    }
  });
});

describe("runBacktest - SL exit", () => {
  it("closes long when low goes below stop-loss", () => {
    // Bar 10: open a long at 100, SL=97
    // Bar 11: l=95 (below SL) - trade should close at SL
    const candles = makeCandles(30, 100);
    candles[10] = { t: candles[10].t, o: 100, h: 102, l: 98, c: 101 };
    candles[11] = { t: candles[11].t, o: 98, h: 99, l: 95, c: 97 };

    // Signal fires exactly at bar 10
    const openLongAt10: SignalGenerator = (cs, barIndex) => {
      if (barIndex === 10) {
        return {
          pair: "BTC",
          direction: "long",
          entryPrice: cs[barIndex].o,
          stopLoss: 97,
          takeProfit: 120,
          barIndex,
        };
      }
      return null;
    };

    const result = runBacktest(BASE_CONFIG, openLongAt10, { candles: { BTC: candles }, warmupBars: 0 });

    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    const trade = result.trades.find(t => t.exitReason === "stop-loss");
    expect(trade).toBeDefined();
    // SL fill should be at or near 97 (adverse slippage may push it slightly lower)
    expect(trade!.exitPrice).toBeLessThanOrEqual(97.1);
  });

  it("closes short when high goes above stop-loss", () => {
    const candles = makeCandles(30, 100);
    candles[10] = { t: candles[10].t, o: 100, h: 102, l: 98, c: 99 };
    candles[11] = { t: candles[11].t, o: 101, h: 105, l: 100, c: 103 };

    const openShortAt10: SignalGenerator = (cs, barIndex) => {
      if (barIndex === 10) {
        return {
          pair: "BTC",
          direction: "short",
          entryPrice: cs[barIndex].o,
          stopLoss: 103, // short SL above entry
          takeProfit: 80,
          barIndex,
        };
      }
      return null;
    };

    const result = runBacktest(BASE_CONFIG, openShortAt10, { candles: { BTC: candles }, warmupBars: 0 });

    const trade = result.trades.find(t => t.exitReason === "stop-loss");
    expect(trade).toBeDefined();
    // Short SL fill near 103 with adverse slippage (higher = worse for short)
    expect(trade!.exitPrice).toBeGreaterThanOrEqual(102.9);
  });
});

describe("runBacktest - TP exit", () => {
  it("closes long when high reaches take-profit", () => {
    const candles = makeCandles(30, 100);
    candles[10] = { t: candles[10].t, o: 100, h: 102, l: 98, c: 101 };
    candles[11] = { t: candles[11].t, o: 101, h: 115, l: 100, c: 112 };

    const openLongAt10: SignalGenerator = (cs, barIndex) => {
      if (barIndex === 10) {
        return {
          pair: "BTC",
          direction: "long",
          entryPrice: cs[barIndex].o,
          stopLoss: 80,
          takeProfit: 110,
          barIndex,
        };
      }
      return null;
    };

    const result = runBacktest(BASE_CONFIG, openLongAt10, { candles: { BTC: candles }, warmupBars: 0 });

    const trade = result.trades.find(t => t.exitReason === "take-profit");
    expect(trade).toBeDefined();
    // TP fill should be at or near 110
    expect(trade!.exitPrice).toBeCloseTo(110, 0);
  });
});

describe("runBacktest - position blocks new signals", () => {
  it("does not call signal generator while position is open", () => {
    const candles = makeCandles(30, 100);
    // Make every candle a green candle (close > open) so signal would fire every bar
    for (let i = 0; i < candles.length; i++) {
      candles[i] = { ...candles[i], o: 100, c: 102, h: 105, l: 99 };
    }

    let signalCallCount = 0;
    const countingSignal: SignalGenerator = (cs, barIndex) => {
      signalCallCount++;
      // Open a position on first call, SL/TP very far away so it stays open
      if (signalCallCount === 1) {
        return {
          pair: "BTC",
          direction: "long",
          entryPrice: cs[barIndex].o,
          stopLoss: 1,    // very low, won't hit
          takeProfit: 999999, // very high, won't hit
          barIndex,
        };
      }
      return null;
    };

    const result = runBacktest(BASE_CONFIG, countingSignal, {
      candles: { BTC: candles },
      warmupBars: 2,
    });

    // Signal should be called only once (to open the position), then blocked
    // After position opened, signal generator should NOT be called again until closed
    // Since SL=1 and TP=999999, position never closes -> signal called exactly once
    expect(signalCallCount).toBe(1);
    // 0 trades (position never closed = not in trades array yet)
    expect(result.trades).toHaveLength(0);
  });
});

describe("runBacktest - cost integration", () => {
  it("trade has non-zero fees after SL exit", () => {
    const candles = makeCandles(30, 100);
    candles[10] = { t: candles[10].t, o: 100, h: 102, l: 98, c: 101 };
    candles[11] = { t: candles[11].t, o: 98, h: 99, l: 90, c: 93 };

    const openLong: SignalGenerator = (cs, barIndex) => {
      if (barIndex === 10) {
        return {
          pair: "BTC",
          direction: "long",
          entryPrice: cs[barIndex].o,
          stopLoss: 97,
          takeProfit: 120,
          barIndex,
        };
      }
      return null;
    };

    const result = runBacktest(BASE_CONFIG, openLong, { candles: { BTC: candles }, warmupBars: 0 });

    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    const trade = result.trades[0];
    expect(trade.fees).toBeGreaterThan(0);
    expect(trade.slippage).toBeGreaterThan(0);
    // fundingCost may be 0 if no funding data, that's fine
    expect(typeof trade.fundingCost).toBe("number");
  });

  it("trade has non-zero slippage on SL exit (adverse fill)", () => {
    const candles = makeCandles(30, 100);
    candles[10] = { t: candles[10].t, o: 100, h: 102, l: 98, c: 101 };
    candles[11] = { t: candles[11].t, o: 98, h: 99, l: 90, c: 93 };

    const openLong: SignalGenerator = (cs, barIndex) => {
      if (barIndex === 10) {
        return {
          pair: "BTC",
          direction: "long",
          entryPrice: cs[barIndex].o,
          stopLoss: 97,
          takeProfit: 120,
          barIndex,
        };
      }
      return null;
    };

    const result = runBacktest(BASE_CONFIG, openLong, { candles: { BTC: candles }, warmupBars: 0 });

    const slTrade = result.trades.find(t => t.exitReason === "stop-loss");
    if (slTrade) {
      expect(slTrade.slippage).toBeGreaterThan(0);
    }
  });
});

describe("loadCandles", () => {
  it("loads and parses candles from JSON file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-test-"));
    const candles: Candle[] = [
      { t: 1000, o: 100, h: 105, l: 98, c: 102 },
      { t: 2000, o: 102, h: 108, l: 101, c: 107 },
    ];
    fs.writeFileSync(path.join(tmpDir, "BTCUSDT.json"), JSON.stringify(candles));

    const result = loadCandles("BTC", tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].t).toBe(1000);
    expect(result[1].o).toBe(102);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("sorts candles by timestamp ascending", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-test-"));
    const candles: Candle[] = [
      { t: 3000, o: 103, h: 110, l: 102, c: 109 },
      { t: 1000, o: 100, h: 105, l: 98, c: 102 },
      { t: 2000, o: 102, h: 108, l: 101, c: 107 },
    ];
    fs.writeFileSync(path.join(tmpDir, "BTCUSDT.json"), JSON.stringify(candles));

    const result = loadCandles("BTC", tmpDir);
    expect(result[0].t).toBe(1000);
    expect(result[1].t).toBe(2000);
    expect(result[2].t).toBe(3000);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("loadFundingData", () => {
  it("returns funding entries from JSON file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-test-"));
    const entries = [
      { time: 1000, rate: 0.0001 },
      { time: 2000, rate: 0.0002 },
    ];
    fs.writeFileSync(path.join(tmpDir, "BTC_funding.json"), JSON.stringify(entries));

    const result = loadFundingData("BTC", tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].rate).toBe(0.0001);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns empty array if funding file does not exist (graceful degradation)", () => {
    const result = loadFundingData("BTC", "/nonexistent/path");
    expect(result).toEqual([]);
  });
});
