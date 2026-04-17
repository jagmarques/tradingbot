/**
 * Profit Giveback Analysis
 * How much unrealized profit do we give back before exit signals fire?
 *
 * Run: npx tsx scripts/bt-giveback-analysis.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SIZE = 7;
const LEV = 10;
const NOT = SIZE * LEV;
const SL_SLIP = 1.5;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

const SP: Record<string, number> = {
  XRP: 2.1e-4, DOGE: 2.7e-4, ARB: 5.2e-4, ENA: 5.1e-4,
  UNI: 5.5e-4, APT: 6.4e-4, LINK: 6.9e-4, TRUMP: 7.3e-4,
  WLD: 8e-4, DOT: 9.9e-4, ADA: 11.1e-4, LDO: 11.6e-4, OP: 12.4e-4,
  BTC: 1.0e-4, SOL: 4.0e-4,
};

const PAIRS = ["OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "SOL"];

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
    result.push({
      t: ts, o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
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
      for (let j = 1; j <= period; j++)
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
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

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];
    if (i > atrPeriod) {
      if (lowerBand > lb[i - 1] || cs[i - 1].c < lb[i - 1]) {} else lowerBand = lb[i - 1];
      if (upperBand < ub[i - 1] || cs[i - 1].c > ub[i - 1]) {} else upperBand = ub[i - 1];
    }
    ub[i] = upperBand; lb[i] = lowerBand;
    if (i === atrPeriod) { dirs[i] = cs[i].c > upperBand ? 1 : -1; }
    else { dirs[i] = dirs[i-1] === 1 ? (cs[i].c < lowerBand ? -1 : 1) : (cs[i].c > upperBand ? 1 : -1); }
    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }
  return { st, dir: dirs };
}

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }

// Load data
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = load5m(p);
  if (d.length > 0) raw5m.set(p, d);
}
const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
}

const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);

function btcBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) { if (btcDaily[i].t <= t) { idx = i; break; } }
  if (idx < 0) return false;
  const i20 = idx - (btcDaily.length - btcEma20.length);
  const i50 = idx - (btcDaily.length - btcEma50.length);
  if (i20 < 0 || i50 < 0) return false;
  return btcEma20[i20] > btcEma50[i50];
}

// Track trades with peak unrealized profit using 5m bars for precision
interface DetailedTrade {
  pair: string; dir: "long" | "short"; engine: string;
  entryPrice: number; exitPrice: number; entryTime: number; exitTime: number;
  peakPriceFavorable: number; // best price during hold
  peakPct: number; // peak unrealized % move (before fees)
  exitPct: number; // actual exit % move (before fees)
  givebackPct: number; // peak - exit
  pnlDollar: number;
  exitReason: string;
  holdDays: number;
}

const trades: DetailedTrade[] = [];

// Engine A: Donchian Trend (daily) - track with 5m bars for peak
console.log("Running Engine A (Donchian)...");
for (const pair of PAIRS) {
  const cs = dailyData.get(pair);
  const bars5m = raw5m.get(pair);
  if (!cs || !bars5m || cs.length < 65) continue;

  const closes = cs.map(c => c.c);
  const fast = calcSMA(closes, 20);
  const slow = calcSMA(closes, 50);
  const atr = calcATR(cs, 14);

  let posEntry = 0, posDir: "long"|"short" = "long", posSl = 0, posTime = 0;
  let inPos = false;

  for (let i = 51; i < cs.length; i++) {
    const bar = cs[i];
    if (bar.t < FULL_START || bar.t > FULL_END) continue;

    if (inPos) {
      let xp = 0, reason = "", isSL = false;
      const holdDays = Math.round((bar.t - posTime) / D);

      if (posDir === "long" && bar.l <= posSl) { xp = posSl; reason = "sl"; isSL = true; }
      else if (posDir === "short" && bar.h >= posSl) { xp = posSl; reason = "sl"; isSL = true; }

      if (!xp && i >= 16) {
        if (posDir === "long") {
          const lo = donchCloseLow(cs, i, 15);
          if (bar.c < lo) { xp = bar.c; reason = "channel"; }
        } else {
          const hi = donchCloseHigh(cs, i, 15);
          if (bar.c > hi) { xp = bar.c; reason = "channel"; }
        }
      }

      if (!xp && holdDays >= 60) { xp = bar.c; reason = "max-hold"; }

      if (xp > 0) {
        // Find peak using 5m bars between entry and exit
        let peakFav = posEntry;
        const entry5mIdx = bars5m.findIndex(b => b.t >= posTime);
        const exit5mIdx = bars5m.findIndex(b => b.t >= bar.t);
        if (entry5mIdx >= 0 && exit5mIdx >= 0) {
          for (let j = entry5mIdx; j <= Math.min(exit5mIdx, bars5m.length - 1); j++) {
            if (posDir === "long") peakFav = Math.max(peakFav, bars5m[j].h);
            else peakFav = Math.min(peakFav, bars5m[j].l);
          }
        }

        const sp = getSpread(pair);
        const adjEntry = posDir === "long" ? posEntry * (1 + sp) : posEntry * (1 - sp);
        const adjExit = posDir === "long" ? xp * (1 - (isSL ? sp * SL_SLIP : sp)) : xp * (1 + (isSL ? sp * SL_SLIP : sp));
        const pnlRaw = posDir === "long" ? (adjExit / adjEntry - 1) * NOT : (adjEntry / adjExit - 1) * NOT;
        const pnl = pnlRaw - NOT * FEE * 2;

        const peakPct = posDir === "long" ? (peakFav / posEntry - 1) * 100 : (posEntry / peakFav - 1) * 100;
        const exitPct = posDir === "long" ? (xp / posEntry - 1) * 100 : (posEntry / xp - 1) * 100;
        const givebackPct = peakPct - exitPct;

        trades.push({
          pair, dir: posDir, engine: "Donchian",
          entryPrice: posEntry, exitPrice: xp, entryTime: posTime, exitTime: bar.t,
          peakPriceFavorable: peakFav, peakPct, exitPct, givebackPct,
          pnlDollar: pnl, exitReason: reason,
          holdDays: Math.round((bar.t - posTime) / D),
        });
        inPos = false;
      }
    }

    if (!inPos) {
      const prev = i - 1;
      if (fast[prev] === 0 || slow[prev] === 0) continue;
      let dir: "long"|"short"|null = null;
      if (fast[prev] <= slow[prev] && fast[i] > slow[i]) dir = "long";
      else if (fast[prev] >= slow[prev] && fast[i] < slow[i]) dir = "short";
      if (!dir) continue;
      if (dir === "long" && !btcBullish(bar.t)) continue;

      const prevATR = atr[i-1];
      if (prevATR <= 0) continue;

      posEntry = bar.o;
      posDir = dir;
      posSl = dir === "long" ? posEntry - 3 * prevATR : posEntry + 3 * prevATR;
      if (dir === "long") posSl = Math.max(posSl, posEntry * 0.965);
      else posSl = Math.min(posSl, posEntry * 1.035);
      posTime = bar.t;
      inPos = true;
    }
  }
}

// Engine B: Supertrend 4h
console.log("Running Engine B (Supertrend)...");
for (const pair of PAIRS) {
  const cs = h4Data.get(pair);
  const bars5m = raw5m.get(pair);
  if (!cs || !bars5m || cs.length < 50) continue;

  const { dir: stDir } = calcSupertrend(cs, 14, 1.75);
  const atr = calcATR(cs, 14);

  let posEntry = 0, posDir: "long"|"short" = "long", posSl = 0, posTime = 0;
  let inPos = false;

  for (let i = 17; i < cs.length; i++) {
    const bar = cs[i];
    if (bar.t < FULL_START || bar.t > FULL_END) continue;

    const flip = stDir[i-1] !== stDir[i-2];

    if (inPos) {
      let xp = 0, reason = "", isSL = false;

      if (posDir === "long" && bar.l <= posSl) { xp = posSl; reason = "sl"; isSL = true; }
      else if (posDir === "short" && bar.h >= posSl) { xp = posSl; reason = "sl"; isSL = true; }

      if (!xp && flip) { xp = bar.o; reason = "flip"; }

      if (!xp) {
        const hours = (bar.t - posTime) / H;
        if (hours >= 60 * 24) { xp = bar.c; reason = "max-hold"; }
      }

      if (xp > 0) {
        let peakFav = posEntry;
        const entry5mIdx = bars5m.findIndex(b => b.t >= posTime);
        const exit5mIdx = bars5m.findIndex(b => b.t >= bar.t);
        if (entry5mIdx >= 0 && exit5mIdx >= 0) {
          for (let j = entry5mIdx; j <= Math.min(exit5mIdx, bars5m.length - 1); j++) {
            if (posDir === "long") peakFav = Math.max(peakFav, bars5m[j].h);
            else peakFav = Math.min(peakFav, bars5m[j].l);
          }
        }

        const sp = getSpread(pair);
        const adjEntry = posDir === "long" ? posEntry * (1 + sp) : posEntry * (1 - sp);
        const adjExit = posDir === "long" ? xp * (1 - (isSL ? sp * SL_SLIP : sp)) : xp * (1 + (isSL ? sp * SL_SLIP : sp));
        const pnlRaw = posDir === "long" ? (adjExit / adjEntry - 1) * NOT : (adjEntry / adjExit - 1) * NOT;
        const pnl = pnlRaw - NOT * FEE * 2;

        const peakPct = posDir === "long" ? (peakFav / posEntry - 1) * 100 : (posEntry / peakFav - 1) * 100;
        const exitPct = posDir === "long" ? (xp / posEntry - 1) * 100 : (posEntry / xp - 1) * 100;

        trades.push({
          pair, dir: posDir, engine: "Supertrend",
          entryPrice: posEntry, exitPrice: xp, entryTime: posTime, exitTime: bar.t,
          peakPriceFavorable: peakFav, peakPct, exitPct, givebackPct: peakPct - exitPct,
          pnlDollar: pnl, exitReason: reason,
          holdDays: Math.round((bar.t - posTime) / D),
        });
        inPos = false;
      }
    }

    if (!inPos && flip && bar.t >= FULL_START) {
      const dir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
      if (dir === "long" && !btcBullish(bar.t)) continue;
      const prevATR = atr[i-1];
      if (prevATR <= 0) continue;

      posEntry = bar.o;
      posDir = dir;
      posSl = dir === "long" ? posEntry - 3 * prevATR : posEntry + 3 * prevATR;
      if (dir === "long") posSl = Math.max(posSl, posEntry * 0.965);
      else posSl = Math.min(posSl, posEntry * 1.035);
      posTime = bar.t;
      inPos = true;
    }
  }
}

// ─── ANALYSIS ───────────────────────────────────────────────────────
console.log(`\nTotal trades analyzed: ${trades.length}`);

const winners = trades.filter(t => t.pnlDollar > 0);
const losers = trades.filter(t => t.pnlDollar <= 0);

console.log("\n" + "=".repeat(80));
console.log("PROFIT GIVEBACK ANALYSIS");
console.log("How much unrealized profit do we give back before exit signals fire?");
console.log("=".repeat(80));

// Overall stats
const avgPeak = trades.reduce((s, t) => s + t.peakPct, 0) / trades.length;
const avgExit = trades.reduce((s, t) => s + t.exitPct, 0) / trades.length;
const avgGiveback = trades.reduce((s, t) => s + t.givebackPct, 0) / trades.length;

console.log(`\n--- ALL TRADES ---`);
console.log(`Avg peak unrealized move:  ${avgPeak.toFixed(2)}%`);
console.log(`Avg actual exit move:      ${avgExit.toFixed(2)}%`);
console.log(`Avg giveback:              ${avgGiveback.toFixed(2)}%`);
console.log(`Giveback ratio:            ${(avgGiveback / avgPeak * 100).toFixed(0)}% of peak given back`);

// Winners only
const wAvgPeak = winners.reduce((s, t) => s + t.peakPct, 0) / winners.length;
const wAvgExit = winners.reduce((s, t) => s + t.exitPct, 0) / winners.length;
const wAvgGiveback = winners.reduce((s, t) => s + t.givebackPct, 0) / winners.length;

console.log(`\n--- WINNING TRADES (${winners.length}) ---`);
console.log(`Avg peak unrealized move:  ${wAvgPeak.toFixed(2)}%`);
console.log(`Avg actual exit move:      ${wAvgExit.toFixed(2)}%`);
console.log(`Avg giveback:              ${wAvgGiveback.toFixed(2)}%`);
console.log(`Giveback ratio:            ${(wAvgGiveback / wAvgPeak * 100).toFixed(0)}% of peak given back`);
console.log(`Avg profit kept:           $${(winners.reduce((s,t) => s + t.pnlDollar, 0) / winners.length).toFixed(2)}`);

// Losers only
const lAvgPeak = losers.reduce((s, t) => s + t.peakPct, 0) / losers.length;
const lAvgGiveback = losers.reduce((s, t) => s + t.givebackPct, 0) / losers.length;

console.log(`\n--- LOSING TRADES (${losers.length}) ---`);
console.log(`Avg peak unrealized move:  ${lAvgPeak.toFixed(2)}%`);
console.log(`Avg giveback:              ${lAvgGiveback.toFixed(2)}%`);
console.log(`Even losers had avg peak:  ${lAvgPeak.toFixed(2)}% before reversing`);

// By engine
for (const eng of ["Donchian", "Supertrend"]) {
  const et = trades.filter(t => t.engine === eng);
  const ew = et.filter(t => t.pnlDollar > 0);
  if (et.length === 0) continue;
  const ePeak = et.reduce((s, t) => s + t.peakPct, 0) / et.length;
  const eExit = et.reduce((s, t) => s + t.exitPct, 0) / et.length;
  const eGb = et.reduce((s, t) => s + t.givebackPct, 0) / et.length;
  console.log(`\n--- ${eng} (${et.length} trades, ${ew.length} winners) ---`);
  console.log(`Avg peak: ${ePeak.toFixed(2)}%, Avg exit: ${eExit.toFixed(2)}%, Giveback: ${eGb.toFixed(2)}%`);
}

// By exit reason
console.log("\n--- BY EXIT REASON ---");
const reasons = new Map<string, DetailedTrade[]>();
for (const t of trades) {
  const arr = reasons.get(t.exitReason) ?? [];
  arr.push(t);
  reasons.set(t.exitReason, arr);
}
for (const [reason, rTrades] of reasons) {
  const rPeak = rTrades.reduce((s, t) => s + t.peakPct, 0) / rTrades.length;
  const rExit = rTrades.reduce((s, t) => s + t.exitPct, 0) / rTrades.length;
  const rGb = rTrades.reduce((s, t) => s + t.givebackPct, 0) / rTrades.length;
  const rPnl = rTrades.reduce((s, t) => s + t.pnlDollar, 0) / rTrades.length;
  const rWr = rTrades.filter(t => t.pnlDollar > 0).length / rTrades.length * 100;
  console.log(`  ${reason.padEnd(12)} ${String(rTrades.length).padStart(5)} trades | peak ${rPeak.toFixed(1)}% | exit ${rExit.toFixed(1)}% | giveback ${rGb.toFixed(1)}% | avg P&L $${rPnl.toFixed(2)} | WR ${rWr.toFixed(0)}%`);
}

// Top 10 biggest givebacks
console.log("\n--- TOP 10 BIGGEST GIVEBACKS (winners that gave back the most) ---");
const bigGivebacks = winners.sort((a, b) => b.givebackPct - a.givebackPct).slice(0, 10);
console.log(`${"Pair".padEnd(8)} ${"Engine".padEnd(12)} ${"Dir".padEnd(6)} ${"Peak%".padStart(8)} ${"Exit%".padStart(8)} ${"Gave back".padStart(10)} ${"P&L".padStart(8)} ${"Hold".padStart(6)} ${"Exit".padEnd(10)}`);
for (const t of bigGivebacks) {
  console.log(`${t.pair.padEnd(8)} ${t.engine.padEnd(12)} ${t.dir.padEnd(6)} ${t.peakPct.toFixed(1).padStart(7)}% ${t.exitPct.toFixed(1).padStart(7)}% ${t.givebackPct.toFixed(1).padStart(9)}% $${t.pnlDollar.toFixed(2).padStart(7)} ${(t.holdDays + "d").padStart(6)} ${t.exitReason.padEnd(10)}`);
}

// Top 10 biggest winners (to show why we let them run)
console.log("\n--- TOP 10 BIGGEST WINNERS (why we let them run) ---");
const bigWinners = winners.sort((a, b) => b.pnlDollar - a.pnlDollar).slice(0, 10);
console.log(`${"Pair".padEnd(8)} ${"Engine".padEnd(12)} ${"Dir".padEnd(6)} ${"Peak%".padStart(8)} ${"Exit%".padStart(8)} ${"Gave back".padStart(10)} ${"P&L".padStart(8)} ${"Hold".padStart(6)} ${"Exit".padEnd(10)}`);
for (const t of bigWinners) {
  console.log(`${t.pair.padEnd(8)} ${t.engine.padEnd(12)} ${t.dir.padEnd(6)} ${t.peakPct.toFixed(1).padStart(7)}% ${t.exitPct.toFixed(1).padStart(7)}% ${t.givebackPct.toFixed(1).padStart(9)}% $${t.pnlDollar.toFixed(2).padStart(7)} ${(t.holdDays + "d").padStart(6)} ${t.exitReason.padEnd(10)}`);
}

// Distribution of giveback
console.log("\n--- GIVEBACK DISTRIBUTION (all trades) ---");
const buckets = [0, 1, 2, 3, 5, 7, 10, 15, 20, 50];
for (let b = 0; b < buckets.length - 1; b++) {
  const lo = buckets[b], hi = buckets[b + 1];
  const count = trades.filter(t => t.givebackPct >= lo && t.givebackPct < hi).length;
  const pct = (count / trades.length * 100).toFixed(0);
  const bar = "#".repeat(Math.round(count / trades.length * 100));
  console.log(`  ${lo.toString().padStart(3)}-${hi.toString().padStart(2)}%: ${String(count).padStart(5)} (${pct.padStart(3)}%) ${bar}`);
}
const over50 = trades.filter(t => t.givebackPct >= 50).length;
console.log(`   50%+: ${String(over50).padStart(5)} (${(over50/trades.length*100).toFixed(0).padStart(3)}%)`);

// The key question: what if we added a 10% TP?
console.log("\n" + "=".repeat(80));
console.log("WHAT IF: Fixed take-profit at various levels?");
console.log("=".repeat(80));

for (const tpPct of [5, 7, 10, 15, 20]) {
  let tpPnl = 0;
  let tpCount = 0;
  for (const t of trades) {
    if (t.peakPct >= tpPct) {
      // Would have hit TP
      const exitPct = tpPct / 100;
      const pnl = exitPct * NOT - NOT * FEE * 2;
      tpPnl += pnl;
    } else {
      // Wouldn't have hit TP, use actual exit
      tpPnl += t.pnlDollar;
    }
    tpCount++;
  }
  const actualTotal = trades.reduce((s, t) => s + t.pnlDollar, 0);
  const days = (FULL_END - FULL_START) / D;
  console.log(`  TP=${tpPct}%: total $${tpPnl.toFixed(2)} ($${(tpPnl/days).toFixed(2)}/day) vs actual $${actualTotal.toFixed(2)} ($${(actualTotal/days).toFixed(2)}/day) | delta: $${((tpPnl - actualTotal)/days).toFixed(2)}/day`);
}

console.log("\nDone.");
