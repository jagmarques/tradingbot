/**
 * SOTA Donchian Ensemble with Volatility-Targeted Sizing
 * Based on Zarattini et al. 2025 "Catching Crypto Trends"
 *
 * Tests ensemble of multiple Donchian channel periods with vol-targeted sizing.
 * Conservative cost model: doubled spreads, taker 0.035%, 1.5x SL slippage, 10x leverage.
 */
import * as fs from "fs";
import * as path from "path";
import { EMA, ATR, ADX } from "technicalindicators";

// ============ TYPES ============
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Trade {
  pair: string; dir: "long" | "short";
  ep: number; xp: number; et: number; xt: number;
  size: number; pnl: number; reason: string;
}
interface Position {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; size: number;
  lastSignal: number; // the combined signal at entry
}

// ============ CONSTANTS ============
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const DAY = 86400000;
const BASE_FEE = 0.00035; // taker fee
const LEV = 10;
const SL_SLIP = 1.5;
const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-04-01").getTime();
const OOS_START = new Date("2025-09-01").getTime();

const PAIRS = [
  "ADAUSDT", "APTUSDT", "ARBUSDT", "BTCUSDT", "DASHUSDT", "DOGEUSDT",
  "DOTUSDT", "ENAUSDT", "ETHUSDT", "LDOUSDT", "LINKUSDT", "OPUSDT",
  "SOLUSDT", "TIAUSDT", "TRUMPUSDT", "UNIUSDT", "WIFUSDT", "WLDUSDT", "XRPUSDT",
];

const LOOKBACKS = [5, 10, 20, 30, 60, 90];
const ENSEMBLE_THRESH = 0.3;
const VOL_TARGET = 0.02; // 2% daily vol target
const BASE_SIZE = 10; // $10 margin
const MIN_SIZE = 2;
const MAX_SIZE = 20;
const MAX_HOLD_DAYS = 60;

// Doubled spreads (conservative)
const SP: Record<string, number> = {
  XRPUSDT: 2.1e-4, DOGEUSDT: 2.7e-4, ETHUSDT: 3.0e-4, SOLUSDT: 4.0e-4,
  ARBUSDT: 5.2e-4, ENAUSDT: 5.1e-4, TIAUSDT: 5.0e-4, UNIUSDT: 5.5e-4,
  APTUSDT: 6.4e-4, LINKUSDT: 6.9e-4, TRUMPUSDT: 7.3e-4, WLDUSDT: 8e-4,
  DOTUSDT: 9.9e-4, WIFUSDT: 10.1e-4, ADAUSDT: 11.1e-4, LDOUSDT: 11.6e-4,
  OPUSDT: 12.4e-4, DASHUSDT: 14.3e-4, BTCUSDT: 1.0e-4,
};

// ============ DATA LOADING ============
function load5m(pair: string): C[] {
  const f = path.join(CACHE_5M, pair + ".json");
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }
  );
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
function calcEMA(candles: C[], period: number): number[] {
  const raw = EMA.calculate({ period, values: candles.map(c => c.c) });
  const pad = candles.length - raw.length;
  return [...new Array(pad).fill(NaN), ...raw];
}

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

function calcADX(candles: C[], period: number): number[] {
  const raw = ADX.calculate({
    close: candles.map(c => c.c),
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    period,
  });
  const pad = candles.length - raw.length;
  return [...new Array(pad).fill(NaN), ...raw.map(a => a.adx)];
}

function calcDonchianHigh(candles: C[], period: number): number[] {
  const result = new Array(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let mx = -Infinity;
    for (let j = i - period; j < i; j++) mx = Math.max(mx, candles[j].h);
    result[i] = mx;
  }
  return result;
}

function calcDonchianLow(candles: C[], period: number): number[] {
  const result = new Array(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let mn = Infinity;
    for (let j = i - period; j < i; j++) mn = Math.min(mn, candles[j].l);
    result[i] = mn;
  }
  return result;
}

function calcRollingStdDailyReturns(candles: C[], period: number): number[] {
  const result = new Array(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    const rets: number[] = [];
    for (let j = i - period + 1; j <= i; j++) {
      rets.push(candles[j].c / candles[j - 1].c - 1);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    result[i] = Math.sqrt(variance) * Math.sqrt(365);
  }
  return result;
}

// ============ PRECOMPUTED DATA ============
interface PairData {
  cs: C[];
  donHi: Map<number, number[]>; // lookback -> array
  donLo: Map<number, number[]>;
  atr14: number[];
  adx14: number[];
  rollingVol: number[];
  idxMap: Map<number, number>;
}

interface BtcData {
  cs: C[];
  ema20: number[];
  ema50: number[];
  idxMap: Map<number, number>;
}

function prepPair(candles: C[]): PairData {
  const donHi = new Map<number, number[]>();
  const donLo = new Map<number, number[]>();
  for (const lb of LOOKBACKS) {
    donHi.set(lb, calcDonchianHigh(candles, lb));
    donLo.set(lb, calcDonchianLow(candles, lb));
  }
  const idxMap = new Map<number, number>();
  candles.forEach((c, i) => idxMap.set(c.t, i));
  return {
    cs: candles,
    donHi, donLo,
    atr14: calcATR(candles, 14),
    adx14: calcADX(candles, 14),
    rollingVol: calcRollingStdDailyReturns(candles, 20),
    idxMap,
  };
}

function prepBtc(candles: C[]): BtcData {
  const idxMap = new Map<number, number>();
  candles.forEach((c, i) => idxMap.set(c.t, i));
  return { cs: candles, ema20: calcEMA(candles, 20), ema50: calcEMA(candles, 50), idxMap };
}

// ============ ENSEMBLE SIGNAL ============
function getEnsembleSignal(pd: PairData, idx: number): number {
  let sum = 0;
  let count = 0;
  for (const lb of LOOKBACKS) {
    const hi = pd.donHi.get(lb)![idx];
    const lo = pd.donLo.get(lb)![idx];
    if (isNaN(hi) || isNaN(lo)) continue;
    const close = pd.cs[idx].c;
    if (close > hi) sum += 1;
    else if (close < lo) sum -= 1;
    // else 0
    count++;
  }
  if (count === 0) return 0;
  return sum / count;
}

// ============ SIMULATION ============
interface SimConfig {
  useBtcFilter: boolean;
  useVolSizing: boolean;
  useAdxFilter: boolean;
  adxMin: number;
  singleLookback: number | null; // if set, use single Donchian instead of ensemble
  pairFilter: string[] | null; // if set, only these pairs
  label: string;
}

function simulate(
  pairMap: Map<string, PairData>,
  btcData: BtcData,
  startTs: number,
  endTs: number,
  config: SimConfig,
): Trade[] {
  const trades: Trade[] = [];
  const positions = new Map<string, Position>();
  const activePairs = config.pairFilter
    ? PAIRS.filter(p => config.pairFilter!.includes(p))
    : PAIRS;

  function btcLongOk(dayTs: number): boolean {
    if (!config.useBtcFilter) return true;
    for (let i = btcData.cs.length - 1; i >= 0; i--) {
      if (btcData.cs[i].t <= dayTs) {
        const e20 = btcData.ema20[i];
        const e50 = btcData.ema50[i];
        if (isNaN(e20) || isNaN(e50)) return false;
        return e20 > e50;
      }
    }
    return false;
  }

  function getSpread(pair: string): number {
    return SP[pair] ?? 8e-4;
  }

  function getSignal(pd: PairData, idx: number): number {
    if (config.singleLookback !== null) {
      // Single Donchian baseline
      const hi = pd.donHi.get(config.singleLookback)![idx];
      const lo = pd.donLo.get(config.singleLookback)![idx];
      if (isNaN(hi) || isNaN(lo)) return 0;
      const close = pd.cs[idx].c;
      if (close > hi) return 1;
      if (close < lo) return -1;
      return 0;
    }
    return getEnsembleSignal(pd, idx);
  }

  function getSize(pd: PairData, idx: number): number {
    if (!config.useVolSizing) return BASE_SIZE;
    const vol = pd.rollingVol[idx];
    if (isNaN(vol) || vol <= 0) return BASE_SIZE;
    const dailyVol = vol / Math.sqrt(365);
    const sz = (BASE_SIZE * VOL_TARGET) / dailyVol;
    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, sz));
  }

  // Collect all daily timestamps in range
  const dailyTimestamps = new Set<number>();
  for (const pd of pairMap.values()) {
    for (const c of pd.cs) {
      if (c.t >= startTs && c.t < endTs) dailyTimestamps.add(c.t);
    }
  }
  const sortedDays = [...dailyTimestamps].sort((a, b) => a - b);

  for (const dayTs of sortedDays) {
    const closedToday = new Set<string>();

    // EXIT pass
    for (const [pair, pos] of positions) {
      const pd = pairMap.get(pair);
      if (!pd) continue;
      const idx = pd.idxMap.get(dayTs);
      if (idx === undefined) continue;
      const bar = pd.cs[idx];
      const sp = getSpread(pair);
      const notional = pos.size * LEV;
      let xp = 0;
      let reason = "";

      // SL check
      if (pos.dir === "long" && bar.l <= pos.sl) {
        xp = pos.sl * (1 - sp * SL_SLIP);
        reason = "sl";
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        xp = pos.sl * (1 + sp * SL_SLIP);
        reason = "sl";
      }

      // Signal flip exit (use previous day's signal for anti-lookahead)
      if (!reason && idx >= 1) {
        const prevSig = getSignal(pd, idx - 1);
        if (pos.dir === "long" && prevSig < -ENSEMBLE_THRESH) {
          xp = bar.o * (1 - sp);
          reason = "flip";
        } else if (pos.dir === "short" && prevSig > ENSEMBLE_THRESH) {
          xp = bar.o * (1 + sp);
          reason = "flip";
        }
      }

      // Max hold
      if (!reason && dayTs - pos.et >= MAX_HOLD_DAYS * DAY) {
        xp = bar.o * (pos.dir === "long" ? (1 - sp) : (1 + sp));
        reason = "mh";
      }

      if (xp > 0) {
        const raw = pos.dir === "long"
          ? (xp / pos.ep - 1) * notional
          : (pos.ep / xp - 1) * notional;
        const fees = notional * BASE_FEE * 2;
        trades.push({
          pair, dir: pos.dir,
          ep: pos.ep, xp, et: pos.et, xt: dayTs,
          size: pos.size, pnl: raw - fees, reason,
        });
        positions.delete(pair);
        closedToday.add(pair);
      }
    }

    // ENTRY pass
    for (const pair of activePairs) {
      if (pair === "BTCUSDT") continue;
      if (positions.has(pair) || closedToday.has(pair)) continue;

      const pd = pairMap.get(pair);
      if (!pd) continue;
      const idx = pd.idxMap.get(dayTs);
      if (idx === undefined || idx < 1) continue;

      // Use signal from day i-1 (anti-lookahead)
      const prevIdx = idx - 1;
      const signal = getSignal(pd, prevIdx);

      let dir: "long" | "short" | null = null;
      if (config.singleLookback !== null) {
        // Single Donchian: +1 = long, -1 = short
        if (signal > 0) dir = "long";
        else if (signal < 0) dir = "short";
      } else {
        if (signal > ENSEMBLE_THRESH) dir = "long";
        else if (signal < -ENSEMBLE_THRESH) dir = "short";
      }
      if (!dir) continue;

      // BTC filter for longs
      if (dir === "long" && !btcLongOk(pd.cs[prevIdx].t)) continue;

      // ADX filter
      if (config.useAdxFilter) {
        const adxVal = pd.adx14[prevIdx];
        if (isNaN(adxVal) || adxVal < config.adxMin) continue;
      }

      const sp = getSpread(pair);
      const ep = pd.cs[idx].o;
      const entryPrice = dir === "long" ? ep * (1 + sp) : ep * (1 - sp);

      const atrVal = pd.atr14[prevIdx];
      if (isNaN(atrVal) || atrVal <= 0) continue;
      const slDist = atrVal * 3;
      const sl = dir === "long" ? entryPrice - slDist : entryPrice + slDist;

      const size = getSize(pd, prevIdx);

      positions.set(pair, {
        pair, dir, ep: entryPrice, et: dayTs, sl, size, lastSignal: signal,
      });
    }
  }

  // Close remaining positions at end
  for (const [pair, pos] of positions) {
    const pd = pairMap.get(pair);
    if (!pd) continue;
    const lastBar = pd.cs[pd.cs.length - 1];
    const sp = getSpread(pair);
    const notional = pos.size * LEV;
    const xp = pos.dir === "long" ? lastBar.c * (1 - sp) : lastBar.c * (1 + sp);
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const fees = notional * BASE_FEE * 2;
    trades.push({
      pair, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: lastBar.t,
      size: pos.size, pnl: raw - fees, reason: "eod",
    });
  }

  return trades;
}

// ============ REPORTING ============
interface Stats {
  trades: number; pf: number; sharpe: number; totalPnl: number;
  winRate: number; perDay: number; maxDD: number; maxDDDuration: number;
  longTrades: number; shortTrades: number;
  longPnl: number; shortPnl: number;
  longWR: number; shortWR: number;
}

function computeStats(trades: Trade[], startTs: number, endTs: number): Stats {
  if (trades.length === 0) return { trades: 0, pf: 0, sharpe: 0, totalPnl: 0, winRate: 0, perDay: 0, maxDD: 0, maxDDDuration: 0, longTrades: 0, shortTrades: 0, longPnl: 0, shortPnl: 0, longWR: 0, shortWR: 0 };

  const total = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const wr = trades.length > 0 ? wins.length / trades.length : 0;
  const days = (endTs - startTs) / DAY;
  const perDay = total / days;

  // Sharpe: daily PnL series
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.pnl);
  }
  const pnlArr = [...dailyPnl.values()];
  const mean = pnlArr.reduce((a, b) => a + b, 0) / pnlArr.length;
  const std = Math.sqrt(pnlArr.reduce((a, b) => a + (b - mean) ** 2, 0) / pnlArr.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  // Max drawdown
  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  let maxDDDuration = 0;
  let peakDay = 0;

  const sortedTrades = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sortedTrades) {
    equity += t.pnl;
    if (equity > peak) {
      peak = equity;
      peakDay = t.xt;
    }
    const dd = peak - equity;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDDuration = Math.round((t.xt - peakDay) / DAY);
    }
  }

  // Long/short split
  const longT = trades.filter(t => t.dir === "long");
  const shortT = trades.filter(t => t.dir === "short");
  const longPnl = longT.reduce((a, t) => a + t.pnl, 0);
  const shortPnl = shortT.reduce((a, t) => a + t.pnl, 0);
  const longWR = longT.length > 0 ? longT.filter(t => t.pnl > 0).length / longT.length : 0;
  const shortWR = shortT.length > 0 ? shortT.filter(t => t.pnl > 0).length / shortT.length : 0;

  return {
    trades: trades.length, pf, sharpe, totalPnl: total,
    winRate: wr, perDay, maxDD, maxDDDuration,
    longTrades: longT.length, shortTrades: shortT.length,
    longPnl, shortPnl, longWR, shortWR,
  };
}

function fmtStats(label: string, s: Stats): string {
  return [
    `  ${label}:`,
    `    Trades: ${s.trades}  |  PF: ${s.pf.toFixed(2)}  |  Sharpe: ${s.sharpe.toFixed(2)}  |  WR: ${(s.winRate * 100).toFixed(1)}%`,
    `    PnL: $${s.totalPnl.toFixed(2)}  |  $/day: $${s.perDay.toFixed(2)}  |  MaxDD: $${s.maxDD.toFixed(2)} (${s.maxDDDuration}d)`,
  ].join("\n");
}

function fmtStatsDetailed(label: string, s: Stats): string {
  return [
    `  ${label}:`,
    `    Trades: ${s.trades}  |  PF: ${s.pf.toFixed(2)}  |  Sharpe: ${s.sharpe.toFixed(2)}  |  WR: ${(s.winRate * 100).toFixed(1)}%`,
    `    PnL: $${s.totalPnl.toFixed(2)}  |  $/day: $${s.perDay.toFixed(2)}  |  MaxDD: $${s.maxDD.toFixed(2)} (${s.maxDDDuration}d)`,
    `    Long: ${s.longTrades} trades, $${s.longPnl.toFixed(2)}, WR ${(s.longWR * 100).toFixed(1)}%`,
    `    Short: ${s.shortTrades} trades, $${s.shortPnl.toFixed(2)}, WR ${(s.shortWR * 100).toFixed(1)}%`,
  ].join("\n");
}

function monthlyBreakdown(trades: Trade[], startTs: number, endTs: number): string {
  const monthly = new Map<string, number>();
  const oosTrades = trades.filter(t => t.xt >= startTs && t.xt < endTs);
  for (const t of oosTrades) {
    const d = new Date(t.xt);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    monthly.set(key, (monthly.get(key) ?? 0) + t.pnl);
  }
  const sorted = [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.map(([m, p]) => `    ${m}: $${p.toFixed(2)}`).join("\n");
}

function quarterTest(trades: Trade[], fullStart: number, fullEnd: number): string {
  const totalDays = (fullEnd - fullStart) / DAY;
  const qLen = totalDays / 4;
  const lines: string[] = [];
  for (let q = 0; q < 4; q++) {
    const qs = fullStart + q * qLen * DAY;
    const qe = fullStart + (q + 1) * qLen * DAY;
    const qt = trades.filter(t => t.et >= qs && t.et < qe);
    const s = computeStats(qt, qs, qe);
    lines.push(`    Q${q + 1}: PF=${s.pf.toFixed(2)}, PnL=$${s.totalPnl.toFixed(2)}, Trades=${s.trades}, $/day=$${s.perDay.toFixed(2)}`);
  }
  return lines.join("\n");
}

// ============ MAIN ============
async function main() {
  console.log("=== SOTA DONCHIAN ENSEMBLE BACKTEST ===");
  console.log("Zarattini et al. 2025 - Catching Crypto Trends\n");
  console.log("Conservative cost model: 2x spreads, taker 0.035%, 1.5x SL slippage, 10x leverage");
  console.log(`Pairs: ${PAIRS.length} | Full: 2023-01 to 2026-03 | OOS: 2025-09-01+`);
  console.log(`Ensemble lookbacks: [${LOOKBACKS.join(", ")}] | Threshold: +/-${ENSEMBLE_THRESH}`);
  console.log(`Vol target: ${VOL_TARGET * 100}% daily | Base size: $${BASE_SIZE} | Range: $${MIN_SIZE}-$${MAX_SIZE}\n`);

  // Load data
  console.log("Loading 5m candles and aggregating to daily...");
  const pairMap = new Map<string, PairData>();
  let btcData: BtcData | null = null;

  for (const pair of PAIRS) {
    const raw = load5m(pair);
    if (raw.length === 0) { console.log(`  SKIP ${pair} (no data)`); continue; }
    const daily = aggregateToDaily(raw);
    if (daily.length < 100) { console.log(`  SKIP ${pair} (${daily.length} daily bars)`); continue; }
    const pd = prepPair(daily);
    pairMap.set(pair, pd);
    if (pair === "BTCUSDT") {
      btcData = prepBtc(daily);
    }
    console.log(`  ${pair}: ${daily.length} daily bars (${new Date(daily[0].t).toISOString().slice(0, 10)} to ${new Date(daily[daily.length - 1].t).toISOString().slice(0, 10)})`);
  }

  if (!btcData) { console.log("ERROR: No BTC data"); return; }

  // ============ VARIATION A: Ensemble + Fixed sizing ============
  const configA: SimConfig = {
    useBtcFilter: true, useVolSizing: false, useAdxFilter: false,
    adxMin: 0, singleLookback: null, pairFilter: null,
    label: "A) Ensemble + Fixed $10",
  };

  // ============ VARIATION B: Ensemble + Vol-targeted sizing ============
  const configB: SimConfig = {
    useBtcFilter: true, useVolSizing: true, useAdxFilter: false,
    adxMin: 0, singleLookback: null, pairFilter: null,
    label: "B) Ensemble + Vol-Targeted (SOTA)",
  };

  // ============ VARIATION C: Ensemble + Vol-targeted + ADX ============
  const configC: SimConfig = {
    useBtcFilter: true, useVolSizing: true, useAdxFilter: true,
    adxMin: 20, singleLookback: null, pairFilter: null,
    label: "C) Ensemble + VolTarget + ADX>20",
  };

  // ============ VARIATION E: Single Donchian 30d baseline ============
  const configE: SimConfig = {
    useBtcFilter: true, useVolSizing: false, useAdxFilter: false,
    adxMin: 0, singleLookback: 30, pairFilter: null,
    label: "E) Single Donchian(30) Baseline",
  };

  const configs = [configA, configB, configC, configE];

  // Run all variations (except D which needs IS results first)
  const results: { config: SimConfig; fullTrades: Trade[]; oosTrades: Trade[] }[] = [];

  for (const cfg of configs) {
    console.log(`\nRunning ${cfg.label}...`);
    const fullTrades = simulate(pairMap, btcData, FULL_START, FULL_END, cfg);
    const oosTrades = fullTrades.filter(t => t.et >= OOS_START);
    results.push({ config: cfg, fullTrades, oosTrades });
  }

  // Variation D: top 10 pairs by IS performance
  console.log("\nDetermining top 10 pairs by IS performance for variation D...");
  const isTrades = results[1].fullTrades.filter(t => t.et < OOS_START); // Use variation B IS trades
  const pairPnlIS = new Map<string, number>();
  for (const t of isTrades) {
    pairPnlIS.set(t.pair, (pairPnlIS.get(t.pair) ?? 0) + t.pnl);
  }
  const sortedPairs = [...pairPnlIS.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p]) => p);
  console.log(`  Top 10 IS pairs: ${sortedPairs.map(p => p.replace("USDT", "")).join(", ")}`);

  const configD: SimConfig = {
    useBtcFilter: true, useVolSizing: true, useAdxFilter: false,
    adxMin: 0, singleLookback: null, pairFilter: sortedPairs,
    label: "D) Ensemble + VolTarget + Top10 IS pairs",
  };
  console.log(`\nRunning ${configD.label}...`);
  const fullTradesD = simulate(pairMap, btcData, FULL_START, FULL_END, configD);
  const oosTradesD = fullTradesD.filter(t => t.et >= OOS_START);
  results.push({ config: configD, fullTrades: fullTradesD, oosTrades: oosTradesD });

  // ============ REPORT ============
  console.log("\n" + "=".repeat(80));
  console.log("RESULTS SUMMARY");
  console.log("=".repeat(80));

  for (const r of results) {
    console.log(`\n--- ${r.config.label} ---`);
    const fullStats = computeStats(r.fullTrades, FULL_START, FULL_END);
    const oosStats = computeStats(r.oosTrades, OOS_START, FULL_END);

    console.log(fmtStats("FULL PERIOD", fullStats));
    console.log(fmtStatsDetailed("OOS (2025-09+)", oosStats));
    console.log("\n  Monthly OOS breakdown:");
    console.log(monthlyBreakdown(r.oosTrades, OOS_START, FULL_END));
    console.log("\n  4-Quarter test (full period):");
    console.log(quarterTest(r.fullTrades, FULL_START, FULL_END));
  }

  // ============ PAIR-LEVEL OOS FOR VARIATION B (SOTA) ============
  console.log("\n" + "=".repeat(80));
  console.log("PAIR-LEVEL OOS BREAKDOWN - Variation B (SOTA)");
  console.log("=".repeat(80));

  const sotaOOS = results[1].oosTrades;
  const pairPnlOOS = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of sotaOOS) {
    const cur = pairPnlOOS.get(t.pair) ?? { pnl: 0, trades: 0, wins: 0 };
    cur.pnl += t.pnl;
    cur.trades += 1;
    if (t.pnl > 0) cur.wins += 1;
    pairPnlOOS.set(t.pair, cur);
  }
  const sortedPairOOS = [...pairPnlOOS.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [pair, data] of sortedPairOOS) {
    const wr = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(0) : "0";
    console.log(`  ${pair.replace("USDT", "").padEnd(6)} ${data.trades.toString().padStart(3)} trades  PnL: $${data.pnl.toFixed(2).padStart(8)}  WR: ${wr}%`);
  }

  // ============ EXIT REASON BREAKDOWN - Variation B ============
  console.log("\n" + "=".repeat(80));
  console.log("EXIT REASON BREAKDOWN - Variation B OOS");
  console.log("=".repeat(80));

  const reasonMap = new Map<string, { count: number; pnl: number }>();
  for (const t of sotaOOS) {
    const cur = reasonMap.get(t.reason) ?? { count: 0, pnl: 0 };
    cur.count += 1;
    cur.pnl += t.pnl;
    reasonMap.set(t.reason, cur);
  }
  for (const [reason, data] of [...reasonMap.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(8)} ${data.count.toString().padStart(4)} trades  PnL: $${data.pnl.toFixed(2)}`);
  }

  // ============ SIZING ANALYSIS - Variation B ============
  console.log("\n" + "=".repeat(80));
  console.log("VOL-TARGETED SIZING ANALYSIS - Variation B OOS");
  console.log("=".repeat(80));

  const sizes = sotaOOS.map(t => t.size);
  const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const minSz = Math.min(...sizes);
  const maxSz = Math.max(...sizes);
  console.log(`  Avg size: $${avgSize.toFixed(2)}  |  Min: $${minSz.toFixed(2)}  |  Max: $${maxSz.toFixed(2)}`);
  const buckets = [2, 5, 8, 12, 16, 20];
  for (let i = 0; i < buckets.length; i++) {
    const lo = i === 0 ? 0 : buckets[i - 1];
    const hi = buckets[i];
    const inBucket = sotaOOS.filter(t => t.size > lo && t.size <= hi);
    if (inBucket.length > 0) {
      const bPnl = inBucket.reduce((a, t) => a + t.pnl, 0);
      console.log(`  Size $${lo}-$${hi}: ${inBucket.length} trades, PnL: $${bPnl.toFixed(2)}`);
    }
  }

  console.log("\nDone.");
}

main();
