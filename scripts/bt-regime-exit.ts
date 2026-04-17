/**
 * Regime-adaptive exit research: does adapting exit rules to market regime improve performance?
 *
 * Engines: A (Daily Donchian), B (4h Supertrend) - same entries, different exit configs.
 * Tests 5 exit regimes vs baseline.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-regime-exit.ts
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
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP",
];

const FULL_START = new Date("2023-06-01").getTime();
const FULL_END   = new Date("2026-03-25").getTime();
const DAYS_TOTAL = (FULL_END - FULL_START) / DAY;

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string;
  engine: string;
  dir: Dir;
  ep: number;
  et: number;
  sl: number;
  margin: number;
  lev: number;
  maxHold: number;
  atr: number;
  bestPnlAtr: number;
}

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number; margin: number;
}

// ─── Exit Config (what varies per regime) ───────────────────────────
interface ExitConfig {
  donchianPeriod: number;   // Engine A exit channel period
  stMult: number;           // Engine B supertrend multiplier for exit
  stPeriod: number;         // Engine B supertrend ATR period for exit
}

const NORMAL_EXIT: ExitConfig = { donchianPeriod: 15, stMult: 2.0, stPeriod: 14 };
const TIGHT_EXIT:  ExitConfig = { donchianPeriod: 10, stMult: 1.25, stPeriod: 14 };
const LOOSE_EXIT:  ExitConfig = { donchianPeriod: 20, stMult: 2.0, stPeriod: 14 };

// ─── Regime Strategies ──────────────────────────────────────────────
type RegimeDecider = (ctx: RegimeCtx) => ExitConfig;

interface RegimeCtx {
  t: number;
  btcDaily: Bar[];
  btcDailyMap: Map<number, number>;
  btcAtr14: (number | null)[];
  btcAtrSma60: (number | null)[];
  equityCurve: number[];    // cumulative PnL
  posEntryTime: number;     // position entry time
}

function baselineRegime(_ctx: RegimeCtx): ExitConfig {
  return NORMAL_EXIT;
}

function btcMomentumRegime(ctx: RegimeCtx): ExitConfig {
  const di = getBarIdx(ctx.btcDaily, ctx.t, ctx.btcDailyMap, DAY);
  if (di < 30) return NORMAL_EXIT;
  const ret30d = ctx.btcDaily[di].c / ctx.btcDaily[di - 30].c - 1;
  if (ret30d < -0.10) return TIGHT_EXIT;
  if (ret30d > 0.10) return LOOSE_EXIT;
  return NORMAL_EXIT;
}

function volatilityRegime(ctx: RegimeCtx): ExitConfig {
  const di = getBarIdx(ctx.btcDaily, ctx.t, ctx.btcDailyMap, DAY);
  if (di < 0) return NORMAL_EXIT;
  const atrNow = ctx.btcAtr14[di];
  const atrSma = ctx.btcAtrSma60[di];
  if (atrNow === null || atrSma === null || atrSma <= 0) return NORMAL_EXIT;
  if (atrNow > 1.5 * atrSma) return TIGHT_EXIT;
  return NORMAL_EXIT;
}

function drawdownRegime(ctx: RegimeCtx): ExitConfig {
  const eq = ctx.equityCurve;
  if (eq.length < 2) return NORMAL_EXIT;
  const last = eq[eq.length - 1];
  let peak = -Infinity;
  for (const v of eq) if (v > peak) peak = v;
  if (last < peak - 5) return TIGHT_EXIT; // $5+ drawdown = tighten
  return NORMAL_EXIT;
}

function timeBasedRegime(ctx: RegimeCtx): ExitConfig {
  const held = ctx.t - ctx.posEntryTime;
  if (held < 7 * DAY) return TIGHT_EXIT;
  return NORMAL_EXIT;
}

const STRATEGIES: { name: string; decide: RegimeDecider }[] = [
  { name: "1-Baseline (fixed exits)",     decide: baselineRegime },
  { name: "2-BTC 30d momentum regime",    decide: btcMomentumRegime },
  { name: "3-Volatility regime (ATR)",     decide: volatilityRegime },
  { name: "4-Drawdown regime",             decide: drawdownRegime },
  { name: "5-Time-based (7d switch)",      decide: timeBasedRegime },
];

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

// ─── Indicators (SMA-based ATR, no look-ahead) ─────────────────────
function smaArr(vals: number[], period: number): (number | null)[] {
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
  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < Math.min(period, vals.length); i++) sum += vals[i];
  if (vals.length < period) return r;
  let v = sum / period;
  r[period - 1] = v;
  const k = 2 / (period + 1);
  for (let i = period; i < vals.length; i++) {
    v = vals[i] * k + v * (1 - k);
    r[i] = v;
  }
  return r;
}

function atrSma(bars: Bar[], period: number): (number | null)[] {
  // SMA-based ATR (simple moving average of true ranges)
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
  return smaArr(trs, period);
}

function donchianLow(closes: number[], period: number): (number | null)[] {
  // No look-ahead: donchian[i] = min of closes[i-period .. i-1] (excludes current bar)
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

function supertrend(bars: Bar[], atrPeriod: number, mult: number): (1 | -1 | null)[] {
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
  return trend;
}

function getBarIdx(bars: Bar[], t: number, barMap: Map<number, number>, period: number): number {
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

// ─── Data Prep ──────────────────────────────────────────────────────
interface PairData {
  m5: C[];
  h4: Bar[];
  daily: Bar[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
}

interface BTCData {
  daily: Bar[];
  h4: Bar[];
  dailyEma20: (number | null)[];
  dailyEma50: (number | null)[];
  dailyMap: Map<number, number>;
  h4Map: Map<number, number>;
  atr14: (number | null)[];
  atrSma60: (number | null)[];
}

function prepBTC(m5: C[]): BTCData {
  const daily = aggregate(m5, DAY);
  const h4 = aggregate(m5, H4);
  const dc = daily.map(b => b.c);
  const atr14 = atrSma(daily, 14);
  const atr14Vals = atr14.map(v => v ?? 0);
  const atrSma60 = smaArr(atr14Vals, 60);
  return {
    daily, h4,
    dailyEma20: ema(dc, 20),
    dailyEma50: ema(dc, 50),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    atr14,
    atrSma60,
  };
}

function prepPair(m5: C[]): PairData {
  const h4 = aggregate(m5, H4);
  const daily = aggregate(m5, DAY);
  return {
    m5, h4, daily,
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
  };
}

// ─── Pre-compute per-pair Donchian channels and Supertrends ─────────
// We pre-compute all variants we need: Donchian 10/15/20 and ST mult 1.25/2.0
interface PairIndicators {
  // Engine A: entry
  sma30: (number | null)[];
  sma60: (number | null)[];
  atr14d: (number | null)[];
  // Engine A: exit (multiple variants)
  donLo10: (number | null)[];
  donHi10: (number | null)[];
  donLo15: (number | null)[];
  donHi15: (number | null)[];
  donLo20: (number | null)[];
  donHi20: (number | null)[];
  // Engine B: entry ST(14,2.0) for signal detection
  stEntry: (1 | -1 | null)[];
  atr14h4: (number | null)[];
  // Engine B: exit (multiple variants)
  stExit_14_2: (1 | -1 | null)[];
  stExit_14_125: (1 | -1 | null)[];
}

function prepIndicators(pd: PairData): PairIndicators {
  const dc = pd.daily.map(b => b.c);
  return {
    sma30: smaArr(dc, 30),
    sma60: smaArr(dc, 60),
    atr14d: atrSma(pd.daily, 14),
    donLo10: donchianLow(dc, 10),
    donHi10: donchianHigh(dc, 10),
    donLo15: donchianLow(dc, 15),
    donHi15: donchianHigh(dc, 15),
    donLo20: donchianLow(dc, 20),
    donHi20: donchianHigh(dc, 20),
    stEntry: supertrend(pd.h4, 14, 2.0),
    atr14h4: atrSma(pd.h4, 14),
    stExit_14_2: supertrend(pd.h4, 14, 2.0),
    stExit_14_125: supertrend(pd.h4, 14, 1.25),
  };
}

// ─── Simulation ─────────────────────────────────────────────────────
function runSim(
  regimeDecide: RegimeDecider,
  btc: BTCData,
  pairDataMap: Map<string, PairData>,
  pairIndMap: Map<string, PairIndicators>,
): Trade[] {
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const equityCurve: number[] = [0];
  let cumPnl = 0;

  function btcBullish(t: number): boolean {
    const di = getBarIdx(btc.daily, t - DAY, btc.dailyMap, DAY);
    if (di < 0) return false;
    const e20 = btc.dailyEma20[di], e50 = btc.dailyEma50[di];
    return e20 !== null && e50 !== null && e20 > e50;
  }

  function closePos(key: string, exitPrice: number, exitTime: number, slippageMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sp(pos.pair) * slippageMult;
    const xp = pos.dir === "long"
      ? exitPrice * (1 - sp_)
      : exitPrice * (1 + sp_);
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
    cumPnl += pnl;
    equityCurve.push(cumPnl);
  }

  // Build daily timestamps
  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    dailyTimestamps.push(t);
  }

  for (const dayT of dailyTimestamps) {
    // ─── CHECK EXISTING POSITIONS ─────────────────────────────────
    for (const [key, pos] of [...positions.entries()]) {
      const pd = pairDataMap.get(pos.pair);
      const ind = pairIndMap.get(pos.pair);
      if (!pd || !ind) continue;

      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;
      const bar = pd.daily[di];

      // Get current regime for this position
      const regimeCtx: RegimeCtx = {
        t: dayT,
        btcDaily: btc.daily,
        btcDailyMap: btc.dailyMap,
        btcAtr14: btc.atr14,
        btcAtrSma60: btc.atrSma60,
        equityCurve,
        posEntryTime: pos.et,
      };
      const exitCfg = regimeDecide(regimeCtx);

      // Check stop-loss (intraday)
      let stopped = false;
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePos(key, pos.sl, dayT, SL_SLIPPAGE);
        stopped = true;
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        closePos(key, pos.sl, dayT, SL_SLIPPAGE);
        stopped = true;
      }
      if (stopped) continue;

      // Check max hold
      if (dayT - pos.et >= pos.maxHold) {
        closePos(key, bar.c, dayT);
        continue;
      }

      // ATR trailing stop management
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

      // ─── Engine A exits: adaptive Donchian ──────────────────────
      if (pos.engine === "A" && di > 0) {
        let donLo: number | null = null;
        let donHi: number | null = null;
        if (exitCfg.donchianPeriod === 10) {
          donLo = ind.donLo10[di]; donHi = ind.donHi10[di];
        } else if (exitCfg.donchianPeriod === 20) {
          donLo = ind.donLo20[di]; donHi = ind.donHi20[di];
        } else {
          donLo = ind.donLo15[di]; donHi = ind.donHi15[di];
        }
        if (pos.dir === "long" && donLo !== null && bar.c < donLo) {
          closePos(key, bar.c, dayT);
          continue;
        }
        if (pos.dir === "short" && donHi !== null && bar.c > donHi) {
          closePos(key, bar.c, dayT);
          continue;
        }
      }

      // ─── Engine B exits: adaptive Supertrend flip ───────────────
      if (pos.engine === "B") {
        // Check at each 4h boundary within this day
        let exited = false;
        for (let h4Off = 0; h4Off < DAY && !exited; h4Off += H4) {
          const h4T = dayT + h4Off;
          const h4i = pd.h4Map.get(h4T);
          if (h4i === undefined || h4i < 2) continue;

          // Pick the right supertrend for the current exit config
          const stArr = exitCfg.stMult <= 1.5 ? ind.stExit_14_125 : ind.stExit_14_2;
          const stNow = stArr[h4i];
          if (stNow === null) continue;

          // Supertrend flip exit
          if (pos.dir === "long" && stNow === -1) {
            closePos(key, pd.h4[h4i].c, h4T);
            exited = true;
          } else if (pos.dir === "short" && stNow === 1) {
            closePos(key, pd.h4[h4i].c, h4T);
            exited = true;
          }
        }
        if (exited) continue;
      }
    }

    // ─── ENGINE A: Daily Donchian Trend (entries) ─────────────────
    for (const p of PAIRS) {
      if (positions.size >= MAX_POSITIONS) break;
      const key = `A:${p}`;
      if (positions.has(key)) continue;

      const pd = pairDataMap.get(p)!;
      const ind = pairIndMap.get(p)!;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 61) continue;

      const bar = pd.daily[di];
      // SMA cross on previous bars (no look-ahead)
      const sma30now = ind.sma30[di - 1], sma60now = ind.sma60[di - 1];
      const sma30prev = ind.sma30[di - 2], sma60prev = ind.sma60[di - 2];
      if (sma30now === null || sma60now === null || sma30prev === null || sma60prev === null) continue;

      let dir: Dir | null = null;
      if (sma30prev <= sma60prev && sma30now > sma60now) {
        if (btcBullish(dayT)) dir = "long";
      }
      if (sma30prev >= sma60prev && sma30now < sma60now) {
        dir = "short";
      }
      if (!dir) continue;

      const atrVal = ind.atr14d[di - 1];
      if (atrVal === null) continue;

      const sp_ = sp(p);
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(key, {
        pair: p, engine: "A", dir, ep, et: dayT, sl,
        margin: 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
      });
    }

    // ─── ENGINE B: 4h Supertrend (entries) ────────────────────────
    for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
      const h4T = dayT + h4Off;
      for (const p of PAIRS) {
        if (positions.size >= MAX_POSITIONS) break;
        const key = `B:${p}`;
        if (positions.has(key)) continue;

        const pd = pairDataMap.get(p)!;
        const ind = pairIndMap.get(p)!;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined || h4i < 21) continue;

        // Supertrend flip (entry uses ST(14,2.0) always)
        const stNow = ind.stEntry[h4i - 1];
        const stPrev = ind.stEntry[h4i - 2];
        if (stNow === null || stPrev === null || stNow === stPrev) continue;

        const dir: Dir = stNow === 1 ? "long" : "short";

        // BTC EMA filter for longs
        if (dir === "long" && !btcBullish(h4T)) continue;

        const atrVal = ind.atr14h4[h4i - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p);
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(key, {
          pair: p, engine: "B", dir, ep, et: h4T, sl,
          margin: 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
        });
      }
    }
  }

  // Close remaining positions at end
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairDataMap.get(pos.pair);
    if (!pd) continue;
    const lastBar = pd.daily[pd.daily.length - 1];
    closePos(key, lastBar.c, lastBar.t);
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
function computeStats(trades: Trade[], label: string) {
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
  const perDay = totalPnl / DAYS_TOTAL;

  // MaxDD
  let cum = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }

  // Sharpe (daily PnL)
  const dp = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dp.set(d, (dp.get(d) || 0) + t.pnl);
  }
  const dailyPnls = [...dp.values()];
  const avg = dailyPnls.reduce((s, r) => s + r, 0) / Math.max(dailyPnls.length, 1);
  const std = Math.sqrt(dailyPnls.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dailyPnls.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  // Avg win / avg loss
  const winPnls = trades.filter(t => t.pnl > 0).map(t => t.pnl);
  const lossPnls = trades.filter(t => t.pnl <= 0).map(t => t.pnl);
  const avgWin = winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0;
  const avgLoss = lossPnls.length > 0 ? lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length : 0;
  const pf = Math.abs(avgLoss) > 0 ? (avgWin * wins) / (Math.abs(avgLoss) * lossPnls.length) : 999;

  // MaxDD duration
  let ddStart = 0, maxDdDur = 0;
  cum = 0; peak = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum >= peak) { peak = cum; ddStart = t.xt; }
    else { const dur = t.xt - ddStart; if (dur > maxDdDur) maxDdDur = dur; }
  }
  const ddDurDays = maxDdDur / DAY;

  // Per-engine breakdown
  const engA = trades.filter(t => t.engine === "A");
  const engB = trades.filter(t => t.engine === "B");
  const pnlA = engA.reduce((s, t) => s + t.pnl, 0);
  const pnlB = engB.reduce((s, t) => s + t.pnl, 0);

  return { label, totalPnl, perDay, maxDd, sharpe, wr, trades: trades.length, pf, ddDurDays,
           engATrades: engA.length, engBTrades: engB.length, pnlA, pnlB, avgWin, avgLoss };
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("Loading 5m data and aggregating...");

const btcRaw = load5m("BTC");
if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }
const btc = prepBTC(btcRaw);

const pairDataMap = new Map<string, PairData>();
const pairIndMap = new Map<string, PairIndicators>();
for (const p of PAIRS) {
  const m5 = load5m(p);
  if (m5.length < 500) { console.log(`Skipping ${p} (only ${m5.length} bars)`); continue; }
  const pd = prepPair(m5);
  pairDataMap.set(p, pd);
  pairIndMap.set(p, prepIndicators(pd));
}
console.log(`Loaded ${pairDataMap.size} pairs + BTC, period ${new Date(FULL_START).toISOString().slice(0,10)} to ${new Date(FULL_END).toISOString().slice(0,10)} (${DAYS_TOTAL.toFixed(0)} days)\n`);

// Run each strategy
const results: ReturnType<typeof computeStats>[] = [];
for (const strat of STRATEGIES) {
  process.stdout.write(`Running ${strat.name}...`);
  const trades = runSim(strat.decide, btc, pairDataMap, pairIndMap);
  const stats = computeStats(trades, strat.name);
  results.push(stats);
  console.log(` ${trades.length} trades`);
}

// ─── Display Results ────────────────────────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("  REGIME-ADAPTIVE EXIT RESEARCH: Donchian + Supertrend engines, 14 pairs, full period");
console.log("=".repeat(120));
console.log("");
console.log(
  "Strategy".padEnd(35) +
  "Trades".padStart(7) +
  "WR%".padStart(7) +
  "PF".padStart(6) +
  "TotalPnl".padStart(10) +
  "$/day".padStart(8) +
  "MaxDD".padStart(8) +
  "Sharpe".padStart(8) +
  "DD-dur".padStart(8) +
  "AvgW".padStart(7) +
  "AvgL".padStart(7)
);
console.log("-".repeat(120));

for (const r of results) {
  const pnlStr = r.totalPnl >= 0 ? `+$${r.totalPnl.toFixed(0)}` : `-$${Math.abs(r.totalPnl).toFixed(0)}`;
  const pdStr = r.perDay >= 0 ? `$${r.perDay.toFixed(2)}` : `-$${Math.abs(r.perDay).toFixed(2)}`;
  console.log(
    r.label.padEnd(35) +
    String(r.trades).padStart(7) +
    r.wr.toFixed(1).padStart(7) +
    r.pf.toFixed(2).padStart(6) +
    pnlStr.padStart(10) +
    pdStr.padStart(8) +
    `$${r.maxDd.toFixed(0)}`.padStart(8) +
    r.sharpe.toFixed(2).padStart(8) +
    `${r.ddDurDays.toFixed(0)}d`.padStart(8) +
    `$${r.avgWin.toFixed(2)}`.padStart(7) +
    `-$${Math.abs(r.avgLoss).toFixed(2)}`.padStart(7)
  );
}

// Per-engine breakdown
console.log("\n" + "=".repeat(100));
console.log("  PER-ENGINE BREAKDOWN");
console.log("=".repeat(100));
console.log(
  "Strategy".padEnd(35) +
  "A-trades".padStart(9) +
  "A-pnl".padStart(9) +
  "A-$/day".padStart(9) +
  "B-trades".padStart(9) +
  "B-pnl".padStart(9) +
  "B-$/day".padStart(9)
);
console.log("-".repeat(100));
for (const r of results) {
  const apnl = r.pnlA >= 0 ? `+$${r.pnlA.toFixed(0)}` : `-$${Math.abs(r.pnlA).toFixed(0)}`;
  const bpnl = r.pnlB >= 0 ? `+$${r.pnlB.toFixed(0)}` : `-$${Math.abs(r.pnlB).toFixed(0)}`;
  console.log(
    r.label.padEnd(35) +
    String(r.engATrades).padStart(9) +
    apnl.padStart(9) +
    `$${(r.pnlA / DAYS_TOTAL).toFixed(2)}`.padStart(9) +
    String(r.engBTrades).padStart(9) +
    bpnl.padStart(9) +
    `$${(r.pnlB / DAYS_TOTAL).toFixed(2)}`.padStart(9)
  );
}

// Delta vs baseline
console.log("\n" + "=".repeat(80));
console.log("  DELTA vs BASELINE");
console.log("=".repeat(80));
const baseline = results[0];
console.log(
  "Strategy".padEnd(35) +
  "dPnl".padStart(9) +
  "d$/day".padStart(9) +
  "dMaxDD".padStart(9) +
  "dSharpe".padStart(9) +
  "dWR%".padStart(9)
);
console.log("-".repeat(80));
for (const r of results.slice(1)) {
  const dp = r.totalPnl - baseline.totalPnl;
  const dpd = r.perDay - baseline.perDay;
  const ddd = r.maxDd - baseline.maxDd;
  const dsh = r.sharpe - baseline.sharpe;
  const dwr = r.wr - baseline.wr;
  console.log(
    r.label.padEnd(35) +
    `${dp >= 0 ? "+" : ""}$${dp.toFixed(0)}`.padStart(9) +
    `${dpd >= 0 ? "+" : ""}$${dpd.toFixed(2)}`.padStart(9) +
    `${ddd <= 0 ? "" : "+"}$${ddd.toFixed(0)}`.padStart(9) +
    `${dsh >= 0 ? "+" : ""}${dsh.toFixed(2)}`.padStart(9) +
    `${dwr >= 0 ? "+" : ""}${dwr.toFixed(1)}%`.padStart(9)
  );
}

console.log("\n--- Interpretation ---");
console.log("Tight exits: Donchian 10d / Supertrend(14, 1.25)");
console.log("Normal exits: Donchian 15d / Supertrend(14, 2.0)");
console.log("Loose exits: Donchian 20d / Supertrend(14, 2.0)");
console.log("Positive dSharpe = regime adaptation helps risk-adjusted returns");
console.log("Negative dMaxDD = regime adaptation reduces drawdown");
