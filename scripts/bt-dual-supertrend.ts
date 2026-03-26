/**
 * Dual Supertrend Backtest - Test whether adding a fast ST(10,1.5) alongside slow ST(14,1.75) improves the 5-engine system
 *
 * Engines: A(Donchian), B(Supertrend slow), B2(Supertrend fast), C(GARCH), D(Carry), E(Momentum)
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-dual-supertrend.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
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

interface TestConfig {
  label: string;
  engines: string[];
  maxPositions: number;
  sizes: Record<string, number>;
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

// ─── Global data (loaded once) ──────────────────────────────────────
let btc: BTCData;
let available: string[] = [];
let pairData: Map<string, PairData>;
let engAMap: Map<string, EngAData>;
let engBMap: Map<string, EngBData>;   // slow ST(14, 1.75)
let engB2Map: Map<string, EngBData>;  // fast ST(10, 1.5)
let engCMap: Map<string, EngCData>;
let engEMap: Map<string, EngEData>;

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
  engB2Map = new Map();
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

    engB2Map.set(p, {
      st: supertrend(pd.h4, 10, 1.5).trend,
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
  console.log("Indicators computed.\n");
}

// ─── Run Backtest ───────────────────────────────────────────────────
function runBacktest(config: TestConfig): Trade[] {
  const MAX_POSITIONS = config.maxPositions;
  const activeEngines = new Set(config.engines);
  const sizes = config.sizes;

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

        positions.set(key, {
          pair: p, engine: "A", dir, ep, et: dayT, sl, tp: 0,
          margin: sizes["A"] ?? 7, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
        });
      }
    }

    // ─── ENGINE B: 4h Supertrend Slow (14, 1.75) ────────────────────
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

          positions.set(key, {
            pair: p, engine: "B", dir, ep, et: h4T, sl, tp: 0,
            margin: sizes["B"] ?? 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
          });
        }
      }
    }

    // ─── ENGINE B2: 4h Supertrend Fast (10, 1.5) ────────────────────
    if (activeEngines.has("B2")) {
      for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
        const h4T = dayT + h4Offset;
        for (const p of available) {
          if (totalPositions() >= MAX_POSITIONS) break;
          const key = `B2:${p}`;
          if (positions.has(key)) continue;

          const pd = pairData.get(p)!;
          const eb2 = engB2Map.get(p)!;
          const h4i = pd.h4Map.get(h4T);
          if (h4i === undefined || h4i < 21) continue;

          const stNow = eb2.st[h4i - 1];
          const stPrev = eb2.st[h4i - 2];
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

          const atrVal = eb2.atr14[h4i - 1];
          if (atrVal === null) continue;

          const sp_ = sp(p);
          const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
          let slDist = atrVal * 3;
          if (slDist / ep > 0.035) slDist = ep * 0.035;
          const sl = dir === "long" ? ep - slDist : ep + slDist;

          positions.set(key, {
            pair: p, engine: "B2", dir, ep, et: h4T, sl, tp: 0,
            margin: sizes["B2"] ?? 3, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
          });
        }
      }
    }

    // ─── ENGINE C: GARCH v2 MTF ─────────────────────────────────────
    if (activeEngines.has("C")) {
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

          positions.set(key, {
            pair: p, engine: "C", dir, ep, et: h1T, sl, tp,
            margin: sizes["C"] ?? 3, lev: 10, maxHold: 96 * H1, atr: h1atr as number, bestPnlAtr: 0,
          });
        }
      }
    }

    // ─── ENGINE D: Carry Momentum ───────────────────────────────────
    if (activeEngines.has("D")) {
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
          const sp_ = sp(pick.pair);
          const ep = dir === "long" ? pd.daily[di].o * (1 + sp_) : pd.daily[di].o * (1 - sp_);
          let slDist = ep * 0.04;
          if (slDist / ep > 0.035) slDist = ep * 0.035;
          const sl = dir === "long" ? ep - slDist : ep + slDist;

          const dailyAtr = atrFn(pd.daily, 14);
          const atrVal = dailyAtr[di - 1] ?? ep * 0.02;

          positions.set(key, {
            pair: pick.pair, engine: "D", dir, ep, et: dayT, sl, tp: 0,
            margin: sizes["D"] ?? 7, lev: 10, maxHold: 8 * DAY, atr: atrVal as number, bestPnlAtr: 0,
          });
        }
      }
    }

    // ─── ENGINE E: Range Expansion / Momentum ──────────────────────
    if (activeEngines.has("E")) {
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

        const atrVal = ee.atr14[di - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p);
        const ep = dir === "long" ? pd.daily[di].o * (1 + sp_) : pd.daily[di].o * (1 - sp_);
        let slDist = atrVal * 2;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(key, {
          pair: p, engine: "E", dir, ep, et: dayT, sl, tp: 0,
          margin: sizes["E"] ?? 3, lev: 10, maxHold: 30 * DAY, atr: atrVal, bestPnlAtr: 0,
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

// ─── Correlation Computation ─────────────────────────────────────────
function computeCorrelation(tradesB: Trade[], tradesB2: Trade[]): number {
  // Build daily P&L maps for each engine
  const dailyB = new Map<number, number>();
  const dailyB2 = new Map<number, number>();

  for (const t of tradesB) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyB.set(d, (dailyB.get(d) ?? 0) + t.pnl);
  }
  for (const t of tradesB2) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyB2.set(d, (dailyB2.get(d) ?? 0) + t.pnl);
  }

  // Get all days that appear in either
  const allDays = new Set([...dailyB.keys(), ...dailyB2.keys()]);
  const sortedDays = [...allDays].sort((a, b) => a - b);

  const xArr: number[] = [];
  const yArr: number[] = [];
  for (const d of sortedDays) {
    xArr.push(dailyB.get(d) ?? 0);
    yArr.push(dailyB2.get(d) ?? 0);
  }

  if (xArr.length < 10) return 0;

  const n = xArr.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xArr[i]; sumY += yArr[i];
    sumXY += xArr[i] * yArr[i];
    sumX2 += xArr[i] * xArr[i]; sumY2 += yArr[i] * yArr[i];
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den > 0 ? num / den : 0;
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

// ─── ENGINE NAMES ───────────────────────────────────────────────────
const ENGINE_NAMES: Record<string, string> = {
  A: "Donchian", B: "ST-Slow(14,1.75)", B2: "ST-Fast(10,1.5)", C: "GARCH", D: "Carry", E: "Momentum",
};

// ─── Configurations ─────────────────────────────────────────────────
const CONFIGS: TestConfig[] = [
  // A. Current 5-engine: Donchian $7 + ST(14,1.75) $5 + GARCH $3 + Carry $7 + Momentum $3
  {
    label: "A. Current 5-eng",
    engines: ["A","B","C","D","E"],
    maxPositions: 20,
    sizes: { A: 7, B: 5, C: 3, D: 7, E: 3 },
  },
  // B. 6-engine with dual ST: Same + ST(10,1.5) $3 as 6th engine
  {
    label: "B. 6-eng + ST-Fast",
    engines: ["A","B","B2","C","D","E"],
    maxPositions: 20,
    sizes: { A: 7, B: 5, B2: 3, C: 3, D: 7, E: 3 },
  },
  // C. Replace slow ST with fast: Donchian $7 + ST(10,1.5) $5 + GARCH $3 + Carry $7 + Momentum $3
  {
    label: "C. Replace B->B2",
    engines: ["A","B2","C","D","E"],
    maxPositions: 20,
    sizes: { A: 7, B2: 5, C: 3, D: 7, E: 3 },
  },
  // D. Both STs at $3 each: Donchian $7 + ST(14,1.75) $3 + ST(10,1.5) $3 + GARCH $3 + Carry $7 + Momentum $3
  {
    label: "D. Both STs $3ea",
    engines: ["A","B","B2","C","D","E"],
    maxPositions: 20,
    sizes: { A: 7, B: 3, B2: 3, C: 3, D: 7, E: 3 },
  },
];

// ─── Main ───────────────────────────────────────────────────────────
console.log("=".repeat(120));
console.log("  DUAL SUPERTREND BACKTEST - Does adding ST-Fast(10,1.5) to ST-Slow(14,1.75) improve the system?");
console.log("  18 pairs, 2023-01 to 2026-03, 5m candles, max 20 positions, no trailing");
console.log("  Cost: Taker 0.035%, standard spread map, 1.5x SL slippage, 10x leverage");
console.log("=".repeat(120));

loadAllData();

interface ConfigResult {
  label: string;
  fullStats: Stats;
  yearStats: Map<number, Stats>;
  trades: Trade[];
}

const results: ConfigResult[] = [];

for (const cfg of CONFIGS) {
  console.log("\n" + "#".repeat(120));
  console.log(`  ${cfg.label}`);
  console.log(`  Engines: ${cfg.engines.map(e => e + ":" + ENGINE_NAMES[e]).join(", ")}`);
  console.log(`  Max positions: ${cfg.maxPositions}, Sizes: ${cfg.engines.map(e => e + "=$" + cfg.sizes[e]).join(", ")}`);
  console.log("#".repeat(120));

  const trades = runBacktest(cfg);
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
    `${"Engine".padEnd(24)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("WR", 7)} ` +
    `${pad("Total PnL", 11)} ${pad("$/day", 9)} ${pad("AvgPnl", 8)}`
  );
  console.log("-".repeat(80));
  const totalDays = (FULL_END - FULL_START) / DAY;
  for (const eng of cfg.engines) {
    const et = trades.filter(t => t.engine === eng);
    const pnl = et.reduce((s, t) => s + t.pnl, 0);
    const wins = et.filter(t => t.pnl > 0);
    const losses = et.filter(t => t.pnl <= 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const epf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
    console.log(
      `${(eng + ": " + ENGINE_NAMES[eng]).padEnd(24)} ${pad(String(et.length), 6)} ${pad(epf.toFixed(2), 6)} ` +
      `${pad(fmtPct(et.length > 0 ? wins.length / et.length * 100 : 0), 7)} ` +
      `${pad(fmtPnl(pnl), 11)} ${pad(fmtPnl(pnl / totalDays), 9)} ` +
      `${pad(fmtPnl(et.length > 0 ? pnl / et.length : 0), 8)}`
    );
  }

  results.push({ label: cfg.label, fullStats, yearStats, trades });
}

// ─── CORRELATION ANALYSIS ───────────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  CORRELATION ANALYSIS: ST-Slow(14,1.75) vs ST-Fast(10,1.5)");
console.log("=".repeat(120));

// Use config A trades for slow ST, and we need the fast ST trades too
// Run a standalone B-only and B2-only to get isolated trade streams
const cfgBonly: TestConfig = {
  label: "B-only", engines: ["B"], maxPositions: 20, sizes: { B: 5 },
};
const cfgB2only: TestConfig = {
  label: "B2-only", engines: ["B2"], maxPositions: 20, sizes: { B2: 5 },
};

const tradesB = runBacktest(cfgBonly);
const tradesB2 = runBacktest(cfgB2only);

const corr = computeCorrelation(tradesB, tradesB2);
console.log(`\nDaily P&L Correlation (B vs B2):  ${corr.toFixed(4)}`);

if (corr > 0.5) {
  console.log("-> HIGH correlation (>0.5): Engines are REDUNDANT. Adding both gives little diversification.");
} else if (corr > 0.3) {
  console.log("-> MODERATE correlation (0.3-0.5): Some overlap. Partial diversification benefit.");
} else {
  console.log("-> LOW correlation (<0.3): Engines are COMPLEMENTARY. Strong diversification case.");
}

// Also show standalone stats for each
const bStats = computeStats(tradesB, FULL_START, FULL_END);
const b2Stats = computeStats(tradesB2, FULL_START, FULL_END);
console.log(`\nST-Slow standalone:  ${bStats.trades} trades, PF ${bStats.pf}, $/day ${fmtPnl(bStats.perDay)}, WR ${fmtPct(bStats.wr)}`);
console.log(`ST-Fast standalone:  ${b2Stats.trades} trades, PF ${b2Stats.pf}, $/day ${fmtPnl(b2Stats.perDay)}, WR ${fmtPct(b2Stats.wr)}`);

// Trade overlap analysis
const bEntries = new Set(tradesB.map(t => `${t.pair}:${Math.floor(t.et / DAY)}`));
const b2Entries = new Set(tradesB2.map(t => `${t.pair}:${Math.floor(t.et / DAY)}`));
let overlap = 0;
for (const e of bEntries) { if (b2Entries.has(e)) overlap++; }
console.log(`\nSame-day same-pair entry overlap: ${overlap} / B:${bEntries.size} B2:${b2Entries.size} = ${(overlap / Math.max(bEntries.size, 1) * 100).toFixed(1)}%`);

// ─── RANKED TABLE ───────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(140));
console.log("  RANKED TABLE - All Configurations (sorted by full-period $/day)");
console.log("=".repeat(140));

const sorted = [...results].sort((a, b) => b.fullStats.perDay - a.fullStats.perDay);

console.log(
  `${"#".padEnd(3)} ${"Config".padEnd(22)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
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
    `${String(i + 1).padEnd(3)} ${r.label.padEnd(22)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 7)} ${pad(s.maxDdDuration, 6)} ${pad(String(s.recoveryDays) + "d", 6)} ` +
    `${pad(fmtPnl(s.totalPnl), 11)} ` +
    `${pad(fmtPnl(y23.perDay), 7)} ${pad(fmtPnl(y24.perDay), 7)} ${pad(fmtPnl(y25.perDay), 7)} ${pad(fmtPnl(y26.perDay), 7)}`
  );
}

// ─── VERDICT ─────────────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  VERDICT");
console.log("=".repeat(120));

const baseline = results[0];
const best = sorted[0];

console.log(`
Baseline (A):     ${baseline.label}  ->  ${fmtPnl(baseline.fullStats.perDay)}/day, PF ${baseline.fullStats.pf}, Sharpe ${baseline.fullStats.sharpe}, MaxDD $${baseline.fullStats.maxDd.toFixed(0)}
Best config:      ${best.label}  ->  ${fmtPnl(best.fullStats.perDay)}/day, PF ${best.fullStats.pf}, Sharpe ${best.fullStats.sharpe}, MaxDD $${best.fullStats.maxDd.toFixed(0)}

Delta vs baseline: ${fmtPnl(best.fullStats.perDay - baseline.fullStats.perDay)}/day (${((best.fullStats.perDay / Math.max(baseline.fullStats.perDay, 0.01) - 1) * 100).toFixed(1)}%)

Correlation B vs B2: ${corr.toFixed(4)} ${corr > 0.5 ? "(REDUNDANT)" : corr > 0.3 ? "(MODERATE)" : "(COMPLEMENTARY)"}

Year consistency (best):
  2023: ${fmtPnl(best.yearStats.get(2023)!.perDay)}/day
  2024: ${fmtPnl(best.yearStats.get(2024)!.perDay)}/day
  2025: ${fmtPnl(best.yearStats.get(2025)!.perDay)}/day
  2026: ${fmtPnl(best.yearStats.get(2026)!.perDay)}/day
`);

// Check all years positive for best
const allYearsPositive = [2023, 2024, 2025, 2026].every(y => best.yearStats.get(y)!.perDay > 0);
if (allYearsPositive) {
  console.log("All years positive for best config.");
} else {
  console.log("WARNING: Best config has negative year(s).");
}

if (corr < 0.3 && best.fullStats.perDay > baseline.fullStats.perDay) {
  console.log("RECOMMENDATION: Dual Supertrend is complementary and improves returns. Add it.");
} else if (corr >= 0.3 && corr <= 0.5 && best.fullStats.perDay > baseline.fullStats.perDay * 1.1) {
  console.log("RECOMMENDATION: Moderate correlation but meaningful improvement. Worth adding.");
} else if (corr > 0.5) {
  console.log("RECOMMENDATION: High correlation. Dual ST is redundant. Keep single slow ST.");
} else {
  console.log("RECOMMENDATION: Improvement is marginal. Stick with current setup unless Sharpe also improves.");
}
