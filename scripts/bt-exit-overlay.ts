/**
 * EXIT OVERLAY RESEARCH
 * Test whether faster-timeframe exit signals reduce giveback while preserving P&L.
 *
 * Engines A (Donchian daily) and B (Supertrend 4h) keep their original entry logic.
 * We overlay 6 different exit strategies on top of the engine's native exits:
 *
 *   0. Baseline: engine exits only (SL + signal + max hold)
 *   1. 1h EMA(9) x EMA(21) death/golden cross against position
 *   2. 1h RSI(14) collapse: drops below 30 from above 70 (long), or above 70 from below 30 (short)
 *   3. 4h Donchian(5) tighter channel break
 *   4. 1h Supertrend(10, 1.5) flip against position
 *   5. 2x ATR(14) drawdown from highest close since entry
 *
 * Data: 5m cache aggregated to 1h/4h/daily. 14 pairs. Full period 2023-01 to 2026-03.
 * Fixes: SMA-based ATR, proper spreads, no look-ahead.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-exit-overlay.ts
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ──

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Signal {
  pair: string; dir: "long" | "short"; engine: string;
  entryTime: number; entryPrice: number; sl: number;
  nativeExitTime: number; nativeExitPrice: number; nativeReason: string;
}
interface TradeResult {
  pnl: number; exitTime: number; reason: string;
  peakPct: number; givebackPct: number;
  priceAfter5h: number; // price 5h after exit -- did price keep falling?
  earlyExit: boolean;   // exited before native exit
  correct: boolean;     // price kept falling (or rising for shorts) after early exit
}

// ── Constants ──

const CD_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const NOTIONAL = 50; // $5 margin x 10 lev

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, WIF: 5.05e-4, DASH: 7.15e-4,
};

const PAIRS = ["OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI"];

// ── Data loading ──

function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] } : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
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
    result.push({ t: ts, o: grp[0].o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1].c });
  }
  return result.sort((a, b) => a.t - b.t);
}

// ── Indicators (SMA-based ATR to match live) ──

function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
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
    if (!init) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j]; ema[i] = s / period; init = true; }
    else { ema[i] = values[i] * k + ema[i - 1] * (1 - k); }
  }
  return ema;
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

function calcRSI(closes: number[], period: number): number[] {
  const rsi = new Array(closes.length).fill(50); // neutral default
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function donchCloseLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c);
  return mn;
}

function donchCloseHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c);
  return mx;
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
    ub[i] = u; lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i - 1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return { dir: dirs };
}

// ── Price helpers ──

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

// ── Data loading ──

console.log("Loading 5m data and aggregating...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
const m5Data = new Map<string, C[]>(); // keep 5m for precise exit

for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
  m5Data.set(p, bars);
}

// ── BTC filter ──

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

console.log(`Loaded ${raw5m.size} pairs. BTC daily: ${btcDaily.length} bars.\n`);

// ── Pre-compute overlay indicators per pair ──

interface PairOverlay {
  // 1h data + indicators
  h1: C[];
  h1TsMap: Map<number, number>;
  h1Ema9: number[];
  h1Ema21: number[];
  h1Rsi: number[];
  h1StDir: number[]; // Supertrend(10, 1.5) on 1h
  h1Atr: number[];
  // 4h data + indicators
  h4: C[];
  h4TsMap: Map<number, number>;
  // 5m data for precise exit sim
  m5: C[];
  m5TsMap: Map<number, number>;
}

console.log("Pre-computing overlay indicators...");
const overlays = new Map<string, PairOverlay>();

for (const pair of PAIRS) {
  const h1 = h1Data.get(pair);
  const h4 = h4Data.get(pair);
  const m5 = m5Data.get(pair);
  if (!h1 || !h4 || !m5) continue;

  const h1Closes = h1.map(c => c.c);
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  const m5TsMap = new Map<number, number>();
  m5.forEach((c, i) => m5TsMap.set(c.t, i));

  overlays.set(pair, {
    h1, h1TsMap,
    h1Ema9: calcEMA(h1Closes, 9),
    h1Ema21: calcEMA(h1Closes, 21),
    h1Rsi: calcRSI(h1Closes, 14),
    h1StDir: calcSupertrend(h1, 10, 1.5).dir,
    h1Atr: calcATR(h1, 14),
    h4, h4TsMap,
    m5, m5TsMap,
  });
}
console.log(`Overlay indicators computed for ${overlays.size} pairs.\n`);

// ── Engine A: Donchian (daily SMA 20/50 crossover) ──

function genDonchian(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < 65) continue;
    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, 20);
    const slow = calcSMA(closes, 50);
    const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && i >= 16) {
          if (pos.dir === "long") { const lo = donchCloseLow(cs, i, 15); if (bar.c < lo) { xp = bar.c; reason = "ch"; } }
          else { const hi = donchCloseHigh(cs, i, 15); if (bar.c > hi) { xp = bar.c; reason = "ch"; } }
        }
        if (!xp && Math.round((bar.t - pos.et) / D) >= 60) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({ pair, dir: pos.dir, engine: "A", entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, nativeExitTime: bar.t, nativeExitPrice: xp, nativeReason: reason });
          pos = null;
        }
      }
      if (!pos) {
        const p = i - 1; const pp = i - 2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long" | "short" | null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long";
        else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i - 1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965); else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ── Engine B: Supertrend 4h ──

function genSupertrend(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < 50) continue;
    const { dir: stDir } = calcSupertrend(cs, 14, 1.75);
    const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 17; i < cs.length; i++) {
      const bar = cs[i];
      const flip = stDir[i - 1] !== stDir[i - 2];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && flip) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t - pos.et) / H >= 60 * 24) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({ pair, dir: pos.dir, engine: "B", entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, nativeExitTime: bar.t, nativeExitPrice: xp, nativeReason: reason });
          pos = null;
        }
      }
      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long" | "short" = stDir[i - 1] === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i - 1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965); else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ── Overlay exit strategies ──

type OverlayId = 0 | 1 | 2 | 3 | 4 | 5;

const OVERLAY_NAMES: Record<OverlayId, string> = {
  0: "Baseline (native exits only)",
  1: "1h EMA(9) x EMA(21) cross",
  2: "1h RSI(14) collapse (70->30 / 30->70)",
  3: "4h Donchian(5) channel break",
  4: "1h Supertrend(10, 1.5) flip",
  5: "2x ATR(14) drop from peak close",
};

function simWithOverlay(sig: Signal, overlayId: OverlayId): TradeResult {
  const ov = overlays.get(sig.pair);
  if (!ov) {
    // No overlay data; just use native exit
    const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);
    const xp = exitPx(sig.pair, sig.dir, sig.nativeExitPrice, sig.nativeReason === "sl");
    return { pnl: calcPnl(sig.dir, ep, xp, NOTIONAL), exitTime: sig.nativeExitTime, reason: sig.nativeReason, peakPct: 0, givebackPct: 0, priceAfter5h: sig.nativeExitPrice, earlyExit: false, correct: false };
  }

  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

  // Walk 5m bars from entry to native exit, checking SL + overlay
  const m5 = ov.m5;

  // Binary search for start index
  let lo = 0, hi = m5.length - 1, startIdx = m5.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (m5[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; }
    else { lo = mid + 1; }
  }

  let peakClose = sig.entryPrice; // track highest/lowest close since entry
  let peakPnlPct = 0;
  let overlayFired = false;
  let overlayExitTime = 0;
  let overlayExitPrice = 0;

  // For RSI overlay: track whether RSI was recently above 70 (long) or below 30 (short)
  let rsiWasExtreme = false;

  // Walk 5m bars
  for (let i = startIdx; i < m5.length; i++) {
    const b = m5[i];
    if (b.t > sig.nativeExitTime) break;

    // SL always checked first (on every 5m bar)
    if (sig.dir === "long" && b.l <= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      const pnl = calcPnl(sig.dir, ep, xp, NOTIONAL);
      // SL fires regardless of overlay
      const afterPx = findPriceAfter(ov, b.t, 5 * H);
      return { pnl, exitTime: b.t, reason: "sl", peakPct: peakPnlPct, givebackPct: peakPnlPct > 0 ? peakPnlPct - ((sig.sl / sig.entryPrice - 1) * LEV * 100) : 0, priceAfter5h: afterPx, earlyExit: false, correct: false };
    }
    if (sig.dir === "short" && b.h >= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      const pnl = calcPnl(sig.dir, ep, xp, NOTIONAL);
      const afterPx = findPriceAfter(ov, b.t, 5 * H);
      return { pnl, exitTime: b.t, reason: "sl", peakPct: peakPnlPct, givebackPct: peakPnlPct > 0 ? peakPnlPct - ((1 - sig.sl / sig.entryPrice) * LEV * 100) : 0, priceAfter5h: afterPx, earlyExit: false, correct: false };
    }

    // Track peak close
    if (sig.dir === "long" && b.c > peakClose) peakClose = b.c;
    if (sig.dir === "short" && b.c < peakClose) peakClose = b.c;

    // Track peak P&L %
    const currBestPct = sig.dir === "long"
      ? (b.h / sig.entryPrice - 1) * LEV * 100
      : (sig.entryPrice / b.l - 1) * LEV * 100;
    if (currBestPct > peakPnlPct) peakPnlPct = currBestPct;

    // Only check overlays at 1h boundaries (for 1h overlays) or 4h boundaries
    if (overlayId === 0) continue; // baseline -- no overlay

    // OVERLAY 1: 1h EMA(9) x EMA(21) cross against position
    if (overlayId === 1) {
      const h1Bucket = Math.floor(b.t / H) * H;
      const h1Idx = ov.h1TsMap.get(h1Bucket);
      if (h1Idx !== undefined && h1Idx >= 2) {
        // Use completed bar: check idx-1 vs idx-2
        const prev = h1Idx - 1;
        const pprev = h1Idx - 2;
        const off9 = ov.h1.length - ov.h1Ema9.length;
        const off21 = ov.h1.length - ov.h1Ema21.length;
        const i9 = prev - off9; const i21 = prev - off21;
        const i9p = pprev - off9; const i21p = pprev - off21;
        if (i9 >= 0 && i21 >= 0 && i9p >= 0 && i21p >= 0) {
          if (sig.dir === "long") {
            // Death cross: EMA9 was above EMA21, now below
            if (ov.h1Ema9[i9p] > ov.h1Ema21[i21p] && ov.h1Ema9[i9] <= ov.h1Ema21[i21]) {
              overlayFired = true; overlayExitTime = b.t; overlayExitPrice = b.o;
              break;
            }
          } else {
            // Golden cross: EMA9 was below EMA21, now above
            if (ov.h1Ema9[i9p] < ov.h1Ema21[i21p] && ov.h1Ema9[i9] >= ov.h1Ema21[i21]) {
              overlayFired = true; overlayExitTime = b.t; overlayExitPrice = b.o;
              break;
            }
          }
        }
      }
    }

    // OVERLAY 2: RSI collapse
    if (overlayId === 2) {
      const h1Bucket = Math.floor(b.t / H) * H;
      const h1Idx = ov.h1TsMap.get(h1Bucket);
      if (h1Idx !== undefined && h1Idx >= 2) {
        const prev = h1Idx - 1;
        const rsiVal = ov.h1Rsi[prev];
        if (sig.dir === "long") {
          if (rsiVal > 70) rsiWasExtreme = true;
          if (rsiWasExtreme && rsiVal < 30) {
            overlayFired = true; overlayExitTime = b.t; overlayExitPrice = b.o;
            break;
          }
        } else {
          if (rsiVal < 30) rsiWasExtreme = true;
          if (rsiWasExtreme && rsiVal > 70) {
            overlayFired = true; overlayExitTime = b.t; overlayExitPrice = b.o;
            break;
          }
        }
      }
    }

    // OVERLAY 3: 4h Donchian(5) channel break
    if (overlayId === 3) {
      const h4Bucket = Math.floor(b.t / H4) * H4;
      const h4Idx = ov.h4TsMap.get(h4Bucket);
      if (h4Idx !== undefined && h4Idx >= 6) {
        const prev = h4Idx - 1; // completed bar
        if (sig.dir === "long") {
          const lo5 = donchCloseLow(ov.h4, prev + 1, 5); // use closes of prev 5 bars
          if (ov.h4[prev].c < lo5) {
            overlayFired = true; overlayExitTime = b.t; overlayExitPrice = b.o;
            break;
          }
        } else {
          const hi5 = donchCloseHigh(ov.h4, prev + 1, 5);
          if (ov.h4[prev].c > hi5) {
            overlayFired = true; overlayExitTime = b.t; overlayExitPrice = b.o;
            break;
          }
        }
      }
    }

    // OVERLAY 4: 1h Supertrend(10, 1.5) flip against position
    if (overlayId === 4) {
      const h1Bucket = Math.floor(b.t / H) * H;
      const h1Idx = ov.h1TsMap.get(h1Bucket);
      if (h1Idx !== undefined && h1Idx >= 12) {
        const prev = h1Idx - 1;
        const pprev = h1Idx - 2;
        if (prev >= 0 && pprev >= 0 && prev < ov.h1StDir.length && pprev < ov.h1StDir.length) {
          const stFlip = ov.h1StDir[prev] !== ov.h1StDir[pprev];
          if (stFlip) {
            // Flip against: supertrend went bearish for long, bullish for short
            if (sig.dir === "long" && ov.h1StDir[prev] === -1) {
              overlayFired = true; overlayExitTime = b.t; overlayExitPrice = b.o;
              break;
            }
            if (sig.dir === "short" && ov.h1StDir[prev] === 1) {
              overlayFired = true; overlayExitTime = b.t; overlayExitPrice = b.o;
              break;
            }
          }
        }
      }
    }

    // OVERLAY 5: 2x ATR(14) drawdown from peak close
    if (overlayId === 5) {
      const h1Bucket = Math.floor(b.t / H) * H;
      const h1Idx = ov.h1TsMap.get(h1Bucket);
      if (h1Idx !== undefined && h1Idx >= 15) {
        const prev = h1Idx - 1;
        const atrVal = ov.h1Atr[prev];
        if (atrVal > 0) {
          if (sig.dir === "long" && peakClose > sig.entryPrice) {
            if (b.c < peakClose - 2 * atrVal) {
              overlayFired = true; overlayExitTime = b.t; overlayExitPrice = b.c;
              break;
            }
          }
          if (sig.dir === "short" && peakClose < sig.entryPrice) {
            if (b.c > peakClose + 2 * atrVal) {
              overlayFired = true; overlayExitTime = b.t; overlayExitPrice = b.c;
              break;
            }
          }
        }
      }
    }
  }

  // Calculate results
  if (overlayFired) {
    const xp = exitPx(sig.pair, sig.dir, overlayExitPrice, false);
    const pnl = calcPnl(sig.dir, ep, xp, NOTIONAL);
    const exitPnlPct = sig.dir === "long"
      ? (overlayExitPrice / sig.entryPrice - 1) * LEV * 100
      : (sig.entryPrice / overlayExitPrice - 1) * LEV * 100;
    const gb = peakPnlPct > 0 ? Math.max(0, peakPnlPct - exitPnlPct) : 0;

    // Check correctness: was price 5h later worse for the position?
    const afterPx = findPriceAfter(ov, overlayExitTime, 5 * H);
    let correct = false;
    if (sig.dir === "long") correct = afterPx < overlayExitPrice;
    else correct = afterPx > overlayExitPrice;

    return { pnl, exitTime: overlayExitTime, reason: "overlay", peakPct: peakPnlPct, givebackPct: gb, priceAfter5h: afterPx, earlyExit: true, correct };
  }

  // Native exit (baseline or overlay didn't fire)
  const xp = exitPx(sig.pair, sig.dir, sig.nativeExitPrice, sig.nativeReason === "sl");
  const pnl = calcPnl(sig.dir, ep, xp, NOTIONAL);
  const exitPnlPct = sig.dir === "long"
    ? (sig.nativeExitPrice / sig.entryPrice - 1) * LEV * 100
    : (sig.entryPrice / sig.nativeExitPrice - 1) * LEV * 100;
  const gb = peakPnlPct > 0 ? Math.max(0, peakPnlPct - exitPnlPct) : 0;
  const afterPx = findPriceAfter(ov, sig.nativeExitTime, 5 * H);
  return { pnl, exitTime: sig.nativeExitTime, reason: sig.nativeReason, peakPct: peakPnlPct, givebackPct: gb, priceAfter5h: afterPx, earlyExit: false, correct: false };
}

function findPriceAfter(ov: PairOverlay, t: number, deltaMs: number): number {
  const target = t + deltaMs;
  // Binary search in 5m bars
  let lo = 0, hi = ov.m5.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ov.m5[mid].t >= target) { idx = mid; hi = mid - 1; }
    else { lo = mid + 1; }
  }
  if (idx >= 0 && idx < ov.m5.length) return ov.m5[idx].c;
  return ov.m5[ov.m5.length - 1].c; // fallback to last bar
}

// ── Generate signals ──

console.log("Generating engine signals...");
const donchSigs = genDonchian();
const stSigs = genSupertrend();
const allSigs = [...donchSigs, ...stSigs];
console.log(`  A (Donchian): ${donchSigs.length} trades`);
console.log(`  B (Supertrend): ${stSigs.length} trades`);
console.log(`  Total: ${allSigs.length} trades\n`);

// ── Run each overlay ──

interface OverlayResult {
  id: OverlayId;
  name: string;
  totalPnl: number;
  perDay: number;
  avgGiveback: number;
  earlyExits: number;
  correctExits: number;
  wrongExits: number;
  trades: number;
  winRate: number;
  maxDD: number;
  profitFactor: number;
  avgPeakPct: number;
  // Per-engine breakdown
  engineA: { pnl: number; earlyExits: number; correct: number; wrong: number; avgGb: number };
  engineB: { pnl: number; earlyExits: number; correct: number; wrong: number; avgGb: number };
}

const days = (FULL_END - FULL_START) / D;
const overlayResults: OverlayResult[] = [];

for (const overlayId of [0, 1, 2, 3, 4, 5] as OverlayId[]) {
  console.log(`Running overlay ${overlayId}: ${OVERLAY_NAMES[overlayId]}...`);

  const results: TradeResult[] = [];
  const engines: string[] = [];
  for (const sig of allSigs) {
    const r = simWithOverlay(sig, overlayId);
    results.push(r);
    engines.push(sig.engine);
  }

  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const wins = results.filter(r => r.pnl > 0).length;
  const gp = results.filter(r => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
  const gl = Math.abs(results.filter(r => r.pnl <= 0).reduce((s, r) => s + r.pnl, 0));

  let cum = 0, peak = 0, maxDD = 0;
  const sortedByExit = results.map((r, i) => ({ ...r, engine: engines[i] })).sort((a, b) => a.exitTime - b.exitTime);
  for (const t of sortedByExit) {
    cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const earlyExits = results.filter(r => r.earlyExit).length;
  const correctExits = results.filter(r => r.earlyExit && r.correct).length;
  const wrongExits = results.filter(r => r.earlyExit && !r.correct).length;

  const avgGiveback = results.length > 0 ? results.reduce((s, r) => s + r.givebackPct, 0) / results.length : 0;
  const avgPeakPct = results.length > 0 ? results.reduce((s, r) => s + r.peakPct, 0) / results.length : 0;

  // Engine breakdown
  const engA = results.filter((_, i) => engines[i] === "A");
  const engB = results.filter((_, i) => engines[i] === "B");
  const engAGb = engA.length > 0 ? engA.reduce((s, r) => s + r.givebackPct, 0) / engA.length : 0;
  const engBGb = engB.length > 0 ? engB.reduce((s, r) => s + r.givebackPct, 0) / engB.length : 0;

  overlayResults.push({
    id: overlayId,
    name: OVERLAY_NAMES[overlayId],
    totalPnl, perDay: totalPnl / days, avgGiveback,
    earlyExits, correctExits, wrongExits,
    trades: results.length, winRate: results.length > 0 ? wins / results.length * 100 : 0,
    maxDD, profitFactor: gl > 0 ? gp / gl : 99,
    avgPeakPct,
    engineA: {
      pnl: engA.reduce((s, r) => s + r.pnl, 0),
      earlyExits: engA.filter(r => r.earlyExit).length,
      correct: engA.filter(r => r.earlyExit && r.correct).length,
      wrong: engA.filter(r => r.earlyExit && !r.correct).length,
      avgGb: engAGb,
    },
    engineB: {
      pnl: engB.reduce((s, r) => s + r.pnl, 0),
      earlyExits: engB.filter(r => r.earlyExit).length,
      correct: engB.filter(r => r.earlyExit && r.correct).length,
      wrong: engB.filter(r => r.earlyExit && !r.correct).length,
      avgGb: engBGb,
    },
  });

  console.log(`  P&L: $${totalPnl.toFixed(2)} | $/day: $${(totalPnl / days).toFixed(2)} | Giveback: ${avgGiveback.toFixed(1)}% | Early: ${earlyExits} (${correctExits} correct, ${wrongExits} wrong)\n`);
}

// ── Final report ──

console.log("\n" + "=".repeat(150));
console.log("EXIT OVERLAY RESEARCH -- Donchian + Supertrend | 15 pairs | 2023-01 to 2026-03 | $5 margin, 10x lev");
console.log("=".repeat(150));

console.log(`\n${"#".padStart(2)} ${"Overlay".padEnd(42)} ${"PnL".padStart(10)} ${"$/day".padStart(8)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"MaxDD".padStart(8)} ${"AvgGb%".padStart(8)} ${"AvgPk%".padStart(8)} ${"Early".padStart(6)} ${"Correct".padStart(8)} ${"Wrong".padStart(6)} ${"Accuracy".padStart(9)}`);
console.log("-".repeat(150));

const baseline = overlayResults.find(r => r.id === 0)!;

for (const r of overlayResults) {
  const acc = r.earlyExits > 0 ? (r.correctExits / r.earlyExits * 100).toFixed(1) + "%" : "N/A";
  const pnlDelta = r.id === 0 ? "" : ` (${r.totalPnl >= baseline.totalPnl ? "+" : ""}$${(r.totalPnl - baseline.totalPnl).toFixed(0)})`;
  console.log(
    `${String(r.id).padStart(2)} ${r.name.padEnd(42)} ${("$" + r.totalPnl.toFixed(0)).padStart(10)}${pnlDelta.padStart(0)} ${("$" + r.perDay.toFixed(2)).padStart(8)} ${r.winRate.toFixed(1).padStart(5)}% ${r.profitFactor.toFixed(2).padStart(6)} ${("$" + r.maxDD.toFixed(0)).padStart(8)} ${r.avgGiveback.toFixed(1).padStart(7)}% ${r.avgPeakPct.toFixed(1).padStart(7)}% ${String(r.earlyExits).padStart(6)} ${String(r.correctExits).padStart(8)} ${String(r.wrongExits).padStart(6)} ${acc.padStart(9)}`
  );
}

console.log("\n" + "-".repeat(150));
console.log("\nEngine A (Donchian) breakdown:");
console.log(`${"#".padStart(2)} ${"Overlay".padEnd(42)} ${"PnL".padStart(10)} ${"AvgGb%".padStart(8)} ${"Early".padStart(6)} ${"Correct".padStart(8)} ${"Wrong".padStart(6)}`);
for (const r of overlayResults) {
  const a = r.engineA;
  console.log(`${String(r.id).padStart(2)} ${r.name.padEnd(42)} ${("$" + a.pnl.toFixed(0)).padStart(10)} ${a.avgGb.toFixed(1).padStart(7)}% ${String(a.earlyExits).padStart(6)} ${String(a.correct).padStart(8)} ${String(a.wrong).padStart(6)}`);
}

console.log("\nEngine B (Supertrend) breakdown:");
console.log(`${"#".padStart(2)} ${"Overlay".padEnd(42)} ${"PnL".padStart(10)} ${"AvgGb%".padStart(8)} ${"Early".padStart(6)} ${"Correct".padStart(8)} ${"Wrong".padStart(6)}`);
for (const r of overlayResults) {
  const b = r.engineB;
  console.log(`${String(r.id).padStart(2)} ${r.name.padEnd(42)} ${("$" + b.pnl.toFixed(0)).padStart(10)} ${b.avgGb.toFixed(1).padStart(7)}% ${String(b.earlyExits).padStart(6)} ${String(b.correct).padStart(8)} ${String(b.wrong).padStart(6)}`);
}

// ── Giveback comparison ──

console.log("\n" + "=".repeat(150));
console.log("GIVEBACK ANALYSIS");
console.log("=".repeat(150));
console.log(`\nBaseline avg giveback: ${baseline.avgGiveback.toFixed(1)}% of leveraged P&L`);
console.log(`Baseline avg peak:    ${baseline.avgPeakPct.toFixed(1)}% (peak unrealized P&L before exit)\n`);

for (const r of overlayResults) {
  if (r.id === 0) continue;
  const gbDelta = r.avgGiveback - baseline.avgGiveback;
  const pnlDelta = r.totalPnl - baseline.totalPnl;
  const gbDir = gbDelta < 0 ? "LESS" : "MORE";
  console.log(`  ${r.name}:`);
  console.log(`    Giveback: ${r.avgGiveback.toFixed(1)}% (${gbDelta >= 0 ? "+" : ""}${gbDelta.toFixed(1)}% ${gbDir} giveback vs baseline)`);
  console.log(`    P&L:      $${r.totalPnl.toFixed(0)} (${pnlDelta >= 0 ? "+" : ""}$${pnlDelta.toFixed(0)} vs baseline)`);
  if (r.earlyExits > 0) {
    console.log(`    Accuracy: ${r.correctExits}/${r.earlyExits} early exits correct (${(r.correctExits / r.earlyExits * 100).toFixed(1)}%)`);
  }
  console.log();
}

// ── Net assessment ──

console.log("=".repeat(150));
console.log("NET ASSESSMENT");
console.log("=".repeat(150));

const best = overlayResults.reduce((best, r) => r.id !== 0 && r.totalPnl > best.totalPnl ? r : best, overlayResults[0]);
const leastGb = overlayResults.reduce((best, r) => r.id !== 0 && r.avgGiveback < best.avgGiveback ? r : best, overlayResults[0]);

console.log(`\n  Best P&L overlay:      #${best.id} ${best.name} -- $${best.perDay.toFixed(2)}/day (baseline $${baseline.perDay.toFixed(2)}/day)`);
console.log(`  Lowest giveback:       #${leastGb.id} ${leastGb.name} -- ${leastGb.avgGiveback.toFixed(1)}% (baseline ${baseline.avgGiveback.toFixed(1)}%)`);

const improved = overlayResults.filter(r => r.id !== 0 && r.totalPnl > baseline.totalPnl && r.avgGiveback < baseline.avgGiveback);
if (improved.length > 0) {
  console.log(`\n  Overlays that IMPROVE BOTH P&L and giveback:`);
  for (const r of improved) {
    console.log(`    #${r.id} ${r.name}: +$${(r.totalPnl - baseline.totalPnl).toFixed(0)} P&L, ${(r.avgGiveback - baseline.avgGiveback).toFixed(1)}% giveback`);
  }
} else {
  console.log(`\n  NO overlay improves BOTH P&L and giveback simultaneously.`);
  const tradeoffs = overlayResults.filter(r => r.id !== 0 && (r.totalPnl > baseline.totalPnl || r.avgGiveback < baseline.avgGiveback));
  if (tradeoffs.length > 0) {
    console.log(`  Tradeoff overlays (improve one metric):`);
    for (const r of tradeoffs) {
      const pnlDelta = r.totalPnl - baseline.totalPnl;
      const gbDelta = r.avgGiveback - baseline.avgGiveback;
      console.log(`    #${r.id}: P&L ${pnlDelta >= 0 ? "+" : ""}$${pnlDelta.toFixed(0)}, giveback ${gbDelta >= 0 ? "+" : ""}${gbDelta.toFixed(1)}%`);
    }
  }
}

console.log("\nDone.");
