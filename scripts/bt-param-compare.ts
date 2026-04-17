/**
 * A/B Parameter Comparison: Current Live vs Proposed
 *
 * Config A (CURRENT LIVE): SMA(20/50), ST(14,1.75), $7 size, max 20, no trailing
 * Config B (PROPOSED):     SMA(30/60), ST(14,2),    $5 size, max 10, no trailing
 * Config C (PROPOSED+TRAIL): SMA(30/60), ST(14,2),  $5 size, max 10, ATR trail 3x->2x->1.5x
 *
 * Run: npx tsx scripts/bt-param-compare.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; engine: string;
}
interface Position {
  pair: string; dir: "long" | "short"; ep: number; et: number;
  sl: number; engine: string; atrAtEntry: number;
}

// ─── Constants ──────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// Calibrated half-spreads DOUBLED
const SP: Record<string, number> = {
  XRP: 2.1e-4, DOGE: 2.7e-4, ARB: 5.2e-4, ENA: 5.1e-4,
  UNI: 5.5e-4, APT: 6.4e-4, LINK: 6.9e-4, TRUMP: 7.3e-4,
  WLD: 8e-4, DOT: 9.9e-4, ADA: 11.1e-4, LDO: 11.6e-4, OP: 12.4e-4,
  BTC: 1.0e-4, SOL: 4.0e-4,
};

const PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "SOL",
];

// ─── Config definitions ─────────────────────────────────────────────
interface Config {
  label: string;
  smaFast: number;
  smaSlow: number;
  stMult: number;
  size: number;
  maxPos: number;
  atrTrail: boolean; // 3x->2x->1.5x trailing
}

const CONFIGS: Config[] = [
  { label: "A: CURRENT LIVE (SMA20/50, ST1.75, $7, max20)", smaFast: 20, smaSlow: 50, stMult: 1.75, size: 7, maxPos: 20, atrTrail: false },
  { label: "B: PROPOSED (SMA30/60, ST2, $5, max10)",        smaFast: 30, smaSlow: 60, stMult: 2,    size: 5, maxPos: 10, atrTrail: false },
  { label: "C: PROPOSED+TRAIL (SMA30/60, ST2, $5, max10)",  smaFast: 30, smaSlow: 60, stMult: 2,    size: 5, maxPos: 10, atrTrail: true },
];

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CD, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars5m: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(bucket);
    if (!arr) { arr = []; groups.set(bucket, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts, o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  result.sort((a, b) => a.t - b.t);
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++)
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
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
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
}

function computeZScores(candles: C[], momLb: number, volWin: number): number[] {
  const z = new Array(candles.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < candles.length; i++) {
    const mom = candles[i].c / candles[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin + 1); j <= i; j++) {
      const r = candles[j].c / candles[j - 1].c - 1;
      sumSq += r * r;
      count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

function donchCloseHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c);
  return mx;
}
function donchCloseLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c);
  return mn;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      if (lowerBand > lb[i - 1] || cs[i - 1].c < lb[i - 1]) { /* keep */ } else lowerBand = lb[i - 1];
      if (upperBand < ub[i - 1] || cs[i - 1].c > ub[i - 1]) { /* keep */ } else upperBand = ub[i - 1];
    }

    ub[i] = upperBand;
    lb[i] = lowerBand;

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i - 1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }

    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
}

// ─── Cost model ─────────────────────────────────────────────────────
function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }

function entryPriceCalc(pair: string, dir: "long" | "short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function exitPriceCalc(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long" | "short", ep: number, xp: number, notional: number): number {
  const raw = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return raw - notional * FEE * 2;
}

// ─── Load all data ──────────────────────────────────────────────────
console.log("Loading 5m candle data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = load5m(p);
  if (d.length > 0) { raw5m.set(p, d); console.log(`  ${p}: ${d.length} bars`); }
  else console.log(`  ${p}: MISSING`);
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

console.log("Aggregated: daily/4h/1h candles ready.");

// BTC filters
const btcDaily = dailyData.get("BTC")!;
const btcDailyCloses = btcDaily.map(c => c.c);
const btcDailyEma20 = calcEMA(btcDailyCloses, 20);
const btcDailyEma50 = calcEMA(btcDailyCloses, 50);

const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));

function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t <= t) { idx = i; break; }
  }
  if (idx < 0) return false;
  const offset = btcDaily.length - btcDailyEma20.length;
  const i20 = idx - offset;
  const i50 = idx - (btcDaily.length - btcDailyEma50.length);
  if (i20 < 0 || i50 < 0 || i20 >= btcDailyEma20.length || i50 >= btcDailyEma50.length) return false;
  return btcDailyEma20[i20] > btcDailyEma50[i50];
}

function btcH1Trend(t: number): "long" | "short" | null {
  const bucket = Math.floor(t / H) * H;
  let idx = btcH1TsMap.get(bucket);
  if (idx === undefined) {
    for (let i = btcH1.length - 1; i >= 0; i--) {
      if (btcH1[i].t <= t) { idx = i; break; }
    }
  }
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  const off9 = btcH1.length - btcH1Ema9.length;
  const off21 = btcH1.length - btcH1Ema21.length;
  const i9 = prev - off9;
  const i21 = prev - off21;
  if (i9 < 0 || i21 < 0 || i9 >= btcH1Ema9.length || i21 >= btcH1Ema21.length) return null;
  if (btcH1Ema9[i9] > btcH1Ema21[i21]) return "long";
  if (btcH1Ema9[i9] < btcH1Ema21[i21]) return "short";
  return null;
}

// ─── Engine A: Daily Donchian Trend (parameterized) ─────────────────
function engineA(cfg: Config, startTs: number, endTs: number, useTrail: boolean): Trade[] {
  const trades: Trade[] = [];
  const EXIT_LB = 15;
  const ATR_MULT = 3, ATR_PER = 14, MAX_HOLD = 60;
  const NOT = cfg.size * 10; // 10x leverage

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < cfg.smaSlow + ATR_PER + 5) continue;

    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, cfg.smaFast);
    const slow = calcSMA(closes, cfg.smaSlow);
    const atr = calcATR(cs, ATR_PER);
    const warmup = cfg.smaSlow + 1;

    let pos: Position | null = null;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      // EXITS first
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / D);

        // ATR trailing stop update (before SL check)
        if (useTrail && pos.atrAtEntry > 0) {
          const profitDist = pos.dir === "long"
            ? bar.c - pos.ep  // use close for daily bars
            : pos.ep - bar.c;

          if (profitDist > 0) {
            let trailMult = 3;
            if (profitDist > 2 * pos.atrAtEntry) trailMult = 1.5;
            else if (profitDist > 1 * pos.atrAtEntry) trailMult = 2;

            const trailStop = pos.dir === "long"
              ? bar.c - trailMult * pos.atrAtEntry
              : bar.c + trailMult * pos.atrAtEntry;

            // Only tighten, never loosen
            if (pos.dir === "long" && trailStop > pos.sl) {
              pos.sl = Math.max(trailStop, pos.ep * (1 - 0.035));
            } else if (pos.dir === "short" && (pos.sl === 0 || trailStop < pos.sl)) {
              pos.sl = Math.min(trailStop, pos.ep * (1 + 0.035));
            }
          }
        }

        let xp = 0, reason = "", isSL = false;

        // SL check
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

        // Donchian channel exit (on closes)
        if (!xp && i >= EXIT_LB + 1) {
          if (pos.dir === "long") {
            const chanLow = donchCloseLow(cs, i, EXIT_LB);
            if (bar.c < chanLow) { xp = bar.c; reason = "ch"; }
          } else {
            const chanHigh = donchCloseHigh(cs, i, EXIT_LB);
            if (bar.c > chanHigh) { xp = bar.c; reason = "ch"; }
          }
        }

        // Max hold
        if (!xp && holdDays >= MAX_HOLD) { xp = bar.c; reason = "mh"; }

        if (xp > 0) {
          const xpAdj = exitPriceCalc(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj, NOT);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, reason, engine: "A" });
          }
          pos = null;
        }
      }

      // ENTRIES
      if (!pos && bar.t >= startTs && bar.t < endTs) {
        const prev = i - 1;
        const prevFast = fast[prev];
        const prevSlow = slow[prev];
        const curFast = fast[i];
        const curSlow = slow[i];
        if (prevFast === 0 || prevSlow === 0 || curFast === 0 || curSlow === 0) continue;

        let dir: "long" | "short" | null = null;
        if (prevFast <= prevSlow && curFast > curSlow) dir = "long";
        else if (prevFast >= prevSlow && curFast < curSlow) dir = "short";
        if (!dir) continue;

        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPriceCalc(pair, dir, bar.o);
        let sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;
        if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir, ep, et: bar.t, sl, engine: "A", atrAtEntry: prevATR };
      }
    }
  }
  return trades;
}

// ─── Engine B: 4h Supertrend (parameterized) ─────────────────────────
function engineB(cfg: Config, startTs: number, endTs: number, useTrail: boolean): Trade[] {
  const trades: Trade[] = [];
  const ST_PER = 14;
  const ATR_MULT = 3, MAX_HOLD_H = 60 * 24;
  const NOT = cfg.size * 10;

  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < ST_PER + 30) continue;

    const { dir: stDir } = calcSupertrend(cs, ST_PER, cfg.stMult);
    const atr = calcATR(cs, ST_PER);

    let pos: Position | null = null;

    for (let i = ST_PER + 2; i < cs.length; i++) {
      const bar = cs[i];
      const prevDir = stDir[i - 1];
      const prevPrevDir = stDir[i - 2];
      const flip = prevDir !== prevPrevDir;

      // EXITS
      if (pos) {
        // ATR trailing stop update
        if (useTrail && pos.atrAtEntry > 0) {
          const profitDist = pos.dir === "long"
            ? bar.o - pos.ep  // use open for intrabar check
            : pos.ep - bar.o;

          if (profitDist > 0) {
            let trailMult = 3;
            if (profitDist > 2 * pos.atrAtEntry) trailMult = 1.5;
            else if (profitDist > 1 * pos.atrAtEntry) trailMult = 2;

            const trailStop = pos.dir === "long"
              ? bar.o - trailMult * pos.atrAtEntry
              : bar.o + trailMult * pos.atrAtEntry;

            if (pos.dir === "long" && trailStop > pos.sl) {
              pos.sl = Math.max(trailStop, pos.ep * (1 - 0.035));
            } else if (pos.dir === "short" && (pos.sl === 0 || trailStop < pos.sl)) {
              pos.sl = Math.min(trailStop, pos.ep * (1 + 0.035));
            }
          }
        }

        let xp = 0, reason = "", isSL = false;

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

        if (!xp && flip) { xp = bar.o; reason = "flip"; }

        if (!xp) {
          const hoursHeld = (bar.t - pos.et) / H;
          if (hoursHeld >= MAX_HOLD_H) { xp = bar.c; reason = "mh"; }
        }

        if (xp > 0) {
          const xpAdj = exitPriceCalc(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj, NOT);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, reason, engine: "B" });
          }
          pos = null;
        }
      }

      if (!pos && flip && bar.t >= startTs && bar.t < endTs) {
        const dir: "long" | "short" = prevDir === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPriceCalc(pair, dir, bar.o);
        let sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;
        if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir, ep, et: bar.t, sl, engine: "B", atrAtEntry: prevATR };
      }
    }
  }
  return trades;
}

// ─── Engine C: GARCH v2 (same across all configs, $3 size) ──────────
function engineC(startTs: number, endTs: number): Trade[] {
  const trades: Trade[] = [];
  const MOM_LB = 3, VOL_WIN = 20;
  const Z_LONG_1H = 4.5, Z_SHORT_1H = -3.0;
  const Z_LONG_4H = 3.0, Z_SHORT_4H = -3.0;
  const EMA_FAST = 9, EMA_SLOW = 21;
  const SL_PCT = 0.04;
  const MAX_HOLD_HOURS = 168;
  const GARCH_SIZE = 3;
  const NOT = GARCH_SIZE * 10;

  for (const pair of PAIRS) {
    const h1 = h1Data.get(pair);
    const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;

    const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
    const z4h = computeZScores(h4, MOM_LB, VOL_WIN);

    const h1Closes = h1.map(c => c.c);
    const ema9_1h = calcEMA(h1Closes, EMA_FAST);
    const ema21_1h = calcEMA(h1Closes, EMA_SLOW);

    const h4TsMap = new Map<number, number>();
    h4.forEach((c, i) => h4TsMap.set(c.t, i));

    let pos: Position | null = null;

    for (let i = Math.max(VOL_WIN + MOM_LB + 2, EMA_SLOW + 1); i < h1.length; i++) {
      const bar = h1[i];

      if (pos) {
        let xp = 0, reason = "", isSL = false;

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

        if (!xp) {
          const hoursHeld = (bar.t - pos.et) / H;
          if (hoursHeld >= MAX_HOLD_HOURS) { xp = bar.c; reason = "mh"; }
        }

        if (xp > 0) {
          const xpAdj = exitPriceCalc(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj, NOT);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, reason, engine: "C" });
          }
          pos = null;
        }
      }

      if (!pos && bar.t >= startTs && bar.t < endTs) {
        const prev = i - 1;
        if (prev < VOL_WIN + MOM_LB) continue;

        const z1 = z1h[prev];
        if (isNaN(z1) || z1 === 0) continue;

        const goLong = z1 > Z_LONG_1H;
        const goShort = z1 < Z_SHORT_1H;
        if (!goLong && !goShort) continue;

        const ts4h = Math.floor(h1[prev].t / H4) * H4;
        const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) continue;
        const z4 = z4h[idx4h];
        if (goLong && z4 <= Z_LONG_4H) continue;
        if (goShort && z4 >= Z_SHORT_4H) continue;

        const off9 = h1.length - ema9_1h.length;
        const off21 = h1.length - ema21_1h.length;
        const i9 = prev - off9;
        const i21 = prev - off21;
        if (i9 < 0 || i21 < 0 || i9 >= ema9_1h.length || i21 >= ema21_1h.length) continue;
        if (goLong && ema9_1h[i9] <= ema21_1h[i21]) continue;
        if (goShort && ema9_1h[i9] >= ema21_1h[i21]) continue;

        const btcTrend = btcH1Trend(h1[prev].t);
        if (goLong && btcTrend !== "long") continue;
        if (goShort && btcTrend !== "short") continue;

        const dir: "long" | "short" = goLong ? "long" : "short";
        const ep = entryPriceCalc(pair, dir, bar.o);
        let sl = dir === "long" ? ep * (1 - SL_PCT) : ep * (1 + SL_PCT);
        if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir, ep, et: bar.t, sl, engine: "C", atrAtEntry: 0 };
      }
    }
  }
  return trades;
}

// ─── Ensemble simulation with shared position pool ──────────────────
function simulateEnsemble(
  cfg: Config, startTs: number, endTs: number,
): { trades: Trade[]; blockedSignals: number } {
  const allA = engineA(cfg, startTs, endTs, cfg.atrTrail);
  const allB = engineB(cfg, startTs, endTs, cfg.atrTrail);
  const allC = engineC(startTs, endTs); // GARCH always same

  interface Event {
    t: number;
    type: "entry" | "exit";
    trade: Trade;
    engine: string;
    pair: string;
  }

  const events: Event[] = [];
  for (const tr of [...allA, ...allB, ...allC]) {
    events.push({ t: tr.et, type: "entry", trade: tr, engine: tr.engine, pair: tr.pair });
    events.push({ t: tr.xt, type: "exit", trade: tr, engine: tr.engine, pair: tr.pair });
  }
  events.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));

  const openPositions = new Map<string, Trade>();
  const accepted: Trade[] = [];
  let blockedSignals = 0;

  for (const evt of events) {
    const key = `${evt.engine}:${evt.pair}`;

    if (evt.type === "exit") {
      if (openPositions.has(key)) {
        openPositions.delete(key);
      }
    } else {
      if (openPositions.has(key)) continue;
      if (openPositions.size >= cfg.maxPos) {
        blockedSignals++;
        continue;
      }
      openPositions.set(key, evt.trade);
      accepted.push(evt.trade);
    }
  }

  return { trades: accepted, blockedSignals };
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number; avgTrade: number;
}

function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, avgTrade: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const std = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = Math.max((endTs - startTs) / D, 1);

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: total / days,
    avgTrade: total / trades.length,
  };
}

function fmtPnl(v: number): string { return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }

// ─── RUN COMPARISON ─────────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("PARAMETER COMPARISON: CURRENT LIVE vs PROPOSED");
console.log("Period: 2023-01 to 2026-03 | Doubled spreads, 0.035% fee, 1.5x SL slippage");
console.log("GARCH v2 is IDENTICAL across all configs ($3 size, no trailing)");
console.log("=".repeat(110));

// Run all configs
for (const cfg of CONFIGS) {
  console.log(`\nRunning: ${cfg.label}...`);

  const full = simulateEnsemble(cfg, FULL_START, FULL_END);
  const oos  = simulateEnsemble(cfg, OOS_START, FULL_END);
  const fullM = calcMetrics(full.trades, FULL_START, FULL_END);
  const oosM  = calcMetrics(oos.trades, OOS_START, FULL_END);

  // Per-engine breakdown
  const fullA = calcMetrics(full.trades.filter(t => t.engine === "A"), FULL_START, FULL_END);
  const fullB = calcMetrics(full.trades.filter(t => t.engine === "B"), FULL_START, FULL_END);
  const fullC = calcMetrics(full.trades.filter(t => t.engine === "C"), FULL_START, FULL_END);

  const oosA = calcMetrics(oos.trades.filter(t => t.engine === "A"), OOS_START, FULL_END);
  const oosB = calcMetrics(oos.trades.filter(t => t.engine === "B"), OOS_START, FULL_END);
  const oosC = calcMetrics(oos.trades.filter(t => t.engine === "C"), OOS_START, FULL_END);

  console.log(`\n${"─".repeat(110)}`);
  console.log(`${cfg.label}`);
  console.log(`${"─".repeat(110)}`);

  console.log(`\n${"".padEnd(28)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"Total".padStart(12)} ${"$/day".padStart(10)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"MaxDD".padStart(10)} ${"AvgTrade".padStart(10)}`);
  console.log("-".repeat(110));

  const fmtRow = (label: string, m: Metrics) =>
    `${label.padEnd(28)} ${String(m.n).padStart(7)} ${m.wr.toFixed(1).padStart(6)}% ${fmtPnl(m.total).padStart(12)} ${fmtPnl(m.perDay).padStart(10)} ${m.pf.toFixed(2).padStart(7)} ${m.sharpe.toFixed(2).padStart(8)} ${"$" + m.dd.toFixed(2).padStart(9)} ${fmtPnl(m.avgTrade).padStart(10)}`;

  console.log(fmtRow("FULL PERIOD ENSEMBLE", fullM));
  console.log(fmtRow("  Engine A (Donchian)", fullA));
  console.log(fmtRow("  Engine B (Supertrend)", fullB));
  console.log(fmtRow("  Engine C (GARCH v2)", fullC));
  console.log("");
  console.log(fmtRow("OOS (2025-09+) ENSEMBLE", oosM));
  console.log(fmtRow("  Engine A OOS", oosA));
  console.log(fmtRow("  Engine B OOS", oosB));
  console.log(fmtRow("  Engine C OOS", oosC));
  console.log(`\nBlocked signals: ${full.blockedSignals} (full) / ${oos.blockedSignals} (OOS)`);

  // Exit reason breakdown
  const reasons = new Map<string, number>();
  for (const t of full.trades) {
    reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
  }
  console.log(`Exit reasons: ${[...reasons.entries()].map(([r, n]) => `${r}=${n}`).join(", ")}`);

  // Monthly P&L
  const monthlyPnl = new Map<string, number>();
  for (const t of full.trades) {
    const d = new Date(t.xt);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    monthlyPnl.set(key, (monthlyPnl.get(key) ?? 0) + t.pnl);
  }
  const sortedMonths = [...monthlyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const losingMonths = sortedMonths.filter(([_, pnl]) => pnl < 0).length;
  console.log(`Losing months: ${losingMonths}/${sortedMonths.length}`);
}

// ─── SIDE-BY-SIDE SUMMARY TABLE ──────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("SIDE-BY-SIDE COMPARISON SUMMARY");
console.log("=".repeat(110));

const results: { label: string; full: Metrics; oos: Metrics; blocked: number }[] = [];
for (const cfg of CONFIGS) {
  const full = simulateEnsemble(cfg, FULL_START, FULL_END);
  const oos  = simulateEnsemble(cfg, OOS_START, FULL_END);
  results.push({
    label: cfg.label.split(":")[0] + ":",
    full: calcMetrics(full.trades, FULL_START, FULL_END),
    oos: calcMetrics(oos.trades, OOS_START, FULL_END),
    blocked: full.blockedSignals,
  });
}

console.log(`\n${"Metric".padEnd(24)} ${results.map(r => r.label.padStart(28)).join(" ")}`);
console.log("-".repeat(24 + results.length * 29));

const rows: [string, (m: Metrics) => string][] = [
  ["Trades (full)", m => String(m.n)],
  ["Win Rate (full)", m => m.wr.toFixed(1) + "%"],
  ["Total PnL (full)", m => fmtPnl(m.total)],
  ["$/day (full)", m => fmtPnl(m.perDay)],
  ["Profit Factor (full)", m => m.pf.toFixed(2)],
  ["Sharpe (full)", m => m.sharpe.toFixed(2)],
  ["Max DD (full)", m => "$" + m.dd.toFixed(2)],
  ["Avg Trade (full)", m => fmtPnl(m.avgTrade)],
  ["--- OOS ---", _ => "---"],
  ["Trades (OOS)", m => String(m.n)],
  ["Win Rate (OOS)", m => m.wr.toFixed(1) + "%"],
  ["Total PnL (OOS)", m => fmtPnl(m.total)],
  ["$/day (OOS)", m => fmtPnl(m.perDay)],
  ["Profit Factor (OOS)", m => m.pf.toFixed(2)],
  ["Sharpe (OOS)", m => m.sharpe.toFixed(2)],
  ["Max DD (OOS)", m => "$" + m.dd.toFixed(2)],
];

for (const [label, fn] of rows) {
  if (label === "--- OOS ---") {
    console.log("-".repeat(24 + results.length * 29));
    continue;
  }
  const isOOS = label.includes("OOS");
  const vals = results.map(r => fn(isOOS ? r.oos : r.full).padStart(28));
  console.log(`${label.padEnd(24)} ${vals.join(" ")}`);
}

console.log("-".repeat(24 + results.length * 29));
console.log(`${"Blocked Signals".padEnd(24)} ${results.map(r => String(r.blocked).padStart(28)).join(" ")}`);

console.log("\nDone. Compare the numbers above to decide which config to deploy.");
