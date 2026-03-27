/**
 * Direction Balance Backtest
 * Test whether limiting long exposure when most positions are short helps or hurts.
 *
 * 5 engines: A(Donchian $7), B(Supertrend $5), C(GARCH $3), D(Carry $7), M(Momentum $3)
 * 18 pairs, 2023-01 to 2026-03, 5m candles, max 20 positions, no trailing.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-direction-balance.ts
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
const FULL_END = new Date("2026-03-27").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

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

// Direction balance config
interface DirConfig {
  label: string;
  maxLongs: number;           // max longs at any time (Infinity = no limit)
  shortsOnlyBearish: boolean; // block ALL longs when BTC EMA20 < EMA50
  directionWeighted: boolean; // reduce minority direction size
  carryNoLongs: boolean;      // Carry engine shorts only
  pureShortsOnly: boolean;    // block ALL longs from ALL engines
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

// ─── Data Prep ──────────────────────────────────────────────────────
interface PairData {
  m5: C[]; h1: Bar[]; h4: Bar[]; daily: Bar[]; weekly: Bar[];
  h1Map: Map<number, number>; h4Map: Map<number, number>; dailyMap: Map<number, number>;
}

interface BTCData {
  daily: Bar[]; h1: Bar[]; h4: Bar[];
  dailyEma20: (number | null)[]; dailyEma50: (number | null)[];
  h1Ema9: (number | null)[]; h1Ema21: (number | null)[];
  h4Ema20: (number | null)[]; h4Ema50: (number | null)[];
  dailyMap: Map<number, number>; h1Map: Map<number, number>; h4Map: Map<number, number>;
}

function prepBTC(m5: C[]): BTCData {
  const daily = aggregate(m5, DAY);
  const h1 = aggregate(m5, H1);
  const h4 = aggregate(m5, H4);
  const dc = daily.map(b => b.c);
  const hc = h1.map(b => b.c);
  const h4c = h4.map(b => b.c);
  return {
    daily, h1, h4,
    dailyEma20: ema(dc, 20), dailyEma50: ema(dc, 50),
    h1Ema9: ema(hc, 9), h1Ema21: ema(hc, 21),
    h4Ema20: ema(h4c, 20), h4Ema50: ema(h4c, 50),
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
interface EngMData {
  volZ: (number | null)[];
  fundingZ: (number | null)[];
  priceZ: (number | null)[];
}

// ─── Global data (loaded once) ──────────────────────────────────────
let btc: BTCData;
let available: string[] = [];
let pairData: Map<string, PairData>;
let engAMap: Map<string, EngAData>;
let engBMap: Map<string, EngBData>;
let engCMap: Map<string, EngCData>;
let engMMap: Map<string, EngMData>;

function loadAllData() {
  console.log("Loading data...");
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
  engMMap = new Map();

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

// ─── Run Backtest ───────────────────────────────────────────────────
interface ConcurrentEvent {
  longLoss: number;    // total loss from a long that lost >$3
  shortProfit: number; // total profit from concurrent shorts
  longTrade: Trade;
  shortTrades: Trade[];
}

function runBacktest(dirCfg: DirConfig, spreadMultiplier: number): { trades: Trade[]; concurrentEvents: ConcurrentEvent[] } {
  const MAX_POSITIONS = 20;
  const BASE_SIZES: Record<string, number> = { A: 7, B: 5, C: 3, D: 7, M: 3 };

  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  let lastCarryRebalance = 0;

  // Track concurrent events: a long lost >$3 while concurrent shorts collectively profited
  const concurrentEvents: ConcurrentEvent[] = [];

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

  function btcH4Ema20gt50(t: number): boolean {
    const h4i = getBarAtOrBefore(btc.h4, t - H4, btc.h4Map, H4);
    if (h4i < 0) return false;
    const e20 = btc.h4Ema20[h4i], e50 = btc.h4Ema50[h4i];
    return e20 !== null && e50 !== null && e20 > e50;
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

  function countLongs(): number {
    return [...positions.values()].filter(p => p.dir === "long").length;
  }
  function countShorts(): number {
    return [...positions.values()].filter(p => p.dir === "short").length;
  }

  // Check if a long is blocked by direction config
  function longBlocked(t: number, engine: string): boolean {
    if (dirCfg.pureShortsOnly) return true;
    if (dirCfg.carryNoLongs && engine === "D") return true;
    if (dirCfg.shortsOnlyBearish && !btcBullish(t)) return true;
    if (countLongs() >= dirCfg.maxLongs) return true;
    return false;
  }

  // Get margin for a given engine and direction
  function getMargin(engine: string, dir: Dir): number {
    const base = BASE_SIZES[engine] ?? 3;
    if (!dirCfg.directionWeighted) return base;
    const total = totalPositions();
    if (total === 0) return base;
    const longPct = countLongs() / total;
    const shortPct = countShorts() / total;
    // Reduce minority direction to $3
    if (dir === "long" && shortPct > 0.7) return Math.min(base, 3);
    if (dir === "short" && longPct > 0.7) return Math.min(base, 3);
    return base;
  }

  function closePosition(key: string, exitPrice: number, exitTime: number, slippageMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sp(pos.pair) * spreadMultiplier;
    const xp = pos.dir === "long"
      ? exitPrice * (1 - sp_ * slippageMult)
      : exitPrice * (1 + sp_ * slippageMult);
    const notional = pos.margin * pos.lev;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const cost = notional * FEE * 2;
    const pnl = raw - cost;
    const trade: Trade = {
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl, margin: pos.margin,
    };
    trades.push(trade);

    // Track concurrent event: did this long lose >$3 while shorts were profitable?
    if (pos.dir === "long" && pnl < -3) {
      // Find all short trades that were active during this long's lifetime (overlap in time)
      const concurrentShortTrades = trades.filter(t =>
        t !== trade && t.dir === "short" &&
        t.et <= exitTime && t.xt >= pos.et // overlapping in time
      );
      const shortProfit = concurrentShortTrades.reduce((s, t) => s + t.pnl, 0);
      if (shortProfit > 0) {
        concurrentEvents.push({
          longLoss: pnl,
          shortProfit,
          longTrade: trade,
          shortTrades: concurrentShortTrades,
        });
      }
    }

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

      // Direction filter
      if (dir === "long" && longBlocked(dayT, "A")) continue;

      const atrVal = ea.atr14[di - 1];
      if (atrVal === null) continue;

      const sp_ = sp(p) * spreadMultiplier;
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(key, {
        pair: p, engine: "A", dir, ep, et: dayT, sl, tp: 0,
        margin: getMargin("A", dir), lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
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

        // Direction filter
        if (dir === "long" && longBlocked(h4T, "B")) continue;

        const atrVal = eb.atr14[h4i - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p) * spreadMultiplier;
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(key, {
          pair: p, engine: "B", dir, ep, et: h4T, sl, tp: 0,
          margin: getMargin("B", dir), lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
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

        // Direction filter
        if (dir === "long" && longBlocked(h1T, "C")) continue;

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

        const sp_ = sp(p) * spreadMultiplier;
        const ep = dir === "long" ? pd.h1[h1i].o * (1 + sp_) : pd.h1[h1i].o * (1 - sp_);
        const slPct = 0.03;
        let slDist = ep * slPct;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        const tp = dir === "long" ? ep * 1.07 : ep * 0.93;

        const h1atr = ec.h1atr14[h1i - 1] ?? (ep * 0.02);

        positions.set(key, {
          pair: p, engine: "C", dir, ep, et: h1T, sl, tp,
          margin: getMargin("C", dir), lev: 10, maxHold: 96 * H1, atr: h1atr as number, bestPnlAtr: 0,
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

        // Direction filter
        if (dir === "long" && longBlocked(dayT, "D")) continue;

        const sp_ = sp(pick.pair) * spreadMultiplier;
        const ep = dir === "long" ? pd.daily[di].o * (1 + sp_) : pd.daily[di].o * (1 - sp_);
        let slDist = ep * 0.04;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        const dailyAtr = atrFn(pd.daily, 14);
        const atrVal = dailyAtr[di - 1] ?? ep * 0.02;

        positions.set(key, {
          pair: pick.pair, engine: "D", dir, ep, et: dayT, sl, tp: 0,
          margin: getMargin("D", dir), lev: 10, maxHold: 8 * DAY, atr: atrVal as number, bestPnlAtr: 0,
        });
      }
    }

    // ─── ENGINE M: Momentum Confirmation ────────────────────────────
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

        // Direction filter
        if (dir === "long" && longBlocked(h4T, "M")) continue;

        const sp_ = sp(p) * spreadMultiplier;
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
        const slDist = ep * 0.03;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(key, {
          pair: p, engine: "M", dir, ep, et: h4T, sl, tp: 0,
          margin: getMargin("M", dir), lev: 10, maxHold: 48 * H1, atr: 0, bestPnlAtr: 0,
        });
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

  return { trades, concurrentEvents };
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
  const std_ = dpVals.length > 1
    ? Math.sqrt(dpVals.reduce((s, v) => s + (v - mean) ** 2, 0) / (dpVals.length - 1))
    : 0;
  const sharpe = std_ > 0 ? (mean / std_) * Math.sqrt(365) : 0;

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
const DIR_CONFIGS: DirConfig[] = [
  {
    label: "1. Baseline",
    maxLongs: Infinity,
    shortsOnlyBearish: false,
    directionWeighted: false,
    carryNoLongs: false,
    pureShortsOnly: false,
  },
  {
    label: "2. Max 3 longs",
    maxLongs: 3,
    shortsOnlyBearish: false,
    directionWeighted: false,
    carryNoLongs: false,
    pureShortsOnly: false,
  },
  {
    label: "3. Max 2 longs",
    maxLongs: 2,
    shortsOnlyBearish: false,
    directionWeighted: false,
    carryNoLongs: false,
    pureShortsOnly: false,
  },
  {
    label: "4. No longs bearish",
    maxLongs: Infinity,
    shortsOnlyBearish: true,
    directionWeighted: false,
    carryNoLongs: false,
    pureShortsOnly: false,
  },
  {
    label: "5. Dir-weighted $",
    maxLongs: Infinity,
    shortsOnlyBearish: false,
    directionWeighted: true,
    carryNoLongs: false,
    pureShortsOnly: false,
  },
  {
    label: "6. No Carry longs",
    maxLongs: Infinity,
    shortsOnlyBearish: false,
    directionWeighted: false,
    carryNoLongs: true,
    pureShortsOnly: false,
  },
  {
    label: "7. Pure shorts only",
    maxLongs: Infinity,
    shortsOnlyBearish: false,
    directionWeighted: false,
    carryNoLongs: false,
    pureShortsOnly: true,
  },
];

const ENGINE_NAMES: Record<string, string> = {
  A: "Donchian", B: "Supertrend", C: "GARCH", D: "Carry", M: "Momentum",
};

// ─── Main ───────────────────────────────────────────────────────────
console.log("=".repeat(120));
console.log("  DIRECTION BALANCE BACKTEST");
console.log("  Does limiting long exposure when most positions are short help or hurt?");
console.log("  5 engines: A(Donchian $7), B(Supertrend $5), C(GARCH $3), D(Carry $7), M(Momentum $3)");
console.log("  18 pairs, 2023-01 to 2026-03, 5m candles, max 20 positions, no trailing");
console.log("  Cost: Taker 0.035%, standard spreads, 1.5x SL slippage, 10x leverage");
console.log("=".repeat(120));

loadAllData();

interface ConfigResult {
  label: string;
  fullStats: Stats;
  yearStats: Map<number, Stats>;
  trades: Trade[];
  concurrentEvents: ConcurrentEvent[];
  longCount: number;
  shortCount: number;
}

const results: ConfigResult[] = [];

for (const cfg of DIR_CONFIGS) {
  console.log("\n" + "#".repeat(120));
  console.log(`  ${cfg.label}`);
  const desc: string[] = [];
  if (cfg.maxLongs < Infinity) desc.push(`maxLongs=${cfg.maxLongs}`);
  if (cfg.shortsOnlyBearish) desc.push("block longs when BTC bearish");
  if (cfg.directionWeighted) desc.push("minority dir gets $3");
  if (cfg.carryNoLongs) desc.push("Carry shorts only");
  if (cfg.pureShortsOnly) desc.push("ALL shorts only");
  if (desc.length === 0) desc.push("no direction limits");
  console.log(`  Rule: ${desc.join(", ")}`);
  console.log("#".repeat(120));

  const { trades, concurrentEvents } = runBacktest(cfg, 1.0);
  const fullStats = computeStats(trades, FULL_START, FULL_END);

  const longCount = trades.filter(t => t.dir === "long").length;
  const shortCount = trades.filter(t => t.dir === "short").length;

  // Full period
  console.log("\n--- Full Period ---");
  printHeader();
  printStatsLine("Full 2023-2026", fullStats);
  console.log(`  Longs: ${longCount}, Shorts: ${shortCount}, L/S ratio: ${(longCount / Math.max(1, shortCount)).toFixed(2)}`);

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
    `${"Engine".padEnd(16)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("WR", 7)} ` +
    `${pad("Total PnL", 11)} ${pad("$/day", 9)} ${pad("AvgPnl", 8)} ${pad("Longs", 6)} ${pad("Shorts", 7)}`
  );
  console.log("-".repeat(85));
  const days = (FULL_END - FULL_START) / DAY;
  for (const eng of ["A", "B", "C", "D", "M"]) {
    const et = trades.filter(t => t.engine === eng);
    if (et.length === 0) continue;
    const pnl = et.reduce((s, t) => s + t.pnl, 0);
    const wins = et.filter(t => t.pnl > 0);
    const losses = et.filter(t => t.pnl <= 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
    const el = et.filter(t => t.dir === "long").length;
    const es = et.filter(t => t.dir === "short").length;
    console.log(
      `${(eng + ": " + ENGINE_NAMES[eng]).padEnd(16)} ${pad(String(et.length), 6)} ${pad(pf.toFixed(2), 6)} ` +
      `${pad(fmtPct(et.length > 0 ? wins.length / et.length * 100 : 0), 7)} ` +
      `${pad(fmtPnl(pnl), 11)} ${pad(fmtPnl(pnl / days), 9)} ` +
      `${pad(fmtPnl(et.length > 0 ? pnl / et.length : 0), 8)} ${pad(String(el), 6)} ${pad(String(es), 7)}`
    );
  }

  results.push({ label: cfg.label, fullStats, yearStats, trades, concurrentEvents, longCount, shortCount });
}

// ─── RANKED TABLE ───────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(140));
console.log("  RANKED TABLE - All Configurations (sorted by $/day)");
console.log("=".repeat(140));

const sorted = [...results].sort((a, b) => b.fullStats.perDay - a.fullStats.perDay);

console.log(
  `${"#".padEnd(3)} ${"Config".padEnd(22)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
  `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ${pad("DDdur", 6)} ${pad("Recov", 6)} ` +
  `${pad("Total PnL", 11)} ${pad("Longs", 6)} ${pad("Shorts", 7)} ` +
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
    `${String(i + 1).padEnd(3)} ${r.label.padEnd(22)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 7)} ${pad(s.maxDdDuration, 6)} ${pad(String(s.recoveryDays) + "d", 6)} ` +
    `${pad(fmtPnl(s.totalPnl), 11)} ${pad(String(r.longCount), 6)} ${pad(String(r.shortCount), 7)} ` +
    `${pad(fmtPnl(y23.perDay), 7)} ${pad(fmtPnl(y24.perDay), 7)} ${pad(fmtPnl(y25.perDay), 7)} ${pad(fmtPnl(y26.perDay), 7)}`
  );
}

// ─── CONCURRENT EVENT ANALYSIS ──────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  CONCURRENT EVENT ANALYSIS");
console.log("  How often does '1 big losing long + many winning shorts' happen?");
console.log("  Criteria: long lost >$3 while concurrent shorts collectively profited");
console.log("=".repeat(120));

for (const r of results) {
  const events = r.concurrentEvents;
  const totalLongs = r.trades.filter(t => t.dir === "long").length;
  console.log(`\n${r.label}:`);
  console.log(`  Total longs: ${totalLongs}, Concurrent loss events: ${events.length}`);
  if (events.length > 0) {
    const avgLongLoss = events.reduce((s, e) => s + e.longLoss, 0) / events.length;
    const avgShortProfit = events.reduce((s, e) => s + e.shortProfit, 0) / events.length;
    const totalLongLoss = events.reduce((s, e) => s + e.longLoss, 0);
    const totalShortProfit = events.reduce((s, e) => s + e.shortProfit, 0);
    const netImpact = totalLongLoss + totalShortProfit;
    console.log(`  Avg long loss: ${fmtPnl(avgLongLoss)}, Avg concurrent short profit: ${fmtPnl(avgShortProfit)}`);
    console.log(`  Total long losses: ${fmtPnl(totalLongLoss)}, Total concurrent short profits: ${fmtPnl(totalShortProfit)}`);
    console.log(`  Net impact: ${fmtPnl(netImpact)} (${netImpact > 0 ? "shorts more than offset long losses" : "long losses exceed short profits"})`);
    console.log(`  Frequency: ${(events.length / Math.max(1, totalLongs) * 100).toFixed(1)}% of longs trigger this scenario`);

    // Show worst 5 events
    const worst = [...events].sort((a, b) => a.longLoss - b.longLoss).slice(0, 5);
    console.log("  Worst 5 events:");
    for (const e of worst) {
      const date = new Date(e.longTrade.et).toISOString().slice(0, 10);
      console.log(
        `    ${date} ${e.longTrade.engine}:${e.longTrade.pair} long loss=${fmtPnl(e.longLoss)}, ` +
        `${e.shortTrades.length} concurrent shorts profit=${fmtPnl(e.shortProfit)}, net=${fmtPnl(e.longLoss + e.shortProfit)}`
      );
    }
  }
}

// ─── DIRECTION BREAKDOWN ────────────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  DIRECTION P&L BREAKDOWN (Baseline config)");
console.log("=".repeat(120));

const baselineTrades = results[0].trades;
const longTrades = baselineTrades.filter(t => t.dir === "long");
const shortTrades = baselineTrades.filter(t => t.dir === "short");

const longPnl = longTrades.reduce((s, t) => s + t.pnl, 0);
const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
const longWins = longTrades.filter(t => t.pnl > 0).length;
const shortWins = shortTrades.filter(t => t.pnl > 0).length;
const longGrossWin = longTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
const longGrossLoss = Math.abs(longTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
const shortGrossWin = shortTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
const shortGrossLoss = Math.abs(shortTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
const longPF = longGrossLoss > 0 ? longGrossWin / longGrossLoss : Infinity;
const shortPF = shortGrossLoss > 0 ? shortGrossWin / shortGrossLoss : Infinity;

const totalDays = (FULL_END - FULL_START) / DAY;
console.log(`\nLONGS:  ${longTrades.length} trades, PF ${longPF.toFixed(2)}, WR ${(longWins / Math.max(1, longTrades.length) * 100).toFixed(1)}%, Total ${fmtPnl(longPnl)}, ${fmtPnl(longPnl / totalDays)}/day`);
console.log(`SHORTS: ${shortTrades.length} trades, PF ${shortPF.toFixed(2)}, WR ${(shortWins / Math.max(1, shortTrades.length) * 100).toFixed(1)}%, Total ${fmtPnl(shortPnl)}, ${fmtPnl(shortPnl / totalDays)}/day`);
console.log(`\nLong avg win: ${fmtPnl(longWins > 0 ? longGrossWin / longWins : 0)}, avg loss: ${fmtPnl(longTrades.length - longWins > 0 ? -longGrossLoss / (longTrades.length - longWins) : 0)}`);
console.log(`Short avg win: ${fmtPnl(shortWins > 0 ? shortGrossWin / shortWins : 0)}, avg loss: ${fmtPnl(shortTrades.length - shortWins > 0 ? -shortGrossLoss / (shortTrades.length - shortWins) : 0)}`);

// Per-year direction breakdown
console.log("\nPer-year direction P&L:");
console.log(
  `${"Year".padEnd(8)} ${pad("L trades", 9)} ${pad("L PnL", 10)} ${pad("L $/day", 9)} ${pad("L PF", 6)} ` +
  `${pad("S trades", 9)} ${pad("S PnL", 10)} ${pad("S $/day", 9)} ${pad("S PF", 6)}`
);
console.log("-".repeat(85));
for (const year of [2023, 2024, 2025, 2026]) {
  const ys = new Date(`${year}-01-01`).getTime();
  const ye = Math.min(new Date(`${year + 1}-01-01`).getTime(), FULL_END);
  const yDays = (ye - ys) / DAY;
  const yLongs = baselineTrades.filter(t => t.dir === "long" && t.et >= ys && t.et < ye);
  const yShorts = baselineTrades.filter(t => t.dir === "short" && t.et >= ys && t.et < ye);
  const yLpnl = yLongs.reduce((s, t) => s + t.pnl, 0);
  const ySpnl = yShorts.reduce((s, t) => s + t.pnl, 0);
  const yLw = yLongs.filter(t => t.pnl > 0);
  const yLl = yLongs.filter(t => t.pnl <= 0);
  const yLgw = yLw.reduce((s, t) => s + t.pnl, 0);
  const yLgl = Math.abs(yLl.reduce((s, t) => s + t.pnl, 0));
  const yLpf = yLgl > 0 ? yLgw / yLgl : yLgw > 0 ? Infinity : 0;
  const ySw = yShorts.filter(t => t.pnl > 0);
  const ySl = yShorts.filter(t => t.pnl <= 0);
  const ySgw = ySw.reduce((s, t) => s + t.pnl, 0);
  const ySgl = Math.abs(ySl.reduce((s, t) => s + t.pnl, 0));
  const ySpf = ySgl > 0 ? ySgw / ySgl : ySgw > 0 ? Infinity : 0;
  console.log(
    `${String(year).padEnd(8)} ${pad(String(yLongs.length), 9)} ${pad(fmtPnl(yLpnl), 10)} ${pad(fmtPnl(yLpnl / yDays), 9)} ${pad(yLpf.toFixed(2), 6)} ` +
    `${pad(String(yShorts.length), 9)} ${pad(fmtPnl(ySpnl), 10)} ${pad(fmtPnl(ySpnl / yDays), 9)} ${pad(ySpf.toFixed(2), 6)}`
  );
}

// ─── VERDICT ────────────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  VERDICT");
console.log("=".repeat(120));
const baseline = results[0];
const bestResult = sorted[0];
const worstResult = sorted[sorted.length - 1];

console.log(`\nBaseline: ${fmtPnl(baseline.fullStats.perDay)}/day, PF ${baseline.fullStats.pf}, Sharpe ${baseline.fullStats.sharpe}`);
console.log(`Best:     ${bestResult.label} -> ${fmtPnl(bestResult.fullStats.perDay)}/day, PF ${bestResult.fullStats.pf}, Sharpe ${bestResult.fullStats.sharpe}`);
console.log(`Worst:    ${worstResult.label} -> ${fmtPnl(worstResult.fullStats.perDay)}/day, PF ${worstResult.fullStats.pf}, Sharpe ${worstResult.fullStats.sharpe}`);

const baselineEvents = baseline.concurrentEvents.length;
const baselineLongLosses = baseline.concurrentEvents.reduce((s, e) => s + e.longLoss, 0);
console.log(`\nConcurrent loss events (baseline): ${baselineEvents} times`);
if (baselineEvents > 0) {
  console.log(`Total long losses in those events: ${fmtPnl(baselineLongLosses)}`);
  console.log(`Total short profits in those events: ${fmtPnl(baseline.concurrentEvents.reduce((s, e) => s + e.shortProfit, 0))}`);
}

if (bestResult.label !== baseline.label) {
  const improvement = bestResult.fullStats.perDay - baseline.fullStats.perDay;
  console.log(`\nDirection limiting HELPS: ${bestResult.label} adds ${fmtPnl(improvement)}/day over baseline.`);
} else {
  console.log(`\nDirection limiting does NOT help: baseline is already optimal.`);
}
