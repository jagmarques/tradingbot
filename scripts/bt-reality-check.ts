/**
 * FINAL REALITY CHECK: Balanced Trend Ensemble
 *
 * Strips away all favorable conditions to find TRUE expected performance.
 * Conservative cost model: DOUBLED spreads + 0.1% extra slippage + taker fees.
 */
import * as fs from "fs";
import * as path from "path";
import { SMA, EMA, ATR } from "technicalindicators";

// ============ TYPES ============
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Trade {
  pair: string; strat: "A" | "B"; dir: "long" | "short";
  ep: number; xp: number; et: number; xt: number;
  pnl: number; reason: string;
}
interface PosA {
  pair: string; dir: "long" | "short"; ep: number; et: number;
  sl: number; maxHold: number;
}
interface PosB {
  pair: string; dir: "long" | "short"; ep: number; et: number;
}

// ============ CONSTANTS ============
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const DAY = 86400000;
const H4 = 4 * 3600000;
const BASE_FEE = 0.00035; // taker fee
const SZ = 5; // $5 margin per trade
const LEV = 10;
const NOT_SZ = SZ * LEV; // $50 notional
const MAX_POS = 10;
const SL_SLIP = 1.5; // extra slippage multiplier on SL fills

const PAIRS = [
  "ADAUSDT", "APTUSDT", "ARBUSDT", "BTCUSDT", "DASHUSDT", "DOGEUSDT",
  "DOTUSDT", "ENAUSDT", "ETHUSDT", "LDOUSDT", "LINKUSDT", "OPUSDT",
  "SOLUSDT", "TIAUSDT", "TRUMPUSDT", "UNIUSDT", "WIFUSDT", "WLDUSDT", "XRPUSDT",
];

// STANDARD spreads (will be DOUBLED in conservative mode)
const SP_BASE: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ETHUSDT: 1.5e-4, SOLUSDT: 2.0e-4,
  ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4, TIAUSDT: 2.5e-4, UNIUSDT: 2.75e-4,
  APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4, WLDUSDT: 4e-4,
  DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4, LDOUSDT: 5.8e-4,
  OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
};

// ============ DATA LOADING ============
function load5m(pair: string): C[] {
  const f = path.join(CACHE_5M, pair + ".json");
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }
  );
}

function aggregateToDaily(bars5m: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
    const dayStart = Math.floor(b.t / DAY) * DAY;
    let arr = groups.get(dayStart);
    if (!arr) { arr = []; groups.set(dayStart, arr); }
    arr.push(b);
  }
  const daily: C[] = [];
  for (const [t, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 200) continue;
    daily.push({
      t, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return daily;
}

function aggregateTo4h(bars5m: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
    const h4Start = Math.floor(b.t / H4) * H4;
    let arr = groups.get(h4Start);
    if (!arr) { arr = []; groups.set(h4Start, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [t, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 40) continue;
    result.push({
      t, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return result;
}

// ============ INDICATOR HELPERS ============
function calcSMA(candles: C[], period: number): number[] {
  const raw = SMA.calculate({ period, values: candles.map(c => c.c) });
  const pad = candles.length - raw.length;
  return [...new Array(pad).fill(NaN), ...raw];
}

function calcEMA(candles: C[], period: number): number[] {
  const raw = EMA.calculate({ period, values: candles.map(c => c.c) });
  const pad = candles.length - raw.length;
  return [...new Array(pad).fill(NaN), ...raw];
}

function calcATR(candles: C[], period: number): number[] {
  const raw = ATR.calculate({
    period,
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    close: candles.map(c => c.c),
  });
  const pad = candles.length - raw.length;
  return [...new Array(pad).fill(NaN), ...raw];
}

function calcDonchianHigh(candles: C[], period: number): number[] {
  const result = new Array(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let mx = -Infinity;
    for (let j = i - period; j < i; j++) mx = Math.max(mx, candles[j].h);
    result[i] = mx;
  }
  return result;
}

function calcDonchianLow(candles: C[], period: number): number[] {
  const result = new Array(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let mn = Infinity;
    for (let j = i - period; j < i; j++) mn = Math.min(mn, candles[j].l);
    result[i] = mn;
  }
  return result;
}

function calcSupertrend(candles: C[], period: number, multiplier: number): { st: number[]; dir: number[] } {
  const atr = calcATR(candles, period);
  const st = new Array(candles.length).fill(NaN);
  const dir = new Array(candles.length).fill(0);

  for (let i = period; i < candles.length; i++) {
    if (isNaN(atr[i])) continue;
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    let upperBand: number;
    if (i === period || isNaN(st[i - 1])) {
      upperBand = basicUpper;
    } else {
      const prevUpper = dir[i - 1] === -1 ? st[i - 1] : basicUpper;
      upperBand = basicUpper < prevUpper ? basicUpper : (candles[i - 1].c > prevUpper ? basicUpper : prevUpper);
    }

    let lowerBand: number;
    if (i === period || isNaN(st[i - 1])) {
      lowerBand = basicLower;
    } else {
      const prevLower = dir[i - 1] === 1 ? st[i - 1] : basicLower;
      lowerBand = basicLower > prevLower ? basicLower : (candles[i - 1].c < prevLower ? basicLower : prevLower);
    }

    if (i === period) {
      dir[i] = candles[i].c > upperBand ? 1 : -1;
      st[i] = dir[i] === 1 ? lowerBand : upperBand;
    } else {
      if (dir[i - 1] === 1) {
        if (candles[i].c < lowerBand) { dir[i] = -1; st[i] = upperBand; }
        else { dir[i] = 1; st[i] = lowerBand; }
      } else {
        if (candles[i].c > upperBand) { dir[i] = 1; st[i] = lowerBand; }
        else { dir[i] = -1; st[i] = upperBand; }
      }
    }
  }
  return { st, dir };
}

// ============ PRECOMPUTED DATA ============
interface DailyData {
  cs: C[]; sma30: number[]; sma60: number[];
  atr14: number[]; donHi15: number[]; donLo15: number[];
}
interface H4Data { cs: C[]; stDir: number[]; stVal: number[]; }
interface BtcDailyData { cs: C[]; ema20: number[]; ema50: number[]; }

function prepDaily(candles: C[]): DailyData {
  return {
    cs: candles, sma30: calcSMA(candles, 30), sma60: calcSMA(candles, 60),
    atr14: calcATR(candles, 14), donHi15: calcDonchianHigh(candles, 15), donLo15: calcDonchianLow(candles, 15),
  };
}
function prepH4(candles: C[]): H4Data {
  const { st, dir } = calcSupertrend(candles, 14, 2);
  return { cs: candles, stDir: dir, stVal: st };
}
function prepBtcDaily(candles: C[]): BtcDailyData {
  return { cs: candles, ema20: calcEMA(candles, 20), ema50: calcEMA(candles, 50) };
}

// ============ SIMULATION ============
interface SimOpts {
  maxPos: number;
  spreadMult: number;    // 1.0 = normal, 2.0 = doubled spreads
  extraSlipPct: number;  // extra slippage pct per trade (e.g. 0.1 = 0.1%)
  feeMult: number;       // fee multiplier
}

const CONSERVATIVE: SimOpts = { maxPos: MAX_POS, spreadMult: 2.0, extraSlipPct: 0.1, feeMult: 1.0 };
const NORMAL: SimOpts = { maxPos: MAX_POS, spreadMult: 1.0, extraSlipPct: 0.0, feeMult: 1.0 };

function simulate(
  dailyMap: Map<string, DailyData>,
  h4Map: Map<string, H4Data>,
  btcDaily: BtcDailyData,
  startTs: number,
  endTs: number,
  opts: SimOpts,
): Trade[] {
  const trades: Trade[] = [];
  const posA = new Map<string, PosA>();
  const posB = new Map<string, PosB>();
  const totalPos = () => posA.size + posB.size;

  function btcLongOk(dayTs: number): boolean {
    for (let i = btcDaily.cs.length - 1; i >= 0; i--) {
      if (btcDaily.cs[i].t <= dayTs) {
        const e20 = btcDaily.ema20[i];
        const e50 = btcDaily.ema50[i];
        if (isNaN(e20) || isNaN(e50)) return false;
        return e20 > e50;
      }
    }
    return false;
  }

  function getSpread(pair: string): number {
    return (SP_BASE[pair] ?? 4e-4) * opts.spreadMult;
  }

  function getExtraSlip(): number {
    return opts.extraSlipPct / 100;
  }

  function getFee(): number {
    return BASE_FEE * opts.feeMult;
  }

  // Build index maps
  const dailyIdxMap = new Map<string, Map<number, number>>();
  for (const [pair, dd] of dailyMap) {
    const m = new Map<number, number>();
    dd.cs.forEach((c, i) => m.set(c.t, i));
    dailyIdxMap.set(pair, m);
  }
  const h4IdxMap = new Map<string, Map<number, number>>();
  for (const [pair, hd] of h4Map) {
    const m = new Map<number, number>();
    hd.cs.forEach((c, i) => m.set(c.t, i));
    h4IdxMap.set(pair, m);
  }

  // Build sorted timelines within range
  const dailyTimestamps = new Set<number>();
  for (const dd of dailyMap.values()) {
    for (const c of dd.cs) {
      if (c.t >= startTs && c.t < endTs) dailyTimestamps.add(c.t);
    }
  }
  const sortedDailyTs = [...dailyTimestamps].sort((a, b) => a - b);

  const h4Timestamps = new Set<number>();
  for (const hd of h4Map.values()) {
    for (const c of hd.cs) {
      if (c.t >= startTs && c.t < endTs) h4Timestamps.add(c.t);
    }
  }
  const sortedH4Ts = [...h4Timestamps].sort((a, b) => a - b);

  // ---- STRATEGY A: Daily SMA(30/60) ----
  for (const dayTs of sortedDailyTs) {
    const closedToday = new Set<string>();

    // EXIT Strategy A
    for (const [pair, pos] of posA) {
      const dd = dailyMap.get(pair);
      if (!dd) continue;
      const idx = dailyIdxMap.get(pair)?.get(dayTs) ?? -1;
      if (idx < 0) continue;
      const bar = dd.cs[idx];
      const sp = getSpread(pair);
      const fee = getFee();
      const slip = getExtraSlip();
      let xp = 0;
      let reason = "";

      // SL check
      if (pos.dir === "long" && bar.l <= pos.sl) {
        xp = pos.sl * (1 - sp * SL_SLIP - slip);
        reason = "sl";
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        xp = pos.sl * (1 + sp * SL_SLIP + slip);
        reason = "sl";
      }

      // Donchian 15d exit
      if (!reason && idx > 0) {
        if (pos.dir === "long" && !isNaN(dd.donLo15[idx]) && bar.c < dd.donLo15[idx]) {
          xp = bar.c * (1 - sp - slip);
          reason = "don-exit";
        } else if (pos.dir === "short" && !isNaN(dd.donHi15[idx]) && bar.c > dd.donHi15[idx]) {
          xp = bar.c * (1 + sp + slip);
          reason = "don-exit";
        }
      }

      // Max hold 60 days
      if (!reason && dayTs - pos.et >= 60 * DAY) {
        xp = bar.c * (pos.dir === "long" ? (1 - sp - slip) : (1 + sp + slip));
        reason = "mh";
      }

      if (xp > 0) {
        const raw = pos.dir === "long"
          ? (xp / pos.ep - 1) * NOT_SZ
          : (pos.ep / xp - 1) * NOT_SZ;
        const fees = NOT_SZ * fee * 2;
        trades.push({
          pair, strat: "A", dir: pos.dir,
          ep: pos.ep, xp, et: pos.et, xt: dayTs,
          pnl: raw - fees, reason,
        });
        posA.delete(pair);
        closedToday.add(pair);
      }
    }

    // ENTRY Strategy A
    for (const pair of PAIRS) {
      if (pair === "BTCUSDT") continue;
      if (posA.has(pair) || closedToday.has(pair)) continue;
      if (totalPos() >= opts.maxPos) break;

      const dd = dailyMap.get(pair);
      if (!dd) continue;
      const idx = dailyIdxMap.get(pair)?.get(dayTs) ?? -1;
      if (idx < 1) continue;

      const prevIdx = idx - 1;
      const sma30prev = dd.sma30[prevIdx];
      const sma60prev = dd.sma60[prevIdx];
      if (isNaN(sma30prev) || isNaN(sma60prev)) continue;
      if (prevIdx < 1) continue;
      const sma30prev2 = dd.sma30[prevIdx - 1];
      const sma60prev2 = dd.sma60[prevIdx - 1];
      if (isNaN(sma30prev2) || isNaN(sma60prev2)) continue;

      let dir: "long" | "short" | null = null;
      if (sma30prev2 <= sma60prev2 && sma30prev > sma60prev) dir = "long";
      else if (sma30prev2 >= sma60prev2 && sma30prev < sma60prev) dir = "short";
      if (!dir) continue;

      // BTC filter for longs only
      if (dir === "long" && !btcLongOk(dd.cs[prevIdx].t)) continue;

      const ep = dd.cs[idx].o;
      const sp = getSpread(pair);
      const slip = getExtraSlip();
      const entryPrice = dir === "long"
        ? ep * (1 + sp + slip)
        : ep * (1 - sp - slip);

      const atrVal = dd.atr14[prevIdx];
      if (isNaN(atrVal) || atrVal <= 0) continue;
      const slDist = atrVal * 3;
      const sl = dir === "long" ? entryPrice - slDist : entryPrice + slDist;

      posA.set(pair, { pair, dir, ep: entryPrice, et: dayTs, sl, maxHold: dayTs + 60 * DAY });
    }
  }

  // ---- STRATEGY B: 4h Supertrend(14,2) ----
  for (const h4Ts of sortedH4Ts) {
    const closedNow = new Set<string>();

    // EXIT Strategy B
    for (const [pair, pos] of posB) {
      const hd = h4Map.get(pair);
      if (!hd) continue;
      const idx = h4IdxMap.get(pair)?.get(h4Ts) ?? -1;
      if (idx < 1) continue;

      const curDir = hd.stDir[idx];
      const prevDir = hd.stDir[idx - 1];

      let shouldExit = false;
      if (pos.dir === "long" && curDir === -1 && prevDir === 1) shouldExit = true;
      if (pos.dir === "short" && curDir === 1 && prevDir === -1) shouldExit = true;

      if (shouldExit) {
        const bar = hd.cs[idx];
        const sp = getSpread(pair);
        const slip = getExtraSlip();
        const xp = pos.dir === "long"
          ? bar.o * (1 - sp - slip)
          : bar.o * (1 + sp + slip);

        const raw = pos.dir === "long"
          ? (xp / pos.ep - 1) * NOT_SZ
          : (pos.ep / xp - 1) * NOT_SZ;
        const fees = NOT_SZ * getFee() * 2;

        trades.push({
          pair, strat: "B", dir: pos.dir,
          ep: pos.ep, xp, et: pos.et, xt: h4Ts,
          pnl: raw - fees, reason: "st-flip",
        });
        posB.delete(pair);
        closedNow.add(pair);
      }
    }

    // ENTRY Strategy B
    for (const pair of PAIRS) {
      if (pair === "BTCUSDT") continue;
      if (posB.has(pair) || closedNow.has(pair)) continue;
      if (totalPos() >= opts.maxPos) break;

      const hd = h4Map.get(pair);
      if (!hd) continue;
      const idx = h4IdxMap.get(pair)?.get(h4Ts) ?? -1;
      if (idx < 2) continue;

      const curDir = hd.stDir[idx - 1];
      const prevDir = hd.stDir[idx - 2];
      if (curDir === 0 || prevDir === 0) continue;
      if (curDir === prevDir) continue;

      let dir: "long" | "short" | null = null;
      if (curDir === 1 && prevDir === -1) dir = "long";
      if (curDir === -1 && prevDir === 1) dir = "short";
      if (!dir) continue;

      if (dir === "long" && !btcLongOk(h4Ts)) continue;

      const bar = hd.cs[idx];
      const sp = getSpread(pair);
      const slip = getExtraSlip();
      const ep = dir === "long"
        ? bar.o * (1 + sp + slip)
        : bar.o * (1 - sp - slip);

      posB.set(pair, { pair, dir, ep, et: h4Ts });
    }
  }

  trades.sort((a, b) => a.xt - b.xt);
  return trades;
}

// ============ METRICS ============
interface Metrics {
  trades: number; wins: number; wr: number; totalPnl: number; pf: number;
  perDay: number; sharpe: number; maxDD: number; maxDDDays: number;
  longestLosing: number; losingStreakPnl: number;
  monthlyWinRate: number; monthlyPnls: number[];
  dailyPnls: number[];
  bestDay: number; worstDay: number;
  bestWeek: number; worstWeek: number;
  bestMonth: number; worstMonth: number;
  drawdowns: { depth: number; startTs: number; endTs: number; recoveryDays: number }[];
}

function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  const days = (endTs - startTs) / DAY;
  const wins = trades.filter(t => t.pnl > 0).length;
  const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Max drawdown + all drawdowns > $30
  let cum = 0, pk = 0, maxDD = 0;
  let inDD = false, ddStartTime = startTs, maxDDDays = 0;
  const drawdowns: { depth: number; startTs: number; endTs: number; recoveryDays: number }[] = [];
  let currentDDPeak = 0;
  let currentDDStart = startTs;

  for (const t of trades) {
    cum += t.pnl;
    if (cum > pk) {
      // Recovered from drawdown
      if (inDD) {
        const depth = currentDDPeak;
        const recoveryDays = (t.xt - currentDDStart) / DAY;
        if (depth > 30) {
          drawdowns.push({ depth, startTs: currentDDStart, endTs: t.xt, recoveryDays });
        }
        const dur = (t.xt - ddStartTime) / DAY;
        if (dur > maxDDDays) maxDDDays = dur;
        inDD = false;
      }
      pk = cum;
      currentDDPeak = 0;
    }
    const dd = pk - cum;
    if (dd > 0) {
      if (!inDD) {
        inDD = true;
        ddStartTime = t.xt;
        currentDDStart = t.xt;
        currentDDPeak = 0;
      }
      if (dd > currentDDPeak) currentDDPeak = dd;
      if (dd > maxDD) maxDD = dd;
    }
  }
  if (inDD) {
    const dur = (endTs - ddStartTime) / DAY;
    if (dur > maxDDDays) maxDDDays = dur;
    if (currentDDPeak > 30) {
      drawdowns.push({ depth: currentDDPeak, startTs: currentDDStart, endTs, recoveryDays: dur });
    }
  }

  // Longest consecutive losing streak
  let longestLosing = 0, curLosing = 0, losingStreakPnl = 0;
  let curStreakPnl = 0, worstStreakPnl = 0, worstStreakLen = 0;
  for (const t of trades) {
    if (t.pnl <= 0) {
      curLosing++;
      curStreakPnl += t.pnl;
      if (curLosing > longestLosing) {
        longestLosing = curLosing;
        worstStreakPnl = curStreakPnl;
      }
    } else {
      curLosing = 0;
      curStreakPnl = 0;
    }
  }
  losingStreakPnl = worstStreakPnl;

  // Daily P&L
  const dailyPnlMap = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dailyPnlMap.set(d, (dailyPnlMap.get(d) || 0) + t.pnl);
  }
  const dailyPnls = [...dailyPnlMap.values()];
  const bestDay = dailyPnls.length > 0 ? Math.max(...dailyPnls) : 0;
  const worstDay = dailyPnls.length > 0 ? Math.min(...dailyPnls) : 0;

  // Weekly P&L
  const weeklyPnl = new Map<number, number>();
  for (const t of trades) {
    const w = Math.floor(t.xt / (7 * DAY));
    weeklyPnl.set(w, (weeklyPnl.get(w) || 0) + t.pnl);
  }
  const weeklyVals = [...weeklyPnl.values()];
  const bestWeek = weeklyVals.length > 0 ? Math.max(...weeklyVals) : 0;
  const worstWeek = weeklyVals.length > 0 ? Math.min(...weeklyVals) : 0;

  // Monthly P&L
  const monthlyPnlMap = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.xt);
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    monthlyPnlMap.set(m, (monthlyPnlMap.get(m) || 0) + t.pnl);
  }
  const monthlyPnls = [...monthlyPnlMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(e => e[1]);
  const bestMonth = monthlyPnls.length > 0 ? Math.max(...monthlyPnls) : 0;
  const worstMonth = monthlyPnls.length > 0 ? Math.min(...monthlyPnls) : 0;
  const monthlyWinRate = monthlyPnls.length > 0
    ? monthlyPnls.filter(v => v > 0).length / monthlyPnls.length * 100 : 0;

  // Sharpe (annualized from daily)
  const avgDaily = dailyPnls.reduce((s, v) => s + v, 0) / Math.max(dailyPnls.length, 1);
  const stdDaily = Math.sqrt(
    dailyPnls.reduce((s, v) => s + (v - avgDaily) ** 2, 0) / Math.max(dailyPnls.length - 1, 1)
  );
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  return {
    trades: trades.length, wins, wr: trades.length > 0 ? wins / trades.length * 100 : 0,
    totalPnl, pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    perDay: totalPnl / Math.max(days, 1), sharpe, maxDD, maxDDDays,
    longestLosing, losingStreakPnl,
    monthlyWinRate, monthlyPnls, dailyPnls,
    bestDay, worstDay, bestWeek, worstWeek, bestMonth, worstMonth,
    drawdowns,
  };
}

// ============ MAIN ============
console.log("=".repeat(80));
console.log("  FINAL REALITY CHECK: Balanced Trend Ensemble");
console.log("  Conservative: 2x spreads + 0.1% extra slippage + taker fees");
console.log("=".repeat(80));

console.log("\nLoading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of PAIRS) {
  const d = load5m(p);
  if (d.length > 0) raw5m.set(p, d);
  else console.log("  MISSING:", p);
}

const dailyMap = new Map<string, DailyData>();
const h4Map = new Map<string, H4Data>();
for (const [p, bars] of raw5m) {
  const daily = aggregateToDaily(bars);
  const h4 = aggregateTo4h(bars);
  dailyMap.set(p, prepDaily(daily));
  h4Map.set(p, prepH4(h4));
}

const btcDailyRaw = dailyMap.get("BTCUSDT")!;
const btcD = prepBtcDaily(btcDailyRaw.cs);

// Find full data range
let dataStart = Infinity, dataEnd = 0;
for (const dd of dailyMap.values()) {
  if (dd.cs.length > 0) {
    dataStart = Math.min(dataStart, dd.cs[0].t);
    dataEnd = Math.max(dataEnd, dd.cs[dd.cs.length - 1].t);
  }
}
console.log(`Data range: ${new Date(dataStart).toISOString().slice(0, 10)} to ${new Date(dataEnd).toISOString().slice(0, 10)}`);
console.log(`Pairs loaded: ${raw5m.size} / ${PAIRS.length}`);

// ============ TEST 1: Conservative cost model on full dataset ============
console.log("\n" + "=".repeat(80));
console.log("  TEST 1: CONSERVATIVE COST MODEL (Full Dataset)");
console.log("  2x spreads, +0.1% slippage, taker fees");
console.log("=".repeat(80));

const fullConservative = simulate(dailyMap, h4Map, btcD, dataStart, dataEnd, CONSERVATIVE);
const fullNormal = simulate(dailyMap, h4Map, btcD, dataStart, dataEnd, NORMAL);
const mCons = calcMetrics(fullConservative, dataStart, dataEnd);
const mNorm = calcMetrics(fullNormal, dataStart, dataEnd);
const totalDays = (dataEnd - dataStart) / DAY;

function printMetrics(label: string, m: Metrics, days: number) {
  console.log(`\n--- ${label} ---`);
  console.log(`  Trades: ${m.trades} | Wins: ${m.wins} (${m.wr.toFixed(1)}%)`);
  console.log(`  Total P&L: $${m.totalPnl.toFixed(2)} | Per Day: $${m.perDay.toFixed(2)}`);
  console.log(`  PF: ${m.pf.toFixed(2)} | Sharpe: ${m.sharpe.toFixed(2)}`);
  console.log(`  Max DD: $${m.maxDD.toFixed(2)} | Max DD Duration: ${m.maxDDDays.toFixed(0)}d`);
  console.log(`  Monthly Win Rate: ${m.monthlyWinRate.toFixed(0)}%`);
  console.log(`  Worst Day: $${m.worstDay.toFixed(2)} | Best Day: $${m.bestDay.toFixed(2)}`);
  console.log(`  Worst Week: $${m.worstWeek.toFixed(2)} | Best Week: $${m.bestWeek.toFixed(2)}`);
  console.log(`  Worst Month: $${m.worstMonth.toFixed(2)} | Best Month: $${m.bestMonth.toFixed(2)}`);
}

printMetrics("Normal Costs (Full)", mNorm, totalDays);
printMetrics("Conservative Costs (Full)", mCons, totalDays);

console.log("\n  Cost impact: conservative reduces P&L by $" +
  (mNorm.totalPnl - mCons.totalPnl).toFixed(2) +
  ` (${((1 - mCons.totalPnl / mNorm.totalPnl) * 100).toFixed(1)}%)`);

// ============ TEST 2: 4-Quarter Rotation ============
console.log("\n" + "=".repeat(80));
console.log("  TEST 2: 4-QUARTER ROTATION (Conservative Costs)");
console.log("=".repeat(80));

const totalRange = dataEnd - dataStart;
const qLen = totalRange / 4;
const quarters: { label: string; start: number; end: number }[] = [];
for (let i = 0; i < 4; i++) {
  const start = dataStart + i * qLen;
  const end = dataStart + (i + 1) * qLen;
  quarters.push({
    label: `Q${i + 1} (${new Date(start).toISOString().slice(0, 10)} to ${new Date(end).toISOString().slice(0, 10)})`,
    start, end,
  });
}

const quarterMetrics: { label: string; m: Metrics }[] = [];
for (const q of quarters) {
  const tr = simulate(dailyMap, h4Map, btcD, q.start, q.end, CONSERVATIVE);
  const m = calcMetrics(tr, q.start, q.end);
  quarterMetrics.push({ label: q.label, m });
  const qDays = (q.end - q.start) / DAY;
  printMetrics(q.label, m, qDays);
}

const worstQ = quarterMetrics.reduce((w, q) => q.m.perDay < w.m.perDay ? q : w);
const bestQ = quarterMetrics.reduce((b, q) => q.m.perDay > b.m.perDay ? q : b);
console.log(`\n  WORST quarter: ${worstQ.label} -> $${worstQ.m.perDay.toFixed(2)}/day`);
console.log(`  BEST quarter: ${bestQ.label} -> $${bestQ.m.perDay.toFixed(2)}/day`);
console.log(`  AVERAGE across quarters: $${(quarterMetrics.reduce((s, q) => s + q.m.perDay, 0) / 4).toFixed(2)}/day`);

// ============ TEST 3: Bull Market Test ============
console.log("\n" + "=".repeat(80));
console.log("  TEST 3: BULL MARKET TEST (Most Bullish 6-Month Period)");
console.log("=".repeat(80));

const btcCs = btcDailyRaw.cs;
const sixMonths = 180 * DAY;
let bestBullStart = dataStart, bestBullReturn = -Infinity;
for (let i = 0; i < btcCs.length; i++) {
  const startT = btcCs[i].t;
  if (startT + sixMonths > dataEnd) break;
  // Find end bar
  let endIdx = -1;
  for (let j = i; j < btcCs.length; j++) {
    if (btcCs[j].t >= startT + sixMonths) { endIdx = j; break; }
  }
  if (endIdx < 0) continue;
  const ret = btcCs[endIdx].c / btcCs[i].o - 1;
  if (ret > bestBullReturn) {
    bestBullReturn = ret;
    bestBullStart = startT;
  }
}
const bullEnd = bestBullStart + sixMonths;
console.log(`  Most bullish 6m: ${new Date(bestBullStart).toISOString().slice(0, 10)} to ${new Date(bullEnd).toISOString().slice(0, 10)}`);
console.log(`  BTC return in period: ${(bestBullReturn * 100).toFixed(1)}%`);

const bullTrades = simulate(dailyMap, h4Map, btcD, bestBullStart, bullEnd, CONSERVATIVE);
const mBull = calcMetrics(bullTrades, bestBullStart, bullEnd);
printMetrics("Bull Market (Conservative)", mBull, 180);

const bullLongs = bullTrades.filter(t => t.dir === "long");
const bullShorts = bullTrades.filter(t => t.dir === "short");
console.log(`  Longs: ${bullLongs.length} trades, P&L $${bullLongs.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
console.log(`  Shorts: ${bullShorts.length} trades, P&L $${bullShorts.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);

// ============ TEST 4: Choppy/Sideways Test ============
console.log("\n" + "=".repeat(80));
console.log("  TEST 4: CHOPPY/SIDEWAYS TEST (Narrowest BTC Range 6-Month)");
console.log("=".repeat(80));

let bestSidewaysStart = dataStart, bestSidewaysRange = Infinity;
for (let i = 0; i < btcCs.length; i++) {
  const startT = btcCs[i].t;
  if (startT + sixMonths > dataEnd) break;
  // Find all bars in range, compute range as (max-min)/start price
  let hi = -Infinity, lo = Infinity;
  for (let j = i; j < btcCs.length && btcCs[j].t < startT + sixMonths; j++) {
    hi = Math.max(hi, btcCs[j].h);
    lo = Math.min(lo, btcCs[j].l);
  }
  const range = (hi - lo) / btcCs[i].o;
  if (range < bestSidewaysRange) {
    bestSidewaysRange = range;
    bestSidewaysStart = startT;
  }
}
const sidewaysEnd = bestSidewaysStart + sixMonths;
console.log(`  Most sideways 6m: ${new Date(bestSidewaysStart).toISOString().slice(0, 10)} to ${new Date(sidewaysEnd).toISOString().slice(0, 10)}`);
console.log(`  BTC range: ${(bestSidewaysRange * 100).toFixed(1)}% of price`);

const sidewaysTrades = simulate(dailyMap, h4Map, btcD, bestSidewaysStart, sidewaysEnd, CONSERVATIVE);
const mSideways = calcMetrics(sidewaysTrades, bestSidewaysStart, sidewaysEnd);
printMetrics("Sideways Market (Conservative)", mSideways, 180);

// ============ TEST 5: Drawdown Recovery ============
console.log("\n" + "=".repeat(80));
console.log("  TEST 5: DRAWDOWN RECOVERY (Full Period, Conservative)");
console.log("=".repeat(80));

if (mCons.drawdowns.length === 0) {
  console.log("  No drawdowns > $30 found.");
} else {
  console.log(`  Drawdowns > $30: ${mCons.drawdowns.length}`);
  for (const dd of mCons.drawdowns) {
    console.log(`    Depth: $${dd.depth.toFixed(2)} | Recovery: ${dd.recoveryDays.toFixed(0)} days | ` +
      `${new Date(dd.startTs).toISOString().slice(0, 10)} to ${new Date(dd.endTs).toISOString().slice(0, 10)}`);
  }
  const avgRecovery = mCons.drawdowns.reduce((s, d) => s + d.recoveryDays, 0) / mCons.drawdowns.length;
  const maxRecovery = Math.max(...mCons.drawdowns.map(d => d.recoveryDays));
  console.log(`  Avg recovery: ${avgRecovery.toFixed(0)} days | Max recovery: ${maxRecovery.toFixed(0)} days`);
}

// ============ TEST 6: Win/Loss Streak Analysis ============
console.log("\n" + "=".repeat(80));
console.log("  TEST 6: WIN/LOSS STREAK ANALYSIS (Full Period, Conservative)");
console.log("=".repeat(80));

// Compute all streaks
let curStreak = 0, curStreakDir: "win" | "loss" | null = null;
let maxWinStreak = 0, maxLossStreak = 0;
let maxLossStreakPnl = 0, curLossStreakPnl = 0;
const allLossStreaks: { len: number; pnl: number }[] = [];
let tempLossLen = 0, tempLossPnl = 0;

for (const t of fullConservative) {
  if (t.pnl > 0) {
    if (tempLossLen > 0) {
      allLossStreaks.push({ len: tempLossLen, pnl: tempLossPnl });
      tempLossLen = 0;
      tempLossPnl = 0;
    }
    if (curStreakDir === "win") curStreak++;
    else { curStreak = 1; curStreakDir = "win"; }
    if (curStreak > maxWinStreak) maxWinStreak = curStreak;
  } else {
    tempLossLen++;
    tempLossPnl += t.pnl;
    if (curStreakDir === "loss") curStreak++;
    else { curStreak = 1; curStreakDir = "loss"; }
    if (curStreak > maxLossStreak) {
      maxLossStreak = curStreak;
      maxLossStreakPnl = tempLossPnl;
    }
  }
}
if (tempLossLen > 0) allLossStreaks.push({ len: tempLossLen, pnl: tempLossPnl });

console.log(`  Max winning streak: ${maxWinStreak} trades`);
console.log(`  Max losing streak: ${maxLossStreak} trades`);
console.log(`  P&L during worst losing streak: $${maxLossStreakPnl.toFixed(2)}`);
console.log(`  All losing streaks >3: ${allLossStreaks.filter(s => s.len > 3).length}`);
for (const s of allLossStreaks.filter(s => s.len > 3).sort((a, b) => a.pnl - b.pnl).slice(0, 5)) {
  console.log(`    ${s.len} losses in a row -> $${s.pnl.toFixed(2)}`);
}

const brutalityScore = maxLossStreak >= 10 ? "BRUTAL" :
  maxLossStreak >= 7 ? "ROUGH" :
  maxLossStreak >= 5 ? "MANAGEABLE" : "MILD";
console.log(`\n  Psychology assessment: ${brutalityScore}`);
console.log(`  With $5/trade, ${maxLossStreak} consecutive losses = $${Math.abs(maxLossStreakPnl).toFixed(2)} drawdown`);
console.log(`  At max DD of $${mCons.maxDD.toFixed(2)}, that is ${(mCons.maxDD / 50 * 100).toFixed(0)}% of $50 capital`);

// ============ TEST 7: Realistic $50 Deployment ============
console.log("\n" + "=".repeat(80));
console.log("  TEST 7: REALISTIC $50 DEPLOYMENT");
console.log("  $25 per sub-strategy, 5 positions each, $5/trade");
console.log("=".repeat(80));

// Run with max 5 positions per sub (but our sim uses shared 10 cap already)
// Since we already run with 10 shared, the $50 deployment is basically the conservative sim
// Monthly P&L distribution
const monthlyPnls = mCons.monthlyPnls;
monthlyPnls.sort((a, b) => a - b);
const p5 = monthlyPnls[Math.floor(monthlyPnls.length * 0.05)] ?? 0;
const p25 = monthlyPnls[Math.floor(monthlyPnls.length * 0.25)] ?? 0;
const p50 = monthlyPnls[Math.floor(monthlyPnls.length * 0.50)] ?? 0;
const p75 = monthlyPnls[Math.floor(monthlyPnls.length * 0.75)] ?? 0;
const p95 = monthlyPnls[Math.floor(monthlyPnls.length * 0.95)] ?? 0;
const avgMonthly = monthlyPnls.reduce((s, v) => s + v, 0) / Math.max(monthlyPnls.length, 1);

console.log(`\n  Monthly P&L distribution (${monthlyPnls.length} months):`);
console.log(`    5th percentile:  $${p5.toFixed(2)}`);
console.log(`    25th percentile: $${p25.toFixed(2)}`);
console.log(`    Median:          $${p50.toFixed(2)}`);
console.log(`    75th percentile: $${p75.toFixed(2)}`);
console.log(`    95th percentile: $${p95.toFixed(2)}`);
console.log(`    Average:         $${avgMonthly.toFixed(2)}`);

console.log(`\n  Expected monthly P&L range (5th-95th): $${p5.toFixed(2)} to $${p95.toFixed(2)}`);
console.log(`  Expected MAX drawdown: $${mCons.maxDD.toFixed(2)} (${(mCons.maxDD / 50 * 100).toFixed(0)}% of capital)`);

// Time to first $50 profit (doubling)
if (mCons.perDay > 0) {
  const daysToDouble = 50 / mCons.perDay;
  console.log(`  Expected time to $50 profit (doubling capital): ${daysToDouble.toFixed(0)} days (${(daysToDouble / 30).toFixed(1)} months)`);
} else {
  console.log(`  Expected time to $50 profit: NEVER (negative daily P&L)`);
}

// Probability of losing money in a month
const monthsLosing = monthlyPnls.filter(v => v <= 0).length;
const probLosingMonth = monthlyPnls.length > 0 ? monthsLosing / monthlyPnls.length * 100 : 0;
console.log(`  Probability of losing month: ${probLosingMonth.toFixed(0)}% (${monthsLosing}/${monthlyPnls.length})`);

// Monthly breakdown
console.log("\n  Monthly P&L breakdown:");
const monthlyEntries = new Map<string, number>();
for (const t of fullConservative) {
  const d = new Date(t.xt);
  const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  monthlyEntries.set(m, (monthlyEntries.get(m) || 0) + t.pnl);
}
for (const [m, pnl] of [...monthlyEntries.entries()].sort()) {
  const bar = pnl >= 0 ? "+".repeat(Math.min(Math.round(pnl / 2), 40)) : "-".repeat(Math.min(Math.round(-pnl / 2), 40));
  console.log(`    ${m}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} ${bar}`);
}

// ============ TEST 8: Buy and Hold BTC Comparison ============
console.log("\n" + "=".repeat(80));
console.log("  TEST 8: BUY AND HOLD BTC COMPARISON");
console.log("=".repeat(80));

// Find BTC price at start and end of full period
const btcStart = btcCs.find(c => c.t >= dataStart);
const btcEnd = btcCs[btcCs.length - 1];
if (btcStart && btcEnd) {
  const btcReturn = btcEnd.c / btcStart.o - 1;
  const btcPnl50 = 50 * btcReturn;
  const stratPnl50 = mCons.totalPnl;
  console.log(`\n  BTC: ${btcStart.o.toFixed(0)} -> ${btcEnd.c.toFixed(0)} (${(btcReturn * 100).toFixed(1)}%)`);
  console.log(`  $50 BTC buy-and-hold P&L: $${btcPnl50.toFixed(2)}`);
  console.log(`  $50 Strategy P&L (conservative): $${stratPnl50.toFixed(2)}`);
  console.log(`  Strategy vs BTC: ${stratPnl50 > btcPnl50 ? "STRATEGY WINS" : "BTC WINS"} by $${Math.abs(stratPnl50 - btcPnl50).toFixed(2)}`);

  // BTC max drawdown
  let btcPk = 0, btcDD = 0;
  for (const c of btcCs) {
    if (c.c > btcPk) btcPk = c.c;
    const dd = (btcPk - c.c) / btcPk;
    if (dd > btcDD) btcDD = dd;
  }
  console.log(`  BTC max drawdown: ${(btcDD * 100).toFixed(1)}% ($${(50 * btcDD).toFixed(2)} on $50)`);
  console.log(`  Strategy max drawdown: $${mCons.maxDD.toFixed(2)} (${(mCons.maxDD / 50 * 100).toFixed(1)}% of capital)`);

  // Per-quarter comparison
  console.log("\n  Per-quarter BTC vs Strategy:");
  for (let i = 0; i < quarters.length; i++) {
    const q = quarters[i];
    const bStart = btcCs.find(c => c.t >= q.start);
    const bEnd = btcCs.filter(c => c.t < q.end).pop();
    if (bStart && bEnd) {
      const bRet = bEnd.c / bStart.o - 1;
      const bPnl = 50 * bRet;
      const sPnl = quarterMetrics[i].m.totalPnl;
      console.log(`    ${q.label.slice(0, 2)}: BTC ${bRet >= 0 ? "+" : ""}${(bRet * 100).toFixed(1)}% ($${bPnl.toFixed(2)}) | Strategy $${sPnl.toFixed(2)} | ${sPnl > bPnl ? "Strat" : "BTC"}`);
    }
  }
}

// ============ TEST 9: HONEST SUMMARY ============
console.log("\n" + "=".repeat(80));
console.log("  TEST 9: HONEST SUMMARY");
console.log("=".repeat(80));

const worstQPerDay = worstQ.m.perDay;
const avgQPerDay = quarterMetrics.reduce((s, q) => s + q.m.perDay, 0) / 4;
const bestQPerDay = bestQ.m.perDay;

console.log(`\n  MINIMUM expected daily profit (worst quarter): $${worstQPerDay.toFixed(3)}`);
console.log(`  REALISTIC expected daily profit (avg quarters): $${avgQPerDay.toFixed(3)}`);
console.log(`  MAXIMUM expected drawdown: $${mCons.maxDD.toFixed(2)} (${(mCons.maxDD / 50 * 100).toFixed(0)}% of $50 capital)`);
console.log(`  Probability of losing month: ${probLosingMonth.toFixed(0)}%`);

// Paper trading needed
const minMonthsPaper = mCons.monthlyWinRate >= 80 ? 2 :
  mCons.monthlyWinRate >= 60 ? 3 :
  mCons.monthlyWinRate >= 50 ? 4 : 6;
console.log(`  Months of paper trading needed: ${minMonthsPaper} minimum (based on ${mCons.monthlyWinRate.toFixed(0)}% monthly WR)`);

// Is the strategy worth trading?
const worthTrading = mCons.totalPnl > 0 && mCons.pf > 1.2 && mCons.sharpe > 0.5 && mCons.maxDD < 50;
const edgeConfidence = mCons.pf > 2.0 ? "HIGH" :
  mCons.pf > 1.5 ? "MODERATE" :
  mCons.pf > 1.2 ? "LOW" : "NONE";

console.log(`\n  Edge confidence: ${edgeConfidence} (PF ${mCons.pf.toFixed(2)} at conservative costs)`);
console.log(`  Worth trading: ${worthTrading ? "YES" : "NO"}`);

if (!worthTrading) {
  if (mCons.totalPnl <= 0) console.log("  REASON: Negative total P&L under conservative costs");
  if (mCons.pf <= 1.2) console.log("  REASON: Profit factor too low (<1.2)");
  if (mCons.sharpe <= 0.5) console.log("  REASON: Sharpe too low (<0.5)");
  if (mCons.maxDD >= 50) console.log("  REASON: Max drawdown exceeds capital");
}

// ============ FINAL TABLE ============
console.log("\n" + "=".repeat(80));
console.log("  FINAL SUMMARY TABLE");
console.log("=".repeat(80));

const optimisticPerDay = bestQPerDay;
const realisticPerDay = avgQPerDay;
const conservativePerDay = worstQPerDay;

// Worst month across all quarters
const allWorstMonths = quarterMetrics.map(q => q.m.worstMonth);
const absoluteWorstMonth = Math.min(...allWorstMonths);

function fmtRow(metric: string, cons: string, real: string, opt: string) {
  console.log(`  ${metric.padEnd(30)} ${cons.padEnd(18)} ${real.padEnd(18)} ${opt}`);
}

console.log("");
fmtRow("Metric", "Conservative", "Realistic", "Optimistic");
fmtRow("-".repeat(30), "-".repeat(18), "-".repeat(18), "-".repeat(18));
fmtRow("Daily P&L", `$${conservativePerDay.toFixed(3)}`, `$${realisticPerDay.toFixed(3)}`, `$${optimisticPerDay.toFixed(3)}`);
fmtRow("Monthly P&L", `$${(conservativePerDay * 30).toFixed(2)}`, `$${(realisticPerDay * 30).toFixed(2)}`, `$${(optimisticPerDay * 30).toFixed(2)}`);
fmtRow("Annual P&L", `$${(conservativePerDay * 365).toFixed(2)}`, `$${(realisticPerDay * 365).toFixed(2)}`, `$${(optimisticPerDay * 365).toFixed(2)}`);
fmtRow("Win Rate", `${worstQ.m.wr.toFixed(0)}%`, `${mCons.wr.toFixed(0)}%`, `${bestQ.m.wr.toFixed(0)}%`);
fmtRow("Profit Factor", `${worstQ.m.pf.toFixed(2)}`, `${mCons.pf.toFixed(2)}`, `${bestQ.m.pf.toFixed(2)}`);
fmtRow("Sharpe Ratio", `${worstQ.m.sharpe.toFixed(2)}`, `${mCons.sharpe.toFixed(2)}`, `${bestQ.m.sharpe.toFixed(2)}`);
fmtRow("Max Drawdown", `$${mCons.maxDD.toFixed(2)}`, `$${mCons.maxDD.toFixed(2)}`, `$${mCons.maxDD.toFixed(2)}`);
fmtRow("Max DD % of $50", `${(mCons.maxDD / 50 * 100).toFixed(0)}%`, `${(mCons.maxDD / 50 * 100).toFixed(0)}%`, `${(mCons.maxDD / 50 * 100).toFixed(0)}%`);
fmtRow("Worst Month", `$${absoluteWorstMonth.toFixed(2)}`, `$${mCons.worstMonth.toFixed(2)}`, `$${mCons.bestMonth.toFixed(2)}`);
fmtRow("Losing Month Prob", `${probLosingMonth.toFixed(0)}%`, `${probLosingMonth.toFixed(0)}%`, `${probLosingMonth.toFixed(0)}%`);
fmtRow("Max Losing Streak", `${mCons.longestLosing}`, `${mCons.longestLosing}`, `${mCons.longestLosing}`);
fmtRow("Days to Double $50",
  mCons.perDay > 0 ? `${(50 / conservativePerDay).toFixed(0)}d` : "Never",
  mCons.perDay > 0 ? `${(50 / realisticPerDay).toFixed(0)}d` : "Never",
  mCons.perDay > 0 ? `${(50 / optimisticPerDay).toFixed(0)}d` : "Never"
);

// Strategy A vs B breakdown
const stratATrades = fullConservative.filter(t => t.strat === "A");
const stratBTrades = fullConservative.filter(t => t.strat === "B");
console.log("\n  Sub-strategy breakdown (conservative costs, full period):");
console.log(`    A (Daily SMA): ${stratATrades.length} trades, P&L $${stratATrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}, WR ${stratATrades.length > 0 ? (stratATrades.filter(t => t.pnl > 0).length / stratATrades.length * 100).toFixed(0) : 0}%`);
console.log(`    B (4h Supertrend): ${stratBTrades.length} trades, P&L $${stratBTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}, WR ${stratBTrades.length > 0 ? (stratBTrades.filter(t => t.pnl > 0).length / stratBTrades.length * 100).toFixed(0) : 0}%`);

// Long vs Short breakdown
const longTrades = fullConservative.filter(t => t.dir === "long");
const shortTrades = fullConservative.filter(t => t.dir === "short");
console.log(`\n  Direction breakdown (conservative):`);
console.log(`    Longs: ${longTrades.length} trades, P&L $${longTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
console.log(`    Shorts: ${shortTrades.length} trades, P&L $${shortTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);

console.log("\n" + "=".repeat(80));
console.log("  END OF REALITY CHECK");
console.log("=".repeat(80));
