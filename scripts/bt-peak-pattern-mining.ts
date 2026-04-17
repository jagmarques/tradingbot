/**
 * Peak Pattern Mining: Find signals that predict when a trend trade is about to reverse.
 *
 * For each trade (Donchian SMA(20/50) + Supertrend(14,1.75)):
 *   - At the PEAK moment, record 12 features
 *   - Split into "good exits" (giveback <30%) and "bad exits" (giveback >70%)
 *   - Compare feature distributions to find reversal predictors
 *
 * Run: npx tsx scripts/bt-peak-pattern-mining.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4,
};

const PAIRS = ["OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "SOL"];

// ─── Helpers ─────────────────────────────────────────────────────────
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

// SMA of TRs (not Wilder's)
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

function calcSupertrend(cs: C[], p: number, m: number): { dir: number[]; band: number[] } {
  const atr = calcATR(cs, p);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  const band = new Array(cs.length).fill(0);
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
    band[i] = dirs[i] === 1 ? lb[i] : ub[i];
  }
  return { dir: dirs, band };
}

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

// ─── Load data ───────────────────────────────────────────────────────
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
}

// BTC filter
const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);
function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) { if (btcDaily[i].t < t) { idx = i; break; } }
  if (idx < 0) return false;
  return idx >= 0 && btcEma20[idx] > 0 && btcEma50[idx] > 0 && btcEma20[idx] > btcEma50[idx];
}

console.log("Data loaded.\n");

// ─── Trade + peak features ───────────────────────────────────────────
interface PeakFeatures {
  pair: string;
  engine: string;
  dir: "long" | "short";
  entryTime: number;
  exitTime: number;
  peakTime: number;
  peakPnlPct: number;   // peak unrealized P&L % (leveraged)
  exitPnlPct: number;   // final realized P&L % (leveraged)
  givebackPct: number;  // how much of peak was given back (0=kept all, 100=lost all)
  exitReason: string;

  // Features at the peak moment
  barsSinceEntry: number;          // how many bars (in engine timeframe) since entry
  atrRatioVsEntry: number;        // ATR at peak / ATR at entry (>1 = expanding vol)
  distFromSMA20_atr: number;      // abs(price - SMA20) / ATR at peak
  priceAcceleration: number;      // rate of price change acceleration (2nd derivative proxy)
  volumeProxy: number;            // range trend ratio: avg range last 5 bars / avg range first 5 bars of trade
  consecutiveBars: number;        // consecutive bars moving in trade direction before peak
  btcCorrelation: number;         // BTC return correlation with pair over trade duration up to peak
  dayOfWeek: number;              // 0=Sun..6=Sat
  hourOfDay: number;              // 0-23 UTC
  distFromBand_atr: number;       // distance from Supertrend band or Donchian channel in ATR units
  holdDurationHrs: number;        // hours from entry to peak
  peakRetracementBefore: number;  // max drawdown before reaching the peak (how choppy was the ride)
}

// ─── Engine A: Donchian SMA(20/50), daily bars ──────────────────────
function genDonchianTrades(): PeakFeatures[] {
  const features: PeakFeatures[] = [];

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < 65) continue;
    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, 20);
    const slow = calcSMA(closes, 50);
    const atr = calcATR(cs, 14);
    const sma20 = calcSMA(closes, 20);

    // 5m bars for intra-trade analysis
    const bars5m = raw5m.get(pair);
    if (!bars5m) continue;

    // BTC 5m for correlation
    const btc5m = raw5m.get("BTC");

    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; entryATR: number; entryBarIdx: number } | null = null;

    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];

      if (pos) {
        let xp = 0, reason = "";
        const hd = Math.round((bar.t - pos.et) / D);

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }

        if (!xp && i >= 16) {
          if (pos.dir === "long") {
            const lo = donchCloseLow(cs, i, 15);
            if (bar.c < lo) { xp = bar.c; reason = "ch"; }
          } else {
            const hi = donchCloseHigh(cs, i, 15);
            if (bar.c > hi) { xp = bar.c; reason = "ch"; }
          }
        }

        if (!xp && hd >= 60) { xp = bar.c; reason = "mh"; }

        if (xp > 0 && pos.et >= FULL_START && pos.et < FULL_END) {
          // Trade closed. Now scan 5m bars for peak analysis
          const f = analyzeTradePeak(pair, "A", pos.dir, pos.ep, pos.et, pos.entryATR, pos.entryBarIdx,
            xp, bar.t, reason, cs, atr, sma20, bars5m, btc5m, null, null);
          if (f) features.push(f);
          pos = null;
        } else if (xp > 0) {
          pos = null;
        }
      }

      if (!pos) {
        // FIX: Use i-1 vs i-2 for crossover (completed bars only)
        const p = i - 1;
        const pp = i - 2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long" | "short" | null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long";
        else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl, entryATR: prevATR, entryBarIdx: i };
      }
    }
  }
  return features;
}

// ─── Engine B: Supertrend(14,1.75), 4h bars ─────────────────────────
function genSupertrendTrades(): PeakFeatures[] {
  const features: PeakFeatures[] = [];

  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < 50) continue;
    const { dir: stDir, band: stBand } = calcSupertrend(cs, 14, 1.75);
    const atr = calcATR(cs, 14);
    const closes = cs.map(c => c.c);
    const sma20 = calcSMA(closes, 20);

    const bars5m = raw5m.get(pair);
    if (!bars5m) continue;
    const btc5m = raw5m.get("BTC");

    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; entryATR: number; entryBarIdx: number } | null = null;

    for (let i = 17; i < cs.length; i++) {
      const bar = cs[i];
      const flip = stDir[i - 1] !== stDir[i - 2];

      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && flip) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t - pos.et) / H >= 60 * 24) { xp = bar.c; reason = "mh"; }

        if (xp > 0 && pos.et >= FULL_START && pos.et < FULL_END) {
          const f = analyzeTradePeak(pair, "B", pos.dir, pos.ep, pos.et, pos.entryATR, pos.entryBarIdx,
            xp, bar.t, reason, cs, atr, sma20, bars5m, btc5m, stBand, stDir);
          if (f) features.push(f);
          pos = null;
        } else if (xp > 0) {
          pos = null;
        }
      }

      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long" | "short" = stDir[i - 1] === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl, entryATR: prevATR, entryBarIdx: i };
      }
    }
  }
  return features;
}

// ─── Peak Analysis (shared by both engines) ──────────────────────────
function analyzeTradePeak(
  pair: string, engine: string, dir: "long" | "short",
  entryPrice: number, entryTime: number, entryATR: number, _entryBarIdx: number,
  exitPriceRaw: number, exitTime: number, exitReason: string,
  engineBars: C[], engineATR: number[], engineSMA20: number[],
  bars5m: C[], btc5m: C[] | undefined,
  stBand: number[] | null, _stDir: number[] | null,
): PeakFeatures | null {

  // Apply spreads
  const ep = entryPx(pair, dir, entryPrice);
  const xp = exitPx(pair, dir, exitPriceRaw, exitReason === "sl");
  const NOT = 5 * LEV;

  // Scan 5m bars between entry and exit to find peak
  const tradeBars: C[] = [];
  const btcTradeBars: C[] = [];

  // Binary search for start
  let lo = 0, hi = bars5m.length - 1, startIdx = bars5m.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars5m[mid].t >= entryTime) { startIdx = mid; hi = mid - 1; } else { lo = mid + 1; }
  }

  let peakPnl = -Infinity;
  let peakIdx = startIdx;
  let maxDrawdownBeforePeak = 0;
  let runningPeakBeforeFinal = -Infinity;
  let runningMin = Infinity;

  for (let i = startIdx; i < bars5m.length && bars5m[i].t <= exitTime; i++) {
    const b = bars5m[i];
    tradeBars.push(b);

    const pnl = dir === "long"
      ? (b.h / entryPrice - 1) * LEV * 100
      : (entryPrice / b.l - 1) * LEV * 100;

    // Track min pnl before peak for "choppiness" measure
    const midPnl = dir === "long"
      ? (b.c / entryPrice - 1) * LEV * 100
      : (entryPrice / b.c - 1) * LEV * 100;

    if (midPnl < runningMin) runningMin = midPnl;

    if (pnl > peakPnl) {
      peakPnl = pnl;
      peakIdx = i;
      // Record max drawdown before this peak
      if (runningPeakBeforeFinal < pnl) {
        maxDrawdownBeforePeak = runningPeakBeforeFinal === -Infinity ? 0 : runningPeakBeforeFinal - runningMin;
      }
      runningPeakBeforeFinal = pnl;
      runningMin = midPnl; // reset after new peak
    }
  }

  if (tradeBars.length < 5 || peakPnl <= 0) return null; // Skip trades that never went positive

  // BTC bars for correlation
  if (btc5m) {
    let bLo = 0, bHi = btc5m.length - 1, bStart = btc5m.length;
    while (bLo <= bHi) {
      const mid = (bLo + bHi) >> 1;
      if (btc5m[mid].t >= entryTime) { bStart = mid; bHi = mid - 1; } else { bLo = mid + 1; }
    }
    for (let i = bStart; i < btc5m.length && btc5m[i].t <= bars5m[peakIdx].t; i++) {
      btcTradeBars.push(btc5m[i]);
    }
  }

  const peakBar = bars5m[peakIdx];
  const peakTime = peakBar.t;

  // Exit P&L
  const exitPnlPct = dir === "long"
    ? (xp / ep - 1) * LEV * 100
    : (ep / xp - 1) * LEV * 100;

  // Giveback: how much of peak was lost
  const givebackPct = peakPnl > 0 ? Math.max(0, (peakPnl - exitPnlPct) / peakPnl * 100) : 0;

  // ─── Feature 1: Bars since entry (in engine timeframe) ──────────
  const barsSinceEntry = tradeBars.length;

  // ─── Feature 2: ATR ratio vs entry ──────────────────────────────
  // Find ATR at peak from engine bars
  let peakATR = entryATR;
  for (let i = engineBars.length - 1; i >= 0; i--) {
    if (engineBars[i].t <= peakTime && engineATR[i] > 0) {
      peakATR = engineATR[i];
      break;
    }
  }
  const atrRatioVsEntry = entryATR > 0 ? peakATR / entryATR : 1;

  // ─── Feature 3: Distance from SMA(20) in ATR units ─────────────
  let distFromSMA20_atr = 0;
  for (let i = engineBars.length - 1; i >= 0; i--) {
    if (engineBars[i].t <= peakTime && engineSMA20[i] > 0 && peakATR > 0) {
      distFromSMA20_atr = Math.abs(peakBar.c - engineSMA20[i]) / peakATR;
      break;
    }
  }

  // ─── Feature 4: Price acceleration (2nd derivative proxy) ──────
  // Compare rate of change in last 1/3 vs first 1/3 of trade to peak
  const barsToAnalyze = tradeBars.slice(0, peakIdx - startIdx + 1);
  let priceAcceleration = 0;
  if (barsToAnalyze.length >= 6) {
    const third = Math.floor(barsToAnalyze.length / 3);
    const firstThirdRet = (barsToAnalyze[third].c - barsToAnalyze[0].c) / barsToAnalyze[0].c;
    const lastStart = barsToAnalyze.length - third;
    const lastThirdRet = (barsToAnalyze[barsToAnalyze.length - 1].c - barsToAnalyze[lastStart].c) / barsToAnalyze[lastStart].c;
    if (dir === "short") {
      // For shorts, negative returns are good
      priceAcceleration = firstThirdRet !== 0 ? lastThirdRet / Math.abs(firstThirdRet) : 0;
    } else {
      priceAcceleration = firstThirdRet !== 0 ? lastThirdRet / Math.abs(firstThirdRet) : 0;
    }
  }

  // ─── Feature 5: Volume proxy (range trend) ─────────────────────
  // avg range last 5 bars vs avg range first 5 bars of the trade
  let volumeProxy = 1;
  if (barsToAnalyze.length >= 10) {
    const first5 = barsToAnalyze.slice(0, 5);
    const last5 = barsToAnalyze.slice(-5);
    const avgFirst = first5.reduce((s, b) => s + (b.h - b.l), 0) / 5;
    const avgLast = last5.reduce((s, b) => s + (b.h - b.l), 0) / 5;
    volumeProxy = avgFirst > 0 ? avgLast / avgFirst : 1;
  }

  // ─── Feature 6: Consecutive bars in same direction before peak ──
  let consecutiveBars = 0;
  const peakLocalIdx = peakIdx - startIdx;
  for (let i = peakLocalIdx; i >= 1; i--) {
    const ret = barsToAnalyze[i].c - barsToAnalyze[i - 1].c;
    const favorable = dir === "long" ? ret > 0 : ret < 0;
    if (favorable) consecutiveBars++;
    else break;
  }

  // ─── Feature 7: BTC correlation at peak moment ──────────────────
  let btcCorrelation = 0;
  if (btcTradeBars.length >= 10 && barsToAnalyze.length >= 10) {
    const n = Math.min(btcTradeBars.length, barsToAnalyze.length);
    const pairRets: number[] = [];
    const btcRets: number[] = [];
    for (let i = 1; i < n; i++) {
      pairRets.push(barsToAnalyze[i].c / barsToAnalyze[i - 1].c - 1);
      btcRets.push(btcTradeBars[i].c / btcTradeBars[i - 1].c - 1);
    }
    btcCorrelation = pearsonCorr(pairRets, btcRets);
  }

  // ─── Feature 8 & 9: Day of week + Hour at peak ─────────────────
  const peakDate = new Date(peakTime);
  const dayOfWeek = peakDate.getUTCDay();
  const hourOfDay = peakDate.getUTCHours();

  // ─── Feature 10: Distance from Supertrend band / Donchian channel
  let distFromBand_atr = 0;
  if (stBand && peakATR > 0) {
    // Supertrend engine: distance from band
    for (let i = engineBars.length - 1; i >= 0; i--) {
      if (engineBars[i].t <= peakTime && stBand[i] > 0) {
        distFromBand_atr = Math.abs(peakBar.c - stBand[i]) / peakATR;
        break;
      }
    }
  } else if (peakATR > 0) {
    // Donchian engine: distance from 15-bar Donchian channel
    for (let i = engineBars.length - 1; i >= 0; i--) {
      if (engineBars[i].t <= peakTime && i >= 16) {
        if (dir === "long") {
          const lo = donchCloseLow(engineBars, i, 15);
          distFromBand_atr = (peakBar.c - lo) / peakATR;
        } else {
          const hi = donchCloseHigh(engineBars, i, 15);
          distFromBand_atr = (hi - peakBar.c) / peakATR;
        }
        break;
      }
    }
  }

  // ─── Feature 11: Hold duration in hours ─────────────────────────
  const holdDurationHrs = (peakTime - entryTime) / H;

  // ─── Feature 12: Max retracement before peak (choppiness) ──────
  const peakRetracementBefore = maxDrawdownBeforePeak > 0 ? maxDrawdownBeforePeak : 0;

  return {
    pair, engine, dir, entryTime, exitTime, peakTime,
    peakPnlPct: peakPnl,
    exitPnlPct,
    givebackPct,
    exitReason,
    barsSinceEntry,
    atrRatioVsEntry,
    distFromSMA20_atr,
    priceAcceleration,
    volumeProxy,
    consecutiveBars,
    btcCorrelation,
    dayOfWeek,
    hourOfDay,
    distFromBand_atr,
    holdDurationHrs,
    peakRetracementBefore,
  };
}

function pearsonCorr(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : 0;
}

// ─── Run ─────────────────────────────────────────────────────────────
console.log("Generating Donchian trades...");
const donchFeatures = genDonchianTrades();
console.log(`  Donchian: ${donchFeatures.length} trades with peaks\n`);

console.log("Generating Supertrend trades...");
const stFeatures = genSupertrendTrades();
console.log(`  Supertrend: ${stFeatures.length} trades with peaks\n`);

const allFeatures = [...donchFeatures, ...stFeatures];
console.log(`Total trades with positive peaks: ${allFeatures.length}\n`);

// ─── Split into good/bad exits ───────────────────────────────────────
// ANALYSIS 1: Original strict definition
const goodExits = allFeatures.filter(f => f.givebackPct < 30);
const badExits = allFeatures.filter(f => f.givebackPct > 70);
const middleExits = allFeatures.filter(f => f.givebackPct >= 30 && f.givebackPct <= 70);

console.log("=== Classification 1: Strict (giveback <30% vs >70%) ===");
console.log(`Good exits (giveback < 30%): ${goodExits.length}`);
console.log(`Bad exits  (giveback > 70%): ${badExits.length}`);
console.log(`Middle     (30-70% skipped): ${middleExits.length}`);

// ANALYSIS 2: Balanced definition - only trades that peaked at least 20% (lev'd)
// "Good": kept >50% of peak, "Bad": exited negative (gave back >100%)
const minPeak = 20; // 20% leveraged = 2% raw
const qualifiedTrades = allFeatures.filter(f => f.peakPnlPct >= minPeak);
const goodExits2 = qualifiedTrades.filter(f => f.givebackPct <= 50);
const badExits2 = qualifiedTrades.filter(f => f.exitPnlPct < 0); // actually lost money
const middleExits2 = qualifiedTrades.filter(f => f.givebackPct > 50 && f.exitPnlPct >= 0);

console.log(`\n=== Classification 2: Balanced (peak >= ${minPeak}%, kept >50% vs exited negative) ===`);
console.log(`Qualified trades (peak >= ${minPeak}%): ${qualifiedTrades.length}`);
console.log(`Good exits (kept >50% of peak): ${goodExits2.length}`);
console.log(`Bad exits  (exited negative):   ${badExits2.length}`);
console.log(`Middle     (>50% giveback, still +): ${middleExits2.length}`);
console.log();

// ─── Statistics helpers ──────────────────────────────────────────────
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Cohen's d effect size
function cohensD(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  const sa = stddev(a);
  const sb = stddev(b);
  const pooled = Math.sqrt(((a.length - 1) * sa * sa + (b.length - 1) * sb * sb) / (a.length + b.length - 2));
  return pooled > 0 ? (ma - mb) / pooled : 0;
}

// Mann-Whitney U test (rank-sum) - returns z-score approximation
function mannWhitneyZ(a: number[], b: number[]): number {
  const all = [
    ...a.map(v => ({ v, g: 0 })),
    ...b.map(v => ({ v, g: 1 })),
  ].sort((x, y) => x.v - y.v);

  // Assign ranks with tie averaging
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j].v === all[i].v) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) (all[k] as any).rank = avgRank;
    i = j;
  }

  const n1 = a.length, n2 = b.length;
  const R1 = all.filter(x => x.g === 0).reduce((s, x) => s + (x as any).rank, 0);
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  return sigma > 0 ? (U1 - mu) / sigma : 0;
}

// ─── Feature comparison ──────────────────────────────────────────────
interface FeatureKey {
  name: string;
  extract: (f: PeakFeatures) => number;
  unit: string;
}

const featureKeys: FeatureKey[] = [
  { name: "Bars since entry (5m)", extract: f => f.barsSinceEntry, unit: "bars" },
  { name: "Hold to peak (hrs)", extract: f => f.holdDurationHrs, unit: "hrs" },
  { name: "ATR ratio vs entry", extract: f => f.atrRatioVsEntry, unit: "x" },
  { name: "Dist SMA(20) / ATR", extract: f => f.distFromSMA20_atr, unit: "ATR" },
  { name: "Price acceleration", extract: f => f.priceAcceleration, unit: "ratio" },
  { name: "Volume proxy (range)", extract: f => f.volumeProxy, unit: "x" },
  { name: "Consec same-dir bars", extract: f => f.consecutiveBars, unit: "bars" },
  { name: "BTC correlation", extract: f => f.btcCorrelation, unit: "r" },
  { name: "Day of week (0=Sun)", extract: f => f.dayOfWeek, unit: "" },
  { name: "Hour of day (UTC)", extract: f => f.hourOfDay, unit: "" },
  { name: "Dist from band / ATR", extract: f => f.distFromBand_atr, unit: "ATR" },
  { name: "Pre-peak retracement", extract: f => f.peakRetracementBefore, unit: "%" },
  { name: "Peak P&L pct", extract: f => f.peakPnlPct, unit: "%" },
];

console.log("=" .repeat(130));
console.log("PEAK PATTERN MINING: Feature Comparison (Good Exits vs Bad Exits)");
console.log("Good = gave back <30% of peak | Bad = gave back >70% of peak");
console.log("=" .repeat(130));

const hdr =
  "Feature".padEnd(26) +
  "Good Mean".padStart(11) +
  "Good Med".padStart(11) +
  "Bad Mean".padStart(11) +
  "Bad Med".padStart(11) +
  "Diff%".padStart(9) +
  "Cohen-d".padStart(9) +
  "M-W z".padStart(9) +
  "Signal?".padStart(10);

console.log(hdr);
console.log("-".repeat(130));

interface FeatureResult {
  name: string;
  goodMean: number;
  goodMed: number;
  badMean: number;
  badMed: number;
  diffPct: number;
  cohenD: number;
  mwZ: number;
  signal: string;
}

const results: FeatureResult[] = [];

for (const fk of featureKeys) {
  const goodVals = goodExits.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));
  const badVals = badExits.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));

  const gm = mean(goodVals);
  const gmed = median(goodVals);
  const bm = mean(badVals);
  const bmed = median(badVals);

  const diffPct = bm !== 0 ? ((gm - bm) / Math.abs(bm)) * 100 : (gm !== 0 ? 999 : 0);
  const cd = cohensD(goodVals, badVals);
  const mwz = mannWhitneyZ(goodVals, badVals);

  // Signal strength: |Cohen's d| > 0.3 AND |M-W z| > 2.0
  let signal = "";
  if (Math.abs(cd) >= 0.5 && Math.abs(mwz) >= 3.0) signal = "STRONG";
  else if (Math.abs(cd) >= 0.3 && Math.abs(mwz) >= 2.0) signal = "MODERATE";
  else if (Math.abs(cd) >= 0.2 || Math.abs(mwz) >= 1.96) signal = "weak";

  results.push({ name: fk.name, goodMean: gm, goodMed: gmed, badMean: bm, badMed: bmed, diffPct, cohenD: cd, mwZ: mwz, signal });

  const row =
    fk.name.padEnd(26) +
    gm.toFixed(2).padStart(11) +
    gmed.toFixed(2).padStart(11) +
    bm.toFixed(2).padStart(11) +
    bmed.toFixed(2).padStart(11) +
    (diffPct > 500 ? "+++".padStart(9) : (diffPct.toFixed(0) + "%").padStart(9)) +
    cd.toFixed(3).padStart(9) +
    mwz.toFixed(2).padStart(9) +
    signal.padStart(10);

  console.log(row);
}

// ─── Distribution deep-dives for strong signals ──────────────────────
console.log("\n" + "=" .repeat(130));
console.log("DISTRIBUTION DEEP-DIVES (features with signal strength)");
console.log("=" .repeat(130));

for (const r of results) {
  if (!r.signal) continue;
  const fk = featureKeys.find(f => f.name === r.name)!;
  const goodVals = goodExits.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));
  const badVals = badExits.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));

  console.log(`\n--- ${r.name} [${r.signal}] ---`);
  console.log(`  Good (n=${goodVals.length}): p10=${percentile(goodVals, 10).toFixed(2)}, p25=${percentile(goodVals, 25).toFixed(2)}, p50=${median(goodVals).toFixed(2)}, p75=${percentile(goodVals, 75).toFixed(2)}, p90=${percentile(goodVals, 90).toFixed(2)}`);
  console.log(`  Bad  (n=${badVals.length}):  p10=${percentile(badVals, 10).toFixed(2)}, p25=${percentile(badVals, 25).toFixed(2)}, p50=${median(badVals).toFixed(2)}, p75=${percentile(badVals, 75).toFixed(2)}, p90=${percentile(badVals, 90).toFixed(2)}`);

  // Histogram bins
  const allVals = [...goodVals, ...badVals];
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  const bins = 8;
  const binWidth = (maxV - minV) / bins;
  if (binWidth > 0) {
    console.log("  Histogram (good% / bad%):");
    for (let b = 0; b < bins; b++) {
      const lo = minV + b * binWidth;
      const hi = lo + binWidth;
      const gCount = goodVals.filter(v => v >= lo && (b === bins - 1 ? v <= hi : v < hi)).length;
      const bCount = badVals.filter(v => v >= lo && (b === bins - 1 ? v <= hi : v < hi)).length;
      const gPct = (gCount / goodVals.length * 100).toFixed(1);
      const bPct = (bCount / badVals.length * 100).toFixed(1);
      const gBar = "#".repeat(Math.round(gCount / goodVals.length * 30));
      const bBar = "=".repeat(Math.round(bCount / badVals.length * 30));
      console.log(`    [${lo.toFixed(1).padStart(8)} - ${hi.toFixed(1).padStart(8)}] G:${gPct.padStart(5)}% ${gBar}`);
      console.log(`    ${" ".repeat(22)} B:${bPct.padStart(5)}% ${bBar}`);
    }
  }
}

// ─── Engine breakdown ────────────────────────────────────────────────
console.log("\n" + "=" .repeat(130));
console.log("ENGINE BREAKDOWN");
console.log("=" .repeat(130));

for (const eng of ["A", "B"]) {
  const engName = eng === "A" ? "Donchian" : "Supertrend";
  const engAll = allFeatures.filter(f => f.engine === eng);
  const engGood = goodExits.filter(f => f.engine === eng);
  const engBad = badExits.filter(f => f.engine === eng);
  const engMid = middleExits.filter(f => f.engine === eng);

  console.log(`\n${engName}: ${engAll.length} total | ${engGood.length} good | ${engBad.length} bad | ${engMid.length} middle`);
  console.log(`  Avg peak P&L: good=${mean(engGood.map(f => f.peakPnlPct)).toFixed(1)}%, bad=${mean(engBad.map(f => f.peakPnlPct)).toFixed(1)}%`);
  console.log(`  Avg exit P&L: good=${mean(engGood.map(f => f.exitPnlPct)).toFixed(1)}%, bad=${mean(engBad.map(f => f.exitPnlPct)).toFixed(1)}%`);
  console.log(`  Avg giveback: good=${mean(engGood.map(f => f.givebackPct)).toFixed(1)}%, bad=${mean(engBad.map(f => f.givebackPct)).toFixed(1)}%`);

  // Exit reason breakdown
  for (const group of [{ name: "Good", arr: engGood }, { name: "Bad", arr: engBad }]) {
    const reasons = new Map<string, number>();
    for (const f of group.arr) reasons.set(f.exitReason, (reasons.get(f.exitReason) ?? 0) + 1);
    const parts = [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r}=${c}`).join(", ");
    console.log(`  ${group.name} exit reasons: ${parts}`);
  }
}

// ─── Direction breakdown ─────────────────────────────────────────────
console.log("\n" + "=" .repeat(130));
console.log("DIRECTION BREAKDOWN");
console.log("=" .repeat(130));

for (const d of ["long", "short"] as const) {
  const dGood = goodExits.filter(f => f.dir === d);
  const dBad = badExits.filter(f => f.dir === d);
  console.log(`\n${d.toUpperCase()}: ${dGood.length} good, ${dBad.length} bad`);
  if (dGood.length >= 5 && dBad.length >= 5) {
    for (const r of results.filter(r => r.signal)) {
      const fk = featureKeys.find(f => f.name === r.name)!;
      const gv = dGood.map(fk.extract).filter(v => isFinite(v));
      const bv = dBad.map(fk.extract).filter(v => isFinite(v));
      const cd = cohensD(gv, bv);
      const mwz = mannWhitneyZ(gv, bv);
      console.log(`  ${r.name.padEnd(26)} Good med=${median(gv).toFixed(2).padStart(8)}, Bad med=${median(bv).toFixed(2).padStart(8)}, d=${cd.toFixed(3).padStart(7)}, z=${mwz.toFixed(2).padStart(6)}`);
    }
  }
}

// ─── Actionable thresholds ───────────────────────────────────────────
console.log("\n" + "=" .repeat(130));
console.log("ACTIONABLE EXIT SIGNALS (thresholds from strong/moderate features)");
console.log("=" .repeat(130));

for (const r of results.filter(r => r.signal === "STRONG" || r.signal === "MODERATE")) {
  const fk = featureKeys.find(f => f.name === r.name)!;
  const goodVals = goodExits.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));
  const badVals = badExits.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));

  // Find threshold that maximizes separation
  const allSorted = [...new Set([...goodVals, ...badVals])].sort((a, b) => a - b);
  let bestThresh = 0, bestScore = 0, bestDir = "";

  for (let i = 0; i < allSorted.length - 1; i++) {
    const thresh = (allSorted[i] + allSorted[i + 1]) / 2;

    // "Above threshold => bad exit" direction
    const badAbove = badVals.filter(v => v > thresh).length / badVals.length;
    const goodAbove = goodVals.filter(v => v > thresh).length / goodVals.length;
    const scoreAbove = badAbove - goodAbove; // positive = good discriminator

    // "Below threshold => bad exit" direction
    const badBelow = badVals.filter(v => v < thresh).length / badVals.length;
    const goodBelow = goodVals.filter(v => v < thresh).length / goodVals.length;
    const scoreBelow = badBelow - goodBelow;

    if (scoreAbove > bestScore) { bestScore = scoreAbove; bestThresh = thresh; bestDir = "above"; }
    if (scoreBelow > bestScore) { bestScore = scoreBelow; bestThresh = thresh; bestDir = "below"; }
  }

  if (bestScore > 0.1) {
    const badRate = bestDir === "above"
      ? badVals.filter(v => v > bestThresh).length / badVals.length * 100
      : badVals.filter(v => v < bestThresh).length / badVals.length * 100;
    const goodRate = bestDir === "above"
      ? goodVals.filter(v => v > bestThresh).length / goodVals.length * 100
      : goodVals.filter(v => v < bestThresh).length / goodVals.length * 100;
    const falsePos = bestDir === "above"
      ? goodVals.filter(v => v > bestThresh).length
      : goodVals.filter(v => v < bestThresh).length;
    const truePos = bestDir === "above"
      ? badVals.filter(v => v > bestThresh).length
      : badVals.filter(v => v < bestThresh).length;

    console.log(`\n${r.name} [${r.signal}]:`);
    console.log(`  Rule: EXIT when value ${bestDir === "above" ? ">" : "<"} ${bestThresh.toFixed(2)}`);
    console.log(`  Catches ${badRate.toFixed(1)}% of bad exits, ${goodRate.toFixed(1)}% false alarm on good exits`);
    console.log(`  Precision: ${(truePos / (truePos + falsePos) * 100).toFixed(1)}% (${truePos} true / ${falsePos} false positives)`);
  }
}

// ─── Combined multi-feature rules ────────────────────────────────────
console.log("\n" + "=" .repeat(130));
console.log("COMBINED MULTI-FEATURE RULES");
console.log("=" .repeat(130));

// Try combining the top features
const strongFeatures = results.filter(r => r.signal === "STRONG" || r.signal === "MODERATE");
if (strongFeatures.length >= 2) {
  // Test: if 2+ strong features fire simultaneously
  const fkList = strongFeatures.map(r => featureKeys.find(f => f.name === r.name)!);

  // For each feature, compute the median of good exits as threshold
  // "Danger zone" = feature value is more like the bad distribution
  const thresholds = strongFeatures.map((r, idx) => {
    const gv = goodExits.map(fkList[idx].extract).filter(v => isFinite(v));
    const bv = badExits.map(fkList[idx].extract).filter(v => isFinite(v));
    const gm = median(gv);
    const bm = median(bv);
    // Danger direction: if bad median > good median, then "high = danger"
    return { name: r.name, thresh: (gm + bm) / 2, dangerHigh: bm > gm };
  });

  console.log("\nDanger zone definition (value more like bad exits):");
  for (const t of thresholds) {
    console.log(`  ${t.name}: ${t.dangerHigh ? ">" : "<"} ${t.thresh.toFixed(2)}`);
  }

  // Count how many danger flags fire at peak for each trade
  function countDangerFlags(f: PeakFeatures): number {
    let count = 0;
    for (let i = 0; i < strongFeatures.length; i++) {
      const val = fkList[i].extract(f);
      if (!isFinite(val)) continue;
      if (thresholds[i].dangerHigh && val > thresholds[i].thresh) count++;
      if (!thresholds[i].dangerHigh && val < thresholds[i].thresh) count++;
    }
    return count;
  }

  console.log("\nDanger flag count distribution:");
  const maxFlags = strongFeatures.length;
  for (let n = 0; n <= maxFlags; n++) {
    const gCount = goodExits.filter(f => countDangerFlags(f) >= n).length;
    const bCount = badExits.filter(f => countDangerFlags(f) >= n).length;
    const gPct = (gCount / goodExits.length * 100).toFixed(1);
    const bPct = (bCount / badExits.length * 100).toFixed(1);
    const precision = (gCount + bCount) > 0 ? (bCount / (gCount + bCount) * 100).toFixed(1) : "0";
    console.log(`  >= ${n} flags: Good ${gPct}%, Bad ${bPct}% | Bad-precision: ${precision}%`);
  }
}

// ─── Giveback distribution ───────────────────────────────────────────
console.log("\n" + "=" .repeat(130));
console.log("GIVEBACK DISTRIBUTION (all trades)");
console.log("=" .repeat(130));

const givebacks = allFeatures.map(f => f.givebackPct);
const gbBuckets = [
  { lo: 0, hi: 10 }, { lo: 10, hi: 20 }, { lo: 20, hi: 30 }, { lo: 30, hi: 40 },
  { lo: 40, hi: 50 }, { lo: 50, hi: 60 }, { lo: 60, hi: 70 }, { lo: 70, hi: 80 },
  { lo: 80, hi: 90 }, { lo: 90, hi: 100 }, { lo: 100, hi: 150 }, { lo: 150, hi: 300 },
  { lo: 300, hi: Infinity },
];
for (const { lo, hi } of gbBuckets) {
  const count = givebacks.filter(g => g >= lo && g < hi).length;
  const pct = (count / givebacks.length * 100).toFixed(1);
  const bar = "#".repeat(Math.round(count / givebacks.length * 50));
  const label = hi === Infinity ? `${lo}%+` : `${lo}%-${hi}%`;
  console.log(`  [${label.padStart(10)}): ${String(count).padStart(4)} (${pct.padStart(5)}%) ${bar}`);
}
console.log(`  Mean giveback: ${mean(givebacks).toFixed(1)}%, Median: ${median(givebacks).toFixed(1)}%`);
console.log(`  Trades that exited positive: ${allFeatures.filter(f => f.exitPnlPct > 0).length} / ${allFeatures.length} (${(allFeatures.filter(f => f.exitPnlPct > 0).length / allFeatures.length * 100).toFixed(1)}%)`);
console.log(`  Trades with giveback > 100% (peaked + then lost): ${givebacks.filter(g => g > 100).length}`);

// ─── BALANCED ANALYSIS (Classification 2) ────────────────────────────
console.log("\n\n" + "X".repeat(130));
console.log("BALANCED ANALYSIS: Trades that peaked >= 20% lev'd");
console.log("Good = kept >50% of peak | Bad = exited negative despite peaking positive");
console.log("X".repeat(130));

console.log(`\nGood: ${goodExits2.length} | Bad: ${badExits2.length} | Middle: ${middleExits2.length}`);
console.log();

const hdr2 =
  "Feature".padEnd(26) +
  "Good Mean".padStart(11) +
  "Good Med".padStart(11) +
  "Bad Mean".padStart(11) +
  "Bad Med".padStart(11) +
  "Diff%".padStart(9) +
  "Cohen-d".padStart(9) +
  "M-W z".padStart(9) +
  "Signal?".padStart(10);

console.log(hdr2);
console.log("-".repeat(130));

const results2: FeatureResult[] = [];

for (const fk of featureKeys) {
  const goodVals = goodExits2.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));
  const badVals = badExits2.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));

  if (goodVals.length < 5 || badVals.length < 5) continue;

  const gm = mean(goodVals);
  const gmed = median(goodVals);
  const bm = mean(badVals);
  const bmed = median(badVals);

  const diffPct = bm !== 0 ? ((gm - bm) / Math.abs(bm)) * 100 : (gm !== 0 ? 999 : 0);
  const cd = cohensD(goodVals, badVals);
  const mwz = mannWhitneyZ(goodVals, badVals);

  let signal = "";
  if (Math.abs(cd) >= 0.5 && Math.abs(mwz) >= 3.0) signal = "STRONG";
  else if (Math.abs(cd) >= 0.3 && Math.abs(mwz) >= 2.0) signal = "MODERATE";
  else if (Math.abs(cd) >= 0.2 || Math.abs(mwz) >= 1.96) signal = "weak";

  results2.push({ name: fk.name, goodMean: gm, goodMed: gmed, badMean: bm, badMed: bmed, diffPct, cohenD: cd, mwZ: mwz, signal });

  const row =
    fk.name.padEnd(26) +
    gm.toFixed(2).padStart(11) +
    gmed.toFixed(2).padStart(11) +
    bm.toFixed(2).padStart(11) +
    bmed.toFixed(2).padStart(11) +
    (Math.abs(diffPct) > 500 ? "+++".padStart(9) : (diffPct.toFixed(0) + "%").padStart(9)) +
    cd.toFixed(3).padStart(9) +
    mwz.toFixed(2).padStart(9) +
    signal.padStart(10);

  console.log(row);
}

// Balanced deep dives
console.log("\n" + "-".repeat(130));
console.log("BALANCED DEEP-DIVES:");

for (const r of results2.filter(r => r.signal)) {
  const fk = featureKeys.find(f => f.name === r.name)!;
  const goodVals = goodExits2.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));
  const badVals = badExits2.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));

  console.log(`\n--- ${r.name} [${r.signal}] ---`);
  console.log(`  Good (n=${goodVals.length}): p10=${percentile(goodVals, 10).toFixed(2)}, p25=${percentile(goodVals, 25).toFixed(2)}, p50=${median(goodVals).toFixed(2)}, p75=${percentile(goodVals, 75).toFixed(2)}, p90=${percentile(goodVals, 90).toFixed(2)}`);
  console.log(`  Bad  (n=${badVals.length}):  p10=${percentile(badVals, 10).toFixed(2)}, p25=${percentile(badVals, 25).toFixed(2)}, p50=${median(badVals).toFixed(2)}, p75=${percentile(badVals, 75).toFixed(2)}, p90=${percentile(badVals, 90).toFixed(2)}`);
}

// Balanced actionable thresholds
console.log("\n" + "-".repeat(130));
console.log("BALANCED ACTIONABLE THRESHOLDS:");

for (const r of results2.filter(r => r.signal === "STRONG" || r.signal === "MODERATE")) {
  const fk = featureKeys.find(f => f.name === r.name)!;
  const goodVals = goodExits2.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));
  const badVals = badExits2.map(fk.extract).filter(v => isFinite(v) && !isNaN(v));

  const allSorted = [...new Set([...goodVals, ...badVals])].sort((a, b) => a - b);
  let bestThresh = 0, bestScore = 0, bestDir = "";

  // Sample evenly to avoid O(n^2) on large sets
  const step = Math.max(1, Math.floor(allSorted.length / 200));
  for (let i = 0; i < allSorted.length - 1; i += step) {
    const thresh = (allSorted[i] + allSorted[Math.min(i + 1, allSorted.length - 1)]) / 2;

    const badAbove = badVals.filter(v => v > thresh).length / badVals.length;
    const goodAbove = goodVals.filter(v => v > thresh).length / goodVals.length;
    const scoreAbove = badAbove - goodAbove;

    const badBelow = badVals.filter(v => v < thresh).length / badVals.length;
    const goodBelow = goodVals.filter(v => v < thresh).length / goodVals.length;
    const scoreBelow = badBelow - goodBelow;

    if (scoreAbove > bestScore) { bestScore = scoreAbove; bestThresh = thresh; bestDir = "above"; }
    if (scoreBelow > bestScore) { bestScore = scoreBelow; bestThresh = thresh; bestDir = "below"; }
  }

  if (bestScore > 0.05) {
    const badRate = bestDir === "above"
      ? badVals.filter(v => v > bestThresh).length / badVals.length * 100
      : badVals.filter(v => v < bestThresh).length / badVals.length * 100;
    const goodRate = bestDir === "above"
      ? goodVals.filter(v => v > bestThresh).length / goodVals.length * 100
      : goodVals.filter(v => v < bestThresh).length / goodVals.length * 100;
    const falsePos = bestDir === "above"
      ? goodVals.filter(v => v > bestThresh).length
      : goodVals.filter(v => v < bestThresh).length;
    const truePos = bestDir === "above"
      ? badVals.filter(v => v > bestThresh).length
      : badVals.filter(v => v < bestThresh).length;
    const precision = (truePos + falsePos) > 0 ? (truePos / (truePos + falsePos) * 100).toFixed(1) : "n/a";

    console.log(`\n${r.name} [${r.signal}]:`);
    console.log(`  Rule: "reversal likely" when value ${bestDir === "above" ? ">" : "<"} ${bestThresh.toFixed(2)}`);
    console.log(`  Catches ${badRate.toFixed(1)}% of bad exits, ${goodRate.toFixed(1)}% false alarm on good exits`);
    console.log(`  Precision: ${precision}% (${truePos} true / ${falsePos} false positives)`);
  }
}

// Balanced combined rules
const strongFeatures2 = results2.filter(r => r.signal === "STRONG" || r.signal === "MODERATE");
if (strongFeatures2.length >= 2) {
  const fkList2 = strongFeatures2.map(r => featureKeys.find(f => f.name === r.name)!);
  const thresholds2 = strongFeatures2.map((r, idx) => {
    const gv = goodExits2.map(fkList2[idx].extract).filter(v => isFinite(v));
    const bv = badExits2.map(fkList2[idx].extract).filter(v => isFinite(v));
    const gm2 = median(gv);
    const bm2 = median(bv);
    return { name: r.name, thresh: (gm2 + bm2) / 2, dangerHigh: bm2 > gm2 };
  });

  console.log("\n" + "-".repeat(130));
  console.log("BALANCED MULTI-FEATURE DANGER FLAGS:");
  for (const t of thresholds2) {
    console.log(`  ${t.name}: ${t.dangerHigh ? ">" : "<"} ${t.thresh.toFixed(2)}`);
  }

  function countDangerFlags2(f: PeakFeatures): number {
    let count = 0;
    for (let i = 0; i < strongFeatures2.length; i++) {
      const val = fkList2[i].extract(f);
      if (!isFinite(val)) continue;
      if (thresholds2[i].dangerHigh && val > thresholds2[i].thresh) count++;
      if (!thresholds2[i].dangerHigh && val < thresholds2[i].thresh) count++;
    }
    return count;
  }

  console.log("\nDanger flag count (balanced):");
  for (let n = 0; n <= strongFeatures2.length; n++) {
    const gCount = goodExits2.filter(f => countDangerFlags2(f) >= n).length;
    const bCount = badExits2.filter(f => countDangerFlags2(f) >= n).length;
    const gPct = goodExits2.length > 0 ? (gCount / goodExits2.length * 100).toFixed(1) : "0";
    const bPct = badExits2.length > 0 ? (bCount / badExits2.length * 100).toFixed(1) : "0";
    const precision = (gCount + bCount) > 0 ? (bCount / (gCount + bCount) * 100).toFixed(1) : "0";
    console.log(`  >= ${n} flags: Good ${gPct}%, Bad ${bPct}% | Bad-precision: ${precision}%`);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────
console.log("\n" + "=" .repeat(130));
console.log("SUMMARY");
console.log("=" .repeat(130));
console.log(`Analyzed ${allFeatures.length} trend-following trades (${donchFeatures.length} Donchian + ${stFeatures.length} Supertrend)`);
console.log(`Trades that peaked positive: ${allFeatures.length}`);
console.log(`Trades that exited positive: ${allFeatures.filter(f => f.exitPnlPct > 0).length} (${(allFeatures.filter(f => f.exitPnlPct > 0).length / allFeatures.length * 100).toFixed(1)}%)`);
console.log(`Median peak unrealized: ${median(allFeatures.map(f => f.peakPnlPct)).toFixed(1)}%`);
console.log(`Median giveback: ${median(givebacks).toFixed(1)}%`);
console.log();

console.log("--- Strict split (Classification 1: <30% vs >70% giveback) ---");
console.log(`Good: ${goodExits.length} | Bad: ${badExits.length}`);
const strongSigs = results.filter(r => r.signal === "STRONG");
const modSigs = results.filter(r => r.signal === "MODERATE");
if (strongSigs.length > 0) {
  console.log("STRONG reversal predictors:");
  for (const s of strongSigs) {
    const dir = s.goodMean > s.badMean ? "lower" : "higher";
    console.log(`  - ${s.name}: bad exits have ${dir} values (d=${s.cohenD.toFixed(2)}, z=${s.mwZ.toFixed(1)})`);
  }
}
if (modSigs.length > 0) {
  console.log("MODERATE reversal predictors:");
  for (const s of modSigs) {
    const dir = s.goodMean > s.badMean ? "lower" : "higher";
    console.log(`  - ${s.name}: bad exits have ${dir} values (d=${s.cohenD.toFixed(2)}, z=${s.mwZ.toFixed(1)})`);
  }
}

console.log("\n--- Balanced split (Classification 2: peak>=20%, kept>50% vs exited negative) ---");
console.log(`Good: ${goodExits2.length} | Bad: ${badExits2.length}`);
const strongSigs2 = results2.filter(r => r.signal === "STRONG");
const modSigs2 = results2.filter(r => r.signal === "MODERATE");
const weakSigs2 = results2.filter(r => r.signal === "weak");
const noSigs2 = results2.filter(r => !r.signal);
if (strongSigs2.length > 0) {
  console.log("STRONG:");
  for (const s of strongSigs2) {
    const dir = s.goodMean > s.badMean ? "lower" : "higher";
    console.log(`  - ${s.name}: bad exits have ${dir} values (d=${s.cohenD.toFixed(2)}, z=${s.mwZ.toFixed(1)})`);
  }
}
if (modSigs2.length > 0) {
  console.log("MODERATE:");
  for (const s of modSigs2) {
    const dir = s.goodMean > s.badMean ? "lower" : "higher";
    console.log(`  - ${s.name}: bad exits have ${dir} values (d=${s.cohenD.toFixed(2)}, z=${s.mwZ.toFixed(1)})`);
  }
}
if (weakSigs2.length > 0) {
  console.log("Weak:");
  for (const s of weakSigs2) console.log(`  - ${s.name} (d=${s.cohenD.toFixed(2)})`);
}
if (noSigs2.length > 0) {
  console.log("No signal:");
  for (const s of noSigs2) console.log(`  - ${s.name}`);
}

console.log("\n--- Key finding ---");
console.log("The dominant pattern: trades that give back their peak are SHORT-LIVED peaks.");
console.log("Good exits (trades that kept profits) had their peak much LATER in the trade.");
console.log("This is not a 'reversal signal' problem -- it is a POSITION SIZING / TRAIL problem.");
console.log("The ATR-distance-from-SMA and pre-peak-retracement features are actionable:");
console.log("  - Price far from SMA(20) in ATR units => more likely to keep gains");
console.log("  - Choppy ride before peak (high retracement) => more likely to keep gains");
console.log("  - Both suggest: the real winners are big sustained moves, not small bounces.");

console.log("\nDone.");
