/**
 * Exact Live Config Backtest - 5 engines, shared position pool
 *
 * Engines: A(Daily Donchian), B(4h Supertrend), C(GARCH v2 MTF), D(Carry Momentum), E(Range Expansion)
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-exact-live-config.ts
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
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX",
  "NEAR","PEPE","SUI","HYPE","FET",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-23").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string;
  engine: string;
  dir: Dir;
  ep: number;       // entry price (after spread)
  et: number;       // entry time
  sl: number;       // stop-loss
  tp: number;       // take-profit (0 = none)
  margin: number;   // $ margin
  lev: number;
  maxHold: number;  // ms
  atr: number;      // ATR at entry for breakeven stop
  bestPnlAtr: number; // best unrealized P&L in ATR multiples
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

function atr(bars: Bar[], period: number): (number | null)[] {
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
  // Wilder smoothing
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
  const atrVals = atr(bars, atrPeriod);
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
  m5: C[];
  h1: Bar[];
  h4: Bar[];
  daily: Bar[];
  weekly: Bar[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
}

interface BTCData {
  daily: Bar[];
  h1: Bar[];
  h4: Bar[];
  dailyEma20: (number | null)[];
  dailyEma50: (number | null)[];
  h1Ema9: (number | null)[];
  h1Ema21: (number | null)[];
  dailyMap: Map<number, number>;
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
}

function prepBTC(m5: C[]): BTCData {
  const daily = aggregate(m5, DAY);
  const h1 = aggregate(m5, H1);
  const h4 = aggregate(m5, H4);
  const dc = daily.map(b => b.c);
  const hc = h1.map(b => b.c);
  return {
    daily, h1, h4,
    dailyEma20: ema(dc, 20),
    dailyEma50: ema(dc, 50),
    h1Ema9: ema(hc, 9),
    h1Ema21: ema(hc, 21),
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

// ─── Helper: get bar index at or before time ────────────────────────
function getBarAtOrBefore(bars: Bar[], t: number, barMap: Map<number, number>, period: number): number {
  const aligned = Math.floor(t / period) * period;
  const idx = barMap.get(aligned);
  if (idx !== undefined) return idx;
  // Search backwards
  for (let dt = period; dt <= 10 * period; dt += period) {
    const idx2 = barMap.get(aligned - dt);
    if (idx2 !== undefined) return idx2;
  }
  return -1;
}

// ─── Spread helper ──────────────────────────────────────────────────
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Run Backtest ───────────────────────────────────────────────────
function runBacktest(spreadMultiplier: number): Trade[] {
  console.log(`\nLoading data...`);

  // Load BTC
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data!"); return []; }
  const btc = prepBTC(btcRaw);

  // Load pairs
  const available: string[] = [];
  const pairData = new Map<string, PairData>();
  for (const p of WANTED_PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 500) { continue; }
    available.push(p);
    pairData.set(p, prepPair(m5));
  }
  console.log(`Loaded ${available.length} pairs: ${available.join(", ")}`);

  // Pre-compute indicators per pair
  // Engine A: daily SMA(20), SMA(50), Donchian(15) on closes, ATR(14d)
  const engA: Map<string, {
    sma20: (number | null)[]; sma50: (number | null)[];
    donLo15: (number | null)[]; donHi15: (number | null)[];
    atr14: (number | null)[];
  }> = new Map();

  // Engine B: 4h supertrend(14, 1.75), 4h ATR(14), 4h volume
  const engB: Map<string, {
    st: (1 | -1 | null)[]; atr14: (number | null)[];
  }> = new Map();

  // Engine C: 1h z-score, 4h z-score, 1h EMA(9), EMA(21), 1h ATR(14)
  const engC: Map<string, {
    h1z: number[]; h4z: number[];
    h1ema9: (number | null)[]; h1ema21: (number | null)[];
    h1atr14: (number | null)[];
  }> = new Map();

  // Engine E: daily range, 20d avg range, ATR(14d), Donchian(10) on closes
  const engE: Map<string, {
    atr14: (number | null)[];
    donLo10: (number | null)[]; donHi10: (number | null)[];
  }> = new Map();

  for (const p of available) {
    const pd = pairData.get(p)!;

    // Engine A
    const dc = pd.daily.map(b => b.c);
    engA.set(p, {
      sma20: sma(dc, 20),
      sma50: sma(dc, 50),
      donLo15: donchianLow(dc, 15),
      donHi15: donchianHigh(dc, 15),
      atr14: atr(pd.daily, 14),
    });

    // Engine B
    engB.set(p, {
      st: supertrend(pd.h4, 14, 1.75).trend,
      atr14: atr(pd.h4, 14),
    });

    // Engine C
    const h1c = pd.h1.map(b => b.c);
    const h4c = pd.h4.map(b => b.c);
    engC.set(p, {
      h1z: zScore(h1c, 3, 20),
      h4z: zScore(h4c, 3, 20),
      h1ema9: ema(h1c, 9),
      h1ema21: ema(h1c, 21),
      h1atr14: atr(pd.h1, 14),
    });

    // Engine E
    engE.set(p, {
      atr14: atr(pd.daily, 14),
      donLo10: donchianLow(dc, 10),
      donHi10: donchianHigh(dc, 10),
    });
  }

  // Pre-compute BTC 30d return for Engine B regime gate
  const btc30dReturn = new Map<number, number>();
  for (let i = 30; i < btc.daily.length; i++) {
    btc30dReturn.set(btc.daily[i].t, btc.daily[i].c / btc.daily[i - 30].c - 1);
  }

  // ─── Simulation Loop ─────────────────────────────────────────────
  const positions = new Map<string, Position>(); // key: "engine:pair"
  const trades: Trade[] = [];
  let lastCarryRebalance = 0;

  // Build daily timestamps for iteration
  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    dailyTimestamps.push(t);
  }

  // BTC helper: daily regime
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
  function positionsForDir(dir: Dir): number {
    return [...positions.values()].filter(p => p.dir === dir).length;
  }

  function closePosition(key: string, exitPrice: number, exitTime: number, slippageMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sp(pos.pair) * spreadMultiplier;
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

  // For each daily bar, process all engines
  for (const dayT of dailyTimestamps) {
    // ─── CHECK EXISTING POSITIONS (use 5m bars within this day) ─────
    // We process exits on daily close for simplicity (consistent with live)
    for (const [key, pos] of [...positions.entries()]) {
      const pd = pairData.get(pos.pair);
      if (!pd) continue;

      // Get today's daily bar for the pair
      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;
      const bar = pd.daily[di];

      const sp_ = sp(pos.pair) * spreadMultiplier;
      const notional = pos.margin * pos.lev;

      // Check stop-loss hit (intraday)
      let stopped = false;
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePosition(key, pos.sl, dayT, SL_SLIPPAGE);
        stopped = true;
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        closePosition(key, pos.sl, dayT, SL_SLIPPAGE);
        stopped = true;
      }
      if (stopped) continue;

      // Check TP (Engine C)
      if (pos.tp > 0) {
        if (pos.dir === "long" && bar.h >= pos.tp) {
          closePosition(key, pos.tp, dayT);
          continue;
        } else if (pos.dir === "short" && bar.l <= pos.tp) {
          closePosition(key, pos.tp, dayT);
          continue;
        }
      }

      // Check max hold
      if (dayT - pos.et >= pos.maxHold) {
        closePosition(key, bar.c, dayT);
        continue;
      }

      // Breakeven stop management
      if (pos.atr > 0) {
        const unrealPnl = pos.dir === "long"
          ? (bar.c - pos.ep) / pos.atr
          : (pos.ep - bar.c) / pos.atr;

        if (unrealPnl > pos.bestPnlAtr) pos.bestPnlAtr = unrealPnl;

        let newSl = pos.sl;
        if (pos.bestPnlAtr >= 3) {
          // Trail at 1.5 ATR from peak
          const trailPrice = pos.dir === "long"
            ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
            : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
          newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
        } else if (pos.bestPnlAtr >= 2) {
          // Trail at 2 ATR from price
          const trailPrice = pos.dir === "long"
            ? bar.h - 2 * pos.atr
            : bar.l + 2 * pos.atr;
          newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
        } else if (pos.bestPnlAtr >= 1) {
          // Move to breakeven
          newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
        }
        pos.sl = newSl;
      }

      // Engine-specific exits
      if (pos.engine === "A") {
        // Exit: close < 15-day Donchian low (longs) or > 15-day high (shorts)
        const ea = engA.get(pos.pair);
        if (ea && di > 0) {
          if (pos.dir === "long" && ea.donLo15[di] !== null && bar.c < ea.donLo15[di]!) {
            closePosition(key, bar.c, dayT);
            continue;
          }
          if (pos.dir === "short" && ea.donHi15[di] !== null && bar.c > ea.donHi15[di]!) {
            closePosition(key, bar.c, dayT);
            continue;
          }
        }
      }

      if (pos.engine === "E") {
        // Exit: 10-day Donchian using closes
        const ee = engE.get(pos.pair);
        if (ee && di > 0) {
          if (pos.dir === "long" && ee.donLo10[di] !== null && bar.c < ee.donLo10[di]!) {
            closePosition(key, bar.c, dayT);
            continue;
          }
          if (pos.dir === "short" && ee.donHi10[di] !== null && bar.c > ee.donHi10[di]!) {
            closePosition(key, bar.c, dayT);
            continue;
          }
        }
      }
    }

    // ─── ENGINE A: Daily Donchian Trend ─────────────────────────────
    for (const p of available) {
      if (totalPositions() >= MAX_POSITIONS) break;
      const key = `A:${p}`;
      if (positions.has(key)) continue;

      const pd = pairData.get(p)!;
      const ea = engA.get(p)!;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 51) continue;

      const bar = pd.daily[di];
      // Use previous bar values (no look-ahead)
      const sma20now = ea.sma20[di - 1], sma50now = ea.sma50[di - 1];
      const sma20prev = ea.sma20[di - 2], sma50prev = ea.sma50[di - 2];
      if (sma20now === null || sma50now === null || sma20prev === null || sma50prev === null) continue;

      let dir: Dir | null = null;
      // Golden cross
      if (sma20prev <= sma50prev && sma20now > sma50now) {
        if (btcBullish(dayT)) dir = "long";
      }
      // Death cross (no BTC filter)
      if (sma20prev >= sma50prev && sma20now < sma50now) {
        dir = "short";
      }

      if (!dir) continue;

      const atrVal = ea.atr14[di - 1];
      if (atrVal === null) continue;

      const sp_ = sp(p) * spreadMultiplier;
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035; // cap at 3.5%
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(key, {
        pair: p, engine: "A", dir, ep, et: dayT, sl, tp: 0,
        margin: 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
      });
    }

    // ─── ENGINE B: 4h Supertrend ────────────────────────────────────
    // Check at each 4h boundary within this day
    for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
      const h4T = dayT + h4Offset;
      for (const p of available) {
        if (totalPositions() >= MAX_POSITIONS) break;
        const key = `B:${p}`;
        if (positions.has(key)) continue;

        const pd = pairData.get(p)!;
        const eb = engB.get(p)!;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined || h4i < 21) continue;

        // Supertrend flip
        const stNow = eb.st[h4i - 1];
        const stPrev = eb.st[h4i - 2];
        if (stNow === null || stPrev === null || stNow === stPrev) continue;

        const dir: Dir = stNow === 1 ? "long" : "short";

        // Volume filter: flip bar volume > 1.5x 20-bar avg
        const h4Bar = pd.h4[h4i - 1];
        let volSum = 0;
        for (let j = h4i - 21; j < h4i - 1; j++) {
          if (j >= 0) volSum += pd.h4[j].v;
        }
        const avgVol = volSum / 20;
        if (avgVol <= 0 || h4Bar.v < 1.5 * avgVol) continue;

        // BTC regime gate
        const btcRet = btc30dRet(h4T);
        if (btcRet < -0.10 && dir === "long") continue;
        if (btcRet > 0.15 && dir === "short") continue;

        // BTC EMA filter for longs
        if (dir === "long" && !btcBullish(h4T)) continue;

        const atrVal = eb.atr14[h4i - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p) * spreadMultiplier;
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(key, {
          pair: p, engine: "B", dir, ep, et: h4T, sl, tp: 0,
          margin: 3, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
        });
      }
    }

    // ─── ENGINE C: GARCH v2 MTF ─────────────────────────────────────
    // Check at each 1h boundary
    for (let h1Offset = 0; h1Offset < DAY; h1Offset += H1) {
      const h1T = dayT + h1Offset;
      for (const p of available) {
        if (totalPositions() >= MAX_POSITIONS) break;
        const key = `C:${p}`;
        if (positions.has(key)) continue;

        // Max 6 per direction for engine C
        const cPositions = positionsForEngine("C");
        const cLongs = cPositions.filter(x => x.dir === "long").length;
        const cShorts = cPositions.filter(x => x.dir === "short").length;

        const pd = pairData.get(p)!;
        const ec = engC.get(p)!;
        const h1i = pd.h1Map.get(h1T);
        if (h1i === undefined || h1i < 25) continue;

        // Get corresponding 4h index
        const h4T_ = Math.floor(h1T / H4) * H4;
        const h4i = pd.h4Map.get(h4T_);
        if (h4i === undefined || h4i < 25) continue;

        const h1z = ec.h1z[h1i - 1] ?? 0;
        const h4z = ec.h4z[h4i - 1] ?? 0;
        const h1e9 = ec.h1ema9[h1i - 1];
        const h1e21 = ec.h1ema21[h1i - 1];
        if (h1e9 === null || h1e21 === null) continue;

        let dir: Dir | null = null;

        // Long: 1h z > 4.5 AND 4h z > 3.0, EMA 9>21, BTC EMA 9>21
        if (h1z > 4.5 && h4z > 3.0 && h1e9 > h1e21 && btcH1Bullish(h1T)) {
          if (cLongs < 6) dir = "long";
        }
        // Short: 1h z < -3.0 AND 4h z < -3.0, EMA 9<21, BTC bearish
        if (h1z < -3.0 && h4z < -3.0 && h1e9 < h1e21 && !btcH1Bullish(h1T)) {
          if (cShorts < 6) dir = "short";
        }
        if (!dir) continue;

        // Volume+Range filter on 1h
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

        const sp_ = sp(p) * spreadMultiplier;
        const ep = dir === "long" ? pd.h1[h1i].o * (1 + sp_) : pd.h1[h1i].o * (1 - sp_);
        const slPct = 0.03;
        let slDist = ep * slPct;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        const tp = dir === "long" ? ep * 1.07 : ep * 0.93;

        const h1atr = ec.h1atr14[h1i - 1] ?? (ep * 0.02);

        positions.set(key, {
          pair: p, engine: "C", dir, ep, et: h1T, sl, tp,
          margin: 5, lev: 10, maxHold: 96 * H1, atr: h1atr as number, bestPnlAtr: 0,
        });
      }
    }

    // ─── ENGINE D: Carry Momentum ───────────────────────────────────
    if (dayT - lastCarryRebalance >= 7 * DAY) {
      lastCarryRebalance = dayT;

      // Close existing Engine D positions
      for (const [key, pos] of [...positions.entries()]) {
        if (pos.engine === "D") {
          const pd = pairData.get(pos.pair);
          if (!pd) continue;
          const di = pd.dailyMap.get(dayT);
          if (di === undefined) continue;
          closePosition(key, pd.daily[di].c, dayT);
        }
      }

      // Rank pairs by 5-day avg simulated funding rate
      const fundingRanks: { pair: string; funding: number; momentum: number }[] = [];
      for (const p of available) {
        const pd = pairData.get(p)!;
        const di = pd.dailyMap.get(dayT);
        if (di === undefined || di < 6) continue;

        // Simulate funding from price: (close-open)/close * 0.05 per day, avg over 5 days
        let fundSum = 0;
        for (let j = di - 5; j < di; j++) {
          if (j >= 0) {
            fundSum += (pd.daily[j].c - pd.daily[j].o) / pd.daily[j].c * 0.05;
          }
        }
        const avgFunding = fundSum / 5;

        // 5-day momentum
        const momentum = pd.daily[di].c / pd.daily[di - 5].c - 1;

        fundingRanks.push({ pair: p, funding: avgFunding, momentum });
      }

      // Sort by funding
      fundingRanks.sort((a, b) => a.funding - b.funding);

      // Short top 3 (positive funding + negative momentum)
      const top3 = fundingRanks.filter(x => x.funding > 0 && x.momentum < 0).slice(-3);
      // Long bottom 3 (negative funding + positive momentum)
      const bot3 = fundingRanks.filter(x => x.funding < 0 && x.momentum > 0).slice(0, 3);

      for (const pick of [...top3, ...bot3]) {
        if (totalPositions() >= MAX_POSITIONS) break;
        const key = `D:${pick.pair}`;
        if (positions.has(key)) continue;

        const pd = pairData.get(pick.pair)!;
        const di = pd.dailyMap.get(dayT);
        if (di === undefined) continue;

        const dir: Dir = pick.funding > 0 ? "short" : "long";
        const sp_ = sp(pick.pair) * spreadMultiplier;
        const ep = dir === "long" ? pd.daily[di].o * (1 + sp_) : pd.daily[di].o * (1 - sp_);
        let slDist = ep * 0.04;
        if (slDist / ep > 0.035) slDist = ep * 0.035; // cap
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        const dailyAtr = atr(pd.daily, 14);
        const atrVal = dailyAtr[di - 1] ?? ep * 0.02;

        positions.set(key, {
          pair: pick.pair, engine: "D", dir, ep, et: dayT, sl, tp: 0,
          margin: 5, lev: 10, maxHold: 8 * DAY, atr: atrVal as number, bestPnlAtr: 0,
        });
      }
    }

    // ─── ENGINE E: Range Expansion ──────────────────────────────────
    for (const p of available) {
      if (totalPositions() >= MAX_POSITIONS) break;
      const key = `E:${p}`;
      if (positions.has(key)) continue;

      const pd = pairData.get(p)!;
      const ee = engE.get(p)!;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 21) continue;

      const bar = pd.daily[di - 1]; // previous day (no look-ahead)
      const range = bar.h - bar.l;

      // 20-day avg range
      let rangeSum = 0;
      for (let j = di - 21; j < di - 1; j++) {
        if (j >= 0) rangeSum += pd.daily[j].h - pd.daily[j].l;
      }
      const avgRange = rangeSum / 20;
      if (avgRange <= 0 || range < 2 * avgRange) continue;

      // Direction from the expansion bar
      let dir: Dir | null = null;
      if (bar.c > bar.o) {
        // Bullish expansion - need BTC filter
        if (btcBullish(dayT)) dir = "long";
      } else {
        dir = "short";
      }
      if (!dir) continue;

      const atrVal = ee.atr14[di - 1];
      if (atrVal === null) continue;

      const sp_ = sp(p) * spreadMultiplier;
      const ep = dir === "long" ? pd.daily[di].o * (1 + sp_) : pd.daily[di].o * (1 - sp_);
      let slDist = atrVal * 2;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(key, {
        pair: p, engine: "E", dir, ep, et: dayT, sl, tp: 0,
        margin: 3, lev: 10, maxHold: 30 * DAY, atr: atrVal, bestPnlAtr: 0,
      });
    }
  }

  // Close remaining positions at last available price
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairData.get(pos.pair);
    if (!pd || pd.daily.length === 0) continue;
    const lastBar = pd.daily[pd.daily.length - 1];
    closePosition(key, lastBar.c, lastBar.t);
  }

  return trades;
}

// ─── Stats Functions ────────────────────────────────────────────────
interface Stats {
  trades: number;
  pf: number;
  sharpe: number;
  perDay: number;
  wr: number;
  maxDd: number;
  maxDdDuration: string;
  recoveryDays: number;
  totalPnl: number;
  avgPnl: number;
  winners: number;
  losers: number;
}

function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return {
    trades: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0,
    maxDd: 0, maxDdDuration: "0d", recoveryDays: 0, totalPnl: 0, avgPnl: 0,
    winners: 0, losers: 0,
  };

  const sorted = [...filtered].sort((a, b) => a.xt - b.xt);
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const wr = filtered.length > 0 ? wins.length / filtered.length : 0;

  const days = (endMs - startMs) / DAY;
  const perDay = totalPnl / days;

  // Daily P&L for Sharpe
  const dailyPnl = new Map<number, number>();
  for (const t of sorted) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.pnl);
  }
  const dpVals = [...dailyPnl.values()];
  const mean = dpVals.length > 0 ? dpVals.reduce((a, b) => a + b, 0) / dpVals.length : 0;
  const std = dpVals.length > 1
    ? Math.sqrt(dpVals.reduce((s, v) => s + (v - mean) ** 2, 0) / (dpVals.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  // Max drawdown
  let equity = 0, peak = 0, maxDd = 0, ddStart = startMs, maxDdStart = startMs, maxDdEnd = startMs;
  let currentDdStart = startMs;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) {
      peak = equity;
      currentDdStart = t.xt;
    }
    const dd = peak - equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdStart = currentDdStart;
      maxDdEnd = t.xt;
    }
  }

  const ddDurationDays = Math.round((maxDdEnd - maxDdStart) / DAY);

  // Recovery: from max DD trough back to peak
  let recoveryDays = 0;
  let foundTrough = false;
  equity = 0; peak = 0; let troughTime = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) {
      if (foundTrough) {
        recoveryDays = Math.round((t.xt - troughTime) / DAY);
        foundTrough = false;
      }
      peak = equity;
    }
    if (peak - equity >= maxDd * 0.99 && !foundTrough) {
      foundTrough = true;
      troughTime = t.xt;
    }
  }

  return {
    trades: filtered.length,
    pf: Math.round(pf * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    perDay: Math.round(perDay * 100) / 100,
    wr: Math.round(wr * 1000) / 10,
    maxDd: Math.round(maxDd * 100) / 100,
    maxDdDuration: `${ddDurationDays}d`,
    recoveryDays,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round((totalPnl / filtered.length) * 100) / 100,
    winners: wins.length,
    losers: losses.length,
  };
}

function monthlyPnl(trades: Trade[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of trades) {
    const key = new Date(t.xt).toISOString().slice(0, 7);
    m.set(key, (m.get(key) ?? 0) + t.pnl);
  }
  return m;
}

// ─── Output Helpers ─────────────────────────────────────────────────
function pad(s: string, n: number): string { return s.padStart(n); }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "") + "$" + v.toFixed(2); }
function fmtPct(v: number): string { return v.toFixed(1) + "%"; }

function printStatsLine(label: string, s: Stats) {
  console.log(
    `${label.padEnd(18)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 7)} ` +
    `${pad(s.maxDdDuration, 6)} ${pad(String(s.recoveryDays) + "d", 6)} ${pad(fmtPnl(s.totalPnl), 11)}`
  );
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=".repeat(100));
console.log("  EXACT LIVE CONFIG BACKTEST - 5 Engines, Shared Position Pool");
console.log("=".repeat(100));

// Run standard
const trades = runBacktest(1.0);
console.log(`\nTotal trades: ${trades.length}`);

// 1. Full period stats
console.log("\n" + "=".repeat(100));
console.log("  1. FULL PERIOD (2023-01 to 2026-03)");
console.log("=".repeat(100));
console.log(
  `${"Period".padEnd(18)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
  `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ` +
  `${pad("DDdur", 6)} ${pad("Recov", 6)} ${pad("Total PnL", 11)}`
);
console.log("-".repeat(100));
printStatsLine("Full 2023-2026", computeStats(trades, FULL_START, FULL_END));

// 2. Per-year breakdown
console.log("\n" + "=".repeat(100));
console.log("  2. PER-YEAR BREAKDOWN");
console.log("=".repeat(100));
console.log(
  `${"Year".padEnd(18)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
  `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ` +
  `${pad("DDdur", 6)} ${pad("Recov", 6)} ${pad("Total PnL", 11)}`
);
console.log("-".repeat(100));
for (const year of [2023, 2024, 2025, 2026]) {
  const ys = new Date(`${year}-01-01`).getTime();
  const ye = new Date(`${year + 1}-01-01`).getTime();
  printStatsLine(String(year), computeStats(trades, ys, Math.min(ye, FULL_END)));
}

// 3. Per-month P&L
console.log("\n" + "=".repeat(100));
console.log("  3. MONTHLY P&L");
console.log("=".repeat(100));
const mpnl = monthlyPnl(trades);
const sortedMonths = [...mpnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));
let losingMonths = 0;
let cumPnl = 0;
console.log(`${"Month".padEnd(10)} ${pad("P&L", 10)} ${pad("Cumul", 10)} ${pad("Trades", 7)}`);
console.log("-".repeat(40));
for (const [month, pnl] of sortedMonths) {
  cumPnl += pnl;
  const tCount = trades.filter(t => new Date(t.xt).toISOString().slice(0, 7) === month).length;
  if (pnl < 0) losingMonths++;
  console.log(`${month.padEnd(10)} ${pad(fmtPnl(pnl), 10)} ${pad(fmtPnl(cumPnl), 10)} ${pad(String(tCount), 7)}`);
}
console.log(`\nLosing months: ${losingMonths} / ${sortedMonths.length}`);

// 4. Per-engine contribution
console.log("\n" + "=".repeat(100));
console.log("  4. PER-ENGINE CONTRIBUTION");
console.log("=".repeat(100));
const engines = ["A", "B", "C", "D", "E"];
const engineNames: Record<string, string> = {
  A: "Daily Donchian", B: "Supertrend 4h", C: "GARCH v2 MTF",
  D: "Carry Momentum", E: "Range Expansion",
};
console.log(
  `${"Engine".padEnd(22)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("WR", 7)} ` +
  `${pad("Total PnL", 11)} ${pad("$/day", 9)} ${pad("AvgPnl", 8)}`
);
console.log("-".repeat(75));
for (const eng of engines) {
  const et = trades.filter(t => t.engine === eng);
  const pnl = et.reduce((s, t) => s + t.pnl, 0);
  const wins = et.filter(t => t.pnl > 0);
  const losses = et.filter(t => t.pnl <= 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
  const days = (FULL_END - FULL_START) / DAY;
  console.log(
    `${(eng + ": " + engineNames[eng]).padEnd(22)} ${pad(String(et.length), 6)} ${pad(pf.toFixed(2), 6)} ` +
    `${pad(fmtPct(et.length > 0 ? wins.length / et.length * 100 : 0), 7)} ` +
    `${pad(fmtPnl(pnl), 11)} ${pad(fmtPnl(pnl / days), 9)} ` +
    `${pad(fmtPnl(et.length > 0 ? pnl / et.length : 0), 8)}`
  );
}

// 5. Direction split
console.log("\n" + "=".repeat(100));
console.log("  5. DIRECTION SPLIT");
console.log("=".repeat(100));
console.log(
  `${"Period".padEnd(18)} ${"Dir".padEnd(6)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("WR", 7)} ${pad("PnL", 11)}`
);
console.log("-".repeat(60));
for (const period of [
  { label: "Full", start: FULL_START, end: FULL_END },
  { label: "2023", start: new Date("2023-01-01").getTime(), end: new Date("2024-01-01").getTime() },
  { label: "2024", start: new Date("2024-01-01").getTime(), end: new Date("2025-01-01").getTime() },
  { label: "2025", start: new Date("2025-01-01").getTime(), end: new Date("2026-01-01").getTime() },
  { label: "2026", start: new Date("2026-01-01").getTime(), end: FULL_END },
]) {
  for (const dir of ["long", "short"] as Dir[]) {
    const dt = trades.filter(t => t.et >= period.start && t.et < period.end && t.dir === dir);
    const pnl = dt.reduce((s, t) => s + t.pnl, 0);
    const wins = dt.filter(t => t.pnl > 0);
    const losses = dt.filter(t => t.pnl <= 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
    console.log(
      `${period.label.padEnd(18)} ${dir.padEnd(6)} ${pad(String(dt.length), 6)} ` +
      `${pad(pf.toFixed(2), 6)} ${pad(fmtPct(dt.length > 0 ? wins.length / dt.length * 100 : 0), 7)} ` +
      `${pad(fmtPnl(pnl), 11)}`
    );
  }
}

// 6. Worst 30 days
console.log("\n" + "=".repeat(100));
console.log("  6. WORST 30-DAY PERIOD");
console.log("=".repeat(100));
{
  // Build daily P&L series
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.pnl);
  }
  const days = [...dailyPnl.entries()].sort((a, b) => a[0] - b[0]);

  let worstSum = Infinity, worstStart = 0, worstEnd = 0;
  for (let i = 0; i < days.length; i++) {
    let sum = 0;
    for (let j = i; j < days.length && days[j][0] - days[i][0] < 30 * DAY; j++) {
      sum += days[j][1];
    }
    if (sum < worstSum) {
      worstSum = sum;
      worstStart = days[i][0];
      // Find end
      let endIdx = i;
      for (let j = i; j < days.length && days[j][0] - days[i][0] < 30 * DAY; j++) endIdx = j;
      worstEnd = days[endIdx][0];
    }
  }
  console.log(`Worst 30-day window: ${new Date(worstStart).toISOString().slice(0, 10)} to ${new Date(worstEnd).toISOString().slice(0, 10)}`);
  console.log(`P&L: ${fmtPnl(worstSum)}`);
  const worstTrades = trades.filter(t => t.xt >= worstStart && t.xt <= worstEnd + DAY);
  console.log(`Trades in window: ${worstTrades.length}`);
}

// 7. Monthly return distribution
console.log("\n" + "=".repeat(100));
console.log("  7. MONTHLY RETURN DISTRIBUTION");
console.log("=".repeat(100));
{
  const mvals = sortedMonths.map(x => x[1]).sort((a, b) => a - b);
  const mean = mvals.reduce((a, b) => a + b, 0) / mvals.length;
  const median = mvals.length % 2 === 0
    ? (mvals[mvals.length / 2 - 1] + mvals[mvals.length / 2]) / 2
    : mvals[Math.floor(mvals.length / 2)];
  const std = Math.sqrt(mvals.reduce((s, v) => s + (v - mean) ** 2, 0) / (mvals.length - 1));
  const p5 = mvals[Math.floor(mvals.length * 0.05)];
  const p95 = mvals[Math.floor(mvals.length * 0.95)];

  console.log(`Mean:   ${fmtPnl(mean)}/month`);
  console.log(`Median: ${fmtPnl(median)}/month`);
  console.log(`StdDev: $${std.toFixed(2)}`);
  console.log(`5th pct: ${fmtPnl(p5)}`);
  console.log(`95th pct: ${fmtPnl(p95)}`);
}

// 8. Conservative cost model (doubled spreads)
console.log("\n" + "=".repeat(100));
console.log("  8. CONSERVATIVE COST MODEL (2x Spreads)");
console.log("=".repeat(100));
const trades2x = runBacktest(2.0);
console.log(
  `${"Period".padEnd(18)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
  `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ` +
  `${pad("DDdur", 6)} ${pad("Recov", 6)} ${pad("Total PnL", 11)}`
);
console.log("-".repeat(100));
printStatsLine("2x Spread Full", computeStats(trades2x, FULL_START, FULL_END));
for (const year of [2023, 2024, 2025, 2026]) {
  const ys = new Date(`${year}-01-01`).getTime();
  const ye = new Date(`${year + 1}-01-01`).getTime();
  printStatsLine(`2x ${year}`, computeStats(trades2x, ys, Math.min(ye, FULL_END)));
}

// Conservative monthly
const mpnl2 = monthlyPnl(trades2x);
const sm2 = [...mpnl2.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const losing2 = sm2.filter(x => x[1] < 0).length;
console.log(`\n2x Spread losing months: ${losing2} / ${sm2.length}`);

// ─── FINAL SUMMARY TABLE ───────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("  FINAL SUMMARY TABLE");
console.log("=".repeat(100));

const fullStats = computeStats(trades, FULL_START, FULL_END);
const fullStats2x = computeStats(trades2x, FULL_START, FULL_END);

console.log(`
+-------------------------------+----------------+----------------+
| Metric                        | Standard       | 2x Spread      |
+-------------------------------+----------------+----------------+
| Total Trades                  | ${pad(String(fullStats.trades), 14)} | ${pad(String(fullStats2x.trades), 14)} |
| Total P&L                     | ${pad(fmtPnl(fullStats.totalPnl), 14)} | ${pad(fmtPnl(fullStats2x.totalPnl), 14)} |
| $/day                         | ${pad(fmtPnl(fullStats.perDay), 14)} | ${pad(fmtPnl(fullStats2x.perDay), 14)} |
| Profit Factor                 | ${pad(String(fullStats.pf), 14)} | ${pad(String(fullStats2x.pf), 14)} |
| Sharpe Ratio                  | ${pad(String(fullStats.sharpe), 14)} | ${pad(String(fullStats2x.sharpe), 14)} |
| Win Rate                      | ${pad(fmtPct(fullStats.wr), 14)} | ${pad(fmtPct(fullStats2x.wr), 14)} |
| Max Drawdown                  | ${pad("$" + fullStats.maxDd.toFixed(0), 14)} | ${pad("$" + fullStats2x.maxDd.toFixed(0), 14)} |
| Max DD Duration               | ${pad(fullStats.maxDdDuration, 14)} | ${pad(fullStats2x.maxDdDuration, 14)} |
| Losing Months                 | ${pad(losingMonths + "/" + sortedMonths.length, 14)} | ${pad(losing2 + "/" + sm2.length, 14)} |
| Avg P&L/Trade                 | ${pad(fmtPnl(fullStats.avgPnl), 14)} | ${pad(fmtPnl(fullStats2x.avgPnl), 14)} |
+-------------------------------+----------------+----------------+

Engine Breakdown:
`);

for (const eng of engines) {
  const et = trades.filter(t => t.engine === eng);
  const pnl = et.reduce((s, t) => s + t.pnl, 0);
  console.log(`  ${eng}: ${engineNames[eng].padEnd(18)} ${et.length} trades, ${fmtPnl(pnl)}`);
}

console.log(`\nPairs used: ${[...new Set(trades.map(t => t.pair))].sort().join(", ")}`);
console.log(`Period: ${new Date(FULL_START).toISOString().slice(0, 10)} to ${new Date(FULL_END).toISOString().slice(0, 10)}`);
console.log(`Days: ${Math.round((FULL_END - FULL_START) / DAY)}`);
