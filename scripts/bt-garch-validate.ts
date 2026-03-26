/**
 * GARCH v2 Deep Statistical Validation
 *
 * 7 tests: Monte Carlo, Bootstrap CI, Random Entry, Walk-Forward,
 * 4-Quarter Stationarity, Donchian+Supertrend Correlation, Combined Portfolio.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-garch-validate.ts
 */

import * as fs from "fs";
import * as path from "path";
import { ATR, ADX, EMA } from "technicalindicators";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const D = 86_400_000;
const FEE = 0.000_35; // 0.035% taker per side
const SIZE = 10;
const LEV = 10;
const NOT = SIZE * LEV; // $100 notional
const SL_SLIP = 1.5;

// GARCH v2 exact params
const Z_LONG = 4.5;
const Z_SHORT = -3.0;
const MOM_LB = 3;
const VOL_WIN = 20;
const ADX_LONG_MIN = 30;
const ADX_SHORT_MIN = 25;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const ATR_PERIOD = 14;
const VOL_LB = 5;
const VOL_RATIO = 0.9;
const SL_PCT = 0.03;
const TP_PCT = 0.10;
const MAX_HOLD = 48; // bars (1h)
const MAX_PER_DIR = 6;

// Spread map (half-spread, one side)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
};

// Pairs
const GARCH_PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "SOL",
];

// Donchian daily uses the full set
const DONCH_PAIRS = [
  "ADA", "APT", "ARB", "BTC", "DASH", "DOGE", "DOT", "ENA", "ETH",
  "LDO", "LINK", "OP", "SOL", "TIA", "TRUMP", "UNI", "WIF", "WLD", "XRP",
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
interface PairData {
  candles: C[];
  tsMap: Map<number, number>;
  zScores: number[];
  adx14: Array<{ adx: number; pdi: number; mdi: number }>;
  ema9: number[];
  ema21: number[];
  atr14: number[];
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

function aggregate1h(bars5m: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
    const hourTs = Math.floor(b.t / H) * H;
    let arr = groups.get(hourTs);
    if (!arr) { arr = []; groups.set(hourTs, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < 10) continue;
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
  const groups = new Map<number, C[]>();
  for (const c of bars5m) {
    const dk = Math.floor(c.t / D) * D;
    const a = groups.get(dk) ?? [];
    a.push(c);
    groups.set(dk, a);
  }
  const out: C[] = [];
  for (const [ts, bs] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length < 200) continue; // need most of 288 5m bars
    bs.sort((a, b) => a.t - b.t);
    out.push({
      t: ts, o: bs[0].o,
      h: Math.max(...bs.map(b => b.h)),
      l: Math.min(...bs.map(b => b.l)),
      c: bs[bs.length - 1].c,
    });
  }
  return out;
}

// ─── Indicator helpers ──────────────────────────────────────────────
function getVal(arr: number[], barIdx: number, candleLen: number): number | null {
  const offset = candleLen - arr.length;
  const idx = barIdx - offset;
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

function getAdx(arr: Array<{ adx: number; pdi: number; mdi: number }>, barIdx: number, candleLen: number): { adx: number } | null {
  const offset = candleLen - arr.length;
  const idx = barIdx - offset;
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

// ─── Precompute indicators for 1h candles ───────────────────────────
function precompute(pair: string): PairData | null {
  const bars5m = load5m(pair);
  if (bars5m.length < 200) return null;
  const candles = aggregate1h(bars5m);
  if (candles.length < 200) return null;

  const tsMap = new Map<number, number>();
  candles.forEach((c, i) => tsMap.set(c.t, i));

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);

  const ema9 = EMA.calculate({ period: EMA_FAST, values: closes });
  const ema21 = EMA.calculate({ period: EMA_SLOW, values: closes });
  const atr14 = ATR.calculate({ period: ATR_PERIOD, high: highs, low: lows, close: closes });
  const adx14 = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

  // Z-scores: mom = close[i-1]/close[i-1-3] - 1 (3-bar momentum),
  // vol = sqrt(sum(r^2, 20) / 20) (realized vol)
  const zScores = new Array(candles.length).fill(0);
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
    zScores[i] = mom / vol;
  }

  return { candles, tsMap, zScores, adx14, ema9, ema21, atr14 };
}

// ─── GARCH Signal (exact v2 logic) ─────────────────────────────────
function garchSignal(
  pd: PairData, barIdx: number, btcPd: PairData, pairTs: number,
): "long" | "short" | null {
  const prev = barIdx - 1; // anti-look-ahead: signal on bar i-1
  if (prev < VOL_WIN + MOM_LB) return null;

  const z = pd.zScores[prev];
  if (isNaN(z) || z === 0) return null;

  const goLong = z > Z_LONG;
  const goShort = z < Z_SHORT;
  if (!goLong && !goShort) return null;

  // ADX filter (asymmetric thresholds)
  const adx = getAdx(pd.adx14, prev, pd.candles.length);
  if (!adx) return null;
  if (goLong && adx.adx < ADX_LONG_MIN) return null;
  if (goShort && adx.adx < ADX_SHORT_MIN) return null;

  // EMA 9/21 trend filter
  const e9 = getVal(pd.ema9, prev, pd.candles.length);
  const e21 = getVal(pd.ema21, prev, pd.candles.length);
  if (e9 === null || e21 === null) return null;
  if (goLong && e9 <= e21) return null;
  if (goShort && e9 >= e21) return null;

  // ATR vol filter: ATR(14) >= 0.9 * ATR(14, 5 bars ago)
  const atrNow = getVal(pd.atr14, prev, pd.candles.length);
  const atrOld = getVal(pd.atr14, prev - VOL_LB, pd.candles.length);
  if (atrNow === null || atrOld === null) return null;
  if (atrNow < VOL_RATIO * atrOld) return null;

  // BTC regime filter: BTC EMA(9) vs EMA(21)
  const btcIdx = btcPd.tsMap.get(pairTs);
  if (btcIdx === undefined || btcIdx < 1) return null;
  const btcPrev = btcIdx - 1;
  const be9 = getVal(btcPd.ema9, btcPrev, btcPd.candles.length);
  const be21 = getVal(btcPd.ema21, btcPrev, btcPd.candles.length);
  if (be9 === null || be21 === null) return null;
  const btcTrend = be9 > be21 ? "long" : "short";
  if (goLong && btcTrend !== "long") return null;
  if (goShort && btcTrend !== "short") return null;

  return goLong ? "long" : "short";
}

// ─── GARCH Simulation ──────────────────────────────────────────────
interface Position {
  pair: string; direction: "long" | "short";
  entryPrice: number; entryTime: number;
  stopLoss: number; takeProfit: number;
}

function simGarch(
  pdm: Map<string, PairData>, btcPd: PairData,
  startTs: number, endTs: number, pairs: string[],
  sizeMult = 1,
): Trade[] {
  const pd = new Map<string, PairData>();
  for (const p of pairs) { const d = pdm.get(p); if (d) pd.set(p, d); }

  const allTs = new Set<number>();
  for (const d of pd.values()) {
    for (const c of d.candles) {
      if (c.t >= startTs && c.t < endTs) allTs.add(c.t);
    }
  }
  const sorted = [...allTs].sort((a, b) => a - b);
  const open = new Map<string, Position>();
  const trades: Trade[] = [];
  const notional = NOT * sizeMult;

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // EXITS
    for (const [p, pos] of open) {
      const d = pd.get(p)!;
      const bi = d.tsMap.get(ts) ?? -1;
      if (bi < 0) continue;
      const bar = d.candles[bi];
      const sp = SP[p] ?? 4e-4;
      let exitPrice = 0, reason = "";

      // SL
      if (pos.direction === "long" && bar.l <= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 - sp * SL_SLIP); reason = "sl";
      } else if (pos.direction === "short" && bar.h >= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 + sp * SL_SLIP); reason = "sl";
      }

      // TP
      if (!reason) {
        if (pos.direction === "long" && bar.h >= pos.takeProfit) {
          exitPrice = pos.takeProfit * (1 - sp); reason = "tp";
        } else if (pos.direction === "short" && bar.l <= pos.takeProfit) {
          exitPrice = pos.takeProfit * (1 + sp); reason = "tp";
        }
      }

      // Max hold
      if (!reason) {
        const barsHeld = Math.floor((ts - pos.entryTime) / H);
        if (barsHeld >= MAX_HOLD) {
          exitPrice = pos.direction === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }
      }

      if (reason) {
        const fee = notional * FEE * 2;
        const raw = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * notional
          : (pos.entryPrice / exitPrice - 1) * notional;
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
      const bi = d.tsMap.get(ts) ?? -1;
      if (bi < 60) continue;

      const dir = garchSignal(d, bi, btcPd, ts);
      if (!dir) continue;

      const dirCount = [...open.values()].filter(x => x.direction === dir).length;
      if (dirCount >= MAX_PER_DIR) continue;

      const entryRaw = d.candles[bi].o;
      const sp = SP[p] ?? 4e-4;
      const entry = dir === "long" ? entryRaw * (1 + sp) : entryRaw * (1 - sp);
      const sl = dir === "long" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
      const tp = dir === "long" ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);

      open.set(p, { pair: p, direction: dir, entryPrice: entry, entryTime: ts, stopLoss: sl, takeProfit: tp });
    }
  }

  return trades;
}

// ─── Random Entry GARCH (same exits: 3% SL, 10% TP, 48h max hold) ──
function simRandomEntry(
  pdm: Map<string, PairData>, btcPd: PairData,
  startTs: number, endTs: number, pairs: string[],
  avgFreqPerPairPerBar: number,
): Trade[] {
  const pd = new Map<string, PairData>();
  for (const p of pairs) { const d = pdm.get(p); if (d) pd.set(p, d); }

  const allTs = new Set<number>();
  for (const d of pd.values()) {
    for (const c of d.candles) {
      if (c.t >= startTs && c.t < endTs) allTs.add(c.t);
    }
  }
  const sorted = [...allTs].sort((a, b) => a - b);
  const open = new Map<string, Position>();
  const trades: Trade[] = [];

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // EXITS (same as GARCH)
    for (const [p, pos] of open) {
      const d = pd.get(p)!;
      const bi = d.tsMap.get(ts) ?? -1;
      if (bi < 0) continue;
      const bar = d.candles[bi];
      const sp = SP[p] ?? 4e-4;
      let exitPrice = 0, reason = "";

      if (pos.direction === "long" && bar.l <= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 - sp * SL_SLIP); reason = "sl";
      } else if (pos.direction === "short" && bar.h >= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 + sp * SL_SLIP); reason = "sl";
      }

      if (!reason) {
        if (pos.direction === "long" && bar.h >= pos.takeProfit) {
          exitPrice = pos.takeProfit * (1 - sp); reason = "tp";
        } else if (pos.direction === "short" && bar.l <= pos.takeProfit) {
          exitPrice = pos.takeProfit * (1 + sp); reason = "tp";
        }
      }

      if (!reason) {
        const barsHeld = Math.floor((ts - pos.entryTime) / H);
        if (barsHeld >= MAX_HOLD) {
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
      const bi = d.tsMap.get(ts) ?? -1;
      if (bi < 60) continue;
      if (Math.random() > avgFreqPerPairPerBar) continue;

      const dir: "long" | "short" = Math.random() > 0.5 ? "long" : "short";
      const dirCount = [...open.values()].filter(x => x.direction === dir).length;
      if (dirCount >= MAX_PER_DIR) continue;

      const entryRaw = d.candles[bi].o;
      const sp = SP[p] ?? 4e-4;
      const entry = dir === "long" ? entryRaw * (1 + sp) : entryRaw * (1 - sp);
      const sl = dir === "long" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
      const tp = dir === "long" ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);

      open.set(p, { pair: p, direction: dir, entryPrice: entry, entryTime: ts, stopLoss: sl, takeProfit: tp });
    }
  }

  return trades;
}

// ─── Donchian Daily Strategy ────────────────────────────────────────
// Donchian(30d) daily: SMA 30/60 cross, 15d exit channel, ATR*3 stop, 60d max hold, BTC filter for longs
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

function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
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
  sizeMult = 1,
): Trade[] {
  const ENTRY_LB = 30;
  const EXIT_LB = 15;
  const ATR_MULT = 3;
  const ATR_PER = 14;
  const DONCH_MAX_HOLD = 60;
  const FAST_SMA = 30;
  const SLOW_SMA = 60;
  const notional = NOT * sizeMult;

  // BTC SMA for filter
  const btcCloses = btcDaily.map(c => c.c);
  const btcFast = calcSMA(btcCloses, FAST_SMA);
  const btcSlow = calcSMA(btcCloses, SLOW_SMA);
  const btcTsMap = new Map<number, number>();
  btcDaily.forEach((c, i) => btcTsMap.set(c.t, i));

  const trades: Trade[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < SLOW_SMA + ATR_PER + 5) continue;
    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, FAST_SMA);
    const slow = calcSMA(closes, SLOW_SMA);
    const atr = calcATRManual(cs, ATR_PER);

    interface DPos { pair: string; dir: "long" | "short"; ep: number; et: number; sl: number; }
    let pos: DPos | null = null;
    const warmup = SLOW_SMA + 1;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];
      const sp = SP[pair] ?? 4e-4;

      // Exit
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / D);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP); reason = "sl";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP); reason = "sl";
        }

        // 15d exit channel
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

      // Entry (SMA 30/60 cross on prev bar)
      if (!pos && i >= warmup && bar.t >= startTs && bar.t < endTs) {
        const prev = i - 1;
        const prevFast = fast[prev];
        const prevSlow = slow[prev];
        const curFast = fast[i];
        const curSlow = slow[i];

        let dir: "long" | "short" | null = null;
        // Cross up = long, cross down = short
        if (prevFast <= prevSlow && curFast > curSlow) dir = "long";
        else if (prevFast >= prevSlow && curFast < curSlow) dir = "short";
        if (!dir) continue;

        // BTC filter for longs
        if (dir === "long") {
          const btcI = btcTsMap.get(bar.t);
          if (btcI !== undefined && btcI > 0) {
            if (btcFast[btcI] <= btcSlow[btcI]) continue; // BTC bearish, skip long
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

// ─── Supertrend Strategy (daily, 14/2) ──────────────────────────────
function simSupertrendDaily(
  dailyData: Map<string, C[]>,
  startTs: number, endTs: number, pairs: string[],
  sizeMult = 1,
): Trade[] {
  const ST_PERIOD = 14;
  const ST_MULT = 2;
  const ST_SL_PCT = 0.035;
  const ST_MAX_HOLD = 60;
  const notional = NOT * sizeMult;
  const trades: Trade[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < ST_PERIOD + 30) continue;

    const atr = calcATRManual(cs, ST_PERIOD);

    // Compute supertrend
    const upperBand = new Array(cs.length).fill(0);
    const lowerBand = new Array(cs.length).fill(0);
    const stDir = new Array(cs.length).fill(1); // 1=up (bullish), -1=down (bearish)

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

      // Exit
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / D);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP); reason = "sl";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP); reason = "sl";
        }

        // Supertrend flip exit
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

      // Entry: supertrend flip on prev bar
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

  // Max DD
  let maxDd = 0, peak = 0, cum = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }

  // Sharpe (daily)
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
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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

function normalCDF(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1.0 + sign * y);
}

function printStats(label: string, s: Stats): void {
  console.log(`${label}`);
  console.log(`  Trades: ${s.n}  WR: ${s.wr.toFixed(1)}%  PF: ${s.pf === Infinity ? "inf" : s.pf.toFixed(2)}`);
  console.log(`  PnL: ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}  $/day: ${s.perDay >= 0 ? "+" : ""}$${s.perDay.toFixed(2)}  Sharpe: ${s.sharpe.toFixed(2)}  MaxDD: $${s.maxDd.toFixed(2)}`);
}

// ════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════

console.log("=".repeat(80));
console.log("  GARCH v2 DEEP STATISTICAL VALIDATION");
console.log("  z-long=4.5, z-short=-3.0, ADX(14), EMA(9/21), BTC filter");
console.log("  SL 3%, TP 10%, max hold 48h, 1h candles, 13 pairs");
console.log("=".repeat(80));

console.log("\nLoading and aggregating 5m -> 1h candles...");
const pdm = new Map<string, PairData>();
const allToLoad = [...new Set([...GARCH_PAIRS, "BTC"])];
for (const p of allToLoad) {
  const d = precompute(p);
  if (d) {
    pdm.set(p, d);
  } else {
    console.log(`  [SKIP] ${p} - insufficient data`);
  }
}
const btcPd = pdm.get("BTC");
if (!btcPd) { console.error("BTC data missing."); process.exit(1); }

const availGarch = GARCH_PAIRS.filter(p => pdm.has(p));
console.log(`Loaded: ${availGarch.length} GARCH pairs + BTC`);

// Also load daily data for Donchian + Supertrend
console.log("\nLoading daily candles for Donchian+Supertrend...");
const dailyData = new Map<string, C[]>();
const allDailyPairs = [...new Set([...DONCH_PAIRS, "BTC"])];
for (const p of allDailyPairs) {
  const raw = load5m(p);
  if (raw.length === 0) { console.log(`  [SKIP] ${p} - no 5m data`); continue; }
  const daily = aggregateDaily(raw);
  dailyData.set(p, daily);
}
const btcDaily = dailyData.get("BTC");
if (!btcDaily) { console.error("BTC daily data missing."); process.exit(1); }
console.log(`Loaded: ${dailyData.size} daily pairs`);

// ─── Baseline ───────────────────────────────────────────────────────
const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

console.log("\n" + "=".repeat(80));
console.log("  BASELINE: GARCH v2 Full Period and OOS");
console.log("=".repeat(80));

const fullTrades = simGarch(pdm, btcPd, FULL_START, FULL_END, availGarch);
const oosTrades = simGarch(pdm, btcPd, OOS_START, FULL_END, availGarch);

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

// ════════════════════════════════════════════════════════════════════
// TEST 1: MONTE CARLO PERMUTATION (500 iterations)
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 1: MONTE CARLO PERMUTATION (500 iterations)");
console.log("  Shuffle trade P&L order. What percentile is actual Sharpe vs random?");
console.log("=".repeat(80));

const MC_ITERS = 500;
const mcSharpes: number[] = [];
const mcMaxDDs: number[] = [];

for (let i = 0; i < MC_ITERS; i++) {
  const shuffled = shuffle(fullPnls);
  const m = statsFromPnls(shuffled);
  mcSharpes.push(m.sharpe);
  mcMaxDDs.push(m.maxDd);
}

mcSharpes.sort((a, b) => a - b);
mcMaxDDs.sort((a, b) => a - b);

const sharpePctile = rankPct(actualStats.sharpe, mcSharpes);
const ddPctile = rankPct(actualStats.maxDd, mcMaxDDs);

console.log("\nMetric        Actual     5th pct    50th pct   95th pct   Rank");
console.log("-".repeat(70));
console.log(`Sharpe        ${actualStats.sharpe.toFixed(2).padStart(7)}  ${percentile(mcSharpes, 5).toFixed(2).padStart(8)}  ${percentile(mcSharpes, 50).toFixed(2).padStart(8)}  ${percentile(mcSharpes, 95).toFixed(2).padStart(8)}  ${sharpePctile.toFixed(1)}%`);
console.log(`MaxDD         $${actualStats.maxDd.toFixed(0).padStart(5)}  $${percentile(mcMaxDDs, 5).toFixed(0).padStart(6)}  $${percentile(mcMaxDDs, 50).toFixed(0).padStart(6)}  $${percentile(mcMaxDDs, 95).toFixed(0).padStart(6)}  ${ddPctile.toFixed(1)}%`);

// p-value: proportion of shuffles with Sharpe >= actual
const pValueMC = mcSharpes.filter(s => s >= actualStats.sharpe).length / MC_ITERS;
const mc1Verdict = pValueMC < 0.05 ? "PASS" : pValueMC < 0.10 ? "WARNING" : "FAIL";
console.log(`\nSharpe p-value: ${pValueMC.toFixed(3)} (proportion of shuffles >= actual)`);
console.log(`Actual Sharpe at ${sharpePctile.toFixed(1)}th percentile of random orderings`);
console.log(`Verdict: ${mc1Verdict}`);

// ════════════════════════════════════════════════════════════════════
// TEST 2: BOOTSTRAP CI (500 iterations)
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 2: BOOTSTRAP CONFIDENCE INTERVALS (500 iterations)");
console.log("  Resample trades with replacement. Report 5th/50th/95th percentile PF.");
console.log("=".repeat(80));

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

// ════════════════════════════════════════════════════════════════════
// TEST 3: RANDOM ENTRY (200 iterations)
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 3: RANDOM ENTRY TEST (200 iterations)");
console.log("  Same exits (3% SL, 10% TP, 48h max hold), random entries.");
console.log("=".repeat(80));

// Calculate actual signal frequency
let totalSignals = 0;
let totalBars = 0;
for (const p of availGarch) {
  const d = pdm.get(p);
  if (!d) continue;
  const barsInRange = d.candles.filter(c => c.t >= FULL_START && c.t < FULL_END).length;
  totalBars += barsInRange;
  totalSignals += fullTrades.filter(t => t.pair === p).length;
}
// Adjust frequency: account for blocking (position held = no new entry)
const avgBarsPer = totalBars > 0 ? totalSignals / totalBars : 0.001;
const adjFreq = avgBarsPer * 2.0; // boost to compensate for blocking

console.log(`\nActual: ${totalSignals} entries across ${totalBars} pair-bars = ${(avgBarsPer * 100).toFixed(3)}%`);
console.log(`Random entry prob per bar: ${(adjFreq * 100).toFixed(3)}% (2x boost for blocking)\n`);

const RAND_ITERS = 200;
const randPFs: number[] = [];
const randSharpes: number[] = [];
const randNs: number[] = [];

for (let i = 0; i < RAND_ITERS; i++) {
  const rt = simRandomEntry(pdm, btcPd, FULL_START, FULL_END, availGarch, adjFreq);
  const m = calcStats(rt, fullDays);
  randPFs.push(m.pf);
  randSharpes.push(m.sharpe);
  randNs.push(m.n);
}

randPFs.sort((a, b) => a - b);
randSharpes.sort((a, b) => a - b);
randNs.sort((a, b) => a - b);

const randPFgt1 = randPFs.filter(pf => pf > 1.0).length;
const garchPFrank = rankPct(actualStats.pf, randPFs);
const garchShRank = rankPct(actualStats.sharpe, randSharpes);

console.log(`Avg random trades per run: ${(randNs.reduce((s, n) => s + n, 0) / RAND_ITERS).toFixed(0)} (actual: ${fullTrades.length})`);
console.log(`Random PF > 1.0: ${randPFgt1}/${RAND_ITERS} (${(randPFgt1 / RAND_ITERS * 100).toFixed(1)}%)`);
console.log(`Random PF > actual (${actualStats.pf.toFixed(2)}): ${randPFs.filter(pf => pf > actualStats.pf).length}/${RAND_ITERS}`);
console.log(`GARCH PF percentile vs random: ${garchPFrank.toFixed(1)}%`);
console.log(`GARCH Sharpe percentile vs random: ${garchShRank.toFixed(1)}%`);

console.log(`\nRandom PF distribution: 5th=${percentile(randPFs, 5).toFixed(2)}, 50th=${percentile(randPFs, 50).toFixed(2)}, 95th=${percentile(randPFs, 95).toFixed(2)}`);
console.log(`Random Sharpe distribution: 5th=${percentile(randSharpes, 5).toFixed(2)}, 50th=${percentile(randSharpes, 50).toFixed(2)}, 95th=${percentile(randSharpes, 95).toFixed(2)}`);

const pValueRand = (100 - garchPFrank) / 100;
const re3Verdict = garchPFrank >= 95 ? "PASS" : garchPFrank >= 75 ? "WARNING" : "FAIL";
console.log(`\np-value (entry edge): ${pValueRand.toFixed(3)}`);
console.log(`Verdict: ${re3Verdict}`);

// ════════════════════════════════════════════════════════════════════
// TEST 4: WALK-FORWARD (6 windows)
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 4: WALK-FORWARD VALIDATION (6 windows)");
console.log("  6-month train, 2-month test, rolling.");
console.log("=".repeat(80));

const WF_TRAIN = 6 * 30 * D; // ~6 months
const WF_TEST = 2 * 30 * D;  // ~2 months
const WF_STEP = WF_TEST;     // rolling

console.log(`\n${"Window".padEnd(8)} ${"Train Period".padEnd(25)} ${"Test Period".padEnd(25)} ${"Train PF".padStart(9)} ${"Test PF".padStart(8)} ${"Test PnL".padStart(9)} ${"Test $/d".padStart(9)}`);
console.log("-".repeat(100));

let wfStart = FULL_START;
let wfWindow = 0;
let wfTotalTestPnl = 0;
let wfTotalTestTrades = 0;
let wfTestDaysTotal = 0;
const wfTestPFs: number[] = [];

while (wfStart + WF_TRAIN + WF_TEST <= FULL_END && wfWindow < 6) {
  const trainStart = wfStart;
  const trainEnd = wfStart + WF_TRAIN;
  const testStart = trainEnd;
  const testEnd = trainEnd + WF_TEST;

  const trainTrades = simGarch(pdm, btcPd, trainStart, trainEnd, availGarch);
  const testTrades = simGarch(pdm, btcPd, testStart, testEnd, availGarch);

  const trainDays = WF_TRAIN / D;
  const testDays = WF_TEST / D;

  const trainS = calcStats(trainTrades, trainDays);
  const testS = calcStats(testTrades, testDays);

  const trainLabel = `${new Date(trainStart).toISOString().slice(0, 10)} - ${new Date(trainEnd).toISOString().slice(0, 10)}`;
  const testLabel = `${new Date(testStart).toISOString().slice(0, 10)} - ${new Date(testEnd).toISOString().slice(0, 10)}`;

  const trainPFStr = trainS.pf === Infinity ? "inf" : trainS.pf.toFixed(2);
  const testPFStr = testS.pf === Infinity ? "inf" : testS.pf.toFixed(2);

  console.log(`W${wfWindow + 1}       ${trainLabel.padEnd(25)} ${testLabel.padEnd(25)} ${trainPFStr.padStart(9)} ${testPFStr.padStart(8)} ${(testS.pnl >= 0 ? "+" : "") + "$" + testS.pnl.toFixed(2).padStart(7)} ${(testS.perDay >= 0 ? "+" : "") + "$" + testS.perDay.toFixed(2).padStart(7)}`);

  wfTotalTestPnl += testS.pnl;
  wfTotalTestTrades += testS.n;
  wfTestDaysTotal += testDays;
  wfTestPFs.push(testS.pf);

  wfStart += WF_STEP;
  wfWindow++;
}

const wfProfitableWindows = wfTestPFs.filter(pf => pf > 1.0).length;
const wfAvgTestPF = wfTestPFs.length > 0 ? wfTestPFs.reduce((s, p) => s + p, 0) / wfTestPFs.length : 0;
const wf4Verdict = wfProfitableWindows >= 4 ? "PASS" : wfProfitableWindows >= 3 ? "WARNING" : "FAIL";

console.log(`\nAgg test PnL: ${wfTotalTestPnl >= 0 ? "+" : ""}$${wfTotalTestPnl.toFixed(2)} over ${wfTotalTestTrades} trades`);
console.log(`Avg test $/day: ${wfTestDaysTotal > 0 ? "$" + (wfTotalTestPnl / wfTestDaysTotal).toFixed(2) : "n/a"}`);
console.log(`Profitable test windows: ${wfProfitableWindows}/${wfTestPFs.length}`);
console.log(`Avg test PF: ${wfAvgTestPF.toFixed(2)}`);
console.log(`Verdict: ${wf4Verdict}`);

// ════════════════════════════════════════════════════════════════════
// TEST 5: 4-QUARTER STATIONARITY
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 5: 4-QUARTER STATIONARITY");
console.log("  Split full period into 4 equal quarters. All 4 must be profitable.");
console.log("=".repeat(80));

const sortedTrades = [...fullTrades].sort((a, b) => a.et - b.et);
const firstEntry = sortedTrades[0]?.et ?? FULL_START;
const lastEntry = sortedTrades[sortedTrades.length - 1]?.et ?? FULL_END;
const qLen = (lastEntry - firstEntry) / 4;

console.log(`\n${"Quarter".padEnd(10)} ${"Period".padEnd(25)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"Sharpe".padStart(7)} ${"PnL".padStart(10)} ${"$/day".padStart(8)}`);
console.log("-".repeat(85));

let stableQ = 0;
const qPFs: number[] = [];
const qSharpes: number[] = [];
const qPnls: number[] = [];

for (let q = 0; q < 4; q++) {
  const qStart = firstEntry + q * qLen;
  const qEnd = firstEntry + (q + 1) * qLen;
  const qTrades = sortedTrades.filter(t => t.et >= qStart && t.et < qEnd);
  const qDays = qLen / D;
  const qS = calcStats(qTrades, qDays);

  qPFs.push(qS.pf);
  qSharpes.push(qS.sharpe);
  qPnls.push(qS.pnl);
  if (qS.pnl > 0) stableQ++;

  const startLabel = new Date(qStart).toISOString().slice(0, 10);
  const endLabel = new Date(qEnd).toISOString().slice(0, 10);
  console.log(`Q${q + 1}        ${(startLabel + " - " + endLabel).padEnd(25)} ${String(qS.n).padStart(7)} ${qS.wr.toFixed(1).padStart(6)} ${(qS.pf === Infinity ? "inf" : qS.pf.toFixed(2)).padStart(6)} ${qS.sharpe.toFixed(2).padStart(7)} ${(qS.pnl >= 0 ? "+" : "") + "$" + qS.pnl.toFixed(2).padStart(8)} ${(qS.perDay >= 0 ? "+" : "") + "$" + qS.perDay.toFixed(2).padStart(6)}`);
}

const st5Verdict = stableQ === 4 ? "PASS" : stableQ >= 3 ? "WARNING" : "FAIL";
console.log(`\nProfitable quarters: ${stableQ}/4`);
console.log(`PF range: ${Math.min(...qPFs).toFixed(2)} - ${Math.max(...qPFs) === Infinity ? "inf" : Math.max(...qPFs).toFixed(2)}`);
console.log(`Sharpe range: ${Math.min(...qSharpes).toFixed(2)} - ${Math.max(...qSharpes).toFixed(2)}`);
console.log(`Verdict: ${st5Verdict}`);

// ════════════════════════════════════════════════════════════════════
// TEST 6: CORRELATION WITH DONCHIAN + SUPERTREND
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 6: CORRELATION WITH DONCHIAN + SUPERTREND");
console.log("  Compute daily P&L correlation between GARCH and Donchian/Supertrend.");
console.log("=".repeat(80));

const donchTrades = simDonchianDaily(dailyData, btcDaily, FULL_START, FULL_END, DONCH_PAIRS);
const stTrades = simSupertrendDaily(dailyData, FULL_START, FULL_END, DONCH_PAIRS);

printStats("\nDonchian Daily (full period)", calcStats(donchTrades, fullDays));
printStats("Supertrend Daily (full period)", calcStats(stTrades, fullDays));

// Build daily PnL maps
function buildDailyPnl(trades: Trade[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / D);
    m.set(day, (m.get(day) ?? 0) + t.pnl);
  }
  return m;
}

const garchDaily = buildDailyPnl(fullTrades);
const donchDaily = buildDailyPnl(donchTrades);
const stDaily = buildDailyPnl(stTrades);

// Correlation function
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

const corrGD = correlation(garchDaily, donchDaily);
const corrGS = correlation(garchDaily, stDaily);
const corrDS = correlation(donchDaily, stDaily);

console.log(`\nDaily PnL Correlation Matrix:`);
console.log(`  GARCH-Donchian:    ${corrGD.toFixed(3)}`);
console.log(`  GARCH-Supertrend:  ${corrGS.toFixed(3)}`);
console.log(`  Donchian-Supertrend: ${corrDS.toFixed(3)}`);

const lowCorr = Math.abs(corrGD) < 0.3 && Math.abs(corrGS) < 0.3;
console.log(`\n${lowCorr ? "Low correlation: strategies complement each other" : "Moderate/high correlation: limited diversification benefit"}`);
const co6Verdict = lowCorr ? "PASS" : Math.abs(corrGD) < 0.5 && Math.abs(corrGS) < 0.5 ? "WARNING" : "FAIL";
console.log(`Verdict: ${co6Verdict}`);

// ════════════════════════════════════════════════════════════════════
// TEST 7: COMBINED PORTFOLIO
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 7: COMBINED PORTFOLIO");
console.log("  GARCH ($5) + Donchian ($2.50) + Supertrend ($2.50) = $10 total");
console.log("=".repeat(80));

// Re-run with size multipliers
const garchCombFull = simGarch(pdm, btcPd, FULL_START, FULL_END, availGarch, 0.5);
const donchCombFull = simDonchianDaily(dailyData, btcDaily, FULL_START, FULL_END, DONCH_PAIRS, 0.25);
const stCombFull = simSupertrendDaily(dailyData, FULL_START, FULL_END, DONCH_PAIRS, 0.25);

const garchCombOos = simGarch(pdm, btcPd, OOS_START, FULL_END, availGarch, 0.5);
const donchCombOos = simDonchianDaily(dailyData, btcDaily, OOS_START, FULL_END, DONCH_PAIRS, 0.25);
const stCombOos = simSupertrendDaily(dailyData, OOS_START, FULL_END, DONCH_PAIRS, 0.25);

// Merge all trades for combined stats
const combinedFull = [...garchCombFull, ...donchCombFull, ...stCombFull];
const combinedOos = [...garchCombOos, ...donchCombOos, ...stCombOos];

console.log("\n--- Full Period ---");
printStats("GARCH ($5 margin)", calcStats(garchCombFull, fullDays));
printStats("Donchian ($2.50 margin)", calcStats(donchCombFull, fullDays));
printStats("Supertrend ($2.50 margin)", calcStats(stCombFull, fullDays));
printStats("COMBINED ($10 total)", calcStats(combinedFull, fullDays));

console.log("\n--- OOS ---");
printStats("GARCH ($5 margin)", calcStats(garchCombOos, oosDays));
printStats("Donchian ($2.50 margin)", calcStats(donchCombOos, oosDays));
printStats("Supertrend ($2.50 margin)", calcStats(stCombOos, oosDays));
printStats("COMBINED ($10 total)", calcStats(combinedOos, oosDays));

// ════════════════════════════════════════════════════════════════════
// OVERALL ASSESSMENT
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  OVERALL STATISTICAL ASSESSMENT");
console.log("=".repeat(80));

const verdicts = [
  { test: "1. Monte Carlo Permutation", verdict: mc1Verdict },
  { test: "2. Bootstrap CI (5th pct PF > 1.0?)", verdict: bs2Verdict },
  { test: "3. Random Entry", verdict: re3Verdict },
  { test: "4. Walk-Forward (6 windows)", verdict: wf4Verdict },
  { test: "5. 4-Quarter Stationarity", verdict: st5Verdict },
  { test: "6. Correlation (low = good)", verdict: co6Verdict },
];

console.log("\nTest                                 Verdict");
console.log("-".repeat(50));
for (const v of verdicts) {
  console.log(`${v.test.padEnd(38)} ${v.verdict}`);
}

const passCount = verdicts.filter(v => v.verdict === "PASS").length;
const failCount = verdicts.filter(v => v.verdict === "FAIL").length;
const warnCount = verdicts.filter(v => v.verdict === "WARNING").length;

// t-test on trade PnLs
const meanPnl = fullPnls.reduce((s, p) => s + p, 0) / fullPnls.length;
const stdPnl = Math.sqrt(fullPnls.reduce((s, p) => s + (p - meanPnl) ** 2, 0) / (fullPnls.length - 1));
const tStat = meanPnl / (stdPnl / Math.sqrt(fullPnls.length));
const pValueTTest = 1 - normalCDF(tStat);

console.log(`\nPASS: ${passCount}  |  WARNING: ${warnCount}  |  FAIL: ${failCount}`);
console.log(`t-test (mean PnL > 0): t=${tStat.toFixed(3)}, p=${pValueTTest.toFixed(4)}`);

let overall: string;
if (passCount >= 5) overall = "HIGH CONFIDENCE";
else if (passCount >= 4 && failCount === 0) overall = "HIGH CONFIDENCE";
else if (passCount >= 3 && failCount <= 1) overall = "MODERATE CONFIDENCE";
else if (passCount >= 2) overall = "LOW-MODERATE CONFIDENCE";
else overall = "LOW CONFIDENCE";

console.log(`\nOverall: ${overall}`);

console.log(`\nKey findings:`);
console.log(`  - Bootstrap 5th pct PF: ${pf5th.toFixed(2)} (${pf5th > 1.0 ? ">1.0 = robust" : "<1.0 = fragile"})`);
console.log(`  - GARCH PF at ${garchPFrank.toFixed(0)}th percentile vs random entries`);
console.log(`  - Walk-forward: ${wfProfitableWindows}/${wfTestPFs.length} profitable test windows`);
console.log(`  - ${stableQ}/4 quarters profitable`);
console.log(`  - GARCH-Donchian correlation: ${corrGD.toFixed(3)} (${Math.abs(corrGD) < 0.3 ? "low = diversifies" : "moderate"})`);
console.log(`  - Combined ($10): Full PnL=$${calcStats(combinedFull, fullDays).pnl.toFixed(2)}, OOS PnL=$${calcStats(combinedOos, oosDays).pnl.toFixed(2)}`);

console.log("\nDone.");
