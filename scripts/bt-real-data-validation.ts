/**
 * Real Alternative Data Validation Backtest
 *
 * Tests our EXISTING live 5-engine system with:
 *   A) Real Fear & Greed Index vs proxy regime
 *   B) SOPR as additional regime filter
 *   C) NUPL as macro regime
 *
 * Data: Real F&G from alternative.me (8yr), SOPR/NUPL from BTC price proxies
 * Engines: Donchian $7, Supertrend $5, GARCH $3, Carry $7, Momentum $3. Max 20 pos.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-real-data-validation.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const ALT_DIR = "/tmp/real-alt-data";
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

// Engine sizes: Donchian $7, Supertrend $5, GARCH $3, Carry $7, Momentum $3
const ENGINE_SIZES: Record<string, number> = { A: 7, B: 5, C: 3, D: 7, E: 3 };
const MAX_POSITIONS = 20;

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";
type Regime = "RISK-OFF" | "RECOVERY" | "RISK-ON" | "CORRECTION";

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

// ─── Alt Data Types ─────────────────────────────────────────────────
interface FngEntry { timestamp: number; value: number; }
interface SoprEntry { timestamp: number; value: number; }
interface NuplEntry { timestamp: number; value: number; }

interface RegimeConfig {
  mode: "none" | "proxy" | "real_fng" | "sopr" | "nupl" | "combined";
  fngData?: Map<number, number>;  // dayTs -> F&G value (0-100)
  soprData?: Map<number, number>; // dayTs -> SOPR value
  nuplData?: Map<number, number>; // dayTs -> NUPL value
  dirFilter: boolean;    // apply direction bias
  sizeFilter: boolean;   // apply size multiplier
  soprFilter?: "long_only" | "short_only" | "combined";
  nuplSizing?: boolean;  // NUPL-based position sizing
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

// ─── Load Real F&G Data ─────────────────────────────────────────────
function loadFearGreed(): Map<number, number> {
  const fp = path.join(ALT_DIR, "fng.json");
  if (!fs.existsSync(fp)) { console.log("No F&G data!"); return new Map(); }
  const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
  const data = raw.data as { value: string; timestamp: string }[];
  const map = new Map<number, number>();
  for (const d of data) {
    const ts = parseInt(d.timestamp) * 1000; // seconds -> ms
    const dayTs = Math.floor(ts / DAY) * DAY;
    map.set(dayTs, parseInt(d.value));
  }
  console.log(`  Loaded ${map.size} F&G data points (${new Date(Math.min(...map.keys())).toISOString().slice(0,10)} to ${new Date(Math.max(...map.keys())).toISOString().slice(0,10)})`);
  return map;
}

// ─── Compute SOPR Proxy from BTC Price ──────────────────────────────
// SOPR approximation: ratio of current price to average cost basis (SMA of recent prices)
// When price > avg cost => SOPR > 1 (profit taking), when price < avg cost => SOPR < 1 (capitulation)
function computeSoprProxy(btcDaily: Bar[]): Map<number, number> {
  const map = new Map<number, number>();
  const lookback = 30; // 30-day realized price proxy
  for (let i = lookback; i < btcDaily.length; i++) {
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += btcDaily[j].c;
    const avgCost = sum / lookback;
    const sopr = btcDaily[i].c / avgCost;
    map.set(btcDaily[i].t, sopr);
  }
  console.log(`  Computed ${map.size} SOPR proxy points`);
  return map;
}

// ─── Compute NUPL Proxy from BTC Price ──────────────────────────────
// NUPL approximation: (market cap - realized cap) / market cap
// Using 200d SMA as realized price proxy (common approximation)
// NUPL ~ (price - SMA200) / price
function computeNuplProxy(btcDaily: Bar[]): Map<number, number> {
  const map = new Map<number, number>();
  const lookback = 200;
  for (let i = lookback; i < btcDaily.length; i++) {
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += btcDaily[j].c;
    const sma200 = sum / lookback;
    const nupl = (btcDaily[i].c - sma200) / btcDaily[i].c;
    map.set(btcDaily[i].t, nupl);
  }
  console.log(`  Computed ${map.size} NUPL proxy points`);
  return map;
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
interface EngCData {
  h1z: number[]; h4z: number[];
  h1ema9: (number | null)[]; h1ema21: (number | null)[];
  h1atr14: (number | null)[];
}
interface EngEData {
  atr14: (number | null)[];
  donLo10: (number | null)[]; donHi10: (number | null)[];
}

// ─── Global data ────────────────────────────────────────────────────
let btc: BTCData;
let available: string[] = [];
let pairData: Map<string, PairData>;
let engAMap: Map<string, EngAData>;
let engBMap: Map<string, EngBData>;
let engCMap: Map<string, EngCData>;
let engEMap: Map<string, EngEData>;

// Alt data
let fngData: Map<number, number>;
let soprData: Map<number, number>;
let nuplData: Map<number, number>;

function loadAllData() {
  console.log("Loading candle data...");
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }
  btc = prepBTC(btcRaw);

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
  engCMap = new Map();
  engEMap = new Map();

  for (const p of available) {
    const pd = pairData.get(p)!;
    const dc = pd.daily.map(b => b.c);

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
    engCMap.set(p, {
      h1z: zScore(h1c, 3, 20), h4z: zScore(h4c, 3, 20),
      h1ema9: ema(h1c, 9), h1ema21: ema(h1c, 21),
      h1atr14: atrFn(pd.h1, 14),
    });

    engEMap.set(p, {
      atr14: atrFn(pd.daily, 14),
      donLo10: donchianLow(dc, 10), donHi10: donchianHigh(dc, 10),
    });
  }

  // Load alternative data
  console.log("\nLoading alternative data...");
  fngData = loadFearGreed();
  soprData = computeSoprProxy(btc.daily);
  nuplData = computeNuplProxy(btc.daily);

  console.log("All data loaded.\n");
}

// ─── Regime Classification ──────────────────────────────────────────

// Proxy regime (what we backtested before): BTC 30d vol + momentum
function classifyRegimeProxy(t: number): Regime {
  const di = getBarAtOrBefore(btc.daily, t - DAY, btc.dailyMap, DAY);
  if (di < 30) return "RISK-ON";

  const btc7dRet = di >= 7 ? btc.daily[di].c / btc.daily[di - 7].c - 1 : 0;
  const declining = btc7dRet < -0.03;

  // 30d vol + momentum proxy for F&G
  let sumRet = 0, sumRet2 = 0;
  const lookback = Math.min(30, di);
  for (let j = di - lookback + 1; j <= di; j++) {
    if (j > 0) {
      const r = Math.log(btc.daily[j].c / btc.daily[j - 1].c);
      sumRet += r;
      sumRet2 += r * r;
    }
  }
  const n = lookback;
  const meanRet = sumRet / n;
  const variance = sumRet2 / n - meanRet * meanRet;
  const dailyVol = Math.sqrt(Math.max(0, variance));
  const annualizedVol = dailyVol * Math.sqrt(365) * 100;
  const btc30dRet = di >= 30 ? btc.daily[di].c / btc.daily[di - 30].c - 1 : 0;
  const fearIndex = (1 - Math.min(annualizedVol / 100, 1)) * 50 + Math.max(-1, Math.min(1, btc30dRet)) * 50;
  const isFearful = fearIndex < 25;

  if (declining && isFearful) return "RISK-OFF";
  if (declining && !isFearful) return "RECOVERY";
  if (!declining && !isFearful) return "RISK-ON";
  return "CORRECTION";
}

// Real F&G regime
function classifyRegimeRealFng(t: number): Regime {
  const dayTs = Math.floor(t / DAY) * DAY;

  // Get BTC 7d return
  const di = getBarAtOrBefore(btc.daily, t - DAY, btc.dailyMap, DAY);
  if (di < 7) return "RISK-ON";
  const btc7dRet = btc.daily[di].c / btc.daily[di - 7].c - 1;
  const declining = btc7dRet < -0.03;

  // Get real F&G value - search backwards up to 3 days for data
  let fngVal: number | undefined;
  for (let d = 0; d <= 3; d++) {
    fngVal = fngData.get(dayTs - d * DAY);
    if (fngVal !== undefined) break;
  }
  if (fngVal === undefined) return "RISK-ON"; // default

  const isFearful = fngVal < 25;

  if (declining && isFearful) return "RISK-OFF";    // F&G < 25 AND BTC 7d < -3%
  if (declining && !isFearful) return "RECOVERY";   // F&G < 25 not met, BTC declining
  if (!declining && !isFearful) return "RISK-ON";   // F&G >= 25 AND BTC 7d >= -3%
  return "CORRECTION";                               // F&G >= 25 AND BTC 7d < -3% (impossible here, catch-all)
}

// Get SOPR value for a timestamp
function getSopr(t: number): number | null {
  const dayTs = Math.floor(t / DAY) * DAY;
  for (let d = 0; d <= 3; d++) {
    const v = soprData.get(dayTs - d * DAY);
    if (v !== undefined) return v;
  }
  return null;
}

// Get NUPL value for a timestamp
function getNupl(t: number): number | null {
  const dayTs = Math.floor(t / DAY) * DAY;
  for (let d = 0; d <= 3; d++) {
    const v = nuplData.get(dayTs - d * DAY);
    if (v !== undefined) return v;
  }
  return null;
}

// Direction allowed by regime config
function regimeAllowsDir(regime: Regime, dir: Dir): boolean {
  if (regime === "RISK-OFF") return dir === "short"; // shorts only
  return true; // RECOVERY, RISK-ON, CORRECTION: both directions
}

// Size multiplier by regime
function regimeSizeMult(regime: Regime): number {
  switch (regime) {
    case "RISK-OFF": return 1.0;
    case "RECOVERY": return 0.75;
    case "RISK-ON": return 1.0;
    case "CORRECTION": return 0.5;
  }
}

// SOPR direction filter
function soprAllowsDir(sopr: number | null, dir: Dir, filterType: string): boolean {
  if (sopr === null) return true;
  if (filterType === "long_only" && sopr < 1.0 && dir === "short") return false;   // capitulation: longs only
  if (filterType === "short_only" && sopr > 1.05 && dir === "long") return false;  // profit-taking: shorts only
  if (filterType === "combined") {
    if (sopr < 1.0 && dir === "short") return false;   // capitulation: block shorts
    if (sopr > 1.05 && dir === "long") return false;    // profit-taking: block longs
  }
  return true;
}

// NUPL position size multiplier
function nuplSizeMult(nupl: number | null, dir: Dir): number {
  if (nupl === null) return 1.0;
  if (nupl < 0) {
    // Capitulation: strong buy signal
    return dir === "long" ? 1.5 : 0.5;
  } else if (nupl < 0.25) {
    // Hope: cautious
    return 1.0;
  } else if (nupl < 0.5) {
    // Optimism: normal
    return 1.0;
  } else if (nupl < 0.75) {
    // Belief: reduce longs
    return dir === "long" ? 0.7 : 1.3;
  } else {
    // Euphoria: shorts only
    return dir === "long" ? 0.3 : 1.5;
  }
}

// ─── Run Backtest ───────────────────────────────────────────────────
function runBacktest(regimeCfg: RegimeConfig): Trade[] {
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  let lastCarryRebalance = 0;

  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    dailyTimestamps.push(t);
  }

  function btcBullish(t: number): boolean {
    const di = getBarAtOrBefore(btc.daily, t - DAY, btc.dailyMap, DAY);
    if (di < 0) return false;
    const e20 = btc.dailyEma20[di], e50 = btc.dailyEma50[di];
    return e20 !== null && e50 !== null && e20 > e50;
  }

  function btcH1Bullish(t: number): boolean {
    const hi = getBarAtOrBefore(btc.h1, t - H1, btc.h1Map, H1);
    if (hi < 0) return false;
    const e9 = btc.h1Ema9[hi], e21 = btc.h1Ema21[hi];
    return e9 !== null && e21 !== null && e9 > e21;
  }

  function btc30dRet(t: number): number {
    const di = getBarAtOrBefore(btc.daily, t - DAY, btc.dailyMap, DAY);
    if (di < 0 || di < 30) return 0;
    return btc.daily[di].c / btc.daily[di - 30].c - 1;
  }

  function totalPositions(): number { return positions.size; }
  function positionsForEngine(eng: string): Position[] {
    return [...positions.values()].filter(p => p.engine === eng);
  }

  function getRegime(t: number): Regime {
    if (regimeCfg.mode === "proxy") return classifyRegimeProxy(t);
    if (regimeCfg.mode === "real_fng" || regimeCfg.mode === "combined") return classifyRegimeRealFng(t);
    return "RISK-ON"; // no regime = always risk-on
  }

  function canTakeDir(t: number, dir: Dir): boolean {
    // F&G / proxy direction filter (only if mode is not "none")
    if (regimeCfg.mode !== "none" && regimeCfg.dirFilter) {
      const regime = getRegime(t);
      if (!regimeAllowsDir(regime, dir)) return false;
    }

    // SOPR filter (independent of regime mode)
    if (regimeCfg.soprFilter) {
      const sopr = getSopr(t);
      if (!soprAllowsDir(sopr, dir, regimeCfg.soprFilter)) return false;
    }

    return true;
  }

  function getMargin(engine: string, t: number, dir: Dir): number {
    let margin = ENGINE_SIZES[engine] ?? 5;

    if (regimeCfg.sizeFilter && regimeCfg.mode !== "none") {
      const regime = getRegime(t);
      margin *= regimeSizeMult(regime);
    }

    if (regimeCfg.nuplSizing) {
      const nupl = getNupl(t);
      margin *= nuplSizeMult(nupl, dir);
    }

    return Math.max(1, Math.round(margin * 100) / 100);
  }

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
    const cost = notional * FEE * 2;
    const pnl = raw - cost;
    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl, margin: pos.margin,
    });
    positions.delete(key);
  }

  for (const dayT of dailyTimestamps) {
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

      // TP (Engine C)
      if (pos.tp > 0) {
        if (pos.dir === "long" && bar.h >= pos.tp) {
          closePosition(key, pos.tp, dayT); continue;
        } else if (pos.dir === "short" && bar.l <= pos.tp) {
          closePosition(key, pos.tp, dayT); continue;
        }
      }

      // Max hold
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

      if (pos.engine === "E") {
        const ee = engEMap.get(pos.pair);
        if (ee && di > 0) {
          if (pos.dir === "long" && ee.donLo10[di] !== null && bar.c < ee.donLo10[di]!) {
            closePosition(key, bar.c, dayT); continue;
          }
          if (pos.dir === "short" && ee.donHi10[di] !== null && bar.c > ee.donHi10[di]!) {
            closePosition(key, bar.c, dayT); continue;
          }
        }
      }
    }

    // ─── ENGINE A: Daily Donchian Trend ─────────────────────────────
    for (const p of available) {
      if (totalPositions() >= MAX_POSITIONS) break;
      const key = `A:${p}`;
      if (positions.has(key)) continue;

      const pd = pairData.get(p)!;
      const ea = engAMap.get(p)!;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 51) continue;

      const bar = pd.daily[di];
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
      if (!canTakeDir(dayT, dir)) continue;

      const atrVal = ea.atr14[di - 1];
      if (atrVal === null) continue;

      const sp_ = sp(p);
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;
      const margin = getMargin("A", dayT, dir);

      positions.set(key, {
        pair: p, engine: "A", dir, ep, et: dayT, sl, tp: 0,
        margin, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
      });
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

        if (!canTakeDir(h4T, dir)) continue;

        const atrVal = eb.atr14[h4i - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p);
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        const margin = getMargin("B", h4T, dir);

        positions.set(key, {
          pair: p, engine: "B", dir, ep, et: h4T, sl, tp: 0,
          margin, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
        });
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
        if (!canTakeDir(h1T, dir)) continue;

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
        const margin = getMargin("C", h1T, dir);

        positions.set(key, {
          pair: p, engine: "C", dir, ep, et: h1T, sl, tp,
          margin, lev: 10, maxHold: 96 * H1, atr: h1atr as number, bestPnlAtr: 0,
        });
      }
    }

    // ─── ENGINE D: Carry Momentum ───────────────────────────────────
    if (dayT - lastCarryRebalance >= 7 * DAY) {
      lastCarryRebalance = dayT;

      for (const [key, pos] of [...positions.entries()]) {
        if (pos.engine === "D") {
          const pd = pairData.get(pos.pair);
          if (!pd) continue;
          const di = pd.dailyMap.get(dayT);
          if (di === undefined) continue;
          closePosition(key, pd.daily[di].c, dayT);
        }
      }

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
      const top3 = fundingRanks.filter(x => x.funding > 0 && x.momentum < 0).slice(-3);
      const bot3 = fundingRanks.filter(x => x.funding < 0 && x.momentum > 0).slice(0, 3);

      for (const pick of [...top3, ...bot3]) {
        if (totalPositions() >= MAX_POSITIONS) break;
        const key = `D:${pick.pair}`;
        if (positions.has(key)) continue;

        const pd = pairData.get(pick.pair)!;
        const di = pd.dailyMap.get(dayT);
        if (di === undefined) continue;

        const dir: Dir = pick.funding > 0 ? "short" : "long";
        if (!canTakeDir(dayT, dir)) continue;

        const sp_ = sp(pick.pair);
        const ep = dir === "long" ? pd.daily[di].o * (1 + sp_) : pd.daily[di].o * (1 - sp_);
        let slDist = ep * 0.04;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        const dailyAtr = atrFn(pd.daily, 14);
        const atrVal = dailyAtr[di - 1] ?? ep * 0.02;
        const margin = getMargin("D", dayT, dir);

        positions.set(key, {
          pair: pick.pair, engine: "D", dir, ep, et: dayT, sl, tp: 0,
          margin, lev: 10, maxHold: 8 * DAY, atr: atrVal as number, bestPnlAtr: 0,
        });
      }
    }

    // ─── ENGINE E: Range Expansion (Momentum) ───────────────────────
    for (const p of available) {
      if (totalPositions() >= MAX_POSITIONS) break;
      const key = `E:${p}`;
      if (positions.has(key)) continue;

      const pd = pairData.get(p)!;
      const ee = engEMap.get(p)!;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 21) continue;

      const bar = pd.daily[di - 1];
      const range = bar.h - bar.l;
      let rangeSum = 0;
      for (let j = di - 21; j < di - 1; j++) {
        if (j >= 0) rangeSum += pd.daily[j].h - pd.daily[j].l;
      }
      const avgRange = rangeSum / 20;
      if (avgRange <= 0 || range < 2 * avgRange) continue;

      let dir: Dir | null = null;
      if (bar.c > bar.o) {
        if (btcBullish(dayT)) dir = "long";
      } else {
        dir = "short";
      }
      if (!dir) continue;
      if (!canTakeDir(dayT, dir)) continue;

      const atrVal = ee.atr14[di - 1];
      if (atrVal === null) continue;

      const sp_ = sp(p);
      const ep = dir === "long" ? pd.daily[di].o * (1 + sp_) : pd.daily[di].o * (1 - sp_);
      let slDist = atrVal * 2;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;
      const margin = getMargin("E", dayT, dir);

      positions.set(key, {
        pair: p, engine: "E", dir, ep, et: dayT, sl, tp: 0,
        margin, lev: 10, maxHold: 30 * DAY, atr: atrVal, bestPnlAtr: 0,
      });
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
  maxDd: number; totalPnl: number; avgPnl: number; winners: number; losers: number;
}

function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return {
    trades: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0,
    maxDd: 0, totalPnl: 0, avgPnl: 0, winners: 0, losers: 0,
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

  let equity = 0, peak = 0, maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades: filtered.length,
    pf: Math.round(pf * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    perDay: Math.round(perDay * 100) / 100,
    wr: Math.round(wr * 1000) / 10,
    maxDd: Math.round(maxDd * 100) / 100,
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

function printHeader() {
  console.log(
    `${"Test".padEnd(28)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
    `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ${pad("Total", 11)}`
  );
  console.log("-".repeat(90));
}

function printLine(label: string, s: Stats) {
  console.log(
    `${label.padEnd(28)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 7)} ` +
    `${pad(fmtPnl(s.totalPnl), 11)}`
  );
}

function printYearBreakdown(label: string, trades: Trade[]) {
  console.log(`\n  ${label} - Per-Year $/day:`);
  const years = [2023, 2024, 2025, 2026];
  const parts: string[] = [];
  for (const y of years) {
    const ys = new Date(`${y}-01-01`).getTime();
    const ye = new Date(`${y + 1}-01-01`).getTime();
    const s = computeStats(trades, ys, Math.min(ye, FULL_END));
    parts.push(`${y}: ${fmtPnl(s.perDay)}/d (${s.trades}t)`);
  }
  console.log(`  ${parts.join("  |  ")}`);
}

// ─── Regime Distribution ────────────────────────────────────────────
function printRegimeDistribution(label: string, classifier: (t: number) => Regime) {
  const counts: Record<Regime, number> = { "RISK-OFF": 0, "RECOVERY": 0, "RISK-ON": 0, "CORRECTION": 0 };
  let total = 0;
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    const r = classifier(t);
    counts[r]++;
    total++;
  }
  console.log(`  ${label} regime distribution:`);
  for (const [r, c] of Object.entries(counts)) {
    console.log(`    ${r.padEnd(12)} ${String(c).padStart(4)} days (${(c / total * 100).toFixed(1)}%)`);
  }
}

// ─── Test Configurations ────────────────────────────────────────────
interface TestConfig {
  label: string;
  regimeCfg: RegimeConfig;
}

// ─── MAIN ───────────────────────────────────────────────────────────
console.log("=".repeat(100));
console.log("  REAL ALTERNATIVE DATA VALIDATION BACKTEST");
console.log("  5 engines: Donchian $7, Supertrend $5, GARCH $3, Carry $7, Momentum $3");
console.log("  18 pairs, 2023-01 to 2026-03, Max 20 positions, No trailing");
console.log("  Cost: Taker 0.035%, standard spreads, 1.5x SL slippage, 10x leverage");
console.log("  Real F&G: alternative.me API (2973 days)");
console.log("  SOPR proxy: BTC price / 30d SMA");
console.log("  NUPL proxy: (BTC price - 200d SMA) / BTC price");
console.log("=".repeat(100));

loadAllData();

// ─── Regime Distribution Comparison ─────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("  REGIME DISTRIBUTION COMPARISON");
console.log("=".repeat(100));
printRegimeDistribution("Proxy (vol+momentum)", classifyRegimeProxy);
console.log();
printRegimeDistribution("Real F&G", classifyRegimeRealFng);

// Count how often they agree
let agree = 0, total = 0;
for (let t = FULL_START; t < FULL_END; t += DAY) {
  const proxy = classifyRegimeProxy(t);
  const real = classifyRegimeRealFng(t);
  if (proxy === real) agree++;
  total++;
}
console.log(`\n  Agreement: ${agree}/${total} days (${(agree / total * 100).toFixed(1)}%)`);

// Show SOPR distribution
let soprBelow1 = 0, soprAbove105 = 0, soprNormal = 0, soprTotal = 0;
for (let t = FULL_START; t < FULL_END; t += DAY) {
  const s = getSopr(t);
  if (s === null) continue;
  soprTotal++;
  if (s < 1.0) soprBelow1++;
  else if (s > 1.05) soprAbove105++;
  else soprNormal++;
}
console.log(`\n  SOPR distribution: <1.0: ${soprBelow1}d (${(soprBelow1/soprTotal*100).toFixed(1)}%), 1.0-1.05: ${soprNormal}d (${(soprNormal/soprTotal*100).toFixed(1)}%), >1.05: ${soprAbove105}d (${(soprAbove105/soprTotal*100).toFixed(1)}%)`);

// Show NUPL distribution
const nuplBuckets = { "< 0 (Capitulation)": 0, "0-0.25 (Hope)": 0, "0.25-0.5 (Optimism)": 0, "0.5-0.75 (Belief)": 0, "> 0.75 (Euphoria)": 0 };
let nuplTotal = 0;
for (let t = FULL_START; t < FULL_END; t += DAY) {
  const n = getNupl(t);
  if (n === null) continue;
  nuplTotal++;
  if (n < 0) nuplBuckets["< 0 (Capitulation)"]++;
  else if (n < 0.25) nuplBuckets["0-0.25 (Hope)"]++;
  else if (n < 0.5) nuplBuckets["0.25-0.5 (Optimism)"]++;
  else if (n < 0.75) nuplBuckets["0.5-0.75 (Belief)"]++;
  else nuplBuckets["> 0.75 (Euphoria)"]++;
}
console.log(`\n  NUPL distribution:`);
for (const [label, count] of Object.entries(nuplBuckets)) {
  console.log(`    ${label.padEnd(25)} ${String(count).padStart(4)} days (${(count/nuplTotal*100).toFixed(1)}%)`);
}

// ═══════════════════════════════════════════════════════════════════════
// TEST A: Real Fear & Greed regime vs proxy
// ═══════════════════════════════════════════════════════════════════════
console.log("\n\n" + "#".repeat(100));
console.log("  TEST A: REAL FEAR & GREED REGIME vs PROXY");
console.log("#".repeat(100));

const testA: TestConfig[] = [
  {
    label: "A1. No regime (baseline)",
    regimeCfg: { mode: "none", dirFilter: false, sizeFilter: false },
  },
  {
    label: "A2. Proxy regime (vol+mom)",
    regimeCfg: { mode: "proxy", dirFilter: true, sizeFilter: true },
  },
  {
    label: "A3. Real F&G regime",
    regimeCfg: { mode: "real_fng", fngData, dirFilter: true, sizeFilter: true },
  },
  {
    label: "A3b. Real F&G dir only",
    regimeCfg: { mode: "real_fng", fngData, dirFilter: true, sizeFilter: false },
  },
  {
    label: "A3c. Real F&G size only",
    regimeCfg: { mode: "real_fng", fngData, dirFilter: false, sizeFilter: true },
  },
];

console.log("\n--- Full Period Results ---");
printHeader();
const testAResults: { label: string; trades: Trade[]; stats: Stats }[] = [];
for (const tc of testA) {
  const trades = runBacktest(tc.regimeCfg);
  const stats = computeStats(trades, FULL_START, FULL_END);
  printLine(tc.label, stats);
  testAResults.push({ label: tc.label, trades, stats });
}

for (const r of testAResults) {
  printYearBreakdown(r.label, r.trades);
}

// Engine contribution for baseline vs real F&G
const ENGINE_NAMES: Record<string, string> = { A: "Donchian", B: "Supertrend", C: "GARCH", D: "Carry", E: "Momentum" };
const dayCount = (FULL_END - FULL_START) / DAY;

for (const idx of [0, 2]) {
  const r = testAResults[idx];
  console.log(`\n  ${r.label} - Engine Contribution:`);
  console.log(`  ${"Engine".padEnd(16)} ${"Trades".padStart(6)} ${"PF".padStart(6)} ${"WR".padStart(7)} ${"Total".padStart(11)} ${"$/day".padStart(9)}`);
  console.log("  " + "-".repeat(60));
  for (const eng of ["A", "B", "C", "D", "E"]) {
    const et = r.trades.filter(t => t.engine === eng);
    const pnl = et.reduce((s, t) => s + t.pnl, 0);
    const wins = et.filter(t => t.pnl > 0);
    const losses = et.filter(t => t.pnl <= 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
    console.log(
      `  ${(eng + ": " + ENGINE_NAMES[eng]).padEnd(16)} ${String(et.length).padStart(6)} ${pf.toFixed(2).padStart(6)} ` +
      `${fmtPct(et.length > 0 ? wins.length / et.length * 100 : 0).padStart(7)} ` +
      `${fmtPnl(pnl).padStart(11)} ${fmtPnl(pnl / dayCount).padStart(9)}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEST B: SOPR as additional regime filter
// ═══════════════════════════════════════════════════════════════════════
console.log("\n\n" + "#".repeat(100));
console.log("  TEST B: SOPR AS ADDITIONAL REGIME FILTER");
console.log("  SOPR < 1.0 = capitulation (buy), SOPR > 1.05 = profit-taking (sell)");
console.log("#".repeat(100));

const testB: TestConfig[] = [
  {
    label: "B1. No SOPR (baseline)",
    regimeCfg: { mode: "none", dirFilter: false, sizeFilter: false },
  },
  {
    label: "B2. SOPR<1 longs only",
    regimeCfg: { mode: "none", dirFilter: false, sizeFilter: false, soprFilter: "long_only" },
  },
  {
    label: "B3. SOPR>1.05 shorts only",
    regimeCfg: { mode: "none", dirFilter: false, sizeFilter: false, soprFilter: "short_only" },
  },
  {
    label: "B4. SOPR combined",
    regimeCfg: { mode: "none", dirFilter: false, sizeFilter: false, soprFilter: "combined" },
  },
  {
    label: "B5. SOPR + Real F&G regime",
    regimeCfg: { mode: "real_fng", fngData, dirFilter: true, sizeFilter: true, soprFilter: "combined" },
  },
];

console.log("\n--- Full Period Results ---");
printHeader();
const testBResults: { label: string; trades: Trade[]; stats: Stats }[] = [];
for (const tc of testB) {
  const trades = runBacktest(tc.regimeCfg);
  const stats = computeStats(trades, FULL_START, FULL_END);
  printLine(tc.label, stats);
  testBResults.push({ label: tc.label, trades, stats });
}

for (const r of testBResults) {
  printYearBreakdown(r.label, r.trades);
}

// ═══════════════════════════════════════════════════════════════════════
// TEST C: NUPL as macro regime
// ═══════════════════════════════════════════════════════════════════════
console.log("\n\n" + "#".repeat(100));
console.log("  TEST C: NUPL AS MACRO REGIME");
console.log("  NUPL < 0: Capitulation (big longs), 0-0.25: Hope, 0.25-0.5: Normal");
console.log("  NUPL 0.5-0.75: Belief (reduce longs), > 0.75: Euphoria (shorts only)");
console.log("#".repeat(100));

const testC: TestConfig[] = [
  {
    label: "C1. No NUPL (baseline)",
    regimeCfg: { mode: "none", dirFilter: false, sizeFilter: false },
  },
  {
    label: "C2. NUPL sizing only",
    regimeCfg: { mode: "none", dirFilter: false, sizeFilter: false, nuplSizing: true },
  },
  {
    label: "C3. NUPL + Real F&G regime",
    regimeCfg: { mode: "real_fng", fngData, dirFilter: true, sizeFilter: true, nuplSizing: true },
  },
  {
    label: "C4. NUPL + SOPR + Real F&G",
    regimeCfg: { mode: "real_fng", fngData, dirFilter: true, sizeFilter: true, soprFilter: "combined", nuplSizing: true },
  },
];

console.log("\n--- Full Period Results ---");
printHeader();
const testCResults: { label: string; trades: Trade[]; stats: Stats }[] = [];
for (const tc of testC) {
  const trades = runBacktest(tc.regimeCfg);
  const stats = computeStats(trades, FULL_START, FULL_END);
  printLine(tc.label, stats);
  testCResults.push({ label: tc.label, trades, stats });
}

for (const r of testCResults) {
  printYearBreakdown(r.label, r.trades);
}

// ═══════════════════════════════════════════════════════════════════════
// RANKED SUMMARY
// ═══════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(100));
console.log("  RANKED SUMMARY - All Tests (sorted by $/day)");
console.log("=".repeat(100));

const allResults = [
  ...testAResults.map(r => ({ ...r, group: "A" })),
  ...testBResults.map(r => ({ ...r, group: "B" })),
  ...testCResults.map(r => ({ ...r, group: "C" })),
];

// Deduplicate baselines (A1, B1, C1 are the same)
const seen = new Set<string>();
const unique = allResults.filter(r => {
  const key = `${r.stats.trades}-${r.stats.totalPnl}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const ranked = unique.sort((a, b) => b.stats.perDay - a.stats.perDay);

console.log(
  `${"#".padEnd(3)} ${"Test".padEnd(28)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
  `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ${pad("Total", 11)} ` +
  `${pad("'23$/d", 8)} ${pad("'24$/d", 8)} ${pad("'25$/d", 8)} ${pad("'26$/d", 8)}`
);
console.log("-".repeat(120));

for (let i = 0; i < ranked.length; i++) {
  const r = ranked[i];
  const s = r.stats;
  const years = [2023, 2024, 2025, 2026];
  const yearParts: string[] = [];
  for (const y of years) {
    const ys = new Date(`${y}-01-01`).getTime();
    const ye = new Date(`${y + 1}-01-01`).getTime();
    const yStat = computeStats(r.trades, ys, Math.min(ye, FULL_END));
    yearParts.push(pad(fmtPnl(yStat.perDay), 8));
  }
  console.log(
    `${String(i + 1).padEnd(3)} ${r.label.padEnd(28)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 7)} ${pad(fmtPnl(s.totalPnl), 11)} ` +
    `${yearParts.join(" ")}`
  );
}

// ─── Key Findings ───────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(100));
console.log("  KEY FINDINGS");
console.log("=".repeat(100));

const baseline = testAResults[0].stats;
const proxyRegime = testAResults[1].stats;
const realFng = testAResults[2].stats;
const bestSopr = testBResults.reduce((a, b) => a.stats.perDay > b.stats.perDay ? a : b);
const bestNupl = testCResults.reduce((a, b) => a.stats.perDay > b.stats.perDay ? a : b);
const bestOverall = ranked[0];

console.log(`
  Baseline (no regime):           ${fmtPnl(baseline.perDay)}/day, PF ${baseline.pf}, Sharpe ${baseline.sharpe}
  Proxy regime (vol+momentum):    ${fmtPnl(proxyRegime.perDay)}/day, PF ${proxyRegime.pf}, Sharpe ${proxyRegime.sharpe}
  Real F&G regime:                ${fmtPnl(realFng.perDay)}/day, PF ${realFng.pf}, Sharpe ${realFng.sharpe}

  Delta (Real F&G vs Proxy):      ${fmtPnl(realFng.perDay - proxyRegime.perDay)}/day
  Delta (Real F&G vs Baseline):   ${fmtPnl(realFng.perDay - baseline.perDay)}/day

  Best SOPR filter:               ${bestSopr.label} -> ${fmtPnl(bestSopr.stats.perDay)}/day
  Best NUPL config:               ${bestNupl.label} -> ${fmtPnl(bestNupl.stats.perDay)}/day
  Best Overall:                   ${bestOverall.label} -> ${fmtPnl(bestOverall.stats.perDay)}/day, PF ${bestOverall.stats.pf}

  VERDICT: ${realFng.perDay > proxyRegime.perDay
    ? "Real F&G OUTPERFORMS proxy regime by " + fmtPnl(realFng.perDay - proxyRegime.perDay) + "/day"
    : realFng.perDay < proxyRegime.perDay
    ? "Proxy regime OUTPERFORMS Real F&G by " + fmtPnl(proxyRegime.perDay - realFng.perDay) + "/day"
    : "Real F&G and Proxy regime perform EQUALLY"}
`);

console.log("Done.");
