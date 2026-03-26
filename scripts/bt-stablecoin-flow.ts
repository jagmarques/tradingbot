/**
 * Stablecoin Supply Flow as Macro Trading Filter
 *
 * Tests stablecoin market cap rate-of-change as a macro regime filter
 * overlaid on Supertrend(14, 1.75) base strategy.
 *
 * Signal: 7-day rate of change of total stablecoin supply (DefiLlama API)
 *   Rising (>+0.5% weekly) = capital inflow = BULLISH
 *   Falling (<-0.5% weekly) = capital outflow = BEARISH
 *   Flat = NEUTRAL
 *
 * Variants:
 * 0. Baseline: Supertrend(14,1.75) no filter
 * A. Stablecoin filter: longs when rising, shorts when falling
 * B. Combined stablecoin + BTC 30d momentum
 * C. Position sizing by flow strength
 *
 * Data: 5m candles from /tmp/bt-pair-cache-5m/, aggregated to 4h.
 * Full: depends on stablecoin data | OOS: 2025-09-01
 *
 * Cost: Taker 0.035%, standard spread map, 1.5x SL slippage, 10x lev, $3 margin.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const STABLE_CACHE = "/tmp/stablecoin-supply-cache.json";
const LEV = 10;
const BASE_SIZE = 3; // $3 margin
const NOT = BASE_SIZE * LEV; // $30 notional
const FEE_TAKER = 0.00035;
const DAY = 86_400_000;
const HOUR = 3_600_000;

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
  et: number; xt: number; pnl: number; reason: string; sz: number;
}

// ─── Stablecoin Data ────────────────────────────────────────────────
interface StableDay {
  ts: number;       // ms timestamp
  totalUSD: number; // total circulating stablecoin supply in USD
}

interface StableSignal {
  ts: number;
  roc7d: number;      // 7-day rate of change as fraction (0.01 = 1%)
  regime: "bullish" | "bearish" | "neutral";
  strength: number;   // abs(roc7d) for sizing
}

async function fetchStablecoinData(): Promise<StableDay[]> {
  // Check cache first (valid for 24h)
  if (fs.existsSync(STABLE_CACHE)) {
    const stat = fs.statSync(STABLE_CACHE);
    const age = Date.now() - stat.mtimeMs;
    if (age < 24 * HOUR) {
      console.log("  Using cached stablecoin data");
      const cached = JSON.parse(fs.readFileSync(STABLE_CACHE, "utf8"));
      return cached;
    }
  }

  console.log("  Fetching from DefiLlama API...");
  const resp = await fetch("https://stablecoins.llama.fi/stablecoincharts/all");
  if (!resp.ok) throw new Error(`DefiLlama API failed: ${resp.status}`);
  const raw = await resp.json() as any[];

  const data: StableDay[] = raw
    .filter((d: any) => d.totalCirculatingUSD?.peggedUSD)
    .map((d: any) => ({
      ts: Number(d.date) * 1000, // convert seconds to ms
      totalUSD: d.totalCirculatingUSD.peggedUSD,
    }))
    .sort((a: StableDay, b: StableDay) => a.ts - b.ts);

  // Cache
  fs.writeFileSync(STABLE_CACHE, JSON.stringify(data));
  console.log(`  Cached ${data.length} daily entries`);

  return data;
}

function buildStableSignals(data: StableDay[]): StableSignal[] {
  const signals: StableSignal[] = [];
  for (let i = 7; i < data.length; i++) {
    const cur = data[i].totalUSD;
    const prev = data[i - 7].totalUSD;
    if (prev <= 0) continue;
    const roc7d = (cur - prev) / prev;

    let regime: "bullish" | "bearish" | "neutral" = "neutral";
    if (roc7d > 0.005) regime = "bullish";       // >0.5% weekly inflow
    else if (roc7d < -0.005) regime = "bearish";  // <-0.5% weekly outflow

    signals.push({ ts: data[i].ts, roc7d, regime, strength: Math.abs(roc7d) });
  }
  return signals;
}

function getStableRegimeAtTime(signals: StableSignal[], t: number): StableSignal | null {
  // Binary search for latest signal <= t
  let lo = 0, hi = signals.length - 1;
  if (hi < 0 || signals[0].ts > t) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (signals[mid].ts <= t) lo = mid;
    else hi = mid - 1;
  }
  // Only use if signal is within 2 days (daily data, allow some gap)
  if (t - signals[lo].ts > 2 * DAY) return null;
  return signals[lo];
}

// ─── BTC Momentum ───────────────────────────────────────────────────
interface BTCMomentum {
  ts: number;
  ret30d: number; // 30-day return
}

function buildBTCMomentum(btcDaily: C[]): BTCMomentum[] {
  const mom: BTCMomentum[] = [];
  for (let i = 30; i < btcDaily.length; i++) {
    const ret30d = (btcDaily[i].c - btcDaily[i - 30].c) / btcDaily[i - 30].c;
    mom.push({ ts: btcDaily[i].t, ret30d });
  }
  return mom;
}

function getBTCMomentumAtTime(mom: BTCMomentum[], t: number): number | null {
  let lo = 0, hi = mom.length - 1;
  if (hi < 0 || mom[0].ts > t) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (mom[mid].ts <= t) lo = mid;
    else hi = mid - 1;
  }
  if (t - mom[lo].ts > 2 * DAY) return null;
  return mom[lo].ret30d;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +(b[5] ?? 0) }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0) },
  ).sort((a: C, b: C) => a.t - b.t);
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
      v: bars.reduce((s, b) => s + b.v, 0),
    });
  }
  return daily;
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

// ─── Cost / PnL ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long" | "short", isSL: boolean, notional: number): number {
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

// ─── Strategy Variants ──────────────────────────────────────────────
type Variant = "baseline" | "stablecoin" | "combined" | "sizing";

interface StrategyConfig {
  name: string;
  variant: Variant;
}

function runStrategy(
  pairData: Map<string, { cs4h: C[]; stDir: number[]; atr: number[] }>,
  stableSignals: StableSignal[],
  btcMom: BTCMomentum[],
  config: StrategyConfig,
  startTs: number,
  endTs: number,
): Tr[] {
  const trades: Tr[] = [];

  for (const pair of PAIRS) {
    const pd = pairData.get(pair);
    if (!pd) continue;
    const { cs4h, stDir, atr } = pd;

    let pos: {
      dir: "long" | "short"; ep: number; et: number;
      sl: number; notional: number;
    } | null = null;

    for (let i = 15; i < cs4h.length; i++) {
      if (cs4h[i].t > endTs && !pos) continue;

      const prevDir = stDir[i - 1];
      const prevPrevDir = i >= 2 ? stDir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // Manage open position
      if (pos) {
        const bar = cs4h[i];
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
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, isSL, pos.notional);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({
              pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
              pnl, reason, sz: pos.notional / LEV,
            });
          }
          pos = null;
        }
      }

      // Entry
      if (!pos && flipped && cs4h[i].t >= startTs && cs4h[i].t < endTs) {
        const newDir: "long" | "short" = prevDir === 1 ? "long" : "short";
        const ep = cs4h[i].o;
        const curATR = atr[i - 1] || atr[i - 2] || 0;
        const slDist = Math.min(3 * curATR, ep * 0.035);
        const sl = newDir === "long" ? ep - slDist : ep + slDist;

        // Get stablecoin regime at entry time
        const stableSig = getStableRegimeAtTime(stableSignals, cs4h[i].t);
        const btcRet = getBTCMomentumAtTime(btcMom, cs4h[i].t);

        let notional = NOT; // default $30

        if (config.variant === "stablecoin") {
          // Variant A: Stablecoin filter only
          // Allow longs when supply rising, shorts when falling
          if (!stableSig) continue; // no data = skip
          if (newDir === "long" && stableSig.regime !== "bullish") continue;
          if (newDir === "short" && stableSig.regime !== "bearish") continue;
        } else if (config.variant === "combined") {
          // Variant B: Stablecoin + BTC momentum
          if (!stableSig || btcRet === null) continue;
          if (newDir === "long" && !(stableSig.regime === "bullish" && btcRet > 0)) continue;
          if (newDir === "short" && !(stableSig.regime === "bearish" && btcRet < 0)) continue;
        } else if (config.variant === "sizing") {
          // Variant C: Position sizing by flow strength
          // Base size when neutral, 1.5x when moderate flow, 2x when strong flow
          if (stableSig) {
            const absRoc = stableSig.strength;
            if (absRoc > 0.02) {
              // Strong flow (>2% weekly): 2x size, only in flow direction
              if (newDir === "long" && stableSig.regime === "bullish") notional = NOT * 2;
              else if (newDir === "short" && stableSig.regime === "bearish") notional = NOT * 2;
              else if (newDir === "long" && stableSig.regime === "bearish") notional = NOT * 0.5;
              else if (newDir === "short" && stableSig.regime === "bullish") notional = NOT * 0.5;
            } else if (absRoc > 0.005) {
              // Moderate flow (0.5-2% weekly): 1.5x with flow, 0.75x against
              if (newDir === "long" && stableSig.regime === "bullish") notional = NOT * 1.5;
              else if (newDir === "short" && stableSig.regime === "bearish") notional = NOT * 1.5;
              else if (newDir === "long" && stableSig.regime === "bearish") notional = NOT * 0.75;
              else if (newDir === "short" && stableSig.regime === "bullish") notional = NOT * 0.75;
            }
            // Neutral = keep base NOT
          }
        }
        // variant "baseline" has no filter, keeps default notional

        pos = { dir: newDir, ep, et: cs4h[i].t, sl, notional };
      }
    }

    // Close open position at end
    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = cs4h[cs4h.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false, pos.notional);
      trades.push({
        pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t,
        pnl, reason: "end", sz: pos.notional / LEV,
      });
    }
  }

  return trades;
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log("=== Stablecoin Supply Flow as Macro Trading Filter ===");
  console.log(`Pairs: ${PAIRS.join(", ")}`);
  console.log(`Notional: $${NOT} (${LEV}x, $${BASE_SIZE} margin)`);
  console.log(`Cost: Taker ${FEE_TAKER * 100}%, spread map, 1.5x SL slip`);
  console.log();

  // Step 1: Download stablecoin supply data
  console.log("--- Step 1: Stablecoin Supply Data ---");
  const stableData = await fetchStablecoinData();
  const firstDate = new Date(stableData[0].ts).toISOString().slice(0, 10);
  const lastDate = new Date(stableData[stableData.length - 1].ts).toISOString().slice(0, 10);
  console.log(`  Range: ${firstDate} to ${lastDate} (${stableData.length} days)`);
  console.log(`  Latest supply: $${(stableData[stableData.length - 1].totalUSD / 1e9).toFixed(1)}B`);

  // Show some recent data points
  const recent = stableData.slice(-10);
  console.log("  Last 10 days:");
  for (const d of recent) {
    const dt = new Date(d.ts).toISOString().slice(0, 10);
    console.log(`    ${dt}: $${(d.totalUSD / 1e9).toFixed(2)}B`);
  }

  // Step 2: Build signals
  console.log("\n--- Step 2: Stablecoin Signal ---");
  const stableSignals = buildStableSignals(stableData);
  console.log(`  Total signal days: ${stableSignals.length}`);

  // Count regimes
  let bullCount = 0, bearCount = 0, neutCount = 0;
  for (const s of stableSignals) {
    if (s.regime === "bullish") bullCount++;
    else if (s.regime === "bearish") bearCount++;
    else neutCount++;
  }
  const totalSig = bullCount + bearCount + neutCount;
  console.log(`  Bullish (>+0.5% weekly): ${bullCount} days (${(bullCount / totalSig * 100).toFixed(1)}%)`);
  console.log(`  Bearish (<-0.5% weekly): ${bearCount} days (${(bearCount / totalSig * 100).toFixed(1)}%)`);
  console.log(`  Neutral: ${neutCount} days (${(neutCount / totalSig * 100).toFixed(1)}%)`);

  // Show regime in OOS period
  const oosSignals = stableSignals.filter(s => s.ts >= OOS_START && s.ts < OOS_END);
  let oosBull = 0, oosBear = 0, oosNeut = 0;
  for (const s of oosSignals) {
    if (s.regime === "bullish") oosBull++;
    else if (s.regime === "bearish") oosBear++;
    else oosNeut++;
  }
  const oosTotal = oosBull + oosBear + oosNeut;
  console.log(`\n  OOS period regimes (2025-09-01 to 2026-03-26):`);
  console.log(`    Bullish: ${oosBull} days (${oosTotal > 0 ? (oosBull / oosTotal * 100).toFixed(1) : 0}%)`);
  console.log(`    Bearish: ${oosBear} days (${oosTotal > 0 ? (oosBear / oosTotal * 100).toFixed(1) : 0}%)`);
  console.log(`    Neutral: ${oosNeut} days (${oosTotal > 0 ? (oosNeut / oosTotal * 100).toFixed(1) : 0}%)`);

  // Show some RoC values around OOS start
  const aroundOos = stableSignals.filter(s => Math.abs(s.ts - OOS_START) < 30 * DAY);
  if (aroundOos.length > 0) {
    console.log("\n  Signal around OOS start (Aug-Sep 2025):");
    for (const s of aroundOos.slice(0, 15)) {
      const dt = new Date(s.ts).toISOString().slice(0, 10);
      console.log(`    ${dt}: 7d RoC=${(s.roc7d * 100).toFixed(3)}% -> ${s.regime}`);
    }
  }

  // Step 3: Load candle data
  console.log("\n--- Step 3: Loading Candle Data ---");
  const pairData = new Map<string, { cs4h: C[]; stDir: number[]; atr: number[] }>();

  for (const pair of PAIRS) {
    const raw5m = load5m(pair);
    if (raw5m.length < 1000) { console.log(`  SKIP ${pair}: only ${raw5m.length} 5m bars`); continue; }
    const cs4h = aggregateTo4h(raw5m);
    if (cs4h.length < 100) { console.log(`  SKIP ${pair}: only ${cs4h.length} 4h bars`); continue; }

    const { dir } = calcSupertrend(cs4h, 14, 1.75);
    const atr = calcATR(cs4h, 14);

    pairData.set(pair, { cs4h, stDir: dir, atr });
    console.log(`  ${pair}: ${cs4h.length} 4h bars`);
  }

  // Build BTC momentum for variant B
  console.log("\nBuilding BTC 30d momentum...");
  const btcRaw = load5m("BTC");
  const btcDaily = aggregateToDaily(btcRaw);
  const btcMom = buildBTCMomentum(btcDaily);
  console.log(`  BTC: ${btcDaily.length} daily bars, ${btcMom.length} momentum values`);

  // Determine full start based on stablecoin data availability vs candle data
  const dataStart = Math.max(FULL_START, stableSignals[0]?.ts ?? FULL_START);
  const dataStartDate = new Date(dataStart).toISOString().slice(0, 10);
  console.log(`\nEffective full-period start: ${dataStartDate}`);

  // Step 4: Run strategies
  console.log("\n--- Step 4: Backtesting ---");

  const STRATEGIES: StrategyConfig[] = [
    { name: "0. Baseline (no filter)", variant: "baseline" },
    { name: "A. Stablecoin Filter", variant: "stablecoin" },
    { name: "B. Stable + BTC Mom", variant: "combined" },
    { name: "C. Flow-Sized", variant: "sizing" },
  ];

  const allResults: {
    name: string;
    oos: Metrics;
    full: Metrics;
    oosTrades: Tr[];
    fullTrades: Tr[];
  }[] = [];

  for (const strat of STRATEGIES) {
    console.log(`  Running ${strat.name}...`);
    const trades = runStrategy(pairData, stableSignals, btcMom, strat, dataStart, OOS_END);
    const oosTrades = trades.filter(t => t.et >= OOS_START);
    const fullTrades = trades;

    const oosM = calcMetrics(oosTrades, OOS_START, OOS_END);
    const fullM = calcMetrics(fullTrades, dataStart, OOS_END);

    allResults.push({ name: strat.name, oos: oosM, full: fullM, oosTrades, fullTrades });
    console.log(`    Full: ${fullTrades.length} trades | OOS: ${oosTrades.length} trades`);
  }

  // ─── Results ────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(100));
  console.log("RESULTS");
  console.log("=".repeat(100));

  const header =
    "Strategy".padEnd(30) +
    "Trades".padStart(7) +
    "WR%".padStart(8) +
    "PF".padStart(7) +
    "Sharpe".padStart(8) +
    "$/day".padStart(8) +
    "Total$".padStart(10) +
    "MaxDD$".padStart(10);

  // OOS
  console.log(`\n--- OOS Results (2025-09-01 to 2026-03-26) ---\n`);
  console.log(header);
  console.log("-".repeat(88));
  for (const r of allResults) {
    const m = r.oos;
    console.log(
      r.name.padEnd(30) +
      String(m.n).padStart(7) +
      m.wr.toFixed(1).padStart(8) +
      m.pf.toFixed(2).padStart(7) +
      m.sharpe.toFixed(2).padStart(8) +
      m.perDay.toFixed(2).padStart(8) +
      m.total.toFixed(2).padStart(10) +
      m.dd.toFixed(2).padStart(10),
    );
  }

  // Full
  console.log(`\n--- Full Period Results (${dataStartDate} to 2026-03-26) ---\n`);
  console.log(header);
  console.log("-".repeat(88));
  for (const r of allResults) {
    const m = r.full;
    console.log(
      r.name.padEnd(30) +
      String(m.n).padStart(7) +
      m.wr.toFixed(1).padStart(8) +
      m.pf.toFixed(2).padStart(7) +
      m.sharpe.toFixed(2).padStart(8) +
      m.perDay.toFixed(2).padStart(8) +
      m.total.toFixed(2).padStart(10) +
      m.dd.toFixed(2).padStart(10),
    );
  }

  // OOS vs Baseline comparison
  console.log("\n--- OOS Improvement vs Baseline ---\n");
  const baseOOS = allResults[0].oos;
  for (let i = 1; i < allResults.length; i++) {
    const r = allResults[i];
    const m = r.oos;
    const tradeReduction = baseOOS.n > 0 ? ((baseOOS.n - m.n) / baseOOS.n * 100).toFixed(1) : "N/A";
    const wrDelta = (m.wr - baseOOS.wr).toFixed(1);
    const pfDelta = (m.pf - baseOOS.pf).toFixed(2);
    const sharpeDelta = (m.sharpe - baseOOS.sharpe).toFixed(2);
    const perDayDelta = (m.perDay - baseOOS.perDay).toFixed(2);
    const ddDelta = (baseOOS.dd - m.dd).toFixed(2); // positive = improvement

    console.log(`${r.name}:`);
    console.log(`  Trades: ${m.n} (${tradeReduction}% fewer)`);
    console.log(`  WR: ${wrDelta > "0" ? "+" : ""}${wrDelta}pp | PF: ${+pfDelta > 0 ? "+" : ""}${pfDelta} | Sharpe: ${+sharpeDelta > 0 ? "+" : ""}${sharpeDelta}`);
    console.log(`  $/day: ${+perDayDelta > 0 ? "+" : ""}${perDayDelta} | DD reduction: $${ddDelta}`);
    console.log();
  }

  // Trade direction breakdown for stablecoin variant (OOS)
  console.log("--- OOS Trade Direction Breakdown (Variant A: Stablecoin Filter) ---\n");
  const stableTrades = allResults[1].oosTrades;
  const longs = stableTrades.filter(t => t.dir === "long");
  const shorts = stableTrades.filter(t => t.dir === "short");
  console.log(`  Longs:  N=${longs.length}  WR=${longs.length > 0 ? (longs.filter(t => t.pnl > 0).length / longs.length * 100).toFixed(1) : 0}%  Total=$${longs.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
  console.log(`  Shorts: N=${shorts.length}  WR=${shorts.length > 0 ? (shorts.filter(t => t.pnl > 0).length / shorts.length * 100).toFixed(1) : 0}%  Total=$${shorts.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);

  // Trade sizing breakdown for variant C (OOS)
  console.log("\n--- OOS Sizing Breakdown (Variant C: Flow-Sized) ---\n");
  const sizeTrades = allResults[3].oosTrades;
  const sizeBuckets = new Map<string, Tr[]>();
  for (const t of sizeTrades) {
    const bucket = `$${t.sz.toFixed(1)}`;
    const arr = sizeBuckets.get(bucket) ?? [];
    arr.push(t);
    sizeBuckets.set(bucket, arr);
  }
  for (const [bucket, trs] of [...sizeBuckets.entries()].sort()) {
    const w = trs.filter(t => t.pnl > 0).length;
    const tot = trs.reduce((s, t) => s + t.pnl, 0);
    console.log(`  Size ${bucket}: N=${trs.length}  WR=${(w / trs.length * 100).toFixed(1)}%  Total=$${tot.toFixed(2)}`);
  }

  // Monthly OOS breakdown for baseline vs stablecoin filter
  console.log("\n--- Monthly OOS PnL: Baseline vs Stablecoin Filter ---\n");
  const baseOOSTrades = allResults[0].oosTrades.sort((a, b) => a.xt - b.xt);
  const stableOOSTrades = allResults[1].oosTrades.sort((a, b) => a.xt - b.xt);

  const months = new Map<string, { base: number; stable: number }>();
  for (const t of baseOOSTrades) {
    const m = new Date(t.xt).toISOString().slice(0, 7);
    const entry = months.get(m) ?? { base: 0, stable: 0 };
    entry.base += t.pnl;
    months.set(m, entry);
  }
  for (const t of stableOOSTrades) {
    const m = new Date(t.xt).toISOString().slice(0, 7);
    const entry = months.get(m) ?? { base: 0, stable: 0 };
    entry.stable += t.pnl;
    months.set(m, entry);
  }
  console.log("  Month      Baseline     Stablecoin    Delta");
  console.log("  " + "-".repeat(50));
  for (const [m, v] of [...months.entries()].sort()) {
    const delta = v.stable - v.base;
    console.log(
      `  ${m}    ${v.base >= 0 ? "+" : ""}${v.base.toFixed(2).padStart(8)}    ${v.stable >= 0 ? "+" : ""}${v.stable.toFixed(2).padStart(8)}    ${delta >= 0 ? "+" : ""}${delta.toFixed(2).padStart(8)}`,
    );
  }

  console.log("\n=== Done ===");
}

main().catch(e => { console.error(e); process.exit(1); });
