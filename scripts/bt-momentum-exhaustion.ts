/**
 * Momentum Exhaustion Exit Overlay Research
 *
 * Tests 5 momentum exhaustion detectors as EXIT-ONLY overlays on top of
 * baseline Donchian (Engine A) and Supertrend (Engine B) engines.
 *
 * Overlays only trigger when position is in profit. They do NOT change entries.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-momentum-exhaustion.ts
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
const MAX_SL_PCT = 0.035;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4,
  OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA",
  "DOGE","APT","LINK","ADA","WLD","XRP",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-23").getTime();
const FULL_DAYS = (FULL_END - FULL_START) / DAY;

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string;
  engine: string;
  dir: Dir;
  ep: number;
  et: number;
  sl: number;
  margin: number;
  lev: number;
  maxHold: number;
  atr: number;
  bestPnlAtr: number;
}

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number; margin: number;
  reason: string;
  peakPnl: number;     // peak unrealized $ pnl
  exitPnl: number;     // actual exit $ pnl
  postExitMove: number; // price move in our favor AFTER exit (positive = we left money, negative = good exit)
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

// ─── Indicators (SMA-based, no look-ahead) ─────────────────────────
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
  // Seed with SMA
  let seedSum = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i < period) {
      seedSum += vals[i];
      if (i === period - 1) {
        r[i] = seedSum / period;
      }
    } else {
      const prev = r[i - 1];
      if (prev !== null) {
        const k = 2 / (period + 1);
        r[i] = vals[i] * k + prev * (1 - k);
      }
    }
  }
  return r;
}

function atrCalc(bars: Bar[], period: number): (number | null)[] {
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
  // SMA-based ATR
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

function donchianLow(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mn = Infinity;
    for (let j = i - period; j < i; j++) mn = Math.min(mn, closes[j]);
    r[i] = mn;
  }
  return r;
}

function donchianHigh(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mx = -Infinity;
    for (let j = i - period; j < i; j++) mx = Math.max(mx, closes[j]);
    r[i] = mx;
  }
  return r;
}

function supertrendCalc(bars: Bar[], atrPeriod: number, mult: number): { trend: (1 | -1 | null)[] } {
  const atrVals = atrCalc(bars, atrPeriod);
  const trend: (1 | -1 | null)[] = new Array(bars.length).fill(null);
  let upperBand = 0, lowerBand = 0, prevTrend = 1;

  for (let i = 0; i < bars.length; i++) {
    const a = atrVals[i];
    if (a === null) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let ub = hl2 + mult * a;
    let lb = hl2 - mult * a;

    if (i > 0 && atrVals[i - 1] !== null) {
      if (!(lb > lowerBand || bars[i - 1].c < lowerBand)) lb = lowerBand;
      if (!(ub < upperBand || bars[i - 1].c > upperBand)) ub = upperBand;
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

// ADX using Wilder smoothing (SMA seed)
function adxCalc(bars: Bar[], period: number): (number | null)[] {
  const n = bars.length;
  const r: (number | null)[] = new Array(n).fill(null);
  if (n < period * 2) return r;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 0; i < n; i++) {
    if (i === 0) {
      trs.push(bars[i].h - bars[i].l);
      plusDMs.push(0);
      minusDMs.push(0);
      continue;
    }
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trs.push(tr);
    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smooth
  let atr14 = 0, plusDM14 = 0, minusDM14 = 0;
  for (let i = 0; i < period; i++) {
    atr14 += trs[i]; plusDM14 += plusDMs[i]; minusDM14 += minusDMs[i];
  }

  const dxVals: number[] = [];

  for (let i = period; i < n; i++) {
    if (i === period) {
      // First values are the SMA
    } else {
      atr14 = atr14 - atr14 / period + trs[i];
      plusDM14 = plusDM14 - plusDM14 / period + plusDMs[i];
      minusDM14 = minusDM14 - minusDM14 / period + minusDMs[i];
    }

    const plusDI = atr14 > 0 ? (plusDM14 / atr14) * 100 : 0;
    const minusDI = atr14 > 0 ? (minusDM14 / atr14) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;
    dxVals.push(dx);

    if (dxVals.length >= period) {
      if (dxVals.length === period) {
        // First ADX = SMA of DX
        let s = 0;
        for (let j = 0; j < period; j++) s += dxVals[j];
        r[i] = s / period;
      } else {
        const prev = r[i - 1];
        if (prev !== null) {
          r[i] = (prev * (period - 1) + dx) / period;
        }
      }
    }
  }
  return r;
}

// RSI
function rsiCalc(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return r;

  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d; else lossSum += -d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  r[period] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    r[i] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
  }
  return r;
}

// ─── Data Prep ──────────────────────────────────────────────────────
interface PairData {
  m5: C[];
  h4: Bar[];
  daily: Bar[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
  // Pre-computed daily indicators for Engine A
  sma30: (number | null)[];
  sma60: (number | null)[];
  donLo15: (number | null)[];
  donHi15: (number | null)[];
  atr14d: (number | null)[];
  // 4h indicators for Engine B
  st: (1 | -1 | null)[];
  atr14h4: (number | null)[];
  // Momentum exhaustion indicators (computed on 4h timeframe for both)
  adx14h4: (number | null)[];
  rsi14d: (number | null)[];
  h4Closes: number[];
  dailyCloses: number[];
}

interface BTCData {
  daily: Bar[];
  dailyEma20: (number | null)[];
  dailyEma50: (number | null)[];
  dailyMap: Map<number, number>;
}

function prepBTC(m5: C[]): BTCData {
  const daily = aggregate(m5, DAY);
  const dc = daily.map(b => b.c);
  return {
    daily,
    dailyEma20: ema(dc, 20),
    dailyEma50: ema(dc, 50),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
  };
}

function prepPair(m5: C[]): PairData {
  const h4 = aggregate(m5, H4);
  const daily = aggregate(m5, DAY);
  const dc = daily.map(b => b.c);
  const h4c = h4.map(b => b.c);

  return {
    m5, h4, daily,
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
    // Engine A
    sma30: sma(dc, 30),
    sma60: sma(dc, 60),
    donLo15: donchianLow(dc, 15),
    donHi15: donchianHigh(dc, 15),
    atr14d: atrCalc(daily, 14),
    // Engine B
    st: supertrendCalc(h4, 14, 2).trend,
    atr14h4: atrCalc(h4, 14),
    // Exhaustion indicators
    adx14h4: adxCalc(h4, 14),
    rsi14d: rsiCalc(dc, 14),
    h4Closes: h4c,
    dailyCloses: dc,
  };
}

function getBarAtOrBefore(barMap: Map<number, number>, t: number, period: number): number {
  const aligned = Math.floor(t / period) * period;
  const idx = barMap.get(aligned);
  if (idx !== undefined) return idx;
  for (let dt = period; dt <= 10 * period; dt += period) {
    const idx2 = barMap.get(aligned - dt);
    if (idx2 !== undefined) return idx2;
  }
  return -1;
}

function halfSpread(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Exhaustion Overlay Types ───────────────────────────────────────
type OverlayName = "baseline" | "adx_decline" | "roc_flatten" | "vol_decline" | "htf_rsi" | "consec_lc";

interface OverlayConfig {
  name: OverlayName;
  label: string;
}

const OVERLAYS: OverlayConfig[] = [
  { name: "baseline",    label: "Baseline (no overlay)" },
  { name: "adx_decline", label: "ADX(14) declining < 25, 3+ bars" },
  { name: "roc_flatten", label: "ROC(5) < 0 for 2 consecutive bars" },
  { name: "vol_decline", label: "Range < 50% of 20-bar avg, 3+ bars" },
  { name: "htf_rsi",     label: "Daily RSI(14) > 70 declining (longs)" },
  { name: "consec_lc",   label: "3 consec lower/higher closes in profit" },
];

// ─── Check momentum exhaustion ──────────────────────────────────────
function checkExhaustion(
  overlay: OverlayName,
  pos: Position,
  pd: PairData,
  h4i: number,   // current 4h bar index (previous completed bar)
  di: number,     // current daily bar index (previous completed bar)
  currentPrice: number,
): boolean {
  // Only exit if in profit
  const unrealPnl = pos.dir === "long"
    ? (currentPrice - pos.ep) / pos.ep
    : (pos.ep - currentPrice) / pos.ep;
  if (unrealPnl <= 0) return false;

  switch (overlay) {
    case "baseline":
      return false; // no overlay

    case "adx_decline": {
      // ADX(14) on 4h drops below 25 AND declining for 3+ bars
      if (h4i < 3) return false;
      const adxNow = pd.adx14h4[h4i];
      if (adxNow === null || adxNow >= 25) return false;
      // Check declining for 3+ bars
      for (let j = 1; j <= 3; j++) {
        const prev = pd.adx14h4[h4i - j];
        const curr = pd.adx14h4[h4i - j + 1];
        if (prev === null || curr === null || curr >= prev) return false;
      }
      return true;
    }

    case "roc_flatten": {
      // 5-bar ROC on 4h drops below 0 for 2 consecutive bars after being positive
      if (h4i < 7) return false;
      const roc = (i: number) => {
        if (i < 5) return null;
        return (pd.h4Closes[i] / pd.h4Closes[i - 5] - 1);
      };
      const rocNow = roc(h4i);
      const rocPrev = roc(h4i - 1);
      const rocPrev2 = roc(h4i - 2);
      if (rocNow === null || rocPrev === null || rocPrev2 === null) return false;
      // For longs: ROC drops below 0 for 2 bars, was positive before
      if (pos.dir === "long") {
        return rocNow < 0 && rocPrev < 0 && rocPrev2 > 0;
      }
      // For shorts: ROC goes above 0 for 2 bars, was negative before
      return rocNow > 0 && rocPrev > 0 && rocPrev2 < 0;
    }

    case "vol_decline": {
      // Range (as vol proxy) < 50% of 20-bar avg for 3+ consecutive 4h bars
      if (h4i < 23) return false;
      let avgRange = 0;
      for (let j = h4i - 23; j < h4i - 3; j++) {
        avgRange += pd.h4[j].h - pd.h4[j].l;
      }
      avgRange /= 20;
      if (avgRange <= 0) return false;
      for (let j = 0; j < 3; j++) {
        const barRange = pd.h4[h4i - j].h - pd.h4[h4i - j].l;
        if (barRange >= avgRange * 0.5) return false;
      }
      return true;
    }

    case "htf_rsi": {
      // Daily RSI(14) > 70 and declining for longs; < 30 and rising for shorts
      if (di < 2) return false;
      const rsiNow = pd.rsi14d[di];
      const rsiPrev = pd.rsi14d[di - 1];
      if (rsiNow === null || rsiPrev === null) return false;
      if (pos.dir === "long") {
        return rsiPrev > 70 && rsiNow < rsiPrev;
      }
      return rsiPrev < 30 && rsiNow > rsiPrev;
    }

    case "consec_lc": {
      // 3 consecutive lower closes (longs) or higher closes (shorts) on 4h
      if (h4i < 3) return false;
      if (pos.dir === "long") {
        return pd.h4Closes[h4i] < pd.h4Closes[h4i - 1] &&
               pd.h4Closes[h4i - 1] < pd.h4Closes[h4i - 2] &&
               pd.h4Closes[h4i - 2] < pd.h4Closes[h4i - 3];
      }
      return pd.h4Closes[h4i] > pd.h4Closes[h4i - 1] &&
             pd.h4Closes[h4i - 1] > pd.h4Closes[h4i - 2] &&
             pd.h4Closes[h4i - 2] > pd.h4Closes[h4i - 3];
    }

    default:
      return false;
  }
}

// ─── Post-exit price move tracker ───────────────────────────────────
// After an exhaustion exit, measure how much further price moved AGAINST us
// (positive = price kept going in our favor = we left money on table)
// Uses 5-day window after exit
function postExitMove(pd: PairData, dir: Dir, exitPrice: number, exitTime: number): number {
  // Find worst price in 5 days after exit (worst from the original position's perspective)
  // For longs: how much higher did price go after we exited?
  // For shorts: how much lower did price go after we exited?
  const windowEnd = exitTime + 5 * DAY;
  let bestContinuation = 0;

  for (const bar of pd.daily) {
    if (bar.t <= exitTime) continue;
    if (bar.t > windowEnd) break;
    if (dir === "long") {
      const move = (bar.h - exitPrice) / exitPrice;
      if (move > bestContinuation) bestContinuation = move;
    } else {
      const move = (exitPrice - bar.l) / exitPrice;
      if (move > bestContinuation) bestContinuation = move;
    }
  }

  // Also check how much it reversed (positive = it did reverse after our exit = good exit)
  let bestReversal = 0;
  for (const bar of pd.daily) {
    if (bar.t <= exitTime) continue;
    if (bar.t > windowEnd) break;
    if (dir === "long") {
      const move = (exitPrice - bar.l) / exitPrice;
      if (move > bestReversal) bestReversal = move;
    } else {
      const move = (bar.h - exitPrice) / exitPrice;
      if (move > bestReversal) bestReversal = move;
    }
  }

  // Return net: negative means price reversed (good exit), positive means price continued (bad exit)
  return bestContinuation - bestReversal;
}

// ─── Run Simulation ─────────────────────────────────────────────────
function runSim(
  overlay: OverlayName,
  pairDataMap: Map<string, PairData>,
  btc: BTCData,
): Trade[] {
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  // Track peak unrealized P&L per position
  const peakPnlMap = new Map<string, number>();

  function btcBullish(t: number): boolean {
    const di = getBarAtOrBefore(btc.dailyMap, t - DAY, DAY);
    if (di < 0) return false;
    const e20 = btc.dailyEma20[di], e50 = btc.dailyEma50[di];
    return e20 !== null && e50 !== null && e20 > e50;
  }

  function closePos(key: string, exitPrice: number, exitTime: number, reason: string, slipMult = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = halfSpread(pos.pair) * slipMult;
    const xp = pos.dir === "long"
      ? exitPrice * (1 - sp_)
      : exitPrice * (1 + sp_);
    const notional = pos.margin * pos.lev;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const cost = notional * FEE * 2;
    const pnl = raw - cost;
    const peak = peakPnlMap.get(key) ?? 0;

    // Post-exit analysis
    const pd = pairDataMap.get(pos.pair)!;
    const pem = postExitMove(pd, pos.dir, xp, exitTime);

    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl, margin: pos.margin,
      reason, peakPnl: peak, exitPnl: pnl, postExitMove: pem,
    });
    positions.delete(key);
    peakPnlMap.delete(key);
  }

  // Build daily timestamps
  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    dailyTimestamps.push(t);
  }

  for (const dayT of dailyTimestamps) {
    // ─── CHECK EXISTING POSITIONS ───────────────────────────────
    for (const [key, pos] of [...positions.entries()]) {
      const pd = pairDataMap.get(pos.pair);
      if (!pd) continue;

      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;
      const bar = pd.daily[di];

      const notional = pos.margin * pos.lev;

      // Track peak unrealized P&L
      const unrealPnl = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * notional - notional * FEE * 2
        : (pos.ep / bar.l - 1) * notional - notional * FEE * 2;
      const prevPeak = peakPnlMap.get(key) ?? 0;
      if (unrealPnl > prevPeak) peakPnlMap.set(key, unrealPnl);

      // 1. Stop-loss
      let stopped = false;
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePos(key, pos.sl, dayT, "stop", SL_SLIPPAGE);
        stopped = true;
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        closePos(key, pos.sl, dayT, "stop", SL_SLIPPAGE);
        stopped = true;
      }
      if (stopped) continue;

      // 2. Max hold
      if (dayT - pos.et >= pos.maxHold) {
        closePos(key, bar.c, dayT, "maxhold");
        continue;
      }

      // 3. ATR trailing stop management
      if (pos.atr > 0) {
        const unrealAtr = pos.dir === "long"
          ? (bar.c - pos.ep) / pos.atr
          : (pos.ep - bar.c) / pos.atr;
        if (unrealAtr > pos.bestPnlAtr) pos.bestPnlAtr = unrealAtr;

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

      // 4. Engine-specific signal exits
      if (pos.engine === "A") {
        // Donchian exit: close < 15d low (longs) or > 15d high (shorts)
        if (pos.dir === "long" && pd.donLo15[di] !== null && bar.c < pd.donLo15[di]!) {
          closePos(key, bar.c, dayT, "donchian");
          continue;
        }
        if (pos.dir === "short" && pd.donHi15[di] !== null && bar.c > pd.donHi15[di]!) {
          closePos(key, bar.c, dayT, "donchian");
          continue;
        }
      }

      if (pos.engine === "B") {
        // Supertrend flip exit: check at 4h boundaries
        for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
          const h4T = dayT + h4Off;
          const h4i = pd.h4Map.get(h4T);
          if (h4i === undefined || h4i < 1) continue;
          const stNow = pd.st[h4i];
          if (stNow === null) continue;
          if ((pos.dir === "long" && stNow === -1) || (pos.dir === "short" && stNow === 1)) {
            closePos(key, pd.h4[h4i].c, dayT, "st_flip");
            break;
          }
        }
        if (!positions.has(key)) continue;
      }

      // 5. MOMENTUM EXHAUSTION OVERLAY (only if still open after normal exits)
      if (overlay !== "baseline") {
        // Get current 4h bar index (most recent completed)
        const h4T = Math.floor(dayT / H4) * H4;
        const h4i = getBarAtOrBefore(pd.h4Map, h4T, H4);
        if (h4i >= 0 && di >= 0) {
          if (checkExhaustion(overlay, pos, pd, h4i, di, bar.c)) {
            closePos(key, bar.c, dayT, `exhaust_${overlay}`);
            continue;
          }
        }
      }
    }

    // ─── ENGINE A: Daily Donchian SMA(30/60) Cross ──────────────
    for (const p of PAIRS) {
      if (positions.size >= 10) break;
      const key = `A:${p}`;
      if (positions.has(key)) continue;

      const pd = pairDataMap.get(p);
      if (!pd) continue;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 61) continue;

      const bar = pd.daily[di];
      // Use previous bar values (no look-ahead)
      const sma30now = pd.sma30[di - 1], sma60now = pd.sma60[di - 1];
      const sma30prev = pd.sma30[di - 2], sma60prev = pd.sma60[di - 2];
      if (sma30now === null || sma60now === null || sma30prev === null || sma60prev === null) continue;

      let dir: Dir | null = null;
      // Golden cross
      if (sma30prev <= sma60prev && sma30now > sma60now) {
        if (btcBullish(dayT)) dir = "long";
      }
      // Death cross (no BTC filter)
      if (sma30prev >= sma60prev && sma30now < sma60now) {
        dir = "short";
      }
      if (!dir) continue;

      const atrVal = pd.atr14d[di - 1];
      if (atrVal === null) continue;

      const sp_ = halfSpread(p);
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > MAX_SL_PCT) slDist = ep * MAX_SL_PCT;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(key, {
        pair: p, engine: "A", dir, ep, et: dayT, sl,
        margin: 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
      });
    }

    // ─── ENGINE B: 4h Supertrend ────────────────────────────────
    for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
      const h4T = dayT + h4Off;
      for (const p of PAIRS) {
        if (positions.size >= 10) break;
        const key = `B:${p}`;
        if (positions.has(key)) continue;

        const pd = pairDataMap.get(p);
        if (!pd) continue;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined || h4i < 21) continue;

        // Supertrend flip detection
        const stNow = pd.st[h4i - 1];
        const stPrev = pd.st[h4i - 2];
        if (stNow === null || stPrev === null || stNow === stPrev) continue;

        const dir: Dir = stNow === 1 ? "long" : "short";

        // BTC EMA filter for longs
        if (dir === "long" && !btcBullish(h4T)) continue;

        const atrVal = pd.atr14h4[h4i - 1];
        if (atrVal === null) continue;

        const sp_ = halfSpread(p);
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > MAX_SL_PCT) slDist = ep * MAX_SL_PCT;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(key, {
          pair: p, engine: "B", dir, ep, et: h4T, sl,
          margin: 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
        });
      }
    }
  }

  // Close remaining
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairDataMap.get(pos.pair);
    if (!pd || pd.daily.length === 0) continue;
    const lastBar = pd.daily[pd.daily.length - 1];
    closePos(key, lastBar.c, lastBar.t, "eod");
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface SimStats {
  trades: number;
  totalPnl: number;
  perDay: number;
  wr: number;
  pf: number;
  maxDd: number;
  avgGiveback: number;   // % of peak given back at exit
  exhaustExits: number;  // how many exits were from exhaustion overlay
  exhaustAccuracy: number; // % of exhaustion exits where price reversed (good exit)
  avgPostExitMove: number; // avg post-exit continuation (negative = good)
}

function computeSimStats(trades: Trade[]): SimStats {
  if (trades.length === 0) return {
    trades: 0, totalPnl: 0, perDay: 0, wr: 0, pf: 0, maxDd: 0,
    avgGiveback: 0, exhaustExits: 0, exhaustAccuracy: 0, avgPostExitMove: 0,
  };

  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  const wr = wins.length / trades.length;

  // Max drawdown
  let equity = 0, peak = 0, maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  // Giveback analysis: for trades that reached meaningful positive peak, how much was given back
  // Only consider trades where peak > $0.50 (meaningful profit was seen)
  let givebackSum = 0;
  let givebackCount = 0;
  for (const t of trades) {
    if (t.peakPnl > 0.50) { // had meaningful unrealized profit
      const giveback = 1 - (Math.max(0, t.exitPnl) / t.peakPnl);
      givebackSum += Math.min(1, Math.max(0, giveback));
      givebackCount++;
    }
  }
  const avgGiveback = givebackCount > 0 ? givebackSum / givebackCount : 0;

  // Exhaustion exit analysis
  const exhaustTrades = trades.filter(t => t.reason.startsWith("exhaust_"));
  const exhaustAccuracy = exhaustTrades.length > 0
    ? exhaustTrades.filter(t => t.postExitMove < 0).length / exhaustTrades.length
    : 0;
  const avgPostExitMove = exhaustTrades.length > 0
    ? exhaustTrades.reduce((s, t) => s + t.postExitMove, 0) / exhaustTrades.length
    : 0;

  return {
    trades: trades.length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    perDay: Math.round((totalPnl / FULL_DAYS) * 100) / 100,
    wr: Math.round(wr * 1000) / 10,
    pf: Math.round(pf * 100) / 100,
    maxDd: Math.round(maxDd * 100) / 100,
    avgGiveback: Math.round(avgGiveback * 1000) / 10,
    exhaustExits: exhaustTrades.length,
    exhaustAccuracy: Math.round(exhaustAccuracy * 1000) / 10,
    avgPostExitMove: Math.round(avgPostExitMove * 10000) / 100, // in %
  };
}

// ─── Engine-level stats ─────────────────────────────────────────────
function computeEngineStats(trades: Trade[], engine: string): SimStats {
  return computeSimStats(trades.filter(t => t.engine === engine));
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=".repeat(110));
console.log("  MOMENTUM EXHAUSTION EXIT OVERLAY RESEARCH");
console.log("  14 pairs, 5m data aggregated, 2023-01 to 2026-03");
console.log("  Testing 5 exhaustion detectors on Donchian (A) + Supertrend (B)");
console.log("=".repeat(110));

console.log("\nLoading data...");
const btcRaw = load5m("BTC");
if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }
const btc = prepBTC(btcRaw);

const pairDataMap = new Map<string, PairData>();
let loaded = 0;
for (const p of PAIRS) {
  const m5 = load5m(p);
  if (m5.length < 500) { console.log(`  Skip ${p} (${m5.length} bars)`); continue; }
  pairDataMap.set(p, prepPair(m5));
  loaded++;
}
console.log(`Loaded ${loaded} pairs\n`);

// Run all overlays
const allResults: { overlay: OverlayConfig; trades: Trade[]; stats: SimStats; statsA: SimStats; statsB: SimStats }[] = [];

for (const ov of OVERLAYS) {
  process.stdout.write(`Running ${ov.name}...`);
  const trades = runSim(ov.name, pairDataMap, btc);
  const stats = computeSimStats(trades);
  const statsA = computeEngineStats(trades, "A");
  const statsB = computeEngineStats(trades, "B");
  allResults.push({ overlay: ov, trades, stats, statsA, statsB });
  console.log(` ${trades.length} trades`);
}

// ─── Output: Combined Results ───────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  COMBINED (Engine A + B)");
console.log("=".repeat(110));
console.log(
  `${"Overlay".padEnd(42)} ${"Trades".padStart(6)} ${"$/day".padStart(7)} ${"WR%".padStart(6)} ` +
  `${"PF".padStart(5)} ${"MaxDD".padStart(7)} ${"Give%".padStart(6)} ` +
  `${"ExhEx".padStart(5)} ${"ExAcc%".padStart(6)} ${"PostMv%".padStart(8)}`
);
console.log("-".repeat(110));

const baseStats = allResults[0].stats;
for (const r of allResults) {
  const s = r.stats;
  const pdDelta = s.perDay - baseStats.perDay;
  const pdStr = `${s.perDay >= 0 ? "+" : ""}$${s.perDay.toFixed(2)}`;
  const deltaStr = r.overlay.name === "baseline" ? "" : ` (${pdDelta >= 0 ? "+" : ""}${pdDelta.toFixed(2)})`;
  console.log(
    `${r.overlay.label.padEnd(42)} ${String(s.trades).padStart(6)} ${(pdStr + deltaStr).padStart(7 + deltaStr.length)} ${s.wr.toFixed(1).padStart(6)} ` +
    `${s.pf.toFixed(2).padStart(5)} ${"$" + s.maxDd.toFixed(0).padStart(6)} ${s.avgGiveback.toFixed(1).padStart(5)}% ` +
    `${String(s.exhaustExits).padStart(5)} ${s.exhaustAccuracy.toFixed(1).padStart(5)}% ${s.avgPostExitMove.toFixed(2).padStart(7)}%`
  );
}

// ─── Output: Engine A (Donchian) Results ────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  ENGINE A: Daily Donchian SMA(30/60)");
console.log("=".repeat(110));
console.log(
  `${"Overlay".padEnd(42)} ${"Trades".padStart(6)} ${"$/day".padStart(7)} ${"WR%".padStart(6)} ` +
  `${"PF".padStart(5)} ${"MaxDD".padStart(7)} ${"Give%".padStart(6)} ` +
  `${"ExhEx".padStart(5)} ${"ExAcc%".padStart(6)} ${"PostMv%".padStart(8)}`
);
console.log("-".repeat(110));

const baseA = allResults[0].statsA;
for (const r of allResults) {
  const s = r.statsA;
  const pdDelta = s.perDay - baseA.perDay;
  const pdStr = `${s.perDay >= 0 ? "+" : ""}$${s.perDay.toFixed(2)}`;
  const deltaStr = r.overlay.name === "baseline" ? "" : ` (${pdDelta >= 0 ? "+" : ""}${pdDelta.toFixed(2)})`;
  console.log(
    `${r.overlay.label.padEnd(42)} ${String(s.trades).padStart(6)} ${(pdStr + deltaStr).padStart(7 + deltaStr.length)} ${s.wr.toFixed(1).padStart(6)} ` +
    `${s.pf.toFixed(2).padStart(5)} ${"$" + s.maxDd.toFixed(0).padStart(6)} ${s.avgGiveback.toFixed(1).padStart(5)}% ` +
    `${String(s.exhaustExits).padStart(5)} ${s.exhaustAccuracy.toFixed(1).padStart(5)}% ${s.avgPostExitMove.toFixed(2).padStart(7)}%`
  );
}

// ─── Output: Engine B (Supertrend) Results ──────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  ENGINE B: 4h Supertrend");
console.log("=".repeat(110));
console.log(
  `${"Overlay".padEnd(42)} ${"Trades".padStart(6)} ${"$/day".padStart(7)} ${"WR%".padStart(6)} ` +
  `${"PF".padStart(5)} ${"MaxDD".padStart(7)} ${"Give%".padStart(6)} ` +
  `${"ExhEx".padStart(5)} ${"ExAcc%".padStart(6)} ${"PostMv%".padStart(8)}`
);
console.log("-".repeat(110));

const baseB = allResults[0].statsB;
for (const r of allResults) {
  const s = r.statsB;
  const pdDelta = s.perDay - baseB.perDay;
  const pdStr = `${s.perDay >= 0 ? "+" : ""}$${s.perDay.toFixed(2)}`;
  const deltaStr = r.overlay.name === "baseline" ? "" : ` (${pdDelta >= 0 ? "+" : ""}${pdDelta.toFixed(2)})`;
  console.log(
    `${r.overlay.label.padEnd(42)} ${String(s.trades).padStart(6)} ${(pdStr + deltaStr).padStart(7 + deltaStr.length)} ${s.wr.toFixed(1).padStart(6)} ` +
    `${s.pf.toFixed(2).padStart(5)} ${"$" + s.maxDd.toFixed(0).padStart(6)} ${s.avgGiveback.toFixed(1).padStart(5)}% ` +
    `${String(s.exhaustExits).padStart(5)} ${s.exhaustAccuracy.toFixed(1).padStart(5)}% ${s.avgPostExitMove.toFixed(2).padStart(7)}%`
  );
}

// ─── Exit reason breakdown for each overlay ─────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  EXIT REASON BREAKDOWN (all overlays)");
console.log("=".repeat(110));

for (const r of allResults) {
  const reasons = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const t of r.trades) {
    const curr = reasons.get(t.reason) ?? { count: 0, pnl: 0, wins: 0 };
    curr.count++;
    curr.pnl += t.pnl;
    if (t.pnl > 0) curr.wins++;
    reasons.set(t.reason, curr);
  }
  console.log(`\n  ${r.overlay.label}`);
  console.log(`  ${"Reason".padEnd(22)} ${"Count".padStart(6)} ${"PnL".padStart(10)} ${"AvgPnl".padStart(8)} ${"WR%".padStart(6)}`);
  console.log("  " + "-".repeat(56));
  for (const [reason, data] of [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      `  ${reason.padEnd(22)} ${String(data.count).padStart(6)} ${(data.pnl >= 0 ? "+" : "") + "$" + data.pnl.toFixed(2).padStart(8)} ` +
      `${(data.pnl / data.count >= 0 ? "+" : "") + "$" + (data.pnl / data.count).toFixed(2).padStart(6)} ` +
      `${(data.wins / data.count * 100).toFixed(1).padStart(6)}`
    );
  }
}

// ─── Exhaustion exit quality deep-dive ──────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  EXHAUSTION EXIT QUALITY ANALYSIS");
console.log("  PostExitMove: negative = price reversed after exit (good), positive = price continued (bad)");
console.log("=".repeat(110));

for (const r of allResults) {
  if (r.overlay.name === "baseline") continue;
  const exhaustTrades = r.trades.filter(t => t.reason.startsWith("exhaust_"));
  if (exhaustTrades.length === 0) continue;

  console.log(`\n  ${r.overlay.label} (${exhaustTrades.length} exhaustion exits)`);

  // Bucket by engine
  for (const eng of ["A", "B"]) {
    const engTrades = exhaustTrades.filter(t => t.engine === eng);
    if (engTrades.length === 0) continue;
    const goodExits = engTrades.filter(t => t.postExitMove < 0);
    const avgMove = engTrades.reduce((s, t) => s + t.postExitMove, 0) / engTrades.length;
    const avgPnl = engTrades.reduce((s, t) => s + t.pnl, 0) / engTrades.length;
    console.log(
      `    Engine ${eng}: ${engTrades.length} exits, ` +
      `accuracy ${(goodExits.length / engTrades.length * 100).toFixed(1)}%, ` +
      `avg post-move ${(avgMove * 100).toFixed(2)}%, ` +
      `avg pnl ${avgPnl >= 0 ? "+" : ""}$${avgPnl.toFixed(2)}`
    );
  }

  // By direction
  for (const dir of ["long", "short"] as Dir[]) {
    const dirTrades = exhaustTrades.filter(t => t.dir === dir);
    if (dirTrades.length === 0) continue;
    const goodExits = dirTrades.filter(t => t.postExitMove < 0);
    const avgMove = dirTrades.reduce((s, t) => s + t.postExitMove, 0) / dirTrades.length;
    console.log(
      `    ${dir}: ${dirTrades.length} exits, ` +
      `accuracy ${(goodExits.length / dirTrades.length * 100).toFixed(1)}%, ` +
      `avg post-move ${(avgMove * 100).toFixed(2)}%`
    );
  }
}

// ─── Summary verdict ────────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  VERDICT");
console.log("=".repeat(110));

const ranked = allResults
  .map(r => ({
    name: r.overlay.name,
    label: r.overlay.label,
    perDay: r.stats.perDay,
    giveback: r.stats.avgGiveback,
    delta: r.stats.perDay - baseStats.perDay,
    ddDelta: r.stats.maxDd - baseStats.maxDd,
    exhaustAcc: r.stats.exhaustAccuracy,
  }))
  .sort((a, b) => b.perDay - a.perDay);

for (const r of ranked) {
  const verdict = r.name === "baseline" ? "BASELINE"
    : r.delta > 0.05 ? "IMPROVES"
    : r.delta < -0.05 ? "HURTS"
    : "NEUTRAL";
  console.log(
    `  ${verdict.padEnd(10)} ${r.label.padEnd(42)} $/day: ${r.perDay >= 0 ? "+" : ""}$${r.perDay.toFixed(2)} ` +
    `(delta: ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)})  giveback: ${r.giveback.toFixed(1)}%  ` +
    `DD delta: ${r.ddDelta >= 0 ? "+" : ""}$${r.ddDelta.toFixed(0)}  ` +
    `exhaust accuracy: ${r.exhaustAcc.toFixed(1)}%`
  );
}

console.log("\nDone.");
