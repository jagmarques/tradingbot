/**
 * Pair-Specific Filter Optimization on Supertrend(14, 1.75) + Volume Filter
 *
 * Tests whether pair-specific filters improve results based on regime
 * specialist findings: APT/SOL/ETH/LINK = relative strength (avoid shorts),
 * WLD/OP/TRUMP/WIF = weakness (prioritize shorts).
 *
 * Filters:
 * 0. Baseline: Supertrend(14,1.75) + volume filter, all 18 pairs
 * 1. Relative Strength: only short pairs underperforming BTC, only long pairs outperforming BTC
 * 2. ATR-Weighted: rank pairs by ATR/price, prioritize high-ATR for shorts, low-ATR for longs
 * 3. Rolling PF: only trade pairs with trailing 30-trade PF > 1.0
 * 4. Combined RS + ATR: short only pairs underperforming BTC AND ATR > median
 *
 * Data: 5m candles from /tmp/bt-pair-cache-5m/, aggregated to 4h.
 * Full: 2023-01 to 2026-03 | OOS: 2025-09-01
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 3;
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

const RS_LOOKBACK_BARS = 84; // 14 days * 6 bars/day (4h bars)
const ROLLING_PF_WINDOW = 30; // trailing 30 trades

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +(b.t ?? b[0]), o: +(b.o ?? b[1]), h: +(b.h ?? b[2]),
    l: +(b.l ?? b[3]), c: +(b.c ?? b[4]), v: +(b.v ?? b[5] ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
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
      v: group.reduce((s, g) => s + g.v, 0),
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

function calcVol20(cs: C[]): number[] {
  const vol20 = new Array(cs.length).fill(0);
  for (let i = 20; i < cs.length; i++) {
    let sum = 0;
    for (let j = i - 20; j < i; j++) sum += cs[j].v;
    vol20[i] = sum / 20;
  }
  return vol20;
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
  const rets = [...dayPnl.values()];
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(rets.length - 1, 1));
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

// ─── Pair Data Structures ───────────────────────────────────────────
interface PairData {
  cs4h: C[];
  stDir: number[];
  atr: number[];
  vol20: number[];
  tsIdx: Map<number, number>; // timestamp -> bar index
}

// ─── Filter Types ───────────────────────────────────────────────────
type FilterType = "baseline" | "rel-strength" | "atr-weighted" | "rolling-pf" | "rs-atr-combined";

// ─── Relative Strength vs BTC ───────────────────────────────────────
// For each pair at each bar, compute 14-day return relative to BTC
// Pair 14d return - BTC 14d return. Positive = outperforming BTC.
function buildRelativeStrength(
  pairData: Map<string, PairData>,
  btcData: PairData,
): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();
  const btcCloseMap = new Map<number, number>();
  for (const c of btcData.cs4h) btcCloseMap.set(c.t, c.c);

  for (const pair of PAIRS) {
    const pd = pairData.get(pair);
    if (!pd) continue;
    const rsMap = new Map<number, number>();

    for (let i = RS_LOOKBACK_BARS; i < pd.cs4h.length; i++) {
      const curClose = pd.cs4h[i].c;
      const prevClose = pd.cs4h[i - RS_LOOKBACK_BARS].c;
      if (prevClose <= 0) continue;
      const pairRet = (curClose - prevClose) / prevClose;

      // Find BTC close at matching timestamps
      const btcCur = btcCloseMap.get(pd.cs4h[i].t);
      const btcPrev = btcCloseMap.get(pd.cs4h[i - RS_LOOKBACK_BARS].t);
      if (!btcCur || !btcPrev || btcPrev <= 0) continue;
      const btcRet = (btcCur - btcPrev) / btcPrev;

      rsMap.set(pd.cs4h[i].t, pairRet - btcRet);
    }

    result.set(pair, rsMap);
  }

  return result;
}

// ─── ATR/Price Ranking ──────────────────────────────────────────────
// At each timestamp, rank pairs by ATR/price ratio
function buildAtrPriceRatio(
  pairData: Map<string, PairData>,
): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();
  for (const pair of PAIRS) {
    result.set(pair, new Map<number, number>());
  }

  // Collect all timestamps
  const allTs = new Set<number>();
  for (const pd of pairData.values()) {
    for (const c of pd.cs4h) allTs.add(c.t);
  }
  const sortedTs = [...allTs].sort((a, b) => a - b);

  for (const t of sortedTs) {
    const ratios: { pair: string; ratio: number }[] = [];
    for (const pair of PAIRS) {
      const pd = pairData.get(pair);
      if (!pd) continue;
      const idx = pd.tsIdx.get(t);
      if (idx === undefined || idx < 15) continue;
      const atrVal = pd.atr[idx - 1];
      const price = pd.cs4h[idx - 1].c;
      if (price <= 0 || atrVal <= 0) continue;
      ratios.push({ pair, ratio: atrVal / price });
    }

    if (ratios.length === 0) continue;

    // Compute median
    const sorted = [...ratios].sort((a, b) => a.ratio - b.ratio);
    const medianIdx = Math.floor(sorted.length / 2);
    const median = sorted[medianIdx].ratio;

    // Store ratio and whether above median (encoded as ratio, median checked at trade time)
    for (const r of ratios) {
      result.get(r.pair)!.set(t, r.ratio);
    }
  }

  return result;
}

function getAtrMedianAtTime(
  pairData: Map<string, PairData>,
  atrRatios: Map<string, Map<number, number>>,
  t: number,
): number {
  const vals: number[] = [];
  for (const pair of PAIRS) {
    const v = atrRatios.get(pair)?.get(t);
    if (v !== undefined) vals.push(v);
  }
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

// ─── Strategy Runner ────────────────────────────────────────────────
function runStrategy(
  pairData: Map<string, PairData>,
  btcData: PairData,
  filterType: FilterType,
  startTs: number,
  endTs: number,
  rsData: Map<string, Map<number, number>>,
  atrRatios: Map<string, Map<number, number>>,
): Tr[] {
  const trades: Tr[] = [];

  // For rolling PF filter, track per-pair trade history globally
  const pairTradeHistory = new Map<string, Tr[]>();
  for (const pair of PAIRS) pairTradeHistory.set(pair, []);

  // Portfolio-level simulation: process all pairs in time order
  // Build per-pair state
  interface PairState {
    pair: string;
    pos: {
      dir: "long" | "short"; ep: number; et: number;
      sl: number; peak: number;
    } | null;
  }

  const pairStates: PairState[] = [];
  for (const pair of PAIRS) {
    if (!pairData.has(pair)) continue;
    pairStates.push({ pair, pos: null });
  }

  // Collect all unique 4h timestamps
  const allTs = new Set<number>();
  for (const pd of pairData.values()) {
    for (const c of pd.cs4h) {
      if (c.t >= FULL_START) allTs.add(c.t);
    }
  }
  const sortedTs = [...allTs].sort((a, b) => a - b);

  for (const t of sortedTs) {
    // Process exits first, then entries
    for (const ps of pairStates) {
      const pd = pairData.get(ps.pair)!;
      const i = pd.tsIdx.get(t);
      if (i === undefined || i < 15) continue;

      const prevDir = pd.stDir[i - 1];
      const prevPrevDir = i >= 2 ? pd.stDir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // Manage open position
      if (ps.pos) {
        const bar = pd.cs4h[i];
        if (ps.pos.dir === "long") ps.pos.peak = Math.max(ps.pos.peak, bar.h);
        else ps.pos.peak = Math.min(ps.pos.peak, bar.l);

        let xp = 0, reason = "";

        // Stop-loss
        if (ps.pos.dir === "long" && bar.l <= ps.pos.sl) {
          xp = ps.pos.sl; reason = "sl";
        } else if (ps.pos.dir === "short" && bar.h >= ps.pos.sl) {
          xp = ps.pos.sl; reason = "sl";
        }

        // Supertrend flip
        if (!xp && flipped) { xp = bar.o; reason = "flip"; }

        // 48h stagnation
        if (!xp && (bar.t - ps.pos.et) > 48 * HOUR) { xp = bar.c; reason = "stagnation"; }

        if (xp > 0) {
          const isSL = reason === "sl";
          const pnl = tradePnl(ps.pair, ps.pos.ep, xp, ps.pos.dir, isSL);
          const trade: Tr = { pair: ps.pair, dir: ps.pos.dir, ep: ps.pos.ep, xp, et: ps.pos.et, xt: bar.t, pnl, reason };
          if (ps.pos.et >= startTs && ps.pos.et < endTs) {
            trades.push(trade);
          }
          // Track ALL trades for rolling PF (including IS trades, to have history for OOS)
          pairTradeHistory.get(ps.pair)!.push(trade);
          ps.pos = null;
        }
      }
    }

    // Entries
    // For ATR-weighted: compute ranking at this bar
    let atrRanking: { pair: string; ratio: number }[] = [];
    if (filterType === "atr-weighted" || filterType === "rs-atr-combined") {
      for (const pair of PAIRS) {
        const v = atrRatios.get(pair)?.get(t);
        if (v !== undefined) atrRanking.push({ pair, ratio: v });
      }
      atrRanking.sort((a, b) => b.ratio - a.ratio); // high ATR first
    }

    // Collect candidate entries
    interface EntryCandidate {
      pair: string;
      dir: "long" | "short";
      ep: number;
      sl: number;
      atrRatio: number;
    }

    const candidates: EntryCandidate[] = [];

    for (const ps of pairStates) {
      if (ps.pos) continue; // already in position
      const pd = pairData.get(ps.pair)!;
      const i = pd.tsIdx.get(t);
      if (i === undefined || i < 15) continue;
      if (t < startTs || t >= endTs) continue;

      const prevDir = pd.stDir[i - 1];
      const prevPrevDir = i >= 2 ? pd.stDir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;
      if (!flipped) continue;

      const newDir: "long" | "short" = prevDir === 1 ? "long" : "short";

      // Volume filter (baseline for all)
      const curVol = pd.cs4h[i - 1]?.v ?? 0;
      const avgVol = pd.vol20[i - 1] || 0;
      if (avgVol <= 0 || curVol < 1.5 * avgVol) continue;

      // Filter 1: Relative Strength
      if (filterType === "rel-strength") {
        const rs = rsData.get(ps.pair)?.get(t);
        if (rs !== undefined) {
          // Only long outperformers (rs > 0), only short underperformers (rs < 0)
          if (newDir === "long" && rs < 0) continue;
          if (newDir === "short" && rs > 0) continue;
        }
      }

      // Filter 3: Rolling PF
      if (filterType === "rolling-pf") {
        const history = pairTradeHistory.get(ps.pair)!;
        if (history.length >= ROLLING_PF_WINDOW) {
          const recent = history.slice(-ROLLING_PF_WINDOW);
          const gp = recent.filter(tr => tr.pnl > 0).reduce((s, tr) => s + tr.pnl, 0);
          const gl = Math.abs(recent.filter(tr => tr.pnl <= 0).reduce((s, tr) => s + tr.pnl, 0));
          const pf = gl > 0 ? gp / gl : (gp > 0 ? 10 : 0);
          if (pf < 1.0) continue; // skip pairs currently losing
        }
        // If fewer than 30 trades, allow (no history yet)
      }

      // Filter 4: Combined RS + ATR
      if (filterType === "rs-atr-combined") {
        const rs = rsData.get(ps.pair)?.get(t);
        const atrVal = atrRatios.get(ps.pair)?.get(t);
        const median = getAtrMedianAtTime(pairData, atrRatios, t);

        if (newDir === "short") {
          // Short only: underperforming BTC AND ATR > median
          if (rs !== undefined && rs > 0) continue;
          if (atrVal !== undefined && atrVal <= median) continue;
        }
        if (newDir === "long") {
          // Long only: outperforming BTC
          if (rs !== undefined && rs < 0) continue;
        }
      }

      const ep = pd.cs4h[i].o;
      const curATR = pd.atr[i - 1] || pd.atr[i - 2] || 0;
      const slDist = Math.min(3 * curATR, ep * 0.035);
      const sl = newDir === "long" ? ep - slDist : ep + slDist;
      const atrRatio = atrRatios.get(ps.pair)?.get(t) ?? 0;

      candidates.push({ pair: ps.pair, dir: newDir, ep, sl, atrRatio });
    }

    // For ATR-weighted filter: rank candidates
    if (filterType === "atr-weighted" && candidates.length > 0) {
      candidates.sort((a, b) => {
        // Shorts: high ATR first; Longs: low ATR first
        if (a.dir === "short" && b.dir === "short") return b.atrRatio - a.atrRatio;
        if (a.dir === "long" && b.dir === "long") return a.atrRatio - b.atrRatio;
        return 0;
      });
    }

    // Open positions for accepted candidates
    for (const cand of candidates) {
      const ps = pairStates.find(p => p.pair === cand.pair)!;
      if (ps.pos) continue;

      // Count open positions per direction
      const openLong = pairStates.filter(p => p.pos?.dir === "long").length;
      const openShort = pairStates.filter(p => p.pos?.dir === "short").length;
      if (cand.dir === "long" && openLong >= 10) continue;
      if (cand.dir === "short" && openShort >= 10) continue;

      ps.pos = { dir: cand.dir, ep: cand.ep, et: t, sl: cand.sl, peak: cand.ep };
    }
  }

  // Close any remaining positions at end
  for (const ps of pairStates) {
    if (ps.pos && ps.pos.et >= startTs && ps.pos.et < endTs) {
      const pd = pairData.get(ps.pair)!;
      const lastBar = pd.cs4h[pd.cs4h.length - 1];
      const pnl = tradePnl(ps.pair, ps.pos.ep, lastBar.c, ps.pos.dir, false);
      trades.push({ pair: ps.pair, dir: ps.pos.dir, ep: ps.pos.ep, xp: lastBar.c, et: ps.pos.et, xt: lastBar.t, pnl, reason: "end" });
      pairTradeHistory.get(ps.pair)!.push(trades[trades.length - 1]);
    }
  }

  return trades;
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("=== PAIR-SPECIFIC FILTER OPTIMIZATION ===");
  console.log(`Supertrend(14, 1.75) + Volume Filter | Size=$${SIZE} | Leverage=${LEV}x | Notional=$${NOT}`);
  console.log(`Full: 2023-01 to 2026-03 | OOS: 2025-09-01 to 2026-03-26`);
  console.log(`Pairs: ${PAIRS.length} | Cost: taker 0.035%, spread map, 1.5x SL slippage\n`);

  // Load data
  console.log("Loading data...");
  const pairData = new Map<string, PairData>();

  for (const pair of [...PAIRS, "BTC"]) {
    const raw5m = load5m(pair);
    if (raw5m.length === 0) { console.log(`  SKIP ${pair}: no 5m data`); continue; }
    const cs4h = aggregateTo4h(raw5m);
    if (cs4h.length < 100) { console.log(`  SKIP ${pair}: only ${cs4h.length} 4h bars`); continue; }

    const { dir: stDir } = calcSupertrend(cs4h, 14, 1.75);
    const atr = calcATR(cs4h, 14);
    const vol20 = calcVol20(cs4h);
    const tsIdx = new Map<number, number>();
    for (let i = 0; i < cs4h.length; i++) tsIdx.set(cs4h[i].t, i);

    pairData.set(pair, { cs4h, stDir, atr, vol20, tsIdx });
    console.log(`  ${pair}: ${cs4h.length} 4h bars (${raw5m.length} 5m)`);
  }

  const btcData = pairData.get("BTC");
  if (!btcData) { console.log("ERROR: No BTC data"); return; }

  // Build filter data
  console.log("\nBuilding filter data...");
  const rsData = buildRelativeStrength(pairData, btcData);
  console.log("  Relative strength: done");
  const atrRatios = buildAtrPriceRatio(pairData);
  console.log("  ATR/price ratios: done");

  // ─── Run Filters ──────────────────────────────────────────────────
  const filters: { name: string; type: FilterType; desc: string }[] = [
    { name: "0. BASELINE", type: "baseline", desc: "Supertrend(14,1.75) + volume filter, all 18 pairs" },
    { name: "1. REL STRENGTH", type: "rel-strength", desc: "Only short underperformers, only long outperformers (vs BTC 14d)" },
    { name: "2. ATR-WEIGHTED", type: "atr-weighted", desc: "Shorts: prioritize high-ATR pairs; Longs: prioritize low-ATR" },
    { name: "3. ROLLING PF", type: "rolling-pf", desc: "Only trade pairs with trailing 30-trade PF > 1.0" },
    { name: "4. RS + ATR", type: "rs-atr-combined", desc: "Shorts: underperform BTC AND high-ATR; Longs: outperform BTC" },
  ];

  const filterResults: { name: string; type: FilterType; oosTrades: Tr[]; oosMetrics: Metrics; fullTrades: Tr[]; fullMetrics: Metrics }[] = [];

  for (const f of filters) {
    console.log(`\nRunning ${f.name}...`);
    const fullTrades = runStrategy(pairData, btcData, f.type, FULL_START, OOS_END, rsData, atrRatios);
    const oosTrades = fullTrades.filter(t => t.et >= OOS_START);
    const isTrades = fullTrades.filter(t => t.et < OOS_START);

    const fullMetrics = calcMetrics(fullTrades, FULL_START, OOS_END);
    const oosMetrics = calcMetrics(oosTrades, OOS_START, OOS_END);
    const isMetrics = calcMetrics(isTrades, FULL_START, OOS_START);

    filterResults.push({ name: f.name, type: f.type, oosTrades, oosMetrics, fullTrades, fullMetrics });

    console.log(`  ${f.desc}`);
    console.log(`  IS:   ${fmtMetrics(isMetrics)}`);
    console.log(`  OOS:  ${fmtMetrics(oosMetrics)}`);
    console.log(`  FULL: ${fmtMetrics(fullMetrics)}`);
  }

  // ─── Summary Table ────────────────────────────────────────────────
  console.log("\n" + "=".repeat(120));
  console.log("OOS COMPARISON TABLE (2025-09-01 to 2026-03-26)");
  console.log("=".repeat(120));
  console.log(
    "Filter".padEnd(22) +
    "Trades".padStart(8) +
    "WR%".padStart(8) +
    "PF".padStart(8) +
    "Sharpe".padStart(8) +
    "$/day".padStart(10) +
    "Total$".padStart(10) +
    "MaxDD$".padStart(10) +
    "  Delta vs Base"
  );
  console.log("-".repeat(120));

  const baseOOS = filterResults[0].oosMetrics;

  for (const fr of filterResults) {
    const m = fr.oosMetrics;
    const delta = m.perDay - baseOOS.perDay;
    const deltaPct = baseOOS.perDay !== 0 ? ((delta / Math.abs(baseOOS.perDay)) * 100).toFixed(1) : "N/A";
    console.log(
      fr.name.padEnd(22) +
      String(m.n).padStart(8) +
      m.wr.toFixed(1).padStart(8) +
      m.pf.toFixed(2).padStart(8) +
      m.sharpe.toFixed(2).padStart(8) +
      m.perDay.toFixed(2).padStart(10) +
      m.total.toFixed(2).padStart(10) +
      m.dd.toFixed(2).padStart(10) +
      `  ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} (${delta >= 0 ? "+" : ""}${deltaPct}%)`
    );
  }

  // ─── Find Best Filter ─────────────────────────────────────────────
  const bestFilter = filterResults.reduce((best, cur) =>
    cur.oosMetrics.perDay > best.oosMetrics.perDay ? cur : best
  );

  console.log(`\nBest filter: ${bestFilter.name} (OOS $/day = ${bestFilter.oosMetrics.perDay.toFixed(2)})`);

  // ─── Per-Pair Breakdown for Best Filter ───────────────────────────
  console.log("\n" + "=".repeat(120));
  console.log(`PER-PAIR OOS BREAKDOWN: ${bestFilter.name}`);
  console.log("=".repeat(120));
  console.log(
    "Pair".padEnd(8) +
    "Trades".padStart(8) +
    "Longs".padStart(8) +
    "Shorts".padStart(8) +
    "WR%".padStart(8) +
    "PF".padStart(8) +
    "Total$".padStart(10) +
    "AvgPnl$".padStart(10) +
    "MaxDD$".padStart(10) +
    "  Exits"
  );
  console.log("-".repeat(120));

  const pairBreakdown: { pair: string; trades: Tr[]; metrics: Metrics }[] = [];

  for (const pair of PAIRS) {
    const pairTrades = bestFilter.oosTrades.filter(t => t.pair === pair);
    if (pairTrades.length === 0) {
      pairBreakdown.push({ pair, trades: [], metrics: { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 } });
      continue;
    }
    const m = calcMetrics(pairTrades, OOS_START, OOS_END);
    pairBreakdown.push({ pair, trades: pairTrades, metrics: m });
  }

  // Sort by total pnl descending
  pairBreakdown.sort((a, b) => b.metrics.total - a.metrics.total);

  for (const pb of pairBreakdown) {
    const m = pb.metrics;
    if (m.n === 0) {
      console.log(`${pb.pair.padEnd(8)}${String(0).padStart(8)}${"--".padStart(8)}${"--".padStart(8)}${"--".padStart(8)}${"--".padStart(8)}${"--".padStart(10)}${"--".padStart(10)}${"--".padStart(10)}  (no trades)`);
      continue;
    }
    const longs = pb.trades.filter(t => t.dir === "long").length;
    const shorts = pb.trades.filter(t => t.dir === "short").length;
    const avgPnl = m.total / m.n;

    // Exit reasons
    const reasons = new Map<string, number>();
    for (const t of pb.trades) {
      reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
    }
    const exitStr = [...reasons.entries()].map(([r, n]) => `${r}:${n}`).join(" ");

    console.log(
      pb.pair.padEnd(8) +
      String(m.n).padStart(8) +
      String(longs).padStart(8) +
      String(shorts).padStart(8) +
      m.wr.toFixed(1).padStart(8) +
      m.pf.toFixed(2).padStart(8) +
      m.total.toFixed(2).padStart(10) +
      avgPnl.toFixed(3).padStart(10) +
      m.dd.toFixed(2).padStart(10) +
      `  ${exitStr}`
    );
  }

  // ─── Long vs Short Split for Best Filter ──────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log(`LONG vs SHORT OOS SPLIT: ${bestFilter.name}`);
  console.log("=".repeat(80));

  const longTrades = bestFilter.oosTrades.filter(t => t.dir === "long");
  const shortTrades = bestFilter.oosTrades.filter(t => t.dir === "short");
  const longM = calcMetrics(longTrades, OOS_START, OOS_END);
  const shortM = calcMetrics(shortTrades, OOS_START, OOS_END);

  console.log(`  LONG:  ${fmtMetrics(longM)}`);
  console.log(`  SHORT: ${fmtMetrics(shortM)}`);

  // ─── Per-Pair Comparison: Baseline vs Best ────────────────────────
  if (bestFilter.type !== "baseline") {
    console.log("\n" + "=".repeat(100));
    console.log(`PER-PAIR DELTA: ${bestFilter.name} vs BASELINE (OOS)`);
    console.log("=".repeat(100));
    console.log(
      "Pair".padEnd(8) +
      "Base N".padStart(8) +
      "Base $".padStart(10) +
      "Filt N".padStart(8) +
      "Filt $".padStart(10) +
      "Delta $".padStart(10) +
      "Skipped".padStart(10)
    );
    console.log("-".repeat(100));

    const baseTrades = filterResults[0].oosTrades;
    for (const pair of [...PAIRS].sort()) {
      const bpt = baseTrades.filter(t => t.pair === pair);
      const fpt = bestFilter.oosTrades.filter(t => t.pair === pair);
      const bTotal = bpt.reduce((s, t) => s + t.pnl, 0);
      const fTotal = fpt.reduce((s, t) => s + t.pnl, 0);
      const delta = fTotal - bTotal;
      const skipped = bpt.length - fpt.length;

      console.log(
        pair.padEnd(8) +
        String(bpt.length).padStart(8) +
        bTotal.toFixed(2).padStart(10) +
        String(fpt.length).padStart(8) +
        fTotal.toFixed(2).padStart(10) +
        `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`.padStart(10) +
        String(skipped >= 0 ? `+${skipped}` : skipped).padStart(10)
      );
    }
  }

  // ─── Regime Specialist Validation ─────────────────────────────────
  console.log("\n" + "=".repeat(100));
  console.log("REGIME SPECIALIST VALIDATION (OOS shorts only)");
  console.log("=".repeat(100));
  console.log("Checking: APT/SOL/ETH/LINK (avoid shorts) vs WLD/OP/TRUMP/WIF (prioritize shorts)\n");

  const strengthPairs = ["APT", "SOL", "ETH", "LINK"];
  const weaknessPairs = ["WLD", "OP", "TRUMP", "WIF"];

  for (const fr of filterResults) {
    const shorts = fr.oosTrades.filter(t => t.dir === "short");
    const strengthShorts = shorts.filter(t => strengthPairs.includes(t.pair));
    const weaknessShorts = shorts.filter(t => weaknessPairs.includes(t.pair));

    const sPnl = strengthShorts.reduce((s, t) => s + t.pnl, 0);
    const wPnl = weaknessShorts.reduce((s, t) => s + t.pnl, 0);

    console.log(`${fr.name}:`);
    console.log(`  Strength shorts (avoid):     N=${strengthShorts.length}  PnL=$${sPnl.toFixed(2)}  WR=${strengthShorts.length > 0 ? (strengthShorts.filter(t => t.pnl > 0).length / strengthShorts.length * 100).toFixed(1) : "0.0"}%`);
    console.log(`  Weakness shorts (prioritize): N=${weaknessShorts.length}  PnL=$${wPnl.toFixed(2)}  WR=${weaknessShorts.length > 0 ? (weaknessShorts.filter(t => t.pnl > 0).length / weaknessShorts.length * 100).toFixed(1) : "0.0"}%`);
  }
}

main();
