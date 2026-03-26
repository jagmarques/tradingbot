/**
 * Win-Rate Boost Research
 *
 * Base: Supertrend(14,2) on 4h (aggregated from 5m).
 * Tests 9 techniques to push WR above 55% without destroying PF / $/day.
 */

import * as fs from "fs";
import * as path from "path";

// ── Config ───────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 5;             // $5 margin
const NOT = SIZE * LEV;     // $50 notional
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const HOUR = 3600000;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE",
  "APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

// ── Types ────────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v?: number; }
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

// ── Data Loading ─────────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
    : b
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles5m: C[]): C[] {
  // Group into aligned 4h blocks (48 x 5m bars)
  const blockSize = 48;
  const result: C[] = [];
  // Align to 4h boundary
  const firstT = candles5m[0]?.t ?? 0;
  const align = Math.floor(firstT / (4 * HOUR)) * (4 * HOUR);

  const groups = new Map<number, C[]>();
  for (const c of candles5m) {
    const block = Math.floor((c.t - align) / (4 * HOUR));
    const key = align + block * 4 * HOUR;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < blockSize * 0.7) continue;
    // Sum volume if available
    const vol = bars.reduce((s, b) => s + (b.v ?? 0), 0);
    result.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(g => g.h)),
      l: Math.min(...bars.map(g => g.l)),
      c: bars[bars.length - 1].c,
      v: vol > 0 ? vol : undefined,
    });
  }
  return result;
}

// ── Indicators ───────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j-1].c), Math.abs(cs[j].l - cs[j-1].c));
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
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
      ema[i] = values[i] * k + ema[i-1] * (1 - k);
    }
  }
  return ema;
}

function calcRSI(values: number[], period: number): number[] {
  const rsi = new Array(values.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss > 0) {
    rsi[period] = 100 - 100 / (1 + avgGain / avgLoss);
  } else {
    rsi[period] = avgGain > 0 ? 100 : 50;
  }
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    if (avgLoss > 0) {
      rsi[i] = 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      rsi[i] = avgGain > 0 ? 100 : 50;
    }
  }
  return rsi;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1); // 1=bullish, -1=bearish
  const upperBands = new Array(cs.length).fill(0);
  const lowerBands = new Array(cs.length).fill(0);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      if (lowerBand > lowerBands[i-1] || cs[i-1].c < lowerBands[i-1]) {
        // keep new lowerBand
      } else {
        lowerBand = lowerBands[i-1];
      }
      if (upperBand < upperBands[i-1] || cs[i-1].c > upperBands[i-1]) {
        // keep new upperBand
      } else {
        upperBand = upperBands[i-1];
      }
    }

    upperBands[i] = upperBand;
    lowerBands[i] = lowerBand;

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i-1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }

    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
}

// ── Cost / PnL ───────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip  = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE_TAKER * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

// ── Metrics ──────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

function calcMetrics(trades: Tr[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.reduce((s, r) => s + r, 0) / Math.max(returns.length, 1);
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = (endTs - startTs) / DAY;
  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe, dd: maxDD, total,
    perDay: days > 0 ? total / days : 0,
  };
}

// ── Technique options for the simulator ──────────────────────────────
interface TechniqueOpts {
  name: string;
  // Breakeven stop: move SL to entry after N x ATR profit
  breakevenATR?: number;        // e.g. 1.0 = 1x ATR
  // Time exit for losers: close after N bars if losing
  timeExitBars?: number;        // e.g. 12
  // Confirmation: wait N extra bars after flip
  confirmBars?: number;         // e.g. 1
  // RSI filter
  rsiFilter?: boolean;
  // Volume filter
  volumeFilter?: boolean;       // vol > 1.5x 20-bar avg
  // Fixed TP %
  tpPct?: number;               // e.g. 0.05 = 5%
  // Custom SL/TP
  slPct?: number;               // e.g. 0.02 = 2%
  customTP?: number;            // e.g. 0.06 = 6%
  // EMA trend filter
  emaTrendFilter?: boolean;     // EMA(50) trend alignment
}

// ── Main simulation with all techniques ──────────────────────────────
function simulate(
  opts: TechniqueOpts,
  pairData: Map<string, { cs4h: C[]; st: { st: number[]; dir: number[] }; atr: number[]; rsi: number[]; ema50: number[]; vol20avg: number[] }>,
  startTs: number,
  endTs: number,
): Tr[] {
  const trades: Tr[] = [];

  for (const [pair, data] of pairData) {
    const { cs4h, st, atr, rsi, ema50, vol20avg } = data;
    const dirs = st.dir;

    let pos: {
      dir: "long"|"short"; ep: number; et: number; sl: number;
      beSL: boolean;  // breakeven stop activated
      barsHeld: number;
    } | null = null;

    for (let i = 15; i < cs4h.length; i++) {
      if (cs4h[i].t > endTs && !pos) continue;

      const prevDir = dirs[i - 1];
      const prevPrevDir = dirs[i - 2] ?? prevDir;
      const flipped = prevDir !== prevPrevDir;

      // ── Manage open position ──
      if (pos) {
        const bar = cs4h[i];
        pos.barsHeld++;
        const curATR = atr[i - 1] || atr[i - 2] || 0;
        let xp = 0, reason = "";
        let isSL = false;

        // Breakeven stop: if we've hit 1x ATR profit, move SL to entry
        if (!pos.beSL && opts.breakevenATR && curATR > 0) {
          if (pos.dir === "long" && bar.h >= pos.ep + opts.breakevenATR * curATR) {
            pos.sl = pos.ep; // move to breakeven
            pos.beSL = true;
          }
          if (pos.dir === "short" && bar.l <= pos.ep - opts.breakevenATR * curATR) {
            pos.sl = pos.ep;
            pos.beSL = true;
          }
        }

        // Check SL hit
        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl; reason = pos.beSL ? "be-sl" : "sl"; isSL = !pos.beSL;
        }
        if (!xp && pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl; reason = pos.beSL ? "be-sl" : "sl"; isSL = !pos.beSL;
        }

        // Check TP (fixed pct)
        const tpPct = opts.tpPct ?? opts.customTP;
        if (!xp && tpPct) {
          const tpPrice = pos.dir === "long" ? pos.ep * (1 + tpPct) : pos.ep * (1 - tpPct);
          if (pos.dir === "long" && bar.h >= tpPrice) { xp = tpPrice; reason = "tp"; }
          if (!xp && pos.dir === "short" && bar.l <= tpPrice) { xp = tpPrice; reason = "tp"; }
        }

        // Time exit for losers
        if (!xp && opts.timeExitBars && pos.barsHeld >= opts.timeExitBars) {
          const curPnl = pos.dir === "long" ? (bar.c - pos.ep) / pos.ep : (pos.ep - bar.c) / pos.ep;
          if (curPnl < 0) {
            xp = bar.c; reason = "time-exit";
          }
        }

        // Supertrend flip exit
        if (!xp && flipped) {
          xp = bar.o; reason = "flip";
        }

        if (xp > 0 && pos.et >= startTs && pos.et < endTs) {
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, isSL);
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason });
          pos = null;
        } else if (xp > 0) {
          pos = null;
        }
      }

      // ── Entry logic ──
      if (!pos && cs4h[i].t >= startTs && cs4h[i].t < endTs) {
        // Determine flip point (with optional confirmation delay)
        const confirmDelay = opts.confirmBars ?? 0;
        const checkIdx = i - confirmDelay;
        if (checkIdx < 2) continue;
        const flipDir = dirs[checkIdx - 1];
        const flipPrevDir = dirs[checkIdx - 2] ?? flipDir;
        const didFlip = flipDir !== flipPrevDir;
        if (!didFlip) continue;

        // If confirmation, make sure all intermediate bars maintained direction
        let confirmed = true;
        for (let c = checkIdx; c <= i - 1; c++) {
          if (dirs[c] !== flipDir) { confirmed = false; break; }
        }
        if (!confirmed) continue;

        const newDir: "long"|"short" = flipDir === 1 ? "long" : "short";

        // RSI filter
        if (opts.rsiFilter) {
          const curRSI = rsi[i - 1] || 50;
          if (newDir === "long" && curRSI <= 50) continue;
          if (newDir === "short" && curRSI >= 50) continue;
        }

        // Volume filter
        if (opts.volumeFilter) {
          const curVol = cs4h[i - 1]?.v ?? 0;
          const avgVol = vol20avg[i - 1] || 0;
          if (avgVol <= 0 || curVol < 1.5 * avgVol) continue;
        }

        // EMA(50) trend filter
        if (opts.emaTrendFilter) {
          const curEMA = ema50[i - 1];
          const curPrice = cs4h[i - 1].c;
          if (curEMA <= 0) continue;
          if (newDir === "long" && curPrice <= curEMA) continue;
          if (newDir === "short" && curPrice >= curEMA) continue;
        }

        const ep = cs4h[i].o;
        const curATR = atr[i - 1] || atr[i - 2] || 0;

        // SL: ATR-based default = 3x ATR, capped at 3.5%
        let slDist: number;
        if (opts.slPct) {
          slDist = ep * opts.slPct;
        } else {
          slDist = Math.min(3 * curATR, ep * 0.035);
        }
        const sl = newDir === "long" ? ep - slDist : ep + slDist;

        pos = { dir: newDir, ep, et: cs4h[i].t, sl, beSL: false, barsHeld: 0 };
      }
    }

    // Close any open position at end
    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = cs4h[cs4h.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ── Main ─────────────────────────────────────────────────────────────
console.log("Loading 5m data and aggregating to 4h...");

const pairData = new Map<string, {
  cs4h: C[]; st: { st: number[]; dir: number[] }; atr: number[];
  rsi: number[]; ema50: number[]; vol20avg: number[];
}>();

for (const pair of PAIRS) {
  const raw5m = load5m(pair);
  if (raw5m.length < 1000) { console.log(`  SKIP ${pair}: only ${raw5m.length} 5m bars`); continue; }
  const cs4h = aggregateTo4h(raw5m);
  if (cs4h.length < 100) { console.log(`  SKIP ${pair}: only ${cs4h.length} 4h bars`); continue; }

  const st = calcSupertrend(cs4h, 14, 2);
  const atr = calcATR(cs4h, 14);
  const closes = cs4h.map(c => c.c);
  const rsi = calcRSI(closes, 14);
  const ema50 = calcEMA(closes, 50);

  // 20-bar volume moving average
  const vol20avg = new Array(cs4h.length).fill(0);
  for (let i = 20; i < cs4h.length; i++) {
    let s = 0;
    for (let j = i - 20; j < i; j++) s += (cs4h[j].v ?? 0);
    vol20avg[i] = s / 20;
  }

  pairData.set(pair, { cs4h, st, atr, rsi, ema50, vol20avg });
  console.log(`  ${pair}: ${cs4h.length} 4h bars (${raw5m.length} 5m)`);
}

console.log(`\nLoaded ${pairData.size} pairs.`);
console.log(`Full period: 2023-01 to 2026-03 | OOS: 2025-09-01+`);
console.log(`Base: Supertrend(14,2) on 4h, ATR SL 3x capped 3.5%, flip exit`);
console.log(`Cost: taker 0.035%, spread map, 1.5x SL slippage, 10x lev, $5 margin ($50 notional)\n`);

// ── Define techniques ────────────────────────────────────────────────
const techniques: TechniqueOpts[] = [
  { name: "0. BASELINE (flip only)" },
  { name: "1. Breakeven stop 1xATR",    breakevenATR: 1.0 },
  { name: "2. Time exit 12 bars",       timeExitBars: 12 },
  { name: "3. Confirmation +1 bar",     confirmBars: 1 },
  { name: "4. RSI(14) agreement",       rsiFilter: true },
  { name: "5. Volume confirm 1.5x",     volumeFilter: true },
  { name: "6a. Tight TP 5%",            tpPct: 0.05 },
  { name: "6b. TP 3%",                  tpPct: 0.03 },
  { name: "6c. TP 4%",                  tpPct: 0.04 },
  { name: "6d. TP 7%",                  tpPct: 0.07 },
  { name: "6e. TP 10%",                 tpPct: 0.10 },
  { name: "7a. SL 2% + TP 6%",          slPct: 0.02, customTP: 0.06 },
  { name: "7b. SL 2% + TP 4%",          slPct: 0.02, customTP: 0.04 },
  { name: "7c. SL 1.5% + TP 4.5%",      slPct: 0.015, customTP: 0.045 },
  { name: "7d. SL 2.5% + TP 5%",        slPct: 0.025, customTP: 0.05 },
  { name: "8. EMA(50) trend filter",    emaTrendFilter: true },
];

// ── Run all techniques and collect OOS results ───────────────────────

interface Result {
  name: string;
  oos: Metrics;
  full: Metrics;
  exitBreakdown: Map<string, number>;
}

const results: Result[] = [];

for (const tech of techniques) {
  const oosTrades = simulate(tech, pairData, OOS_START, FULL_END);
  const fullTrades = simulate(tech, pairData, FULL_START, FULL_END);
  const oosM = calcMetrics(oosTrades, OOS_START, FULL_END);
  const fullM = calcMetrics(fullTrades, FULL_START, FULL_END);

  const exitBreakdown = new Map<string, number>();
  for (const t of oosTrades) exitBreakdown.set(t.reason, (exitBreakdown.get(t.reason) ?? 0) + 1);

  results.push({ name: tech.name, oos: oosM, full: fullM, exitBreakdown });
}

// ── Print OOS results ────────────────────────────────────────────────
const oosDays = (FULL_END - OOS_START) / DAY;

console.log("=" .repeat(130));
console.log("OOS RESULTS (2025-09-01 to 2026-03-26)");
console.log("=" .repeat(130));
console.log(
  "Technique".padEnd(32) +
  "Trades".padStart(7) +
  "WR%".padStart(8) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(8) +
  "MaxDD".padStart(8) +
  "Total".padStart(9) +
  "  Exits"
);
console.log("-".repeat(130));

const baselineWR = results[0].oos.wr;
const baselinePD = results[0].oos.perDay;

for (const r of results) {
  const m = r.oos;
  const wrDelta = m.wr - baselineWR;
  const pdDelta = m.perDay - baselinePD;
  const wrTag = wrDelta > 0 ? ` (+${wrDelta.toFixed(1)})` : wrDelta < 0 ? ` (${wrDelta.toFixed(1)})` : "";
  const exits = [...r.exitBreakdown.entries()].map(([k, v]) => `${k}:${v}`).join(" ");

  console.log(
    r.name.padEnd(32) +
    String(m.n).padStart(7) +
    `${m.wr.toFixed(1)}${wrTag}`.padStart(8 + wrTag.length) +
    m.pf.toFixed(2).padStart(7) +
    m.sharpe.toFixed(2).padStart(8) +
    `$${m.perDay.toFixed(2)}`.padStart(8) +
    `$${m.dd.toFixed(0)}`.padStart(8) +
    `$${m.total.toFixed(0)}`.padStart(9) +
    `  ${exits}`
  );
}

// ── Highlight winners ────────────────────────────────────────────────
console.log("\n" + "=".repeat(130));
console.log("ANALYSIS: Techniques that improve WR without destroying PF or $/day");
console.log("=".repeat(130));

const winners: Result[] = [];
const baseOOS = results[0].oos;

for (let i = 1; i < results.length; i++) {
  const r = results[i];
  const wrUp = r.oos.wr > baseOOS.wr;
  const pfOk = r.oos.pf >= baseOOS.pf * 0.8;  // allow 20% PF drop
  const pdOk = r.oos.perDay >= baseOOS.perDay * 0.7;  // allow 30% $/day drop

  const verdict = wrUp && pfOk && pdOk ? "WINNER" : wrUp && pfOk ? "MIXED ($/day hit)" : wrUp ? "WR up but PF/$ crushed" : "NO IMPROVEMENT";
  const tag = wrUp && pfOk && pdOk ? ">>>" : "   ";

  console.log(
    `${tag} ${r.name.padEnd(32)} WR: ${r.oos.wr.toFixed(1)}% (${(r.oos.wr - baseOOS.wr) >= 0 ? "+" : ""}${(r.oos.wr - baseOOS.wr).toFixed(1)})  ` +
    `PF: ${r.oos.pf.toFixed(2)}  $/day: $${r.oos.perDay.toFixed(2)}  -- ${verdict}`
  );

  if (wrUp && pfOk && pdOk) winners.push(r);
}

// ── Combined techniques (always run) ─────────────────────────────────
console.log("\n" + "=".repeat(130));
console.log("COMBINATIONS - Mixing techniques to maximize WR while preserving edge");
console.log("=".repeat(130));

const combos: TechniqueOpts[] = [
  // TP-based combos (TP drives WR the most)
  { name: "C1.  RSI + TP5%",                rsiFilter: true, tpPct: 0.05 },
  { name: "C2.  RSI + TP4%",                rsiFilter: true, tpPct: 0.04 },
  { name: "C3.  RSI + TP3%",                rsiFilter: true, tpPct: 0.03 },
  { name: "C4.  RSI + EMA50 + TP5%",        rsiFilter: true, emaTrendFilter: true, tpPct: 0.05 },
  { name: "C5.  RSI + EMA50 + TP4%",        rsiFilter: true, emaTrendFilter: true, tpPct: 0.04 },
  { name: "C6.  RSI + EMA50 + TP3%",        rsiFilter: true, emaTrendFilter: true, tpPct: 0.03 },
  // SL/TP ratio combos with filters
  { name: "C7.  RSI + SL2%+TP4%",           rsiFilter: true, slPct: 0.02, customTP: 0.04 },
  { name: "C8.  RSI + SL1.5%+TP4.5%",       rsiFilter: true, slPct: 0.015, customTP: 0.045 },
  { name: "C9.  RSI + SL2%+TP6%",           rsiFilter: true, slPct: 0.02, customTP: 0.06 },
  { name: "C10. EMA50 + TP5%",              emaTrendFilter: true, tpPct: 0.05 },
  { name: "C11. EMA50 + TP4%",              emaTrendFilter: true, tpPct: 0.04 },
  { name: "C12. Vol + TP5%",                volumeFilter: true, tpPct: 0.05 },
  { name: "C13. Vol + RSI + TP5%",           volumeFilter: true, rsiFilter: true, tpPct: 0.05 },
  { name: "C14. Confirm + RSI + TP5%",       confirmBars: 1, rsiFilter: true, tpPct: 0.05 },
  { name: "C15. TimeExit + TP5%",            timeExitBars: 12, tpPct: 0.05 },
  { name: "C16. TimeExit + RSI + TP5%",      timeExitBars: 12, rsiFilter: true, tpPct: 0.05 },
  // SL/TP combos with RSI + EMA
  { name: "C17. RSI+EMA+SL2%+TP4%",         rsiFilter: true, emaTrendFilter: true, slPct: 0.02, customTP: 0.04 },
  { name: "C18. RSI+EMA+SL1.5%+TP4.5%",     rsiFilter: true, emaTrendFilter: true, slPct: 0.015, customTP: 0.045 },
  { name: "C19. RSI+EMA+SL2.5%+TP5%",       rsiFilter: true, emaTrendFilter: true, slPct: 0.025, customTP: 0.05 },
  // Aggressive WR combos
  { name: "C20. Vol+RSI+EMA+TP4%",          volumeFilter: true, rsiFilter: true, emaTrendFilter: true, tpPct: 0.04 },
  { name: "C21. Vol+RSI+EMA+TP5%",          volumeFilter: true, rsiFilter: true, emaTrendFilter: true, tpPct: 0.05 },
  { name: "C22. Vol+RSI+SL2%+TP4%",         volumeFilter: true, rsiFilter: true, slPct: 0.02, customTP: 0.04 },
  { name: "C23. Confirm+RSI+EMA+TP4%",       confirmBars: 1, rsiFilter: true, emaTrendFilter: true, tpPct: 0.04 },
  { name: "C24. RSI+EMA+SL2%+TP5%",         rsiFilter: true, emaTrendFilter: true, slPct: 0.02, customTP: 0.05 },
];

console.log(
  "Combo".padEnd(35) +
  "Trades".padStart(7) +
  "WR%".padStart(8) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(8) +
  "MaxDD".padStart(8) +
  "Total".padStart(9) +
  "  Note"
);
console.log("-".repeat(130));

for (const co of combos) {
  const coTrades = simulate(co, pairData, OOS_START, FULL_END);
  const coM = calcMetrics(coTrades, OOS_START, FULL_END);
  const wrDelta = coM.wr - baseOOS.wr;
  const note = coM.wr >= 55 && coM.pf >= 1.0 && coM.perDay > 0 ? "TARGET HIT" :
               coM.wr >= 50 && coM.pf >= 1.0 && coM.perDay > 0 ? "CLOSE" :
               coM.wr >= 45 && coM.pf >= 1.1 ? "GOOD WR" : "";
  console.log(
    co.name.padEnd(35) +
    String(coM.n).padStart(7) +
    `${coM.wr.toFixed(1)}`.padStart(8) +
    coM.pf.toFixed(2).padStart(7) +
    coM.sharpe.toFixed(2).padStart(8) +
    `$${coM.perDay.toFixed(2)}`.padStart(8) +
    `$${coM.dd.toFixed(0)}`.padStart(8) +
    `$${coM.total.toFixed(0)}`.padStart(9) +
    (note ? `  ${note}` : "")
  );
}

// ── Full-period sanity check ─────────────────────────────────────────
console.log("\n" + "=".repeat(130));
console.log("FULL PERIOD RESULTS (2023-01 to 2026-03) - Sanity Check");
console.log("=".repeat(130));
console.log(
  "Technique".padEnd(32) +
  "Trades".padStart(7) +
  "WR%".padStart(8) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(8) +
  "MaxDD".padStart(8) +
  "Total".padStart(9)
);
console.log("-".repeat(95));

for (const r of results) {
  const m = r.full;
  console.log(
    r.name.padEnd(32) +
    String(m.n).padStart(7) +
    `${m.wr.toFixed(1)}`.padStart(8) +
    m.pf.toFixed(2).padStart(7) +
    m.sharpe.toFixed(2).padStart(8) +
    `$${m.perDay.toFixed(2)}`.padStart(8) +
    `$${m.dd.toFixed(0)}`.padStart(8) +
    `$${m.total.toFixed(0)}`.padStart(9)
  );
}

console.log("\nDone.");
