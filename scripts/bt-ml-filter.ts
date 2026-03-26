/**
 * ML Feature Filter for Supertrend(14,2) 4h signals
 *
 * Score each Supertrend flip signal with 8 features, trade only
 * signals above threshold. Compare loose->strict filters OOS.
 * Feature importance: avg P&L when feature true vs false.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 5; // $5 margin
const NOT = SIZE * LEV; // $50 notional
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const HOUR = 3600000;

const FULL_START = new Date("2023-01-01").getTime();
const OOS_START = new Date("2025-09-01").getTime();
const END = new Date("2026-03-20").getTime();

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE",
  "APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface FeatureVec {
  adxGood: boolean;
  atrNotExtreme: boolean;
  rsiAgrees: boolean;
  bbNarrow: boolean;
  volumeHigh: boolean;
  btcCorr: boolean;
  noRecentSL: boolean;
  emaAgrees: boolean;
  score: number;
}
interface ScoredTrade {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
  features: FeatureVec;
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
  const barsPerGroup = 48; // 48 x 5m = 4h
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
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j-1].c), Math.abs(cs[j].l - cs[j-1].c));
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
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
      ema[i] = values[i] * k + ema[i-1] * (1 - k);
    }
  }
  return ema;
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
      const prevUpper = (cs[i-1].h + cs[i-1].l) / 2 + mult * atr[i-1];
      const prevLower = (cs[i-1].h + cs[i-1].l) / 2 - mult * atr[i-1];
      const prevFinalUpper = st[i-1] > 0 && dirs[i-1] === -1 ? st[i-1] : prevUpper;
      const prevFinalLower = st[i-1] > 0 && dirs[i-1] === 1 ? st[i-1] : prevLower;

      if (!(lowerBand > prevFinalLower || cs[i-1].c < prevFinalLower)) {
        lowerBand = prevFinalLower;
      }
      if (!(upperBand < prevFinalUpper || cs[i-1].c > prevFinalUpper)) {
        upperBand = prevFinalUpper;
      }
    }

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i-1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }

    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
}

function calcADX(cs: C[], period: number): number[] {
  const adx = new Array(cs.length).fill(0);
  const trArr = new Array(cs.length).fill(0);
  const dmPlus = new Array(cs.length).fill(0);
  const dmMinus = new Array(cs.length).fill(0);

  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
    const upMove = cs[i].h - cs[i-1].h;
    const downMove = cs[i-1].l - cs[i].l;
    trArr[i] = tr;
    dmPlus[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    dmMinus[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }

  const smoothTR = new Array(cs.length).fill(0);
  const smoothDMPlus = new Array(cs.length).fill(0);
  const smoothDMMinus = new Array(cs.length).fill(0);
  const dx = new Array(cs.length).fill(0);

  for (let i = period; i < cs.length; i++) {
    if (i === period) {
      let sumTR = 0, sumDMP = 0, sumDMM = 0;
      for (let j = 1; j <= period; j++) { sumTR += trArr[j]; sumDMP += dmPlus[j]; sumDMM += dmMinus[j]; }
      smoothTR[i] = sumTR;
      smoothDMPlus[i] = sumDMP;
      smoothDMMinus[i] = sumDMM;
    } else {
      smoothTR[i] = smoothTR[i-1] - smoothTR[i-1] / period + trArr[i];
      smoothDMPlus[i] = smoothDMPlus[i-1] - smoothDMPlus[i-1] / period + dmPlus[i];
      smoothDMMinus[i] = smoothDMMinus[i-1] - smoothDMMinus[i-1] / period + dmMinus[i];
    }
    const diPlus = smoothTR[i] > 0 ? (smoothDMPlus[i] / smoothTR[i]) * 100 : 0;
    const diMinus = smoothTR[i] > 0 ? (smoothDMMinus[i] / smoothTR[i]) * 100 : 0;
    dx[i] = (diPlus + diMinus) > 0 ? Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100 : 0;
  }

  // Smooth DX to get ADX
  const adxStart = period * 2;
  for (let i = adxStart; i < cs.length; i++) {
    if (i === adxStart) {
      let sum = 0;
      for (let j = period; j < adxStart; j++) sum += dx[j];
      adx[i] = sum / period;
    } else {
      adx[i] = (adx[i-1] * (period - 1) + dx[i]) / period;
    }
  }

  return adx;
}

function calcRSI(cs: C[], period: number): number[] {
  const rsi = new Array(cs.length).fill(50);
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period && i < cs.length; i++) {
    const diff = cs[i].c - cs[i-1].c;
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  if (period < cs.length) {
    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  for (let i = period + 1; i < cs.length; i++) {
    const diff = cs[i].c - cs[i-1].c;
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

function calcBBWidth(cs: C[], period: number): number[] {
  const bbw = new Array(cs.length).fill(0);
  for (let i = period - 1; i < cs.length; i++) {
    let sum = 0, sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += cs[j].c; sumSq += cs[j].c * cs[j].c; }
    const mean = sum / period;
    const std = Math.sqrt(sumSq / period - mean * mean);
    bbw[i] = mean > 0 ? (std * 2 * 2) / mean : 0; // width = 2*2*std / middle
  }
  return bbw;
}

function calcVolume(cs5m: C[], cs4h: C[]): number[] {
  // Approximate volume from 5m range (high-low) as proxy since we lack volume data
  // Use dollar range = (high-low)/close as activity proxy per 4h bar
  const vol = new Array(cs4h.length).fill(0);
  for (let i = 0; i < cs4h.length; i++) {
    vol[i] = cs4h[i].c > 0 ? (cs4h[i].h - cs4h[i].l) / cs4h[i].c : 0;
  }
  return vol;
}

function rollingCorrelation(a: number[], b: number[], i: number, window: number): number {
  if (i < window) return 0;
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let j = i - window; j < i; j++) {
    sumA += a[j]; sumB += b[j]; sumAB += a[j] * b[j];
    sumA2 += a[j] * a[j]; sumB2 += b[j] * b[j];
  }
  const n = window;
  const denom = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
  return denom > 0 ? (n * sumAB - sumA * sumB) / denom : 0;
}

// ─── Cost / PnL ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE_TAKER * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

function calcMetrics(trades: ScoredTrade[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
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
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = (endTs - startTs) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

// ─── Main Strategy + Feature Scoring ──────────────────────────────────
function run() {
  console.log("Loading 5m candles...");

  // Load all data
  const raw5m = new Map<string, C[]>();
  const data4h = new Map<string, C[]>();

  for (const pair of [...PAIRS, "BTC"]) {
    const cs = load5m(pair);
    if (cs.length < 1000) { console.log(`  SKIP ${pair}: only ${cs.length} 5m bars`); continue; }
    raw5m.set(pair, cs);
    data4h.set(pair, aggregateTo4h(cs));
    console.log(`  ${pair}: ${cs.length} 5m -> ${data4h.get(pair)!.length} 4h bars`);
  }

  // Pre-compute all indicators for each pair on 4h data
  console.log("\nComputing indicators...");

  interface PairIndicators {
    cs: C[];
    atr: number[];
    adx: number[];
    rsi: number[];
    bbw: number[];
    vol: number[]; // range proxy
    ema9: number[];
    ema21: number[];
    returns: number[]; // bar-to-bar returns for correlation
  }

  const indicators = new Map<string, PairIndicators>();

  for (const [pair, cs] of data4h) {
    const closes = cs.map(c => c.c);
    const atr = calcATR(cs, 14);
    const adx = calcADX(cs, 14);
    const rsi = calcRSI(cs, 14);
    const bbw = calcBBWidth(cs, 20);
    const vol = calcVolume(raw5m.get(pair)!, cs);
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const rets = new Array(cs.length).fill(0);
    for (let i = 1; i < cs.length; i++) rets[i] = cs[i-1].c > 0 ? (cs[i].c / cs[i-1].c - 1) : 0;

    indicators.set(pair, { cs, atr, adx, rsi, bbw, vol, ema9, ema21, returns: rets });
  }

  const btcInd = indicators.get("BTC");
  if (!btcInd) { console.log("ERROR: No BTC data"); return; }

  // Compute BB width percentiles (rolling 100-bar)
  function bbPercentile(bbw: number[], i: number): number {
    if (i < 100) return 50;
    let count = 0;
    for (let j = i - 100; j < i; j++) {
      if (bbw[j] <= bbw[i]) count++;
    }
    return count;
  }

  // Compute ATR/price ratio percentile (rolling 100-bar)
  function atrPctPercentile(atr: number[], cs: C[], i: number): number {
    if (i < 100 || cs[i].c === 0) return 50;
    const cur = atr[i] / cs[i].c;
    let count = 0;
    for (let j = i - 100; j < i; j++) {
      const val = cs[j].c > 0 ? atr[j] / cs[j].c : 0;
      if (val <= cur) count++;
    }
    return count;
  }

  // ─── Generate ALL Supertrend(14,2) flip signals with features ─────
  console.log("Generating Supertrend(14,2) signals with features...\n");

  // Track last SL time per pair for feature #7
  const lastSLTime = new Map<string, number>();

  const allTrades: ScoredTrade[] = [];

  for (const pair of PAIRS) {
    const ind = indicators.get(pair);
    if (!ind) continue;
    const cs = ind.cs;
    if (cs.length < 50) continue;

    const { dir } = calcSupertrend(cs, 14, 2);
    const atr = ind.atr;

    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number; features: FeatureVec } | null = null;

    for (let i = 30; i < cs.length; i++) {
      if (cs[i].t > END && !pos) continue;

      const prevDir = dir[i - 1];
      const prevPrevDir = i >= 2 ? dir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // Check exit for existing position
      if (pos) {
        const bar = cs[i];
        let xp = 0, reason = "";

        // SL check (ATR-based, capped 3.5%)
        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl; reason = "sl";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl; reason = "sl";
        }

        // Supertrend flip exit
        if (!xp && flipped) {
          xp = bar.o; reason = "flip";
        }

        // Max hold 48h (12 x 4h bars)
        if (!xp && i - 12 >= 0 && cs[i].t - pos.et >= 48 * HOUR) {
          xp = bar.c; reason = "mh";
        }

        if (xp > 0) {
          const isSL = reason === "sl";
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, isSL);
          if (pos.et >= FULL_START) {
            allTrades.push({
              pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason,
              features: pos.features,
            });
          }
          if (isSL) lastSLTime.set(pair, bar.t);
          pos = null;
        }
      }

      // New entry on flip
      if (!pos && flipped && cs[i].t >= FULL_START && cs[i].t < END) {
        const newDir: "long"|"short" = prevDir === 1 ? "long" : "short";
        const ep = cs[i].o;

        // Compute SL: ATR-based, capped at 3.5%
        const curATR = atr[i - 1] > 0 ? atr[i - 1] : atr[i];
        const atrSL = curATR * 3;
        const maxSL = ep * 0.035;
        const slDist = Math.min(atrSL, maxSL);
        const sl = newDir === "long" ? ep - slDist : ep + slDist;

        // ─── Feature computation at entry time (bar i-1 is last complete bar) ─────
        const bi = i - 1; // use prior completed bar

        // F1: ADX > 20
        const adxVal = ind.adx[bi] || 0;
        const adxGood = adxVal > 20;

        // F2: ATR ratio < 80th percentile (not extremely volatile)
        const atrPctile = atrPctPercentile(ind.atr, cs, bi);
        const atrNotExtreme = atrPctile < 80;

        // F3: RSI agrees with direction
        const rsiVal = ind.rsi[bi] || 50;
        const rsiAgrees = newDir === "long" ? rsiVal > 50 : rsiVal < 50;

        // F4: BB width < 50th percentile
        const bbPctile = bbPercentile(ind.bbw, bi);
        const bbNarrow = bbPctile < 50;

        // F5: Volume (range proxy) > 1.2x 20-bar average
        let vol20Avg = 0;
        if (bi >= 20) {
          let sum = 0;
          for (let j = bi - 20; j < bi; j++) sum += ind.vol[j];
          vol20Avg = sum / 20;
        }
        const volumeHigh = vol20Avg > 0 && ind.vol[bi] > 1.2 * vol20Avg;

        // F6: BTC correlation > 0.3 (20-bar rolling)
        let btcCorr = 0;
        if (btcInd && bi >= 20) {
          // Find closest BTC bar by timestamp
          const targetT = cs[bi].t;
          let btcIdx = -1;
          for (let b = btcInd.cs.length - 1; b >= 0; b--) {
            if (btcInd.cs[b].t <= targetT) { btcIdx = b; break; }
          }
          if (btcIdx >= 20) {
            // Compute returns for pair at matching window
            btcCorr = rollingCorrelation(ind.returns, btcInd.returns, Math.min(bi, btcIdx) + 1, 20);
          }
        }
        const btcCorrGood = btcCorr > 0.3;

        // F7: No SL in last 24h on this pair
        const lastSL = lastSLTime.get(pair) ?? 0;
        const noRecentSL = (cs[i].t - lastSL) > 24 * HOUR;

        // F8: EMA 9 > 21 agrees with direction
        const e9 = ind.ema9[bi] || 0;
        const e21 = ind.ema21[bi] || 0;
        const emaAgrees = newDir === "long" ? e9 > e21 : e9 < e21;

        const score = (adxGood ? 1 : 0) + (atrNotExtreme ? 1 : 0) + (rsiAgrees ? 1 : 0) +
          (bbNarrow ? 1 : 0) + (volumeHigh ? 1 : 0) + (btcCorrGood ? 1 : 0) +
          (noRecentSL ? 1 : 0) + (emaAgrees ? 1 : 0);

        const features: FeatureVec = {
          adxGood, atrNotExtreme, rsiAgrees, bbNarrow, volumeHigh,
          btcCorr: btcCorrGood, noRecentSL, emaAgrees, score,
        };

        pos = { dir: newDir, ep, et: cs[i].t, sl, features };
      }
    }

    // Close open position at end
    if (pos && pos.et >= FULL_START) {
      const lastBar = cs[cs.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      allTrades.push({
        pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end",
        features: pos.features,
      });
    }
  }

  // Sort all trades by exit time
  allTrades.sort((a, b) => a.xt - b.xt);

  const isTrades = allTrades.filter(t => t.et < OOS_START);
  const oosTrades = allTrades.filter(t => t.et >= OOS_START);

  console.log(`Total trades: ${allTrades.length} (IS: ${isTrades.length}, OOS: ${oosTrades.length})`);
  console.log(`IS period: 2023-01 to 2025-09 | OOS period: 2025-09 to 2026-03`);

  // ─── Score distribution ────────────────────────────────────────────
  console.log("\n=== SCORE DISTRIBUTION (all trades) ===");
  for (let s = 0; s <= 8; s++) {
    const isCount = isTrades.filter(t => t.features.score === s).length;
    const oosCount = oosTrades.filter(t => t.features.score === s).length;
    const isPnl = isTrades.filter(t => t.features.score === s).reduce((a, t) => a + t.pnl, 0);
    const oosPnl = oosTrades.filter(t => t.features.score === s).reduce((a, t) => a + t.pnl, 0);
    console.log(`  Score ${s}: IS ${String(isCount).padStart(5)} trades, $${isPnl.toFixed(2).padStart(8)} | OOS ${String(oosCount).padStart(4)} trades, $${oosPnl.toFixed(2).padStart(8)}`);
  }

  // ─── Threshold tests ──────────────────────────────────────────────
  console.log("\n=== OOS RESULTS BY THRESHOLD ===");
  console.log("Threshold   Trades  WR%    PF     Sharpe  $/day    MaxDD    Total");
  console.log("-".repeat(80));

  const thresholds = [0, 3, 4, 5, 6, 7];
  for (const thresh of thresholds) {
    const filtered = oosTrades.filter(t => t.features.score >= thresh);
    const m = calcMetrics(filtered, OOS_START, END);
    const label = thresh === 0 ? "No filter" : `Score >= ${thresh}`;
    console.log(
      `${label.padEnd(12)}${String(m.n).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(6)}  ${("$" + m.perDay.toFixed(2)).padStart(7)}  ${("$" + m.dd.toFixed(0)).padStart(7)}  ${(m.total >= 0 ? "+$" + m.total.toFixed(0) : "-$" + Math.abs(m.total).toFixed(0)).padStart(7)}`
    );
  }

  // ─── IS Comparison ────────────────────────────────────────────────
  console.log("\n=== IS RESULTS BY THRESHOLD (for comparison) ===");
  console.log("Threshold   Trades  WR%    PF     Sharpe  $/day    MaxDD    Total");
  console.log("-".repeat(80));

  for (const thresh of thresholds) {
    const filtered = isTrades.filter(t => t.features.score >= thresh);
    const m = calcMetrics(filtered, FULL_START, OOS_START);
    const label = thresh === 0 ? "No filter" : `Score >= ${thresh}`;
    console.log(
      `${label.padEnd(12)}${String(m.n).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(6)}  ${("$" + m.perDay.toFixed(2)).padStart(7)}  ${("$" + m.dd.toFixed(0)).padStart(7)}  ${(m.total >= 0 ? "+$" + m.total.toFixed(0) : "-$" + Math.abs(m.total).toFixed(0)).padStart(7)}`
    );
  }

  // ─── Feature importance ───────────────────────────────────────────
  console.log("\n=== FEATURE IMPORTANCE (OOS) ===");
  console.log("Feature          True   AvgPnL   False  AvgPnL   Diff     WR(T)  WR(F)");
  console.log("-".repeat(80));

  const featureNames: { key: keyof FeatureVec; label: string }[] = [
    { key: "adxGood", label: "ADX > 20" },
    { key: "atrNotExtreme", label: "ATR < 80pct" },
    { key: "rsiAgrees", label: "RSI agrees" },
    { key: "bbNarrow", label: "BB < 50pct" },
    { key: "volumeHigh", label: "Vol > 1.2x" },
    { key: "btcCorr", label: "BTC corr>0.3" },
    { key: "noRecentSL", label: "No recent SL" },
    { key: "emaAgrees", label: "EMA 9>21 ok" },
  ];

  for (const feat of featureNames) {
    const trueT = oosTrades.filter(t => t.features[feat.key] === true);
    const falseT = oosTrades.filter(t => t.features[feat.key] === false);
    const trueAvg = trueT.length > 0 ? trueT.reduce((s, t) => s + t.pnl, 0) / trueT.length : 0;
    const falseAvg = falseT.length > 0 ? falseT.reduce((s, t) => s + t.pnl, 0) / falseT.length : 0;
    const trueWR = trueT.length > 0 ? trueT.filter(t => t.pnl > 0).length / trueT.length * 100 : 0;
    const falseWR = falseT.length > 0 ? falseT.filter(t => t.pnl > 0).length / falseT.length * 100 : 0;
    const diff = trueAvg - falseAvg;
    console.log(
      `${feat.label.padEnd(17)}${String(trueT.length).padStart(5)}  ${("$" + trueAvg.toFixed(3)).padStart(8)}  ${String(falseT.length).padStart(5)}  ${("$" + falseAvg.toFixed(3)).padStart(8)}  ${(diff >= 0 ? "+" : "") + "$" + diff.toFixed(3)}  ${trueWR.toFixed(1).padStart(5)}%  ${falseWR.toFixed(1).padStart(5)}%`
    );
  }

  // ─── IS Feature importance (for cross-validation) ──────────────────
  console.log("\n=== FEATURE IMPORTANCE (IS) ===");
  console.log("Feature          True   AvgPnL   False  AvgPnL   Diff     WR(T)  WR(F)");
  console.log("-".repeat(80));

  for (const feat of featureNames) {
    const trueT = isTrades.filter(t => t.features[feat.key] === true);
    const falseT = isTrades.filter(t => t.features[feat.key] === false);
    const trueAvg = trueT.length > 0 ? trueT.reduce((s, t) => s + t.pnl, 0) / trueT.length : 0;
    const falseAvg = falseT.length > 0 ? falseT.reduce((s, t) => s + t.pnl, 0) / falseT.length : 0;
    const trueWR = trueT.length > 0 ? trueT.filter(t => t.pnl > 0).length / trueT.length * 100 : 0;
    const falseWR = falseT.length > 0 ? falseT.filter(t => t.pnl > 0).length / falseT.length * 100 : 0;
    const diff = trueAvg - falseAvg;
    console.log(
      `${feat.label.padEnd(17)}${String(trueT.length).padStart(5)}  ${("$" + trueAvg.toFixed(3)).padStart(8)}  ${String(falseT.length).padStart(5)}  ${("$" + falseAvg.toFixed(3)).padStart(8)}  ${(diff >= 0 ? "+" : "") + "$" + diff.toFixed(3)}  ${trueWR.toFixed(1).padStart(5)}%  ${falseWR.toFixed(1).padStart(5)}%`
    );
  }

  // ─── Long vs Short breakdown for best threshold ────────────────────
  console.log("\n=== LONG vs SHORT BREAKDOWN (OOS, Score >= 4) ===");
  const best = oosTrades.filter(t => t.features.score >= 4);
  const longs = best.filter(t => t.dir === "long");
  const shorts = best.filter(t => t.dir === "short");

  const mLong = calcMetrics(longs, OOS_START, END);
  const mShort = calcMetrics(shorts, OOS_START, END);
  console.log(`  Long:  ${mLong.n} trades, WR ${mLong.wr.toFixed(1)}%, PF ${mLong.pf.toFixed(2)}, $${mLong.perDay.toFixed(2)}/day, MaxDD $${mLong.dd.toFixed(0)}`);
  console.log(`  Short: ${mShort.n} trades, WR ${mShort.wr.toFixed(1)}%, PF ${mShort.pf.toFixed(2)}, $${mShort.perDay.toFixed(2)}/day, MaxDD $${mShort.dd.toFixed(0)}`);

  // ─── Per-pair OOS breakdown at threshold 4 ─────────────────────────
  console.log("\n=== PER-PAIR OOS BREAKDOWN (Score >= 4) ===");
  console.log("Pair      Trades  WR%    PF     $/day    Total");
  console.log("-".repeat(55));

  for (const pair of PAIRS) {
    const pt = best.filter(t => t.pair === pair);
    if (pt.length === 0) continue;
    const pm = calcMetrics(pt, OOS_START, END);
    console.log(
      `${pair.padEnd(10)}${String(pm.n).padStart(5)}  ${pm.wr.toFixed(1).padStart(5)}  ${pm.pf.toFixed(2).padStart(5)}  ${("$" + pm.perDay.toFixed(2)).padStart(7)}  ${(pm.total >= 0 ? "+$" + pm.total.toFixed(0) : "-$" + Math.abs(pm.total).toFixed(0)).padStart(7)}`
    );
  }

  // ─── Exit reason breakdown ─────────────────────────────────────────
  console.log("\n=== EXIT REASON BREAKDOWN (OOS, Score >= 4) ===");
  const reasons = new Map<string, { n: number; pnl: number; wins: number }>();
  for (const t of best) {
    const r = reasons.get(t.reason) ?? { n: 0, pnl: 0, wins: 0 };
    r.n++; r.pnl += t.pnl; if (t.pnl > 0) r.wins++;
    reasons.set(t.reason, r);
  }
  for (const [reason, data] of [...reasons.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${reason.padEnd(8)} ${String(data.n).padStart(5)} trades, WR ${(data.wins / data.n * 100).toFixed(1)}%, total $${data.pnl.toFixed(2)}`);
  }

  // ─── Monthly OOS equity curve for Score >= 4 ──────────────────────
  console.log("\n=== MONTHLY OOS EQUITY (Score >= 4) ===");
  const monthly = new Map<string, { pnl: number; trades: number }>();
  for (const t of best) {
    const d = new Date(t.xt);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const m = monthly.get(key) ?? { pnl: 0, trades: 0 };
    m.pnl += t.pnl; m.trades++;
    monthly.set(key, m);
  }
  let cumPnl = 0;
  for (const [month, data] of [...monthly.entries()].sort()) {
    cumPnl += data.pnl;
    const bar = data.pnl >= 0 ? "+".repeat(Math.min(Math.round(data.pnl / 0.5), 40)) : "-".repeat(Math.min(Math.round(Math.abs(data.pnl) / 0.5), 40));
    console.log(`  ${month}  ${String(data.trades).padStart(3)} trades  ${(data.pnl >= 0 ? "+" : "") + "$" + data.pnl.toFixed(2)}  cum: $${cumPnl.toFixed(2)}  ${bar}`);
  }

  console.log("\nDone.");
}

run();
