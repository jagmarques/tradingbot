/**
 * Trailing Stop Optimization
 * Tests all combinations of activation% and trail distance%
 * Uses 5m bars for realistic intra-bar SL/trail execution
 *
 * Run: npx tsx scripts/bt-trail-optimize.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; engine: string;
  peakPct: number;
}
interface Position {
  pair: string; dir: "long" | "short"; ep: number; et: number;
  sl: number; engine: string; leverage: number;
  peakPnlPct: number; trailActive: boolean;
}

const CD = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

const SP: Record<string, number> = {
  XRP: 2.1e-4, DOGE: 2.7e-4, ARB: 5.2e-4, ENA: 5.1e-4,
  UNI: 5.5e-4, APT: 6.4e-4, LINK: 6.9e-4, TRUMP: 7.3e-4,
  WLD: 8e-4, DOT: 9.9e-4, ADA: 11.1e-4, LDO: 11.6e-4, OP: 12.4e-4,
  BTC: 1.0e-4, SOL: 4.0e-4,
};

const PAIRS = ["OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "SOL"];

// Engine configs
const DONCHIAN_SIZE = 7;
const ST_SIZE = 5;
const GARCH_SIZE = 3;

function load5m(pair: string): C[] {
  const fp = path.join(CD, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars5m: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
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
  result.sort((a, b) => a.t - b.t);
  return result;
}

function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
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
    if (!init) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j]; ema[i] = s / period; init = true; }
    else { ema[i] = values[i] * k + ema[i - 1] * (1 - k); }
  }
  return ema;
}

function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j]; out[i] = s / period; }
  return out;
}

function donchCloseLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity; for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c); return mn;
}
function donchCloseHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity; for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c); return mx;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];
    if (i > atrPeriod) {
      if (!(lowerBand > lb[i-1] || cs[i-1].c < lb[i-1])) lowerBand = lb[i-1];
      if (!(upperBand < ub[i-1] || cs[i-1].c > ub[i-1])) upperBand = ub[i-1];
    }
    ub[i] = upperBand; lb[i] = lowerBand;
    if (i === atrPeriod) { dirs[i] = cs[i].c > upperBand ? 1 : -1; }
    else { dirs[i] = dirs[i-1] === 1 ? (cs[i].c < lowerBand ? -1 : 1) : (cs[i].c > upperBand ? 1 : -1); }
  }
  return { dir: dirs };
}

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function entryPx(pair: string, dir: "long"|"short", raw: number): number { const sp = getSpread(pair); return dir === "long" ? raw * (1 + sp) : raw * (1 - sp); }
function exitPx(pair: string, dir: "long"|"short", raw: number, isSL: boolean): number { const sp = getSpread(pair); const slip = isSL ? sp * SL_SLIP : sp; return dir === "long" ? raw * (1 - slip) : raw * (1 + slip); }
function calcPnl(dir: "long"|"short", ep: number, xp: number, notional: number): number {
  const raw = dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional;
  return raw - notional * FEE * 2;
}

// Load data
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = load5m(p); if (d.length > 0) raw5m.set(p, d); }
const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) { dailyData.set(p, aggregate(bars, D, 200)); h4Data.set(p, aggregate(bars, H4, 40)); }
console.log("Aggregated.");

const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);

function btcBullish(t: number): boolean {
  let idx = -1; for (let i = btcDaily.length - 1; i >= 0; i--) { if (btcDaily[i].t <= t) { idx = i; break; } }
  if (idx < 0) return false;
  const i20 = idx - (btcDaily.length - btcEma20.length);
  const i50 = idx - (btcDaily.length - btcEma50.length);
  if (i20 < 0 || i50 < 0) return false;
  return btcEma20[i20] > btcEma50[i50];
}

// Generate raw signals (entry/exit points) WITHOUT trailing
// Then apply trailing as a post-process using 5m bars
interface Signal {
  pair: string; dir: "long"|"short"; engine: string;
  entryTime: number; entryPrice: number; sl: number; size: number;
  // Exit conditions from engine (checked on engine timeframe)
  exitChecks: { time: number; price: number; reason: string }[];
}

function generateDonchianSignals(): Signal[] {
  const signals: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < 65) continue;
    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, 20);
    const slow = calcSMA(closes, 50);
    const atr = calcATR(cs, 14);

    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number; exits: { time: number; price: number; reason: string }[] } | null = null;

    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];

      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / D);
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && i >= 16) {
          if (pos.dir === "long") { const lo = donchCloseLow(cs, i, 15); if (bar.c < lo) { xp = bar.c; reason = "channel"; } }
          else { const hi = donchCloseHigh(cs, i, 15); if (bar.c > hi) { xp = bar.c; reason = "channel"; } }
        }
        if (!xp && holdDays >= 60) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          pos.exits.push({ time: bar.t, price: xp, reason });
          if (pos.et >= FULL_START && pos.et < FULL_END) {
            signals.push({ pair, dir: pos.dir, engine: "A", entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, size: DONCHIAN_SIZE, exitChecks: pos.exits });
          }
          pos = null;
        } else {
          pos.exits.push({ time: bar.t, price: bar.c, reason: "" }); // daily check, no exit
        }
      }

      if (!pos) {
        const prev = i - 1;
        if (fast[prev] === 0 || slow[prev] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[prev] <= slow[prev] && fast[i] > slow[i]) dir = "long";
        else if (fast[prev] >= slow[prev] && fast[i] < slow[i]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btcBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        const ep = bar.o;
        let sl = dir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, ep * 0.965); else sl = Math.min(sl, ep * 1.035);
        pos = { dir, ep, et: bar.t, sl, exits: [] };
      }
    }
  }
  return signals;
}

function generateSupertrendSignals(): Signal[] {
  const signals: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < 50) continue;
    const { dir: stDir } = calcSupertrend(cs, 14, 1.75);
    const atr = calcATR(cs, 14);

    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number; exits: { time: number; price: number; reason: string }[] } | null = null;

    for (let i = 17; i < cs.length; i++) {
      const bar = cs[i];
      const flip = stDir[i-1] !== stDir[i-2];

      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && flip) { xp = bar.o; reason = "flip"; }
        if (!xp) { const hours = (bar.t - pos.et) / H; if (hours >= 60 * 24) { xp = bar.c; reason = "max-hold"; } }

        if (xp > 0) {
          pos.exits.push({ time: bar.t, price: xp, reason });
          if (pos.et >= FULL_START && pos.et < FULL_END) {
            signals.push({ pair, dir: pos.dir, engine: "B", entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, size: ST_SIZE, exitChecks: pos.exits });
          }
          pos = null;
        }
      }

      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
        if (dir === "long" && !btcBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        const ep = bar.o;
        let sl = dir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, ep * 0.965); else sl = Math.min(sl, ep * 1.035);
        pos = { dir, ep, et: bar.t, sl, exits: [] };
      }
    }
  }
  return signals;
}

// Simulate a signal with trailing stop using 5m bars for precision
function simulateWithTrail(sig: Signal, activation: number, distance: number): Trade {
  const bars5m = raw5m.get(sig.pair)!;
  const NOT = sig.size * LEV;
  const engineExitTime = sig.exitChecks[sig.exitChecks.length - 1]?.time ?? sig.entryTime + 60 * D;
  const engineExitPrice = sig.exitChecks[sig.exitChecks.length - 1]?.price ?? sig.entryPrice;
  const engineExitReason = sig.exitChecks[sig.exitChecks.length - 1]?.reason ?? "unknown";

  // Find 5m bars in range
  let startIdx = -1;
  for (let i = 0; i < bars5m.length; i++) { if (bars5m[i].t >= sig.entryTime) { startIdx = i; break; } }
  if (startIdx < 0) {
    const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);
    const xp = exitPx(sig.pair, sig.dir, engineExitPrice, engineExitReason === "sl");
    return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: engineExitTime, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: engineExitReason, engine: sig.engine, peakPct: 0 };
  }

  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);
  let peakPnlPct = 0;
  let trailActive = false;

  for (let i = startIdx; i < bars5m.length; i++) {
    const b = bars5m[i];
    if (b.t > engineExitTime) break; // engine would have exited

    // SL check
    if (sig.dir === "long" && b.l <= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: b.t, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", engine: sig.engine, peakPct: peakPnlPct };
    }
    if (sig.dir === "short" && b.h >= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: b.t, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", engine: sig.engine, peakPct: peakPnlPct };
    }

    // Calculate unrealized P&L % (using close as proxy, leveraged)
    const pricePct = sig.dir === "long" ? (b.c / sig.entryPrice - 1) : (sig.entryPrice / b.c - 1);
    const unrealPnlPct = pricePct * LEV * 100;

    if (unrealPnlPct > peakPnlPct) peakPnlPct = unrealPnlPct;

    // Trailing stop check
    if (activation > 0 && peakPnlPct >= activation) {
      trailActive = true;
      const triggerLevel = peakPnlPct - distance;
      if (unrealPnlPct <= triggerLevel) {
        // Trail triggered - close at current price
        const xp = exitPx(sig.pair, sig.dir, b.c, false);
        return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: b.t, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "trail", engine: sig.engine, peakPct: peakPnlPct };
      }
    }
  }

  // Engine exit (no trail triggered before engine signal)
  const xp = exitPx(sig.pair, sig.dir, engineExitPrice, engineExitReason === "sl");
  return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: engineExitTime, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: engineExitReason, engine: sig.engine, peakPct: peakPnlPct };
}

// Generate all signals
console.log("Generating signals...");
const donchSignals = generateDonchianSignals();
const stSignals = generateSupertrendSignals();
const allSignals = [...donchSignals, ...stSignals];
console.log(`Donchian: ${donchSignals.length}, Supertrend: ${stSignals.length}, Total: ${allSignals.length}`);

// Test configurations
const activations = [0, 10, 15, 20, 25, 30, 40];  // 0 = no trailing
const distances = [2, 3, 4, 5, 7, 10];

interface Result {
  activation: number; distance: number;
  trades: number; wr: number; pf: number; total: number; perDay: number;
  maxDD: number; sharpe: number; trailExits: number; avgTrailPnl: number;
  oosTrades: number; oosTotal: number; oosPerDay: number; oosPf: number;
}

const results: Result[] = [];

console.log("\nRunning optimizations...");

for (const act of activations) {
  const dists = act === 0 ? [0] : distances;
  for (const dist of dists) {
    const label = act === 0 ? "NO TRAIL" : `${act}/${dist}`;
    process.stdout.write(`  ${label}...`);

    const trades: Trade[] = [];
    for (const sig of allSignals) {
      trades.push(simulateWithTrail(sig, act, dist));
    }

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const days = (FULL_END - FULL_START) / D;

    let cum = 0, peak = 0, maxDD = 0;
    const sorted = [...trades].sort((a, b) => a.xt - b.xt);
    for (const t of sorted) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

    const dayPnl = new Map<number, number>();
    for (const t of trades) { const d = Math.floor(t.xt / D); dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl); }
    const rets = [...dayPnl.values()];
    const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
    const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    const trailExits = trades.filter(t => t.reason === "trail");
    const avgTrailPnl = trailExits.length > 0 ? trailExits.reduce((s, t) => s + t.pnl, 0) / trailExits.length : 0;

    // OOS
    const oosTrades = trades.filter(t => t.et >= OOS_START);
    const oosTotal = oosTrades.reduce((s, t) => s + t.pnl, 0);
    const oosDays = (FULL_END - OOS_START) / D;
    const oosWins = oosTrades.filter(t => t.pnl > 0);
    const oosLosses = oosTrades.filter(t => t.pnl <= 0);
    const oosGP = oosWins.reduce((s, t) => s + t.pnl, 0);
    const oosGL = Math.abs(oosLosses.reduce((s, t) => s + t.pnl, 0));

    results.push({
      activation: act, distance: dist,
      trades: trades.length,
      wr: wins.length / trades.length * 100,
      pf: grossLoss > 0 ? grossProfit / grossLoss : 99,
      total, perDay: total / days, maxDD, sharpe,
      trailExits: trailExits.length,
      avgTrailPnl,
      oosTrades: oosTrades.length,
      oosTotal,
      oosPerDay: oosTotal / oosDays,
      oosPf: oosGL > 0 ? oosGP / oosGL : 99,
    });

    console.log(` $${(total / days).toFixed(2)}/day, DD $${maxDD.toFixed(0)}, ${trailExits.length} trail exits`);
  }
}

// Sort by $/day
results.sort((a, b) => b.perDay - a.perDay);

console.log("\n" + "=".repeat(130));
console.log("TRAILING STOP OPTIMIZATION RESULTS (sorted by $/day)");
console.log("Donchian SMA(20/50) $7 + Supertrend(14,1.75) $5 | 5m bar precision | Full period 2023-01 to 2026-03");
console.log("=".repeat(130));

console.log(`${"Config".padEnd(12)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"Total".padStart(12)} ${"$/day".padStart(10)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"MaxDD".padStart(10)} ${"TrailExits".padStart(11)} ${"AvgTrailPnL".padStart(12)} ${"OOS$/day".padStart(10)} ${"OOS PF".padStart(8)}`);
console.log("-".repeat(130));

for (const r of results) {
  const label = r.activation === 0 ? "NO TRAIL" : `${r.activation}/${r.distance}`;
  const marker = r.activation === 0 ? " <<<" : "";
  console.log(
    `${label.padEnd(12)} ${String(r.trades).padStart(7)} ${r.wr.toFixed(1).padStart(6)}% ${("$" + r.total.toFixed(2)).padStart(12)} ${("$" + r.perDay.toFixed(2)).padStart(10)} ${r.pf.toFixed(2).padStart(7)} ${r.sharpe.toFixed(2).padStart(8)} ${("$" + r.maxDD.toFixed(0)).padStart(10)} ${String(r.trailExits).padStart(11)} ${("$" + r.avgTrailPnl.toFixed(2)).padStart(12)} ${("$" + r.oosPerDay.toFixed(2)).padStart(10)} ${r.oosPf.toFixed(2).padStart(8)}${marker}`
  );
}

// Highlight best configs
console.log("\n" + "=".repeat(130));
console.log("TOP 5 BY $/DAY:");
for (let i = 0; i < Math.min(5, results.length); i++) {
  const r = results[i];
  const label = r.activation === 0 ? "NO TRAIL" : `${r.activation}/${r.distance}`;
  console.log(`  ${i+1}. ${label}: $${r.perDay.toFixed(2)}/day, MaxDD $${r.maxDD.toFixed(0)}, PF ${r.pf.toFixed(2)}, Sharpe ${r.sharpe.toFixed(2)}, OOS $${r.oosPerDay.toFixed(2)}/day`);
}

// Best by MaxDD
const byDD = [...results].sort((a, b) => a.maxDD - b.maxDD);
console.log("\nTOP 5 BY LOWEST MAX DD:");
for (let i = 0; i < Math.min(5, byDD.length); i++) {
  const r = byDD[i];
  const label = r.activation === 0 ? "NO TRAIL" : `${r.activation}/${r.distance}`;
  console.log(`  ${i+1}. ${label}: MaxDD $${r.maxDD.toFixed(0)}, $${r.perDay.toFixed(2)}/day, PF ${r.pf.toFixed(2)}, Sharpe ${r.sharpe.toFixed(2)}`);
}

// Best balance ($/day * sharpe / maxDD)
const byBalance = [...results].sort((a, b) => (b.perDay * b.sharpe / Math.max(b.maxDD, 1)) - (a.perDay * a.sharpe / Math.max(a.maxDD, 1)));
console.log("\nTOP 5 BY RISK-ADJUSTED ($/day * Sharpe / MaxDD):");
for (let i = 0; i < Math.min(5, byBalance.length); i++) {
  const r = byBalance[i];
  const label = r.activation === 0 ? "NO TRAIL" : `${r.activation}/${r.distance}`;
  const score = r.perDay * r.sharpe / Math.max(r.maxDD, 1);
  console.log(`  ${i+1}. ${label}: score ${score.toFixed(4)}, $${r.perDay.toFixed(2)}/day, MaxDD $${r.maxDD.toFixed(0)}, Sharpe ${r.sharpe.toFixed(2)}`);
}

console.log("\nDone.");
