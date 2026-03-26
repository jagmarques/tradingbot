/**
 * DEFINITIVE 3-Engine Ensemble Validation
 *
 * Engine A: Daily Donchian Trend (SMA 30/60 cross, 15-day close channel exit)
 * Engine B: 4h Supertrend(14,2) flip entry/exit
 * Engine C: GARCH v2 Multi-TF (1h+4h z-score)
 *
 * Shared position pool: max 10 concurrent across all engines.
 * Conservative cost model: doubled spreads, 0.035% taker, 1.5x SL slippage.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-final-ensemble-validate.ts
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
  sl: number; engine: string;
}

// ─── Constants ──────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35; // 0.035% taker per side
const SIZE = 5;        // $5 margin per engine
const LEV = 10;
const NOT = SIZE * LEV; // $50 notional per trade
const SL_SLIP = 1.5;
const MAX_POS = 10;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// Calibrated half-spreads DOUBLED for conservative model
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

// Donchian on CLOSES (not highs/lows)
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

// Supertrend
function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1); // 1=bullish, -1=bearish
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      // Lower band only rises
      if (lowerBand > lb[i - 1] || cs[i - 1].c < lb[i - 1]) { /* keep */ } else lowerBand = lb[i - 1];
      // Upper band only falls
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

function entryPrice(pair: string, dir: "long" | "short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function exitPrice(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long" | "short", ep: number, xp: number): number {
  const raw = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return raw - NOT * FEE * 2;
}

// ─── Load all data ──────────────────────────────────────────────────
console.log("Loading 5m candle data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = load5m(p);
  if (d.length > 0) { raw5m.set(p, d); console.log(`  ${p}: ${d.length} bars`); }
  else console.log(`  ${p}: MISSING`);
}

// Aggregated data
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
const btcDailyTsMap = new Map<number, number>();
btcDaily.forEach((c, i) => btcDailyTsMap.set(c.t, i));

const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));

function btcDailyBullish(t: number): boolean {
  // Find last daily bar at or before t
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
  // Find nearest 1h bar at or before t
  const bucket = Math.floor(t / H) * H;
  let idx = btcH1TsMap.get(bucket);
  if (idx === undefined) {
    // Search backward
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

// ─── Engine A: Daily Donchian Trend ─────────────────────────────────
// SMA(30) cross SMA(60), BTC EMA(20)>EMA(50) for longs
// Exit: close < 15-day Donchian low (closes), ATR*3 SL capped 3.5%, max hold 60d
function engineA(startTs: number, endTs: number): Trade[] {
  const trades: Trade[] = [];
  const SMA_FAST = 30, SMA_SLOW = 60, EXIT_LB = 15;
  const ATR_MULT = 3, ATR_PER = 14, MAX_HOLD = 60;

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < SMA_SLOW + ATR_PER + 5) continue;

    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, SMA_FAST);
    const slow = calcSMA(closes, SMA_SLOW);
    const atr = calcATR(cs, ATR_PER);
    const warmup = SMA_SLOW + 1;

    let pos: Position | null = null;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      // EXITS first
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / D);
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
        if (!xp && holdDays >= MAX_HOLD) {
          xp = bar.c; reason = "mh";
        }

        if (xp > 0) {
          const xpAdj = exitPrice(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj);
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
        // Golden cross
        if (prevFast <= prevSlow && curFast > curSlow) dir = "long";
        // Death cross
        else if (prevFast >= prevSlow && curFast < curSlow) dir = "short";
        if (!dir) continue;

        // BTC filter: longs only when BTC EMA(20) > EMA(50) daily
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        // Shorts: no BTC filter

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPrice(pair, dir, bar.o);
        let sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;
        // Cap SL at 3.5%
        if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir, ep, et: bar.t, sl, engine: "A" };
      }
    }
  }
  return trades;
}

// ─── Engine B: 4h Supertrend ────────────────────────────────────────
// Supertrend(14,2) flip entry/exit, BTC EMA(20)>EMA(50) daily for longs
// ATR*3 SL capped 3.5%, max hold 60d
function engineB(startTs: number, endTs: number): Trade[] {
  const trades: Trade[] = [];
  const ST_PER = 14, ST_MULT = 2;
  const ATR_MULT = 3, MAX_HOLD_H = 60 * 24; // 60 days in hours

  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < ST_PER + 30) continue;

    const { dir: stDir } = calcSupertrend(cs, ST_PER, ST_MULT);
    const atr = calcATR(cs, ST_PER);

    let pos: Position | null = null;

    for (let i = ST_PER + 2; i < cs.length; i++) {
      const bar = cs[i];

      // Detect flip on completed bar: stDir[i-1] != stDir[i-2]
      const prevDir = stDir[i - 1];
      const prevPrevDir = stDir[i - 2];
      const flip = prevDir !== prevPrevDir;

      // EXITS
      if (pos) {
        let xp = 0, reason = "", isSL = false;

        // SL check
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

        // Supertrend flip exit
        if (!xp && flip) { xp = bar.o; reason = "flip"; }

        // Max hold
        if (!xp) {
          const hoursHeld = (bar.t - pos.et) / H;
          if (hoursHeld >= MAX_HOLD_H) { xp = bar.c; reason = "mh"; }
        }

        if (xp > 0) {
          const xpAdj = exitPrice(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, reason, engine: "B" });
          }
          pos = null;
        }
      }

      // ENTRIES on flip
      if (!pos && flip && bar.t >= startTs && bar.t < endTs) {
        const dir: "long" | "short" = prevDir === 1 ? "long" : "short";

        // BTC filter: longs only when BTC EMA(20) > EMA(50) daily
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPrice(pair, dir, bar.o);
        let sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;
        // Cap at 3.5%
        if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir, ep, et: bar.t, sl, engine: "B" };
      }
    }
  }
  return trades;
}

// ─── Engine C: GARCH v2 Multi-TF ───────────────────────────────────
// 1h z > 4.5 AND 4h z > 3.0 + EMA(9)>EMA(21) + BTC EMA(9)>EMA(21) 1h → long
// 1h z < -3.0 AND 4h z < -3.0 + EMA(9)<EMA(21) + BTC bearish → short
// SL 4% capped at 3.5%, max hold 168h
function engineC(startTs: number, endTs: number): Trade[] {
  const trades: Trade[] = [];
  const MOM_LB = 3, VOL_WIN = 20;
  const Z_LONG_1H = 4.5, Z_SHORT_1H = -3.0;
  const Z_LONG_4H = 3.0, Z_SHORT_4H = -3.0;
  const EMA_FAST = 9, EMA_SLOW = 21;
  const SL_PCT = 0.04;
  const MAX_HOLD_HOURS = 168;

  for (const pair of PAIRS) {
    const h1 = h1Data.get(pair);
    const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;

    const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
    const z4h = computeZScores(h4, MOM_LB, VOL_WIN);

    const h1Closes = h1.map(c => c.c);
    const ema9_1h = calcEMA(h1Closes, EMA_FAST);
    const ema21_1h = calcEMA(h1Closes, EMA_SLOW);

    // Build 4h timestamp lookup
    const h4TsMap = new Map<number, number>();
    h4.forEach((c, i) => h4TsMap.set(c.t, i));

    let pos: Position | null = null;

    for (let i = Math.max(VOL_WIN + MOM_LB + 2, EMA_SLOW + 1); i < h1.length; i++) {
      const bar = h1[i];

      // EXITS
      if (pos) {
        let xp = 0, reason = "", isSL = false;

        // SL
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

        // Max hold
        if (!xp) {
          const hoursHeld = (bar.t - pos.et) / H;
          if (hoursHeld >= MAX_HOLD_HOURS) { xp = bar.c; reason = "mh"; }
        }

        if (xp > 0) {
          const xpAdj = exitPrice(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, reason, engine: "C" });
          }
          pos = null;
        }
      }

      // ENTRIES
      if (!pos && bar.t >= startTs && bar.t < endTs) {
        const prev = i - 1; // anti look-ahead
        if (prev < VOL_WIN + MOM_LB) continue;

        const z1 = z1h[prev];
        if (isNaN(z1) || z1 === 0) continue;

        const goLong = z1 > Z_LONG_1H;
        const goShort = z1 < Z_SHORT_1H;
        if (!goLong && !goShort) continue;

        // 4h confirmation
        const ts4h = Math.floor(h1[prev].t / H4) * H4;
        const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) continue;
        const z4 = z4h[idx4h];
        if (goLong && z4 <= Z_LONG_4H) continue;
        if (goShort && z4 >= Z_SHORT_4H) continue;

        // EMA filter on 1h
        const off9 = h1.length - ema9_1h.length;
        const off21 = h1.length - ema21_1h.length;
        const i9 = prev - off9;
        const i21 = prev - off21;
        if (i9 < 0 || i21 < 0 || i9 >= ema9_1h.length || i21 >= ema21_1h.length) continue;
        if (goLong && ema9_1h[i9] <= ema21_1h[i21]) continue;
        if (goShort && ema9_1h[i9] >= ema21_1h[i21]) continue;

        // BTC EMA(9)>EMA(21) on 1h
        const btcTrend = btcH1Trend(h1[prev].t);
        if (goLong && btcTrend !== "long") continue;
        if (goShort && btcTrend !== "short") continue;

        const dir: "long" | "short" = goLong ? "long" : "short";
        const ep = entryPrice(pair, dir, bar.o);
        let sl = dir === "long" ? ep * (1 - SL_PCT) : ep * (1 + SL_PCT);
        // Cap at 3.5%
        if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir, ep, et: bar.t, sl, engine: "C" };
      }
    }
  }
  return trades;
}

// ─── Ensemble simulation with shared position pool ──────────────────
function simulateEnsemble(
  startTs: number, endTs: number, maxPos: number = MAX_POS,
): { trades: Trade[]; blockedSignals: number } {
  // Generate all signals from each engine (standalone, no cap)
  const allA = engineA(startTs, endTs);
  const allB = engineB(startTs, endTs);
  const allC = engineC(startTs, endTs);

  // Merge all trades into events timeline
  interface Event {
    t: number;
    type: "entry" | "exit";
    trade: Trade;
    engine: string;
    pair: string;
    dir: "long" | "short";
  }

  const events: Event[] = [];
  for (const tr of [...allA, ...allB, ...allC]) {
    events.push({ t: tr.et, type: "entry", trade: tr, engine: tr.engine, pair: tr.pair, dir: tr.dir });
    events.push({ t: tr.xt, type: "exit", trade: tr, engine: tr.engine, pair: tr.pair, dir: tr.dir });
  }
  events.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1)); // exits first at same time

  // Simulate with position cap
  const openPositions = new Map<string, Trade>(); // key: engine+pair
  const accepted: Trade[] = [];
  let blockedSignals = 0;

  for (const evt of events) {
    const key = `${evt.engine}:${evt.pair}`;

    if (evt.type === "exit") {
      if (openPositions.has(key)) {
        openPositions.delete(key);
      }
    } else {
      // Entry
      // Check max 1 per pair per engine
      if (openPositions.has(key)) continue;
      // Check total position cap
      if (openPositions.size >= maxPos) {
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
  dd: number; total: number; perDay: number;
}

function calcMetrics(trades: Trade[], startTs?: number, endTs?: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
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

  const firstT = startTs ?? Math.min(...trades.map(t => t.et));
  const lastT = endTs ?? Math.max(...trades.map(t => t.xt));
  const days = Math.max((lastT - firstT) / D, 1);

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: total / days,
  };
}

function fmtPnl(v: number): string { return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }
function fmtRow(label: string, m: Metrics): string {
  return `${label.padEnd(32)} ${String(m.n).padStart(5)}  ${m.wr.toFixed(1).padStart(5)}%  ${fmtPnl(m.total).padStart(12)}  ${m.pf.toFixed(2).padStart(6)}  ${m.sharpe.toFixed(2).padStart(7)}  $${m.dd.toFixed(2).padStart(8)}  ${fmtPnl(m.perDay).padStart(10)}/d`;
}
function printHeader(): void {
  console.log(`${"".padEnd(32)} ${"Trades".padStart(5)}  ${"WR%".padStart(6)}  ${"TotalPnL".padStart(12)}  ${"PF".padStart(6)}  ${"Sharpe".padStart(7)}  ${"MaxDD".padStart(9)}  ${"$/day".padStart(11)}`);
  console.log("-".repeat(100));
}

// ─── VALIDATION SUITE ───────────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("DEFINITIVE 3-ENGINE ENSEMBLE VALIDATION");
console.log("Period: 2023-01 to 2026-03 | OOS: 2025-09-01 | Doubled spreads, 0.035% fee");
console.log("=".repeat(100));

// Generate standalone engine trades (full period)
console.log("\nGenerating trades from all 3 engines...");
const tradesA_full = engineA(FULL_START, FULL_END);
const tradesB_full = engineB(FULL_START, FULL_END);
const tradesC_full = engineC(FULL_START, FULL_END);
console.log(`  Engine A (Daily Donchian): ${tradesA_full.length} trades`);
console.log(`  Engine B (4h Supertrend):  ${tradesB_full.length} trades`);
console.log(`  Engine C (GARCH v2 MTF):   ${tradesC_full.length} trades`);

// ─── TEST 1: Full Period Combined Equity ────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 1: FULL PERIOD COMBINED EQUITY (with shared position pool, max 10)");
console.log("=".repeat(100));
printHeader();

const fullEnsemble = simulateEnsemble(FULL_START, FULL_END);
const fullM = calcMetrics(fullEnsemble.trades, FULL_START, FULL_END);
console.log(fmtRow("Ensemble (capped at 10)", fullM));

// Also show standalone (no cap) for reference
const allStandalone = [...tradesA_full, ...tradesB_full, ...tradesC_full];
const standaloneM = calcMetrics(allStandalone, FULL_START, FULL_END);
console.log(fmtRow("All trades (no cap)", standaloneM));
console.log(`\nBlocked signals due to 10-pos cap: ${fullEnsemble.blockedSignals}`);

// ─── TEST 2: OOS Combined ──────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 2: OOS COMBINED (2025-09-01 to present)");
console.log("=".repeat(100));
printHeader();

const oosEnsemble = simulateEnsemble(OOS_START, FULL_END);
const oosM = calcMetrics(oosEnsemble.trades, OOS_START, FULL_END);
console.log(fmtRow("Ensemble OOS", oosM));

// Per-engine OOS
const oosA = oosEnsemble.trades.filter(t => t.engine === "A");
const oosB = oosEnsemble.trades.filter(t => t.engine === "B");
const oosC = oosEnsemble.trades.filter(t => t.engine === "C");
console.log(fmtRow("  Engine A OOS", calcMetrics(oosA, OOS_START, FULL_END)));
console.log(fmtRow("  Engine B OOS", calcMetrics(oosB, OOS_START, FULL_END)));
console.log(fmtRow("  Engine C OOS", calcMetrics(oosC, OOS_START, FULL_END)));

// ─── TEST 3: 4-Quarter Stationarity ────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 3: 4-QUARTER STATIONARITY");
console.log("=".repeat(100));

const totalDuration = FULL_END - FULL_START;
const quarterLen = totalDuration / 4;
const quarters = [
  { label: "Q1 (2023-01 to 2023-10)", start: FULL_START, end: FULL_START + quarterLen },
  { label: "Q2 (2023-10 to 2024-07)", start: FULL_START + quarterLen, end: FULL_START + 2 * quarterLen },
  { label: "Q3 (2024-07 to 2025-04)", start: FULL_START + 2 * quarterLen, end: FULL_START + 3 * quarterLen },
  { label: "Q4 (2025-04 to 2026-03)", start: FULL_START + 3 * quarterLen, end: FULL_END },
];

printHeader();
let allQuartersProfitable = true;
for (const q of quarters) {
  const qEns = simulateEnsemble(q.start, q.end);
  const qM = calcMetrics(qEns.trades, q.start, q.end);
  console.log(fmtRow(q.label, qM));
  if (qM.total <= 0) allQuartersProfitable = false;
}
console.log(`\nAll quarters profitable: ${allQuartersProfitable ? "YES" : "NO"}`);

// ─── TEST 4: Monthly P&L ───────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 4: MONTHLY P&L");
console.log("=".repeat(100));

const monthlyPnl = new Map<string, number>();
const monthlyCount = new Map<string, number>();
for (const t of fullEnsemble.trades) {
  const d = new Date(t.xt);
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  monthlyPnl.set(key, (monthlyPnl.get(key) ?? 0) + t.pnl);
  monthlyCount.set(key, (monthlyCount.get(key) ?? 0) + 1);
}

const sortedMonths = [...monthlyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));
let losingMonths = 0;
console.log(`${"Month".padEnd(10)}  ${"Trades".padStart(6)}  ${"P&L".padStart(12)}`);
console.log("-".repeat(35));
for (const [m, pnl] of sortedMonths) {
  const cnt = monthlyCount.get(m) ?? 0;
  const bar = pnl >= 0 ? "+".repeat(Math.min(Math.round(pnl / 2), 40)) : "-".repeat(Math.min(Math.round(Math.abs(pnl) / 2), 40));
  console.log(`${m.padEnd(10)}  ${String(cnt).padStart(6)}  ${fmtPnl(pnl).padStart(12)}  ${bar}`);
  if (pnl < 0) losingMonths++;
}
console.log(`\nTotal months: ${sortedMonths.length}, Losing months: ${losingMonths} (${(losingMonths / sortedMonths.length * 100).toFixed(0)}%)`);

// ─── TEST 5: Worst Drawdown Analysis ───────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 5: WORST DRAWDOWN ANALYSIS (top 3)");
console.log("=".repeat(100));

interface Drawdown { start: number; end: number; depth: number; recoveryDays: number; }

function findDrawdowns(trades: Trade[]): Drawdown[] {
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  const dds: Drawdown[] = [];
  let cum = 0, peak = 0, peakTime = sorted[0]?.xt ?? 0;
  let ddStart = 0, inDD = false;

  const cumArr: { t: number; cum: number }[] = [];
  for (const t of sorted) {
    cum += t.pnl;
    cumArr.push({ t: t.xt, cum });
    if (cum > peak) {
      if (inDD) {
        dds.push({ start: ddStart, end: t.xt, depth: peak - Math.min(...cumArr.filter(c => c.t >= ddStart && c.t <= t.xt).map(c => c.cum)), recoveryDays: Math.round((t.xt - ddStart) / D) });
        inDD = false;
      }
      peak = cum;
      peakTime = t.xt;
    }
    if (cum < peak && !inDD) {
      inDD = true;
      ddStart = peakTime;
    }
  }
  // If still in DD at end
  if (inDD) {
    const trough = Math.min(...cumArr.filter(c => c.t >= ddStart).map(c => c.cum));
    dds.push({ start: ddStart, end: sorted[sorted.length - 1].xt, depth: peak - trough, recoveryDays: -1 });
  }

  return dds.sort((a, b) => b.depth - a.depth);
}

const dds = findDrawdowns(fullEnsemble.trades);
for (let i = 0; i < Math.min(3, dds.length); i++) {
  const dd = dds[i];
  const startD = new Date(dd.start).toISOString().slice(0, 10);
  const endD = new Date(dd.end).toISOString().slice(0, 10);
  console.log(`  DD #${i + 1}: ${startD} to ${endD}, depth $${dd.depth.toFixed(2)}, recovery: ${dd.recoveryDays >= 0 ? dd.recoveryDays + " days" : "NOT RECOVERED"}`);
}

// ─── TEST 6: Bootstrap (500 runs) ──────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 6: BOOTSTRAP (500 runs, resample combined trades)");
console.log("=".repeat(100));

const bootstrapPFs: number[] = [];
const bootstrapSharpes: number[] = [];
const N_BOOT = 500;
const allEnsembleTrades = fullEnsemble.trades;

for (let b = 0; b < N_BOOT; b++) {
  const sample: Trade[] = [];
  for (let i = 0; i < allEnsembleTrades.length; i++) {
    sample.push(allEnsembleTrades[Math.floor(Math.random() * allEnsembleTrades.length)]);
  }
  const wins = sample.filter(t => t.pnl > 0);
  const losses = sample.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  bootstrapPFs.push(gl > 0 ? gp / gl : (gp > 0 ? 10 : 0));

  // Compute Sharpe from daily P&L of bootstrap sample
  const dayMap = new Map<number, number>();
  for (const t of sample) {
    const dk = Math.floor(t.xt / D);
    dayMap.set(dk, (dayMap.get(dk) ?? 0) + t.pnl);
  }
  const rets = [...dayMap.values()];
  const m = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1));
  bootstrapSharpes.push(sd > 0 ? (m / sd) * Math.sqrt(252) : 0);
}

bootstrapPFs.sort((a, b) => a - b);
bootstrapSharpes.sort((a, b) => a - b);

const pctl = (arr: number[], p: number) => arr[Math.floor(arr.length * p / 100)];
console.log(`  PF     5th: ${pctl(bootstrapPFs, 5).toFixed(2)}, 50th: ${pctl(bootstrapPFs, 50).toFixed(2)}, 95th: ${pctl(bootstrapPFs, 95).toFixed(2)}`);
console.log(`  Sharpe 5th: ${pctl(bootstrapSharpes, 5).toFixed(2)}, 50th: ${pctl(bootstrapSharpes, 50).toFixed(2)}, 95th: ${pctl(bootstrapSharpes, 95).toFixed(2)}`);

// ─── TEST 7: Per-Engine Contribution ────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 7: PER-ENGINE CONTRIBUTION");
console.log("=".repeat(100));

printHeader();
const engAFull = fullEnsemble.trades.filter(t => t.engine === "A");
const engBFull = fullEnsemble.trades.filter(t => t.engine === "B");
const engCFull = fullEnsemble.trades.filter(t => t.engine === "C");
const mA = calcMetrics(engAFull, FULL_START, FULL_END);
const mB = calcMetrics(engBFull, FULL_START, FULL_END);
const mC = calcMetrics(engCFull, FULL_START, FULL_END);
console.log(fmtRow("Engine A (Daily Donchian)", mA));
console.log(fmtRow("Engine B (4h Supertrend)", mB));
console.log(fmtRow("Engine C (GARCH v2 MTF)", mC));
console.log(fmtRow("Combined", fullM));

console.log("\nPnL contribution:");
console.log(`  Engine A: ${fmtPnl(mA.total)} (${(mA.total / fullM.total * 100).toFixed(1)}%)`);
console.log(`  Engine B: ${fmtPnl(mB.total)} (${(mB.total / fullM.total * 100).toFixed(1)}%)`);
console.log(`  Engine C: ${fmtPnl(mC.total)} (${(mC.total / fullM.total * 100).toFixed(1)}%)`);

// Removal impact
console.log("\nRemoval impact:");
const withoutA = simulateEnsemble(FULL_START, FULL_END);
const tradesNoA = fullEnsemble.trades.filter(t => t.engine !== "A");
const tradesNoB = fullEnsemble.trades.filter(t => t.engine !== "B");
const tradesNoC = fullEnsemble.trades.filter(t => t.engine !== "C");
const mNoA = calcMetrics(tradesNoA, FULL_START, FULL_END);
const mNoB = calcMetrics(tradesNoB, FULL_START, FULL_END);
const mNoC = calcMetrics(tradesNoC, FULL_START, FULL_END);
console.log(`  Without A: ${fmtPnl(mNoA.total)} (delta: ${fmtPnl(mNoA.total - fullM.total)})`);
console.log(`  Without B: ${fmtPnl(mNoB.total)} (delta: ${fmtPnl(mNoB.total - fullM.total)})`);
console.log(`  Without C: ${fmtPnl(mNoC.total)} (delta: ${fmtPnl(mNoC.total - fullM.total)})`);

// ─── TEST 8: Direction Split ────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 8: DIRECTION SPLIT");
console.log("=".repeat(100));

const longs = fullEnsemble.trades.filter(t => t.dir === "long");
const shorts = fullEnsemble.trades.filter(t => t.dir === "short");
const oosLongs = oosEnsemble.trades.filter(t => t.dir === "long");
const oosShorts = oosEnsemble.trades.filter(t => t.dir === "short");

printHeader();
console.log(fmtRow("Full - Longs", calcMetrics(longs, FULL_START, FULL_END)));
console.log(fmtRow("Full - Shorts", calcMetrics(shorts, FULL_START, FULL_END)));
console.log(fmtRow("OOS  - Longs", calcMetrics(oosLongs, OOS_START, FULL_END)));
console.log(fmtRow("OOS  - Shorts", calcMetrics(oosShorts, OOS_START, FULL_END)));

// ─── TEST 9: Position Cap Analysis ─────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 9: POSITION CAP ANALYSIS");
console.log("=".repeat(100));

// Build concurrent position time series
const sortedTrades = [...fullEnsemble.trades].sort((a, b) => a.et - b.et);
let maxConcurrent = 0;
const posEvents: { t: number; delta: number }[] = [];
for (const tr of allStandalone) { // use all standalone trades to see true demand
  posEvents.push({ t: tr.et, delta: 1 });
  posEvents.push({ t: tr.xt, delta: -1 });
}
posEvents.sort((a, b) => a.t - b.t || a.delta - b.delta);
let concurrent = 0;
const concurrentHistory: { t: number; n: number }[] = [];
for (const e of posEvents) {
  concurrent += e.delta;
  if (concurrent > maxConcurrent) maxConcurrent = concurrent;
  concurrentHistory.push({ t: e.t, n: concurrent });
}

console.log(`  Max concurrent positions (uncapped): ${maxConcurrent}`);
console.log(`  Blocked signals at cap=10: ${fullEnsemble.blockedSignals}`);

// What if cap=15?
const ens15 = simulateEnsemble(FULL_START, FULL_END, 15);
const m15 = calcMetrics(ens15.trades, FULL_START, FULL_END);
console.log(`  Blocked signals at cap=15: ${ens15.blockedSignals}`);
console.log(`\n  Cap=10: ${fmtPnl(fullM.total)}, Sharpe ${fullM.sharpe.toFixed(2)}, DD $${fullM.dd.toFixed(2)}`);
console.log(`  Cap=15: ${fmtPnl(m15.total)}, Sharpe ${m15.sharpe.toFixed(2)}, DD $${m15.dd.toFixed(2)}`);

// Time at cap
let barsAtCap10 = 0, barsTotal = 0;
for (const ch of concurrentHistory) {
  barsTotal++;
  if (ch.n >= 10) barsAtCap10++;
}
console.log(`  Time at or above 10 positions: ${(barsAtCap10 / barsTotal * 100).toFixed(1)}%`);

// ─── TEST 10: Capital Scenarios ─────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 10: CAPITAL DEPLOYMENT SCENARIOS");
console.log("=".repeat(100));

// Backtest uses $5 margin × 3 engines = $15 base capital
const baseCapital = 15; // $5 per engine × 3 engines
console.log(`  Backtest base: $${baseCapital} margin ($5/engine x 3 engines, 10x leverage)`);
console.log(`  Backtest notional: $${baseCapital * LEV} ($50/trade)`);
console.log();

const scenarios = [50, 100, 150, 200];
console.log(`${"Capital".padEnd(12)} ${"Margin/eng".padStart(12)} ${"$/day".padStart(10)} ${"MaxDD".padStart(10)} ${"Annual".padStart(12)} ${"DD%".padStart(8)}`);
console.log("-".repeat(70));
for (const cap of scenarios) {
  const scale = cap / baseCapital;
  const perDay = fullM.perDay * scale;
  const maxDD = fullM.dd * scale;
  const annual = perDay * 365;
  const ddPct = (maxDD / cap * 100);
  console.log(
    `$${String(cap).padEnd(11)} $${(cap / 3).toFixed(1).padStart(11)} ${fmtPnl(perDay).padStart(10)} $${maxDD.toFixed(2).padStart(9)} ${fmtPnl(annual).padStart(12)} ${ddPct.toFixed(1).padStart(7)}%`
  );
}

// ─── TEST 11: Buy-and-Hold BTC Comparison ───────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TEST 11: BTC BUY-AND-HOLD COMPARISON ($100 equivalent)");
console.log("=".repeat(100));

const btcFirst = btcDaily.find(c => c.t >= FULL_START);
const btcLast = btcDaily[btcDaily.length - 1];
if (btcFirst && btcLast) {
  const btcReturn = btcLast.c / btcFirst.c - 1;
  const btcPnl = 100 * btcReturn;
  const ensemblePnl = fullM.total * (100 / baseCapital);
  const btcDays = (btcLast.t - btcFirst.t) / D;

  // BTC max drawdown
  let btcPeak = 0, btcMaxDD = 0;
  for (const c of btcDaily) {
    if (c.t < FULL_START || c.t > FULL_END) continue;
    if (c.c > btcPeak) btcPeak = c.c;
    const dd = (btcPeak - c.c) / btcPeak * 100;
    if (dd > btcMaxDD) btcMaxDD = dd;
  }

  console.log(`  BTC: $${btcFirst.c.toFixed(0)} -> $${btcLast.c.toFixed(0)} (${(btcReturn * 100).toFixed(1)}%)`);
  console.log(`  $100 in BTC:      ${fmtPnl(btcPnl)} over ${btcDays.toFixed(0)} days (${fmtPnl(btcPnl / btcDays)}/day). Max DD: ${btcMaxDD.toFixed(1)}%`);
  console.log(`  $100 in Ensemble: ${fmtPnl(ensemblePnl)} over ${btcDays.toFixed(0)} days (${fmtPnl(ensemblePnl / btcDays)}/day). Max DD: $${(fullM.dd * 100 / baseCapital).toFixed(2)}`);

  // OOS comparison
  const btcOosFirst = btcDaily.find(c => c.t >= OOS_START);
  if (btcOosFirst) {
    const btcOosReturn = btcLast.c / btcOosFirst.c - 1;
    const btcOosPnl = 100 * btcOosReturn;
    const ensOosPnl = oosM.total * (100 / baseCapital);
    const oosDays = (btcLast.t - OOS_START) / D;
    console.log(`\n  OOS (since 2025-09-01):`);
    console.log(`  $100 in BTC:      ${fmtPnl(btcOosPnl)} (${(btcOosReturn * 100).toFixed(1)}%)`);
    console.log(`  $100 in Ensemble: ${fmtPnl(ensOosPnl)} over ${oosDays.toFixed(0)} days`);
  }
}

// ─── FINAL SUMMARY TABLE ────────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("FINAL SUMMARY");
console.log("=".repeat(100));

console.log(`
┌─────────────────────────┬──────────────────────────────────────────────────────────┐
│ Metric                  │ Full Period              │ OOS (2025-09+)               │
├─────────────────────────┼──────────────────────────┼──────────────────────────────┤
│ Total Trades            │ ${String(fullM.n).padStart(24)} │ ${String(oosM.n).padStart(28)} │
│ Win Rate                │ ${(fullM.wr.toFixed(1) + "%").padStart(24)} │ ${(oosM.wr.toFixed(1) + "%").padStart(28)} │
│ Profit Factor           │ ${fullM.pf.toFixed(2).padStart(24)} │ ${oosM.pf.toFixed(2).padStart(28)} │
│ Sharpe Ratio            │ ${fullM.sharpe.toFixed(2).padStart(24)} │ ${oosM.sharpe.toFixed(2).padStart(28)} │
│ Total P&L               │ ${fmtPnl(fullM.total).padStart(24)} │ ${fmtPnl(oosM.total).padStart(28)} │
│ $/day                   │ ${fmtPnl(fullM.perDay).padStart(24)} │ ${fmtPnl(oosM.perDay).padStart(28)} │
│ Max Drawdown            │ ${"$" + fullM.dd.toFixed(2).padStart(23)} │ ${"$" + oosM.dd.toFixed(2).padStart(27)} │
│ Losing Months           │ ${(losingMonths + "/" + sortedMonths.length).padStart(24)} │                              │
│ All Quarters Profitable │ ${(allQuartersProfitable ? "YES" : "NO").padStart(24)} │                              │
│ Position Cap Blocks     │ ${String(fullEnsemble.blockedSignals).padStart(24)} │                              │
│ Bootstrap PF (5th pctl) │ ${pctl(bootstrapPFs, 5).toFixed(2).padStart(24)} │                              │
│ Bootstrap Sharpe (5th)  │ ${pctl(bootstrapSharpes, 5).toFixed(2).padStart(24)} │                              │
├─────────────────────────┼──────────────────────────┼──────────────────────────────┤
│ Engine A PnL            │ ${fmtPnl(mA.total).padStart(24)} │ ${fmtPnl(calcMetrics(oosA, OOS_START, FULL_END).total).padStart(28)} │
│ Engine B PnL            │ ${fmtPnl(mB.total).padStart(24)} │ ${fmtPnl(calcMetrics(oosB, OOS_START, FULL_END).total).padStart(28)} │
│ Engine C PnL            │ ${fmtPnl(mC.total).padStart(24)} │ ${fmtPnl(calcMetrics(oosC, OOS_START, FULL_END).total).padStart(28)} │
├─────────────────────────┼──────────────────────────┼──────────────────────────────┤
│ $100 deploy $/day       │ ${fmtPnl(fullM.perDay * 100 / baseCapital).padStart(24)} │ ${fmtPnl(oosM.perDay * 100 / baseCapital).padStart(28)} │
│ $100 deploy MaxDD       │ ${"$" + (fullM.dd * 100 / baseCapital).toFixed(2).padStart(23)} │ ${"$" + (oosM.dd * 100 / baseCapital).toFixed(2).padStart(27)} │
└─────────────────────────┴──────────────────────────┴──────────────────────────────┘
`);

console.log("Validation complete.");
