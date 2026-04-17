// Funding rate signal backtest
// Tests: (1) standalone contrarian signal, (2) entry filter on GARCH z-score ensemble
// Funding source: /tmp/hl-funding-cache/{PAIR}.json (from collect-hl-funding.ts)
// Candles source: /tmp/bt-pair-cache-1h/{PAIR}USDT.json
// Run: npx tsx scripts/bt-funding-signal.ts

import * as fs from "fs";
import * as path from "path";
import { EMA, ATR, ADX } from "technicalindicators";

// ---- Constants ----
const FUNDING_CACHE = "/tmp/hl-funding-cache";
const CANDLE_CACHE = "/tmp/bt-pair-cache-1h";
const H = 3_600_000;
const DAY = 86_400_000;
const FEE = 0.00035; // HL taker 0.035%
const SZ = 20;
const LEV = 10;

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT",
  "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL", "ZEC", "AVAX",
  "NEAR", "kPEPE", "SUI", "HYPE", "FET",
];

// Approx HL spread per pair (taker slippage model)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, AVAX: 2.55e-4, ARB: 2.6e-4,
  ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4,
  OP: 6.2e-4, DASH: 7.15e-4, ETH: 0.5e-4, SOL: 1e-4, NEAR: 3e-4,
  TIA: 4e-4, ZEC: 5e-4, kPEPE: 2e-4, HYPE: 3e-4, FET: 4e-4,
  BTC: 0.5e-4,
};

// ---- Types ----
interface Candle { t: number; o: number; h: number; l: number; c: number; }
interface FundingBar { time: number; fundingRate: number; }

interface PairData {
  pair: string;       // e.g. "OP"
  candles: Candle[];
  timeIdx: Map<number, number>;   // t -> candle index
  funding: FundingBar[];
  fundingIdx: Map<number, number>; // fundingBar.time -> index
  ema9: number[];
  ema21: number[];
  atr: number[];
  adx: number[];
  zScore: number[];   // 3-bar momentum z-score (same as GARCH v2 ensemble)
}

interface Position {
  pair: string;
  dir: "long" | "short";
  ep: number;         // entry price
  et: number;         // entry time
  sl: number;
  tp: number;
  pk: number;         // peak profit% (for trailing)
}

interface Trade {
  pair: string;
  dir: "long" | "short";
  pnl: number;
  et: number;
  xt: number;
  reason: string;
}

// ---- Loaders ----
function loadCandles(pair: string): Candle[] {
  const f = path.join(CANDLE_CACHE, `${pair}USDT.json`);
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, "utf-8")) as any[];
  return raw.map(b => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
    : b as Candle
  );
}

function loadFunding(pair: string): FundingBar[] {
  const f = path.join(FUNDING_CACHE, `${pair}.json`);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf-8")) as FundingBar[];
}

function calcZScore(candles: Candle[]): number[] {
  const r = new Array(candles.length).fill(0);
  for (let i = 21; i < candles.length; i++) {
    const m = candles[i].c / candles[i - 3].c - 1;
    let s = 0, n = 0;
    for (let j = Math.max(1, i - 19); j <= i; j++) {
      s += (candles[j].c / candles[j - 1].c - 1) ** 2;
      n++;
    }
    if (n < 10) continue;
    const v = Math.sqrt(s / n);
    if (v > 0) r[i] = m / v;
  }
  return r;
}

function gv(arr: number[], i: number, len: number): number | null {
  const x = i - (len - arr.length);
  return x >= 0 && x < arr.length ? arr[x] : null;
}

function preparePair(pair: string, requireFunding = true): PairData | null {
  const candles = loadCandles(pair);
  if (candles.length < 200) return null;

  const funding = loadFunding(pair);
  if (requireFunding && funding.length < 100) return null;

  const timeIdx = new Map<number, number>();
  candles.forEach((c, i) => timeIdx.set(c.t, i));

  const fundingIdx = new Map<number, number>();
  funding.forEach((f, i) => fundingIdx.set(f.time, i));

  const cl = candles.map(c => c.c);
  const hi = candles.map(c => c.h);
  const lo = candles.map(c => c.l);

  return {
    pair,
    candles,
    timeIdx,
    funding,
    fundingIdx,
    ema9: EMA.calculate({ period: 9, values: cl }),
    ema21: EMA.calculate({ period: 21, values: cl }),
    atr: ATR.calculate({ period: 14, high: hi, low: lo, close: cl }),
    adx: ADX.calculate({ close: cl, high: hi, low: lo, period: 14 }).map(a => a.adx),
    zScore: calcZScore(candles),
  };
}

// Returns the rolling N-hour average funding rate at time t for a pair
function rollingAvgFunding(pd: PairData, t: number, hours: number): number | null {
  // Find the most recent funding bar at or before t
  const funding = pd.funding;
  if (funding.length === 0) return null;

  let hi = funding.length - 1;
  if (funding[hi].time > t) {
    // Binary search for last bar <= t
    let lo = 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (funding[mid].time <= t) lo = mid; else hi = mid - 1;
    }
    hi = lo;
  }

  if (hi < 0 || funding[hi].time > t) return null;

  const endIdx = hi;
  const startIdx = Math.max(0, endIdx - hours + 1);
  if (endIdx - startIdx + 1 < Math.floor(hours * 0.5)) return null; // need at least half coverage

  let sum = 0;
  for (let i = startIdx; i <= endIdx; i++) sum += funding[i].fundingRate;
  return sum / (endIdx - startIdx + 1);
}

// ---- Simulation ----

interface SimConfig {
  name: string;
  // Funding thresholds (per-hour rate)
  fundingShortThresh: number;  // funding > this => block longs (crowded long) or go short
  fundingLongThresh: number;   // funding < this => block shorts or go long
  fundingWindow: number;       // hours for rolling average
  // Mode
  mode: "standalone" | "filter" | "combined";
  // GARCH z-score entry thresholds (for ensemble / combined modes)
  zLong: number;
  zShort: number;
  // Exit params
  sl: number;       // stop-loss fraction (e.g. 0.03 = 3%)
  tp: number;       // 0 = disabled
  trailA: number;   // trailing activation %PnL (levered)
  trailD: number;   // trailing drawback %PnL
  maxHold: number;  // ms
}

function sim(
  cfg: SimConfig,
  pairData: Map<string, PairData>,
  btcData: PairData,
  startMs: number,
  endMs: number,
): Trade[] {
  // Build sorted timeline from all candle timestamps in range
  const ts = new Set<number>();
  for (const pd of pairData.values()) {
    for (const c of pd.candles) {
      if (c.t >= startMs && c.t < endMs) ts.add(c.t);
    }
  }
  const timeline = [...ts].sort((a, b) => a - b);

  const positions = new Map<string, Position>();
  const trades: Trade[] = [];

  // BTC regime: if BTC EMA9 > EMA21 => bullish bias
  const btcRegime = (t: number): "long" | "short" | null => {
    const bi = btcData.timeIdx.get(t);
    if (!bi || bi < 1) return null;
    const e9 = gv(btcData.ema9, bi - 1, btcData.candles.length);
    const e21 = gv(btcData.ema21, bi - 1, btcData.candles.length);
    if (e9 === null || e21 === null) return null;
    return e9 > e21 ? "long" : "short";
  };

  for (const t of timeline) {
    const closed = new Set<string>();

    // --- Exit pass ---
    for (const [pair, pos] of positions) {
      const pd = pairData.get(pair)!;
      const bi = pd.timeIdx.get(t) ?? -1;
      if (bi < 0) continue;
      const bar = pd.candles[bi];
      const sp = SP[pair] ?? 4e-4;
      let xp = 0;
      let reason = "";

      // SL
      if (pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl) {
        xp = pos.dir === "long" ? pos.sl * (1 - sp) : pos.sl * (1 + sp);
        reason = "sl";
      }

      // TP
      if (!reason && pos.tp > 0) {
        if (pos.dir === "long" ? bar.h >= pos.tp : bar.l <= pos.tp) {
          xp = pos.dir === "long" ? pos.tp * (1 - sp) : pos.tp * (1 + sp);
          reason = "tp";
        }
      }

      // Trailing stop
      if (!reason && cfg.trailA > 0) {
        const pnlPct = pos.dir === "long"
          ? (bar.c - pos.ep) / pos.ep * LEV * 100
          : (pos.ep - bar.c) / pos.ep * LEV * 100;
        if (pnlPct > pos.pk) pos.pk = pnlPct;
        if (pos.pk >= cfg.trailA && pnlPct <= pos.pk - cfg.trailD) {
          xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "trail";
        }
      }

      // Max hold
      if (!reason && t - pos.et >= cfg.maxHold) {
        xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        reason = "mh";
      }

      if (xp > 0) {
        const raw = pos.dir === "long"
          ? (xp / pos.ep - 1) * SZ * LEV
          : (pos.ep / xp - 1) * SZ * LEV;
        trades.push({ pair, dir: pos.dir, pnl: raw - SZ * LEV * FEE * 2, et: pos.et, xt: t, reason });
        positions.delete(pair);
        closed.add(pair);
      }
    }

    // --- Entry pass ---
    for (const [pair, pd] of pairData) {
      if (pair === "BTC" || positions.has(pair) || closed.has(pair)) continue;
      const bi = pd.timeIdx.get(t) ?? -1;
      if (bi < 60) continue;

      const sp = SP[pair] ?? 4e-4;

      // Get rolling funding average
      const avgFunding = rollingAvgFunding(pd, t, cfg.fundingWindow);
      if (avgFunding === null) continue;

      const fundingCrowdedLong = avgFunding > cfg.fundingShortThresh;   // longs paying heavily
      const fundingCrowdedShort = avgFunding < cfg.fundingLongThresh;   // shorts paying heavily

      let dir: "long" | "short" | null = null;

      if (cfg.mode === "standalone") {
        // Contrarian: fade crowded positions
        if (fundingCrowdedLong) dir = "short";
        else if (fundingCrowdedShort) dir = "long";
      } else if (cfg.mode === "filter") {
        // GARCH z-score signal, filtered by funding (block if crowded)
        const z = pd.zScore[bi - 1] || 0;
        const adx = gv(pd.adx, bi - 1, pd.candles.length);
        const e9 = gv(pd.ema9, bi - 1, pd.candles.length);
        const e21 = gv(pd.ema21, bi - 1, pd.candles.length);
        const atrN = gv(pd.atr, bi - 1, pd.candles.length);
        const atrP = gv(pd.atr, bi - 6, pd.candles.length);

        if (!adx || !e9 || !e21) continue;
        if (atrN && atrP && atrN < atrP * 0.9) continue;

        let rawDir: "long" | "short" | null = null;
        if (z > cfg.zLong) rawDir = "long";
        else if (z < -cfg.zShort) rawDir = "short";
        if (!rawDir) continue;

        if (rawDir === "long" && adx <= 30) continue;
        if (rawDir === "short" && adx <= 25) continue;
        if (rawDir === "long" && e9 <= e21) continue;
        if (rawDir === "short" && e9 >= e21) continue;

        const btcDir = btcRegime(t);
        if (!btcDir || btcDir !== rawDir) continue;

        // Filter: block longs when funding crowded long, block shorts when funding crowded short
        if (rawDir === "long" && fundingCrowdedLong) continue;
        if (rawDir === "short" && fundingCrowdedShort) continue;

        dir = rawDir;
      } else {
        // combined: GARCH signal AND funding alignment as confirmation
        const z = pd.zScore[bi - 1] || 0;
        const adx = gv(pd.adx, bi - 1, pd.candles.length);
        const e9 = gv(pd.ema9, bi - 1, pd.candles.length);
        const e21 = gv(pd.ema21, bi - 1, pd.candles.length);
        const atrN = gv(pd.atr, bi - 1, pd.candles.length);
        const atrP = gv(pd.atr, bi - 6, pd.candles.length);

        if (!adx || !e9 || !e21) continue;
        if (atrN && atrP && atrN < atrP * 0.9) continue;

        let rawDir: "long" | "short" | null = null;
        if (z > cfg.zLong) rawDir = "long";
        else if (z < -cfg.zShort) rawDir = "short";
        if (!rawDir) continue;

        if (rawDir === "long" && adx <= 30) continue;
        if (rawDir === "short" && adx <= 25) continue;
        if (rawDir === "long" && e9 <= e21) continue;
        if (rawDir === "short" && e9 >= e21) continue;

        const btcDir = btcRegime(t);
        if (!btcDir || btcDir !== rawDir) continue;

        // Require funding confirmation (contrarian alignment):
        // GARCH long → funding should be negative or neutral (not crowded long)
        // GARCH short → funding should be positive or neutral (not crowded short)
        if (rawDir === "long" && avgFunding > 0 && !fundingCrowdedShort) continue;
        if (rawDir === "short" && avgFunding < 0 && !fundingCrowdedLong) continue;

        dir = rawDir;
      }

      if (!dir) continue;

      // Position concentration limit
      const sameDirCount = [...positions.values()].filter(p => p.dir === dir).length;
      if (sameDirCount >= 4) continue;

      const entryPrice = pd.candles[bi].o;
      const ent = dir === "long" ? entryPrice * (1 + sp) : entryPrice * (1 - sp);
      const sl = dir === "long" ? ent * (1 - cfg.sl) : ent * (1 + cfg.sl);
      const tp = cfg.tp > 0 ? (dir === "long" ? ent * (1 + cfg.tp) : ent * (1 - cfg.tp)) : 0;

      positions.set(pair, { pair, dir, ep: ent, et: t, sl, tp, pk: 0 });
    }
  }

  return trades;
}

function metrics(trades: Trade[], startMs: number, endMs: number) {
  const days = (endMs - startMs) / DAY;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const wr = trades.length > 0 ? wins / trades.length * 100 : 0;

  let cum = 0, peak = 0, maxDD = 0;
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
    const day = Math.floor(t.xt / DAY);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
  }

  const dr = [...dailyPnl.values()];
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  const gw = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);

  return { pnl, days, pnlPerDay: pnl / days, wr, sharpe, maxDD, pf, n: trades.length, tpd: trades.length / days };
}

// ---- Main ----

async function main() {
  console.log("Loading pair data...");

  // Load BTC for regime (funding not required for BTC, it's regime only)
  const btcData = preparePair("BTC", false);
  if (!btcData) {
    console.error("BTC candle data missing - need /tmp/bt-pair-cache-1h/BTCUSDT.json");
    process.exit(1);
  }

  const pairData = new Map<string, PairData>();
  let loaded = 0;
  let missingCandles: string[] = [];
  let missingFunding: string[] = [];

  for (const pair of PAIRS) {
    const candles = loadCandles(pair);
    const funding = loadFunding(pair);

    if (candles.length < 200) { missingCandles.push(pair); continue; }
    if (funding.length < 100) { missingFunding.push(pair); continue; }

    const pd = preparePair(pair);
    if (pd) {
      pairData.set(pair, pd);
      loaded++;
    }
  }

  console.log(`Loaded ${loaded}/${PAIRS.length} pairs`);
  if (missingCandles.length > 0) console.log(`Missing candles: ${missingCandles.join(", ")}`);
  if (missingFunding.length > 0) console.log(`Missing funding: ${missingFunding.join(", ")} (run collect-hl-funding.ts first)`);

  if (pairData.size < 5) {
    console.error("Too few pairs. Run collect-hl-funding.ts first to download funding data.");
    process.exit(1);
  }

  // Determine date range from available data.
  // Use the minimum across-pair candle start so the range isn't clamped by late-listing pairs.
  // Each pair's rollingAvgFunding() will return null if no funding data available at that time.
  let minTs = Infinity, maxTs = 0;
  for (const pd of pairData.values()) {
    if (pd.candles[0].t < minTs) minTs = pd.candles[0].t;
    if (pd.candles[pd.candles.length - 1].t > maxTs) maxTs = pd.candles[pd.candles.length - 1].t;
  }
  const startMs = Math.max(minTs, new Date("2023-01-01").getTime());
  const endMs = maxTs;
  const midMs = startMs + (endMs - startMs) * 0.6; // 60/40 train/test

  console.log(`\nDate range: ${new Date(startMs).toISOString().slice(0, 10)} -> ${new Date(endMs).toISOString().slice(0, 10)}`);
  console.log(`Train: -> ${new Date(midMs).toISOString().slice(0, 10)}  Test: ->`);

  // --- Baseline: GARCH ensemble (no funding filter) ---
  const baseline: SimConfig = {
    name: "GARCH-baseline (no funding filter)",
    fundingShortThresh: 999,
    fundingLongThresh: -999,
    fundingWindow: 24,
    mode: "filter",
    zLong: 4.5, zShort: 3.0,
    sl: 0.03, tp: 0.10, trailA: 40, trailD: 15,
    maxHold: 48 * H,
  };

  // --- Standalone funding signal configs ---
  const standaloneConfigs: SimConfig[] = [];
  for (const thresh of [0.0001, 0.00015, 0.0002, 0.0003]) {
    for (const window of [24, 48, 72]) {
      for (const [tp, trA, trD, mh] of [
        [0.10, 0, 0, 48 * H],
        [0.12, 0, 0, 48 * H],
        [0, 40, 15, 72 * H],
      ] as [number, number, number, number][]) {
        standaloneConfigs.push({
          name: `standalone thresh=${(thresh * 10000).toFixed(1)}bph win=${window}h tp=${tp > 0 ? (tp * 100).toFixed(0) + "%" : "trail"}`,
          fundingShortThresh: thresh,
          fundingLongThresh: -thresh,
          fundingWindow: window,
          mode: "standalone",
          zLong: 4.5, zShort: 3.0,
          sl: 0.03, tp, trailA: trA, trailD: trD,
          maxHold: mh,
        });
      }
    }
  }

  // --- Entry filter configs ---
  const filterConfigs: SimConfig[] = [];
  for (const thresh of [0.00005, 0.0001, 0.00015, 0.0002]) {
    for (const window of [24, 48]) {
      filterConfigs.push({
        name: `GARCH+filter thresh=${(thresh * 10000).toFixed(2)}bph win=${window}h`,
        fundingShortThresh: thresh,
        fundingLongThresh: -thresh,
        fundingWindow: window,
        mode: "filter",
        zLong: 4.5, zShort: 3.0,
        sl: 0.03, tp: 0.10, trailA: 40, trailD: 15,
        maxHold: 48 * H,
      });
    }
  }

  // --- Combined (GARCH + funding confirmation) ---
  const combinedConfigs: SimConfig[] = [];
  for (const thresh of [0.00005, 0.0001, 0.00015]) {
    for (const window of [24, 48]) {
      combinedConfigs.push({
        name: `combined thresh=${(thresh * 10000).toFixed(2)}bph win=${window}h`,
        fundingShortThresh: thresh,
        fundingLongThresh: -thresh,
        fundingWindow: window,
        mode: "combined",
        zLong: 4.5, zShort: 3.0,
        sl: 0.03, tp: 0.10, trailA: 40, trailD: 15,
        maxHold: 48 * H,
      });
    }
  }

  // ---- Run baseline ----
  console.log("\n=== BASELINE ===");
  {
    const allTr = sim(baseline, pairData, btcData, startMs, endMs);
    const trainTr = sim(baseline, pairData, btcData, startMs, midMs);
    const testTr = sim(baseline, pairData, btcData, midMs, endMs);
    const m = metrics(allTr, startMs, endMs);
    const mt = metrics(trainTr, startMs, midMs);
    const ms = metrics(testTr, midMs, endMs);
    console.log(`${baseline.name}`);
    console.log(`  Trades: ${m.n} (${m.tpd.toFixed(1)}/day)  WR: ${m.wr.toFixed(1)}%  PF: ${m.pf.toFixed(2)}  $/day: $${m.pnlPerDay.toFixed(2)}  Sharpe: ${m.sharpe.toFixed(2)}  MaxDD: $${m.maxDD.toFixed(0)}`);
    console.log(`  Train: $${mt.pnlPerDay.toFixed(2)}/day  Test: $${ms.pnlPerDay.toFixed(2)}/day`);
  }

  // ---- Run standalone ----
  console.log("\n=== STANDALONE FUNDING SIGNAL ===");
  console.log("Name".padEnd(60) + "  N    T/d  WR%   PF    $/d    Sharpe MaxDD  Train  Test");
  console.log("-".repeat(115));

  type Result = {
    cfg: SimConfig;
    m: ReturnType<typeof metrics>;
    mt: ReturnType<typeof metrics>;
    ms: ReturnType<typeof metrics>;
  };

  const standaloneResults: Result[] = [];
  for (const cfg of standaloneConfigs) {
    const allTr = sim(cfg, pairData, btcData, startMs, endMs);
    if (allTr.length < 10) continue;
    const trainTr = sim(cfg, pairData, btcData, startMs, midMs);
    const testTr = sim(cfg, pairData, btcData, midMs, endMs);
    const m = metrics(allTr, startMs, endMs);
    const mt = metrics(trainTr, startMs, midMs);
    const ms = metrics(testTr, midMs, endMs);
    standaloneResults.push({ cfg, m, mt, ms });
  }

  standaloneResults.sort((a, b) => b.m.pnlPerDay - a.m.pnlPerDay);
  for (const { cfg, m, mt, ms } of standaloneResults.slice(0, 15)) {
    const trainTest = mt.pnlPerDay > 0 && ms.pnlPerDay > 0 ? "OK" : "FAIL";
    console.log(
      `${cfg.name.slice(0, 58).padEnd(60)}  ${String(m.n).padStart(4)}  ${m.tpd.toFixed(1).padStart(4)}  ${m.wr.toFixed(0).padStart(4)}%  ${m.pf.toFixed(2).padStart(5)}  ${("$" + m.pnlPerDay.toFixed(2)).padStart(6)}  ${m.sharpe.toFixed(2).padStart(5)}  $${m.maxDD.toFixed(0).padStart(4)}  $${mt.pnlPerDay.toFixed(2).padStart(5)}  $${ms.pnlPerDay.toFixed(2).padStart(5)}  ${trainTest}`
    );
  }

  // ---- Run filter ----
  console.log("\n=== GARCH + FUNDING ENTRY FILTER ===");
  console.log("Name".padEnd(52) + "  N    T/d  WR%   PF    $/d    Sharpe MaxDD  Train  Test  vs Baseline");
  console.log("-".repeat(122));

  const baselineTr = sim(baseline, pairData, btcData, startMs, endMs);
  const baselineM = metrics(baselineTr, startMs, endMs);

  const filterResults: Result[] = [];
  for (const cfg of filterConfigs) {
    const allTr = sim(cfg, pairData, btcData, startMs, endMs);
    if (allTr.length < 10) continue;
    const trainTr = sim(cfg, pairData, btcData, startMs, midMs);
    const testTr = sim(cfg, pairData, btcData, midMs, endMs);
    const m = metrics(allTr, startMs, endMs);
    const mt = metrics(trainTr, startMs, midMs);
    const ms = metrics(testTr, midMs, endMs);
    filterResults.push({ cfg, m, mt, ms });
  }

  filterResults.sort((a, b) => b.m.pnlPerDay - a.m.pnlPerDay);
  for (const { cfg, m, mt, ms } of filterResults) {
    const diff = m.pnlPerDay - baselineM.pnlPerDay;
    const diffStr = (diff >= 0 ? "+" : "") + "$" + diff.toFixed(2);
    const trainTest = mt.pnlPerDay > 0 && ms.pnlPerDay > 0 ? "OK" : "FAIL";
    console.log(
      `${cfg.name.slice(0, 50).padEnd(52)}  ${String(m.n).padStart(4)}  ${m.tpd.toFixed(1).padStart(4)}  ${m.wr.toFixed(0).padStart(4)}%  ${m.pf.toFixed(2).padStart(5)}  ${("$" + m.pnlPerDay.toFixed(2)).padStart(6)}  ${m.sharpe.toFixed(2).padStart(5)}  $${m.maxDD.toFixed(0).padStart(4)}  $${mt.pnlPerDay.toFixed(2).padStart(5)}  $${ms.pnlPerDay.toFixed(2).padStart(5)}  ${diffStr}  ${trainTest}`
    );
  }

  // ---- Run combined ----
  console.log("\n=== GARCH + FUNDING CONFIRMATION (combined) ===");
  console.log("Name".padEnd(52) + "  N    T/d  WR%   PF    $/d    Sharpe MaxDD  Train  Test  vs Baseline");
  console.log("-".repeat(122));

  const combinedResults: Result[] = [];
  for (const cfg of combinedConfigs) {
    const allTr = sim(cfg, pairData, btcData, startMs, endMs);
    if (allTr.length < 5) continue;
    const trainTr = sim(cfg, pairData, btcData, startMs, midMs);
    const testTr = sim(cfg, pairData, btcData, midMs, endMs);
    const m = metrics(allTr, startMs, endMs);
    const mt = metrics(trainTr, startMs, midMs);
    const ms = metrics(testTr, midMs, endMs);
    combinedResults.push({ cfg, m, mt, ms });
  }

  combinedResults.sort((a, b) => b.m.pnlPerDay - a.m.pnlPerDay);
  for (const { cfg, m, mt, ms } of combinedResults) {
    const diff = m.pnlPerDay - baselineM.pnlPerDay;
    const diffStr = (diff >= 0 ? "+" : "") + "$" + diff.toFixed(2);
    const trainTest = mt.pnlPerDay > 0 && ms.pnlPerDay > 0 ? "OK" : "FAIL";
    console.log(
      `${cfg.name.slice(0, 50).padEnd(52)}  ${String(m.n).padStart(4)}  ${m.tpd.toFixed(1).padStart(4)}  ${m.wr.toFixed(0).padStart(4)}%  ${m.pf.toFixed(2).padStart(5)}  ${("$" + m.pnlPerDay.toFixed(2)).padStart(6)}  ${m.sharpe.toFixed(2).padStart(5)}  $${m.maxDD.toFixed(0).padStart(4)}  $${mt.pnlPerDay.toFixed(2).padStart(5)}  $${ms.pnlPerDay.toFixed(2).padStart(5)}  ${diffStr}  ${trainTest}`
    );
  }

  // ---- Funding signal statistics ----
  console.log("\n=== FUNDING RATE STATISTICS ===");
  for (const [pair, pd] of [...pairData.entries()].sort()) {
    if (pd.funding.length === 0) continue;
    const rates = pd.funding.map(f => f.fundingRate);
    const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
    const absAvg = rates.reduce((s, r) => s + Math.abs(r), 0) / rates.length;
    const pctPositive = rates.filter(r => r > 0).length / rates.length * 100;
    const extremeHigh = rates.filter(r => r > 0.0001).length;
    const extremeLow = rates.filter(r => r < -0.0001).length;
    console.log(
      `${pair.padEnd(8)} bars=${String(pd.funding.length).padStart(6)}  avg=${(avg * 10000).toFixed(3).padStart(7)}bph  |avg|=${(absAvg * 10000).toFixed(3).padStart(7)}bph  +${pctPositive.toFixed(0)}%  extreme+${extremeHigh} extreme-${extremeLow}`
    );
  }

  console.log("\nDone.");
}

main().catch(console.error);
