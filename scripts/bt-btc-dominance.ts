/**
 * BTC Dominance as a Trading Signal
 *
 * Proxy BTC dominance via BTC return vs avg altcoin return.
 * Three strategies: Dominance Trend, Dominance Reversal, Alt Season Detector.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-btc-dominance.ts
 */

import * as fs from "fs";
import * as path from "path";

// ── Constants ───────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const SL_SLIPPAGE = 1.5;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, AVAX: 2.55e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const ALT_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-27").getTime();
const MARGIN = 5;
const LEV = 10;

// ── Types ───────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string; dir: Dir;
  ep: number; et: number; sl: number;
  margin: number; lev: number; maxHold: number;
  atr: number; bestPnlAtr: number;
}

interface Trade {
  pair: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number; margin: number;
}

// ── Data Loading ────────────────────────────────────────────────────
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

// ── Indicators ──────────────────────────────────────────────────────
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

function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ── Stats ───────────────────────────────────────────────────────────
interface Stats {
  trades: number; pf: number; sharpe: number; perDay: number; wr: number;
  maxDd: number; maxDdDuration: string; totalPnl: number; avgPnl: number;
  winners: number; losers: number;
}

function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return {
    trades: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0,
    maxDd: 0, maxDdDuration: "0d", totalPnl: 0, avgPnl: 0,
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

  return {
    trades: filtered.length,
    pf: Math.round(pf * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    perDay: Math.round(perDay * 100) / 100,
    wr: Math.round(wr * 1000) / 10,
    maxDd: Math.round(maxDd * 100) / 100,
    maxDdDuration: `${ddDurationDays}d`,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round((totalPnl / filtered.length) * 100) / 100,
    winners: wins.length,
    losers: losses.length,
  };
}

function fmtStats(label: string, s: Stats): string {
  return [
    `  ${label}`,
    `    Trades: ${s.trades}  (W:${s.winners} L:${s.losers})  WR: ${s.wr}%`,
    `    PnL: $${s.totalPnl}  AvgPnl: $${s.avgPnl}  $/day: $${s.perDay}`,
    `    PF: ${s.pf}  Sharpe: ${s.sharpe}  MaxDD: $${s.maxDd} (${s.maxDdDuration})`,
  ].join("\n");
}

// ── Data structures ─────────────────────────────────────────────────
interface DailyDominance {
  t: number;
  btcRet: number;
  avgAltRet: number;
  domProxy: number;       // btcRet - avgAltRet
  dom7d: number | null;   // rolling 7-day mean of domProxy
  dom30dMean: number | null;
  dom30dStd: number | null;
  altOutperformPct14d: number | null; // % of alts outperforming BTC over 14 days
}

// ── Main ────────────────────────────────────────────────────────────
function main() {
  console.log("=== BTC DOMINANCE PROXY BACKTEST ===\n");

  // Load BTC
  const btcM5 = load5m("BTC");
  if (btcM5.length === 0) { console.log("No BTC data!"); process.exit(1); }
  const btcDaily = aggregate(btcM5, DAY);
  const btcDailyMap = new Map(btcDaily.map((b, i) => [b.t, i]));
  console.log(`BTC: ${btcDaily.length} daily bars`);

  // Load alt pairs
  const altData = new Map<string, { daily: Bar[]; h4: Bar[]; dailyMap: Map<number, number>; h4Map: Map<number, number>; }>();
  const loaded: string[] = [];
  for (const p of ALT_PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 500) continue;
    const daily = aggregate(m5, DAY);
    const h4 = aggregate(m5, H4);
    altData.set(p, {
      daily,
      h4,
      dailyMap: new Map(daily.map((b, i) => [b.t, i])),
      h4Map: new Map(h4.map((b, i) => [b.t, i])),
    });
    loaded.push(p);
  }
  console.log(`Loaded ${loaded.length} alt pairs: ${loaded.join(", ")}\n`);

  // Precompute Supertrend(14, 1.75) on 4h for each alt
  const stMap = new Map<string, { trend: (1 | -1 | null)[]; atr14: (number | null)[] }>();
  for (const p of loaded) {
    const pd = altData.get(p)!;
    stMap.set(p, {
      trend: supertrend(pd.h4, 14, 1.75).trend,
      atr14: atrFn(pd.h4, 14),
    });
  }

  // Build daily timestamps
  const allDailyTs: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    allDailyTs.push(t);
  }

  // Compute daily returns per pair and BTC
  const btcDailyRet = new Map<number, number>();
  for (let i = 1; i < btcDaily.length; i++) {
    btcDailyRet.set(btcDaily[i].t, btcDaily[i].c / btcDaily[i - 1].c - 1);
  }

  const altDailyRets = new Map<string, Map<number, number>>();
  for (const p of loaded) {
    const pd = altData.get(p)!;
    const rets = new Map<number, number>();
    for (let i = 1; i < pd.daily.length; i++) {
      rets.set(pd.daily[i].t, pd.daily[i].c / pd.daily[i - 1].c - 1);
    }
    altDailyRets.set(p, rets);
  }

  // Compute dominance metrics per day
  const domData: DailyDominance[] = [];
  const domProxyHist: number[] = [];

  // For alt outperformance: need 14-day cumulative returns
  const btcCumRet14 = new Map<number, number>();
  const altCumRet14 = new Map<string, Map<number, number>>();

  // We need to process days in order
  const orderedDays = allDailyTs.filter(t => btcDailyRet.has(t));

  for (const p of loaded) {
    altCumRet14.set(p, new Map());
  }

  for (let dayIdx = 0; dayIdx < orderedDays.length; dayIdx++) {
    const t = orderedDays[dayIdx];
    const btcR = btcDailyRet.get(t) ?? 0;

    // Avg alt return
    let altSum = 0, altCount = 0;
    for (const p of loaded) {
      const r = altDailyRets.get(p)!.get(t);
      if (r !== undefined) { altSum += r; altCount++; }
    }
    const avgAltRet = altCount > 0 ? altSum / altCount : 0;
    const domProxy = btcR - avgAltRet;
    domProxyHist.push(domProxy);

    // Rolling 7-day dominance trend
    let dom7d: number | null = null;
    if (domProxyHist.length >= 7) {
      let s = 0;
      for (let j = domProxyHist.length - 7; j < domProxyHist.length; j++) s += domProxyHist[j];
      dom7d = s / 7;
    }

    // Rolling 30-day mean and std of domProxy
    let dom30dMean: number | null = null;
    let dom30dStd: number | null = null;
    if (domProxyHist.length >= 30) {
      let s = 0, s2 = 0;
      for (let j = domProxyHist.length - 30; j < domProxyHist.length; j++) {
        s += domProxyHist[j];
        s2 += domProxyHist[j] ** 2;
      }
      dom30dMean = s / 30;
      const variance = s2 / 30 - dom30dMean ** 2;
      dom30dStd = Math.sqrt(Math.max(0, variance));
    }

    // 14-day alt outperformance %
    let altOutperformPct14d: number | null = null;
    if (dayIdx >= 13) {
      let outperformCount = 0, totalPairs = 0;
      // Compute 14-day cumulative return for BTC
      let btcCum = 1;
      for (let j = dayIdx - 13; j <= dayIdx; j++) {
        const r = btcDailyRet.get(orderedDays[j]) ?? 0;
        btcCum *= (1 + r);
      }
      const btc14dRet = btcCum - 1;

      for (const p of loaded) {
        let altCum = 1;
        let valid = true;
        for (let j = dayIdx - 13; j <= dayIdx; j++) {
          const r = altDailyRets.get(p)!.get(orderedDays[j]);
          if (r === undefined) { valid = false; break; }
          altCum *= (1 + r);
        }
        if (!valid) continue;
        totalPairs++;
        if (altCum - 1 > btc14dRet) outperformCount++;
      }
      if (totalPairs > 0) altOutperformPct14d = outperformCount / totalPairs;
    }

    domData.push({ t, btcRet: btcR, avgAltRet, domProxy, dom7d, dom30dMean, dom30dStd, altOutperformPct14d });
  }

  // Index domData by timestamp
  const domMap = new Map<number, DailyDominance>();
  for (const d of domData) domMap.set(d.t, d);

  console.log(`Dominance data: ${domData.length} days computed`);

  // Quick summary of dominance proxy
  const domVals = domData.map(d => d.domProxy);
  const domMean = domVals.reduce((a, b) => a + b, 0) / domVals.length;
  const domStdAll = Math.sqrt(domVals.reduce((s, v) => s + (v - domMean) ** 2, 0) / domVals.length);
  console.log(`Dominance proxy -- Mean: ${(domMean * 100).toFixed(4)}%  Std: ${(domStdAll * 100).toFixed(4)}%`);
  const dom7dVals = domData.filter(d => d.dom7d !== null).map(d => d.dom7d!);
  const dom7dPos = dom7dVals.filter(v => v > 0).length;
  console.log(`7-day dom trend: ${dom7dPos}/${dom7dVals.length} days positive (${(dom7dPos / dom7dVals.length * 100).toFixed(1)}%)`);
  const altSeasonDays = domData.filter(d => d.altOutperformPct14d !== null && d.altOutperformPct14d > 0.75).length;
  const btcSeasonDays = domData.filter(d => d.altOutperformPct14d !== null && d.altOutperformPct14d! < 0.25).length;
  console.log(`Alt season (>75% outperform): ${altSeasonDays} days  |  BTC season (<25%): ${btcSeasonDays} days\n`);

  // ── Helper: get H4 bar index ──────────────────────────────────────
  function getH4i(pair: string, h4T: number): number {
    const pd = altData.get(pair)!;
    const idx = pd.h4Map.get(h4T);
    if (idx !== undefined) return idx;
    for (let dt = H4; dt <= 10 * H4; dt += H4) {
      const idx2 = pd.h4Map.get(h4T - dt);
      if (idx2 !== undefined) return idx2;
    }
    return -1;
  }

  // ── Backtest engine ───────────────────────────────────────────────
  function runStrategy(
    label: string,
    shouldEnter: (pair: string, dayT: number, h4T: number, h4i: number, stDir: 1 | -1) => Dir | null,
    maxHoldDays: number,
  ): Trade[] {
    const positions = new Map<string, Position>();
    const trades: Trade[] = [];

    for (const dayT of allDailyTs) {
      // Check existing positions -- exits
      for (const [key, pos] of [...positions.entries()]) {
        const pd = altData.get(pos.pair);
        if (!pd) continue;

        // Use 4h bars for intraday SL checks
        for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
          const h4T = dayT + h4Off;
          const h4i = getH4i(pos.pair, h4T);
          if (h4i < 0) continue;
          const bar = pd.h4[h4i];

          // Stop-loss
          if (pos.dir === "long" && bar.l <= pos.sl) {
            closePos(positions, trades, key, pos.sl, h4T, pos);
            break;
          } else if (pos.dir === "short" && bar.h >= pos.sl) {
            closePos(positions, trades, key, pos.sl, h4T, pos);
            break;
          }
        }
        if (!positions.has(key)) continue;

        // Max hold
        const pd2 = altData.get(pos.pair)!;
        const di = pd2.dailyMap.get(dayT);
        if (di !== undefined && dayT - pos.et >= maxHoldDays * DAY) {
          closePos(positions, trades, key, pd2.daily[di].c, dayT, pos);
          continue;
        }

        // ATR trailing (breakeven + ladder)
        if (di !== undefined && pos.atr > 0) {
          const bar = pd2.daily[di];
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
      }

      // Entries -- scan 4h bars in the day
      for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
        const h4T = dayT + h4Off;
        for (const p of loaded) {
          const key = `${label}:${p}`;
          if (positions.has(key)) continue;

          const pd = altData.get(p)!;
          const st = stMap.get(p)!;
          const h4i = pd.h4Map.get(h4T);
          if (h4i === undefined || h4i < 21) continue;

          const stNow = st.trend[h4i - 1];
          const stPrev = st.trend[h4i - 2];
          if (stNow === null || stPrev === null) continue;

          // Only enter on Supertrend flip
          if (stNow === stPrev) continue;

          const stDir = stNow; // 1 = bullish, -1 = bearish

          const dir = shouldEnter(p, dayT, h4T, h4i, stDir);
          if (!dir) continue;

          const atrVal = st.atr14[h4i - 1];
          if (atrVal === null) continue;

          const sp_ = sp(p);
          const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);
          let slDist = atrVal * 3;
          if (slDist / ep > 0.035) slDist = ep * 0.035;
          const sl = dir === "long" ? ep - slDist : ep + slDist;

          positions.set(key, {
            pair: p, dir, ep, et: h4T, sl,
            margin: MARGIN, lev: LEV, maxHold: maxHoldDays * DAY,
            atr: atrVal, bestPnlAtr: 0,
          });
        }
      }
    }

    // Close remaining
    for (const [key, pos] of [...positions.entries()]) {
      const pd = altData.get(pos.pair);
      if (!pd || pd.daily.length === 0) continue;
      const lastBar = pd.daily[pd.daily.length - 1];
      closePos(positions, trades, key, lastBar.c, lastBar.t, pos);
    }

    return trades;
  }

  function closePos(
    positions: Map<string, Position>, trades: Trade[],
    key: string, exitPrice: number, exitTime: number, pos: Position, slippageMult: number = 1,
  ) {
    const sp_ = sp(pos.pair);
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
      pair: pos.pair, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl, margin: pos.margin,
    });
    positions.delete(key);
  }

  // ════════════════════════════════════════════════════════════════════
  // STRATEGY 0: BASELINE -- Pure Supertrend(14, 1.75) with no filter
  // ════════════════════════════════════════════════════════════════════
  console.log("Running Strategy 0: Baseline Supertrend (no filter)...");
  const trades0 = runStrategy("S0", (_pair, _dayT, _h4T, _h4i, stDir) => {
    return stDir === 1 ? "long" : "short";
  }, 60);

  // ════════════════════════════════════════════════════════════════════
  // STRATEGY 1: DOMINANCE TREND
  // 7-day dom > 0 (BTC outperforming) => short alts only
  // 7-day dom < 0 (alts outperforming) => long alts only
  // ════════════════════════════════════════════════════════════════════
  console.log("Running Strategy 1: Dominance Trend filter on Supertrend...");
  const trades1 = runStrategy("S1", (_pair, dayT, _h4T, _h4i, stDir) => {
    // Use previous day's dominance data (no look-ahead)
    const prevDay = Math.floor((dayT - DAY) / DAY) * DAY;
    const dom = domMap.get(prevDay);
    if (!dom || dom.dom7d === null) return null;

    if (dom.dom7d > 0) {
      // BTC outperforming => only short alts
      return stDir === -1 ? "short" : null;
    } else {
      // Alts outperforming => only long alts
      return stDir === 1 ? "long" : null;
    }
  }, 60);

  // ════════════════════════════════════════════════════════════════════
  // STRATEGY 2: DOMINANCE REVERSAL
  // When domProxy hits extreme (>2 std from 30-day mean), fade it
  // Extreme BTC outperformance => long alts (reversion)
  // Extreme alt outperformance => short alts (reversion)
  // Still use Supertrend for timing
  // ════════════════════════════════════════════════════════════════════
  console.log("Running Strategy 2: Dominance Reversal on Supertrend...");
  const trades2 = runStrategy("S2", (_pair, dayT, _h4T, _h4i, stDir) => {
    const prevDay = Math.floor((dayT - DAY) / DAY) * DAY;
    const dom = domMap.get(prevDay);
    if (!dom || dom.dom30dMean === null || dom.dom30dStd === null || dom.dom30dStd === 0) return null;

    const zScore = (dom.domProxy - dom.dom30dMean) / dom.dom30dStd;

    if (zScore > 2) {
      // Extreme BTC outperformance => fade, go long alts
      return stDir === 1 ? "long" : null;
    } else if (zScore < -2) {
      // Extreme alt outperformance => fade, go short alts
      return stDir === -1 ? "short" : null;
    }
    // No extreme => take any Supertrend signal
    return stDir === 1 ? "long" : "short";
  }, 60);

  // ════════════════════════════════════════════════════════════════════
  // STRATEGY 3: ALT SEASON DETECTOR
  // >75% alts outperform BTC over 14d => alt season, long aggressively
  // <25% outperform => BTC season, short alts
  // Between => take any Supertrend signal
  // ════════════════════════════════════════════════════════════════════
  console.log("Running Strategy 3: Alt Season Detector on Supertrend...");
  const trades3 = runStrategy("S3", (_pair, dayT, _h4T, _h4i, stDir) => {
    const prevDay = Math.floor((dayT - DAY) / DAY) * DAY;
    const dom = domMap.get(prevDay);
    if (!dom || dom.altOutperformPct14d === null) return null;

    if (dom.altOutperformPct14d > 0.75) {
      // Alt season => only long
      return stDir === 1 ? "long" : null;
    } else if (dom.altOutperformPct14d < 0.25) {
      // BTC season => only short
      return stDir === -1 ? "short" : null;
    }
    // Neutral => take any signal
    return stDir === 1 ? "long" : "short";
  }, 60);

  // ════════════════════════════════════════════════════════════════════
  // STRATEGY 1b: DOMINANCE TREND -- both directions allowed, filter only blocks
  // ════════════════════════════════════════════════════════════════════
  console.log("Running Strategy 1b: Dominance Trend (block counter-trend only)...");
  const trades1b = runStrategy("S1b", (_pair, dayT, _h4T, _h4i, stDir) => {
    const prevDay = Math.floor((dayT - DAY) / DAY) * DAY;
    const dom = domMap.get(prevDay);
    if (!dom || dom.dom7d === null) {
      // No data, take signal as-is
      return stDir === 1 ? "long" : "short";
    }

    // Block longs when BTC dominance rising (alts should underperform)
    if (dom.dom7d > 0 && stDir === 1) return null;
    // Block shorts when alts outperforming
    if (dom.dom7d < 0 && stDir === -1) return null;

    return stDir === 1 ? "long" : "short";
  }, 60);

  // ════════════════════════════════════════════════════════════════════
  // RESULTS
  // ════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));

  const periods: { label: string; start: number; end: number }[] = [
    { label: "FULL (2023-01 to 2026-03)", start: FULL_START, end: FULL_END },
    { label: "IS (2023-01 to 2024-07)", start: FULL_START, end: new Date("2024-07-01").getTime() },
    { label: "OOS (2024-07 to 2026-03)", start: new Date("2024-07-01").getTime(), end: FULL_END },
  ];

  const strategies: { label: string; trades: Trade[] }[] = [
    { label: "S0: Baseline Supertrend (no filter)", trades: trades0 },
    { label: "S1: Dominance Trend (directional)", trades: trades1 },
    { label: "S1b: Dominance Trend (block counter)", trades: trades1b },
    { label: "S2: Dominance Reversal", trades: trades2 },
    { label: "S3: Alt Season Detector", trades: trades3 },
  ];

  for (const period of periods) {
    console.log(`\n--- ${period.label} ---`);
    for (const strat of strategies) {
      const s = computeStats(strat.trades, period.start, period.end);
      console.log(fmtStats(strat.label, s));
    }
  }

  // ── Direction breakdown ───────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("DIRECTION BREAKDOWN (FULL PERIOD)");
  console.log("=".repeat(70));

  for (const strat of strategies) {
    const longs = strat.trades.filter(t => t.dir === "long");
    const shorts = strat.trades.filter(t => t.dir === "short");
    const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
    const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
    const longWr = longs.length > 0 ? longs.filter(t => t.pnl > 0).length / longs.length : 0;
    const shortWr = shorts.length > 0 ? shorts.filter(t => t.pnl > 0).length / shorts.length : 0;
    console.log(`  ${strat.label}`);
    console.log(`    Longs:  ${longs.length} trades, $${longPnl.toFixed(2)}, WR: ${(longWr * 100).toFixed(1)}%`);
    console.log(`    Shorts: ${shorts.length} trades, $${shortPnl.toFixed(2)}, WR: ${(shortWr * 100).toFixed(1)}%`);
  }

  // ── Top/Bottom pairs by strategy ──────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("PER-PAIR PNL (FULL PERIOD) -- S1 vs Baseline");
  console.log("=".repeat(70));

  for (const strat of [strategies[0], strategies[1]]) {
    const pairPnl = new Map<string, number>();
    for (const t of strat.trades) {
      pairPnl.set(t.pair, (pairPnl.get(t.pair) ?? 0) + t.pnl);
    }
    const sorted = [...pairPnl.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\n  ${strat.label}:`);
    for (const [pair, pnl] of sorted) {
      const count = strat.trades.filter(t => t.pair === pair).length;
      console.log(`    ${pair.padEnd(6)} $${pnl.toFixed(2).padStart(8)}  (${count} trades)`);
    }
  }

  // ── Dominance regime stats ────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("DOMINANCE REGIME ANALYSIS");
  console.log("=".repeat(70));

  // For baseline trades, classify by regime at entry time
  const regimeLabels = ["BTC Dominant (7d>0)", "Alt Dominant (7d<0)"];
  for (const regimeLabel of regimeLabels) {
    const isPosDom = regimeLabel.includes("BTC");
    const inRegime = trades0.filter(t => {
      const prevDay = Math.floor((t.et - DAY) / DAY) * DAY;
      const dom = domMap.get(prevDay);
      if (!dom || dom.dom7d === null) return false;
      return isPosDom ? dom.dom7d > 0 : dom.dom7d <= 0;
    });

    const longs = inRegime.filter(t => t.dir === "long");
    const shorts = inRegime.filter(t => t.dir === "short");
    const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
    const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
    const longWr = longs.length > 0 ? longs.filter(t => t.pnl > 0).length / longs.length : 0;
    const shortWr = shorts.length > 0 ? shorts.filter(t => t.pnl > 0).length / shorts.length : 0;

    console.log(`\n  ${regimeLabel}:`);
    console.log(`    Longs:  ${longs.length} trades, $${longPnl.toFixed(2)}, WR: ${(longWr * 100).toFixed(1)}%`);
    console.log(`    Shorts: ${shorts.length} trades, $${shortPnl.toFixed(2)}, WR: ${(shortWr * 100).toFixed(1)}%`);
    console.log(`    Total:  ${inRegime.length} trades, $${(longPnl + shortPnl).toFixed(2)}`);
  }

  // Alt season / BTC season regime breakdown
  console.log("\n  Alt Season (>75% outperform BTC):");
  const altSeasonTrades = trades0.filter(t => {
    const prevDay = Math.floor((t.et - DAY) / DAY) * DAY;
    const dom = domMap.get(prevDay);
    return dom && dom.altOutperformPct14d !== null && dom.altOutperformPct14d > 0.75;
  });
  const btcSeasonTrades = trades0.filter(t => {
    const prevDay = Math.floor((t.et - DAY) / DAY) * DAY;
    const dom = domMap.get(prevDay);
    return dom && dom.altOutperformPct14d !== null && dom.altOutperformPct14d < 0.25;
  });
  {
    const longs = altSeasonTrades.filter(t => t.dir === "long");
    const shorts = altSeasonTrades.filter(t => t.dir === "short");
    console.log(`    Longs:  ${longs.length} trades, $${longs.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
    console.log(`    Shorts: ${shorts.length} trades, $${shorts.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
  }
  console.log("  BTC Season (<25% outperform BTC):");
  {
    const longs = btcSeasonTrades.filter(t => t.dir === "long");
    const shorts = btcSeasonTrades.filter(t => t.dir === "short");
    console.log(`    Longs:  ${longs.length} trades, $${longs.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
    console.log(`    Shorts: ${shorts.length} trades, $${shorts.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
  }

  console.log("\nDone.");
}

main();
