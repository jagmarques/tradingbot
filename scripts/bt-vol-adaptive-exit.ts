/**
 * Volatility-Adaptive Exit Research
 *
 * Tests whether adapting exit sensitivity to current volatility reduces
 * peak giveback in trend-following crypto exits.
 *
 * Engines: A (Daily Donchian SMA 30/60), B (4h Supertrend 14/2)
 * Exit variants:
 *   1. Baseline (current: 15d Donchian / ST flip, ATR*3 SL, ATR trail)
 *   2. ATR ratio: tighten when ATR(14) > 1.5x ATR(14) from 20 bars ago
 *   3. Volatility percentile: tighten when ATR in >80th percentile over 60 bars
 *   4. Chandelier exit: trail from HH/LL by 3x ATR (adapts to current vol)
 *   5. Parabolic SAR as exit (acceleration 0.02, max 0.2)
 *
 * Uses 5m data for signals + exit precision. SMA ATR (not Wilder).
 * Proper half-spreads. Fix Donchian SMA look-ahead (use i-1 vs i-2).
 * Donchian $7, Supertrend $5, 10x leverage.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-vol-adaptive-exit.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;

const MARGIN_A = 7;
const MARGIN_B = 5;
const LEV = 10;
const MAX_SL_PCT = 0.035;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA",
  "DOGE","APT","LINK","ADA","WLD","XRP","UNI",
];

const FULL_START = new Date("2023-06-01").getTime();
const FULL_END   = new Date("2026-03-25").getTime();

type Dir = "long" | "short";
type ExitMode = "baseline" | "atr-ratio" | "vol-pctile" | "chandelier" | "psar";

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }

interface Position {
  pair: string;
  engine: "A" | "B";
  dir: Dir;
  ep: number;
  et: number;
  sl: number;
  margin: number;
  atrAtEntry: number;
  bestPnlAtr: number;
  highestHigh: number;
  lowestLow: number;
  psar: number;
  psarAf: number;
  psarEp_: number;
  peakUnreal: number; // peak unrealized $PnL
}

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number;
  pnl: number; margin: number; reason: string;
  peakPnl: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_5M, `${pair}USDT.json`);
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
    for (const c of cs) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; vol += c.v; }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c, v: vol });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators (SMA-based ATR, not Wilder) ─────────────────────────
function smaInd(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) r[i] = sum / period;
  }
  return r;
}

function emaInd(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  let seeded = false;
  let v = 0;
  for (let i = 0; i < vals.length; i++) {
    if (!seeded) {
      v += vals[i];
      if (i === period - 1) { v /= period; seeded = true; r[i] = v; }
    } else {
      v = vals[i] * k + v * (1 - k);
      r[i] = v;
    }
  }
  return r;
}

function atrSma(bars: Bar[], period: number): (number | null)[] {
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trs.push(tr);
  }
  return smaInd(trs, period);
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

function supertrendCalc(bars: Bar[], atrPeriod: number, mult: number): (1 | -1 | null)[] {
  const atrVals = atrSma(bars, atrPeriod);
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
    if (prevTrend === 1) t = bars[i].c < lowerBand ? -1 : 1;
    else t = bars[i].c > upperBand ? 1 : -1;

    upperBand = ub; lowerBand = lb; prevTrend = t; trend[i] = t;
  }
  return trend;
}

function atrPercentile(atrVals: (number | null)[], idx: number, lookback: number): number | null {
  const vals: number[] = [];
  for (let j = Math.max(0, idx - lookback + 1); j <= idx; j++) {
    if (atrVals[j] !== null) vals.push(atrVals[j]!);
  }
  if (vals.length < 20) return null;
  const cur = atrVals[idx];
  if (cur === null) return null;
  return vals.filter(v => v < cur).length / vals.length;
}

// ─── Spread helper ──────────────────────────────────────────────────
function halfSpread(pair: string): number { return (SPREAD[pair] ?? 4e-4) / 2; }

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("Loading data...");

  // Load BTC
  const btcM5 = load5m("BTC");
  const btcDaily = aggregate(btcM5, DAY);
  const btcDc = btcDaily.map(b => b.c);
  const btcEma20 = emaInd(btcDc, 20);
  const btcEma50 = emaInd(btcDc, 50);
  const btcDailyMap = new Map(btcDaily.map((b, i) => [b.t, i]));
  // Free btcM5
  btcM5.length = 0;

  // Load pairs -- keep only aggregated bars, discard 5m raw
  interface PairInd {
    daily: Bar[]; h4: Bar[];
    dailyMap: Map<number, number>; h4Map: Map<number, number>;
    // Engine A indicators (daily)
    sma30: (number | null)[]; sma60: (number | null)[];
    donLo15: (number | null)[]; donHi15: (number | null)[];
    donLo8: (number | null)[]; donHi8: (number | null)[];
    donLo10: (number | null)[]; donHi10: (number | null)[];
    atr14d: (number | null)[];
    // Engine B indicators (4h)
    st: (1 | -1 | null)[]; atr14h4: (number | null)[];
  }

  const pairInd = new Map<string, PairInd>();
  const available: string[] = [];

  for (const p of PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 500) continue;
    const h4 = aggregate(m5, H4);
    const daily = aggregate(m5, DAY);
    // Free 5m immediately
    m5.length = 0;

    const dc = daily.map(b => b.c);
    available.push(p);
    pairInd.set(p, {
      daily, h4,
      dailyMap: new Map(daily.map((b, i) => [b.t, i])),
      h4Map: new Map(h4.map((b, i) => [b.t, i])),
      sma30: smaInd(dc, 30), sma60: smaInd(dc, 60),
      donLo15: donchianLow(dc, 15), donHi15: donchianHigh(dc, 15),
      donLo8: donchianLow(dc, 8), donHi8: donchianHigh(dc, 8),
      donLo10: donchianLow(dc, 10), donHi10: donchianHigh(dc, 10),
      atr14d: atrSma(daily, 14),
      st: supertrendCalc(h4, 14, 2), atr14h4: atrSma(h4, 14),
    });
  }
  console.log(`Loaded ${available.length} pairs, BTC daily: ${btcDaily.length} bars`);

  // ─── Helpers ──────────────────────────────────────────────────────
  function btcBullish(t: number): boolean {
    const dayKey = Math.floor(t / DAY) * DAY;
    let di = btcDailyMap.get(dayKey - DAY);
    if (di === undefined) di = btcDailyMap.get(dayKey);
    if (di === undefined) return false;
    const e20 = btcEma20[di], e50 = btcEma50[di];
    return e20 !== null && e50 !== null && e20 > e50;
  }

  function getIdx(barMap: Map<number, number>, t: number, period: number): number {
    const aligned = Math.floor(t / period) * period;
    let idx = barMap.get(aligned);
    if (idx !== undefined) return idx;
    for (let dt = period; dt <= 5 * period; dt += period) {
      idx = barMap.get(aligned - dt);
      if (idx !== undefined) return idx;
    }
    return -1;
  }

  function updatePsar(pos: Position, bar: Bar) {
    if (pos.dir === "long") {
      pos.psar = pos.psar + pos.psarAf * (pos.psarEp_ - pos.psar);
      pos.psar = Math.min(pos.psar, bar.l);
      if (bar.h > pos.psarEp_) {
        pos.psarEp_ = bar.h;
        pos.psarAf = Math.min(pos.psarAf + 0.02, 0.20);
      }
    } else {
      pos.psar = pos.psar - pos.psarAf * (pos.psar - pos.psarEp_);
      pos.psar = Math.max(pos.psar, bar.h);
      if (bar.l < pos.psarEp_) {
        pos.psarEp_ = bar.l;
        pos.psarAf = Math.min(pos.psarAf + 0.02, 0.20);
      }
    }
  }

  function closePos(pos: Position, exitPrice: number, exitTime: number, reason: string, trades: Trade[]) {
    const hs = halfSpread(pos.pair);
    const xp = pos.dir === "long" ? exitPrice * (1 - hs) : exitPrice * (1 + hs);
    const notional = pos.margin * LEV;
    const raw = pos.dir === "long" ? (xp / pos.ep - 1) * notional : (pos.ep / xp - 1) * notional;
    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl: raw - notional * FEE * 2,
      margin: pos.margin, reason, peakPnl: pos.peakUnreal,
    });
  }

  // ─── Run simulation ───────────────────────────────────────────────
  function simulate(exitMode: ExitMode): Trade[] {
    const positions = new Map<string, Position>();
    const trades: Trade[] = [];

    const dailyTimestamps: number[] = [];
    for (let t = FULL_START; t < FULL_END; t += DAY) dailyTimestamps.push(t);

    for (const dayT of dailyTimestamps) {
      // ─── EXIT CHECKS ──────────────────────────────────────────────
      for (const [key, pos] of [...positions.entries()]) {
        const pi = pairInd.get(pos.pair);
        if (!pi) continue;
        const hs = halfSpread(pos.pair);
        const di = getIdx(pi.dailyMap, dayT, DAY);
        if (di < 1) continue;
        const bar = pi.daily[di];
        const notional = pos.margin * LEV;

        // Track peak unrealized PnL
        const bestPx = pos.dir === "long" ? bar.h : bar.l;
        const bestUnreal = pos.dir === "long"
          ? (bestPx * (1 - hs) / pos.ep - 1) * notional - notional * FEE * 2
          : (pos.ep / (bestPx * (1 + hs)) - 1) * notional - notional * FEE * 2;
        if (bestUnreal > pos.peakUnreal) pos.peakUnreal = bestUnreal;

        // Track Chandelier HH/LL
        if (bar.h > pos.highestHigh) pos.highestHigh = bar.h;
        if (bar.l < pos.lowestLow) pos.lowestLow = bar.l;

        // ATR trail management
        const unrealAtr = pos.atrAtEntry > 0
          ? (pos.dir === "long" ? (bar.c - pos.ep) / pos.atrAtEntry : (pos.ep - bar.c) / pos.atrAtEntry)
          : 0;
        if (unrealAtr > pos.bestPnlAtr) pos.bestPnlAtr = unrealAtr;

        let newSl = pos.sl;
        if (pos.atrAtEntry > 0) {
          if (pos.bestPnlAtr >= 3) {
            const tp = pos.dir === "long"
              ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atrAtEntry
              : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atrAtEntry;
            newSl = pos.dir === "long" ? Math.max(newSl, tp) : Math.min(newSl, tp);
          } else if (pos.bestPnlAtr >= 2) {
            const tp = pos.dir === "long"
              ? bar.h - 2 * pos.atrAtEntry
              : bar.l + 2 * pos.atrAtEntry;
            newSl = pos.dir === "long" ? Math.max(newSl, tp) : Math.min(newSl, tp);
          } else if (pos.bestPnlAtr >= 1) {
            newSl = pos.dir === "long" ? Math.max(newSl, pos.ep) : Math.min(newSl, pos.ep);
          }
        }
        pos.sl = newSl;

        // SL check
        let stopped = false;
        if (pos.dir === "long" && bar.l <= pos.sl) {
          closePos(pos, pos.sl, dayT, "sl", trades);
          positions.delete(key); stopped = true;
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          closePos(pos, pos.sl, dayT, "sl", trades);
          positions.delete(key); stopped = true;
        }
        if (stopped) continue;

        // Max hold 60d
        if (dayT - pos.et >= 60 * DAY) {
          closePos(pos, bar.c, dayT, "mh", trades);
          positions.delete(key); continue;
        }

        // ── Engine A signal exits ────────────────────────────────────
        if (pos.engine === "A") {
          const curAtr = pi.atr14d[di];
          const oldAtr = di >= 20 ? pi.atr14d[di - 20] : null;

          let exited = false;
          if (exitMode === "baseline") {
            if (pos.dir === "long" && pi.donLo15[di] !== null && bar.c < pi.donLo15[di]!) exited = true;
            if (pos.dir === "short" && pi.donHi15[di] !== null && bar.c > pi.donHi15[di]!) exited = true;
            if (exited) { closePos(pos, bar.c, dayT, "donch15", trades); positions.delete(key); continue; }
          } else if (exitMode === "atr-ratio") {
            const volHigh = curAtr !== null && oldAtr !== null && oldAtr > 0 && curAtr > 1.5 * oldAtr;
            const donLo = volHigh ? pi.donLo8[di] : pi.donLo15[di];
            const donHi = volHigh ? pi.donHi8[di] : pi.donHi15[di];
            if (pos.dir === "long" && donLo !== null && bar.c < donLo) exited = true;
            if (pos.dir === "short" && donHi !== null && bar.c > donHi) exited = true;
            if (exited) { closePos(pos, bar.c, dayT, volHigh ? "donch8v" : "donch15", trades); positions.delete(key); continue; }
          } else if (exitMode === "vol-pctile") {
            const pctile = atrPercentile(pi.atr14d, di, 60);
            const volHigh = pctile !== null && pctile > 0.80;
            const donLo = volHigh ? pi.donLo10[di] : pi.donLo15[di];
            const donHi = volHigh ? pi.donHi10[di] : pi.donHi15[di];
            if (pos.dir === "long" && donLo !== null && bar.c < donLo) exited = true;
            if (pos.dir === "short" && donHi !== null && bar.c > donHi) exited = true;
            if (exited) { closePos(pos, bar.c, dayT, volHigh ? "donch10v" : "donch15", trades); positions.delete(key); continue; }
          } else if (exitMode === "chandelier") {
            if (curAtr !== null) {
              const chandLong = pos.highestHigh - 3 * curAtr;
              const chandShort = pos.lowestLow + 3 * curAtr;
              if (pos.dir === "long" && bar.c < chandLong) exited = true;
              if (pos.dir === "short" && bar.c > chandShort) exited = true;
              if (exited) { closePos(pos, bar.c, dayT, "chand", trades); positions.delete(key); continue; }
            }
          } else if (exitMode === "psar") {
            updatePsar(pos, bar);
            if (pos.dir === "long" && bar.c < pos.psar) exited = true;
            if (pos.dir === "short" && bar.c > pos.psar) exited = true;
            if (exited) { closePos(pos, bar.c, dayT, "psar", trades); positions.delete(key); continue; }
          }
        }

        // ── Engine B signal exits ────────────────────────────────────
        if (pos.engine === "B") {
          let exited = false;

          if (exitMode === "baseline") {
            for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
              const h4T = dayT + h4Off;
              const h4i = pi.h4Map.get(h4T);
              if (h4i === undefined || h4i < 2) continue;
              const stNow = pi.st[h4i], stPrev = pi.st[h4i - 1];
              if (stNow === null || stPrev === null) continue;
              if (pos.dir === "long" && stNow === -1 && stPrev === 1) {
                closePos(pos, pi.h4[h4i].c, dayT, "st-flip", trades);
                positions.delete(key); exited = true; break;
              }
              if (pos.dir === "short" && stNow === 1 && stPrev === -1) {
                closePos(pos, pi.h4[h4i].c, dayT, "st-flip", trades);
                positions.delete(key); exited = true; break;
              }
            }
            if (exited) continue;
          } else if (exitMode === "atr-ratio") {
            for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
              const h4T = dayT + h4Off;
              const h4i = pi.h4Map.get(h4T);
              if (h4i === undefined || h4i < 2) continue;
              const stNow = pi.st[h4i], stPrev = pi.st[h4i - 1];
              const h4bar = pi.h4[h4i];
              const curAtr4h = pi.atr14h4[h4i];
              // Normal ST flip
              if (stNow !== null && stPrev !== null && stNow !== stPrev) {
                if ((pos.dir === "long" && stNow === -1) || (pos.dir === "short" && stNow === 1)) {
                  closePos(pos, h4bar.c, dayT, "st-flip", trades);
                  positions.delete(key); exited = true; break;
                }
              }
              // Volatile bar: range > 2x ATR closing against position
              if (curAtr4h !== null && curAtr4h > 0) {
                const barRange = h4bar.h - h4bar.l;
                if (barRange > 2 * curAtr4h) {
                  const against = pos.dir === "long" ? h4bar.c < h4bar.o : h4bar.c > h4bar.o;
                  if (against) {
                    closePos(pos, h4bar.c, dayT, "atr-bar", trades);
                    positions.delete(key); exited = true; break;
                  }
                }
              }
            }
            if (exited) continue;
          } else if (exitMode === "vol-pctile") {
            for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
              const h4T = dayT + h4Off;
              const h4i = pi.h4Map.get(h4T);
              if (h4i === undefined || h4i < 2) continue;
              const stNow = pi.st[h4i], stPrev = pi.st[h4i - 1];
              const h4bar = pi.h4[h4i];
              // Normal ST flip
              if (stNow !== null && stPrev !== null && stNow !== stPrev) {
                if ((pos.dir === "long" && stNow === -1) || (pos.dir === "short" && stNow === 1)) {
                  closePos(pos, h4bar.c, dayT, "st-flip", trades);
                  positions.delete(key); exited = true; break;
                }
              }
              // High vol: exit if losing and vol >80th pctile
              const pctile = atrPercentile(pi.atr14h4, h4i, 60);
              if (pctile !== null && pctile > 0.80 && dayT - pos.et > DAY) {
                const unrealPct = pos.dir === "long"
                  ? (h4bar.c - pos.ep) / pos.ep
                  : (pos.ep - h4bar.c) / pos.ep;
                if (unrealPct < -0.005) {
                  closePos(pos, h4bar.c, dayT, "vpctile", trades);
                  positions.delete(key); exited = true; break;
                }
              }
            }
            if (exited) continue;
          } else if (exitMode === "chandelier") {
            for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
              const h4T = dayT + h4Off;
              const h4i = pi.h4Map.get(h4T);
              if (h4i === undefined || h4i < 2) continue;
              const h4bar = pi.h4[h4i];
              const curAtr4h = pi.atr14h4[h4i];
              // Update HH/LL from 4h bars
              if (h4bar.h > pos.highestHigh) pos.highestHigh = h4bar.h;
              if (h4bar.l < pos.lowestLow) pos.lowestLow = h4bar.l;
              if (curAtr4h !== null) {
                const chandL = pos.highestHigh - 3 * curAtr4h;
                const chandS = pos.lowestLow + 3 * curAtr4h;
                if (pos.dir === "long" && h4bar.c < chandL) {
                  closePos(pos, h4bar.c, dayT, "chand", trades);
                  positions.delete(key); exited = true; break;
                }
                if (pos.dir === "short" && h4bar.c > chandS) {
                  closePos(pos, h4bar.c, dayT, "chand", trades);
                  positions.delete(key); exited = true; break;
                }
              }
            }
            if (exited) continue;
          } else if (exitMode === "psar") {
            // PSAR on daily bar for B engine
            updatePsar(pos, bar);
            if (pos.dir === "long" && bar.c < pos.psar) {
              closePos(pos, bar.c, dayT, "psar", trades);
              positions.delete(key); continue;
            }
            if (pos.dir === "short" && bar.c > pos.psar) {
              closePos(pos, bar.c, dayT, "psar", trades);
              positions.delete(key); continue;
            }
          }
        }
      }

      // ─── ENGINE A ENTRIES: Daily Donchian SMA(30/60) cross ────────
      for (const p of available) {
        if (positions.size >= 10) break;
        const key = `A:${p}`;
        if (positions.has(key)) continue;

        const pi = pairInd.get(p)!;
        const di = getIdx(pi.dailyMap, dayT, DAY);
        if (di < 61) continue;

        // Use i-1 vs i-2 for cross (no look-ahead)
        const s30now = pi.sma30[di - 1], s60now = pi.sma60[di - 1];
        const s30prev = pi.sma30[di - 2], s60prev = pi.sma60[di - 2];
        if (s30now === null || s60now === null || s30prev === null || s60prev === null) continue;

        let dir: Dir | null = null;
        if (s30prev <= s60prev && s30now > s60now && btcBullish(dayT)) dir = "long";
        if (s30prev >= s60prev && s30now < s60now) dir = "short";
        if (!dir) continue;

        const atrVal = pi.atr14d[di - 1];
        if (atrVal === null) continue;
        const bar = pi.daily[di];
        const hs = halfSpread(p);
        const ep = dir === "long" ? bar.o * (1 + hs) : bar.o * (1 - hs);
        let slDist = atrVal * 3;
        if (slDist / ep > MAX_SL_PCT) slDist = ep * MAX_SL_PCT;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(key, {
          pair: p, engine: "A", dir, ep, et: dayT, sl, margin: MARGIN_A,
          atrAtEntry: atrVal, bestPnlAtr: 0,
          highestHigh: bar.h, lowestLow: bar.l,
          psar: dir === "long" ? bar.l : bar.h, psarAf: 0.02,
          psarEp_: dir === "long" ? bar.h : bar.l, peakUnreal: 0,
        });
      }

      // ─── ENGINE B ENTRIES: 4h Supertrend(14, 2) flip ──────────────
      for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
        const h4T = dayT + h4Off;
        for (const p of available) {
          if (positions.size >= 10) break;
          const key = `B:${p}`;
          if (positions.has(key)) continue;

          const pi = pairInd.get(p)!;
          const h4i = pi.h4Map.get(h4T);
          if (h4i === undefined || h4i < 21) continue;

          // ST flip: closed bars i-1 vs i-2
          const stNow = pi.st[h4i - 1];
          const stPrev = pi.st[h4i - 2];
          if (stNow === null || stPrev === null || stNow === stPrev) continue;

          const dir: Dir = stNow === 1 ? "long" : "short";
          if (dir === "long" && !btcBullish(h4T)) continue;

          // Volume filter: flip bar volume > 1.5x 20-bar avg
          const flipBar = pi.h4[h4i - 1];
          let volSum = 0;
          for (let j = h4i - 21; j < h4i - 1; j++) {
            if (j >= 0) volSum += pi.h4[j].v;
          }
          const avgVol = volSum / 20;
          if (avgVol <= 0 || flipBar.v < 1.5 * avgVol) continue;

          const atrVal = pi.atr14h4[h4i - 1];
          if (atrVal === null) continue;
          const h4bar = pi.h4[h4i];
          const hs = halfSpread(p);
          const ep = dir === "long" ? h4bar.o * (1 + hs) : h4bar.o * (1 - hs);
          let slDist = atrVal * 3;
          if (slDist / ep > MAX_SL_PCT) slDist = ep * MAX_SL_PCT;
          const sl = dir === "long" ? ep - slDist : ep + slDist;

          positions.set(key, {
            pair: p, engine: "B", dir, ep, et: h4T, sl, margin: MARGIN_B,
            atrAtEntry: atrVal, bestPnlAtr: 0,
            highestHigh: h4bar.h, lowestLow: h4bar.l,
            psar: dir === "long" ? h4bar.l : h4bar.h, psarAf: 0.02,
            psarEp_: dir === "long" ? h4bar.h : h4bar.l, peakUnreal: 0,
          });
        }
      }
    }

    // Force close remaining at end
    for (const [key, pos] of positions.entries()) {
      const pi = pairInd.get(pos.pair)!;
      const lastBar = pi.daily[pi.daily.length - 1];
      closePos(pos, lastBar.c, lastBar.t, "eob", trades);
    }

    return trades;
  }

  // ─── Stats ────────────────────────────────────────────────────────
  interface StatsResult {
    label: string; trades: number; wr: number; pnl: number; perDay: number;
    dd: number; givebackPct: number; sharpe: number; pf: number;
    engATrades: number; engBTrades: number; aPerDay: number; bPerDay: number;
    reasons: Map<string, { count: number; pnl: number }>;
    avgHoldDays: number;
    // Per-engine giveback
    aGivebackPct: number; bGivebackPct: number;
  }

  function computeStats(trades: Trade[], label: string): StatsResult {
    const days = (FULL_END - FULL_START) / DAY;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const wins = trades.filter(t => t.pnl > 0).length;
    const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
    const perDay = pnl / days;

    let cum = 0, pk = 0, dd = 0;
    const sorted = [...trades].sort((a, b) => a.xt - b.xt);
    for (const t of sorted) { cum += t.pnl; if (cum > pk) pk = cum; if (pk - cum > dd) dd = pk - cum; }

    // Giveback: for winning trades, how much of peak unrealized was given back
    const winTrades = trades.filter(t => t.pnl > 0 && t.peakPnl > 0);
    let totalGb = 0, totalPk = 0;
    for (const t of winTrades) { totalGb += (t.peakPnl - t.pnl); totalPk += t.peakPnl; }
    const givebackPct = totalPk > 0 ? totalGb / totalPk * 100 : 0;

    // Per-engine giveback
    function engineGb(eng: string): number {
      const wt = trades.filter(t => t.engine === eng && t.pnl > 0 && t.peakPnl > 0);
      let gb = 0, pk_ = 0;
      for (const t of wt) { gb += (t.peakPnl - t.pnl); pk_ += t.peakPnl; }
      return pk_ > 0 ? gb / pk_ * 100 : 0;
    }

    const dailyPnl = new Map<number, number>();
    for (const t of sorted) {
      const dk = Math.floor(t.xt / DAY);
      dailyPnl.set(dk, (dailyPnl.get(dk) ?? 0) + t.pnl);
    }
    const dr = [...dailyPnl.values()];
    const avg = dr.length > 0 ? dr.reduce((s, r) => s + r, 0) / dr.length : 0;
    const std = dr.length > 1 ? Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / (dr.length - 1)) : 0;
    const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

    const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : 999;

    const engA = trades.filter(t => t.engine === "A");
    const engB = trades.filter(t => t.engine === "B");
    const aPnl = engA.reduce((s, t) => s + t.pnl, 0);
    const bPnl = engB.reduce((s, t) => s + t.pnl, 0);

    const reasons = new Map<string, { count: number; pnl: number }>();
    for (const t of trades) {
      const r = reasons.get(t.reason) ?? { count: 0, pnl: 0 };
      r.count++; r.pnl += t.pnl; reasons.set(t.reason, r);
    }

    const avgHoldDays = trades.length > 0
      ? trades.reduce((s, t) => s + (t.xt - t.et), 0) / trades.length / DAY
      : 0;

    return {
      label, trades: trades.length, wr, pnl, perDay, dd, givebackPct, sharpe, pf,
      engATrades: engA.length, engBTrades: engB.length,
      aPerDay: aPnl / days, bPerDay: bPnl / days,
      reasons, avgHoldDays,
      aGivebackPct: engineGb("A"), bGivebackPct: engineGb("B"),
    };
  }

  // ─── Run all modes ────────────────────────────────────────────────
  const modes: ExitMode[] = ["baseline", "atr-ratio", "vol-pctile", "chandelier", "psar"];
  const results: StatsResult[] = [];

  for (const mode of modes) {
    process.stdout.write(`Simulating: ${mode}...`);
    const t0 = Date.now();
    const trades = simulate(mode);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const s = computeStats(trades, mode);
    results.push(s);
    console.log(` ${s.trades} trades, ${elapsed}s`);
  }

  // ─── Print Results ────────────────────────────────────────────────
  const days = (FULL_END - FULL_START) / DAY;
  console.log("\n" + "=".repeat(115));
  console.log("VOLATILITY-ADAPTIVE EXIT RESEARCH");
  console.log("=".repeat(115));
  console.log(`Period: ${new Date(FULL_START).toISOString().slice(0,10)} to ${new Date(FULL_END).toISOString().slice(0,10)} (${days.toFixed(0)} days)`);
  console.log(`Pairs: ${available.join(", ")} (${available.length})`);
  console.log(`Engine A: Daily Donchian SMA(30/60) cross, $${MARGIN_A}x${LEV} | Engine B: 4h Supertrend(14,2), $${MARGIN_B}x${LEV}`);
  console.log(`SL: ATR(14)*3 capped 3.5%, ATR trail ladder (BE->2x->1.5x). ATR: SMA-based.`);
  console.log(`Longs: BTC EMA(20)>EMA(50) filter. Shorts: always allowed.`);
  console.log("-".repeat(115));

  console.log("\n--- SUMMARY ---\n");
  const hdr = "Exit Mode".padEnd(15) +
    "Trades".padStart(7) + "WR%".padStart(7) + "PnL".padStart(10) + "$/day".padStart(8) +
    "MaxDD".padStart(8) + "Giveback%".padStart(11) + "Sharpe".padStart(8) + "PF".padStart(6) +
    "HoldD".padStart(7) + " | A$/d".padStart(8) + "B$/d".padStart(7) + "A-Gb%".padStart(7) + "B-Gb%".padStart(7);
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  for (const r of results) {
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
    console.log(
      r.label.padEnd(15) +
      String(r.trades).padStart(7) +
      r.wr.toFixed(1).padStart(7) +
      pnlStr.padStart(10) +
      `$${r.perDay.toFixed(2)}`.padStart(8) +
      `$${r.dd.toFixed(0)}`.padStart(8) +
      `${r.givebackPct.toFixed(1)}%`.padStart(11) +
      r.sharpe.toFixed(2).padStart(8) +
      r.pf.toFixed(2).padStart(6) +
      r.avgHoldDays.toFixed(1).padStart(7) +
      ` | $${r.aPerDay.toFixed(2)}`.padStart(8) +
      `$${r.bPerDay.toFixed(2)}`.padStart(7) +
      `${r.aGivebackPct.toFixed(0)}%`.padStart(7) +
      `${r.bGivebackPct.toFixed(0)}%`.padStart(7)
    );
  }

  // ─── Deltas vs baseline ───────────────────────────────────────────
  const base = results[0];
  console.log("\n--- DELTA VS BASELINE ---\n");
  console.log(
    "Exit Mode".padEnd(15) + "$/day".padStart(10) + "MaxDD".padStart(10) +
    "Giveback".padStart(12) + "Sharpe".padStart(10) + "PF".padStart(8) + "WR".padStart(8)
  );
  console.log("-".repeat(73));
  for (const r of results.slice(1)) {
    const fmt = (v: number, prefix = "$") => {
      const s = prefix === "$" ? `${prefix}${Math.abs(v).toFixed(2)}` : `${Math.abs(v).toFixed(1)}${prefix}`;
      return v >= 0 ? `+${s}` : `-${s}`;
    };
    console.log(
      r.label.padEnd(15) +
      fmt(r.perDay - base.perDay).padStart(10) +
      fmt(r.dd - base.dd).padStart(10) +
      `${(r.givebackPct - base.givebackPct) >= 0 ? "+" : ""}${(r.givebackPct - base.givebackPct).toFixed(1)}pp`.padStart(12) +
      `${(r.sharpe - base.sharpe) >= 0 ? "+" : ""}${(r.sharpe - base.sharpe).toFixed(2)}`.padStart(10) +
      `${(r.pf - base.pf) >= 0 ? "+" : ""}${(r.pf - base.pf).toFixed(2)}`.padStart(8) +
      `${(r.wr - base.wr) >= 0 ? "+" : ""}${(r.wr - base.wr).toFixed(1)}pp`.padStart(8)
    );
  }

  // ─── Exit reason breakdown ────────────────────────────────────────
  console.log("\n--- EXIT REASON BREAKDOWN ---\n");
  for (const r of results) {
    console.log(`[${r.label}]`);
    const sorted = [...r.reasons.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [reason, data] of sorted) {
      const pStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(0)}` : `-$${Math.abs(data.pnl).toFixed(0)}`;
      const avgPnl = data.count > 0 ? data.pnl / data.count : 0;
      console.log(`  ${reason.padEnd(12)} ${String(data.count).padStart(5)} trades  ${pStr.padStart(8)}  avg ${avgPnl >= 0 ? "+" : ""}$${avgPnl.toFixed(1)}`);
    }
    console.log();
  }

  // ─── Validated period analysis (Jun 2025 - Mar 2026) ──────────────
  const VAL_START = new Date("2025-06-01").getTime();
  const VAL_MID = new Date("2025-11-01").getTime();
  const VAL_END = FULL_END;

  console.log("=".repeat(115));
  console.log("VALIDATED PERIOD: Jun 2025 - Mar 2026 (train/test split at Nov 2025)");
  console.log("=".repeat(115));

  function subStats(allTrades: Trade[], start: number, end: number, label: string) {
    const sub = allTrades.filter(t => t.et >= start && t.et < end);
    const periodDays = (end - start) / DAY;
    const pnl = sub.reduce((s, t) => s + t.pnl, 0);
    const wins = sub.filter(t => t.pnl > 0).length;
    const wr = sub.length > 0 ? wins / sub.length * 100 : 0;
    let cum = 0, pk = 0, dd = 0;
    const sorted = [...sub].sort((a, b) => a.xt - b.xt);
    for (const t of sorted) { cum += t.pnl; if (cum > pk) pk = cum; if (pk - cum > dd) dd = pk - cum; }
    const wt = sub.filter(t => t.pnl > 0 && t.peakPnl > 0);
    let gb = 0, pkTot = 0;
    for (const t of wt) { gb += (t.peakPnl - t.pnl); pkTot += t.peakPnl; }
    const givebackPct = pkTot > 0 ? gb / pkTot * 100 : 0;
    return { label, n: sub.length, wr, pnl, perDay: pnl / periodDays, dd, givebackPct };
  }

  // Re-run on full period and extract sub-periods
  console.log("\n--- TRAIN (Jun-Oct 2025) / TEST (Nov 2025 - Mar 2026) ---\n");
  const tHdr = "Exit Mode".padEnd(15) +
    "  Train N".padStart(8) + " $/day".padStart(7) + " MaxDD".padStart(7) + " Gb%".padStart(6) +
    " | Test N".padStart(9) + " $/day".padStart(7) + " MaxDD".padStart(7) + " Gb%".padStart(6) +
    " | Decay%".padStart(9);
  console.log(tHdr);
  console.log("-".repeat(tHdr.length));

  for (const mode of modes) {
    const trades = simulate(mode);
    const train = subStats(trades, VAL_START, VAL_MID, `${mode}-train`);
    const test = subStats(trades, VAL_MID, VAL_END, `${mode}-test`);
    const decay = train.perDay !== 0 ? ((test.perDay / train.perDay - 1) * 100) : 0;

    console.log(
      mode.padEnd(15) +
      String(train.n).padStart(8) +
      `$${train.perDay.toFixed(2)}`.padStart(7) +
      `$${train.dd.toFixed(0)}`.padStart(7) +
      `${train.givebackPct.toFixed(0)}%`.padStart(6) +
      ` | ${String(test.n).padStart(5)}` +
      `$${test.perDay.toFixed(2)}`.padStart(7) +
      `$${test.dd.toFixed(0)}`.padStart(7) +
      `${test.givebackPct.toFixed(0)}%`.padStart(6) +
      ` | ${decay >= 0 ? "+" : ""}${decay.toFixed(0)}%`.padStart(9)
    );
  }

  // ─── Giveback distribution analysis ───────────────────────────────
  console.log("\n--- GIVEBACK DISTRIBUTION (winning trades only) ---\n");
  for (const mode of modes) {
    const trades = simulate(mode);
    const winners = trades.filter(t => t.pnl > 0 && t.peakPnl > 0);
    if (winners.length === 0) { console.log(`${mode}: no winners`); continue; }

    const givebacks = winners.map(t => (t.peakPnl - t.pnl) / t.peakPnl * 100);
    givebacks.sort((a, b) => a - b);
    const p25 = givebacks[Math.floor(givebacks.length * 0.25)];
    const p50 = givebacks[Math.floor(givebacks.length * 0.50)];
    const p75 = givebacks[Math.floor(givebacks.length * 0.75)];
    const avg = givebacks.reduce((s, v) => s + v, 0) / givebacks.length;

    // How many winners gave back <30%, 30-50%, 50-70%, >70%
    const lt30 = givebacks.filter(g => g < 30).length;
    const b3050 = givebacks.filter(g => g >= 30 && g < 50).length;
    const b5070 = givebacks.filter(g => g >= 50 && g < 70).length;
    const gt70 = givebacks.filter(g => g >= 70).length;

    console.log(`${mode.padEnd(15)} n=${String(winners.length).padStart(4)}  avg=${avg.toFixed(0)}%  p25=${p25.toFixed(0)}%  p50=${p50.toFixed(0)}%  p75=${p75.toFixed(0)}%  | <30%:${lt30}  30-50%:${b3050}  50-70%:${b5070}  >70%:${gt70}`);
  }

  // ─── Top winning trade comparison ─────────────────────────────────
  console.log("\n--- TOP 10 WINNERS: PSAR vs BASELINE captured PnL ---\n");
  const baseAll = simulate("baseline");
  const psarAll = simulate("psar");

  const baseWinners = baseAll.filter(t => t.pnl > 0).sort((a, b) => b.peakPnl - a.peakPnl).slice(0, 15);
  console.log("Baseline top winners by peak unrealized:");
  console.log("  Pair       Engine Dir   Peak$   Actual$   Giveback%  Hold(d)  Exit");
  for (const t of baseWinners) {
    const gb = t.peakPnl > 0 ? (t.peakPnl - t.pnl) / t.peakPnl * 100 : 0;
    const hold = (t.xt - t.et) / DAY;
    console.log(`  ${t.pair.padEnd(10)} ${t.engine}     ${t.dir.padEnd(6)} $${t.peakPnl.toFixed(1).padStart(6)} $${t.pnl.toFixed(1).padStart(7)}   ${gb.toFixed(0).padStart(4)}%     ${hold.toFixed(1).padStart(5)}  ${t.reason}`);
  }

  const psarWinners = psarAll.filter(t => t.pnl > 0).sort((a, b) => b.peakPnl - a.peakPnl).slice(0, 15);
  console.log("\nPSAR top winners by peak unrealized:");
  console.log("  Pair       Engine Dir   Peak$   Actual$   Giveback%  Hold(d)  Exit");
  for (const t of psarWinners) {
    const gb = t.peakPnl > 0 ? (t.peakPnl - t.pnl) / t.peakPnl * 100 : 0;
    const hold = (t.xt - t.et) / DAY;
    console.log(`  ${t.pair.padEnd(10)} ${t.engine}     ${t.dir.padEnd(6)} $${t.peakPnl.toFixed(1).padStart(6)} $${t.pnl.toFixed(1).padStart(7)}   ${gb.toFixed(0).padStart(4)}%     ${hold.toFixed(1).padStart(5)}  ${t.reason}`);
  }

  // ─── Capture ratio: how much of theoretical peak was captured ─────
  console.log("\n--- CAPTURE RATIO (actual PnL / peak unrealized) ---\n");
  for (const mode of modes) {
    const trades = simulate(mode);
    const winners = trades.filter(t => t.pnl > 0 && t.peakPnl > 0);
    const totalActual = winners.reduce((s, t) => s + t.pnl, 0);
    const totalPeak = winners.reduce((s, t) => s + t.peakPnl, 0);
    const captureRatio = totalPeak > 0 ? totalActual / totalPeak * 100 : 0;
    console.log(`${mode.padEnd(15)} captured ${captureRatio.toFixed(1)}% of peak unrealized ($${totalActual.toFixed(0)} / $${totalPeak.toFixed(0)})`);
  }
}

main();
