/**
 * New Pairs Test: Supertrend(14, 1.75) with volume-proxy filter
 *
 * Loads 1h candles from /tmp/bt-pair-cache-1h/, aggregates to 4h.
 * Compares current 18 pairs vs all available pairs.
 * Per-pair breakdown for new pairs with PF, $/day, WR, trade count.
 *
 * Cost model: Taker 0.035%, default spread 4e-4 for new pairs, 1.5x SL slippage,
 *             10x leverage, $3 margin ($30 notional).
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-new-pairs-test.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_1H = "/tmp/bt-pair-cache-1h";
const H = 3_600_000;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const SIZE = 3;
const NOT = SIZE * LEV; // $30 notional

const ST_ATR_PERIOD = 14;
const ST_MULT = 1.75;
const ST_SL_ATR_MULT = 3.0;
const ST_SL_MAX_PCT = 0.035;
const ST_STAG_BARS = 12; // 48h at 4h bars (12 x 4h)

// Standard spread map (half-spread)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4,
};
const DEFAULT_SPREAD = 4e-4;

// Current 18 pairs (production set)
const CURRENT_PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

// OOS window: 2025-09-01 to end of data (2026-03-26)
const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-27").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load1h(pair: string): C[] {
  const fp = path.join(CACHE_1H, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) {
    // Try kPEPE format
    const fp2 = path.join(CACHE_1H, `k${pair}USDT.json`);
    if (!fs.existsSync(fp2)) return [];
    const raw = JSON.parse(fs.readFileSync(fp2, "utf8")) as any[];
    return raw.map((b: any) => Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : b
    ).sort((a: C, b: C) => a.t - b.t);
  }
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
    : b
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles: C[]): C[] {
  const barsPerGroup = 4; // 4 x 1h = 4h
  const result: C[] = [];
  // Align to 4h boundaries
  const firstTs = candles[0]?.t ?? 0;
  const startAlign = Math.floor(firstTs / (4 * H)) * (4 * H);

  // Group by 4h windows
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / (4 * H)) * (4 * H);
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 3) continue; // need at least 3 of 4 bars
    result.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c)
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(
          cs[j].h - cs[j].l,
          Math.abs(cs[j].h - cs[j - 1].c),
          Math.abs(cs[j].l - cs[j - 1].c)
        );
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
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
      const prevUpper = (cs[i - 1].h + cs[i - 1].l) / 2 + mult * atr[i - 1];
      const prevLower = (cs[i - 1].h + cs[i - 1].l) / 2 - mult * atr[i - 1];
      const prevFinalUpper = st[i - 1] > 0 && dirs[i - 1] === -1 ? st[i - 1] : prevUpper;
      const prevFinalLower = st[i - 1] > 0 && dirs[i - 1] === 1 ? st[i - 1] : prevLower;

      if (!(lowerBand > prevFinalLower || cs[i - 1].c < prevFinalLower)) {
        lowerBand = prevFinalLower;
      }
      if (!(upperBand < prevFinalUpper || cs[i - 1].c > prevFinalUpper)) {
        upperBand = prevFinalUpper;
      }
    }

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i - 1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }

    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
}

// Volume proxy: range/price ratio compared to 20-bar average
function rangeAboveAvg(cs: C[], idx: number, lookback = 20): boolean {
  if (idx < lookback) return true; // not enough data, allow
  let sumRange = 0;
  for (let k = idx - lookback; k < idx; k++) {
    sumRange += (cs[k].h - cs[k].l) / cs[k].c;
  }
  const avgRange = sumRange / lookback;
  const curRange = (cs[idx].h - cs[idx].l) / cs[idx].c;
  return curRange >= 0.5 * avgRange;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long" | "short", isSL: boolean): number {
  const sp = SP[pair] ?? DEFAULT_SPREAD;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? SL_SLIP : 1);
  const fees = NOT * FEE * 2;
  const rawPnl = dir === "long" ? (xp / ep - 1) * NOT : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

// ─── Strategy ───────────────────────────────────────────────────────
function runSupertrend(
  pairs: string[],
  h4Data: Map<string, C[]>,
  startTs: number,
  endTs: number,
): Tr[] {
  const trades: Tr[] = [];

  for (const pair of pairs) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < ST_ATR_PERIOD + 30) continue;

    const { dir } = calcSupertrend(cs, ST_ATR_PERIOD, ST_MULT);
    const atr = calcATR(cs, ST_ATR_PERIOD);
    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; entryIdx: number } | null = null;

    for (let i = ST_ATR_PERIOD + 1; i < cs.length; i++) {
      const bar = cs[i];
      const prevDir = dir[i - 1];
      const prevPrevDir = i >= 2 ? dir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // EXIT
      if (pos) {
        let xp = 0, reason = "", isSL = false;

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

        if (!xp) {
          const barsHeld = i - pos.entryIdx;
          if (barsHeld >= ST_STAG_BARS) { xp = bar.c; reason = "stag"; }
        }

        if (!xp && flipped) { xp = bar.o; reason = "flip"; }

        if (xp > 0) {
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, isSL);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason });
          }
          pos = null;
        }
      }

      // ENTRY
      if (!pos && flipped && bar.t >= startTs && bar.t < endTs) {
        const newDir: "long" | "short" = prevDir === 1 ? "long" : "short";

        // Volume proxy filter: skip low-range bars
        if (!rangeAboveAvg(cs, i)) continue;

        const curATR = atr[i] || atr[i - 1];
        let slDist = curATR * ST_SL_ATR_MULT;
        const maxDist = bar.o * ST_SL_MAX_PCT;
        if (slDist > maxDist) slDist = maxDist;
        const sl = newDir === "long" ? bar.o - slDist : bar.o + slDist;

        pos = { dir: newDir, ep: bar.o, et: bar.t, sl, entryIdx: i };
      }
    }

    // Close open position at end
    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = cs[cs.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ─── Metrics ────────────────────────────────────────────────────────
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
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.reduce((s, r) => s + r, 0) / Math.max(returns.length, 1);
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = (endTs - startTs) / D;

  return {
    n: trades.length,
    wr: trades.length > 0 ? wins.length / trades.length * 100 : 0,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

// ─── Formatting ─────────────────────────────────────────────────────
function fmtPnl(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function printMetrics(label: string, m: Metrics): void {
  console.log(
    `  ${label.padEnd(35)} `
    + `N=${String(m.n).padStart(4)}  `
    + `WR=${m.wr.toFixed(1).padStart(5)}%  `
    + `PF=${(m.pf === Infinity ? " Inf" : m.pf.toFixed(2)).padStart(5)}  `
    + `PnL=${fmtPnl(m.total).padStart(9)}  `
    + `$/d=${fmtPnl(m.perDay).padStart(7)}  `
    + `Sharpe=${m.sharpe.toFixed(2).padStart(6)}  `
    + `DD=$${m.dd.toFixed(0).padStart(4)}`
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════
console.log("=".repeat(85));
console.log("  SUPERTREND(14, 1.75) NEW PAIRS TEST");
console.log("  1h candles -> 4h | ATR SL 3x (capped 3.5%) | 48h stag | range filter");
console.log("  Cost: 0.035% taker, spread map (4e-4 default), 1.5x SL slip, 10x lev, $3 margin");
console.log("=".repeat(85));

// Discover all pairs from cache
const cacheFiles = fs.readdirSync(CACHE_1H).filter(f => f.endsWith(".json"));
const allPairsRaw = cacheFiles.map(f => f.replace("USDT.json", "").replace("k", ""));
// Also keep track of k-prefixed pairs
const kPrefixed = new Set(cacheFiles.filter(f => f.startsWith("k")).map(f => f.replace("USDT.json", "").replace("k", "")));

// Load all pairs
console.log("\nLoading data...");
const h4Data = new Map<string, C[]>();
const pairBarCounts = new Map<string, { h1: number; h4: number }>();

// Get unique pair names
const allPairsSet = new Set<string>();
for (const f of cacheFiles) {
  let pair = f.replace("USDT.json", "");
  if (pair.startsWith("k")) pair = pair.substring(1);
  allPairsSet.add(pair);
}
const allPairs = [...allPairsSet].sort();

for (const pair of allPairs) {
  const h1 = load1h(pair);
  if (h1.length < 200) {
    console.log(`  SKIP ${pair} (${h1.length} bars, need 200+)`);
    continue;
  }
  const h4 = aggregateTo4h(h1);
  h4Data.set(pair, h4);
  pairBarCounts.set(pair, { h1: h1.length, h4: h4.length });
  console.log(`  ${pair.padEnd(12)} ${h1.length} 1h -> ${h4.length} 4h`);
}

const loadedPairs = [...h4Data.keys()];
const currentLoaded = CURRENT_PAIRS.filter(p => h4Data.has(p));
const newPairs = loadedPairs.filter(p => !CURRENT_PAIRS.includes(p) && p !== "BTC");
const allTradeable = loadedPairs.filter(p => p !== "BTC");

console.log(`\nLoaded: ${loadedPairs.length} pairs`);
console.log(`Current 18: ${currentLoaded.length} loaded (${currentLoaded.join(", ")})`);
console.log(`New candidates: ${newPairs.length} (${newPairs.join(", ")})`);

const oosDays = (OOS_END - OOS_START) / D;
console.log(`\nOOS period: 2025-09-01 to 2026-03-26 (${oosDays.toFixed(0)} days)`);

// ═══════════════════════════════════════════════════════════════════
//  SECTION 1: Current 18 pairs OOS
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(85));
console.log("  SECTION 1: CURRENT 18 PAIRS (OOS)");
console.log("=".repeat(85));

const currentTrades = runSupertrend(currentLoaded, h4Data, OOS_START, OOS_END);
const currentMetrics = calcMetrics(currentTrades, OOS_START, OOS_END);
printMetrics("Current 18 pairs", currentMetrics);

// Per-pair breakdown for current set
console.log("\n  Per-pair (current set):");
console.log("  " + "-".repeat(75));
console.log("  " + "Pair".padEnd(10) + "Trades".padStart(7) + "  WR%".padStart(6) + "  PF".padStart(6) + "     PnL".padStart(10) + "  $/day".padStart(8));
console.log("  " + "-".repeat(75));

for (const pair of currentLoaded.sort()) {
  const pt = currentTrades.filter(t => t.pair === pair);
  if (pt.length === 0) {
    console.log("  " + pair.padEnd(10) + "      0    -      -          -       -");
    continue;
  }
  const m = calcMetrics(pt, OOS_START, OOS_END);
  console.log(
    "  " + pair.padEnd(10)
    + String(m.n).padStart(7) + "  "
    + m.wr.toFixed(1).padStart(5) + "  "
    + (m.pf === Infinity ? "  Inf" : m.pf.toFixed(2).padStart(5)) + "  "
    + fmtPnl(m.total).padStart(9) + "  "
    + fmtPnl(m.perDay).padStart(7)
  );
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION 2: ALL pairs OOS
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(85));
console.log("  SECTION 2: ALL " + allTradeable.length + " PAIRS (OOS)");
console.log("=".repeat(85));

const allTrades = runSupertrend(allTradeable, h4Data, OOS_START, OOS_END);
const allMetrics = calcMetrics(allTrades, OOS_START, OOS_END);
printMetrics(`All ${allTradeable.length} pairs`, allMetrics);

// ═══════════════════════════════════════════════════════════════════
//  SECTION 3: NEW PAIRS INDIVIDUAL BREAKDOWN
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(85));
console.log("  SECTION 3: NEW PAIR CANDIDATES (individual OOS)");
console.log("=".repeat(85));
console.log("\n  " + "Pair".padEnd(12) + "4h bars".padStart(8) + "  Trades".padStart(8) + "  WR%".padStart(6) + "    PF".padStart(6) + "     PnL".padStart(10) + "  $/day".padStart(8) + "  MaxDD".padStart(7) + "  Verdict");
console.log("  " + "-".repeat(85));

interface PairResult {
  pair: string;
  m: Metrics;
  verdict: string;
}

const pairResults: PairResult[] = [];

for (const pair of newPairs.sort()) {
  const cs = h4Data.get(pair);
  const h4Count = cs?.length ?? 0;
  const pt = allTrades.filter(t => t.pair === pair);

  if (pt.length === 0) {
    console.log("  " + pair.padEnd(12) + String(h4Count).padStart(8) + "        0    -      -          -       -       -   SKIP (no trades)");
    pairResults.push({ pair, m: { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 }, verdict: "SKIP" });
    continue;
  }

  const m = calcMetrics(pt, OOS_START, OOS_END);
  let verdict = "SKIP";
  if (m.pf > 1.2 && m.perDay > 0) verdict = "ADD";
  else if (m.pf > 1.0 && m.perDay > 0) verdict = "MAYBE";
  else if (m.total > 0) verdict = "WEAK";

  pairResults.push({ pair, m, verdict });

  console.log(
    "  " + pair.padEnd(12)
    + String(h4Count).padStart(8)
    + String(m.n).padStart(8) + "  "
    + m.wr.toFixed(1).padStart(5) + "  "
    + (m.pf === Infinity ? "  Inf" : m.pf.toFixed(2).padStart(5)) + "  "
    + fmtPnl(m.total).padStart(9) + "  "
    + fmtPnl(m.perDay).padStart(7) + "  "
    + ("$" + m.dd.toFixed(0)).padStart(6) + "  "
    + verdict
  );
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION 4: COMPARISON SUMMARY
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(85));
console.log("  SECTION 4: COMPARISON SUMMARY");
console.log("=".repeat(85));

const addPairs = pairResults.filter(p => p.verdict === "ADD");
const maybePairs = pairResults.filter(p => p.verdict === "MAYBE");

console.log("\n  Recommended ADD (PF > 1.2 and positive $/day):");
if (addPairs.length === 0) {
  console.log("    (none)");
} else {
  for (const p of addPairs.sort((a, b) => b.m.perDay - a.m.perDay)) {
    console.log(`    ${p.pair.padEnd(10)} PF=${p.m.pf.toFixed(2)}  $/d=${fmtPnl(p.m.perDay)}  WR=${p.m.wr.toFixed(1)}%  N=${p.m.n}`);
  }
}

console.log("\n  Maybe (PF > 1.0 but < 1.2):");
if (maybePairs.length === 0) {
  console.log("    (none)");
} else {
  for (const p of maybePairs.sort((a, b) => b.m.perDay - a.m.perDay)) {
    console.log(`    ${p.pair.padEnd(10)} PF=${p.m.pf.toFixed(2)}  $/d=${fmtPnl(p.m.perDay)}  WR=${p.m.wr.toFixed(1)}%  N=${p.m.n}`);
  }
}

// Build proposed new set
const proposedNew = [...currentLoaded, ...addPairs.map(p => p.pair)];
if (addPairs.length > 0) {
  const proposedTrades = runSupertrend(proposedNew, h4Data, OOS_START, OOS_END);
  const proposedMetrics = calcMetrics(proposedTrades, OOS_START, OOS_END);

  console.log("\n  Ensemble comparison:");
  printMetrics(`Current (${currentLoaded.length} pairs)`, currentMetrics);
  printMetrics(`Proposed (${proposedNew.length} pairs)`, proposedMetrics);

  const deltaPerDay = proposedMetrics.perDay - currentMetrics.perDay;
  const deltaPF = proposedMetrics.pf - currentMetrics.pf;
  console.log(`\n  Delta: $/day ${fmtPnl(deltaPerDay)}, PF ${deltaPF >= 0 ? "+" : ""}${deltaPF.toFixed(2)}`);
  console.log(`  Proposed set: ${proposedNew.join(", ")}`);
} else {
  console.log("\n  No new pairs meet the ADD criteria. Current set is optimal.");
}

// Exit breakdown
console.log("\n  Exit reasons (current set):");
const exitReasons = new Map<string, number>();
for (const t of currentTrades) {
  exitReasons.set(t.reason, (exitReasons.get(t.reason) ?? 0) + 1);
}
for (const [reason, count] of [...exitReasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${reason.padEnd(8)} ${count}`);
}

console.log("\n  Exit reasons (all pairs):");
const exitReasonsAll = new Map<string, number>();
for (const t of allTrades) {
  exitReasonsAll.set(t.reason, (exitReasonsAll.get(t.reason) ?? 0) + 1);
}
for (const [reason, count] of [...exitReasonsAll.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${reason.padEnd(8)} ${count}`);
}

console.log("\n" + "=".repeat(85));
console.log("  DONE");
console.log("=".repeat(85));
