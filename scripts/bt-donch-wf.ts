import * as fs from "fs";
import * as path from "path";

// ── Types ──────────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number }
interface Trade { pair: string; dir: "long" | "short"; pnl: number; et: number; xt: number }

// ── Constants ──────────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const DAY = 86400000;
const FEE = 0.00035;
const SZ = 10;
const LEV = 10;
const MAX_HOLD_DAYS = 60;

const PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, SOLUSDT: 2.0e-4, ETHUSDT: 1.5e-4,
  ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4, UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4,
  LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4, WLDUSDT: 4e-4, TIAUSDT: 2.5e-4,
  DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4, LDOUSDT: 5.8e-4,
  OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
};

const SL_SLIP = 1.5; // slippage multiplier on SL

// ── Load & aggregate 5m -> daily ───────────────────────────────────────
function load5m(pair: string): C[] {
  const f = path.join(CD, pair + "USDT.json");
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
  );
}

function aggDaily(bars5m: C[]): C[] {
  const byDay = new Map<number, C[]>();
  for (const b of bars5m) {
    const dayKey = Math.floor(b.t / DAY) * DAY;
    let arr = byDay.get(dayKey);
    if (!arr) { arr = []; byDay.set(dayKey, arr); }
    arr.push(b);
  }
  const daily: C[] = [];
  for (const [dayKey, bars] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 200) continue; // need ~full day of 5m bars (288 expected, allow some gaps)
    const o = bars[0].o;
    const c = bars[bars.length - 1].c;
    let h = -Infinity, l = Infinity;
    for (const b of bars) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; }
    daily.push({ t: dayKey, o, h, l, c });
  }
  return daily;
}

// ── ATR calculation ────────────────────────────────────────────────────
function calcATR(daily: C[], period: number): number[] {
  const atr = new Array(daily.length).fill(0);
  for (let i = 1; i < daily.length; i++) {
    const tr = Math.max(
      daily[i].h - daily[i].l,
      Math.abs(daily[i].h - daily[i - 1].c),
      Math.abs(daily[i].l - daily[i - 1].c)
    );
    if (i < period) {
      // simple average for initial period
      let sum = 0;
      for (let j = 1; j <= i; j++) {
        sum += Math.max(
          daily[j].h - daily[j].l,
          Math.abs(daily[j].h - daily[j - 1].c),
          Math.abs(daily[j].l - daily[j - 1].c)
        );
      }
      atr[i] = sum / i;
    } else if (i === period) {
      let sum = 0;
      for (let j = 1; j <= period; j++) {
        sum += Math.max(
          daily[j].h - daily[j].l,
          Math.abs(daily[j].h - daily[j - 1].c),
          Math.abs(daily[j].l - daily[j - 1].c)
        );
      }
      atr[i] = sum / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

// ── Donchian channels ──────────────────────────────────────────────────
function donchianHigh(daily: C[], i: number, lb: number): number {
  let mx = -Infinity;
  for (let j = Math.max(0, i - lb); j < i; j++) if (daily[j].h > mx) mx = daily[j].h;
  return mx;
}

function donchianLow(daily: C[], i: number, lb: number): number {
  let mn = Infinity;
  for (let j = Math.max(0, i - lb); j < i; j++) if (daily[j].l < mn) mn = daily[j].l;
  return mn;
}

// ── Simulate one parameter set over a date range ──────────────────────
interface Params { entryLB: number; exitLB: number; atrMult: number }
interface SimResult { trades: Trade[]; pf: number; sharpe: number; wr: number; totalPnl: number }

function simulate(
  pairData: Map<string, { daily: C[]; atr: number[] }>,
  params: Params,
  startMs: number,
  endMs: number
): SimResult {
  const trades: Trade[] = [];

  for (const [pairKey, { daily, atr }] of pairData) {
    const pos: {
      dir: "long" | "short"; ep: number; et: number; sl: number;
    } | null = null as any;
    let curPos: typeof pos = null;

    for (let i = params.entryLB + 1; i < daily.length; i++) {
      const bar = daily[i];
      if (bar.t < startMs || bar.t >= endMs) {
        // If we have a position and we exit the window, close at last bar
        if (curPos && bar.t >= endMs && i > 0) {
          const prevBar = daily[i - 1];
          if (prevBar.t >= startMs && prevBar.t < endMs) {
            const sp = SP[pairKey] ?? 4e-4;
            const xp = curPos.dir === "long"
              ? prevBar.c * (1 - sp)
              : prevBar.c * (1 + sp);
            const raw = curPos.dir === "long"
              ? (xp / curPos.ep - 1) * SZ * LEV
              : (curPos.ep / xp - 1) * SZ * LEV;
            const pnl = raw - SZ * LEV * FEE * 2;
            trades.push({ pair: pairKey, dir: curPos.dir, pnl, et: curPos.et, xt: prevBar.t });
            curPos = null;
          }
        }
        continue;
      }

      const sp = SP[pairKey] ?? 4e-4;

      // Check exits first
      if (curPos) {
        const slSpread = sp * SL_SLIP;
        let xp = 0;
        let exitReason = "";

        // Stop-loss
        if (curPos.dir === "long" && bar.l <= curPos.sl) {
          xp = curPos.sl * (1 - slSpread);
          exitReason = "sl";
        } else if (curPos.dir === "short" && bar.h >= curPos.sl) {
          xp = curPos.sl * (1 + slSpread);
          exitReason = "sl";
        }

        // Exit channel (using previous day's channel - anti-look-ahead)
        if (!xp) {
          const exitHigh = donchianHigh(daily, i - 1, params.exitLB);
          const exitLow = donchianLow(daily, i - 1, params.exitLB);
          if (curPos.dir === "long" && daily[i - 1].c < exitLow) {
            xp = bar.o * (1 - sp); // exit at today's open
            exitReason = "exit_ch";
          } else if (curPos.dir === "short" && daily[i - 1].c > exitHigh) {
            xp = bar.o * (1 + sp);
            exitReason = "exit_ch";
          }
        }

        // Max hold
        if (!xp && (bar.t - curPos.et) >= MAX_HOLD_DAYS * DAY) {
          xp = curPos.dir === "long" ? bar.o * (1 - sp) : bar.o * (1 + sp);
          exitReason = "max_hold";
        }

        if (xp) {
          const raw = curPos.dir === "long"
            ? (xp / curPos.ep - 1) * SZ * LEV
            : (curPos.ep / xp - 1) * SZ * LEV;
          const pnl = raw - SZ * LEV * FEE * 2;
          trades.push({ pair: pairKey, dir: curPos.dir, pnl, et: curPos.et, xt: bar.t });
          curPos = null;
        }
      }

      // Check entries (signal on day i-1, entry at day i open)
      if (!curPos && i >= params.entryLB + 1) {
        const prevClose = daily[i - 1].c;
        const entryHigh = donchianHigh(daily, i - 1, params.entryLB); // channel up to i-2
        const entryLow = donchianLow(daily, i - 1, params.entryLB);

        // Use i-2 for signal check to avoid look-ahead:
        // Signal: day i-1 close breaks channel computed from bars before i-1
        let dir: "long" | "short" | null = null;
        if (prevClose > entryHigh) dir = "long";
        else if (prevClose < entryLow) dir = "short";

        if (dir) {
          const atrVal = atr[i - 1];
          if (atrVal <= 0) continue;
          const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
          const slDist = atrVal * params.atrMult;
          const sl = dir === "long" ? ep - slDist : ep + slDist;
          curPos = { dir, ep, et: bar.t, sl };
        }
      }
    }

    // Close any remaining position at end of window
    if (curPos) {
      // Find last bar in range
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i].t >= startMs && daily[i].t < endMs) {
          const sp = SP[pairKey] ?? 4e-4;
          const xp = curPos.dir === "long"
            ? daily[i].c * (1 - sp)
            : daily[i].c * (1 + sp);
          const raw = curPos.dir === "long"
            ? (xp / curPos.ep - 1) * SZ * LEV
            : (curPos.ep / xp - 1) * SZ * LEV;
          const pnl = raw - SZ * LEV * FEE * 2;
          trades.push({ pair: pairKey, dir: curPos.dir, pnl, et: curPos.et, xt: daily[i].t });
          break;
        }
      }
    }
  }

  return computeMetrics(trades);
}

function computeMetrics(trades: Trade[]): SimResult {
  if (trades.length === 0) return { trades, pf: 0, sharpe: 0, wr: 0, totalPnl: 0 };

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const wr = trades.length > 0 ? wins.length / trades.length : 0;

  // Daily PnL for Sharpe
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / DAY) * DAY;
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
  }
  const pnls = [...dailyPnl.values()];
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return { trades, pf, sharpe, wr, totalPnl };
}

// ── Main ───────────────────────────────────────────────────────────────
console.log("Loading and aggregating 5m -> daily candles...\n");

const pairData = new Map<string, { daily: C[]; atr: number[] }>();
for (const p of PAIRS) {
  const bars5m = load5m(p);
  if (bars5m.length === 0) { console.log(`  SKIP ${p} - no data`); continue; }
  const daily = aggDaily(bars5m);
  const atr = calcATR(daily, 14);
  pairData.set(p + "USDT", { daily, atr });
  console.log(`  ${p}: ${daily.length} daily bars (${new Date(daily[0].t).toISOString().slice(0, 10)} to ${new Date(daily[daily.length - 1].t).toISOString().slice(0, 10)})`);
}

// ── Walk-forward windows ───────────────────────────────────────────────
const TRAIN_MONTHS = 6;
const TEST_MONTHS = 2;
const STEP_MONTHS = 2;
const MIN_TRADES = 30;

function addMonths(d: Date, m: number): Date {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + m);
  return r;
}

interface WindowResult {
  windowIdx: number;
  trainStart: string; trainEnd: string;
  testStart: string; testEnd: string;
  bestParams: Params;
  trainPF: number; trainSharpe: number;
  oosPF: number; oosSharpe: number; oosTrades: number; oosPnl: number; oosWR: number;
}

const ENTRY_LBS = [15, 20, 25, 30, 35, 40, 50];
const ATR_MULTS = [2, 2.5, 3, 3.5];
const results: WindowResult[] = [];
const allOOSTrades: Trade[] = [];

let windowStart = new Date("2023-01-01");
const dataEnd = new Date("2026-03-26");
let windowIdx = 0;

console.log("\n=== WALK-FORWARD OPTIMIZATION ===\n");
console.log(`Train: ${TRAIN_MONTHS}mo, Test: ${TEST_MONTHS}mo, Step: ${STEP_MONTHS}mo`);
console.log(`Entry LBs: [${ENTRY_LBS}], ATR mults: [${ATR_MULTS}]`);
console.log(`Min trades in training: ${MIN_TRADES}\n`);

while (true) {
  const trainStart = windowStart;
  const trainEnd = addMonths(trainStart, TRAIN_MONTHS);
  const testStart = trainEnd;
  const testEnd = addMonths(testStart, TEST_MONTHS);

  if (testEnd.getTime() > dataEnd.getTime()) break;

  windowIdx++;
  const trainStartMs = trainStart.getTime();
  const trainEndMs = trainEnd.getTime();
  const testStartMs = testStart.getTime();
  const testEndMs = testEnd.getTime();

  const tsStr = trainStart.toISOString().slice(0, 10);
  const teStr = trainEnd.toISOString().slice(0, 10);
  const osStr = testStart.toISOString().slice(0, 10);
  const oeStr = testEnd.toISOString().slice(0, 10);

  process.stdout.write(`Window ${windowIdx}: train ${tsStr}->${teStr}, test ${osStr}->${oeStr} ... `);

  // Sweep parameters on training set
  let bestSharpe = -Infinity;
  let bestParams: Params = { entryLB: 20, exitLB: 10, atrMult: 3 };
  let bestTrainResult: SimResult | null = null;
  let combosEvaluated = 0;

  for (const entryLB of ENTRY_LBS) {
    const exitLBs = [Math.round(entryLB / 3), Math.round(entryLB / 2)];
    for (const exitLB of exitLBs) {
      for (const atrMult of ATR_MULTS) {
        const params: Params = { entryLB, exitLB, atrMult };
        const result = simulate(pairData, params, trainStartMs, trainEndMs);
        combosEvaluated++;
        if (result.trades.length >= MIN_TRADES && result.sharpe > bestSharpe) {
          bestSharpe = result.sharpe;
          bestParams = params;
          bestTrainResult = result;
        }
      }
    }
  }

  // Run best params on OOS test window
  const oosResult = simulate(pairData, bestParams, testStartMs, testEndMs);
  allOOSTrades.push(...oosResult.trades);

  const wResult: WindowResult = {
    windowIdx,
    trainStart: tsStr, trainEnd: teStr,
    testStart: osStr, testEnd: oeStr,
    bestParams,
    trainPF: bestTrainResult?.pf ?? 0,
    trainSharpe: bestTrainResult?.sharpe ?? 0,
    oosPF: oosResult.pf,
    oosSharpe: oosResult.sharpe,
    oosTrades: oosResult.trades.length,
    oosPnl: oosResult.totalPnl,
    oosWR: oosResult.wr,
  };
  results.push(wResult);

  console.log(
    `best=[${bestParams.entryLB}/${bestParams.exitLB}/${bestParams.atrMult}] ` +
    `trainPF=${(bestTrainResult?.pf ?? 0).toFixed(2)} trainSh=${bestSharpe.toFixed(2)} | ` +
    `OOS: ${oosResult.trades.length} trades, PF=${oosResult.pf.toFixed(2)}, Sh=${oosResult.sharpe.toFixed(2)}, PnL=$${oosResult.totalPnl.toFixed(1)}`
  );

  windowStart = addMonths(windowStart, STEP_MONTHS);
}

// ── Results table ──────────────────────────────────────────────────────
console.log("\n" + "=".repeat(140));
console.log("PER-WINDOW RESULTS");
console.log("=".repeat(140));
console.log(
  "Win  Train dates           Test dates            Best params      Train PF  OOS PF  OOS trades  OOS PnL    OOS Sharpe  OOS WR%"
);
console.log("-".repeat(140));

for (const r of results) {
  const paramStr = `${r.bestParams.entryLB}/${r.bestParams.exitLB}/${r.bestParams.atrMult}`;
  console.log(
    `${String(r.windowIdx).padStart(3)}  ` +
    `${r.trainStart}->${r.trainEnd}  ` +
    `${r.testStart}->${r.testEnd}  ` +
    `${paramStr.padEnd(15)}  ` +
    `${r.trainPF.toFixed(2).padStart(8)}  ` +
    `${r.oosPF.toFixed(2).padStart(6)}  ` +
    `${String(r.oosTrades).padStart(10)}  ` +
    `$${r.oosPnl.toFixed(1).padStart(8)}  ` +
    `${r.oosSharpe.toFixed(2).padStart(10)}  ` +
    `${(r.oosWR * 100).toFixed(1).padStart(6)}%`
  );
}

// ── Aggregate OOS metrics ──────────────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("AGGREGATE OOS METRICS (all OOS trades combined)");
console.log("=".repeat(80));

const aggResult = computeMetrics(allOOSTrades);
console.log(`Total OOS trades:  ${allOOSTrades.length}`);
console.log(`Total OOS PnL:     $${aggResult.totalPnl.toFixed(2)}`);
console.log(`OOS Profit Factor: ${aggResult.pf.toFixed(3)}`);
console.log(`OOS Sharpe:        ${aggResult.sharpe.toFixed(3)}`);
console.log(`OOS Win Rate:      ${(aggResult.wr * 100).toFixed(1)}%`);

const avgWin = allOOSTrades.filter(t => t.pnl > 0).length > 0
  ? allOOSTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / allOOSTrades.filter(t => t.pnl > 0).length
  : 0;
const avgLoss = allOOSTrades.filter(t => t.pnl <= 0).length > 0
  ? allOOSTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / allOOSTrades.filter(t => t.pnl <= 0).length
  : 0;
console.log(`Avg win:           $${avgWin.toFixed(2)}`);
console.log(`Avg loss:          $${avgLoss.toFixed(2)}`);
console.log(`Avg PnL/trade:     $${(aggResult.totalPnl / allOOSTrades.length).toFixed(3)}`);

// ── Degradation ratio ──────────────────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("OOS DEGRADATION ANALYSIS");
console.log("=".repeat(80));

const validWindows = results.filter(r => r.trainPF > 0 && r.oosTrades > 0);
const avgTrainPF = validWindows.reduce((s, r) => s + r.trainPF, 0) / validWindows.length;
const avgOOSPF = validWindows.reduce((s, r) => s + r.oosPF, 0) / validWindows.length;
const degradationRatio = avgTrainPF > 0 ? avgOOSPF / avgTrainPF : 0;

console.log(`Avg Train PF:        ${avgTrainPF.toFixed(3)}`);
console.log(`Avg OOS PF:          ${avgOOSPF.toFixed(3)}`);
console.log(`Degradation Ratio:   ${degradationRatio.toFixed(3)} (>0.5 = robust, <0.3 = overfit)`);

const windowsAbove1 = results.filter(r => r.oosPF > 1.0).length;
console.log(`\nWindows with OOS PF > 1.0: ${windowsAbove1} / ${results.length} (${(windowsAbove1 / results.length * 100).toFixed(0)}%)`);

// ── Parameter stability ────────────────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("PARAMETER STABILITY");
console.log("=".repeat(80));

const entryLBCounts = new Map<number, number>();
const exitLBCounts = new Map<number, number>();
const atrMultCounts = new Map<number, number>();
for (const r of results) {
  entryLBCounts.set(r.bestParams.entryLB, (entryLBCounts.get(r.bestParams.entryLB) ?? 0) + 1);
  exitLBCounts.set(r.bestParams.exitLB, (exitLBCounts.get(r.bestParams.exitLB) ?? 0) + 1);
  atrMultCounts.set(r.bestParams.atrMult, (atrMultCounts.get(r.bestParams.atrMult) ?? 0) + 1);
}

console.log("\nEntry lookback distribution:");
for (const [k, v] of [...entryLBCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  LB=${k}: ${v} windows (${(v / results.length * 100).toFixed(0)}%)`);
}
console.log("\nExit lookback distribution:");
for (const [k, v] of [...exitLBCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ExitLB=${k}: ${v} windows (${(v / results.length * 100).toFixed(0)}%)`);
}
console.log("\nATR multiplier distribution:");
for (const [k, v] of [...atrMultCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ATR=${k}: ${v} windows (${(v / results.length * 100).toFixed(0)}%)`);
}

// ── Per-pair OOS breakdown ─────────────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("PER-PAIR OOS PERFORMANCE");
console.log("=".repeat(80));

const pairPerf = new Map<string, { trades: number; pnl: number; wins: number }>();
for (const t of allOOSTrades) {
  const p = pairPerf.get(t.pair) ?? { trades: 0, pnl: 0, wins: 0 };
  p.trades++;
  p.pnl += t.pnl;
  if (t.pnl > 0) p.wins++;
  pairPerf.set(t.pair, p);
}

console.log("\nPair         Trades   PnL      WR%     Avg PnL");
console.log("-".repeat(55));
for (const [pair, p] of [...pairPerf.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
  console.log(
    `${pair.padEnd(12)} ${String(p.trades).padStart(6)}   $${p.pnl.toFixed(1).padStart(7)}  ` +
    `${(p.wins / p.trades * 100).toFixed(1).padStart(5)}%  ` +
    `$${(p.pnl / p.trades).toFixed(2).padStart(7)}`
  );
}

console.log("\nDone.");
