/**
 * Supertrend Exit Optimization
 *
 * Entry: ST(14, 1.75) flip on 4h (unchanged)
 * Exit variations:
 *   - Baseline: ST(14, 1.75) flip on 4h (same as entry)
 *   - Tighter 4h: (10,1.5), (10,1.0), (7,1.5), (7,1.0), (14,1.0), (14,1.25)
 *   - 1h timeframe: ST(14,1.75), ST(10,1.5), ST(7,1.0) on 1h bars
 *
 * Measures: avg peak at exit, avg giveback%, total P&L, $/day
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && \
 *      NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-st-exit-optimize.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }

// ─── Constants ──────────────────────────────────────────────────────
const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const SIZE = 5;
const NOT = SIZE * LEV; // $50 notional

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-28").getTime();
const DAYS = (FULL_END - FULL_START) / D;

const PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE", "APT",
  "LINK", "ADA", "WLD", "XRP", "UNI", "SOL",
];

// Half-spreads from costs.ts
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  SOL: 2.0e-4, BTC: 0.5e-4,
};

// ─── Data Loading ───────────────────────────────────────────────────
function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) {
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
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// ─── Indicators (SMA ATR to match live) ─────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c),
    );
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += trs[j];
    atr[i] = s / period;
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

function calcSupertrend(cs: C[], p: number, m: number): { dir: number[] } {
  const atr = calcATR(cs, p);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  for (let i = p; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let u = hl2 + m * atr[i];
    let l = hl2 - m * atr[i];
    if (i > p) {
      if (!(l > lb[i - 1] || cs[i - 1].c < lb[i - 1])) l = lb[i - 1];
      if (!(u < ub[i - 1] || cs[i - 1].c > ub[i - 1])) u = ub[i - 1];
    }
    ub[i] = u;
    lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i - 1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return { dir: dirs };
}

// ─── Cost helpers ───────────────────────────────────────────────────
function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function entryPx(pair: string, dir: "long" | "short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function exitPx(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long" | "short", ep: number, xp: number, not: number): number {
  return (dir === "long" ? (xp / ep - 1) * not : (ep / xp - 1) * not) - not * FEE * 2;
}

// ─── Load data ──────────────────────────────────────────────────────
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) raw1m.set(p, d);
}

// Aggregate to needed timeframes
const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// BTC daily filter: EMA(20) > EMA(50)
const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);

function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t < t) { idx = i; break; }
  }
  if (idx < 0) return false;
  const i20 = idx - (btcDaily.length - btcEma20.length);
  const i50 = idx - (btcDaily.length - btcEma50.length);
  return i20 >= 0 && i50 >= 0 && btcEma20[i20] > btcEma50[i50];
}

console.log(`Loaded ${raw5m.size} pairs (5m), ${raw1m.size} pairs (1m)\n`);

// ─── Exit config definitions ────────────────────────────────────────
interface ExitConfig {
  label: string;
  tf: "4h" | "1h";        // exit timeframe
  stPeriod: number;        // exit Supertrend period
  stMult: number;          // exit Supertrend multiplier
}

const EXIT_CONFIGS: ExitConfig[] = [
  // Baseline (same as entry)
  { label: "4h ST(14,1.75)", tf: "4h", stPeriod: 14, stMult: 1.75 },
  // Tighter 4h exits
  { label: "4h ST(14,1.25)", tf: "4h", stPeriod: 14, stMult: 1.25 },
  { label: "4h ST(14,1.0)",  tf: "4h", stPeriod: 14, stMult: 1.0 },
  { label: "4h ST(10,1.5)",  tf: "4h", stPeriod: 10, stMult: 1.5 },
  { label: "4h ST(10,1.0)",  tf: "4h", stPeriod: 10, stMult: 1.0 },
  { label: "4h ST(7,1.5)",   tf: "4h", stPeriod: 7,  stMult: 1.5 },
  { label: "4h ST(7,1.0)",   tf: "4h", stPeriod: 7,  stMult: 1.0 },
  // 1h timeframe exits
  { label: "1h ST(14,1.75)", tf: "1h", stPeriod: 14, stMult: 1.75 },
  { label: "1h ST(10,1.5)",  tf: "1h", stPeriod: 10, stMult: 1.5 },
  { label: "1h ST(7,1.0)",   tf: "1h", stPeriod: 7,  stMult: 1.0 },
];

// ─── Precompute Supertrend arrays for each config ───────────────────
// Key: "pair:tf:period:mult" -> dir[]
const stCache = new Map<string, { dir: number[]; bars: C[] }>();

function getSTDirs(pair: string, tf: "4h" | "1h", period: number, mult: number): { dir: number[]; bars: C[] } | null {
  const key = `${pair}:${tf}:${period}:${mult}`;
  if (stCache.has(key)) return stCache.get(key)!;
  const bars = tf === "4h" ? h4Data.get(pair) : h1Data.get(pair);
  if (!bars || bars.length < period + 5) return null;
  const { dir } = calcSupertrend(bars, period, mult);
  const result = { dir, bars };
  stCache.set(key, result);
  return result;
}

// ─── Trade struct ───────────────────────────────────────────────────
interface Trade {
  pair: string;
  dir: "long" | "short";
  entryTime: number;
  entryRaw: number;   // raw price (bar open) for peak tracking
  entryFill: number;  // after spread
  exitFill: number;
  exitTime: number;
  exitReason: string;
  sl: number;
  pnl: number;
  peakPct: number;    // peak unrealized % (on notional)
  exitPct: number;    // exit unrealized % (on notional)
  givebackPct: number; // peakPct - exitPct (if peak>0)
}

// ─── Run one exit config across all pairs ───────────────────────────
function runConfig(cfg: ExitConfig): Trade[] {
  const trades: Trade[] = [];

  for (const pair of PAIRS) {
    // Entry always on 4h ST(14, 1.75) flip
    const entryH4 = h4Data.get(pair);
    if (!entryH4 || entryH4.length < 20) continue;
    const { dir: entryStDir } = calcSupertrend(entryH4, 14, 1.75);
    const entryATR = calcATR(entryH4, 14);

    // Exit supertrend
    const exitST = getSTDirs(pair, cfg.tf, cfg.stPeriod, cfg.stMult);
    if (!exitST) continue;
    const exitSTDir = exitST.dir;
    const exitSTBars = exitST.bars;

    // Build timestamp->index map for exit bars
    const exitTsMap = new Map<number, number>();
    exitSTBars.forEach((b, i) => exitTsMap.set(b.t, i));

    // 1m bars for precise tracking
    const bars1m = raw1m.get(pair) ?? [];

    let inPos = false;
    let posDir: "long" | "short" = "long";
    let posEntryRaw = 0;
    let posEntryFill = 0;
    let posSL = 0;
    let posEntryTime = 0;
    let posATR = 0;

    // Iterate 4h bars for ENTRY signals
    for (let i = 17; i < entryH4.length; i++) {
      const bar = entryH4[i];
      if (bar.t < FULL_START || bar.t >= FULL_END) continue;

      const flip = entryStDir[i - 1] !== entryStDir[i - 2];

      if (!inPos && flip) {
        const dir: "long" | "short" = entryStDir[i - 1] === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = entryATR[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPx(pair, dir, bar.o);
        let slDist = 3 * prevATR;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        inPos = true;
        posDir = dir;
        posEntryRaw = bar.o;
        posEntryFill = ep;
        posSL = sl;
        posEntryTime = bar.t;
        posATR = prevATR;
      }

      if (!inPos) continue;

      // --- Check exits using 1m bars for this 4h period ---
      // We scan 1m bars from entry to find: SL hit, exit ST flip, max hold, peak

      // Once in a position, we scan 1m bar by bar until exit
      // This is done once per trade below (after the loop or via a separate pass)
    }

    // Now do a second pass: simulate each trade using 1m precision
    // Re-generate entries, then walk 1m bars for exit
    inPos = false;
    let tradeEntryI = -1;

    for (let i = 17; i < entryH4.length; i++) {
      const bar = entryH4[i];
      if (bar.t < FULL_START || bar.t >= FULL_END) continue;

      const flip = entryStDir[i - 1] !== entryStDir[i - 2];

      if (!inPos && flip) {
        const dir: "long" | "short" = entryStDir[i - 1] === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = entryATR[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPx(pair, dir, bar.o);
        let slDist = 3 * prevATR;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        inPos = true;
        posDir = dir;
        posEntryRaw = bar.o;
        posEntryFill = ep;
        posSL = sl;
        posEntryTime = bar.t;
        posATR = prevATR;

        // Walk 1m bars from entry to find exit
        const maxHoldMs = 60 * D;
        const maxExitTime = posEntryTime + maxHoldMs;

        // Binary search for 1m start
        let lo = 0, hi = bars1m.length - 1, startIdx = bars1m.length;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (bars1m[mid].t >= posEntryTime) { startIdx = mid; hi = mid - 1; }
          else { lo = mid + 1; }
        }

        let peakPricePct = 0; // best unrealized % on raw price (not leveraged)
        let exited = false;

        // Track what exit ST direction was at entry time
        // For the exit ST, we need to know the direction at each bar
        // We'll look up the exit ST direction by finding the exit-tf bar that contains each 1m bar

        const exitTfMs = cfg.tf === "4h" ? H4 : H;

        for (let mi = startIdx; mi < bars1m.length; mi++) {
          const b = bars1m[mi];
          if (b.t > maxExitTime) {
            // Max hold exit
            const xp = exitPx(pair, posDir, b.c, false);
            const pnl = calcPnl(posDir, posEntryFill, xp, NOT);
            const exitPct = posDir === "long"
              ? (b.c / posEntryRaw - 1) * 100
              : (posEntryRaw / b.c - 1) * 100;
            trades.push({
              pair, dir: posDir, entryTime: posEntryTime, entryRaw: posEntryRaw,
              entryFill: posEntryFill, exitFill: xp, exitTime: b.t, exitReason: "mh",
              sl: posSL, pnl, peakPct: peakPricePct, exitPct,
              givebackPct: peakPricePct > 0 ? ((peakPricePct - exitPct) / peakPricePct) * 100 : 0,
            });
            exited = true;
            inPos = false;
            break;
          }

          // SL check
          if (posDir === "long" && b.l <= posSL) {
            const xp = exitPx(pair, posDir, posSL, true);
            const pnl = calcPnl(posDir, posEntryFill, xp, NOT);
            const exitPct = posDir === "long"
              ? (posSL / posEntryRaw - 1) * 100
              : (posEntryRaw / posSL - 1) * 100;
            trades.push({
              pair, dir: posDir, entryTime: posEntryTime, entryRaw: posEntryRaw,
              entryFill: posEntryFill, exitFill: xp, exitTime: b.t, exitReason: "sl",
              sl: posSL, pnl, peakPct: peakPricePct, exitPct,
              givebackPct: peakPricePct > 0 ? ((peakPricePct - exitPct) / peakPricePct) * 100 : 0,
            });
            exited = true;
            inPos = false;
            break;
          }
          if (posDir === "short" && b.h >= posSL) {
            const xp = exitPx(pair, posDir, posSL, true);
            const pnl = calcPnl(posDir, posEntryFill, xp, NOT);
            const exitPct = posDir === "short"
              ? (posEntryRaw / posSL - 1) * 100
              : (posSL / posEntryRaw - 1) * 100;
            trades.push({
              pair, dir: posDir, entryTime: posEntryTime, entryRaw: posEntryRaw,
              entryFill: posEntryFill, exitFill: xp, exitTime: b.t, exitReason: "sl",
              sl: posSL, pnl, peakPct: peakPricePct, exitPct,
              givebackPct: peakPricePct > 0 ? ((peakPricePct - exitPct) / peakPricePct) * 100 : 0,
            });
            exited = true;
            inPos = false;
            break;
          }

          // Peak tracking (raw price, unleveraged %)
          const currPct = posDir === "long"
            ? (b.h / posEntryRaw - 1) * 100
            : (posEntryRaw / b.l - 1) * 100;
          if (currPct > peakPricePct) peakPricePct = currPct;

          // Exit ST flip check: look up exit-tf bar for this 1m bar
          const exitBucket = Math.floor(b.t / exitTfMs) * exitTfMs;
          const exitIdx = exitTsMap.get(exitBucket);
          if (exitIdx !== undefined && exitIdx >= 2) {
            // Check if the COMPLETED exit-tf bar just flipped
            // A flip means exitSTDir[exitIdx-1] !== exitSTDir[exitIdx-2]
            // But we should only act on it once, at the open of the new bar
            // So check if 1m bar is at the START of a new exit-tf bar and prev bar flipped
            const prevBucket = exitBucket - exitTfMs;
            const prevExitIdx = exitTsMap.get(prevBucket);
            if (prevExitIdx !== undefined && prevExitIdx >= 1) {
              // We're at the boundary of a new exit-tf bar
              // Check if b.t is within the first minute of this exit-tf bar
              if (b.t >= exitBucket && b.t < exitBucket + 60_000) {
                const nowDir = exitSTDir[prevExitIdx];
                const prevDir = exitIdx >= 3 ? exitSTDir[prevExitIdx - 1] : nowDir;
                if (nowDir !== prevDir) {
                  // Exit ST flipped against our position?
                  // For long: exit when ST flips bearish (dir becomes -1)
                  // For short: exit when ST flips bullish (dir becomes 1)
                  const shouldExit =
                    (posDir === "long" && nowDir === -1) ||
                    (posDir === "short" && nowDir === 1);
                  if (shouldExit) {
                    const rawExit = exitSTBars[exitIdx]?.o ?? b.c;
                    const xp = exitPx(pair, posDir, rawExit, false);
                    const pnl = calcPnl(posDir, posEntryFill, xp, NOT);
                    const exitPctVal = posDir === "long"
                      ? (rawExit / posEntryRaw - 1) * 100
                      : (posEntryRaw / rawExit - 1) * 100;
                    trades.push({
                      pair, dir: posDir, entryTime: posEntryTime, entryRaw: posEntryRaw,
                      entryFill: posEntryFill, exitFill: xp, exitTime: b.t, exitReason: "flip",
                      sl: posSL, pnl, peakPct: peakPricePct, exitPct: exitPctVal,
                      givebackPct: peakPricePct > 0 ? ((peakPricePct - exitPctVal) / peakPricePct) * 100 : 0,
                    });
                    exited = true;
                    inPos = false;
                    break;
                  }
                }
              }
            }
          }
        }

        if (!exited) {
          // No exit found in 1m data - use last available bar
          if (bars1m.length > 0) {
            const lastBar = bars1m[bars1m.length - 1];
            const xp = exitPx(pair, posDir, lastBar.c, false);
            const pnl = calcPnl(posDir, posEntryFill, xp, NOT);
            const exitPctVal = posDir === "long"
              ? (lastBar.c / posEntryRaw - 1) * 100
              : (posEntryRaw / lastBar.c - 1) * 100;
            trades.push({
              pair, dir: posDir, entryTime: posEntryTime, entryRaw: posEntryRaw,
              entryFill: posEntryFill, exitFill: xp, exitTime: lastBar.t, exitReason: "eod",
              sl: posSL, pnl, peakPct: peakPricePct, exitPct: exitPctVal,
              givebackPct: peakPricePct > 0 ? ((peakPricePct - exitPctVal) / peakPricePct) * 100 : 0,
            });
          }
          inPos = false;
        }
      }
    }
  }

  return trades;
}

// The 1m-based approach above has a subtle bug with flip detection at boundaries.
// Let me use a cleaner approach: walk 4h/1h bars for flip detection, then use 1m bars
// only for SL and peak tracking within each bar.

function runConfigV2(cfg: ExitConfig): Trade[] {
  const trades: Trade[] = [];

  for (const pair of PAIRS) {
    const entryH4 = h4Data.get(pair);
    if (!entryH4 || entryH4.length < 20) continue;

    const entryST = calcSupertrend(entryH4, 14, 1.75);
    const entryATR = calcATR(entryH4, 14);

    // Exit ST on its timeframe
    const exitST = getSTDirs(pair, cfg.tf, cfg.stPeriod, cfg.stMult);
    if (!exitST) continue;
    const exitDir = exitST.dir;
    const exitBars = exitST.bars;

    // 1m bars
    const bars1m = raw1m.get(pair) ?? [];

    // Build binary-searchable 1m timestamps
    function find1mStart(t: number): number {
      let lo = 0, hi = bars1m.length - 1, res = bars1m.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (bars1m[mid].t >= t) { res = mid; hi = mid - 1; }
        else { lo = mid + 1; }
      }
      return res;
    }

    // Scan 1m bars in a range, return peak % and check SL
    function scan1mRange(
      dir: "long" | "short", entryRaw: number, sl: number,
      fromT: number, toT: number, prevPeak: number
    ): { peakPct: number; slHit: boolean; slTime: number } {
      let peak = prevPeak;
      const si = find1mStart(fromT);
      for (let mi = si; mi < bars1m.length; mi++) {
        const b = bars1m[mi];
        if (b.t >= toT) break;
        // SL
        if (dir === "long" && b.l <= sl) return { peakPct: peak, slHit: true, slTime: b.t };
        if (dir === "short" && b.h >= sl) return { peakPct: peak, slHit: true, slTime: b.t };
        // Peak
        const pct = dir === "long"
          ? (b.h / entryRaw - 1) * 100
          : (entryRaw / b.l - 1) * 100;
        if (pct > peak) peak = pct;
      }
      return { peakPct: peak, slHit: false, slTime: 0 };
    }

    // Walk through entry signals
    let inPos = false;
    let posDir: "long" | "short" = "long";
    let posEntryRaw = 0;
    let posEntryFill = 0;
    let posSL = 0;
    let posEntryTime = 0;
    let peakPct = 0;

    // For exit: walk exit-tf bars, check for flip
    // We need to track the "expected direction" for exit: if we're long, exit ST should be bullish
    // When it flips bearish, we exit. If we're short, when it flips bullish, we exit.

    for (let i = 17; i < entryH4.length; i++) {
      const bar = entryH4[i];
      if (bar.t < FULL_START) continue;
      if (bar.t >= FULL_END) break;

      // Check entry (only when not in position)
      if (!inPos) {
        const flip = entryST.dir[i - 1] !== entryST.dir[i - 2];
        if (!flip) continue;

        const dir: "long" | "short" = entryST.dir[i - 1] === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = entryATR[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPx(pair, dir, bar.o);
        let slDist = 3 * prevATR;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        inPos = true;
        posDir = dir;
        posEntryRaw = bar.o;
        posEntryFill = ep;
        posSL = sl;
        posEntryTime = bar.t;
        peakPct = 0;
      }

      if (!inPos) continue;

      // Position management: scan exit-tf bars that fall within this 4h bar
      const exitTfMs = cfg.tf === "4h" ? H4 : H;
      const nextH4Time = bar.t + H4;
      const maxHoldTime = posEntryTime + 60 * D;

      // Max hold
      if (bar.t >= maxHoldTime) {
        const rawExit = bar.o;
        const xp = exitPx(pair, posDir, rawExit, false);
        const pnl = calcPnl(posDir, posEntryFill, xp, NOT);
        const exitPctVal = posDir === "long"
          ? (rawExit / posEntryRaw - 1) * 100
          : (posEntryRaw / rawExit - 1) * 100;
        trades.push({
          pair, dir: posDir, entryTime: posEntryTime, entryRaw: posEntryRaw,
          entryFill: posEntryFill, exitFill: xp, exitTime: bar.t, exitReason: "mh",
          sl: posSL, pnl, peakPct, exitPct: exitPctVal,
          givebackPct: peakPct > 0 ? ((peakPct - exitPctVal) / peakPct) * 100 : 0,
        });
        inPos = false;
        // Need to recheck this bar for a new entry
        i--;
        continue;
      }

      // Scan 1m bars in this 4h period for SL + peak tracking
      const scanResult = scan1mRange(posDir, posEntryRaw, posSL, bar.t, nextH4Time, peakPct);
      peakPct = scanResult.peakPct;

      if (scanResult.slHit) {
        const xp = exitPx(pair, posDir, posSL, true);
        const pnl = calcPnl(posDir, posEntryFill, xp, NOT);
        const exitPctVal = posDir === "long"
          ? (posSL / posEntryRaw - 1) * 100
          : (posEntryRaw / posSL - 1) * 100;
        trades.push({
          pair, dir: posDir, entryTime: posEntryTime, entryRaw: posEntryRaw,
          entryFill: posEntryFill, exitFill: xp, exitTime: scanResult.slTime, exitReason: "sl",
          sl: posSL, pnl, peakPct, exitPct: exitPctVal,
          givebackPct: peakPct > 0 ? ((peakPct - exitPctVal) / peakPct) * 100 : 0,
        });
        inPos = false;
        continue;
      }

      // Check exit-tf ST flip for bars completed by now
      // For each exit-tf bar that completes within this 4h bar, check for flip
      for (let ej = 0; ej < exitBars.length; ej++) {
        const eb = exitBars[ej];
        if (eb.t < bar.t) continue;
        if (eb.t >= nextH4Time) break;
        if (eb.t <= posEntryTime) continue; // skip entry bar

        if (ej < 2) continue;
        const nowD = exitDir[ej - 1];
        const prevD = exitDir[ej - 2];
        if (nowD === prevD) continue;

        // Flip happened at end of bar ej-1, so exit at open of bar ej
        const shouldExit =
          (posDir === "long" && nowD === -1) ||
          (posDir === "short" && nowD === 1);
        if (!shouldExit) continue;

        // Scan 1m up to flip bar for peak
        const scanToFlip = scan1mRange(posDir, posEntryRaw, posSL, bar.t, eb.t, peakPct);
        peakPct = scanToFlip.peakPct;

        if (scanToFlip.slHit) {
          const xp = exitPx(pair, posDir, posSL, true);
          const pnl = calcPnl(posDir, posEntryFill, xp, NOT);
          const exitPctV = posDir === "long"
            ? (posSL / posEntryRaw - 1) * 100
            : (posEntryRaw / posSL - 1) * 100;
          trades.push({
            pair, dir: posDir, entryTime: posEntryTime, entryRaw: posEntryRaw,
            entryFill: posEntryFill, exitFill: xp, exitTime: scanToFlip.slTime, exitReason: "sl",
            sl: posSL, pnl, peakPct, exitPct: exitPctV,
            givebackPct: peakPct > 0 ? ((peakPct - exitPctV) / peakPct) * 100 : 0,
          });
          inPos = false;
          break;
        }

        // Exit at this bar open
        const rawExit = eb.o;
        const xp = exitPx(pair, posDir, rawExit, false);
        const pnl = calcPnl(posDir, posEntryFill, xp, NOT);
        const exitPctVal = posDir === "long"
          ? (rawExit / posEntryRaw - 1) * 100
          : (posEntryRaw / rawExit - 1) * 100;
        trades.push({
          pair, dir: posDir, entryTime: posEntryTime, entryRaw: posEntryRaw,
          entryFill: posEntryFill, exitFill: xp, exitTime: eb.t, exitReason: "flip",
          sl: posSL, pnl, peakPct, exitPct: exitPctVal,
          givebackPct: peakPct > 0 ? ((peakPct - exitPctVal) / peakPct) * 100 : 0,
        });
        inPos = false;
        break;
      }
    }

    // If still in position at end, close at last bar
    if (inPos) {
      const lastBar = entryH4[entryH4.length - 1];
      const xp = exitPx(pair, posDir, lastBar.c, false);
      const pnl = calcPnl(posDir, posEntryFill, xp, NOT);
      const exitPctVal = posDir === "long"
        ? (lastBar.c / posEntryRaw - 1) * 100
        : (posEntryRaw / lastBar.c - 1) * 100;
      trades.push({
        pair, dir: posDir, entryTime: posEntryTime, entryRaw: posEntryRaw,
        entryFill: posEntryFill, exitFill: xp, exitTime: lastBar.t, exitReason: "eod",
        sl: posSL, pnl, peakPct, exitPct: exitPctVal,
        givebackPct: peakPct > 0 ? ((peakPct - exitPctVal) / peakPct) * 100 : 0,
      });
    }
  }

  return trades;
}

// ─── Results ────────────────────────────────────────────────────────
interface Result {
  label: string;
  trades: number;
  wins: number;
  wr: number;
  totalPnl: number;
  perDay: number;
  pf: number;
  maxDD: number;
  avgPeakPct: number;
  avgExitPct: number;
  avgCapturePct: number;    // % of peak kept at exit (higher = better)
  medianCapturePct: number;
  avgGivebackAbs: number;   // absolute peak - exit (lower = better)
  flipExits: number;
  slExits: number;
  mhExits: number;
  avgHoldDays: number;
  flipWR: number;
}

function analyze(label: string, trades: Trade[]): Result {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Max drawdown
  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Peak / exit stats for FLIP exits only (what we're optimizing)
  const flips = trades.filter(t => t.exitReason === "flip");
  const flipsWithPeak = flips.filter(t => t.peakPct > 0.5);
  const avgPeak = flipsWithPeak.length > 0
    ? flipsWithPeak.reduce((s, t) => s + t.peakPct, 0) / flipsWithPeak.length : 0;
  const avgExit = flipsWithPeak.length > 0
    ? flipsWithPeak.reduce((s, t) => s + t.exitPct, 0) / flipsWithPeak.length : 0;
  // Capture ratio for flips: exitPct/peakPct (how much of peak was kept)
  const captureRatios = flipsWithPeak.map(t => (t.exitPct / t.peakPct) * 100);
  const avgCapture = captureRatios.length > 0
    ? captureRatios.reduce((s, v) => s + v, 0) / captureRatios.length : 0;
  const sortedCaptures = [...captureRatios].sort((a, b) => a - b);
  const medianCapture = sortedCaptures.length > 0
    ? sortedCaptures[Math.floor(sortedCaptures.length / 2)] : 0;
  // Giveback: peak - exit for flips (absolute %, how much returned to market)
  const avgGivebackAbs = flipsWithPeak.length > 0
    ? flipsWithPeak.reduce((s, t) => s + (t.peakPct - t.exitPct), 0) / flipsWithPeak.length : 0;
  // Winning flips: what % of flip exits are profitable
  const flipWR = flips.length > 0 ? (flips.filter(t => t.pnl > 0).length / flips.length) * 100 : 0;

  const flipExits = trades.filter(t => t.exitReason === "flip").length;
  const slExits = trades.filter(t => t.exitReason === "sl").length;
  const mhExits = trades.filter(t => t.exitReason === "mh").length;
  const avgHoldDays = trades.length > 0
    ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / trades.length / D : 0;

  return {
    label,
    trades: trades.length,
    wins: wins.length,
    wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    totalPnl,
    perDay: totalPnl / DAYS,
    pf: gl > 0 ? gp / gl : 99,
    maxDD,
    avgPeakPct: avgPeak,
    avgExitPct: avgExit,
    avgCapturePct: avgCapture,
    medianCapturePct: medianCapture,
    avgGivebackAbs: avgGivebackAbs,
    flipWR,
    flipExits,
    slExits,
    mhExits,
    avgHoldDays,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("Running Supertrend exit optimization...\n");
console.log(`Entry: ST(14, 1.75) on 4h | 14 pairs | $${SIZE} margin, ${LEV}x lev`);
console.log(`Period: 2023-01-01 to 2026-03-28 (${DAYS.toFixed(0)} days)`);
console.log(`ATR: SMA (matching live) | SL: ATR*3 capped 3.5% | Max hold: 60d\n`);

const results: Result[] = [];

for (const cfg of EXIT_CONFIGS) {
  process.stdout.write(`  ${cfg.label}...`);
  const trades = runConfigV2(cfg);
  const r = analyze(cfg.label, trades);
  results.push(r);
  console.log(` ${r.trades} trades, $${r.perDay.toFixed(2)}/day, capture ${r.avgCapturePct.toFixed(0)}%`);
}

// ─── Display ────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(160));
console.log("SUPERTREND EXIT OPTIMIZATION - Entry: ST(14, 1.75) 4h flip | Exit: variable");
console.log("=".repeat(160));

// Column legend for "flip exit" metrics:
//   FlipPk = avg peak unrealized % for trades that exit via flip (the move we're trying to capture)
//   FlipEx = avg exit % for those same trades
//   Capt   = FlipEx / FlipPk (% of peak kept at flip exit, higher = better timing)
//   GB     = FlipPk - FlipEx (absolute % given back, lower = better)
//   FWR    = win rate among flip exits specifically

console.log(`\n${"Exit Config".padEnd(18)} ${"Trds".padStart(5)} ${"WR%".padStart(6)} ${"Total$".padStart(10)} ${"$/day".padStart(8)} ${"PF".padStart(6)} ${"DD$".padStart(7)} | ${"FlipPk".padStart(7)} ${"FlipEx".padStart(7)} ${"Capt".padStart(6)} ${"GB".padStart(6)} ${"FWR".padStart(6)} | ${"Flips".padStart(5)} ${"SLs".padStart(5)} ${"Hold".padStart(5)}`);
console.log("-".repeat(140));

// Sort by $/day descending
const sorted = [...results].sort((a, b) => b.perDay - a.perDay);

for (const r of sorted) {
  const isBaseline = r.label === "4h ST(14,1.75)";
  const mark = isBaseline ? " <<" : "";
  console.log(
    `${r.label.padEnd(18)} ${String(r.trades).padStart(5)} ${r.wr.toFixed(1).padStart(5)}% ${("$" + r.totalPnl.toFixed(0)).padStart(10)} ${("$" + r.perDay.toFixed(2)).padStart(8)} ${r.pf.toFixed(2).padStart(6)} ${("$" + r.maxDD.toFixed(0)).padStart(7)} | ${(r.avgPeakPct.toFixed(1) + "%").padStart(7)} ${(r.avgExitPct.toFixed(1) + "%").padStart(7)} ${(r.avgCapturePct.toFixed(0) + "%").padStart(6)} ${(r.avgGivebackAbs.toFixed(1) + "%").padStart(6)} ${(r.flipWR.toFixed(0) + "%").padStart(6)} | ${String(r.flipExits).padStart(5)} ${String(r.slExits).padStart(5)} ${(r.avgHoldDays.toFixed(1) + "d").padStart(5)}${mark}`
  );
}

// ─── Comparison vs baseline ─────────────────────────────────────────
const baseline = results.find(r => r.label === "4h ST(14,1.75)")!;
console.log("\n" + "=".repeat(100));
console.log("COMPARISON vs BASELINE [4h ST(14,1.75)]");
console.log("=".repeat(100));
console.log(`\nBaseline: ${baseline.trades} trades, $${baseline.perDay.toFixed(2)}/day, PF ${baseline.pf.toFixed(2)}`);
console.log(`  Flip exits: peak ${baseline.avgPeakPct.toFixed(1)}%, exit ${baseline.avgExitPct.toFixed(1)}%, capture ${baseline.avgCapturePct.toFixed(0)}%, giveback ${baseline.avgGivebackAbs.toFixed(1)}%\n`);

console.log(`${"Exit Config".padEnd(18)} ${"d$/day".padStart(8)} ${"dCapt".padStart(7)} ${"dGB".padStart(7)} ${"dWR".padStart(6)} ${"dPF".padStart(7)} ${"dDD$".padStart(7)} ${"dHold".padStart(7)}`);
console.log("-".repeat(80));

for (const r of sorted) {
  if (r.label === baseline.label) continue;
  const dPnl = r.perDay - baseline.perDay;
  const dCapt = r.avgCapturePct - baseline.avgCapturePct;
  const dGB = r.avgGivebackAbs - baseline.avgGivebackAbs;
  const dWR = r.wr - baseline.wr;
  const dPF = r.pf - baseline.pf;
  const dDD = r.maxDD - baseline.maxDD;
  const dHold = r.avgHoldDays - baseline.avgHoldDays;
  const fmt = (v: number, suf: string) => (v >= 0 ? "+" : "") + v.toFixed(suf === "$" ? 2 : suf === "d" ? 1 : 0) + (suf === "%" ? "%" : suf === "d" ? "d" : "");
  console.log(
    `${r.label.padEnd(18)} ${("$" + (dPnl >= 0 ? "+" : "") + dPnl.toFixed(2)).padStart(8)} ${fmt(dCapt, "%").padStart(7)} ${fmt(dGB, "%").padStart(7)} ${fmt(dWR, "%").padStart(6)} ${(dPF >= 0 ? "+" : "") + dPF.toFixed(2).padStart(6)} ${("$" + (dDD >= 0 ? "+" : "") + dDD.toFixed(0)).padStart(7)} ${fmt(dHold, "d").padStart(7)}`
  );
}

// ─── Key takeaway ───────────────────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("CONCLUSION");
console.log("=".repeat(80));
const best = sorted[0];
if (best.label === baseline.label) {
  console.log(`\nThe BASELINE exit [${baseline.label}] is already the best config.`);
  console.log(`Every tighter Supertrend exit REDUCED total P&L.`);
  console.log(`\nThe paradox: tighter exits DO reduce giveback (lower GB%), but they`);
  console.log(`also cut winning trades short before they reach their full potential.`);
  console.log(`The baseline captures only ${baseline.avgCapturePct.toFixed(0)}% of peak, but the`);
  console.log(`trades that DO ride generate enough profit to more than offset losers.`);
  console.log(`\nTighter exits produce more flip signals (${sorted[sorted.length-1].flipExits} vs ${baseline.flipExits}),`);
  console.log(`meaning more whipsaw re-entries, more spread/fee cost, less net P&L.`);
} else {
  console.log(`\nBest config: ${best.label} at $${best.perDay.toFixed(2)}/day`);
  console.log(`vs baseline $${baseline.perDay.toFixed(2)}/day (+$${(best.perDay - baseline.perDay).toFixed(2)}/day)`);
}
console.log("\nDone.");
