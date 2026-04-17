/**
 * Novel HFT Strategies - Cycle 2 Backtest
 * Tests 5 strategies on BTC, ETH, SOL, DOGE, XRP
 *
 * $9 margin, 10x leverage = $90 notional per trade (pairs: $4.50/leg)
 * Maker fee: 0.015% per side, Taker (SL) fee: 0.035% per side
 *
 * Run: NODE_OPTIONS="--max-old-space-size=4096" npx tsx scripts/bt-novel-hft.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; v: number; }

interface Trade {
  strategy: string;
  pair: string;
  dir: "long" | "short";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  reason: string;
}

const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M = "/tmp/bt-pair-cache-1m";

const MIN = 60_000;
const H = 3_600_000;
const D = 86_400_000;

// Fee structure
const MAKER_FEE = 0.00015; // 0.015% per side
const TAKER_FEE = 0.00035; // 0.035% per side (SL exits)

// Position sizing
const MARGIN = 9;
const LEV = 10;
const NOTIONAL = MARGIN * LEV; // $90

const PAIRS = ["BTC", "ETH", "SOL", "DOGE", "XRP"];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

// ─── Data loading ──────────────────────────────────────────────────────────────

function loadBars(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw
    .map((b: any) =>
      Array.isArray(b)
        ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[5] ?? 0 }
        : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v ?? 0 },
    )
    .filter(b => b.t >= FULL_START && b.t <= FULL_END)
    .sort((a, b) => a.t - b.t);
}

function aggregate(bars: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(bucket);
    if (!arr) { arr = []; groups.set(bucket, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
      v: grp.reduce((s, b) => s + b.v, 0),
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// ─── Indicators ────────────────────────────────────────────────────────────────

function calcSMA(vals: number[], period: number): number[] {
  const out = new Array(vals.length).fill(NaN);
  for (let i = period - 1; i < vals.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += vals[j];
    out[i] = s / period;
  }
  return out;
}

function calcEMA(vals: number[], period: number): number[] {
  const ema = new Array(vals.length).fill(NaN);
  const k = 2 / (period + 1);
  for (let i = period - 1; i < vals.length; i++) {
    if (i === period - 1) {
      let s = 0;
      for (let j = 0; j < period; j++) s += vals[j];
      ema[i] = s / period;
    } else {
      ema[i] = vals[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(NaN);
  const trs: number[] = [0];
  for (let i = 1; i < cs.length; i++) {
    trs.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
  }
  for (let i = period; i < cs.length; i++) {
    if (i === period) {
      atr[i] = trs.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
    }
  }
  return atr;
}

function calcVWAP(cs: C[]): number[] {
  // Session VWAP: reset every day
  const out = new Array(cs.length).fill(NaN);
  let cumPV = 0, cumV = 0, lastDay = -1;
  for (let i = 0; i < cs.length; i++) {
    const day = Math.floor(cs[i].t / D);
    if (day !== lastDay) { cumPV = 0; cumV = 0; lastDay = day; }
    const typicalPx = (cs[i].h + cs[i].l + cs[i].c) / 3;
    cumPV += typicalPx * cs[i].v;
    cumV += cs[i].v;
    out[i] = cumV > 0 ? cumPV / cumV : cs[i].c;
  }
  return out;
}

function calcStd(vals: number[], period: number): number[] {
  const out = new Array(vals.length).fill(NaN);
  for (let i = period - 1; i < vals.length; i++) {
    const slice = vals.slice(i - period + 1, i + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / period;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

// ─── PnL helpers ───────────────────────────────────────────────────────────────

function makerPnl(dir: "long" | "short", ep: number, xp: number, notional: number): number {
  const raw = dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional;
  return raw - notional * MAKER_FEE * 2; // maker entry + maker exit
}

function takerExitPnl(dir: "long" | "short", ep: number, xp: number, notional: number): number {
  const raw = dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional;
  return raw - notional * (MAKER_FEE + TAKER_FEE); // maker entry + taker SL exit
}

// ─── Results ───────────────────────────────────────────────────────────────────

function summarize(name: string, trades: Trade[]) {
  if (trades.length === 0) {
    console.log(`\n${name}: NO TRADES`);
    return;
  }
  const totalDays = (FULL_END - FULL_START) / D;
  const tradesPerDay = trades.length / totalDays;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const pnlPerDay = totalPnl / totalDays;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const wr = (wins.length / trades.length) * 100;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  // Max drawdown
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades.sort((a, b) => a.entryTime - b.entryTime)) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Per-pair breakdown
  const byPair = new Map<string, { pnl: number; count: number }>();
  for (const t of trades) {
    const e = byPair.get(t.pair) ?? { pnl: 0, count: 0 };
    e.pnl += t.pnl; e.count++;
    byPair.set(t.pair, e);
  }

  console.log(`\n━━━ ${name} ━━━`);
  console.log(`  Trades: ${trades.length} total | ${tradesPerDay.toFixed(1)}/day`);
  console.log(`  PnL: $${totalPnl.toFixed(2)} total | $${pnlPerDay.toFixed(2)}/day`);
  console.log(`  MaxDD: $${maxDD.toFixed(2)}`);
  console.log(`  WR: ${wr.toFixed(1)}% | PF: ${isFinite(pf) ? pf.toFixed(2) : "∞"}`);
  console.log(`  Avg trade: $${(totalPnl / trades.length).toFixed(3)}`);
  const pairStr = [...byPair.entries()].map(([p, e]) => `${p}:$${e.pnl.toFixed(1)}(${e.count})`).join("  ");
  console.log(`  By pair: ${pairStr}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY 1: Pairs Spread Scalp (DOGE/WIF ratio)
// ═══════════════════════════════════════════════════════════════════════════════

function runPairsSpread(): Trade[] {
  console.log("[S1] Pairs Spread Scalp: DOGE/WIF...");
  const trades: Trade[] = [];

  const doge = loadBars(CD_5M, "DOGE");
  const wif = loadBars(CD_5M, "WIF");

  if (doge.length === 0 || wif.length === 0) {
    console.log("  WIF or DOGE data missing");
    return trades;
  }

  // Align by timestamp
  const dogeMap = new Map(doge.map(b => [b.t, b]));
  const wifMap = new Map(wif.map(b => [b.t, b]));
  const times = doge.map(b => b.t).filter(t => wifMap.has(t));

  const ratios = times.map(t => dogeMap.get(t)!.c / wifMap.get(t)!.c);
  const RATIO_PERIOD = 20;
  const ratioBars = times.map((t, i) => ({ t, ratio: ratios[i] }));

  // Per-leg notional: $4.50 margin * 10x = $45
  const LEG_NOTIONAL = 4.5 * 10;

  type PairPos = { dogeDir: "long" | "short"; wifDir: "long" | "short"; dogeEp: number; wifEp: number; entryTime: number; entryRatio: number; meanAtEntry: number; };
  let pos: PairPos | null = null;
  let barsSinceEntry = 0;
  const MAX_HOLD_BARS = 24; // 2 hours max

  for (let i = RATIO_PERIOD; i < ratioBars.length; i++) {
    const t = ratioBars[i].t;
    const ratio = ratioBars[i].ratio;
    const slice = ratios.slice(i - RATIO_PERIOD, i);
    const mean = slice.reduce((s, v) => s + v, 0) / RATIO_PERIOD;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / RATIO_PERIOD;
    const std = Math.sqrt(variance);
    if (std === 0) continue;
    const zscore = (ratio - mean) / std;

    const dogeBar = dogeMap.get(t)!;
    const wifBar = wifMap.get(t)!;

    if (pos) {
      barsSinceEntry++;
      // Exit when ratio reverts to mean OR max hold
      const currentZ = zscore;
      const reverted = (pos.dogeDir === "short" && currentZ <= 0.1) || (pos.dogeDir === "long" && currentZ >= -0.1);
      const timeout = barsSinceEntry >= MAX_HOLD_BARS;

      if (reverted || timeout) {
        // Close both legs at market (maker exit on limit, we assume limit)
        const dogePnl = makerPnl(pos.dogeDir, pos.dogeEp, dogeBar.c, LEG_NOTIONAL);
        const wifPnl = makerPnl(pos.wifDir, pos.wifEp, wifBar.c, LEG_NOTIONAL);
        const combinedPnl = dogePnl + wifPnl;

        trades.push({
          strategy: "PairsSpread",
          pair: "DOGE",
          dir: pos.dogeDir,
          entryTime: pos.entryTime,
          exitTime: t,
          entryPrice: pos.dogeEp,
          exitPrice: dogeBar.c,
          pnl: combinedPnl,
          reason: timeout ? "timeout" : "revert",
        });
        pos = null;
        barsSinceEntry = 0;
      }
    }

    if (!pos && Math.abs(zscore) > 1.0) {
      // DOGE outperforms (ratio high): short DOGE, long WIF
      // DOGE underperforms (ratio low): long DOGE, short WIF
      const dogeDir: "long" | "short" = zscore > 1 ? "short" : "long";
      const wifDir: "long" | "short" = zscore > 1 ? "long" : "short";
      pos = {
        dogeDir, wifDir,
        dogeEp: dogeBar.c,
        wifEp: wifBar.c,
        entryTime: t,
        entryRatio: ratio,
        meanAtEntry: mean,
      };
      barsSinceEntry = 0;
    }
  }

  console.log(`  Trades: ${trades.length}`);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY 2: Funding Rate Scalp
// ═══════════════════════════════════════════════════════════════════════════════

function runFundingScalp(): Trade[] {
  console.log("[S2] Funding Rate Scalp...");
  const trades: Trade[] = [];

  // We don't have real funding data, so we simulate from 5m price data.
  // Funding is estimated as a function of premium (close vs mark).
  // On Hyperliquid, funding is paid every hour.
  // We proxy funding with: if price is above 1h average -> positive funding (shorts collect)
  //                         if price is below 1h average -> negative funding (longs collect)
  // Entry 5m before hour, exit 5m after hour.
  // Only trade if predicted funding > 0.005% = $0.045 on $90 notional

  const MIN_FUNDING = 0.00005; // 0.005%
  const NOTIONAL_S2 = NOTIONAL;

  for (const pair of PAIRS) {
    const bars5m = loadBars(CD_5M, pair);
    if (bars5m.length === 0) continue;

    // Build index by time for O(1) lookup
    const barIdx = new Map(bars5m.map((b, i) => [b.t, i]));

    // Find all hour boundaries in the data
    const firstT = bars5m[0].t;
    const lastT = bars5m[bars5m.length - 1].t;

    let hourT = Math.ceil(firstT / H) * H;
    while (hourT + H < lastT) {
      // 5m before hour = hourT - 5min
      const entryT = hourT - 5 * MIN;
      // 5m after hour = hourT + 5min
      const exitT = hourT + 5 * MIN;

      const entryIdx = barIdx.get(entryT);
      const exitIdx = barIdx.get(exitT);

      if (entryIdx !== undefined && exitIdx !== undefined) {
        const entryBar = bars5m[entryIdx];
        const exitBar = bars5m[exitIdx];

        // Proxy funding: 1h-prior price vs current price
        // Use last 12 bars (1h of 5m) average as "mark proxy"
        const start = Math.max(0, entryIdx - 12);
        let sum = 0;
        let cnt = 0;
        for (let k = start; k < entryIdx; k++) { sum += bars5m[k].c; cnt++; }
        if (cnt === 0) { hourT += H; continue; }
        const markProxy = sum / cnt;
        const premium = (entryBar.c - markProxy) / markProxy;

        // Positive premium -> positive funding -> shorts collect
        // Negative premium -> negative funding -> longs collect
        if (Math.abs(premium) < MIN_FUNDING) { hourT += H; continue; }

        const dir: "long" | "short" = premium < 0 ? "long" : "short";

        // Funding collected = |premium| * notional (approximate)
        // But we also pay fees in/out
        const fundingCollected = Math.abs(premium) * NOTIONAL_S2;
        const feeCost = NOTIONAL_S2 * MAKER_FEE * 2;
        const priceMove = dir === "long"
          ? (exitBar.c / entryBar.c - 1) * NOTIONAL_S2
          : (entryBar.c / exitBar.c - 1) * NOTIONAL_S2;

        const pnl = priceMove + fundingCollected - feeCost;

        trades.push({
          strategy: "FundingScalp",
          pair,
          dir,
          entryTime: entryT,
          exitTime: exitT,
          entryPrice: entryBar.c,
          exitPrice: exitBar.c,
          pnl,
          reason: "funding",
        });
      }

      hourT += H;
    }
  }

  console.log(`  Trades: ${trades.length}`);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY 3: Volatility Breakout Scalp
// ═══════════════════════════════════════════════════════════════════════════════

function runVolBreakout(): Trade[] {
  console.log("[S3] Volatility Breakout Scalp...");
  const trades: Trade[] = [];

  const TP_PCT = 0.003;  // +0.3%
  const SL_PCT = 0.0015; // -0.15%
  const ATR_FAST = 5;
  const ATR_SLOW = 20;
  const LOOKBACK = 3; // bars for direction

  for (const pair of PAIRS) {
    const bars = loadBars(CD_5M, pair);
    if (bars.length < 50) continue;

    const atrFast = calcATR(bars, ATR_FAST);
    const atrSlow = calcATR(bars, ATR_SLOW);

    type Pos = { dir: "long" | "short"; ep: number; tp: number; sl: number; entryTime: number; };
    let pos: Pos | null = null;

    for (let i = ATR_SLOW + LOOKBACK; i < bars.length; i++) {
      const bar = bars[i];

      if (pos) {
        // Check SL and TP within bar
        let xp = 0, reason = "", isSL = false;
        if (pos.dir === "long") {
          if (bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
          else if (bar.h >= pos.tp) { xp = pos.tp; reason = "tp"; }
        } else {
          if (bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
          else if (bar.l <= pos.tp) { xp = pos.tp; reason = "tp"; }
        }

        if (reason) {
          const pnl = isSL
            ? takerExitPnl(pos.dir, pos.ep, xp, NOTIONAL)
            : makerPnl(pos.dir, pos.ep, xp, NOTIONAL);
          trades.push({
            strategy: "VolBreakout",
            pair,
            dir: pos.dir,
            entryTime: pos.entryTime,
            exitTime: bar.t,
            entryPrice: pos.ep,
            exitPrice: xp,
            pnl,
            reason,
          });
          pos = null;
        }
      }

      if (!pos) {
        if (isNaN(atrFast[i]) || isNaN(atrSlow[i]) || atrSlow[i] === 0) continue;
        const volExpanding = atrFast[i] > 2 * atrSlow[i];
        if (!volExpanding) continue;

        // Direction: last 3 bars net move
        const priceStart = bars[i - LOOKBACK].c;
        const priceNow = bar.c;
        const move = priceNow - priceStart;
        if (move === 0) continue;

        const dir: "long" | "short" = move > 0 ? "long" : "short";
        const ep = bar.c;
        const tp = dir === "long" ? ep * (1 + TP_PCT) : ep * (1 - TP_PCT);
        const sl = dir === "long" ? ep * (1 - SL_PCT) : ep * (1 + SL_PCT);

        pos = { dir, ep, tp, sl, entryTime: bar.t };
      }
    }

    // Close open position at end of data
    if (pos) {
      const lastBar = bars[bars.length - 1];
      const pnl = makerPnl(pos.dir, pos.ep, lastBar.c, NOTIONAL);
      trades.push({
        strategy: "VolBreakout",
        pair,
        dir: pos.dir,
        entryTime: pos.entryTime,
        exitTime: lastBar.t,
        entryPrice: pos.ep,
        exitPrice: lastBar.c,
        pnl,
        reason: "eod",
      });
    }
  }

  console.log(`  Trades: ${trades.length}`);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY 4: Cross-TF Momentum (1m / 5m / 15m alignment)
// ═══════════════════════════════════════════════════════════════════════════════

function runCrossTFMomentum(): Trade[] {
  console.log("[S4] Cross-TF Momentum...");
  const trades: Trade[] = [];

  const M15 = 15 * MIN;
  const EMA_FAST = 5;
  const EMA_SLOW = 20;

  for (const pair of PAIRS) {
    const bars1m = loadBars(CD_1M, pair);
    const bars5m = loadBars(CD_5M, pair);
    if (bars1m.length === 0 || bars5m.length === 0) continue;

    // Aggregate 15m from 1m
    const bars15m = aggregate(bars1m, M15, 10);

    // Compute EMA on each TF
    const ema1mF = calcEMA(bars1m.map(b => b.c), EMA_FAST);
    const ema1mS = calcEMA(bars1m.map(b => b.c), EMA_SLOW);
    const ema5mF = calcEMA(bars5m.map(b => b.c), EMA_FAST);
    const ema5mS = calcEMA(bars5m.map(b => b.c), EMA_SLOW);
    const ema15mF = calcEMA(bars15m.map(b => b.c), EMA_FAST);
    const ema15mS = calcEMA(bars15m.map(b => b.c), EMA_SLOW);

    // Build lookup maps for 5m and 15m by timestamp
    const ema5mByT = new Map(bars5m.map((b, i) => [b.t, { f: ema5mF[i], s: ema5mS[i] }]));
    const ema15mByT = new Map(bars15m.map((b, i) => [b.t, { f: ema15mF[i], s: ema15mS[i] }]));

    // Get the most recent 5m/15m bar at each 1m timestamp
    function get5mAtTime(t: number): { f: number; s: number } | null {
      const bucket5 = Math.floor(t / (5 * MIN)) * (5 * MIN);
      return ema5mByT.get(bucket5) ?? null;
    }
    function get15mAtTime(t: number): { f: number; s: number } | null {
      const bucket15 = Math.floor(t / M15) * M15;
      return ema15mByT.get(bucket15) ?? null;
    }

    type Pos = { dir: "long" | "short"; ep: number; entryTime: number; };
    let pos: Pos | null = null;

    for (let i = EMA_SLOW; i < bars1m.length; i++) {
      const bar = bars1m[i];
      const t = bar.t;

      const e1mF = ema1mF[i];
      const e1mS = ema1mS[i];
      if (isNaN(e1mF) || isNaN(e1mS)) continue;

      const e5m = get5mAtTime(t);
      const e15m = get15mAtTime(t);
      if (!e5m || !e15m) continue;
      if (isNaN(e5m.f) || isNaN(e5m.s) || isNaN(e15m.f) || isNaN(e15m.s)) continue;

      const bull1m = e1mF > e1mS;
      const bull5m = e5m.f > e5m.s;
      const bull15m = e15m.f > e15m.s;
      const allBull = bull1m && bull5m && bull15m;
      const allBear = !bull1m && !bull5m && !bull15m;

      if (pos) {
        // Exit when 1m flips
        const exitLong = pos.dir === "long" && !bull1m;
        const exitShort = pos.dir === "short" && bull1m;
        if (exitLong || exitShort) {
          const pnl = makerPnl(pos.dir, pos.ep, bar.c, NOTIONAL);
          trades.push({
            strategy: "CrossTFMomentum",
            pair,
            dir: pos.dir,
            entryTime: pos.entryTime,
            exitTime: t,
            entryPrice: pos.ep,
            exitPrice: bar.c,
            pnl,
            reason: "flip",
          });
          pos = null;
        }
      }

      if (!pos) {
        if (allBull) {
          pos = { dir: "long", ep: bar.c, entryTime: t };
        } else if (allBear) {
          pos = { dir: "short", ep: bar.c, entryTime: t };
        }
      }
    }

    // Close at end
    if (pos) {
      const lastBar = bars1m[bars1m.length - 1];
      const pnl = makerPnl(pos.dir, pos.ep, lastBar.c, NOTIONAL);
      trades.push({
        strategy: "CrossTFMomentum",
        pair,
        dir: pos.dir,
        entryTime: pos.entryTime,
        exitTime: lastBar.t,
        entryPrice: pos.ep,
        exitPrice: lastBar.c,
        pnl,
        reason: "eod",
      });
    }
  }

  console.log(`  Trades: ${trades.length}`);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY 5: Micro Mean Reversion with Volume Filter
// ═══════════════════════════════════════════════════════════════════════════════

function runMicroMeanReversion(): Trade[] {
  console.log("[S5] Micro Mean Reversion with Volume Filter...");
  const trades: Trade[] = [];

  const VWAP_THRESHOLD = 0.003; // 0.3% below VWAP
  const VOL_MULT = 2.0;
  const SL_PCT = 0.002;  // -0.2%
  const MAX_HOLD_BARS = 6;
  const VOL_PERIOD = 20; // average volume lookback

  for (const pair of PAIRS) {
    const bars = loadBars(CD_5M, pair);
    if (bars.length < 30) continue;

    const vwap = calcVWAP(bars);
    const volumes = bars.map(b => b.v);
    const avgVol = calcSMA(volumes, VOL_PERIOD);

    type Pos = { dir: "long"; ep: number; sl: number; tp: number; entryTime: number; barsIn: number; };
    let pos: Pos | null = null;

    for (let i = VOL_PERIOD; i < bars.length; i++) {
      const bar = bars[i];

      if (pos) {
        pos.barsIn++;
        let xp = 0, reason = "", isSL = false;

        if (bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (bar.h >= pos.tp) { xp = pos.tp; reason = "vwap"; }
        else if (pos.barsIn >= MAX_HOLD_BARS) { xp = bar.c; reason = "timeout"; }

        if (reason) {
          const pnl = isSL
            ? takerExitPnl("long", pos.ep, xp, NOTIONAL)
            : makerPnl("long", pos.ep, xp, NOTIONAL);
          trades.push({
            strategy: "MicroMeanRev",
            pair,
            dir: "long",
            entryTime: pos.entryTime,
            exitTime: bar.t,
            entryPrice: pos.ep,
            exitPrice: xp,
            pnl,
            reason,
          });
          pos = null;
        }
      }

      if (!pos) {
        if (isNaN(vwap[i]) || isNaN(avgVol[i]) || avgVol[i] === 0) continue;
        const deviation = (vwap[i] - bar.c) / vwap[i]; // positive when price < vwap
        const volRatio = bar.v / avgVol[i];

        if (deviation >= VWAP_THRESHOLD && volRatio >= VOL_MULT) {
          const ep = bar.c;
          const sl = ep * (1 - SL_PCT);
          const tp = vwap[i]; // target VWAP
          pos = { dir: "long", ep, sl, tp, entryTime: bar.t, barsIn: 0 };
        }
      }
    }

    // Close open position at end of data
    if (pos) {
      const lastBar = bars[bars.length - 1];
      const pnl = makerPnl("long", pos.ep, lastBar.c, NOTIONAL);
      trades.push({
        strategy: "MicroMeanRev",
        pair,
        dir: "long",
        entryTime: pos.entryTime,
        exitTime: lastBar.t,
        entryPrice: pos.ep,
        exitPrice: lastBar.c,
        pnl,
        reason: "eod",
      });
    }
  }

  console.log(`  Trades: ${trades.length}`);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

console.log("=== Novel HFT Cycle 2 Backtest ===");
console.log(`Pairs: ${PAIRS.join(", ")}`);
console.log(`Period: 2023-01-01 to 2026-03-26 (${Math.round((FULL_END - FULL_START) / D)} days)`);
console.log(`Fees: Maker 0.015%/side, Taker 0.035%/side`);
console.log(`Sizing: $${MARGIN} margin × ${LEV}x = $${NOTIONAL} notional\n`);

const t0 = Date.now();

const s1 = runPairsSpread();
const s2 = runFundingScalp();
const s3 = runVolBreakout();
const s4 = runCrossTFMomentum();
const s5 = runMicroMeanReversion();

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nComputed in ${elapsed}s`);

console.log("\n══════════════════════════════════════════════════════════════");
console.log("RESULTS");
console.log("══════════════════════════════════════════════════════════════");

summarize("S1: Pairs Spread Scalp (DOGE/WIF)", s1);
summarize("S2: Funding Rate Scalp", s2);
summarize("S3: Volatility Breakout Scalp", s3);
summarize("S4: Cross-TF Momentum (1m/5m/15m)", s4);
summarize("S5: Micro Mean Reversion + Volume", s5);

// Combined summary
const allTrades = [...s1, ...s2, ...s3, ...s4, ...s5];
const totalDays = (FULL_END - FULL_START) / D;
const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
console.log("\n══════════════════════════════════════════════════════════════");
console.log(`COMBINED: ${allTrades.length} trades | $${totalPnl.toFixed(2)} total | $${(totalPnl / totalDays).toFixed(2)}/day`);
console.log("══════════════════════════════════════════════════════════════");
