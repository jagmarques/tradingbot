/**
 * Corrected Regime Backtest - Fixes 5 bugs from bt-full-regime-system.ts / bt-regime-investigation.ts
 *
 * BUGS FIXED:
 * 1. Stagnation: Donchian=60d, Supertrend=60d, Carry=8d (not 48h for all)
 * 2. Spread: applied to entry/exit prices only, no double-counting
 * 3. Carry engine: funding proxy (close-open)/close * 0.05, rank + momentum filter (matches bt-engine-combos.ts)
 * 4. Donchian entry: SMA 20/50 CROSSOVER only (golden/death cross), NOT trend+breakout
 * 5. Donchian channel: uses CLOSES, not highs/lows
 *
 * Configs: A(baseline), B(+regime dir), C(+regime dir+size), D(+extra engines in specific regimes)
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-regime-corrected.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const SL_SLIPPAGE = 1.5;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, AVAX: 2.55e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const WANTED_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";
type Regime = "RISK_OFF" | "RECOVERY" | "RISK_ON" | "CORRECTION";

interface Position {
  pair: string; engine: string; dir: Dir;
  ep: number; et: number; sl: number; tp: number;
  margin: number; lev: number; maxHold: number;
  atr: number; bestPnlAtr: number;
}

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number; margin: number;
}

interface RegimeConfig {
  label: string;
  engines: string[];
  maxPositions: number;
  sizes: Record<string, number>;
  useRegime: boolean;
  regimeDir: boolean;          // apply direction bias per regime
  regimeSize: boolean;         // apply size multiplier per regime
  extraRegimeEngines: boolean; // GARCH in RISK_OFF, Alt Rotation in RISK_ON
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(candles: C[], period: number): Bar[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const bars: Bar[] = [];
  for (const [t, cs] of groups) {
    if (cs.length === 0) continue;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of cs) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
      vol += c.v;
    }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c, v: vol });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators ─────────────────────────────────────────────────────
function sma(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) r[i] = sum / period;
  }
  return r;
}

function ema(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  let v = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i === 0) { v = vals[i]; }
    else { v = vals[i] * k + v * (1 - k); }
    if (i >= period - 1) r[i] = v;
  }
  return r;
}

function atrFn(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c)
        );
    trs.push(tr);
  }
  let val = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      val += trs[i];
      if (i === period - 1) { val /= period; r[i] = val; }
    } else {
      val = (val * (period - 1) + trs[i]) / period;
      r[i] = val;
    }
  }
  return r;
}

// BUG FIX #5: Donchian channel uses CLOSES, not highs/lows
function donchianHigh(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mx = -Infinity;
    for (let j = i - period; j < i; j++) mx = Math.max(mx, closes[j]);
    r[i] = mx;
  }
  return r;
}

function donchianLow(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mn = Infinity;
    for (let j = i - period; j < i; j++) mn = Math.min(mn, closes[j]);
    r[i] = mn;
  }
  return r;
}

function supertrend(bars: Bar[], atrPeriod: number, mult: number): { trend: (1 | -1 | null)[] } {
  const atrVals = atrFn(bars, atrPeriod);
  const trend: (1 | -1 | null)[] = new Array(bars.length).fill(null);
  let upperBand = 0, lowerBand = 0, prevTrend = 1;

  for (let i = 0; i < bars.length; i++) {
    const a = atrVals[i];
    if (a === null) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let ub = hl2 + mult * a;
    let lb = hl2 - mult * a;

    if (i > 0 && atrVals[i - 1] !== null) {
      if (lb > lowerBand || bars[i - 1].c < lowerBand) { /* keep lb */ } else lb = lowerBand;
      if (ub < upperBand || bars[i - 1].c > upperBand) { /* keep ub */ } else ub = upperBand;
    }

    let t: 1 | -1;
    if (prevTrend === 1) {
      t = bars[i].c < lowerBand ? -1 : 1;
    } else {
      t = bars[i].c > upperBand ? 1 : -1;
    }

    upperBand = ub;
    lowerBand = lb;
    prevTrend = t;
    trend[i] = t;
  }
  return { trend };
}

function zScore(closes: number[], retLag: number, lookback: number): number[] {
  const r = new Array(closes.length).fill(0);
  for (let i = retLag + lookback; i < closes.length; i++) {
    const ret = closes[i] / closes[i - retLag] - 1;
    let sum = 0, sum2 = 0, n = 0;
    for (let j = i - lookback + 1; j <= i; j++) {
      const rr = closes[j] / closes[j - 1] - 1;
      sum += rr; sum2 += rr * rr; n++;
    }
    if (n < 10) continue;
    const mean = sum / n;
    const variance = sum2 / n - mean * mean;
    const std = Math.sqrt(Math.max(0, variance));
    if (std > 0) r[i] = ret / std;
  }
  return r;
}

// ─── Data Prep ──────────────────────────────────────────────────────
interface PairData {
  m5: C[]; h1: Bar[]; h4: Bar[]; daily: Bar[]; weekly: Bar[];
  h1Map: Map<number, number>; h4Map: Map<number, number>; dailyMap: Map<number, number>;
}

interface BTCData {
  daily: Bar[]; h1: Bar[]; h4: Bar[];
  dailyEma20: (number | null)[]; dailyEma50: (number | null)[];
  h1Ema9: (number | null)[]; h1Ema21: (number | null)[];
  dailyMap: Map<number, number>; h1Map: Map<number, number>; h4Map: Map<number, number>;
}

function prepBTC(m5: C[]): BTCData {
  const daily = aggregate(m5, DAY);
  const h1 = aggregate(m5, H1);
  const h4 = aggregate(m5, H4);
  const dc = daily.map(b => b.c);
  const hc = h1.map(b => b.c);
  return {
    daily, h1, h4,
    dailyEma20: ema(dc, 20), dailyEma50: ema(dc, 50),
    h1Ema9: ema(hc, 9), h1Ema21: ema(hc, 21),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
    h1Map: new Map(h1.map((b, i) => [b.t, i])),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
  };
}

function prepPair(m5: C[]): PairData {
  const h1 = aggregate(m5, H1);
  const h4 = aggregate(m5, H4);
  const daily = aggregate(m5, DAY);
  const weekly = aggregate(m5, 7 * DAY);
  return {
    m5, h1, h4, daily, weekly,
    h1Map: new Map(h1.map((b, i) => [b.t, i])),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
  };
}

function getBarAtOrBefore(bars: Bar[], t: number, barMap: Map<number, number>, period: number): number {
  const aligned = Math.floor(t / period) * period;
  const idx = barMap.get(aligned);
  if (idx !== undefined) return idx;
  for (let dt = period; dt <= 10 * period; dt += period) {
    const idx2 = barMap.get(aligned - dt);
    if (idx2 !== undefined) return idx2;
  }
  return -1;
}

function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Precomputed Indicators ─────────────────────────────────────────
interface EngAData {
  sma20: (number | null)[]; sma50: (number | null)[];
  donLo15: (number | null)[]; donHi15: (number | null)[];
  atr14: (number | null)[];
}
interface EngBData {
  st: (1 | -1 | null)[]; atr14: (number | null)[];
}
interface EngGARCHData {
  h1z: number[]; h4z: number[];
  h1ema9: (number | null)[]; h1ema21: (number | null)[];
  h1atr14: (number | null)[];
}

// ─── Global data ────────────────────────────────────────────────────
let btcData: BTCData;
let available: string[] = [];
let pairData: Map<string, PairData>;
let engAMap: Map<string, EngAData>;
let engBMap: Map<string, EngBData>;
let engGARCHMap: Map<string, EngGARCHData>;

function loadAllData() {
  console.log("Loading data...");
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }
  btcData = prepBTC(btcRaw);

  pairData = new Map();
  available = [];
  for (const p of WANTED_PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 500) continue;
    available.push(p);
    pairData.set(p, prepPair(m5));
  }
  console.log(`Loaded ${available.length} pairs: ${available.join(", ")}`);

  engAMap = new Map();
  engBMap = new Map();
  engGARCHMap = new Map();

  for (const p of available) {
    const pd = pairData.get(p)!;
    const dc = pd.daily.map(b => b.c); // BUG FIX #5: Donchian on closes

    engAMap.set(p, {
      sma20: sma(dc, 20), sma50: sma(dc, 50),
      donLo15: donchianLow(dc, 15), donHi15: donchianHigh(dc, 15),
      atr14: atrFn(pd.daily, 14),
    });

    engBMap.set(p, {
      st: supertrend(pd.h4, 14, 1.75).trend,
      atr14: atrFn(pd.h4, 14),
    });

    const h1c = pd.h1.map(b => b.c);
    const h4c = pd.h4.map(b => b.c);
    engGARCHMap.set(p, {
      h1z: zScore(h1c, 3, 20), h4z: zScore(h4c, 3, 20),
      h1ema9: ema(h1c, 9), h1ema21: ema(h1c, 21),
      h1atr14: atrFn(pd.h1, 14),
    });
  }
  console.log("Indicators computed.\n");
}

// ─── Regime Classification ──────────────────────────────────────────
// BTC 7-day return: < -3% = declining
// BTC 30d vol+momentum proxy for Fear: <25 = fearful
// RISK_OFF:   declining + fearful
// RECOVERY:   declining + not fearful  (fear resolved, still declining)
// RISK_ON:    not declining + not fearful
// CORRECTION: not declining + fearful   (overbought pullback)

function classifyRegime(t: number): Regime {
  const di = getBarAtOrBefore(btcData.daily, t - DAY, btcData.dailyMap, DAY);
  if (di < 30) return "RISK_ON"; // default when insufficient data

  // 7-day return
  const btc7dRet = di >= 7 ? btcData.daily[di].c / btcData.daily[di - 7].c - 1 : 0;
  const declining = btc7dRet < -0.03;

  // 30d vol+momentum proxy for fear index
  // Use: 30d realized vol (annualized) * 100 as proxy, adjusted by momentum
  // High vol + negative momentum = fear
  let sumRet = 0, sumRet2 = 0;
  const lookback = Math.min(30, di);
  for (let j = di - lookback + 1; j <= di; j++) {
    if (j > 0) {
      const r = Math.log(btcData.daily[j].c / btcData.daily[j - 1].c);
      sumRet += r;
      sumRet2 += r * r;
    }
  }
  const n = lookback;
  const meanRet = sumRet / n;
  const variance = sumRet2 / n - meanRet * meanRet;
  const dailyVol = Math.sqrt(Math.max(0, variance));
  const annualizedVol = dailyVol * Math.sqrt(365) * 100; // percentage

  // 30d momentum
  const btc30dRet = di >= 30 ? btcData.daily[di].c / btcData.daily[di - 30].c - 1 : 0;

  // Fear proxy: high vol (>50%) or negative 30d momentum with vol > 40%
  // Simplified: fear score = annualizedVol - 30d_momentum * 100
  // Fearful if fear score > 25 (i.e., vol is high relative to momentum)
  const fearScore = annualizedVol - btc30dRet * 100;
  const fearful = fearScore < 25; // low fear score = NOT fearful; high = fearful
  // Actually: rethink. User said "BTC 30d vol+momentum proxy for Fear (<25 = fearful)"
  // So the proxy itself is the "fear index". If index < 25, it's fearful.
  // Let's use: fear_index = (1 - annualized_vol/100) * 50 + btc30dRet * 50
  // This gives: low vol + positive momentum = high index (not fearful)
  //             high vol + negative momentum = low index (fearful)
  const fearIndex = (1 - Math.min(annualizedVol / 100, 1)) * 50 + Math.max(-1, Math.min(1, btc30dRet)) * 50;
  const isFearful = fearIndex < 25;

  if (declining && isFearful) return "RISK_OFF";
  if (declining && !isFearful) return "RECOVERY";
  if (!declining && !isFearful) return "RISK_ON";
  return "CORRECTION"; // !declining && isFearful
}

// ─── Regime Filters ─────────────────────────────────────────────────
function regimeAllowsDir(regime: Regime, dir: Dir, config: RegimeConfig): boolean {
  if (!config.regimeDir) return true; // no regime filtering
  switch (regime) {
    case "RISK_OFF": return dir === "short"; // shorts only
    case "RECOVERY": return true;            // both
    case "RISK_ON": return true;             // both
    case "CORRECTION": return true;          // both
  }
}

function regimeSizeMultiplier(regime: Regime, config: RegimeConfig): number {
  if (!config.regimeSize) return 1;
  switch (regime) {
    case "RISK_OFF": return 1.0;
    case "RECOVERY": return 0.75;
    case "RISK_ON": return 1.0;
    case "CORRECTION": return 0.5;
  }
}

// ─── Run Backtest ───────────────────────────────────────────────────
function runBacktest(config: RegimeConfig): Trade[] {
  const MAX_POSITIONS = config.maxPositions;
  const activeEngines = new Set(config.engines);
  const sizes = config.sizes;

  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  let lastCarryRebalance = 0;

  // Track regime distribution
  const regimeCounts = { RISK_OFF: 0, RECOVERY: 0, RISK_ON: 0, CORRECTION: 0 };

  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    dailyTimestamps.push(t);
  }

  function btcBullish(t: number): boolean {
    const di = getBarAtOrBefore(btcData.daily, t - DAY, btcData.dailyMap, DAY);
    if (di < 0) return false;
    const e20 = btcData.dailyEma20[di], e50 = btcData.dailyEma50[di];
    return e20 !== null && e50 !== null && e20 > e50;
  }

  function btcH1Bullish(t: number): boolean {
    const hi = getBarAtOrBefore(btcData.h1, t - H1, btcData.h1Map, H1);
    if (hi < 0) return false;
    const e9 = btcData.h1Ema9[hi], e21 = btcData.h1Ema21[hi];
    return e9 !== null && e21 !== null && e9 > e21;
  }

  function btc30dRet(t: number): number {
    const di = getBarAtOrBefore(btcData.daily, t - DAY, btcData.dailyMap, DAY);
    if (di < 0 || di < 30) return 0;
    return btcData.daily[di].c / btcData.daily[di - 30].c - 1;
  }

  function totalPositions(): number { return positions.size; }
  function positionsForEngine(eng: string): Position[] {
    return [...positions.values()].filter(p => p.engine === eng);
  }

  // BUG FIX #2: Spread applied to entry/exit prices ONLY, no separate deduction
  function closePosition(key: string, exitPrice: number, exitTime: number, slippageMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sp(pos.pair);
    const xp = pos.dir === "long"
      ? exitPrice * (1 - sp_ * slippageMult)
      : exitPrice * (1 + sp_ * slippageMult);
    const notional = pos.margin * pos.lev;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const cost = notional * FEE * 2; // entry + exit fee only
    const pnl = raw - cost;
    // NO additional spread deduction (BUG FIX #2)
    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl, margin: pos.margin,
    });
    positions.delete(key);
  }

  for (const dayT of dailyTimestamps) {
    const regime = classifyRegime(dayT);
    regimeCounts[regime]++;
    const sizeMult = regimeSizeMultiplier(regime, config);

    // ─── CHECK EXISTING POSITIONS ─────────────────────────────────
    for (const [key, pos] of [...positions.entries()]) {
      const pd = pairData.get(pos.pair);
      if (!pd) continue;

      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;
      const bar = pd.daily[di];

      // Stop-loss
      let stopped = false;
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePosition(key, pos.sl, dayT, SL_SLIPPAGE);
        stopped = true;
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        closePosition(key, pos.sl, dayT, SL_SLIPPAGE);
        stopped = true;
      }
      if (stopped) continue;

      // TP (GARCH engine)
      if (pos.tp > 0) {
        if (pos.dir === "long" && bar.h >= pos.tp) {
          closePosition(key, pos.tp, dayT); continue;
        } else if (pos.dir === "short" && bar.l <= pos.tp) {
          closePosition(key, pos.tp, dayT); continue;
        }
      }

      // BUG FIX #1: maxHold per engine (Donchian=60d, Supertrend=60d, Carry=8d)
      if (dayT - pos.et >= pos.maxHold) {
        closePosition(key, bar.c, dayT); continue;
      }

      // Breakeven + ATR trailing ladder
      if (pos.atr > 0) {
        const unrealPnl = pos.dir === "long"
          ? (bar.c - pos.ep) / pos.atr
          : (pos.ep - bar.c) / pos.atr;
        if (unrealPnl > pos.bestPnlAtr) pos.bestPnlAtr = unrealPnl;

        let newSl = pos.sl;
        if (pos.bestPnlAtr >= 3) {
          const trailPrice = pos.dir === "long"
            ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
            : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
          newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
        } else if (pos.bestPnlAtr >= 2) {
          const trailPrice = pos.dir === "long"
            ? bar.h - 2 * pos.atr
            : bar.l + 2 * pos.atr;
          newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
        } else if (pos.bestPnlAtr >= 1) {
          newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
        }
        pos.sl = newSl;
      }

      // Engine-specific exits
      if (pos.engine === "A") {
        const ea = engAMap.get(pos.pair);
        if (ea && di > 0) {
          if (pos.dir === "long" && ea.donLo15[di] !== null && bar.c < ea.donLo15[di]!) {
            closePosition(key, bar.c, dayT); continue;
          }
          if (pos.dir === "short" && ea.donHi15[di] !== null && bar.c > ea.donHi15[di]!) {
            closePosition(key, bar.c, dayT); continue;
          }
        }
      }
    }

    // ─── ENGINE A: Daily Donchian (SMA 20/50 CROSSOVER) ──────────
    // BUG FIX #4: entry on SMA 20/50 crossover ONLY, not trend+breakout
    if (activeEngines.has("A")) {
      for (const p of available) {
        if (totalPositions() >= MAX_POSITIONS) break;
        const key = `A:${p}`;
        if (positions.has(key)) continue;

        const pd = pairData.get(p)!;
        const ea = engAMap.get(p)!;
        const di = pd.dailyMap.get(dayT);
        if (di === undefined || di < 51) continue;

        const bar = pd.daily[di];
        // BUG FIX #4: Use SMA crossover, not breakout
        const sma20now = ea.sma20[di - 1], sma50now = ea.sma50[di - 1];
        const sma20prev = ea.sma20[di - 2], sma50prev = ea.sma50[di - 2];
        if (sma20now === null || sma50now === null || sma20prev === null || sma50prev === null) continue;

        let dir: Dir | null = null;
        // Golden cross: SMA20 crosses above SMA50
        if (sma20prev <= sma50prev && sma20now > sma50now) {
          if (btcBullish(dayT)) dir = "long";
        }
        // Death cross: SMA20 crosses below SMA50
        if (sma20prev >= sma50prev && sma20now < sma50now) {
          dir = "short";
        }
        if (!dir) continue;

        // Regime filter
        if (!regimeAllowsDir(regime, dir, config)) continue;

        const atrVal = ea.atr14[di - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p);
        // BUG FIX #2: spread on entry price only
        const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        const margin = (sizes["A"] ?? 7) * sizeMult;

        positions.set(key, {
          pair: p, engine: "A", dir, ep, et: dayT, sl, tp: 0,
          margin, lev: 10,
          maxHold: 60 * DAY, // BUG FIX #1: 60 days, not 48h
          atr: atrVal, bestPnlAtr: 0,
        });
      }
    }

    // ─── ENGINE B: 4h Supertrend ────────────────────────────────────
    if (activeEngines.has("B")) {
      for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
        const h4T = dayT + h4Offset;
        for (const p of available) {
          if (totalPositions() >= MAX_POSITIONS) break;
          const key = `B:${p}`;
          if (positions.has(key)) continue;

          const pd = pairData.get(p)!;
          const eb = engBMap.get(p)!;
          const h4i = pd.h4Map.get(h4T);
          if (h4i === undefined || h4i < 21) continue;

          const stNow = eb.st[h4i - 1];
          const stPrev = eb.st[h4i - 2];
          if (stNow === null || stPrev === null || stNow === stPrev) continue;

          const dir: Dir = stNow === 1 ? "long" : "short";

          // Volume filter
          const h4Bar = pd.h4[h4i - 1];
          let volSum = 0;
          for (let j = h4i - 21; j < h4i - 1; j++) {
            if (j >= 0) volSum += pd.h4[j].v;
          }
          const avgVol = volSum / 20;
          if (avgVol <= 0 || h4Bar.v < 1.5 * avgVol) continue;

          const btcRet_ = btc30dRet(h4T);
          if (btcRet_ < -0.10 && dir === "long") continue;
          if (btcRet_ > 0.15 && dir === "short") continue;
          if (dir === "long" && !btcBullish(h4T)) continue;

          // Regime filter
          if (!regimeAllowsDir(regime, dir, config)) continue;

          const atrVal = eb.atr14[h4i - 1];
          if (atrVal === null) continue;

          const sp_ = sp(p);
          const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
          let slDist = atrVal * 3;
          if (slDist / ep > 0.035) slDist = ep * 0.035;
          const sl = dir === "long" ? ep - slDist : ep + slDist;

          const margin = (sizes["B"] ?? 5) * sizeMult;

          positions.set(key, {
            pair: p, engine: "B", dir, ep, et: h4T, sl, tp: 0,
            margin, lev: 10,
            maxHold: 60 * DAY, // BUG FIX #1: 60 days, not 48h
            atr: atrVal, bestPnlAtr: 0,
          });
        }
      }
    }

    // ─── ENGINE D: Carry Momentum ───────────────────────────────────
    // BUG FIX #3: funding proxy (close-open)/close * 0.05, rank + momentum filter
    if (activeEngines.has("D")) {
      if (dayT - lastCarryRebalance >= 7 * DAY) {
        lastCarryRebalance = dayT;

        // Close existing carry positions
        for (const [key, pos] of [...positions.entries()]) {
          if (pos.engine === "D") {
            const pd = pairData.get(pos.pair);
            if (!pd) continue;
            const di = pd.dailyMap.get(dayT);
            if (di === undefined) continue;
            closePosition(key, pd.daily[di].c, dayT);
          }
        }

        // BUG FIX #3: Exact same carry logic as bt-engine-combos.ts
        const fundingRanks: { pair: string; funding: number; momentum: number }[] = [];
        for (const p of available) {
          const pd = pairData.get(p)!;
          const di = pd.dailyMap.get(dayT);
          if (di === undefined || di < 6) continue;

          let fundSum = 0;
          for (let j = di - 5; j < di; j++) {
            if (j >= 0) {
              fundSum += (pd.daily[j].c - pd.daily[j].o) / pd.daily[j].c * 0.05;
            }
          }
          const avgFunding = fundSum / 5;
          const momentum = pd.daily[di].c / pd.daily[di - 5].c - 1;
          fundingRanks.push({ pair: p, funding: avgFunding, momentum });
        }

        fundingRanks.sort((a, b) => a.funding - b.funding);
        // Short high-funding (positive funding + negative momentum = overheated, short)
        const top3 = fundingRanks.filter(x => x.funding > 0 && x.momentum < 0).slice(-3);
        // Long low-funding (negative funding + positive momentum = undervalued, long)
        const bot3 = fundingRanks.filter(x => x.funding < 0 && x.momentum > 0).slice(0, 3);

        for (const pick of [...top3, ...bot3]) {
          if (totalPositions() >= MAX_POSITIONS) break;
          const key = `D:${pick.pair}`;
          if (positions.has(key)) continue;

          const pd = pairData.get(pick.pair)!;
          const di = pd.dailyMap.get(dayT);
          if (di === undefined) continue;

          const dir: Dir = pick.funding > 0 ? "short" : "long";

          // Regime filter
          if (!regimeAllowsDir(regime, dir, config)) continue;

          const sp_ = sp(pick.pair);
          const ep = dir === "long" ? pd.daily[di].o * (1 + sp_) : pd.daily[di].o * (1 - sp_);
          let slDist = ep * 0.04;
          if (slDist / ep > 0.035) slDist = ep * 0.035;
          const sl = dir === "long" ? ep - slDist : ep + slDist;

          const dailyAtr = atrFn(pd.daily, 14);
          const atrVal = dailyAtr[di - 1] ?? ep * 0.02;

          const margin = (sizes["D"] ?? 7) * sizeMult;

          positions.set(key, {
            pair: pick.pair, engine: "D", dir, ep, et: dayT, sl, tp: 0,
            margin, lev: 10,
            maxHold: 8 * DAY, // BUG FIX #1: 8 days for carry, not 48h
            atr: atrVal as number, bestPnlAtr: 0,
          });
        }
      }
    }

    // ─── ENGINE G: GARCH v2 MTF (only in config D, RISK_OFF regime) ──
    if (config.extraRegimeEngines && activeEngines.has("G") && regime === "RISK_OFF") {
      for (let h1Offset = 0; h1Offset < DAY; h1Offset += H1) {
        const h1T = dayT + h1Offset;
        for (const p of available) {
          if (totalPositions() >= MAX_POSITIONS) break;
          const key = `G:${p}`;
          if (positions.has(key)) continue;

          const cPositions = positionsForEngine("G");
          const cLongs = cPositions.filter(x => x.dir === "long").length;
          const cShorts = cPositions.filter(x => x.dir === "short").length;

          const pd = pairData.get(p)!;
          const ec = engGARCHMap.get(p)!;
          const h1i = pd.h1Map.get(h1T);
          if (h1i === undefined || h1i < 25) continue;

          const h4T_ = Math.floor(h1T / H4) * H4;
          const h4i = pd.h4Map.get(h4T_);
          if (h4i === undefined || h4i < 25) continue;

          const h1z = ec.h1z[h1i - 1] ?? 0;
          const h4z = ec.h4z[h4i - 1] ?? 0;
          const h1e9 = ec.h1ema9[h1i - 1];
          const h1e21 = ec.h1ema21[h1i - 1];
          if (h1e9 === null || h1e21 === null) continue;

          let dir: Dir | null = null;
          // In RISK_OFF, only allow shorts
          if (h1z < -3.0 && h4z < -3.0 && h1e9 < h1e21 && !btcH1Bullish(h1T)) {
            if (cShorts < 6) dir = "short";
          }
          if (!dir) continue;

          const h1Bar = pd.h1[h1i - 1];
          let volSum = 0, rangeSum = 0;
          for (let j = h1i - 21; j < h1i - 1; j++) {
            if (j >= 0) {
              volSum += pd.h1[j].v;
              rangeSum += pd.h1[j].h - pd.h1[j].l;
            }
          }
          const avgVol = volSum / 20;
          const avgRange = rangeSum / 20;
          if (avgVol <= 0 || h1Bar.v < 1.5 * avgVol) continue;
          if (avgRange <= 0 || (h1Bar.h - h1Bar.l) < 1.5 * avgRange) continue;

          const sp_ = sp(p);
          const ep = dir === "long" ? pd.h1[h1i].o * (1 + sp_) : pd.h1[h1i].o * (1 - sp_);
          const slPct = 0.03;
          let slDist = ep * slPct;
          if (slDist / ep > 0.035) slDist = ep * 0.035;
          const sl = dir === "long" ? ep - slDist : ep + slDist;
          const tp = dir === "long" ? ep * 1.07 : ep * 0.93;

          const h1atr = ec.h1atr14[h1i - 1] ?? (ep * 0.02);

          const margin = (sizes["G"] ?? 5) * sizeMult;

          positions.set(key, {
            pair: p, engine: "G", dir, ep, et: h1T, sl, tp,
            margin, lev: 10, maxHold: 96 * H1, atr: h1atr as number, bestPnlAtr: 0,
          });
        }
      }
    }

    // ─── ENGINE R: Alt Rotation (only in config D, RISK_ON regime) ──
    // Momentum rotation: buy top 3 momentum performers, rebalance weekly
    if (config.extraRegimeEngines && activeEngines.has("R") && regime === "RISK_ON") {
      // Rebalance weekly (use same carry rebalance cadence but separate tracking)
      const rotKey = `_ROT_LAST_`;
      const lastRot = positions.has(rotKey) ? 0 : dayT; // simple check via carry
      // Use a simpler approach: check if any R positions exist, if weekly rebalance
      const rPositions = positionsForEngine("R");
      const oldestR = rPositions.length > 0 ? Math.min(...rPositions.map(p => p.et)) : 0;
      const shouldRebalance = rPositions.length === 0 || (dayT - oldestR >= 7 * DAY);

      if (shouldRebalance) {
        // Close existing rotation positions
        for (const [key, pos] of [...positions.entries()]) {
          if (pos.engine === "R") {
            const pd = pairData.get(pos.pair);
            if (!pd) continue;
            const di = pd.dailyMap.get(dayT);
            if (di === undefined) continue;
            closePosition(key, pd.daily[di].c, dayT);
          }
        }

        // Rank by 14d momentum, pick top 3
        const momRanks: { pair: string; mom: number }[] = [];
        for (const p of available) {
          const pd = pairData.get(p)!;
          const di = pd.dailyMap.get(dayT);
          if (di === undefined || di < 14) continue;
          const mom = pd.daily[di].c / pd.daily[di - 14].c - 1;
          momRanks.push({ pair: p, mom });
        }
        momRanks.sort((a, b) => b.mom - a.mom);
        const top3 = momRanks.slice(0, 3).filter(x => x.mom > 0);

        for (const pick of top3) {
          if (totalPositions() >= MAX_POSITIONS) break;
          const key = `R:${pick.pair}`;
          if (positions.has(key)) continue;

          const pd = pairData.get(pick.pair)!;
          const di = pd.dailyMap.get(dayT);
          if (di === undefined) continue;

          const dir: Dir = "long"; // rotation is long-only in RISK_ON
          const sp_ = sp(pick.pair);
          const ep = pd.daily[di].o * (1 + sp_);
          const dailyAtr = atrFn(pd.daily, 14);
          const atrVal = dailyAtr[di - 1] ?? ep * 0.02;
          let slDist = (atrVal as number) * 3;
          if (slDist / ep > 0.035) slDist = ep * 0.035;
          const sl = ep - slDist;

          const margin = (sizes["R"] ?? 5) * sizeMult;

          positions.set(key, {
            pair: pick.pair, engine: "R", dir, ep, et: dayT, sl, tp: 0,
            margin, lev: 10, maxHold: 14 * DAY, atr: atrVal as number, bestPnlAtr: 0,
          });
        }
      }
    }
  }

  // Close remaining positions
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairData.get(pos.pair);
    if (!pd || pd.daily.length === 0) continue;
    const lastBar = pd.daily[pd.daily.length - 1];
    closePosition(key, lastBar.c, lastBar.t);
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  trades: number; pf: number; sharpe: number; perDay: number; wr: number;
  maxDd: number; maxDdDuration: string; recoveryDays: number;
  totalPnl: number; avgPnl: number; winners: number; losers: number;
}

function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return {
    trades: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0,
    maxDd: 0, maxDdDuration: "0d", recoveryDays: 0, totalPnl: 0, avgPnl: 0,
    winners: 0, losers: 0,
  };

  const sorted = [...filtered].sort((a, b) => a.xt - b.xt);
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const wr = filtered.length > 0 ? wins.length / filtered.length : 0;

  const days = (endMs - startMs) / DAY;
  const perDay = totalPnl / days;

  const dailyPnl = new Map<number, number>();
  for (const t of sorted) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.pnl);
  }
  const dpVals = [...dailyPnl.values()];
  const mean = dpVals.length > 0 ? dpVals.reduce((a, b) => a + b, 0) / dpVals.length : 0;
  const std = dpVals.length > 1
    ? Math.sqrt(dpVals.reduce((s, v) => s + (v - mean) ** 2, 0) / (dpVals.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  let equity = 0, peak = 0, maxDd = 0, maxDdStart = startMs, maxDdEnd = startMs;
  let currentDdStart = startMs;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) { peak = equity; currentDdStart = t.xt; }
    const dd = peak - equity;
    if (dd > maxDd) { maxDd = dd; maxDdStart = currentDdStart; maxDdEnd = t.xt; }
  }
  const ddDurationDays = Math.round((maxDdEnd - maxDdStart) / DAY);

  let recoveryDays = 0;
  let foundTrough = false;
  equity = 0; peak = 0; let troughTime = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) {
      if (foundTrough) { recoveryDays = Math.round((t.xt - troughTime) / DAY); foundTrough = false; }
      peak = equity;
    }
    if (peak - equity >= maxDd * 0.99 && !foundTrough) { foundTrough = true; troughTime = t.xt; }
  }

  return {
    trades: filtered.length,
    pf: Math.round(pf * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    perDay: Math.round(perDay * 100) / 100,
    wr: Math.round(wr * 1000) / 10,
    maxDd: Math.round(maxDd * 100) / 100,
    maxDdDuration: `${ddDurationDays}d`,
    recoveryDays,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round((totalPnl / filtered.length) * 100) / 100,
    winners: wins.length,
    losers: losses.length,
  };
}

// ─── Output Helpers ─────────────────────────────────────────────────
function pad(s: string, n: number): string { return s.padStart(n); }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "") + "$" + v.toFixed(2); }
function fmtPct(v: number): string { return v.toFixed(1) + "%"; }

function printStatsLine(label: string, s: Stats) {
  console.log(
    `${label.padEnd(20)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 7)} ` +
    `${pad(s.maxDdDuration, 6)} ${pad(String(s.recoveryDays) + "d", 6)} ${pad(fmtPnl(s.totalPnl), 11)}`
  );
}

function printHeader() {
  console.log(
    `${"Period".padEnd(20)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
    `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ` +
    `${pad("DDdur", 6)} ${pad("Recov", 6)} ${pad("Total PnL", 11)}`
  );
  console.log("-".repeat(100));
}

// ─── Configurations ─────────────────────────────────────────────────
const ENGINE_NAMES: Record<string, string> = {
  A: "Donchian", B: "Supertrend", D: "Carry", G: "GARCH", R: "AltRotation",
};

const CONFIGS: RegimeConfig[] = [
  {
    label: "A. 3-eng baseline",
    engines: ["A","B","D"],
    maxPositions: 10,
    sizes: { A: 7, B: 5, D: 7 },
    useRegime: false,
    regimeDir: false,
    regimeSize: false,
    extraRegimeEngines: false,
  },
  {
    label: "B. +regime dir",
    engines: ["A","B","D"],
    maxPositions: 10,
    sizes: { A: 7, B: 5, D: 7 },
    useRegime: true,
    regimeDir: true,
    regimeSize: false,
    extraRegimeEngines: false,
  },
  {
    label: "C. +regime dir+size",
    engines: ["A","B","D"],
    maxPositions: 10,
    sizes: { A: 7, B: 5, D: 7 },
    useRegime: true,
    regimeDir: true,
    regimeSize: true,
    extraRegimeEngines: false,
  },
  {
    label: "D. +extra engines",
    engines: ["A","B","D","G","R"],
    maxPositions: 10,
    sizes: { A: 7, B: 5, D: 7, G: 5, R: 5 },
    useRegime: true,
    regimeDir: true,
    regimeSize: true,
    extraRegimeEngines: true,
  },
];

// ─── Main ───────────────────────────────────────────────────────────
console.log("=".repeat(120));
console.log("  CORRECTED REGIME BACKTEST - 5 Bug Fixes Applied");
console.log("  Fixes: stagnation times, spread double-count, carry logic, Donchian crossover, Donchian on closes");
console.log("  18 pairs, 2023-01 to 2026-03, 5m candles, 10x leverage");
console.log("  Cost: Taker 0.035%, standard spread map, 1.5x SL slippage");
console.log("=".repeat(120));

loadAllData();

// Regime distribution check
console.log("\n--- Regime Distribution (daily) ---");
const regimeDist = { RISK_OFF: 0, RECOVERY: 0, RISK_ON: 0, CORRECTION: 0 };
for (let t = FULL_START; t < FULL_END; t += DAY) {
  const r = classifyRegime(t);
  regimeDist[r]++;
}
const totalDays = Object.values(regimeDist).reduce((a, b) => a + b, 0);
for (const [r, c] of Object.entries(regimeDist)) {
  console.log(`  ${r.padEnd(14)} ${String(c).padStart(5)} days (${(c / totalDays * 100).toFixed(1)}%)`);
}

interface ConfigResult {
  label: string;
  fullStats: Stats;
  yearStats: Map<number, Stats>;
  trades: Trade[];
}

const results: ConfigResult[] = [];

for (const config of CONFIGS) {
  console.log("\n" + "#".repeat(120));
  console.log(`  ${config.label}`);
  console.log(`  Engines: ${config.engines.map(e => e + ":" + ENGINE_NAMES[e]).join(", ")}`);
  console.log(`  Max positions: ${config.maxPositions}, Sizes: ${config.engines.map(e => e + "=$" + config.sizes[e]).join(", ")}`);
  console.log(`  Regime: dir=${config.regimeDir}, size=${config.regimeSize}, extraEngines=${config.extraRegimeEngines}`);
  console.log("#".repeat(120));

  const trades = runBacktest(config);
  const fullStats = computeStats(trades, FULL_START, FULL_END);

  // Full period
  console.log("\n--- Full Period ---");
  printHeader();
  printStatsLine("Full 2023-2026", fullStats);

  // Per-year
  console.log("\n--- Per-Year ---");
  printHeader();
  const yearStats = new Map<number, Stats>();
  for (const year of [2023, 2024, 2025, 2026]) {
    const ys = new Date(`${year}-01-01`).getTime();
    const ye = new Date(`${year + 1}-01-01`).getTime();
    const s = computeStats(trades, ys, Math.min(ye, FULL_END));
    yearStats.set(year, s);
    printStatsLine(String(year), s);
  }

  // Per-engine contribution
  console.log("\n--- Engine Contribution ---");
  console.log(
    `${"Engine".padEnd(20)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("WR", 7)} ` +
    `${pad("Total PnL", 11)} ${pad("$/day", 9)} ${pad("AvgPnl", 8)}`
  );
  console.log("-".repeat(75));
  const totalDaysInPeriod = (FULL_END - FULL_START) / DAY;
  for (const eng of config.engines) {
    const et = trades.filter(t => t.engine === eng);
    const pnl = et.reduce((s, t) => s + t.pnl, 0);
    const wins = et.filter(t => t.pnl > 0);
    const losses = et.filter(t => t.pnl <= 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
    console.log(
      `${(eng + ": " + ENGINE_NAMES[eng]).padEnd(20)} ${pad(String(et.length), 6)} ${pad(pf.toFixed(2), 6)} ` +
      `${pad(fmtPct(et.length > 0 ? wins.length / et.length * 100 : 0), 7)} ` +
      `${pad(fmtPnl(pnl), 11)} ${pad(fmtPnl(pnl / totalDaysInPeriod), 9)} ` +
      `${pad(fmtPnl(et.length > 0 ? pnl / et.length : 0), 8)}`
    );
  }

  // Per-regime breakdown (for configs with regime)
  if (config.useRegime) {
    console.log("\n--- Per-Regime Breakdown ---");
    const regimes: Regime[] = ["RISK_OFF", "RECOVERY", "RISK_ON", "CORRECTION"];
    console.log(
      `${"Regime".padEnd(16)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("WR", 7)} ` +
      `${pad("Total PnL", 11)} ${pad("AvgPnl", 8)}`
    );
    console.log("-".repeat(65));

    // Classify each trade's entry regime
    for (const regime of regimes) {
      const regimeTrades = trades.filter(t => {
        return classifyRegime(t.et) === regime;
      });
      const pnl = regimeTrades.reduce((s, t) => s + t.pnl, 0);
      const wins = regimeTrades.filter(t => t.pnl > 0);
      const losses = regimeTrades.filter(t => t.pnl <= 0);
      const gw = wins.reduce((s, t) => s + t.pnl, 0);
      const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
      const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
      console.log(
        `${regime.padEnd(16)} ${pad(String(regimeTrades.length), 6)} ${pad(pf.toFixed(2), 6)} ` +
        `${pad(fmtPct(regimeTrades.length > 0 ? wins.length / regimeTrades.length * 100 : 0), 7)} ` +
        `${pad(fmtPnl(pnl), 11)} ` +
        `${pad(fmtPnl(regimeTrades.length > 0 ? pnl / regimeTrades.length : 0), 8)}`
      );
    }
  }

  results.push({ label: config.label, fullStats, yearStats, trades });
}

// ─── RANKED TABLE ───────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(140));
console.log("  RANKED TABLE - All Configurations (sorted by $/day)");
console.log("=".repeat(140));

const sorted = [...results].sort((a, b) => b.fullStats.perDay - a.fullStats.perDay);

console.log(
  `${"#".padEnd(3)} ${"Config".padEnd(24)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
  `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ${pad("DDdur", 6)} ${pad("Recov", 6)} ` +
  `${pad("Total PnL", 11)} ` +
  `${pad("'23$/d", 7)} ${pad("'24$/d", 7)} ${pad("'25$/d", 7)} ${pad("'26$/d", 7)}`
);
console.log("-".repeat(140));

for (let i = 0; i < sorted.length; i++) {
  const r = sorted[i];
  const s = r.fullStats;
  const y23 = r.yearStats.get(2023)!;
  const y24 = r.yearStats.get(2024)!;
  const y25 = r.yearStats.get(2025)!;
  const y26 = r.yearStats.get(2026)!;

  console.log(
    `${String(i + 1).padEnd(3)} ${r.label.padEnd(24)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 7)} ${pad(s.maxDdDuration, 6)} ${pad(String(s.recoveryDays) + "d", 6)} ` +
    `${pad(fmtPnl(s.totalPnl), 11)} ` +
    `${pad(fmtPnl(y23.perDay), 7)} ${pad(fmtPnl(y24.perDay), 7)} ${pad(fmtPnl(y25.perDay), 7)} ${pad(fmtPnl(y26.perDay), 7)}`
  );
}

// ─── SUMMARY ────────────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  SUMMARY & COMPARISON");
console.log("=".repeat(120));

const baseline = results[0];
const best = sorted[0];

console.log(`
Baseline (A: no regime):  ${fmtPnl(baseline.fullStats.perDay)}/day, PF ${baseline.fullStats.pf}, Sharpe ${baseline.fullStats.sharpe}, MaxDD $${baseline.fullStats.maxDd.toFixed(0)}
Best config:              ${best.label} -> ${fmtPnl(best.fullStats.perDay)}/day, PF ${best.fullStats.pf}, Sharpe ${best.fullStats.sharpe}, MaxDD $${best.fullStats.maxDd.toFixed(0)}

Delta vs baseline:        ${fmtPnl(best.fullStats.perDay - baseline.fullStats.perDay)}/day (${((best.fullStats.perDay / (baseline.fullStats.perDay || 0.01) - 1) * 100).toFixed(1)}%)
`);

for (const r of results) {
  const s = r.fullStats;
  const y23 = r.yearStats.get(2023)!.perDay;
  const y24 = r.yearStats.get(2024)!.perDay;
  const y25 = r.yearStats.get(2025)!.perDay;
  const y26 = r.yearStats.get(2026)!.perDay;
  const allPositive = y23 > 0 && y24 > 0 && y25 > 0 && y26 > 0;
  console.log(
    `${r.label.padEnd(26)} ${fmtPnl(s.perDay).padStart(9)}/day  PF ${String(s.pf).padStart(5)}  Sharpe ${String(s.sharpe).padStart(5)}  ` +
    `Years: ${fmtPnl(y23)}/${fmtPnl(y24)}/${fmtPnl(y25)}/${fmtPnl(y26)}  ${allPositive ? "ALL YEARS POSITIVE" : "NOT ALL POSITIVE"}`
  );
}

console.log("\n--- Bug Fix Impact ---");
console.log("1. Stagnation: Donchian/Supertrend=60d (was 48h) -> positions run to completion, more profit from trends");
console.log("2. Spread: no double-counting (was applied to price AND deducted separately) -> fewer phantom losses");
console.log("3. Carry: correct funding proxy + momentum filter (was broken) -> better mean-reversion picks");
console.log("4. Donchian: SMA crossover only (was trend+breakout) -> fewer false entries");
console.log("5. Donchian: channel on closes (was on highs/lows) -> tighter, more responsive channel");
