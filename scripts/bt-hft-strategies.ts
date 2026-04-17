/**
 * HFT Strategy Backtest
 * Tests 5 scalping strategies on BTC, ETH, SOL using 5m and 1m data.
 * Goal: identify if any can reach $10/day with MaxDD < $20.
 *
 * Run: npx tsx scripts/bt-hft-strategies.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Trade {
  pair: string; strategy: string; dir: "long" | "short";
  ep: number; xp: number; pnl: number; pnlDollar: number; reason: string;
  et: number; xt: number;
}

const DIR_5M = "/tmp/bt-pair-cache-5m";
const DIR_1M = "/tmp/bt-pair-cache-1m";
const PAIRS = ["BTC", "ETH", "SOL"];

const MARGIN = 9;
const LEV = 10;
const NOTIONAL = MARGIN * LEV;         // $90
const FEE = 0.00035;                   // 0.035% per side
const RT_FEE = FEE * 2;               // 0.07% round trip
const H = 3_600_000;
const M5 = 5 * 60_000;
const M1 = 60_000;

// Full period: Jan 2023 – Mar 2026 (~3.2yr = ~1168 trading days)
const START = new Date("2023-01-01").getTime();
const END   = new Date("2026-03-26").getTime();
const DAYS  = (END - START) / 86_400_000;

// ── Loaders ──────────────────────────────────────────────────────────────────

function load(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw
    .map((b: any) =>
      Array.isArray(b)
        ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +(b[5] ?? 0) }
        : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0) },
    )
    .filter((b: C) => b.t >= START && b.t <= END)
    .sort((a: C, b: C) => a.t - b.t);
}

// ── Indicators ────────────────────────────────────────────────────────────────

function sma(arr: number[], period: number, i: number): number {
  if (i < period - 1) return NaN;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) s += arr[j];
  return s / period;
}

function stddev(arr: number[], period: number, i: number, mean: number): number {
  if (i < period - 1) return NaN;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) s += (arr[j] - mean) ** 2;
  return Math.sqrt(s / period);
}

// ── Stats Helper ──────────────────────────────────────────────────────────────

function calcStats(trades: Trade[], stratName: string) {
  if (trades.length === 0) {
    return { stratName, trades: 0, tradesPerDay: 0, dollarPerDay: 0, pf: 0, maxDD: 0, wr: 0, totalPnl: 0 };
  }
  // Sort by exit time
  trades.sort((a, b) => a.xt - b.xt);
  let gross_win = 0, gross_loss = 0, wins = 0;
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnlDollar;
    if (t.pnlDollar > 0) { gross_win += t.pnlDollar; wins++; }
    else gross_loss += Math.abs(t.pnlDollar);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  const totalPnl = equity;
  const pf = gross_loss > 0 ? gross_win / gross_loss : gross_win > 0 ? Infinity : 0;
  const wr = wins / trades.length;
  const tradesPerDay = trades.length / DAYS;
  const dollarPerDay = totalPnl / DAYS;
  return { stratName, trades: trades.length, tradesPerDay, dollarPerDay, pf, maxDD, wr, totalPnl };
}

// ── Strategy 1: 1h Mean Reversion Scalp ──────────────────────────────────────
// Aggregate 5m bars into 1h. When price drops >1% from 1h open, buy.
// When price rises >1% from 1h open, sell short.
// Exit at +0.3% or -0.5% SL. Max hold 2h.

function strat1_MeanRevScalp(pair: string): Trade[] {
  const bars5m = load(DIR_5M, pair);
  if (!bars5m.length) return [];

  // Build 1h bars from 5m
  const hourBuckets = new Map<number, C[]>();
  for (const b of bars5m) {
    const bucket = Math.floor(b.t / H) * H;
    if (!hourBuckets.has(bucket)) hourBuckets.set(bucket, []);
    hourBuckets.get(bucket)!.push(b);
  }

  const trades: Trade[] = [];
  let pos: { dir: "long" | "short"; ep: number; et: number } | null = null;

  for (const b of bars5m) {
    const hourStart = Math.floor(b.t / H) * H;
    const hourBars = hourBuckets.get(hourStart) ?? [];
    const hourOpen = hourBars.length ? hourBars[0].o : b.o;
    const price = b.c;

    // Close open position
    if (pos) {
      const maxHoldBars = 24; // 24 * 5m = 2h
      const age = (b.t - pos.et) / M5;
      const pricePct = pos.dir === "long"
        ? (price - pos.ep) / pos.ep
        : (pos.ep - price) / pos.ep;

      let exitReason = "";
      if (pricePct >= 0.003) exitReason = "TP";
      else if (pricePct <= -0.005) exitReason = "SL";
      else if (age >= maxHoldBars) exitReason = "MaxHold";

      if (exitReason) {
        const grossPnl = pricePct * NOTIONAL;
        const feeCost = RT_FEE * NOTIONAL;
        const pnlDollar = grossPnl - feeCost;
        trades.push({ pair, strategy: "MeanRevScalp", dir: pos.dir, ep: pos.ep, xp: price, pnl: pricePct, pnlDollar, reason: exitReason, et: pos.et, xt: b.t });
        pos = null;
      }
    }

    // Entry signal
    if (!pos) {
      const movePct = (price - hourOpen) / hourOpen;
      if (movePct <= -0.01) {
        pos = { dir: "long", ep: price, et: b.t };
      } else if (movePct >= 0.01) {
        pos = { dir: "short", ep: price, et: b.t };
      }
    }
  }

  return trades;
}

// ── Strategy 2: Bollinger Band Scalp ─────────────────────────────────────────
// 5m bars, BB(20, 1.5). Enter long at lower band touch. Exit at middle or -0.3% SL. Max 30 bars.

function strat2_BBScalp(pair: string): Trade[] {
  const bars = load(DIR_5M, pair);
  if (!bars.length) return [];

  const closes = bars.map(b => b.c);
  const BB_PERIOD = 20;
  const BB_MULT = 1.5;
  const TP_PCT = 0.003;
  const SL_PCT = 0.003;
  const MAX_BARS = 30;

  const trades: Trade[] = [];
  let pos: { dir: "long" | "short"; ep: number; et: number; middleBand: number; entryBar: number } | null = null;

  for (let i = BB_PERIOD; i < bars.length; i++) {
    const b = bars[i];
    const mid = sma(closes, BB_PERIOD, i);
    const sd = stddev(closes, BB_PERIOD, i, mid);
    const upper = mid + BB_MULT * sd;
    const lower = mid - BB_MULT * sd;

    // Close position
    if (pos) {
      const age = i - pos.entryBar;
      const pricePct = pos.dir === "long"
        ? (b.c - pos.ep) / pos.ep
        : (pos.ep - b.c) / pos.ep;

      let exitReason = "";
      if (pos.dir === "long" && b.c >= pos.middleBand) exitReason = "MidBand";
      else if (pos.dir === "short" && b.c <= pos.middleBand) exitReason = "MidBand";
      else if (pricePct <= -SL_PCT) exitReason = "SL";
      else if (age >= MAX_BARS) exitReason = "MaxHold";

      if (exitReason) {
        const grossPnl = pricePct * NOTIONAL;
        const feeCost = RT_FEE * NOTIONAL;
        trades.push({ pair, strategy: "BBScalp", dir: pos.dir, ep: pos.ep, xp: b.c, pnl: pricePct, pnlDollar: grossPnl - feeCost, reason: exitReason, et: pos.et, xt: b.t });
        pos = null;
      }
    }

    if (!pos) {
      // Long when price touches lower band
      if (b.l <= lower && b.c > lower) {
        pos = { dir: "long", ep: b.c, et: b.t, middleBand: mid, entryBar: i };
      }
      // Short when price touches upper band
      else if (b.h >= upper && b.c < upper) {
        pos = { dir: "short", ep: b.c, et: b.t, middleBand: mid, entryBar: i };
      }
    }
  }

  return trades;
}

// ── Strategy 3: Grid Trading ──────────────────────────────────────────────────
// Virtual grid every 0.5% from current price. $3 per level, 5 levels each side.
// We simulate: buy when price moves down to a grid level, sell at next level up.
// Sell short when price moves up to a grid level, cover at next level down.
// TP = 0.5% (one grid), SL = 1.5% (three grids adverse), Max hold 4h = 48 bars.

function strat3_Grid(pair: string): Trade[] {
  const bars = load(DIR_5M, pair);
  if (!bars.length) return [];

  const GRID_PCT = 0.005;    // 0.5% grid spacing
  const GRID_LEVELS = 5;
  const GRID_MARGIN = 3;     // $3 per grid slot
  const GRID_LEV = 10;
  const GRID_NOTIONAL = GRID_MARGIN * GRID_LEV; // $30
  const GRID_TP = GRID_PCT;
  const GRID_SL = GRID_PCT * 3;
  const MAX_BARS = 48;       // 4h

  const trades: Trade[] = [];

  // Recalculate grid center every 4h; track open grid positions
  type GridPos = { dir: "long" | "short"; ep: number; et: number; level: number; bar: number };
  const openPos = new Map<number, GridPos>(); // level -> position
  let gridCenter = 0;
  let lastGridUpdate = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];

    // Update grid center every 4h
    if (b.t - lastGridUpdate >= 4 * H) {
      gridCenter = b.c;
      lastGridUpdate = b.t;
      openPos.clear(); // reset grid on center reset
    }

    if (gridCenter === 0) continue;

    // Check existing positions for exit
    for (const [lvl, p] of openPos.entries()) {
      const pricePct = p.dir === "long"
        ? (b.c - p.ep) / p.ep
        : (p.ep - b.c) / p.ep;
      const age = i - p.bar;
      let exitReason = "";
      if (pricePct >= GRID_TP) exitReason = "TP";
      else if (pricePct <= -GRID_SL) exitReason = "SL";
      else if (age >= MAX_BARS) exitReason = "MaxHold";

      if (exitReason) {
        const grossPnl = pricePct * GRID_NOTIONAL;
        const feeCost = RT_FEE * GRID_NOTIONAL;
        trades.push({ pair, strategy: "Grid", dir: p.dir, ep: p.ep, xp: b.c, pnl: pricePct, pnlDollar: grossPnl - feeCost, reason: exitReason, et: p.et, xt: b.t });
        openPos.delete(lvl);
      }
    }

    // Check for new grid entries
    for (let lvl = 1; lvl <= GRID_LEVELS; lvl++) {
      const buyLevel = gridCenter * (1 - lvl * GRID_PCT);
      const sellLevel = gridCenter * (1 + lvl * GRID_PCT);

      // Long at buy level
      if (b.l <= buyLevel && !openPos.has(-lvl)) {
        openPos.set(-lvl, { dir: "long", ep: buyLevel, et: b.t, level: -lvl, bar: i });
      }
      // Short at sell level
      if (b.h >= sellLevel && !openPos.has(lvl)) {
        openPos.set(lvl, { dir: "short", ep: sellLevel, et: b.t, level: lvl, bar: i });
      }
    }
  }

  return trades;
}

// ── Strategy 4: Momentum Scalp (1m) ──────────────────────────────────────────
// 1m data. Enter when 5-bar momentum > 2 std devs. Exit 10 bars or +0.2% TP / -0.3% SL.

function strat4_MomScalp(pair: string): Trade[] {
  const bars = load(DIR_1M, pair);
  if (!bars.length) return [];

  const MOM_PERIOD = 5;
  const LOOKBACK = 20; // for std dev of momentum
  const TP_PCT = 0.002;
  const SL_PCT = 0.003;
  const MAX_BARS = 10;

  const trades: Trade[] = [];
  const closes = bars.map(b => b.c);
  let pos: { dir: "long" | "short"; ep: number; et: number; entryBar: number } | null = null;

  for (let i = MOM_PERIOD + LOOKBACK; i < bars.length; i++) {
    const b = bars[i];

    // Close position
    if (pos) {
      const age = i - pos.entryBar;
      const pricePct = pos.dir === "long"
        ? (b.c - pos.ep) / pos.ep
        : (pos.ep - b.c) / pos.ep;

      let exitReason = "";
      if (pricePct >= TP_PCT) exitReason = "TP";
      else if (pricePct <= -SL_PCT) exitReason = "SL";
      else if (age >= MAX_BARS) exitReason = "MaxHold";

      if (exitReason) {
        const grossPnl = pricePct * NOTIONAL;
        const feeCost = RT_FEE * NOTIONAL;
        trades.push({ pair, strategy: "MomScalp", dir: pos.dir, ep: pos.ep, xp: b.c, pnl: pricePct, pnlDollar: grossPnl - feeCost, reason: exitReason, et: pos.et, xt: b.t });
        pos = null;
      }
    }

    if (!pos) {
      // Compute momentum (current close vs close 5 bars ago)
      const momValues: number[] = [];
      for (let k = i - LOOKBACK; k <= i; k++) {
        momValues.push(closes[k] - closes[k - MOM_PERIOD]);
      }
      const curMom = momValues[momValues.length - 1];
      const momMean = momValues.reduce((a, b) => a + b, 0) / momValues.length;
      const momStd = Math.sqrt(momValues.reduce((a, b) => a + (b - momMean) ** 2, 0) / momValues.length);

      if (momStd > 0) {
        const z = (curMom - momMean) / momStd;
        if (z > 2) {
          pos = { dir: "long", ep: b.c, et: b.t, entryBar: i };
        } else if (z < -2) {
          pos = { dir: "short", ep: b.c, et: b.t, entryBar: i };
        }
      }
    }
  }

  return trades;
}

// ── Strategy 5: Volume Spike Scalp ───────────────────────────────────────────
// 5m bars. Volume > 3x 20-bar avg AND price moved >0.5% in that bar. Enter in direction. Exit +0.3%/-0.3% or 6 bars.

function strat5_VolSpike(pair: string): Trade[] {
  const bars = load(DIR_5M, pair);
  if (!bars.length) return [];

  const VOL_PERIOD = 20;
  const VOL_MULT = 3;
  const PRICE_MOVE = 0.005;
  const TP_PCT = 0.003;
  const SL_PCT = 0.003;
  const MAX_BARS = 6;

  const trades: Trade[] = [];
  const volumes = bars.map(b => b.v);
  let pos: { dir: "long" | "short"; ep: number; et: number; entryBar: number } | null = null;

  for (let i = VOL_PERIOD; i < bars.length; i++) {
    const b = bars[i];

    // Close
    if (pos) {
      const age = i - pos.entryBar;
      const pricePct = pos.dir === "long"
        ? (b.c - pos.ep) / pos.ep
        : (pos.ep - b.c) / pos.ep;
      let exitReason = "";
      if (pricePct >= TP_PCT) exitReason = "TP";
      else if (pricePct <= -SL_PCT) exitReason = "SL";
      else if (age >= MAX_BARS) exitReason = "MaxHold";

      if (exitReason) {
        const grossPnl = pricePct * NOTIONAL;
        const feeCost = RT_FEE * NOTIONAL;
        trades.push({ pair, strategy: "VolSpike", dir: pos.dir, ep: pos.ep, xp: b.c, pnl: pricePct, pnlDollar: grossPnl - feeCost, reason: exitReason, et: pos.et, xt: b.t });
        pos = null;
      }
    }

    if (!pos) {
      const avgVol = sma(volumes, VOL_PERIOD, i - 1); // use prior bar avg (no look-ahead)
      const barMove = (b.c - b.o) / b.o;
      const barRange = (b.h - b.l) / b.o;
      const isSpike = b.v > VOL_MULT * avgVol && barRange >= PRICE_MOVE;

      if (isSpike) {
        if (barMove > 0) {
          pos = { dir: "long", ep: b.c, et: b.t, entryBar: i };
        } else if (barMove < 0) {
          pos = { dir: "short", ep: b.c, et: b.t, entryBar: i };
        }
      }
    }
  }

  return trades;
}

// ── Run all strategies ────────────────────────────────────────────────────────

function runStrategy(name: string, fn: (pair: string) => Trade[]): ReturnType<typeof calcStats> {
  const allTrades: Trade[] = [];
  for (const pair of PAIRS) {
    const t = fn(pair);
    allTrades.push(...t);
  }
  return calcStats(allTrades, name);
}

console.log(`\nHFT Strategy Backtest | ${PAIRS.join(", ")} | ${DAYS.toFixed(0)} days | $${MARGIN} margin ${LEV}x\n`);
console.log("Running strategies... (1m data may take 30s)\n");

const results = [
  runStrategy("1. MeanRevScalp (1h drops, 5m exec)", strat1_MeanRevScalp),
  runStrategy("2. BBScalp (5m BB20/1.5)",            strat2_BBScalp),
  runStrategy("3. Grid (0.5% spacing, $3/level)",    strat3_Grid),
  runStrategy("4. MomScalp (1m, 5-bar mom z>2)",     strat4_MomScalp),
  runStrategy("5. VolSpike (3x vol + 0.5% move)",    strat5_VolSpike),
];

// ── Report ────────────────────────────────────────────────────────────────────

const col = (s: string | number, w: number) => String(s).padStart(w);

console.log(
  "Strategy".padEnd(38) +
  col("Trades", 8) +
  col("T/Day", 7) +
  col("$/Day", 7) +
  col("PF", 6) +
  col("MaxDD", 8) +
  col("WR%", 7) +
  col("TotalPnL", 10),
);
console.log("-".repeat(91));

for (const r of results) {
  const viable = r.dollarPerDay >= 10 && r.maxDD < 20 ? " <-- TARGET HIT" : "";
  console.log(
    r.stratName.padEnd(38) +
    col(r.trades, 8) +
    col(r.tradesPerDay.toFixed(1), 7) +
    col(r.dollarPerDay.toFixed(2), 7) +
    col(r.pf === Infinity ? "Inf" : r.pf.toFixed(2), 6) +
    col(r.maxDD.toFixed(2), 8) +
    col((r.wr * 100).toFixed(1) + "%", 7) +
    col(r.totalPnl.toFixed(0), 10) +
    viable,
  );
}

// ── GARCH Scaling Analysis ────────────────────────────────────────────────────

console.log("\n--- GARCH Scaling Analysis ---");
const GARCH_CURRENT_MARGIN = 9;
const GARCH_CURRENT_DAILY = 2.38;
const TARGET_DAILY = 10;
const scalingFactor = TARGET_DAILY / GARCH_CURRENT_DAILY;
const neededMargin = GARCH_CURRENT_MARGIN * scalingFactor;
const neededEquity = neededMargin * (100 / 30); // ~3.3x margin as equity buffer for 10% margin utilization
console.log(`Current:   $${GARCH_CURRENT_MARGIN} margin -> $${GARCH_CURRENT_DAILY}/day`);
console.log(`To reach:  $${TARGET_DAILY}/day requires $${neededMargin.toFixed(0)} margin per trade`);
console.log(`           Scaling factor: ${scalingFactor.toFixed(2)}x`);
console.log(`Safety equity (3.3x margin buffer): ~$${Math.ceil(neededMargin * 3.3 / 10) * 10}`);
console.log(`Simpler:   $9 * (10/2.38) = $${(9 * 10 / 2.38).toFixed(0)} margin -> needs ~$${Math.ceil(9 * 10 / 2.38 * 3.3 / 10) * 10} equity`);

console.log("\n--- Fee Drag per Strategy ---");
console.log(`Per trade fee cost (0.07% RT on $${NOTIONAL} notional): $${(RT_FEE * NOTIONAL).toFixed(4)}`);
for (const r of results) {
  const feeDragPerDay = r.tradesPerDay * RT_FEE * NOTIONAL;
  console.log(`  ${r.stratName.padEnd(36)}: ${r.tradesPerDay.toFixed(1)} trades/day x $${(RT_FEE * NOTIONAL).toFixed(3)} = $${feeDragPerDay.toFixed(2)}/day fee drag`);
}

console.log("\nDone.\n");
