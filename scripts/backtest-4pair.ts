/**
 * 4-pair GARCH-chan backtest: DASH, TRUMP, TON (lowest-correlated subset).
 * Simplified version of backtest-hedge.ts - no hedge, portfolio-level simulation.
 *
 * npx tsx scripts/backtest-4pair.ts
 */

import * as fs from "fs";
import * as path from "path";
import { ATR } from "technicalindicators";

interface Candle { t: number; o: number; h: number; l: number; c: number; }
interface Position {
  pair: string; direction: "long" | "short"; entryPrice: number; entryTime: number;
  size: number; leverage: number; stopLoss: number; takeProfit: number;
  peakPnlPct: number; trailActive: boolean;
}
interface Trade {
  pair: string; direction: "long" | "short"; entryPrice: number; exitPrice: number;
  entryTime: number; exitTime: number; pnl: number; reason: string;
}

const CACHE_1H = "/tmp/bt-pair-cache";
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

// 4 lowest-correlated pairs (HYPE excluded - no cache data)
const PAIRS_WANTED = ["DASHUSDT", "TRUMPUSDT", "TONUSDT", "HYPEUSDT"];
const PAIRS = PAIRS_WANTED.filter(p => fs.existsSync(path.join(CACHE_1H, p + ".json")));

console.log(`Using pairs: ${PAIRS.join(", ")}`);
if (PAIRS.length < PAIRS_WANTED.length) {
  const missing = PAIRS_WANTED.filter(p => !PAIRS.includes(p));
  console.log(`Skipped (no cache): ${missing.join(", ")}`);
}

const SPREAD_MAP: Record<string, number> = {
  TRUMPUSDT: 3.65e-4,
  TONUSDT: 4.6e-4,
  DASHUSDT: 7.15e-4,
  HYPEUSDT: 5e-4,
};

const HL_FEE = 0.00045;
const ATR_PERIOD = 14;
const CHAN_MULT = 6;
const LOOKBACK = 3;
const VOL_WINDOW = 20;
const Z_THRESH = 0.7;
const SL_CAP = 0.035;
const TP_PCT = 0.015;
const TRAIL_A = 5;
const TRAIL_D = 2;
const MAX_HOLD = 8 * HOUR_MS;
const SIZE = 10;
const LEVERAGE = 10;
const MAX_PER_DIR = 10;

function loadCandles(pair: string): Candle[] {
  const fp = path.join(CACHE_1H, pair + ".json");
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as unknown[];
  return (raw as (number[] | Candle)[]).map(b =>
    Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] } : b as Candle
  );
}

function getSpread(pair: string): number { return SPREAD_MAP[pair] ?? 4e-4; }

function garchSignal(cs: Candle[], barIdx: number): "long" | "short" | null {
  if (barIdx < 30) return null;
  const slice = cs.slice(0, barIdx);
  const last = slice.length - 1;
  const atrVals = ATR.calculate({ period: ATR_PERIOD, high: slice.map(c => c.h), low: slice.map(c => c.l), close: slice.map(c => c.c) });
  if (atrVals.length < 2 || last - LOOKBACK < 0) return null;
  const mom = slice[last].c / slice[last - LOOKBACK].c - 1;
  const rets: number[] = [];
  for (let i = Math.max(1, last - VOL_WINDOW + 1); i <= last; i++) rets.push(slice[i].c / slice[i - 1].c - 1);
  if (rets.length < 10) return null;
  const vol = Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length);
  if (vol === 0) return null;
  const z = mom / vol;
  if (z > Z_THRESH) return "long";
  if (z < -Z_THRESH) return "short";
  return null;
}

function computeAtr(cs: Candle[]): number[] {
  return ATR.calculate({ period: ATR_PERIOD, high: cs.map(c => c.h), low: cs.map(c => c.l), close: cs.map(c => c.c) });
}

function capSl(entry: number, sl: number, dir: "long" | "short"): number {
  if (dir === "long") return Math.max(sl, entry * (1 - SL_CAP));
  return Math.min(sl, entry * (1 + SL_CAP));
}

function simulate(startTs: number, endTs: number): { trades: Trade[]; equityCurve: number[] } {
  const pairData = new Map<string, { candles: Candle[]; atr: number[]; tsMap: Map<number, number> }>();
  for (const pair of PAIRS) {
    const candles = loadCandles(pair);
    if (candles.length < 40) continue;
    const tsMap = new Map<number, number>();
    candles.forEach((c, i) => tsMap.set(c.t, i));
    pairData.set(pair, { candles, atr: computeAtr(candles), tsMap });
  }

  const allTimestamps = new Set<number>();
  for (const { candles } of pairData.values()) {
    for (const c of candles) if (c.t >= startTs && c.t < endTs) allTimestamps.add(c.t);
  }
  const sortedTs = [...allTimestamps].sort((a, b) => a - b);

  const openPositions = new Map<string, Position>();
  const trades: Trade[] = [];
  const equityCurve: number[] = [];
  let cumulativePnl = 0;

  for (const ts of sortedTs) {
    const closedThisBar = new Set<string>();

    // Check exits
    for (const [pair, pos] of openPositions) {
      const pd = pairData.get(pair)!;
      const barIdx = pd.tsMap.get(ts) ?? -1;
      if (barIdx < 0) continue;
      const bar = pd.candles[barIdx];
      const spread = getSpread(pair);

      // Update chandelier stop
      const atrOff = pd.candles.length - pd.atr.length;
      const atrIdx = barIdx - 1 - atrOff;
      if (atrIdx >= 0 && atrIdx < pd.atr.length) {
        const atr = pd.atr[atrIdx];
        const sliceStart = Math.max(0, barIdx - ATR_PERIOD);
        if (pos.direction === "long") {
          const hh = Math.max(...pd.candles.slice(sliceStart, barIdx).map(c => c.h));
          const ns = hh - CHAN_MULT * atr;
          if (ns > pos.stopLoss) pos.stopLoss = ns;
        } else {
          const ll = Math.min(...pd.candles.slice(sliceStart, barIdx).map(c => c.l));
          const ns = ll + CHAN_MULT * atr;
          if (ns < pos.stopLoss) pos.stopLoss = ns;
        }
      }

      let exitPrice = 0, reason = "";

      const slHit = pos.direction === "long" ? bar.l <= pos.stopLoss : bar.h >= pos.stopLoss;
      if (slHit) { exitPrice = pos.direction === "long" ? pos.stopLoss * (1 - spread) : pos.stopLoss * (1 + spread); reason = "stop-loss"; }

      if (!reason && pos.takeProfit > 0) {
        const tpHit = pos.direction === "long" ? bar.h >= pos.takeProfit : bar.l <= pos.takeProfit;
        if (tpHit) { exitPrice = pos.direction === "long" ? pos.takeProfit * (1 - spread) : pos.takeProfit * (1 + spread); reason = "take-profit"; }
      }

      if (!reason) {
        const pnlPct = pos.direction === "long"
          ? (bar.c - pos.entryPrice) / pos.entryPrice * pos.leverage * 100
          : (pos.entryPrice - bar.c) / pos.entryPrice * pos.leverage * 100;
        if (pnlPct > pos.peakPnlPct) pos.peakPnlPct = pnlPct;
        if (TRAIL_A > 0 && pos.peakPnlPct >= TRAIL_A && pnlPct <= pos.peakPnlPct - TRAIL_D) {
          exitPrice = pos.direction === "long" ? bar.c * (1 - spread) : bar.c * (1 + spread); reason = "trailing-stop";
        }
      }

      if (!reason && ts - pos.entryTime >= MAX_HOLD) {
        exitPrice = pos.direction === "long" ? bar.c * (1 - spread) : bar.c * (1 + spread); reason = "max-hold";
      }

      if (reason) {
        const fees = SIZE * LEVERAGE * HL_FEE * 2;
        const rawPnl = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * SIZE * LEVERAGE
          : (pos.entryPrice / exitPrice - 1) * SIZE * LEVERAGE;
        const pnl = rawPnl - fees;
        trades.push({ pair, direction: pos.direction, entryPrice: pos.entryPrice, exitPrice, entryTime: pos.entryTime, exitTime: ts, pnl, reason });
        cumulativePnl += pnl;
        openPositions.delete(pair);
        closedThisBar.add(pair);
      }
    }

    // Entry logic
    for (const [pair, pd] of pairData) {
      if (openPositions.has(pair)) continue;
      if (closedThisBar.has(pair)) continue;
      const barIdx = pd.tsMap.get(ts) ?? -1;
      if (barIdx < 30) continue;

      const dir = garchSignal(pd.candles, barIdx);
      if (!dir) continue;

      const dirCount = [...openPositions.values()].filter(p => p.direction === dir).length;
      if (dirCount >= MAX_PER_DIR) continue;

      const entry = pd.candles[barIdx].o;
      const spread = getSpread(pair);
      const entryWithSpread = dir === "long" ? entry * (1 + spread) : entry * (1 - spread);
      const cs = pd.candles.slice(0, barIdx);
      const last = cs.length - 1;
      const atrOff = cs.length - pd.atr.length;
      const atrIdx = last - atrOff;
      if (atrIdx < 0 || atrIdx >= pd.atr.length) continue;
      const atr = pd.atr[atrIdx];

      let sl: number;
      if (dir === "long") {
        const hh = Math.max(...cs.slice(Math.max(0, last - ATR_PERIOD), last + 1).map(c => c.h));
        sl = capSl(entryWithSpread, hh - CHAN_MULT * atr, "long");
        if (sl >= entryWithSpread) continue;
      } else {
        const ll = Math.min(...cs.slice(Math.max(0, last - ATR_PERIOD), last + 1).map(c => c.l));
        sl = capSl(entryWithSpread, ll + CHAN_MULT * atr, "short");
        if (sl <= entryWithSpread) continue;
      }

      const tp = dir === "long" ? entryWithSpread * (1 + TP_PCT) : entryWithSpread * (1 - TP_PCT);
      openPositions.set(pair, {
        pair, direction: dir, entryPrice: entryWithSpread, entryTime: ts,
        size: SIZE, leverage: LEVERAGE, stopLoss: sl, takeProfit: tp,
        peakPnlPct: 0, trailActive: false,
      });
    }

    equityCurve.push(cumulativePnl);
  }

  return { trades, equityCurve };
}

function stats(trades: Trade[], equityCurve: number[], days: number) {
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;

  let maxDd = 0, peak = -Infinity;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDd) maxDd = dd;
  }

  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.exitTime / DAY_MS);
    dailyPnl.set(day, (dailyPnl.get(day) || 0) + t.pnl);
  }
  const dr = Array.from(dailyPnl.values());
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  return { trades: trades.length, wins, winRate: trades.length > 0 ? (wins / trades.length * 100) : 0,
    totalPnl, sharpe, maxDd, perDay: totalPnl / Math.max(days, 1) };
}

function main() {
  const testStart = new Date("2025-06-01").getTime();
  const testEnd = new Date("2026-03-20").getTime();
  const days = (testEnd - testStart) / DAY_MS;

  console.log(`\nGARCH-chan 4-pair (low-correlation) Backtest`);
  console.log(`Date range: 2025-06-01 to 2026-03-20 (${days.toFixed(0)} days)`);
  console.log(`Pairs: ${PAIRS.join(", ")}\n`);

  const t0 = Date.now();
  const { trades, equityCurve } = simulate(testStart, testEnd);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const s = stats(trades, equityCurve, days);

  console.log("=".repeat(70));
  console.log("PORTFOLIO SUMMARY");
  console.log("=".repeat(70));
  console.log(`Total PnL:    $${s.totalPnl.toFixed(2)}`);
  console.log(`Trades:       ${s.trades}`);
  console.log(`Win Rate:     ${s.winRate.toFixed(1)}%`);
  console.log(`Sharpe:       ${s.sharpe.toFixed(2)}`);
  console.log(`Max Drawdown: $${s.maxDd.toFixed(2)}`);
  console.log(`Per Day:      $${s.perDay.toFixed(2)}`);
  console.log(`Runtime:      ${elapsed}s`);
  console.log("=".repeat(70));

  console.log("\nPER-PAIR BREAKDOWN");
  console.log("-".repeat(60));
  console.log("Pair".padEnd(12) + "Trades".padStart(8) + "WR%".padStart(8) + "PnL".padStart(12));
  console.log("-".repeat(60));

  for (const pair of PAIRS) {
    const pairTrades = trades.filter(t => t.pair === pair);
    const pairWins = pairTrades.filter(t => t.pnl > 0).length;
    const pairPnl = pairTrades.reduce((s, t) => s + t.pnl, 0);
    const pairWr = pairTrades.length > 0 ? (pairWins / pairTrades.length * 100).toFixed(1) : "0.0";
    console.log(
      pair.replace("USDT", "").padEnd(12) +
      String(pairTrades.length).padStart(8) +
      (pairWr + "%").padStart(8) +
      ("$" + pairPnl.toFixed(2)).padStart(12)
    );
  }
  console.log("-".repeat(60));
  console.log(
    "TOTAL".padEnd(12) +
    String(s.trades).padStart(8) +
    (s.winRate.toFixed(1) + "%").padStart(8) +
    ("$" + s.totalPnl.toFixed(2)).padStart(12)
  );

  console.log("\nREASON BREAKDOWN");
  console.log("-".repeat(50));
  const reasons = ["stop-loss", "take-profit", "trailing-stop", "max-hold"];
  for (const r of reasons) {
    const rt = trades.filter(t => t.reason === r);
    if (rt.length === 0) continue;
    const rPnl = rt.reduce((s, t) => s + t.pnl, 0);
    const rWr = (rt.filter(t => t.pnl > 0).length / rt.length * 100).toFixed(0);
    console.log(`${r.padEnd(16)} ${String(rt.length).padStart(5)} trades  ${rWr}%w  $${rPnl.toFixed(2)}`);
  }

  console.log("\nDECISION GUIDANCE");
  console.log("-".repeat(50));
  if (s.totalPnl > -200) {
    console.log(`Result: $${s.totalPnl.toFixed(2)} > -$200 threshold`);
    console.log("Recommendation: reduce-pairs (keep running with 4-pair subset)");
  } else {
    console.log(`Result: $${s.totalPnl.toFixed(2)} < -$200 threshold`);
    console.log("Recommendation: pause-garch (backtest still significantly negative)");
  }
}

main();
