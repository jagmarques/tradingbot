/**
 * SMA-Optimal Combo Backtest
 *
 * Tests 5 entry signals x 5 exit frameworks = 25 combinations.
 * Goal: find the best entry+exit combo from the full matrix.
 *
 * Entry signals:
 *   1. SMA 20/50  2. SMA 30/60  3. SMA 50/100  4. EMA 20/50  5. Donchian 30d
 *
 * Exit frameworks:
 *   A. Donchian 15d + ATR×3 SL + 60d hold
 *   B. ATR trailing (3→2→1.5) + 60d hold
 *   C. Reverse signal only
 *   D. Reverse signal + ATR×4 catastrophic SL
 *   E. Time-based 30d exit
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 10;
const NOT = SIZE * LEV;
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
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const OOS_START = new Date("2025-09-01").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Pos {
  pair: string; dir: "long"|"short"; ep: number; et: number;
  sl: number; peak: number; atrAtEntry: number; entryIdx: number;
}
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; holdDays: number;
}
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number; total: number; perDay: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
    : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
  ).sort((a: C, b: C) => a.t - b.t);
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
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcSMA(values: number[], period: number): number[] {
  const sma = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    sma[i] = s / period;
  }
  return sma;
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

// ─── Cost ───────────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE * 2;
  const rawPnl = dir === "long" ? (xp / ep - 1) * NOT : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
function calcMetrics(trades: Tr[]): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, total: 0, perDay: 0 };
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

  const firstT = Math.min(...trades.map(t => t.et));
  const lastT = Math.max(...trades.map(t => t.xt));
  const days = (lastT - firstT) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
    sharpe,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

// ─── Entry Signals ──────────────────────────────────────────────────
// Returns direction on day i-1 (signal day). Entry will be at day i open.

type SignalFn = (cs: C[], i: number, indicators: Map<string, number[]>) => "long"|"short"|null;

function mkSmaCrossSignal(fast: number, slow: number): { fn: SignalFn; warmup: number; indicatorKeys: string[] } {
  const keyF = `sma${fast}`;
  const keyS = `sma${slow}`;
  return {
    warmup: slow + 1,
    indicatorKeys: [keyF, keyS],
    fn: (cs, i, ind) => {
      const smaF = ind.get(keyF)!;
      const smaS = ind.get(keyS)!;
      // Signal on day i-1
      const idx = i - 1;
      if (smaF[idx] === 0 || smaS[idx] === 0) return null;
      if (smaF[idx] > smaS[idx]) return "long";
      if (smaF[idx] < smaS[idx]) return "short";
      return null;
    },
  };
}

function mkEmaCrossSignal(fast: number, slow: number): { fn: SignalFn; warmup: number; indicatorKeys: string[] } {
  const keyF = `ema${fast}`;
  const keyS = `ema${slow}`;
  return {
    warmup: slow + 1,
    indicatorKeys: [keyF, keyS],
    fn: (cs, i, ind) => {
      const emaF = ind.get(keyF)!;
      const emaS = ind.get(keyS)!;
      const idx = i - 1;
      if (emaF[idx] === 0 || emaS[idx] === 0) return null;
      if (emaF[idx] > emaS[idx]) return "long";
      if (emaF[idx] < emaS[idx]) return "short";
      return null;
    },
  };
}

function mkDonchianSignal(lb: number): { fn: SignalFn; warmup: number; indicatorKeys: string[] } {
  return {
    warmup: lb + 1,
    indicatorKeys: [],
    fn: (cs, i, _ind) => {
      const prev = cs[i - 1];
      const dHigh = donchianHigh(cs, i - 1, lb);
      const dLow = donchianLow(cs, i - 1, lb);
      if (prev.c > dHigh) return "long";
      if (prev.c < dLow) return "short";
      return null;
    },
  };
}

// For cross signals: detect state CHANGE (not just position)
// The cross entry signals only trigger a new trade when the signal CHANGES direction,
// not when it's already in that direction. This avoids re-entering on the same signal.

// ─── Exit Frameworks ────────────────────────────────────────────────
type ExitCheckFn = (
  pos: Pos, bar: C, i: number, cs: C[], atr: number[],
  signalDir: "long"|"short"|null, barsHeld: number,
) => { xp: number; reason: string; isSL: boolean } | null;

// A. Donchian exit channel (15d) + ATR×3 stop + 60d max hold
function exitDonchianATR(pos: Pos, bar: C, i: number, cs: C[], atr: number[], _sigDir: "long"|"short"|null, barsHeld: number) {
  // SL
  if (pos.dir === "long" && bar.l <= pos.sl) return { xp: pos.sl, reason: "stop-loss", isSL: true };
  if (pos.dir === "short" && bar.h >= pos.sl) return { xp: pos.sl, reason: "stop-loss", isSL: true };

  // Donchian exit
  const exitLow = donchianLow(cs, i, 15);
  const exitHigh = donchianHigh(cs, i, 15);
  if (pos.dir === "long" && bar.c < exitLow) return { xp: bar.c, reason: "donchian-exit", isSL: false };
  if (pos.dir === "short" && bar.c > exitHigh) return { xp: bar.c, reason: "donchian-exit", isSL: false };

  // Max hold
  if (barsHeld >= 60) return { xp: bar.c, reason: "max-hold", isSL: false };
  return null;
}

// B. ATR Trailing stop (3→2→1.5 as profit grows) + 60d max hold
function exitATRTrail(pos: Pos, bar: C, i: number, cs: C[], atr: number[], _sigDir: "long"|"short"|null, barsHeld: number) {
  // Update peak
  if (pos.dir === "long") pos.peak = Math.max(pos.peak, bar.h);
  else pos.peak = Math.min(pos.peak, bar.l);

  // Determine trailing mult based on profit in ATRs
  const profitATRs = pos.dir === "long"
    ? (pos.peak - pos.ep) / pos.atrAtEntry
    : (pos.ep - pos.peak) / pos.atrAtEntry;

  let trailMult = 3;
  if (profitATRs >= 2) trailMult = 1.5;
  else if (profitATRs >= 1) trailMult = 2;

  const trailSL = pos.dir === "long"
    ? pos.peak - trailMult * atr[i-1]
    : pos.peak + trailMult * atr[i-1];

  // Only tighten
  if (pos.dir === "long" && trailSL > pos.sl) pos.sl = trailSL;
  if (pos.dir === "short" && trailSL < pos.sl) pos.sl = trailSL;

  // SL check
  if (pos.dir === "long" && bar.l <= pos.sl) return { xp: pos.sl, reason: "trail-stop", isSL: true };
  if (pos.dir === "short" && bar.h >= pos.sl) return { xp: pos.sl, reason: "trail-stop", isSL: true };

  // Max hold
  if (barsHeld >= 60) return { xp: bar.c, reason: "max-hold", isSL: false };
  return null;
}

// C. Reverse signal only (no SL, no max hold)
function exitReverseOnly(pos: Pos, bar: C, _i: number, _cs: C[], _atr: number[], sigDir: "long"|"short"|null, _barsHeld: number) {
  if (sigDir !== null && sigDir !== pos.dir) {
    return { xp: bar.c, reason: "signal-reverse", isSL: false };
  }
  return null;
}

// D. Reverse signal + ATR×4 catastrophic stop
function exitReverseATR4(pos: Pos, bar: C, _i: number, _cs: C[], _atr: number[], sigDir: "long"|"short"|null, _barsHeld: number) {
  // Catastrophic SL at ATR×4
  if (pos.dir === "long" && bar.l <= pos.sl) return { xp: pos.sl, reason: "catastrophic-sl", isSL: true };
  if (pos.dir === "short" && bar.h >= pos.sl) return { xp: pos.sl, reason: "catastrophic-sl", isSL: true };

  // Reverse signal
  if (sigDir !== null && sigDir !== pos.dir) {
    return { xp: bar.c, reason: "signal-reverse", isSL: false };
  }
  return null;
}

// E. Time-based: exit after 30d
function exitTimeBased(pos: Pos, bar: C, _i: number, _cs: C[], _atr: number[], _sigDir: "long"|"short"|null, barsHeld: number) {
  if (barsHeld >= 30) return { xp: bar.c, reason: "time-30d", isSL: false };
  return null;
}

// ─── Unified Strategy Runner ────────────────────────────────────────
interface EntryDef {
  name: string;
  fn: SignalFn;
  warmup: number;
  indicatorKeys: string[];
  isCross: boolean; // MA cross = always in market; Donchian = only on breakout
}

interface ExitDef {
  name: string;
  fn: ExitCheckFn;
  slMult: number; // ATR multiplier for initial SL (0 = no SL)
}

function runCombo(
  pairs: string[],
  dailyData: Map<string, C[]>,
  entry: EntryDef,
  exit: ExitDef,
  btcFilter: boolean,
  btcDaily: C[],
): Tr[] {
  const ATR_PERIOD = 14;
  const trades: Tr[] = [];

  // BTC trend
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

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < entry.warmup + ATR_PERIOD + 10) continue;
    const atr = calcATR(cs, ATR_PERIOD);

    // Compute needed indicators
    const indicators = new Map<string, number[]>();
    const closes = cs.map(c => c.c);
    for (const key of entry.indicatorKeys) {
      if (key.startsWith("sma")) {
        const p = parseInt(key.slice(3));
        indicators.set(key, calcSMA(closes, p));
      } else if (key.startsWith("ema")) {
        const p = parseInt(key.slice(3));
        indicators.set(key, calcEMA(closes, p));
      }
    }

    let pos: Pos | null = null;
    let prevSignal: "long"|"short"|null = null;
    const warmup = Math.max(entry.warmup, ATR_PERIOD + 1);

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      // Get current signal direction (for exit reverse check and entry)
      const sigDir = entry.fn(cs, i, indicators);

      // Check exit
      if (pos) {
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        const exitResult = exit.fn(pos, bar, i, cs, atr, sigDir, barsHeld);

        if (exitResult) {
          trades.push({
            pair, dir: pos.dir, ep: pos.ep, xp: exitResult.xp,
            et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, exitResult.xp, pos.dir, exitResult.isSL),
            reason: exitResult.reason, holdDays: barsHeld,
          });
          pos = null;
        }
      }

      // Check entry
      if (!pos && sigDir !== null) {
        const curATR = atr[i - 1];
        if (curATR <= 0) { prevSignal = sigDir; continue; }

        let shouldEnter = false;

        if (entry.isCross) {
          // For MA cross entries: only enter on signal CHANGE
          if (sigDir !== prevSignal) shouldEnter = true;
        } else {
          // For Donchian: signal itself IS the entry trigger
          shouldEnter = true;
        }

        if (shouldEnter) {
          // BTC filter
          if (btcFilter && pair !== "BTC") {
            const btcTrend = getBtcTrend(bar.t);
            if (!btcTrend || btcTrend !== sigDir) {
              prevSignal = sigDir;
              continue;
            }
          }

          const ep = bar.o;
          let sl = 0;
          if (exit.slMult > 0) {
            sl = sigDir === "long" ? ep - exit.slMult * curATR : ep + exit.slMult * curATR;
          } else {
            // No SL - set to extreme value
            sl = sigDir === "long" ? 0 : ep * 100;
          }

          pos = { pair, dir: sigDir, ep, et: bar.t, sl, peak: ep, atrAtEntry: curATR, entryIdx: i };
        }
      }

      prevSignal = sigDir;
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

  console.log(`\nFull period: all available data`);
  console.log(`OOS: 2025-09-01 onwards`);
  console.log(`Cost: ${FEE * 100}% taker/side, spread map, 1.5x SL slippage, 10x lev, $10 margin`);
  console.log(`Anti-look-ahead: signal on day i-1, entry at day i open\n`);

  // ─── Define entries ─────────────────────────────────────────────
  const sma2050 = mkSmaCrossSignal(20, 50);
  const sma3060 = mkSmaCrossSignal(30, 60);
  const sma50100 = mkSmaCrossSignal(50, 100);
  const ema2050 = mkEmaCrossSignal(20, 50);
  const donch30 = mkDonchianSignal(30);

  const entries: EntryDef[] = [
    { name: "SMA 20/50", ...sma2050, isCross: true },
    { name: "SMA 30/60", ...sma3060, isCross: true },
    { name: "SMA 50/100", ...sma50100, isCross: true },
    { name: "EMA 20/50", ...ema2050, isCross: true },
    { name: "Donch 30d", ...donch30, isCross: false },
  ];

  const exits: ExitDef[] = [
    { name: "Donch15+ATR3+60d", fn: exitDonchianATR, slMult: 3 },
    { name: "ATRTrail3-2-1.5+60d", fn: exitATRTrail, slMult: 3 },
    { name: "ReverseOnly", fn: exitReverseOnly, slMult: 0 },
    { name: "Reverse+ATR4", fn: exitReverseATR4, slMult: 4 },
    { name: "Time30d", fn: exitTimeBased, slMult: 0 },
  ];

  // ─── Run all 25 combos ─────────────────────────────────────────
  interface ComboResult {
    entryName: string;
    exitName: string;
    full: Metrics;
    oos: Metrics;
    oosLong: Metrics;
    oosShort: Metrics;
  }

  const results: ComboResult[] = [];

  for (const entry of entries) {
    for (const exit of exits) {
      const allTrades = runCombo(ALL_PAIRS, dailyData, entry, exit, false, btcDaily);
      const oosTrades = allTrades.filter(t => t.et >= OOS_START);
      const oosLong = oosTrades.filter(t => t.dir === "long");
      const oosShort = oosTrades.filter(t => t.dir === "short");

      results.push({
        entryName: entry.name,
        exitName: exit.name,
        full: calcMetrics(allTrades),
        oos: calcMetrics(oosTrades),
        oosLong: calcMetrics(oosLong),
        oosShort: calcMetrics(oosShort),
      });
    }
  }

  // ─── Sort by full-period Sharpe ─────────────────────────────────
  results.sort((a, b) => b.full.sharpe - a.full.sharpe);

  // ─── Print ranked table ─────────────────────────────────────────
  console.log("=".repeat(180));
  console.log("RANKED BY FULL-PERIOD SHARPE (25 combos: 5 entries x 5 exits)");
  console.log("=".repeat(180));
  console.log(
    `${"#".padStart(3)}  ${"Entry".padEnd(12)} ${"Exit".padEnd(22)} | ` +
    `${"Full Trades".padStart(6)} ${"Full PF".padStart(7)} ${"Full Sharpe".padStart(7)} ${"Full PnL".padStart(10)} | ` +
    `${"OOS Tr".padStart(6)} ${"OOS PF".padStart(7)} ${"OOS Sharpe".padStart(7)} ${"OOS PnL".padStart(10)} ${"OOS WR".padStart(7)} ${"OOS $/d".padStart(8)} | ` +
    `${"L Tr".padStart(5)} ${"L PF".padStart(6)} ${"L PnL".padStart(9)} | ` +
    `${"S Tr".padStart(5)} ${"S PF".padStart(6)} ${"S PnL".padStart(9)}`
  );
  console.log("-".repeat(180));

  for (let r = 0; r < results.length; r++) {
    const res = results[r];
    const fmtPnl = (v: number) => v >= 0 ? `+$${v.toFixed(1)}` : `-$${Math.abs(v).toFixed(1)}`;
    const fmtPF = (v: number) => v === Infinity ? "  Inf" : v.toFixed(2).padStart(5);
    const fmtDay = (v: number) => v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;

    console.log(
      `${String(r + 1).padStart(3)}  ${res.entryName.padEnd(12)} ${res.exitName.padEnd(22)} | ` +
      `${String(res.full.n).padStart(6)} ${fmtPF(res.full.pf).padStart(7)} ${res.full.sharpe.toFixed(2).padStart(7)} ${fmtPnl(res.full.total).padStart(10)} | ` +
      `${String(res.oos.n).padStart(6)} ${fmtPF(res.oos.pf).padStart(7)} ${res.oos.sharpe.toFixed(2).padStart(7)} ${fmtPnl(res.oos.total).padStart(10)} ${res.oos.wr.toFixed(1).padStart(6)}% ${fmtDay(res.oos.perDay).padStart(8)} | ` +
      `${String(res.oosLong.n).padStart(5)} ${fmtPF(res.oosLong.pf).padStart(6)} ${fmtPnl(res.oosLong.total).padStart(9)} | ` +
      `${String(res.oosShort.n).padStart(5)} ${fmtPF(res.oosShort.pf).padStart(6)} ${fmtPnl(res.oosShort.total).padStart(9)}`
    );
  }

  // ─── BTC Trend Filter on top 3 ─────────────────────────────────
  console.log(`\n${"=".repeat(180)}`);
  console.log("BTC TREND FILTER TEST (top 3 combos by full-period Sharpe)");
  console.log(`BTC EMA 20 > 50 = only longs allowed, BTC EMA 20 < 50 = only shorts allowed`);
  console.log("=".repeat(180));
  console.log(
    `${"#".padStart(3)}  ${"Entry".padEnd(12)} ${"Exit".padEnd(22)} | ` +
    `${"Full Trades".padStart(6)} ${"Full PF".padStart(7)} ${"Full Sharpe".padStart(7)} ${"Full PnL".padStart(10)} | ` +
    `${"OOS Tr".padStart(6)} ${"OOS PF".padStart(7)} ${"OOS Sharpe".padStart(7)} ${"OOS PnL".padStart(10)} ${"OOS WR".padStart(7)} ${"OOS $/d".padStart(8)} | ` +
    `vs NoFilter Full Sharpe | vs NoFilter OOS PnL`
  );
  console.log("-".repeat(180));

  for (let r = 0; r < Math.min(3, results.length); r++) {
    const res = results[r];
    // Find matching entry/exit
    const entryDef = entries.find(e => e.name === res.entryName)!;
    const exitDef = exits.find(e => e.name === res.exitName)!;

    const allTrades = runCombo(ALL_PAIRS, dailyData, entryDef, exitDef, true, btcDaily);
    const oosTrades = allTrades.filter(t => t.et >= OOS_START);
    const full = calcMetrics(allTrades);
    const oos = calcMetrics(oosTrades);

    const fmtPnl = (v: number) => v >= 0 ? `+$${v.toFixed(1)}` : `-$${Math.abs(v).toFixed(1)}`;
    const fmtPF = (v: number) => v === Infinity ? "  Inf" : v.toFixed(2).padStart(5);
    const fmtDay = (v: number) => v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;

    const sharpeDelta = full.sharpe - res.full.sharpe;
    const pnlDelta = oos.total - res.oos.total;

    console.log(
      `${String(r + 1).padStart(3)}  ${res.entryName.padEnd(12)} ${res.exitName.padEnd(22)} | ` +
      `${String(full.n).padStart(6)} ${fmtPF(full.pf).padStart(7)} ${full.sharpe.toFixed(2).padStart(7)} ${fmtPnl(full.total).padStart(10)} | ` +
      `${String(oos.n).padStart(6)} ${fmtPF(oos.pf).padStart(7)} ${oos.sharpe.toFixed(2).padStart(7)} ${fmtPnl(oos.total).padStart(10)} ${oos.wr.toFixed(1).padStart(6)}% ${fmtDay(oos.perDay).padStart(8)} | ` +
      `${sharpeDelta >= 0 ? "+" : ""}${sharpeDelta.toFixed(2).padStart(6)} | ` +
      `${fmtPnl(pnlDelta)}`
    );
  }

  // ─── Summary ────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(100)}`);
  console.log("SUMMARY");
  console.log("=".repeat(100));

  const best = results[0];
  console.log(`\nBest combo (full Sharpe): ${best.entryName} + ${best.exitName}`);
  console.log(`  Full:  ${best.full.n} trades, PF ${best.full.pf.toFixed(2)}, Sharpe ${best.full.sharpe.toFixed(2)}, PnL ${best.full.total >= 0 ? "+" : ""}$${best.full.total.toFixed(1)}`);
  console.log(`  OOS:   ${best.oos.n} trades, PF ${best.oos.pf.toFixed(2)}, Sharpe ${best.oos.sharpe.toFixed(2)}, PnL ${best.oos.total >= 0 ? "+" : ""}$${best.oos.total.toFixed(1)}, WR ${best.oos.wr.toFixed(1)}%, $${best.oos.perDay.toFixed(2)}/day`);
  console.log(`  Longs: ${best.oosLong.n} trades, PF ${best.oosLong.pf.toFixed(2)}, PnL ${best.oosLong.total >= 0 ? "+" : ""}$${best.oosLong.total.toFixed(1)}`);
  console.log(`  Shorts: ${best.oosShort.n} trades, PF ${best.oosShort.pf.toFixed(2)}, PnL ${best.oosShort.total >= 0 ? "+" : ""}$${best.oosShort.total.toFixed(1)}`);

  // Best OOS combo
  const bestOOS = [...results].sort((a, b) => b.oos.sharpe - a.oos.sharpe)[0];
  console.log(`\nBest OOS Sharpe (info only): ${bestOOS.entryName} + ${bestOOS.exitName}`);
  console.log(`  Full: Sharpe ${bestOOS.full.sharpe.toFixed(2)} | OOS: Sharpe ${bestOOS.oos.sharpe.toFixed(2)}, PnL ${bestOOS.oos.total >= 0 ? "+" : ""}$${bestOOS.oos.total.toFixed(1)}, $/day ${bestOOS.oos.perDay.toFixed(2)}`);

  // Entry signal ranking (avg full Sharpe across exits)
  console.log("\nEntry signal ranking (avg full Sharpe across all exits):");
  for (const entry of entries) {
    const entryResults = results.filter(r => r.entryName === entry.name);
    const avgSharpe = entryResults.reduce((s, r) => s + r.full.sharpe, 0) / entryResults.length;
    const avgOOSSharpe = entryResults.reduce((s, r) => s + r.oos.sharpe, 0) / entryResults.length;
    console.log(`  ${entry.name.padEnd(12)}: avg full Sharpe ${avgSharpe.toFixed(2)}, avg OOS Sharpe ${avgOOSSharpe.toFixed(2)}`);
  }

  // Exit framework ranking (avg full Sharpe across entries)
  console.log("\nExit framework ranking (avg full Sharpe across all entries):");
  for (const exit of exits) {
    const exitResults = results.filter(r => r.exitName === exit.name);
    const avgSharpe = exitResults.reduce((s, r) => s + r.full.sharpe, 0) / exitResults.length;
    const avgOOSSharpe = exitResults.reduce((s, r) => s + r.oos.sharpe, 0) / exitResults.length;
    console.log(`  ${exit.name.padEnd(22)}: avg full Sharpe ${avgSharpe.toFixed(2)}, avg OOS Sharpe ${avgOOSSharpe.toFixed(2)}`);
  }
}

main();
