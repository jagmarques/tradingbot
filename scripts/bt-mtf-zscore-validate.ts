/**
 * Multi-Timeframe Z-Score Strategy Validation
 *
 * 8 tests: Random Entry, Bootstrap CI, 4-Quarter Stationarity,
 * Direction Bias, Spread Stress, Parameter Neighbors, Correlation, Per-Pair.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-mtf-zscore-validate.ts
 */

import * as fs from "fs";
import * as path from "path";
import { EMA } from "technicalindicators";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35; // 0.035% taker per side
const SIZE = 5;
const LEV = 10;
const NOT = SIZE * LEV; // $50 notional
const SL_SLIP = 1.5;

// MTF Z-Score params
const Z_LONG_1H = 4.5;
const Z_SHORT_1H = -3.0;
const Z_LONG_4H = 3.0;
const Z_SHORT_4H = -3.0;
const MOM_LB = 3;
const VOL_WIN = 20;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const SL_PCT = 0.04;
const MAX_HOLD_H = 168; // 7 days in hours (168 bars on 1h)

// Spread map (half-spread, one side)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4,
};

const PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "SOL",
];

// Donchian daily pairs (for correlation test)
const DONCH_PAIRS = [
  "ADA", "APT", "ARB", "BTC", "DASH", "DOGE", "DOT", "ENA",
  "LDO", "LINK", "OP", "SOL", "TRUMP", "UNI", "WIF", "WLD", "XRP",
];

// Dates
const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

interface TFData {
  candles: C[];
  tsMap: Map<number, number>;
  zScores: number[];
  ema9: number[];
  ema21: number[];
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_5M, `${pair}USDT.json`);
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

function aggregateDaily(bars5m: C[]): C[] {
  return aggregate(bars5m, D, 200);
}

// ─── Indicator helpers ──────────────────────────────────────────────
function getVal(arr: number[], barIdx: number, candleLen: number): number | null {
  const offset = candleLen - arr.length;
  const idx = barIdx - offset;
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

function computeZScores(candles: C[]): number[] {
  const z = new Array(candles.length).fill(0);
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < candles.length; i++) {
    const mom = candles[i].c / candles[i - MOM_LB].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - VOL_WIN + 1); j <= i; j++) {
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

function buildTFData(candles: C[]): TFData | null {
  if (candles.length < 200) return null;
  const tsMap = new Map<number, number>();
  candles.forEach((c, i) => tsMap.set(c.t, i));
  const closes = candles.map(c => c.c);
  const ema9 = EMA.calculate({ period: EMA_FAST, values: closes });
  const ema21 = EMA.calculate({ period: EMA_SLOW, values: closes });
  const zScores = computeZScores(candles);
  return { candles, tsMap, zScores, ema9, ema21 };
}

// ─── Precompute 1h and 4h data ──────────────────────────────────────
interface PairMTF {
  h1: TFData;
  h4: TFData;
}

function precompute(pair: string): PairMTF | null {
  const bars5m = load5m(pair);
  if (bars5m.length < 200) return null;
  const h1 = buildTFData(aggregate(bars5m, H, 10));
  const h4 = buildTFData(aggregate(bars5m, H4, 40));
  if (!h1 || !h4) return null;
  return { h1, h4 };
}

// ─── MTF Z-Score Signal ─────────────────────────────────────────────
function mtfSignal(
  pd: PairMTF, barIdx1h: number, btcH1: TFData,
  zLong1h: number, zShort1h: number, zLong4h: number, zShort4h: number,
): "long" | "short" | null {
  const prev = barIdx1h - 1; // anti-look-ahead
  if (prev < VOL_WIN + MOM_LB) return null;

  // 1h z-score
  const z1h = pd.h1.zScores[prev];
  if (isNaN(z1h) || z1h === 0) return null;

  const goLong = z1h > zLong1h;
  const goShort = z1h < zShort1h;
  if (!goLong && !goShort) return null;

  // 4h z-score confirmation: find the 4h bar covering this 1h bar's time
  const ts1h = pd.h1.candles[prev].t;
  const ts4h = Math.floor(ts1h / H4) * H4;
  const idx4h = pd.h4.tsMap.get(ts4h);
  if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) return null;

  const z4h = pd.h4.zScores[idx4h];
  if (goLong && z4h <= zLong4h) return null;
  if (goShort && z4h >= zShort4h) return null;

  // EMA 9/21 filter on 1h
  const e9 = getVal(pd.h1.ema9, prev, pd.h1.candles.length);
  const e21 = getVal(pd.h1.ema21, prev, pd.h1.candles.length);
  if (e9 === null || e21 === null) return null;
  if (goLong && e9 <= e21) return null;
  if (goShort && e9 >= e21) return null;

  // BTC EMA(9) > EMA(21) on 1h for longs, < for shorts
  const btcIdx = btcH1.tsMap.get(ts1h);
  if (btcIdx === undefined || btcIdx < 1) return null;
  const btcPrev = btcIdx - 1;
  const be9 = getVal(btcH1.ema9, btcPrev, btcH1.candles.length);
  const be21 = getVal(btcH1.ema21, btcPrev, btcH1.candles.length);
  if (be9 === null || be21 === null) return null;
  if (goLong && be9 <= be21) return null;
  if (goShort && be9 >= be21) return null;

  return goLong ? "long" : "short";
}

// ─── Simulation ─────────────────────────────────────────────────────
interface Position {
  pair: string; direction: "long" | "short";
  entryPrice: number; entryTime: number;
  stopLoss: number;
}

function simMTF(
  pdm: Map<string, PairMTF>, btcH1: TFData,
  startTs: number, endTs: number, pairs: string[],
  opts: {
    spreadMult?: number;
    zLong1h?: number; zShort1h?: number;
    zLong4h?: number; zShort4h?: number;
    slPct?: number;
  } = {},
): Trade[] {
  const pd = new Map<string, PairMTF>();
  for (const p of pairs) { const d = pdm.get(p); if (d) pd.set(p, d); }

  const spreadMult = opts.spreadMult ?? 1;
  const zL1 = opts.zLong1h ?? Z_LONG_1H;
  const zS1 = opts.zShort1h ?? Z_SHORT_1H;
  const zL4 = opts.zLong4h ?? Z_LONG_4H;
  const zS4 = opts.zShort4h ?? Z_SHORT_4H;
  const slPct = opts.slPct ?? SL_PCT;

  const allTs = new Set<number>();
  for (const d of pd.values()) {
    for (const c of d.h1.candles) {
      if (c.t >= startTs && c.t < endTs) allTs.add(c.t);
    }
  }
  const sorted = [...allTs].sort((a, b) => a - b);
  const open = new Map<string, Position>();
  const trades: Trade[] = [];

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // EXITS
    for (const [p, pos] of open) {
      const d = pd.get(p)!;
      const bi = d.h1.tsMap.get(ts) ?? -1;
      if (bi < 0) continue;
      const bar = d.h1.candles[bi];
      const sp = (SP[p] ?? 4e-4) * spreadMult;
      let exitPrice = 0, reason = "";

      // SL
      if (pos.direction === "long" && bar.l <= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 - sp * SL_SLIP); reason = "sl";
      } else if (pos.direction === "short" && bar.h >= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 + sp * SL_SLIP); reason = "sl";
      }

      // Max hold (168h = 168 bars on 1h)
      if (!reason) {
        const barsHeld = Math.floor((ts - pos.entryTime) / H);
        if (barsHeld >= MAX_HOLD_H) {
          exitPrice = pos.direction === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }
      }

      if (reason) {
        const fee = NOT * FEE * 2;
        const raw = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * NOT
          : (pos.entryPrice / exitPrice - 1) * NOT;
        trades.push({
          pair: p, dir: pos.direction, ep: pos.entryPrice, xp: exitPrice,
          et: pos.entryTime, xt: ts, pnl: raw - fee, reason,
        });
        open.delete(p);
        closedThisBar.add(p);
      }
    }

    // ENTRIES
    for (const [p, d] of pd) {
      if (open.has(p) || closedThisBar.has(p)) continue;
      const bi = d.h1.tsMap.get(ts) ?? -1;
      if (bi < 60) continue;

      const dir = mtfSignal(d, bi, btcH1, zL1, zS1, zL4, zS4);
      if (!dir) continue;

      const entryRaw = d.h1.candles[bi].o;
      const sp = (SP[p] ?? 4e-4) * spreadMult;
      const entry = dir === "long" ? entryRaw * (1 + sp) : entryRaw * (1 - sp);
      const sl = dir === "long" ? entry * (1 - slPct) : entry * (1 + slPct);

      open.set(p, { pair: p, direction: dir, entryPrice: entry, entryTime: ts, stopLoss: sl });
    }
  }

  return trades;
}

// ─── Random Entry (same exits) ──────────────────────────────────────
function simRandomEntry(
  pdm: Map<string, PairMTF>, startTs: number, endTs: number,
  pairs: string[], avgFreq: number, spreadMult = 1,
): Trade[] {
  const pd = new Map<string, PairMTF>();
  for (const p of pairs) { const d = pdm.get(p); if (d) pd.set(p, d); }

  const allTs = new Set<number>();
  for (const d of pd.values()) {
    for (const c of d.h1.candles) {
      if (c.t >= startTs && c.t < endTs) allTs.add(c.t);
    }
  }
  const sorted = [...allTs].sort((a, b) => a - b);
  const open = new Map<string, Position>();
  const trades: Trade[] = [];

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // EXITS (same as MTF)
    for (const [p, pos] of open) {
      const d = pd.get(p)!;
      const bi = d.h1.tsMap.get(ts) ?? -1;
      if (bi < 0) continue;
      const bar = d.h1.candles[bi];
      const sp = (SP[p] ?? 4e-4) * spreadMult;
      let exitPrice = 0, reason = "";

      if (pos.direction === "long" && bar.l <= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 - sp * SL_SLIP); reason = "sl";
      } else if (pos.direction === "short" && bar.h >= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 + sp * SL_SLIP); reason = "sl";
      }

      if (!reason) {
        const barsHeld = Math.floor((ts - pos.entryTime) / H);
        if (barsHeld >= MAX_HOLD_H) {
          exitPrice = pos.direction === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }
      }

      if (reason) {
        const fee = NOT * FEE * 2;
        const raw = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * NOT
          : (pos.entryPrice / exitPrice - 1) * NOT;
        trades.push({
          pair: p, dir: pos.direction, ep: pos.entryPrice, xp: exitPrice,
          et: pos.entryTime, xt: ts, pnl: raw - fee, reason,
        });
        open.delete(p);
        closedThisBar.add(p);
      }
    }

    // RANDOM ENTRIES
    for (const [p, d] of pd) {
      if (open.has(p) || closedThisBar.has(p)) continue;
      const bi = d.h1.tsMap.get(ts) ?? -1;
      if (bi < 60) continue;
      if (Math.random() > avgFreq) continue;

      const dir: "long" | "short" = Math.random() > 0.5 ? "long" : "short";
      const entryRaw = d.h1.candles[bi].o;
      const sp = (SP[p] ?? 4e-4) * spreadMult;
      const entry = dir === "long" ? entryRaw * (1 + sp) : entryRaw * (1 - sp);
      const sl = dir === "long" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);

      open.set(p, { pair: p, direction: dir, entryPrice: entry, entryTime: ts, stopLoss: sl });
    }
  }

  return trades;
}

// ─── Donchian Daily (for correlation) ───────────────────────────────
function calcSMAArr(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
}

function calcATRManual(cs: C[], period: number): number[] {
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

function donchHi(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let j = Math.max(0, idx - lb); j < idx; j++) mx = Math.max(mx, cs[j].h);
  return mx;
}

function donchLo(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let j = Math.max(0, idx - lb); j < idx; j++) mn = Math.min(mn, cs[j].l);
  return mn;
}

function simDonchianDaily(
  dailyData: Map<string, C[]>, btcDaily: C[],
  startTs: number, endTs: number, pairs: string[],
): Trade[] {
  const ENTRY_LB = 30;
  const EXIT_LB = 15;
  const ATR_MULT = 3;
  const ATR_PER = 14;
  const DONCH_MAX_HOLD = 60;
  const FAST_SMA = 30;
  const SLOW_SMA = 60;
  const notional = NOT;

  const btcCloses = btcDaily.map(c => c.c);
  const btcFast = calcSMAArr(btcCloses, FAST_SMA);
  const btcSlow = calcSMAArr(btcCloses, SLOW_SMA);
  const btcTsMap = new Map<number, number>();
  btcDaily.forEach((c, i) => btcTsMap.set(c.t, i));

  const trades: Trade[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < SLOW_SMA + ATR_PER + 5) continue;

    const closes = cs.map(c => c.c);
    const fast = calcSMAArr(closes, FAST_SMA);
    const slow = calcSMAArr(closes, SLOW_SMA);
    const atr = calcATRManual(cs, ATR_PER);
    const warmup = SLOW_SMA + 1;

    interface DPos { pair: string; dir: "long" | "short"; ep: number; et: number; sl: number; }
    let pos: DPos | null = null;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];
      const sp = SP[pair] ?? 4e-4;

      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / D);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP); reason = "sl";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP); reason = "sl";
        }

        if (!xp && i >= EXIT_LB + 1) {
          if (pos.dir === "long") {
            const chanLow = donchLo(cs, i, EXIT_LB);
            if (bar.c < chanLow) { xp = bar.c * (1 - sp); reason = "ch"; }
          } else {
            const chanHigh = donchHi(cs, i, EXIT_LB);
            if (bar.c > chanHigh) { xp = bar.c * (1 + sp); reason = "ch"; }
          }
        }

        if (!xp && holdDays >= DONCH_MAX_HOLD) {
          xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }

        if (xp > 0) {
          const fee = notional * FEE * 2;
          const raw = pos.dir === "long"
            ? (xp / pos.ep - 1) * notional
            : (pos.ep / xp - 1) * notional;
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: raw - fee, reason });
          }
          pos = null;
        }
      }

      if (!pos && i >= warmup && bar.t >= startTs && bar.t < endTs) {
        const prev = i - 1;
        const prevFast = fast[prev];
        const prevSlow = slow[prev];
        const curFast = fast[i];
        const curSlow = slow[i];

        let dir: "long" | "short" | null = null;
        if (prevFast <= prevSlow && curFast > curSlow) dir = "long";
        else if (prevFast >= prevSlow && curFast < curSlow) dir = "short";
        if (!dir) continue;

        if (dir === "long") {
          const btcI = btcTsMap.get(bar.t);
          if (btcI !== undefined && btcI > 0) {
            if (btcFast[btcI] <= btcSlow[btcI]) continue;
          }
        }

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
        const sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;
        pos = { pair, dir, ep, et: bar.t, sl };
      }
    }
  }

  return trades;
}

// ─── Supertrend Daily (for correlation) ─────────────────────────────
function simSupertrendDaily(
  dailyData: Map<string, C[]>,
  startTs: number, endTs: number, pairs: string[],
): Trade[] {
  const ST_PERIOD = 14;
  const ST_MULT = 2;
  const ST_SL_PCT = 0.035;
  const ST_MAX_HOLD = 60;
  const notional = NOT;
  const trades: Trade[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < ST_PERIOD + 30) continue;

    const atr = calcATRManual(cs, ST_PERIOD);
    const upperBand = new Array(cs.length).fill(0);
    const lowerBand = new Array(cs.length).fill(0);
    const stDir = new Array(cs.length).fill(1);

    for (let i = ST_PERIOD; i < cs.length; i++) {
      const mid = (cs[i].h + cs[i].l) / 2;
      const ub = mid + ST_MULT * atr[i];
      const lb = mid - ST_MULT * atr[i];

      upperBand[i] = i > ST_PERIOD && ub < upperBand[i - 1] && cs[i - 1].c > upperBand[i - 1]
        ? upperBand[i - 1] : ub;
      lowerBand[i] = i > ST_PERIOD && lb > lowerBand[i - 1] && cs[i - 1].c < lowerBand[i - 1]
        ? lowerBand[i - 1] : lb;

      if (i === ST_PERIOD) {
        stDir[i] = cs[i].c > upperBand[i] ? 1 : -1;
      } else {
        if (stDir[i - 1] === 1) {
          stDir[i] = cs[i].c < lowerBand[i] ? -1 : 1;
        } else {
          stDir[i] = cs[i].c > upperBand[i] ? 1 : -1;
        }
      }
    }

    interface STPos { pair: string; dir: "long" | "short"; ep: number; et: number; sl: number; }
    let pos: STPos | null = null;
    const warmup = ST_PERIOD + 2;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];
      const sp = SP[pair] ?? 4e-4;

      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / D);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP); reason = "sl";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP); reason = "sl";
        }

        if (!reason) {
          if (pos.dir === "long" && stDir[i] === -1 && stDir[i - 1] === 1) {
            xp = bar.c * (1 - sp); reason = "st-flip";
          } else if (pos.dir === "short" && stDir[i] === 1 && stDir[i - 1] === -1) {
            xp = bar.c * (1 + sp); reason = "st-flip";
          }
        }

        if (!xp && holdDays >= ST_MAX_HOLD) {
          xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }

        if (xp > 0) {
          const fee = notional * FEE * 2;
          const raw = pos.dir === "long"
            ? (xp / pos.ep - 1) * notional
            : (pos.ep / xp - 1) * notional;
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: raw - fee, reason });
          }
          pos = null;
        }
      }

      if (!pos && bar.t >= startTs && bar.t < endTs) {
        let dir: "long" | "short" | null = null;
        if (stDir[i - 1] === 1 && stDir[i - 2] === -1) dir = "long";
        else if (stDir[i - 1] === -1 && stDir[i - 2] === 1) dir = "short";
        if (!dir) continue;

        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
        const sl = dir === "long" ? ep * (1 - ST_SL_PCT) : ep * (1 + ST_SL_PCT);
        pos = { pair, dir, ep, et: bar.t, sl };
      }
    }
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  n: number; wr: number; pf: number; sharpe: number;
  pnl: number; perDay: number; maxDd: number;
}

function calcStats(trades: Trade[], daySpan: number): Stats {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, pnl: 0, perDay: 0, maxDd: 0 };

  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const wr = (wins.length / trades.length) * 100;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  let maxDd = 0, peak = 0, cum = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }

  const dailyMap = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / D);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + t.pnl);
  }
  const dr = Array.from(dailyMap.values());
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  return { n: trades.length, wr, pf, sharpe, pnl, perDay: daySpan > 0 ? pnl / daySpan : 0, maxDd };
}

function statsFromPnls(pnls: number[]): { pf: number; sharpe: number; total: number; maxDd: number; wr: number } {
  if (pnls.length === 0) return { pf: 0, sharpe: 0, total: 0, maxDd: 0, wr: 0 };
  const total = pnls.reduce((s, p) => s + p, 0);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const gw = wins.reduce((s, p) => s + p, 0);
  const gl = Math.abs(losses.reduce((s, p) => s + p, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
  const wr = (wins.length / pnls.length) * 100;
  let cum = 0, peak = 0, maxDd = 0;
  for (const p of pnls) {
    cum += p; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum;
  }
  const mean = total / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  return { pf, sharpe, total, maxDd, wr };
}

// ─── Helpers ────────────────────────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function rankPct(value: number, sorted: number[]): number {
  let count = 0;
  for (const v of sorted) { if (v < value) count++; }
  return (count / sorted.length) * 100;
}

function printStats(label: string, s: Stats): void {
  console.log(`${label}`);
  console.log(`  Trades: ${s.n}  WR: ${s.wr.toFixed(1)}%  PF: ${s.pf === Infinity ? "inf" : s.pf.toFixed(2)}`);
  console.log(`  PnL: ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}  $/day: ${s.perDay >= 0 ? "+" : ""}$${s.perDay.toFixed(2)}  Sharpe: ${s.sharpe.toFixed(2)}  MaxDD: $${s.maxDd.toFixed(2)}`);
}

function buildDailyPnl(trades: Trade[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / D);
    m.set(day, (m.get(day) ?? 0) + t.pnl);
  }
  return m;
}

function correlation(mapA: Map<number, number>, mapB: Map<number, number>): number {
  const allDays = new Set<number>([...mapA.keys(), ...mapB.keys()]);
  const aVals: number[] = [];
  const bVals: number[] = [];
  for (const d of allDays) {
    aVals.push(mapA.get(d) ?? 0);
    bVals.push(mapB.get(d) ?? 0);
  }
  if (aVals.length < 2) return 0;
  const aMean = aVals.reduce((s, v) => s + v, 0) / aVals.length;
  const bMean = bVals.reduce((s, v) => s + v, 0) / bVals.length;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < aVals.length; i++) {
    const da = aVals[i] - aMean;
    const db = bVals[i] - bMean;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

// ════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════

console.log("=".repeat(80));
console.log("  MULTI-TIMEFRAME Z-SCORE STRATEGY VALIDATION");
console.log("  1h z>4.5 AND 4h z>3.0 = LONG | 1h z<-3.0 AND 4h z<-3.0 = SHORT");
console.log("  EMA(9/21) filter + BTC filter | SL 4%, no TP, max hold 168h (7d)");
console.log("  $5 margin, 10x leverage, 13 pairs");
console.log("=".repeat(80));

console.log("\nLoading and aggregating 5m -> 1h + 4h candles...");
const pdm = new Map<string, PairMTF>();
const allToLoad = [...new Set([...PAIRS, "BTC"])];
for (const p of allToLoad) {
  const d = precompute(p);
  if (d) {
    pdm.set(p, d);
  } else {
    console.log(`  [SKIP] ${p} - insufficient data`);
  }
}
const btcData = pdm.get("BTC");
if (!btcData) { console.error("BTC data missing."); process.exit(1); }
const btcH1 = btcData.h1;

const availPairs = PAIRS.filter(p => pdm.has(p));
console.log(`Loaded: ${availPairs.length} pairs + BTC`);

// Load daily data for Donchian + Supertrend correlation
console.log("\nLoading daily candles for Donchian+Supertrend...");
const dailyData = new Map<string, C[]>();
const allDailyPairs = [...new Set([...DONCH_PAIRS, "BTC"])];
for (const p of allDailyPairs) {
  const raw = load5m(p);
  if (raw.length === 0) { console.log(`  [SKIP] ${p} - no 5m data`); continue; }
  dailyData.set(p, aggregateDaily(raw));
}
const btcDaily = dailyData.get("BTC");
if (!btcDaily) { console.error("BTC daily data missing."); process.exit(1); }
console.log(`Loaded: ${dailyData.size} daily pairs`);

// ─── Baseline ───────────────────────────────────────────────────────
const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

console.log("\n" + "=".repeat(80));
console.log("  BASELINE: Multi-TF Z-Score Full Period and OOS");
console.log("=".repeat(80));

const fullTrades = simMTF(pdm, btcH1, FULL_START, FULL_END, availPairs);
const oosTrades = simMTF(pdm, btcH1, OOS_START, FULL_END, availPairs);

printStats("\nFull Period (2023-01 to 2026-03)", calcStats(fullTrades, fullDays));
const reasons = new Map<string, number>();
for (const t of fullTrades) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
console.log(`  Exits: ${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);

printStats("\nOOS (2025-09 to 2026-03)", calcStats(oosTrades, oosDays));
const oosReasons = new Map<string, number>();
for (const t of oosTrades) oosReasons.set(t.reason, (oosReasons.get(t.reason) ?? 0) + 1);
console.log(`  Exits: ${[...oosReasons.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);

const fullPnls = fullTrades.map(t => t.pnl);
const actualStats = calcStats(fullTrades, fullDays);

let testsPassed = 0;
let totalTests = 0;

// ════════════════════════════════════════════════════════════════════
// TEST 1: RANDOM ENTRY (200 iterations)
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 1: RANDOM ENTRY TEST (200 iterations)");
console.log("  Same exits (4% SL, 168h max hold), random entries.");
console.log("=".repeat(80));
totalTests++;

// Calculate actual signal frequency
let totalSignals = 0;
let totalBars = 0;
for (const p of availPairs) {
  const d = pdm.get(p);
  if (!d) continue;
  totalBars += d.h1.candles.filter(c => c.t >= FULL_START && c.t < FULL_END).length;
  totalSignals += fullTrades.filter(t => t.pair === p).length;
}
const avgBarsPer = totalBars > 0 ? totalSignals / totalBars : 0.001;
const adjFreq = avgBarsPer * 2.0; // boost to compensate for blocking

console.log(`\nActual: ${totalSignals} entries across ${totalBars} pair-bars = ${(avgBarsPer * 100).toFixed(3)}%`);
console.log(`Random entry prob per bar: ${(adjFreq * 100).toFixed(3)}% (2x boost for blocking)\n`);

const RAND_ITERS = 200;
const randPFs: number[] = [];
const randSharpes: number[] = [];
const randNs: number[] = [];

for (let i = 0; i < RAND_ITERS; i++) {
  const rt = simRandomEntry(pdm, FULL_START, FULL_END, availPairs, adjFreq);
  const m = calcStats(rt, fullDays);
  randPFs.push(m.pf);
  randSharpes.push(m.sharpe);
  randNs.push(m.n);
}

randPFs.sort((a, b) => a - b);
randSharpes.sort((a, b) => a - b);
randNs.sort((a, b) => a - b);

const randPFgt1 = randPFs.filter(pf => pf > 1.0).length;
const mtfPFrank = rankPct(actualStats.pf, randPFs);
const mtfShRank = rankPct(actualStats.sharpe, randSharpes);

console.log(`Avg random trades per run: ${(randNs.reduce((s, n) => s + n, 0) / RAND_ITERS).toFixed(0)} (actual: ${fullTrades.length})`);
console.log(`Random PF > 1.0: ${randPFgt1}/${RAND_ITERS} (${(randPFgt1 / RAND_ITERS * 100).toFixed(1)}%)`);
console.log(`Random PF > actual (${actualStats.pf === Infinity ? "inf" : actualStats.pf.toFixed(2)}): ${randPFs.filter(pf => pf > actualStats.pf).length}/${RAND_ITERS}`);
console.log(`MTF PF percentile vs random: ${mtfPFrank.toFixed(1)}%`);
console.log(`MTF Sharpe percentile vs random: ${mtfShRank.toFixed(1)}%`);
console.log(`\nRandom PF dist: 5th=${percentile(randPFs, 5).toFixed(2)}, 50th=${percentile(randPFs, 50).toFixed(2)}, 95th=${percentile(randPFs, 95).toFixed(2)}`);
console.log(`Random Sharpe dist: 5th=${percentile(randSharpes, 5).toFixed(2)}, 50th=${percentile(randSharpes, 50).toFixed(2)}, 95th=${percentile(randSharpes, 95).toFixed(2)}`);

const re1Verdict = mtfPFrank >= 95 ? "PASS" : mtfPFrank >= 75 ? "WARNING" : "FAIL";
console.log(`\np-value (entry edge): ${((100 - mtfPFrank) / 100).toFixed(3)}`);
console.log(`Verdict: ${re1Verdict}`);
if (re1Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 2: BOOTSTRAP CI (500 iterations)
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 2: BOOTSTRAP CONFIDENCE INTERVALS (500 iterations)");
console.log("  Resample trades with replacement. Report 5th/50th/95th percentile PF.");
console.log("=".repeat(80));
totalTests++;

const BS_ITERS = 500;
const bsPFs: number[] = [];
const bsSharpes: number[] = [];
const bsTotals: number[] = [];

for (let i = 0; i < BS_ITERS; i++) {
  const sample: number[] = [];
  for (let j = 0; j < fullPnls.length; j++) {
    sample.push(fullPnls[Math.floor(Math.random() * fullPnls.length)]);
  }
  const m = statsFromPnls(sample);
  bsPFs.push(m.pf);
  bsSharpes.push(m.sharpe);
  bsTotals.push(m.total);
}

bsPFs.sort((a, b) => a - b);
bsSharpes.sort((a, b) => a - b);
bsTotals.sort((a, b) => a - b);

console.log("\nMetric        5th pct    50th pct   95th pct");
console.log("-".repeat(55));
console.log(`PF            ${percentile(bsPFs, 5).toFixed(2).padStart(8)}  ${percentile(bsPFs, 50).toFixed(2).padStart(8)}  ${percentile(bsPFs, 95).toFixed(2).padStart(8)}`);
console.log(`Sharpe        ${percentile(bsSharpes, 5).toFixed(2).padStart(8)}  ${percentile(bsSharpes, 50).toFixed(2).padStart(8)}  ${percentile(bsSharpes, 95).toFixed(2).padStart(8)}`);
console.log(`Total PnL     $${percentile(bsTotals, 5).toFixed(0).padStart(6)}  $${percentile(bsTotals, 50).toFixed(0).padStart(6)}  $${percentile(bsTotals, 95).toFixed(0).padStart(6)}`);

const pf5th = percentile(bsPFs, 5);
const bs2Verdict = pf5th > 1.0 ? "PASS" : pf5th > 0.8 ? "WARNING" : "FAIL";
console.log(`\n5th percentile PF: ${pf5th.toFixed(2)} -- ${pf5th > 1.0 ? "profitable even in worst-case bootstrap" : "NOT profitable in worst case"}`);
console.log(`95% CI for PF: [${percentile(bsPFs, 2.5).toFixed(2)}, ${percentile(bsPFs, 97.5).toFixed(2)}]`);
console.log(`Verdict: ${bs2Verdict}`);
if (bs2Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 3: 4-QUARTER STATIONARITY
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 3: 4-QUARTER STATIONARITY");
console.log("  Split full period into 4 equal quarters. All 4 must be profitable.");
console.log("=".repeat(80));
totalTests++;

const sortedTrades = [...fullTrades].sort((a, b) => a.et - b.et);
const firstEntry = sortedTrades[0]?.et ?? FULL_START;
const lastEntry = sortedTrades[sortedTrades.length - 1]?.et ?? FULL_END;
const qLen = (lastEntry - firstEntry) / 4;

console.log(`\n${"Quarter".padEnd(10)} ${"Period".padEnd(25)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"Sharpe".padStart(7)} ${"PnL".padStart(10)} ${"$/day".padStart(8)}`);
console.log("-".repeat(85));

let stableQ = 0;
const qPFs: number[] = [];
const qPnls: number[] = [];

for (let q = 0; q < 4; q++) {
  const qStart = firstEntry + q * qLen;
  const qEnd = firstEntry + (q + 1) * qLen;
  const qTrades = sortedTrades.filter(t => t.et >= qStart && t.et < qEnd);
  const qDays = qLen / D;
  const qS = calcStats(qTrades, qDays);

  qPFs.push(qS.pf);
  qPnls.push(qS.pnl);
  if (qS.pnl > 0) stableQ++;

  const startLabel = new Date(qStart).toISOString().slice(0, 10);
  const endLabel = new Date(qEnd).toISOString().slice(0, 10);
  console.log(`Q${q + 1}        ${(startLabel + " - " + endLabel).padEnd(25)} ${String(qS.n).padStart(7)} ${qS.wr.toFixed(1).padStart(6)} ${(qS.pf === Infinity ? "inf" : qS.pf.toFixed(2)).padStart(6)} ${qS.sharpe.toFixed(2).padStart(7)} ${(qS.pnl >= 0 ? "+" : "") + "$" + qS.pnl.toFixed(2).padStart(8)} ${(qS.perDay >= 0 ? "+" : "") + "$" + qS.perDay.toFixed(2).padStart(6)}`);
}

const st3Verdict = stableQ === 4 ? "PASS" : stableQ >= 3 ? "WARNING" : "FAIL";
console.log(`\nProfitable quarters: ${stableQ}/4`);
console.log(`PF range: ${Math.min(...qPFs).toFixed(2)} - ${Math.max(...qPFs) === Infinity ? "inf" : Math.max(...qPFs).toFixed(2)}`);
console.log(`Verdict: ${st3Verdict}`);
if (st3Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 4: DIRECTION BIAS
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 4: DIRECTION BIAS");
console.log("  Longs AND shorts must both be profitable.");
console.log("=".repeat(80));
totalTests++;

const longTrades = fullTrades.filter(t => t.dir === "long");
const shortTrades = fullTrades.filter(t => t.dir === "short");

const longStats = calcStats(longTrades, fullDays);
const shortStats = calcStats(shortTrades, fullDays);

printStats("\nLONGS", longStats);
printStats("SHORTS", shortStats);

const longProfit = longStats.pnl > 0;
const shortProfit = shortStats.pnl > 0;
const dir4Verdict = longProfit && shortProfit ? "PASS" : (longProfit || shortProfit) ? "WARNING" : "FAIL";
console.log(`\nLongs profitable: ${longProfit ? "YES" : "NO"} | Shorts profitable: ${shortProfit ? "YES" : "NO"}`);
console.log(`Verdict: ${dir4Verdict}`);
if (dir4Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 5: SPREAD STRESS
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 5: SPREAD STRESS TEST");
console.log("  Profitable at 2x and 3x spreads?");
console.log("=".repeat(80));
totalTests++;

const trades2x = simMTF(pdm, btcH1, FULL_START, FULL_END, availPairs, { spreadMult: 2 });
const trades3x = simMTF(pdm, btcH1, FULL_START, FULL_END, availPairs, { spreadMult: 3 });

const stats2x = calcStats(trades2x, fullDays);
const stats3x = calcStats(trades3x, fullDays);

printStats("\n1x spread (baseline)", actualStats);
printStats("2x spread", stats2x);
printStats("3x spread", stats3x);

const sp2xOk = stats2x.pnl > 0;
const sp3xOk = stats3x.pnl > 0;
const sp5Verdict = sp2xOk && sp3xOk ? "PASS" : sp2xOk ? "WARNING" : "FAIL";
console.log(`\n2x profitable: ${sp2xOk ? "YES" : "NO"} | 3x profitable: ${sp3xOk ? "YES" : "NO"}`);
console.log(`Verdict: ${sp5Verdict}`);
if (sp5Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 6: PARAMETER NEIGHBORS
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 6: PARAMETER NEIGHBOR TEST");
console.log("  1h z [3.5, 4.0, 4.5, 5.0] x 4h z [2.0, 2.5, 3.0, 3.5]. All profitable?");
console.log("=".repeat(80));
totalTests++;

const z1hGrid = [3.5, 4.0, 4.5, 5.0];
const z4hGrid = [2.0, 2.5, 3.0, 3.5];

console.log(`\n${"1h z\\4h z".padEnd(10)} ${z4hGrid.map(z => z.toFixed(1).padStart(10)).join("")}`);
console.log("-".repeat(10 + z4hGrid.length * 10));

let neighborsProfitable = 0;
let neighborsTotal = 0;

for (const z1 of z1hGrid) {
  const row: string[] = [];
  for (const z4 of z4hGrid) {
    neighborsTotal++;
    const trades = simMTF(pdm, btcH1, FULL_START, FULL_END, availPairs, {
      zLong1h: z1, zShort1h: -3.0, zLong4h: z4, zShort4h: -3.0,
    });
    const s = calcStats(trades, fullDays);
    const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(0)}` : `-$${Math.abs(s.pnl).toFixed(0)}`;
    const pfStr = s.pf === Infinity ? "inf" : s.pf.toFixed(2);
    row.push(`${pnlStr}/${pfStr}`.padStart(10));
    if (s.pnl > 0) neighborsProfitable++;
  }
  console.log(`z1h=${z1.toFixed(1)}   ${row.join("")}`);
}

const pn6Pct = (neighborsProfitable / neighborsTotal) * 100;
const pn6Verdict = pn6Pct === 100 ? "PASS" : pn6Pct >= 75 ? "WARNING" : "FAIL";
console.log(`\nProfitable neighbors: ${neighborsProfitable}/${neighborsTotal} (${pn6Pct.toFixed(0)}%)`);
console.log(`Verdict: ${pn6Verdict}`);
if (pn6Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 7: CORRELATION WITH DONCHIAN + SUPERTREND
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 7: CORRELATION WITH DONCHIAN + SUPERTREND");
console.log("  Daily P&L correlation. Low = good portfolio fit.");
console.log("=".repeat(80));
totalTests++;

const donchTrades = simDonchianDaily(dailyData, btcDaily, FULL_START, FULL_END, DONCH_PAIRS);
const stTrades = simSupertrendDaily(dailyData, FULL_START, FULL_END, DONCH_PAIRS);

printStats("\nDonchian Daily (full period)", calcStats(donchTrades, fullDays));
printStats("Supertrend Daily (full period)", calcStats(stTrades, fullDays));

const mtfDaily = buildDailyPnl(fullTrades);
const donchDaily = buildDailyPnl(donchTrades);
const stDaily = buildDailyPnl(stTrades);

const corrMD = correlation(mtfDaily, donchDaily);
const corrMS = correlation(mtfDaily, stDaily);
const corrDS = correlation(donchDaily, stDaily);

console.log(`\nDaily PnL Correlation Matrix:`);
console.log(`  MTF-Donchian:         ${corrMD.toFixed(3)}`);
console.log(`  MTF-Supertrend:       ${corrMS.toFixed(3)}`);
console.log(`  Donchian-Supertrend:  ${corrDS.toFixed(3)}`);

const lowCorr = Math.abs(corrMD) < 0.3 && Math.abs(corrMS) < 0.3;
console.log(`\n${lowCorr ? "Low correlation: strategies complement each other" : "Moderate/high correlation: limited diversification benefit"}`);
const co7Verdict = lowCorr ? "PASS" : Math.abs(corrMD) < 0.5 && Math.abs(corrMS) < 0.5 ? "WARNING" : "FAIL";
console.log(`Verdict: ${co7Verdict}`);
if (co7Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 8: PER-PAIR BREAKDOWN
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 8: PER-PAIR BREAKDOWN");
console.log("  Which pairs win/lose?");
console.log("=".repeat(80));
totalTests++;

console.log(`\n${"Pair".padEnd(8)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"PnL".padStart(10)} ${"Avg PnL".padStart(8)} ${"Win".padStart(5)} ${"Lose".padStart(5)}`);
console.log("-".repeat(60));

let pairsProfit = 0;
let pairsTotal = 0;
const pairRows: { pair: string; pnl: number; trades: number; wr: number; pf: number; wins: number; losses: number }[] = [];

for (const p of availPairs) {
  const pTrades = fullTrades.filter(t => t.pair === p);
  if (pTrades.length === 0) continue;
  pairsTotal++;

  const pnl = pTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = pTrades.filter(t => t.pnl > 0);
  const losses = pTrades.filter(t => t.pnl <= 0);
  const wr = (wins.length / pTrades.length) * 100;
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
  if (pnl > 0) pairsProfit++;

  pairRows.push({ pair: p, pnl, trades: pTrades.length, wr, pf, wins: wins.length, losses: losses.length });
}

pairRows.sort((a, b) => b.pnl - a.pnl);
for (const r of pairRows) {
  const pfStr = r.pf === Infinity ? "inf" : r.pf.toFixed(2);
  console.log(`${r.pair.padEnd(8)} ${String(r.trades).padStart(7)} ${r.wr.toFixed(1).padStart(6)} ${pfStr.padStart(6)} ${(r.pnl >= 0 ? "+" : "") + "$" + r.pnl.toFixed(2).padStart(8)} ${("$" + (r.pnl / r.trades).toFixed(2)).padStart(8)} ${String(r.wins).padStart(5)} ${String(r.losses).padStart(5)}`);
}

const pp8Pct = pairsTotal > 0 ? (pairsProfit / pairsTotal) * 100 : 0;
const pp8Verdict = pp8Pct >= 70 ? "PASS" : pp8Pct >= 50 ? "WARNING" : "FAIL";
console.log(`\nProfitable pairs: ${pairsProfit}/${pairsTotal} (${pp8Pct.toFixed(0)}%)`);
console.log(`Verdict: ${pp8Verdict}`);
if (pp8Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// FINAL VERDICT
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  FINAL VERDICT");
console.log("=".repeat(80));

const verdicts = [
  { name: "Random Entry (200 runs)", result: re1Verdict },
  { name: "Bootstrap CI (500 runs)", result: bs2Verdict },
  { name: "4-Quarter Stationarity", result: st3Verdict },
  { name: "Direction Bias", result: dir4Verdict },
  { name: "Spread Stress (2x+3x)", result: sp5Verdict },
  { name: "Parameter Neighbors", result: pn6Verdict },
  { name: "Correlation w/ Donchian+ST", result: co7Verdict },
  { name: "Per-Pair Breakdown", result: pp8Verdict },
];

console.log("");
for (const v of verdicts) {
  console.log(`  ${v.result.padEnd(8)} ${v.name}`);
}

const passed = verdicts.filter(v => v.result === "PASS").length;
const warned = verdicts.filter(v => v.result === "WARNING").length;
const failed = verdicts.filter(v => v.result === "FAIL").length;

console.log(`\nPASS: ${passed}  WARNING: ${warned}  FAIL: ${failed}`);
console.log(`OOS PnL: ${actualStats.pnl >= 0 ? "+" : ""}$${calcStats(oosTrades, oosDays).pnl.toFixed(2)}/day`);

const deploy = passed >= 6 && failed === 0;
console.log(`\nDEPLOY: ${deploy ? "YES" : "NO"}`);
if (!deploy) {
  const failReasons: string[] = [];
  if (failed > 0) failReasons.push(`${failed} test(s) failed`);
  if (passed < 6) failReasons.push(`only ${passed}/8 passed (need 6+)`);
  console.log(`Reason: ${failReasons.join(", ")}`);
}
console.log("");
