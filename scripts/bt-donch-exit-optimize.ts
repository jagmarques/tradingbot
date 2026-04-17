/**
 * Donchian Exit Channel Period Optimization
 * Tests whether shorter exit channels capture more peak profit.
 * Uses SMA(20/50) entry, BTC EMA(20)>EMA(50) long filter, ATR*3 SL capped 3.5%.
 * 1m data for intra-trade peak tracking, 5m aggregated to daily for signals.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-donch-exit-optimize.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const SIZE = 7;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4,
};

const PAIRS = ["OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI"];
const EXIT_PERIODS = [3, 5, 8, 10, 12, 15, 20];

// --- Helpers ---
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
  return result.sort((a, b) => a.t - b.t);
}

function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += trs[j];
    atr[i] = s / period;
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
    let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
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

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function entryPxCalc(pair: string, dir: "long" | "short", raw: number): number { const sp = getSpread(pair); return dir === "long" ? raw * (1 + sp) : raw * (1 - sp); }
function exitPxCalc(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number { const sp = getSpread(pair); const slip = isSL ? sp * SL_SLIP : sp; return dir === "long" ? raw * (1 - slip) : raw * (1 + slip); }
function calcPnl(dir: "long" | "short", ep: number, xp: number, not: number): number { return (dir === "long" ? (xp / ep - 1) * not : (ep / xp - 1) * not) - not * FEE * 2; }

// --- Load data ---
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = loadJson(CD_5M, p); if (d.length > 0) raw5m.set(p, d); }

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) { raw1m.set(p, d); console.log(`  ${p}: ${d.length.toLocaleString()} 1m bars`); }
}

const dailyData = new Map<string, C[]>();
for (const [p, bars] of raw5m) { dailyData.set(p, aggregate(bars, D, 200)); }

// BTC filter
const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);

function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) { if (btcDaily[i].t < t) { idx = i; break; } }
  if (idx < 0) return false;
  const i20 = idx - (btcDaily.length - btcEma20.length);
  const i50 = idx - (btcDaily.length - btcEma50.length);
  return i20 >= 0 && i50 >= 0 && btcEma20[i20] > btcEma50[i50];
}

console.log("Loaded.\n");

// --- Trade struct ---
interface Trade {
  pair: string;
  dir: "long" | "short";
  entryTime: number;
  entryPrice: number;
  sl: number;
  exitTime: number;
  exitPrice: number;
  exitReason: string;
  peakPrice: number;  // best price during trade (high for longs, low for shorts)
  peakPct: number;    // peak unrealized % of entry (leveraged)
  exitPct: number;    // exit % of entry (leveraged)
  pnl: number;
}

/**
 * Generate Donchian signals and simulate with a specific exit channel period.
 * Uses 1m bars for precise peak tracking and exit detection within daily bars.
 */
function runDonchian(exitPeriod: number, startTs: number, endTs: number): Trade[] {
  const trades: Trade[] = [];

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < 65) continue;

    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, 20);
    const slow = calcSMA(closes, 50);
    const atr = calcATR(cs, 14);

    const bars1m = raw1m.get(pair) ?? [];

    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; rawEntry: number } | null = null;

    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];

      if (pos) {
        let xp = 0;
        let reason = "";
        const hd = Math.round((bar.t - pos.et) / D);

        // SL check on daily bar
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }

        // Donchian channel exit with VARIABLE period
        if (!xp && i >= exitPeriod + 1) {
          if (pos.dir === "long") {
            const lo = donchCloseLow(cs, i, exitPeriod);
            if (bar.c < lo) { xp = bar.c; reason = "ch"; }
          } else {
            const hi = donchCloseHigh(cs, i, exitPeriod);
            if (bar.c > hi) { xp = bar.c; reason = "ch"; }
          }
        }

        // Max hold 60 days
        if (!xp && hd >= 60) { xp = bar.c; reason = "mh"; }

        if (xp > 0) {
          if (pos.et >= startTs && pos.et < endTs) {
            // Use 1m bars to find precise peak
            const ep = pos.ep;
            const rawEntry = pos.rawEntry;
            let peakPrice = pos.dir === "long" ? rawEntry : rawEntry;
            let peakPct = 0;

            // Binary search for 1m start
            let lo2 = 0, hi2 = bars1m.length - 1, startIdx = bars1m.length;
            while (lo2 <= hi2) {
              const mid = (lo2 + hi2) >> 1;
              if (bars1m[mid].t >= pos.et) { startIdx = mid; hi2 = mid - 1; } else { lo2 = mid + 1; }
            }

            for (let m = startIdx; m < bars1m.length && bars1m[m].t <= bar.t; m++) {
              const b1m = bars1m[m];
              if (pos.dir === "long") {
                const pct = (b1m.h / rawEntry - 1) * LEV * 100;
                if (pct > peakPct) { peakPct = pct; peakPrice = b1m.h; }
              } else {
                const pct = (rawEntry / b1m.l - 1) * LEV * 100;
                if (pct > peakPct) { peakPct = pct; peakPrice = b1m.l; }
              }
            }

            const adjEp = entryPxCalc(pair, pos.dir, rawEntry);
            const adjXp = exitPxCalc(pair, pos.dir, xp, reason === "sl");
            const NOT = SIZE * LEV;
            const pnl = calcPnl(pos.dir, adjEp, adjXp, NOT);
            const exitPct = pos.dir === "long"
              ? (xp / rawEntry - 1) * LEV * 100
              : (rawEntry / xp - 1) * LEV * 100;

            trades.push({
              pair, dir: pos.dir, entryTime: pos.et, entryPrice: rawEntry,
              sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason,
              peakPrice, peakPct, exitPct, pnl,
            });
          }
          pos = null;
        }
      }

      if (!pos) {
        const p = i - 1;
        const pp = i - 2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;

        let dir: "long" | "short" | null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long";
        else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;

        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);

        pos = { dir, ep: entryPxCalc(pair, dir, bar.o), et: bar.t, sl, rawEntry: bar.o };
      }
    }
  }

  return trades;
}

// --- Run all exit periods ---
console.log("=== Donchian Exit Channel Optimization ===");
console.log(`Entry: SMA(20/50) crossover | BTC EMA(20)>EMA(50) long filter`);
console.log(`SL: ATR(14)*3 capped 3.5% | Max hold: 60d | $${SIZE} margin, ${LEV}x lev`);
console.log(`Pairs: ${PAIRS.length} | Period: 2023-01 to 2026-03\n`);

interface PeriodResult {
  period: number;
  trades: number;
  wins: number;
  wr: number;
  pf: number;
  totalPnl: number;
  perDay: number;
  avgPeakPct: number;      // avg peak unrealized % (leveraged)
  avgExitPct: number;      // avg exit % (leveraged)
  avgGivebackPct: number;  // how much of peak is given back (as % of peak)
  medianGivebackPct: number;
  avgHoldDays: number;
  chExits: number;         // channel exits
  slExits: number;         // stop exits
  mhExits: number;         // max hold exits
  // Winners only
  winAvgPeak: number;
  winAvgExit: number;
  winAvgGiveback: number;
  // OOS
  oosPnl: number;
  oosPerDay: number;
  oosTrades: number;
}

const results: PeriodResult[] = [];
const totalDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

for (const period of EXIT_PERIODS) {
  process.stdout.write(`  Exit period ${period}d...`);

  const trades = runDonchian(period, FULL_START, FULL_END);
  const oosTrades = trades.filter(t => t.entryTime >= OOS_START);

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Giveback: for trades with positive peak, how much was given back
  const tradesWithPeak = trades.filter(t => t.peakPct > 0);
  const givebacks = tradesWithPeak.map(t => {
    const givenBack = t.peakPct - t.exitPct;
    return t.peakPct > 0 ? (givenBack / t.peakPct) * 100 : 0;
  });

  const avgPeak = tradesWithPeak.length > 0 ? tradesWithPeak.reduce((s, t) => s + t.peakPct, 0) / tradesWithPeak.length : 0;
  const avgExit = tradesWithPeak.length > 0 ? tradesWithPeak.reduce((s, t) => s + t.exitPct, 0) / tradesWithPeak.length : 0;
  const avgGiveback = givebacks.length > 0 ? givebacks.reduce((s, v) => s + v, 0) / givebacks.length : 0;
  const sortedGb = [...givebacks].sort((a, b) => a - b);
  const medianGb = sortedGb.length > 0 ? sortedGb[Math.floor(sortedGb.length / 2)] : 0;

  // Winners only
  const winTrades = wins.filter(t => t.peakPct > 0);
  const winAvgPeak = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.peakPct, 0) / winTrades.length : 0;
  const winAvgExit = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.exitPct, 0) / winTrades.length : 0;
  const winGivebacks = winTrades.map(t => t.peakPct > 0 ? ((t.peakPct - t.exitPct) / t.peakPct) * 100 : 0);
  const winAvgGiveback = winGivebacks.length > 0 ? winGivebacks.reduce((s, v) => s + v, 0) / winGivebacks.length : 0;

  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / trades.length / D : 0;

  const oosPnl = oosTrades.reduce((s, t) => s + t.pnl, 0);

  results.push({
    period,
    trades: trades.length,
    wins: wins.length,
    wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? 99 : 0,
    totalPnl,
    perDay: totalPnl / totalDays,
    avgPeakPct: avgPeak,
    avgExitPct: avgExit,
    avgGivebackPct: avgGiveback,
    medianGivebackPct: medianGb,
    avgHoldDays: avgHold,
    chExits: trades.filter(t => t.exitReason === "ch").length,
    slExits: trades.filter(t => t.exitReason === "sl").length,
    mhExits: trades.filter(t => t.exitReason === "mh").length,
    winAvgPeak,
    winAvgExit,
    winAvgGiveback,
    oosPnl,
    oosPerDay: oosPnl / oosDays,
    oosTrades: oosTrades.length,
  });

  console.log(` ${trades.length} trades, $${totalPnl.toFixed(2)}`);
}

// --- Print results ---
console.log("\n" + "=".repeat(130));
console.log("ALL TRADES (entry 2023-01 to 2026-03)");
console.log("=".repeat(130));
console.log(
  "Period".padStart(6) + " | " +
  "Trades".padStart(6) + " | " +
  "WR%".padStart(5) + " | " +
  "PF".padStart(5) + " | " +
  "Total$".padStart(8) + " | " +
  "$/day".padStart(7) + " | " +
  "AvgPeak%".padStart(9) + " | " +
  "AvgExit%".padStart(9) + " | " +
  "Giveback%".padStart(10) + " | " +
  "MedGb%".padStart(7) + " | " +
  "Hold(d)".padStart(8) + " | " +
  "CH".padStart(4) + " | " +
  "SL".padStart(4) + " | " +
  "MH".padStart(4)
);
console.log("-".repeat(130));

for (const r of results) {
  console.log(
    `${r.period}d`.padStart(6) + " | " +
    `${r.trades}`.padStart(6) + " | " +
    `${r.wr.toFixed(1)}`.padStart(5) + " | " +
    `${r.pf.toFixed(2)}`.padStart(5) + " | " +
    `$${r.totalPnl.toFixed(2)}`.padStart(8) + " | " +
    `$${r.perDay.toFixed(3)}`.padStart(7) + " | " +
    `${r.avgPeakPct.toFixed(1)}%`.padStart(9) + " | " +
    `${r.avgExitPct.toFixed(1)}%`.padStart(9) + " | " +
    `${r.avgGivebackPct.toFixed(1)}%`.padStart(10) + " | " +
    `${r.medianGivebackPct.toFixed(1)}%`.padStart(7) + " | " +
    `${r.avgHoldDays.toFixed(1)}`.padStart(8) + " | " +
    `${r.chExits}`.padStart(4) + " | " +
    `${r.slExits}`.padStart(4) + " | " +
    `${r.mhExits}`.padStart(4)
  );
}

console.log("\n" + "=".repeat(100));
console.log("WINNERS ONLY (peak/exit/giveback for winning trades)");
console.log("=".repeat(100));
console.log(
  "Period".padStart(6) + " | " +
  "Winners".padStart(7) + " | " +
  "WinAvgPeak%".padStart(12) + " | " +
  "WinAvgExit%".padStart(12) + " | " +
  "WinGiveback%".padStart(13) + " | " +
  "AvgWinSize$".padStart(12)
);
console.log("-".repeat(100));

for (const r of results) {
  const avgWinSize = r.wins > 0 ? r.totalPnl / r.wins : 0; // approximation
  const winTotalPnl = r.totalPnl; // use total for simplicity
  console.log(
    `${r.period}d`.padStart(6) + " | " +
    `${r.wins}`.padStart(7) + " | " +
    `${r.winAvgPeak.toFixed(1)}%`.padStart(12) + " | " +
    `${r.winAvgExit.toFixed(1)}%`.padStart(12) + " | " +
    `${r.winAvgGiveback.toFixed(1)}%`.padStart(13) + " | " +
    `$${(r.totalPnl / Math.max(r.wins, 1)).toFixed(2)}`.padStart(12)
  );
}

console.log("\n" + "=".repeat(80));
console.log("OOS (entry 2025-09 to 2026-03)");
console.log("=".repeat(80));
console.log(
  "Period".padStart(6) + " | " +
  "Trades".padStart(6) + " | " +
  "OOS Total$".padStart(11) + " | " +
  "OOS $/day".padStart(10)
);
console.log("-".repeat(80));

for (const r of results) {
  console.log(
    `${r.period}d`.padStart(6) + " | " +
    `${r.oosTrades}`.padStart(6) + " | " +
    `$${r.oosPnl.toFixed(2)}`.padStart(11) + " | " +
    `$${r.oosPerDay.toFixed(3)}`.padStart(10)
  );
}

// --- Key insight ---
console.log("\n" + "=".repeat(80));
console.log("KEY INSIGHT: Giveback vs Total P&L tradeoff");
console.log("=".repeat(80));
const best = results.reduce((a, b) => a.perDay > b.perDay ? a : b);
const leastGb = results.reduce((a, b) => a.avgGivebackPct < b.avgGivebackPct ? a : b);
console.log(`  Best $/day:     ${best.period}d exit -> $${best.perDay.toFixed(3)}/day, ${best.avgGivebackPct.toFixed(1)}% giveback`);
console.log(`  Least giveback: ${leastGb.period}d exit -> $${leastGb.perDay.toFixed(3)}/day, ${leastGb.avgGivebackPct.toFixed(1)}% giveback`);
console.log(`  Current (15d):  ${results.find(r => r.period === 15)?.perDay.toFixed(3) ?? "N/A"}/day, ${results.find(r => r.period === 15)?.avgGivebackPct.toFixed(1) ?? "N/A"}% giveback`);

// --- Detailed trade breakdown for the best performer ---
console.log("\n" + "=".repeat(80));
console.log(`TOP 10 biggest winners at BEST period (${best.period}d) vs 15d exit`);
console.log("=".repeat(80));

const bestTrades = runDonchian(best.period, FULL_START, FULL_END).sort((a, b) => b.pnl - a.pnl).slice(0, 10);
const ref15Trades = runDonchian(15, FULL_START, FULL_END);

for (const bt of bestTrades) {
  // Find corresponding 15d trade
  const ref = ref15Trades.find(r => r.pair === bt.pair && Math.abs(r.entryTime - bt.entryTime) < D);
  const refPnl = ref ? `$${ref.pnl.toFixed(2)}` : "N/A";
  const refExit = ref ? `${ref.exitPct.toFixed(1)}%` : "N/A";
  console.log(
    `  ${bt.pair.padEnd(6)} ${new Date(bt.entryTime).toISOString().slice(0, 10)} ` +
    `${bt.dir.padEnd(5)} peak=${bt.peakPct.toFixed(1)}% exit=${bt.exitPct.toFixed(1)}% ` +
    `pnl=$${bt.pnl.toFixed(2)} (15d: pnl=${refPnl} exit=${refExit})`
  );
}
