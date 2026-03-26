/**
 * Max-Pain Proxy Backtest
 *
 * BTC options expire every Friday. Max pain pulls price toward strike clusters.
 * We can't get historical max-pain data, so we use proxy signals:
 *
 * Strategy 1 - Friday Gravity:
 *   Wed: if BTC >3% from nearest $5K round -> short alts (pullback expected)
 *   Wed: if BTC <-3% below nearest $5K round -> long alts (bounce expected)
 *   Close Monday open.
 *
 * Strategy 2 - Weekly Mean Reversion:
 *   Wed: if BTC 5-day return >3% -> short alts (expect Friday revert)
 *   Wed: if BTC 5-day return <-3% -> long alts
 *   Close Monday open.
 *
 * Strategy 3 - Expiry Volatility Fade:
 *   Thu: if ATR(5) > 1.5x ATR(20) -> straddle (long+short different pairs)
 *   Expect vol compression after Friday expiry. Close Monday.
 *
 * Uses 5m candles aggregated to daily for BTC signal, 5m for alt execution.
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ──────────────────────────────────────────────────────────────
interface C5 { t: number; o: number; h: number; l: number; c: number; v: number }
interface DailyBar { t: number; o: number; h: number; l: number; c: number; v: number }
interface Position {
  pair: string;
  dir: "long" | "short";
  entry: number;   // filled price (incl. spread)
  entryT: number;
  sl: number;
  margin: number;  // $ margin
}
interface Trade {
  pair: string;
  dir: "long" | "short";
  pnl: number;
  entryT: number;
  exitT: number;
}

// ── Constants ──────────────────────────────────────────────────────────
const CACHE = "/tmp/bt-pair-cache-5m";
const DAY = 86_400_000;
const H = 3_600_000;
const FEE = 0.00035;   // taker fee per side
const LEV = 10;
const MARGIN = 5;       // $5 per position

const PAIRS = [
  "OPUSDT", "WIFUSDT", "ARBUSDT", "LDOUSDT", "TRUMPUSDT", "DASHUSDT",
  "DOTUSDT", "ENAUSDT", "DOGEUSDT", "APTUSDT", "LINKUSDT", "ADAUSDT",
  "WLDUSDT", "XRPUSDT", "UNIUSDT", "SOLUSDT", "TIAUSDT", "ETHUSDT",
];

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4,
  WLDUSDT: 4e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4,
  LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
  SOLUSDT: 1.5e-4, TIAUSDT: 3.8e-4, ETHUSDT: 0.8e-4,
};

// ── Data Loading ───────────────────────────────────────────────────────
function load5m(pair: string): C5[] {
  const f = path.join(CACHE, pair + ".json");
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as any[]).map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v || 0),
  }));
}

function aggregateDaily(candles: C5[]): DailyBar[] {
  const map = new Map<number, C5[]>();
  for (const c of candles) {
    const dayKey = Math.floor(c.t / DAY) * DAY;
    if (!map.has(dayKey)) map.set(dayKey, []);
    map.get(dayKey)!.push(c);
  }
  const result: DailyBar[] = [];
  for (const [dayKey, bars] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 10) continue; // skip incomplete days
    result.push({
      t: dayKey,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, b) => s + b.v, 0),
    });
  }
  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────
function dayOfWeek(t: number): number {
  return new Date(t).getUTCDay(); // 0=Sun, 1=Mon, ..., 3=Wed, 4=Thu, 5=Fri
}

function nearestRound5K(price: number): number {
  return Math.round(price / 5000) * 5000;
}

function atr(daily: DailyBar[], idx: number, period: number): number | null {
  if (idx < period) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const tr = Math.max(
      daily[i].h - daily[i].l,
      Math.abs(daily[i].h - daily[i - 1].c),
      Math.abs(daily[i].l - daily[i - 1].c),
    );
    sum += tr;
  }
  return sum / period;
}

// Pick top N pairs by recent 7d volume
function topPairsByVolume(
  pairData: Map<string, C5[]>,
  refTime: number,
  n: number,
): string[] {
  const vols: { pair: string; vol: number }[] = [];
  for (const [pair, candles] of pairData) {
    if (pair === "BTCUSDT") continue;
    let vol = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].t < refTime - 7 * DAY) break;
      if (candles[i].t <= refTime) vol += candles[i].v * candles[i].c;
    }
    vols.push({ pair, vol });
  }
  vols.sort((a, b) => b.vol - a.vol);
  return vols.slice(0, n).map(v => v.pair);
}

// Find the 5m bar index closest to a given timestamp
function findBarIdx(candles: C5[], t: number): number {
  // Binary search
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Get price at a timestamp from 5m candles
function priceAt(candles: C5[], t: number): number | null {
  const idx = findBarIdx(candles, t);
  if (idx >= candles.length) return null;
  // Allow up to 30min tolerance
  if (Math.abs(candles[idx].t - t) > 30 * 60_000) return null;
  return candles[idx].o;
}

// ── Strategy Results ───────────────────────────────────────────────────
interface StratResult {
  name: string;
  trades: Trade[];
  totalPnl: number;
  pf: number;
  sharpe: number;
  perDay: number;
  winRate: number;
  maxDD: number;
  avgTrade: number;
}

function analyzeResult(name: string, trades: Trade[], startT: number, endT: number): StratResult {
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const days = (endT - startT) / DAY;
  const perDay = totalPnl / days;
  const winRate = trades.length > 0 ? wins.length / trades.length * 100 : 0;

  // Daily PnL for Sharpe
  const dailyMap = new Map<number, number>();
  for (const t of trades) {
    const dk = Math.floor(t.exitT / DAY);
    dailyMap.set(dk, (dailyMap.get(dk) || 0) + t.pnl);
  }
  const dailyPnls = [...dailyMap.values()];
  const avgDaily = dailyPnls.length > 0 ? dailyPnls.reduce((s, x) => s + x, 0) / dailyPnls.length : 0;
  const stdDaily = dailyPnls.length > 1
    ? Math.sqrt(dailyPnls.reduce((s, x) => s + (x - avgDaily) ** 2, 0) / (dailyPnls.length - 1))
    : 0;
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  // Max drawdown
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of trades.sort((a, b) => a.exitT - b.exitT)) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const avgTrade = trades.length > 0 ? totalPnl / trades.length : 0;

  return { name, trades, totalPnl, pf, sharpe, perDay, winRate, maxDD, avgTrade };
}

function printResult(r: StratResult): void {
  console.log(`  Trades: ${r.trades.length}`);
  console.log(`  Total PnL: $${r.totalPnl.toFixed(2)}`);
  console.log(`  $/day: $${r.perDay.toFixed(3)}`);
  console.log(`  Win Rate: ${r.winRate.toFixed(1)}%`);
  console.log(`  Profit Factor: ${r.pf === Infinity ? "INF" : r.pf.toFixed(2)}`);
  console.log(`  Sharpe: ${r.sharpe.toFixed(2)}`);
  console.log(`  Max DD: $${r.maxDD.toFixed(2)}`);
  console.log(`  Avg Trade: $${r.avgTrade.toFixed(3)}`);
}

// ── STRATEGY 1: Friday Gravity ─────────────────────────────────────────
function stratFridayGravity(
  btcDaily: DailyBar[],
  pairCandles: Map<string, C5[]>,
  startT: number,
  endT: number,
): Trade[] {
  const trades: Trade[] = [];

  for (let i = 25; i < btcDaily.length; i++) {
    const bar = btcDaily[i];
    if (bar.t < startT || bar.t >= endT) continue;
    if (dayOfWeek(bar.t) !== 3) continue; // Wednesday only

    const btcPrice = bar.c;
    const round5k = nearestRound5K(btcPrice);
    const pctFromRound = (btcPrice - round5k) / round5k;

    let dir: "long" | "short" | null = null;
    if (pctFromRound > 0.03) dir = "short";     // >3% above round -> expect pullback
    else if (pctFromRound < -0.03) dir = "long"; // >3% below round -> expect bounce

    if (!dir) continue;

    // Find Monday close time (bar.t + 5 days = next Monday 00:00 UTC)
    const mondayT = bar.t + 5 * DAY;
    // Entry: Wednesday close = Thursday open (next bar open)
    const entryT = bar.t + DAY; // Thursday 00:00

    const topPairs = topPairsByVolume(pairCandles, bar.t, 5);

    for (const pair of topPairs) {
      const candles = pairCandles.get(pair)!;
      const entryPrice = priceAt(candles, entryT);
      const exitPrice = priceAt(candles, mondayT);
      if (!entryPrice || !exitPrice) continue;

      const sp = SP[pair] || 4e-4;
      const filledEntry = dir === "long" ? entryPrice * (1 + sp) : entryPrice * (1 - sp);
      const filledExit = dir === "long" ? exitPrice * (1 - sp) : exitPrice * (1 + sp);
      const notional = MARGIN * LEV;
      const raw = dir === "long"
        ? (filledExit / filledEntry - 1) * notional
        : (filledEntry / filledExit - 1) * notional;
      const fees = notional * FEE * 2;
      const pnl = raw - fees;

      // SL check: scan 5m candles between entry and exit for SL hit (3.5%)
      const slPct = 0.035;
      const slPrice = dir === "long" ? filledEntry * (1 - slPct) : filledEntry * (1 + slPct);
      let hitSL = false;
      const entryIdx = findBarIdx(candles, entryT);
      const exitIdx = findBarIdx(candles, mondayT);

      for (let k = entryIdx; k <= Math.min(exitIdx, candles.length - 1); k++) {
        if (dir === "long" && candles[k].l <= slPrice) {
          const slExit = slPrice * (1 - sp);
          const slRaw = (slExit / filledEntry - 1) * notional;
          trades.push({ pair, dir, pnl: slRaw - fees, entryT, exitT: candles[k].t });
          hitSL = true;
          break;
        }
        if (dir === "short" && candles[k].h >= slPrice) {
          const slExit = slPrice * (1 + sp);
          const slRaw = (filledEntry / slExit - 1) * notional;
          trades.push({ pair, dir, pnl: slRaw - fees, entryT, exitT: candles[k].t });
          hitSL = true;
          break;
        }
      }
      if (!hitSL) {
        trades.push({ pair, dir, pnl, entryT, exitT: mondayT });
      }
    }
  }
  return trades;
}

// ── STRATEGY 2: Weekly Mean Reversion ──────────────────────────────────
function stratWeeklyMR(
  btcDaily: DailyBar[],
  pairCandles: Map<string, C5[]>,
  startT: number,
  endT: number,
): Trade[] {
  const trades: Trade[] = [];

  for (let i = 25; i < btcDaily.length; i++) {
    const bar = btcDaily[i];
    if (bar.t < startT || bar.t >= endT) continue;
    if (dayOfWeek(bar.t) !== 3) continue;

    // 5-day return
    const fiveDayAgo = btcDaily[i - 5];
    if (!fiveDayAgo) continue;
    const ret5d = (bar.c - fiveDayAgo.c) / fiveDayAgo.c;

    let dir: "long" | "short" | null = null;
    if (ret5d > 0.03) dir = "short";     // Up >3% in 5 days -> expect revert
    else if (ret5d < -0.03) dir = "long"; // Down >3% -> expect bounce

    if (!dir) continue;

    const entryT = bar.t + DAY;
    const mondayT = bar.t + 5 * DAY;

    const topPairs = topPairsByVolume(pairCandles, bar.t, 5);

    for (const pair of topPairs) {
      const candles = pairCandles.get(pair)!;
      const entryPrice = priceAt(candles, entryT);
      const exitPrice = priceAt(candles, mondayT);
      if (!entryPrice || !exitPrice) continue;

      const sp = SP[pair] || 4e-4;
      const filledEntry = dir === "long" ? entryPrice * (1 + sp) : entryPrice * (1 - sp);
      const filledExit = dir === "long" ? exitPrice * (1 - sp) : exitPrice * (1 + sp);
      const notional = MARGIN * LEV;
      const raw = dir === "long"
        ? (filledExit / filledEntry - 1) * notional
        : (filledEntry / filledExit - 1) * notional;
      const fees = notional * FEE * 2;

      const slPct = 0.035;
      const slPrice = dir === "long" ? filledEntry * (1 - slPct) : filledEntry * (1 + slPct);
      let hitSL = false;
      const entryIdx = findBarIdx(candles, entryT);
      const exitIdx = findBarIdx(candles, mondayT);

      for (let k = entryIdx; k <= Math.min(exitIdx, candles.length - 1); k++) {
        if (dir === "long" && candles[k].l <= slPrice) {
          const slExit = slPrice * (1 - sp);
          const slRaw = (slExit / filledEntry - 1) * notional;
          trades.push({ pair, dir, pnl: slRaw - fees, entryT, exitT: candles[k].t });
          hitSL = true;
          break;
        }
        if (dir === "short" && candles[k].h >= slPrice) {
          const slExit = slPrice * (1 + sp);
          const slRaw = (filledEntry / slExit - 1) * notional;
          trades.push({ pair, dir, pnl: slRaw - fees, entryT, exitT: candles[k].t });
          hitSL = true;
          break;
        }
      }
      if (!hitSL) {
        trades.push({ pair, dir, pnl: raw - fees, entryT, exitT: mondayT });
      }
    }
  }
  return trades;
}

// ── STRATEGY 3: Expiry Volatility Fade ─────────────────────────────────
function stratVolFade(
  btcDaily: DailyBar[],
  pairCandles: Map<string, C5[]>,
  startT: number,
  endT: number,
): Trade[] {
  const trades: Trade[] = [];

  for (let i = 25; i < btcDaily.length; i++) {
    const bar = btcDaily[i];
    if (bar.t < startT || bar.t >= endT) continue;
    if (dayOfWeek(bar.t) !== 4) continue; // Thursday only

    const atr5 = atr(btcDaily, i, 5);
    const atr20 = atr(btcDaily, i, 20);
    if (!atr5 || !atr20 || atr20 === 0) continue;

    const ratio = atr5 / atr20;
    if (ratio <= 1.5) continue; // Not elevated enough

    // Straddle-like: long top 3 pairs, short next 3 pairs
    const entryT = bar.t + DAY; // Friday 00:00
    const mondayT = bar.t + 4 * DAY; // Monday 00:00 (Thu + 4 = Mon)

    const topPairs = topPairsByVolume(pairCandles, bar.t, 6);
    const longPairs = topPairs.slice(0, 3);
    const shortPairs = topPairs.slice(3, 6);

    for (const pair of longPairs) {
      const candles = pairCandles.get(pair)!;
      const entryPrice = priceAt(candles, entryT);
      const exitPrice = priceAt(candles, mondayT);
      if (!entryPrice || !exitPrice) continue;

      const sp = SP[pair] || 4e-4;
      const filledEntry = entryPrice * (1 + sp);
      const filledExit = exitPrice * (1 - sp);
      const notional = MARGIN * LEV;
      const raw = (filledExit / filledEntry - 1) * notional;
      const fees = notional * FEE * 2;

      const slPct = 0.035;
      const slPrice = filledEntry * (1 - slPct);
      let hitSL = false;
      const entryIdx = findBarIdx(candles, entryT);
      const exitIdx = findBarIdx(candles, mondayT);

      for (let k = entryIdx; k <= Math.min(exitIdx, candles.length - 1); k++) {
        if (candles[k].l <= slPrice) {
          const slExit = slPrice * (1 - sp);
          const slRaw = (slExit / filledEntry - 1) * notional;
          trades.push({ pair, dir: "long", pnl: slRaw - fees, entryT, exitT: candles[k].t });
          hitSL = true;
          break;
        }
      }
      if (!hitSL) {
        trades.push({ pair, dir: "long", pnl: raw - fees, entryT, exitT: mondayT });
      }
    }

    for (const pair of shortPairs) {
      const candles = pairCandles.get(pair)!;
      const entryPrice = priceAt(candles, entryT);
      const exitPrice = priceAt(candles, mondayT);
      if (!entryPrice || !exitPrice) continue;

      const sp = SP[pair] || 4e-4;
      const filledEntry = entryPrice * (1 - sp);
      const filledExit = exitPrice * (1 + sp);
      const notional = MARGIN * LEV;
      const raw = (filledEntry / filledExit - 1) * notional;
      const fees = notional * FEE * 2;

      const slPct = 0.035;
      const slPrice = filledEntry * (1 + slPct);
      let hitSL = false;
      const entryIdx = findBarIdx(candles, entryT);
      const exitIdx = findBarIdx(candles, mondayT);

      for (let k = entryIdx; k <= Math.min(exitIdx, candles.length - 1); k++) {
        if (candles[k].h >= slPrice) {
          const slExit = slPrice * (1 + sp);
          const slRaw = (filledEntry / slExit - 1) * notional;
          trades.push({ pair, dir: "short", pnl: slRaw - fees, entryT, exitT: candles[k].t });
          hitSL = true;
          break;
        }
      }
      if (!hitSL) {
        trades.push({ pair, dir: "short", pnl: raw - fees, entryT, exitT: mondayT });
      }
    }
  }
  return trades;
}

// ── MAIN ───────────────────────────────────────────────────────────────
console.log("Loading candle data...");

const pairCandles = new Map<string, C5[]>();
for (const pair of [...PAIRS, "BTCUSDT"]) {
  const candles = load5m(pair);
  if (candles.length > 0) {
    pairCandles.set(pair, candles);
    console.log(`  ${pair}: ${candles.length} bars (${new Date(candles[0].t).toISOString().slice(0, 10)} to ${new Date(candles[candles.length - 1].t).toISOString().slice(0, 10)})`);
  }
}

const btcCandles = pairCandles.get("BTCUSDT")!;
const btcDaily = aggregateDaily(btcCandles);
console.log(`\nBTC daily bars: ${btcDaily.length}`);
console.log(`Date range: ${new Date(btcDaily[0].t).toISOString().slice(0, 10)} to ${new Date(btcDaily[btcDaily.length - 1].t).toISOString().slice(0, 10)}`);

const START = new Date("2023-01-01").getTime();
const END = new Date("2026-03-25").getTime();
const TOTAL_DAYS = (END - START) / DAY;

// OOS split: train 2023-01 to 2024-09, test 2024-10 to 2026-03
const SPLIT = new Date("2024-10-01").getTime();

console.log(`\nPeriod: ${new Date(START).toISOString().slice(0, 10)} to ${new Date(END).toISOString().slice(0, 10)} (${TOTAL_DAYS.toFixed(0)} days)`);
console.log(`Train: 2023-01 to 2024-09 | Test: 2024-10 to 2026-03`);
console.log(`Margin: $${MARGIN}/position, ${LEV}x leverage, Fee: ${FEE * 100}%/side`);
console.log(`SL: 3.5% from entry`);

// ── Run Strategies ─────────────────────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("STRATEGY 1: FRIDAY GRAVITY (Wed entry, Mon exit)");
console.log("Signal: BTC distance from nearest $5K round number > 3%");
console.log("=".repeat(80));

const fg_full = stratFridayGravity(btcDaily, pairCandles, START, END);
const fg_train = stratFridayGravity(btcDaily, pairCandles, START, SPLIT);
const fg_test = stratFridayGravity(btcDaily, pairCandles, SPLIT, END);

const fg_full_r = analyzeResult("Friday Gravity (Full)", fg_full, START, END);
const fg_train_r = analyzeResult("Friday Gravity (Train)", fg_train, START, SPLIT);
const fg_test_r = analyzeResult("Friday Gravity (Test)", fg_test, SPLIT, END);

console.log("\n--- Full Period ---");
printResult(fg_full_r);
console.log("\n--- Train (2023-01 to 2024-09) ---");
printResult(fg_train_r);
console.log("\n--- Test (2024-10 to 2026-03) ---");
printResult(fg_test_r);

// Direction breakdown
const fgLong = fg_full.filter(t => t.dir === "long");
const fgShort = fg_full.filter(t => t.dir === "short");
console.log(`\n  Long trades: ${fgLong.length}, PnL: $${fgLong.reduce((s, t) => s + t.pnl, 0).toFixed(2)}, WR: ${fgLong.length > 0 ? (fgLong.filter(t => t.pnl > 0).length / fgLong.length * 100).toFixed(1) : 0}%`);
console.log(`  Short trades: ${fgShort.length}, PnL: $${fgShort.reduce((s, t) => s + t.pnl, 0).toFixed(2)}, WR: ${fgShort.length > 0 ? (fgShort.filter(t => t.pnl > 0).length / fgShort.length * 100).toFixed(1) : 0}%`);

// Show signal occurrences
let fgSignals = 0;
for (let i = 25; i < btcDaily.length; i++) {
  if (btcDaily[i].t < START || btcDaily[i].t >= END) continue;
  if (dayOfWeek(btcDaily[i].t) !== 3) continue;
  const round5k = nearestRound5K(btcDaily[i].c);
  const pct = (btcDaily[i].c - round5k) / round5k;
  if (Math.abs(pct) > 0.03) fgSignals++;
}
console.log(`  Signal weeks: ${fgSignals} / ${Math.floor(TOTAL_DAYS / 7)} total weeks`);

console.log("\n" + "=".repeat(80));
console.log("STRATEGY 2: WEEKLY MEAN REVERSION (Wed entry, Mon exit)");
console.log("Signal: BTC 5-day return > |3%|");
console.log("=".repeat(80));

const mr_full = stratWeeklyMR(btcDaily, pairCandles, START, END);
const mr_train = stratWeeklyMR(btcDaily, pairCandles, START, SPLIT);
const mr_test = stratWeeklyMR(btcDaily, pairCandles, SPLIT, END);

const mr_full_r = analyzeResult("Weekly MR (Full)", mr_full, START, END);
const mr_train_r = analyzeResult("Weekly MR (Train)", mr_train, START, SPLIT);
const mr_test_r = analyzeResult("Weekly MR (Test)", mr_test, SPLIT, END);

console.log("\n--- Full Period ---");
printResult(mr_full_r);
console.log("\n--- Train (2023-01 to 2024-09) ---");
printResult(mr_train_r);
console.log("\n--- Test (2024-10 to 2026-03) ---");
printResult(mr_test_r);

const mrLong = mr_full.filter(t => t.dir === "long");
const mrShort = mr_full.filter(t => t.dir === "short");
console.log(`\n  Long trades: ${mrLong.length}, PnL: $${mrLong.reduce((s, t) => s + t.pnl, 0).toFixed(2)}, WR: ${mrLong.length > 0 ? (mrLong.filter(t => t.pnl > 0).length / mrLong.length * 100).toFixed(1) : 0}%`);
console.log(`  Short trades: ${mrShort.length}, PnL: $${mrShort.reduce((s, t) => s + t.pnl, 0).toFixed(2)}, WR: ${mrShort.length > 0 ? (mrShort.filter(t => t.pnl > 0).length / mrShort.length * 100).toFixed(1) : 0}%`);

let mrSignals = 0;
for (let i = 25; i < btcDaily.length; i++) {
  if (btcDaily[i].t < START || btcDaily[i].t >= END) continue;
  if (dayOfWeek(btcDaily[i].t) !== 3) continue;
  const ret = (btcDaily[i].c - btcDaily[i - 5].c) / btcDaily[i - 5].c;
  if (Math.abs(ret) > 0.03) mrSignals++;
}
console.log(`  Signal weeks: ${mrSignals} / ${Math.floor(TOTAL_DAYS / 7)} total weeks`);

console.log("\n" + "=".repeat(80));
console.log("STRATEGY 3: EXPIRY VOLATILITY FADE (Thu entry, Mon exit)");
console.log("Signal: BTC ATR(5) > 1.5x ATR(20) -> straddle (long 3, short 3)");
console.log("=".repeat(80));

const vf_full = stratVolFade(btcDaily, pairCandles, START, END);
const vf_train = stratVolFade(btcDaily, pairCandles, START, SPLIT);
const vf_test = stratVolFade(btcDaily, pairCandles, SPLIT, END);

const vf_full_r = analyzeResult("Vol Fade (Full)", vf_full, START, END);
const vf_train_r = analyzeResult("Vol Fade (Train)", vf_train, START, SPLIT);
const vf_test_r = analyzeResult("Vol Fade (Test)", vf_test, SPLIT, END);

console.log("\n--- Full Period ---");
printResult(vf_full_r);
console.log("\n--- Train (2023-01 to 2024-09) ---");
printResult(vf_train_r);
console.log("\n--- Test (2024-10 to 2026-03) ---");
printResult(vf_test_r);

const vfLong = vf_full.filter(t => t.dir === "long");
const vfShort = vf_full.filter(t => t.dir === "short");
console.log(`\n  Long trades: ${vfLong.length}, PnL: $${vfLong.reduce((s, t) => s + t.pnl, 0).toFixed(2)}, WR: ${vfLong.length > 0 ? (vfLong.filter(t => t.pnl > 0).length / vfLong.length * 100).toFixed(1) : 0}%`);
console.log(`  Short trades: ${vfShort.length}, PnL: $${vfShort.reduce((s, t) => s + t.pnl, 0).toFixed(2)}, WR: ${vfShort.length > 0 ? (vfShort.filter(t => t.pnl > 0).length / vfShort.length * 100).toFixed(1) : 0}%`);

let vfSignals = 0;
for (let i = 25; i < btcDaily.length; i++) {
  if (btcDaily[i].t < START || btcDaily[i].t >= END) continue;
  if (dayOfWeek(btcDaily[i].t) !== 4) continue;
  const a5 = atr(btcDaily, i, 5);
  const a20 = atr(btcDaily, i, 20);
  if (a5 && a20 && a5 / a20 > 1.5) vfSignals++;
}
console.log(`  Signal weeks: ${vfSignals} / ${Math.floor(TOTAL_DAYS / 7)} total weeks`);

// ── SUMMARY TABLE ──────────────────────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("SUMMARY COMPARISON");
console.log("=".repeat(80));
console.log("");
console.log("Strategy                    Trades  WR%    PF     Sharpe  $/day    MaxDD   AvgTrade");
console.log("-".repeat(90));

function summaryRow(r: StratResult): string {
  return `${r.name.padEnd(28)} ${String(r.trades.length).padStart(5)}  ${r.winRate.toFixed(1).padStart(5)}%  ${(r.pf === Infinity ? "INF" : r.pf.toFixed(2)).padStart(5)}  ${r.sharpe.toFixed(2).padStart(6)}  $${r.perDay.toFixed(3).padStart(7)}  $${r.maxDD.toFixed(0).padStart(5)}  $${r.avgTrade.toFixed(3).padStart(7)}`;
}

console.log(summaryRow(fg_full_r));
console.log(summaryRow(fg_train_r));
console.log(summaryRow(fg_test_r));
console.log("");
console.log(summaryRow(mr_full_r));
console.log(summaryRow(mr_train_r));
console.log(summaryRow(mr_test_r));
console.log("");
console.log(summaryRow(vf_full_r));
console.log(summaryRow(vf_train_r));
console.log(summaryRow(vf_test_r));

// ── Monthly Breakdown for best strategy ────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("MONTHLY BREAKDOWN - All Strategies (Full Period)");
console.log("=".repeat(80));

function monthlyBreakdown(name: string, trades: Trade[]): void {
  const months = new Map<string, { pnl: number; count: number; wins: number }>();
  for (const t of trades) {
    const d = new Date(t.exitT);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!months.has(key)) months.set(key, { pnl: 0, count: 0, wins: 0 });
    const m = months.get(key)!;
    m.pnl += t.pnl;
    m.count++;
    if (t.pnl > 0) m.wins++;
  }
  console.log(`\n  ${name}:`);
  console.log("  Month      Trades  WR%     PnL");
  const sorted = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [month, data] of sorted) {
    const wr = data.count > 0 ? (data.wins / data.count * 100).toFixed(0) : "0";
    console.log(`  ${month}     ${String(data.count).padStart(4)}  ${wr.padStart(4)}%  $${data.pnl.toFixed(2).padStart(8)}`);
  }
}

monthlyBreakdown("Friday Gravity", fg_full);
monthlyBreakdown("Weekly MR", mr_full);
monthlyBreakdown("Vol Fade", vf_full);

// ── Equity Curve (cumulative PnL by week) ──────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("CUMULATIVE PnL BY QUARTER");
console.log("=".repeat(80));

function quarterlyEquity(name: string, trades: Trade[]): void {
  const quarters = new Map<string, number>();
  const sorted = [...trades].sort((a, b) => a.exitT - b.exitT);
  let cum = 0;
  for (const t of sorted) {
    cum += t.pnl;
    const d = new Date(t.exitT);
    const q = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    quarters.set(q, cum);
  }
  console.log(`\n  ${name}:`);
  for (const [q, equity] of [...quarters.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const bar = equity >= 0 ? "+".repeat(Math.min(40, Math.round(equity / 2))) : "-".repeat(Math.min(40, Math.round(Math.abs(equity) / 2)));
    console.log(`  ${q}: $${equity.toFixed(2).padStart(8)} ${bar}`);
  }
}

quarterlyEquity("Friday Gravity", fg_full);
quarterlyEquity("Weekly MR", mr_full);
quarterlyEquity("Vol Fade", vf_full);

// ── Pair Performance ───────────────────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("TOP PAIR PERFORMANCE - Weekly MR (Full)");
console.log("=".repeat(80));

const pairPerf = new Map<string, { pnl: number; count: number; wins: number }>();
for (const t of mr_full) {
  if (!pairPerf.has(t.pair)) pairPerf.set(t.pair, { pnl: 0, count: 0, wins: 0 });
  const p = pairPerf.get(t.pair)!;
  p.pnl += t.pnl;
  p.count++;
  if (t.pnl > 0) p.wins++;
}
console.log("\n  Pair         Trades  WR%     PnL");
for (const [pair, data] of [...pairPerf.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
  const wr = data.count > 0 ? (data.wins / data.count * 100).toFixed(0) : "0";
  console.log(`  ${pair.padEnd(12)} ${String(data.count).padStart(5)}  ${wr.padStart(4)}%  $${data.pnl.toFixed(2).padStart(8)}`);
}

console.log("\n" + "=".repeat(80));
console.log("VERDICT");
console.log("=".repeat(80));
console.log("");

const allResults = [fg_full_r, mr_full_r, vf_full_r];
const best = allResults.reduce((a, b) => a.perDay > b.perDay ? a : b);
const bestTest = [fg_test_r, mr_test_r, vf_test_r].reduce((a, b) => a.perDay > b.perDay ? a : b);

console.log(`Best full-period: ${best.name} at $${best.perDay.toFixed(3)}/day`);
console.log(`Best OOS test: ${bestTest.name} at $${bestTest.perDay.toFixed(3)}/day`);

if (best.perDay > 0 && best.sharpe > 0.5 && best.pf > 1.2) {
  console.log("\nPotential edge detected. Worth further investigation with real max-pain data.");
} else if (best.perDay > 0) {
  console.log("\nMarginal positive returns. Edge too thin for live trading without real options data.");
} else {
  console.log("\nNo edge found with proxy signals. Max-pain effect may exist but these proxies don't capture it.");
}
console.log("");
