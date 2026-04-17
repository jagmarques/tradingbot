/**
 * Trailing Stop Test with 1s-precision data (aggregated to 1m from actual 1s candles)
 * Period: Dec 2025 - Mar 2026 (4 months of real 1s tick data)
 * Tests: no trail vs various activation/distance combos
 * Uses 1s-aggregated-1m data for trail checks (captures every wick)
 * Uses 5m data for engine signals (same as live)
 *
 * Run: npx tsx scripts/bt-trail-1s-precision.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; engine: string;
  peakPct: number; holdHours: number;
}

const CD_5m = "/tmp/bt-pair-cache-5m";
const CD_1s = "/tmp/bt-pair-cache-1s-as-1m"; // 1s aggregated to 1m
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;

// Period: Dec 2025 - Mar 2026 (what the 1s data covers)
const START = new Date("2025-12-01").getTime();
const END = new Date("2026-03-19").getTime();

const SP: Record<string, number> = {
  XRP: 2.1e-4, DOGE: 2.7e-4, ARB: 5.2e-4, ENA: 5.1e-4,
  UNI: 5.5e-4, APT: 6.4e-4, LINK: 6.9e-4, TRUMP: 7.3e-4,
  WLD: 8e-4, DOT: 9.9e-4, ADA: 11.1e-4, LDO: 11.6e-4, OP: 12.4e-4,
};

// Only pairs that have both 5m AND 1s data
const PAIRS = ["OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI"];

const DONCHIAN_SIZE = 7;
const ST_SIZE = 5;

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
    let arr = groups.get(bucket); if (!arr) { arr = []; groups.set(bucket, arr); } arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({ t: ts, o: grp[0].o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1].c });
  }
  return result.sort((a, b) => a.t - b.t);
}

function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i < period) continue;
    if (i === period) { let s = 0; for (let j = 1; j <= period; j++) s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c)); atr[i] = s / period; }
    else { atr[i] = (atr[i - 1] * (period - 1) + tr) / period; }
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

function donchCloseLow(cs: C[], idx: number, lb: number): number { let mn = Infinity; for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c); return mn; }
function donchCloseHigh(cs: C[], idx: number, lb: number): number { let mx = -Infinity; for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c); return mx; }

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { dir: number[] } {
  const atr = calcATR(cs, atrPeriod); const dirs = new Array(cs.length).fill(1); const ub = new Array(cs.length).fill(0); const lb = new Array(cs.length).fill(0);
  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2; let upperBand = hl2 + mult * atr[i]; let lowerBand = hl2 - mult * atr[i];
    if (i > atrPeriod) { if (!(lowerBand > lb[i-1] || cs[i-1].c < lb[i-1])) lowerBand = lb[i-1]; if (!(upperBand < ub[i-1] || cs[i-1].c > ub[i-1])) upperBand = ub[i-1]; }
    ub[i] = upperBand; lb[i] = lowerBand;
    if (i === atrPeriod) dirs[i] = cs[i].c > upperBand ? 1 : -1;
    else dirs[i] = dirs[i-1] === 1 ? (cs[i].c < lowerBand ? -1 : 1) : (cs[i].c > upperBand ? 1 : -1);
  }
  return { dir: dirs };
}

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function entryPx(pair: string, dir: "long"|"short", raw: number): number { const sp = getSpread(pair); return dir === "long" ? raw * (1 + sp) : raw * (1 - sp); }
function exitPx(pair: string, dir: "long"|"short", raw: number, isSL: boolean): number { const sp = getSpread(pair); const slip = isSL ? sp * SL_SLIP : sp; return dir === "long" ? raw * (1 - slip) : raw * (1 + slip); }
function calcPnl(dir: "long"|"short", ep: number, xp: number, notional: number): number {
  return (dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional) - notional * FEE * 2;
}

// Load all data
console.log("Loading data...");

// 5m data for engine signals + BTC filter
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = loadJson(CD_5m, p); if (d.length > 0) raw5m.set(p, d); }

// 1s-as-1m data for precise trailing
const raw1sAs1m = new Map<string, C[]>();
for (const p of PAIRS) { const d = loadJson(CD_1s, p); if (d.length > 0) { raw1sAs1m.set(p, d); console.log(`  ${p}: ${d.length} 1m bars (from 1s)`); } }

// Aggregate 5m to daily/4h
const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) { dailyData.set(p, aggregate(bars, D, 200)); h4Data.set(p, aggregate(bars, H4, 40)); }

// Also aggregate 1s-1m to 5m for comparison run
const raw1sAs5m = new Map<string, C[]>();
for (const [p, bars] of raw1sAs1m) { raw1sAs5m.set(p, aggregate(bars, 5 * 60_000, 4)); }

// BTC filter
const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);
function btcBullish(t: number): boolean {
  let idx = -1; for (let i = btcDaily.length - 1; i >= 0; i--) { if (btcDaily[i].t <= t) { idx = i; break; } }
  if (idx < 0) return false;
  const i20 = idx - (btcDaily.length - btcEma20.length); const i50 = idx - (btcDaily.length - btcEma50.length);
  return i20 >= 0 && i50 >= 0 && btcEma20[i20] > btcEma50[i50];
}

console.log("Loaded.\n");

// Signal type: entry + engine exit time/price
interface Signal {
  pair: string; dir: "long"|"short"; engine: string; size: number;
  entryTime: number; entryPrice: number; sl: number;
  engineExitTime: number; engineExitPrice: number; engineExitReason: string;
}

// Generate Donchian signals in the Dec25-Mar26 window
function getDonchianSignals(): Signal[] {
  const signals: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair); if (!cs || cs.length < 65) continue;
    const closes = cs.map(c => c.c); const fast = calcSMA(closes, 20); const slow = calcSMA(closes, 50); const atr = calcATR(cs, 14);
    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;
    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = "";
        const holdDays = Math.round((bar.t - pos.et) / D);
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && i >= 16) {
          if (pos.dir === "long") { const lo = donchCloseLow(cs, i, 15); if (bar.c < lo) { xp = bar.c; reason = "channel"; } }
          else { const hi = donchCloseHigh(cs, i, 15); if (bar.c > hi) { xp = bar.c; reason = "channel"; } }
        }
        if (!xp && holdDays >= 60) { xp = bar.c; reason = "max-hold"; }
        if (xp > 0) {
          if (pos.et >= START && pos.et < END) {
            signals.push({ pair, dir: pos.dir, engine: "Donchian", size: DONCHIAN_SIZE, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, engineExitTime: bar.t, engineExitPrice: xp, engineExitReason: reason });
          }
          pos = null;
        }
      }
      if (!pos) {
        const prev = i - 1; if (fast[prev] === 0 || slow[prev] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[prev] <= slow[prev] && fast[i] > slow[i]) dir = "long";
        else if (fast[prev] >= slow[prev] && fast[i] < slow[i]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btcBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965); else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return signals;
}

function getSupertrendSignals(): Signal[] {
  const signals: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair); if (!cs || cs.length < 50) continue;
    const { dir: stDir } = calcSupertrend(cs, 14, 1.75); const atr = calcATR(cs, 14);
    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;
    for (let i = 17; i < cs.length; i++) {
      const bar = cs[i]; const flip = stDir[i-1] !== stDir[i-2];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && flip) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t - pos.et) / H >= 60 * 24) { xp = bar.c; reason = "max-hold"; }
        if (xp > 0) {
          if (pos.et >= START && pos.et < END) {
            signals.push({ pair, dir: pos.dir, engine: "Supertrend", size: ST_SIZE, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, engineExitTime: bar.t, engineExitPrice: xp, engineExitReason: reason });
          }
          pos = null;
        }
      }
      if (!pos && flip && bar.t >= START) {
        const dir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
        if (dir === "long" && !btcBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965); else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return signals;
}

// Simulate with trail using high-res data
function simWithTrail(sig: Signal, bars: C[], act: number, dist: number): Trade {
  const NOT = sig.size * LEV;
  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

  // Find bars in range
  let startIdx = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i].t >= sig.entryTime) { startIdx = i; break; } }

  if (startIdx < 0) {
    const xp = exitPx(sig.pair, sig.dir, sig.engineExitPrice, sig.engineExitReason === "sl");
    return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: sig.engineExitTime, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.engineExitReason, engine: sig.engine, peakPct: 0, holdHours: (sig.engineExitTime - sig.entryTime) / H };
  }

  let peakPnlPct = 0;

  for (let i = startIdx; i < bars.length; i++) {
    const b = bars[i];
    if (b.t > sig.engineExitTime) break;

    // SL check using intrabar high/low
    if (sig.dir === "long" && b.l <= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: b.t, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", engine: sig.engine, peakPct: peakPnlPct, holdHours: (b.t - sig.entryTime) / H };
    }
    if (sig.dir === "short" && b.h >= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: b.t, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", engine: sig.engine, peakPct: peakPnlPct, holdHours: (b.t - sig.entryTime) / H };
    }

    // Track peak using HIGH for longs, LOW for shorts (captures wicks!)
    const bestPrice = sig.dir === "long" ? b.h : b.l;
    const bestPct = sig.dir === "long" ? (bestPrice / sig.entryPrice - 1) * LEV * 100 : (sig.entryPrice / bestPrice - 1) * LEV * 100;
    if (bestPct > peakPnlPct) peakPnlPct = bestPct;

    // Trail check using CLOSE for current level (more conservative than using worst intrabar)
    const currPct = sig.dir === "long" ? (b.c / sig.entryPrice - 1) * LEV * 100 : (sig.entryPrice / b.c - 1) * LEV * 100;

    if (act > 0 && peakPnlPct >= act) {
      const trigger = peakPnlPct - dist;
      if (currPct <= trigger) {
        const xp = exitPx(sig.pair, sig.dir, b.c, false);
        return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: b.t, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "trail", engine: sig.engine, peakPct: peakPnlPct, holdHours: (b.t - sig.entryTime) / H };
      }
    }
  }

  // Engine exit
  const xp = exitPx(sig.pair, sig.dir, sig.engineExitPrice, sig.engineExitReason === "sl");
  return { pair: sig.pair, dir: sig.dir, ep, xp, et: sig.entryTime, xt: sig.engineExitTime, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.engineExitReason, engine: sig.engine, peakPct: peakPnlPct, holdHours: (sig.engineExitTime - sig.entryTime) / H };
}

// Generate signals
console.log("Generating signals for Dec 2025 - Mar 2026...");
const allSignals = [...getDonchianSignals(), ...getSupertrendSignals()];
console.log(`Total signals: ${allSignals.length} (Donchian: ${allSignals.filter(s=>s.engine==="Donchian").length}, ST: ${allSignals.filter(s=>s.engine==="Supertrend").length})`);

// Test configs
const configs: [number, number][] = [
  [0, 0],      // no trail
  [15, 3], [15, 5],
  [20, 3], [20, 5],
  [25, 3], [25, 5],
  [30, 3], [30, 5], [30, 7], [30, 10],
  [40, 5], [40, 7], [40, 10],
];

interface Result {
  label: string; resolution: string;
  trades: number; wr: number; pf: number; total: number; perDay: number;
  maxDD: number; trailExits: number; avgTrailPnl: number;
  winnersGivenBack: number; // trades that were winners w/o trail but losers with trail
}

const days = (END - START) / D;
const allResults: Result[] = [];

// Run each config with BOTH 5m and 1s-as-1m data
for (const [act, dist] of configs) {
  const label = act === 0 ? "NO TRAIL" : `${act}/${dist}`;

  for (const [resLabel, barsMap] of [["5m", raw1sAs5m], ["1s-1m", raw1sAs1m]] as [string, Map<string, C[]>][]) {
    const trades: Trade[] = [];
    for (const sig of allSignals) {
      const bars = barsMap.get(sig.pair);
      if (!bars || bars.length === 0) continue;
      trades.push(simWithTrail(sig, bars, act, dist));
    }

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const total = trades.reduce((s, t) => s + t.pnl, 0);

    let cum = 0, peak = 0, maxDD = 0;
    for (const t of [...trades].sort((a, b) => a.xt - b.xt)) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

    const trailExits = trades.filter(t => t.reason === "trail");
    const avgTrailPnl = trailExits.length > 0 ? trailExits.reduce((s, t) => s + t.pnl, 0) / trailExits.length : 0;

    allResults.push({
      label, resolution: resLabel,
      trades: trades.length, wr: trades.length > 0 ? wins.length / trades.length * 100 : 0,
      pf: gl > 0 ? gp / gl : 99, total, perDay: total / days, maxDD,
      trailExits: trailExits.length, avgTrailPnl, winnersGivenBack: 0,
    });
  }
}

// Print comparison
console.log("\n" + "=".repeat(120));
console.log("1s-PRECISION TRAILING STOP COMPARISON (Dec 2025 - Mar 2026, 4 months)");
console.log("5m = standard backtest | 1s-1m = 1-second candles aggregated to 1-minute (captures every wick)");
console.log("=".repeat(120));

console.log(`\n${"Config".padEnd(12)} ${"Res".padEnd(6)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"Total".padStart(10)} ${"$/day".padStart(9)} ${"PF".padStart(6)} ${"MaxDD".padStart(9)} ${"Trails".padStart(7)} ${"AvgTrailPnL".padStart(12)}`);
console.log("-".repeat(120));

for (const [act, dist] of configs) {
  const label = act === 0 ? "NO TRAIL" : `${act}/${dist}`;
  const r5m = allResults.find(r => r.label === label && r.resolution === "5m");
  const r1s = allResults.find(r => r.label === label && r.resolution === "1s-1m");

  if (r5m) console.log(`${label.padEnd(12)} ${"5m".padEnd(6)} ${String(r5m.trades).padStart(7)} ${r5m.wr.toFixed(1).padStart(6)}% ${("$"+r5m.total.toFixed(2)).padStart(10)} ${("$"+r5m.perDay.toFixed(2)).padStart(9)} ${r5m.pf.toFixed(2).padStart(6)} ${("$"+r5m.maxDD.toFixed(0)).padStart(9)} ${String(r5m.trailExits).padStart(7)} ${("$"+r5m.avgTrailPnl.toFixed(2)).padStart(12)}`);
  if (r1s) console.log(`${"".padEnd(12)} ${"1s-1m".padEnd(6)} ${String(r1s.trades).padStart(7)} ${r1s.wr.toFixed(1).padStart(6)}% ${("$"+r1s.total.toFixed(2)).padStart(10)} ${("$"+r1s.perDay.toFixed(2)).padStart(9)} ${r1s.pf.toFixed(2).padStart(6)} ${("$"+r1s.maxDD.toFixed(0)).padStart(9)} ${String(r1s.trailExits).padStart(7)} ${("$"+r1s.avgTrailPnl.toFixed(2)).padStart(12)}`);

  if (r5m && r1s) {
    const delta = r1s.perDay - r5m.perDay;
    const extraTrails = r1s.trailExits - r5m.trailExits;
    console.log(`${"".padEnd(12)} ${"DELTA".padEnd(6)} ${"".padStart(7)} ${"".padStart(7)} ${"".padStart(10)} ${(delta >= 0 ? "+$" : "-$") + Math.abs(delta).toFixed(2).padStart(7)} ${"".padStart(6)} ${"".padStart(9)} ${(extraTrails >= 0 ? "+" : "") + String(extraTrails).padStart(6)}`);
  }
  console.log("");
}

// Summary table
console.log("=".repeat(120));
console.log("SUMMARY: Does 1s data change the conclusion?");
console.log("=".repeat(120));

const noTrail5m = allResults.find(r => r.label === "NO TRAIL" && r.resolution === "5m");
const noTrail1s = allResults.find(r => r.label === "NO TRAIL" && r.resolution === "1s-1m");

console.log(`\nNo Trail:     5m=$${noTrail5m?.perDay.toFixed(2)}/day | 1s=$${noTrail1s?.perDay.toFixed(2)}/day`);

const best5m = allResults.filter(r => r.resolution === "5m" && r.label !== "NO TRAIL").sort((a, b) => b.perDay - a.perDay)[0];
const best1s = allResults.filter(r => r.resolution === "1s-1m" && r.label !== "NO TRAIL").sort((a, b) => b.perDay - a.perDay)[0];

console.log(`Best Trail:   5m=${best5m?.label} $${best5m?.perDay.toFixed(2)}/day | 1s=${best1s?.label} $${best1s?.perDay.toFixed(2)}/day`);

const gap5m = (noTrail5m?.perDay ?? 0) - (best5m?.perDay ?? 0);
const gap1s = (noTrail1s?.perDay ?? 0) - (best1s?.perDay ?? 0);
console.log(`Trail Cost:   5m=-$${gap5m.toFixed(2)}/day | 1s=-$${gap1s.toFixed(2)}/day`);

if (gap1s < gap5m * 0.5) {
  console.log("\n>>> 1s DATA SHOWS TRAILING IS SIGNIFICANTLY LESS DESTRUCTIVE <<<");
  console.log(">>> Wicks DO help trailing - the 5m backtest was too pessimistic <<<");
} else if (gap1s > gap5m * 1.5) {
  console.log("\n>>> 1s DATA SHOWS TRAILING IS EVEN WORSE THAN 5m SUGGESTED <<<");
  console.log(">>> Wicks cause MORE whipsaw exits, not fewer <<<");
} else {
  console.log("\n>>> CONCLUSION UNCHANGED: Both resolutions agree trailing hurts <<<");
  console.log(">>> 1s data does NOT rescue trailing stops <<<");
}

console.log("\nDone.");
