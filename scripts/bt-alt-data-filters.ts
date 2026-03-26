/**
 * Alternative Data Filters on Supertrend(14, 1.75)
 *
 * Tests simulated Fear/Greed regime gate + Funding Rate extreme filter
 * as overlays on the base Supertrend engine with volume filter.
 *
 * Filters:
 * 0. Baseline: Supertrend(14,1.75) + volume filter (no alt data)
 * 1A. Fear/Greed Contrarian: Fear -> longs only, Greed -> shorts only
 * 1B. Fear/Greed Trend-Aligned: Fear -> shorts only, Greed -> longs only
 * 2.  Funding Rate Extreme: skip longs when funding >99pct, skip shorts <1pct
 * 3A. Combined Contrarian F/G + Funding
 * 3B. Combined Trend-Aligned F/G + Funding
 *
 * Fear/Greed proxy: BTC 30-day return + 30-day realized vol
 *   Fear  = BTC 30d return < -10%
 *   Greed = BTC 30d return > +15%
 *   Neutral = between
 *
 * Funding: real Hyperliquid hourly data from /tmp/hl-funding/
 *
 * Data: 5m candles from /tmp/bt-pair-cache-5m/, aggregated to 4h.
 * Full: 2023-01 to 2026-03 | OOS: 2025-09-01
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const FUNDING_DIR = "/tmp/hl-funding";
const LEV = 10;
const SIZE = 3; // $3 margin
const NOT = SIZE * LEV; // $30 notional
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const HOUR = 3600000;

const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-26").getTime();
const FULL_START = new Date("2023-01-01").getTime();

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}
interface FundingEntry { coin: string; fundingRate: string; premium: string; time: number; }

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t ?? +b[0], o: +b.o ?? +b[1], h: +b.h ?? +b[2],
    l: +b.l ?? +b[3], c: +b.c ?? +b[4], v: +(b.v ?? b[5] ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles: C[]): C[] {
  const barsPerGroup = 48; // 48 x 5m = 4h
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
      v: group.reduce((s, g) => s + g.v, 0),
    });
  }
  return result;
}

function loadFunding(pair: string): { time: number; rate: number }[] {
  const fp = path.join(FUNDING_DIR, `${pair}_funding.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as FundingEntry[];
  return raw.map(e => ({ time: e.time, rate: parseFloat(e.fundingRate) }))
    .sort((a, b) => a.time - b.time);
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c),
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(
          cs[j].h - cs[j].l,
          Math.abs(cs[j].h - cs[j - 1].c),
          Math.abs(cs[j].l - cs[j - 1].c),
        );
      }
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
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period;
      init = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);

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

// ─── Cost / PnL ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long" | "short", isSL: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE_TAKER * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
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
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = (endTs - startTs) / DAY;
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

function fmtMetrics(m: Metrics): string {
  return `N=${m.n}  WR=${m.wr.toFixed(1)}%  PF=${m.pf.toFixed(2)}  Sharpe=${m.sharpe.toFixed(2)}  $/day=${m.perDay.toFixed(2)}  Total=$${m.total.toFixed(2)}  MaxDD=$${m.dd.toFixed(2)}`;
}

// ─── Fear/Greed Regime from BTC ─────────────────────────────────────
type Regime = "fear" | "greed" | "neutral";

interface RegimeData {
  /** Map from 4h bar timestamp -> regime */
  regimeAt: Map<number, Regime>;
}

function buildBTCRegime(btc4h: C[]): RegimeData {
  // We need ~30 days of 4h bars = 180 bars
  const LOOKBACK_BARS = 180; // 30 days * 6 bars/day
  const regimeAt = new Map<number, Regime>();

  for (let i = LOOKBACK_BARS; i < btc4h.length; i++) {
    // 30-day return
    const ret30d = (btc4h[i].c - btc4h[i - LOOKBACK_BARS].c) / btc4h[i - LOOKBACK_BARS].c;

    let regime: Regime = "neutral";
    if (ret30d < -0.10) regime = "fear";
    else if (ret30d > 0.15) regime = "greed";

    regimeAt.set(btc4h[i].t, regime);
  }

  return { regimeAt };
}

function getRegimeAtTime(regimeData: RegimeData, btc4h: C[], t: number): Regime {
  // Find closest BTC 4h bar <= t
  const exact = regimeData.regimeAt.get(t);
  if (exact) return exact;

  // Binary search for closest bar
  let lo = 0, hi = btc4h.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (btc4h[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return regimeData.regimeAt.get(btc4h[lo].t) ?? "neutral";
}

// ─── Funding Rate Data ──────────────────────────────────────────────
interface FundingIndex {
  /** For each pair: sorted array of {time, rate} */
  data: Map<string, { time: number; rate: number }[]>;
}

function buildFundingIndex(): FundingIndex {
  const data = new Map<string, { time: number; rate: number }[]>();
  for (const pair of PAIRS) {
    const fr = loadFunding(pair);
    if (fr.length > 0) data.set(pair, fr);
  }
  return { data };
}

/**
 * Get 7-day average funding rate for a pair at a given timestamp.
 * Also returns the 60-day percentile of that 7d avg.
 */
function getFundingStats(
  fundingIdx: FundingIndex,
  pair: string,
  t: number,
): { avg7d: number; pct60d: number } | null {
  const rates = fundingIdx.data.get(pair);
  if (!rates || rates.length === 0) return null;

  // Find all funding entries in [t - 7d, t]
  const t7d = t - 7 * DAY;
  const t60d = t - 60 * DAY;

  // Collect rates in 7d window
  const recent7d: number[] = [];
  const recent60d: number[] = [];

  // Use binary search to find start index for 60d window
  let startIdx = 0;
  {
    let lo = 0, hi = rates.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rates[mid].time < t60d) lo = mid + 1;
      else hi = mid;
    }
    startIdx = lo;
  }

  for (let i = startIdx; i < rates.length && rates[i].time <= t; i++) {
    if (rates[i].time >= t7d) recent7d.push(rates[i].rate);
    recent60d.push(rates[i].rate);
  }

  if (recent7d.length < 10 || recent60d.length < 100) return null;

  const avg7d = recent7d.reduce((s, r) => s + r, 0) / recent7d.length;

  // Compute 7d averages over the 60d window (rolling, weekly steps)
  const weeklyAvgs: number[] = [];
  const WEEK = 7 * DAY;
  for (let wEnd = t60d + WEEK; wEnd <= t; wEnd += HOUR * 8) {
    const wStart = wEnd - WEEK;
    const wRates = recent60d.filter((_, idx) => {
      const rt = rates[startIdx + idx]?.time;
      return rt !== undefined && rt >= wStart && rt <= wEnd;
    });
    if (wRates.length >= 10) {
      weeklyAvgs.push(wRates.reduce((s, r) => s + r, 0) / wRates.length);
    }
  }

  if (weeklyAvgs.length < 5) return null;

  // Percentile of current avg7d within the 60d distribution
  const sorted = [...weeklyAvgs].sort((a, b) => a - b);
  let rank = 0;
  for (const v of sorted) {
    if (v <= avg7d) rank++;
  }
  const pct60d = rank / sorted.length;

  return { avg7d, pct60d };
}

// ─── Strategy Runner ────────────────────────────────────────────────
interface FilterConfig {
  name: string;
  fearGreed?: "contrarian" | "trend-aligned";
  fundingExtreme?: boolean;
}

function runStrategy(
  pairData: Map<string, { cs4h: C[]; stDir: number[]; atr: number[]; vol20: number[] }>,
  btcRegime: RegimeData,
  btc4h: C[],
  fundingIdx: FundingIndex,
  filter: FilterConfig,
  startTs: number,
  endTs: number,
): Tr[] {
  const trades: Tr[] = [];

  for (const pair of PAIRS) {
    const pd = pairData.get(pair);
    if (!pd) continue;
    const { cs4h, stDir, atr, vol20 } = pd;

    let pos: {
      dir: "long" | "short"; ep: number; et: number;
      sl: number; peak: number; trailActive: boolean;
    } | null = null;

    for (let i = 15; i < cs4h.length; i++) {
      if (cs4h[i].t > endTs && !pos) continue;

      const prevDir = stDir[i - 1];
      const prevPrevDir = i >= 2 ? stDir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // Manage open position
      if (pos) {
        const bar = cs4h[i];
        const curATR = atr[i - 1] || atr[i - 2] || 0;

        // Update peak
        if (pos.dir === "long") pos.peak = Math.max(pos.peak, bar.h);
        else pos.peak = Math.min(pos.peak, bar.l);

        let xp = 0, reason = "";

        // Fixed SL check
        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl;
          reason = "sl";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl;
          reason = "sl";
        }

        // Supertrend flip exit
        if (!xp && flipped) {
          xp = bar.o;
          reason = "flip";
        }

        // 48h stagnation
        if (!xp && (bar.t - pos.et) > 48 * HOUR) {
          xp = bar.c;
          reason = "stagnation";
        }

        if (xp > 0) {
          const isSL = reason === "sl";
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, isSL);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason });
          }
          pos = null;
        }
      }

      // Entry
      if (!pos && flipped && cs4h[i].t >= startTs && cs4h[i].t < endTs) {
        const newDir: "long" | "short" = prevDir === 1 ? "long" : "short";

        // Volume filter: bar vol > 1.5x 20-bar avg
        const curVol = cs4h[i - 1]?.v ?? 0;
        const avgVol = vol20[i - 1] || 0;
        if (avgVol <= 0 || curVol < 1.5 * avgVol) continue;

        // Fear/Greed filter
        if (filter.fearGreed) {
          const regime = getRegimeAtTime(btcRegime, btc4h, cs4h[i].t);
          if (filter.fearGreed === "contrarian") {
            // Fear = contrarian buy signal -> allow longs only
            // Greed = contrarian sell signal -> allow shorts only
            if (regime === "fear" && newDir === "short") continue;
            if (regime === "greed" && newDir === "long") continue;
          } else {
            // Trend-aligned: Fear = bearish -> shorts only
            //                Greed = bullish -> longs only
            if (regime === "fear" && newDir === "long") continue;
            if (regime === "greed" && newDir === "short") continue;
          }
        }

        // Funding extreme filter
        if (filter.fundingExtreme) {
          const fStats = getFundingStats(fundingIdx, pair, cs4h[i].t);
          if (fStats) {
            // >99th percentile funding -> skip longs (overcrowded longs)
            if (fStats.pct60d > 0.99 && newDir === "long") continue;
            // <1st percentile funding -> skip shorts (overcrowded shorts)
            if (fStats.pct60d < 0.01 && newDir === "short") continue;
          }
        }

        const ep = cs4h[i].o;
        const curATR = atr[i - 1] || atr[i - 2] || 0;
        const slDist = Math.min(3 * curATR, ep * 0.035);
        const sl = newDir === "long" ? ep - slDist : ep + slDist;

        pos = { dir: newDir, ep, et: cs4h[i].t, sl, peak: ep, trailActive: false };
      }
    }

    // Close open position at end
    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = cs4h[cs4h.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=== Alt Data Filters on Supertrend(14, 1.75) ===");
console.log(`Pairs: ${PAIRS.join(", ")}`);
console.log(`Full: 2023-01 to 2026-03 | OOS: 2025-09-01`);
console.log(`Notional: $${NOT} (${LEV}x, $${SIZE} margin)`);
console.log();

// Load and aggregate data
console.log("Loading 5m data and aggregating to 4h...");

const pairData = new Map<string, { cs4h: C[]; stDir: number[]; atr: number[]; vol20: number[] }>();

for (const pair of PAIRS) {
  const raw5m = load5m(pair);
  if (raw5m.length < 1000) { console.log(`  SKIP ${pair}: only ${raw5m.length} 5m bars`); continue; }
  const cs4h = aggregateTo4h(raw5m);
  if (cs4h.length < 100) { console.log(`  SKIP ${pair}: only ${cs4h.length} 4h bars`); continue; }

  const { dir } = calcSupertrend(cs4h, 14, 1.75);
  const atr = calcATR(cs4h, 14);

  // 20-bar volume moving average
  const vol20 = new Array(cs4h.length).fill(0);
  for (let i = 20; i < cs4h.length; i++) {
    let s = 0;
    for (let j = i - 20; j < i; j++) s += (cs4h[j].v ?? 0);
    vol20[i] = s / 20;
  }

  pairData.set(pair, { cs4h, stDir: dir, atr, vol20 });
  console.log(`  ${pair}: ${cs4h.length} 4h bars`);
}

// Load BTC data for Fear/Greed
console.log("\nBuilding BTC Fear/Greed regime...");
const btcRaw = load5m("BTC");
const btc4h = aggregateTo4h(btcRaw);
const btcRegime = buildBTCRegime(btc4h);
console.log(`  BTC: ${btc4h.length} 4h bars`);

// Count regimes
let fearCount = 0, greedCount = 0, neutralCount = 0;
for (const [, regime] of btcRegime.regimeAt) {
  if (regime === "fear") fearCount++;
  else if (regime === "greed") greedCount++;
  else neutralCount++;
}
const totalRegime = fearCount + greedCount + neutralCount;
console.log(`  Fear: ${fearCount} bars (${(fearCount / totalRegime * 100).toFixed(1)}%)`);
console.log(`  Greed: ${greedCount} bars (${(greedCount / totalRegime * 100).toFixed(1)}%)`);
console.log(`  Neutral: ${neutralCount} bars (${(neutralCount / totalRegime * 100).toFixed(1)}%)`);

// Load funding data
console.log("\nLoading Hyperliquid funding data...");
const fundingIdx = buildFundingIndex();
for (const [pair, rates] of fundingIdx.data) {
  console.log(`  ${pair}: ${rates.length} hourly entries`);
}

// Define filter configs
const FILTERS: FilterConfig[] = [
  { name: "0. Baseline (ST + Vol)" },
  { name: "1A. F/G Contrarian", fearGreed: "contrarian" },
  { name: "1B. F/G Trend-Aligned", fearGreed: "trend-aligned" },
  { name: "2. Funding Extreme", fundingExtreme: true },
  { name: "3A. Combined Contrarian", fearGreed: "contrarian", fundingExtreme: true },
  { name: "3B. Combined Trend-Aligned", fearGreed: "trend-aligned", fundingExtreme: true },
];

// Run all strategies
console.log("\n" + "=".repeat(90));
console.log("RESULTS");
console.log("=".repeat(90));

const allResults: { name: string; oos: Metrics; full: Metrics; oosTrades: Tr[] }[] = [];

for (const filter of FILTERS) {
  const trades = runStrategy(pairData, btcRegime, btc4h, fundingIdx, filter, FULL_START, OOS_END);
  const oosTrades = trades.filter(t => t.et >= OOS_START);
  const fullTrades = trades;

  const oosM = calcMetrics(oosTrades, OOS_START, OOS_END);
  const fullM = calcMetrics(fullTrades, FULL_START, OOS_END);

  allResults.push({ name: filter.name, oos: oosM, full: fullM, oosTrades });
}

// Print results table
console.log("\n--- OOS Results (2025-09-01 to 2026-03-26) ---\n");
console.log(
  "Strategy".padEnd(32) +
  "Trades".padStart(7) +
  "WR%".padStart(8) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(8) +
  "Total$".padStart(9) +
  "MaxDD$".padStart(9),
);
console.log("-".repeat(88));

for (const r of allResults) {
  const m = r.oos;
  console.log(
    r.name.padEnd(32) +
    String(m.n).padStart(7) +
    m.wr.toFixed(1).padStart(8) +
    m.pf.toFixed(2).padStart(7) +
    m.sharpe.toFixed(2).padStart(8) +
    m.perDay.toFixed(2).padStart(8) +
    m.total.toFixed(2).padStart(9) +
    m.dd.toFixed(2).padStart(9),
  );
}

console.log("\n--- Full Period Results (2023-01 to 2026-03) ---\n");
console.log(
  "Strategy".padEnd(32) +
  "Trades".padStart(7) +
  "WR%".padStart(8) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(8) +
  "Total$".padStart(9) +
  "MaxDD$".padStart(9),
);
console.log("-".repeat(88));

for (const r of allResults) {
  const m = r.full;
  console.log(
    r.name.padEnd(32) +
    String(m.n).padStart(7) +
    m.wr.toFixed(1).padStart(8) +
    m.pf.toFixed(2).padStart(7) +
    m.sharpe.toFixed(2).padStart(8) +
    m.perDay.toFixed(2).padStart(8) +
    m.total.toFixed(2).padStart(9) +
    m.dd.toFixed(2).padStart(9),
  );
}

// Delta analysis: compare each filter to baseline
const baseline = allResults[0];
console.log("\n--- OOS Delta vs Baseline ---\n");
console.log(
  "Strategy".padEnd(32) +
  "dTrades".padStart(8) +
  "dWR%".padStart(8) +
  "dPF".padStart(8) +
  "dSharpe".padStart(9) +
  "d$/day".padStart(9) +
  "dMaxDD$".padStart(9),
);
console.log("-".repeat(83));

for (let i = 1; i < allResults.length; i++) {
  const r = allResults[i];
  const bm = baseline.oos;
  const m = r.oos;
  const dN = m.n - bm.n;
  const dWR = m.wr - bm.wr;
  const dPF = m.pf - bm.pf;
  const dSharpe = m.sharpe - bm.sharpe;
  const dPerDay = m.perDay - bm.perDay;
  const dDD = m.dd - bm.dd; // negative is better

  const sign = (v: number) => v >= 0 ? "+" : "";
  console.log(
    r.name.padEnd(32) +
    (sign(dN) + dN).padStart(8) +
    (sign(dWR) + dWR.toFixed(1)).padStart(8) +
    (sign(dPF) + dPF.toFixed(2)).padStart(8) +
    (sign(dSharpe) + dSharpe.toFixed(2)).padStart(9) +
    (sign(dPerDay) + dPerDay.toFixed(2)).padStart(9) +
    (sign(dDD) + dDD.toFixed(2)).padStart(9),
  );
}

// Long/Short breakdown for OOS
console.log("\n--- OOS Long/Short Split ---\n");
for (const r of allResults) {
  const longs = r.oosTrades.filter(t => t.dir === "long");
  const shorts = r.oosTrades.filter(t => t.dir === "short");
  const lm = calcMetrics(longs, OOS_START, OOS_END);
  const sm = calcMetrics(shorts, OOS_START, OOS_END);
  console.log(`${r.name}:`);
  console.log(`  Longs:  ${fmtMetrics(lm)}`);
  console.log(`  Shorts: ${fmtMetrics(sm)}`);
}

// Regime breakdown for Fear/Greed
console.log("\n--- OOS Regime Breakdown (Baseline trades split by regime at entry) ---\n");
{
  const baselineTrades = allResults[0].oosTrades;
  const byRegime: Record<Regime, Tr[]> = { fear: [], greed: [], neutral: [] };
  for (const t of baselineTrades) {
    const regime = getRegimeAtTime(btcRegime, btc4h, t.et);
    byRegime[regime].push(t);
  }
  for (const regime of ["fear", "greed", "neutral"] as Regime[]) {
    const m = calcMetrics(byRegime[regime], OOS_START, OOS_END);
    console.log(`  ${regime.toUpperCase().padEnd(8)}: ${fmtMetrics(m)}`);
  }
}

// Funding extreme stats
console.log("\n--- OOS Funding Extreme Stats ---\n");
{
  const baselineTrades = allResults[0].oosTrades;
  let blockedLong = 0, blockedShort = 0;
  for (const t of baselineTrades) {
    const fStats = getFundingStats(fundingIdx, t.pair, t.et);
    if (!fStats) continue;
    if (fStats.pct60d > 0.99 && t.dir === "long") blockedLong++;
    if (fStats.pct60d < 0.01 && t.dir === "short") blockedShort++;
  }
  console.log(`  Would-be-blocked longs (funding >99pct): ${blockedLong}`);
  console.log(`  Would-be-blocked shorts (funding <1pct): ${blockedShort}`);

  // Show avg PnL of blocked vs allowed
  const blocked: Tr[] = [];
  const allowed: Tr[] = [];
  for (const t of baselineTrades) {
    const fStats = getFundingStats(fundingIdx, t.pair, t.et);
    if (!fStats) { allowed.push(t); continue; }
    if ((fStats.pct60d > 0.99 && t.dir === "long") || (fStats.pct60d < 0.01 && t.dir === "short")) {
      blocked.push(t);
    } else {
      allowed.push(t);
    }
  }
  if (blocked.length > 0) {
    const avgBlocked = blocked.reduce((s, t) => s + t.pnl, 0) / blocked.length;
    console.log(`  Avg PnL of blocked trades: $${avgBlocked.toFixed(3)} (n=${blocked.length})`);
  }
  if (allowed.length > 0) {
    const avgAllowed = allowed.reduce((s, t) => s + t.pnl, 0) / allowed.length;
    console.log(`  Avg PnL of allowed trades: $${avgAllowed.toFixed(3)} (n=${allowed.length})`);
  }
}

// Per-pair OOS for best filter
console.log("\n--- Per-Pair OOS (Best Filter vs Baseline) ---\n");
{
  // Find best OOS filter by $/day
  let bestIdx = 0;
  for (let i = 1; i < allResults.length; i++) {
    if (allResults[i].oos.perDay > allResults[bestIdx].oos.perDay) bestIdx = i;
  }
  const best = allResults[bestIdx];
  const base = allResults[0];

  console.log(`Best filter: ${best.name}`);
  console.log();
  console.log(
    "Pair".padEnd(8) +
    "Base N".padStart(7) +
    "Base $/d".padStart(9) +
    "Filt N".padStart(7) +
    "Filt $/d".padStart(9) +
    "Delta".padStart(8),
  );
  console.log("-".repeat(48));

  for (const pair of PAIRS) {
    const baseTr = base.oosTrades.filter(t => t.pair === pair);
    const filtTr = best.oosTrades.filter(t => t.pair === pair);
    const days = (OOS_END - OOS_START) / DAY;
    const basePerDay = baseTr.reduce((s, t) => s + t.pnl, 0) / days;
    const filtPerDay = filtTr.reduce((s, t) => s + t.pnl, 0) / days;
    const delta = filtPerDay - basePerDay;
    console.log(
      pair.padEnd(8) +
      String(baseTr.length).padStart(7) +
      basePerDay.toFixed(3).padStart(9) +
      String(filtTr.length).padStart(7) +
      filtPerDay.toFixed(3).padStart(9) +
      (delta >= 0 ? "+" : "") + delta.toFixed(3).padStart(7),
    );
  }
}

console.log("\nDone.");
