/**
 * Partial Close Research - Does closing part of a position at profit milestones
 * beat holding 100% until exit signal?
 *
 * Strategies tested:
 *   1. Baseline: hold 100% until exit signal
 *   2. Close 50% at +2x ATR profit, let 50% run
 *   3. Close 33% at +1x ATR, 33% at +3x ATR, let 34% run
 *   4. Close 25% at +10%, +20%, +30%, let 25% run
 *   5. Close 50% at +15% leveraged, let 50% run with SL at breakeven
 *
 * Combined Donchian SMA(20/50) $7 + Supertrend(14,1.75) $5, 10x leverage.
 * Each partial close pays its own spread + fees round-trip.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-partial-close.ts
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
const SL_SLIPPAGE = 1.5;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const WANTED_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-28").getTime();

const DON_MARGIN = 7;
const ST_MARGIN  = 5;
const LEV = 10;
const SL_ATR_MULT = 3;
const SL_CAP = 0.035;
const MAX_HOLD = 60 * DAY;

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

// A partial-close milestone
interface Milestone {
  fractionToClose: number;       // fraction of ORIGINAL notional to close
  triggerType: "atr" | "pct";    // ATR multiples or percentage of leveraged P&L
  triggerValue: number;           // the threshold value
  moveSLToBreakeven?: boolean;   // after partial close, move SL to entry
}

interface PartialCloseStrategy {
  label: string;
  milestones: Milestone[];       // sorted ascending by triggerValue
}

// Position represents a live position that may have had partials closed
interface Position {
  pair: string;
  engine: string;
  dir: Dir;
  ep: number;         // entry price (after spread)
  et: number;         // entry time
  sl: number;         // stop-loss price
  origMargin: number; // original margin at entry
  atr: number;        // ATR at entry
  bestPnlAtr: number; // best unrealized P&L in ATR multiples (for trail)
  closedFraction: number;   // fraction already closed via partials (0..1)
  milestonesHit: boolean[]; // which milestones have been triggered
  peakPrice: number;        // highest (long) / lowest (short) price seen
}

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number;
  pnl: number; margin: number;
  isPartial: boolean;
  fraction: number;       // fraction of original position this trade represents
  peakPrice: number;      // peak price during this portion's life
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
function smaFn(vals: number[], period: number): (number | null)[] {
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

function atrSma(bars: Bar[], period: number): (number | null)[] {
  // SMA-based ATR (not Wilder smoothing)
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
  const r: (number | null)[] = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    sum += trs[i];
    if (i >= period) sum -= trs[i - period];
    if (i >= period - 1) r[i] = sum / period;
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
  return { trend };
}

// ─── Data Prep ──────────────────────────────────────────────────────
interface PairData {
  m5: C[]; h4: Bar[]; daily: Bar[];
  h4Map: Map<number, number>; dailyMap: Map<number, number>;
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
    dailyEma20: ema(dc, 20),
    dailyEma50: ema(dc, 50),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
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

function getBarAtOrBefore(bars: Bar[], t: number, barMap: Map<number, number>, period: number): number {
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

// ─── Partial Close Strategies ───────────────────────────────────────
const STRATEGIES: PartialCloseStrategy[] = [
  {
    label: "1. Baseline (100% hold)",
    milestones: [],
  },
  {
    label: "2. 50% @ +2x ATR",
    milestones: [
      { fractionToClose: 0.50, triggerType: "atr", triggerValue: 2.0 },
    ],
  },
  {
    label: "3. 33%@1x + 33%@3x ATR",
    milestones: [
      { fractionToClose: 0.33, triggerType: "atr", triggerValue: 1.0 },
      { fractionToClose: 0.33, triggerType: "atr", triggerValue: 3.0 },
    ],
  },
  {
    label: "4. 25%@10/20/30% lev",
    milestones: [
      { fractionToClose: 0.25, triggerType: "pct", triggerValue: 0.10 },
      { fractionToClose: 0.25, triggerType: "pct", triggerValue: 0.20 },
      { fractionToClose: 0.25, triggerType: "pct", triggerValue: 0.30 },
    ],
  },
  {
    label: "5. 50%@15% + BE SL",
    milestones: [
      { fractionToClose: 0.50, triggerType: "pct", triggerValue: 0.15, moveSLToBreakeven: true },
    ],
  },
];

// ─── Run Backtest for one strategy ─────────────────────────────────
function runBacktest(strategy: PartialCloseStrategy, btc: BTCData,
  pairDataMap: Map<string, PairData>, available: string[],
  engA: Map<string, { sma20: (number | null)[]; sma50: (number | null)[]; donLo15: (number | null)[]; donHi15: (number | null)[]; atr14: (number | null)[] }>,
  engB: Map<string, { st: (1 | -1 | null)[]; atr14: (number | null)[] }>,
): Trade[] {

  const positions = new Map<string, Position>();
  const trades: Trade[] = [];

  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    dailyTimestamps.push(t);
  }

  function btcBullish(t: number): boolean {
    const di = getBarAtOrBefore(btc.daily, t - DAY, btc.dailyMap, DAY);
    if (di < 0) return false;
    const e20 = btc.dailyEma20[di], e50 = btc.dailyEma50[di];
    return e20 !== null && e50 !== null && e20 > e50;
  }

  function btc30dRet(t: number): number {
    const di = getBarAtOrBefore(btc.daily, t - DAY, btc.dailyMap, DAY);
    if (di < 0 || di < 30) return 0;
    return btc.daily[di].c / btc.daily[di - 30].c - 1;
  }

  // Close the remaining fraction of a position
  function closeRemaining(key: string, exitPrice: number, exitTime: number, slippageMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const remainFrac = 1 - pos.closedFraction;
    if (remainFrac <= 0.001) { positions.delete(key); return; }

    const sp_ = sp(pos.pair);
    const xp = pos.dir === "long"
      ? exitPrice * (1 - sp_ * slippageMult)
      : exitPrice * (1 + sp_ * slippageMult);

    const partialMargin = pos.origMargin * remainFrac;
    const notional = partialMargin * LEV;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const cost = notional * FEE * 2; // entry + exit fees on this partial
    const pnl = raw - cost;

    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime,
      pnl, margin: partialMargin,
      isPartial: false, fraction: remainFrac,
      peakPrice: pos.peakPrice,
    });
    positions.delete(key);
  }

  // Execute a partial close at a milestone price
  function executePartial(pos: Position, milestoneIdx: number, closePrice: number, closeTime: number) {
    const milestone = strategy.milestones[milestoneIdx];
    const frac = milestone.fractionToClose;
    const sp_ = sp(pos.pair);

    // Exit price with spread for partial close
    const xp = pos.dir === "long"
      ? closePrice * (1 - sp_)
      : closePrice * (1 + sp_);

    const partialMargin = pos.origMargin * frac;
    const notional = partialMargin * LEV;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    // Partial close pays its own round-trip fees (entry was already counted at original open)
    // Actually: the entry fee was for the full position. The partial close exit pays exit fee.
    // But we need to be fair: allocate entry fee proportionally + pay exit fee for the partial.
    const entryCost = notional * FEE;  // proportional entry fee for this slice
    const exitCost = notional * FEE;   // exit fee for this slice
    const cost = entryCost + exitCost;
    const pnl = raw - cost;

    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: closeTime,
      pnl, margin: partialMargin,
      isPartial: true, fraction: frac,
      peakPrice: pos.peakPrice,
    });

    pos.closedFraction += frac;
    pos.milestonesHit[milestoneIdx] = true;

    // Move SL to breakeven if requested
    if (milestone.moveSLToBreakeven) {
      pos.sl = pos.dir === "long"
        ? Math.max(pos.sl, pos.ep)
        : Math.min(pos.sl, pos.ep);
    }
  }

  // Check if price triggers a milestone
  function checkMilestones(pos: Position, barHigh: number, barLow: number, barClose: number, barTime: number) {
    if (strategy.milestones.length === 0) return;

    for (let mi = 0; mi < strategy.milestones.length; mi++) {
      if (pos.milestonesHit[mi]) continue;
      if (pos.closedFraction >= 0.999) break;

      const ms = strategy.milestones[mi];
      let triggered = false;
      let triggerPrice = barClose;

      if (ms.triggerType === "atr") {
        // Check if intraday high/low crossed the ATR threshold
        const pnlAtHigh = pos.dir === "long"
          ? (barHigh - pos.ep) / pos.atr
          : (pos.ep - barLow) / pos.atr;
        if (pnlAtHigh >= ms.triggerValue) {
          triggered = true;
          // Use the exact trigger price
          triggerPrice = pos.dir === "long"
            ? pos.ep + ms.triggerValue * pos.atr
            : pos.ep - ms.triggerValue * pos.atr;
        }
      } else if (ms.triggerType === "pct") {
        // Percentage of leveraged notional = pct return on margin
        // E.g. +10% means entry price moved 1% (with 10x leverage)
        const pricePctAtHigh = pos.dir === "long"
          ? (barHigh - pos.ep) / pos.ep
          : (pos.ep - barLow) / pos.ep;
        const levPct = pricePctAtHigh * LEV;
        if (levPct >= ms.triggerValue) {
          triggered = true;
          const priceMove = ms.triggerValue / LEV;
          triggerPrice = pos.dir === "long"
            ? pos.ep * (1 + priceMove)
            : pos.ep * (1 - priceMove);
        }
      }

      if (triggered) {
        executePartial(pos, mi, triggerPrice, barTime);
      }
    }
  }

  // ─── Main Loop ─────────────────────────────────────────────────────
  for (const dayT of dailyTimestamps) {

    // ─── CHECK EXISTING POSITIONS ─────────────────────────────────
    for (const [key, pos] of [...positions.entries()]) {
      if (!positions.has(key)) continue; // may have been closed by partial
      const pd = pairDataMap.get(pos.pair);
      if (!pd) continue;

      if (pos.engine === "A") {
        // Donchian: check on daily bar
        const di = pd.dailyMap.get(dayT);
        if (di === undefined) continue;
        const bar = pd.daily[di];

        // Update peak price
        if (pos.dir === "long" && bar.h > pos.peakPrice) pos.peakPrice = bar.h;
        if (pos.dir === "short" && bar.l < pos.peakPrice) pos.peakPrice = bar.l;

        // Stop-loss check
        if (pos.dir === "long" && bar.l <= pos.sl) {
          closeRemaining(key, pos.sl, dayT, SL_SLIPPAGE); continue;
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          closeRemaining(key, pos.sl, dayT, SL_SLIPPAGE); continue;
        }

        // Max hold
        if (dayT - pos.et >= MAX_HOLD) {
          closeRemaining(key, bar.c, dayT); continue;
        }

        // Check partial close milestones (before trail update)
        checkMilestones(pos, bar.h, bar.l, bar.c, dayT);
        if (!positions.has(key)) continue;

        // Trailing stop (ATR-based, same as live)
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

        // Donchian exit: close < 15-day low (longs) or > 15-day high (shorts)
        const ea = engA.get(pos.pair);
        if (ea && di > 0) {
          if (pos.dir === "long" && ea.donLo15[di] !== null && bar.c < ea.donLo15[di]!) {
            closeRemaining(key, bar.c, dayT); continue;
          }
          if (pos.dir === "short" && ea.donHi15[di] !== null && bar.c > ea.donHi15[di]!) {
            closeRemaining(key, bar.c, dayT); continue;
          }
        }
      }

      if (pos.engine === "B") {
        // Supertrend: check at each 4h bar
        // (we process all 6 4h bars for this day)
        let closed = false;
        for (let h4Offset = 0; h4Offset < DAY && !closed; h4Offset += H4) {
          const h4T = dayT + h4Offset;
          if (!positions.has(key)) { closed = true; break; }

          const h4i = pd.h4Map.get(h4T);
          if (h4i === undefined) continue;
          const bar = pd.h4[h4i];

          // Update peak price
          if (pos.dir === "long" && bar.h > pos.peakPrice) pos.peakPrice = bar.h;
          if (pos.dir === "short" && bar.l < pos.peakPrice) pos.peakPrice = bar.l;

          // Stop-loss
          if (pos.dir === "long" && bar.l <= pos.sl) {
            closeRemaining(key, pos.sl, h4T, SL_SLIPPAGE); closed = true; continue;
          } else if (pos.dir === "short" && bar.h >= pos.sl) {
            closeRemaining(key, pos.sl, h4T, SL_SLIPPAGE); closed = true; continue;
          }

          // Max hold
          if (h4T - pos.et >= MAX_HOLD) {
            closeRemaining(key, bar.c, h4T); closed = true; continue;
          }

          // Check partial close milestones
          checkMilestones(pos, bar.h, bar.l, bar.c, h4T);
          if (!positions.has(key)) { closed = true; continue; }

          // Trailing stop
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

          // Supertrend signal flip exit
          const sm = engB.get(pos.pair);
          if (sm) {
            const stNow = sm.st[h4i];
            if (stNow !== null) {
              if (pos.dir === "long" && stNow === -1) {
                closeRemaining(key, bar.c, h4T); closed = true; continue;
              }
              if (pos.dir === "short" && stNow === 1) {
                closeRemaining(key, bar.c, h4T); closed = true; continue;
              }
            }
          }
        }
      }
    }

    // ─── ENGINE A: Daily Donchian Trend SMA(20/50) ──────────────────
    for (const p of available) {
      const key = `A:${p}`;
      if (positions.has(key)) continue;

      const pd = pairDataMap.get(p)!;
      const ea = engA.get(p)!;
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

      const sp_ = sp(p);
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * SL_ATR_MULT;
      if (slDist / ep > SL_CAP) slDist = ep * SL_CAP;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      const peakInit = dir === "long" ? bar.h : bar.l;

      positions.set(key, {
        pair: p, engine: "A", dir, ep, et: dayT, sl,
        origMargin: DON_MARGIN, atr: atrVal,
        bestPnlAtr: 0, closedFraction: 0,
        milestonesHit: new Array(strategy.milestones.length).fill(false),
        peakPrice: peakInit,
      });
    }

    // ─── ENGINE B: 4h Supertrend ────────────────────────────────────
    for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
      const h4T = dayT + h4Offset;
      for (const p of available) {
        const key = `B:${p}`;
        if (positions.has(key)) continue;

        const pd = pairDataMap.get(p)!;
        const eb = engB.get(p)!;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined || h4i < 21) continue;

        const stNow = eb.st[h4i - 1];
        const stPrev = eb.st[h4i - 2];
        if (stNow === null || stPrev === null || stNow === stPrev) continue;

        const dir: Dir = stNow === 1 ? "long" : "short";

        // Volume filter
        const h4Bar = pd.h4[h4i - 1];
        let volSum = 0;
        for (let j = h4i - 21; j < h4i - 1; j++) {
          if (j >= 0) volSum += pd.h4[j].v;
        }
        const avgVol = volSum / 20;
        if (avgVol <= 0 || h4Bar.v < 1.5 * avgVol) continue;

        // BTC filters
        const btcRet = btc30dRet(h4T);
        if (btcRet < -0.10 && dir === "long") continue;
        if (btcRet > 0.15 && dir === "short") continue;
        if (dir === "long" && !btcBullish(h4T)) continue;

        const atrVal = eb.atr14[h4i - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p);
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
        let slDist = atrVal * SL_ATR_MULT;
        if (slDist / ep > SL_CAP) slDist = ep * SL_CAP;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        const peakInit = dir === "long" ? pd.h4[h4i].h : pd.h4[h4i].l;

        positions.set(key, {
          pair: p, engine: "B", dir, ep, et: h4T, sl,
          origMargin: ST_MARGIN, atr: atrVal,
          bestPnlAtr: 0, closedFraction: 0,
          milestonesHit: new Array(strategy.milestones.length).fill(false),
          peakPrice: peakInit,
        });
      }
    }
  }

  // Close remaining positions at last available bar
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairDataMap.get(pos.pair);
    if (!pd) continue;
    if (pos.engine === "A") {
      if (pd.daily.length === 0) continue;
      const lastBar = pd.daily[pd.daily.length - 1];
      closeRemaining(key, lastBar.c, lastBar.t);
    } else {
      if (pd.h4.length === 0) continue;
      const lastBar = pd.h4[pd.h4.length - 1];
      closeRemaining(key, lastBar.c, lastBar.t);
    }
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  trades: number;
  totalPnl: number;
  perDay: number;
  pf: number;
  wr: number;
  maxDd: number;
  avgGiveback: number;     // average giveback % on the running portion
  lockedPnl: number;       // P&L from partial closes only
  runnerPnl: number;       // P&L from final exits only
  partialCloses: number;   // number of partial close events
}

function computeStats(trades: Trade[]): Stats {
  if (trades.length === 0) return {
    trades: 0, totalPnl: 0, perDay: 0, pf: 0, wr: 0,
    maxDd: 0, avgGiveback: 0, lockedPnl: 0, runnerPnl: 0, partialCloses: 0,
  };

  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // Group trades by position (pair+engine+entryTime) to compute win rate per position
  const posKey = (t: Trade) => `${t.engine}:${t.pair}:${t.et}`;
  const posGroups = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = posKey(t);
    if (!posGroups.has(k)) posGroups.set(k, []);
    posGroups.get(k)!.push(t);
  }
  const posCount = posGroups.size;
  let posWins = 0;
  for (const [, group] of posGroups) {
    const posPnl = group.reduce((s, t) => s + t.pnl, 0);
    if (posPnl > 0) posWins++;
  }
  const wr = posCount > 0 ? posWins / posCount : 0;

  const days = (FULL_END - FULL_START) / DAY;
  const perDay = totalPnl / days;

  // MaxDD on equity curve
  let equity = 0, peak = 0, maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  // Giveback analysis: for non-partial (final) trades, compute how much
  // was given back from peak to exit
  const partials = trades.filter(t => t.isPartial);
  const finals = trades.filter(t => !t.isPartial);
  let givebackSum = 0;
  let givebackCount = 0;
  for (const t of finals) {
    if (t.peakPrice <= 0) continue;
    let peakPnlPct: number;
    let exitPnlPct: number;
    if (t.dir === "long") {
      peakPnlPct = (t.peakPrice - t.ep) / t.ep;
      exitPnlPct = (t.xp - t.ep) / t.ep;
    } else {
      peakPnlPct = (t.ep - t.peakPrice) / t.ep;
      exitPnlPct = (t.ep - t.xp) / t.ep;
    }
    if (peakPnlPct > 0.001) { // only count trades that went into profit
      const giveback = 1 - exitPnlPct / peakPnlPct;
      givebackSum += Math.max(0, Math.min(1, giveback)); // clamp 0-1
      givebackCount++;
    }
  }
  const avgGiveback = givebackCount > 0 ? givebackSum / givebackCount : 0;

  const lockedPnl = partials.reduce((s, t) => s + t.pnl, 0);
  const runnerPnl = finals.reduce((s, t) => s + t.pnl, 0);

  return {
    trades: posCount,
    totalPnl: Math.round(totalPnl * 100) / 100,
    perDay: Math.round(perDay * 100) / 100,
    pf: Math.round(pf * 100) / 100,
    wr: Math.round(wr * 1000) / 10,
    maxDd: Math.round(maxDd * 100) / 100,
    avgGiveback: Math.round(avgGiveback * 1000) / 10,
    lockedPnl: Math.round(lockedPnl * 100) / 100,
    runnerPnl: Math.round(runnerPnl * 100) / 100,
    partialCloses: partials.length,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("=== Partial Close Research ===\n");
  console.log("Loading data...");

  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }
  const btc = prepBTC(btcRaw);

  const pairDataMap = new Map<string, PairData>();
  const available: string[] = [];
  for (const p of WANTED_PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 500) continue;
    available.push(p);
    pairDataMap.set(p, prepPair(m5));
  }
  console.log(`Loaded ${available.length} pairs: ${available.join(", ")}\n`);

  // Pre-compute indicators (shared across all strategy variants)
  const engA = new Map<string, {
    sma20: (number | null)[]; sma50: (number | null)[];
    donLo15: (number | null)[]; donHi15: (number | null)[];
    atr14: (number | null)[];
  }>();
  const engB = new Map<string, {
    st: (1 | -1 | null)[]; atr14: (number | null)[];
  }>();

  for (const p of available) {
    const pd = pairDataMap.get(p)!;

    // Engine A: Donchian SMA(20/50)
    const dc = pd.daily.map(b => b.c);
    engA.set(p, {
      sma20: smaFn(dc, 20),
      sma50: smaFn(dc, 50),
      donLo15: donchianLow(dc, 15),
      donHi15: donchianHigh(dc, 15),
      atr14: atrSma(pd.daily, 14),
    });

    // Engine B: Supertrend(14, 1.75)
    engB.set(p, {
      st: supertrend(pd.h4, 14, 1.75).trend,
      atr14: atrSma(pd.h4, 14),
    });
  }

  // Run each strategy
  const results: { label: string; stats: Stats }[] = [];

  for (const strat of STRATEGIES) {
    console.log(`Running: ${strat.label}...`);
    const trades = runBacktest(strat, btc, pairDataMap, available, engA, engB);
    const stats = computeStats(trades);
    results.push({ label: strat.label, stats });
  }

  // ─── Print Results ─────────────────────────────────────────────────
  console.log("\n\n=== PARTIAL CLOSE COMPARISON ===");
  console.log(`Engines: Donchian SMA(20/50) $${DON_MARGIN} + Supertrend(14,1.75) $${ST_MARGIN} | ${LEV}x lev | ATR(14) SMA stops`);
  console.log(`Period: ${new Date(FULL_START).toISOString().slice(0,10)} to ${new Date(FULL_END).toISOString().slice(0,10)} | ${available.length} pairs\n`);

  const hdr = `${"Strategy".padEnd(28)} ${p("Trades",6)} ${p("PF",6)} ${p("WR",7)} ${p("$/day",9)} ${p("MaxDD",9)} ${p("Total",11)} ${p("Locked",10)} ${p("Runner",10)} ${p("GvBk%",7)} ${p("Parts",6)}`;
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  for (const r of results) {
    const s = r.stats;
    console.log(
      `${r.label.padEnd(28)} ` +
      `${p(String(s.trades), 6)} ` +
      `${p(String(s.pf), 6)} ` +
      `${p(s.wr.toFixed(1) + "%", 7)} ` +
      `${p(fmtPnl(s.perDay), 9)} ` +
      `${p("$" + s.maxDd.toFixed(0), 9)} ` +
      `${p(fmtPnl(s.totalPnl), 11)} ` +
      `${p(fmtPnl(s.lockedPnl), 10)} ` +
      `${p(fmtPnl(s.runnerPnl), 10)} ` +
      `${p(s.avgGiveback.toFixed(1) + "%", 7)} ` +
      `${p(String(s.partialCloses), 6)}`
    );
  }

  // ─── Delta analysis vs baseline ────────────────────────────────────
  const baseline = results[0].stats;
  console.log("\n\n=== DELTA vs BASELINE ===\n");
  console.log(`${"Strategy".padEnd(28)} ${p("dPnl",10)} ${p("d$/day",9)} ${p("dMaxDD",9)} ${p("dGvBk",8)} ${p("dPF",7)}`);
  console.log("-".repeat(75));

  for (let i = 1; i < results.length; i++) {
    const s = results[i].stats;
    const dPnl = s.totalPnl - baseline.totalPnl;
    const dDay = s.perDay - baseline.perDay;
    const dDD = s.maxDd - baseline.maxDd;
    const dGv = s.avgGiveback - baseline.avgGiveback;
    const dPF = s.pf - baseline.pf;
    console.log(
      `${results[i].label.padEnd(28)} ` +
      `${p(fmtPnl(dPnl), 10)} ` +
      `${p(fmtPnl(dDay), 9)} ` +
      `${p((dDD >= 0 ? "+" : "") + "$" + dDD.toFixed(0), 9)} ` +
      `${p((dGv >= 0 ? "+" : "") + dGv.toFixed(1) + "pp", 8)} ` +
      `${p((dPF >= 0 ? "+" : "") + dPF.toFixed(2), 7)}`
    );
  }

  // ─── Per-engine breakdown ──────────────────────────────────────────
  console.log("\n\n=== PER-ENGINE BREAKDOWN ===\n");
  for (const r of results) {
    // Re-run is wasteful, just filter trades - but we need the trades themselves
    // So let's re-run once more for the baseline and best alternative
    // Actually, let's just re-run all and save trades
  }

  // Re-run to get trade-level data for engine breakdown
  for (const strat of STRATEGIES) {
    const trades = runBacktest(strat, btc, pairDataMap, available, engA, engB);
    const donTrades = trades.filter(t => t.engine === "A");
    const stTrades = trades.filter(t => t.engine === "B");
    const donStats = computeStats(donTrades);
    const stStats = computeStats(stTrades);
    console.log(`${strat.label}`);
    console.log(`  Donchian:   PnL=${fmtPnl(donStats.totalPnl).padStart(8)}  $/d=${fmtPnl(donStats.perDay).padStart(7)}  DD=$${donStats.maxDd.toFixed(0).padStart(4)}  GvBk=${donStats.avgGiveback.toFixed(1)}%  PF=${donStats.pf}`);
    console.log(`  Supertrend: PnL=${fmtPnl(stStats.totalPnl).padStart(8)}  $/d=${fmtPnl(stStats.perDay).padStart(7)}  DD=$${stStats.maxDd.toFixed(0).padStart(4)}  GvBk=${stStats.avgGiveback.toFixed(1)}%  PF=${stStats.pf}`);
    console.log();
  }

  console.log("\nDone.");
}

function p(s: string, n: number): string { return s.padStart(n); }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "") + "$" + v.toFixed(2); }

main();
