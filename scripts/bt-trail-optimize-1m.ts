/**
 * Trailing Stop Optimization - 1m vs 5m Comparison
 * Runs trailing stop backtest at both 5m and 1m precision,
 * then compares results to determine if 1m resolution matters.
 *
 * Run: npx tsx scripts/bt-trail-optimize-1m.ts
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

const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M = "/tmp/bt-pair-cache-1m";
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

const DONCHIAN_SIZE = 7;
const ST_SIZE = 5;

function loadBars(cacheDir: string, pair: string): C[] {
  const fp = path.join(cacheDir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
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

// ── Load 5m data (for signal generation and 5m trail simulation) ──
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = loadBars(CD_5M, p); if (d.length > 0) raw5m.set(p, d); }
const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) { dailyData.set(p, aggregate(bars, D, 200)); h4Data.set(p, aggregate(bars, H4, 40)); }
console.log(`5m loaded: ${raw5m.size} pairs`);

// ── Load 1m data (for 1m trail simulation only) ──
console.log("Loading 1m data...");
const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = loadBars(CD_1M, p); if (d.length > 0) raw1m.set(p, d); }
console.log(`1m loaded: ${raw1m.size} pairs`);

// ── BTC filter ──
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

// ── Signal generation (identical for both 5m and 1m - same signals) ──
interface Signal {
  pair: string; dir: "long"|"short"; engine: string;
  entryTime: number; entryPrice: number; sl: number; size: number;
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
          pos.exits.push({ time: bar.t, price: bar.c, reason: "" });
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

// ── Simulate with trail using arbitrary-resolution bars ──
function simulateWithTrailBars(sig: Signal, activation: number, distance: number, bars: C[]): Trade {
  const NOT = sig.size * LEV;
  const engineExitTime = sig.exitChecks[sig.exitChecks.length - 1]?.time ?? sig.entryTime + 60 * D;
  const engineExitPrice = sig.exitChecks[sig.exitChecks.length - 1]?.price ?? sig.entryPrice;
  const engineExitReason = sig.exitChecks[sig.exitChecks.length - 1]?.reason ?? "unknown";

  // Binary search for start index
  let lo = 0, hi = bars.length - 1, startIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; }
    else { lo = mid + 1; }
  }

  if (startIdx < 0) {
    const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);
    const xp = exitPx(sig.pair, sig.dir, engineExitPrice, engineExitReason === "sl");
    return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: engineExitTime, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: engineExitReason, engine: sig.engine, peakPct: 0 };
  }

  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);
  let peakPnlPct = 0;

  for (let i = startIdx; i < bars.length; i++) {
    const b = bars[i];
    if (b.t > engineExitTime) break;

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
      const triggerLevel = peakPnlPct - distance;
      if (unrealPnlPct <= triggerLevel) {
        const xp = exitPx(sig.pair, sig.dir, b.c, false);
        return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: b.t, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "trail", engine: sig.engine, peakPct: peakPnlPct };
      }
    }
  }

  // Engine exit
  const xp = exitPx(sig.pair, sig.dir, engineExitPrice, engineExitReason === "sl");
  return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: engineExitTime, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: engineExitReason, engine: sig.engine, peakPct: peakPnlPct };
}

// ── Generate signals ──
console.log("\nGenerating signals...");
const donchSignals = generateDonchianSignals();
const stSignals = generateSupertrendSignals();
const allSignals = [...donchSignals, ...stSignals];
console.log(`Donchian: ${donchSignals.length}, Supertrend: ${stSignals.length}, Total: ${allSignals.length}`);

// ── Trail configs from plan ──
interface TrailConfig { activation: number; distance: number; label: string; }
const configs: TrailConfig[] = [
  { activation: 0, distance: 0, label: "NO TRAIL" },
  { activation: 20, distance: 3, label: "20/3" },
  { activation: 20, distance: 5, label: "20/5" },
  { activation: 25, distance: 3, label: "25/3" },
  { activation: 25, distance: 5, label: "25/5" },
  { activation: 30, distance: 3, label: "30/3" },
  { activation: 30, distance: 5, label: "30/5" },
  { activation: 30, distance: 7, label: "30/7" },
  { activation: 30, distance: 10, label: "30/10" },
  { activation: 40, distance: 5, label: "40/5" },
  { activation: 40, distance: 7, label: "40/7" },
  { activation: 40, distance: 10, label: "40/10" },
];

interface ConfigResult {
  label: string;
  trades: number; total: number; perDay: number; pf: number;
  maxDD: number; sharpe: number; trailExits: number; wr: number;
}

function computeStats(trades: Trade[]): Omit<ConfigResult, "label"> {
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

  return {
    trades: trades.length,
    total,
    perDay: total / days,
    pf: grossLoss > 0 ? grossProfit / grossLoss : 99,
    maxDD,
    sharpe,
    trailExits: trades.filter(t => t.reason === "trail").length,
    wr: trades.length > 0 ? wins.length / trades.length * 100 : 0,
  };
}

// ── Run both simulations ──
const results5m: { config: TrailConfig; stats: ConfigResult; trades: Trade[] }[] = [];
const results1m: { config: TrailConfig; stats: ConfigResult; trades: Trade[] }[] = [];

for (const cfg of configs) {
  process.stdout.write(`\n${cfg.label}:`);

  // 5m simulation
  process.stdout.write(" 5m...");
  const trades5m: Trade[] = [];
  for (const sig of allSignals) {
    const bars = raw5m.get(sig.pair);
    if (!bars) continue;
    trades5m.push(simulateWithTrailBars(sig, cfg.activation, cfg.distance, bars));
  }
  const stats5m = computeStats(trades5m);
  results5m.push({ config: cfg, stats: { label: cfg.label, ...stats5m }, trades: trades5m });
  process.stdout.write(` $${stats5m.perDay.toFixed(2)}/day`);

  // 1m simulation
  process.stdout.write(" | 1m...");
  const trades1m: Trade[] = [];
  for (const sig of allSignals) {
    const bars = raw1m.get(sig.pair);
    if (!bars) continue;
    trades1m.push(simulateWithTrailBars(sig, cfg.activation, cfg.distance, bars));
  }
  const stats1m = computeStats(trades1m);
  results1m.push({ config: cfg, stats: { label: cfg.label, ...stats1m }, trades: trades1m });
  process.stdout.write(` $${stats1m.perDay.toFixed(2)}/day`);
}
console.log("\n");

// ── TABLE 1: 5m RESULTS ──
console.log("=".repeat(120));
console.log("TABLE 1: 5m RESULTS");
console.log("=".repeat(120));
console.log(`${"Config".padEnd(12)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"$/day".padStart(10)} ${"Total".padStart(12)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"MaxDD".padStart(10)} ${"TrailExits".padStart(11)}`);
console.log("-".repeat(120));
for (const r of results5m) {
  const s = r.stats;
  console.log(
    `${s.label.padEnd(12)} ${String(s.trades).padStart(7)} ${s.wr.toFixed(1).padStart(6)}% ${("$" + s.perDay.toFixed(2)).padStart(10)} ${("$" + s.total.toFixed(2)).padStart(12)} ${s.pf.toFixed(2).padStart(7)} ${s.sharpe.toFixed(2).padStart(8)} ${("$" + s.maxDD.toFixed(0)).padStart(10)} ${String(s.trailExits).padStart(11)}`
  );
}

// ── TABLE 2: 1m RESULTS ──
console.log("\n" + "=".repeat(120));
console.log("TABLE 2: 1m RESULTS");
console.log("=".repeat(120));
console.log(`${"Config".padEnd(12)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"$/day".padStart(10)} ${"Total".padStart(12)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"MaxDD".padStart(10)} ${"TrailExits".padStart(11)}`);
console.log("-".repeat(120));
for (const r of results1m) {
  const s = r.stats;
  console.log(
    `${s.label.padEnd(12)} ${String(s.trades).padStart(7)} ${s.wr.toFixed(1).padStart(6)}% ${("$" + s.perDay.toFixed(2)).padStart(10)} ${("$" + s.total.toFixed(2)).padStart(12)} ${s.pf.toFixed(2).padStart(7)} ${s.sharpe.toFixed(2).padStart(8)} ${("$" + s.maxDD.toFixed(0)).padStart(10)} ${String(s.trailExits).padStart(11)}`
  );
}

// ── TABLE 3: COMPARISON ──
console.log("\n" + "=".repeat(160));
console.log("TABLE 3: 5m vs 1m COMPARISON");
console.log("=".repeat(160));
console.log(
  `${"Config".padEnd(12)} ${"5m $/day".padStart(10)} ${"1m $/day".padStart(10)} ${"Delta".padStart(10)} ${"5m PF".padStart(7)} ${"1m PF".padStart(7)} ${"5m MaxDD".padStart(10)} ${"1m MaxDD".padStart(10)} ${"5m Trail".padStart(9)} ${"1m Trail".padStart(9)} ${"5m Sharpe".padStart(10)} ${"1m Sharpe".padStart(10)} ${"Delta%".padStart(8)}`
);
console.log("-".repeat(160));

for (let i = 0; i < configs.length; i++) {
  const s5 = results5m[i].stats;
  const s1 = results1m[i].stats;
  const delta = s1.perDay - s5.perDay;
  const deltaPct = s5.perDay !== 0 ? (delta / Math.abs(s5.perDay)) * 100 : 0;
  const marker = Math.abs(deltaPct) > 5 ? " ***" : "";
  console.log(
    `${configs[i].label.padEnd(12)} ${("$" + s5.perDay.toFixed(2)).padStart(10)} ${("$" + s1.perDay.toFixed(2)).padStart(10)} ${((delta >= 0 ? "+$" : "-$") + Math.abs(delta).toFixed(2)).padStart(10)} ${s5.pf.toFixed(2).padStart(7)} ${s1.pf.toFixed(2).padStart(7)} ${("$" + s5.maxDD.toFixed(0)).padStart(10)} ${("$" + s1.maxDD.toFixed(0)).padStart(10)} ${String(s5.trailExits).padStart(9)} ${String(s1.trailExits).padStart(9)} ${s5.sharpe.toFixed(2).padStart(10)} ${s1.sharpe.toFixed(2).padStart(10)} ${(deltaPct >= 0 ? "+" : "") + deltaPct.toFixed(1) + "%"}${marker}`
  );
}

// ── DIVERGENCE ANALYSIS ──
console.log("\n" + "=".repeat(160));
console.log("TRADE-LEVEL DIVERGENCE ANALYSIS");
console.log("=".repeat(160));

let totalDivergent = 0;

for (let ci = 0; ci < configs.length; ci++) {
  const cfg = configs[ci];
  if (cfg.activation === 0) continue; // No trail = no divergence possible for trail exits

  const t5 = results5m[ci].trades;
  const t1 = results1m[ci].trades;

  // Match trades by pair + dir + engine + entryTime
  const divergent: { pair: string; dir: string; engine: string; entryDate: string; reason5m: string; reason1m: string; pnl5m: number; pnl1m: number; peak5m: number; peak1m: number }[] = [];

  for (let j = 0; j < t5.length; j++) {
    if (j >= t1.length) break;
    const a = t5[j], b = t1[j];
    // Same signal, different outcome?
    if (a.reason !== b.reason || Math.abs(a.pnl - b.pnl) > 0.01) {
      divergent.push({
        pair: a.pair, dir: a.dir, engine: a.engine,
        entryDate: new Date(a.et).toISOString().slice(0, 10),
        reason5m: a.reason, reason1m: b.reason,
        pnl5m: a.pnl, pnl1m: b.pnl,
        peak5m: a.peakPct, peak1m: b.peakPct,
      });
    }
  }

  if (divergent.length > 0) {
    console.log(`\n${cfg.label}: ${divergent.length} divergent trades`);
    console.log(`${"Pair".padEnd(8)} ${"Dir".padEnd(6)} ${"Eng".padEnd(4)} ${"Entry".padEnd(12)} ${"5m Reason".padEnd(12)} ${"1m Reason".padEnd(12)} ${"5m PnL".padStart(10)} ${"1m PnL".padStart(10)} ${"5m Peak%".padStart(10)} ${"1m Peak%".padStart(10)}`);
    for (const d of divergent.slice(0, 20)) { // Show up to 20
      console.log(
        `${d.pair.padEnd(8)} ${d.dir.padEnd(6)} ${d.engine.padEnd(4)} ${d.entryDate.padEnd(12)} ${d.reason5m.padEnd(12)} ${d.reason1m.padEnd(12)} ${("$" + d.pnl5m.toFixed(2)).padStart(10)} ${("$" + d.pnl1m.toFixed(2)).padStart(10)} ${d.peak5m.toFixed(1).padStart(9)}% ${d.peak1m.toFixed(1).padStart(9)}%`
      );
    }
    if (divergent.length > 20) console.log(`  ... and ${divergent.length - 20} more`);
    totalDivergent += divergent.length;
  }
}

if (totalDivergent === 0) {
  console.log("\nNo divergent trades found across any config.");
}

// ── TRAIL EXIT COUNTS COMPARISON ──
console.log("\n" + "=".repeat(80));
console.log("TRAIL EXITS CAPTURED AT 1m BUT MISSED AT 5m:");
console.log("=".repeat(80));
for (let ci = 0; ci < configs.length; ci++) {
  const cfg = configs[ci];
  if (cfg.activation === 0) continue;
  const t5trail = results5m[ci].trades.filter(t => t.reason === "trail").length;
  const t1trail = results1m[ci].trades.filter(t => t.reason === "trail").length;
  const diff = t1trail - t5trail;
  console.log(`  ${cfg.label.padEnd(8)}: 5m=${t5trail}, 1m=${t1trail}, delta=${diff >= 0 ? "+" : ""}${diff}`);
}

// ── VERDICT ──
console.log("\n" + "=".repeat(80));
let anySignificant = false;
for (let i = 0; i < configs.length; i++) {
  const s5 = results5m[i].stats;
  const s1 = results1m[i].stats;
  const deltaPct = s5.total !== 0 ? Math.abs((s1.total - s5.total) / Math.abs(s5.total)) * 100 : 0;
  if (deltaPct > 5) { anySignificant = true; break; }
}

if (anySignificant) {
  console.log("VERDICT: 1m MATTERS -- some configs show >5% difference in total P&L");
} else {
  console.log("VERDICT: 5m IS SUFFICIENT -- no config shows >5% difference in total P&L");
}
console.log("=".repeat(80));
console.log("\nDone.");
