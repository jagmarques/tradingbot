/**
 * Walk-Forward Validation: BTC 4h EMA(9/21) vs Daily EMA(20/50) Long Filter
 *
 * Tests whether the 4h EMA upgrade is robust or overfit by:
 * 1. Walk-forward: 4 train/test periods
 * 2. Quarterly breakdown: 8 quarters (~4 months each)
 * 3. Bootstrap: 200 resamples for 5th percentile PF and $/day
 *
 * Same engines: Donchian SMA(20/50) + Supertrend(14,1.75)
 * 14 pairs, SMA ATR, doubled half-spreads, i-1/i-2 look-ahead fix.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-btc-filter-walkforward.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
type Dir = "long" | "short";

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number;
  margin: number;
}

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const DAY = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const MAX_POS = 10;

// Doubled half-spreads (conservative)
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

// Engine sizing
const DON_MARGIN = 7;
const DON_LEV = 10;
const DON_NOT = DON_MARGIN * DON_LEV;
const ST_MARGIN = 5;
const ST_LEV = 10;
const ST_NOT = ST_MARGIN * ST_LEV;

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
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
function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
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

// Donchian on CLOSES
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

function entryPx(pair: string, dir: Dir, raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function exitPx(pair: string, dir: Dir, raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: Dir, ep: number, xp: number, notional: number): number {
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
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, DAY, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
}
console.log("Aggregated: daily + 4h candles ready.\n");

// ─── BTC indicator pre-computation ──────────────────────────────────
const btcDaily = dailyData.get("BTC")!;
const btcDC = btcDaily.map(c => c.c);
const btcDailyEma20 = calcEMA(btcDC, 20);
const btcDailyEma50 = calcEMA(btcDC, 50);

const btc4h = h4Data.get("BTC")!;
const btc4hC = btc4h.map(c => c.c);
const btc4hEma9 = calcEMA(btc4hC, 9);
const btc4hEma21 = calcEMA(btc4hC, 21);

// Helpers: find last BTC bar index at or before t
function btcDailyIdx(t: number): number {
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t <= t) return i;
  }
  return -1;
}
function btc4hIdx(t: number): number {
  for (let i = btc4h.length - 1; i >= 0; i--) {
    if (btc4h[i].t <= t) return i;
  }
  return -1;
}

// BTC indicator accessors with look-ahead fix
function btcEma20At(dailyIdx: number): number {
  return dailyIdx >= 0 && dailyIdx < btcDailyEma20.length ? btcDailyEma20[dailyIdx] : 0;
}
function btcEma50At(dailyIdx: number): number {
  return dailyIdx >= 0 && dailyIdx < btcDailyEma50.length ? btcDailyEma50[dailyIdx] : 0;
}
function btc4hEma9At(idx: number): number {
  return idx >= 0 && idx < btc4hEma9.length ? btc4hEma9[idx] : 0;
}
function btc4hEma21At(idx: number): number {
  return idx >= 0 && idx < btc4hEma21.length ? btc4hEma21[idx] : 0;
}

// ─── Filter definitions ─────────────────────────────────────────────
type EntryFilter = (dir: Dir, t: number) => boolean;

interface FilterConfig {
  name: string;
  entryFilter: EntryFilter;
}

const BASELINE: FilterConfig = {
  name: "Baseline: Daily EMA(20/50)",
  entryFilter: (dir, t) => {
    if (dir === "short") return true;
    const idx = btcDailyIdx(t);
    if (idx < 1) return false;
    const e20 = btcEma20At(idx - 1);
    const e50 = btcEma50At(idx - 1);
    if (e20 === 0 || e50 === 0) return false;
    return e20 > e50;
  },
};

const UPGRADE: FilterConfig = {
  name: "Upgrade: 4h EMA(9/21)",
  entryFilter: (dir, t) => {
    if (dir === "short") return true;
    const idx = btc4hIdx(t);
    if (idx < 1) return false;
    const e9 = btc4hEma9At(idx - 1);
    const e21 = btc4hEma21At(idx - 1);
    if (e9 === 0 || e21 === 0) return false;
    return e9 > e21;
  },
};

// ─── Signal generation ──────────────────────────────────────────────
interface Signal {
  pair: string; engine: string; dir: Dir; ep: number; et: number;
  sl: number; maxHold: number; margin: number; notional: number;
  donchExit?: { dailyCs: C[]; exitLb: number };
  stExit?: { h4Cs: C[]; stDir: number[]; entryBarIdx: number };
}

function generateSignalsA(startTs: number, endTs: number, entryFilter: EntryFilter): Signal[] {
  const signals: Signal[] = [];
  const SMA_FAST = 20, SMA_SLOW = 50, EXIT_LB = 15;
  const ATR_MULT = 3, ATR_PER = 14, MAX_HOLD = 60 * DAY;

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < SMA_SLOW + ATR_PER + 5) continue;

    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, SMA_FAST);
    const slow = calcSMA(closes, SMA_SLOW);
    const atrArr = calcATR(cs, ATR_PER);
    const warmup = SMA_SLOW + 1;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < startTs || bar.t >= endTs) continue;

      const prev2 = i - 2;
      const prev1 = i - 1;
      if (prev2 < 0) continue;
      const prevFast = fast[prev2];
      const prevSlow = slow[prev2];
      const curFast = fast[prev1];
      const curSlow = slow[prev1];
      if (prevFast === 0 || prevSlow === 0 || curFast === 0 || curSlow === 0) continue;

      let dir: Dir | null = null;
      if (prevFast <= prevSlow && curFast > curSlow) dir = "long";
      else if (prevFast >= prevSlow && curFast < curSlow) dir = "short";
      if (!dir) continue;

      if (!entryFilter(dir, bar.t)) continue;

      const prevATR = atrArr[i - 1];
      if (prevATR <= 0) continue;

      const ep = entryPx(pair, dir, bar.o);
      let sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;
      if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
      else sl = Math.min(sl, ep * (1 + 0.035));

      signals.push({
        pair, engine: "A", dir, ep, et: bar.t, sl,
        maxHold: MAX_HOLD, margin: DON_MARGIN, notional: DON_NOT,
        donchExit: { dailyCs: cs, exitLb: EXIT_LB },
      });
    }
  }
  return signals;
}

function generateSignalsB(startTs: number, endTs: number, entryFilter: EntryFilter): Signal[] {
  const signals: Signal[] = [];
  const ST_PER = 14, ST_MULT = 1.75;
  const ATR_MULT = 3, MAX_HOLD = 60 * DAY;

  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < ST_PER + 30) continue;

    const { dir: stDir } = calcSupertrend(cs, ST_PER, ST_MULT);
    const atrArr = calcATR(cs, ST_PER);

    for (let i = ST_PER + 2; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < startTs || bar.t >= endTs) continue;

      const prevDir = stDir[i - 1];
      const prevPrevDir = stDir[i - 2];
      if (prevDir === prevPrevDir) continue;

      const dir: Dir = prevDir === 1 ? "long" : "short";

      if (!entryFilter(dir, bar.t)) continue;

      const prevATR = atrArr[i - 1];
      if (prevATR <= 0) continue;

      const ep = entryPx(pair, dir, bar.o);
      let sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;
      if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
      else sl = Math.min(sl, ep * (1 + 0.035));

      signals.push({
        pair, engine: "B", dir, ep, et: bar.t, sl,
        maxHold: MAX_HOLD, margin: ST_MARGIN, notional: ST_NOT,
        stExit: { h4Cs: cs, stDir, entryBarIdx: i },
      });
    }
  }
  return signals;
}

// ─── Simulation ─────────────────────────────────────────────────────
function simulate(startTs: number, endTs: number, filter: FilterConfig): Trade[] {
  const sigA = generateSignalsA(startTs, endTs, filter.entryFilter);
  const sigB = generateSignalsB(startTs, endTs, filter.entryFilter);

  function resolveSignals(signals: Signal[]): Trade[] {
    const trades: Trade[] = [];
    const grouped = new Map<string, Signal[]>();
    for (const sig of signals) {
      const key = `${sig.engine}:${sig.pair}`;
      let arr = grouped.get(key);
      if (!arr) { arr = []; grouped.set(key, arr); }
      arr.push(sig);
    }

    for (const [, sigs] of grouped) {
      sigs.sort((a, b) => a.et - b.et);
      let posEnd = 0;

      for (const sig of sigs) {
        if (sig.et < posEnd) continue;

        let xp = 0, xt = 0, isSL = false;

        if (sig.donchExit) {
          const cs = sig.donchExit.dailyCs;
          const exitLb = sig.donchExit.exitLb;
          let entryIdx = -1;
          for (let i = 0; i < cs.length; i++) {
            if (cs[i].t === sig.et) { entryIdx = i; break; }
          }
          if (entryIdx < 0) continue;

          for (let i = entryIdx + 1; i < cs.length; i++) {
            const bar = cs[i];

            if (sig.dir === "long" && bar.l <= sig.sl) { xp = sig.sl; xt = bar.t; isSL = true; break; }
            if (sig.dir === "short" && bar.h >= sig.sl) { xp = sig.sl; xt = bar.t; isSL = true; break; }

            if (i >= exitLb + 1) {
              if (sig.dir === "long") {
                const chanLow = donchCloseLow(cs, i, exitLb);
                if (bar.c < chanLow) { xp = bar.c; xt = bar.t; break; }
              } else {
                const chanHigh = donchCloseHigh(cs, i, exitLb);
                if (bar.c > chanHigh) { xp = bar.c; xt = bar.t; break; }
              }
            }

            if (bar.t - sig.et >= sig.maxHold) { xp = bar.c; xt = bar.t; break; }
          }
        } else if (sig.stExit) {
          const cs = sig.stExit.h4Cs;
          const stDir = sig.stExit.stDir;
          const entryIdx = sig.stExit.entryBarIdx;

          for (let i = entryIdx + 1; i < cs.length; i++) {
            const bar = cs[i];

            if (sig.dir === "long" && bar.l <= sig.sl) { xp = sig.sl; xt = bar.t; isSL = true; break; }
            if (sig.dir === "short" && bar.h >= sig.sl) { xp = sig.sl; xt = bar.t; isSL = true; break; }

            if (stDir[i - 1] !== stDir[i - 2]) { xp = bar.o; xt = bar.t; break; }

            if (bar.t - sig.et >= sig.maxHold) { xp = bar.c; xt = bar.t; break; }
          }
        }

        if (xp > 0 && xt > 0) {
          const xpAdj = exitPx(sig.pair, sig.dir, xp, isSL);
          const pnl = calcPnl(sig.dir, sig.ep, xpAdj, sig.notional);
          trades.push({
            pair: sig.pair, engine: sig.engine, dir: sig.dir,
            ep: sig.ep, xp: xpAdj, et: sig.et, xt,
            pnl, margin: sig.margin,
          });
          posEnd = xt;
        }
      }
    }
    return trades;
  }

  const rawA = resolveSignals(sigA);
  const rawB = resolveSignals(sigB);

  // Apply position cap
  interface Event { t: number; type: "entry" | "exit"; trade: Trade; }
  const events: Event[] = [];
  for (const tr of [...rawA, ...rawB]) {
    events.push({ t: tr.et, type: "entry", trade: tr });
    events.push({ t: tr.xt, type: "exit", trade: tr });
  }
  events.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));

  const openPositions = new Map<string, Trade>();
  const accepted: Trade[] = [];

  for (const evt of events) {
    if (evt.type === "exit") {
      const key = `${evt.trade.engine}:${evt.trade.pair}`;
      if (openPositions.has(key)) openPositions.delete(key);
    } else {
      const key = `${evt.trade.engine}:${evt.trade.pair}`;
      if (openPositions.has(key)) continue;
      if (openPositions.size >= MAX_POS) continue;
      openPositions.set(key, evt.trade);
      accepted.push(evt.trade);
    }
  }

  return accepted;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
  longs: number; shorts: number;
}

function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, longs: 0, shorts: 0 };
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
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const std = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = Math.max((endTs - startTs) / DAY, 1);

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe, dd: maxDD, total,
    perDay: total / days,
    longs: trades.filter(t => t.dir === "long").length,
    shorts: trades.filter(t => t.dir === "short").length,
  };
}

// ─── Filter trades to a date range (for trades that EXIT within the range) ──
function filterTrades(trades: Trade[], start: number, end: number): Trade[] {
  return trades.filter(t => t.xt >= start && t.xt < end);
}

// ─── Bootstrap ──────────────────────────────────────────────────────
function bootstrap(trades: Trade[], nResamples: number, startTs: number, endTs: number): { pf5: number; pd5: number; pfMed: number; pdMed: number } {
  if (trades.length < 5) return { pf5: 0, pd5: 0, pfMed: 0, pdMed: 0 };
  const days = Math.max((endTs - startTs) / DAY, 1);
  const pfs: number[] = [];
  const pds: number[] = [];

  for (let r = 0; r < nResamples; r++) {
    // Resample trades with replacement
    const sample: Trade[] = [];
    for (let i = 0; i < trades.length; i++) {
      sample.push(trades[Math.floor(Math.random() * trades.length)]);
    }
    const grossP = sample.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossL = Math.abs(sample.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const total = sample.reduce((s, t) => s + t.pnl, 0);
    pfs.push(grossL > 0 ? grossP / grossL : (grossP > 0 ? 10 : 0));
    pds.push(total / days);
  }

  pfs.sort((a, b) => a - b);
  pds.sort((a, b) => a - b);

  const p5idx = Math.floor(nResamples * 0.05);
  const medIdx = Math.floor(nResamples * 0.5);

  return {
    pf5: pfs[p5idx],
    pd5: pds[p5idx],
    pfMed: pfs[medIdx],
    pdMed: pds[medIdx],
  };
}

// ─── Formatting helpers ─────────────────────────────────────────────
function fmtPnl(v: number): string { return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }
function fmtPf(v: number): string { return v === Infinity ? "Inf" : v.toFixed(2); }
function pad(s: string, n: number): string { return s.padStart(n); }

// ========================================================================
// PART 1: WALK-FORWARD VALIDATION (4 periods)
// ========================================================================
console.log("=".repeat(120));
console.log("WALK-FORWARD VALIDATION: BTC 4h EMA(9/21) vs Daily EMA(20/50) Long Filter");
console.log("Donchian SMA(20/50) + Supertrend(14,1.75) | 14 pairs | Doubled spreads | SMA ATR | Look-ahead fix");
console.log("=".repeat(120));

interface WFPeriod {
  label: string;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

const WF_PERIODS: WFPeriod[] = [
  {
    label: "WF-1",
    trainStart: new Date("2023-01-01").getTime(),
    trainEnd: new Date("2023-10-01").getTime(),
    testStart: new Date("2023-10-01").getTime(),
    testEnd: new Date("2024-04-01").getTime(),
  },
  {
    label: "WF-2",
    trainStart: new Date("2023-10-01").getTime(),
    trainEnd: new Date("2024-07-01").getTime(),
    testStart: new Date("2024-07-01").getTime(),
    testEnd: new Date("2025-01-01").getTime(),
  },
  {
    label: "WF-3",
    trainStart: new Date("2024-07-01").getTime(),
    trainEnd: new Date("2025-04-01").getTime(),
    testStart: new Date("2025-04-01").getTime(),
    testEnd: new Date("2025-10-01").getTime(),
  },
  {
    label: "WF-4",
    trainStart: new Date("2025-04-01").getTime(),
    trainEnd: new Date("2026-03-01").getTime(),
    testStart: new Date("2025-10-01").getTime(),
    testEnd: new Date("2026-03-28").getTime(),
  },
];

console.log("\n--- Walk-Forward Periods ---");
for (const p of WF_PERIODS) {
  const ts = (t: number) => new Date(t).toISOString().slice(0, 10);
  console.log(`  ${p.label}: Train ${ts(p.trainStart)}-${ts(p.trainEnd)} | Test ${ts(p.testStart)}-${ts(p.testEnd)}`);
}

// Run both configs on each period
interface WFResult {
  label: string;
  baselineTrain: Metrics;
  baselineTest: Metrics;
  upgradeTrain: Metrics;
  upgradeTest: Metrics;
  upgradeWinsTest: boolean;
}

const wfResults: WFResult[] = [];

console.log("\nRunning walk-forward simulations...");

for (const p of WF_PERIODS) {
  process.stdout.write(`  ${p.label}...`);

  // We need trades from the FULL range to capture trades that enter in train and exit in test
  // But for walk-forward, we want to evaluate signal generation in each period
  // and measure test-period performance by trades that EXIT in the test period.

  // Generate signals for train+test combined, then filter by exit time
  const fullStart = p.trainStart;
  const fullEnd = p.testEnd;

  const baseAll = simulate(fullStart, fullEnd, BASELINE);
  const upgAll = simulate(fullStart, fullEnd, UPGRADE);

  // Train metrics: trades that exit during train period
  const baseTrain = filterTrades(baseAll, p.trainStart, p.trainEnd);
  const upgTrain = filterTrades(upgAll, p.trainStart, p.trainEnd);

  // Test metrics: trades that exit during test period
  const baseTest = filterTrades(baseAll, p.testStart, p.testEnd);
  const upgTest = filterTrades(upgAll, p.testStart, p.testEnd);

  const btm = calcMetrics(baseTrain, p.trainStart, p.trainEnd);
  const btsm = calcMetrics(baseTest, p.testStart, p.testEnd);
  const utm = calcMetrics(upgTrain, p.trainStart, p.trainEnd);
  const utsm = calcMetrics(upgTest, p.testStart, p.testEnd);

  const upgradeWins = utsm.perDay > btsm.perDay;
  wfResults.push({
    label: p.label,
    baselineTrain: btm,
    baselineTest: btsm,
    upgradeTrain: utm,
    upgradeTest: utsm,
    upgradeWinsTest: upgradeWins,
  });

  console.log(` done (base test: ${btsm.n} trades, upg test: ${utsm.n} trades)`);
}

// Print walk-forward table
console.log("\n" + "=".repeat(120));
console.log("WALK-FORWARD RESULTS: TEST PERIOD COMPARISON");
console.log("=".repeat(120));

console.log(
  `${"Period".padEnd(8)} ` +
  `${"Config".padEnd(26)} ` +
  `${pad("N", 5)}  ` +
  `${pad("$/day", 8)}  ` +
  `${pad("Total", 9)}  ` +
  `${pad("WR%", 6)}  ` +
  `${pad("PF", 6)}  ` +
  `${pad("MaxDD", 7)}  ` +
  `${pad("Sharpe", 7)}  ` +
  `${pad("L/S", 8)}  ` +
  `${pad("Winner?", 8)}`
);
console.log("-".repeat(120));

for (const r of wfResults) {
  // Baseline test row
  const bm = r.baselineTest;
  console.log(
    `${r.label.padEnd(8)} ` +
    `${BASELINE.name.padEnd(26)} ` +
    `${pad(String(bm.n), 5)}  ` +
    `${pad(fmtPnl(bm.perDay), 8)}  ` +
    `${pad(fmtPnl(bm.total), 9)}  ` +
    `${pad(bm.wr.toFixed(1), 6)}  ` +
    `${pad(fmtPf(bm.pf), 6)}  ` +
    `${pad("$" + bm.dd.toFixed(0), 7)}  ` +
    `${pad(bm.sharpe.toFixed(2), 7)}  ` +
    `${pad(bm.longs + "/" + bm.shorts, 8)}  ` +
    `${pad(r.upgradeWinsTest ? "" : "<-- WIN", 8)}`
  );

  // Upgrade test row
  const um = r.upgradeTest;
  console.log(
    `${"".padEnd(8)} ` +
    `${UPGRADE.name.padEnd(26)} ` +
    `${pad(String(um.n), 5)}  ` +
    `${pad(fmtPnl(um.perDay), 8)}  ` +
    `${pad(fmtPnl(um.total), 9)}  ` +
    `${pad(um.wr.toFixed(1), 6)}  ` +
    `${pad(fmtPf(um.pf), 6)}  ` +
    `${pad("$" + um.dd.toFixed(0), 7)}  ` +
    `${pad(um.sharpe.toFixed(2), 7)}  ` +
    `${pad(um.longs + "/" + um.shorts, 8)}  ` +
    `${pad(r.upgradeWinsTest ? "<-- WIN" : "", 8)}`
  );

  // Delta row
  const deltaPd = um.perDay - bm.perDay;
  const deltaPf = um.pf - bm.pf;
  const deltaDD = um.dd - bm.dd;
  console.log(
    `${"".padEnd(8)} ` +
    `${"  delta".padEnd(26)} ` +
    `${pad(String(um.n - bm.n), 5)}  ` +
    `${pad(fmtPnl(deltaPd), 8)}  ` +
    `${"".padEnd(9)}  ` +
    `${"".padEnd(6)}  ` +
    `${pad((deltaPf >= 0 ? "+" : "") + deltaPf.toFixed(2), 6)}  ` +
    `${pad((deltaDD >= 0 ? "+" : "-") + "$" + Math.abs(deltaDD).toFixed(0), 7)}  ` +
    `${"".padEnd(7)}  ` +
    `${"".padEnd(8)}  ` +
    `${"".padEnd(8)}`
  );
  console.log("-".repeat(120));
}

const wfWins = wfResults.filter(r => r.upgradeWinsTest).length;
console.log(`\n4h EMA(9/21) wins ${wfWins}/4 test periods.`);
if (wfWins >= 3) {
  console.log("VERDICT: Robust improvement -- consistent across walk-forward folds.");
} else if (wfWins >= 2) {
  console.log("VERDICT: Mixed -- improvement is not fully consistent. Proceed with caution.");
} else {
  console.log("VERDICT: Likely overfit -- upgrade does NOT hold up across different periods.");
}

// ========================================================================
// PART 2: QUARTERLY BREAKDOWN (8 quarters, ~4 months each)
// ========================================================================
console.log("\n" + "=".repeat(120));
console.log("QUARTERLY BREAKDOWN: Does 4h filter win in EVERY quarter?");
console.log("=".repeat(120));

interface Quarter {
  label: string;
  start: number;
  end: number;
}

const QUARTERS: Quarter[] = [
  { label: "2023-Q1 (Jan-Apr)", start: new Date("2023-01-01").getTime(), end: new Date("2023-05-01").getTime() },
  { label: "2023-Q2 (May-Aug)", start: new Date("2023-05-01").getTime(), end: new Date("2023-09-01").getTime() },
  { label: "2023-Q3 (Sep-Dec)", start: new Date("2023-09-01").getTime(), end: new Date("2024-01-01").getTime() },
  { label: "2024-Q1 (Jan-Apr)", start: new Date("2024-01-01").getTime(), end: new Date("2024-05-01").getTime() },
  { label: "2024-Q2 (May-Aug)", start: new Date("2024-05-01").getTime(), end: new Date("2024-09-01").getTime() },
  { label: "2024-Q3 (Sep-Dec)", start: new Date("2024-09-01").getTime(), end: new Date("2025-01-01").getTime() },
  { label: "2025-Q1 (Jan-Apr)", start: new Date("2025-01-01").getTime(), end: new Date("2025-05-01").getTime() },
  { label: "2025-Q2 (May-Oct)", start: new Date("2025-05-01").getTime(), end: new Date("2026-03-28").getTime() },
];

// Run full sim once for the whole period, then slice by quarter
const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-28").getTime();

console.log("\nRunning full-period simulations...");
const allBaseline = simulate(FULL_START, FULL_END, BASELINE);
const allUpgrade = simulate(FULL_START, FULL_END, UPGRADE);
console.log(`  Baseline: ${allBaseline.length} trades total`);
console.log(`  Upgrade:  ${allUpgrade.length} trades total`);

console.log(
  `\n${"Quarter".padEnd(22)} ` +
  `${"Base N".padStart(7)} ${"Base $/d".padStart(9)} ${"Base PF".padStart(8)} ` +
  `${"Upg N".padStart(7)} ${"Upg $/d".padStart(9)} ${"Upg PF".padStart(8)} ` +
  `${"Delta $/d".padStart(10)} ${"Winner".padStart(10)}`
);
console.log("-".repeat(100));

let qtrWins = 0;
let qtrLosses = 0;

for (const q of QUARTERS) {
  const bt = filterTrades(allBaseline, q.start, q.end);
  const ut = filterTrades(allUpgrade, q.start, q.end);

  const bm = calcMetrics(bt, q.start, q.end);
  const um = calcMetrics(ut, q.start, q.end);

  const delta = um.perDay - bm.perDay;
  const winner = um.perDay > bm.perDay ? "4h EMA" : (um.perDay < bm.perDay ? "Baseline" : "Tie");

  if (um.perDay > bm.perDay) qtrWins++;
  else if (um.perDay < bm.perDay) qtrLosses++;

  console.log(
    `${q.label.padEnd(22)} ` +
    `${pad(String(bm.n), 7)} ${pad(fmtPnl(bm.perDay), 9)} ${pad(fmtPf(bm.pf), 8)} ` +
    `${pad(String(um.n), 7)} ${pad(fmtPnl(um.perDay), 9)} ${pad(fmtPf(um.pf), 8)} ` +
    `${pad(fmtPnl(delta), 10)} ${pad(winner, 10)}`
  );
}

console.log("-".repeat(100));
console.log(`4h EMA(9/21) wins ${qtrWins}/${QUARTERS.length} quarters, loses ${qtrLosses}/${QUARTERS.length}.`);

if (qtrWins >= 6) {
  console.log("VERDICT: Strong consistency -- 4h filter wins most quarters.");
} else if (qtrWins >= 4) {
  console.log("VERDICT: Moderate consistency -- some quarters favor baseline.");
} else {
  console.log("VERDICT: Poor consistency -- improvement is period-dependent (overfit risk).");
}

// ========================================================================
// PART 3: BOOTSTRAP (200 resamples, 5th percentile)
// ========================================================================
console.log("\n" + "=".repeat(120));
console.log("BOOTSTRAP ANALYSIS: 200 resamples, 5th percentile confidence");
console.log("=".repeat(120));

console.log("\nRunning bootstrap (200 resamples)...");
const baseBoot = bootstrap(allBaseline, 200, FULL_START, FULL_END);
const upgBoot = bootstrap(allUpgrade, 200, FULL_START, FULL_END);

const bFull = calcMetrics(allBaseline, FULL_START, FULL_END);
const uFull = calcMetrics(allUpgrade, FULL_START, FULL_END);

console.log(
  `\n${"Metric".padEnd(22)} ${"Baseline".padStart(14)} ${"4h EMA(9/21)".padStart(14)} ${"Delta".padStart(12)}`
);
console.log("-".repeat(66));
console.log(
  `${"Observed $/day".padEnd(22)} ${pad(fmtPnl(bFull.perDay), 14)} ${pad(fmtPnl(uFull.perDay), 14)} ${pad(fmtPnl(uFull.perDay - bFull.perDay), 12)}`
);
console.log(
  `${"Bootstrap 5th% $/day".padEnd(22)} ${pad(fmtPnl(baseBoot.pd5), 14)} ${pad(fmtPnl(upgBoot.pd5), 14)} ${pad(fmtPnl(upgBoot.pd5 - baseBoot.pd5), 12)}`
);
console.log(
  `${"Bootstrap median $/day".padEnd(22)} ${pad(fmtPnl(baseBoot.pdMed), 14)} ${pad(fmtPnl(upgBoot.pdMed), 14)} ${pad(fmtPnl(upgBoot.pdMed - baseBoot.pdMed), 12)}`
);
console.log(
  `${"Observed PF".padEnd(22)} ${pad(fmtPf(bFull.pf), 14)} ${pad(fmtPf(uFull.pf), 14)} ${pad((uFull.pf - bFull.pf >= 0 ? "+" : "") + (uFull.pf - bFull.pf).toFixed(2), 12)}`
);
console.log(
  `${"Bootstrap 5th% PF".padEnd(22)} ${pad(fmtPf(baseBoot.pf5), 14)} ${pad(fmtPf(upgBoot.pf5), 14)} ${pad((upgBoot.pf5 - baseBoot.pf5 >= 0 ? "+" : "") + (upgBoot.pf5 - baseBoot.pf5).toFixed(2), 12)}`
);
console.log(
  `${"Bootstrap median PF".padEnd(22)} ${pad(fmtPf(baseBoot.pfMed), 14)} ${pad(fmtPf(upgBoot.pfMed), 14)} ${pad((upgBoot.pfMed - baseBoot.pfMed >= 0 ? "+" : "") + (upgBoot.pfMed - baseBoot.pfMed).toFixed(2), 12)}`
);
console.log(
  `${"Total trades".padEnd(22)} ${pad(String(bFull.n), 14)} ${pad(String(uFull.n), 14)} ${pad(String(uFull.n - bFull.n), 12)}`
);
console.log(
  `${"Win rate".padEnd(22)} ${pad(bFull.wr.toFixed(1) + "%", 14)} ${pad(uFull.wr.toFixed(1) + "%", 14)} ${pad((uFull.wr - bFull.wr >= 0 ? "+" : "") + (uFull.wr - bFull.wr).toFixed(1) + "%", 12)}`
);
console.log(
  `${"Max drawdown".padEnd(22)} ${pad("$" + bFull.dd.toFixed(0), 14)} ${pad("$" + uFull.dd.toFixed(0), 14)} ${pad((uFull.dd - bFull.dd >= 0 ? "+$" : "-$") + Math.abs(uFull.dd - bFull.dd).toFixed(0), 12)}`
);

// ========================================================================
// PART 4: OVERALL VERDICT
// ========================================================================
console.log("\n" + "=".repeat(120));
console.log("OVERALL VERDICT");
console.log("=".repeat(120));

const robustChecks = [
  { test: "Walk-forward: wins 3+/4 test periods", pass: wfWins >= 3 },
  { test: "Quarterly: wins 5+/8 quarters", pass: qtrWins >= 5 },
  { test: "Bootstrap 5th% PF > 1.0", pass: upgBoot.pf5 > 1.0 },
  { test: "Bootstrap 5th% $/day > 0", pass: upgBoot.pd5 > 0 },
  { test: "Upgrade 5th% PF >= Baseline 5th% PF", pass: upgBoot.pf5 >= baseBoot.pf5 },
  { test: "Upgrade 5th% $/day >= Baseline 5th% $/day", pass: upgBoot.pd5 >= baseBoot.pd5 },
];

let passCount = 0;
for (const c of robustChecks) {
  const status = c.pass ? "PASS" : "FAIL";
  console.log(`  [${status}] ${c.test}`);
  if (c.pass) passCount++;
}

console.log(`\nRobustness score: ${passCount}/${robustChecks.length}`);

if (passCount >= 5) {
  console.log("\nCONCLUSION: 4h EMA(9/21) is a ROBUST improvement over daily EMA(20/50).");
  console.log("Safe to deploy as the production long filter.");
} else if (passCount >= 3) {
  console.log("\nCONCLUSION: 4h EMA(9/21) shows MARGINAL improvement.");
  console.log("The upgrade exists but is not strongly differentiated. Consider keeping baseline.");
} else {
  console.log("\nCONCLUSION: 4h EMA(9/21) is LIKELY OVERFIT.");
  console.log("The improvement does not hold consistently. Stick with daily EMA(20/50).");
}
