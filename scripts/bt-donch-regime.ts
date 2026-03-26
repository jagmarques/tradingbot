/**
 * Regime-Adaptive Donchian Breakout Backtest
 *
 * Tests 5 approaches:
 * 0. Baseline: fixed 30d/15d/ATRx3, BTC trend filter
 * 1. BTC Volatility Regime: adjust lookback/ATR by BTC 20d realized vol
 * 2. ATR-Ratio Regime: each pair's ATR(14)/ATR(50) ratio
 * 3. Trend Strength (ADX) sizing: full/half/skip by ADX
 * 4. Inverse Volatility sizing: size inversely to ATR
 *
 * Data: 5m from /tmp/bt-pair-cache-5m/, aggregated to daily
 * OOS: 2025-09-01 onwards
 * Cost: 0.035% taker, spread map, 1.5x SL slip, 10x lev, max hold 60d
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const BASE_SIZE = 10; // $10 margin
const FEE = 0.00035;
const DAY = 86400000;
const MAX_HOLD = 60;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, AVAX: 2.55e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, SEI: 4.4e-4,
  TON: 4.6e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
  ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
};

const ALL_PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-26").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Pos {
  pair: string; dir: "long"|"short"; ep: number; et: number;
  sl: number; peak: number; atrAtEntry: number; size: number;
}
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
  holdDays: number; size: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c,
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregateToDaily(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const dayTs = Math.floor(c.t / DAY) * DAY;
    const arr = groups.get(dayTs) ?? [];
    arr.push(c);
    groups.set(dayTs, arr);
  }
  const daily: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 200) continue; // need most of day (288 x 5m bars)
    daily.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return daily;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++)
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j-1].c), Math.abs(cs[j].l - cs[j-1].c));
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period; init = true;
    } else {
      ema[i] = values[i] * k + ema[i-1] * (1 - k);
    }
  }
  return ema;
}

function calcADX(cs: C[], period: number): number[] {
  const adx = new Array(cs.length).fill(0);
  const plusDM: number[] = [], minusDM: number[] = [], tr: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    if (i === 0) { plusDM.push(0); minusDM.push(0); tr.push(cs[i].h - cs[i].l); continue; }
    const upMove = cs[i].h - cs[i-1].h;
    const downMove = cs[i-1].l - cs[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c)));
  }
  const smoothTR = new Array(cs.length).fill(0);
  const smoothPDM = new Array(cs.length).fill(0);
  const smoothMDM = new Array(cs.length).fill(0);
  if (cs.length <= period) return adx;
  for (let i = 1; i <= period; i++) { smoothTR[period] += tr[i]; smoothPDM[period] += plusDM[i]; smoothMDM[period] += minusDM[i]; }
  for (let i = period + 1; i < cs.length; i++) {
    smoothTR[i] = smoothTR[i-1] - smoothTR[i-1] / period + tr[i];
    smoothPDM[i] = smoothPDM[i-1] - smoothPDM[i-1] / period + plusDM[i];
    smoothMDM[i] = smoothMDM[i-1] - smoothMDM[i-1] / period + minusDM[i];
  }
  const dx = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    if (smoothTR[i] === 0) continue;
    const pdi = 100 * smoothPDM[i] / smoothTR[i];
    const mdi = 100 * smoothMDM[i] / smoothTR[i];
    dx[i] = pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
  }
  if (cs.length <= 2 * period) return adx;
  let adxSum = 0;
  for (let i = period; i < 2 * period; i++) adxSum += dx[i];
  adx[2 * period - 1] = adxSum / period;
  for (let i = 2 * period; i < cs.length; i++) {
    adx[i] = (adx[i-1] * (period - 1) + dx[i]) / period;
  }
  return adx;
}

function donchianHigh(cs: C[], idx: number, lookback: number): number {
  let max = -Infinity;
  for (let i = Math.max(0, idx - lookback); i < idx; i++) max = Math.max(max, cs[i].h);
  return max;
}

function donchianLow(cs: C[], idx: number, lookback: number): number {
  let min = Infinity;
  for (let i = Math.max(0, idx - lookback); i < idx; i++) min = Math.min(min, cs[i].l);
  return min;
}

// ─── BTC Realized Volatility (20d annualized) ──────────────────────
function calcBtcRealizedVol(cs: C[], window: number): number[] {
  // 20-day realized vol = annualized std of daily log returns
  const rv = new Array(cs.length).fill(0);
  for (let i = window; i < cs.length; i++) {
    const rets: number[] = [];
    for (let j = i - window + 1; j <= i; j++) {
      rets.push(Math.log(cs[j].c / cs[j-1].c));
    }
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    rv[i] = Math.sqrt(variance) * Math.sqrt(365) * 100; // annualized, percentage
  }
  return rv;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean, size: number): number {
  const notional = size * LEV;
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = notional * FEE * 2;
  const rawPnl = dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional;
  return rawPnl - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number; dd: number;
  total: number; perDay: number;
}

function calcMetrics(trades: Tr[]): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  let peak = 0, equity = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const firstT = Math.min(...trades.map(t => t.et));
  const lastT = Math.max(...trades.map(t => t.xt));
  const days = (lastT - firstT) / DAY;

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

// ─── Regime type for BTC vol ────────────────────────────────────────
type VolRegime = "low" | "medium" | "high";

function getBtcVolRegime(rv: number): VolRegime {
  if (rv < 40) return "low";
  if (rv <= 80) return "medium";
  return "high";
}

// ─── Strategy Runner ────────────────────────────────────────────────
interface StrategyConfig {
  name: string;
  // For each bar, return entryLB, exitLB, atrMult, size (or null to skip)
  getParams: (
    pair: string,
    barIdx: number,
    pairDaily: C[],
    pairATR14: number[],
    pairATR50: number[],
    pairADX: number[],
    btcRV: number[], // btc realized vol array indexed by btc bar idx
    btcTimeMap: Map<number, number>,
    allATR14: Map<string, number[]>, // for inv-vol sizing
    allDaily: Map<string, C[]>,
  ) => { entryLB: number; exitLB: number; atrMult: number; size: number } | null;
}

function runStrategy(
  config: StrategyConfig,
  tradingPairs: string[],
  dailyData: Map<string, C[]>,
  btcDaily: C[],
  btcEma20: number[],
  btcEma50: number[],
  btcTimeMap: Map<number, number>,
  btcRV: number[],
  allATR14: Map<string, number[]>,
  allATR50: Map<string, number[]>,
  allADX: Map<string, number[]>,
): Tr[] {
  const trades: Tr[] = [];

  const getBtcTrend = (t: number): "long"|"short"|null => {
    const bi = btcTimeMap.get(t);
    if (bi === undefined || bi < 50) return null;
    if (btcEma20[bi] === 0 || btcEma50[bi] === 0) return null;
    return btcEma20[bi] > btcEma50[bi] ? "long" : "short";
  };

  for (const pair of tradingPairs) {
    if (pair === "BTC") continue;
    const cs = dailyData.get(pair);
    if (!cs || cs.length < 60) continue;
    const atr14 = allATR14.get(pair);
    const atr50 = allATR50.get(pair);
    const adx = allADX.get(pair);
    if (!atr14 || !atr50 || !adx) continue;

    let pos: Pos | null = null;
    const warmup = 55; // enough for 50d lookback + ADX warmup

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      // Check exit for open position
      if (pos) {
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        // SL check (intraday)
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        // Donchian exit channel: use same exitLB that was active at entry
        // We re-derive params to get exitLB (could store on pos, but simpler to re-derive)
        if (!xp) {
          // Get current params to know exitLB
          const params = config.getParams(pair, i - 1, cs, atr14, atr50, adx, btcRV, btcTimeMap, allATR14, dailyData);
          const exitLB = params ? params.exitLB : 15;
          const exitLow = donchianLow(cs, i, exitLB);
          const exitHigh = donchianHigh(cs, i, exitLB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        // Max hold
        if (!xp && barsHeld >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          if (bar.t >= OOS_START && bar.t < OOS_END) {
            trades.push({
              pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
              pnl: tradePnl(pair, pos.ep, xp, pos.dir, reason === "stop-loss", pos.size),
              reason, holdDays: barsHeld, size: pos.size,
            });
          }
          pos = null;
        }
      }

      // Entry signal: signal on day i-1, entry at day i open
      if (!pos && i >= warmup) {
        const params = config.getParams(pair, i - 1, cs, atr14, atr50, adx, btcRV, btcTimeMap, allATR14, dailyData);
        if (!params) continue;

        const { entryLB, exitLB: _exitLB, atrMult, size } = params;
        if (size <= 0) continue;
        if (i - 1 < entryLB) continue;

        const prev = cs[i - 1]; // signal day
        const curATR = atr14[i - 1];
        if (curATR <= 0) continue;

        const dHigh = donchianHigh(cs, i - 1, entryLB);
        const dLow = donchianLow(cs, i - 1, entryLB);

        let dir: "long" | "short" | null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        // BTC trend filter
        const btcTrend = getBtcTrend(bar.t);
        if (!btcTrend || btcTrend !== dir) continue;

        const ep = bar.o; // entry at today's open
        const sl = dir === "long" ? ep - atrMult * curATR : ep + atrMult * curATR;

        pos = { pair, dir, ep, et: bar.t, sl, peak: ep, atrAtEntry: curATR, size };
      }
    }
  }

  return trades;
}

// ─── Print helpers ──────────────────────────────────────────────────
function fmtRow(name: string, m: Metrics, baseline?: Metrics): void {
  const pnlStr = m.total >= 0 ? `+$${m.total.toFixed(1)}` : `-$${Math.abs(m.total).toFixed(1)}`;
  const dayStr = m.perDay >= 0 ? `+$${m.perDay.toFixed(2)}` : `-$${Math.abs(m.perDay).toFixed(2)}`;
  let delta = "";
  if (baseline && baseline.total !== 0) {
    const d = m.total - baseline.total;
    delta = d >= 0 ? ` (+$${d.toFixed(0)})` : ` (-$${Math.abs(d).toFixed(0)})`;
  }
  console.log(
    `${name.padEnd(35)} ${String(m.n).padStart(5)}  ${pnlStr.padStart(10)}  ` +
    `${m.pf === Infinity ? "  Inf" : m.pf.toFixed(2).padStart(5)}  ` +
    `${m.sharpe.toFixed(2).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ` +
    `${dayStr.padStart(7)}  $${m.dd.toFixed(1).padStart(6)}${delta}`
  );
}

function header(): void {
  console.log(
    `${"Strategy".padEnd(35)} ${"Trd".padStart(5)}  ${"PnL".padStart(10)}  ` +
    `${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"WR".padStart(6)}  ` +
    `${"$/day".padStart(7)}  ${"MaxDD".padStart(7)}`
  );
  console.log("-".repeat(100));
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("Loading and aggregating 5m candles to daily...\n");

  const dailyData = new Map<string, C[]>();
  for (const pair of ALL_PAIRS) {
    const raw = load5m(pair);
    if (raw.length === 0) { console.log(`  SKIP ${pair} (no data)`); continue; }
    const daily = aggregateToDaily(raw);
    dailyData.set(pair, daily);
    console.log(`  ${pair}: ${raw.length} 5m -> ${daily.length} daily bars`);
  }

  const btcDaily = dailyData.get("BTC");
  if (!btcDaily) { console.log("ERROR: no BTC data"); return; }

  // Pre-compute BTC indicators
  const btcCloses = btcDaily.map(c => c.c);
  const btcEma20 = calcEMA(btcCloses, 20);
  const btcEma50 = calcEMA(btcCloses, 50);
  const btcTimeMap = new Map<number, number>();
  btcDaily.forEach((c, i) => btcTimeMap.set(c.t, i));
  const btcRV = calcBtcRealizedVol(btcDaily, 20);

  // Pre-compute all pair indicators
  const allATR14 = new Map<string, number[]>();
  const allATR50 = new Map<string, number[]>();
  const allADX = new Map<string, number[]>();
  for (const [pair, cs] of dailyData) {
    allATR14.set(pair, calcATR(cs, 14));
    allATR50.set(pair, calcATR(cs, 50));
    allADX.set(pair, calcADX(cs, 14));
  }

  const tradingPairs = ALL_PAIRS.filter(p => p !== "BTC");
  const oosDays = (OOS_END - OOS_START) / DAY;

  console.log(`\nOOS period: 2025-09-01 to 2026-03-26 (${oosDays.toFixed(0)} days)`);
  console.log(`Cost: ${FEE * 100}% taker/side, spread map, 1.5x spread slip on SL, 10x lev`);
  console.log(`BTC trend filter: EMA(20) > EMA(50) for longs, < for shorts`);
  console.log(`Anti-look-ahead: signal on day i-1, entry at day i open\n`);

  // ═════════════════════════════════════════════════════════════════
  // STRATEGY 0: BASELINE (fixed 30d/15d/ATRx3, $10 size)
  // ═════════════════════════════════════════════════════════════════
  const baselineConfig: StrategyConfig = {
    name: "Baseline (30d/15d/ATRx3/$10)",
    getParams: () => ({ entryLB: 30, exitLB: 15, atrMult: 3.0, size: 10 }),
  };

  // ═════════════════════════════════════════════════════════════════
  // STRATEGY 1: BTC Volatility Regime
  // ═════════════════════════════════════════════════════════════════
  const btcVolRegimeConfig: StrategyConfig = {
    name: "BTC Vol Regime",
    getParams: (_pair, barIdx, pairDaily, _a14, _a50, _adx, btcRVArr, btcTM) => {
      const t = pairDaily[barIdx].t;
      const bi = btcTM.get(t);
      if (bi === undefined || bi < 20) return { entryLB: 30, exitLB: 15, atrMult: 3.0, size: 10 };
      const rv = btcRVArr[bi];
      const regime = getBtcVolRegime(rv);
      switch (regime) {
        case "low":    return { entryLB: 40, exitLB: 20, atrMult: 3.5, size: 10 };
        case "medium": return { entryLB: 30, exitLB: 15, atrMult: 3.0, size: 10 };
        case "high":   return { entryLB: 20, exitLB: 10, atrMult: 2.5, size: 10 };
      }
    },
  };

  // ═════════════════════════════════════════════════════════════════
  // STRATEGY 2: ATR-Ratio Regime (per-pair)
  // ═════════════════════════════════════════════════════════════════
  const atrRatioConfig: StrategyConfig = {
    name: "ATR-Ratio Regime",
    getParams: (_pair, barIdx, _pairDaily, pairA14, pairA50) => {
      const a14 = pairA14[barIdx];
      const a50 = pairA50[barIdx];
      if (!a14 || !a50 || a50 <= 0) return { entryLB: 30, exitLB: 15, atrMult: 3.0, size: 10 };
      const ratio = a14 / a50;
      if (ratio > 1.2) {
        // Expanding vol: shorter lookback, tighter stops
        return { entryLB: 20, exitLB: 10, atrMult: 2.5, size: 10 };
      } else if (ratio < 0.8) {
        // Contracting vol: longer lookback, wider stops
        return { entryLB: 40, exitLB: 20, atrMult: 3.5, size: 10 };
      } else {
        return { entryLB: 30, exitLB: 15, atrMult: 3.0, size: 10 };
      }
    },
  };

  // ═════════════════════════════════════════════════════════════════
  // STRATEGY 3: ADX Trend Strength Sizing
  // ═════════════════════════════════════════════════════════════════
  const adxSizingConfig: StrategyConfig = {
    name: "ADX Trend Sizing",
    getParams: (_pair, barIdx, _pairDaily, _a14, _a50, pairADX) => {
      const adxVal = pairADX[barIdx];
      if (adxVal > 30) return { entryLB: 30, exitLB: 15, atrMult: 3.0, size: 10 };
      if (adxVal >= 20) return { entryLB: 30, exitLB: 15, atrMult: 3.0, size: 5 };
      return null; // ADX < 20: skip
    },
  };

  // ═════════════════════════════════════════════════════════════════
  // STRATEGY 4: Inverse Volatility Position Sizing
  // ═════════════════════════════════════════════════════════════════
  const invVolSizingConfig: StrategyConfig = {
    name: "Inverse Vol Sizing",
    getParams: (pair, barIdx, pairDaily, _a14, _a50, _adx, _btcRV, _btcTM, allA14Map, allDailyMap) => {
      // Get current ATR for this pair
      const pairATR = allA14Map.get(pair);
      if (!pairATR) return { entryLB: 30, exitLB: 15, atrMult: 3.0, size: 10 };
      const myATR = pairATR[barIdx];
      if (!myATR || myATR <= 0) return { entryLB: 30, exitLB: 15, atrMult: 3.0, size: 10 };

      // Get ATR as % of price for this pair
      const myPrice = pairDaily[barIdx].c;
      const myATRpct = myATR / myPrice;

      // Compute median ATR% across all pairs at this timestamp
      const t = pairDaily[barIdx].t;
      const atrPcts: number[] = [];
      for (const [p, cs] of allDailyMap) {
        if (p === "BTC") continue;
        const pATR = allA14Map.get(p);
        if (!pATR) continue;
        // Find bar index for this pair at same timestamp
        for (let j = 0; j < cs.length; j++) {
          if (cs[j].t === t && pATR[j] > 0) {
            atrPcts.push(pATR[j] / cs[j].c);
            break;
          }
        }
      }

      if (atrPcts.length === 0) return { entryLB: 30, exitLB: 15, atrMult: 3.0, size: 10 };
      atrPcts.sort((a, b) => a - b);
      const medianATRpct = atrPcts[Math.floor(atrPcts.length / 2)];

      // Size inversely: base * (median / pair_ATR%), cap $20, floor $5
      let size = 10 * (medianATRpct / myATRpct);
      size = Math.max(5, Math.min(20, size));
      size = Math.round(size * 2) / 2; // round to nearest $0.50

      return { entryLB: 30, exitLB: 15, atrMult: 3.0, size };
    },
  };

  // ═════════════════════════════════════════════════════════════════
  // COMBINED: BTC Vol Regime + ADX Sizing
  // ═════════════════════════════════════════════════════════════════
  const btcVolAdxConfig: StrategyConfig = {
    name: "BTC Vol + ADX Sizing",
    getParams: (pair, barIdx, pairDaily, a14, a50, pairADX, btcRVArr, btcTM) => {
      // ADX gate first
      const adxVal = pairADX[barIdx];
      if (adxVal < 20) return null;
      const size = adxVal > 30 ? 10 : 5;

      // BTC vol regime for params
      const t = pairDaily[barIdx].t;
      const bi = btcTM.get(t);
      if (bi === undefined || bi < 20) return { entryLB: 30, exitLB: 15, atrMult: 3.0, size };
      const rv = btcRVArr[bi];
      const regime = getBtcVolRegime(rv);
      switch (regime) {
        case "low":    return { entryLB: 40, exitLB: 20, atrMult: 3.5, size };
        case "medium": return { entryLB: 30, exitLB: 15, atrMult: 3.0, size };
        case "high":   return { entryLB: 20, exitLB: 10, atrMult: 2.5, size };
      }
    },
  };

  // ═════════════════════════════════════════════════════════════════
  // COMBINED: BTC Vol Regime + Inverse Vol Sizing
  // ═════════════════════════════════════════════════════════════════
  const btcVolInvVolConfig: StrategyConfig = {
    name: "BTC Vol + Inv Vol Sizing",
    getParams: (pair, barIdx, pairDaily, a14, a50, _adx, btcRVArr, btcTM, allA14Map, allDailyMap) => {
      // BTC vol regime for entry/exit params
      const t = pairDaily[barIdx].t;
      const bi = btcTM.get(t);
      let entryLB = 30, exitLB = 15, atrMult = 3.0;
      if (bi !== undefined && bi >= 20) {
        const rv = btcRVArr[bi];
        const regime = getBtcVolRegime(rv);
        switch (regime) {
          case "low":    entryLB = 40; exitLB = 20; atrMult = 3.5; break;
          case "medium": break;
          case "high":   entryLB = 20; exitLB = 10; atrMult = 2.5; break;
        }
      }

      // Inv vol sizing
      const pairATR = allA14Map.get(pair);
      if (!pairATR) return { entryLB, exitLB, atrMult, size: 10 };
      const myATR = pairATR[barIdx];
      if (!myATR || myATR <= 0) return { entryLB, exitLB, atrMult, size: 10 };
      const myPrice = pairDaily[barIdx].c;
      const myATRpct = myATR / myPrice;

      const atrPcts: number[] = [];
      for (const [p, cs] of allDailyMap) {
        if (p === "BTC") continue;
        const pATR = allA14Map.get(p);
        if (!pATR) continue;
        for (let j = 0; j < cs.length; j++) {
          if (cs[j].t === t && pATR[j] > 0) {
            atrPcts.push(pATR[j] / cs[j].c);
            break;
          }
        }
      }
      if (atrPcts.length === 0) return { entryLB, exitLB, atrMult, size: 10 };
      atrPcts.sort((a, b) => a - b);
      const medianATRpct = atrPcts[Math.floor(atrPcts.length / 2)];
      let size = 10 * (medianATRpct / myATRpct);
      size = Math.max(5, Math.min(20, Math.round(size * 2) / 2));

      return { entryLB, exitLB, atrMult, size };
    },
  };

  // ═════════════════════════════════════════════════════════════════
  // COMBINED: ATR-Ratio Regime + ADX Sizing
  // ═════════════════════════════════════════════════════════════════
  const atrRatioAdxConfig: StrategyConfig = {
    name: "ATR-Ratio + ADX Sizing",
    getParams: (_pair, barIdx, _pairDaily, pairA14, pairA50, pairADX) => {
      const adxVal = pairADX[barIdx];
      if (adxVal < 20) return null;
      const size = adxVal > 30 ? 10 : 5;

      const a14 = pairA14[barIdx];
      const a50 = pairA50[barIdx];
      if (!a14 || !a50 || a50 <= 0) return { entryLB: 30, exitLB: 15, atrMult: 3.0, size };
      const ratio = a14 / a50;
      if (ratio > 1.2) return { entryLB: 20, exitLB: 10, atrMult: 2.5, size };
      if (ratio < 0.8) return { entryLB: 40, exitLB: 20, atrMult: 3.5, size };
      return { entryLB: 30, exitLB: 15, atrMult: 3.0, size };
    },
  };

  // Run all strategies
  const strategies: StrategyConfig[] = [
    baselineConfig,
    btcVolRegimeConfig,
    atrRatioConfig,
    adxSizingConfig,
    invVolSizingConfig,
    btcVolAdxConfig,
    btcVolInvVolConfig,
    atrRatioAdxConfig,
  ];

  interface Result { name: string; m: Metrics; trades: Tr[]; }
  const results: Result[] = [];

  console.log("Running strategies...\n");

  for (const config of strategies) {
    const trades = runStrategy(
      config, tradingPairs, dailyData, btcDaily,
      btcEma20, btcEma50, btcTimeMap, btcRV,
      allATR14, allATR50, allADX,
    );
    const m = calcMetrics(trades);
    results.push({ name: config.name, m, trades });
    console.log(`  ${config.name}: ${trades.length} trades`);
  }

  // ═════════════════════════════════════════════════════════════════
  // RESULTS COMPARISON
  // ═════════════════════════════════════════════════════════════════
  const baseM = results[0].m;

  console.log(`\n${"=".repeat(100)}`);
  console.log("REGIME-ADAPTIVE DONCHIAN: ALL APPROACHES COMPARED");
  console.log(`${"=".repeat(100)}`);
  header();
  for (const r of results) {
    fmtRow(r.name, r.m, r.name === baselineConfig.name ? undefined : baseM);
  }

  // ═════════════════════════════════════════════════════════════════
  // BTC VOL REGIME BREAKDOWN
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(100)}`);
  console.log("BTC VOLATILITY REGIME DISTRIBUTION (OOS period)");
  console.log(`${"=".repeat(100)}`);

  let lowDays = 0, medDays = 0, highDays = 0;
  for (let i = 0; i < btcDaily.length; i++) {
    if (btcDaily[i].t < OOS_START || btcDaily[i].t >= OOS_END) continue;
    const rv = btcRV[i];
    const regime = getBtcVolRegime(rv);
    if (regime === "low") lowDays++;
    else if (regime === "medium") medDays++;
    else highDays++;
  }
  const totalRegimeDays = lowDays + medDays + highDays;
  console.log(`\n  Low vol  (<40%):  ${lowDays} days (${(lowDays/totalRegimeDays*100).toFixed(1)}%) -> 40d entry, 20d exit, ATRx3.5`);
  console.log(`  Med vol  (40-80%): ${medDays} days (${(medDays/totalRegimeDays*100).toFixed(1)}%) -> 30d entry, 15d exit, ATRx3`);
  console.log(`  High vol (>80%):  ${highDays} days (${(highDays/totalRegimeDays*100).toFixed(1)}%) -> 20d entry, 10d exit, ATRx2.5`);

  // Show BTC RV stats
  const oosRVs: number[] = [];
  for (let i = 0; i < btcDaily.length; i++) {
    if (btcDaily[i].t >= OOS_START && btcDaily[i].t < OOS_END && btcRV[i] > 0) {
      oosRVs.push(btcRV[i]);
    }
  }
  oosRVs.sort((a, b) => a - b);
  const rvMin = oosRVs[0];
  const rvMax = oosRVs[oosRVs.length - 1];
  const rvMedian = oosRVs[Math.floor(oosRVs.length / 2)];
  const rvMean = oosRVs.reduce((s, v) => s + v, 0) / oosRVs.length;
  console.log(`\n  BTC 20d RV stats: min=${rvMin.toFixed(1)}%, median=${rvMedian.toFixed(1)}%, mean=${rvMean.toFixed(1)}%, max=${rvMax.toFixed(1)}%`);

  // ═════════════════════════════════════════════════════════════════
  // PER-REGIME TRADE BREAKDOWN (BTC Vol strategy)
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(100)}`);
  console.log("BTC VOL REGIME: TRADES BY REGIME AT ENTRY");
  console.log(`${"=".repeat(100)}`);

  const btcVolTrades = results[1].trades;
  const tradesByRegime: Record<VolRegime, Tr[]> = { low: [], medium: [], high: [] };
  for (const tr of btcVolTrades) {
    const bi = btcTimeMap.get(Math.floor(tr.et / DAY) * DAY);
    if (bi === undefined) continue;
    const rv = btcRV[bi];
    const regime = getBtcVolRegime(rv);
    tradesByRegime[regime].push(tr);
  }

  console.log(`\n${"Regime".padEnd(12)} ${"Trd".padStart(5)}  ${"PnL".padStart(10)}  ${"PF".padStart(5)}  ${"WR".padStart(6)}  ${"AvgPnl".padStart(8)}`);
  console.log("-".repeat(55));
  for (const regime of ["low", "medium", "high"] as VolRegime[]) {
    const rTrades = tradesByRegime[regime];
    if (rTrades.length === 0) { console.log(`${regime.padEnd(12)}     0`); continue; }
    const wins = rTrades.filter(t => t.pnl > 0).length;
    const pnl = rTrades.reduce((s, t) => s + t.pnl, 0);
    const gp = rTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(rTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(1)}` : `-$${Math.abs(pnl).toFixed(1)}`;
    const avgStr = (pnl / rTrades.length) >= 0 ? `+$${(pnl / rTrades.length).toFixed(2)}` : `-$${Math.abs(pnl / rTrades.length).toFixed(2)}`;
    console.log(`${regime.padEnd(12)} ${String(rTrades.length).padStart(5)}  ${pnlStr.padStart(10)}  ${pf.toFixed(2).padStart(5)}  ${(wins/rTrades.length*100).toFixed(1).padStart(5)}%  ${avgStr.padStart(8)}`);
  }

  // ═════════════════════════════════════════════════════════════════
  // ATR RATIO REGIME BREAKDOWN
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(100)}`);
  console.log("ATR-RATIO REGIME: TRADES BY REGIME AT ENTRY");
  console.log(`${"=".repeat(100)}`);

  const atrRatioTrades = results[2].trades;
  const atrRegimes: Record<string, Tr[]> = { expanding: [], normal: [], contracting: [] };
  for (const tr of atrRatioTrades) {
    const a14 = allATR14.get(tr.pair);
    const a50 = allATR50.get(tr.pair);
    const cs = dailyData.get(tr.pair);
    if (!a14 || !a50 || !cs) continue;
    // Find the bar index at entry
    let entryIdx = -1;
    for (let j = 0; j < cs.length; j++) {
      if (cs[j].t === tr.et) { entryIdx = j; break; }
    }
    if (entryIdx < 0) continue;
    const ratio = a50[entryIdx] > 0 ? a14[entryIdx] / a50[entryIdx] : 1;
    if (ratio > 1.2) atrRegimes.expanding.push(tr);
    else if (ratio < 0.8) atrRegimes.contracting.push(tr);
    else atrRegimes.normal.push(tr);
  }

  console.log(`\n${"Regime".padEnd(14)} ${"Params".padEnd(22)} ${"Trd".padStart(5)}  ${"PnL".padStart(10)}  ${"PF".padStart(5)}  ${"WR".padStart(6)}  ${"AvgPnl".padStart(8)}`);
  console.log("-".repeat(80));
  for (const [regime, params] of [["expanding", "20d/10d/ATRx2.5"], ["normal", "30d/15d/ATRx3"], ["contracting", "40d/20d/ATRx3.5"]] as const) {
    const rTrades = atrRegimes[regime];
    if (rTrades.length === 0) { console.log(`${regime.padEnd(14)} ${params.padEnd(22)}     0`); continue; }
    const wins = rTrades.filter(t => t.pnl > 0).length;
    const pnl = rTrades.reduce((s, t) => s + t.pnl, 0);
    const gp = rTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(rTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(1)}` : `-$${Math.abs(pnl).toFixed(1)}`;
    const avgStr = (pnl / rTrades.length) >= 0 ? `+$${(pnl / rTrades.length).toFixed(2)}` : `-$${Math.abs(pnl / rTrades.length).toFixed(2)}`;
    console.log(`${regime.padEnd(14)} ${params.padEnd(22)} ${String(rTrades.length).padStart(5)}  ${pnlStr.padStart(10)}  ${pf.toFixed(2).padStart(5)}  ${(wins/rTrades.length*100).toFixed(1).padStart(5)}%  ${avgStr.padStart(8)}`);
  }

  // ═════════════════════════════════════════════════════════════════
  // ADX SIZING BREAKDOWN
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(100)}`);
  console.log("ADX TREND SIZING: TRADES BY ADX BUCKET");
  console.log(`${"=".repeat(100)}`);

  const adxTrades = results[3].trades;
  const adxBuckets: Record<string, Tr[]> = { "full ($10, ADX>30)": [], "half ($5, ADX 20-30)": [] };
  for (const tr of adxTrades) {
    if (tr.size >= 10) adxBuckets["full ($10, ADX>30)"].push(tr);
    else adxBuckets["half ($5, ADX 20-30)"].push(tr);
  }

  console.log(`\n${"Bucket".padEnd(25)} ${"Trd".padStart(5)}  ${"PnL".padStart(10)}  ${"PF".padStart(5)}  ${"WR".padStart(6)}  ${"AvgPnl".padStart(8)}`);
  console.log("-".repeat(65));
  for (const [bucket, bTrades] of Object.entries(adxBuckets)) {
    if (bTrades.length === 0) { console.log(`${bucket.padEnd(25)}     0`); continue; }
    const wins = bTrades.filter(t => t.pnl > 0).length;
    const pnl = bTrades.reduce((s, t) => s + t.pnl, 0);
    const gp = bTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(bTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(1)}` : `-$${Math.abs(pnl).toFixed(1)}`;
    const avgStr = (pnl / bTrades.length) >= 0 ? `+$${(pnl / bTrades.length).toFixed(2)}` : `-$${Math.abs(pnl / bTrades.length).toFixed(2)}`;
    console.log(`${bucket.padEnd(25)} ${String(bTrades.length).padStart(5)}  ${pnlStr.padStart(10)}  ${pf.toFixed(2).padStart(5)}  ${(wins/bTrades.length*100).toFixed(1).padStart(5)}%  ${avgStr.padStart(8)}`);
  }

  // ═════════════════════════════════════════════════════════════════
  // INV VOL SIZING BREAKDOWN
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(100)}`);
  console.log("INVERSE VOL SIZING: SIZE DISTRIBUTION");
  console.log(`${"=".repeat(100)}`);

  const invVolTrades = results[4].trades;
  const sizeBuckets = new Map<number, { count: number; pnl: number; wins: number }>();
  for (const tr of invVolTrades) {
    const sz = tr.size;
    const v = sizeBuckets.get(sz) ?? { count: 0, pnl: 0, wins: 0 };
    v.count++; v.pnl += tr.pnl; if (tr.pnl > 0) v.wins++;
    sizeBuckets.set(sz, v);
  }

  console.log(`\n${"Size".padEnd(8)} ${"Trd".padStart(5)}  ${"PnL".padStart(10)}  ${"WR".padStart(6)}  ${"AvgPnl".padStart(8)}`);
  console.log("-".repeat(45));
  for (const [sz, v] of [...sizeBuckets.entries()].sort((a, b) => a[0] - b[0])) {
    const pnlStr = v.pnl >= 0 ? `+$${v.pnl.toFixed(1)}` : `-$${Math.abs(v.pnl).toFixed(1)}`;
    const avgStr = (v.pnl / v.count) >= 0 ? `+$${(v.pnl / v.count).toFixed(2)}` : `-$${Math.abs(v.pnl / v.count).toFixed(2)}`;
    console.log(`$${sz.toFixed(1).padEnd(7)} ${String(v.count).padStart(5)}  ${pnlStr.padStart(10)}  ${(v.wins/v.count*100).toFixed(1).padStart(5)}%  ${avgStr.padStart(8)}`);
  }

  // ═════════════════════════════════════════════════════════════════
  // MONTHLY BREAKDOWN FOR TOP 3
  // ═════════════════════════════════════════════════════════════════
  const sorted = [...results].sort((a, b) => b.m.perDay - a.m.perDay);

  console.log(`\n${"=".repeat(100)}`);
  console.log("MONTHLY BREAKDOWN: TOP 3 STRATEGIES BY $/day");
  console.log(`${"=".repeat(100)}`);

  for (let rank = 0; rank < Math.min(3, sorted.length); rank++) {
    const r = sorted[rank];
    console.log(`\n--- #${rank + 1}: ${r.name} ---`);
    console.log(`${"Month".padEnd(10)} ${"Trades".padStart(6)}  ${"PnL".padStart(10)}  ${"WR".padStart(6)}`);
    console.log("-".repeat(40));

    const monthly = new Map<string, { trades: number; pnl: number; wins: number }>();
    for (const t of r.trades) {
      const m = new Date(t.xt).toISOString().slice(0, 7);
      const v = monthly.get(m) ?? { trades: 0, pnl: 0, wins: 0 };
      v.trades++; v.pnl += t.pnl; if (t.pnl > 0) v.wins++;
      monthly.set(m, v);
    }
    for (const [m, v] of [...monthly.entries()].sort()) {
      const pStr = v.pnl >= 0 ? `+$${v.pnl.toFixed(1)}` : `-$${Math.abs(v.pnl).toFixed(1)}`;
      console.log(`${m.padEnd(10)} ${String(v.trades).padStart(6)}  ${pStr.padStart(10)}  ${(v.wins / v.trades * 100).toFixed(0).padStart(5)}%`);
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // EXIT REASON BREAKDOWN FOR BEST
  // ═════════════════════════════════════════════════════════════════
  const best = sorted[0];
  console.log(`\n${"=".repeat(100)}`);
  console.log(`BEST STRATEGY: ${best.name}`);
  console.log(`${"=".repeat(100)}`);
  console.log(`Trades: ${best.m.n} | PnL: $${best.m.total.toFixed(2)} | PF: ${best.m.pf.toFixed(2)} | Sharpe: ${best.m.sharpe.toFixed(2)} | WR: ${best.m.wr.toFixed(1)}% | $/day: $${best.m.perDay.toFixed(2)} | MaxDD: $${best.m.dd.toFixed(2)}`);

  const reasons = new Map<string, { count: number; pnl: number }>();
  for (const t of best.trades) {
    const r = reasons.get(t.reason) ?? { count: 0, pnl: 0 };
    r.count++; r.pnl += t.pnl;
    reasons.set(t.reason, r);
  }
  console.log(`\nExit reason breakdown:`);
  console.log(`${"Reason".padEnd(16)} ${"Count".padStart(6)}  ${"PnL".padStart(10)}  ${"Avg".padStart(8)}`);
  for (const [reason, r] of [...reasons.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    const pStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(1)}` : `-$${Math.abs(r.pnl).toFixed(1)}`;
    const avgStr = (r.pnl / r.count) >= 0 ? `+$${(r.pnl / r.count).toFixed(2)}` : `-$${Math.abs(r.pnl / r.count).toFixed(2)}`;
    console.log(`${reason.padEnd(16)} ${String(r.count).padStart(6)}  ${pStr.padStart(10)}  ${avgStr.padStart(8)}`);
  }

  // Direction breakdown
  const longs = best.trades.filter(t => t.dir === "long");
  const shorts = best.trades.filter(t => t.dir === "short");
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  console.log(`\nDirection: Longs ${longs.length} trades, PnL $${longPnl.toFixed(1)} | Shorts ${shorts.length} trades, PnL $${shortPnl.toFixed(1)}`);
  const avgHold = best.trades.reduce((s, t) => s + t.holdDays, 0) / best.trades.length;
  console.log(`Average hold: ${avgHold.toFixed(1)} days`);

  // ═════════════════════════════════════════════════════════════════
  // FINAL RANKING
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(100)}`);
  console.log("FINAL RANKING BY $/day");
  console.log(`${"=".repeat(100)}`);
  header();
  for (const r of sorted) {
    fmtRow(r.name, r.m, r.name === baselineConfig.name ? undefined : baseM);
  }
}

main();
