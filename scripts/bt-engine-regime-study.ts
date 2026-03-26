/**
 * Engine Regime Study - Are GARCH v2 and Range Expansion "free options"?
 *
 * Tests whether weak engines break even in most regimes but contribute in specific ones.
 * If they don't lose, keeping them is free diversification / insurance.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-engine-regime-study.ts
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
const MAX_POSITIONS = 10;
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
interface EngAData { sma20: (number | null)[]; sma50: (number | null)[]; donLo15: (number | null)[]; donHi15: (number | null)[]; atr14: (number | null)[]; }
interface EngBData { st: (1 | -1 | null)[]; atr14: (number | null)[]; }
interface EngCData { h1z: number[]; h4z: number[]; h1ema9: (number | null)[]; h1ema21: (number | null)[]; h1atr14: (number | null)[]; }
interface EngEData { atr14: (number | null)[]; donLo10: (number | null)[]; donHi10: (number | null)[]; }

// ─── Global data ────────────────────────────────────────────────────
let btc: BTCData;
let available: string[] = [];
let pairData: Map<string, PairData>;
let engAMap: Map<string, EngAData>;
let engBMap: Map<string, EngBData>;
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
  console.log("Indicators computed.\n");
}

// ─── Run Backtest ───────────────────────────────────────────────────
function runBacktest(activeEngines: Set<string>, sizes: Record<string, number>, maxPos: number): Trade[] {
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
        if (totalPositions() >= maxPos) break;
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
          margin: sizes["A"] ?? 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
        });
      }
    }

    // ─── ENGINE B: 4h Supertrend ────────────────────────────────────
    if (activeEngines.has("B")) {
      for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
        const h4T = dayT + h4Offset;
        for (const p of available) {
          if (totalPositions() >= maxPos) break;
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
            margin: sizes["B"] ?? 3, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
          });
        }
      }
    }

    // ─── ENGINE C: GARCH v2 MTF ─────────────────────────────────────
    if (activeEngines.has("C")) {
      for (let h1Offset = 0; h1Offset < DAY; h1Offset += H1) {
        const h1T = dayT + h1Offset;
        for (const p of available) {
          if (totalPositions() >= maxPos) break;
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
            margin: sizes["C"] ?? 5, lev: 10, maxHold: 96 * H1, atr: h1atr as number, bestPnlAtr: 0,
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
          if (totalPositions() >= maxPos) break;
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
            margin: sizes["D"] ?? 5, lev: 10, maxHold: 8 * DAY, atr: atrVal as number, bestPnlAtr: 0,
          });
        }
      }
    }

    // ─── ENGINE E: Range Expansion ──────────────────────────────────
    if (activeEngines.has("E")) {
      for (const p of available) {
        if (totalPositions() >= maxPos) break;
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

// ─── Helper Functions ───────────────────────────────────────────────
function pad(s: string, n: number): string { return s.padStart(n); }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "") + "$" + Math.abs(v).toFixed(2); }

function getMonthKey(t: number): string {
  return new Date(t).toISOString().slice(0, 7);
}

function getYearKey(t: number): number {
  return new Date(t).getFullYear();
}

// BTC monthly returns for regime classification
function btcMonthlyReturns(): Map<string, number> {
  const m = new Map<string, number>();
  const monthPrices = new Map<string, { first: number; last: number }>();

  for (const bar of btc.daily) {
    const mk = getMonthKey(bar.t);
    const existing = monthPrices.get(mk);
    if (!existing) {
      monthPrices.set(mk, { first: bar.o, last: bar.c });
    } else {
      existing.last = bar.c;
    }
  }

  for (const [mk, prices] of monthPrices) {
    m.set(mk, (prices.last / prices.first) - 1);
  }
  return m;
}

type Regime = "bull" | "bear" | "sideways";
function classifyRegime(ret: number): Regime {
  if (ret > 0.05) return "bull";
  if (ret < -0.05) return "bear";
  return "sideways";
}

// ─── ANALYSIS FUNCTIONS ─────────────────────────────────────────────

function monthlyPnlByEngine(trades: Trade[]): Map<string, Map<string, number>> {
  // engine -> month -> pnl
  const result = new Map<string, Map<string, number>>();
  for (const t of trades) {
    const mk = getMonthKey(t.xt);
    if (!result.has(t.engine)) result.set(t.engine, new Map());
    const em = result.get(t.engine)!;
    em.set(mk, (em.get(mk) ?? 0) + t.pnl);
  }
  return result;
}

// ─── MAIN ───────────────────────────────────────────────────────────
console.log("=".repeat(120));
console.log("  ENGINE REGIME STUDY - Are GARCH v2 and Range Expansion 'free options'?");
console.log("  18 pairs, 2023-01 to 2026-03, 5m candles, exact live parameters");
console.log("  Cost: Taker 0.035%, standard spread map, 1.5x SL slippage, 10x leverage");
console.log("=".repeat(120));

loadAllData();

const ENGINE_LABELS: Record<string, string> = {
  A: "Donchian", B: "Supertrend", C: "GARCH v2", D: "Carry", E: "RangeExp",
};
const ALL_ENGINES = ["A", "B", "C", "D", "E"];
const LIVE_SIZES: Record<string, number> = { A: 5, B: 3, C: 5, D: 5, E: 3 };

// Run 5-engine baseline
console.log("Running 5-engine baseline (A+B+C+D+E)...");
const trades5 = runBacktest(new Set(ALL_ENGINES), LIVE_SIZES, MAX_POSITIONS);
console.log(`  ${trades5.length} trades total`);

// Run 3-engine (A+B+D)
console.log("Running 3-engine (A+B+D)...");
const trades3 = runBacktest(new Set(["A","B","D"]), LIVE_SIZES, MAX_POSITIONS);
console.log(`  ${trades3.length} trades total`);

// Run 4-engine keep GARCH (A+B+C+D)
console.log("Running 4-engine keepGARCH (A+B+C+D)...");
const trades4C = runBacktest(new Set(["A","B","C","D"]), LIVE_SIZES, MAX_POSITIONS);
console.log(`  ${trades4C.length} trades total`);

// Run 4-engine keep Range (A+B+D+E)
console.log("Running 4-engine keepRange (A+B+D+E)...");
const trades4E = runBacktest(new Set(["A","B","D","E"]), LIVE_SIZES, MAX_POSITIONS);
console.log(`  ${trades4E.length} trades total`);

const btcMR = btcMonthlyReturns();

// ════════════════════════════════════════════════════════════════════
// 1. PER-ENGINE PER-YEAR PnL
// ════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(120));
console.log("  1. PER-ENGINE PER-YEAR PnL");
console.log("=".repeat(120));

const years = [2023, 2024, 2025, 2026];
console.log(`\n${"Engine".padEnd(14)} ${"Trades".padStart(7)} ${"Total".padStart(10)} ${"2023".padStart(10)} ${"2024".padStart(10)} ${"2025".padStart(10)} ${"2026".padStart(10)}`);
console.log("-".repeat(75));

for (const eng of ALL_ENGINES) {
  const et = trades5.filter(t => t.engine === eng);
  const total = et.reduce((s, t) => s + t.pnl, 0);
  const yearPnl: number[] = [];
  for (const y of years) {
    const ys = new Date(`${y}-01-01`).getTime();
    const ye = y === 2026 ? FULL_END : new Date(`${y + 1}-01-01`).getTime();
    const yp = et.filter(t => t.xt >= ys && t.xt < ye).reduce((s, t) => s + t.pnl, 0);
    yearPnl.push(yp);
  }
  console.log(
    `${(eng + ": " + ENGINE_LABELS[eng]).padEnd(14)} ${pad(String(et.length), 7)} ${pad(fmtPnl(total), 10)} ` +
    yearPnl.map(v => pad(fmtPnl(v), 10)).join(" ")
  );
}

// ════════════════════════════════════════════════════════════════════
// 2. PER-ENGINE PER-REGIME PnL
// ════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(120));
console.log("  2. PER-ENGINE PER-REGIME PnL (bull = BTC >+5%/mo, bear = BTC <-5%/mo, sideways = rest)");
console.log("=".repeat(120));

// Count months per regime
const regimeMonths: Record<Regime, string[]> = { bull: [], bear: [], sideways: [] };
for (const [mk, ret] of btcMR) {
  if (new Date(mk + "-01").getTime() >= FULL_START && new Date(mk + "-01").getTime() < FULL_END) {
    regimeMonths[classifyRegime(ret)].push(mk);
  }
}
console.log(`\nRegime distribution: Bull ${regimeMonths.bull.length}mo, Bear ${regimeMonths.bear.length}mo, Sideways ${regimeMonths.sideways.length}mo`);

const mpnlByEng = monthlyPnlByEngine(trades5);

console.log(`\n${"Engine".padEnd(14)} ${"Bull PnL".padStart(10)} ${"Bull $/mo".padStart(10)} ${"Bear PnL".padStart(10)} ${"Bear $/mo".padStart(10)} ${"Side PnL".padStart(10)} ${"Side $/mo".padStart(10)}`);
console.log("-".repeat(80));

for (const eng of ALL_ENGINES) {
  const em = mpnlByEng.get(eng) ?? new Map<string, number>();
  const regPnl: Record<Regime, number> = { bull: 0, bear: 0, sideways: 0 };

  for (const [mk, pnl] of em) {
    const btcRet = btcMR.get(mk);
    if (btcRet === undefined) continue;
    const regime = classifyRegime(btcRet);
    regPnl[regime] += pnl;
  }

  console.log(
    `${(eng + ": " + ENGINE_LABELS[eng]).padEnd(14)} ` +
    `${pad(fmtPnl(regPnl.bull), 10)} ${pad(fmtPnl(regimeMonths.bull.length > 0 ? regPnl.bull / regimeMonths.bull.length : 0), 10)} ` +
    `${pad(fmtPnl(regPnl.bear), 10)} ${pad(fmtPnl(regimeMonths.bear.length > 0 ? regPnl.bear / regimeMonths.bear.length : 0), 10)} ` +
    `${pad(fmtPnl(regPnl.sideways), 10)} ${pad(fmtPnl(regimeMonths.sideways.length > 0 ? regPnl.sideways / regimeMonths.sideways.length : 0), 10)}`
  );
}

// Show monthly detail
console.log("\nMonth-by-month regime classification:");
const allMonths = [...btcMR.entries()]
  .filter(([mk]) => new Date(mk + "-01").getTime() >= FULL_START && new Date(mk + "-01").getTime() < FULL_END)
  .sort((a, b) => a[0].localeCompare(b[0]));

console.log(`${"Month".padEnd(10)} ${"BTC Ret".padStart(8)} ${"Regime".padStart(10)} ` +
  ALL_ENGINES.map(e => (ENGINE_LABELS[e] || e).padStart(10)).join(" "));
console.log("-".repeat(75));

for (const [mk, ret] of allMonths) {
  const regime = classifyRegime(ret);
  const engPnls = ALL_ENGINES.map(e => {
    const em = mpnlByEng.get(e);
    return em?.get(mk) ?? 0;
  });
  console.log(
    `${mk.padEnd(10)} ${pad((ret * 100).toFixed(1) + "%", 8)} ${pad(regime, 10)} ` +
    engPnls.map(v => pad(fmtPnl(v), 10)).join(" ")
  );
}

// ════════════════════════════════════════════════════════════════════
// 3. POSITION SLOT ANALYSIS
// ════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(120));
console.log("  3. POSITION SLOT ANALYSIS");
console.log("=".repeat(120));

// Count how many trades overlapped per day (approximate)
{
  // For each day, count active positions by engine
  const daySlots = new Map<number, Map<string, number>>();
  const allTrades = trades5;

  // Build a timeline of active positions per day
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    const active = new Map<string, number>();
    for (const tr of allTrades) {
      // If the trade was open during this day
      if (tr.et <= t && tr.xt >= t) {
        active.set(tr.engine, (active.get(tr.engine) ?? 0) + 1);
      }
    }
    const total = [...active.values()].reduce((s, v) => s + v, 0);
    if (total > 0) daySlots.set(t, active);
  }

  // Analyze slot usage
  let daysAtCap = 0;
  let totalDays = 0;
  const engSlotSum: Record<string, number> = {};
  const engSlotDays: Record<string, number> = {};
  for (const eng of ALL_ENGINES) { engSlotSum[eng] = 0; engSlotDays[eng] = 0; }

  for (const [, slots] of daySlots) {
    totalDays++;
    const total = [...slots.values()].reduce((s, v) => s + v, 0);
    if (total >= MAX_POSITIONS) daysAtCap++;
    for (const eng of ALL_ENGINES) {
      const cnt = slots.get(eng) ?? 0;
      engSlotSum[eng] += cnt;
      if (cnt > 0) engSlotDays[eng]++;
    }
  }

  console.log(`\nDays at 10-position cap: ${daysAtCap} / ${totalDays} (${(daysAtCap / totalDays * 100).toFixed(1)}%)`);
  console.log(`\nAverage daily slot usage per engine:`);
  console.log(`${"Engine".padEnd(14)} ${"Avg Slots".padStart(10)} ${"Days Active".padStart(12)} ${"% of Days".padStart(10)}`);
  console.log("-".repeat(50));
  for (const eng of ALL_ENGINES) {
    console.log(
      `${(eng + ": " + ENGINE_LABELS[eng]).padEnd(14)} ${pad((engSlotSum[eng] / Math.max(totalDays, 1)).toFixed(2), 10)} ` +
      `${pad(String(engSlotDays[eng]), 12)} ${pad((engSlotDays[eng] / Math.max(totalDays, 1) * 100).toFixed(1) + "%", 10)}`
    );
  }

  // When C or E holds a slot and cap is hit, what were A/B/D generating?
  // Compare: trades that 3-engine config got but 5-engine didn't
  const trades3Set = new Set(trades3.map(t => `${t.engine}:${t.pair}:${t.et}`));
  const trades5Set = new Set(trades5.map(t => `${t.engine}:${t.pair}:${t.et}`));

  const missed3by5 = trades3.filter(t => !trades5Set.has(`${t.engine}:${t.pair}:${t.et}`));
  const extra5over3 = trades5.filter(t => !trades3Set.has(`${t.engine}:${t.pair}:${t.et}`));

  const missedPnl = missed3by5.reduce((s, t) => s + t.pnl, 0);
  const extraPnl = extra5over3.reduce((s, t) => s + t.pnl, 0);
  const cePnl5 = trades5.filter(t => t.engine === "C" || t.engine === "E").reduce((s, t) => s + t.pnl, 0);

  console.log(`\nOpportunity cost analysis (5-eng vs 3-eng A+B+D):`);
  console.log(`  Trades in 3-eng NOT in 5-eng (displaced by C/E): ${missed3by5.length}, PnL: ${fmtPnl(missedPnl)}`);
  console.log(`  Extra trades in 5-eng (C+E themselves):          ${extra5over3.length}, PnL: ${fmtPnl(extraPnl)}`);
  console.log(`  C+E direct contribution in 5-eng:                PnL: ${fmtPnl(cePnl5)}`);
  console.log(`  Net effect of having C+E (3eng PnL vs 5eng PnL): ${fmtPnl(trades5.reduce((s,t)=>s+t.pnl,0) - trades3.reduce((s,t)=>s+t.pnl,0))}`);
}

// ════════════════════════════════════════════════════════════════════
// 4. "FREE OPTION" TEST
// ════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(120));
console.log("  4. FREE OPTION TEST");
console.log("  Months where engine contributes >+$5, hurts <-$5, or breaks even |pnl|<$5");
console.log("=".repeat(120));

for (const eng of ["C", "E"]) {
  const em = mpnlByEng.get(eng) ?? new Map<string, number>();
  const allPnls: { month: string; pnl: number }[] = [];

  // Include all months (zero for months with no trades)
  for (const [mk] of allMonths) {
    allPnls.push({ month: mk, pnl: em.get(mk) ?? 0 });
  }

  const contributes = allPnls.filter(x => x.pnl > 5);
  const hurts = allPnls.filter(x => x.pnl < -5);
  const breakeven = allPnls.filter(x => Math.abs(x.pnl) <= 5);

  const contribSum = contributes.reduce((s, x) => s + x.pnl, 0);
  const hurtsSum = hurts.reduce((s, x) => s + x.pnl, 0);
  const beSum = breakeven.reduce((s, x) => s + x.pnl, 0);

  console.log(`\n--- ${eng}: ${ENGINE_LABELS[eng]} ---`);
  console.log(`  Contributes (>+$5):  ${contributes.length} months, total ${fmtPnl(contribSum)}, avg ${fmtPnl(contributes.length > 0 ? contribSum / contributes.length : 0)}/mo`);
  if (contributes.length > 0) {
    console.log(`    Best months: ${contributes.sort((a, b) => b.pnl - a.pnl).slice(0, 5).map(x => `${x.month} (${fmtPnl(x.pnl)})`).join(", ")}`);
  }
  console.log(`  Hurts (<-$5):        ${hurts.length} months, total ${fmtPnl(hurtsSum)}, avg ${fmtPnl(hurts.length > 0 ? hurtsSum / hurts.length : 0)}/mo`);
  if (hurts.length > 0) {
    console.log(`    Worst months: ${hurts.sort((a, b) => a.pnl - b.pnl).slice(0, 5).map(x => `${x.month} (${fmtPnl(x.pnl)})`).join(", ")}`);
  }
  console.log(`  Breakeven (|pnl|<=5): ${breakeven.length} months, total ${fmtPnl(beSum)}`);

  const totalPnl = allPnls.reduce((s, x) => s + x.pnl, 0);
  const isOption = hurts.length <= 3 && contributes.length >= 5;
  console.log(`  TOTAL: ${fmtPnl(totalPnl)} over ${allPnls.length} months`);
  console.log(`  VERDICT: ${isOption ? "YES - This looks like a free option (few hurt months, some contribute months)" : hurts.length > contributes.length ? "NO - Hurts more often than it helps" : "MARGINAL - Close call"}`);
}

// ════════════════════════════════════════════════════════════════════
// 5. WORST CASE WITHOUT EACH ENGINE
// ════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(120));
console.log("  5. WORST SINGLE MONTH BY CONFIGURATION");
console.log("=".repeat(120));

function worstMonth(trades: Trade[]): { month: string; pnl: number } {
  const mp = new Map<string, number>();
  for (const t of trades) {
    const mk = getMonthKey(t.xt);
    mp.set(mk, (mp.get(mk) ?? 0) + t.pnl);
  }
  let worst = { month: "", pnl: Infinity };
  for (const [m, p] of mp) {
    if (p < worst.pnl) worst = { month: m, pnl: p };
  }
  return worst;
}

function monthlyStats(trades: Trade[]): { months: Map<string, number>; totalPnl: number } {
  const months = new Map<string, number>();
  for (const t of trades) {
    const mk = getMonthKey(t.xt);
    months.set(mk, (months.get(mk) ?? 0) + t.pnl);
  }
  return { months, totalPnl: trades.reduce((s, t) => s + t.pnl, 0) };
}

const configs = [
  { label: "5-eng (A+B+C+D+E)", trades: trades5 },
  { label: "3-eng (A+B+D)", trades: trades3 },
  { label: "4-eng keepGARCH (A+B+C+D)", trades: trades4C },
  { label: "4-eng keepRange (A+B+D+E)", trades: trades4E },
];

console.log(`\n${"Config".padEnd(30)} ${"Total PnL".padStart(11)} ${"Worst Month".padStart(12)} ${"Worst PnL".padStart(10)} ${"Losing Mo".padStart(10)}`);
console.log("-".repeat(80));

for (const cfg of configs) {
  const wm = worstMonth(cfg.trades);
  const ms = monthlyStats(cfg.trades);
  const losingMonths = [...ms.months.values()].filter(v => v < 0).length;
  console.log(
    `${cfg.label.padEnd(30)} ${pad(fmtPnl(ms.totalPnl), 11)} ${pad(wm.month, 12)} ${pad(fmtPnl(wm.pnl), 10)} ${pad(String(losingMonths) + "/" + ms.months.size, 10)}`
  );
}

// Show the worst 5 months per configuration
console.log("\nWorst 5 months per configuration:");
for (const cfg of configs) {
  const ms = monthlyStats(cfg.trades);
  const sorted = [...ms.months.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5);
  console.log(`  ${cfg.label}:`);
  for (const [m, p] of sorted) {
    console.log(`    ${m}: ${fmtPnl(p)}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 6. CORRELATION DURING DRAWDOWNS
// ════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(120));
console.log("  6. CORRELATION DURING DRAWDOWNS");
console.log("  When the 5-engine portfolio is in drawdown (equity < peak), how do GARCH and Range perform?");
console.log("=".repeat(120));

{
  // Build daily equity curve for the 5-engine portfolio
  const dailyPnl5 = new Map<number, number>();
  for (const t of trades5) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyPnl5.set(d, (dailyPnl5.get(d) ?? 0) + t.pnl);
  }
  const sortedDays = [...dailyPnl5.entries()].sort((a, b) => a[0] - b[0]);

  // Identify DD periods (equity below previous peak)
  let equity = 0, peak = 0;
  const ddDays = new Set<number>();
  const nonDdDays = new Set<number>();
  for (const [d, pnl] of sortedDays) {
    equity += pnl;
    if (equity >= peak) {
      peak = equity;
      nonDdDays.add(d);
    } else {
      ddDays.add(d);
    }
  }

  console.log(`\nTotal trading days: ${sortedDays.length}`);
  console.log(`Days in drawdown: ${ddDays.size} (${(ddDays.size / sortedDays.length * 100).toFixed(1)}%)`);
  console.log(`Days at/above peak: ${nonDdDays.size}`);

  // For each engine, compute PnL during DD days vs non-DD days
  console.log(`\n${"Engine".padEnd(14)} ${"DD PnL".padStart(10)} ${"DD $/day".padStart(10)} ${"Non-DD PnL".padStart(12)} ${"Non-DD $/d".padStart(11)} ${"DD Helps?".padStart(10)}`);
  console.log("-".repeat(75));

  for (const eng of ALL_ENGINES) {
    let ddPnl = 0, nonDdPnl = 0;
    let ddCount = 0, nonDdCount = 0;

    for (const t of trades5.filter(tr => tr.engine === eng)) {
      const d = Math.floor(t.xt / DAY) * DAY;
      if (ddDays.has(d)) {
        ddPnl += t.pnl;
        ddCount++;
      } else {
        nonDdPnl += t.pnl;
        nonDdCount++;
      }
    }

    const ddAvg = ddDays.size > 0 ? ddPnl / ddDays.size : 0;
    const nonDdAvg = nonDdDays.size > 0 ? nonDdPnl / nonDdDays.size : 0;
    const helps = ddPnl > 0 ? "YES" : ddPnl > -5 ? "NEUTRAL" : "NO";

    console.log(
      `${(eng + ": " + ENGINE_LABELS[eng]).padEnd(14)} ${pad(fmtPnl(ddPnl), 10)} ${pad(fmtPnl(ddAvg), 10)} ` +
      `${pad(fmtPnl(nonDdPnl), 12)} ${pad(fmtPnl(nonDdAvg), 11)} ${pad(helps, 10)}`
    );
  }

  // Also check: during the worst drawdown period specifically
  equity = 0; peak = 0;
  let maxDd = 0, ddStartDay = 0, ddEndDay = 0;
  let currentDdStart = 0;
  for (const [d, pnl] of sortedDays) {
    equity += pnl;
    if (equity > peak) { peak = equity; currentDdStart = d; }
    const dd = peak - equity;
    if (dd > maxDd) { maxDd = dd; ddStartDay = currentDdStart; ddEndDay = d; }
  }

  if (maxDd > 0) {
    console.log(`\nMax drawdown period: ${new Date(ddStartDay).toISOString().slice(0,10)} to ${new Date(ddEndDay).toISOString().slice(0,10)} ($${maxDd.toFixed(2)})`);
    console.log("Engine PnL during max DD period:");
    for (const eng of ALL_ENGINES) {
      const pnl = trades5
        .filter(t => t.engine === eng && t.xt >= ddStartDay && t.xt <= ddEndDay)
        .reduce((s, t) => s + t.pnl, 0);
      console.log(`  ${eng}: ${ENGINE_LABELS[eng]}: ${fmtPnl(pnl)}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// 7. FINAL VERDICT TABLE
// ════════════════════════════════════════════════════════════════════
console.log("\n\n" + "=".repeat(120));
console.log("  7. FINAL VERDICT TABLE");
console.log("=".repeat(120));

// Compute per-engine stats
const days = (FULL_END - FULL_START) / DAY;

console.log(`\n${"Engine".padEnd(14)} ${"Trades".padStart(7)} ${"PF".padStart(6)} ${"WR".padStart(7)} ${"Total PnL".padStart(11)} ${"$/day".padStart(9)} ${"Best Regime".padStart(14)} ${"Worst Regime".padStart(14)} ${"VERDICT".padStart(14)}`);
console.log("-".repeat(110));

for (const eng of ALL_ENGINES) {
  const et = trades5.filter(t => t.engine === eng);
  const pnl = et.reduce((s, t) => s + t.pnl, 0);
  const wins = et.filter(t => t.pnl > 0).length;
  const losses = et.filter(t => t.pnl <= 0).length;
  const gw = et.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(et.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
  const wr = et.length > 0 ? wins / et.length * 100 : 0;

  // Regime analysis
  const em = mpnlByEng.get(eng) ?? new Map<string, number>();
  const regPnl: Record<Regime, number> = { bull: 0, bear: 0, sideways: 0 };
  for (const [mk, p] of em) {
    const btcRet = btcMR.get(mk);
    if (btcRet !== undefined) regPnl[classifyRegime(btcRet)] += p;
  }

  const regNames = Object.entries(regPnl).sort((a, b) => b[1] - a[1]);
  const bestRegime = `${regNames[0][0]} ${fmtPnl(regNames[0][1])}`;
  const worstRegime = `${regNames[2][0]} ${fmtPnl(regNames[2][1])}`;

  // Verdict logic
  let verdict: string;
  const monthPnls = [...(em.values())];
  const hurtsCount = monthPnls.filter(p => p < -5).length;
  const helpsCount = monthPnls.filter(p => p > 5).length;

  if (pf >= 1.2 && pnl > 0) {
    verdict = "KEEP";
  } else if (pf < 0.9 || pnl < -20) {
    verdict = "REMOVE";
  } else if (hurtsCount > helpsCount * 2) {
    verdict = "REMOVE";
  } else if (helpsCount >= hurtsCount && pnl >= 0) {
    verdict = "KEEP";
  } else if (hurtsCount <= 3 && helpsCount >= 3) {
    verdict = "CONDITIONAL";
  } else if (pnl >= 0 && pf >= 1.0) {
    verdict = "CONDITIONAL";
  } else {
    verdict = "REMOVE";
  }

  console.log(
    `${(eng + ": " + ENGINE_LABELS[eng]).padEnd(14)} ${pad(String(et.length), 7)} ${pad(pf.toFixed(2), 6)} ` +
    `${pad(wr.toFixed(1) + "%", 7)} ${pad(fmtPnl(pnl), 11)} ${pad(fmtPnl(pnl / days), 9)} ` +
    `${pad(bestRegime, 14)} ${pad(worstRegime, 14)} ${pad(verdict, 14)}`
  );
}

// ─── FINAL RECOMMENDATION ──────────────────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("  FINAL RECOMMENDATION");
console.log("=".repeat(120));

const pnl5 = trades5.reduce((s, t) => s + t.pnl, 0);
const pnl3 = trades3.reduce((s, t) => s + t.pnl, 0);
const pnl4C = trades4C.reduce((s, t) => s + t.pnl, 0);
const pnl4E = trades4E.reduce((s, t) => s + t.pnl, 0);

const w5 = worstMonth(trades5);
const w3 = worstMonth(trades3);
const w4C = worstMonth(trades4C);
const w4E = worstMonth(trades4E);

console.log(`
  5-engine (A+B+C+D+E):        Total ${fmtPnl(pnl5)}, $/day ${fmtPnl(pnl5/days)}, worst month ${fmtPnl(w5.pnl)}
  4-engine keepGARCH (A+B+C+D): Total ${fmtPnl(pnl4C)}, $/day ${fmtPnl(pnl4C/days)}, worst month ${fmtPnl(w4C.pnl)}
  4-engine keepRange (A+B+D+E): Total ${fmtPnl(pnl4E)}, $/day ${fmtPnl(pnl4E/days)}, worst month ${fmtPnl(w4E.pnl)}
  3-engine (A+B+D):            Total ${fmtPnl(pnl3)}, $/day ${fmtPnl(pnl3/days)}, worst month ${fmtPnl(w3.pnl)}

  Delta (5eng - 3eng): ${fmtPnl(pnl5 - pnl3)} total, ${fmtPnl((pnl5 - pnl3) / days)}/day
  Worst month insurance: 5eng ${fmtPnl(w5.pnl)} vs 3eng ${fmtPnl(w3.pnl)} (${w5.pnl > w3.pnl ? "5-eng is better (less bad)" : "3-eng is better (less bad)"})
`);

console.log("Done.");
