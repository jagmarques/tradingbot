/**
 * Funding Rate Extreme Mean Reversion Backtest
 *
 * Uses REAL Hyperliquid hourly funding data from /tmp/hl-funding/.
 * When funding z-score is extreme (overcrowded positioning), take contrarian trade.
 *
 * Variants:
 *   A. z=2.5 threshold, 24h max hold (base)
 *   B. z=3.0 threshold (stricter, higher conviction)
 *   C. z=2.0 threshold (looser, more trades)
 *   D. z=2.5, 48h max hold
 *   E. z=2.5, no BTC filter (allow longs in bearish BTC)
 *   F. z=2.5, volume confirmation (1h vol > 1.5x 20-bar avg)
 *
 * Cost: taker 0.035%, realistic spreads, 1.5x SL slippage, 10x leverage
 */
import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const FUNDING_DIR = "/tmp/hl-funding";
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const H = 3600000;
const DAY = 86400000;
const FEE = 0.00035;
const MARGIN = 3; // $3 margin per position
const LEV = 10;
const NOT = MARGIN * LEV; // $30 notional
const SL_SLIP = 1.5;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4,
  TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

const FULL_START = new Date("2024-04-01").getTime(); // 3 months warmup from Jan 2024
const OOS_START = new Date("2025-09-01").getTime();
const END = new Date("2026-03-26").getTime();
const WARMUP_H = 168; // 7-day lookback

// ─── Types ──────────────────────────────────────────────────────────
interface FR { coin: string; fundingRate: string; premium: string; time: number; }
interface Candle5m { t: number; o: number; h: number; l: number; c: number; v: number; }
interface HourBar { t: number; o: number; h: number; l: number; c: number; v: number; funding: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pricePnl: number; fundingPnl: number;
  totalPnl: number; reason: string; zEntry: number;
}
interface Metrics {
  label: string; n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number; avgHold: number;
  longs: number; shorts: number; longPnl: number; shortPnl: number;
}
interface VariantCfg {
  label: string;
  entryZ: number;
  exitZ: number;
  maxHoldH: number;
  useBtcFilter: boolean;
  useVolFilter: boolean;
  slPct: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function loadFunding(pair: string): FR[] {
  const fp = path.join(FUNDING_DIR, `${pair}_funding.json`);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function load5m(pair: string): Candle5m[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: Candle5m, b: Candle5m) => a.t - b.t);
}

function aggregateToHourly(candles: Candle5m[]): HourBar[] {
  const groups = new Map<number, Candle5m[]>();
  for (const c of candles) {
    const hourTs = Math.floor(c.t / H) * H;
    const arr = groups.get(hourTs) ?? [];
    arr.push(c);
    groups.set(hourTs, arr);
  }
  const hourly: HourBar[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 8) continue;
    hourly.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, b) => s + b.v, 0),
      funding: 0,
    });
  }
  return hourly;
}

function aggregateToDaily(bars: HourBar[]): { t: number; o: number; h: number; l: number; c: number; }[] {
  const groups = new Map<number, HourBar[]>();
  for (const b of bars) {
    const dayTs = Math.floor(b.t / DAY) * DAY;
    const arr = groups.get(dayTs) ?? [];
    arr.push(b);
    groups.set(dayTs, arr);
  }
  const daily: { t: number; o: number; h: number; l: number; c: number; }[] = [];
  for (const [ts, bars2] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars2.length < 16) continue;
    daily.push({
      t: ts, o: bars2[0].o,
      h: Math.max(...bars2.map(b => b.h)),
      l: Math.min(...bars2.map(b => b.l)),
      c: bars2[bars2.length - 1].c,
    });
  }
  return daily;
}

function buildHourlyBars(pair: string, funding: FR[], candles: Candle5m[]): HourBar[] {
  const hourly = aggregateToHourly(candles);
  const fundingMap = new Map<number, number>();
  for (const f of funding) {
    const hTs = Math.floor(f.time / H) * H;
    fundingMap.set(hTs, parseFloat(f.fundingRate));
  }
  for (const bar of hourly) {
    bar.funding = fundingMap.get(bar.t) ?? 0;
  }
  return hourly;
}

// ─── BTC EMA Filter ─────────────────────────────────────────────────
function buildBtcEmaFilter(): Map<number, boolean> {
  const btc5m = load5m("BTC");
  const btcHourly = aggregateToHourly(btc5m);
  const closes = btcHourly.map(b => b.c);

  // EMA(20) and EMA(50) on hourly closes
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  const filter = new Map<number, boolean>();
  for (let i = 0; i < btcHourly.length; i++) {
    // true = bullish (EMA20 > EMA50) -> longs allowed
    filter.set(btcHourly[i].t, ema20[i] > ema50[i]);
  }
  return filter;
}

function calcEMA(values: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      // SMA for initial period
      const slice = values.slice(0, i + 1);
      ema = slice.reduce((s, v) => s + v, 0) / slice.length;
    } else if (i === period - 1) {
      ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    } else {
      ema = values[i] * k + ema * (1 - k);
    }
    result.push(ema);
  }
  return result;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function tradeCost(pair: string, ep: number, xp: number, dir: "long" | "short", reason: string): number {
  const sp = SPREAD[pair] ?? 4e-4;
  // Entry: taker fee + half spread
  const entryCost = NOT * (FEE + sp / 2);
  // Exit: taker fee + half spread (SL gets 1.5x slippage on spread)
  const slipMul = reason === "sl" ? SL_SLIP : 1.0;
  const exitCost = NOT * (FEE + (sp / 2) * slipMul);
  return entryCost + exitCost;
}

// ─── Backtest Engine ────────────────────────────────────────────────
function runVariant(
  cfg: VariantCfg,
  pairData: Map<string, HourBar[]>,
  btcFilter: Map<number, boolean>,
): Trade[] {
  const trades: Trade[] = [];

  for (const pair of PAIRS) {
    const bars = pairData.get(pair);
    if (!bars || bars.length < WARMUP_H + 50) continue;

    // Build index for O(1) bar lookup
    const barIdx = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) barIdx.set(bars[i].t, i);

    // Pre-compute volume SMA(20) for volume filter
    let volSma20: number[] = [];
    if (cfg.useVolFilter) {
      volSma20 = new Array(bars.length).fill(0);
      for (let i = 19; i < bars.length; i++) {
        let sum = 0;
        for (let j = i - 19; j <= i; j++) sum += bars[j].v;
        volSma20[i] = sum / 20;
      }
    }

    let openPos: {
      dir: "long" | "short"; ep: number; et: number; sl: number; zEntry: number;
    } | null = null;

    for (let i = WARMUP_H; i < bars.length; i++) {
      const t = bars[i].t;
      if (t < FULL_START || t >= END) continue;

      const price = bars[i].c;

      // --- Check exit conditions on open position ---
      if (openPos) {
        const holdH = (t - openPos.et) / H;

        // SL check using hourly high/low
        let slHit = false;
        if (openPos.dir === "long" && bars[i].l <= openPos.sl) {
          slHit = true;
        } else if (openPos.dir === "short" && bars[i].h >= openPos.sl) {
          slHit = true;
        }

        // z-score for exit check
        const fundingWindow: number[] = [];
        for (let j = i - WARMUP_H; j < i; j++) {
          if (j >= 0) fundingWindow.push(bars[j].funding);
        }
        const mean = fundingWindow.reduce((s, v) => s + v, 0) / fundingWindow.length;
        const std = Math.sqrt(fundingWindow.reduce((s, v) => s + (v - mean) ** 2, 0) / fundingWindow.length);
        const currentZ = std > 1e-7 ? (bars[i].funding - mean) / std : 0;
        const zNormalized = Math.abs(currentZ) <= cfg.exitZ;

        const maxHoldReached = holdH >= cfg.maxHoldH;

        if (slHit || zNormalized || maxHoldReached) {
          const reason = slHit ? "sl" : zNormalized ? "z-exit" : "max-hold";
          const xp = slHit ? openPos.sl : price;
          const pricePnl = openPos.dir === "long"
            ? (xp / openPos.ep - 1) * NOT
            : (1 - xp / openPos.ep) * NOT;

          // Funding P&L
          let fundPnl = 0;
          for (let j = barIdx.get(openPos.et) ?? 0; j < i; j++) {
            if (bars[j].t >= openPos.et && bars[j].t < t) {
              // Short collects positive funding, long collects negative funding
              if (openPos.dir === "short") fundPnl += NOT * bars[j].funding;
              else fundPnl -= NOT * bars[j].funding;
            }
          }

          const cost = tradeCost(pair, openPos.ep, xp, openPos.dir, reason);
          const totalPnl = pricePnl + fundPnl - cost;

          trades.push({
            pair, dir: openPos.dir, ep: openPos.ep, xp,
            et: openPos.et, xt: t, pricePnl, fundingPnl: fundPnl,
            totalPnl, reason, zEntry: openPos.zEntry,
          });
          openPos = null;
        }
        continue;
      }

      // --- Entry conditions ---
      // Compute 168h rolling mean and std of funding rates
      const fundingWindow: number[] = [];
      for (let j = i - WARMUP_H; j < i; j++) {
        if (j >= 0) fundingWindow.push(bars[j].funding);
      }
      if (fundingWindow.length < WARMUP_H * 0.8) continue;

      const mean = fundingWindow.reduce((s, v) => s + v, 0) / fundingWindow.length;
      const std = Math.sqrt(fundingWindow.reduce((s, v) => s + (v - mean) ** 2, 0) / fundingWindow.length);
      // Minimum std threshold to avoid division by near-zero (funding rates ~1e-5 scale)
      if (std < 1e-7) continue;

      const z = (bars[i].funding - mean) / std;

      // Volume filter
      if (cfg.useVolFilter && i >= 20) {
        if (bars[i].v < 1.5 * volSma20[i]) continue;
      }

      // SL: 3% from entry, capped at 3.5%
      const slPct = Math.min(cfg.slPct, 0.035);

      if (z > cfg.entryZ) {
        // Extreme positive funding -> SHORT (overcrowded longs)
        const ep = price;
        const sl = ep * (1 + slPct);
        openPos = { dir: "short", ep, et: t, sl, zEntry: z };
      } else if (z < -cfg.entryZ) {
        // Extreme negative funding -> LONG (overcrowded shorts)
        // BTC filter: only go long if BTC EMA(20) > EMA(50)
        if (cfg.useBtcFilter) {
          const bullish = btcFilter.get(t);
          if (!bullish) continue;
        }
        const ep = price;
        const sl = ep * (1 - slPct);
        openPos = { dir: "long", ep, et: t, sl, zEntry: z };
      }
    }

    // Close remaining open position
    if (openPos && bars.length > 0) {
      const lastBar = bars[bars.length - 1];
      const xp = lastBar.c;
      const pricePnl = openPos.dir === "long"
        ? (xp / openPos.ep - 1) * NOT
        : (1 - xp / openPos.ep) * NOT;
      let fundPnl = 0;
      const startIdx = barIdx.get(openPos.et) ?? 0;
      for (let j = startIdx; j < bars.length; j++) {
        if (bars[j].t >= openPos.et && bars[j].t < lastBar.t) {
          if (openPos.dir === "short") fundPnl += NOT * bars[j].funding;
          else fundPnl -= NOT * bars[j].funding;
        }
      }
      const cost = tradeCost(pair, openPos.ep, xp, openPos.dir, "eod");
      trades.push({
        pair, dir: openPos.dir, ep: openPos.ep, xp,
        et: openPos.et, xt: lastBar.t, pricePnl, fundingPnl: fundPnl,
        totalPnl: pricePnl + fundPnl - cost, reason: "eod", zEntry: openPos.zEntry,
      });
    }
  }

  return trades.sort((a, b) => a.et - b.et);
}

// ─── Metrics ────────────────────────────────────────────────────────
function calcMetrics(trades: Trade[], label: string, startMs: number, endMs: number): Metrics {
  const n = trades.length;
  if (n === 0) return { label, n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, avgHold: 0, longs: 0, shorts: 0, longPnl: 0, shortPnl: 0 };

  const wins = trades.filter(t => t.totalPnl > 0);
  const losses = trades.filter(t => t.totalPnl <= 0);
  const wr = (wins.length / n) * 100;
  const grossWin = wins.reduce((s, t) => s + t.totalPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.totalPnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const total = trades.reduce((s, t) => s + t.totalPnl, 0);
  const days = (endMs - startMs) / DAY;
  const perDay = total / days;

  // Sharpe from daily P&L
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.totalPnl);
  }
  // Fill zero-days
  const startDay = Math.floor(startMs / DAY);
  const endDay = Math.floor(endMs / DAY);
  for (let d = startDay; d <= endDay; d++) {
    if (!dailyPnl.has(d)) dailyPnl.set(d, 0);
  }
  const dr = [...dailyPnl.values()];
  const avg = dr.reduce((s, r) => s + r, 0) / dr.length;
  const std2 = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std2 > 0 ? (avg / std2) * Math.sqrt(365) : 0;

  // MaxDD
  let cum = 0, peak = 0, dd = 0;
  for (const t of trades.sort((a, b) => a.xt - b.xt)) {
    cum += t.totalPnl;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }

  const avgHold = trades.reduce((s, t) => s + (t.xt - t.et), 0) / n / H;

  const longTrades = trades.filter(t => t.dir === "long");
  const shortTrades = trades.filter(t => t.dir === "short");

  return {
    label, n, wr, pf, sharpe, dd, total, perDay, avgHold,
    longs: longTrades.length,
    shorts: shortTrades.length,
    longPnl: longTrades.reduce((s, t) => s + t.totalPnl, 0),
    shortPnl: shortTrades.reduce((s, t) => s + t.totalPnl, 0),
  };
}

function printMetrics(m: Metrics) {
  console.log(`  ${m.label}`);
  console.log(`    Trades: ${m.n}  WR: ${m.wr.toFixed(1)}%  PF: ${m.pf.toFixed(2)}  Sharpe: ${m.sharpe.toFixed(2)}`);
  console.log(`    Total: $${m.total.toFixed(2)}  $/day: $${m.perDay.toFixed(3)}  MaxDD: $${m.dd.toFixed(2)}`);
  console.log(`    AvgHold: ${m.avgHold.toFixed(1)}h  Longs: ${m.longs} ($${m.longPnl.toFixed(2)})  Shorts: ${m.shorts} ($${m.shortPnl.toFixed(2)})`);
}

function printPerYear(trades: Trade[], label: string) {
  const years = [2024, 2025, 2026];
  console.log(`\n  ${label} per-year breakdown:`);
  for (const y of years) {
    const yStart = new Date(`${y}-01-01`).getTime();
    const yEnd = new Date(`${y + 1}-01-01`).getTime();
    const yTrades = trades.filter(t => t.xt >= yStart && t.xt < yEnd);
    if (yTrades.length === 0) { console.log(`    ${y}: no trades`); continue; }
    const m = calcMetrics(yTrades, `${y}`, yStart, Math.min(yEnd, END));
    console.log(`    ${y}: ${m.n} trades  WR: ${m.wr.toFixed(1)}%  PF: ${m.pf.toFixed(2)}  $${m.total.toFixed(2)}  $/day: $${m.perDay.toFixed(3)}  Sharpe: ${m.sharpe.toFixed(2)}  DD: $${m.dd.toFixed(2)}`);
  }
}

function printExitReasons(trades: Trade[]) {
  const reasons = new Map<string, { n: number; pnl: number }>();
  for (const t of trades) {
    const r = reasons.get(t.reason) ?? { n: 0, pnl: 0 };
    r.n++;
    r.pnl += t.totalPnl;
    reasons.set(t.reason, r);
  }
  console.log("    Exit reasons:");
  for (const [reason, { n, pnl }] of reasons) {
    console.log(`      ${reason}: ${n} trades, $${pnl.toFixed(2)}`);
  }
}

// ─── Correlation with Supertrend Proxy ──────────────────────────────
function calcCorrelation(fundingTrades: Trade[], pairData: Map<string, HourBar[]>): number {
  // Use a simple SMA crossover as ST proxy (SMA10 vs SMA30 on daily closes)
  // Build daily P&L for ST proxy
  const stDailyPnl = new Map<number, number>();

  for (const pair of PAIRS) {
    const bars = pairData.get(pair);
    if (!bars) continue;
    const daily = aggregateToDaily(bars);
    if (daily.length < 35) continue;

    const closes = daily.map(d => d.c);
    let inPos: { dir: "long" | "short"; ep: number; et: number } | null = null;

    for (let i = 30; i < daily.length; i++) {
      const t = daily[i].t;
      if (t < FULL_START || t >= END) continue;

      const sma10 = closes.slice(i - 10, i).reduce((s, v) => s + v, 0) / 10;
      const sma30 = closes.slice(i - 30, i).reduce((s, v) => s + v, 0) / 30;

      if (inPos) {
        // Exit if signal flips
        const shouldExit = (inPos.dir === "long" && sma10 < sma30) ||
                           (inPos.dir === "short" && sma10 > sma30);
        if (shouldExit) {
          const pnl = inPos.dir === "long"
            ? (daily[i].c / inPos.ep - 1) * 50 // $5 margin * 10x
            : (1 - daily[i].c / inPos.ep) * 50;
          const d = Math.floor(t / DAY);
          stDailyPnl.set(d, (stDailyPnl.get(d) ?? 0) + pnl);
          inPos = null;
        }
        continue;
      }

      if (sma10 > sma30) {
        inPos = { dir: "long", ep: daily[i].c, et: t };
      } else if (sma10 < sma30) {
        inPos = { dir: "short", ep: daily[i].c, et: t };
      }
    }
  }

  // Build funding daily P&L
  const fundDailyPnl = new Map<number, number>();
  for (const t of fundingTrades) {
    const d = Math.floor(t.xt / DAY);
    fundDailyPnl.set(d, (fundDailyPnl.get(d) ?? 0) + t.totalPnl);
  }

  // Compute Pearson correlation on overlapping days
  const allDays = new Set([...stDailyPnl.keys(), ...fundDailyPnl.keys()]);
  const xArr: number[] = [];
  const yArr: number[] = [];
  for (const d of allDays) {
    xArr.push(stDailyPnl.get(d) ?? 0);
    yArr.push(fundDailyPnl.get(d) ?? 0);
  }
  if (xArr.length < 10) return 0;

  const mx = xArr.reduce((s, v) => s + v, 0) / xArr.length;
  const my = yArr.reduce((s, v) => s + v, 0) / yArr.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xArr.length; i++) {
    num += (xArr[i] - mx) * (yArr[i] - my);
    dx += (xArr[i] - mx) ** 2;
    dy += (yArr[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

// ─── Ensemble Simulation ────────────────────────────────────────────
interface EnsembleTrade {
  engine: string; pair: string; dir: "long" | "short";
  et: number; xt: number; pnl: number;
}

function simulateEnsemble(
  fundingTrades: Trade[],
  pairData: Map<string, HourBar[]>,
  maxPositions: number,
): { withFunding: Metrics; withoutFunding: Metrics } {
  // Generate proxy trades for existing engines using SMA crossover signals
  // Donchian: $7/engine x4 = $28, ST: $5, GARCH: $3, Carry: $7 => total $43/day capacity
  // We model existing engines as simple trend followers with different timeframes

  const allEngines: EnsembleTrade[] = [];

  // Existing 4-engine proxy trades (SMA crossovers on daily with different periods)
  const engineConfigs = [
    { name: "Donch", smaFast: 12, smaSlow: 30, margin: 7 },
    { name: "ST", smaFast: 10, smaSlow: 25, margin: 5 },
    { name: "GARCH", smaFast: 8, smaSlow: 20, margin: 3 },
    { name: "Carry", smaFast: 15, smaSlow: 40, margin: 7 },
  ];

  for (const eng of engineConfigs) {
    const notional = eng.margin * LEV;
    for (const pair of PAIRS) {
      const bars = pairData.get(pair);
      if (!bars) continue;
      const daily = aggregateToDaily(bars);
      if (daily.length < eng.smaSlow + 5) continue;

      const closes = daily.map(d => d.c);
      let inPos: { dir: "long" | "short"; ep: number; et: number } | null = null;

      for (let i = eng.smaSlow; i < daily.length; i++) {
        const t = daily[i].t;
        if (t < FULL_START || t >= END) continue;

        const fast = closes.slice(i - eng.smaFast, i).reduce((s, v) => s + v, 0) / eng.smaFast;
        const slow = closes.slice(i - eng.smaSlow, i).reduce((s, v) => s + v, 0) / eng.smaSlow;

        if (inPos) {
          const shouldExit = (inPos.dir === "long" && fast < slow) || (inPos.dir === "short" && fast > slow);
          if (shouldExit) {
            const pnl = inPos.dir === "long"
              ? (daily[i].c / inPos.ep - 1) * notional
              : (1 - daily[i].c / inPos.ep) * notional;
            const sp = SPREAD[pair] ?? 4e-4;
            const cost = notional * (FEE * 2 + sp * 2);
            allEngines.push({ engine: eng.name, pair, dir: inPos.dir, et: inPos.et, xt: t, pnl: pnl - cost });
            inPos = null;
          }
          continue;
        }

        if (fast > slow) inPos = { dir: "long", ep: daily[i].c, et: t };
        else if (fast < slow) inPos = { dir: "short", ep: daily[i].c, et: t };
      }
    }
  }

  // Add funding trades
  const fundingEnsemble: EnsembleTrade[] = fundingTrades.map(t => ({
    engine: "FundMR", pair: t.pair, dir: t.dir, et: t.et, xt: t.xt, pnl: t.totalPnl,
  }));

  // Simulate with position limit
  function simWithLimit(allTrades: EnsembleTrade[]): Metrics {
    const sorted = [...allTrades].sort((a, b) => a.et - b.et);
    const active: EnsembleTrade[] = [];
    const completed: EnsembleTrade[] = [];

    for (const trade of sorted) {
      // Close expired
      active.forEach((a, idx) => { if (a.xt <= trade.et) { completed.push(a); } });
      const stillActive = active.filter(a => a.xt > trade.et);
      active.length = 0;
      active.push(...stillActive);

      if (active.length < maxPositions) {
        active.push(trade);
      }
    }
    completed.push(...active);

    const n = completed.length;
    if (n === 0) return { label: "", n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, avgHold: 0, longs: 0, shorts: 0, longPnl: 0, shortPnl: 0 };

    const wins = completed.filter(t => t.pnl > 0);
    const losses = completed.filter(t => t.pnl <= 0);
    const total = completed.reduce((s, t) => s + t.pnl, 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    const dailyPnl = new Map<number, number>();
    const startDay = Math.floor(FULL_START / DAY);
    const endDay = Math.floor(END / DAY);
    for (let d = startDay; d <= endDay; d++) dailyPnl.set(d, 0);
    for (const t of completed) {
      const d = Math.floor(t.xt / DAY);
      dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.pnl);
    }
    const dr = [...dailyPnl.values()];
    const avgDr = dr.reduce((s, v) => s + v, 0) / dr.length;
    const stdDr = Math.sqrt(dr.reduce((s, v) => s + (v - avgDr) ** 2, 0) / Math.max(dr.length - 1, 1));
    const sharpe = stdDr > 0 ? (avgDr / stdDr) * Math.sqrt(365) : 0;

    let cum = 0, peak2 = 0, dd = 0;
    for (const t of completed.sort((a, b) => a.xt - b.xt)) {
      cum += t.pnl;
      if (cum > peak2) peak2 = cum;
      if (peak2 - cum > dd) dd = peak2 - cum;
    }

    const days = (END - FULL_START) / DAY;
    return {
      label: "", n, wr: (wins.length / n) * 100,
      pf: grossLoss > 0 ? grossWin / grossLoss : 999,
      sharpe, dd, total, perDay: total / days, avgHold: 0,
      longs: completed.filter(t => t.dir === "long").length,
      shorts: completed.filter(t => t.dir === "short").length,
      longPnl: completed.filter(t => t.dir === "long").reduce((s, t) => s + t.pnl, 0),
      shortPnl: completed.filter(t => t.dir === "short").reduce((s, t) => s + t.pnl, 0),
    };
  }

  const withoutFunding = simWithLimit(allEngines);
  const withFunding = simWithLimit([...allEngines, ...fundingEnsemble]);

  return {
    withFunding: { ...withFunding, label: "4-Engine + FundMR" },
    withoutFunding: { ...withoutFunding, label: "4-Engine Only" },
  };
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log("=== FUNDING RATE EXTREME MEAN REVERSION BACKTEST ===");
  console.log(`Period: ${new Date(FULL_START).toISOString().slice(0, 10)} to ${new Date(END).toISOString().slice(0, 10)}`);
  console.log(`OOS start: ${new Date(OOS_START).toISOString().slice(0, 10)}`);
  console.log(`Margin: $${MARGIN}, Leverage: ${LEV}x, Notional: $${NOT}`);
  console.log(`Warmup: ${WARMUP_H}h (7 days)\n`);

  // Load all data
  console.log("Loading data...");
  const pairData = new Map<string, HourBar[]>();
  let loadedPairs = 0;

  for (const pair of PAIRS) {
    const funding = loadFunding(pair);
    if (funding.length === 0) {
      console.log(`  ${pair}: no funding data, skipping`);
      continue;
    }
    const candles = load5m(pair);
    if (candles.length === 0) {
      console.log(`  ${pair}: no candle data, skipping`);
      continue;
    }
    const bars = buildHourlyBars(pair, funding, candles);
    pairData.set(pair, bars);

    const fundingCount = bars.filter(b => b.funding !== 0).length;
    console.log(`  ${pair}: ${bars.length} hourly bars, ${funding.length} funding records, ${fundingCount} matched`);
    loadedPairs++;
  }

  console.log(`\nLoaded ${loadedPairs} pairs with funding data.\n`);

  // BTC EMA filter
  console.log("Building BTC EMA(20/50) filter...");
  const btcFilter = buildBtcEmaFilter();
  const bullishH = [...btcFilter.values()].filter(v => v).length;
  console.log(`  BTC bullish hours: ${bullishH}/${btcFilter.size} (${(bullishH / btcFilter.size * 100).toFixed(1)}%)\n`);

  // Define variants
  const variants: VariantCfg[] = [
    { label: "A. Base (z=2.5, 24h)", entryZ: 2.5, exitZ: 0.5, maxHoldH: 24, useBtcFilter: true, useVolFilter: false, slPct: 0.03 },
    { label: "B. Strict (z=3.0, 24h)", entryZ: 3.0, exitZ: 0.5, maxHoldH: 24, useBtcFilter: true, useVolFilter: false, slPct: 0.03 },
    { label: "C. Loose (z=2.0, 24h)", entryZ: 2.0, exitZ: 0.5, maxHoldH: 24, useBtcFilter: true, useVolFilter: false, slPct: 0.03 },
    { label: "D. Long hold (z=2.5, 48h)", entryZ: 2.5, exitZ: 0.5, maxHoldH: 48, useBtcFilter: true, useVolFilter: false, slPct: 0.03 },
    { label: "E. No BTC filter (z=2.5, 24h)", entryZ: 2.5, exitZ: 0.5, maxHoldH: 24, useBtcFilter: false, useVolFilter: false, slPct: 0.03 },
    { label: "F. Vol confirm (z=2.5, 24h)", entryZ: 2.5, exitZ: 0.5, maxHoldH: 24, useBtcFilter: true, useVolFilter: true, slPct: 0.03 },
  ];

  let bestVariant = "";
  let bestSharpe = -Infinity;
  let bestTrades: Trade[] = [];

  for (const cfg of variants) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`VARIANT ${cfg.label}`);
    console.log(`${"=".repeat(60)}`);

    const trades = runVariant(cfg, pairData, btcFilter);

    // Full period
    const fullTrades = trades.filter(t => t.xt >= FULL_START && t.xt < END);
    const fullM = calcMetrics(fullTrades, "Full Period", FULL_START, END);
    printMetrics(fullM);
    printExitReasons(fullTrades);

    // IS / OOS split
    const isTrades = trades.filter(t => t.xt >= FULL_START && t.xt < OOS_START);
    const oosTrades = trades.filter(t => t.xt >= OOS_START && t.xt < END);
    const isM = calcMetrics(isTrades, "In-Sample", FULL_START, OOS_START);
    const oosM = calcMetrics(oosTrades, "Out-of-Sample", OOS_START, END);
    console.log("\n  IS vs OOS:");
    printMetrics(isM);
    printMetrics(oosM);

    // Per year
    printPerYear(fullTrades, cfg.label);

    // Correlation with ST proxy
    const corr = calcCorrelation(fullTrades, pairData);
    console.log(`\n  Correlation with Supertrend proxy: ${corr.toFixed(3)}`);

    // Per-pair breakdown
    console.log("\n  Per-pair:");
    for (const pair of PAIRS) {
      const pairTrades = fullTrades.filter(t => t.pair === pair);
      if (pairTrades.length === 0) continue;
      const pnl = pairTrades.reduce((s, t) => s + t.totalPnl, 0);
      const wr = (pairTrades.filter(t => t.totalPnl > 0).length / pairTrades.length * 100).toFixed(0);
      const avgZ = (pairTrades.reduce((s, t) => s + Math.abs(t.zEntry), 0) / pairTrades.length).toFixed(2);
      console.log(`    ${pair.padEnd(6)} ${String(pairTrades.length).padStart(4)} trades  WR: ${wr.padStart(3)}%  PnL: $${pnl.toFixed(2).padStart(8)}  AvgZ: ${avgZ}`);
    }

    // Track best by full-period Sharpe
    if (fullM.sharpe > bestSharpe && fullM.n > 10) {
      bestSharpe = fullM.sharpe;
      bestVariant = cfg.label;
      bestTrades = fullTrades;
    }
  }

  // ─── Winner Summary ─────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(`WINNER: ${bestVariant} (Sharpe: ${bestSharpe.toFixed(2)})`);
  console.log(`${"=".repeat(60)}`);

  if (bestTrades.length > 0) {
    const m = calcMetrics(bestTrades, "Winner Full", FULL_START, END);
    printMetrics(m);

    // ─── Ensemble Test ────────────────────────────────────────────
    console.log(`\n${"=".repeat(60)}`);
    console.log("ENSEMBLE: Adding FundMR to current 4-engine system (max 20 positions)");
    console.log(`${"=".repeat(60)}`);

    const { withFunding, withoutFunding } = simulateEnsemble(bestTrades, pairData, 20);

    console.log("\n  Without FundMR (4-engine baseline):");
    console.log(`    Trades: ${withoutFunding.n}  WR: ${withoutFunding.wr.toFixed(1)}%  PF: ${withoutFunding.pf.toFixed(2)}  Sharpe: ${withoutFunding.sharpe.toFixed(2)}`);
    console.log(`    Total: $${withoutFunding.total.toFixed(2)}  $/day: $${withoutFunding.perDay.toFixed(3)}  MaxDD: $${withoutFunding.dd.toFixed(2)}`);

    console.log("\n  With FundMR (4-engine + FundMR):");
    console.log(`    Trades: ${withFunding.n}  WR: ${withFunding.wr.toFixed(1)}%  PF: ${withFunding.pf.toFixed(2)}  Sharpe: ${withFunding.sharpe.toFixed(2)}`);
    console.log(`    Total: $${withFunding.total.toFixed(2)}  $/day: $${withFunding.perDay.toFixed(3)}  MaxDD: $${withFunding.dd.toFixed(2)}`);

    const deltaPnl = withFunding.total - withoutFunding.total;
    const deltaSharpe = withFunding.sharpe - withoutFunding.sharpe;
    const deltaDD = withFunding.dd - withoutFunding.dd;
    console.log(`\n  Delta: PnL ${deltaPnl >= 0 ? "+" : ""}$${deltaPnl.toFixed(2)}  Sharpe ${deltaSharpe >= 0 ? "+" : ""}${deltaSharpe.toFixed(2)}  DD ${deltaDD >= 0 ? "+" : ""}$${deltaDD.toFixed(2)}`);
    console.log(`  Verdict: ${deltaSharpe > 0 && deltaPnl > 0 ? "IMPROVES ensemble" : "Does NOT improve ensemble"}`);
  }

  // ─── Z-score distribution ──────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("FUNDING Z-SCORE DISTRIBUTION (all pairs, full period)");
  console.log(`${"=".repeat(60)}`);

  const allZ: number[] = [];
  for (const pair of PAIRS) {
    const bars = pairData.get(pair);
    if (!bars || bars.length < WARMUP_H + 50) continue;
    for (let i = WARMUP_H; i < bars.length; i++) {
      if (bars[i].t < FULL_START || bars[i].t >= END) continue;
      const window: number[] = [];
      for (let j = i - WARMUP_H; j < i; j++) {
        if (j >= 0) window.push(bars[j].funding);
      }
      if (window.length < WARMUP_H * 0.8) continue;
      const mean = window.reduce((s, v) => s + v, 0) / window.length;
      const std = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length);
      if (std > 0) allZ.push((bars[i].funding - mean) / std);
    }
  }

  const buckets = [-5, -4, -3, -2.5, -2, -1, 0, 1, 2, 2.5, 3, 4, 5];
  console.log(`  Total z-score observations: ${allZ.length}`);
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i], hi = buckets[i + 1];
    const cnt = allZ.filter(z => z >= lo && z < hi).length;
    const pct = (cnt / allZ.length * 100).toFixed(2);
    console.log(`    [${lo.toFixed(1)}, ${hi.toFixed(1)}): ${cnt} (${pct}%)`);
  }
  const extreme = allZ.filter(z => Math.abs(z) >= 2.5).length;
  console.log(`  Extreme (|z| >= 2.5): ${extreme} (${(extreme / allZ.length * 100).toFixed(2)}%)`);
  const veryExtreme = allZ.filter(z => Math.abs(z) >= 3.0).length;
  console.log(`  Very extreme (|z| >= 3.0): ${veryExtreme} (${(veryExtreme / allZ.length * 100).toFixed(2)}%)`);

  console.log("\nDone.");
}

main().catch(console.error);
