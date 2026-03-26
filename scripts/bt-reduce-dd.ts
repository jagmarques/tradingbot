/**
 * Drawdown Reduction Study: 4h Supertrend(14,2)
 *
 * Tests 8 techniques + combined best to get MaxDD < $30.
 * Cost model: Taker 0.035%, standard spread map, 1.5x SL slippage, 10x lev, $5 margin.
 */
import * as fs from "fs";
import * as path from "path";
import { ATR } from "technicalindicators";

// ============ CONFIG ============
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const BASE_SIZE = 5; // $5 margin
const NOT = BASE_SIZE * LEV; // $50 notional
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const H4 = 4 * 3600000;
const SL_SLIP = 1.5;

const OOS_START = new Date("2025-09-01").getTime();
const PERIOD_START = new Date("2023-01-01").getTime();
const PERIOD_END = new Date("2026-03-26").getTime();

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4,
  OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
};

// ============ TYPES ============
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; notional: number;
}
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

// ============ DATA LOADING ============
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(bars5m: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
    const h4Start = Math.floor(b.t / H4) * H4;
    let arr = groups.get(h4Start);
    if (!arr) { arr = []; groups.set(h4Start, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [t, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 40) continue;
    result.push({
      t, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return result;
}

function aggregateToDaily(bars5m: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
    const dayStart = Math.floor(b.t / DAY) * DAY;
    let arr = groups.get(dayStart);
    if (!arr) { arr = []; groups.set(dayStart, arr); }
    arr.push(b);
  }
  const daily: C[] = [];
  for (const [t, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 200) continue;
    daily.push({
      t, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return daily;
}

// ============ INDICATORS ============
function calcATR(candles: C[], period: number): number[] {
  const raw = ATR.calculate({
    period,
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    close: candles.map(c => c.c),
  });
  const pad = candles.length - raw.length;
  return [...new Array(pad).fill(NaN), ...raw];
}

function calcSupertrend(candles: C[], period: number, multiplier: number): { st: number[]; dir: number[] } {
  const atr = calcATR(candles, period);
  const st = new Array(candles.length).fill(NaN);
  const dir = new Array(candles.length).fill(0);

  for (let i = period; i < candles.length; i++) {
    if (isNaN(atr[i])) continue;
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    let upperBand: number;
    if (i === period || isNaN(st[i - 1])) {
      upperBand = basicUpper;
    } else {
      const prevUpper = dir[i - 1] === -1 ? st[i - 1] : basicUpper;
      upperBand = basicUpper < prevUpper ? basicUpper : (candles[i - 1].c > prevUpper ? basicUpper : prevUpper);
    }

    let lowerBand: number;
    if (i === period || isNaN(st[i - 1])) {
      lowerBand = basicLower;
    } else {
      const prevLower = dir[i - 1] === 1 ? st[i - 1] : basicLower;
      lowerBand = basicLower > prevLower ? basicLower : (candles[i - 1].c < prevLower ? basicLower : prevLower);
    }

    if (i === period) {
      dir[i] = candles[i].c > upperBand ? 1 : -1;
      st[i] = dir[i] === 1 ? lowerBand : upperBand;
    } else {
      if (dir[i - 1] === 1) {
        if (candles[i].c < lowerBand) { dir[i] = -1; st[i] = upperBand; }
        else { dir[i] = 1; st[i] = lowerBand; }
      } else {
        if (candles[i].c > upperBand) { dir[i] = 1; st[i] = lowerBand; }
        else { dir[i] = -1; st[i] = upperBand; }
      }
    }
  }
  return { st, dir };
}

// ============ COST / PNL ============
function tradePnl(pair: string, ep: number, xp: number, dir: "long" | "short", isSL: boolean, notional: number = NOT): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? SL_SLIP : 1);
  const fees = notional * FEE_TAKER * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return rawPnl - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

// ============ METRICS ============
function calcMetrics(trades: Tr[], startTs: number = OOS_START, endTs: number = PERIOD_END): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = (endTs - startTs) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

// ============ PRECOMPUTE DATA ============
console.log("Loading candle data...");
const raw5m = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const dailyData = new Map<string, C[]>();

for (const pair of [...PAIRS, "BTC"]) {
  const bars = load5m(pair);
  if (bars.length === 0) { console.log(`  WARN: no data for ${pair}`); continue; }
  raw5m.set(pair, bars);
  h4Data.set(pair, aggregateTo4h(bars));
  dailyData.set(pair, aggregateToDaily(bars));
}

// Precompute supertrend for all pairs
const stData = new Map<string, { dir: number[]; st: number[] }>();
const atrData = new Map<string, number[]>();
for (const pair of PAIRS) {
  const cs = h4Data.get(pair);
  if (!cs || cs.length < 20) continue;
  stData.set(pair, calcSupertrend(cs, 14, 2));
  atrData.set(pair, calcATR(cs, 14));
}

// BTC daily for volatility scaling
const btcDaily = dailyData.get("BTC") ?? [];

console.log(`Loaded ${h4Data.size} pairs, ${btcDaily.length} BTC daily bars\n`);

// ============ BASELINE: 4h Supertrend(14,2) with ATR SL 3.5% cap ============

interface Position {
  pair: string;
  dir: "long" | "short";
  ep: number;
  et: number;
  sl: number;
  notional: number;
}

interface TechniqueOpts {
  // 1: Losing streak circuit breaker
  losingStreakBreaker?: { maxConsec: number; skipNext: number };
  // 2: Daily loss limit per engine
  dailyLossLimit?: number;
  // 3: Equity curve trading
  equityCurveMA?: number;
  // 4: Volatility scaling
  volScaling?: boolean;
  // 5: Inverse correlation hedge
  maxShorts?: number;
  // 6: Max open positions per engine
  maxOpenPos?: number;
  // 7: Tighter global SL
  maxSlPct?: number;
  // 8: Time-weighted sizing
  timeWeightedSizing?: boolean;
}

function runSupertrend(opts: TechniqueOpts = {}): Tr[] {
  const trades: Tr[] = [];
  const maxSlPct = opts.maxSlPct ?? 0.035; // default 3.5%

  // State for technique tracking
  let consecLosses = 0;
  let skipRemaining = 0;
  const dailyPnlTracker = new Map<number, number>(); // dayKey -> cumulative pnl
  const recentPnls: number[] = []; // for equity curve MA
  let equityCurveSum = 0;
  const openPositions = new Map<string, Position>();

  // BTC 20-day realized vol (for vol scaling)
  const btcDailyReturns: number[] = [];
  const btcVolHistory: number[] = []; // rolling 20-day realized vol
  for (let i = 1; i < btcDaily.length; i++) {
    const ret = Math.log(btcDaily[i].c / btcDaily[i - 1].c);
    btcDailyReturns.push(ret);
    if (btcDailyReturns.length >= 20) {
      const last20 = btcDailyReturns.slice(-20);
      const m = last20.reduce((s, r) => s + r, 0) / 20;
      const v = Math.sqrt(last20.reduce((s, r) => s + (r - m) ** 2, 0) / 19) * Math.sqrt(365) * 100;
      btcVolHistory.push(v);
    } else {
      btcVolHistory.push(NaN);
    }
  }
  // Compute 80th percentile of BTC vol
  const validVols = btcVolHistory.filter(v => !isNaN(v)).sort((a, b) => a - b);
  const vol80pct = validVols[Math.floor(validVols.length * 0.8)] ?? 80;
  const volMedian = validVols[Math.floor(validVols.length * 0.5)] ?? 50;

  function getBtcVol(ts: number): number {
    // Find closest BTC daily bar index
    for (let i = btcDaily.length - 1; i >= 1; i--) {
      if (btcDaily[i].t <= ts && i - 1 < btcVolHistory.length) {
        return btcVolHistory[i - 1] ?? volMedian;
      }
    }
    return volMedian;
  }

  function getNotional(ts: number): number {
    if (opts.volScaling) {
      const curVol = getBtcVol(ts);
      if (curVol > vol80pct) {
        // Scale down: size = $5 * (median / current), min $2, max $5
        const scaledMargin = Math.min(BASE_SIZE, Math.max(2, BASE_SIZE * (volMedian / curVol)));
        return scaledMargin * LEV;
      }
    }
    if (opts.timeWeightedSizing) {
      const hour = new Date(ts).getUTCHours();
      if (hour >= 0 && hour < 8) {
        // High-vol hours: reduce to $3 margin
        return 3 * LEV;
      }
    }
    return NOT;
  }

  // Collect all 4h timestamps across all pairs
  const allH4Timestamps = new Set<number>();
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs) continue;
    for (const bar of cs) allH4Timestamps.add(bar.t);
  }
  const sortedTs = [...allH4Timestamps].sort((a, b) => a - b);

  // Build index maps for quick lookup
  const h4IdxMap = new Map<string, Map<number, number>>();
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs) continue;
    const m = new Map<number, number>();
    cs.forEach((c, i) => m.set(c.t, i));
    h4IdxMap.set(pair, m);
  }

  for (const ts of sortedTs) {
    const closedNow = new Set<string>();

    // EXIT: check all open positions
    for (const [pair, pos] of openPositions) {
      const cs = h4Data.get(pair);
      const sd = stData.get(pair);
      if (!cs || !sd) continue;
      const idx = h4IdxMap.get(pair)?.get(ts) ?? -1;
      if (idx < 1) continue;

      const bar = cs[idx];
      let xp = 0;
      let reason = "";
      let isSL = false;

      // Check ATR SL
      if (pos.dir === "long" && bar.l <= pos.sl) {
        xp = pos.sl;
        reason = "sl";
        isSL = true;
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        xp = pos.sl;
        reason = "sl";
        isSL = true;
      }

      // Check supertrend flip
      if (!xp) {
        const curDir = sd.dir[idx];
        const prevDir = sd.dir[idx - 1];
        if (pos.dir === "long" && curDir === -1 && prevDir === 1) {
          xp = bar.o;
          reason = "flip";
        } else if (pos.dir === "short" && curDir === 1 && prevDir === -1) {
          xp = bar.o;
          reason = "flip";
        }
      }

      // Stagnation: 48h max hold
      if (!xp && ts - pos.et >= 48 * 3600000) {
        xp = bar.c;
        reason = "stag";
      }

      if (xp > 0) {
        const pnl = tradePnl(pair, pos.ep, xp, pos.dir, isSL, pos.notional);
        if (pos.et >= OOS_START && pos.et < PERIOD_END) {
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: ts, pnl, reason, notional: pos.notional });

          // Update state for techniques
          const dayKey = Math.floor(ts / DAY);
          dailyPnlTracker.set(dayKey, (dailyPnlTracker.get(dayKey) ?? 0) + pnl);

          if (pnl <= 0) {
            consecLosses++;
          } else {
            consecLosses = 0;
            skipRemaining = 0;
          }

          recentPnls.push(pnl);
          equityCurveSum += pnl;
        }
        openPositions.delete(pair);
        closedNow.add(pair);
      }
    }

    // ENTRY: check for new signals
    for (const pair of PAIRS) {
      if (openPositions.has(pair) || closedNow.has(pair)) continue;
      if (ts < OOS_START || ts >= PERIOD_END) continue;

      const cs = h4Data.get(pair);
      const sd = stData.get(pair);
      const atr = atrData.get(pair);
      if (!cs || !sd || !atr) continue;
      const idx = h4IdxMap.get(pair)?.get(ts) ?? -1;
      if (idx < 2) continue;

      const curDir = sd.dir[idx - 1];
      const prevDir = sd.dir[idx - 2];
      if (curDir === 0 || prevDir === 0 || curDir === prevDir) continue;

      const dir: "long" | "short" = curDir === 1 ? "long" : "short";

      // Technique 1: Losing streak circuit breaker
      if (opts.losingStreakBreaker) {
        if (skipRemaining > 0) {
          skipRemaining--;
          continue;
        }
        if (consecLosses >= opts.losingStreakBreaker.maxConsec) {
          skipRemaining = opts.losingStreakBreaker.skipNext - 1;
          consecLosses = 0;
          continue;
        }
      }

      // Technique 2: Daily loss limit
      if (opts.dailyLossLimit !== undefined) {
        const dayKey = Math.floor(ts / DAY);
        const dayPnl = dailyPnlTracker.get(dayKey) ?? 0;
        if (dayPnl < -opts.dailyLossLimit) continue;
      }

      // Technique 3: Equity curve trading
      if (opts.equityCurveMA !== undefined && recentPnls.length >= opts.equityCurveMA) {
        const maLen = opts.equityCurveMA;
        const recentSlice = recentPnls.slice(-maLen);
        const maVal = recentSlice.reduce((s, v) => s + v, 0) / maLen;
        if (equityCurveSum / recentPnls.length < maVal) continue; // below MA -> skip
      }

      // Technique 5: Inverse correlation hedge
      if (opts.maxShorts !== undefined && dir === "short") {
        let shortCount = 0;
        for (const [, p] of openPositions) {
          if (p.dir === "short") shortCount++;
        }
        if (shortCount >= opts.maxShorts) continue;
      }

      // Technique 6: Max open positions
      if (opts.maxOpenPos !== undefined) {
        if (openPositions.size >= opts.maxOpenPos) continue;
      }

      // Compute notional (technique 4 + 8)
      const notional = getNotional(ts);

      // Compute ATR SL capped at maxSlPct
      const curATR = atr[idx - 1];
      if (isNaN(curATR) || curATR <= 0) continue;
      const ep = cs[idx].o;
      const atrSL = curATR * 3;
      const capSL = ep * maxSlPct;
      const slDist = Math.min(atrSL, capSL);
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.set(pair, { pair, dir, ep, et: ts, sl, notional });
    }
  }

  // Close remaining open positions
  for (const [pair, pos] of openPositions) {
    if (pos.et < OOS_START || pos.et >= PERIOD_END) continue;
    const cs = h4Data.get(pair);
    if (!cs || cs.length === 0) continue;
    const lastBar = cs[cs.length - 1];
    const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false, pos.notional);
    trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end", notional: pos.notional });
  }

  trades.sort((a, b) => a.xt - b.xt);
  return trades;
}

// ============ FORMATTING ============
function fmtRow(label: string, m: Metrics, baselineDD: number): string {
  const ddReduction = baselineDD > 0 ? ((baselineDD - m.dd) / baselineDD * 100).toFixed(1) : "N/A";
  return `  ${label.padEnd(42)} `
    + `N=${String(m.n).padStart(4)}  `
    + `WR=${m.wr.toFixed(1).padStart(5)}%  `
    + `PF=${m.pf.toFixed(2).padStart(5)}  `
    + `Sharpe=${m.sharpe.toFixed(2).padStart(5)}  `
    + `$/d=${(m.perDay >= 0 ? "+" : "") + "$" + Math.abs(m.perDay).toFixed(2)}  `
    + `MaxDD=$${m.dd.toFixed(2).padStart(6)}  `
    + `DDchg=${(baselineDD - m.dd >= 0 ? "-" : "+") + Math.abs(baselineDD - m.dd).toFixed(2)}  `
    + `(${ddReduction}%)`;
}

// ============ RUN ALL TECHNIQUES ============
console.log("=".repeat(140));
console.log("4h Supertrend(14,2) Drawdown Reduction Study");
console.log("OOS: 2025-09-01 to 2026-03-26 | Cost: Taker 0.035%, spread map, 1.5x SL slip, 10x lev, $5 margin");
console.log("=".repeat(140));

// 0. Baseline
console.log("\n--- BASELINE ---");
const baselineTrades = runSupertrend({});
const baselineM = calcMetrics(baselineTrades);
console.log(fmtRow("0. Baseline (3.5% SL cap, no limits)", baselineM, baselineM.dd));

// 1. Losing streak circuit breaker
console.log("\n--- TECHNIQUE 1: Losing Streak Circuit Breaker ---");
const t1Trades = runSupertrend({ losingStreakBreaker: { maxConsec: 3, skipNext: 2 } });
const t1M = calcMetrics(t1Trades);
console.log(fmtRow("1. Skip 2 after 3 consecutive losses", t1M, baselineM.dd));

// 2. Daily loss limit
console.log("\n--- TECHNIQUE 2: Daily Loss Limit ---");
const t2Trades = runSupertrend({ dailyLossLimit: 5 });
const t2M = calcMetrics(t2Trades);
console.log(fmtRow("2. Daily loss limit $5/engine", t2M, baselineM.dd));

// 3. Equity curve trading
console.log("\n--- TECHNIQUE 3: Equity Curve Trading ---");
const t3Trades = runSupertrend({ equityCurveMA: 20 });
const t3M = calcMetrics(t3Trades);
console.log(fmtRow("3. 20-trade equity curve MA filter", t3M, baselineM.dd));

// 4. Volatility scaling
console.log("\n--- TECHNIQUE 4: Volatility Scaling ---");
const t4Trades = runSupertrend({ volScaling: true });
const t4M = calcMetrics(t4Trades);
console.log(fmtRow("4. BTC vol scaling (reduce > 80th pctl)", t4M, baselineM.dd));

// 5. Inverse correlation hedge
console.log("\n--- TECHNIQUE 5: Inverse Correlation Hedge ---");
const t5Trades = runSupertrend({ maxShorts: 5 });
const t5M = calcMetrics(t5Trades);
console.log(fmtRow("5. Max 5 open shorts (direction cap)", t5M, baselineM.dd));

// 6. Max open positions
console.log("\n--- TECHNIQUE 6: Max Open Positions ---");
const t6Trades = runSupertrend({ maxOpenPos: 3 });
const t6M = calcMetrics(t6Trades);
console.log(fmtRow("6. Max 3 open positions", t6M, baselineM.dd));

// 7. Tighter global SL
console.log("\n--- TECHNIQUE 7: Tighter Global SL ---");
const t7Trades = runSupertrend({ maxSlPct: 0.025 });
const t7M = calcMetrics(t7Trades);
console.log(fmtRow("7. SL cap 2.5% (vs 3.5% baseline)", t7M, baselineM.dd));

// 8. Time-weighted sizing
console.log("\n--- TECHNIQUE 8: Time-Weighted Sizing ---");
const t8Trades = runSupertrend({ timeWeightedSizing: true });
const t8M = calcMetrics(t8Trades);
console.log(fmtRow("8. Reduce size 00:00-08:00 UTC ($30 not)", t8M, baselineM.dd));

// ============ FIND TOP 3 DD REDUCERS ============
const results = [
  { name: "1. Losing streak breaker", opts: { losingStreakBreaker: { maxConsec: 3, skipNext: 2 } } as TechniqueOpts, m: t1M },
  { name: "2. Daily loss limit $5", opts: { dailyLossLimit: 5 } as TechniqueOpts, m: t2M },
  { name: "3. Equity curve MA(20)", opts: { equityCurveMA: 20 } as TechniqueOpts, m: t3M },
  { name: "4. Vol scaling", opts: { volScaling: true } as TechniqueOpts, m: t4M },
  { name: "5. Max 5 shorts", opts: { maxShorts: 5 } as TechniqueOpts, m: t5M },
  { name: "6. Max 3 positions", opts: { maxOpenPos: 3 } as TechniqueOpts, m: t6M },
  { name: "7. SL 2.5%", opts: { maxSlPct: 0.025 } as TechniqueOpts, m: t7M },
  { name: "8. Time-weighted sizing", opts: { timeWeightedSizing: true } as TechniqueOpts, m: t8M },
];

// Sort by DD reduction (lower DD = better)
const sorted = [...results].sort((a, b) => a.m.dd - b.m.dd);

console.log("\n" + "=".repeat(140));
console.log("RANKING BY DRAWDOWN (best to worst):");
console.log("=".repeat(140));
for (let i = 0; i < sorted.length; i++) {
  const r = sorted[i];
  const ddRed = ((baselineM.dd - r.m.dd) / baselineM.dd * 100).toFixed(1);
  console.log(`  #${i + 1}  ${r.name.padEnd(32)} DD=$${r.m.dd.toFixed(2).padStart(6)}  `
    + `reduction=${ddRed}%  `
    + `$/d=${(r.m.perDay >= 0 ? "+" : "") + "$" + Math.abs(r.m.perDay).toFixed(2)}  `
    + `Sharpe=${r.m.sharpe.toFixed(2)}`);
}

// ============ TECHNIQUE 9: Combined Best 3 ============
console.log("\n" + "=".repeat(140));
console.log("TECHNIQUE 9: COMBINED BEST 3");
console.log("=".repeat(140));

// Merge the top 3 technique opts
const top3 = sorted.slice(0, 3);
console.log(`  Combining: ${top3.map(t => t.name).join(" + ")}`);

const combinedOpts: TechniqueOpts = {};
for (const t of top3) {
  Object.assign(combinedOpts, t.opts);
}

const t9Trades = runSupertrend(combinedOpts);
const t9M = calcMetrics(t9Trades);
console.log(fmtRow("9. Combined best 3 techniques", t9M, baselineM.dd));

// Also try combining ALL techniques that reduced DD
const ddReducers = results.filter(r => r.m.dd < baselineM.dd);
if (ddReducers.length > 3) {
  console.log(`\n  Also trying: all ${ddReducers.length} DD-reducing techniques combined`);
  const allOpts: TechniqueOpts = {};
  for (const r of ddReducers) {
    Object.assign(allOpts, r.opts);
  }
  const tAllTrades = runSupertrend(allOpts);
  const tAllM = calcMetrics(tAllTrades);
  console.log(fmtRow("9b. All DD-reducing techniques combined", tAllM, baselineM.dd));
}

// ============ SUMMARY TABLE ============
console.log("\n" + "=".repeat(140));
console.log("SUMMARY TABLE");
console.log("=".repeat(140));
console.log(`  ${"Technique".padEnd(42)} ${"Trades".padStart(6)}  ${"WR%".padStart(6)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"$/day".padStart(8)}  ${"MaxDD".padStart(8)}  ${"DD chg".padStart(8)}  ${"DD red%".padStart(7)}`);
console.log("  " + "-".repeat(108));

const allResults = [
  { name: "0. Baseline (3.5% SL, no limits)", m: baselineM },
  { name: "1. Losing streak breaker (3L->skip 2)", m: t1M },
  { name: "2. Daily loss limit $5/engine", m: t2M },
  { name: "3. Equity curve MA(20) filter", m: t3M },
  { name: "4. Volatility scaling (BTC vol>80pct)", m: t4M },
  { name: "5. Direction cap (max 5 shorts)", m: t5M },
  { name: "6. Max 3 open positions", m: t6M },
  { name: "7. Tighter SL 2.5% cap", m: t7M },
  { name: "8. Time-weighted sizing (00-08 UTC)", m: t8M },
  { name: "9. Combined best 3", m: t9M },
];

for (const r of allResults) {
  const ddRed = baselineM.dd > 0 ? ((baselineM.dd - r.m.dd) / baselineM.dd * 100) : 0;
  console.log(
    `  ${r.name.padEnd(42)} `
    + `${String(r.m.n).padStart(6)}  `
    + `${r.m.wr.toFixed(1).padStart(6)}  `
    + `${r.m.pf.toFixed(2).padStart(5)}  `
    + `${r.m.sharpe.toFixed(2).padStart(6)}  `
    + `${((r.m.perDay >= 0 ? "+" : "-") + "$" + Math.abs(r.m.perDay).toFixed(2)).padStart(8)}  `
    + `${("$" + r.m.dd.toFixed(2)).padStart(8)}  `
    + `${((baselineM.dd - r.m.dd >= 0 ? "-" : "+") + "$" + Math.abs(baselineM.dd - r.m.dd).toFixed(2)).padStart(8)}  `
    + `${(ddRed >= 0 ? "-" : "+") + Math.abs(ddRed).toFixed(1) + "%"}`
  );
}

// ============ TARGETED COMBOS ============
console.log("\n" + "=".repeat(140));
console.log("TARGETED COMBOS (practical: keep $/day > 0 and Sharpe > 0)");
console.log("=".repeat(140));

// Combo A: Max 3 pos + Daily loss limit $5
const comboA = runSupertrend({ maxOpenPos: 3, dailyLossLimit: 5 });
const comboAM = calcMetrics(comboA);
console.log(fmtRow("A. Max 3 pos + Daily loss $5", comboAM, baselineM.dd));

// Combo B: Max 3 pos + Time-weighted sizing
const comboB = runSupertrend({ maxOpenPos: 3, timeWeightedSizing: true });
const comboBM = calcMetrics(comboB);
console.log(fmtRow("B. Max 3 pos + Time-weighted sizing", comboBM, baselineM.dd));

// Combo C: Max 3 pos + Daily loss $5 + Time-weighted
const comboC = runSupertrend({ maxOpenPos: 3, dailyLossLimit: 5, timeWeightedSizing: true });
const comboCM = calcMetrics(comboC);
console.log(fmtRow("C. Max 3 pos + DL $5 + Time-weighted", comboCM, baselineM.dd));

// Combo D: Max 3 pos + Losing streak breaker
const comboD = runSupertrend({ maxOpenPos: 3, losingStreakBreaker: { maxConsec: 3, skipNext: 2 } });
const comboDM = calcMetrics(comboD);
console.log(fmtRow("D. Max 3 pos + Losing streak breaker", comboDM, baselineM.dd));

// Combo E: Max 3 pos + DL $5 + Losing streak
const comboE = runSupertrend({ maxOpenPos: 3, dailyLossLimit: 5, losingStreakBreaker: { maxConsec: 3, skipNext: 2 } });
const comboEM = calcMetrics(comboE);
console.log(fmtRow("E. Max 3 pos + DL $5 + Streak breaker", comboEM, baselineM.dd));

console.log("\n" + "=".repeat(140));
console.log("TARGET: MaxDD < $30");
const allCandidates = [
  { name: "6. Max 3 positions", dd: t6M.dd, perDay: t6M.perDay, sharpe: t6M.sharpe },
  { name: "A. Max 3 pos + DL $5", dd: comboAM.dd, perDay: comboAM.perDay, sharpe: comboAM.sharpe },
  { name: "B. Max 3 pos + Time-weighted", dd: comboBM.dd, perDay: comboBM.perDay, sharpe: comboBM.sharpe },
  { name: "C. Max 3 pos + DL $5 + TW", dd: comboCM.dd, perDay: comboCM.perDay, sharpe: comboCM.sharpe },
  { name: "D. Max 3 pos + Streak breaker", dd: comboDM.dd, perDay: comboDM.perDay, sharpe: comboDM.sharpe },
  { name: "E. Max 3 pos + DL $5 + Streak", dd: comboEM.dd, perDay: comboEM.perDay, sharpe: comboEM.sharpe },
];
// Best = lowest DD that still has positive perDay
const viable = allCandidates.filter(c => c.perDay > 0);
viable.sort((a, b) => a.dd - b.dd);
for (const v of viable) {
  const met = v.dd < 30 ? "MET" : "NOT MET";
  console.log(`  ${v.name.padEnd(40)} DD=$${v.dd.toFixed(2).padStart(6)}  $/d=+$${v.perDay.toFixed(2)}  Sharpe=${v.sharpe.toFixed(2)}  [${met}]`);
}
console.log("=".repeat(140));
