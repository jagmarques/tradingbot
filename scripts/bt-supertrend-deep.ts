/**
 * Supertrend(14,2) 4h Deep Validation
 *
 * 9 tests: per-pair, long/short split, param sensitivity, BTC filter,
 * ATR trailing stop, walk-forward, random entry comparison, monthly P&L,
 * ensemble with Donchian.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 10;
const NOT = SIZE * LEV; // $100 notional
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const HOUR = 3600000;

const OOS_START = new Date("2025-09-01").getTime();

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const ALL_PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
    : b
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles: C[]): C[] {
  const barsPerGroup = 48;
  const result: C[] = [];
  for (let i = 0; i < candles.length; i += barsPerGroup) {
    const group = candles.slice(i, i + barsPerGroup);
    if (group.length < barsPerGroup * 0.8) continue;
    result.push({
      t: group[0].t,
      o: group[0].o,
      h: Math.max(...group.map(g => g.h)),
      l: Math.min(...group.map(g => g.l)),
      c: group[group.length - 1].c,
    });
  }
  return result;
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

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1); // 1 = up (bullish), -1 = down (bearish)

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      const prevUpper = (cs[i-1].h + cs[i-1].l) / 2 + mult * atr[i-1];
      const prevLower = (cs[i-1].h + cs[i-1].l) / 2 - mult * atr[i-1];
      const prevFinalUpper = st[i-1] > 0 && dirs[i-1] === -1 ? st[i-1] : prevUpper;
      const prevFinalLower = st[i-1] > 0 && dirs[i-1] === 1 ? st[i-1] : prevLower;

      if (lowerBand > prevFinalLower || cs[i-1].c < prevFinalLower) {
        // keep lowerBand
      } else {
        lowerBand = prevFinalLower;
      }
      if (upperBand < prevFinalUpper || cs[i-1].c > prevFinalUpper) {
        // keep upperBand
      } else {
        upperBand = prevFinalUpper;
      }
    }

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

// ─── Cost / PnL ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean, notional: number = NOT): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = notional * FEE_TAKER * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return rawPnl - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

function calcMetrics(trades: Tr[], startTs?: number, endTs?: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()].map(p => p / SIZE);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const firstT = startTs ?? Math.min(...trades.map(t => t.et));
  const lastT = endTs ?? Math.max(...trades.map(t => t.xt));
  const days = (lastT - firstT) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

// ─── Supertrend Strategy (pure flip exit) ────────────────────────────
function stratSupertrend(
  pairs: string[],
  fourHData: Map<string, C[]>,
  atrPeriod: number,
  mult: number,
  startTs: number,
  endTs: number = Infinity,
  btcFilter?: { ema20: number[]; ema50: number[]; cs: C[] },
): Tr[] {
  const trades: Tr[] = [];

  for (const pair of pairs) {
    const cs = fourHData.get(pair);
    if (!cs || cs.length < atrPeriod + 20) continue;

    const { dir } = calcSupertrend(cs, atrPeriod, mult);
    let pos: { dir: "long"|"short"; ep: number; et: number } | null = null;

    for (let i = atrPeriod + 1; i < cs.length; i++) {
      if (cs[i].t > endTs && !pos) continue;

      const prevDir = dir[i - 1];
      const prevPrevDir = i >= 2 ? dir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      if (pos && flipped) {
        const xp = cs[i].o;
        const pnl = tradePnl(pair, pos.ep, xp, pos.dir, false);
        if (pos.et >= startTs && pos.et < endTs) {
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: cs[i].t, pnl, reason: "flip" });
        }
        pos = null;
      }

      if (!pos && flipped && cs[i].t >= startTs && cs[i].t < endTs) {
        const newDir: "long"|"short" = prevDir === 1 ? "long" : "short";

        // BTC trend filter
        if (btcFilter && pair !== "BTC") {
          // Find closest BTC 4h bar
          const btcCs = btcFilter.cs;
          let btcIdx = -1;
          for (let b = btcCs.length - 1; b >= 0; b--) {
            if (btcCs[b].t <= cs[i].t) { btcIdx = b; break; }
          }
          if (btcIdx >= 50) {
            const btcTrend = btcFilter.ema20[btcIdx] > btcFilter.ema50[btcIdx] ? "long" : "short";
            if (newDir !== btcTrend) continue; // skip trade if against BTC trend
          }
        }

        pos = { dir: newDir, ep: cs[i].o, et: cs[i].t };
      }
    }

    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = cs[cs.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ─── Supertrend + ATR trailing stop ──────────────────────────────────
function stratSupertrendTrail(
  pairs: string[],
  fourHData: Map<string, C[]>,
  atrPeriod: number,
  mult: number,
  trailATRMult: number,
  activationATRMult: number,
  startTs: number,
  endTs: number = Infinity,
): Tr[] {
  const trades: Tr[] = [];

  for (const pair of pairs) {
    const cs = fourHData.get(pair);
    if (!cs || cs.length < atrPeriod + 20) continue;

    const { dir } = calcSupertrend(cs, atrPeriod, mult);
    const atr = calcATR(cs, atrPeriod);
    let pos: { dir: "long"|"short"; ep: number; et: number; peak: number; trailActive: boolean } | null = null;

    for (let i = atrPeriod + 1; i < cs.length; i++) {
      if (cs[i].t > endTs && !pos) continue;

      const prevDir = dir[i - 1];
      const prevPrevDir = i >= 2 ? dir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      if (pos) {
        const bar = cs[i];
        const curATR = atr[i - 1];

        // Update peak
        if (pos.dir === "long") pos.peak = Math.max(pos.peak, bar.h);
        else pos.peak = Math.min(pos.peak, bar.l);

        // Check if trailing stop should activate (1×ATR profit)
        if (!pos.trailActive) {
          if (pos.dir === "long" && bar.h >= pos.ep + activationATRMult * curATR) pos.trailActive = true;
          if (pos.dir === "short" && bar.l <= pos.ep - activationATRMult * curATR) pos.trailActive = true;
        }

        let xp = 0, reason = "";

        // ATR trailing stop
        if (pos.trailActive && curATR > 0) {
          if (pos.dir === "long") {
            const trailSL = pos.peak - trailATRMult * curATR;
            if (bar.l <= trailSL) { xp = trailSL; reason = "trail-sl"; }
          } else {
            const trailSL = pos.peak + trailATRMult * curATR;
            if (bar.h >= trailSL) { xp = trailSL; reason = "trail-sl"; }
          }
        }

        // Supertrend flip exit
        if (!xp && flipped) {
          xp = bar.o;
          reason = "flip";
        }

        if (xp > 0) {
          const isSL = reason === "trail-sl";
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, isSL);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason });
          }
          pos = null;
        }
      }

      if (!pos && flipped && cs[i].t >= startTs && cs[i].t < endTs) {
        const newDir: "long"|"short" = prevDir === 1 ? "long" : "short";
        pos = { dir: newDir, ep: cs[i].o, et: cs[i].t, peak: cs[i].o, trailActive: false };
      }
    }

    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = cs[cs.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ─── Donchian strategy (for ensemble test) ───────────────────────────
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

function stratDonchian(
  pairs: string[],
  dailyData: Map<string, C[]>,
  entryLB: number,
  exitLB: number,
  atrMult: number,
  maxHoldDays: number,
  startTs: number,
): Tr[] {
  const atrPeriod = 14;
  const trades: Tr[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < entryLB + atrPeriod + 10) continue;
    const atr = calcATR(cs, atrPeriod);
    let pos: { pair: string; dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;
    const warmup = Math.max(entryLB, atrPeriod) + 1;

    for (let i = warmup; i < cs.length; i++) {
      if (pos) {
        const bar = cs[i];
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        if (!xp) {
          const exitLow = donchianLow(cs, i, exitLB);
          const exitHigh = donchianHigh(cs, i, exitLB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        if (!xp && barsHeld >= maxHoldDays) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          const isSL = reason === "stop-loss";
          const tr: Tr = {
            pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
            reason,
          };
          if (pos.et >= startTs) trades.push(tr);
          pos = null;
        }
      }

      if (!pos && i >= warmup) {
        const prev = cs[i - 1];
        const dHigh = donchianHigh(cs, i - 1, entryLB);
        const dLow = donchianLow(cs, i - 1, entryLB);
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        let dir: "long" | "short" | null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        const ep = cs[i].o;
        const sl = dir === "long" ? ep - atrMult * curATR : ep + atrMult * curATR;
        pos = { pair, dir, ep, et: cs[i].t, sl };
      }
    }
  }
  return trades;
}

// ─── Random entry with supertrend flip exit ──────────────────────────
function stratRandomSupertrend(
  pairs: string[],
  fourHData: Map<string, C[]>,
  atrPeriod: number,
  mult: number,
  startTs: number,
  avgFrequency: number, // probability of entry per bar per pair
): Tr[] {
  const trades: Tr[] = [];

  for (const pair of pairs) {
    const cs = fourHData.get(pair);
    if (!cs || cs.length < atrPeriod + 20) continue;

    const { dir } = calcSupertrend(cs, atrPeriod, mult);
    let pos: { dir: "long"|"short"; ep: number; et: number } | null = null;

    for (let i = atrPeriod + 1; i < cs.length; i++) {
      const prevDir = dir[i - 1];
      const prevPrevDir = i >= 2 ? dir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // Exit on supertrend flip (same as real strategy)
      if (pos && flipped) {
        const xp = cs[i].o;
        const pnl = tradePnl(pair, pos.ep, xp, pos.dir, false);
        if (pos.et >= startTs) {
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: cs[i].t, pnl, reason: "flip" });
        }
        pos = null;
      }

      // Random entry
      if (!pos && cs[i].t >= startTs && Math.random() < avgFrequency) {
        const randomDir: "long"|"short" = Math.random() > 0.5 ? "long" : "short";
        pos = { dir: randomDir, ep: cs[i].o, et: cs[i].t };
      }
    }

    if (pos && pos.et >= startTs) {
      const lastBar = cs[cs.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ─── Helpers ────────────────────────────────────────────────────────
function fmtPnl(v: number): string {
  return (v >= 0 ? "+" : "") + "$" + Math.abs(v).toFixed(0);
}

function fmtPnl2(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function printMetrics(label: string, m: Metrics) {
  console.log(
    `  ${label.padEnd(40)} `
    + `N=${String(m.n).padStart(5)}  `
    + `PnL=${fmtPnl(m.total).padStart(8)}  `
    + `PF=${(m.pf === Infinity ? "Inf" : m.pf.toFixed(2)).padStart(5)}  `
    + `Sharpe=${m.sharpe.toFixed(2).padStart(6)}  `
    + `WR=${m.wr.toFixed(1).padStart(5)}%  `
    + `$/d=${m.perDay.toFixed(2).padStart(7)}  `
    + `DD=$${m.dd.toFixed(0).padStart(5)}`
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════
console.log("=".repeat(80));
console.log("  SUPERTREND(14,2) 4H DEEP VALIDATION");
console.log("=".repeat(80));
console.log("\nLoading data...");

const fourHData = new Map<string, C[]>();
const dailyData = new Map<string, C[]>();
const raw5m = new Map<string, C[]>();

for (const pair of ALL_PAIRS) {
  const c5 = load5m(pair);
  if (c5.length === 0) { console.log(`  SKIP ${pair} (no data)`); continue; }
  raw5m.set(pair, c5);
  fourHData.set(pair, aggregateTo4h(c5));
  dailyData.set(pair, aggregateToDaily(c5));
  console.log(`  ${pair}: ${c5.length} 5m -> ${fourHData.get(pair)!.length} 4h, ${dailyData.get(pair)!.length} daily`);
}

// Baseline: Supertrend(14,2) full and OOS
const fullTrades = stratSupertrend(ALL_PAIRS, fourHData, 14, 2, 0);
const oosTrades = stratSupertrend(ALL_PAIRS, fourHData, 14, 2, OOS_START);
const fullM = calcMetrics(fullTrades);
const oosM = calcMetrics(oosTrades);

console.log("\n--- BASELINE ---");
printMetrics("Full period ST(14,2)", fullM);
printMetrics("OOS (Sep 2025+) ST(14,2)", oosM);

// ═══════════════════════════════════════════════════════════════════
//  TEST 1: PER-PAIR BREAKDOWN (OOS)
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 1: PER-PAIR BREAKDOWN (OOS)");
console.log("=".repeat(80));
console.log("\nPair       Trades    WR%      PnL       PF    Sharpe   $/day");
console.log("-".repeat(70));

const pairResults: { pair: string; m: Metrics }[] = [];
for (const pair of ALL_PAIRS) {
  const pt = oosTrades.filter(t => t.pair === pair);
  const m = calcMetrics(pt);
  pairResults.push({ pair, m });
}
pairResults.sort((a, b) => b.m.total - a.m.total);

for (const { pair, m } of pairResults) {
  if (m.n === 0) { console.log(`${pair.padEnd(10)} (no trades)`); continue; }
  console.log(
    `${pair.padEnd(10)} ${String(m.n).padStart(5)}  ${m.wr.toFixed(1).padStart(5)}%  ${fmtPnl(m.total).padStart(8)}  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(7)}  ${fmtPnl2(m.perDay).padStart(7)}`
  );
}

const winners = pairResults.filter(p => p.m.total > 0 && p.m.n > 0);
const losers = pairResults.filter(p => p.m.total <= 0 && p.m.n > 0);
console.log(`\nWinners: ${winners.length} pairs, Losers: ${losers.length} pairs`);
console.log(`Top 3: ${winners.slice(0, 3).map(p => `${p.pair} ${fmtPnl(p.m.total)}`).join(", ")}`);
console.log(`Bottom 3: ${losers.slice(-3).map(p => `${p.pair} ${fmtPnl(p.m.total)}`).join(", ")}`);

// ═══════════════════════════════════════════════════════════════════
//  TEST 2: LONG VS SHORT SPLIT
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 2: LONG VS SHORT SPLIT");
console.log("=".repeat(80));

const fullLong = fullTrades.filter(t => t.dir === "long");
const fullShort = fullTrades.filter(t => t.dir === "short");
const oosLong = oosTrades.filter(t => t.dir === "long");
const oosShort = oosTrades.filter(t => t.dir === "short");

console.log("\nFull period:");
printMetrics("Long", calcMetrics(fullLong));
printMetrics("Short", calcMetrics(fullShort));

console.log("\nOOS (Sep 2025+):");
printMetrics("Long", calcMetrics(oosLong));
printMetrics("Short", calcMetrics(oosShort));

const oosLM = calcMetrics(oosLong);
const oosSM = calcMetrics(oosShort);
console.log(`\nOOS direction bias: ${oosLM.total > oosSM.total ? "LONG" : "SHORT"}-biased (${fmtPnl(oosLM.total)} long vs ${fmtPnl(oosSM.total)} short)`);

// ═══════════════════════════════════════════════════════════════════
//  TEST 3: PARAMETER SENSITIVITY SWEEP
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 3: PARAMETER SENSITIVITY SWEEP");
console.log("=".repeat(80));

const paramSets: { period: number; mult: number }[] = [
  { period: 7, mult: 2 },
  { period: 10, mult: 2 },
  { period: 14, mult: 2 },
  { period: 20, mult: 2 },
  { period: 14, mult: 1.5 },
  { period: 14, mult: 2.5 },
  { period: 14, mult: 3 },
];

console.log("\nParams       Trades    WR%      PnL       PF    Sharpe   $/day    MaxDD");
console.log("-".repeat(85));

for (const ps of paramSets) {
  const trades = stratSupertrend(ALL_PAIRS, fourHData, ps.period, ps.mult, OOS_START);
  const m = calcMetrics(trades);
  const star = (ps.period === 14 && ps.mult === 2) ? " <-- BASELINE" : "";
  console.log(
    `ST(${String(ps.period).padStart(2)},${ps.mult.toFixed(1)})  ${String(m.n).padStart(5)}  ${m.wr.toFixed(1).padStart(5)}%  ${fmtPnl(m.total).padStart(8)}  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(7)}  ${fmtPnl2(m.perDay).padStart(7)}  $${m.dd.toFixed(0).padStart(5)}${star}`
  );
}

// Count profitable params
const paramResults = paramSets.map(ps => {
  const trades = stratSupertrend(ALL_PAIRS, fourHData, ps.period, ps.mult, OOS_START);
  return { ps, m: calcMetrics(trades) };
});
const profitableParams = paramResults.filter(r => r.m.total > 0);
console.log(`\nProfitable param sets: ${profitableParams.length}/${paramSets.length} (${(profitableParams.length / paramSets.length * 100).toFixed(0)}%)`);

// ═══════════════════════════════════════════════════════════════════
//  TEST 4: BTC TREND FILTER
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 4: BTC TREND FILTER (EMA20 > EMA50 on 4h)");
console.log("=".repeat(80));

const btcCs = fourHData.get("BTC");
if (btcCs && btcCs.length > 50) {
  const btcCloses = btcCs.map(c => c.c);
  const btcEma20 = calcEMA(btcCloses, 20);
  const btcEma50 = calcEMA(btcCloses, 50);
  const btcFilter = { ema20: btcEma20, ema50: btcEma50, cs: btcCs };

  const filteredTrades = stratSupertrend(ALL_PAIRS, fourHData, 14, 2, OOS_START, Infinity, btcFilter);
  const filteredM = calcMetrics(filteredTrades);

  console.log("\n");
  printMetrics("Without BTC filter (baseline)", oosM);
  printMetrics("With BTC trend filter", filteredM);

  console.log(`\nFilter impact: ${filteredM.total > oosM.total ? "HELPS" : "HURTS"} (${fmtPnl(filteredM.total - oosM.total)} difference)`);
  console.log(`Trades reduced: ${oosM.n} -> ${filteredM.n} (${((1 - filteredM.n / oosM.n) * 100).toFixed(0)}% fewer)`);
} else {
  console.log("\n  BTC data unavailable, skipping.");
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 5: ATR TRAILING STOP
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 5: ATR TRAILING STOP (activate at 1xATR profit, trail at 2xATR)");
console.log("=".repeat(80));

const trailTrades = stratSupertrendTrail(ALL_PAIRS, fourHData, 14, 2, 2.0, 1.0, OOS_START);
const trailM = calcMetrics(trailTrades);

console.log("\n");
printMetrics("Pure flip exit (baseline)", oosM);
printMetrics("ATR trail (act=1x, dist=2x)", trailM);

// Also test a few other trail configs
const trailConfigs = [
  { act: 0.5, dist: 1.5, label: "act=0.5x, dist=1.5x" },
  { act: 1.0, dist: 2.0, label: "act=1.0x, dist=2.0x" },
  { act: 1.5, dist: 2.5, label: "act=1.5x, dist=2.5x" },
  { act: 2.0, dist: 3.0, label: "act=2.0x, dist=3.0x" },
];

console.log("\nTrail configs comparison:");
console.log("Config                  Trades    WR%      PnL       PF    Sharpe   $/day    MaxDD");
console.log("-".repeat(90));

for (const tc of trailConfigs) {
  const tt = stratSupertrendTrail(ALL_PAIRS, fourHData, 14, 2, tc.dist, tc.act, OOS_START);
  const tm = calcMetrics(tt);
  console.log(
    `${tc.label.padEnd(22)}  ${String(tm.n).padStart(5)}  ${tm.wr.toFixed(1).padStart(5)}%  ${fmtPnl(tm.total).padStart(8)}  ${tm.pf.toFixed(2).padStart(5)}  ${tm.sharpe.toFixed(2).padStart(7)}  ${fmtPnl2(tm.perDay).padStart(7)}  $${tm.dd.toFixed(0).padStart(5)}`
  );
}

console.log(`\nTrailing stop impact: ${trailM.total > oosM.total ? "HELPS" : "HURTS"} (${fmtPnl(trailM.total - oosM.total)} difference)`);

// ═══════════════════════════════════════════════════════════════════
//  TEST 6: WALK-FORWARD (4 WINDOWS)
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 6: WALK-FORWARD VALIDATION (4 WINDOWS)");
console.log("=".repeat(80));

// Get full data range
let dataStart = Infinity, dataEnd = 0;
for (const [, cs] of fourHData) {
  if (cs.length > 0) {
    dataStart = Math.min(dataStart, cs[0].t);
    dataEnd = Math.max(dataEnd, cs[cs.length - 1].t);
  }
}

const totalSpan = dataEnd - dataStart;
const windowSize = totalSpan / 4;

const windows: { start: number; end: number; label: string }[] = [];
for (let w = 0; w < 4; w++) {
  const s = dataStart + w * windowSize;
  const e = dataStart + (w + 1) * windowSize;
  windows.push({
    start: s,
    end: e,
    label: `${new Date(s).toISOString().slice(0, 10)} to ${new Date(e).toISOString().slice(0, 10)}`,
  });
}

console.log("\nWalk-forward: train on 2 windows, test on 1 (rotating)\n");
console.log("Test Window                          Train WR%   Test Trades  Test PnL   Test PF   Test Sharpe");
console.log("-".repeat(100));

const wfResults: Metrics[] = [];
const allWfTrades: Tr[] = [];

for (let testIdx = 1; testIdx < 4; testIdx++) {
  // Train on windows before testIdx
  const trainStart = windows[0].start;
  const trainEnd = windows[testIdx].start;
  const testStart = windows[testIdx].start;
  const testEnd = windows[testIdx].end;

  const trainTrades = stratSupertrend(ALL_PAIRS, fourHData, 14, 2, trainStart, trainEnd);
  const testTrades = stratSupertrend(ALL_PAIRS, fourHData, 14, 2, testStart, testEnd);
  const trainM = calcMetrics(trainTrades);
  const testM = calcMetrics(testTrades);
  wfResults.push(testM);
  allWfTrades.push(...testTrades);

  console.log(
    `${windows[testIdx].label}  ${trainM.wr.toFixed(1).padStart(7)}%  ${String(testM.n).padStart(11)}  ${fmtPnl(testM.total).padStart(9)}  ${testM.pf.toFixed(2).padStart(8)}  ${testM.sharpe.toFixed(2).padStart(11)}`
  );
}

const aggWfM = calcMetrics(allWfTrades);
console.log("-".repeat(100));
console.log(
  `${"AGGREGATE".padEnd(37)}  ${"".padStart(7)}   ${String(aggWfM.n).padStart(11)}  ${fmtPnl(aggWfM.total).padStart(9)}  ${aggWfM.pf.toFixed(2).padStart(8)}  ${aggWfM.sharpe.toFixed(2).padStart(11)}`
);

const profitableWF = wfResults.filter(m => m.total > 0);
console.log(`\nProfitable windows: ${profitableWF.length}/${wfResults.length}`);

// ═══════════════════════════════════════════════════════════════════
//  TEST 7: RANDOM ENTRY COMPARISON (100 RUNS)
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 7: RANDOM ENTRY COMPARISON (100 runs)");
console.log("=".repeat(80));

// Calculate avg entry frequency of real strategy
const oosBarsPerPair = new Map<string, number>();
for (const pair of ALL_PAIRS) {
  const cs = fourHData.get(pair);
  if (!cs) continue;
  const oosBars = cs.filter(c => c.t >= OOS_START).length;
  oosBarsPerPair.set(pair, oosBars);
}
const totalOosBars = [...oosBarsPerPair.values()].reduce((s, n) => s + n, 0);
const pairTradesMap = new Map<string, number>();
for (const t of oosTrades) {
  pairTradesMap.set(t.pair, (pairTradesMap.get(t.pair) ?? 0) + 1);
}
const avgTradesPerPair = oosTrades.length / ALL_PAIRS.length;
const avgBarsPerPair = totalOosBars / ALL_PAIRS.length;
const avgFreq = avgTradesPerPair / avgBarsPerPair;

console.log(`\nReal strategy: ${oosTrades.length} trades, avg freq = ${(avgFreq * 100).toFixed(2)}% per bar`);

const NUM_RANDOM = 100;
let countBeat = 0;
const randomPnls: number[] = [];
const randomSharpes: number[] = [];

for (let r = 0; r < NUM_RANDOM; r++) {
  const randTrades = stratRandomSupertrend(ALL_PAIRS, fourHData, 14, 2, OOS_START, avgFreq);
  const rm = calcMetrics(randTrades);
  randomPnls.push(rm.total);
  randomSharpes.push(rm.sharpe);
  if (rm.total >= oosM.total) countBeat++;
}

randomPnls.sort((a, b) => a - b);
randomSharpes.sort((a, b) => a - b);

const medianRandom = randomPnls[Math.floor(NUM_RANDOM / 2)];
const p95Random = randomPnls[Math.floor(NUM_RANDOM * 0.95)];
const medianRandomSharpe = randomSharpes[Math.floor(NUM_RANDOM / 2)];

console.log(`\nRandom entry results (${NUM_RANDOM} runs):`);
console.log(`  Median PnL:    ${fmtPnl(medianRandom)}`);
console.log(`  95th pctile:   ${fmtPnl(p95Random)}`);
console.log(`  Median Sharpe: ${medianRandomSharpe.toFixed(2)}`);
console.log(`  Real strategy: ${fmtPnl(oosM.total)} PnL, ${oosM.sharpe.toFixed(2)} Sharpe`);
console.log(`  Runs that beat real: ${countBeat}/${NUM_RANDOM} (${(countBeat / NUM_RANDOM * 100).toFixed(0)}%)`);
console.log(`  p-value (PnL): ${(countBeat / NUM_RANDOM).toFixed(3)}`);

// ═══════════════════════════════════════════════════════════════════
//  TEST 8: MONTHLY P&L DISTRIBUTION (OOS)
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 8: MONTHLY P&L DISTRIBUTION (OOS)");
console.log("=".repeat(80));

const monthlyPnl = new Map<string, { pnl: number; trades: number; wins: number }>();
for (const t of oosTrades) {
  const d = new Date(t.xt);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const entry = monthlyPnl.get(key) ?? { pnl: 0, trades: 0, wins: 0 };
  entry.pnl += t.pnl;
  entry.trades++;
  if (t.pnl > 0) entry.wins++;
  monthlyPnl.set(key, entry);
}

const sortedMonths = [...monthlyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));

console.log("\nMonth       Trades    WR%      PnL     Cumulative");
console.log("-".repeat(60));

let cumPnl = 0;
let greenMonths = 0;
let redMonths = 0;

for (const [month, data] of sortedMonths) {
  cumPnl += data.pnl;
  const wr = data.trades > 0 ? (data.wins / data.trades * 100) : 0;
  if (data.pnl > 0) greenMonths++; else redMonths++;
  console.log(
    `${month}     ${String(data.trades).padStart(5)}  ${wr.toFixed(1).padStart(5)}%  ${fmtPnl(data.pnl).padStart(8)}  ${fmtPnl(cumPnl).padStart(10)}`
  );
}

console.log(`\nGreen months: ${greenMonths}, Red months: ${redMonths} (${(greenMonths / (greenMonths + redMonths) * 100).toFixed(0)}% green)`);

// ═══════════════════════════════════════════════════════════════════
//  TEST 9: ENSEMBLE WITH DONCHIAN
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 9: ENSEMBLE WITH DONCHIAN (30d/15d/ATR3/60d hold)");
console.log("=".repeat(80));

// Donchian OOS trades (half size: $5 each)
const donchTrades = stratDonchian(ALL_PAIRS, dailyData, 30, 15, 3.0, 60, OOS_START);

// Scale both to $5 margin ($50 notional)
const stHalf = oosTrades.map(t => ({ ...t, pnl: t.pnl * 0.5 }));
const donchHalf = donchTrades.map(t => ({ ...t, pnl: t.pnl * 0.5 }));

const stHalfM = calcMetrics(stHalf);
const donchHalfM = calcMetrics(donchHalf);

// Combined
const ensembleTrades = [...stHalf, ...donchHalf];
const ensembleM = calcMetrics(ensembleTrades);

console.log("\nIndividual ($5 each):");
printMetrics("Supertrend(14,2) 4h @$5", stHalfM);
printMetrics("Donchian(30/15/3) daily @$5", donchHalfM);
console.log("\nCombined ($5 + $5 = $10 total):");
printMetrics("Ensemble", ensembleM);

// Daily P&L correlation
const stDailyPnl = new Map<number, number>();
const donchDailyPnl = new Map<number, number>();
for (const t of stHalf) {
  const d = Math.floor(t.xt / DAY);
  stDailyPnl.set(d, (stDailyPnl.get(d) ?? 0) + t.pnl);
}
for (const t of donchHalf) {
  const d = Math.floor(t.xt / DAY);
  donchDailyPnl.set(d, (donchDailyPnl.get(d) ?? 0) + t.pnl);
}

// All days with at least one exit in either strategy
const allDays = new Set([...stDailyPnl.keys(), ...donchDailyPnl.keys()]);
const pairedSt: number[] = [];
const pairedDonch: number[] = [];
for (const d of allDays) {
  pairedSt.push(stDailyPnl.get(d) ?? 0);
  pairedDonch.push(donchDailyPnl.get(d) ?? 0);
}

// Pearson correlation
const n = pairedSt.length;
const meanSt = pairedSt.reduce((s, v) => s + v, 0) / n;
const meanDonch = pairedDonch.reduce((s, v) => s + v, 0) / n;
let cov = 0, varSt = 0, varDonch = 0;
for (let i = 0; i < n; i++) {
  cov += (pairedSt[i] - meanSt) * (pairedDonch[i] - meanDonch);
  varSt += (pairedSt[i] - meanSt) ** 2;
  varDonch += (pairedDonch[i] - meanDonch) ** 2;
}
const corr = (varSt > 0 && varDonch > 0) ? cov / Math.sqrt(varSt * varDonch) : 0;

console.log(`\nDaily P&L correlation (ST vs Donch): ${corr.toFixed(3)}`);
console.log(`Interpretation: ${Math.abs(corr) < 0.2 ? "LOW correlation - good diversification" : Math.abs(corr) < 0.5 ? "MODERATE correlation" : "HIGH correlation - poor diversification"}`);

// ═══════════════════════════════════════════════════════════════════
//  FINAL VERDICT
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  FINAL VERDICT");
console.log("=".repeat(80));

console.log("\nSupertrend(14,2) 4h OOS summary:");
console.log(`  Trades: ${oosM.n}, WR: ${oosM.wr.toFixed(1)}%, PF: ${oosM.pf.toFixed(2)}, Sharpe: ${oosM.sharpe.toFixed(2)}`);
console.log(`  Total PnL: ${fmtPnl(oosM.total)}, $/day: ${fmtPnl2(oosM.perDay)}, MaxDD: $${oosM.dd.toFixed(0)}`);

console.log("\nKey findings:");
console.log(`  1. Per-pair: ${winners.length}/${pairResults.filter(p => p.m.n > 0).length} pairs profitable OOS`);
console.log(`  2. Direction: ${oosLM.total > oosSM.total ? "LONG" : "SHORT"}-biased`);
console.log(`  3. Param robustness: ${profitableParams.length}/${paramSets.length} nearby configs profitable`);
console.log(`  4. BTC filter: ${btcCs ? (calcMetrics(stratSupertrend(ALL_PAIRS, fourHData, 14, 2, OOS_START, Infinity, { ema20: calcEMA(btcCs.map(c => c.c), 20), ema50: calcEMA(btcCs.map(c => c.c), 50), cs: btcCs })).total > oosM.total ? "HELPS" : "HURTS") : "N/A"}`);
console.log(`  5. ATR trailing stop: ${trailM.total > oosM.total ? "HELPS" : "HURTS"}`);
console.log(`  6. Walk-forward: ${profitableWF.length}/${wfResults.length} OOS windows profitable`);
console.log(`  7. Random entry p-value: ${(countBeat / NUM_RANDOM).toFixed(3)} (${countBeat < 5 ? "SIGNIFICANT" : "NOT significant"})`);
console.log(`  8. Monthly consistency: ${greenMonths}/${greenMonths + redMonths} green months (${(greenMonths / (greenMonths + redMonths) * 100).toFixed(0)}%)`);
console.log(`  9. Ensemble correlation: ${corr.toFixed(3)} (${Math.abs(corr) < 0.2 ? "low" : Math.abs(corr) < 0.5 ? "moderate" : "high"})`);

// Compare with Donchian
const donchFullM = calcMetrics(donchTrades);
console.log(`\nSupertrend vs Donchian (OOS):`);
console.log(`  ST:    ${oosM.n} trades, PF ${oosM.pf.toFixed(2)}, Sharpe ${oosM.sharpe.toFixed(2)}, ${fmtPnl(oosM.total)}, $/d ${fmtPnl2(oosM.perDay)}`);
console.log(`  Donch: ${donchFullM.n} trades, PF ${donchFullM.pf.toFixed(2)}, Sharpe ${donchFullM.sharpe.toFixed(2)}, ${fmtPnl(donchFullM.total)}, $/d ${fmtPnl2(donchFullM.perDay)}`);
console.log(`  Verdict: ${oosM.perDay > donchFullM.perDay ? "Supertrend BETTER $/day" : "Donchian BETTER $/day"}, ${oosM.sharpe > donchFullM.sharpe ? "ST better Sharpe" : "Donch better Sharpe"}`);
console.log(`  Trade count advantage: ST has ${oosM.n}x more statistical confidence than Donch (${donchFullM.n} trades)`);

console.log("\n" + "=".repeat(80));
