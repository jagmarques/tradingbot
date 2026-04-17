/**
 * Maker-Only HFT Backtest
 * Tests 4 maker strategies using -0.01% rebate vs 0.035% taker fee.
 * Data: 1m bars from /tmp/bt-pair-cache-1m/
 *
 * Run: NODE_OPTIONS="--max-old-space-size=4096" npx tsx scripts/bt-maker-hft.ts
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ──────────────────────────────────────────────────────────────────

interface C { t: number; o: number; h: number; l: number; c: number; v?: number; }

interface Trade {
  pnlUsd: number;
  entryFee: number;
  exitFee: number;
  dir: "long" | "short";
  reason: string;
}

interface Stats {
  strategy: string;
  pair: string;
  trades: number;
  tradesPerDay: number;
  winRate: number;
  profitFactor: number;
  pnlPerDay: number;
  totalPnl: number;
  maxDD: number;
  avgPnlPerTrade: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CACHE_DIR = "/tmp/bt-pair-cache-1m";
const MAKER_REBATE = -0.0001;  // -0.01% → income on fill
const TAKER_FEE   =  0.00035; // +0.035% → cost on forced exit
const NOTIONAL    = 90;        // $9 margin × 10x
const LEVERAGE    = 10;

// Date range: last 6 months for speed, still 260k+ bars on BTC
const START_MS = new Date("2025-09-01").getTime();
const END_MS   = new Date("2026-03-26").getTime();

const PAIRS = ["BTC", "ETH", "SOL", "DOGE", "XRP"];

// ── Helpers ────────────────────────────────────────────────────────────────

function loadBars(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  const bars = raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[5] || 0 }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0 }
  ).sort((a, b) => a.t - b.t);
  return bars.filter(b => b.t >= START_MS && b.t <= END_MS);
}

function calcRSI(closes: number[], period = 14): number[] {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcVWAP(bars: C[], windowBars: number): number[] {
  // Rolling VWAP over windowBars
  const vwap = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    let cumPV = 0, cumV = 0;
    const start = Math.max(0, i - windowBars + 1);
    for (let j = start; j <= i; j++) {
      const typical = (bars[j].h + bars[j].l + bars[j].c) / 3;
      const vol = bars[j].v || 1;
      cumPV += typical * vol;
      cumV  += vol;
    }
    vwap[i] = cumV > 0 ? cumPV / cumV : bars[i].c;
  }
  return vwap;
}

function makerFee(notional: number): number {
  return notional * MAKER_REBATE; // negative = rebate (income)
}

function takerFee(notional: number): number {
  return notional * TAKER_FEE;   // positive = cost
}

function computeStats(strategy: string, pair: string, trades: Trade[], totalBars: number): Stats {
  if (trades.length === 0) {
    return { strategy, pair, trades: 0, tradesPerDay: 0, winRate: 0, profitFactor: 0, pnlPerDay: 0, totalPnl: 0, maxDD: 0, avgPnlPerTrade: 0 };
  }
  const days = (totalBars * 60_000) / 86_400_000;
  const wins = trades.filter(t => t.pnlUsd > 0).length;
  const grossWin  = trades.filter(t => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = trades.filter(t => t.pnlUsd <= 0).reduce((s, t) => s + Math.abs(t.pnlUsd), 0);

  // Equity curve for MaxDD
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnlUsd;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    strategy,
    pair,
    trades: trades.length,
    tradesPerDay: trades.length / days,
    winRate: (wins / trades.length) * 100,
    profitFactor: grossLoss === 0 ? 999 : grossWin / grossLoss,
    pnlPerDay: trades.reduce((s, t) => s + t.pnlUsd, 0) / days,
    totalPnl: trades.reduce((s, t) => s + t.pnlUsd, 0),
    maxDD,
    avgPnlPerTrade: trades.reduce((s, t) => s + t.pnlUsd, 0) / trades.length,
  };
}

// ── Strategy 1: Spread Capture ────────────────────────────────────────────
// Buy at close - 0.05%, sell at close + 0.05%.
// If both fill within 5 bars → profit = spread + 2x rebate.
// If only one fills, close at market after 10 bars (taker exit).
// No directional bias; trade every bar that isn't already in a position.

function spreadCapture(bars: C[]): Trade[] {
  const trades: Trade[] = [];
  const SPREAD_PCT = 0.0005;  // 0.05%
  const FILL_BARS  = 5;
  const TIMEOUT    = 10;

  let i = 0;
  while (i < bars.length - TIMEOUT - 1) {
    const bar = bars[i];
    const buyLimit  = bar.c * (1 - SPREAD_PCT);
    const sellLimit = bar.c * (1 + SPREAD_PCT);

    let buyFilled  = false;
    let sellFilled = false;
    let buyFillBar  = -1;
    let sellFillBar = -1;

    // Check fills within FILL_BARS
    for (let j = i + 1; j <= i + FILL_BARS && j < bars.length; j++) {
      if (!buyFilled  && bars[j].l <= buyLimit)  { buyFilled  = true; buyFillBar  = j; }
      if (!sellFilled && bars[j].h >= sellLimit) { sellFilled = true; sellFillBar = j; }
    }

    if (buyFilled && sellFilled) {
      // Both filled → full spread captured, 2x maker rebate
      const spread = (sellLimit - buyLimit) / bar.c * NOTIONAL;
      const fees   = makerFee(NOTIONAL) + makerFee(NOTIONAL); // both sides rebate
      trades.push({ pnlUsd: spread + fees, entryFee: fees, exitFee: 0, dir: "long", reason: "both_filled" });
      // Advance past later fill
      i = Math.max(buyFillBar, sellFillBar) + 1;
      continue;
    }

    if (buyFilled && !sellFilled) {
      // Only buy filled → stuck long, close at market after TIMEOUT from buy
      const closeBar = Math.min(buyFillBar + TIMEOUT, bars.length - 1);
      const exitPrice = bars[closeBar].c;
      const entryFee  = makerFee(NOTIONAL);
      const exitFee   = takerFee(NOTIONAL);
      const pricePnl  = (exitPrice - buyLimit) / buyLimit * NOTIONAL;
      trades.push({ pnlUsd: pricePnl + entryFee - exitFee, entryFee, exitFee, dir: "long", reason: "buy_only" });
      i = closeBar + 1;
      continue;
    }

    if (sellFilled && !buyFilled) {
      // Only sell filled → stuck short, close at market after TIMEOUT from sell
      const closeBar = Math.min(sellFillBar + TIMEOUT, bars.length - 1);
      const exitPrice = bars[closeBar].c;
      const entryFee  = makerFee(NOTIONAL);
      const exitFee   = takerFee(NOTIONAL);
      const pricePnl  = (sellLimit - exitPrice) / sellLimit * NOTIONAL;
      trades.push({ pnlUsd: pricePnl + entryFee - exitFee, entryFee, exitFee, dir: "short", reason: "sell_only" });
      i = sellFillBar + 1;
      continue;
    }

    // Neither filled → no trade, move forward
    i++;
  }

  return trades;
}

// ── Strategy 2: Mean Reversion Maker ──────────────────────────────────────
// RSI(14) < 30 → place buy limit at close (maker entry).
// RSI(14) > 70 → place sell limit at close (maker entry).
// Exit: RSI crosses 50 (maker limit at close at signal bar) OR timeout 30 bars (taker).

function meanReversionMaker(bars: C[]): Trade[] {
  const trades: Trade[] = [];
  const closes = bars.map(b => b.c);
  const rsi    = calcRSI(closes, 14);
  const RSI_ENTRY_LOW  = 30;
  const RSI_ENTRY_HIGH = 70;
  const RSI_EXIT       = 50;
  const TIMEOUT        = 30;
  const FILL_BARS      = 3; // limit fill window

  let i = 15; // warmup
  while (i < bars.length - TIMEOUT - 2) {
    // LONG entry: RSI < 30
    if (rsi[i] < RSI_ENTRY_LOW && rsi[i - 1] >= RSI_ENTRY_LOW) {
      const entryLimit = bars[i].c;

      // Check if limit fills within FILL_BARS
      let fillBar = -1;
      for (let j = i + 1; j <= i + FILL_BARS && j < bars.length; j++) {
        if (bars[j].l <= entryLimit) { fillBar = j; break; }
      }
      if (fillBar === -1) { i++; continue; }

      // Find exit: RSI crosses above 50 (maker limit at close of that bar) or timeout
      let exitBar = -1;
      let exitReason = "timeout";
      for (let j = fillBar + 1; j <= fillBar + TIMEOUT && j < bars.length; j++) {
        if (rsi[j - 1] < RSI_EXIT && rsi[j] >= RSI_EXIT) { exitBar = j; exitReason = "rsi_exit"; break; }
      }
      if (exitBar === -1) exitBar = Math.min(fillBar + TIMEOUT, bars.length - 1);

      const exitPrice = bars[exitBar].c;
      const entryFee  = makerFee(NOTIONAL);
      const exitFee   = exitReason === "rsi_exit" ? makerFee(NOTIONAL) : takerFee(NOTIONAL);
      const pricePnl  = (exitPrice - entryLimit) / entryLimit * NOTIONAL;
      trades.push({ pnlUsd: pricePnl + entryFee + exitFee, entryFee, exitFee, dir: "long", reason: exitReason });
      i = exitBar + 1;
      continue;
    }

    // SHORT entry: RSI > 70
    if (rsi[i] > RSI_ENTRY_HIGH && rsi[i - 1] <= RSI_ENTRY_HIGH) {
      const entryLimit = bars[i].c;

      let fillBar = -1;
      for (let j = i + 1; j <= i + FILL_BARS && j < bars.length; j++) {
        if (bars[j].h >= entryLimit) { fillBar = j; break; }
      }
      if (fillBar === -1) { i++; continue; }

      let exitBar = -1;
      let exitReason = "timeout";
      for (let j = fillBar + 1; j <= fillBar + TIMEOUT && j < bars.length; j++) {
        if (rsi[j - 1] > RSI_EXIT && rsi[j] <= RSI_EXIT) { exitBar = j; exitReason = "rsi_exit"; break; }
      }
      if (exitBar === -1) exitBar = Math.min(fillBar + TIMEOUT, bars.length - 1);

      const exitPrice = bars[exitBar].c;
      const entryFee  = makerFee(NOTIONAL);
      const exitFee   = exitReason === "rsi_exit" ? makerFee(NOTIONAL) : takerFee(NOTIONAL);
      const pricePnl  = (entryLimit - exitPrice) / entryLimit * NOTIONAL;
      trades.push({ pnlUsd: pricePnl + entryFee + exitFee, entryFee, exitFee, dir: "short", reason: exitReason });
      i = exitBar + 1;
      continue;
    }

    i++;
  }

  return trades;
}

// ── Strategy 3: VWAP Reversion Maker ──────────────────────────────────────
// When price < VWAP by 0.1%, place buy limit at current price.
// Exit at VWAP (maker limit). SL at -0.2% from entry (taker).

function vwapReversionMaker(bars: C[]): Trade[] {
  const trades: Trade[] = [];
  const VWAP_WINDOW   = 60;   // 60-bar rolling VWAP
  const ENTRY_DISC    = 0.001; // 0.1% below VWAP
  const SL_PCT        = 0.002; // 0.2% SL
  const MAX_HOLD      = 60;    // bars
  const FILL_BARS     = 2;

  const vwap = calcVWAP(bars, VWAP_WINDOW);

  let i = VWAP_WINDOW;
  while (i < bars.length - MAX_HOLD - 2) {
    const v = vwap[i];
    const c = bars[i].c;

    if (c < v * (1 - ENTRY_DISC)) {
      const entryLimit = c;
      const sl         = entryLimit * (1 - SL_PCT);
      const tpVwap     = v; // target: return to VWAP

      // Check entry fill
      let fillBar = -1;
      for (let j = i + 1; j <= i + FILL_BARS && j < bars.length; j++) {
        if (bars[j].l <= entryLimit) { fillBar = j; break; }
      }
      if (fillBar === -1) { i++; continue; }

      // Track position
      let exitBar = -1;
      let exitPrice = 0;
      let exitReason = "timeout";

      for (let j = fillBar + 1; j <= fillBar + MAX_HOLD && j < bars.length; j++) {
        // SL hit (taker)
        if (bars[j].l <= sl) {
          exitBar = j; exitPrice = sl; exitReason = "sl"; break;
        }
        // TP at VWAP (maker limit — check if high touches rolling VWAP at that bar)
        const vj = vwap[j];
        if (bars[j].h >= vj && vj > entryLimit) {
          exitBar = j; exitPrice = vj; exitReason = "vwap_tp"; break;
        }
      }
      if (exitBar === -1) { exitBar = Math.min(fillBar + MAX_HOLD, bars.length - 1); exitPrice = bars[exitBar].c; }

      const entryFee = makerFee(NOTIONAL);
      const exitFee  = exitReason === "sl" || exitReason === "timeout" ? takerFee(NOTIONAL) : makerFee(NOTIONAL);
      const pricePnl = (exitPrice - entryLimit) / entryLimit * NOTIONAL;
      trades.push({ pnlUsd: pricePnl + entryFee + exitFee, entryFee, exitFee, dir: "long", reason: exitReason });
      i = exitBar + 1;
      continue;
    }

    i++;
  }

  return trades;
}

// ── Strategy 4: Momentum Continuation Maker ───────────────────────────────
// After a 0.3% move in 3 bars, place limit 0.05% back (buy the pullback).
// Exit at +0.15% (maker) or -0.1% SL (taker).

function momentumContinuationMaker(bars: C[]): Trade[] {
  const trades: Trade[] = [];
  const MOVE_PCT    = 0.003;  // 0.3% in 3 bars
  const ENTRY_BACK  = 0.0005; // place 0.05% below the trigger bar close
  const TP_PCT      = 0.0015; // +0.15% TP (maker)
  const SL_PCT      = 0.001;  // -0.1% SL (taker)
  const FILL_BARS   = 5;
  const MAX_HOLD    = 30;

  let i = 3;
  while (i < bars.length - MAX_HOLD - 2) {
    const move = (bars[i].c - bars[i - 3].c) / bars[i - 3].c;

    if (move >= MOVE_PCT) {
      // Uptrend: buy the pullback
      const entryLimit = bars[i].c * (1 - ENTRY_BACK);
      const tp         = entryLimit * (1 + TP_PCT);
      const sl         = entryLimit * (1 - SL_PCT);

      let fillBar = -1;
      for (let j = i + 1; j <= i + FILL_BARS && j < bars.length; j++) {
        if (bars[j].l <= entryLimit) { fillBar = j; break; }
      }
      if (fillBar === -1) { i++; continue; }

      let exitBar = -1;
      let exitPrice = 0;
      let exitReason = "timeout";
      for (let j = fillBar + 1; j <= fillBar + MAX_HOLD && j < bars.length; j++) {
        if (bars[j].l <= sl) {
          exitBar = j; exitPrice = sl; exitReason = "sl"; break;
        }
        if (bars[j].h >= tp) {
          exitBar = j; exitPrice = tp; exitReason = "tp"; break;
        }
      }
      if (exitBar === -1) { exitBar = Math.min(fillBar + MAX_HOLD, bars.length - 1); exitPrice = bars[exitBar].c; }

      const entryFee = makerFee(NOTIONAL);
      const exitFee  = exitReason === "tp" ? makerFee(NOTIONAL) : takerFee(NOTIONAL);
      const pricePnl = (exitPrice - entryLimit) / entryLimit * NOTIONAL;
      trades.push({ pnlUsd: pricePnl + entryFee + exitFee, entryFee, exitFee, dir: "long", reason: exitReason });
      i = exitBar + 1;
      continue;
    }

    if (move <= -MOVE_PCT) {
      // Downtrend: sell the pullback
      const entryLimit = bars[i].c * (1 + ENTRY_BACK);
      const tp         = entryLimit * (1 - TP_PCT);
      const sl         = entryLimit * (1 + SL_PCT);

      let fillBar = -1;
      for (let j = i + 1; j <= i + FILL_BARS && j < bars.length; j++) {
        if (bars[j].h >= entryLimit) { fillBar = j; break; }
      }
      if (fillBar === -1) { i++; continue; }

      let exitBar = -1;
      let exitPrice = 0;
      let exitReason = "timeout";
      for (let j = fillBar + 1; j <= fillBar + MAX_HOLD && j < bars.length; j++) {
        if (bars[j].h >= sl) {
          exitBar = j; exitPrice = sl; exitReason = "sl"; break;
        }
        if (bars[j].l <= tp) {
          exitBar = j; exitPrice = tp; exitReason = "tp"; break;
        }
      }
      if (exitBar === -1) { exitBar = Math.min(fillBar + MAX_HOLD, bars.length - 1); exitPrice = bars[exitBar].c; }

      const entryFee = makerFee(NOTIONAL);
      const exitFee  = exitReason === "tp" ? makerFee(NOTIONAL) : takerFee(NOTIONAL);
      const pricePnl = (entryLimit - exitPrice) / entryLimit * NOTIONAL;
      trades.push({ pnlUsd: pricePnl + entryFee + exitFee, entryFee, exitFee, dir: "short", reason: exitReason });
      i = exitBar + 1;
      continue;
    }

    i++;
  }

  return trades;
}

// ── Main ───────────────────────────────────────────────────────────────────

function printTable(allStats: Stats[]): void {
  const header = [
    "Strategy".padEnd(24),
    "Pair".padEnd(6),
    "Trades".padStart(7),
    "T/Day".padStart(6),
    "WR%".padStart(6),
    "PF".padStart(6),
    "$/Day".padStart(7),
    "TotalPnL".padStart(9),
    "MaxDD".padStart(7),
    "$/Trade".padStart(8),
  ].join("  ");
  console.log("\n" + header);
  console.log("-".repeat(header.length));

  for (const s of allStats) {
    console.log([
      s.strategy.padEnd(24),
      s.pair.padEnd(6),
      s.trades.toString().padStart(7),
      s.tradesPerDay.toFixed(1).padStart(6),
      s.winRate.toFixed(1).padStart(6),
      (s.profitFactor === 999 ? "∞" : s.profitFactor.toFixed(2)).padStart(6),
      s.pnlPerDay.toFixed(4).padStart(7),
      s.totalPnl.toFixed(2).padStart(9),
      s.maxDD.toFixed(2).padStart(7),
      s.avgPnlPerTrade.toFixed(4).padStart(8),
    ].join("  "));
  }
}

function printSummary(allStats: Stats[]): void {
  const strategies = ["SpreadCapture", "MeanRevMaker", "VWAPReversion", "MomentumMaker"];

  console.log("\n\n=== AGGREGATE BY STRATEGY (all pairs combined) ===");
  for (const strat of strategies) {
    const rows = allStats.filter(s => s.strategy === strat);
    if (rows.length === 0) continue;
    const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
    const days = rows[0] ? (rows[0].trades / rows[0].tradesPerDay || 1) : 1;
    // Recalc: use per-row days
    const totalPnl  = rows.reduce((s, r) => s + r.totalPnl, 0);
    const totalDays = rows.reduce((s, r) => s + (r.trades > 0 ? r.trades / r.tradesPerDay : 0), 0) / rows.length;
    const avgWR     = rows.reduce((s, r) => s + r.winRate, 0) / rows.length;
    const avgPF     = rows.filter(r => r.profitFactor < 999).reduce((s, r) => s + r.profitFactor, 0) /
                      Math.max(1, rows.filter(r => r.profitFactor < 999).length);
    const avgDD     = rows.reduce((s, r) => s + r.maxDD, 0) / rows.length;
    const avgPDay   = rows.reduce((s, r) => s + r.pnlPerDay, 0) / rows.length;

    console.log(`\n${strat}:`);
    console.log(`  Pairs tested : ${rows.length}`);
    console.log(`  Total trades : ${totalTrades}`);
    console.log(`  Avg WR%      : ${avgWR.toFixed(1)}%`);
    console.log(`  Avg PF       : ${avgPF.toFixed(2)}`);
    console.log(`  Avg $/day    : ${avgPDay.toFixed(4)}`);
    console.log(`  Total PnL    : $${totalPnl.toFixed(2)}`);
    console.log(`  Avg MaxDD    : $${avgDD.toFixed(2)}`);
  }
}

async function main(): Promise<void> {
  console.log("Maker-Only HFT Backtest");
  console.log(`Period: ${new Date(START_MS).toISOString().slice(0, 10)} → ${new Date(END_MS).toISOString().slice(0, 10)}`);
  console.log(`Notional: $${NOTIONAL} | Maker rebate: ${MAKER_REBATE * 100}% | Taker fee: ${TAKER_FEE * 100}%\n`);

  const allStats: Stats[] = [];

  for (const pair of PAIRS) {
    process.stdout.write(`Loading ${pair}... `);
    const bars = loadBars(pair);
    if (bars.length < 500) { console.log("insufficient data, skip"); continue; }
    console.log(`${bars.length.toLocaleString()} bars`);

    const strategies: [string, (b: C[]) => Trade[]][] = [
      ["SpreadCapture",  spreadCapture],
      ["MeanRevMaker",   meanReversionMaker],
      ["VWAPReversion",  vwapReversionMaker],
      ["MomentumMaker",  momentumContinuationMaker],
    ];

    for (const [name, fn] of strategies) {
      process.stdout.write(`  ${name.padEnd(20)} `);
      const trades = fn(bars);
      const stats  = computeStats(name, pair, trades, bars.length);
      allStats.push(stats);
      process.stdout.write(
        `${trades.length} trades | WR ${stats.winRate.toFixed(0)}% | PF ${stats.profitFactor === 999 ? "∞" : stats.profitFactor.toFixed(2)} | $/day ${stats.pnlPerDay.toFixed(4)}\n`
      );
    }
    console.log();
  }

  printTable(allStats);
  printSummary(allStats);

  // Breakdown by exit reason
  console.log("\n\n=== EXIT REASON BREAKDOWN (BTC only) ===");
  const btcBars = loadBars("BTC");
  const btcStrategies: [string, (b: C[]) => Trade[]][] = [
    ["SpreadCapture",  spreadCapture],
    ["MeanRevMaker",   meanReversionMaker],
    ["VWAPReversion",  vwapReversionMaker],
    ["MomentumMaker",  momentumContinuationMaker],
  ];
  for (const [name, fn] of btcStrategies) {
    const trades = fn(btcBars);
    const reasons = new Map<string, { count: number; pnl: number }>();
    for (const t of trades) {
      const r = reasons.get(t.reason) ?? { count: 0, pnl: 0 };
      r.count++; r.pnl += t.pnlUsd;
      reasons.set(t.reason, r);
    }
    console.log(`\n${name} (BTC):`);
    for (const [reason, data] of reasons) {
      console.log(`  ${reason.padEnd(16)} count=${data.count}  pnl=$${data.pnl.toFixed(2)}  avg=$${(data.pnl/data.count).toFixed(4)}`);
    }
  }

  // Fee impact analysis
  console.log("\n\n=== FEE IMPACT: Maker rebate vs Taker fee ===");
  console.log("Hypothetical: same SpreadCapture but with taker fees on all fills");
  const btcTrades = spreadCapture(btcBars);
  const totalRebate = btcTrades.reduce((s, t) => s + t.entryFee, 0);
  const totalTakerCost = btcTrades.length * 2 * takerFee(NOTIONAL);
  console.log(`  BTC SpreadCapture trades: ${btcTrades.length}`);
  console.log(`  Total maker rebate earned: $${totalRebate.toFixed(2)}`);
  console.log(`  What taker would cost: $${(-totalTakerCost).toFixed(2)}`);
  console.log(`  Fee advantage (maker vs taker): $${(totalRebate - (-totalTakerCost)).toFixed(2)}`);
}

main().catch(console.error);
