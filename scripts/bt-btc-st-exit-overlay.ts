/**
 * BTC 1h Supertrend Exit Overlay Backtest
 *
 * Tests whether exiting when BTC 1h Supertrend(10, 1.5) flips against your altcoin
 * position improves the full ensemble system's results.
 *
 * Methodology:
 * 1. Run baseline (no overlay) to build the trade pool
 * 2. Re-run with identical entries, applying overlay exit logic on 1m bars
 * 3. Compare same-trade sets for fair evaluation
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && \
 *      NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-btc-st-exit-overlay.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const CACHE_1M = "/tmp/bt-pair-cache-1m";
const M1 = 60_000;
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
  NEAR: 3.0e-4, ZEC: 4.5e-4, FET: 3.5e-4, BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const WANTED_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX",
  "NEAR","SUI","FET",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-28").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string; engine: string; dir: Dir;
  ep: number; et: number; sl: number; tp: number;
  margin: number; lev: number; maxHold: number;
  atr: number; bestPnlAtr: number;
  peakPrice: number; // for giveback tracking
}

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number;
  pnl: number; margin: number;
  peakPnlPct: number; // best leveraged P&L % during trade
  exitReason: string;
}

// ─── Data Loading ───────────────────────────────────────────────────
function loadCandles(pair: string, cacheDir: string): C[] {
  const fp = path.join(cacheDir, `${pair}USDT.json`);
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

// ─── Indicators (SMA ATR, not Wilder's) ────────────────────────────
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
  // Seed with SMA of first `period` values
  let seed = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i < period) {
      seed += vals[i];
      if (i === period - 1) {
        seed /= period;
        r[i] = seed;
      }
    } else {
      seed = vals[i] * k + seed * (1 - k);
      r[i] = seed;
    }
  }
  return r;
}

/** SMA-based ATR (simple average of last N TRs) */
function atrSMA(bars: Bar[], period: number): (number | null)[] {
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
    if (i >= period - 1) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += trs[j];
      r[i] = s / period;
    }
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
  const atrVals = atrSMA(bars, atrPeriod);
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

/** Z-score with vol window = 21 (returns), retLag = 3 */
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

function stdDev(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  for (let i = period - 1; i < vals.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += vals[j];
    const mean = sum / period;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (vals[j] - mean) ** 2;
    r[i] = Math.sqrt(sumSq / period);
  }
  return r;
}

// ─── Data Structures ────────────────────────────────────────────────
interface PairData {
  m5: C[]; h1: Bar[]; h4: Bar[]; daily: Bar[];
  h1Map: Map<number, number>; h4Map: Map<number, number>; dailyMap: Map<number, number>;
}

interface BTCData {
  daily: Bar[]; h1: Bar[]; h4: Bar[];
  dailyEma20: (number | null)[]; dailyEma50: (number | null)[];
  h1Ema9: (number | null)[]; h1Ema21: (number | null)[];
  dailyMap: Map<number, number>; h1Map: Map<number, number>; h4Map: Map<number, number>;
  // BTC 1h Supertrend for overlay
  h1StTrend: (1 | -1 | null)[];
  // BTC 1h EMA(9)/EMA(21) for alt overlay
  h1Ema9overlay: (number | null)[]; h1Ema21overlay: (number | null)[];
}

interface EngAData {
  sma20: (number | null)[]; sma50: (number | null)[];
  donLo15: (number | null)[]; donHi15: (number | null)[];
  atr14: (number | null)[];
}
interface EngBData {
  st: (1 | -1 | null)[]; atr14: (number | null)[];
}
interface EngCData {
  h1z: number[]; h4z: number[];
  h1ema9: (number | null)[]; h1ema21: (number | null)[];
  h1atr14: (number | null)[];
}
interface EngMData {
  volZ: (number | null)[];
  fundingZ: (number | null)[];
  priceZ: (number | null)[];
}

// ─── Pair 1m data for exit precision ────────────────────────────────
interface Pair1mData {
  m1: C[];
  m1Map: Map<number, number>; // aligned minute -> index
}

// ─── Global data ────────────────────────────────────────────────────
let btc: BTCData;
let btc1m: C[];
let available: string[] = [];
let pairData: Map<string, PairData>;
let pair1mData: Map<string, Pair1mData>;
let engAMap: Map<string, EngAData>;
let engBMap: Map<string, EngBData>;
let engCMap: Map<string, EngCData>;
let engMMap: Map<string, EngMData>;

function prepBTC(m5: C[]): BTCData {
  const daily = aggregate(m5, DAY);
  const h1 = aggregate(m5, H1);
  const h4 = aggregate(m5, H4);
  const dc = daily.map(b => b.c);
  const hc = h1.map(b => b.c);

  // BTC 1h Supertrend(10, 1.5) for overlay
  const h1StTrend = supertrend(h1, 10, 1.5).trend;

  return {
    daily, h1, h4,
    dailyEma20: ema(dc, 20), dailyEma50: ema(dc, 50),
    h1Ema9: ema(hc, 9), h1Ema21: ema(hc, 21),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
    h1Map: new Map(h1.map((b, i) => [b.t, i])),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    h1StTrend,
    h1Ema9overlay: ema(hc, 9),
    h1Ema21overlay: ema(hc, 21),
  };
}

function prepPair(m5: C[]): PairData {
  const h1 = aggregate(m5, H1);
  const h4 = aggregate(m5, H4);
  const daily = aggregate(m5, DAY);
  return {
    m5, h1, h4, daily,
    h1Map: new Map(h1.map((b, i) => [b.t, i])),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
  };
}

function prep1m(m1: C[]): Pair1mData {
  return {
    m1,
    m1Map: new Map(m1.map((b, i) => [b.t, i])),
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

function loadAllData() {
  console.log("Loading 5m data...");
  const btcRaw = loadCandles("BTC", CACHE_5M);
  if (btcRaw.length === 0) { console.log("No BTC 5m data!"); process.exit(1); }
  btc = prepBTC(btcRaw);

  console.log("Loading BTC 1m data for overlay precision...");
  btc1m = loadCandles("BTC", CACHE_1M);
  console.log(`  BTC 1m bars: ${btc1m.length}`);

  pairData = new Map();
  pair1mData = new Map();
  available = [];
  for (const p of WANTED_PAIRS) {
    const m5 = loadCandles(p, CACHE_5M);
    if (m5.length < 500) continue;
    available.push(p);
    pairData.set(p, prepPair(m5));
  }
  console.log(`Loaded ${available.length} pairs (5m): ${available.join(", ")}`);

  // Load 1m data for each pair (for exit precision)
  console.log("Loading 1m data for exit precision...");
  for (const p of available) {
    const m1 = loadCandles(p, CACHE_1M);
    if (m1.length > 0) {
      pair1mData.set(p, prep1m(m1));
    }
  }
  console.log(`Loaded 1m data for ${pair1mData.size} pairs`);

  engAMap = new Map();
  engBMap = new Map();
  engCMap = new Map();
  engMMap = new Map();

  for (const p of available) {
    const pd = pairData.get(p)!;
    const dc = pd.daily.map(b => b.c);

    engAMap.set(p, {
      sma20: sma(dc, 20), sma50: sma(dc, 50),
      donLo15: donchianLow(dc, 15), donHi15: donchianHigh(dc, 15),
      atr14: atrSMA(pd.daily, 14),
    });

    engBMap.set(p, {
      st: supertrend(pd.h4, 14, 1.75).trend,
      atr14: atrSMA(pd.h4, 14),
    });

    const h1c = pd.h1.map(b => b.c);
    const h4c = pd.h4.map(b => b.c);
    engCMap.set(p, {
      h1z: zScore(h1c, 3, 21), h4z: zScore(h4c, 3, 21),
      h1ema9: ema(h1c, 9), h1ema21: ema(h1c, 21),
      h1atr14: atrSMA(pd.h1, 14),
    });

    // Momentum engine indicators on 4h bars
    const h4v = pd.h4.map(b => b.v);
    const h4closes = pd.h4.map(b => b.c);

    const volZ: (number | null)[] = new Array(pd.h4.length).fill(null);
    for (let i = 20; i < pd.h4.length; i++) {
      let sum = 0;
      for (let j = i - 20; j < i; j++) sum += h4v[j];
      const avg = sum / 20;
      let sumSq = 0;
      for (let j = i - 20; j < i; j++) sumSq += (h4v[j] - avg) ** 2;
      const std_ = Math.sqrt(sumSq / 20);
      if (std_ > 0) volZ[i] = (h4v[i] - avg) / std_;
    }

    const fundingProxy = pd.h4.map(b => (b.c - b.o) / b.c);
    const fundingZ: (number | null)[] = new Array(pd.h4.length).fill(null);
    for (let i = 50; i < pd.h4.length; i++) {
      let sum = 0;
      for (let j = i - 50; j < i; j++) sum += fundingProxy[j];
      const avg = sum / 50;
      let sumSq = 0;
      for (let j = i - 50; j < i; j++) sumSq += (fundingProxy[j] - avg) ** 2;
      const std_ = Math.sqrt(sumSq / 50);
      if (std_ > 0) fundingZ[i] = (fundingProxy[i] - avg) / std_;
    }

    const sma20h4 = sma(h4closes, 20);
    const std20h4 = stdDev(h4closes, 20);
    const priceZ: (number | null)[] = new Array(pd.h4.length).fill(null);
    for (let i = 0; i < pd.h4.length; i++) {
      if (sma20h4[i] !== null && std20h4[i] !== null && std20h4[i]! > 0) {
        priceZ[i] = (h4closes[i] - sma20h4[i]!) / std20h4[i]!;
      }
    }

    engMMap.set(p, { volZ, fundingZ, priceZ });
  }
  console.log("Indicators computed.\n");
}

// ─── BTC Overlay Signal Helpers ─────────────────────────────────────

/** Get BTC 1h Supertrend direction at given time (completed bar) */
function btcH1StDir(t: number): 1 | -1 | null {
  // Use the completed 1h bar: strict less-than
  const aligned = Math.floor(t / H1) * H1;
  // We want the bar that ended before or at t
  const barT = aligned === t ? aligned - H1 : aligned;
  const idx = btc.h1Map.get(barT);
  if (idx === undefined) {
    // fallback search
    for (let dt = H1; dt <= 5 * H1; dt += H1) {
      const idx2 = btc.h1Map.get(barT - dt);
      if (idx2 !== undefined) return btc.h1StTrend[idx2];
    }
    return null;
  }
  return btc.h1StTrend[idx];
}

/** Check if BTC 1h ST flipped at a given 1h boundary */
function btcH1StFlippedAt(h1BoundaryT: number): { flipped: boolean; newDir: 1 | -1 | null } {
  const idx = btc.h1Map.get(h1BoundaryT);
  if (idx === undefined || idx < 1) return { flipped: false, newDir: null };
  const curr = btc.h1StTrend[idx];
  const prev = btc.h1StTrend[idx - 1];
  if (curr === null || prev === null) return { flipped: false, newDir: null };
  if (curr !== prev) return { flipped: true, newDir: curr };
  return { flipped: false, newDir: curr };
}

/** Check if BTC 1h EMA(9) crossed below EMA(21) at a given 1h boundary */
function btcH1EmaCrossedBearish(h1BoundaryT: number): boolean {
  const idx = btc.h1Map.get(h1BoundaryT);
  if (idx === undefined || idx < 1) return false;
  const e9now = btc.h1Ema9overlay[idx];
  const e21now = btc.h1Ema21overlay[idx];
  const e9prev = btc.h1Ema9overlay[idx - 1];
  const e21prev = btc.h1Ema21overlay[idx - 1];
  if (e9now === null || e21now === null || e9prev === null || e21prev === null) return false;
  // Bearish cross: was above, now below
  return e9prev >= e21prev && e9now < e21now;
}

/** Check if BTC 1h EMA(9) crossed above EMA(21) at a given 1h boundary */
function btcH1EmaCrossedBullish(h1BoundaryT: number): boolean {
  const idx = btc.h1Map.get(h1BoundaryT);
  if (idx === undefined || idx < 1) return false;
  const e9now = btc.h1Ema9overlay[idx];
  const e21now = btc.h1Ema21overlay[idx];
  const e9prev = btc.h1Ema9overlay[idx - 1];
  const e21prev = btc.h1Ema21overlay[idx - 1];
  if (e9now === null || e21now === null || e9prev === null || e21prev === null) return false;
  return e9prev <= e21prev && e9now > e21now;
}

// ─── Baseline Backtest (build trade pool, no overlay) ───────────────

function btcBullish(t: number): boolean {
  // Use strict less-than: btcDaily[i].t < t to exclude incomplete bar
  let bestIdx = -1;
  for (let i = btc.daily.length - 1; i >= 0; i--) {
    if (btc.daily[i].t < t) { bestIdx = i; break; }
  }
  if (bestIdx < 0) return false;
  const e20 = btc.dailyEma20[bestIdx], e50 = btc.dailyEma50[bestIdx];
  return e20 !== null && e50 !== null && e20 > e50;
}

function btcH1Bullish(t: number): boolean {
  let bestIdx = -1;
  for (let i = btc.h1.length - 1; i >= 0; i--) {
    if (btc.h1[i].t < t) { bestIdx = i; break; }
  }
  if (bestIdx < 0) return false;
  const e9 = btc.h1Ema9[bestIdx], e21 = btc.h1Ema21[bestIdx];
  return e9 !== null && e21 !== null && e9 > e21;
}

function btcH4Ema20gt50(t: number): boolean {
  // Need BTC h4 EMA20/50 -- compute on the fly (not stored in BTCData)
  // For Momentum engine filter, approximate using btcBullish (daily)
  return btcBullish(t);
}

function btc30dRet(t: number): number {
  let bestIdx = -1;
  for (let i = btc.daily.length - 1; i >= 0; i--) {
    if (btc.daily[i].t < t) { bestIdx = i; break; }
  }
  if (bestIdx < 0 || bestIdx < 30) return 0;
  return btc.daily[bestIdx].c / btc.daily[bestIdx - 30].c - 1;
}

interface BaselineEntry {
  pair: string; engine: string; dir: Dir;
  ep: number; et: number; sl: number; tp: number;
  margin: number; lev: number; maxHold: number;
  atr: number;
}

function runBaseline(): { trades: Trade[]; entries: BaselineEntry[] } {
  const MAX_POSITIONS = 20;
  const sizes: Record<string, number> = { A: 7, B: 5, C: 3, M: 3 };

  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const entries: BaselineEntry[] = [];

  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    dailyTimestamps.push(t);
  }

  function totalPositions(): number { return positions.size; }
  function positionsForEngine(eng: string): Position[] {
    return [...positions.values()].filter(p => p.engine === eng);
  }

  function closePosition(key: string, exitPrice: number, exitTime: number, slippageMult: number = 1, reason: string = "native") {
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
    const cost = notional * FEE * 2;
    const pnl = raw - cost;

    // Peak PnL % (leveraged) during trade
    const peakPnlPct = pos.dir === "long"
      ? (pos.peakPrice / pos.ep - 1) * pos.lev * 100
      : (pos.ep / pos.peakPrice - 1) * pos.lev * 100;

    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl, margin: pos.margin,
      peakPnlPct: Math.max(0, peakPnlPct),
      exitReason: reason,
    });
    positions.delete(key);
  }

  for (const dayT of dailyTimestamps) {
    // ─── UPDATE PEAK PRICES (using daily bars) ──────────────────────
    for (const [, pos] of positions) {
      const pd = pairData.get(pos.pair);
      if (!pd) continue;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;
      const bar = pd.daily[di];
      if (pos.dir === "long") {
        if (bar.h > pos.peakPrice) pos.peakPrice = bar.h;
      } else {
        if (bar.l < pos.peakPrice) pos.peakPrice = bar.l;
      }
    }

    // ─── CHECK EXISTING POSITIONS ──────────────────────────────────

    // Engine B/M: check on 4h bars within this day
    for (const [key, pos] of [...positions.entries()]) {
      if (pos.engine !== "B" && pos.engine !== "M") continue;
      const pd = pairData.get(pos.pair);
      if (!pd) continue;

      let exited = false;
      for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
        const h4T = dayT + h4Offset;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined) continue;
        const bar = pd.h4[h4i];

        // Update peak
        if (pos.dir === "long" && bar.h > pos.peakPrice) pos.peakPrice = bar.h;
        if (pos.dir === "short" && bar.l < pos.peakPrice) pos.peakPrice = bar.l;

        // Stop-loss
        if (pos.dir === "long" && bar.l <= pos.sl) {
          closePosition(key, pos.sl, h4T, SL_SLIPPAGE, "sl"); exited = true; break;
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          closePosition(key, pos.sl, h4T, SL_SLIPPAGE, "sl"); exited = true; break;
        }

        // Max hold
        if (h4T - pos.et >= pos.maxHold) {
          closePosition(key, bar.c, h4T, 1, "maxhold"); exited = true; break;
        }

        // Engine B: Supertrend flip exit
        if (pos.engine === "B") {
          const eb = engBMap.get(pos.pair);
          if (eb && h4i >= 2) {
            const stNow = eb.st[h4i - 1];
            if (stNow !== null) {
              if (pos.dir === "long" && stNow === -1) {
                closePosition(key, bar.c, h4T, 1, "st-flip"); exited = true; break;
              }
              if (pos.dir === "short" && stNow === 1) {
                closePosition(key, bar.c, h4T, 1, "st-flip"); exited = true; break;
              }
            }
          }
        }
      }
      if (exited) continue;
    }

    // Engine A/C: check on daily bar
    for (const [key, pos] of [...positions.entries()]) {
      if (pos.engine === "B" || pos.engine === "M") continue;
      if (!positions.has(key)) continue;
      const pd = pairData.get(pos.pair);
      if (!pd) continue;

      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;
      const bar = pd.daily[di];

      // Stop-loss
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePosition(key, pos.sl, dayT, SL_SLIPPAGE, "sl"); continue;
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        closePosition(key, pos.sl, dayT, SL_SLIPPAGE, "sl"); continue;
      }

      // TP (Engine C: 7%)
      if (pos.tp > 0) {
        if (pos.dir === "long" && bar.h >= pos.tp) {
          closePosition(key, pos.tp, dayT, 1, "tp"); continue;
        } else if (pos.dir === "short" && bar.l <= pos.tp) {
          closePosition(key, pos.tp, dayT, 1, "tp"); continue;
        }
      }

      // Max hold
      if (dayT - pos.et >= pos.maxHold) {
        closePosition(key, bar.c, dayT, 1, "maxhold"); continue;
      }

      // Engine A: Donchian exit
      if (pos.engine === "A") {
        const ea = engAMap.get(pos.pair);
        if (ea && di > 0) {
          if (pos.dir === "long" && ea.donLo15[di] !== null && bar.c < ea.donLo15[di]!) {
            closePosition(key, bar.c, dayT, 1, "donch-exit"); continue;
          }
          if (pos.dir === "short" && ea.donHi15[di] !== null && bar.c > ea.donHi15[di]!) {
            closePosition(key, bar.c, dayT, 1, "donch-exit"); continue;
          }
        }
      }
    }

    // ─── ENGINE A: Daily Donchian Trend (SMA 20/50 cross) ──────────
    for (const p of available) {
      if (totalPositions() >= MAX_POSITIONS) break;
      const key = `A:${p}`;
      if (positions.has(key)) continue;

      const pd = pairData.get(p)!;
      const ea = engAMap.get(p)!;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 51) continue;

      const bar = pd.daily[di];
      // Fix: crossover uses i-1 vs i-2, enter at bar[i] open
      const sma20now = ea.sma20[di - 1], sma50now = ea.sma50[di - 1];
      const sma20prev = ea.sma20[di - 2], sma50prev = ea.sma50[di - 2];
      if (sma20now === null || sma50now === null || sma20prev === null || sma50prev === null) continue;

      let dir: Dir | null = null;
      if (sma20prev <= sma50prev && sma20now > sma50now) {
        if (btcBullish(dayT)) dir = "long";
      }
      if (sma20prev >= sma50prev && sma20now < sma50now) {
        dir = "short";
      }
      if (!dir) continue;

      const atrVal = ea.atr14[di - 1];
      if (atrVal === null) continue;

      const sp_ = sp(p);
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      const pos: Position = {
        pair: p, engine: "A", dir, ep, et: dayT, sl, tp: 0,
        margin: sizes["A"], lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
        peakPrice: ep,
      };
      positions.set(key, pos);
      entries.push({ pair: p, engine: "A", dir, ep, et: dayT, sl, tp: 0, margin: sizes["A"], lev: 10, maxHold: 60 * DAY, atr: atrVal });
    }

    // ─── ENGINE B: 4h Supertrend ────────────────────────────────────
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

        const btcRet = btc30dRet(h4T);
        if (btcRet < -0.10 && dir === "long") continue;
        if (btcRet > 0.15 && dir === "short") continue;
        if (dir === "long" && !btcBullish(h4T)) continue;

        const atrVal = eb.atr14[h4i - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p);
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        const pos: Position = {
          pair: p, engine: "B", dir, ep, et: h4T, sl, tp: 0,
          margin: sizes["B"], lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
          peakPrice: ep,
        };
        positions.set(key, pos);
        entries.push({ pair: p, engine: "B", dir, ep, et: h4T, sl, tp: 0, margin: sizes["B"], lev: 10, maxHold: 60 * DAY, atr: atrVal });
      }
    }

    // ─── ENGINE C: GARCH v2 MTF ─────────────────────────────────────
    for (let h1Offset = 0; h1Offset < DAY; h1Offset += H1) {
      const h1T = dayT + h1Offset;
      for (const p of available) {
        if (totalPositions() >= MAX_POSITIONS) break;
        const key = `C:${p}`;
        if (positions.has(key)) continue;

        const cPositions = positionsForEngine("C");
        const cLongs = cPositions.filter(x => x.dir === "long").length;
        const cShorts = cPositions.filter(x => x.dir === "short").length;

        const pd = pairData.get(p)!;
        const ec = engCMap.get(p)!;
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
        if (h1z > 4.5 && h4z > 3.0 && h1e9 > h1e21 && btcH1Bullish(h1T)) {
          if (cLongs < 6) dir = "long";
        }
        if (h1z < -3.0 && h4z < -3.0 && h1e9 < h1e21 && !btcH1Bullish(h1T)) {
          if (cShorts < 6) dir = "short";
        }
        if (!dir) continue;

        // Volume + range filter
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
        // 3% SL, capped 3.5%
        let slDist = ep * 0.03;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        // 7% TP
        const tp = dir === "long" ? ep * 1.07 : ep * 0.93;

        const h1atr = ec.h1atr14[h1i - 1] ?? (ep * 0.02);

        const pos: Position = {
          pair: p, engine: "C", dir, ep, et: h1T, sl, tp,
          margin: sizes["C"], lev: 10, maxHold: 96 * H1, atr: h1atr as number, bestPnlAtr: 0,
          peakPrice: ep,
        };
        positions.set(key, pos);
        entries.push({ pair: p, engine: "C", dir, ep, et: h1T, sl, tp, margin: sizes["C"], lev: 10, maxHold: 96 * H1, atr: h1atr as number });
      }
    }

    // ─── ENGINE M: Momentum Confirmation (4h) ───────────────────────
    for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
      const h4T = dayT + h4Offset;
      for (const p of available) {
        if (totalPositions() >= MAX_POSITIONS) break;
        const key = `M:${p}`;
        if (positions.has(key)) continue;

        const pd = pairData.get(p)!;
        const em = engMMap.get(p)!;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined || h4i < 51) continue;

        const vz = em.volZ[h4i - 1];
        const fz = em.fundingZ[h4i - 1];
        const pz = em.priceZ[h4i - 1];
        if (vz === null || fz === null || pz === null) continue;

        let dir: Dir | null = null;
        if (vz > 2 && fz > 2 && pz > 1) {
          if (btcH4Ema20gt50(h4T)) dir = "long";
        }
        if (vz > 2 && fz < -2 && pz < -1) {
          dir = "short";
        }
        if (!dir) continue;

        const sp_ = sp(p);
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
        const slDist = ep * 0.03;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        const pos: Position = {
          pair: p, engine: "M", dir, ep, et: h4T, sl, tp: 0,
          margin: sizes["M"], lev: 10, maxHold: 48 * H1, atr: 0, bestPnlAtr: 0,
          peakPrice: ep,
        };
        positions.set(key, pos);
        entries.push({ pair: p, engine: "M", dir, ep, et: h4T, sl, tp: 0, margin: sizes["M"], lev: 10, maxHold: 48 * H1, atr: 0 });
      }
    }
  }

  // Close remaining positions
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairData.get(pos.pair);
    if (!pd || pd.daily.length === 0) continue;
    const lastBar = pd.daily[pd.daily.length - 1];
    closePosition(key, lastBar.c, lastBar.t, 1, "end-of-data");
  }

  return { trades, entries };
}

// ─── Overlay Backtest (apply overlay to same entry set) ─────────────

type OverlayMode =
  | "none"                    // baseline
  | "btc-st-any"             // BTC ST flip, any position
  | "btc-st-profit"          // BTC ST flip, only when in profit
  | "btc-st-profit5"         // BTC ST flip, only when in profit >5% leveraged
  | "btc-st-profit10"        // BTC ST flip, only when in profit >10% leveraged
  | "btc-ema-cross";         // BTC 1h EMA(9) crossing below EMA(21)

function runWithOverlay(baselineEntries: BaselineEntry[], mode: OverlayMode): Trade[] {
  const MAX_POSITIONS = 20;
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];

  // Sort entries by time
  const sortedEntries = [...baselineEntries].sort((a, b) => a.et - b.et);

  // Build a timeline of all 1h boundaries for overlay checks
  // We iterate day-by-day, checking 1h boundaries within each day
  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    dailyTimestamps.push(t);
  }

  // Entry index pointer
  let entryIdx = 0;

  function totalPositions(): number { return positions.size; }

  function closePosition(key: string, exitPrice: number, exitTime: number, slippageMult: number = 1, reason: string = "native") {
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
    const cost = notional * FEE * 2;
    const pnl = raw - cost;

    const peakPnlPct = pos.dir === "long"
      ? (pos.peakPrice / pos.ep - 1) * pos.lev * 100
      : (pos.ep / pos.peakPrice - 1) * pos.lev * 100;

    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl, margin: pos.margin,
      peakPnlPct: Math.max(0, peakPnlPct),
      exitReason: reason,
    });
    positions.delete(key);
  }

  /** Get 1m price for a pair at given time, return close. */
  function get1mClose(pair: string, t: number): number | null {
    const p1m = pair1mData.get(pair);
    if (!p1m) return null;
    const aligned = Math.floor(t / M1) * M1;
    const idx = p1m.m1Map.get(aligned);
    if (idx !== undefined) return p1m.m1[idx].c;
    // Try next few minutes
    for (let dt = M1; dt <= 5 * M1; dt += M1) {
      const idx2 = p1m.m1Map.get(aligned + dt);
      if (idx2 !== undefined) return p1m.m1[idx2].c;
    }
    return null;
  }

  /** Get current leveraged P&L % for a position at a given price */
  function getLevPnlPct(pos: Position, price: number): number {
    if (pos.dir === "long") {
      return (price / pos.ep - 1) * pos.lev * 100;
    } else {
      return (pos.ep / price - 1) * pos.lev * 100;
    }
  }

  /** Check if overlay should fire for this position at this price */
  function shouldOverlayFire(pos: Position, price: number, overlayMode: OverlayMode): boolean {
    if (overlayMode === "none") return false;

    const levPnlPct = getLevPnlPct(pos, price);

    if (overlayMode === "btc-st-any") return true;
    if (overlayMode === "btc-st-profit") return levPnlPct > 0;
    if (overlayMode === "btc-st-profit5") return levPnlPct > 5;
    if (overlayMode === "btc-st-profit10") return levPnlPct > 10;
    if (overlayMode === "btc-ema-cross") return levPnlPct > 0; // same profit filter for EMA variant

    return false;
  }

  for (const dayT of dailyTimestamps) {
    // Add entries that occur on or before this day
    while (entryIdx < sortedEntries.length && sortedEntries[entryIdx].et <= dayT + DAY - 1) {
      const e = sortedEntries[entryIdx];
      const key = `${e.engine}:${e.pair}`;
      if (!positions.has(key) && totalPositions() < MAX_POSITIONS) {
        positions.set(key, {
          pair: e.pair, engine: e.engine, dir: e.dir,
          ep: e.ep, et: e.et, sl: e.sl, tp: e.tp,
          margin: e.margin, lev: e.lev, maxHold: e.maxHold,
          atr: e.atr, bestPnlAtr: 0,
          peakPrice: e.ep,
        });
      }
      entryIdx++;
    }

    // ─── OVERLAY CHECK: scan 1h boundaries within this day ──────────
    if (mode !== "none") {
      for (let h1Offset = 0; h1Offset < DAY; h1Offset += H1) {
        const h1T = dayT + h1Offset;

        let overlaySignalLong = false;  // signal to exit longs
        let overlaySignalShort = false; // signal to exit shorts

        if (mode === "btc-ema-cross") {
          // EMA variant: bearish cross -> exit longs, bullish cross -> exit shorts
          if (btcH1EmaCrossedBearish(h1T)) overlaySignalLong = true;
          if (btcH1EmaCrossedBullish(h1T)) overlaySignalShort = true;
        } else {
          // BTC ST flip variants
          const flip = btcH1StFlippedAt(h1T);
          if (flip.flipped) {
            if (flip.newDir === -1) overlaySignalLong = true;  // bearish flip -> exit longs
            if (flip.newDir === 1) overlaySignalShort = true;  // bullish flip -> exit shorts
          }
        }

        if (!overlaySignalLong && !overlaySignalShort) continue;

        // Exit on next 1m bar close after the flip
        const exit1mT = h1T + M1;

        for (const [key, pos] of [...positions.entries()]) {
          let shouldExit = false;
          if (pos.dir === "long" && overlaySignalLong) shouldExit = true;
          if (pos.dir === "short" && overlaySignalShort) shouldExit = true;
          if (!shouldExit) continue;

          // Get 1m price for exit precision
          let exitPrice = get1mClose(pos.pair, exit1mT);
          if (exitPrice === null) {
            // Fallback: use 5m bar
            const pd = pairData.get(pos.pair);
            if (!pd) continue;
            const m5Aligned = Math.floor(exit1mT / M5) * M5;
            for (let idx = 0; idx < pd.m5.length; idx++) {
              if (pd.m5[idx].t >= m5Aligned) { exitPrice = pd.m5[idx].c; break; }
            }
            if (exitPrice === null) continue;
          }

          if (shouldOverlayFire(pos, exitPrice, mode)) {
            closePosition(key, exitPrice, exit1mT, 1, "overlay");
          }
        }
      }
    }

    // ─── NATIVE EXIT CHECKS ─────────────────────────────────────────

    // Engine B/M: check on 4h bars
    for (const [key, pos] of [...positions.entries()]) {
      if (pos.engine !== "B" && pos.engine !== "M") continue;
      const pd = pairData.get(pos.pair);
      if (!pd) continue;

      let exited = false;
      for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
        const h4T = dayT + h4Offset;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined) continue;
        const bar = pd.h4[h4i];

        if (pos.dir === "long" && bar.h > pos.peakPrice) pos.peakPrice = bar.h;
        if (pos.dir === "short" && bar.l < pos.peakPrice) pos.peakPrice = bar.l;

        if (pos.dir === "long" && bar.l <= pos.sl) {
          closePosition(key, pos.sl, h4T, SL_SLIPPAGE, "sl"); exited = true; break;
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          closePosition(key, pos.sl, h4T, SL_SLIPPAGE, "sl"); exited = true; break;
        }

        if (h4T - pos.et >= pos.maxHold) {
          closePosition(key, bar.c, h4T, 1, "maxhold"); exited = true; break;
        }

        if (pos.engine === "B") {
          const eb = engBMap.get(pos.pair);
          if (eb && h4i >= 2) {
            const stNow = eb.st[h4i - 1];
            if (stNow !== null) {
              if (pos.dir === "long" && stNow === -1) {
                closePosition(key, bar.c, h4T, 1, "st-flip"); exited = true; break;
              }
              if (pos.dir === "short" && stNow === 1) {
                closePosition(key, bar.c, h4T, 1, "st-flip"); exited = true; break;
              }
            }
          }
        }
      }
      if (exited) continue;
    }

    // Engine A/C: check on daily bar
    for (const [key, pos] of [...positions.entries()]) {
      if (pos.engine === "B" || pos.engine === "M") continue;
      if (!positions.has(key)) continue;
      const pd = pairData.get(pos.pair);
      if (!pd) continue;

      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;
      const bar = pd.daily[di];

      if (pos.dir === "long" && bar.h > pos.peakPrice) pos.peakPrice = bar.h;
      if (pos.dir === "short" && bar.l < pos.peakPrice) pos.peakPrice = bar.l;

      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePosition(key, pos.sl, dayT, SL_SLIPPAGE, "sl"); continue;
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        closePosition(key, pos.sl, dayT, SL_SLIPPAGE, "sl"); continue;
      }

      if (pos.tp > 0) {
        if (pos.dir === "long" && bar.h >= pos.tp) {
          closePosition(key, pos.tp, dayT, 1, "tp"); continue;
        } else if (pos.dir === "short" && bar.l <= pos.tp) {
          closePosition(key, pos.tp, dayT, 1, "tp"); continue;
        }
      }

      if (dayT - pos.et >= pos.maxHold) {
        closePosition(key, bar.c, dayT, 1, "maxhold"); continue;
      }

      if (pos.engine === "A") {
        const ea = engAMap.get(pos.pair);
        if (ea && di > 0) {
          if (pos.dir === "long" && ea.donLo15[di] !== null && bar.c < ea.donLo15[di]!) {
            closePosition(key, bar.c, dayT, 1, "donch-exit"); continue;
          }
          if (pos.dir === "short" && ea.donHi15[di] !== null && bar.c > ea.donHi15[di]!) {
            closePosition(key, bar.c, dayT, 1, "donch-exit"); continue;
          }
        }
      }
    }
  }

  // Close remaining
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairData.get(pos.pair);
    if (!pd || pd.daily.length === 0) continue;
    const lastBar = pd.daily[pd.daily.length - 1];
    closePosition(key, lastBar.c, lastBar.t, 1, "end-of-data");
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  trades: number; pf: number; sharpe: number; perDay: number; wr: number;
  maxDd: number; totalPnl: number; avgGivebackPct: number;
  oosPerDay: number;
}

function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return {
    trades: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0,
    maxDd: 0, totalPnl: 0, avgGivebackPct: 0, oosPerDay: 0,
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

  // Sharpe
  const dailyPnl = new Map<number, number>();
  for (const t of sorted) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.pnl);
  }
  const dpVals = [...dailyPnl.values()];
  const mean = dpVals.length > 0 ? dpVals.reduce((a, b) => a + b, 0) / dpVals.length : 0;
  const std_ = dpVals.length > 1
    ? Math.sqrt(dpVals.reduce((s, v) => s + (v - mean) ** 2, 0) / (dpVals.length - 1))
    : 0;
  const sharpe = std_ > 0 ? (mean / std_) * Math.sqrt(365) : 0;

  // MaxDD
  let equity = 0, peak = 0, maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  // Average giveback %: for trades with peak > 0, how much was given back
  const givebacks: number[] = [];
  for (const t of filtered) {
    if (t.peakPnlPct > 0.5) { // only count trades that had meaningful peak
      const exitPnlPct = t.dir === "long"
        ? (t.xp / t.ep - 1) * 10 * 100  // 10x leverage
        : (t.ep / t.xp - 1) * 10 * 100;
      const giveback = t.peakPnlPct > 0 ? (1 - exitPnlPct / t.peakPnlPct) * 100 : 0;
      givebacks.push(Math.max(0, Math.min(200, giveback)));
    }
  }
  const avgGivebackPct = givebacks.length > 0 ? givebacks.reduce((a, b) => a + b, 0) / givebacks.length : 0;

  // OOS $/day
  const oosTrades = trades.filter(t => t.et >= OOS_START && t.et < endMs);
  const oosDays = (endMs - OOS_START) / DAY;
  const oosPnl = oosTrades.reduce((s, t) => s + t.pnl, 0);
  const oosPerDay = oosDays > 0 ? oosPnl / oosDays : 0;

  return {
    trades: filtered.length,
    pf: Math.round(pf * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    perDay: Math.round(perDay * 100) / 100,
    wr: Math.round(wr * 1000) / 10,
    maxDd: Math.round(maxDd * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgGivebackPct: Math.round(avgGivebackPct * 10) / 10,
    oosPerDay: Math.round(oosPerDay * 100) / 100,
  };
}

// ─── Output Helpers ─────────────────────────────────────────────────
function pad(s: string, n: number): string { return s.padStart(n); }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "") + "$" + v.toFixed(2); }
function fmtPct(v: number): string { return v.toFixed(1) + "%"; }

function printHeader() {
  console.log(
    `${"Config".padEnd(28)} ${pad("Trades", 7)} ${pad("WR%", 7)} ${pad("Total", 10)} ` +
    `${pad("$/day", 8)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
    `${pad("MaxDD", 8)} ${pad("OOS$/d", 8)} ${pad("Givebk%", 8)}`
  );
  console.log("-".repeat(106));
}

function printLine(label: string, s: Stats) {
  console.log(
    `${label.padEnd(28)} ${pad(String(s.trades), 7)} ${pad(fmtPct(s.wr), 7)} ${pad(fmtPnl(s.totalPnl), 10)} ` +
    `${pad(fmtPnl(s.perDay), 8)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad("$" + s.maxDd.toFixed(0), 8)} ${pad(fmtPnl(s.oosPerDay), 8)} ${pad(fmtPct(s.avgGivebackPct), 8)}`
  );
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=".repeat(120));
console.log("  BTC 1h SUPERTREND EXIT OVERLAY BACKTEST");
console.log("  Full ensemble: Donchian SMA(20/50) $7 + Supertrend(14,1.75) $5 + GARCH v2 $3 + Momentum $3");
console.log("  23 pairs, 2023-01 to 2026-03, OOS from 2025-09, max 20 positions");
console.log("  BTC 1h Supertrend(10,1.5) overlay: exit when BTC ST flips against position");
console.log("  SMA ATR (not Wilder), proper half-spreads, Donchian SMA look-ahead fix");
console.log("  GARCH v2: 7% TP, 3% SL, 96h max hold, z-score vol window = 21");
console.log("  1m data used for overlay exit precision");
console.log("=".repeat(120));

loadAllData();

console.log("\n--- Phase 1: Building baseline trade pool (no overlay) ---\n");
const { trades: baselineTrades, entries: baselineEntries } = runBaseline();
const baselineStats = computeStats(baselineTrades, FULL_START, FULL_END);
console.log(`Baseline: ${baselineTrades.length} trades, ${baselineEntries.length} entries`);

// Count overlay trigger events for info
let overlayFlipCount = 0;
for (let t = FULL_START; t < FULL_END; t += H1) {
  const flip = btcH1StFlippedAt(t);
  if (flip.flipped) overlayFlipCount++;
}
console.log(`BTC 1h ST(10,1.5) flips in period: ${overlayFlipCount}`);

console.log("\n--- Phase 2: Running overlay variants on same entry set ---\n");

const modes: { mode: OverlayMode; label: string }[] = [
  { mode: "none",            label: "0. Baseline (no overlay)" },
  { mode: "btc-st-any",      label: "1. BTC ST flip (any)" },
  { mode: "btc-st-profit",   label: "2. BTC ST flip (profit>0)" },
  { mode: "btc-st-profit5",  label: "3. BTC ST flip (profit>5%)" },
  { mode: "btc-st-profit10", label: "4. BTC ST flip (profit>10%)" },
  { mode: "btc-ema-cross",   label: "5. BTC EMA(9)<EMA(21) cross" },
];

interface Result {
  label: string;
  mode: OverlayMode;
  stats: Stats;
  trades: Trade[];
}

const results: Result[] = [];

// Baseline uses its own trades (no overlay pass)
results.push({
  label: modes[0].label,
  mode: "none",
  stats: baselineStats,
  trades: baselineTrades,
});

for (const { mode, label } of modes.slice(1)) {
  console.log(`  Running: ${label}...`);
  const trades = runWithOverlay(baselineEntries, mode);
  const stats = computeStats(trades, FULL_START, FULL_END);
  results.push({ label, mode, stats, trades });
}

// ─── RESULTS TABLE ──────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  RESULTS: FULL PERIOD (2023-01 to 2026-03)");
console.log("=".repeat(120));
printHeader();
for (const r of results) {
  printLine(r.label, r.stats);
}

// ─── OOS ONLY TABLE ─────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  RESULTS: OOS ONLY (2025-09 to 2026-03)");
console.log("=".repeat(120));
printHeader();
for (const r of results) {
  const oosStats = computeStats(r.trades, OOS_START, FULL_END);
  printLine(r.label, oosStats);
}

// ─── IS ONLY TABLE ──────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  RESULTS: IN-SAMPLE ONLY (2023-01 to 2025-09)");
console.log("=".repeat(120));
printHeader();
for (const r of results) {
  const isStats = computeStats(r.trades, FULL_START, OOS_START);
  printLine(r.label, isStats);
}

// ─── OVERLAY-EXITED TRADE ANALYSIS ──────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  OVERLAY-EXITED TRADE ANALYSIS");
console.log("=".repeat(120));

for (const r of results.slice(1)) {
  const overlayExited = r.trades.filter(t => t.exitReason === "overlay");
  const nativeExited = r.trades.filter(t => t.exitReason !== "overlay");
  const overlayPnl = overlayExited.reduce((s, t) => s + t.pnl, 0);
  const nativePnl = nativeExited.reduce((s, t) => s + t.pnl, 0);
  const overlayWr = overlayExited.length > 0
    ? overlayExited.filter(t => t.pnl > 0).length / overlayExited.length * 100
    : 0;

  // Average P&L of overlay-exited trades
  const avgOverlayPnl = overlayExited.length > 0 ? overlayPnl / overlayExited.length : 0;

  // How many overlay exits were from each engine?
  const byEngine: Record<string, number> = {};
  for (const t of overlayExited) {
    byEngine[t.engine] = (byEngine[t.engine] ?? 0) + 1;
  }

  console.log(`\n${r.label}:`);
  console.log(`  Overlay exits: ${overlayExited.length} (${(overlayExited.length / r.trades.length * 100).toFixed(1)}% of trades)`);
  console.log(`  Overlay exits PnL: ${fmtPnl(overlayPnl)}, WR: ${overlayWr.toFixed(1)}%, avg: ${fmtPnl(avgOverlayPnl)}`);
  console.log(`  Native exits PnL:  ${fmtPnl(nativePnl)}`);
  console.log(`  By engine: ${Object.entries(byEngine).map(([e, n]) => `${e}=${n}`).join(", ")}`);

  // Compare giveback on overlay-exited vs all
  const overlayGivebacks: number[] = [];
  for (const t of overlayExited) {
    if (t.peakPnlPct > 0.5) {
      const exitPnlPct = t.dir === "long"
        ? (t.xp / t.ep - 1) * 10 * 100
        : (t.ep / t.xp - 1) * 10 * 100;
      const giveback = t.peakPnlPct > 0 ? (1 - exitPnlPct / t.peakPnlPct) * 100 : 0;
      overlayGivebacks.push(Math.max(0, Math.min(200, giveback)));
    }
  }
  const avgOverlayGiveback = overlayGivebacks.length > 0
    ? overlayGivebacks.reduce((a, b) => a + b, 0) / overlayGivebacks.length
    : 0;
  console.log(`  Avg giveback (overlay exits): ${avgOverlayGiveback.toFixed(1)}%`);
}

// ─── BASELINE VS BEST OVERLAY COMPARISON ────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  BASELINE vs OVERLAY: PER-ENGINE BREAKDOWN");
console.log("=".repeat(120));

const ENGINE_NAMES: Record<string, string> = {
  A: "Donchian", B: "Supertrend", C: "GARCH", M: "Momentum",
};

for (const r of results) {
  console.log(`\n${r.label}:`);
  console.log(
    `  ${"Engine".padEnd(16)} ${pad("Trades", 7)} ${pad("PF", 6)} ${pad("WR%", 7)} ` +
    `${pad("Total PnL", 11)} ${pad("$/day", 9)} ${pad("AvgPnl", 8)}`
  );
  console.log("  " + "-".repeat(72));

  const days = (FULL_END - FULL_START) / DAY;
  for (const eng of ["A", "B", "C", "M"]) {
    const et = r.trades.filter(t => t.engine === eng);
    const pnl = et.reduce((s, t) => s + t.pnl, 0);
    const wins = et.filter(t => t.pnl > 0);
    const losses = et.filter(t => t.pnl <= 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
    console.log(
      `  ${(eng + ": " + ENGINE_NAMES[eng]).padEnd(16)} ${pad(String(et.length), 7)} ${pad(pf.toFixed(2), 6)} ` +
      `${pad(fmtPct(et.length > 0 ? wins.length / et.length * 100 : 0), 7)} ` +
      `${pad(fmtPnl(pnl), 11)} ${pad(fmtPnl(pnl / days), 9)} ` +
      `${pad(fmtPnl(et.length > 0 ? pnl / et.length : 0), 8)}`
    );
  }
}

// ─── YEARLY BREAKDOWN FOR BEST CONFIGS ──────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  YEARLY BREAKDOWN");
console.log("=".repeat(120));

for (const r of results) {
  console.log(`\n${r.label}:`);
  printHeader();
  for (const year of [2023, 2024, 2025, 2026]) {
    const ys = new Date(`${year}-01-01`).getTime();
    const ye = new Date(`${year + 1}-01-01`).getTime();
    const s = computeStats(r.trades, ys, Math.min(ye, FULL_END));
    printLine(String(year), s);
  }
}

// ─── EXIT REASON DISTRIBUTION ───────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  EXIT REASON DISTRIBUTION (all configs)");
console.log("=".repeat(120));

for (const r of results) {
  const reasons: Record<string, { count: number; pnl: number }> = {};
  for (const t of r.trades) {
    if (!reasons[t.exitReason]) reasons[t.exitReason] = { count: 0, pnl: 0 };
    reasons[t.exitReason].count++;
    reasons[t.exitReason].pnl += t.pnl;
  }
  console.log(`\n${r.label}:`);
  for (const [reason, data] of Object.entries(reasons).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(16)} ${pad(String(data.count), 5)} trades  ${fmtPnl(data.pnl).padStart(10)}  avg: ${fmtPnl(data.pnl / data.count)}`);
  }
}

// ─── SUMMARY / VERDICT ──────────────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  SUMMARY");
console.log("=".repeat(120));

const baseline = results[0];
console.log(`\nBaseline: ${baseline.stats.trades} trades, PF ${baseline.stats.pf}, $/day ${fmtPnl(baseline.stats.perDay)}, MaxDD $${baseline.stats.maxDd}, Giveback ${baseline.stats.avgGivebackPct}%`);

for (const r of results.slice(1)) {
  const pnlDelta = r.stats.totalPnl - baseline.stats.totalPnl;
  const ddDelta = r.stats.maxDd - baseline.stats.maxDd;
  const givebackDelta = r.stats.avgGivebackPct - baseline.stats.avgGivebackPct;
  console.log(
    `${r.label}: PnL ${fmtPnl(pnlDelta)} (${pnlDelta >= 0 ? "better" : "worse"}), ` +
    `MaxDD ${ddDelta >= 0 ? "+" : ""}$${ddDelta.toFixed(0)} (${ddDelta <= 0 ? "better" : "worse"}), ` +
    `Giveback ${givebackDelta >= 0 ? "+" : ""}${givebackDelta.toFixed(1)}pp (${givebackDelta <= 0 ? "better" : "worse"})`
  );
}

console.log("\nDone.");
