// MTF walk-forward parameter sweep: 81 combos, 8 pairs, 365d data.
// Train: first 1440 4h bars (~240d). Test: remaining ~750 bars (~125d).
// Run: npx tsx scripts/backtest-mtf.ts 2>&1 | tee /tmp/backtest-mtf.txt

import { ATR, ADX, RSI } from "technicalindicators";
import * as fs from "node:fs";

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Params {
  smaPeriod: number;
  adxMin: number;
  rsiHigh: number;   // rsiLow is always 35
  stopAtr: number;
  rewardRisk: number;
}

interface BacktestResult {
  trades: number;
  wins: number;
  totalReturn: number;
  maxDrawdown: number;
  tradePnlPcts: number[];
  days: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RSI_LOW = 35;
const STAG_BARS = 20; // 20 x 4h bars = 80h stagnation exit
const LEV = 10;
const FEE_RATE = 0.0009; // 0.09% round-trip total (entry + exit)
const MARGIN_PER_TRADE = 10; // $10 fixed margin
const NOTIONAL = MARGIN_PER_TRADE * LEV; // $100 notional

const PAIRS = ["BTC", "ETH", "SOL", "DOGE", "AVAX", "LINK", "ARB", "OP"];
const DAYS_4H = 365;
const DAYS_DAILY = 150;
const TRAIN_BARS = 1440; // first 1440 4h bars = train set

// Parameter grid (81 combos)
const SMA_PERIODS = [70, 100, 130];
const ADX_MINS = [14, 18, 22];
const RSI_HIGHS = [48, 52, 58];
const STOP_ATRS = [2.0, 2.5, 3.0];
const REWARD_RISKS = [2.5, 3.0, 3.5];

// ─── Fetch ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCandlesOnce(coin: string, interval: string, days: number): Promise<Candle[]> {
  const endTime = Date.now();
  const startTime = endTime - days * 86400_000;
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${coin} ${interval}`);
  const raw = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
  return raw
    .map((c) => ({
      timestamp: c.t,
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchCandles(coin: string, interval: string, days: number): Promise<Candle[]> {
  try {
    return await fetchCandlesOnce(coin, interval, days);
  } catch (e) {
    await sleep(1000);
    return await fetchCandlesOnce(coin, interval, days);
  }
}

// ─── Daily Indicators ────────────────────────────────────────────────────────

interface DailyPreInd {
  sma: Record<number, (number | null)[]>;
  adx: (number | null)[];
}

function precomputeDaily(candles: Candle[], smaPeriods: number[]): DailyPreInd {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const adxRaw = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxArr: (number | null)[] = new Array(n).fill(null);
  adxRaw.forEach((v, i) => {
    adxArr[n - adxRaw.length + i] = v?.adx ?? null;
  });

  const sma: Record<number, (number | null)[]> = {};
  for (const period of smaPeriods) {
    const arr: (number | null)[] = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      let sum = 0;
      for (let k = i - period + 1; k <= i; k++) sum += closes[k];
      arr[i] = sum / period;
    }
    sma[period] = arr;
  }

  return { sma, adx: adxArr };
}

// ─── 4h Indicators ───────────────────────────────────────────────────────────

interface H4PreInd {
  atr: (number | null)[];
  rsi: (number | null)[];
}

function precompute4h(candles: Candle[]): H4PreInd {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atrArr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => {
    atrArr[n - atrRaw.length + i] = v;
  });

  const rsiRaw = RSI.calculate({ values: closes, period: 14 });
  const rsiArr: (number | null)[] = new Array(n).fill(null);
  rsiRaw.forEach((v, i) => {
    rsiArr[n - rsiRaw.length + i] = v;
  });

  return { atr: atrArr, rsi: rsiArr };
}

// ─── Index map: for each 4h bar, index of last completed daily bar ────────────

function buildDailyIndex(h4: Candle[], daily: Candle[]): number[] {
  const idxDailyAt: number[] = new Array(h4.length).fill(-1);
  let j = 0;
  for (let i = 0; i < h4.length; i++) {
    while (j < daily.length && daily[j].timestamp <= h4[i].timestamp) j++;
    idxDailyAt[i] = j - 1;
  }
  return idxDailyAt;
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

function runBacktest(
  candles4h: Candle[],
  pre4h: H4PreInd,
  dailyCandles: Candle[],
  preDaily: DailyPreInd,
  idxDailyAt: number[],
  p: Params,
  startIdx: number,
  endIdx: number,
): BacktestResult {
  let pnlTotal = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;
  const tradePnlPcts: number[] = [];

  type Pos = {
    dir: "long" | "short";
    entry: number;
    entryIdx: number;
    sl: number;
    tp: number;
  };
  let pos: Pos | null = null;

  for (let i = startIdx; i < endIdx; i++) {
    const c = candles4h[i];

    if (pos !== null) {
      const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
      const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;
      const stagHit = i - pos.entryIdx >= STAG_BARS;

      let exitPrice: number | null = null;
      if (slHit && tpHit) {
        // Both hit same bar: assume SL (conservative)
        exitPrice = pos.sl;
      } else if (slHit) {
        exitPrice = pos.sl;
      } else if (tpHit) {
        exitPrice = pos.tp;
      } else if (stagHit) {
        exitPrice = c.close;
      }

      if (exitPrice !== null) {
        const pricePct = ((exitPrice - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
        const grossPnl = pricePct * NOTIONAL;
        const fees = NOTIONAL * FEE_RATE;
        const net = grossPnl - fees;
        pnlTotal += net;
        peakPnl = Math.max(peakPnl, pnlTotal);
        maxDrawdown = Math.max(maxDrawdown, peakPnl - pnlTotal);
        trades++;
        if (net > 0) wins++;
        tradePnlPcts.push((net / MARGIN_PER_TRADE) * 100);
        pos = null;
      }
    }

    if (pos === null && i + 1 < endIdx) {
      const dIdx = idxDailyAt[i];
      if (dIdx < 0) continue;

      const dailySma = preDaily.sma[p.smaPeriod]?.[dIdx] ?? null;
      const dailyAdx = preDaily.adx[dIdx];
      const dailyClose = dailyCandles[dIdx].close;

      if (dailySma === null || dailyAdx === null) continue;
      if (dailyAdx < p.adxMin) continue;

      const dailyUptrend = dailyClose > dailySma;
      const dailyDowntrend = dailyClose < dailySma;

      const rsi4h = pre4h.rsi[i];
      if (rsi4h === null) continue;

      let dir: "long" | "short" | null = null;

      // Long: daily uptrend + 4h RSI in pullback zone [rsiLow, rsiHigh]
      if (dailyUptrend && rsi4h >= RSI_LOW && rsi4h <= p.rsiHigh) {
        dir = "long";
      }

      // Short: daily downtrend + 4h RSI in mirror zone [100-rsiHigh, 100-rsiLow]
      const shortLow = 100 - p.rsiHigh;
      const shortHigh = 100 - RSI_LOW;
      if (dailyDowntrend && rsi4h >= shortLow && rsi4h <= shortHigh) {
        dir = "short";
      }

      if (dir !== null) {
        const entryPrice = candles4h[i + 1].open;
        const atr = pre4h.atr[i] ?? c.close * 0.02;
        const stopDist = atr * p.stopAtr;
        const sl = dir === "long" ? entryPrice - stopDist : entryPrice + stopDist;
        const tp = dir === "long" ? entryPrice + stopDist * p.rewardRisk : entryPrice - stopDist * p.rewardRisk;
        pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp };
      }
    }
  }

  const startTs = candles4h[startIdx]?.timestamp ?? 0;
  const endTs = candles4h[endIdx - 1]?.timestamp ?? 0;
  return {
    trades,
    wins,
    totalReturn: pnlTotal,
    maxDrawdown,
    tradePnlPcts,
    days: (endTs - startTs) / 86400_000,
  };
}

function sharpe(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(pnls.length);
}

// ─── Build full grid ─────────────────────────────────────────────────────────

function buildGrid(): Params[] {
  const grid: Params[] = [];
  for (const smaPeriod of SMA_PERIODS) {
    for (const adxMin of ADX_MINS) {
      for (const rsiHigh of RSI_HIGHS) {
        for (const stopAtr of STOP_ATRS) {
          for (const rewardRisk of REWARD_RISKS) {
            grid.push({ smaPeriod, adxMin, rsiHigh, stopAtr, rewardRisk });
          }
        }
      }
    }
  }
  return grid;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface ComboResult {
  params: Params;
  testPnl: number;
  testDays: number;
  pctPerDay: number;
  testTrades: number;
  testWins: number;
  winRate: number;
  testSharpe: number;
  maxDrawdown: number;
  lowTrades: boolean;
}

async function main() {
  const grid = buildGrid();
  console.log(`=== backtest-mtf.ts: MTF Walk-Forward Sweep ===`);
  console.log(`Pairs: ${PAIRS.join(", ")}`);
  console.log(`Grid: ${grid.length} combos (smaPeriod x adxMin x rsiHigh x stopAtr x rewardRisk)`);
  console.log(`Walk-forward: train first ${TRAIN_BARS} 4h bars, test remaining`);
  console.log(`Fees: ${(FEE_RATE * 100).toFixed(3)}% round-trip | Leverage: ${LEV}x | Margin: $${MARGIN_PER_TRADE}/trade\n`);

  // ── Fetch all pair data ──────────────────────────────────────────────────────
  console.log("Fetching candle data...");

  type PairData = {
    h4: Candle[];
    pre4h: H4PreInd;
    dailyCandles: Candle[];
    preDaily: DailyPreInd;
    idxDailyAt: number[];
    trainEnd: number;
  };

  const candleMap: Record<string, PairData> = {};
  const allSmaPeriods = [...new Set(SMA_PERIODS)];

  for (let pi = 0; pi < PAIRS.length; pi++) {
    const pair = PAIRS[pi];
    if (pi > 0) await sleep(200);
    try {
      process.stdout.write(`  ${pair} 4h...`);
      const h4 = await fetchCandles(pair, "4h", DAYS_4H);

      process.stdout.write(` ${h4.length}bars. daily...`);
      let dailyCandles: Candle[] | null = null;
      for (const interval of ["1d", "24h"]) {
        try {
          dailyCandles = await fetchCandles(pair, interval, DAYS_DAILY);
          break;
        } catch {
          // try next interval
        }
        await sleep(300);
      }
      if (!dailyCandles || dailyCandles.length === 0) throw new Error("daily fetch failed");

      const pre4h = precompute4h(h4);
      const preDaily = precomputeDaily(dailyCandles, allSmaPeriods);
      const idxDailyAt = buildDailyIndex(h4, dailyCandles);

      // train = first TRAIN_BARS bars (or 240/365 fraction if fewer bars available)
      const trainEnd = Math.min(TRAIN_BARS, Math.floor(h4.length * (240 / 365)));
      candleMap[pair] = { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd };

      const testBars = h4.length - trainEnd;
      const testDays = (h4[h4.length - 1].timestamp - h4[trainEnd].timestamp) / 86400_000;
      console.log(` ${dailyCandles.length}daily. trainEnd=${trainEnd} testBars=${testBars} testDays=${testDays.toFixed(0)}`);
    } catch (e) {
      console.warn(`  ${pair}: SKIP (${(e as Error).message})`);
    }
  }

  const pairs = PAIRS.filter((p) => candleMap[p]);
  if (pairs.length === 0) {
    console.error("No pairs loaded. Exiting.");
    process.exit(1);
  }

  const samp = candleMap[pairs[0]];
  const testDaysRef = (samp.h4[samp.h4.length - 1].timestamp - samp.h4[samp.trainEnd].timestamp) / 86400_000;
  console.log(`\nLoaded ${pairs.length} pairs. Test window: ~${testDaysRef.toFixed(0)} days\n`);

  // ── Sweep all combos ─────────────────────────────────────────────────────────
  console.log(`Running ${grid.length} combos x ${pairs.length} pairs...`);

  const results: ComboResult[] = [];

  for (let ci = 0; ci < grid.length; ci++) {
    const p = grid[ci];
    let testPnl = 0;
    let testTrades = 0;
    let testWins = 0;
    let maxDD = 0;
    let testDays = 0;
    const allPnls: number[] = [];

    for (const pair of pairs) {
      const { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd } = candleMap[pair];
      const r = runBacktest(h4, pre4h, dailyCandles, preDaily, idxDailyAt, p, trainEnd, h4.length);
      testPnl += r.totalReturn;
      testTrades += r.trades;
      testWins += r.wins;
      maxDD = Math.max(maxDD, r.maxDrawdown);
      allPnls.push(...r.tradePnlPcts);
      testDays = Math.max(testDays, r.days);
    }

    const pctPerDay = testDays > 0 ? (testPnl / (MARGIN_PER_TRADE * pairs.length)) / testDays * 100 : 0;
    const winRate = testTrades > 0 ? (testWins / testTrades) * 100 : 0;
    const testSharpe = sharpe(allPnls);
    const maxDDPct = MARGIN_PER_TRADE * pairs.length > 0 ? (maxDD / (MARGIN_PER_TRADE * pairs.length)) * 100 : 0;

    results.push({
      params: p,
      testPnl,
      testDays,
      pctPerDay,
      testTrades,
      testWins,
      winRate,
      testSharpe,
      maxDrawdown: maxDDPct,
      lowTrades: testTrades < 15,
    });

    if ((ci + 1) % 27 === 0) {
      process.stdout.write(`  ${ci + 1}/${grid.length} done\n`);
    }
  }

  // ── Sort: qualified first (>=15 trades), then by pctPerDay desc ──────────────
  results.sort((a, b) => {
    if (a.lowTrades !== b.lowTrades) return a.lowTrades ? 1 : -1;
    return b.pctPerDay - a.pctPerDay;
  });

  // ── Full results table to file ───────────────────────────────────────────────
  const header = `smaPeriod adxMin rsiHigh stopAtr  rr   | test: %/day     trades  winRate  Sharpe   maxDD`;
  const separator = "─".repeat(header.length);
  const fullLines: string[] = [
    `=== backtest-mtf.ts: Full Results (${grid.length} combos, ${pairs.length} pairs) ===`,
    `Test window: ~${testDaysRef.toFixed(0)}d | rsiLow=35 fixed | stagBars=${STAG_BARS} | fees=${(FEE_RATE * 100).toFixed(3)}%RT`,
    "",
    header,
    separator,
  ];

  for (const r of results) {
    const p = r.params;
    const tag = `smaPeriod=${String(p.smaPeriod).padEnd(3)} adxMin=${String(p.adxMin).padEnd(2)} rsiHigh=${String(p.rsiHigh).padEnd(2)} stopAtr=${p.stopAtr.toFixed(1)} rr=${p.rewardRisk.toFixed(1)}`;
    const stats = `${r.pctPerDay >= 0 ? "+" : ""}${r.pctPerDay.toFixed(3)}%/d  ${String(r.testTrades).padStart(4)}T  ${r.winRate.toFixed(0).padStart(3)}%w  Sharpe=${r.testSharpe.toFixed(2)}  DD=${r.maxDrawdown.toFixed(1)}%${r.lowTrades ? "  (low trades)" : ""}`;
    fullLines.push(`${tag} | test: ${stats}`);
  }

  fs.writeFileSync("/tmp/backtest-mtf-full.txt", fullLines.join("\n") + "\n");
  console.log(`\nFull results saved to /tmp/backtest-mtf-full.txt`);

  // ── Top 10 qualified results ─────────────────────────────────────────────────
  const qualified = results.filter((r) => !r.lowTrades);
  const top10 = qualified.slice(0, 10);

  console.log(`\n=== TOP 10 by test %/day (trades >= 15, out-of-sample ~${testDaysRef.toFixed(0)}d) ===\n`);
  console.log(`rsiLow=35 fixed | stagBars=${STAG_BARS} (${STAG_BARS * 4}h) | fees=${(FEE_RATE * 100).toFixed(3)}% RT | leverage=${LEV}x\n`);

  top10.forEach((r, i) => {
    const p = r.params;
    const line = `smaPeriod=${p.smaPeriod} adxMin=${p.adxMin} rsiHigh=${p.rsiHigh} stopAtr=${p.stopAtr.toFixed(1)} rr=${p.rewardRisk.toFixed(1)} | test: ${r.pctPerDay >= 0 ? "+" : ""}${r.pctPerDay.toFixed(3)}%/d ${r.testTrades}T ${r.winRate.toFixed(0)}%w Sharpe=${r.testSharpe.toFixed(2)}`;
    console.log(`${String(i + 1).padStart(2)}. ${line}`);
  });

  if (top10.length === 0) {
    console.log("No combos qualified with >= 15 test trades.");
    console.log("\nTop 10 including low-trade combos:");
    results.slice(0, 10).forEach((r, i) => {
      const p = r.params;
      const line = `smaPeriod=${p.smaPeriod} adxMin=${p.adxMin} rsiHigh=${p.rsiHigh} stopAtr=${p.stopAtr.toFixed(1)} rr=${p.rewardRisk.toFixed(1)} | test: ${r.pctPerDay >= 0 ? "+" : ""}${r.pctPerDay.toFixed(3)}%/d ${r.testTrades}T ${r.winRate.toFixed(0)}%w Sharpe=${r.testSharpe.toFixed(2)} (low trades)`;
      console.log(`${String(i + 1).padStart(2)}. ${line}`);
    });
  }

  if (top10.length > 0) {
    const best = top10[0];
    const bp = best.params;
    console.log("\n=== BEST COMBO ===");
    console.log(`smaPeriod=${bp.smaPeriod} adxMin=${bp.adxMin} rsiHigh=${bp.rsiHigh} rsiLow=35 stopAtr=${bp.stopAtr} rewardRisk=${bp.rewardRisk}`);
    console.log(`Test: ${best.pctPerDay >= 0 ? "+" : ""}${best.pctPerDay.toFixed(3)}%/day | ${best.testTrades} trades | ${best.winRate.toFixed(0)}% WR | Sharpe=${best.testSharpe.toFixed(2)} | MaxDD=${best.maxDrawdown.toFixed(1)}%`);
  }

  console.log(`\nAll ${results.length} results saved to /tmp/backtest-mtf-full.txt`);
}

main().catch(console.error);
