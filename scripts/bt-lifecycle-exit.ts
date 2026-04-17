/**
 * Lifecycle Exit Research: age-based exit strategies for Donchian + Supertrend trades.
 *
 * Hypothesis: trades that survive 3+ days win 72%+; trades dying <1 day are 98% losers.
 * Test whether early-stage and late-stage trades need different management.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-lifecycle-exit.ts
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
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
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
const FULL_END   = new Date("2026-03-23").getTime();

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
  margin: number;
  lev: number;
  maxHold: number;  // ms
  atr: number;      // ATR at entry for trailing stop
  bestPnlAtr: number;
}

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number; margin: number;
  reason: string;
}

// Lifecycle config
interface LifecycleConfig {
  name: string;
  // Phase 1 (early protection)
  p1Enabled: boolean;
  p1FailHours: number;     // hours: if > X% against by this time, exit
  p1FailPct: number;       // leveraged % threshold (negative = against)
  p1MomentumHours: number; // hours: if not > Y% leveraged by this time, exit
  p1MomentumPct: number;   // leveraged % min needed
  // Phase 1 graduated (variant 5)
  p1Graduated: boolean;
  p1Grad12h: number;       // min leveraged % at 12h
  p1Grad24h: number;       // min leveraged % at 24h
  p1Grad48h: number;       // min leveraged % at 48h
  // Phase 2 (breakeven lock)
  p2Enabled: boolean;
  p2ThresholdPct: number;  // leveraged %: once reached, lock BE
  p2BufferPct: number;     // % buffer above BE (e.g., 1% = +0.1% unleveraged)
  // Phase 3 (let it run)
  p3Enabled: boolean;      // if true, disable max hold interference for 7+ day trades
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
function smaCalc(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) r[i] = sum / period;
  }
  return r;
}

function emaCalc(vals: number[], period: number): (number | null)[] {
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

function atrCalc(bars: Bar[], period: number): (number | null)[] {
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

function supertrendCalc(bars: Bar[], atrPeriod: number, mult: number): { trend: (1 | -1 | null)[] } {
  const atrVals = atrCalc(bars, atrPeriod);
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

// ─── Data Prep ──────────────────────────────────────────────────────
interface PairData {
  m5: C[];
  h4: Bar[];
  daily: Bar[];
  m5Map: Map<number, number>;
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
}

interface BTCData {
  daily: Bar[];
  dailyEma20: (number | null)[];
  dailyEma50: (number | null)[];
  dailyMap: Map<number, number>;
}

function prepBTC(m5: C[]): BTCData {
  const daily = aggregate(m5, DAY);
  const dc = daily.map(b => b.c);
  return {
    daily,
    dailyEma20: emaCalc(dc, 20),
    dailyEma50: emaCalc(dc, 50),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
  };
}

function prepPair(m5: C[]): PairData {
  const h4 = aggregate(m5, H4);
  const daily = aggregate(m5, DAY);
  return {
    m5, h4, daily,
    m5Map: new Map(m5.map((b, i) => [b.t, i])),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
  };
}

function getBarAtOrBefore(barMap: Map<number, number>, t: number, period: number): number {
  const aligned = Math.floor(t / period) * period;
  const idx = barMap.get(aligned);
  if (idx !== undefined) return idx;
  for (let dt = period; dt <= 10 * period; dt += period) {
    const idx2 = barMap.get(aligned - dt);
    if (idx2 !== undefined) return idx2;
  }
  return -1;
}

function sprd(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Simulation ─────────────────────────────────────────────────────
function runSim(
  lc: LifecycleConfig,
  pairDataMap: Map<string, PairData>,
  btc: BTCData,
  engAInd: Map<string, { sma20: (number|null)[]; sma50: (number|null)[]; donLo15: (number|null)[]; donHi15: (number|null)[]; atr14: (number|null)[] }>,
  engBInd: Map<string, { st: (1|-1|null)[]; atr14: (number|null)[] }>,
  startMs: number,
  endMs: number,
): { trades: Trade[]; cutPhase1: Trade[]; cutPhase2: Trade[] } {

  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const cutPhase1: Trade[] = [];
  const cutPhase2: Trade[] = [];

  function btcBullish(t: number): boolean {
    const di = getBarAtOrBefore(btc.dailyMap, t - DAY, DAY);
    if (di < 0) return false;
    const e20 = btc.dailyEma20[di], e50 = btc.dailyEma50[di];
    return e20 !== null && e50 !== null && e20 > e50;
  }

  function totalPositions(): number { return positions.size; }

  function closePosition(key: string, exitPrice: number, exitTime: number, reason: string, slipMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sprd(pos.pair);
    const xp = pos.dir === "long"
      ? exitPrice * (1 - sp_ * slipMult)
      : exitPrice * (1 + sp_ * slipMult);
    const notional = pos.margin * pos.lev;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const cost = notional * FEE * 2;
    const pnl = raw - cost;
    const trade: Trade = {
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl, margin: pos.margin, reason,
    };
    trades.push(trade);
    if (reason.startsWith("p1")) cutPhase1.push(trade);
    if (reason.startsWith("p2")) cutPhase2.push(trade);
    positions.delete(key);
  }

  // Build daily timestamps for iteration
  const dailyTimestamps: number[] = [];
  for (let t = startMs; t < endMs; t += DAY) dailyTimestamps.push(t);

  for (const dayT of dailyTimestamps) {
    // ─── CHECK EXISTING POSITIONS ─────────────────────────────────
    for (const [key, pos] of [...positions.entries()]) {
      const pd = pairDataMap.get(pos.pair);
      if (!pd) continue;

      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;
      const bar = pd.daily[di];
      const ageMs = dayT - pos.et;
      const ageH = ageMs / H1;

      // ─ Lifecycle Phase 1: Early protection (first 48h) ─
      // Determine the max phase-1 window for this config
      const p1MaxH = lc.p1Graduated
        ? 48 + 1   // graduated checks up to 48h
        : Math.max(lc.p1FailHours, lc.p1MomentumHours);
      if (lc.p1Enabled && ageH <= p1MaxH) {
        // We need intra-day resolution. Use 5m bars within this day.
        const m5Start = dayT;
        const m5End = dayT + DAY;
        for (let m5t = m5Start; m5t < m5End; m5t += M5) {
          if (positions.get(key) === undefined) break; // already closed
          const m5i = pd.m5Map.get(m5t);
          if (m5i === undefined) continue;
          const m5bar = pd.m5[m5i];
          const currentAgeH = (m5t - pos.et) / H1;
          const leveragedPct = pos.dir === "long"
            ? (m5bar.c - pos.ep) / pos.ep * pos.lev * 100
            : (pos.ep - m5bar.c) / pos.ep * pos.lev * 100;

          // Check SL first (5m resolution)
          if (pos.dir === "long" ? m5bar.l <= pos.sl : m5bar.h >= pos.sl) {
            closePosition(key, pos.sl, m5t, "sl", SL_SLIPPAGE);
            break;
          }

          // Phase 1: fail check (gone against by X% within Y hours)
          if (!lc.p1Graduated && currentAgeH >= lc.p1FailHours && leveragedPct < -lc.p1FailPct) {
            closePosition(key, m5bar.c, m5t, "p1-fail");
            break;
          }

          // Phase 1: momentum check (not enough profit by Y hours)
          if (!lc.p1Graduated && currentAgeH >= lc.p1MomentumHours && leveragedPct < lc.p1MomentumPct) {
            closePosition(key, m5bar.c, m5t, "p1-slow");
            break;
          }

          // Phase 1 graduated variant: check at each gate with 1h window
          if (lc.p1Graduated) {
            if (currentAgeH >= 12 && currentAgeH < 13 && leveragedPct < lc.p1Grad12h) {
              closePosition(key, m5bar.c, m5t, "p1-grad12");
              break;
            }
            if (currentAgeH >= 24 && currentAgeH < 25 && leveragedPct < lc.p1Grad24h) {
              closePosition(key, m5bar.c, m5t, "p1-grad24");
              break;
            }
            if (currentAgeH >= 48 && currentAgeH < 49 && leveragedPct < lc.p1Grad48h) {
              closePosition(key, m5bar.c, m5t, "p1-grad48");
              break;
            }
          }
        }
        if (positions.get(key) === undefined) continue; // was closed in 5m loop
      }

      // ─ Lifecycle Phase 2: Breakeven lock (1-7 days) ─
      if (lc.p2Enabled && ageMs >= DAY && ageMs < 7 * DAY) {
        // Check on 5m for precise SL and BE lock
        const m5Start = dayT;
        const m5End = dayT + DAY;
        for (let m5t = m5Start; m5t < m5End; m5t += M5) {
          if (positions.get(key) === undefined) break;
          const m5i = pd.m5Map.get(m5t);
          if (m5i === undefined) continue;
          const m5bar = pd.m5[m5i];
          const leveragedPct = pos.dir === "long"
            ? (m5bar.c - pos.ep) / pos.ep * pos.lev * 100
            : (pos.ep - m5bar.c) / pos.ep * pos.lev * 100;

          // Check SL first
          if (pos.dir === "long" ? m5bar.l <= pos.sl : m5bar.h >= pos.sl) {
            closePosition(key, pos.sl, m5t, "sl", SL_SLIPPAGE);
            break;
          }

          // If leveraged profit ever reached threshold, lock BE
          if (leveragedPct >= lc.p2ThresholdPct) {
            // Move SL to breakeven + buffer
            const bePriceLong = pos.ep * (1 + lc.p2BufferPct / 100 / pos.lev);
            const bePriceShort = pos.ep * (1 - lc.p2BufferPct / 100 / pos.lev);
            const newSl = pos.dir === "long"
              ? Math.max(pos.sl, bePriceLong)
              : Math.min(pos.sl, bePriceShort);
            pos.sl = newSl;
          }
        }
        if (positions.get(key) === undefined) continue;
      }

      // ─ Standard exit checks (daily bar resolution) ─

      // Check stop-loss hit (intraday via daily H/L)
      let stopped = false;
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePosition(key, pos.sl, dayT, "sl", SL_SLIPPAGE);
        stopped = true;
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        closePosition(key, pos.sl, dayT, "sl", SL_SLIPPAGE);
        stopped = true;
      }
      if (stopped) continue;

      // Check TP (engine C)
      if (pos.tp > 0) {
        if (pos.dir === "long" && bar.h >= pos.tp) {
          closePosition(key, pos.tp, dayT, "tp");
          continue;
        } else if (pos.dir === "short" && bar.l <= pos.tp) {
          closePosition(key, pos.tp, dayT, "tp");
          continue;
        }
      }

      // Check max hold
      if (!lc.p3Enabled || ageMs < 7 * DAY) {
        // Normal max hold
        if (ageMs >= pos.maxHold) {
          closePosition(key, bar.c, dayT, "maxhold");
          continue;
        }
      }
      // Phase 3: 7+ day trades only exit via engine signals, no maxhold interference
      // (still check maxhold as a safety net at 90 days)
      if (lc.p3Enabled && ageMs >= 90 * DAY) {
        closePosition(key, bar.c, dayT, "maxhold");
        continue;
      }

      // ATR trailing stop management (production logic)
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

      // Engine-specific exits
      if (pos.engine === "A") {
        const ea = engAInd.get(pos.pair);
        if (ea && di > 0) {
          if (pos.dir === "long" && ea.donLo15[di] !== null && bar.c < ea.donLo15[di]!) {
            closePosition(key, bar.c, dayT, "donch-exit");
            continue;
          }
          if (pos.dir === "short" && ea.donHi15[di] !== null && bar.c > ea.donHi15[di]!) {
            closePosition(key, bar.c, dayT, "donch-exit");
            continue;
          }
        }
      }

      if (pos.engine === "B") {
        // Supertrend flip exit
        const eb = engBInd.get(pos.pair);
        if (eb) {
          const h4i = getBarAtOrBefore(pd.h4Map, dayT, H4);
          if (h4i > 0) {
            const stNow = eb.st[h4i];
            if (stNow !== null) {
              if (pos.dir === "long" && stNow === -1) {
                closePosition(key, pd.h4[h4i].c, dayT, "st-flip");
                continue;
              }
              if (pos.dir === "short" && stNow === 1) {
                closePosition(key, pd.h4[h4i].c, dayT, "st-flip");
                continue;
              }
            }
          }
        }
      }
    }

    // ─── ENGINE A: Daily Donchian Trend ─────────────────────────────
    for (const p of PAIRS) {
      if (totalPositions() >= MAX_POSITIONS) break;
      const keyA = `A:${p}`;
      if (positions.has(keyA)) continue;

      const pd = pairDataMap.get(p);
      if (!pd) continue;
      const ea = engAInd.get(p);
      if (!ea) continue;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 51) continue;

      const bar = pd.daily[di];
      const sma20now = ea.sma20[di - 1], sma50now = ea.sma50[di - 1];
      const sma20prev = ea.sma20[di - 2], sma50prev = ea.sma50[di - 2];
      if (sma20now === null || sma50now === null || sma20prev === null || sma50prev === null) continue;

      let dir: Dir | null = null;
      if (sma20prev <= sma50prev && sma20now > sma50now) {
        if (btcBullish(dayT)) dir = "long";
      }
      if (sma20prev >= sma50prev && sma20now < sma50now) {
        dir = "short";
      }
      if (!dir) continue;

      const atrVal = ea.atr14[di - 1];
      if (atrVal === null) continue;

      const sp_ = sprd(p);
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(keyA, {
        pair: p, engine: "A", dir, ep, et: dayT, sl, tp: 0,
        margin: 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
      });
    }

    // ─── ENGINE B: 4h Supertrend ────────────────────────────────────
    for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
      const h4T = dayT + h4Offset;
      for (const p of PAIRS) {
        if (totalPositions() >= MAX_POSITIONS) break;
        const keyB = `B:${p}`;
        if (positions.has(keyB)) continue;

        const pd = pairDataMap.get(p);
        if (!pd) continue;
        const eb = engBInd.get(p);
        if (!eb) continue;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined || h4i < 21) continue;

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

        // BTC EMA filter for longs
        if (dir === "long" && !btcBullish(h4T)) continue;

        const atrVal = eb.atr14[h4i - 1];
        if (atrVal === null) continue;

        const sp_ = sprd(p);
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(keyB, {
          pair: p, engine: "B", dir, ep, et: h4T, sl, tp: 0,
          margin: 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
        });
      }
    }
  }

  // Close remaining at last available price
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairDataMap.get(pos.pair);
    if (!pd || pd.daily.length === 0) continue;
    const lastBar = pd.daily[pd.daily.length - 1];
    closePosition(key, lastBar.c, lastBar.t, "eod");
  }

  return { trades, cutPhase1, cutPhase2 };
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  trades: number; pf: number; sharpe: number; perDay: number; wr: number;
  maxDd: number; totalPnl: number; avgPnl: number; avgHoldDays: number;
}

function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return {
    trades: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0, maxDd: 0, totalPnl: 0, avgPnl: 0, avgHoldDays: 0,
  };

  const sorted = [...filtered].sort((a, b) => a.xt - b.xt);
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const wr = wins.length / filtered.length;

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
  let equity = 0, peak = 0, maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDd) maxDd = peak - equity;
  }

  const avgHoldDays = filtered.reduce((s, t) => s + (t.xt - t.et), 0) / filtered.length / DAY;

  return {
    trades: filtered.length, pf, sharpe, perDay, wr, maxDd, totalPnl, avgPnl: totalPnl / filtered.length, avgHoldDays,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("Loading data...");

const btcRaw = load5m("BTC");
if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }
const btc = prepBTC(btcRaw);

const pairDataMap = new Map<string, PairData>();
const available: string[] = [];
for (const p of PAIRS) {
  const m5 = load5m(p);
  if (m5.length < 500) { console.log(`  Skipping ${p}: only ${m5.length} candles`); continue; }
  available.push(p);
  pairDataMap.set(p, prepPair(m5));
}
console.log(`Loaded ${available.length} pairs: ${available.join(", ")}\n`);

// Pre-compute indicators
const engAInd = new Map<string, { sma20: (number|null)[]; sma50: (number|null)[]; donLo15: (number|null)[]; donHi15: (number|null)[]; atr14: (number|null)[] }>();
const engBInd = new Map<string, { st: (1|-1|null)[]; atr14: (number|null)[] }>();

for (const p of available) {
  const pd = pairDataMap.get(p)!;
  const dc = pd.daily.map(b => b.c);
  engAInd.set(p, {
    sma20: smaCalc(dc, 20),
    sma50: smaCalc(dc, 50),
    donLo15: donchianLow(dc, 15),
    donHi15: donchianHigh(dc, 15),
    atr14: atrCalc(pd.daily, 14),
  });
  engBInd.set(p, {
    st: supertrendCalc(pd.h4, 14, 1.75).trend,
    atr14: atrCalc(pd.h4, 14),
  });
}

// ─── Define Lifecycle Configs ───────────────────────────────────────
const NO_LIFECYCLE: LifecycleConfig = {
  name: "1. Baseline (no age rules)",
  p1Enabled: false, p1FailHours: 0, p1FailPct: 0, p1MomentumHours: 0, p1MomentumPct: 0,
  p1Graduated: false, p1Grad12h: 0, p1Grad24h: 0, p1Grad48h: 0,
  p2Enabled: false, p2ThresholdPct: 0, p2BufferPct: 0,
  p3Enabled: false,
};

const PHASE1_ONLY: LifecycleConfig = {
  name: "2. Phase 1 only",
  p1Enabled: true, p1FailHours: 4, p1FailPct: 1, p1MomentumHours: 24, p1MomentumPct: 5,
  p1Graduated: false, p1Grad12h: 0, p1Grad24h: 0, p1Grad48h: 0,
  p2Enabled: false, p2ThresholdPct: 0, p2BufferPct: 0,
  p3Enabled: false,
};

const PHASE1_2: LifecycleConfig = {
  name: "3. Phase 1 + 2",
  p1Enabled: true, p1FailHours: 4, p1FailPct: 1, p1MomentumHours: 24, p1MomentumPct: 5,
  p1Graduated: false, p1Grad12h: 0, p1Grad24h: 0, p1Grad48h: 0,
  p2Enabled: true, p2ThresholdPct: 15, p2BufferPct: 1,
  p3Enabled: false,
};

const FULL_LIFECYCLE: LifecycleConfig = {
  name: "4. Full lifecycle (1+2+3)",
  p1Enabled: true, p1FailHours: 4, p1FailPct: 1, p1MomentumHours: 24, p1MomentumPct: 5,
  p1Graduated: false, p1Grad12h: 0, p1Grad24h: 0, p1Grad48h: 0,
  p2Enabled: true, p2ThresholdPct: 15, p2BufferPct: 1,
  p3Enabled: true,
};

const GRADUATED: LifecycleConfig = {
  name: "5. Graduated thresholds",
  p1Enabled: true, p1FailHours: 0, p1FailPct: 0, p1MomentumHours: 0, p1MomentumPct: 0,
  p1Graduated: true, p1Grad12h: 0, p1Grad24h: 5, p1Grad48h: 10,
  p2Enabled: false, p2ThresholdPct: 0, p2BufferPct: 0,
  p3Enabled: false,
};

// Data-driven variants based on threshold analysis
const SOFT_4H: LifecycleConfig = {
  name: "6. Soft 4h (-10% cut only)",
  p1Enabled: true, p1FailHours: 4, p1FailPct: 10, p1MomentumHours: 0, p1MomentumPct: 0,
  p1Graduated: false, p1Grad12h: 0, p1Grad24h: 0, p1Grad48h: 0,
  p2Enabled: false, p2ThresholdPct: 0, p2BufferPct: 0,
  p3Enabled: false,
};

const SWEET_12H: LifecycleConfig = {
  name: "7. 12h gate (<-5% cut)",
  p1Enabled: true, p1FailHours: 12, p1FailPct: 5, p1MomentumHours: 0, p1MomentumPct: 0,
  p1Graduated: false, p1Grad12h: 0, p1Grad24h: 0, p1Grad48h: 0,
  p2Enabled: false, p2ThresholdPct: 0, p2BufferPct: 0,
  p3Enabled: false,
};

const SWEET_12H_BE: LifecycleConfig = {
  name: "8. 12h gate + BE lock",
  p1Enabled: true, p1FailHours: 12, p1FailPct: 5, p1MomentumHours: 0, p1MomentumPct: 0,
  p1Graduated: false, p1Grad12h: 0, p1Grad24h: 0, p1Grad48h: 0,
  p2Enabled: true, p2ThresholdPct: 15, p2BufferPct: 1,
  p3Enabled: false,
};

const GENTLE_GRAD: LifecycleConfig = {
  name: "9. Gentle graduated (-5/0/5)",
  p1Enabled: true, p1FailHours: 0, p1FailPct: 0, p1MomentumHours: 0, p1MomentumPct: 0,
  p1Graduated: true, p1Grad12h: -5, p1Grad24h: 0, p1Grad48h: 5,
  p2Enabled: false, p2ThresholdPct: 0, p2BufferPct: 0,
  p3Enabled: false,
};

const STRICT_GRAD: LifecycleConfig = {
  name: "10. Strict graduated (-10/-5/0)",
  p1Enabled: true, p1FailHours: 0, p1FailPct: 0, p1MomentumHours: 0, p1MomentumPct: 0,
  p1Graduated: true, p1Grad12h: -10, p1Grad24h: -5, p1Grad48h: 0,
  p2Enabled: false, p2ThresholdPct: 0, p2BufferPct: 0,
  p3Enabled: false,
};

const STRICT_GRAD_BE: LifecycleConfig = {
  name: "11. Strict grad + BE lock",
  p1Enabled: true, p1FailHours: 0, p1FailPct: 0, p1MomentumHours: 0, p1MomentumPct: 0,
  p1Graduated: true, p1Grad12h: -10, p1Grad24h: -5, p1Grad48h: 0,
  p2Enabled: true, p2ThresholdPct: 15, p2BufferPct: 1,
  p3Enabled: false,
};

const STRICT_GRAD_FULL: LifecycleConfig = {
  name: "12. Strict grad + BE + P3",
  p1Enabled: true, p1FailHours: 0, p1FailPct: 0, p1MomentumHours: 0, p1MomentumPct: 0,
  p1Graduated: true, p1Grad12h: -10, p1Grad24h: -5, p1Grad48h: 0,
  p2Enabled: true, p2ThresholdPct: 15, p2BufferPct: 1,
  p3Enabled: true,
};

const configs: LifecycleConfig[] = [
  NO_LIFECYCLE, PHASE1_ONLY, PHASE1_2, FULL_LIFECYCLE, GRADUATED,
  SOFT_4H, SWEET_12H, SWEET_12H_BE, GENTLE_GRAD, STRICT_GRAD, STRICT_GRAD_BE, STRICT_GRAD_FULL,
];

// ─── Run All Configs ────────────────────────────────────────────────
const days = (FULL_END - FULL_START) / DAY;
console.log(`Period: ${new Date(FULL_START).toISOString().slice(0,10)} to ${new Date(FULL_END).toISOString().slice(0,10)} (${days.toFixed(0)} days)\n`);

console.log("=".repeat(120));
console.log("LIFECYCLE EXIT RESEARCH: Age-based exit strategies for Donchian + Supertrend");
console.log("=".repeat(120));

// Run OOS split: train Jun2023-Jun2025, test Jun2025-Mar2026
const TRAIN_START = new Date("2023-06-01").getTime();
const TRAIN_END = new Date("2025-06-01").getTime();
const TEST_START = new Date("2025-06-01").getTime();
const TEST_END = new Date("2026-03-23").getTime();

console.log("\n--- FULL PERIOD ---\n");
console.log(
  "Strategy".padEnd(35) +
  "Trades".padStart(7) +
  "$/day".padStart(8) +
  "WR%".padStart(7) +
  "PF".padStart(7) +
  "MaxDD".padStart(8) +
  "Sharpe".padStart(8) +
  "AvgHold".padStart(9) +
  "TotalPnL".padStart(10) +
  "P1cuts".padStart(8) +
  "P2cuts".padStart(8)
);
console.log("-".repeat(120));

interface ResultRow {
  lc: LifecycleConfig;
  full: Stats;
  train: Stats;
  test: Stats;
  cutP1: Trade[];
  cutP2: Trade[];
  allTrades: Trade[];
}
const results: ResultRow[] = [];

for (const lc of configs) {
  const { trades, cutPhase1, cutPhase2 } = runSim(lc, pairDataMap, btc, engAInd, engBInd, FULL_START, FULL_END);
  const full = computeStats(trades, FULL_START, FULL_END);
  const train = computeStats(trades, TRAIN_START, TRAIN_END);
  const test = computeStats(trades, TEST_START, TEST_END);
  results.push({ lc, full, train, test, cutP1: cutPhase1, cutP2: cutPhase2, allTrades: trades });

  const f = full;
  console.log(
    lc.name.padEnd(35) +
    String(f.trades).padStart(7) +
    `$${f.perDay.toFixed(2)}`.padStart(8) +
    `${(f.wr * 100).toFixed(1)}`.padStart(7) +
    f.pf.toFixed(2).padStart(7) +
    `$${f.maxDd.toFixed(0)}`.padStart(8) +
    f.sharpe.toFixed(2).padStart(8) +
    `${f.avgHoldDays.toFixed(1)}d`.padStart(9) +
    `$${f.totalPnl.toFixed(0)}`.padStart(10) +
    String(cutPhase1.length).padStart(8) +
    String(cutPhase2.length).padStart(8)
  );
}

// ─── Train / Test Split ─────────────────────────────────────────────
console.log("\n--- TRAIN PERIOD (Jun2023 - Jun2025) ---\n");
console.log(
  "Strategy".padEnd(35) +
  "Trades".padStart(7) +
  "$/day".padStart(8) +
  "WR%".padStart(7) +
  "PF".padStart(7) +
  "MaxDD".padStart(8) +
  "Sharpe".padStart(8)
);
console.log("-".repeat(80));
for (const r of results) {
  const s = r.train;
  console.log(
    r.lc.name.padEnd(35) +
    String(s.trades).padStart(7) +
    `$${s.perDay.toFixed(2)}`.padStart(8) +
    `${(s.wr * 100).toFixed(1)}`.padStart(7) +
    s.pf.toFixed(2).padStart(7) +
    `$${s.maxDd.toFixed(0)}`.padStart(8) +
    s.sharpe.toFixed(2).padStart(8)
  );
}

console.log("\n--- TEST PERIOD (Jun2025 - Mar2026) ---\n");
console.log(
  "Strategy".padEnd(35) +
  "Trades".padStart(7) +
  "$/day".padStart(8) +
  "WR%".padStart(7) +
  "PF".padStart(7) +
  "MaxDD".padStart(8) +
  "Sharpe".padStart(8)
);
console.log("-".repeat(80));
for (const r of results) {
  const s = r.test;
  console.log(
    r.lc.name.padEnd(35) +
    String(s.trades).padStart(7) +
    `$${s.perDay.toFixed(2)}`.padStart(8) +
    `${(s.wr * 100).toFixed(1)}`.padStart(7) +
    s.pf.toFixed(2).padStart(7) +
    `$${s.maxDd.toFixed(0)}`.padStart(8) +
    s.sharpe.toFixed(2).padStart(8)
  );
}

// ─── Phase 1 Cut Analysis ───────────────────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("PHASE 1 CUT ANALYSIS: P&L of trades killed early vs what they would have done");
console.log("=".repeat(120));

for (const r of results) {
  if (r.cutP1.length === 0) continue;
  const p1pnl = r.cutP1.reduce((s, t) => s + t.pnl, 0);
  const p1wins = r.cutP1.filter(t => t.pnl > 0).length;
  const p1losses = r.cutP1.filter(t => t.pnl <= 0).length;

  // Break down by reason
  const byReason = new Map<string, { count: number; pnl: number }>();
  for (const t of r.cutP1) {
    const curr = byReason.get(t.reason) ?? { count: 0, pnl: 0 };
    curr.count++;
    curr.pnl += t.pnl;
    byReason.set(t.reason, curr);
  }

  console.log(`\n${r.lc.name}:`);
  console.log(`  Phase 1 cuts: ${r.cutP1.length} trades (${p1wins}W / ${p1losses}L), P&L: $${p1pnl.toFixed(2)}`);
  console.log(`  Avg P&L of cut trades: $${(p1pnl / r.cutP1.length).toFixed(2)}`);
  for (const [reason, data] of byReason) {
    console.log(`    ${reason}: ${data.count} trades, P&L: $${data.pnl.toFixed(2)}, avg: $${(data.pnl / data.count).toFixed(2)}`);
  }
}

// ─── Phase 2 Cut Analysis ───────────────────────────────────────────
for (const r of results) {
  if (r.cutP2.length === 0) continue;
  const p2pnl = r.cutP2.reduce((s, t) => s + t.pnl, 0);
  const p2wins = r.cutP2.filter(t => t.pnl > 0).length;
  const p2losses = r.cutP2.filter(t => t.pnl <= 0).length;
  console.log(`\n${r.lc.name} - Phase 2 BE locks:`);
  console.log(`  ${r.cutP2.length} trades triggered BE lock (${p2wins}W / ${p2losses}L), P&L: $${p2pnl.toFixed(2)}`);
}

// ─── Trade Age Distribution ─────────────────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("TRADE AGE ANALYSIS (Baseline)");
console.log("=".repeat(120));

const baseline = results[0];
if (baseline) {
  const ageBuckets: { label: string; minH: number; maxH: number }[] = [
    { label: "<4h", minH: 0, maxH: 4 },
    { label: "4-12h", minH: 4, maxH: 12 },
    { label: "12-24h", minH: 12, maxH: 24 },
    { label: "1-2d", minH: 24, maxH: 48 },
    { label: "2-3d", minH: 48, maxH: 72 },
    { label: "3-7d", minH: 72, maxH: 168 },
    { label: "7-14d", minH: 168, maxH: 336 },
    { label: "14-30d", minH: 336, maxH: 720 },
    { label: "30-60d", minH: 720, maxH: 1440 },
    { label: "60d+", minH: 1440, maxH: Infinity },
  ];

  console.log("\n" +
    "Age Bucket".padEnd(12) +
    "Trades".padStart(8) +
    "WR%".padStart(8) +
    "AvgPnL".padStart(10) +
    "TotalPnL".padStart(10) +
    "AvgLev%".padStart(9) +
    "Winners".padStart(9) +
    "Losers".padStart(8)
  );
  console.log("-".repeat(80));

  for (const bucket of ageBuckets) {
    const inBucket = baseline.allTrades.filter(t => {
      const ageH = (t.xt - t.et) / H1;
      return ageH >= bucket.minH && ageH < bucket.maxH;
    });
    if (inBucket.length === 0) continue;
    const wins = inBucket.filter(t => t.pnl > 0).length;
    const total = inBucket.reduce((s, t) => s + t.pnl, 0);
    const avgLevPct = inBucket.reduce((s, t) => {
      const notional = t.margin * 10;
      return s + (t.pnl / notional * 100);
    }, 0) / inBucket.length;

    console.log(
      bucket.label.padEnd(12) +
      String(inBucket.length).padStart(8) +
      `${(wins / inBucket.length * 100).toFixed(1)}`.padStart(8) +
      `$${(total / inBucket.length).toFixed(2)}`.padStart(10) +
      `$${total.toFixed(0)}`.padStart(10) +
      `${avgLevPct.toFixed(1)}%`.padStart(9) +
      String(wins).padStart(9) +
      String(inBucket.length - wins).padStart(8)
    );
  }
}

// ─── Leveraged P&L at key checkpoints ───────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("INTRA-TRADE P&L SNAPSHOTS (Baseline trades, using 5m data)");
console.log("What leveraged % did trades show at 4h, 12h, 24h, 48h -- and then final outcome");
console.log("=".repeat(120));

// For each baseline trade, reconstruct leveraged P&L at checkpoints using 5m data
const checkpoints = [4, 12, 24, 48]; // hours

interface TradeSnapshot {
  trade: Trade;
  pctAt: Map<number, number | null>; // hoursCheckpoint -> leveraged % at that time
}

const snapshots: TradeSnapshot[] = [];
for (const trade of baseline?.allTrades ?? []) {
  const pd = pairDataMap.get(trade.pair);
  if (!pd) continue;

  const snap: TradeSnapshot = { trade, pctAt: new Map() };
  for (const cp of checkpoints) {
    const targetT = trade.et + cp * H1;
    if (targetT > trade.xt) { snap.pctAt.set(cp, null); continue; }

    // Find closest 5m bar
    const aligned = Math.floor(targetT / M5) * M5;
    const m5i = pd.m5Map.get(aligned);
    if (m5i === undefined) { snap.pctAt.set(cp, null); continue; }
    const bar = pd.m5[m5i];
    const leveragedPct = trade.dir === "long"
      ? (bar.c - trade.ep) / trade.ep * 10 * 100
      : (trade.ep - bar.c) / trade.ep * 10 * 100;
    snap.pctAt.set(cp, leveragedPct);
  }
  snapshots.push(snap);
}

// Analyze: for trades that end as losers vs winners, what did they look like at each checkpoint
for (const cp of checkpoints) {
  const withData = snapshots.filter(s => s.pctAt.get(cp) !== null);
  if (withData.length === 0) continue;

  const winners = withData.filter(s => s.trade.pnl > 0);
  const losers = withData.filter(s => s.trade.pnl <= 0);

  const winAvg = winners.length > 0 ? winners.reduce((s, w) => s + (w.pctAt.get(cp) ?? 0), 0) / winners.length : 0;
  const loseAvg = losers.length > 0 ? losers.reduce((s, w) => s + (w.pctAt.get(cp) ?? 0), 0) / losers.length : 0;

  // What % of winners were negative at this checkpoint
  const winNeg = winners.filter(s => (s.pctAt.get(cp) ?? 0) < 0).length;
  const loseNeg = losers.filter(s => (s.pctAt.get(cp) ?? 0) < 0).length;

  // What % of winners were below various thresholds
  const thresholds = [-10, -5, -1, 0, 5, 10, 15];

  console.log(`\nAt ${cp}h checkpoint (${withData.length} trades with data):`);
  console.log(`  Winners (${winners.length}): avg lev% = ${winAvg.toFixed(1)}%, negative: ${winNeg} (${(winNeg / Math.max(winners.length, 1) * 100).toFixed(0)}%)`);
  console.log(`  Losers  (${losers.length}): avg lev% = ${loseAvg.toFixed(1)}%, negative: ${loseNeg} (${(loseNeg / Math.max(losers.length, 1) * 100).toFixed(0)}%)`);

  console.log(`  Threshold analysis (if we cut trades below X at ${cp}h):`);
  for (const th of thresholds) {
    const cutTrades = withData.filter(s => (s.pctAt.get(cp) ?? 0) < th);
    const cutWins = cutTrades.filter(s => s.trade.pnl > 0);
    const cutLosses = cutTrades.filter(s => s.trade.pnl <= 0);
    const savedLoss = cutLosses.reduce((s, t) => s + t.trade.pnl, 0);
    const missedWin = cutWins.reduce((s, t) => s + t.trade.pnl, 0);
    const netImpact = -savedLoss - missedWin; // positive = good (we saved more than we missed)
    if (cutTrades.length === 0) continue;
    console.log(`    Cut <${th}%: ${cutTrades.length} trades (${cutWins.length}W/${cutLosses.length}L), saved losses: $${(-savedLoss).toFixed(2)}, missed wins: $${missedWin.toFixed(2)}, net: ${netImpact >= 0 ? "+" : ""}$${netImpact.toFixed(2)}`);
  }
}

// ─── Exit Reason Breakdown ──────────────────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("EXIT REASON BREAKDOWN (all strategies)");
console.log("=".repeat(120));

for (const r of results) {
  const reasons = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const t of r.allTrades) {
    const curr = reasons.get(t.reason) ?? { count: 0, pnl: 0, wins: 0 };
    curr.count++;
    curr.pnl += t.pnl;
    if (t.pnl > 0) curr.wins++;
    reasons.set(t.reason, curr);
  }

  console.log(`\n${r.lc.name}:`);
  for (const [reason, data] of [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(15)} ${String(data.count).padStart(5)} trades  WR=${(data.wins / data.count * 100).toFixed(1)}%  PnL=$${data.pnl.toFixed(2)}  Avg=$${(data.pnl / data.count).toFixed(2)}`);
  }
}

// ─── Summary ────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("SUMMARY: Delta from baseline");
console.log("=".repeat(120));

const bFull = results[0]?.full;
if (bFull) {
  console.log("\n" +
    "Strategy".padEnd(35) +
    "dTrades".padStart(9) +
    "d$/day".padStart(9) +
    "dWR%".padStart(8) +
    "dMaxDD".padStart(9) +
    "dSharpe".padStart(9) +
    "Verdict".padStart(10)
  );
  console.log("-".repeat(95));

  for (const r of results) {
    const f = r.full;
    const dt = f.trades - bFull.trades;
    const dpd = f.perDay - bFull.perDay;
    const dwr = (f.wr - bFull.wr) * 100;
    const ddd = f.maxDd - bFull.maxDd;
    const dsh = f.sharpe - bFull.sharpe;
    const verdict = dpd > 0 && ddd <= 0 ? "BETTER" : dpd >= 0 && ddd < 0 ? "DD-HELP" : dpd > 0 && ddd > 0 ? "MIXED" : dpd < 0 ? "WORSE" : "SAME";
    console.log(
      r.lc.name.padEnd(35) +
      `${dt >= 0 ? "+" : ""}${dt}`.padStart(9) +
      `${dpd >= 0 ? "+" : ""}$${dpd.toFixed(2)}`.padStart(9) +
      `${dwr >= 0 ? "+" : ""}${dwr.toFixed(1)}`.padStart(8) +
      `${ddd >= 0 ? "+" : ""}$${ddd.toFixed(0)}`.padStart(9) +
      `${dsh >= 0 ? "+" : ""}${dsh.toFixed(2)}`.padStart(9) +
      verdict.padStart(10)
    );
  }
}

// ─── Replacement Trade Analysis ─────────────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("REPLACEMENT TRADE ANALYSIS: What happened to the extra trades opened after early cuts?");
console.log("=".repeat(120));

for (const r of results) {
  if (r.cutP1.length === 0) continue;
  const baselineTrades = results[0].allTrades;
  // Find trades in this config that don't exist in baseline (by pair+engine+entryTime)
  const baselineKeys = new Set(baselineTrades.map(t => `${t.pair}:${t.engine}:${t.et}`));
  const extraTrades = r.allTrades.filter(t => !baselineKeys.has(`${t.pair}:${t.engine}:${t.et}`));
  const extraPnl = extraTrades.reduce((s, t) => s + t.pnl, 0);
  const extraWins = extraTrades.filter(t => t.pnl > 0).length;

  // Trades in baseline but NOT in this config (replaced)
  const thisKeys = new Set(r.allTrades.map(t => `${t.pair}:${t.engine}:${t.et}`));
  const missingTrades = baselineTrades.filter(t => !thisKeys.has(`${t.pair}:${t.engine}:${t.et}`));
  const missingPnl = missingTrades.reduce((s, t) => s + t.pnl, 0);

  console.log(`\n${r.lc.name}:`);
  console.log(`  Extra trades (not in baseline): ${extraTrades.length}, WR=${(extraWins / Math.max(extraTrades.length, 1) * 100).toFixed(1)}%, PnL=$${extraPnl.toFixed(2)}`);
  console.log(`  Missing baseline trades: ${missingTrades.length}, missed PnL=$${missingPnl.toFixed(2)}`);
  console.log(`  Net effect: cuts saved $${(-r.cutP1.reduce((s,t) => s + t.pnl, 0)).toFixed(2)} from early exit + $${extraPnl.toFixed(2)} from replacements - $${missingPnl.toFixed(2)} missed`);
}

// ─── Risk-Adjusted Comparison ───────────────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("RISK-ADJUSTED COMPARISON: $/day per $1 MaxDD");
console.log("=".repeat(120));

console.log("\n" +
  "Strategy".padEnd(35) +
  "$/day".padStart(8) +
  "MaxDD".padStart(8) +
  "$/DD".padStart(8) +
  "Sharpe".padStart(8) +
  "PF".padStart(7) +
  "Train$/d".padStart(10) +
  "Test$/d".padStart(9)
);
console.log("-".repeat(95));
const sortedResults = [...results].sort((a, b) => {
  const aRatio = a.full.maxDd > 0 ? a.full.perDay / a.full.maxDd : 0;
  const bRatio = b.full.maxDd > 0 ? b.full.perDay / b.full.maxDd : 0;
  return bRatio - aRatio;
});

for (const r of sortedResults) {
  const f = r.full;
  const ratio = f.maxDd > 0 ? f.perDay / f.maxDd : 0;
  console.log(
    r.lc.name.padEnd(35) +
    `$${f.perDay.toFixed(2)}`.padStart(8) +
    `$${f.maxDd.toFixed(0)}`.padStart(8) +
    ratio.toFixed(4).padStart(8) +
    f.sharpe.toFixed(2).padStart(8) +
    f.pf.toFixed(2).padStart(7) +
    `$${r.train.perDay.toFixed(2)}`.padStart(10) +
    `$${r.test.perDay.toFixed(2)}`.padStart(9)
  );
}

console.log("\nDone.");
