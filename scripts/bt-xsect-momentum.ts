/**
 * Cross-Sectional Momentum Backtest (Academic Version)
 *
 * Weekly rebalance: rank altcoins by trailing return,
 * long top N, short bottom N. Multiple variations tested.
 *
 * 5m candles aggregated to daily. OOS from 2025-09-01.
 */
import * as fs from "fs";
import * as path from "path";

// ── Types ──
interface C5 { t: number; o: number; h: number; l: number; c: number }
interface DC { t: number; o: number; h: number; l: number; c: number }

interface Trade {
  pair: string;
  dir: "long" | "short";
  ep: number;       // entry price
  xp: number;       // exit price
  et: number;       // entry time
  xt: number;       // exit time
  pnl: number;
  reason: string;
  notional: number; // position notional
}

interface Stats {
  trades: number;
  pf: string;
  sharpe: string;
  totalPnl: string;
  wr: string;
  perDay: string;
  maxDD: string;
  longPnl: string;
  shortPnl: string;
}

// ── Constants ──
const CD5 = "/tmp/bt-pair-cache-5m";
const DAY = 86400000;
const FEE = 0.00035;        // taker fee per side
const SL_SLIP = 1.5;        // SL slippage multiplier
const LEV = 10;
const BASE_MARGIN = 5;      // $5 per position
const OOS_START = new Date("2025-09-01").getTime();
const FULL_START = new Date("2023-01-01").getTime();
const END = new Date("2026-03-26").getTime();

const PAIRS = [
  "ADA","APT","ARB","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4,
  WLDUSDT: 4e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4,
  LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
  ETHUSDT: 0.8e-4, SOLUSDT: 1.2e-4, TIAUSDT: 3.8e-4,
};

// ── Load and aggregate ──
function load5m(pair: string): C5[] {
  const f = path.join(CD5, pair + "USDT.json");
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
  );
}

function toDailyCandles(bars: C5[]): DC[] {
  const byDay = new Map<number, C5[]>();
  for (const b of bars) {
    const dayTs = Math.floor(b.t / DAY) * DAY;
    let arr = byDay.get(dayTs);
    if (!arr) { arr = []; byDay.set(dayTs, arr); }
    arr.push(b);
  }
  const daily: DC[] = [];
  for (const [dayTs, bs] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length < 200) continue;
    let hi = -Infinity, lo = Infinity;
    for (const b of bs) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
    daily.push({ t: dayTs, o: bs[0].o, h: hi, l: lo, c: bs[bs.length - 1].c });
  }
  return daily;
}

// ── Build all pair data ──
const pairDaily = new Map<string, DC[]>();
console.log("Loading candle data...");
for (const p of PAIRS) {
  const bars = load5m(p);
  const daily = toDailyCandles(bars);
  pairDaily.set(p, daily);
}
// Also load BTC for the momentum filter
const btcBars = load5m("BTC");
const btcDaily = toDailyCandles(btcBars);
console.log(`Loaded ${PAIRS.length} pairs + BTC. BTC daily bars: ${btcDaily.length}`);

// ── Helper: get daily close at or before timestamp ──
function getCloseAt(daily: DC[], ts: number): number | null {
  // Find last candle at or before ts
  let best: DC | null = null;
  for (const c of daily) {
    if (c.t <= ts) best = c;
    else break;
  }
  return best ? best.c : null;
}

function getCloseIndex(daily: DC[], ts: number): number {
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].t <= ts) return i;
  }
  return -1;
}

// ── Helper: compute trailing return ──
function trailingReturn(daily: DC[], endTs: number, lookbackDays: number): number | null {
  const endIdx = getCloseIndex(daily, endTs);
  if (endIdx < 0) return null;
  const startTs = endTs - lookbackDays * DAY;
  const startIdx = getCloseIndex(daily, startTs);
  if (startIdx < 0) return null;
  const startPrice = daily[startIdx].c;
  const endPrice = daily[endIdx].c;
  if (startPrice <= 0) return null;
  return (endPrice - startPrice) / startPrice;
}

// ── Helper: compute realized vol (daily returns std dev over a window) ──
function realizedVol(daily: DC[], endTs: number, windowDays: number): number | null {
  const endIdx = getCloseIndex(daily, endTs);
  if (endIdx < 0) return null;
  const startIdx = Math.max(0, endIdx - windowDays);
  if (endIdx - startIdx < 10) return null; // need at least 10 days
  const rets: number[] = [];
  for (let i = startIdx + 1; i <= endIdx; i++) {
    rets.push(daily[i].c / daily[i - 1].c - 1);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

// ── Helper: get intraday low/high from 5m data for SL checking ──
// For efficiency, build a daily high/low map per pair
function buildDailyHiLo(pair: string): Map<number, { hi: number; lo: number }> {
  // We already have daily candles with h/l
  const daily = pairDaily.get(pair);
  if (!daily) return new Map();
  const m = new Map<number, { hi: number; lo: number }>();
  for (const c of daily) {
    m.set(c.t, { hi: c.h, lo: c.l });
  }
  return m;
}

// ── SMA cross trend proxy (for correlation calc) ──
function computeSmaCrossPnl(): { dailyPnl: Map<number, number> } {
  const dailyPnl = new Map<number, number>();

  for (const pair of PAIRS) {
    const daily = pairDaily.get(pair);
    if (!daily || daily.length < 61) continue;
    const sp = SP[pair + "USDT"] ?? 4e-4;
    const totalCost = (FEE + sp / 2) * 2; // round-trip cost as fraction

    // Compute SMA30 and SMA60
    for (let i = 60; i < daily.length; i++) {
      let sum30 = 0, sum60 = 0;
      for (let j = i - 29; j <= i; j++) sum30 += daily[j].c;
      for (let j = i - 59; j <= i; j++) sum60 += daily[j].c;
      const sma30 = sum30 / 30;
      const sma60 = sum60 / 60;

      // Previous day SMAs
      if (i < 61) continue;
      let prevSum30 = 0, prevSum60 = 0;
      for (let j = i - 30; j <= i - 1; j++) prevSum30 += daily[j].c;
      for (let j = i - 60; j <= i - 1; j++) prevSum60 += daily[j].c;
      const prevSma30 = prevSum30 / 30;
      const prevSma60 = prevSum60 / 60;

      // Signal: position based on SMA cross
      const prevSignal = prevSma30 > prevSma60 ? 1 : -1;
      const dayRet = daily[i].c / daily[i - 1].c - 1;
      const pnl = prevSignal * dayRet * BASE_MARGIN * LEV - totalCost * BASE_MARGIN * LEV * Math.abs(
        (prevSma30 > prevSma60 ? 1 : -1) !== (sma30 > sma60 ? 1 : -1) ? 1 : 0
      );

      const dayTs = daily[i].t;
      dailyPnl.set(dayTs, (dailyPnl.get(dayTs) ?? 0) + pnl / PAIRS.length);
    }
  }
  return { dailyPnl };
}

// ── Variation config ──
interface VariationCfg {
  name: string;
  lookbackDays: number;
  holdDays: number;
  topN: number;
  bottomN: number;
  volTarget: boolean;    // scale by inverse vol
  slPct: number | null;  // null = no SL
  btcFilter: boolean;    // only trade when BTC 28d return > 0
}

const VARIATIONS: VariationCfg[] = [
  { name: "A. Base (28d/7d/top3)", lookbackDays: 28, holdDays: 7, topN: 3, bottomN: 3, volTarget: false, slPct: null, btcFilter: false },
  { name: "B. Short lookback (14d/7d/top3)", lookbackDays: 14, holdDays: 7, topN: 3, bottomN: 3, volTarget: false, slPct: null, btcFilter: false },
  { name: "C. Long lookback (42d/7d/top3)", lookbackDays: 42, holdDays: 7, topN: 3, bottomN: 3, volTarget: false, slPct: null, btcFilter: false },
  { name: "D. More positions (28d/7d/top5)", lookbackDays: 28, holdDays: 7, topN: 5, bottomN: 5, volTarget: false, slPct: null, btcFilter: false },
  { name: "E. Vol-targeted (28d/7d/top3)", lookbackDays: 28, holdDays: 7, topN: 3, bottomN: 3, volTarget: true, slPct: null, btcFilter: false },
  { name: "F. With 5% SL (28d/7d/top3)", lookbackDays: 28, holdDays: 7, topN: 3, bottomN: 3, volTarget: false, slPct: 0.05, btcFilter: false },
  { name: "G. Biweekly (28d/14d/top3)", lookbackDays: 28, holdDays: 14, topN: 3, bottomN: 3, volTarget: false, slPct: null, btcFilter: false },
  { name: "H. BTC filter (28d/7d/top3)", lookbackDays: 28, holdDays: 7, topN: 3, bottomN: 3, volTarget: false, slPct: null, btcFilter: true },
];

// ── Core simulation ──
interface OpenPos {
  pair: string;
  dir: "long" | "short";
  ep: number;
  et: number;
  notional: number;  // actual notional (may differ due to vol targeting)
  margin: number;
  slPrice: number | null; // for variation F
  stopped: boolean;
}

function runVariation(cfg: VariationCfg): Trade[] {
  const trades: Trade[] = [];

  // Build sorted unique day timestamps across all pairs
  const daySet = new Set<number>();
  for (const [, daily] of pairDaily) {
    for (const c of daily) {
      if (c.t >= FULL_START && c.t < END) daySet.add(c.t);
    }
  }
  const allDays = [...daySet].sort((a, b) => a - b);
  if (allDays.length === 0) return trades;

  // Find Monday rebalance days (day 0 = Monday in UTC, getUTCDay() returns 0=Sun..6=Sat)
  const rebalanceDays: number[] = [];
  let lastRebalance = -Infinity;
  for (const dayTs of allDays) {
    const d = new Date(dayTs);
    const dow = d.getUTCDay(); // 0=Sun, 1=Mon
    if (dow === 1) { // Monday
      // Check if enough time has passed since last rebalance
      if (dayTs - lastRebalance >= cfg.holdDays * DAY - DAY) {
        rebalanceDays.push(dayTs);
        lastRebalance = dayTs;
      }
    }
  }

  // Build daily hi/lo maps for SL checking
  const pairHiLo = new Map<string, Map<number, { hi: number; lo: number }>>();
  if (cfg.slPct !== null) {
    for (const p of PAIRS) {
      pairHiLo.set(p, buildDailyHiLo(p));
    }
  }

  // Iterate through rebalance periods
  let positions: OpenPos[] = [];

  for (let ri = 0; ri < rebalanceDays.length; ri++) {
    const rebalanceTs = rebalanceDays[ri];
    const nextRebalanceTs = ri + 1 < rebalanceDays.length ? rebalanceDays[ri + 1] : END;

    // Close all existing positions at rebalance open
    for (const pos of positions) {
      if (pos.stopped) continue; // already closed by SL
      const daily = pairDaily.get(pos.pair);
      if (!daily) continue;
      const closePrice = getCloseAt(daily, rebalanceTs);
      if (!closePrice) continue;

      const sp = SP[pos.pair + "USDT"] ?? 4e-4;
      const exitCost = (FEE + sp / 2);
      const xp = pos.dir === "long"
        ? closePrice * (1 - exitCost)
        : closePrice * (1 + exitCost);
      const pnl = pos.dir === "long"
        ? (xp / pos.ep - 1) * pos.notional
        : (1 - xp / pos.ep) * pos.notional;

      trades.push({
        pair: pos.pair, dir: pos.dir, ep: pos.ep, xp,
        et: pos.et, xt: rebalanceTs, pnl,
        reason: "rebalance", notional: pos.notional,
      });
    }
    positions = [];

    // BTC momentum filter
    if (cfg.btcFilter) {
      const btcRet = trailingReturn(btcDaily, rebalanceTs - DAY, 28);
      if (btcRet === null || btcRet <= 0) continue; // skip this period
    }

    // Compute trailing returns for all pairs
    const returns: { pair: string; ret: number; vol: number }[] = [];
    for (const pair of PAIRS) {
      const daily = pairDaily.get(pair);
      if (!daily) continue;
      const ret = trailingReturn(daily, rebalanceTs - DAY, cfg.lookbackDays); // use day before rebalance
      if (ret === null) continue;
      const vol = cfg.volTarget ? (realizedVol(daily, rebalanceTs - DAY, cfg.lookbackDays) ?? 0.05) : 0.05;
      returns.push({ pair, ret, vol: Math.max(vol, 0.005) }); // floor vol at 0.5%
    }

    if (returns.length < cfg.topN + cfg.bottomN) continue;

    // Rank by return
    returns.sort((a, b) => b.ret - a.ret);

    const topPairs = returns.slice(0, cfg.topN);
    const bottomPairs = returns.slice(-cfg.bottomN);

    // Vol-target: inverse vol weighting
    let topWeights: number[];
    let bottomWeights: number[];
    if (cfg.volTarget) {
      const topInvVol = topPairs.map(p => 1 / p.vol);
      const topSum = topInvVol.reduce((s, v) => s + v, 0);
      topWeights = topInvVol.map(v => v / topSum * cfg.topN); // scale so sum = topN

      const botInvVol = bottomPairs.map(p => 1 / p.vol);
      const botSum = botInvVol.reduce((s, v) => s + v, 0);
      bottomWeights = botInvVol.map(v => v / botSum * cfg.bottomN);
    } else {
      topWeights = topPairs.map(() => 1);
      bottomWeights = bottomPairs.map(() => 1);
    }

    // Open long positions (top performers)
    for (let i = 0; i < topPairs.length; i++) {
      const { pair } = topPairs[i];
      const daily = pairDaily.get(pair);
      if (!daily) continue;
      const entryPrice = getCloseAt(daily, rebalanceTs);
      if (!entryPrice) continue;

      const sp = SP[pair + "USDT"] ?? 4e-4;
      const entryCost = (FEE + sp / 2);
      const ep = entryPrice * (1 + entryCost); // buy at ask
      const margin = BASE_MARGIN * topWeights[i];
      const notional = margin * LEV;

      let slPrice: number | null = null;
      if (cfg.slPct !== null) {
        slPrice = ep * (1 - cfg.slPct);
      }

      positions.push({ pair, dir: "long", ep, et: rebalanceTs, notional, margin, slPrice, stopped: false });
    }

    // Open short positions (bottom performers)
    for (let i = 0; i < bottomPairs.length; i++) {
      const { pair } = bottomPairs[i];
      const daily = pairDaily.get(pair);
      if (!daily) continue;
      const entryPrice = getCloseAt(daily, rebalanceTs);
      if (!entryPrice) continue;

      const sp = SP[pair + "USDT"] ?? 4e-4;
      const entryCost = (FEE + sp / 2);
      const ep = entryPrice * (1 - entryCost); // sell at bid
      const margin = BASE_MARGIN * bottomWeights[i];
      const notional = margin * LEV;

      let slPrice: number | null = null;
      if (cfg.slPct !== null) {
        slPrice = ep * (1 + cfg.slPct);
      }

      positions.push({ pair, dir: "short", ep, et: rebalanceTs, notional, margin, slPrice, stopped: false });
    }

    // Check SL during the holding period (day by day)
    if (cfg.slPct !== null) {
      for (const dayTs of allDays) {
        if (dayTs <= rebalanceTs || dayTs >= nextRebalanceTs) continue;
        for (const pos of positions) {
          if (pos.stopped) continue;
          const hiLo = pairHiLo.get(pos.pair)?.get(dayTs);
          if (!hiLo) continue;

          if (pos.dir === "long" && pos.slPrice !== null && hiLo.lo <= pos.slPrice) {
            const sp = SP[pos.pair + "USDT"] ?? 4e-4;
            const xp = pos.slPrice * (1 - sp * SL_SLIP);
            const pnl = (xp / pos.ep - 1) * pos.notional;
            trades.push({
              pair: pos.pair, dir: pos.dir, ep: pos.ep, xp,
              et: pos.et, xt: dayTs, pnl,
              reason: "sl", notional: pos.notional,
            });
            pos.stopped = true;
          } else if (pos.dir === "short" && pos.slPrice !== null && hiLo.hi >= pos.slPrice) {
            const sp = SP[pos.pair + "USDT"] ?? 4e-4;
            const xp = pos.slPrice * (1 + sp * SL_SLIP);
            const pnl = (1 - xp / pos.ep) * pos.notional;
            trades.push({
              pair: pos.pair, dir: pos.dir, ep: pos.ep, xp,
              et: pos.et, xt: dayTs, pnl,
              reason: "sl", notional: pos.notional,
            });
            pos.stopped = true;
          }
        }
      }
    }
  }

  // Close any remaining positions at end
  for (const pos of positions) {
    if (pos.stopped) continue;
    const daily = pairDaily.get(pos.pair);
    if (!daily) continue;
    const closePrice = getCloseAt(daily, END);
    if (!closePrice) continue;

    const sp = SP[pos.pair + "USDT"] ?? 4e-4;
    const exitCost = (FEE + sp / 2);
    const xp = pos.dir === "long"
      ? closePrice * (1 - exitCost)
      : closePrice * (1 + exitCost);
    const pnl = pos.dir === "long"
      ? (xp / pos.ep - 1) * pos.notional
      : (1 - xp / pos.ep) * pos.notional;

    trades.push({
      pair: pos.pair, dir: pos.dir, ep: pos.ep, xp,
      et: pos.et, xt: END, pnl,
      reason: "end", notional: pos.notional,
    });
  }

  return trades;
}

// ── Compute stats ──
function computeStats(trades: Trade[], startTs: number, endTs: number): Stats {
  if (trades.length === 0) {
    return { trades: 0, pf: "0.00", sharpe: "0.00", totalPnl: "0.00", wr: "0.0%", perDay: "0.00", maxDD: "0.00", longPnl: "0.00", shortPnl: "0.00" };
  }

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const wr = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const days = (endTs - startTs) / DAY;
  const perDay = totalPnl / days;

  // Sharpe: weekly returns
  const weeklyPnl = new Map<number, number>();
  for (const t of trades) {
    const week = Math.floor(t.xt / (7 * DAY));
    weeklyPnl.set(week, (weeklyPnl.get(week) ?? 0) + t.pnl);
  }
  const weeklyRets = [...weeklyPnl.values()];
  let sharpe = 0;
  if (weeklyRets.length > 1) {
    const mean = weeklyRets.reduce((s, r) => s + r, 0) / weeklyRets.length;
    const std = Math.sqrt(weeklyRets.reduce((s, r) => s + (r - mean) ** 2, 0) / (weeklyRets.length - 1));
    sharpe = std > 0 ? (mean / std) * Math.sqrt(52) : 0;
  }

  // Max drawdown
  let peak = 0, dd = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  let cum = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  const longPnl = trades.filter(t => t.dir === "long").reduce((s, t) => s + t.pnl, 0);
  const shortPnl = trades.filter(t => t.dir === "short").reduce((s, t) => s + t.pnl, 0);

  return {
    trades: trades.length,
    pf: pf === Infinity ? "INF" : pf.toFixed(2),
    sharpe: sharpe.toFixed(2),
    totalPnl: totalPnl.toFixed(2),
    wr: wr.toFixed(1) + "%",
    perDay: perDay.toFixed(2),
    maxDD: maxDD.toFixed(2),
    longPnl: longPnl.toFixed(2),
    shortPnl: shortPnl.toFixed(2),
  };
}

// ── Correlation helper ──
function pearsonCorr(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

// ── Main ──
console.log("\n=== Cross-Sectional Momentum Backtest ===");
console.log(`Period: 2023-01 to 2026-03 | OOS: 2025-09-01`);
console.log(`Pairs: ${PAIRS.length} altcoins (excl BTC)`);
console.log(`Leverage: ${LEV}x | Base margin: $${BASE_MARGIN}/pos`);
console.log(`Fees: ${FEE * 100}% taker + spread + ${SL_SLIP}x SL slip\n`);

// Compute SMA cross PnL for correlation
console.log("Computing trend-following proxy (SMA 30/60 cross)...");
const smaCross = computeSmaCrossPnl();

const separator = "─".repeat(110);

for (const cfg of VARIATIONS) {
  console.log(separator);
  console.log(`\n>>> ${cfg.name}`);
  console.log(`    Lookback: ${cfg.lookbackDays}d | Hold: ${cfg.holdDays}d | Long top ${cfg.topN} / Short bottom ${cfg.bottomN}`);
  if (cfg.volTarget) console.log("    Vol-targeted position sizing (inverse realized vol)");
  if (cfg.slPct !== null) console.log(`    Stop-loss: ${(cfg.slPct * 100).toFixed(0)}% per position`);
  if (cfg.btcFilter) console.log("    BTC momentum filter: skip when BTC 28d return <= 0");

  const allTrades = runVariation(cfg);
  const fullTrades = allTrades.filter(t => t.et >= FULL_START && t.xt <= END);
  const oosTrades = allTrades.filter(t => t.et >= OOS_START);
  const isTrades = allTrades.filter(t => t.et >= FULL_START && t.et < OOS_START);

  const fullStats = computeStats(fullTrades, FULL_START, END);
  const oosStats = computeStats(oosTrades, OOS_START, END);
  const isStats = computeStats(isTrades, FULL_START, OOS_START);

  console.log("\n  FULL PERIOD:");
  console.log(`    Trades: ${fullStats.trades} | PF: ${fullStats.pf} | Sharpe: ${fullStats.sharpe} | WR: ${fullStats.wr}`);
  console.log(`    Total PnL: $${fullStats.totalPnl} | $/day: ${fullStats.perDay} | MaxDD: $${fullStats.maxDD}`);
  console.log(`    Long PnL: $${fullStats.longPnl} | Short PnL: $${fullStats.shortPnl}`);

  console.log("  IN-SAMPLE (2023-01 to 2025-09):");
  console.log(`    Trades: ${isStats.trades} | PF: ${isStats.pf} | Sharpe: ${isStats.sharpe} | WR: ${isStats.wr}`);
  console.log(`    Total PnL: $${isStats.totalPnl} | $/day: ${isStats.perDay} | MaxDD: $${isStats.maxDD}`);
  console.log(`    Long PnL: $${isStats.longPnl} | Short PnL: $${isStats.shortPnl}`);

  console.log("  OUT-OF-SAMPLE (2025-09 onwards):");
  console.log(`    Trades: ${oosStats.trades} | PF: ${oosStats.pf} | Sharpe: ${oosStats.sharpe} | WR: ${oosStats.wr}`);
  console.log(`    Total PnL: $${oosStats.totalPnl} | $/day: ${oosStats.perDay} | MaxDD: $${oosStats.maxDD}`);
  console.log(`    Long PnL: $${oosStats.longPnl} | Short PnL: $${oosStats.shortPnl}`);

  // Correlation with SMA cross
  // Bucket momentum PnL into weekly bins
  const momWeekly = new Map<number, number>();
  for (const t of fullTrades) {
    const week = Math.floor(t.xt / (7 * DAY));
    momWeekly.set(week, (momWeekly.get(week) ?? 0) + t.pnl);
  }
  const smaWeekly = new Map<number, number>();
  for (const [dayTs, pnl] of smaCross.dailyPnl) {
    if (dayTs < FULL_START || dayTs >= END) continue;
    const week = Math.floor(dayTs / (7 * DAY));
    smaWeekly.set(week, (smaWeekly.get(week) ?? 0) + pnl);
  }
  // Align weeks
  const commonWeeks = [...momWeekly.keys()].filter(w => smaWeekly.has(w)).sort();
  const momVals = commonWeeks.map(w => momWeekly.get(w)!);
  const smaVals = commonWeeks.map(w => smaWeekly.get(w)!);
  const corr = pearsonCorr(momVals, smaVals);
  console.log(`  Correlation with SMA 30/60 trend-following: ${corr.toFixed(3)} (n=${commonWeeks.length} weeks)`);

  // Top pair frequency
  const pairCount = new Map<string, { long: number; short: number }>();
  for (const t of fullTrades) {
    if (!pairCount.has(t.pair)) pairCount.set(t.pair, { long: 0, short: 0 });
    const pc = pairCount.get(t.pair)!;
    if (t.dir === "long") pc.long++;
    else pc.short++;
  }
  const pairEntries = [...pairCount.entries()].sort((a, b) =>
    (b[1].long + b[1].short) - (a[1].long + a[1].short)
  );
  console.log("  Pair frequency (top 6):");
  for (const [pair, counts] of pairEntries.slice(0, 6)) {
    const pairTrades = fullTrades.filter(t => t.pair === pair);
    const pairPnl = pairTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`    ${pair.padEnd(6)} L:${String(counts.long).padStart(3)} S:${String(counts.short).padStart(3)} PnL: $${pairPnl.toFixed(2)}`);
  }
}

// ── Summary table ──
console.log("\n" + separator);
console.log("\n=== SUMMARY TABLE ===\n");
console.log(
  "Variation".padEnd(38) +
  "Trades".padStart(7) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "Total$".padStart(9) +
  "$/day".padStart(8) +
  "WR".padStart(7) +
  "MaxDD".padStart(9) +
  " | OOS: " +
  "Trades".padStart(7) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(8)
);
console.log("─".repeat(140));

for (const cfg of VARIATIONS) {
  const allTrades = runVariation(cfg);
  const fullTrades = allTrades.filter(t => t.et >= FULL_START && t.xt <= END);
  const oosTrades = allTrades.filter(t => t.et >= OOS_START);

  const f = computeStats(fullTrades, FULL_START, END);
  const o = computeStats(oosTrades, OOS_START, END);

  console.log(
    cfg.name.padEnd(38) +
    String(f.trades).padStart(7) +
    f.pf.padStart(7) +
    f.sharpe.padStart(8) +
    ("$" + f.totalPnl).padStart(9) +
    f.perDay.padStart(8) +
    f.wr.padStart(7) +
    ("$" + f.maxDD).padStart(9) +
    " | " +
    String(o.trades).padStart(7) +
    o.pf.padStart(7) +
    o.sharpe.padStart(8) +
    o.perDay.padStart(8)
  );
}

console.log("\nDone.");
