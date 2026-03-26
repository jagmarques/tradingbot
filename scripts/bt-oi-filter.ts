/**
 * OI-Proxy (Volume) Filter Backtest
 *
 * Tests volume-based filters as OI proxy on Supertrend(14, 1.75) 4h.
 * Academic research shows volume and OI are highly correlated in crypto perps.
 * Since we lack historical OI data, volume spikes proxy for OI changes.
 *
 * Filters:
 * 0. Baseline: Supertrend(14, 1.75) 4h unfiltered
 * 1. Volume Confirmation: flip bar volume > 1.5x 20-bar avg
 * 2. Volume + Price Agreement: volume > 1.5x avg AND range > 1.5x ATR
 * 3. Anti-Low-Volume: skip when volume < 0.5x 20-bar avg
 * 4. Volume Trend: 3-bar volume SMA increasing (each bar higher)
 * 5. Volume Spike Contrarian: skip climax (>3x avg), only enter 1.0-2.5x avg
 * 6. Combined Best: volume > 1.2x avg AND range > 1.0x ATR AND no climax (<3x)
 *
 * Also tests best filter on GARCH v2 MTF z-score engine.
 *
 * Data: 5m candles from /tmp/bt-pair-cache-5m/, aggregated to 4h (and 1h for GARCH).
 * OOS: 2025-09-01 onwards. Full: 2023-01 to 2026-03.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-oi-filter.ts
 */

import * as fs from "fs";
import * as path from "path";
import { EMA } from "technicalindicators";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;

// Supertrend config
const ST_LEV = 10;
const ST_SIZE = 3; // $3 margin
const ST_NOT = ST_SIZE * ST_LEV; // $30 notional
const ST_ATR_PERIOD = 14;
const ST_MULT = 1.75;
const ST_SL_ATR_MULT = 3.0;
const ST_SL_MAX_PCT = 0.035;
const ST_STAG_BARS = 12; // 48h at 4h bars

// GARCH MTF z-score config
const GR_LEV = 10;
const GR_SIZE = 5; // $5 margin
const GR_NOT = GR_SIZE * GR_LEV; // $50 notional
const Z_LONG_1H = 4.5;
const Z_SHORT_1H = -3.0;
const Z_LONG_4H = 3.0;
const Z_SHORT_4H = -3.0;
const MOM_LB = 3;
const VOL_WIN = 20;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const GR_SL_PCT = 0.04;
const MAX_HOLD_H = 168;

// Spread map
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.2e-4, SOL: 1.6e-4,
  TIA: 3.8e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const ST_PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

const GR_PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
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
      v: grp.reduce((s, b) => s + b.v, 0),
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
      for (let j = 1; j <= period; j++) {
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
      }
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

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      const prevUpper = (cs[i - 1].h + cs[i - 1].l) / 2 + mult * atr[i - 1];
      const prevLower = (cs[i - 1].h + cs[i - 1].l) / 2 - mult * atr[i - 1];
      const prevFinalUpper = st[i - 1] > 0 && dirs[i - 1] === -1 ? st[i - 1] : prevUpper;
      const prevFinalLower = st[i - 1] > 0 && dirs[i - 1] === 1 ? st[i - 1] : prevLower;

      if (!(lowerBand > prevFinalLower || cs[i - 1].c < prevFinalLower)) {
        lowerBand = prevFinalLower;
      }
      if (!(upperBand < prevFinalUpper || cs[i - 1].c > prevFinalUpper)) {
        upperBand = prevFinalUpper;
      }
    }

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

// Volume helper: 20-bar SMA of volume
function volAvg(cs: C[], idx: number, period: number = 20): number {
  if (idx < period) return 0;
  let s = 0;
  for (let j = idx - period; j < idx; j++) s += cs[j].v;
  return s / period;
}

// ─── Cost Helpers ───────────────────────────────────────────────────
function stTradePnl(pair: string, ep: number, xp: number, dir: "long" | "short", isSL: boolean): number {
  const sp = SP[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? SL_SLIP : 1);
  const fees = ST_NOT * FEE * 2;
  const rawPnl = dir === "long" ? (xp / ep - 1) * ST_NOT : (ep / xp - 1) * ST_NOT;
  return rawPnl - entrySlip * (ST_NOT / ep) - exitSlip * (ST_NOT / xp) - fees;
}

function grTradePnl(pair: string, ep: number, xp: number, dir: "long" | "short", isSL: boolean): number {
  const sp = SP[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? SL_SLIP : 1);
  const fees = GR_NOT * FEE * 2;
  const rawPnl = dir === "long" ? (xp / ep - 1) * GR_NOT : (ep / xp - 1) * GR_NOT;
  return rawPnl - entrySlip * (GR_NOT / ep) - exitSlip * (GR_NOT / xp) - fees;
}

// ─── OI Filter definitions ──────────────────────────────────────────
type VolFilter = (cs: C[], atr: number[], idx: number) => boolean;

const filters: { name: string; fn: VolFilter }[] = [
  {
    name: "0. Baseline (no filter)",
    fn: () => true,
  },
  {
    name: "1. Volume Confirm (>1.5x avg)",
    fn: (cs, _atr, idx) => {
      const avg = volAvg(cs, idx);
      return avg > 0 && cs[idx].v > 1.5 * avg;
    },
  },
  {
    name: "2. Vol+Range (v>1.5x, range>1.5xATR)",
    fn: (cs, atr, idx) => {
      const avg = volAvg(cs, idx);
      if (avg <= 0 || atr[idx] <= 0) return false;
      const range = cs[idx].h - cs[idx].l;
      return cs[idx].v > 1.5 * avg && range > 1.5 * atr[idx];
    },
  },
  {
    name: "3. Anti-Low-Vol (skip <0.5x avg)",
    fn: (cs, _atr, idx) => {
      const avg = volAvg(cs, idx);
      return avg > 0 && cs[idx].v >= 0.5 * avg;
    },
  },
  {
    name: "4. Volume Trend (3-bar SMA rising)",
    fn: (cs, _atr, idx) => {
      if (idx < 23) return false; // need 20+3 bars
      // 3-bar SMA: bars [idx-2, idx-1, idx] each avg
      const sma0 = (cs[idx].v + cs[idx - 1].v + cs[idx - 2].v) / 3;
      const sma1 = (cs[idx - 1].v + cs[idx - 2].v + cs[idx - 3].v) / 3;
      const sma2 = (cs[idx - 2].v + cs[idx - 3].v + cs[idx - 4].v) / 3;
      return sma0 > sma1 && sma1 > sma2;
    },
  },
  {
    name: "5. Spike Contrarian (1.0-2.5x only)",
    fn: (cs, _atr, idx) => {
      const avg = volAvg(cs, idx);
      if (avg <= 0) return false;
      const ratio = cs[idx].v / avg;
      return ratio >= 1.0 && ratio <= 2.5;
    },
  },
  {
    name: "6. Combined (v>1.2x, range>1xATR, <3x)",
    fn: (cs, atr, idx) => {
      const avg = volAvg(cs, idx);
      if (avg <= 0 || atr[idx] <= 0) return false;
      const ratio = cs[idx].v / avg;
      const range = cs[idx].h - cs[idx].l;
      return ratio > 1.2 && ratio < 3.0 && range > 1.0 * atr[idx];
    },
  },
];

// ─── Supertrend Strategy with Volume Filter ─────────────────────────
function simSupertrend(
  pairs: string[],
  data4h: Map<string, C[]>,
  startTs: number,
  endTs: number,
  filterFn: VolFilter,
): Trade[] {
  const trades: Trade[] = [];

  for (const pair of pairs) {
    const cs = data4h.get(pair);
    if (!cs || cs.length < ST_ATR_PERIOD + 30) continue;

    const { dir } = calcSupertrend(cs, ST_ATR_PERIOD, ST_MULT);
    const atr = calcATR(cs, ST_ATR_PERIOD);
    let pos: {
      dir: "long" | "short"; ep: number; et: number;
      sl: number; entryIdx: number;
    } | null = null;

    for (let i = ST_ATR_PERIOD + 1; i < cs.length; i++) {
      const bar = cs[i];
      const prevDir = dir[i - 1];
      const prevPrevDir = i >= 2 ? dir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // EXIT LOGIC
      if (pos) {
        let xp = 0;
        let reason = "";
        let isSL = false;

        // SL check
        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl; reason = "sl"; isSL = true;
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl; reason = "sl"; isSL = true;
        }

        // Stagnation (48h = 12 x 4h bars)
        if (!xp) {
          const barsHeld = i - pos.entryIdx;
          if (barsHeld >= ST_STAG_BARS) {
            xp = bar.c; reason = "stag";
          }
        }

        // Supertrend flip exit
        if (!xp && flipped) {
          xp = bar.o; reason = "flip";
        }

        if (xp > 0) {
          const pnl = stTradePnl(pair, pos.ep, xp, pos.dir, isSL);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason });
          }
          pos = null;
        }
      }

      // ENTRY LOGIC
      if (!pos && flipped && bar.t >= startTs && bar.t < endTs) {
        const newDir: "long" | "short" = prevDir === 1 ? "long" : "short";

        // Volume filter
        if (!filterFn(cs, atr, i)) continue;

        // ATR stop-loss
        const curATR = atr[i] || atr[i - 1];
        let slDist = curATR * ST_SL_ATR_MULT;
        const maxDist = bar.o * ST_SL_MAX_PCT;
        if (slDist > maxDist) slDist = maxDist;
        const sl = newDir === "long" ? bar.o - slDist : bar.o + slDist;

        pos = { dir: newDir, ep: bar.o, et: bar.t, sl, entryIdx: i };
      }
    }

    // Close any open position at end
    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = cs[cs.length - 1];
      const pnl = stTradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ─── GARCH MTF Z-Score helpers ──────────────────────────────────────
interface TFData {
  candles: C[];
  tsMap: Map<number, number>;
  zScores: number[];
  ema9: number[];
  ema21: number[];
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

function getVal(arr: number[], barIdx: number, candleLen: number): number | null {
  const offset = candleLen - arr.length;
  const idx = barIdx - offset;
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

interface PairMTF { h1: TFData; h4: TFData; h1Candles: C[]; }

function precomputeMTF(pair: string, bars5m: C[]): PairMTF | null {
  if (bars5m.length < 200) return null;
  const h1Candles = aggregate(bars5m, H, 10);
  const h4Candles = aggregate(bars5m, H4, 40);
  const h1 = buildTFData(h1Candles);
  const h4 = buildTFData(h4Candles);
  if (!h1 || !h4) return null;
  return { h1, h4, h1Candles };
}

function mtfSignal(
  pd: PairMTF, barIdx1h: number, btcH1: TFData,
): "long" | "short" | null {
  const prev = barIdx1h - 1;
  if (prev < VOL_WIN + MOM_LB) return null;

  const z1h = pd.h1.zScores[prev];
  if (isNaN(z1h) || z1h === 0) return null;

  const goLong = z1h > Z_LONG_1H;
  const goShort = z1h < Z_SHORT_1H;
  if (!goLong && !goShort) return null;

  // 4h z-score confirmation
  const ts1h = pd.h1.candles[prev].t;
  const ts4h = Math.floor(ts1h / H4) * H4;
  const idx4h = pd.h4.tsMap.get(ts4h);
  if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) return null;

  const z4h = pd.h4.zScores[idx4h];
  if (goLong && z4h <= Z_LONG_4H) return null;
  if (goShort && z4h >= Z_SHORT_4H) return null;

  // EMA 9/21 filter on 1h
  const e9 = getVal(pd.h1.ema9, prev, pd.h1.candles.length);
  const e21 = getVal(pd.h1.ema21, prev, pd.h1.candles.length);
  if (e9 === null || e21 === null) return null;
  if (goLong && e9 <= e21) return null;
  if (goShort && e9 >= e21) return null;

  // BTC EMA filter
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

// ─── GARCH MTF Simulation with Volume Filter ────────────────────────
function simGARCH(
  pdm: Map<string, PairMTF>,
  btcH1: TFData,
  data4h: Map<string, C[]>, // for volume filter on 4h bars
  startTs: number,
  endTs: number,
  pairs: string[],
  filterFn: VolFilter,
): Trade[] {
  const pd = new Map<string, PairMTF>();
  for (const p of pairs) { const d = pdm.get(p); if (d) pd.set(p, d); }

  // Precompute 4h ATR for volume filter
  const atr4hMap = new Map<string, number[]>();
  for (const p of pairs) {
    const cs = data4h.get(p);
    if (cs) atr4hMap.set(p, calcATR(cs, 14));
  }

  const allTs = new Set<number>();
  for (const d of pd.values()) {
    for (const c of d.h1.candles) {
      if (c.t >= startTs && c.t < endTs) allTs.add(c.t);
    }
  }
  const sorted = [...allTs].sort((a, b) => a - b);

  interface Pos {
    pair: string; direction: "long" | "short";
    entryPrice: number; entryTime: number; stopLoss: number;
  }
  const open = new Map<string, Pos>();
  const trades: Trade[] = [];

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // EXITS
    for (const [p, pos] of open) {
      const d = pd.get(p)!;
      const bi = d.h1.tsMap.get(ts) ?? -1;
      if (bi < 0) continue;
      const bar = d.h1.candles[bi];
      const sp = SP[p] ?? 4e-4;
      let exitPrice = 0, reason = "";

      // SL
      if (pos.direction === "long" && bar.l <= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 - sp * SL_SLIP); reason = "sl";
      } else if (pos.direction === "short" && bar.h >= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 + sp * SL_SLIP); reason = "sl";
      }

      // Max hold
      if (!reason) {
        const barsHeld = Math.floor((ts - pos.entryTime) / H);
        if (barsHeld >= MAX_HOLD_H) {
          exitPrice = pos.direction === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }
      }

      if (reason) {
        const fee = GR_NOT * FEE * 2;
        const raw = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * GR_NOT
          : (pos.entryPrice / exitPrice - 1) * GR_NOT;
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

      const dir = mtfSignal(d, bi, btcH1);
      if (!dir) continue;

      // Volume filter: check the covering 4h bar
      const cs4h = data4h.get(p);
      const atr4h = atr4hMap.get(p);
      if (cs4h && atr4h) {
        const ts4h = Math.floor(ts / H4) * H4;
        // find 4h bar index
        let barIdx4h = -1;
        for (let k = cs4h.length - 1; k >= 0; k--) {
          if (cs4h[k].t <= ts4h) { barIdx4h = k; break; }
        }
        if (barIdx4h >= 20) {
          if (!filterFn(cs4h, atr4h, barIdx4h)) continue;
        }
      }

      const entryRaw = d.h1.candles[bi].o;
      const sp = SP[p] ?? 4e-4;
      const entry = dir === "long" ? entryRaw * (1 + sp) : entryRaw * (1 - sp);
      const sl = dir === "long" ? entry * (1 - GR_SL_PCT) : entry * (1 + GR_SL_PCT);

      open.set(p, { pair: p, direction: dir, entryPrice: entry, entryTime: ts, stopLoss: sl });
    }
  }

  return trades;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  let peak = 0, equity = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const days = (endTs - startTs) / D;
  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

function fmtMetrics(m: Metrics): string {
  const pnlStr = m.total >= 0 ? `+$${m.total.toFixed(0)}` : `-$${Math.abs(m.total).toFixed(0)}`;
  return [
    `N=${String(m.n).padStart(5)}`,
    `WR=${m.wr.toFixed(1).padStart(5)}%`,
    `PF=${m.pf.toFixed(2).padStart(5)}`,
    `Sharpe=${m.sharpe.toFixed(2).padStart(6)}`,
    `$/day=${("$" + m.perDay.toFixed(2)).padStart(7)}`,
    `MaxDD=$${m.dd.toFixed(0).padStart(5)}`,
    `Total=${pnlStr.padStart(7)}`,
  ].join("  ");
}

// ─── MAIN ───────────────────────────────────────────────────────────
console.log("==========================================================");
console.log("  OI-PROXY (VOLUME) FILTER BACKTEST");
console.log("  Supertrend(14, 1.75) 4h + Volume Filters");
console.log("  Full: 2023-01 to 2026-03 | OOS: 2025-09-01");
console.log("==========================================================\n");

console.log("Loading 5m data and aggregating to 4h...");

// Load data
const raw5m = new Map<string, C[]>();
const allPairsToLoad = [...new Set([...ST_PAIRS, ...GR_PAIRS, "BTC"])];
for (const p of allPairsToLoad) {
  const bars = load5m(p);
  if (bars.length > 1000) {
    raw5m.set(p, bars);
    console.log(`  ${p}: ${bars.length} 5m bars`);
  } else {
    console.log(`  SKIP ${p}: only ${bars.length} 5m bars`);
  }
}

// Aggregate to 4h with volume
const data4h = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  const h4 = aggregate(bars, H4, 40);
  data4h.set(p, h4);
}

console.log(`\nLoaded ${data4h.size} pairs. Running Supertrend volume filter tests...\n`);

// ─── TEST 1: Supertrend with all volume filters ─────────────────────
console.log("==========================================================");
console.log("  PART 1: SUPERTREND(14, 1.75) + VOLUME FILTERS (OOS)");
console.log("==========================================================");
console.log("  Cost: Taker 0.035%, spread map, 1.5x SL slip, 10x lev, $3 size");
console.log("  SL: ATR*3 capped 3.5% | Stagnation: 48h | Exit: flip/sl/stag");
console.log("----------------------------------------------------------\n");

const stOosResults: { name: string; m: Metrics }[] = [];
const stFullResults: { name: string; m: Metrics }[] = [];

for (const filter of filters) {
  const allTrades = simSupertrend(ST_PAIRS, data4h, FULL_START, FULL_END, filter.fn);
  const oosTrades = allTrades.filter(t => t.et >= OOS_START);
  const fullTrades = allTrades.filter(t => t.et >= FULL_START);

  const oosM = calcMetrics(oosTrades, OOS_START, FULL_END);
  const fullM = calcMetrics(fullTrades, FULL_START, FULL_END);

  stOosResults.push({ name: filter.name, m: oosM });
  stFullResults.push({ name: filter.name, m: fullM });
}

// Print OOS table
console.log("OOS Results (2025-09-01 to 2026-03-26):");
console.log("-".repeat(100));
for (const r of stOosResults) {
  console.log(`  ${r.name.padEnd(42)} ${fmtMetrics(r.m)}`);
}

console.log("\nFull Period Results (2023-01 to 2026-03):");
console.log("-".repeat(100));
for (const r of stFullResults) {
  console.log(`  ${r.name.padEnd(42)} ${fmtMetrics(r.m)}`);
}

// ─── Delta vs baseline ──────────────────────────────────────────────
console.log("\n==========================================================");
console.log("  PART 2: OOS DELTA vs BASELINE");
console.log("==========================================================\n");

const baseline = stOosResults[0].m;
console.log("Filter".padEnd(42) + "  dTrades  dWR     dPF    dSharpe  d$/day   dDD");
console.log("-".repeat(100));
for (let i = 1; i < stOosResults.length; i++) {
  const r = stOosResults[i];
  const dN = r.m.n - baseline.n;
  const dWR = r.m.wr - baseline.wr;
  const dPF = r.m.pf - baseline.pf;
  const dSh = r.m.sharpe - baseline.sharpe;
  const dPD = r.m.perDay - baseline.perDay;
  const dDD = r.m.dd - baseline.dd;
  console.log(
    `  ${r.name.padEnd(40)}` +
    `  ${(dN >= 0 ? "+" : "") + dN}`.padStart(8) +
    `  ${(dWR >= 0 ? "+" : "") + dWR.toFixed(1)}%`.padStart(8) +
    `  ${(dPF >= 0 ? "+" : "") + dPF.toFixed(2)}`.padStart(7) +
    `  ${(dSh >= 0 ? "+" : "") + dSh.toFixed(2)}`.padStart(9) +
    `  ${(dPD >= 0 ? "+$" : "-$") + Math.abs(dPD).toFixed(2)}`.padStart(9) +
    `  ${(dDD >= 0 ? "+$" : "-$") + Math.abs(dDD).toFixed(0)}`.padStart(7)
  );
}

// ─── Per-pair breakdown for baseline and best filter ────────────────
console.log("\n==========================================================");
console.log("  PART 3: PER-PAIR OOS BREAKDOWN (Baseline vs Best)");
console.log("==========================================================\n");

// Find best filter by Sharpe
let bestIdx = 0;
let bestSharpe = -Infinity;
for (let i = 0; i < stOosResults.length; i++) {
  if (stOosResults[i].m.sharpe > bestSharpe) {
    bestSharpe = stOosResults[i].m.sharpe;
    bestIdx = i;
  }
}
const bestFilter = filters[bestIdx];
console.log(`Best OOS filter by Sharpe: ${bestFilter.name}\n`);

console.log("Pair".padEnd(8) + "Baseline(N/WR/PF/$/d)".padEnd(35) + "Best Filter(N/WR/PF/$/d)");
console.log("-".repeat(75));

for (const pair of ST_PAIRS) {
  const baseTrades = simSupertrend([pair], data4h, OOS_START, FULL_END, filters[0].fn);
  const bestTrades = simSupertrend([pair], data4h, OOS_START, FULL_END, bestFilter.fn);
  const bm = calcMetrics(baseTrades, OOS_START, FULL_END);
  const fm = calcMetrics(bestTrades, OOS_START, FULL_END);
  const bStr = `${bm.n}/${bm.wr.toFixed(0)}%/${bm.pf.toFixed(2)}/$${bm.perDay.toFixed(2)}`;
  const fStr = `${fm.n}/${fm.wr.toFixed(0)}%/${fm.pf.toFixed(2)}/$${fm.perDay.toFixed(2)}`;
  console.log(`  ${pair.padEnd(6)} ${bStr.padEnd(33)} ${fStr}`);
}

// ─── PART 4: GARCH MTF Z-Score with Volume Filter ──────────────────
console.log("\n==========================================================");
console.log("  PART 4: GARCH v2 MTF Z-SCORE + BEST VOLUME FILTER (OOS)");
console.log("==========================================================");
console.log("  Cost: Taker 0.035%, spread map, 1.5x SL slip, 10x lev, $5 size");
console.log("  SL: 4% fixed | Max hold: 168h | Z-score: 4.5/-3.0 (1h), 3.0/-3.0 (4h)");
console.log("----------------------------------------------------------\n");

// Precompute MTF data for GARCH pairs
console.log("Precomputing MTF data for GARCH pairs...");
const mtfData = new Map<string, PairMTF>();
for (const p of [...GR_PAIRS, "BTC"]) {
  const bars = raw5m.get(p);
  if (!bars) continue;
  const pd = precomputeMTF(p, bars);
  if (pd) {
    mtfData.set(p, pd);
    console.log(`  ${p}: h1=${pd.h1.candles.length}, h4=${pd.h4.candles.length}`);
  }
}

const btcMTF = mtfData.get("BTC");
if (!btcMTF) {
  console.log("ERROR: No BTC MTF data available");
  process.exit(1);
}

// Run baseline and best filter on GARCH
const garchFiltersToTest = [
  filters[0], // baseline
  bestFilter, // best from Supertrend test
];

// Also test all filters on GARCH for completeness
console.log("\nGARCH MTF + Volume Filters (OOS):");
console.log("-".repeat(100));

for (const filter of filters) {
  const allTrades = simGARCH(mtfData, btcMTF.h1, data4h, FULL_START, FULL_END, GR_PAIRS, filter.fn);
  const oosTrades = allTrades.filter(t => t.et >= OOS_START);
  const oosM = calcMetrics(oosTrades, OOS_START, FULL_END);
  console.log(`  ${filter.name.padEnd(42)} ${fmtMetrics(oosM)}`);
}

// GARCH full period
console.log("\nGARCH MTF + Volume Filters (Full Period):");
console.log("-".repeat(100));

for (const filter of filters) {
  const allTrades = simGARCH(mtfData, btcMTF.h1, data4h, FULL_START, FULL_END, GR_PAIRS, filter.fn);
  const fullM = calcMetrics(allTrades, FULL_START, FULL_END);
  console.log(`  ${filter.name.padEnd(42)} ${fmtMetrics(fullM)}`);
}

// ─── PART 5: Summary / Recommendations ──────────────────────────────
console.log("\n==========================================================");
console.log("  PART 5: SUMMARY");
console.log("==========================================================\n");

// Find best Supertrend filter by $/day OOS
let bestStDollar = 0;
let bestStIdx = 0;
for (let i = 0; i < stOosResults.length; i++) {
  if (stOosResults[i].m.perDay > bestStDollar) {
    bestStDollar = stOosResults[i].m.perDay;
    bestStIdx = i;
  }
}
console.log(`Best Supertrend OOS by $/day: ${filters[bestStIdx].name}`);
console.log(`  ${fmtMetrics(stOosResults[bestStIdx].m)}`);
console.log(`  vs Baseline: ${fmtMetrics(stOosResults[0].m)}\n`);

// Recap
console.log("Key findings:");
console.log(`  - Baseline Supertrend OOS: ${stOosResults[0].m.n} trades, $${stOosResults[0].m.perDay.toFixed(2)}/day, Sharpe ${stOosResults[0].m.sharpe.toFixed(2)}`);
console.log(`  - Best filter OOS:         ${stOosResults[bestStIdx].m.n} trades, $${stOosResults[bestStIdx].m.perDay.toFixed(2)}/day, Sharpe ${stOosResults[bestStIdx].m.sharpe.toFixed(2)}`);
const tradeReduction = ((stOosResults[0].m.n - stOosResults[bestStIdx].m.n) / stOosResults[0].m.n * 100);
console.log(`  - Trade reduction: ${tradeReduction.toFixed(0)}%`);
console.log(`  - Volume filters work as OI proxy: ${bestStIdx !== 0 ? "YES (improved metrics)" : "NO (baseline was best)"}`);

console.log("\nDone.");
