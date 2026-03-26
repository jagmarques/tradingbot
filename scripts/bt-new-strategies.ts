/**
 * New Strategy Variants Backtest
 * Applies GARCH v2 learnings: extreme thresholds + multi-filter + asymmetric SL/TP
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-new-strategies.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ──────────────────────────────────────────────────────────
interface C {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
interface Pos {
  pair: string;
  dir: "long" | "short";
  ep: number;
  et: number;
  sl: number;
  tp: number;
}
interface Tr {
  pair: string;
  dir: "long" | "short";
  ep: number;
  xp: number;
  et: number;
  xt: number;
  pnl: number;
  reason: string;
}

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const D = 86_400_000;
const FEE = 0.00035; // 0.035% taker per side
const SIZE = 10; // $10 margin
const LEV = 10;
const NOT = SIZE * LEV; // $100 notional
const SL_SLIP = 1.5;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

const PAIRS = [
  "OP",
  "ARB",
  "LDO",
  "TRUMP",
  "DOT",
  "ENA",
  "DOGE",
  "APT",
  "LINK",
  "ADA",
  "WLD",
  "XRP",
  "SOL",
];

const SP: Record<string, number> = {
  XRP: 1.05e-4,
  DOGE: 1.35e-4,
  ARB: 2.6e-4,
  ENA: 2.55e-4,
  APT: 3.2e-4,
  LINK: 3.45e-4,
  TRUMP: 3.65e-4,
  WLD: 4e-4,
  DOT: 4.95e-4,
  ADA: 5.55e-4,
  LDO: 5.8e-4,
  OP: 6.2e-4,
  SOL: 2.0e-4,
  BTC: 0.5e-4,
};

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw
    .map((b: any) =>
      Array.isArray(b)
        ? {
            t: +b[0],
            o: +b[1],
            h: +b[2],
            l: +b[3],
            c: +b[4],
            v: +(b[5] ?? 0),
          }
        : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0) }
    )
    .sort((a: C, b: C) => a.t - b.t);
}

function aggregateByTime(
  bars5m: C[],
  periodMs: number,
  minBarsRatio: number = 0.8
): C[] {
  const barsPerPeriod = periodMs / (5 * 60_000);
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
    const ts = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(ts);
    if (!arr) {
      arr = [];
      groups.set(ts, arr);
    }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < barsPerPeriod * minBarsRatio) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map((b) => b.h)),
      l: Math.min(...grp.map((b) => b.l)),
      c: grp[grp.length - 1].c,
      v: grp.reduce((s, b) => s + b.v, 0),
    });
  }
  result.sort((a, b) => a.t - b.t);
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      ema[i] = 0;
      continue;
    }
    if (!init) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period;
      init = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c)
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(
          cs[j].h - cs[j].l,
          Math.abs(cs[j].h - cs[j - 1].c),
          Math.abs(cs[j].l - cs[j - 1].c)
        );
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcADX(cs: C[], period: number): number[] {
  const adx = new Array(cs.length).fill(0);
  const plusDM: number[] = [],
    minusDM: number[] = [],
    tr: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    if (i === 0) {
      plusDM.push(0);
      minusDM.push(0);
      tr.push(cs[i].h - cs[i].l);
      continue;
    }
    const upMove = cs[i].h - cs[i - 1].h;
    const downMove = cs[i - 1].l - cs[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        cs[i].h - cs[i].l,
        Math.abs(cs[i].h - cs[i - 1].c),
        Math.abs(cs[i].l - cs[i - 1].c)
      )
    );
  }
  const smoothTR = new Array(cs.length).fill(0);
  const smoothPDM = new Array(cs.length).fill(0);
  const smoothMDM = new Array(cs.length).fill(0);
  if (cs.length <= period) return adx;
  for (let i = 1; i <= period; i++) {
    smoothTR[period] += tr[i];
    smoothPDM[period] += plusDM[i];
    smoothMDM[period] += minusDM[i];
  }
  for (let i = period + 1; i < cs.length; i++) {
    smoothTR[i] = smoothTR[i - 1] - smoothTR[i - 1] / period + tr[i];
    smoothPDM[i] = smoothPDM[i - 1] - smoothPDM[i - 1] / period + plusDM[i];
    smoothMDM[i] = smoothMDM[i - 1] - smoothMDM[i - 1] / period + minusDM[i];
  }
  const dx = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    if (smoothTR[i] === 0) continue;
    const pdi = (100 * smoothPDM[i]) / smoothTR[i];
    const mdi = (100 * smoothMDM[i]) / smoothTR[i];
    dx[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  }
  if (cs.length <= 2 * period) return adx;
  let adxSum = 0;
  for (let i = period; i < 2 * period; i++) adxSum += dx[i];
  adx[2 * period - 1] = adxSum / period;
  for (let i = 2 * period; i < cs.length; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }
  return adx;
}

function calcRSI(closes: number[], period: number): number[] {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0,
    avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] =
    avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] =
      avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcBB(
  closes: number[],
  period: number,
  mult: number
): { upper: number[]; lower: number[]; mid: number[] } {
  const upper: number[] = new Array(closes.length).fill(0);
  const lower: number[] = new Array(closes.length).fill(0);
  const mid: number[] = new Array(closes.length).fill(0);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const m = sum / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (closes[j] - m) ** 2;
    const std = Math.sqrt(sqSum / period);
    mid[i] = m;
    upper[i] = m + mult * std;
    lower[i] = m - mult * std;
  }
  return { upper, lower, mid };
}

function calcStochastic(
  cs: C[],
  kPeriod: number,
  dPeriod: number
): { k: number[]; d: number[] } {
  const rawK: number[] = new Array(cs.length).fill(50);
  for (let i = kPeriod - 1; i < cs.length; i++) {
    let hh = -Infinity,
      ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, cs[j].h);
      ll = Math.min(ll, cs[j].l);
    }
    rawK[i] = hh === ll ? 50 : ((cs[i].c - ll) / (hh - ll)) * 100;
  }
  // Smooth %K with SMA(dPeriod) -> this becomes the "slow %K"
  const k: number[] = new Array(cs.length).fill(50);
  for (let i = kPeriod - 1 + dPeriod - 1; i < cs.length; i++) {
    let sum = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) sum += rawK[j];
    k[i] = sum / dPeriod;
  }
  // %D is SMA(dPeriod) of smoothed %K
  const d: number[] = new Array(cs.length).fill(50);
  for (let i = kPeriod - 1 + 2 * (dPeriod - 1); i < cs.length; i++) {
    let sum = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) sum += k[j];
    d[i] = sum / dPeriod;
  }
  return { k, d };
}

function calcZScores(
  cs: C[],
  momLB: number,
  volWin: number
): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLB + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i].c / cs[i - momLB].c - 1;
    let sumSq = 0,
      count = 0;
    for (let j = Math.max(1, i - volWin + 1); j <= i; j++) {
      const r = cs[j].c / cs[j - 1].c - 1;
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

function calcVolAvg(cs: C[], period: number): number[] {
  const avg = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += cs[j].v;
    avg[i] = sum / period;
  }
  return avg;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function spread(pair: string): number {
  return SP[pair] ?? 4e-4;
}

function pnl(
  pair: string,
  ep: number,
  xp: number,
  dir: "long" | "short",
  isSL: boolean
): number {
  const sp = spread(pair);
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? SL_SLIP : 1);
  const rawPnl =
    dir === "long" ? (xp / ep - 1) * NOT : (ep / xp - 1) * NOT;
  const cost =
    entrySlip * (NOT / ep) + exitSlip * (NOT / xp) + NOT * FEE * 2;
  return rawPnl - cost;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Stats {
  n: number;
  wr: number;
  pf: number;
  sharpe: number;
  dd: number;
  total: number;
  perDay: number;
}

function calcStats(trades: Tr[], startTs: number, endTs: number): Stats {
  if (trades.length === 0)
    return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const days = (endTs - startTs) / D;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  // Sharpe (daily)
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()].map((p) => p / SIZE);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  );
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // Max DD
  let peak = 0,
    equity = 0,
    maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  return {
    n: trades.length,
    wr: (wins.length / trades.length) * 100,
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

function fmtStats(s: Stats): string {
  return (
    `  Trades: ${s.n}  WR: ${s.wr.toFixed(1)}%  PF: ${s.pf === Infinity ? "inf" : s.pf.toFixed(2)}  Sharpe: ${s.sharpe.toFixed(2)}\n` +
    `  PnL: ${s.total >= 0 ? "+" : ""}$${s.total.toFixed(2)}  $/day: ${s.perDay >= 0 ? "+" : ""}$${s.perDay.toFixed(2)}  MaxDD: $${s.dd.toFixed(2)}`
  );
}

// ─── Simulation Engine ──────────────────────────────────────────────
type SignalFn = (
  pair: string,
  barIdx: number,
  allData: Map<string, { cs: C[]; [key: string]: any }>
) => { dir: "long" | "short"; sl: number; tp: number } | null;

function simulate(
  pairs: string[],
  allData: Map<string, { cs: C[]; [key: string]: any }>,
  signalFn: SignalFn,
  startTs: number,
  endTs: number,
  maxHoldMs: number,
  maxPerDir: number = 6
): Tr[] {
  // Collect all bar timestamps in range across all pairs
  const allTs = new Set<number>();
  const tsToIdx = new Map<string, Map<number, number>>();
  for (const pair of pairs) {
    const d = allData.get(pair);
    if (!d) continue;
    const m = new Map<number, number>();
    for (let i = 0; i < d.cs.length; i++) {
      if (d.cs[i].t >= startTs && d.cs[i].t < endTs) {
        allTs.add(d.cs[i].t);
      }
      m.set(d.cs[i].t, i);
    }
    tsToIdx.set(pair, m);
  }
  const sorted = [...allTs].sort((a, b) => a - b);

  const open = new Map<string, Pos>();
  const trades: Tr[] = [];

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // --- EXITS ---
    for (const [key, pos] of open) {
      const idxMap = tsToIdx.get(pos.pair);
      if (!idxMap) continue;
      const bi = idxMap.get(ts);
      if (bi === undefined) continue;
      const d = allData.get(pos.pair)!;
      const bar = d.cs[bi];
      const sp = spread(pos.pair);

      let xp = 0;
      let reason = "";

      // SL check (intra-bar)
      if (pos.dir === "long" && bar.l <= pos.sl) {
        xp = pos.sl * (1 - sp * SL_SLIP);
        reason = "sl";
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        xp = pos.sl * (1 + sp * SL_SLIP);
        reason = "sl";
      }

      // TP check
      if (!reason) {
        if (pos.dir === "long" && bar.h >= pos.tp) {
          xp = pos.tp * (1 - sp);
          reason = "tp";
        } else if (pos.dir === "short" && bar.l <= pos.tp) {
          xp = pos.tp * (1 + sp);
          reason = "tp";
        }
      }

      // Max hold
      if (!reason && ts - pos.et >= maxHoldMs) {
        xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        reason = "mh";
      }

      if (reason) {
        trades.push({
          pair: pos.pair,
          dir: pos.dir,
          ep: pos.ep,
          xp,
          et: pos.et,
          xt: ts,
          pnl: pnl(pos.pair, pos.ep, xp, pos.dir, reason === "sl"),
          reason,
        });
        open.delete(key);
        closedThisBar.add(pos.pair);
      }
    }

    // --- ENTRIES ---
    for (const pair of pairs) {
      if (open.has(pair) || closedThisBar.has(pair)) continue;
      const idxMap = tsToIdx.get(pair);
      if (!idxMap) continue;
      const bi = idxMap.get(ts);
      if (bi === undefined || bi < 60) continue;

      const sig = signalFn(pair, bi, allData);
      if (!sig) continue;

      // Max per direction cap
      const dirCount = [...open.values()].filter(
        (p) => p.dir === sig.dir
      ).length;
      if (dirCount >= maxPerDir) continue;

      const d = allData.get(pair)!;
      const entryRaw = d.cs[bi].o;
      const sp = spread(pair);
      const entry =
        sig.dir === "long" ? entryRaw * (1 + sp) : entryRaw * (1 - sp);

      // Recalculate SL/TP based on entry with spread
      const slDist = Math.abs(sig.sl - entryRaw) / entryRaw;
      const tpDist = Math.abs(sig.tp - entryRaw) / entryRaw;
      const sl =
        sig.dir === "long" ? entry * (1 - slDist) : entry * (1 + slDist);
      const tp =
        sig.dir === "long" ? entry * (1 + tpDist) : entry * (1 - tpDist);

      open.set(pair, { pair, dir: sig.dir, ep: entry, et: ts, sl, tp });
    }
  }

  return trades;
}

// ─── Strategy 1: GARCH on 4h bars ──────────────────────────────────
function buildGarch4h(
  btcData: { cs: C[]; ema9: number[]; ema21: number[]; tsMap: Map<number, number> }
): SignalFn {
  const Z_LONG = 4.5;
  const Z_SHORT = -3.0;
  const MOM_LB = 3;
  const VOL_WIN = 20;
  const ADX_L = 30;
  const ADX_S = 25;
  const VOL_LB = 5;
  const VOL_RATIO = 0.9;
  const SL = 0.04;
  const TP = 0.10;

  return (pair, barIdx, allData) => {
    const d = allData.get(pair)!;
    const prev = barIdx - 1;
    if (prev < VOL_WIN + MOM_LB + 1) return null;

    const z = d.zScores[prev];
    if (isNaN(z) || z === 0) return null;

    const goLong = z > Z_LONG;
    const goShort = z < Z_SHORT;
    if (!goLong && !goShort) return null;

    // ADX filter
    const adx = d.adx[prev];
    if (!adx || adx === 0) return null;
    if (goLong && adx < ADX_L) return null;
    if (goShort && adx < ADX_S) return null;

    // EMA filter
    const e9 = d.ema9[prev];
    const e21 = d.ema21[prev];
    if (!e9 || !e21 || e9 === 0 || e21 === 0) return null;
    if (goLong && e9 <= e21) return null;
    if (goShort && e9 >= e21) return null;

    // ATR vol filter
    const atrNow = d.atr[prev];
    const atrOld = d.atr[prev - VOL_LB];
    if (!atrNow || !atrOld || atrNow === 0 || atrOld === 0) return null;
    if (atrNow < VOL_RATIO * atrOld) return null;

    // BTC regime
    const btcTs = d.cs[barIdx].t;
    const btcIdx = btcData.tsMap.get(btcTs);
    if (btcIdx === undefined || btcIdx < 2) return null;
    const bp = btcIdx - 1;
    const be9 = btcData.ema9[bp];
    const be21 = btcData.ema21[bp];
    if (!be9 || !be21 || be9 === 0 || be21 === 0) return null;
    if (goLong && be9 <= be21) return null;
    if (goShort && be9 >= be21) return null;

    const dir: "long" | "short" = goLong ? "long" : "short";
    const ep = d.cs[barIdx].o;
    const sl = dir === "long" ? ep * (1 - SL) : ep * (1 + SL);
    const tp = dir === "long" ? ep * (1 + TP) : ep * (1 - TP);
    return { dir, sl, tp };
  };
}

// ─── Strategy 2: RSI Extreme + Filters ─────────────────────────────
// Mean-reversion logic: RSI hit extreme, now turning back.
// Long: RSI was below threshold on bar i-2, now rising on bar i-1 + BTC bullish
// Short: RSI was above threshold on bar i-2, now falling on bar i-1
// No EMA filter (contradicts mean-reversion entry at extremes)
function buildRSIExtreme(
  rsiLong: number,
  rsiShort: number,
  btcData: { cs: C[]; ema9: number[]; ema21: number[]; tsMap: Map<number, number> }
): SignalFn {
  const SL = 0.04;
  const TP = 0.10;

  return (pair, barIdx, allData) => {
    const d = allData.get(pair)!;
    const prev = barIdx - 1;
    const prev2 = barIdx - 2;
    if (prev2 < 15) return null;

    const rsiNow = d.rsi[prev];
    const rsiPrev = d.rsi[prev2];
    if (isNaN(rsiNow) || isNaN(rsiPrev)) return null;

    // Long: RSI was below threshold, now turning up
    const goLong = rsiPrev < rsiLong && rsiNow > rsiPrev;
    // Short: RSI was above threshold, now turning down
    const goShort = rsiPrev > rsiShort && rsiNow < rsiPrev;
    if (!goLong && !goShort) return null;

    // BTC filter (longs only)
    if (goLong) {
      const btcTs = d.cs[barIdx].t;
      const btcIdx = btcData.tsMap.get(btcTs);
      if (btcIdx === undefined || btcIdx < 2) return null;
      const bp = btcIdx - 1;
      const be9 = btcData.ema9[bp];
      const be21 = btcData.ema21[bp];
      if (!be9 || !be21 || be9 === 0 || be21 === 0) return null;
      if (be9 <= be21) return null;
    }

    const dir: "long" | "short" = goLong ? "long" : "short";
    const ep = d.cs[barIdx].o;
    const sl = dir === "long" ? ep * (1 - SL) : ep * (1 + SL);
    const tp = dir === "long" ? ep * (1 + TP) : ep * (1 - TP);
    return { dir, sl, tp };
  };
}

// ─── Strategy 3: Bollinger Band Extreme + Filters ──────────────────
function buildBBExtreme(
  btcData: { cs: C[]; ema9: number[]; ema21: number[]; tsMap: Map<number, number> }
): SignalFn {
  const SL = 0.04;
  const TP = 0.10;
  const ADX_MIN = 25;

  return (pair, barIdx, allData) => {
    const d = allData.get(pair)!;
    const prev = barIdx - 1;
    if (prev < 30) return null;

    const close = d.cs[prev].c;
    const upper = d.bbUpper[prev];
    const lower = d.bbLower[prev];
    if (!upper || !lower || upper === 0 || lower === 0) return null;

    const goLong = close < lower;
    const goShort = close > upper;
    if (!goLong && !goShort) return null;

    // ADX filter
    const adx = d.adx[prev];
    if (!adx || adx < ADX_MIN) return null;

    // BTC filter (longs only)
    if (goLong) {
      const btcTs = d.cs[barIdx].t;
      const btcIdx = btcData.tsMap.get(btcTs);
      if (btcIdx === undefined || btcIdx < 2) return null;
      const bp = btcIdx - 1;
      const be9 = btcData.ema9[bp];
      const be21 = btcData.ema21[bp];
      if (!be9 || !be21 || be9 === 0 || be21 === 0) return null;
      if (be9 <= be21) return null;
    }

    const dir: "long" | "short" = goLong ? "long" : "short";
    const ep = d.cs[barIdx].o;
    const sl = dir === "long" ? ep * (1 - SL) : ep * (1 + SL);
    const tp = dir === "long" ? ep * (1 + TP) : ep * (1 - TP);
    return { dir, sl, tp };
  };
}

// ─── Strategy 4: Multi-Timeframe Z-Score ───────────────────────────
function buildMTFZScore(
  h4Data: Map<string, { cs: C[]; zScores: number[]; tsMap: Map<number, number> }>,
  btcData: { cs: C[]; ema9: number[]; ema21: number[]; tsMap: Map<number, number> }
): SignalFn {
  const Z_1H_LONG = 4.5;
  const Z_1H_SHORT = -3.0;
  const Z_4H_LONG = 3.0;
  const Z_4H_SHORT = -2.0;
  const ADX_L = 30;
  const ADX_S = 25;
  const SL = 0.04;
  const TP = 0.10;

  return (pair, barIdx, allData) => {
    const d = allData.get(pair)!;
    const prev = barIdx - 1;
    if (prev < 30) return null;

    // 1h z-score
    const z1h = d.zScores[prev];
    if (isNaN(z1h) || z1h === 0) return null;

    const goLong = z1h > Z_1H_LONG;
    const goShort = z1h < Z_1H_SHORT;
    if (!goLong && !goShort) return null;

    // Find corresponding 4h bar
    const barTs = d.cs[prev].t;
    const h4d = h4Data.get(pair);
    if (!h4d) return null;
    const h4Ts = Math.floor(barTs / (4 * H)) * (4 * H);
    const h4Idx = h4d.tsMap.get(h4Ts);
    if (h4Idx === undefined || h4Idx < 1) return null;

    // 4h z-score confirmation
    const z4h = h4d.zScores[h4Idx];
    if (isNaN(z4h) || z4h === 0) return null;
    if (goLong && z4h <= Z_4H_LONG) return null;
    if (goShort && z4h >= Z_4H_SHORT) return null;

    // ADX filter on 1h
    const adx = d.adx[prev];
    if (!adx || adx === 0) return null;
    if (goLong && adx < ADX_L) return null;
    if (goShort && adx < ADX_S) return null;

    // EMA filter on 1h
    const e9 = d.ema9[prev];
    const e21 = d.ema21[prev];
    if (!e9 || !e21 || e9 === 0 || e21 === 0) return null;
    if (goLong && e9 <= e21) return null;
    if (goShort && e9 >= e21) return null;

    // BTC regime
    const btcTs = d.cs[barIdx].t;
    const btcIdx = btcData.tsMap.get(btcTs);
    if (btcIdx === undefined || btcIdx < 2) return null;
    const bp = btcIdx - 1;
    const be9 = btcData.ema9[bp];
    const be21 = btcData.ema21[bp];
    if (!be9 || !be21 || be9 === 0 || be21 === 0) return null;
    if (goLong && be9 <= be21) return null;
    if (goShort && be9 >= be21) return null;

    const dir: "long" | "short" = goLong ? "long" : "short";
    const ep = d.cs[barIdx].o;
    const sl = dir === "long" ? ep * (1 - SL) : ep * (1 + SL);
    const tp = dir === "long" ? ep * (1 + TP) : ep * (1 - TP);
    return { dir, sl, tp };
  };
}

// ─── Strategy 5: GARCH Optimized ───────────────────────────────────
function buildGarchOptimized(
  btcData: { cs: C[]; ema9: number[]; ema21: number[]; tsMap: Map<number, number> }
): SignalFn {
  const Z_LONG = 4.5;
  const Z_SHORT = -3.0;
  const MOM_LB = 3;
  const VOL_WIN = 20;
  const VOL_LB = 5;
  const VOL_RATIO = 0.9;
  const SL = 0.04; // wider SL
  const TP = 0.10;

  return (pair, barIdx, allData) => {
    const d = allData.get(pair)!;
    const prev = barIdx - 1;
    if (prev < VOL_WIN + MOM_LB + 1) return null;

    const z = d.zScores[prev];
    if (isNaN(z) || z === 0) return null;

    const goLong = z > Z_LONG;
    const goShort = z < Z_SHORT;
    if (!goLong && !goShort) return null;

    // NO ADX filter (removed)

    // EMA filter
    const e9 = d.ema9[prev];
    const e21 = d.ema21[prev];
    if (!e9 || !e21 || e9 === 0 || e21 === 0) return null;
    if (goLong && e9 <= e21) return null;
    if (goShort && e9 >= e21) return null;

    // ATR vol filter
    const atrNow = d.atr[prev];
    const atrOld = d.atr[prev - VOL_LB];
    if (!atrNow || !atrOld || atrNow === 0 || atrOld === 0) return null;
    if (atrNow < VOL_RATIO * atrOld) return null;

    // BTC regime
    const btcTs = d.cs[barIdx].t;
    const btcIdx = btcData.tsMap.get(btcTs);
    if (btcIdx === undefined || btcIdx < 2) return null;
    const bp = btcIdx - 1;
    const be9 = btcData.ema9[bp];
    const be21 = btcData.ema21[bp];
    if (!be9 || !be21 || be9 === 0 || be21 === 0) return null;
    if (goLong && be9 <= be21) return null;
    if (goShort && be9 >= be21) return null;

    const dir: "long" | "short" = goLong ? "long" : "short";
    const ep = d.cs[barIdx].o;
    const sl = dir === "long" ? ep * (1 - SL) : ep * (1 + SL);
    const tp = dir === "long" ? ep * (1 + TP) : ep * (1 - TP);
    return { dir, sl, tp };
  };
}

// ─── Strategy 6: Volume Spike + Z-Score ────────────────────────────
function buildVolSpike(
  btcData: { cs: C[]; ema9: number[]; ema21: number[]; tsMap: Map<number, number> }
): SignalFn {
  const Z_LONG_THRESH = -3.0; // selling climax -> buy
  const Z_SHORT_THRESH = 4.5; // buying climax -> sell
  const VOL_MULT = 2.0;
  const SL = 0.04;
  const TP = 0.10;

  return (pair, barIdx, allData) => {
    const d = allData.get(pair)!;
    const prev = barIdx - 1;
    if (prev < 30) return null;

    const z = d.zScores[prev];
    if (isNaN(z) || z === 0) return null;

    // Volume spike check
    const volAvg = d.volAvg[prev];
    const vol = d.cs[prev].v;
    if (!volAvg || volAvg === 0 || !vol) return null;
    if (vol < VOL_MULT * volAvg) return null;

    const goLong = z < Z_LONG_THRESH; // panic selling
    const goShort = z > Z_SHORT_THRESH; // euphoric buying
    if (!goLong && !goShort) return null;

    // BTC filter (longs only)
    if (goLong) {
      const btcTs = d.cs[barIdx].t;
      const btcIdx = btcData.tsMap.get(btcTs);
      if (btcIdx === undefined || btcIdx < 2) return null;
      const bp = btcIdx - 1;
      const be9 = btcData.ema9[bp];
      const be21 = btcData.ema21[bp];
      if (!be9 || !be21 || be9 === 0 || be21 === 0) return null;
      if (be9 <= be21) return null;
    }

    const dir: "long" | "short" = goLong ? "long" : "short";
    const ep = d.cs[barIdx].o;
    const sl = dir === "long" ? ep * (1 - SL) : ep * (1 + SL);
    const tp = dir === "long" ? ep * (1 + TP) : ep * (1 - TP);
    return { dir, sl, tp };
  };
}

// ─── Strategy 7: Stochastic Extreme + Filters ──────────────────────
function buildStochExtreme(
  btcData: { cs: C[]; ema9: number[]; ema21: number[]; tsMap: Map<number, number> }
): SignalFn {
  const SL = 0.04;
  const TP = 0.10;

  return (pair, barIdx, allData) => {
    const d = allData.get(pair)!;
    const prev = barIdx - 1;
    const prev2 = barIdx - 2;
    if (prev2 < 20) return null;

    const kNow = d.stochK[prev];
    const dNow = d.stochD[prev];
    const kPrev = d.stochK[prev2];
    const dPrev = d.stochD[prev2];
    if (
      isNaN(kNow) || isNaN(dNow) || isNaN(kPrev) || isNaN(dPrev)
    )
      return null;

    // %K crosses above %D from below 10
    const goLong = kNow < 10 && kPrev <= dPrev && kNow > dNow;
    // %K crosses below %D from above 90
    const goShort = kNow > 90 && kPrev >= dPrev && kNow < dNow;
    if (!goLong && !goShort) return null;

    // EMA filter
    const e9 = d.ema9[prev];
    const e21 = d.ema21[prev];
    if (!e9 || !e21 || e9 === 0 || e21 === 0) return null;
    if (goLong && e9 <= e21) return null;
    if (goShort && e9 >= e21) return null;

    const dir: "long" | "short" = goLong ? "long" : "short";
    const ep = d.cs[barIdx].o;
    const sl = dir === "long" ? ep * (1 - SL) : ep * (1 + SL);
    const tp = dir === "long" ? ep * (1 + TP) : ep * (1 - TP);
    return { dir, sl, tp };
  };
}

// ─── MAIN ───────────────────────────────────────────────────────────
console.log("Loading 5m data and aggregating...\n");

// Load all 5m data
const raw5m = new Map<string, C[]>();
const allToLoad = [...new Set([...PAIRS, "BTC"])];
for (const pair of allToLoad) {
  const bars = load5m(pair);
  if (bars.length > 0) {
    raw5m.set(pair, bars);
    console.log(`  ${pair}: ${bars.length} 5m bars`);
  } else {
    console.log(`  [SKIP] ${pair} - no data`);
  }
}

// Aggregate to 1h
console.log("\nAggregating to 1h...");
const h1Data = new Map<string, any>();
for (const [pair, bars] of raw5m) {
  const cs = aggregateByTime(bars, H);
  if (cs.length < 200) {
    console.log(`  [SKIP] ${pair} 1h - only ${cs.length} bars`);
    continue;
  }
  const closes = cs.map((c) => c.c);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const atr = calcATR(cs, 14);
  const adx = calcADX(cs, 14);
  const rsi = calcRSI(closes, 14);
  const bb = calcBB(closes, 20, 2.5);
  const zScores = calcZScores(cs, 3, 20);
  const stoch = calcStochastic(cs, 14, 3);
  const volAvg = calcVolAvg(cs, 20);
  const tsMap = new Map<number, number>();
  cs.forEach((c, i) => tsMap.set(c.t, i));
  h1Data.set(pair, {
    cs,
    ema9,
    ema21,
    atr,
    adx,
    rsi,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    zScores,
    stochK: stoch.k,
    stochD: stoch.d,
    volAvg,
    tsMap,
  });
}

// Aggregate to 4h
console.log("Aggregating to 4h...");
const h4Data = new Map<string, any>();
for (const [pair, bars] of raw5m) {
  const cs = aggregateByTime(bars, 4 * H);
  if (cs.length < 200) continue;
  const closes = cs.map((c) => c.c);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const atr = calcATR(cs, 14);
  const adx = calcADX(cs, 14);
  const zScores = calcZScores(cs, 3, 20);
  const tsMap = new Map<number, number>();
  cs.forEach((c, i) => tsMap.set(c.t, i));
  h4Data.set(pair, { cs, ema9, ema21, atr, adx, zScores, tsMap });
}

const btc1h = h1Data.get("BTC");
const btc4h = h4Data.get("BTC");
if (!btc1h) {
  console.error("BTC 1h data missing");
  process.exit(1);
}
if (!btc4h) {
  console.error("BTC 4h data missing");
  process.exit(1);
}

const tradePairs = PAIRS.filter((p) => h1Data.has(p));
console.log(`\nTradeable pairs: ${tradePairs.length} (${tradePairs.join(", ")})\n`);

const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

function runStrategy(
  name: string,
  signalFn: SignalFn,
  data: Map<string, any>,
  maxHoldMs: number,
  maxPerDir: number = 6
) {
  console.log("=".repeat(70));
  console.log(name);
  console.log("=".repeat(70));

  const fullTrades = simulate(
    tradePairs,
    data,
    signalFn,
    FULL_START,
    FULL_END,
    maxHoldMs,
    maxPerDir
  );
  const oosTrades = simulate(
    tradePairs,
    data,
    signalFn,
    OOS_START,
    FULL_END,
    maxHoldMs,
    maxPerDir
  );

  const fullStats = calcStats(fullTrades, FULL_START, FULL_END);
  const oosStats = calcStats(oosTrades, OOS_START, FULL_END);

  console.log("\n  [FULL 2023-01 to 2026-03]");
  console.log(fmtStats(fullStats));

  // Exit reasons
  const reasons = new Map<string, number>();
  for (const t of fullTrades)
    reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
  console.log(
    `  Exits: ${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`
  );

  console.log("\n  [OOS 2025-09 to 2026-03]");
  console.log(fmtStats(oosStats));

  const oosReasons = new Map<string, number>();
  for (const t of oosTrades)
    oosReasons.set(t.reason, (oosReasons.get(t.reason) ?? 0) + 1);
  console.log(
    `  Exits: ${[...oosReasons.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`
  );

  // Long vs short split
  const fullLong = fullTrades.filter((t) => t.dir === "long");
  const fullShort = fullTrades.filter((t) => t.dir === "short");
  const oosLong = oosTrades.filter((t) => t.dir === "long");
  const oosShort = oosTrades.filter((t) => t.dir === "short");
  console.log(
    `\n  Direction split (Full):  Long: ${fullLong.length} trades, PnL ${fullLong.reduce((s, t) => s + t.pnl, 0).toFixed(2)}  |  Short: ${fullShort.length} trades, PnL ${fullShort.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`
  );
  console.log(
    `  Direction split (OOS):  Long: ${oosLong.length} trades, PnL ${oosLong.reduce((s, t) => s + t.pnl, 0).toFixed(2)}  |  Short: ${oosShort.length} trades, PnL ${oosShort.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`
  );
  console.log();

  return { fullStats, oosStats };
}

// ─── Run All Strategies ─────────────────────────────────────────────
const results: Array<{ name: string; full: Stats; oos: Stats }> = [];

// 1. GARCH on 4h bars (max hold: 30 × 4h bars = 120h = 5 days)
{
  const sig = buildGarch4h(btc4h);
  const r = runStrategy(
    "1. GARCH 4h (z>4.5/-3.0, ADX+EMA+BTC, SL4%/TP10%, 5d hold)",
    sig,
    h4Data,
    30 * 4 * H,
    6
  );
  results.push({ name: "GARCH-4h", full: r.fullStats, oos: r.oosStats });
}

// 2. RSI Extreme variants
for (const [rsiL, rsiS, label] of [
  [10, 90, "10/90"],
  [15, 85, "15/85"],
  [20, 80, "20/80"],
] as const) {
  const sig = buildRSIExtreme(rsiL, rsiS, btc1h);
  const r = runStrategy(
    `2. RSI Extreme ${label} (EMA+BTC, SL4%/TP10%, 48h hold)`,
    sig,
    h1Data,
    48 * H,
    6
  );
  results.push({
    name: `RSI-${label}`,
    full: r.fullStats,
    oos: r.oosStats,
  });
}

// 3. Bollinger Band Extreme
{
  const sig = buildBBExtreme(btc1h);
  const r = runStrategy(
    "3. BB Extreme (BB20,2.5 + ADX>25 + BTC, SL4%/TP10%, 48h hold)",
    sig,
    h1Data,
    48 * H,
    6
  );
  results.push({ name: "BB-Extreme", full: r.fullStats, oos: r.oosStats });
}

// 4. Multi-Timeframe Z-Score
{
  const sig = buildMTFZScore(h4Data, btc1h);
  const r = runStrategy(
    "4. MTF Z-Score (1h z>4.5 + 4h z>3.0 + ADX+EMA+BTC, SL4%/TP10%, 48h hold)",
    sig,
    h1Data,
    48 * H,
    6
  );
  results.push({ name: "MTF-ZScore", full: r.fullStats, oos: r.oosStats });
}

// 5. GARCH Optimized (wider SL, longer hold, no ADX)
{
  const sig = buildGarchOptimized(btc1h);
  const r = runStrategy(
    "5. GARCH Optimized (SL4%, 168h hold, NO ADX, EMA+BTC+ATR)",
    sig,
    h1Data,
    168 * H,
    6
  );
  results.push({
    name: "GARCH-Opt",
    full: r.fullStats,
    oos: r.oosStats,
  });
}

// 6. Volume Spike + Z-Score
{
  const sig = buildVolSpike(btc1h);
  const r = runStrategy(
    "6. VolSpike+Z (z<-3 vol>2x = long, z>4.5 vol>2x = short, BTC, SL4%/TP10%, 48h)",
    sig,
    h1Data,
    48 * H,
    6
  );
  results.push({ name: "VolSpike-Z", full: r.fullStats, oos: r.oosStats });
}

// 7. Stochastic Extreme
{
  const sig = buildStochExtreme(btc1h);
  const r = runStrategy(
    "7. Stoch Extreme (%K<10 cross + EMA, %K>90 cross + EMA, SL4%/TP10%, 48h)",
    sig,
    h1Data,
    48 * H,
    6
  );
  results.push({
    name: "Stoch-Ext",
    full: r.fullStats,
    oos: r.oosStats,
  });
}

// ─── Summary Comparison ─────────────────────────────────────────────
console.log("\n" + "=".repeat(70));
console.log("SUMMARY COMPARISON");
console.log("=".repeat(70));
console.log(
  `${"Strategy".padEnd(16)} | ${"N".padStart(5)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"Shrp".padStart(6)} ${"PnL".padStart(10)} ${"$/day".padStart(8)} ${"MaxDD".padStart(8)} | ${"N".padStart(5)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"Shrp".padStart(6)} ${"PnL".padStart(10)} ${"$/day".padStart(8)} ${"MaxDD".padStart(8)}`
);
console.log(
  `${"".padEnd(16)} | ${"─── FULL PERIOD ───────────────────────────────────".padEnd(55)} | ${"─── OOS (2025-09+) ───────────────────────────────".padEnd(55)}`
);
console.log("-".repeat(140));

for (const r of results) {
  const f = r.full;
  const o = r.oos;
  const fPnl = `${f.total >= 0 ? "+" : ""}$${f.total.toFixed(2)}`;
  const fPd = `${f.perDay >= 0 ? "+" : ""}$${f.perDay.toFixed(2)}`;
  const oPnl = `${o.total >= 0 ? "+" : ""}$${o.total.toFixed(2)}`;
  const oPd = `${o.perDay >= 0 ? "+" : ""}$${o.perDay.toFixed(2)}`;

  console.log(
    `${r.name.padEnd(16)} | ${String(f.n).padStart(5)} ${f.wr.toFixed(1).padStart(6)} ${(f.pf === Infinity ? "inf" : f.pf.toFixed(2)).padStart(6)} ${f.sharpe.toFixed(2).padStart(6)} ${fPnl.padStart(10)} ${fPd.padStart(8)} ${("$" + f.dd.toFixed(2)).padStart(8)} | ${String(o.n).padStart(5)} ${o.wr.toFixed(1).padStart(6)} ${(o.pf === Infinity ? "inf" : o.pf.toFixed(2)).padStart(6)} ${o.sharpe.toFixed(2).padStart(6)} ${oPnl.padStart(10)} ${oPd.padStart(8)} ${("$" + o.dd.toFixed(2)).padStart(8)}`
  );
}

console.log("\nDone.");
