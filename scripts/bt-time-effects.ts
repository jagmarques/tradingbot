/**
 * Time-of-Day & Seasonality Effects Backtest
 *
 * Tests 6 well-documented market anomalies in crypto:
 * 1. Asian Session Fade (London open reversal)
 * 2. US Session Momentum (14:00-22:00 UTC)
 * 3. Weekend Effect (Fri-Sun)
 * 4. Month-End Rebalance
 * 5. Hour-of-Day Return Analysis
 * 6. Day-of-Week Effect
 *
 * 5m candles aggregated to 1h. OOS from 2025-09-01.
 */
import * as fs from "fs";
import * as path from "path";

// ── Types ──
interface C5 { t: number; o: number; h: number; l: number; c: number }
interface C1H { t: number; o: number; h: number; l: number; c: number }

interface Trade {
  pair: string;
  dir: "long" | "short";
  ep: number;
  xp: number;
  et: number;
  xt: number;
  pnl: number;
  notional: number;
  strategy: string;
}

interface Stats {
  trades: number;
  pf: string;
  sharpe: string;
  totalPnl: string;
  wr: string;
  perDay: string;
  maxDD: string;
}

// ── Constants ──
const CD5 = "/tmp/bt-pair-cache-5m";
const HOUR = 3600000;
const DAY = 86400000;
const TAKER_FEE = 0.00035;
const MAKER_FEE = 0.0001;
const LEV = 10;
const MARGIN = 5;
const OOS_START = new Date("2025-09-01").getTime();
const FULL_START = new Date("2023-01-01").getTime();
const END = new Date("2026-03-26").getTime();

const PAIRS = [
  "ADA","APT","ARB","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

// Top 5 liquid pairs for basket strategies
const BASKET_PAIRS = ["ETH","SOL","XRP","DOGE","LINK"];

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4,
  WLDUSDT: 4e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4,
  LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
  ETHUSDT: 0.8e-4, SOLUSDT: 1.2e-4, TIAUSDT: 3.8e-4,
};

// ── Load and aggregate to 1h ──
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

function toHourly(bars: C5[]): C1H[] {
  const byHour = new Map<number, C5[]>();
  for (const b of bars) {
    const hourTs = Math.floor(b.t / HOUR) * HOUR;
    let arr = byHour.get(hourTs);
    if (!arr) { arr = []; byHour.set(hourTs, arr); }
    arr.push(b);
  }
  const hourly: C1H[] = [];
  for (const [hourTs, bs] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length < 10) continue; // need at least 10 of 12 bars
    let hi = -Infinity, lo = Infinity;
    for (const b of bs) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
    hourly.push({ t: hourTs, o: bs[0].o, h: hi, l: lo, c: bs[bs.length - 1].c });
  }
  return hourly;
}

// ── Load all data ──
console.log("Loading candle data...");
const pairHourly = new Map<string, C1H[]>();
const pairHourlyMap = new Map<string, Map<number, C1H>>();

for (const p of PAIRS) {
  const bars = load5m(p);
  const h = toHourly(bars);
  pairHourly.set(p, h);
  const m = new Map<number, C1H>();
  for (const c of h) m.set(c.t, c);
  pairHourlyMap.set(p, m);
}

// BTC hourly
const btc5m = load5m("BTC");
const btcHourly = toHourly(btc5m);
const btcHourlyMap = new Map<number, C1H>();
for (const c of btcHourly) btcHourlyMap.set(c.t, c);
console.log(`Loaded ${PAIRS.length} pairs + BTC. BTC hourly bars: ${btcHourly.length}`);

// ── Helpers ──
function getHourlyClose(hourMap: Map<number, C1H>, ts: number): number | null {
  const c = hourMap.get(ts);
  return c ? c.c : null;
}

function getHourlyOpen(hourMap: Map<number, C1H>, ts: number): number | null {
  const c = hourMap.get(ts);
  return c ? c.o : null;
}

function spreadHalf(pair: string): number {
  return (SP[pair + "USDT"] ?? 4e-4) / 2;
}

function entryPrice(price: number, dir: "long" | "short", pair: string, fee: number): number {
  const sp = spreadHalf(pair);
  return dir === "long" ? price * (1 + fee + sp) : price * (1 - fee - sp);
}

function exitPrice(price: number, dir: "long" | "short", pair: string, fee: number): number {
  const sp = spreadHalf(pair);
  return dir === "long" ? price * (1 - fee - sp) : price * (1 + fee + sp);
}

function tradePnl(ep: number, xp: number, dir: "long" | "short", notional: number): number {
  return dir === "long"
    ? (xp / ep - 1) * notional
    : (1 - xp / ep) * notional;
}

// ── Compute stats ──
function computeStats(trades: Trade[], startTs: number, endTs: number): Stats {
  if (trades.length === 0) {
    return { trades: 0, pf: "0.00", sharpe: "0.00", totalPnl: "0.00", wr: "0.0%", perDay: "0.00", maxDD: "0.00" };
  }

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const wr = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const days = Math.max(1, (endTs - startTs) / DAY);
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
  let peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  let cum = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades: trades.length,
    pf: pf === Infinity ? "INF" : pf.toFixed(2),
    sharpe: sharpe.toFixed(2),
    totalPnl: totalPnl.toFixed(2),
    wr: wr.toFixed(1) + "%",
    perDay: perDay.toFixed(2),
    maxDD: maxDD.toFixed(2),
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

// ── Trend-following proxy: SMA 30/60 daily cross PnL ──
function computeTrendPnl(): Map<number, number> {
  // Build daily candles from hourly for all pairs
  const dailyPnl = new Map<number, number>();

  for (const pair of PAIRS) {
    const hourly = pairHourly.get(pair);
    if (!hourly || hourly.length < 1500) continue; // need ~60 days of hourly
    const sp = SP[pair + "USDT"] ?? 4e-4;
    const totalCost = (TAKER_FEE + sp / 2) * 2;

    // Build daily from hourly
    const byDay = new Map<number, C1H[]>();
    for (const h of hourly) {
      const dayTs = Math.floor(h.t / DAY) * DAY;
      let arr = byDay.get(dayTs);
      if (!arr) { arr = []; byDay.set(dayTs, arr); }
      arr.push(h);
    }
    const dailyArr: { t: number; c: number }[] = [];
    for (const [dayTs, hs] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
      if (hs.length < 20) continue;
      dailyArr.push({ t: dayTs, c: hs[hs.length - 1].c });
    }

    for (let i = 61; i < dailyArr.length; i++) {
      let sum30 = 0, sum60 = 0, prevSum30 = 0, prevSum60 = 0;
      for (let j = i - 29; j <= i; j++) sum30 += dailyArr[j].c;
      for (let j = i - 59; j <= i; j++) sum60 += dailyArr[j].c;
      for (let j = i - 30; j <= i - 1; j++) prevSum30 += dailyArr[j].c;
      for (let j = i - 60; j <= i - 1; j++) prevSum60 += dailyArr[j].c;

      const prevSignal = prevSum30 / 30 > prevSum60 / 60 ? 1 : -1;
      const curSignal = sum30 / 30 > sum60 / 60 ? 1 : -1;
      const dayRet = dailyArr[i].c / dailyArr[i - 1].c - 1;
      const flipped = prevSignal !== curSignal ? 1 : 0;
      const pnl = prevSignal * dayRet * MARGIN * LEV - totalCost * MARGIN * LEV * flipped;
      const dayTs = dailyArr[i].t;
      dailyPnl.set(dayTs, (dailyPnl.get(dayTs) ?? 0) + pnl / PAIRS.length);
    }
  }
  return dailyPnl;
}

// ── Build list of all hour timestamps ──
const allHourTs: number[] = [];
{
  const hourSet = new Set<number>();
  for (const c of btcHourly) {
    if (c.t >= FULL_START && c.t < END) hourSet.add(c.t);
  }
  allHourTs.push(...[...hourSet].sort((a, b) => a - b));
}

// ────────────────────────────────────────────────────────
// STRATEGY 1: Asian Session Fade
// ────────────────────────────────────────────────────────
function runAsianFade(): Trade[] {
  const trades: Trade[] = [];
  const notional = MARGIN * LEV; // $50

  // For each day, check 00:00 to 08:00 BTC move, trade basket 08:00-16:00
  for (const hourTs of allHourTs) {
    const d = new Date(hourTs);
    if (d.getUTCHours() !== 8) continue; // only trigger at 08:00

    const asianStart = hourTs - 8 * HOUR; // 00:00 UTC
    const exitTs = hourTs + 8 * HOUR;     // 16:00 UTC

    // BTC move during Asian session
    const btcOpen = getHourlyOpen(btcHourlyMap, asianStart);
    const btcClose = getHourlyClose(btcHourlyMap, hourTs - HOUR); // close of 07:00 bar
    if (!btcOpen || !btcClose) continue;

    const btcMove = (btcClose - btcOpen) / btcOpen;
    if (Math.abs(btcMove) < 0.01) continue; // need >1% move

    // Fade: if BTC pumped, short basket; if BTC dumped, long basket
    const dir: "long" | "short" = btcMove > 0 ? "short" : "long";

    for (const pair of BASKET_PAIRS) {
      const hm = pairHourlyMap.get(pair);
      if (!hm) continue;

      const entryBar = hm.get(hourTs);
      // Exit bar: close of 15:00 bar
      const exitBar = hm.get(exitTs - HOUR);
      if (!entryBar || !exitBar) continue;

      const ep = entryPrice(entryBar.o, dir, pair, TAKER_FEE);
      const xp = exitPrice(exitBar.c, dir, pair, TAKER_FEE);
      const pnl = tradePnl(ep, xp, dir, notional);

      trades.push({ pair, dir, ep, xp, et: hourTs, xt: exitTs, pnl, notional, strategy: "AsianFade" });
    }
  }
  return trades;
}

// ────────────────────────────────────────────────────────
// STRATEGY 2: US Session Momentum
// ────────────────────────────────────────────────────────
function runUSMomentum(): Trade[] {
  const trades: Trade[] = [];
  const notional = MARGIN * LEV;

  for (const hourTs of allHourTs) {
    const d = new Date(hourTs);
    if (d.getUTCHours() !== 14) continue; // trigger at 14:00

    const exitTs = hourTs + 8 * HOUR; // 22:00

    // Check 12:00-14:00 direction for each pair
    for (const pair of PAIRS) {
      const hm = pairHourlyMap.get(pair);
      if (!hm) continue;

      const bar12 = hm.get(hourTs - 2 * HOUR);
      const bar13 = hm.get(hourTs - HOUR);
      const entryBar = hm.get(hourTs);
      const exitBar = hm.get(exitTs - HOUR);
      if (!bar12 || !bar13 || !entryBar || !exitBar) continue;

      const preMove = (bar13.c - bar12.o) / bar12.o;
      if (Math.abs(preMove) < 0.005) continue; // need >0.5% move

      const dir: "long" | "short" = preMove > 0 ? "long" : "short";
      const ep = entryPrice(entryBar.o, dir, pair, TAKER_FEE);
      const xp = exitPrice(exitBar.c, dir, pair, TAKER_FEE);
      const pnl = tradePnl(ep, xp, dir, notional);

      trades.push({ pair, dir, ep, xp, et: hourTs, xt: exitTs, pnl, notional, strategy: "USMomentum" });
    }
  }
  return trades;
}

// ────────────────────────────────────────────────────────
// STRATEGY 3A: Weekend Fade (short weekend rallies)
// ────────────────────────────────────────────────────────
function runWeekendFade(): Trade[] {
  const trades: Trade[] = [];
  const notional = MARGIN * LEV;

  // Find each Friday 20:00 UTC
  for (const hourTs of allHourTs) {
    const d = new Date(hourTs);
    if (d.getUTCDay() !== 5 || d.getUTCHours() !== 20) continue; // Friday 20:00

    const sundayExit = hourTs + 48 * HOUR; // Sunday 20:00

    for (const pair of PAIRS) {
      const hm = pairHourlyMap.get(pair);
      if (!hm) continue;

      const entryBar = hm.get(hourTs);
      const exitBar = hm.get(sundayExit - HOUR);
      if (!entryBar || !exitBar) continue;

      // Check if there is a weekend rally > 2% by scanning all bars in the window
      let peakPrice = entryBar.o;
      let troughPrice = entryBar.o;
      for (let t = hourTs; t < sundayExit; t += HOUR) {
        const bar = hm.get(t);
        if (!bar) continue;
        if (bar.h > peakPrice) peakPrice = bar.h;
        if (bar.l < troughPrice) troughPrice = bar.l;
      }

      const rallyPct = (peakPrice - entryBar.o) / entryBar.o;
      const dumpPct = (entryBar.o - troughPrice) / entryBar.o;

      // If weekend pump > 2%, we fade it (short at current price, close Sunday)
      // We enter at Saturday 08:00 after seeing the move develop
      const saturdayEntry = hourTs + 12 * HOUR; // Saturday 08:00
      const satBar = hm.get(saturdayEntry);
      if (!satBar) continue;

      const satRally = (satBar.c - entryBar.o) / entryBar.o;
      if (satRally > 0.02) {
        // Short the rally
        const ep = entryPrice(satBar.c, "short", pair, TAKER_FEE);
        const xp = exitPrice(exitBar.c, "short", pair, TAKER_FEE);
        const pnl = tradePnl(ep, xp, "short", notional);
        trades.push({ pair, dir: "short", ep, xp, et: saturdayEntry, xt: sundayExit, pnl, notional, strategy: "WeekendFade" });
      } else if (satRally < -0.02) {
        // Long the dump
        const ep = entryPrice(satBar.c, "long", pair, TAKER_FEE);
        const xp = exitPrice(exitBar.c, "long", pair, TAKER_FEE);
        const pnl = tradePnl(ep, xp, "long", notional);
        trades.push({ pair, dir: "long", ep, xp, et: saturdayEntry, xt: sundayExit, pnl, notional, strategy: "WeekendFade" });
      }
    }
  }
  return trades;
}

// ────────────────────────────────────────────────────────
// STRATEGY 3B: Weekend Drift (buy Friday, sell Sunday)
// ────────────────────────────────────────────────────────
function runWeekendDrift(): Trade[] {
  const trades: Trade[] = [];
  const notional = MARGIN * LEV;

  for (const hourTs of allHourTs) {
    const d = new Date(hourTs);
    if (d.getUTCDay() !== 5 || d.getUTCHours() !== 20) continue;

    const sundayExit = hourTs + 48 * HOUR;

    for (const pair of BASKET_PAIRS) {
      const hm = pairHourlyMap.get(pair);
      if (!hm) continue;

      const entryBar = hm.get(hourTs);
      const exitBar = hm.get(sundayExit - HOUR);
      if (!entryBar || !exitBar) continue;

      const ep = entryPrice(entryBar.o, "long", pair, TAKER_FEE);
      const xp = exitPrice(exitBar.c, "long", pair, TAKER_FEE);
      const pnl = tradePnl(ep, xp, "long", notional);

      trades.push({ pair, dir: "long", ep, xp, et: hourTs, xt: sundayExit, pnl, notional, strategy: "WeekendDrift" });
    }
  }
  return trades;
}

// ────────────────────────────────────────────────────────
// STRATEGY 4: Month-End Rebalance
// ────────────────────────────────────────────────────────
function runMonthEndRebalance(): Trade[] {
  const trades: Trade[] = [];
  const notional = MARGIN * LEV;

  // Find last 2 days of each month
  // We iterate day by day
  const daySet = new Set<number>();
  for (const ts of allHourTs) {
    const dayTs = Math.floor(ts / DAY) * DAY;
    daySet.add(dayTs);
  }
  const allDays = [...daySet].sort((a, b) => a - b);

  for (let i = 0; i < allDays.length; i++) {
    const dayTs = allDays[i];
    const d = new Date(dayTs);
    const month = d.getUTCMonth();
    const year = d.getUTCFullYear();

    // Check if this is day before last day of month (penultimate day)
    const nextDay = new Date(dayTs + DAY);
    const dayAfterNext = new Date(dayTs + 2 * DAY);
    if (nextDay.getUTCMonth() === month && dayAfterNext.getUTCMonth() !== month) {
      // This is the penultimate day - entry at 00:00 UTC

      // BTC month-to-date return
      const monthStart = new Date(year, month, 1).getTime();
      const btcMonthOpen = btcHourlyMap.get(Math.floor(monthStart / HOUR) * HOUR);
      const btcNow = btcHourlyMap.get(dayTs);
      if (!btcMonthOpen || !btcNow) continue;

      const btcMTD = (btcNow.c - btcMonthOpen.o) / btcMonthOpen.o;
      if (Math.abs(btcMTD) < 0.05) continue; // need >5% monthly move

      // BTC up >5%: funds sell, short. BTC down >5%: funds buy, long.
      const dir: "long" | "short" = btcMTD > 0 ? "short" : "long";
      const holdEnd = dayTs + 4 * DAY; // hold ~48h into new month

      for (const pair of BASKET_PAIRS) {
        const hm = pairHourlyMap.get(pair);
        if (!hm) continue;

        const entryBar = hm.get(dayTs);
        // Find exit bar closest to holdEnd
        let exitBar: C1H | undefined;
        for (let t = holdEnd; t > dayTs; t -= HOUR) {
          exitBar = hm.get(t);
          if (exitBar) break;
        }
        if (!entryBar || !exitBar) continue;

        const ep = entryPrice(entryBar.o, dir, pair, TAKER_FEE);
        const xp = exitPrice(exitBar.c, dir, pair, TAKER_FEE);
        const pnl = tradePnl(ep, xp, dir, notional);

        trades.push({ pair, dir, ep, xp, et: dayTs, xt: holdEnd, pnl, notional, strategy: "MonthEnd" });
      }
    }
  }
  return trades;
}

// ────────────────────────────────────────────────────────
// STRATEGY 5: Hour-of-Day Return Analysis
// ────────────────────────────────────────────────────────
function runHourOfDay(): { trades: Trade[]; analysis: { hour: number; avgRet: number; count: number; tStat: number }[] } {
  // Phase 1: compute average hourly return for each UTC hour (IS period)
  const hourReturns: number[][] = Array.from({ length: 24 }, () => []);

  for (const pair of PAIRS) {
    const hourly = pairHourly.get(pair);
    if (!hourly) continue;

    for (let i = 1; i < hourly.length; i++) {
      const h = hourly[i];
      if (h.t < FULL_START || h.t >= OOS_START) continue; // IS only for discovery
      const prev = hourly[i - 1];
      if (h.t - prev.t !== HOUR) continue; // skip gaps
      const ret = (h.c - prev.c) / prev.c;
      const hour = new Date(h.t).getUTCHours();
      hourReturns[hour].push(ret);
    }
  }

  const analysis = hourReturns.map((rets, hour) => {
    if (rets.length === 0) return { hour, avgRet: 0, count: 0, tStat: 0 };
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
    const tStat = std > 0 ? mean / (std / Math.sqrt(rets.length)) : 0;
    return { hour, avgRet: mean, count: rets.length, tStat };
  });

  // Sort by avgRet to find best/worst
  const sorted = [...analysis].sort((a, b) => b.avgRet - a.avgRet);
  const bestHours = sorted.slice(0, 3).map(a => a.hour);
  const worstHours = sorted.slice(-3).map(a => a.hour);

  // Phase 2: trade on all data (full period) using the IS-discovered hours
  const trades: Trade[] = [];
  const notional = MARGIN * LEV;

  for (const hourTs of allHourTs) {
    const d = new Date(hourTs);
    const hour = d.getUTCHours();
    const exitTs = hourTs + HOUR;

    let dir: "long" | "short" | null = null;
    if (bestHours.includes(hour)) dir = "long";
    else if (worstHours.includes(hour)) dir = "short";
    else continue;

    for (const pair of BASKET_PAIRS) {
      const hm = pairHourlyMap.get(pair);
      if (!hm) continue;

      const entryBar = hm.get(hourTs);
      const exitBar = hm.get(exitTs);
      if (!entryBar || !exitBar) continue;

      // Maker fees for limit orders at hour boundary
      const ep = entryPrice(entryBar.o, dir, pair, MAKER_FEE);
      const xp = exitPrice(exitBar.o, dir, pair, MAKER_FEE); // exit at next hour open (limit)
      const pnl = tradePnl(ep, xp, dir, notional);

      trades.push({ pair, dir, ep, xp, et: hourTs, xt: exitTs, pnl, notional, strategy: "HourOfDay" });
    }
  }

  return { trades, analysis };
}

// ────────────────────────────────────────────────────────
// STRATEGY 6: Day-of-Week Effect
// ────────────────────────────────────────────────────────
function runDayOfWeek(): { trades: Trade[]; analysis: { day: string; avgRet: number; count: number; tStat: number }[] } {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayReturns: number[][] = Array.from({ length: 7 }, () => []);

  // Build daily returns from hourly for IS period
  for (const pair of PAIRS) {
    const hourly = pairHourly.get(pair);
    if (!hourly) continue;

    const byDay = new Map<number, C1H[]>();
    for (const h of hourly) {
      const dayTs = Math.floor(h.t / DAY) * DAY;
      let arr = byDay.get(dayTs);
      if (!arr) { arr = []; byDay.set(dayTs, arr); }
      arr.push(h);
    }

    const dailyPrices: { t: number; open: number; close: number }[] = [];
    for (const [dayTs, hs] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
      if (hs.length < 20) continue;
      dailyPrices.push({ t: dayTs, open: hs[0].o, close: hs[hs.length - 1].c });
    }

    for (let i = 1; i < dailyPrices.length; i++) {
      const dp = dailyPrices[i];
      if (dp.t < FULL_START || dp.t >= OOS_START) continue; // IS only
      const ret = (dp.close - dailyPrices[i - 1].close) / dailyPrices[i - 1].close;
      const dow = new Date(dp.t).getUTCDay();
      dayReturns[dow].push(ret);
    }
  }

  const analysis = dayReturns.map((rets, day) => {
    if (rets.length === 0) return { day: dayNames[day], avgRet: 0, count: 0, tStat: 0 };
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
    const tStat = std > 0 ? mean / (std / Math.sqrt(rets.length)) : 0;
    return { day: dayNames[day], avgRet: mean, count: rets.length, tStat };
  });

  // Find best and worst day
  const sorted = [...analysis].sort((a, b) => b.avgRet - a.avgRet);
  const bestDayIdx = dayNames.indexOf(sorted[0].day);
  const worstDayIdx = dayNames.indexOf(sorted[sorted.length - 1].day);

  // Trade full period using IS-discovered days
  const trades: Trade[] = [];
  const notional = MARGIN * LEV;

  // Collect daily timestamps
  const daySet = new Set<number>();
  for (const ts of allHourTs) {
    const dayTs = Math.floor(ts / DAY) * DAY;
    daySet.add(dayTs);
  }
  const allDays = [...daySet].sort((a, b) => a - b);

  for (const dayTs of allDays) {
    const dow = new Date(dayTs).getUTCDay();
    let dir: "long" | "short" | null = null;
    if (dow === bestDayIdx) dir = "long";
    else if (dow === worstDayIdx) dir = "short";
    else continue;

    const exitTs = dayTs + DAY;

    for (const pair of BASKET_PAIRS) {
      const hm = pairHourlyMap.get(pair);
      if (!hm) continue;

      const entryBar = hm.get(dayTs);
      // Find last bar of the day
      let exitBar: C1H | undefined;
      for (let t = exitTs - HOUR; t >= dayTs; t -= HOUR) {
        exitBar = hm.get(t);
        if (exitBar) break;
      }
      if (!entryBar || !exitBar) continue;

      const ep = entryPrice(entryBar.o, dir, pair, TAKER_FEE);
      const xp = exitPrice(exitBar.c, dir, pair, TAKER_FEE);
      const pnl = tradePnl(ep, xp, dir, notional);

      trades.push({ pair, dir, ep, xp, et: dayTs, xt: exitTs, pnl, notional, strategy: "DayOfWeek" });
    }
  }

  return { trades, analysis };
}

// ────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────
console.log("\n=== Time-of-Day & Seasonality Effects Backtest ===");
console.log(`Period: 2023-01 to 2026-03 | OOS: 2025-09-01`);
console.log(`Pairs: ${PAIRS.length} altcoins + BTC reference`);
console.log(`Leverage: ${LEV}x | Margin: $${MARGIN}/pos | Notional: $${MARGIN * LEV}`);
console.log(`Fees: Taker ${TAKER_FEE * 100}% | Maker ${MAKER_FEE * 100}% | + half-spread per side`);

// Compute trend proxy for correlation
console.log("\nComputing trend-following proxy (SMA 30/60)...");
const trendDailyPnl = computeTrendPnl();

function computeCorrelation(trades: Trade[]): string {
  const weeklyPnl = new Map<number, number>();
  for (const t of trades) {
    const week = Math.floor(t.xt / (7 * DAY));
    weeklyPnl.set(week, (weeklyPnl.get(week) ?? 0) + t.pnl);
  }
  const trendWeekly = new Map<number, number>();
  for (const [dayTs, pnl] of trendDailyPnl) {
    if (dayTs < FULL_START || dayTs >= END) continue;
    const week = Math.floor(dayTs / (7 * DAY));
    trendWeekly.set(week, (trendWeekly.get(week) ?? 0) + pnl);
  }
  const commonWeeks = [...weeklyPnl.keys()].filter(w => trendWeekly.has(w)).sort();
  if (commonWeeks.length < 5) return "N/A (insufficient overlap)";
  const a = commonWeeks.map(w => weeklyPnl.get(w)!);
  const b = commonWeeks.map(w => trendWeekly.get(w)!);
  return `${pearsonCorr(a, b).toFixed(3)} (n=${commonWeeks.length} weeks)`;
}

function printStrategyResult(name: string, trades: Trade[]) {
  const sep = "-".repeat(80);
  console.log(`\n${sep}`);
  console.log(`>>> ${name}`);
  console.log(sep);

  const fullTrades = trades.filter(t => t.et >= FULL_START && t.xt <= END);
  const oosTrades = trades.filter(t => t.et >= OOS_START);

  const full = computeStats(fullTrades, FULL_START, END);
  const oos = computeStats(oosTrades, OOS_START, END);

  console.log(`\n  FULL PERIOD (2023-01 to 2026-03):`);
  console.log(`    Trades: ${full.trades} | PF: ${full.pf} | Sharpe: ${full.sharpe} | WR: ${full.wr}`);
  console.log(`    Total PnL: $${full.totalPnl} | $/day: ${full.perDay} | MaxDD: $${full.maxDD}`);

  console.log(`  OOS (2025-09-01 onwards):`);
  console.log(`    Trades: ${oos.trades} | PF: ${oos.pf} | Sharpe: ${oos.sharpe} | WR: ${oos.wr}`);
  console.log(`    Total PnL: $${oos.totalPnl} | $/day: ${oos.perDay} | MaxDD: $${oos.maxDD}`);

  const corr = computeCorrelation(fullTrades);
  console.log(`  Correlation with trend-following: ${corr}`);

  // Direction breakdown
  const longTrades = fullTrades.filter(t => t.dir === "long");
  const shortTrades = fullTrades.filter(t => t.dir === "short");
  const longPnl = longTrades.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`  Long: ${longTrades.length} trades, $${longPnl.toFixed(2)} | Short: ${shortTrades.length} trades, $${shortPnl.toFixed(2)}`);
}

// ── Run all strategies ──

// 1. Asian Session Fade
console.log("\nRunning strategies...");
const asianTrades = runAsianFade();
printStrategyResult("1. Asian Session Fade (00-08 BTC >1% -> fade at 08:00, close 16:00, basket top 5)", asianTrades);

// 2. US Session Momentum
const usTrades = runUSMomentum();
printStrategyResult("2. US Session Momentum (14:00-22:00, follow 12:00-14:00 direction >0.5%)", usTrades);

// 3A. Weekend Fade
const wkndFadeTrades = runWeekendFade();
printStrategyResult("3A. Weekend Fade (short weekend rallies >2%, long dumps >2%)", wkndFadeTrades);

// 3B. Weekend Drift
const wkndDriftTrades = runWeekendDrift();
printStrategyResult("3B. Weekend Drift (buy Fri 20:00, sell Sun 20:00, basket top 5)", wkndDriftTrades);

// 4. Month-End Rebalance
const monthEndTrades = runMonthEndRebalance();
printStrategyResult("4. Month-End Rebalance (BTC >5% MTD: short, <-5%: long, hold 48h)", monthEndTrades);

// 5. Hour-of-Day
const { trades: hourTrades, analysis: hourAnalysis } = runHourOfDay();
console.log("\n" + "-".repeat(80));
console.log(">>> 5. Hour-of-Day Return Analysis (IS discovery -> full period trade)");
console.log("-".repeat(80));

console.log("\n  Hourly Return Profile (IS period, all pairs):");
console.log("  Hour | Avg Ret (bps) | Count  | t-stat");
console.log("  " + "-".repeat(50));
const sortedHours = [...hourAnalysis].sort((a, b) => b.avgRet - a.avgRet);
for (const a of sortedHours) {
  const marker = a.tStat > 2 ? " **" : a.tStat < -2 ? " **" : "";
  console.log(`  ${String(a.hour).padStart(4)}  | ${(a.avgRet * 10000).toFixed(2).padStart(12)} | ${String(a.count).padStart(6)} | ${a.tStat.toFixed(2).padStart(6)}${marker}`);
}

{
  const fullTrades = hourTrades.filter(t => t.et >= FULL_START && t.xt <= END);
  const oosTrades = hourTrades.filter(t => t.et >= OOS_START);
  const full = computeStats(fullTrades, FULL_START, END);
  const oos = computeStats(oosTrades, OOS_START, END);

  console.log(`\n  FULL PERIOD:`);
  console.log(`    Trades: ${full.trades} | PF: ${full.pf} | Sharpe: ${full.sharpe} | WR: ${full.wr}`);
  console.log(`    Total PnL: $${full.totalPnl} | $/day: ${full.perDay} | MaxDD: $${full.maxDD}`);
  console.log(`  OOS:`);
  console.log(`    Trades: ${oos.trades} | PF: ${oos.pf} | Sharpe: ${oos.sharpe} | WR: ${oos.wr}`);
  console.log(`    Total PnL: $${oos.totalPnl} | $/day: ${oos.perDay} | MaxDD: $${oos.maxDD}`);
  console.log(`  Correlation with trend-following: ${computeCorrelation(fullTrades)}`);

  const bestHours = sortedHours.slice(0, 3).map(a => a.hour);
  const worstHours = sortedHours.slice(-3).map(a => a.hour);
  console.log(`  Best 3 hours (long): ${bestHours.join(", ")} UTC`);
  console.log(`  Worst 3 hours (short): ${worstHours.join(", ")} UTC`);

  // OOS breakdown by discovered hours
  console.log("  OOS by hour:");
  for (const h of [...bestHours, ...worstHours]) {
    const hourOos = oosTrades.filter(t => new Date(t.et).getUTCHours() === h);
    const pnl = hourOos.reduce((s, t) => s + t.pnl, 0);
    const dir = bestHours.includes(h) ? "long" : "short";
    console.log(`    Hour ${String(h).padStart(2)} (${dir}): ${hourOos.length} trades, $${pnl.toFixed(2)}`);
  }
}

// 6. Day-of-Week
const { trades: dowTrades, analysis: dowAnalysis } = runDayOfWeek();
console.log("\n" + "-".repeat(80));
console.log(">>> 6. Day-of-Week Effect (IS discovery -> full period trade)");
console.log("-".repeat(80));

console.log("\n  Daily Return Profile (IS period, all pairs):");
console.log("  Day | Avg Ret (bps) | Count  | t-stat");
console.log("  " + "-".repeat(50));
const sortedDow = [...dowAnalysis].sort((a, b) => b.avgRet - a.avgRet);
for (const a of sortedDow) {
  const marker = a.tStat > 2 ? " **" : a.tStat < -2 ? " **" : "";
  console.log(`  ${a.day.padEnd(5)} | ${(a.avgRet * 10000).toFixed(2).padStart(12)} | ${String(a.count).padStart(6)} | ${a.tStat.toFixed(2).padStart(6)}${marker}`);
}

{
  const fullTrades = dowTrades.filter(t => t.et >= FULL_START && t.xt <= END);
  const oosTrades = dowTrades.filter(t => t.et >= OOS_START);
  const full = computeStats(fullTrades, FULL_START, END);
  const oos = computeStats(oosTrades, OOS_START, END);

  console.log(`\n  FULL PERIOD:`);
  console.log(`    Trades: ${full.trades} | PF: ${full.pf} | Sharpe: ${full.sharpe} | WR: ${full.wr}`);
  console.log(`    Total PnL: $${full.totalPnl} | $/day: ${full.perDay} | MaxDD: $${full.maxDD}`);
  console.log(`  OOS:`);
  console.log(`    Trades: ${oos.trades} | PF: ${oos.pf} | Sharpe: ${oos.sharpe} | WR: ${oos.wr}`);
  console.log(`    Total PnL: $${oos.totalPnl} | $/day: ${oos.perDay} | MaxDD: $${oos.maxDD}`);
  console.log(`  Correlation with trend-following: ${computeCorrelation(fullTrades)}`);
  console.log(`  Best day (long): ${sortedDow[0].day} | Worst day (short): ${sortedDow[sortedDow.length - 1].day}`);
}

// ────────────────────────────────────────────────────────
// SUMMARY TABLE
// ────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("\n=== SUMMARY TABLE ===\n");

const allStrategies: { name: string; trades: Trade[] }[] = [
  { name: "1. Asian Session Fade", trades: asianTrades },
  { name: "2. US Session Momentum", trades: usTrades },
  { name: "3A. Weekend Fade", trades: wkndFadeTrades },
  { name: "3B. Weekend Drift", trades: wkndDriftTrades },
  { name: "4. Month-End Rebalance", trades: monthEndTrades },
  { name: "5. Hour-of-Day", trades: hourTrades },
  { name: "6. Day-of-Week", trades: dowTrades },
];

console.log(
  "Strategy".padEnd(28) +
  "Trades".padStart(7) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "Total$".padStart(10) +
  "$/day".padStart(8) +
  "WR".padStart(8) +
  "MaxDD$".padStart(10) +
  " | OOS: " +
  "Trades".padStart(7) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(8) +
  "Corr".padStart(8)
);
console.log("-".repeat(140));

for (const { name, trades } of allStrategies) {
  const fullTrades = trades.filter(t => t.et >= FULL_START && t.xt <= END);
  const oosTrades = trades.filter(t => t.et >= OOS_START);

  const f = computeStats(fullTrades, FULL_START, END);
  const o = computeStats(oosTrades, OOS_START, END);
  const corr = computeCorrelation(fullTrades);
  const corrVal = corr.startsWith("N/A") ? "N/A" : corr.split(" ")[0];

  console.log(
    name.padEnd(28) +
    String(f.trades).padStart(7) +
    f.pf.padStart(7) +
    f.sharpe.padStart(8) +
    ("$" + f.totalPnl).padStart(10) +
    f.perDay.padStart(8) +
    f.wr.padStart(8) +
    ("$" + f.maxDD).padStart(10) +
    " | " +
    String(o.trades).padStart(7) +
    o.pf.padStart(7) +
    o.sharpe.padStart(8) +
    o.perDay.padStart(8) +
    corrVal.padStart(8)
  );
}

console.log("\nDone.");
