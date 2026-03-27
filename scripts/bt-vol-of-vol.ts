/**
 * Vol-of-Vol Backtest - Test volatility-of-volatility as a signal filter for Supertrend
 *
 * Idea: when volatility itself becomes volatile (unstable), big moves are coming.
 * When vol is stable (low vol-of-vol), the market is calm.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-vol-of-vol.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const SL_SLIPPAGE = 1.5;
const LEV = 10;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, AVAX: 2.55e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const WANTED_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-27").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string; dir: Dir;
  ep: number; et: number; sl: number;
  margin: number; lev: number; maxHold: number;
  atr: number; bestPnlAtr: number;
  strategy: string;
}

interface Trade {
  pair: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number; margin: number;
  strategy: string;
}

interface Stats {
  trades: number; pf: number; sharpe: number; perDay: number; wr: number;
  maxDd: number; maxDdDuration: string; recoveryDays: number;
  totalPnl: number; avgPnl: number; winners: number; losers: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(candles: C[], period: number): Bar[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const bars: Bar[] = [];
  for (const [t, cs] of groups) {
    if (cs.length === 0) continue;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of cs) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
      vol += c.v;
    }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c, v: vol });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators ─────────────────────────────────────────────────────
function atrFn(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c)
        );
    trs.push(tr);
  }
  let val = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      val += trs[i];
      if (i === period - 1) { val /= period; r[i] = val; }
    } else {
      val = (val * (period - 1) + trs[i]) / period;
      r[i] = val;
    }
  }
  return r;
}

function supertrend(bars: Bar[], atrPeriod: number, mult: number): { trend: (1 | -1 | null)[] } {
  const atrVals = atrFn(bars, atrPeriod);
  const trend: (1 | -1 | null)[] = new Array(bars.length).fill(null);
  let upperBand = 0, lowerBand = 0, prevTrend = 1;

  for (let i = 0; i < bars.length; i++) {
    const a = atrVals[i];
    if (a === null) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let ub = hl2 + mult * a;
    let lb = hl2 - mult * a;

    if (i > 0 && atrVals[i - 1] !== null) {
      if (lb > lowerBand || bars[i - 1].c < lowerBand) { /* keep lb */ } else lb = lowerBand;
      if (ub < upperBand || bars[i - 1].c > upperBand) { /* keep ub */ } else ub = upperBand;
    }

    let t: 1 | -1;
    if (prevTrend === 1) {
      t = bars[i].c < lowerBand ? -1 : 1;
    } else {
      t = bars[i].c > upperBand ? 1 : -1;
    }

    upperBand = ub;
    lowerBand = lb;
    prevTrend = t;
    trend[i] = t;
  }
  return { trend };
}

// Vol-of-vol computation
// ATR(14) = realized volatility
// Rolling 20-bar std of ATR values = vol-of-vol
// Z-score the vol-of-vol vs 100-bar history of vol-of-vol values
function computeVolOfVol(
  bars: Bar[],
  atrPeriod: number,
  vovWindow: number, // rolling std window for vol-of-vol
  zLookback: number, // z-score history window
): { atr14: (number | null)[]; vovZ: (number | null)[] } {
  const atr14 = atrFn(bars, atrPeriod);
  const vov: (number | null)[] = new Array(bars.length).fill(null);
  const vovZ: (number | null)[] = new Array(bars.length).fill(null);

  // Compute rolling std of ATR values (vol-of-vol)
  for (let i = vovWindow - 1; i < bars.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - vovWindow + 1; j <= i; j++) {
      if (atr14[j] !== null) { sum += atr14[j]!; count++; }
    }
    if (count < vovWindow * 0.8) continue; // need enough data
    const mean = sum / count;
    let ssq = 0;
    for (let j = i - vovWindow + 1; j <= i; j++) {
      if (atr14[j] !== null) { ssq += (atr14[j]! - mean) ** 2; }
    }
    vov[i] = Math.sqrt(ssq / count);
  }

  // Z-score the vol-of-vol
  for (let i = zLookback; i < bars.length; i++) {
    if (vov[i] === null) continue;
    let sum = 0, count = 0;
    for (let j = i - zLookback; j < i; j++) {
      if (vov[j] !== null) { sum += vov[j]!; count++; }
    }
    if (count < zLookback * 0.5) continue;
    const mean = sum / count;
    let ssq = 0;
    for (let j = i - zLookback; j < i; j++) {
      if (vov[j] !== null) { ssq += (vov[j]! - mean) ** 2; }
    }
    const std = Math.sqrt(ssq / count);
    if (std > 0) {
      vovZ[i] = (vov[i]! - mean) / std;
    } else {
      vovZ[i] = 0;
    }
  }

  return { atr14, vovZ };
}

// ─── Spread helper ──────────────────────────────────────────────────
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Stats ──────────────────────────────────────────────────────────
function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return {
    trades: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0,
    maxDd: 0, maxDdDuration: "0d", recoveryDays: 0, totalPnl: 0, avgPnl: 0,
    winners: 0, losers: 0,
  };

  const sorted = [...filtered].sort((a, b) => a.xt - b.xt);
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const wr = filtered.length > 0 ? wins.length / filtered.length : 0;

  const days = (endMs - startMs) / DAY;
  const perDay = totalPnl / days;

  const dailyPnl = new Map<number, number>();
  for (const t of sorted) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.pnl);
  }
  const dpVals = [...dailyPnl.values()];
  const mean = dpVals.length > 0 ? dpVals.reduce((a, b) => a + b, 0) / dpVals.length : 0;
  const std = dpVals.length > 1
    ? Math.sqrt(dpVals.reduce((s, v) => s + (v - mean) ** 2, 0) / (dpVals.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  let equity = 0, peak = 0, maxDd = 0, maxDdStart = startMs, maxDdEnd = startMs;
  let currentDdStart = startMs;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) { peak = equity; currentDdStart = t.xt; }
    const dd = peak - equity;
    if (dd > maxDd) { maxDd = dd; maxDdStart = currentDdStart; maxDdEnd = t.xt; }
  }
  const ddDurationDays = Math.round((maxDdEnd - maxDdStart) / DAY);

  let recoveryDays = 0;
  let foundTrough = false;
  equity = 0; peak = 0; let troughTime = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) {
      if (foundTrough) { recoveryDays = Math.round((t.xt - troughTime) / DAY); foundTrough = false; }
      peak = equity;
    }
    if (peak - equity >= maxDd * 0.99 && !foundTrough) { foundTrough = true; troughTime = t.xt; }
  }

  return {
    trades: filtered.length,
    pf: Math.round(pf * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    perDay: Math.round(perDay * 100) / 100,
    wr: Math.round(wr * 1000) / 10,
    maxDd: Math.round(maxDd * 100) / 100,
    maxDdDuration: `${ddDurationDays}d`,
    recoveryDays,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: filtered.length > 0 ? Math.round((totalPnl / filtered.length) * 100) / 100 : 0,
    winners: wins.length,
    losers: losses.length,
  };
}

// ─── Backtest Runner ────────────────────────────────────────────────
interface StrategyConfig {
  label: string;
  // Filter: given vovZ at signal bar, should we enter?
  entryFilter: (vovZ: number | null) => boolean;
  // Position sizing: given vovZ, return margin
  sizeFn: (vovZ: number | null) => number;
  // SL multiplier: given vovZ, return ATR multiplier for stop-loss
  slMultFn: (vovZ: number | null) => number;
}

function runBacktest(
  strategies: StrategyConfig[],
  pairH4: Map<string, Bar[]>,
  pairVovData: Map<string, { atr14: (number | null)[]; vovZ: (number | null)[] }>,
  pairSt: Map<string, (1 | -1 | null)[]>,
  available: string[],
): Map<string, Trade[]> {
  const results = new Map<string, Trade[]>();
  for (const strat of strategies) results.set(strat.label, []);

  for (const pair of available) {
    const h4 = pairH4.get(pair)!;
    const st = pairSt.get(pair)!;
    const vovData = pairVovData.get(pair)!;
    const h4Map = new Map(h4.map((b, i) => [b.t, i]));

    for (const strat of strategies) {
      const trades = results.get(strat.label)!;
      let pos: Position | null = null;

      for (let i = 2; i < h4.length; i++) {
        const bar = h4[i];
        if (bar.t < FULL_START || bar.t >= FULL_END) continue;

        // ─── Check existing position ─────────────
        if (pos) {
          // ATR trailing ladder
          const curAtr = vovData.atr14[i];
          if (curAtr !== null && pos.atr > 0) {
            const unrealPnl = pos.dir === "long"
              ? (bar.c - pos.ep) / pos.atr
              : (pos.ep - bar.c) / pos.atr;
            if (unrealPnl > pos.bestPnlAtr) pos.bestPnlAtr = unrealPnl;

            let newSl = pos.sl;
            if (pos.bestPnlAtr >= 3) {
              const trailPrice = pos.dir === "long"
                ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
                : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
              newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
            } else if (pos.bestPnlAtr >= 2) {
              const trailPrice = pos.dir === "long"
                ? bar.h - 2 * pos.atr
                : bar.l + 2 * pos.atr;
              newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
            } else if (pos.bestPnlAtr >= 1) {
              newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
            }
            pos.sl = newSl;
          }

          // Stop-loss
          let stopped = false;
          if (pos.dir === "long" && bar.l <= pos.sl) {
            closeTrade(trades, pos, pos.sl, bar.t, pair, strat.label, SL_SLIPPAGE);
            pos = null; stopped = true;
          } else if (pos.dir === "short" && bar.h >= pos.sl) {
            closeTrade(trades, pos, pos.sl, bar.t, pair, strat.label, SL_SLIPPAGE);
            pos = null; stopped = true;
          }
          if (stopped) { /* fall through to check new entry this bar */ }

          // Max hold
          if (pos && bar.t - pos.et >= pos.maxHold) {
            closeTrade(trades, pos, bar.c, bar.t, pair, strat.label, 1);
            pos = null;
          }

          // Signal flip exit
          if (pos) {
            const stNow = st[i - 1];
            if (stNow !== null) {
              if (pos.dir === "long" && stNow === -1) {
                closeTrade(trades, pos, bar.c, bar.t, pair, strat.label, 1);
                pos = null;
              } else if (pos.dir === "short" && stNow === 1) {
                closeTrade(trades, pos, bar.c, bar.t, pair, strat.label, 1);
                pos = null;
              }
            }
          }

          if (pos) continue; // still in a position, skip entry
        }

        // ─── Entry signal ────────────────────────
        const stNow = st[i - 1];
        const stPrev = st[i - 2];
        if (stNow === null || stPrev === null || stNow === stPrev) continue;

        const dir: Dir = stNow === 1 ? "long" : "short";

        // Use vol-of-vol from the completed bar (i-1) to avoid look-ahead
        const vovZVal = vovData.vovZ[i - 1];

        // Apply entry filter
        if (!strat.entryFilter(vovZVal)) continue;

        // Get ATR for stop-loss
        const atrVal = vovData.atr14[i - 1];
        if (atrVal === null) continue;

        // Position sizing
        const margin = strat.sizeFn(vovZVal);

        // SL distance
        const slMult = strat.slMultFn(vovZVal);
        const sp_ = sp(pair);
        const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
        let slDist = atrVal * slMult;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        pos = {
          pair, dir, ep, et: bar.t, sl, margin, lev: LEV,
          maxHold: 48 * H1, atr: atrVal, bestPnlAtr: 0,
          strategy: strat.label,
        };
      }

      // Close remaining position
      if (pos) {
        const lastBar = h4[h4.length - 1];
        closeTrade(trades, pos, lastBar.c, lastBar.t, pair, strat.label, 1);
      }
    }
  }

  return results;
}

function closeTrade(
  trades: Trade[], pos: Position, exitPrice: number, exitTime: number,
  pair: string, strategy: string, slippageMult: number,
) {
  const sp_ = sp(pair);
  const xp = pos.dir === "long"
    ? exitPrice * (1 - sp_ * slippageMult)
    : exitPrice * (1 + sp_ * slippageMult);
  const notional = pos.margin * pos.lev;
  const raw = pos.dir === "long"
    ? (xp / pos.ep - 1) * notional
    : (pos.ep / xp - 1) * notional;
  const cost = notional * FEE * 2;
  const pnl = raw - cost;
  trades.push({
    pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: exitTime,
    pnl, margin: pos.margin, strategy,
  });
}

// ─── Output Helpers ─────────────────────────────────────────────────
function pad(s: string, n: number): string { return s.padStart(n); }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "") + "$" + v.toFixed(2); }
function fmtPct(v: number): string { return v.toFixed(1) + "%"; }

function printHeader() {
  console.log(
    `${"Strategy".padEnd(28)} ${pad("Trades", 7)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
    `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 8)} ` +
    `${pad("DDdur", 6)} ${pad("Recov", 6)} ${pad("Total", 11)}`
  );
  console.log("-".repeat(105));
}

function printStatsLine(label: string, s: Stats) {
  console.log(
    `${label.padEnd(28)} ${pad(String(s.trades), 7)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 8)} ` +
    `${pad(s.maxDdDuration, 6)} ${pad(String(s.recoveryDays) + "d", 6)} ${pad(fmtPnl(s.totalPnl), 11)}`
  );
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("=".repeat(105));
  console.log("  VOL-OF-VOL BACKTEST");
  console.log("  4h Supertrend(14,1.75) + Vol-of-Vol signal filter");
  console.log("  ATR(14) -> 20-bar rolling std -> z-score vs 100-bar history");
  console.log("  Period: 2023-01 to 2026-03 | 18 pairs | 10x lev");
  console.log("  Cost: Taker 0.035%, standard spreads, 1.5x SL slippage");
  console.log("=".repeat(105));
  console.log();

  // Load data
  console.log("Loading 5m data...");
  const pairH4 = new Map<string, Bar[]>();
  const pairVovData = new Map<string, { atr14: (number | null)[]; vovZ: (number | null)[] }>();
  const pairSt = new Map<string, (1 | -1 | null)[]>();
  const available: string[] = [];

  for (const p of WANTED_PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 500) { console.log(`  ${p}: skipped (${m5.length} candles)`); continue; }
    const h4 = aggregate(m5, H4);
    pairH4.set(p, h4);
    pairSt.set(p, supertrend(h4, 14, 1.75).trend);
    pairVovData.set(p, computeVolOfVol(h4, 14, 20, 100));
    available.push(p);
    console.log(`  ${p}: ${h4.length} 4h bars`);
  }
  console.log(`Loaded ${available.length} pairs.\n`);

  // Print vol-of-vol distribution sample
  console.log("--- Vol-of-Vol Z-Score Distribution (last 500 bars, first pair) ---");
  const samplePair = available[0];
  const sampleVov = pairVovData.get(samplePair)!.vovZ;
  const validZ = sampleVov.filter(z => z !== null).slice(-500) as number[];
  if (validZ.length > 0) {
    const buckets = new Map<string, number>();
    for (const z of validZ) {
      let bucket: string;
      if (z < -1.5) bucket = "< -1.5";
      else if (z < -1.0) bucket = "-1.5 to -1.0";
      else if (z < -0.5) bucket = "-1.0 to -0.5";
      else if (z < 0.0) bucket = "-0.5 to  0.0";
      else if (z < 0.5) bucket = " 0.0 to  0.5";
      else if (z < 1.0) bucket = " 0.5 to  1.0";
      else if (z < 1.5) bucket = " 1.0 to  1.5";
      else bucket = "> 1.5";
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    const ordered = ["< -1.5", "-1.5 to -1.0", "-1.0 to -0.5", "-0.5 to  0.0",
                      " 0.0 to  0.5", " 0.5 to  1.0", " 1.0 to  1.5", "> 1.5"];
    for (const b of ordered) {
      const cnt = buckets.get(b) ?? 0;
      const pct = ((cnt / validZ.length) * 100).toFixed(1);
      const bar = "#".repeat(Math.round(cnt / validZ.length * 50));
      console.log(`  ${b.padEnd(16)} ${String(cnt).padStart(4)} (${pct.padStart(5)}%) ${bar}`);
    }
  }
  console.log();

  // ─── Strategy definitions ─────────────────────────────────────────

  const strategies: StrategyConfig[] = [
    // 0. BASELINE: Plain Supertrend, no vol-of-vol filter
    {
      label: "0-Baseline (no filter)",
      entryFilter: () => true,
      sizeFn: () => 5,
      slMultFn: () => 3,
    },
    // 1. Vol-of-Vol expansion entry: only enter when vovZ > 1.0
    {
      label: "1-VoV Expansion (z>1.0)",
      entryFilter: (z) => z !== null && z > 1.0,
      sizeFn: () => 5,
      slMultFn: () => 3,
    },
    // 2. Vol-of-Vol contraction entry: only enter when vovZ < -0.5
    {
      label: "2-VoV Contraction (z<-0.5)",
      entryFilter: (z) => z !== null && z < -0.5,
      sizeFn: () => 5,
      slMultFn: () => 3,
    },
    // 3. Position sizing by vol-of-vol
    {
      label: "3-VoV Size ($3/$5/$7)",
      entryFilter: () => true,
      sizeFn: (z) => {
        if (z !== null && z > 1.5) return 7;
        if (z !== null && z < -0.5) return 3;
        return 5;
      },
      slMultFn: () => 3,
    },
    // 4. Vol-of-vol as SL adjuster
    {
      label: "4-VoV SL (ATR 2/3/4)",
      entryFilter: () => true,
      sizeFn: () => 5,
      slMultFn: (z) => {
        if (z !== null && z > 1.0) return 4;   // wider stops in volatile-vol regime
        if (z !== null && z < -0.5) return 2;   // tighter stops in calm regime
        return 3;
      },
    },
    // 5. Combined: expansion filter + bigger size
    {
      label: "5-Expand+Size (z>1,m=$7)",
      entryFilter: (z) => z !== null && z > 1.0,
      sizeFn: () => 7,
      slMultFn: () => 3,
    },
    // 6. Combined: expansion filter + wider SL
    {
      label: "6-Expand+WideSL (z>1,4x)",
      entryFilter: (z) => z !== null && z > 1.0,
      sizeFn: () => 5,
      slMultFn: () => 4,
    },
    // 7. Mild expansion: z > 0.5
    {
      label: "7-Mild Expand (z>0.5)",
      entryFilter: (z) => z !== null && z > 0.5,
      sizeFn: () => 5,
      slMultFn: () => 3,
    },
    // 8. Exclude extreme vol-of-vol (between -1 and 2)
    {
      label: "8-Exclude extreme VoV",
      entryFilter: (z) => z !== null && z > -1.0 && z < 2.0,
      sizeFn: () => 5,
      slMultFn: () => 3,
    },
  ];

  // Run backtest
  console.log("Running backtests...\n");
  const allResults = runBacktest(strategies, pairH4, pairVovData, pairSt, available);

  // ─── FULL PERIOD ──────────────────────────────────────────────────
  console.log("=".repeat(105));
  console.log("  FULL PERIOD: 2023-01 to 2026-03");
  console.log("=".repeat(105));
  printHeader();
  for (const strat of strategies) {
    const trades = allResults.get(strat.label)!;
    const s = computeStats(trades, FULL_START, FULL_END);
    printStatsLine(strat.label, s);
  }

  // ─── IN-SAMPLE / OUT-OF-SAMPLE ───────────────────────────────────
  const OOS_START = new Date("2025-06-01").getTime();
  console.log("\n");
  console.log("=".repeat(105));
  console.log("  IN-SAMPLE: 2023-01 to 2025-06");
  console.log("=".repeat(105));
  printHeader();
  for (const strat of strategies) {
    const trades = allResults.get(strat.label)!;
    const s = computeStats(trades, FULL_START, OOS_START);
    printStatsLine(strat.label, s);
  }

  console.log("\n");
  console.log("=".repeat(105));
  console.log("  OUT-OF-SAMPLE: 2025-06 to 2026-03");
  console.log("=".repeat(105));
  printHeader();
  for (const strat of strategies) {
    const trades = allResults.get(strat.label)!;
    const s = computeStats(trades, OOS_START, FULL_END);
    printStatsLine(strat.label, s);
  }

  // ─── Per-pair breakdown for best strategies ───────────────────────
  console.log("\n");
  console.log("=".repeat(105));
  console.log("  PER-PAIR BREAKDOWN: Baseline vs Best Strategies");
  console.log("=".repeat(105));

  const toCompare = ["0-Baseline (no filter)", "1-VoV Expansion (z>1.0)", "2-VoV Contraction (z<-0.5)", "4-VoV SL (ATR 2/3/4)"];
  for (const stratLabel of toCompare) {
    const trades = allResults.get(stratLabel)!;
    console.log(`\n--- ${stratLabel} ---`);
    console.log(`${"Pair".padEnd(8)} ${pad("Trades", 7)} ${pad("PF", 6)} ${pad("WR", 7)} ${pad("$/day", 9)} ${pad("Total", 10)}`);
    console.log("-".repeat(50));
    for (const p of available) {
      const pt = trades.filter(t => t.pair === p);
      if (pt.length === 0) { console.log(`${p.padEnd(8)} ${pad("0", 7)}`); continue; }
      const s = computeStats(pt, FULL_START, FULL_END);
      console.log(
        `${p.padEnd(8)} ${pad(String(s.trades), 7)} ${pad(String(s.pf), 6)} ${pad(fmtPct(s.wr), 7)} ` +
        `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPnl(s.totalPnl), 10)}`
      );
    }
  }

  // ─── Vol-of-vol z-score at entry for baseline trades ──────────────
  console.log("\n");
  console.log("=".repeat(105));
  console.log("  ANALYSIS: Baseline trade PnL by VoV Z-Score bucket at entry");
  console.log("=".repeat(105));

  const baselineTrades = allResults.get("0-Baseline (no filter)")!;
  // For each baseline trade, find the vovZ at entry
  const bucketPnl = new Map<string, { wins: number; losses: number; totalPnl: number; count: number }>();
  const bucketNames = ["z<-1", "-1<z<-0.5", "-0.5<z<0", "0<z<0.5", "0.5<z<1", "z>1"];
  for (const b of bucketNames) bucketPnl.set(b, { wins: 0, losses: 0, totalPnl: 0, count: 0 });

  for (const t of baselineTrades) {
    const h4 = pairH4.get(t.pair)!;
    const vov = pairVovData.get(t.pair)!;
    // Find the bar index at entry time
    let entryIdx = -1;
    for (let j = 0; j < h4.length; j++) {
      if (h4[j].t === t.et) { entryIdx = j; break; }
    }
    if (entryIdx < 1) continue;
    const z = vov.vovZ[entryIdx - 1]; // signal bar
    if (z === null) continue;

    let bucket: string;
    if (z < -1) bucket = "z<-1";
    else if (z < -0.5) bucket = "-1<z<-0.5";
    else if (z < 0) bucket = "-0.5<z<0";
    else if (z < 0.5) bucket = "0<z<0.5";
    else if (z < 1) bucket = "0.5<z<1";
    else bucket = "z>1";

    const bkt = bucketPnl.get(bucket)!;
    bkt.count++;
    bkt.totalPnl += t.pnl;
    if (t.pnl > 0) bkt.wins++; else bkt.losses++;
  }

  console.log(`${"Bucket".padEnd(16)} ${pad("Trades", 7)} ${pad("WR", 7)} ${pad("AvgPnl", 9)} ${pad("Total", 10)}`);
  console.log("-".repeat(55));
  for (const b of bucketNames) {
    const bkt = bucketPnl.get(b)!;
    if (bkt.count === 0) {
      console.log(`${b.padEnd(16)} ${pad("0", 7)}`);
      continue;
    }
    const wr = ((bkt.wins / bkt.count) * 100).toFixed(1);
    const avg = bkt.totalPnl / bkt.count;
    console.log(
      `${b.padEnd(16)} ${pad(String(bkt.count), 7)} ${pad(wr + "%", 7)} ` +
      `${pad(fmtPnl(avg), 9)} ${pad(fmtPnl(bkt.totalPnl), 10)}`
    );
  }

  console.log("\n[Done]");
}

main();
