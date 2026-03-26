/**
 * Liquidation Level Mapper Backtest
 *
 * DIY liquidation cluster estimation from volume profile + leverage assumptions.
 *
 * Approach:
 * 1. Build 4h volume profile over trailing 7-day window (42 bars)
 * 2. Divide price range into 20 bins, find top-3 volume clusters (entry zones)
 * 3. Estimate liquidation levels at 10x, 20x, 50x leverage offsets
 * 4. When price approaches dense liquidation cluster within 2%:
 *    - Approaching long liq from above -> short (cascade)
 *    - Approaching short liq from below -> long (squeeze)
 * 5. SL 2%, hold max 24h
 *
 * Uses 5m candle data from /tmp/bt-pair-cache-5m/, aggregated to 4h.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-liquidation-map.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const DAY = 86_400_000;
const H = 3_600_000;
const H4 = 4 * H;
const FEE = 0.000_35; // 0.035% taker per side
const SIZE = 5;
const LEV = 10;
const NOT = SIZE * LEV; // $50 notional
const SL_SLIP = 1.5;
const SL_PCT = 0.02; // 2% stop loss
const MAX_HOLD_BARS = 6; // 6 x 4h = 24h
const APPROACH_PCT = 0.02; // within 2% of liq cluster
const VP_LOOKBACK = 42; // 7 days of 4h bars
const VP_BINS = 20;
const TOP_CLUSTERS = 3;

// Leverage assumptions for liquidation offset
// At Nx leverage, liquidation is ~(1/N) from entry (for longs below, shorts above)
const LEVERAGE_TIERS = [10, 20, 50] as const;
// Corresponding offsets: 10%, 5%, 2%
const LIQ_OFFSETS = LEVERAGE_TIERS.map(l => 1 / l);

// Weight distribution across leverage tiers (most traders use 10-25x)
const LIQ_WEIGHTS = [0.5, 0.35, 0.15]; // 10x heaviest, 50x lightest

const SPREAD: Record<string, number> = {
  ETH: 1.5e-4, SOL: 2.0e-4, DOGE: 1.35e-4, XRP: 1.05e-4,
  LINK: 3.45e-4, DOT: 4.95e-4, ADA: 5.55e-4, ARB: 2.6e-4,
  WLD: 4e-4, APT: 3.2e-4,
};

const PAIRS = ["ETH", "SOL", "DOGE", "XRP", "LINK", "DOT", "ADA", "ARB", "WLD", "APT"];

const FULL_START = new Date("2023-01-01").getTime();
const OOS_START = new Date("2025-09-01").getTime();
const END = new Date("2026-03-26").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}
interface Stats {
  n: number; wr: number; pf: number; sharpe: number;
  pnl: number; perDay: number; maxDd: number;
}

interface VolumeProfileBin {
  lo: number;
  hi: number;
  mid: number;
  vol: number;
}

interface LiqCluster {
  entryPrice: number; // center of high-volume bin
  longLiqs: number[]; // estimated long liquidation levels per leverage tier
  shortLiqs: number[]; // estimated short liquidation levels per leverage tier
  weight: number; // volume weight of this cluster
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0,
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregate4h(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const bucket = Math.floor(c.t / H4) * H4;
    const arr = groups.get(bucket) ?? [];
    arr.push(c);
    groups.set(bucket, arr);
  }
  const result: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 40) continue; // need enough 5m bars
    bars.sort((a, b) => a.t - b.t);
    result.push({
      t: ts, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, b) => s + b.v, 0),
    });
  }
  return result;
}

// ─── Volume Profile ─────────────────────────────────────────────────
function buildVolumeProfile(bars: C[], endIdx: number, lookback: number): VolumeProfileBin[] {
  const startIdx = Math.max(0, endIdx - lookback);
  const window = bars.slice(startIdx, endIdx);
  if (window.length < 10) return [];

  let pxHi = -Infinity;
  let pxLo = Infinity;
  for (const b of window) {
    if (b.h > pxHi) pxHi = b.h;
    if (b.l < pxLo) pxLo = b.l;
  }

  if (pxHi <= pxLo || pxLo <= 0) return [];

  const binSize = (pxHi - pxLo) / VP_BINS;
  const bins: VolumeProfileBin[] = [];
  for (let i = 0; i < VP_BINS; i++) {
    const lo = pxLo + i * binSize;
    const hi = lo + binSize;
    bins.push({ lo, hi, mid: (lo + hi) / 2, vol: 0 });
  }

  // Distribute each bar's volume across bins it spans
  for (const b of window) {
    const barVol = b.v;
    if (barVol <= 0) continue;
    // Find which bins this bar overlaps
    const binsHit: number[] = [];
    for (let i = 0; i < VP_BINS; i++) {
      const overlap = Math.min(b.h, bins[i].hi) - Math.max(b.l, bins[i].lo);
      if (overlap > 0) binsHit.push(i);
    }
    if (binsHit.length === 0) continue;
    const volPerBin = barVol / binsHit.length;
    for (const bi of binsHit) {
      bins[bi].vol += volPerBin;
    }
  }

  return bins;
}

function getTopClusters(bins: VolumeProfileBin[], topN: number): VolumeProfileBin[] {
  const sorted = [...bins].sort((a, b) => b.vol - a.vol);
  return sorted.slice(0, topN);
}

// ─── Liquidation Level Estimation ───────────────────────────────────
function estimateLiqClusters(topBins: VolumeProfileBin[]): LiqCluster[] {
  return topBins.map(bin => {
    const ep = bin.mid;
    return {
      entryPrice: ep,
      longLiqs: LIQ_OFFSETS.map(off => ep * (1 - off)), // longs liquidate below
      shortLiqs: LIQ_OFFSETS.map(off => ep * (1 + off)), // shorts liquidate above
      weight: bin.vol,
    };
  });
}

// ─── Signal Detection ───────────────────────────────────────────────
// Returns signal: "long" if price approaching short squeeze zone from below,
//                 "short" if price approaching long cascade zone from above,
//                 null if no signal
function detectLiqSignal(
  price: number,
  clusters: LiqCluster[],
  approachPct: number,
): "long" | "short" | null {
  // Compute weighted liquidation density at various levels
  // For each cluster, check if current price is near any liquidation level

  let longScore = 0; // approaching short-liq zones from below -> long (squeeze)
  let shortScore = 0; // approaching long-liq zones from above -> short (cascade)

  for (const cluster of clusters) {
    const w = cluster.weight;

    // Check proximity to long liquidation levels (below entry, price coming from above)
    for (let t = 0; t < LEVERAGE_TIERS.length; t++) {
      const liqLvl = cluster.longLiqs[t];
      const dist = (price - liqLvl) / price;
      // Price is above liq level, approaching from above
      if (dist > 0 && dist < approachPct) {
        shortScore += w * LIQ_WEIGHTS[t] * (1 - dist / approachPct);
      }
    }

    // Check proximity to short liquidation levels (above entry, price coming from below)
    for (let t = 0; t < LEVERAGE_TIERS.length; t++) {
      const liqLvl = cluster.shortLiqs[t];
      const dist = (liqLvl - price) / price;
      // Price is below liq level, approaching from below
      if (dist > 0 && dist < approachPct) {
        longScore += w * LIQ_WEIGHTS[t] * (1 - dist / approachPct);
      }
    }
  }

  // Need meaningful score to trigger
  const threshold = 0; // any proximity triggers
  if (longScore > threshold && longScore > shortScore) return "long";
  if (shortScore > threshold && shortScore > longScore) return "short";
  return null;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function entryCost(sp: number): number { return FEE + sp / 2; }
function exitCost(sp: number): number { return FEE + sp / 2; }
function slipCost(sp: number): number { return FEE + sp * SL_SLIP / 2; }

// ─── Simulation ─────────────────────────────────────────────────────
function simulate(
  pair: string,
  bars4h: C[],
  startMs: number,
  endMs: number,
): Trade[] {
  const sp = SPREAD[pair] ?? 4e-4;
  const trades: Trade[] = [];

  let pos: {
    dir: "long" | "short";
    ep: number;
    et: number;
    sl: number;
    barsHeld: number;
  } | null = null;

  const warmup = VP_LOOKBACK + 5;

  for (let i = warmup; i < bars4h.length; i++) {
    const bar = bars4h[i];
    if (bar.t < startMs || bar.t > endMs) continue;

    // Handle open position
    if (pos) {
      pos.barsHeld++;
      let xp = 0;
      let reason = "";

      // SL check
      if (pos.dir === "long" && bar.l <= pos.sl) {
        xp = pos.sl;
        reason = "sl";
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        xp = pos.sl;
        reason = "sl";
      }

      // Max hold (24h = 6 x 4h bars)
      if (!xp && pos.barsHeld >= MAX_HOLD_BARS) {
        xp = bar.c;
        reason = "timeout";
      }

      if (xp > 0) {
        const isSL = reason === "sl";
        const exitFee = isSL ? slipCost(sp) : exitCost(sp);
        const rawPnl = pos.dir === "long"
          ? (xp / pos.ep - 1) * NOT
          : (pos.ep / xp - 1) * NOT;
        const fees = NOT * (entryCost(sp) + exitFee);
        trades.push({
          pair, dir: pos.dir, ep: pos.ep, xp,
          et: pos.et, xt: bar.t,
          pnl: rawPnl - fees, reason,
        });
        pos = null;
      }
    }

    // Entry logic (no position)
    if (pos) continue;

    // Build volume profile from trailing 7-day window
    const vpBins = buildVolumeProfile(bars4h, i, VP_LOOKBACK);
    if (vpBins.length === 0) continue;

    const topBins = getTopClusters(vpBins, TOP_CLUSTERS);
    if (topBins.length === 0) continue;

    const clusters = estimateLiqClusters(topBins);
    const signal = detectLiqSignal(bar.c, clusters, APPROACH_PCT);

    if (!signal) continue;

    const ep = signal === "long"
      ? bar.c * (1 + sp / 2) // buy at ask
      : bar.c * (1 - sp / 2); // sell at bid

    const sl = signal === "long"
      ? ep * (1 - SL_PCT)
      : ep * (1 + SL_PCT);

    pos = { dir: signal, ep, et: bar.t, sl, barsHeld: 0 };
  }

  // Close any open position at end
  if (pos) {
    const lastBar = bars4h[bars4h.length - 1];
    const xp = lastBar.c;
    const rawPnl = pos.dir === "long"
      ? (xp / pos.ep - 1) * NOT
      : (pos.ep / xp - 1) * NOT;
    const fees = NOT * (entryCost(sp) + exitCost(sp));
    trades.push({
      pair, dir: pos.dir, ep: pos.ep, xp,
      et: pos.et, xt: lastBar.t,
      pnl: rawPnl - fees, reason: "eod",
    });
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const days = (endMs - startMs) / DAY;
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, pnl: 0, perDay: 0, maxDd: 0 };

  const wins = trades.filter(t => t.pnl > 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wr = (wins / n) * 100;

  const grossW = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossL > 0 ? grossW / grossL : grossW > 0 ? 999 : 0;

  // Max drawdown
  let cum = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  // Sharpe on daily PnL
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const dayKey = Math.floor(t.xt / DAY);
    dailyPnl.set(dayKey, (dailyPnl.get(dayKey) ?? 0) + t.pnl);
  }
  const dpArr = [...dailyPnl.values()];
  const avg = dpArr.reduce((s, v) => s + v, 0) / Math.max(dpArr.length, 1);
  const std = Math.sqrt(dpArr.reduce((s, v) => s + (v - avg) ** 2, 0) / Math.max(dpArr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  return { n, wr, pf, sharpe, pnl, perDay: pnl / days, maxDd };
}

function fmtStats(s: Stats): string {
  const p = s.pnl >= 0 ? `+$${s.pnl.toFixed(2)}` : `-$${Math.abs(s.pnl).toFixed(2)}`;
  return `  Trades: ${s.n}  |  WR: ${s.wr.toFixed(1)}%  |  PF: ${s.pf.toFixed(2)}  |  Sharpe: ${s.sharpe.toFixed(2)}  |  $/day: ${s.perDay.toFixed(2)}  |  PnL: ${p}  |  MaxDD: $${s.maxDd.toFixed(2)}`;
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=== Liquidation Level Mapper Backtest ===");
console.log(`Pairs: ${PAIRS.join(", ")}`);
console.log(`Full period: 2023-01 to 2026-03 | OOS: 2025-09-01`);
console.log(`SL: ${(SL_PCT * 100).toFixed(0)}% | Max hold: 24h | VP window: 7d (42 x 4h bars)`);
console.log(`Leverage tiers: ${LEVERAGE_TIERS.join("x, ")}x | Approach threshold: ${(APPROACH_PCT * 100).toFixed(0)}%`);
console.log(`Position size: $${SIZE} x ${LEV}x = $${NOT} notional`);
console.log();

console.log("Loading 5m data and aggregating to 4h...");

const pairBars = new Map<string, C[]>();
for (const pair of PAIRS) {
  const raw = load5m(pair);
  if (raw.length < 1000) {
    console.log(`  SKIP ${pair}: only ${raw.length} 5m bars`);
    continue;
  }
  const h4 = aggregate4h(raw);
  pairBars.set(pair, h4);
  console.log(`  ${pair}: ${raw.length} 5m bars -> ${h4.length} 4h bars`);
}

console.log();

// Run simulation per pair
const allTradesFull: Trade[] = [];
const allTradesOOS: Trade[] = [];
const pairStatsFull = new Map<string, Stats>();
const pairStatsOOS = new Map<string, Stats>();

console.log("─── Per-Pair Results ───────────────────────────────────────────");
console.log();

for (const pair of PAIRS) {
  const bars = pairBars.get(pair);
  if (!bars) continue;

  const tradesFull = simulate(pair, bars, FULL_START, END);
  const tradesOOS = tradesFull.filter(t => t.et >= OOS_START);
  const tradesIS = tradesFull.filter(t => t.et < OOS_START);

  allTradesFull.push(...tradesFull);
  allTradesOOS.push(...tradesOOS);

  const sf = computeStats(tradesFull, FULL_START, END);
  const so = computeStats(tradesOOS, OOS_START, END);
  pairStatsFull.set(pair, sf);
  pairStatsOOS.set(pair, so);

  console.log(`${pair}:`);
  console.log(`  Full: ${fmtStats(sf)}`);
  console.log(`  OOS:  ${fmtStats(so)}`);

  // Direction breakdown
  const fullLong = tradesFull.filter(t => t.dir === "long");
  const fullShort = tradesFull.filter(t => t.dir === "short");
  const longPnl = fullLong.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = fullShort.reduce((s, t) => s + t.pnl, 0);
  const longWR = fullLong.length > 0
    ? (fullLong.filter(t => t.pnl > 0).length / fullLong.length * 100).toFixed(1)
    : "0.0";
  const shortWR = fullShort.length > 0
    ? (fullShort.filter(t => t.pnl > 0).length / fullShort.length * 100).toFixed(1)
    : "0.0";
  console.log(`  Longs: ${fullLong.length} (WR ${longWR}%, PnL ${longPnl >= 0 ? "+" : ""}$${longPnl.toFixed(2)})  |  Shorts: ${fullShort.length} (WR ${shortWR}%, PnL ${shortPnl >= 0 ? "+" : ""}$${shortPnl.toFixed(2)})`);

  // Exit reason breakdown
  const slCount = tradesFull.filter(t => t.reason === "sl").length;
  const toCount = tradesFull.filter(t => t.reason === "timeout").length;
  const eodCount = tradesFull.filter(t => t.reason === "eod").length;
  console.log(`  Exits: SL=${slCount}  Timeout=${toCount}  EOD=${eodCount}`);
  console.log();
}

// Portfolio aggregates
console.log("═══════════════════════════════════════════════════════════════");
console.log("PORTFOLIO AGGREGATE");
console.log("═══════════════════════════════════════════════════════════════");

const portfolioFull = computeStats(
  allTradesFull.sort((a, b) => a.et - b.et), FULL_START, END
);
const portfolioOOS = computeStats(
  allTradesOOS.sort((a, b) => a.et - b.et), OOS_START, END
);

console.log(`Full (2023-01 to 2026-03):`);
console.log(fmtStats(portfolioFull));
console.log();
console.log(`OOS  (2025-09 to 2026-03):`);
console.log(fmtStats(portfolioOOS));
console.log();

// Direction split
const fullLongs = allTradesFull.filter(t => t.dir === "long");
const fullShorts = allTradesFull.filter(t => t.dir === "short");
console.log(`Direction split (Full):`);
console.log(`  Longs:  ${fullLongs.length} trades, WR ${fullLongs.length > 0 ? (fullLongs.filter(t => t.pnl > 0).length / fullLongs.length * 100).toFixed(1) : 0}%, PnL ${fullLongs.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}$${fullLongs.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
console.log(`  Shorts: ${fullShorts.length} trades, WR ${fullShorts.length > 0 ? (fullShorts.filter(t => t.pnl > 0).length / fullShorts.length * 100).toFixed(1) : 0}%, PnL ${fullShorts.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}$${fullShorts.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);

// Exit reasons
const slTot = allTradesFull.filter(t => t.reason === "sl").length;
const toTot = allTradesFull.filter(t => t.reason === "timeout").length;
const eodTot = allTradesFull.filter(t => t.reason === "eod").length;
console.log(`\nExit reasons (Full): SL=${slTot} (${(slTot / allTradesFull.length * 100).toFixed(1)}%)  Timeout=${toTot} (${(toTot / allTradesFull.length * 100).toFixed(1)}%)  EOD=${eodTot}`);

// Monthly PnL
console.log("\n─── Monthly PnL (Full) ────────────────────────────────────────");
const monthlyPnl = new Map<string, number>();
const monthlyCount = new Map<string, number>();
for (const t of allTradesFull) {
  const d = new Date(t.et);
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  monthlyPnl.set(key, (monthlyPnl.get(key) ?? 0) + t.pnl);
  monthlyCount.set(key, (monthlyCount.get(key) ?? 0) + 1);
}

const sortedMonths = [...monthlyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));
let profitableMonths = 0;
for (const [month, pnl] of sortedMonths) {
  const cnt = monthlyCount.get(month) ?? 0;
  const sign = pnl >= 0 ? "+" : "";
  console.log(`  ${month}: ${sign}$${pnl.toFixed(2)} (${cnt} trades)`);
  if (pnl > 0) profitableMonths++;
}
console.log(`\n  Profitable months: ${profitableMonths}/${sortedMonths.length} (${(profitableMonths / sortedMonths.length * 100).toFixed(0)}%)`);

// Quarterly stationarity
console.log("\n─── Quarterly PnL ─────────────────────────────────────────────");
const qPnl = new Map<string, number>();
const qCount = new Map<string, number>();
for (const t of allTradesFull) {
  const d = new Date(t.et);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  const key = `${d.getUTCFullYear()}-Q${q}`;
  qPnl.set(key, (qPnl.get(key) ?? 0) + t.pnl);
  qCount.set(key, (qCount.get(key) ?? 0) + 1);
}
const sortedQ = [...qPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));
let profQ = 0;
for (const [q, pnl] of sortedQ) {
  const cnt = qCount.get(q) ?? 0;
  const sign = pnl >= 0 ? "+" : "";
  console.log(`  ${q}: ${sign}$${pnl.toFixed(2)} (${cnt} trades)`);
  if (pnl > 0) profQ++;
}
console.log(`\n  Profitable quarters: ${profQ}/${sortedQ.length} (${(profQ / sortedQ.length * 100).toFixed(0)}%)`);

// Best and worst pair
console.log("\n─── Pair Rankings (Full PnL) ───────────────────────────────────");
const pairRank = [...pairStatsFull.entries()]
  .sort((a, b) => b[1].pnl - a[1].pnl);
for (const [pair, s] of pairRank) {
  const sign = s.pnl >= 0 ? "+" : "";
  console.log(`  ${pair.padEnd(5)} ${sign}$${s.pnl.toFixed(2).padStart(8)}  (PF ${s.pf.toFixed(2)}, WR ${s.wr.toFixed(1)}%, ${s.n} trades)`);
}

// Sample trades
console.log("\n─── Sample Trades (last 10 OOS) ───────────────────────────────");
const lastOOS = allTradesOOS.sort((a, b) => a.et - b.et).slice(-10);
for (const t of lastOOS) {
  const d = new Date(t.et).toISOString().slice(0, 16);
  const sign = t.pnl >= 0 ? "+" : "";
  console.log(`  ${d} ${t.pair.padEnd(5)} ${t.dir.padEnd(5)} ep=${t.ep.toFixed(4)} xp=${t.xp.toFixed(4)} ${sign}$${t.pnl.toFixed(2)} (${t.reason})`);
}

console.log("\n=== Done ===");
