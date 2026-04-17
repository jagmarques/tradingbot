/**
 * Reversal Pattern Mining
 *
 * Generates Supertrend(14,1.75) trades on 4h bars for 14 pairs.
 * For each trade, finds the PEAK price on 5m bars, then extracts
 * features from the 6h and 24h windows BEFORE the peak.
 *
 * Classification: uses PEAK TIMING within the trade.
 *   "early_peak" = peak in first 40% of trade duration (trend fails quickly)
 *   "late_peak"  = peak in last 40% of trade duration (trend ran properly)
 * Only considers trades lasting >12h and with >1% peak-to-entry move.
 *
 * Uses BALANCED ACCURACY (avg of TPR + TNR) to avoid class imbalance bias.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 5;
const NOT = SIZE * LEV;
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const HOUR = 3600000;

const PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE",
  "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "SOL",
];

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SOL: 2.0e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
};

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }

interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number;
  peakPrice: number; peakTime: number;
  peakPctFromEntry: number;  // how far price went in our favor (%)
  peakTimeFraction: number;  // when peak occurred (0=entry, 1=exit)
  givebackFromPeak: number;  // % given back from peak to exit
  classification: "early_peak" | "late_peak" | "mid";
  feat24h: FeatureSet;
  feat6h: FeatureSet;
}

interface FeatureSet {
  volTrend: number;           // slope of range normalized by avg range
  accel: number;              // 2nd derivative of price
  newHighPct: number;         // fraction of 5m bars making new highs
  emaSpreadTrend: number;     // slope of (price - 1h EMA9)
  largeWickCount: number;     // wicks >2x avg range in opposite dir
  rsiDivergence: boolean;     // RSI making lower highs while price higher highs
  priceToEmaRatio: number;    // current price / EMA(9) at peak time
  rangeExpansion: number;     // ratio of recent range to older range within window
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
    : b
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles: C[]): C[] {
  const barsPerGroup = 48;
  const result: C[] = [];
  for (let i = 0; i < candles.length; i += barsPerGroup) {
    const group = candles.slice(i, i + barsPerGroup);
    if (group.length < barsPerGroup * 0.8) continue;
    result.push({
      t: group[0].t,
      o: group[0].o,
      h: Math.max(...group.map(g => g.h)),
      l: Math.min(...group.map(g => g.l)),
      c: group[group.length - 1].c,
    });
  }
  return result;
}

function aggregateTo1h(candles: C[]): C[] {
  const barsPerGroup = 12;
  const result: C[] = [];
  for (let i = 0; i < candles.length; i += barsPerGroup) {
    const group = candles.slice(i, i + barsPerGroup);
    if (group.length < barsPerGroup * 0.8) continue;
    result.push({
      t: group[0].t,
      o: group[0].o,
      h: Math.max(...group.map(g => g.h)),
      l: Math.min(...group.map(g => g.l)),
      c: group[group.length - 1].c,
    });
  }
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
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
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period; init = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcRSI(values: number[], period: number): number[] {
  const rsi = new Array(values.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period && i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) avgGain += change; else avgLoss -= change;
  }
  if (period >= values.length) return rsi;
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      const prevUpper = (cs[i - 1].h + cs[i - 1].l) / 2 + mult * atr[i - 1];
      const prevLower = (cs[i - 1].h + cs[i - 1].l) / 2 - mult * atr[i - 1];
      const prevFinalUpper = st[i - 1] > 0 && dirs[i - 1] === -1 ? st[i - 1] : prevUpper;
      const prevFinalLower = st[i - 1] > 0 && dirs[i - 1] === 1 ? st[i - 1] : prevLower;

      if (!(lowerBand > prevFinalLower || cs[i - 1].c < prevFinalLower)) lowerBand = prevFinalLower;
      if (!(upperBand < prevFinalUpper || cs[i - 1].c > prevFinalUpper)) upperBand = prevFinalUpper;
    }

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      dirs[i] = dirs[i - 1] === 1
        ? (cs[i].c < lowerBand ? -1 : 1)
        : (cs[i].c > upperBand ? 1 : -1);
    }
    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }
  return { st, dir: dirs };
}

// ─── Trade Generation ───────────────────────────────────────────────
function generateRawTrades(pair: string, bars4h: C[]): { dir: "long" | "short"; ep: number; et: number; xp: number; xt: number; pnl: number }[] {
  const { dir } = calcSupertrend(bars4h, 14, 1.75);
  const trades: any[] = [];
  let pos: { dir: "long" | "short"; ep: number; et: number } | null = null;

  for (let i = 15; i < bars4h.length; i++) {
    const prevDir = dir[i - 1];
    const prevPrevDir = i >= 2 ? dir[i - 2] : prevDir;
    const flipped = prevDir !== prevPrevDir;

    if (pos && flipped) {
      const xp = bars4h[i].o;
      const sp = SPREAD[pair] ?? 4e-4;
      const rawPnl = pos.dir === "long" ? (xp / pos.ep - 1) * NOT : (pos.ep / xp - 1) * NOT;
      const fees = NOT * FEE_TAKER * 2;
      const slip = sp * NOT * 2;
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bars4h[i].t, pnl: rawPnl - fees - slip });
      pos = null;
    }
    if (!pos && flipped) {
      pos = { dir: prevDir === 1 ? "long" : "short", ep: bars4h[i].o, et: bars4h[i].t };
    }
  }
  if (pos) {
    const last = bars4h[bars4h.length - 1];
    const sp = SPREAD[pair] ?? 4e-4;
    const rawPnl = pos.dir === "long" ? (last.c / pos.ep - 1) * NOT : (pos.ep / last.c - 1) * NOT;
    trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: last.c, et: pos.et, xt: last.t, pnl: rawPnl - NOT * FEE_TAKER * 2 - sp * NOT * 2 });
  }
  return trades;
}

// ─── Peak Finding ───────────────────────────────────────────────────
function findPeak(bars5m: C[], entryTime: number, exitTime: number, dir: "long" | "short"): { peakPrice: number; peakTime: number } {
  let peakPrice = dir === "long" ? -Infinity : Infinity;
  let peakTime = entryTime;

  for (const b of bars5m) {
    if (b.t < entryTime || b.t > exitTime) continue;
    if (dir === "long" && b.h > peakPrice) { peakPrice = b.h; peakTime = b.t; }
    if (dir === "short" && b.l < peakPrice) { peakPrice = b.l; peakTime = b.t; }
  }
  return { peakPrice: peakPrice === -Infinity || peakPrice === Infinity ? 0 : peakPrice, peakTime };
}

// ─── Feature Extraction ─────────────────────────────────────────────
function linearSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += values[i]; sumXY += i * values[i]; sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

function extractFeatures(
  bars5m: C[],
  bars1h: C[],
  rsi1h: number[],
  ema9_1h: number[],
  peakTime: number,
  dir: "long" | "short",
  windowHours: number,
): FeatureSet {
  const windowMs = windowHours * HOUR;
  const empty: FeatureSet = { volTrend: 0, accel: 0, newHighPct: 0, emaSpreadTrend: 0, largeWickCount: 0, rsiDivergence: false, priceToEmaRatio: 0, rangeExpansion: 0 };

  // 5m bars in window
  const windowBars: C[] = [];
  for (const b of bars5m) {
    if (b.t >= peakTime - windowMs && b.t < peakTime) windowBars.push(b);
  }
  if (windowBars.length < 6) return empty;

  // 1. Volume trend (range as proxy)
  const ranges = windowBars.map(b => b.h - b.l);
  const avgRange = ranges.reduce((s, r) => s + r, 0) / ranges.length;
  const volTrend = avgRange > 0 ? linearSlope(ranges) / avgRange : 0;

  // 2. Price acceleration (2nd derivative)
  const prices = windowBars.map(b => b.c);
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  const retDiffs: number[] = [];
  for (let i = 1; i < returns.length; i++) retDiffs.push(returns[i] - returns[i - 1]);
  // Direction-normalized: positive = accelerating in trend direction
  const rawAccel = retDiffs.length > 0 ? retDiffs.reduce((s, r) => s + r, 0) / retDiffs.length : 0;
  const accel = dir === "long" ? rawAccel : -rawAccel;

  // 3. New high percentage
  let runningHigh = dir === "long" ? -Infinity : Infinity;
  let newHighCount = 0;
  for (const b of windowBars) {
    if (dir === "long" && b.h > runningHigh) { runningHigh = b.h; newHighCount++; }
    if (dir === "short" && b.l < runningHigh) { runningHigh = b.l; newHighCount++; }
  }
  const newHighPct = newHighCount / windowBars.length;

  // 4. EMA spread trend (price - 1h EMA9)
  const window1h: { bar: C; idx: number }[] = [];
  for (let i = 0; i < bars1h.length; i++) {
    if (bars1h[i].t >= peakTime - windowMs && bars1h[i].t < peakTime && ema9_1h[i] > 0)
      window1h.push({ bar: bars1h[i], idx: i });
  }
  const spreads = window1h.map(({ bar, idx }) => dir === "long" ? bar.c - ema9_1h[idx] : ema9_1h[idx] - bar.c);
  const emaSpreadTrend = spreads.length >= 3 ? linearSlope(spreads) : 0;

  // 5. Large wicks in opposite direction
  let largeWickCount = 0;
  for (const b of windowBars) {
    const oppositeWick = dir === "long"
      ? Math.min(b.o, b.c) - b.l
      : b.h - Math.max(b.o, b.c);
    if (oppositeWick > avgRange * 2) largeWickCount++;
  }

  // 6. RSI divergence
  let rsiDivergence = false;
  if (window1h.length >= 6) {
    const third = Math.floor(window1h.length / 3);
    const first = window1h.slice(0, third);
    const last = window1h.slice(-third);
    const firstPH = Math.max(...first.map(({ bar }) => dir === "long" ? bar.h : -bar.l));
    const lastPH = Math.max(...last.map(({ bar }) => dir === "long" ? bar.h : -bar.l));
    const firstRH = Math.max(...first.map(({ idx }) => dir === "long" ? rsi1h[idx] : 100 - rsi1h[idx]));
    const lastRH = Math.max(...last.map(({ idx }) => dir === "long" ? rsi1h[idx] : 100 - rsi1h[idx]));
    if (lastPH > firstPH && lastRH < firstRH - 2) rsiDivergence = true;
  }

  // 7. Price-to-EMA ratio at peak
  let priceToEmaRatio = 0;
  if (window1h.length > 0) {
    const last1h = window1h[window1h.length - 1];
    if (ema9_1h[last1h.idx] > 0) {
      const ratio = last1h.bar.c / ema9_1h[last1h.idx];
      priceToEmaRatio = dir === "long" ? ratio : 2 - ratio; // normalize: >1 = overextended
    }
  }

  // 8. Range expansion: last third of window range / first third range
  const thirdLen = Math.floor(windowBars.length / 3);
  if (thirdLen >= 2) {
    const firstRanges = ranges.slice(0, thirdLen);
    const lastRanges = ranges.slice(-thirdLen);
    const firstAvg = firstRanges.reduce((s, r) => s + r, 0) / firstRanges.length;
    const lastAvg = lastRanges.reduce((s, r) => s + r, 0) / lastRanges.length;
    if (firstAvg > 0) {
      return { volTrend, accel, newHighPct, emaSpreadTrend, largeWickCount, rsiDivergence, priceToEmaRatio, rangeExpansion: lastAvg / firstAvg };
    }
  }

  return { volTrend, accel, newHighPct, emaSpreadTrend, largeWickCount, rsiDivergence, priceToEmaRatio, rangeExpansion: 1 };
}

// ─── Balanced Accuracy (avg of TPR + TNR) ───────────────────────────
function balancedAccuracy(posVals: number[], negVals: number[], thresholds?: number[]): { balAcc: number; threshold: number; direction: ">" | "<"; tpr: number; tnr: number } {
  if (posVals.length === 0 || negVals.length === 0) return { balAcc: 0.5, threshold: 0, direction: ">", tpr: 0.5, tnr: 0.5 };

  // Generate candidate thresholds from percentiles
  const all = [...posVals, ...negVals].sort((a, b) => a - b);
  const candidates = thresholds ?? [];
  if (candidates.length === 0) {
    for (let p = 5; p <= 95; p += 5) {
      const idx = Math.floor(all.length * p / 100);
      candidates.push(all[idx]);
    }
    // Add unique values (subsample if too many)
    const unique = [...new Set(all)];
    if (unique.length <= 200) {
      candidates.push(...unique);
    } else {
      for (let i = 0; i < 200; i++) candidates.push(unique[Math.floor(i * unique.length / 200)]);
    }
  }

  let best = { balAcc: 0.5, threshold: 0, direction: ">" as ">" | "<", tpr: 0.5, tnr: 0.5 };

  for (const thresh of candidates) {
    // Positive > threshold
    const tprGt = posVals.filter(v => v > thresh).length / posVals.length;
    const tnrGt = negVals.filter(v => v <= thresh).length / negVals.length;
    const balGt = (tprGt + tnrGt) / 2;
    if (balGt > best.balAcc) best = { balAcc: balGt, threshold: thresh, direction: ">", tpr: tprGt, tnr: tnrGt };

    // Positive < threshold
    const tprLt = posVals.filter(v => v < thresh).length / posVals.length;
    const tnrLt = negVals.filter(v => v >= thresh).length / negVals.length;
    const balLt = (tprLt + tnrLt) / 2;
    if (balLt > best.balAcc) best = { balAcc: balLt, threshold: thresh, direction: "<", tpr: tprLt, tnr: tnrLt };
  }
  return best;
}

// Permutation test
function permPValue(posVals: number[], negVals: number[], nPerms = 2000): number {
  const combined = [...posVals, ...negVals];
  const n1 = posVals.length;
  const obsMean1 = posVals.reduce((s, v) => s + v, 0) / n1;
  const obsMean2 = negVals.reduce((s, v) => s + v, 0) / negVals.length;
  const obsDiff = Math.abs(obsMean1 - obsMean2);
  let count = 0;
  for (let p = 0; p < nPerms; p++) {
    for (let i = combined.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [combined[i], combined[j]] = [combined[j], combined[i]];
    }
    const m1 = combined.slice(0, n1).reduce((s, v) => s + v, 0) / n1;
    const m2 = combined.slice(n1).reduce((s, v) => s + v, 0) / negVals.length;
    if (Math.abs(m1 - m2) >= obsDiff) count++;
  }
  return count / nPerms;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("Loading 5m candle data...");

const allTrades: Trade[] = [];

for (const pair of PAIRS) {
  const bars5m = load5m(pair);
  if (bars5m.length < 500) { console.log(`  ${pair}: skipped`); continue; }

  const bars4h = aggregateTo4h(bars5m);
  const bars1h = aggregateTo1h(bars5m);
  const closes1h = bars1h.map(b => b.c);
  const ema9_1h = calcEMA(closes1h, 9);
  const rsi1h = calcRSI(closes1h, 14);

  const rawTrades = generateRawTrades(pair, bars4h);
  let accepted = 0;

  for (const rt of rawTrades) {
    const duration = rt.xt - rt.et;
    if (duration < 12 * HOUR) continue; // Skip very short trades

    const { peakPrice, peakTime } = findPeak(bars5m, rt.et, rt.xt, rt.dir);
    if (peakPrice === 0) continue;

    // Peak move from entry
    const peakPctFromEntry = rt.dir === "long"
      ? (peakPrice - rt.ep) / rt.ep * 100
      : (rt.ep - peakPrice) / rt.ep * 100;

    if (peakPctFromEntry < 1.0) continue; // Skip trades that barely moved (<1%)

    // Peak timing within trade
    const peakTimeFraction = (peakTime - rt.et) / duration;

    // Giveback from peak to exit
    const givebackFromPeak = rt.dir === "long"
      ? (peakPrice - rt.xp) / peakPrice * 100
      : (rt.xp - peakPrice) / peakPrice * 100;

    // Classification: early peak vs late peak
    let classification: Trade["classification"];
    if (peakTimeFraction < 0.40) classification = "early_peak";
    else if (peakTimeFraction > 0.60) classification = "late_peak";
    else classification = "mid";

    // Extract features
    const feat24h = extractFeatures(bars5m, bars1h, rsi1h, ema9_1h, peakTime, rt.dir, 24);
    const feat6h = extractFeatures(bars5m, bars1h, rsi1h, ema9_1h, peakTime, rt.dir, 6);

    allTrades.push({
      pair, dir: rt.dir, ep: rt.ep, xp: rt.xp, et: rt.et, xt: rt.xt, pnl: rt.pnl,
      peakPrice, peakTime, peakPctFromEntry, peakTimeFraction,
      givebackFromPeak, classification, feat24h, feat6h,
    });
    accepted++;
  }
  console.log(`  ${pair}: ${rawTrades.length} raw -> ${accepted} accepted (>12h, >1% peak)`);
}

const earlyPeaks = allTrades.filter(t => t.classification === "early_peak");
const latePeaks = allTrades.filter(t => t.classification === "late_peak");
const midPeaks = allTrades.filter(t => t.classification === "mid");

console.log("\n" + "=".repeat(95));
console.log("REVERSAL PATTERN MINING - Supertrend(14, 1.75) on 4h bars, 14 pairs");
console.log("=".repeat(95));
console.log(`\nTotal trades (>12h, >1% peak move): ${allTrades.length}`);
console.log(`  Early peak (<40% of duration = trend fails): ${earlyPeaks.length} (${(earlyPeaks.length / allTrades.length * 100).toFixed(1)}%)`);
console.log(`  Late peak  (>60% of duration = trend runs):  ${latePeaks.length} (${(latePeaks.length / allTrades.length * 100).toFixed(1)}%)`);
console.log(`  Mid peak   (40-60% = ambiguous):             ${midPeaks.length} (${(midPeaks.length / allTrades.length * 100).toFixed(1)}%)`);
console.log(`  Longs: ${allTrades.filter(t => t.dir === "long").length}  Shorts: ${allTrades.filter(t => t.dir === "short").length}`);
console.log(`\n  Avg peak move - Early: ${earlyPeaks.map(t => t.peakPctFromEntry).reduce((s, v) => s + v, 0) / (earlyPeaks.length || 1) |0}%  Late: ${latePeaks.map(t => t.peakPctFromEntry).reduce((s, v) => s + v, 0) / (latePeaks.length || 1) |0}%`);
console.log(`  Avg giveback  - Early: ${earlyPeaks.map(t => t.givebackFromPeak).reduce((s, v) => s + v, 0) / (earlyPeaks.length || 1) |0}%  Late: ${latePeaks.map(t => t.givebackFromPeak).reduce((s, v) => s + v, 0) / (latePeaks.length || 1) |0}%`);
console.log(`  Avg P&L ($)   - Early: $${(earlyPeaks.map(t => t.pnl).reduce((s, v) => s + v, 0) / (earlyPeaks.length || 1)).toFixed(2)}  Late: $${(latePeaks.map(t => t.pnl).reduce((s, v) => s + v, 0) / (latePeaks.length || 1)).toFixed(2)}`);

// ─── Feature Analysis ───────────────────────────────────────────────
// Positive class = early_peak (the thing we want to detect)
// Negative class = late_peak

type FeatureKey = keyof FeatureSet;
const numericFeatures: { key: FeatureKey; label: string }[] = [
  { key: "volTrend", label: "Volume (range) trend" },
  { key: "accel", label: "Price acceleration (2nd deriv)" },
  { key: "newHighPct", label: "% bars making new highs" },
  { key: "emaSpreadTrend", label: "EMA(9) spread trend" },
  { key: "largeWickCount", label: "Opposite-dir large wicks" },
  { key: "priceToEmaRatio", label: "Price/EMA(9) ratio" },
  { key: "rangeExpansion", label: "Range expansion (last/first)" },
];

const boolFeatures: { key: FeatureKey; label: string }[] = [
  { key: "rsiDivergence", label: "RSI divergence (bearish)" },
];

for (const windowLabel of ["24h", "6h"] as const) {
  const fKey = windowLabel === "24h" ? "feat24h" : "feat6h";
  console.log(`\n${"─".repeat(95)}`);
  console.log(`FEATURES IN THE ${windowLabel === "24h" ? 24 : 6} HOURS BEFORE PEAK   (balanced accuracy = avg of TPR + TNR)`);
  console.log(`${"─".repeat(95)}`);
  console.log(`${"Feature".padEnd(35)} ${"Early Mean".padStart(11)} ${"Late Mean".padStart(11)} ${"Early Med".padStart(11)} ${"Late Med".padStart(11)} ${"BalAcc".padStart(8)} ${"TPR".padStart(6)} ${"TNR".padStart(6)} ${"p-val".padStart(8)}`);
  console.log("-".repeat(110));

  for (const fc of numericFeatures) {
    const posVals = earlyPeaks.map(t => (t[fKey] as any)[fc.key] as number);
    const negVals = latePeaks.map(t => (t[fKey] as any)[fc.key] as number);
    const posMean = posVals.reduce((s, v) => s + v, 0) / (posVals.length || 1);
    const negMean = negVals.reduce((s, v) => s + v, 0) / (negVals.length || 1);
    const posMed = median(posVals);
    const negMed = median(negVals);
    const { balAcc, tpr, tnr } = balancedAccuracy(posVals, negVals);
    const pVal = permPValue(posVals, negVals);
    const sig = pVal < 0.01 ? " **" : pVal < 0.05 ? " *" : "";
    console.log(
      `${fc.label.padEnd(35)} ${fmt(posMean, 11)} ${fmt(negMean, 11)} ${fmt(posMed, 11)} ${fmt(negMed, 11)} ${(balAcc * 100).toFixed(1).padStart(7)}% ${(tpr * 100).toFixed(0).padStart(5)}% ${(tnr * 100).toFixed(0).padStart(5)}% ${fmtP(pVal).padStart(8)}${sig}`
    );
  }

  for (const fc of boolFeatures) {
    const posRate = earlyPeaks.filter(t => (t[fKey] as any)[fc.key]).length / (earlyPeaks.length || 1);
    const negRate = latePeaks.filter(t => (t[fKey] as any)[fc.key]).length / (latePeaks.length || 1);
    // Balanced accuracy for boolean: try "if true -> predict early"
    const tpr1 = posRate;
    const tnr1 = 1 - negRate;
    const bal1 = (tpr1 + tnr1) / 2;
    const bal2 = ((1 - posRate) + negRate) / 2; // inverse
    const best = bal1 >= bal2 ? { balAcc: bal1, tpr: tpr1, tnr: tnr1, dir: "true=early" } : { balAcc: bal2, tpr: 1 - posRate, tnr: negRate, dir: "false=early" };
    const posNums = earlyPeaks.map(t => (t[fKey] as any)[fc.key] ? 1 : 0);
    const negNums = latePeaks.map(t => (t[fKey] as any)[fc.key] ? 1 : 0);
    const pVal = permPValue(posNums, negNums);
    console.log(
      `${fc.label.padEnd(35)} ${(posRate * 100).toFixed(1).padStart(10)}% ${(negRate * 100).toFixed(1).padStart(10)}% ${"-".padStart(11)} ${"-".padStart(11)} ${(best.balAcc * 100).toFixed(1).padStart(7)}% ${(best.tpr * 100).toFixed(0).padStart(5)}% ${(best.tnr * 100).toFixed(0).padStart(5)}% ${fmtP(pVal).padStart(8)}`
    );
  }
}

// ─── Combo Features ─────────────────────────────────────────────────
console.log(`\n${"─".repeat(95)}`);
console.log("COMBO FEATURES (multiple signals combined)");
console.log(`${"─".repeat(95)}`);

interface ComboResult { name: string; balAcc: number; tpr: number; tnr: number; nEarly: number; nLate: number; earlyFire: number; lateFire: number; }

function testCombo(name: string, testFn: (t: Trade) => boolean): ComboResult {
  const earlyFire = earlyPeaks.filter(testFn).length;
  const lateFire = latePeaks.filter(testFn).length;
  const tpr = earlyFire / (earlyPeaks.length || 1);
  const tnr = (latePeaks.length - lateFire) / (latePeaks.length || 1);
  const bal = (tpr + tnr) / 2;
  // Also try inverse
  const invTpr = (earlyPeaks.length - earlyFire) / (earlyPeaks.length || 1);
  const invTnr = lateFire / (latePeaks.length || 1);
  const invBal = (invTpr + invTnr) / 2;
  if (invBal > bal) {
    return { name: name + " [INV]", balAcc: invBal, tpr: invTpr, tnr: invTnr, nEarly: earlyPeaks.length, nLate: latePeaks.length, earlyFire: earlyPeaks.length - earlyFire, lateFire: latePeaks.length - lateFire };
  }
  return { name, balAcc: bal, tpr, tnr, nEarly: earlyPeaks.length, nLate: latePeaks.length, earlyFire, lateFire };
}

const combos: ComboResult[] = [];

// 6h window combos
combos.push(testCombo("Declining vol (6h)", t => t.feat6h.volTrend < 0));
combos.push(testCombo("Negative acceleration (6h)", t => t.feat6h.accel < 0));
combos.push(testCombo("Low new-highs <15% (6h)", t => t.feat6h.newHighPct < 0.15));
combos.push(testCombo("Low new-highs <10% (6h)", t => t.feat6h.newHighPct < 0.10));
combos.push(testCombo("EMA spread narrowing (6h)", t => t.feat6h.emaSpreadTrend < 0));
combos.push(testCombo("Any large wicks (6h)", t => t.feat6h.largeWickCount >= 1));
combos.push(testCombo("2+ large wicks (6h)", t => t.feat6h.largeWickCount >= 2));
combos.push(testCombo("RSI divergence (6h)", t => t.feat6h.rsiDivergence));
combos.push(testCombo("Overextended price/EMA >1.02 (6h)", t => t.feat6h.priceToEmaRatio > 1.02));
combos.push(testCombo("Range contracting <0.8 (6h)", t => t.feat6h.rangeExpansion < 0.8));
combos.push(testCombo("Range expanding >1.5 (6h)", t => t.feat6h.rangeExpansion > 1.5));

// 24h window combos
combos.push(testCombo("Declining vol (24h)", t => t.feat24h.volTrend < 0));
combos.push(testCombo("Negative acceleration (24h)", t => t.feat24h.accel < 0));
combos.push(testCombo("RSI divergence (24h)", t => t.feat24h.rsiDivergence));
combos.push(testCombo("Low new-highs <10% (24h)", t => t.feat24h.newHighPct < 0.10));
combos.push(testCombo("EMA spread narrowing (24h)", t => t.feat24h.emaSpreadTrend < 0));
combos.push(testCombo("Overextended price/EMA >1.02 (24h)", t => t.feat24h.priceToEmaRatio > 1.02));
combos.push(testCombo("Range contracting <0.8 (24h)", t => t.feat24h.rangeExpansion < 0.8));

// Multi-signal combos
combos.push(testCombo("Vol down + decel (6h)", t => t.feat6h.volTrend < 0 && t.feat6h.accel < 0));
combos.push(testCombo("Vol down + low newHigh<15% (6h)", t => t.feat6h.volTrend < 0 && t.feat6h.newHighPct < 0.15));
combos.push(testCombo("Decel + EMA narrowing (6h)", t => t.feat6h.accel < 0 && t.feat6h.emaSpreadTrend < 0));
combos.push(testCombo("Decel + wicks (6h)", t => t.feat6h.accel < 0 && t.feat6h.largeWickCount >= 1));
combos.push(testCombo("RSI div + decel (24h)", t => t.feat24h.rsiDivergence && t.feat24h.accel < 0));
combos.push(testCombo("RSI div + EMA narrow (24h)", t => t.feat24h.rsiDivergence && t.feat24h.emaSpreadTrend < 0));
combos.push(testCombo("Low newHigh + wicks (6h)", t => t.feat6h.newHighPct < 0.15 && t.feat6h.largeWickCount >= 1));
combos.push(testCombo("Overextended + decel (6h)", t => t.feat6h.priceToEmaRatio > 1.02 && t.feat6h.accel < 0));
combos.push(testCombo("Overextended + vol down (6h)", t => t.feat6h.priceToEmaRatio > 1.02 && t.feat6h.volTrend < 0));
combos.push(testCombo("Range contract + decel (6h)", t => t.feat6h.rangeExpansion < 0.8 && t.feat6h.accel < 0));
combos.push(testCombo("3-signal: vol+decel+EMA (6h)", t => t.feat6h.volTrend < 0 && t.feat6h.accel < 0 && t.feat6h.emaSpreadTrend < 0));
combos.push(testCombo("3-signal: decel+lowNH+wicks (6h)", t => t.feat6h.accel < 0 && t.feat6h.newHighPct < 0.15 && t.feat6h.largeWickCount >= 1));
combos.push(testCombo("Kitchen sink 6h (4 signals)", t =>
  t.feat6h.volTrend < 0 && t.feat6h.accel < 0 && t.feat6h.newHighPct < 0.15 && t.feat6h.emaSpreadTrend < 0));

// SECOND CLASSIFICATION: use giveback % directly as continuous
// Find trades where giveback > 50% (regardless of peak timing)
const highGiveback = allTrades.filter(t => t.givebackFromPeak > 50);
const lowGiveback = allTrades.filter(t => t.givebackFromPeak < 20);
console.log(`\n  (Also testing against giveback classification: >50% giveback: ${highGiveback.length}, <20%: ${lowGiveback.length})`);

combos.push(testComboAlt("Decel (6h) [giveback]", t => t.feat6h.accel < 0, highGiveback, lowGiveback));
combos.push(testComboAlt("Low newHigh<15% (6h) [giveback]", t => t.feat6h.newHighPct < 0.15, highGiveback, lowGiveback));
combos.push(testComboAlt("RSI div (24h) [giveback]", t => t.feat24h.rsiDivergence, highGiveback, lowGiveback));
combos.push(testComboAlt("Vol down (6h) [giveback]", t => t.feat6h.volTrend < 0, highGiveback, lowGiveback));
combos.push(testComboAlt("Overextended >1.02 (6h) [giveback]", t => t.feat6h.priceToEmaRatio > 1.02, highGiveback, lowGiveback));
combos.push(testComboAlt("Range contract <0.8 (6h) [giveback]", t => t.feat6h.rangeExpansion < 0.8, highGiveback, lowGiveback));

function testComboAlt(name: string, testFn: (t: Trade) => boolean, pos: Trade[], neg: Trade[]): ComboResult {
  const posFire = pos.filter(testFn).length;
  const negFire = neg.filter(testFn).length;
  const tpr = posFire / (pos.length || 1);
  const tnr = (neg.length - negFire) / (neg.length || 1);
  const bal = (tpr + tnr) / 2;
  const invBal = ((1 - tpr) + (1 - tnr)) / 2;
  // invBal = 1 - bal, so just check if bal < 0.5
  if (bal < 0.5) {
    return { name: name + " [INV]", balAcc: 1 - bal, tpr: 1 - tpr, tnr: 1 - tnr, nEarly: pos.length, nLate: neg.length, earlyFire: pos.length - posFire, lateFire: neg.length - negFire };
  }
  return { name, balAcc: bal, tpr, tnr, nEarly: pos.length, nLate: neg.length, earlyFire: posFire, lateFire: negFire };
}

console.log(`\n${"Combo".padEnd(45)} ${"BalAcc".padStart(8)} ${"TPR".padStart(6)} ${"TNR".padStart(6)} ${"Fire/Early".padStart(12)} ${"Fire/Late".padStart(11)}`);
console.log("-".repeat(90));

for (const c of combos.sort((a, b) => b.balAcc - a.balAcc)) {
  const sig = c.balAcc >= 0.60 ? " <<" : "";
  console.log(
    `${c.name.padEnd(45)} ${(c.balAcc * 100).toFixed(1).padStart(7)}% ${(c.tpr * 100).toFixed(0).padStart(5)}% ${(c.tnr * 100).toFixed(0).padStart(5)}% ${`${c.earlyFire}/${c.nEarly}`.padStart(12)} ${`${c.lateFire}/${c.nLate}`.padStart(11)}${sig}`
  );
}

// ─── Distribution Plots ─────────────────────────────────────────────
console.log(`\n${"─".repeat(95)}`);
console.log("DISTRIBUTIONS - % bars making new highs (6h before peak)");
console.log(`${"─".repeat(95)}`);
printDistribution(
  earlyPeaks.map(t => t.feat6h.newHighPct),
  latePeaks.map(t => t.feat6h.newHighPct),
  [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.60, 1.0],
  "early", "late",
);

console.log(`\n${"─".repeat(95)}`);
console.log("DISTRIBUTIONS - Price acceleration (6h before peak)");
console.log(`${"─".repeat(95)}`);
printDistribution(
  earlyPeaks.map(t => t.feat6h.accel * 1e5),
  latePeaks.map(t => t.feat6h.accel * 1e5),
  [-50, -10, -5, -2, -1, 0, 1, 2, 5, 10, 50],
  "early", "late",
);

console.log(`\n${"─".repeat(95)}`);
console.log("DISTRIBUTIONS - Volume trend (6h before peak)");
console.log(`${"─".repeat(95)}`);
printDistribution(
  earlyPeaks.map(t => t.feat6h.volTrend * 1000),
  latePeaks.map(t => t.feat6h.volTrend * 1000),
  [-20, -5, -2, -1, 0, 1, 2, 5, 10, 20],
  "early", "late",
);

console.log(`\n${"─".repeat(95)}`);
console.log("DISTRIBUTIONS - Price/EMA(9) ratio (6h before peak)");
console.log(`${"─".repeat(95)}`);
printDistribution(
  earlyPeaks.map(t => t.feat6h.priceToEmaRatio),
  latePeaks.map(t => t.feat6h.priceToEmaRatio),
  [0.95, 0.98, 0.99, 1.0, 1.005, 1.01, 1.015, 1.02, 1.03, 1.05, 1.10],
  "early", "late",
);

console.log(`\n${"─".repeat(95)}`);
console.log("DISTRIBUTIONS - Range expansion ratio (6h)");
console.log(`${"─".repeat(95)}`);
printDistribution(
  earlyPeaks.map(t => t.feat6h.rangeExpansion),
  latePeaks.map(t => t.feat6h.rangeExpansion),
  [0, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0, 10.0],
  "early", "late",
);

console.log(`\n${"─".repeat(95)}`);
console.log("DISTRIBUTIONS - RSI divergence rate");
console.log(`${"─".repeat(95)}`);
const earlyDiv6 = earlyPeaks.filter(t => t.feat6h.rsiDivergence).length;
const lateDiv6 = latePeaks.filter(t => t.feat6h.rsiDivergence).length;
const earlyDiv24 = earlyPeaks.filter(t => t.feat24h.rsiDivergence).length;
const lateDiv24 = latePeaks.filter(t => t.feat24h.rsiDivergence).length;
console.log(`  RSI div (6h):  Early: ${earlyDiv6}/${earlyPeaks.length} = ${(earlyDiv6 / earlyPeaks.length * 100).toFixed(1)}%   Late: ${lateDiv6}/${latePeaks.length} = ${(lateDiv6 / latePeaks.length * 100).toFixed(1)}%`);
console.log(`  RSI div (24h): Early: ${earlyDiv24}/${earlyPeaks.length} = ${(earlyDiv24 / earlyPeaks.length * 100).toFixed(1)}%   Late: ${lateDiv24}/${latePeaks.length} = ${(lateDiv24 / latePeaks.length * 100).toFixed(1)}%`);

// ─── Per-Pair ───────────────────────────────────────────────────────
console.log(`\n${"─".repeat(95)}`);
console.log("PER-PAIR BREAKDOWN");
console.log(`${"─".repeat(95)}`);
console.log(`${"Pair".padEnd(8)} ${"Total".padStart(7)} ${"Early%".padStart(8)} ${"Late%".padStart(8)} ${"EarlyPnl".padStart(10)} ${"LatePnl".padStart(10)} ${"AvgPeakMove".padStart(13)} ${"AvgPeakFrac".padStart(13)}`);
console.log("-".repeat(80));

for (const pair of PAIRS) {
  const pt = allTrades.filter(t => t.pair === pair);
  if (pt.length === 0) continue;
  const pe = pt.filter(t => t.classification === "early_peak");
  const pl = pt.filter(t => t.classification === "late_peak");
  const ePnl = pe.reduce((s, t) => s + t.pnl, 0) / (pe.length || 1);
  const lPnl = pl.reduce((s, t) => s + t.pnl, 0) / (pl.length || 1);
  const avgPeak = pt.reduce((s, t) => s + t.peakPctFromEntry, 0) / pt.length;
  const avgFrac = pt.reduce((s, t) => s + t.peakTimeFraction, 0) / pt.length;
  console.log(
    `${pair.padEnd(8)} ${String(pt.length).padStart(7)} ${(pe.length / pt.length * 100).toFixed(1).padStart(7)}% ${(pl.length / pt.length * 100).toFixed(1).padStart(7)}% ${("$" + ePnl.toFixed(2)).padStart(10)} ${("$" + lPnl.toFixed(2)).padStart(10)} ${(avgPeak.toFixed(1) + "%").padStart(13)} ${avgFrac.toFixed(2).padStart(13)}`
  );
}

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(95)}`);
console.log("SUMMARY");
console.log(`${"=".repeat(95)}`);

const actionable = combos.filter(c => c.balAcc >= 0.55).sort((a, b) => b.balAcc - a.balAcc);
if (actionable.length > 0) {
  console.log(`\nFeatures/combos with balanced accuracy >= 55%:`);
  for (const c of actionable.slice(0, 15)) {
    console.log(`  ${(c.balAcc * 100).toFixed(1)}%  TPR=${(c.tpr * 100).toFixed(0)}% TNR=${(c.tnr * 100).toFixed(0)}%  ${c.name}`);
  }
} else {
  console.log("\nNo feature or combo reached 55% balanced accuracy.");
}

const anyAbove60 = combos.filter(c => c.balAcc >= 0.60);
console.log(`\nFeatures with balanced accuracy >= 60%: ${anyAbove60.length}`);
if (anyAbove60.length > 0) {
  for (const c of anyAbove60.sort((a, b) => b.balAcc - a.balAcc)) {
    console.log(`  ${(c.balAcc * 100).toFixed(1)}%  ${c.name}`);
  }
} else {
  console.log("  None - the pre-peak window does not reliably distinguish early from late peaks.");
}

console.log(`\nConclusion: Early-peak trades (trend failures) have avg P&L $${(earlyPeaks.reduce((s, t) => s + t.pnl, 0) / (earlyPeaks.length || 1)).toFixed(2)}`);
console.log(`           Late-peak trades (trend runs) have avg P&L $${(latePeaks.reduce((s, t) => s + t.pnl, 0) / (latePeaks.length || 1)).toFixed(2)}`);
console.log(`           ${allTrades.length} trades across ${PAIRS.length} pairs, ${(allTrades[0]?.et ? new Date(Math.min(...allTrades.map(t => t.et))).toISOString().slice(0, 10) : "?")} to ${(allTrades[0]?.xt ? new Date(Math.max(...allTrades.map(t => t.xt))).toISOString().slice(0, 10) : "?")}`);

// ─── Helpers ────────────────────────────────────────────────────────
function fmt(v: number, w: number): string {
  if (v === 0) return "0".padStart(w);
  if (Math.abs(v) < 0.0001) return v.toExponential(2).padStart(w);
  if (Math.abs(v) >= 100) return v.toFixed(1).padStart(w);
  if (Math.abs(v) >= 1) return v.toFixed(4).padStart(w);
  return v.toFixed(6).padStart(w);
}

function fmtP(p: number): string {
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

function printDistribution(posVals: number[], negVals: number[], buckets: number[], posLabel: string, negLabel: string) {
  console.log(`${"Bucket".padEnd(18)} ${posLabel.padStart(10)} ${negLabel.padStart(10)} ${(posLabel + "/(total)").padStart(15)}`);
  for (let b = 0; b < buckets.length - 1; b++) {
    const lo = buckets[b], hi = buckets[b + 1];
    const pc = posVals.filter(v => v >= lo && v < hi).length;
    const nc = negVals.filter(v => v >= lo && v < hi).length;
    const tot = pc + nc;
    const pct = tot > 0 ? (pc / tot * 100).toFixed(1) + "%" : "-";
    console.log(
      `${`[${lo},${hi})`.padEnd(18)} ${String(pc).padStart(10)} ${String(nc).padStart(10)} ${pct.padStart(15)}`
    );
  }
}
