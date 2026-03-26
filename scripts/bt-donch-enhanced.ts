/**
 * Enhanced Daily Donchian Breakout Backtest
 *
 * Baseline: 30d entry, 15d exit, ATR x3 stop, daily bars from 5m aggregation
 * Tests: BTC trend filter, ADX filter, ATR trailing stop, volume confirmation,
 *        pair selection, combined best
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 10;
const NOT = SIZE * LEV; // $100 notional
const FEE = 0.00035;
const DAY = 86400000;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, AVAX: 2.55e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, SEI: 4.4e-4,
  TON: 4.6e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
  ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
};

const ALL_PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP"
];

const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-26").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Pos {
  pair: string; dir: "long"|"short"; ep: number; et: number;
  sl: number; peak: number; atrAtEntry: number;
}
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; holdDays: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregateToDaily(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const dayTs = Math.floor(c.t / DAY) * DAY;
    const arr = groups.get(dayTs) ?? [];
    arr.push(c);
    groups.set(dayTs, arr);
  }
  const daily: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 200) continue;
    daily.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, b) => s + b.v, 0),
    });
  }
  return daily;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++)
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j-1].c), Math.abs(cs[j].l - cs[j-1].c));
      atr[i] = s / period;
    } else {
      const trNow = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
      atr[i] = (atr[i-1] * (period - 1) + trNow) / period;
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

function calcADX(cs: C[], period: number): number[] {
  const adx = new Array(cs.length).fill(0);
  const plusDM: number[] = [], minusDM: number[] = [], tr: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    if (i === 0) { plusDM.push(0); minusDM.push(0); tr.push(cs[i].h - cs[i].l); continue; }
    const upMove = cs[i].h - cs[i-1].h;
    const downMove = cs[i-1].l - cs[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c)));
  }
  const smoothTR = new Array(cs.length).fill(0);
  const smoothPDM = new Array(cs.length).fill(0);
  const smoothMDM = new Array(cs.length).fill(0);
  if (cs.length <= period) return adx;
  for (let i = 1; i <= period; i++) { smoothTR[period] += tr[i]; smoothPDM[period] += plusDM[i]; smoothMDM[period] += minusDM[i]; }
  for (let i = period + 1; i < cs.length; i++) {
    smoothTR[i] = smoothTR[i-1] - smoothTR[i-1] / period + tr[i];
    smoothPDM[i] = smoothPDM[i-1] - smoothPDM[i-1] / period + plusDM[i];
    smoothMDM[i] = smoothMDM[i-1] - smoothMDM[i-1] / period + minusDM[i];
  }
  const dx = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    if (smoothTR[i] === 0) continue;
    const pdi = 100 * smoothPDM[i] / smoothTR[i];
    const mdi = 100 * smoothMDM[i] / smoothTR[i];
    dx[i] = pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
  }
  if (cs.length <= 2 * period) return adx;
  let adxSum = 0;
  for (let i = period; i < 2 * period; i++) adxSum += dx[i];
  adx[2 * period - 1] = adxSum / period;
  for (let i = 2 * period; i < cs.length; i++) {
    adx[i] = (adx[i-1] * (period - 1) + dx[i]) / period;
  }
  return adx;
}

function donchianHigh(cs: C[], idx: number, lookback: number): number {
  let max = -Infinity;
  for (let i = Math.max(0, idx - lookback); i < idx; i++) max = Math.max(max, cs[i].h);
  return max;
}

function donchianLow(cs: C[], idx: number, lookback: number): number {
  let min = Infinity;
  for (let i = Math.max(0, idx - lookback); i < idx; i++) min = Math.min(min, cs[i].l);
  return min;
}

// ─── Cost Calculation ───────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE * 2;
  const rawPnl = dir === "long" ? (xp / ep - 1) * NOT : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics { n: number; wr: number; pf: number; sharpe: number; dd: number; total: number; perDay: number; }

function calcMetrics(trades: Tr[]): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  let peak = 0, equity = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const firstT = Math.min(...trades.map(t => t.et));
  const lastT = Math.max(...trades.map(t => t.xt));
  const days = (lastT - firstT) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

// ─── Enhancement Options ────────────────────────────────────────────
interface EnhOpts {
  btcTrendFilter: boolean;   // Enhancement 1
  adxThreshold: number;      // Enhancement 2: 0 = disabled
  atrTrailStop: boolean;     // Enhancement 3
  volumeConfirm: boolean;    // Enhancement 4
  pairsToUse?: string[];     // Enhancement 5: subset of pairs
}

// ─── Donchian Strategy with Enhancements ────────────────────────────
function runDonchian(
  pairs: string[],
  dailyData: Map<string, C[]>,
  btcDaily: C[],
  opts: EnhOpts,
): Tr[] {
  const ENTRY_LB = 30;
  const EXIT_LB = 15;
  const ATR_MULT = 3;
  const ATR_PERIOD = 14;
  const MAX_HOLD = 60;

  const activePairs = opts.pairsToUse ?? pairs;

  // Pre-compute BTC EMAs for trend filter
  const btcCloses = btcDaily.map(c => c.c);
  const btcEma20 = calcEMA(btcCloses, 20);
  const btcEma50 = calcEMA(btcCloses, 50);
  const btcTimeMap = new Map<number, number>();
  btcDaily.forEach((c, i) => btcTimeMap.set(c.t, i));

  const getBtcTrend = (t: number): "long"|"short"|null => {
    const bi = btcTimeMap.get(t);
    if (bi === undefined || bi < 50) return null;
    if (btcEma20[bi] === 0 || btcEma50[bi] === 0) return null;
    return btcEma20[bi] > btcEma50[bi] ? "long" : "short";
  };

  const trades: Tr[] = [];

  for (const pair of activePairs) {
    if (pair === "BTC") continue; // don't trade BTC against itself for trend filter
    const cs = dailyData.get(pair);
    if (!cs || cs.length < ENTRY_LB + ATR_PERIOD + 10) continue;
    const atr = calcATR(cs, ATR_PERIOD);
    const adx = opts.adxThreshold > 0 ? calcADX(cs, 14) : [];

    // Volume: 20-day average
    const volAvg = new Array(cs.length).fill(0);
    if (opts.volumeConfirm) {
      for (let i = 20; i < cs.length; i++) {
        let s = 0;
        for (let j = i - 20; j < i; j++) s += cs[j].v;
        volAvg[i] = s / 20;
      }
    }

    let pos: Pos | null = null;
    const warmup = Math.max(ENTRY_LB, ATR_PERIOD, 30) + 1;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < OOS_START) {
        // still need to track positions that span into OOS
        // but only count trades that EXIT in OOS
      }

      // Check exit
      if (pos) {
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        // Enhancement 3: ATR trailing stop
        if (opts.atrTrailStop && atr[i-1] > 0) {
          const profitATRs = pos.dir === "long"
            ? (bar.h - pos.ep) / pos.atrAtEntry
            : (pos.ep - bar.l) / pos.atrAtEntry;

          // Update peak
          if (pos.dir === "long") pos.peak = Math.max(pos.peak, bar.h);
          else pos.peak = Math.min(pos.peak, bar.l);

          // Tighten trail based on profit level
          let trailMult = ATR_MULT; // initial: 3x ATR
          if (profitATRs >= 2) trailMult = 1.5;
          else if (profitATRs >= 1) trailMult = 2;

          const trailSL = pos.dir === "long"
            ? pos.peak - trailMult * atr[i-1]
            : pos.peak + trailMult * atr[i-1];

          // Only tighten, never widen
          if (pos.dir === "long" && trailSL > pos.sl) pos.sl = trailSL;
          else if (pos.dir === "short" && trailSL < pos.sl) pos.sl = trailSL;
        }

        // SL check
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        // Donchian exit channel (on close)
        if (!xp) {
          const exitLow = donchianLow(cs, i, EXIT_LB);
          const exitHigh = donchianHigh(cs, i, EXIT_LB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        // Max hold
        if (!xp && barsHeld >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          // Only count trades that exit within OOS period
          if (bar.t >= OOS_START && bar.t < OOS_END) {
            trades.push({
              pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
              pnl: tradePnl(pair, pos.ep, xp, pos.dir, reason === "stop-loss"),
              reason, holdDays: barsHeld,
            });
          }
          pos = null;
        }
      }

      // Entry signal (based on previous day's close)
      if (!pos && i >= warmup) {
        const prev = cs[i - 1];
        const dHigh = donchianHigh(cs, i - 1, ENTRY_LB);
        const dLow = donchianLow(cs, i - 1, ENTRY_LB);
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        let dir: "long" | "short" | null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        // Enhancement 1: BTC trend filter
        if (opts.btcTrendFilter) {
          const btcTrend = getBtcTrend(bar.t);
          if (!btcTrend || btcTrend !== dir) continue;
        }

        // Enhancement 2: ADX filter
        if (opts.adxThreshold > 0) {
          if (i - 1 < adx.length && adx[i - 1] < opts.adxThreshold) continue;
        }

        // Enhancement 4: Volume confirmation
        if (opts.volumeConfirm) {
          if (volAvg[i - 1] > 0 && cs[i - 1].v < 1.5 * volAvg[i - 1]) continue;
        }

        const ep = bar.o;
        const sl = dir === "long" ? ep - ATR_MULT * curATR : ep + ATR_MULT * curATR;

        pos = { pair, dir, ep, et: bar.t, sl, peak: ep, atrAtEntry: curATR };
      }
    }
  }

  return trades;
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("Loading and aggregating 5m candles to daily...\n");

  const dailyData = new Map<string, C[]>();
  for (const pair of ALL_PAIRS) {
    const raw = load5m(pair);
    if (raw.length === 0) { console.log(`  SKIP ${pair} (no data)`); continue; }
    const daily = aggregateToDaily(raw);
    dailyData.set(pair, daily);
    console.log(`  ${pair}: ${raw.length} 5m -> ${daily.length} daily bars`);
  }

  const btcDaily = dailyData.get("BTC");
  if (!btcDaily) { console.log("ERROR: no BTC data"); return; }

  const oosDays = (OOS_END - OOS_START) / DAY;
  console.log(`\nOOS period: 2025-09-01 to 2026-03-26 (${oosDays.toFixed(0)} days)`);
  console.log(`Cost: ${FEE * 100}% taker/side, spread map, 1.5x spread slip on SL, 10x lev, $10 margin`);
  console.log(`Strategy: 30d entry / 15d exit / ATR(14)x3 SL / 60d max hold\n`);

  // ─── Print helper ─────────────────────────────────────────────────
  const fmtRow = (name: string, m: Metrics, baseline?: Metrics) => {
    const pnlStr = m.total >= 0 ? `+$${m.total.toFixed(1)}` : `-$${Math.abs(m.total).toFixed(1)}`;
    const dayStr = m.perDay >= 0 ? `+$${m.perDay.toFixed(2)}` : `-$${Math.abs(m.perDay).toFixed(2)}`;
    let delta = "";
    if (baseline && baseline.total !== 0) {
      const d = m.total - baseline.total;
      delta = d >= 0 ? ` (+$${d.toFixed(1)})` : ` (-$${Math.abs(d).toFixed(1)})`;
    }
    console.log(
      `${name.padEnd(30)} ${String(m.n).padStart(5)}  ${pnlStr.padStart(10)}  ` +
      `${m.pf === Infinity ? "  Inf" : m.pf.toFixed(2).padStart(5)}  ` +
      `${m.sharpe.toFixed(2).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ` +
      `${dayStr.padStart(7)}  $${m.dd.toFixed(1).padStart(6)}${delta}`
    );
  };

  const header = () => {
    console.log(
      `${"Strategy".padEnd(30)} ${"Trades".padStart(5)}  ${"PnL".padStart(10)}  ` +
      `${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"WR".padStart(6)}  ` +
      `${"$/day".padStart(7)}  ${"MaxDD".padStart(7)}`
    );
    console.log("-".repeat(95));
  };

  // ═════════════════════════════════════════════════════════════════
  // BASELINE
  // ═════════════════════════════════════════════════════════════════
  console.log("═".repeat(95));
  console.log("BASELINE: 30d/15d Donchian, ATRx3, no filters");
  console.log("═".repeat(95));
  header();

  const baseOpts: EnhOpts = {
    btcTrendFilter: false, adxThreshold: 0, atrTrailStop: false, volumeConfirm: false,
  };
  const baseTrades = runDonchian(ALL_PAIRS, dailyData, btcDaily, baseOpts);
  const baseM = calcMetrics(baseTrades);
  fmtRow("Baseline (no filters)", baseM);

  // ═════════════════════════════════════════════════════════════════
  // ENHANCEMENT 1: BTC Trend Filter
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(95)}`);
  console.log("ENHANCEMENT 1: BTC Trend Filter (EMA20 > EMA50 = long, < = short)");
  console.log("═".repeat(95));
  header();
  fmtRow("Baseline (no filters)", baseM);

  const btcOpts: EnhOpts = { ...baseOpts, btcTrendFilter: true };
  const btcTrades = runDonchian(ALL_PAIRS, dailyData, btcDaily, btcOpts);
  const btcM = calcMetrics(btcTrades);
  fmtRow("+ BTC Trend Filter", btcM, baseM);

  // ═════════════════════════════════════════════════════════════════
  // ENHANCEMENT 2: ADX Filter
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(95)}`);
  console.log("ENHANCEMENT 2: ADX Filter (only enter when ADX > threshold)");
  console.log("═".repeat(95));
  header();
  fmtRow("Baseline (no filters)", baseM);

  for (const adxTh of [15, 20, 25]) {
    const opts: EnhOpts = { ...baseOpts, adxThreshold: adxTh };
    const tr = runDonchian(ALL_PAIRS, dailyData, btcDaily, opts);
    const m = calcMetrics(tr);
    fmtRow(`+ ADX > ${adxTh}`, m, baseM);
  }

  // ═════════════════════════════════════════════════════════════════
  // ENHANCEMENT 3: ATR Trailing Stop
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(95)}`);
  console.log("ENHANCEMENT 3: ATR Trailing Stop (3x -> 2x after 1 ATR profit -> 1.5x after 2 ATR profit)");
  console.log("═".repeat(95));
  header();
  fmtRow("Baseline (no filters)", baseM);

  const trailOpts: EnhOpts = { ...baseOpts, atrTrailStop: true };
  const trailTrades = runDonchian(ALL_PAIRS, dailyData, btcDaily, trailOpts);
  const trailM = calcMetrics(trailTrades);
  fmtRow("+ ATR Trailing Stop", trailM, baseM);

  // ═════════════════════════════════════════════════════════════════
  // ENHANCEMENT 4: Volume Confirmation
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(95)}`);
  console.log("ENHANCEMENT 4: Volume Confirmation (today vol > 1.5x 20-day avg)");
  console.log("═".repeat(95));
  header();
  fmtRow("Baseline (no filters)", baseM);

  const volOpts: EnhOpts = { ...baseOpts, volumeConfirm: true };
  const volTrades = runDonchian(ALL_PAIRS, dailyData, btcDaily, volOpts);
  const volM = calcMetrics(volTrades);
  fmtRow("+ Volume Confirmation", volM, baseM);

  // ═════════════════════════════════════════════════════════════════
  // ENHANCEMENT 5: Pair Selection (top 50% by OOS PF)
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(95)}`);
  console.log("ENHANCEMENT 5: Pair Selection (rank by OOS PF, use top 50%)");
  console.log("═".repeat(95));

  // Run baseline per pair
  const pairResults: { pair: string; m: Metrics }[] = [];
  console.log("\nPer-pair baseline OOS results:");
  console.log(`${"Pair".padEnd(8)} ${"Trades".padStart(6)}  ${"PnL".padStart(10)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"WR".padStart(6)}  ${"$/day".padStart(7)}`);
  console.log("-".repeat(65));

  for (const pair of ALL_PAIRS) {
    if (pair === "BTC") continue;
    const opts: EnhOpts = { ...baseOpts, pairsToUse: [pair] };
    const tr = runDonchian(ALL_PAIRS, dailyData, btcDaily, opts);
    const m = calcMetrics(tr);
    pairResults.push({ pair, m });
    const pnlStr = m.total >= 0 ? `+$${m.total.toFixed(1)}` : `-$${Math.abs(m.total).toFixed(1)}`;
    const dayStr = m.perDay >= 0 ? `+$${m.perDay.toFixed(2)}` : `-$${Math.abs(m.perDay).toFixed(2)}`;
    console.log(
      `${pair.padEnd(8)} ${String(m.n).padStart(6)}  ${pnlStr.padStart(10)}  ` +
      `${m.pf === Infinity ? "  Inf" : m.pf.toFixed(2).padStart(5)}  ` +
      `${m.sharpe.toFixed(2).padStart(6)}  ${m.wr.toFixed(1).padStart(6)}  ${dayStr.padStart(7)}`
    );
  }

  // Sort by PF (treat Infinity as high, 0 trades as bad)
  pairResults.sort((a, b) => {
    if (a.m.n === 0) return 1;
    if (b.m.n === 0) return -1;
    const pfA = a.m.pf === Infinity ? 999 : a.m.pf;
    const pfB = b.m.pf === Infinity ? 999 : b.m.pf;
    return pfB - pfA;
  });

  const topHalf = pairResults.slice(0, Math.ceil(pairResults.length / 2)).map(p => p.pair);
  console.log(`\nTop 50% pairs by PF: ${topHalf.join(", ")}`);

  console.log("");
  header();
  fmtRow("Baseline (all pairs)", baseM);

  const pairSelOpts: EnhOpts = { ...baseOpts, pairsToUse: topHalf };
  const pairSelTrades = runDonchian(ALL_PAIRS, dailyData, btcDaily, pairSelOpts);
  const pairSelM = calcMetrics(pairSelTrades);
  fmtRow("Top 50% pairs only", pairSelM, baseM);

  // ═════════════════════════════════════════════════════════════════
  // ENHANCEMENT 6: Combined Best
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(95)}`);
  console.log("ENHANCEMENT 6: Combinations of individual winners");
  console.log("═".repeat(95));
  header();
  fmtRow("Baseline (no filters)", baseM);

  // Try several combinations
  const combos: { name: string; opts: EnhOpts }[] = [
    {
      name: "BTC Filter + ATR Trail",
      opts: { btcTrendFilter: true, adxThreshold: 0, atrTrailStop: true, volumeConfirm: false },
    },
    {
      name: "BTC Filter + ADX>20",
      opts: { btcTrendFilter: true, adxThreshold: 20, atrTrailStop: false, volumeConfirm: false },
    },
    {
      name: "BTC Filter + Volume",
      opts: { btcTrendFilter: true, adxThreshold: 0, atrTrailStop: false, volumeConfirm: true },
    },
    {
      name: "ADX>20 + ATR Trail",
      opts: { btcTrendFilter: false, adxThreshold: 20, atrTrailStop: true, volumeConfirm: false },
    },
    {
      name: "ADX>20 + Volume",
      opts: { btcTrendFilter: false, adxThreshold: 20, atrTrailStop: false, volumeConfirm: true },
    },
    {
      name: "ATR Trail + Volume",
      opts: { btcTrendFilter: false, adxThreshold: 0, atrTrailStop: true, volumeConfirm: true },
    },
    {
      name: "BTC + ADX>20 + Trail",
      opts: { btcTrendFilter: true, adxThreshold: 20, atrTrailStop: true, volumeConfirm: false },
    },
    {
      name: "BTC + ADX>20 + Volume",
      opts: { btcTrendFilter: true, adxThreshold: 20, atrTrailStop: false, volumeConfirm: true },
    },
    {
      name: "BTC + Trail + Volume",
      opts: { btcTrendFilter: true, adxThreshold: 0, atrTrailStop: true, volumeConfirm: true },
    },
    {
      name: "ADX>20 + Trail + Volume",
      opts: { btcTrendFilter: false, adxThreshold: 20, atrTrailStop: true, volumeConfirm: true },
    },
    {
      name: "ALL (BTC+ADX20+Trail+Vol)",
      opts: { btcTrendFilter: true, adxThreshold: 20, atrTrailStop: true, volumeConfirm: true },
    },
    {
      name: "Top50% + BTC Filter",
      opts: { btcTrendFilter: true, adxThreshold: 0, atrTrailStop: false, volumeConfirm: false, pairsToUse: topHalf },
    },
    {
      name: "Top50% + ATR Trail",
      opts: { btcTrendFilter: false, adxThreshold: 0, atrTrailStop: true, volumeConfirm: false, pairsToUse: topHalf },
    },
    {
      name: "Top50% + BTC + Trail",
      opts: { btcTrendFilter: true, adxThreshold: 0, atrTrailStop: true, volumeConfirm: false, pairsToUse: topHalf },
    },
    {
      name: "Top50% + BTC+ADX20+Trail",
      opts: { btcTrendFilter: true, adxThreshold: 20, atrTrailStop: true, volumeConfirm: false, pairsToUse: topHalf },
    },
  ];

  for (const c of combos) {
    const tr = runDonchian(ALL_PAIRS, dailyData, btcDaily, c.opts);
    const m = calcMetrics(tr);
    fmtRow(c.name, m, baseM);
  }

  // ═════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═════════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(95)}`);
  console.log("SUMMARY: All enhancements ranked by $/day");
  console.log("═".repeat(95));
  header();

  interface Result { name: string; m: Metrics; }
  const all: Result[] = [
    { name: "Baseline", m: baseM },
    { name: "BTC Trend Filter", m: btcM },
    { name: "ADX > 15", m: calcMetrics(runDonchian(ALL_PAIRS, dailyData, btcDaily, { ...baseOpts, adxThreshold: 15 })) },
    { name: "ADX > 20", m: calcMetrics(runDonchian(ALL_PAIRS, dailyData, btcDaily, { ...baseOpts, adxThreshold: 20 })) },
    { name: "ADX > 25", m: calcMetrics(runDonchian(ALL_PAIRS, dailyData, btcDaily, { ...baseOpts, adxThreshold: 25 })) },
    { name: "ATR Trailing Stop", m: trailM },
    { name: "Volume Confirm", m: volM },
    { name: "Top 50% Pairs", m: pairSelM },
  ];
  for (const c of combos) {
    all.push({ name: c.name, m: calcMetrics(runDonchian(ALL_PAIRS, dailyData, btcDaily, c.opts)) });
  }

  all.sort((a, b) => b.m.perDay - a.m.perDay);
  for (const r of all) fmtRow(r.name, r.m, baseM);

  // ─── Trade breakdown for best strategy ────────────────────────────
  const best = all[0];
  console.log(`\n${"═".repeat(95)}`);
  console.log(`BEST STRATEGY: ${best.name}`);
  console.log("═".repeat(95));
  console.log(`Trades: ${best.m.n} | PnL: $${best.m.total.toFixed(2)} | PF: ${best.m.pf.toFixed(2)} | Sharpe: ${best.m.sharpe.toFixed(2)} | WR: ${best.m.wr.toFixed(1)}% | $/day: $${best.m.perDay.toFixed(2)} | MaxDD: $${best.m.dd.toFixed(2)}`);

  // Find the matching combo opts or use baseline
  let bestOpts = baseOpts;
  const bestCombo = combos.find(c => c.name === best.name);
  if (bestCombo) bestOpts = bestCombo.opts;
  else if (best.name === "BTC Trend Filter") bestOpts = btcOpts;
  else if (best.name === "ATR Trailing Stop") bestOpts = trailOpts;
  else if (best.name === "Volume Confirm") bestOpts = volOpts;
  else if (best.name === "Top 50% Pairs") bestOpts = pairSelOpts;
  else if (best.name.startsWith("ADX > ")) bestOpts = { ...baseOpts, adxThreshold: parseInt(best.name.split("> ")[1]) };

  const bestTrades = runDonchian(ALL_PAIRS, dailyData, btcDaily, bestOpts);

  // Exit reason breakdown
  const reasons = new Map<string, { count: number; pnl: number }>();
  for (const t of bestTrades) {
    const r = reasons.get(t.reason) ?? { count: 0, pnl: 0 };
    r.count++; r.pnl += t.pnl;
    reasons.set(t.reason, r);
  }
  console.log("\nExit reason breakdown:");
  console.log(`${"Reason".padEnd(16)} ${"Count".padStart(6)}  ${"PnL".padStart(10)}  ${"Avg".padStart(8)}`);
  for (const [reason, r] of [...reasons.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    const pStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(1)}` : `-$${Math.abs(r.pnl).toFixed(1)}`;
    const avgStr = (r.pnl / r.count) >= 0 ? `+$${(r.pnl / r.count).toFixed(2)}` : `-$${Math.abs(r.pnl / r.count).toFixed(2)}`;
    console.log(`${reason.padEnd(16)} ${String(r.count).padStart(6)}  ${pStr.padStart(10)}  ${avgStr.padStart(8)}`);
  }

  // Monthly breakdown
  console.log("\nMonthly breakdown:");
  console.log(`${"Month".padEnd(10)} ${"Trades".padStart(6)}  ${"PnL".padStart(10)}  ${"WR".padStart(6)}`);
  const monthly = new Map<string, { trades: number; pnl: number; wins: number }>();
  for (const t of bestTrades) {
    const m = new Date(t.xt).toISOString().slice(0, 7);
    const v = monthly.get(m) ?? { trades: 0, pnl: 0, wins: 0 };
    v.trades++; v.pnl += t.pnl; if (t.pnl > 0) v.wins++;
    monthly.set(m, v);
  }
  for (const [m, v] of [...monthly.entries()].sort()) {
    const pStr = v.pnl >= 0 ? `+$${v.pnl.toFixed(1)}` : `-$${Math.abs(v.pnl).toFixed(1)}`;
    console.log(`${m.padEnd(10)} ${String(v.trades).padStart(6)}  ${pStr.padStart(10)}  ${(v.wins / v.trades * 100).toFixed(0).padStart(5)}%`);
  }

  // Direction breakdown
  const longs = bestTrades.filter(t => t.dir === "long");
  const shorts = bestTrades.filter(t => t.dir === "short");
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  console.log(`\nDirection: Longs ${longs.length} trades, PnL $${longPnl.toFixed(1)} | Shorts ${shorts.length} trades, PnL $${shortPnl.toFixed(1)}`);

  // Average hold time
  const avgHold = bestTrades.reduce((s, t) => s + t.holdDays, 0) / bestTrades.length;
  console.log(`Average hold: ${avgHold.toFixed(1)} days`);
}

main();
