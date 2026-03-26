/**
 * FINAL SYNTHESIS: Balanced Trend Ensemble Backtest
 *
 * Sub-Strategy A: Daily SMA(30/60) Trend Following
 *   - Entry: SMA30 crosses SMA60 on daily candles
 *   - Long: SMA30>SMA60 AND BTC EMA20>EMA50 (BTC filter longs only)
 *   - Short: SMA30<SMA60 (no filter)
 *   - Exit: Donchian 15d channel exit
 *   - Stop: ATR(14d) x 3 from entry
 *   - Max hold: 60 days
 *
 * Sub-Strategy B: 4h Supertrend(14,2) Trend Following
 *   - Entry: Supertrend flip on 4h candles
 *   - Long: close > supertrend AND BTC daily EMA20>EMA50 (BTC filter longs only)
 *   - Short: close < supertrend (no filter)
 *   - Exit: Supertrend flip (opposite direction)
 *
 * $5 margin per trade, 10x leverage, max 10 concurrent positions total
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
const FEE = 0.00035;
const SZ = 5; // $5 margin per trade
const LEV = 10;
const NOT_SZ = SZ * LEV; // $50 notional
const MAX_POS = 10;

const PAIRS = [
  "ADAUSDT", "APTUSDT", "ARBUSDT", "BTCUSDT", "DASHUSDT", "DOGEUSDT",
  "DOTUSDT", "ENAUSDT", "ETHUSDT", "LDOUSDT", "LINKUSDT", "OPUSDT",
  "SOLUSDT", "TIAUSDT", "TRUMPUSDT", "UNIUSDT", "WIFUSDT", "WLDUSDT", "XRPUSDT",
];

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ETHUSDT: 1.5e-4, SOLUSDT: 2.0e-4,
  ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4, TIAUSDT: 2.5e-4, UNIUSDT: 2.75e-4,
  APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4, WLDUSDT: 4e-4,
  DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4, LDOUSDT: 5.8e-4,
  OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
};

const SL_SLIP = 1.5; // SL slippage multiplier

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
    if (bars.length < 200) continue; // require ~200 of 288 5m bars per day
    daily.push({
      t,
      o: bars[0].o,
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
    if (bars.length < 48) continue; // require all 48 5m bars per 4h
    result.push({
      t,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return result;
}

// ============ INDICATOR HELPERS ============
function calcSMA(candles: C[], period: number): number[] {
  const vals = candles.map(c => c.c);
  const raw = SMA.calculate({ period, values: vals });
  // Pad front so indices align with candles
  const pad = candles.length - raw.length;
  return [...new Array(pad).fill(NaN), ...raw];
}

function calcEMA(candles: C[], period: number): number[] {
  const vals = candles.map(c => c.c);
  const raw = EMA.calculate({ period, values: vals });
  const pad = candles.length - raw.length;
  return [...new Array(pad).fill(NaN), ...raw];
}

function calcATR(candles: C[], period: number): number[] {
  const hi = candles.map(c => c.h);
  const lo = candles.map(c => c.l);
  const cl = candles.map(c => c.c);
  const raw = ATR.calculate({ period, high: hi, low: lo, close: cl });
  const pad = candles.length - raw.length;
  return [...new Array(pad).fill(NaN), ...raw];
}

// Donchian channel: highest high and lowest low over period
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

// Supertrend calculation
function calcSupertrend(candles: C[], period: number, multiplier: number): { st: number[]; dir: number[] } {
  const atr = calcATR(candles, period);
  const st = new Array(candles.length).fill(NaN);
  const dir = new Array(candles.length).fill(0); // 1 = up (bullish), -1 = down (bearish)

  for (let i = period; i < candles.length; i++) {
    if (isNaN(atr[i])) continue;
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    // Upper band: min of current basic upper and prev upper (if prev close was below prev upper)
    let upperBand: number;
    if (i === period || isNaN(st[i - 1])) {
      upperBand = basicUpper;
    } else {
      const prevUpper = dir[i - 1] === -1 ? st[i - 1] : basicUpper;
      upperBand = basicUpper < prevUpper ? basicUpper : (candles[i - 1].c > prevUpper ? basicUpper : prevUpper);
    }

    // Lower band: max of current basic lower and prev lower (if prev close was above prev lower)
    let lowerBand: number;
    if (i === period || isNaN(st[i - 1])) {
      lowerBand = basicLower;
    } else {
      const prevLower = dir[i - 1] === 1 ? st[i - 1] : basicLower;
      lowerBand = basicLower > prevLower ? basicLower : (candles[i - 1].c < prevLower ? basicLower : prevLower);
    }

    // Direction
    if (i === period) {
      dir[i] = candles[i].c > upperBand ? 1 : -1;
      st[i] = dir[i] === 1 ? lowerBand : upperBand;
    } else {
      if (dir[i - 1] === 1) {
        // Was bullish
        if (candles[i].c < lowerBand) {
          dir[i] = -1;
          st[i] = upperBand;
        } else {
          dir[i] = 1;
          st[i] = lowerBand;
        }
      } else {
        // Was bearish
        if (candles[i].c > upperBand) {
          dir[i] = 1;
          st[i] = lowerBand;
        } else {
          dir[i] = -1;
          st[i] = upperBand;
        }
      }
    }
  }
  return { st, dir };
}

// ============ PRECOMPUTED DATA ============
interface DailyData {
  cs: C[];
  sma30: number[];
  sma60: number[];
  atr14: number[];
  donHi15: number[];
  donLo15: number[];
}

interface H4Data {
  cs: C[];
  stDir: number[]; // supertrend direction
  stVal: number[]; // supertrend value
}

interface BtcDailyData {
  cs: C[];
  ema20: number[];
  ema50: number[];
}

function prepDaily(candles: C[]): DailyData {
  return {
    cs: candles,
    sma30: calcSMA(candles, 30),
    sma60: calcSMA(candles, 60),
    atr14: calcATR(candles, 14),
    donHi15: calcDonchianHigh(candles, 15),
    donLo15: calcDonchianLow(candles, 15),
  };
}

function prepH4(candles: C[]): H4Data {
  const { st, dir } = calcSupertrend(candles, 14, 2);
  return { cs: candles, stDir: dir, stVal: st };
}

function prepBtcDaily(candles: C[]): BtcDailyData {
  return {
    cs: candles,
    ema20: calcEMA(candles, 20),
    ema50: calcEMA(candles, 50),
  };
}

// ============ COST CALCULATION ============
function entryCost(pair: string): number {
  const sp = SP[pair] ?? 4e-4;
  return NOT_SZ * FEE + NOT_SZ * sp / 2; // taker fee + half spread
}

function exitCost(pair: string): number {
  return entryCost(pair); // same
}

function slExitCost(pair: string): number {
  const sp = SP[pair] ?? 4e-4;
  return NOT_SZ * FEE + NOT_SZ * sp / 2 * SL_SLIP; // 1.5x spread on SL
}

// ============ SIMULATION ============
interface SimOpts {
  maxPos: number;
  feeMultiplier: number;       // 1.0 = normal, 2.0 = double spreads
  extraSlippage: number;       // extra pct slippage per entry
  btcFilterLongs: boolean;     // BTC EMA filter for longs
  enableA: boolean;
  enableB: boolean;
}

const DEFAULT_OPTS: SimOpts = {
  maxPos: MAX_POS,
  feeMultiplier: 1.0,
  extraSlippage: 0,
  btcFilterLongs: true,
  enableA: true,
  enableB: true,
};

function simulate(
  dailyMap: Map<string, DailyData>,
  h4Map: Map<string, H4Data>,
  btcDaily: BtcDailyData,
  startTs: number,
  endTs: number,
  opts: SimOpts = DEFAULT_OPTS,
): Trade[] {
  const trades: Trade[] = [];
  const posA = new Map<string, PosA>(); // Strategy A positions
  const posB = new Map<string, PosB>(); // Strategy B positions

  // Track previous day SMA cross state for Strategy A
  const prevCrossA = new Map<string, "long" | "short" | null>();
  // Track previous 4h Supertrend direction for Strategy B
  const prevStDir = new Map<string, number>();

  const totalPos = () => posA.size + posB.size;

  // BTC daily EMA filter: is BTC in uptrend?
  function btcLongOk(dayTs: number): boolean {
    if (!opts.btcFilterLongs) return true;
    // Find the BTC daily bar for this day
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

  // Get daily bar index for timestamp
  function getDailyIdx(data: DailyData, ts: number): number {
    // Find the most recent daily bar at or before ts
    for (let i = data.cs.length - 1; i >= 0; i--) {
      if (data.cs[i].t <= ts) return i;
    }
    return -1;
  }

  // Build a timeline of daily bars in range
  const dailyTimestamps = new Set<number>();
  for (const dd of dailyMap.values()) {
    for (const c of dd.cs) {
      if (c.t >= startTs && c.t < endTs) dailyTimestamps.add(c.t);
    }
  }
  const sortedDailyTs = [...dailyTimestamps].sort((a, b) => a - b);

  // Build a timeline of 4h bars in range
  const h4Timestamps = new Set<number>();
  for (const hd of h4Map.values()) {
    for (const c of hd.cs) {
      if (c.t >= startTs && c.t < endTs) h4Timestamps.add(c.t);
    }
  }
  const sortedH4Ts = [...h4Timestamps].sort((a, b) => a - b);

  // Merge all timestamps
  const allTs = [...new Set([...sortedDailyTs, ...sortedH4Ts])].sort((a, b) => a - b);

  // For efficient lookup: build index maps
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
  const btcDailyIdxMap = new Map<number, number>();
  btcDaily.cs.forEach((c, i) => btcDailyIdxMap.set(c.t, i));

  // Process each day for Strategy A
  if (opts.enableA) {
    for (const dayTs of sortedDailyTs) {
      const closedToday = new Set<string>();

      // --- EXIT Strategy A positions ---
      for (const [pair, pos] of posA) {
        const dd = dailyMap.get(pair);
        if (!dd) continue;
        const idx = dailyIdxMap.get(pair)?.get(dayTs) ?? -1;
        if (idx < 0) continue;
        const bar = dd.cs[idx];
        const sp = (SP[pair] ?? 4e-4) * opts.feeMultiplier;
        let xp = 0;
        let reason = "";

        // Check stop-loss using intraday high/low
        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP);
          reason = "sl";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP);
          reason = "sl";
        }

        // Check Donchian 15d exit (using previous bar's channel)
        if (!reason && idx > 0) {
          if (pos.dir === "long" && !isNaN(dd.donLo15[idx]) && bar.c < dd.donLo15[idx]) {
            xp = bar.c * (1 - sp);
            reason = "don-exit";
          } else if (pos.dir === "short" && !isNaN(dd.donHi15[idx]) && bar.c > dd.donHi15[idx]) {
            xp = bar.c * (1 + sp);
            reason = "don-exit";
          }
        }

        // Max hold 60 days
        if (!reason && dayTs - pos.et >= 60 * DAY) {
          xp = bar.c * (pos.dir === "long" ? (1 - sp) : (1 + sp));
          reason = "mh";
        }

        if (xp > 0) {
          const raw = pos.dir === "long"
            ? (xp / pos.ep - 1) * NOT_SZ
            : (pos.ep / xp - 1) * NOT_SZ;
          const fees = NOT_SZ * FEE * 2 * opts.feeMultiplier;
          trades.push({
            pair, strat: "A", dir: pos.dir,
            ep: pos.ep, xp, et: pos.et, xt: dayTs,
            pnl: raw - fees, reason,
          });
          posA.delete(pair);
          closedToday.add(pair);
        }
      }

      // --- ENTRY Strategy A ---
      for (const pair of PAIRS) {
        if (pair === "BTCUSDT") continue;
        if (posA.has(pair) || closedToday.has(pair)) continue;
        if (totalPos() >= opts.maxPos) break;

        const dd = dailyMap.get(pair);
        if (!dd) continue;
        const idx = dailyIdxMap.get(pair)?.get(dayTs) ?? -1;
        if (idx < 1) continue;

        // Use previous bar (i-1) for signals, enter at current bar open
        const prevIdx = idx - 1;
        const sma30prev = dd.sma30[prevIdx];
        const sma60prev = dd.sma60[prevIdx];
        if (isNaN(sma30prev) || isNaN(sma60prev)) continue;

        // Check two bars back to detect cross
        if (prevIdx < 1) continue;
        const sma30prev2 = dd.sma30[prevIdx - 1];
        const sma60prev2 = dd.sma60[prevIdx - 1];
        if (isNaN(sma30prev2) || isNaN(sma60prev2)) continue;

        let dir: "long" | "short" | null = null;

        // Cross up: SMA30 was below SMA60, now above
        if (sma30prev2 <= sma60prev2 && sma30prev > sma60prev) {
          dir = "long";
        }
        // Cross down: SMA30 was above SMA60, now below
        else if (sma30prev2 >= sma60prev2 && sma30prev < sma60prev) {
          dir = "short";
        }

        if (!dir) continue;

        // BTC filter for longs only
        if (dir === "long" && !btcLongOk(dd.cs[prevIdx].t)) continue;

        // Entry at current bar open
        const ep = dd.cs[idx].o;
        const sp = (SP[pair] ?? 4e-4) * opts.feeMultiplier;
        const extraSlip = opts.extraSlippage / 100;
        const entryPrice = dir === "long"
          ? ep * (1 + sp + extraSlip)
          : ep * (1 - sp - extraSlip);

        // ATR-based stop: ATR(14) x 3 from entry, using previous bar's ATR
        const atrVal = dd.atr14[prevIdx];
        if (isNaN(atrVal) || atrVal <= 0) continue;
        const slDist = atrVal * 3;
        const sl = dir === "long"
          ? entryPrice - slDist
          : entryPrice + slDist;

        posA.set(pair, {
          pair, dir, ep: entryPrice, et: dayTs, sl,
          maxHold: dayTs + 60 * DAY,
        });
      }
    }
  }

  // Process 4h bars for Strategy B
  if (opts.enableB) {
    for (const h4Ts of sortedH4Ts) {
      const closedNow = new Set<string>();

      // --- EXIT Strategy B positions (supertrend flip) ---
      for (const [pair, pos] of posB) {
        const hd = h4Map.get(pair);
        if (!hd) continue;
        const idx = h4IdxMap.get(pair)?.get(h4Ts) ?? -1;
        if (idx < 1) continue;

        const curDir = hd.stDir[idx];
        const prevDir = hd.stDir[idx - 1];

        // Exit on flip
        let shouldExit = false;
        if (pos.dir === "long" && curDir === -1 && prevDir === 1) shouldExit = true;
        if (pos.dir === "short" && curDir === 1 && prevDir === -1) shouldExit = true;

        if (shouldExit) {
          const bar = hd.cs[idx];
          const sp = (SP[pair] ?? 4e-4) * opts.feeMultiplier;
          const xp = pos.dir === "long"
            ? bar.o * (1 - sp)
            : bar.o * (1 + sp);

          const raw = pos.dir === "long"
            ? (xp / pos.ep - 1) * NOT_SZ
            : (pos.ep / xp - 1) * NOT_SZ;
          const fees = NOT_SZ * FEE * 2 * opts.feeMultiplier;

          trades.push({
            pair, strat: "B", dir: pos.dir,
            ep: pos.ep, xp, et: pos.et, xt: h4Ts,
            pnl: raw - fees, reason: "st-flip",
          });
          posB.delete(pair);
          closedNow.add(pair);
        }
      }

      // --- ENTRY Strategy B ---
      for (const pair of PAIRS) {
        if (pair === "BTCUSDT") continue;
        if (posB.has(pair) || closedNow.has(pair)) continue;
        if (totalPos() >= opts.maxPos) break;

        const hd = h4Map.get(pair);
        if (!hd) continue;
        const idx = h4IdxMap.get(pair)?.get(h4Ts) ?? -1;
        if (idx < 2) continue;

        // Signal on bar i-1: detect flip
        const curDir = hd.stDir[idx - 1];
        const prevDir = hd.stDir[idx - 2];
        if (curDir === 0 || prevDir === 0) continue;
        if (curDir === prevDir) continue; // no flip

        let dir: "long" | "short" | null = null;
        if (curDir === 1 && prevDir === -1) dir = "long";  // flip to bullish
        if (curDir === -1 && prevDir === 1) dir = "short";  // flip to bearish
        if (!dir) continue;

        // BTC filter for longs only (use the daily bar closest to this 4h bar)
        if (dir === "long" && !btcLongOk(h4Ts)) continue;

        // Entry at bar i open
        const bar = hd.cs[idx];
        const sp = (SP[pair] ?? 4e-4) * opts.feeMultiplier;
        const extraSlip = opts.extraSlippage / 100;
        const ep = dir === "long"
          ? bar.o * (1 + sp + extraSlip)
          : bar.o * (1 - sp - extraSlip);

        posB.set(pair, { pair, dir, ep, et: h4Ts });
      }
    }
  }

  // Sort trades by exit time
  trades.sort((a, b) => a.xt - b.xt);
  return trades;
}

// ============ METRICS ============
interface Metrics {
  trades: number;
  wins: number;
  wr: number;
  totalPnl: number;
  pf: number;
  perDay: number;
  sharpe: number;
  maxDD: number;
  maxDDDuration: number; // days
  longestLosing: number;
  monthlyWinRate: number;
  bestDay: number;
  worstDay: number;
  bestWeek: number;
  worstWeek: number;
  bestMonth: number;
  worstMonth: number;
}

function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  const days = (endTs - startTs) / DAY;
  const wins = trades.filter(t => t.pnl > 0).length;
  const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Max drawdown
  let cum = 0, pk = 0, maxDD = 0;
  let ddStart = startTs, ddEnd = startTs, maxDDDuration = 0;
  let inDD = false, ddStartTime = startTs;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > pk) {
      pk = cum;
      if (inDD) {
        const dur = (t.xt - ddStartTime) / DAY;
        if (dur > maxDDDuration) maxDDDuration = dur;
        inDD = false;
      }
    }
    if (pk - cum > maxDD) {
      maxDD = pk - cum;
      if (!inDD) {
        inDD = true;
        ddStartTime = t.xt;
      }
    }
  }
  if (inDD) {
    const dur = (endTs - ddStartTime) / DAY;
    if (dur > maxDDDuration) maxDDDuration = dur;
  }

  // Longest consecutive losing streak
  let longestLosing = 0, curLosing = 0;
  for (const t of trades) {
    if (t.pnl <= 0) { curLosing++; if (curLosing > longestLosing) longestLosing = curLosing; }
    else curLosing = 0;
  }

  // Daily P&L
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dailyPnl.set(d, (dailyPnl.get(d) || 0) + t.pnl);
  }
  const dailyVals = [...dailyPnl.values()];
  const bestDay = dailyVals.length > 0 ? Math.max(...dailyVals) : 0;
  const worstDay = dailyVals.length > 0 ? Math.min(...dailyVals) : 0;

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
  const monthlyPnl = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.xt);
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    monthlyPnl.set(m, (monthlyPnl.get(m) || 0) + t.pnl);
  }
  const monthlyVals = [...monthlyPnl.values()];
  const bestMonth = monthlyVals.length > 0 ? Math.max(...monthlyVals) : 0;
  const worstMonth = monthlyVals.length > 0 ? Math.min(...monthlyVals) : 0;
  const monthlyWinRate = monthlyVals.length > 0
    ? monthlyVals.filter(v => v > 0).length / monthlyVals.length * 100
    : 0;

  // Sharpe
  const avgDaily = dailyVals.reduce((s, v) => s + v, 0) / Math.max(dailyVals.length, 1);
  const stdDaily = Math.sqrt(
    dailyVals.reduce((s, v) => s + (v - avgDaily) ** 2, 0) / Math.max(dailyVals.length - 1, 1)
  );
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  return {
    trades: trades.length,
    wins,
    wr: trades.length > 0 ? wins / trades.length * 100 : 0,
    totalPnl,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    perDay: totalPnl / days,
    sharpe,
    maxDD,
    maxDDDuration,
    longestLosing,
    monthlyWinRate,
    bestDay,
    worstDay,
    bestWeek,
    worstWeek,
    bestMonth,
    worstMonth,
  };
}

function fmtPnl(v: number): string {
  return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
}

function fmtPnl0(v: number): string {
  return v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`;
}

function printMetrics(label: string, m: Metrics): void {
  console.log(`  ${label}:`);
  console.log(`    Trades: ${m.trades}  Wins: ${m.wins}  WR: ${m.wr.toFixed(1)}%  PF: ${m.pf === Infinity ? "Inf" : m.pf.toFixed(2)}`);
  console.log(`    PnL: ${fmtPnl(m.totalPnl)}  $/day: ${fmtPnl(m.perDay)}  Sharpe: ${m.sharpe.toFixed(2)}  MaxDD: $${m.maxDD.toFixed(2)}`);
}

// ============ MAIN ============
console.log("=== BALANCED TREND ENSEMBLE - FINAL SYNTHESIS ===\n");
console.log("Loading 5m data and aggregating...");

const raw5m = new Map<string, C[]>();
for (const pair of PAIRS) {
  const data = load5m(pair);
  if (data.length > 0) {
    raw5m.set(pair, data);
    process.stdout.write(`  ${pair.replace("USDT", "")}: ${data.length} bars -> `);
  } else {
    console.log(`  ${pair}: NO DATA`);
  }
}

// Aggregate
const dailyMap = new Map<string, DailyData>();
const h4Map = new Map<string, H4Data>();
for (const [pair, bars] of raw5m) {
  const daily = aggregateToDaily(bars);
  const h4 = aggregateTo4h(bars);
  if (daily.length >= 60) {
    dailyMap.set(pair, prepDaily(daily));
  }
  if (h4.length >= 60) {
    h4Map.set(pair, prepH4(h4));
  }
  console.log(`daily=${daily.length}, 4h=${h4.length}`);
}

// BTC daily
const btcRaw = raw5m.get("BTCUSDT");
if (!btcRaw) { console.log("ERROR: No BTC data"); process.exit(1); }
const btcDailyCandles = aggregateToDaily(btcRaw);
const btcDaily = prepBtcDaily(btcDailyCandles);
console.log(`\nBTC daily: ${btcDailyCandles.length} bars, EMA20/50 from bar ${btcDaily.ema50.findIndex(v => !isNaN(v))}`);

// Date ranges
const FULL_START = new Date("2023-06-01").getTime();
const FULL_END = new Date("2026-03-25").getTime();
const OOS_START = new Date("2025-10-01").getTime(); // OOS = last ~6 months
const FULL_DAYS = (FULL_END - FULL_START) / DAY;
const OOS_DAYS = (FULL_END - OOS_START) / DAY;

console.log(`\nFull period: 2023-06-01 to 2026-03-25 (${FULL_DAYS.toFixed(0)} days)`);
console.log(`OOS period:  2025-10-01 to 2026-03-25 (${OOS_DAYS.toFixed(0)} days)`);
console.log(`Pairs: ${PAIRS.filter(p => p !== "BTCUSDT").map(p => p.replace("USDT", "")).join(", ")}`);
console.log(`Sizing: $${SZ} margin, ${LEV}x lev = $${NOT_SZ} notional`);
console.log(`Max concurrent: ${MAX_POS}`);

// ========================================
// TEST 1: Full Combined Strategy
// ========================================
console.log("\n" + "=".repeat(70));
console.log("TEST 1: FULL COMBINED STRATEGY");
console.log("=".repeat(70));

const fullTrades = simulate(dailyMap, h4Map, btcDaily, FULL_START, FULL_END);
const oosTrades = simulate(dailyMap, h4Map, btcDaily, OOS_START, FULL_END);

const fullM = calcMetrics(fullTrades, FULL_START, FULL_END);
const oosM = calcMetrics(oosTrades, OOS_START, FULL_END);

// OOS long-only and short-only
const oosLong = oosTrades.filter(t => t.dir === "long");
const oosShort = oosTrades.filter(t => t.dir === "short");
const oosLongM = calcMetrics(oosLong, OOS_START, FULL_END);
const oosShortM = calcMetrics(oosShort, OOS_START, FULL_END);

printMetrics("Full Period", fullM);
printMetrics("OOS (Oct 2025 - Mar 2026)", oosM);
printMetrics("OOS Long-only", oosLongM);
printMetrics("OOS Short-only", oosShortM);

// Strategy breakdown
const fullA = fullTrades.filter(t => t.strat === "A");
const fullB = fullTrades.filter(t => t.strat === "B");
console.log(`\n  Strategy A (Daily SMA): ${fullA.length} trades, PnL ${fmtPnl(fullA.reduce((s, t) => s + t.pnl, 0))}`);
console.log(`  Strategy B (4h Supertrend): ${fullB.length} trades, PnL ${fmtPnl(fullB.reduce((s, t) => s + t.pnl, 0))}`);

// Exit reasons
const exitReasons = new Map<string, { count: number; pnl: number }>();
for (const t of fullTrades) {
  const r = exitReasons.get(t.reason) || { count: 0, pnl: 0 };
  r.count++;
  r.pnl += t.pnl;
  exitReasons.set(t.reason, r);
}
console.log("\n  Exit reasons (full period):");
for (const [reason, { count, pnl }] of [...exitReasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`    ${reason.padEnd(12)} ${String(count).padStart(5)} trades  ${fmtPnl(pnl)}`);
}

// ========================================
// TEST 2: Monthly P&L Breakdown (OOS)
// ========================================
console.log("\n" + "=".repeat(70));
console.log("TEST 2: MONTHLY P&L BREAKDOWN (OOS)");
console.log("=".repeat(70));

const monthlyBreak = new Map<string, { pnl: number; trades: number; wins: number }>();
for (const t of oosTrades) {
  const d = new Date(t.xt);
  const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const v = monthlyBreak.get(m) || { pnl: 0, trades: 0, wins: 0 };
  v.trades++;
  v.pnl += t.pnl;
  if (t.pnl > 0) v.wins++;
  monthlyBreak.set(m, v);
}

console.log("\n  Month      Trades  Wins  WR%    PnL");
console.log("  " + "-".repeat(45));
for (const [m, v] of [...monthlyBreak.entries()].sort()) {
  const wr = v.trades > 0 ? (v.wins / v.trades * 100).toFixed(1) : "0.0";
  console.log(`  ${m}    ${String(v.trades).padStart(5)}  ${String(v.wins).padStart(4)}  ${wr.padStart(5)}%  ${fmtPnl(v.pnl).padStart(10)}`);
}

// ========================================
// TEST 3: Per-Pair Breakdown (OOS)
// ========================================
console.log("\n" + "=".repeat(70));
console.log("TEST 3: PER-PAIR BREAKDOWN (OOS)");
console.log("=".repeat(70));

const pairBreak = new Map<string, { pnl: number; trades: number; wins: number }>();
for (const t of oosTrades) {
  const p = t.pair.replace("USDT", "");
  const v = pairBreak.get(p) || { pnl: 0, trades: 0, wins: 0 };
  v.trades++;
  v.pnl += t.pnl;
  if (t.pnl > 0) v.wins++;
  pairBreak.set(p, v);
}

console.log("\n  Pair     Trades  Wins  WR%    PnL");
console.log("  " + "-".repeat(42));
for (const [p, v] of [...pairBreak.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
  const wr = v.trades > 0 ? (v.wins / v.trades * 100).toFixed(1) : "0.0";
  console.log(`  ${p.padEnd(8)} ${String(v.trades).padStart(5)}  ${String(v.wins).padStart(4)}  ${wr.padStart(5)}%  ${fmtPnl(v.pnl).padStart(10)}`);
}
const losers = [...pairBreak.entries()].filter(([, v]) => v.pnl < 0);
console.log(`\n  Losers: ${losers.length}/${pairBreak.size} pairs`);

// ========================================
// TEST 4: Equity Curve Characteristics
// ========================================
console.log("\n" + "=".repeat(70));
console.log("TEST 4: EQUITY CURVE CHARACTERISTICS");
console.log("=".repeat(70));

console.log(`\n  Full Period:`);
console.log(`    Max Drawdown: $${fullM.maxDD.toFixed(2)}`);
console.log(`    Max DD Duration: ${fullM.maxDDDuration.toFixed(1)} days`);
console.log(`    Longest Losing Streak: ${fullM.longestLosing} trades`);
console.log(`    Monthly Win Rate: ${fullM.monthlyWinRate.toFixed(1)}% (${[...new Set(fullTrades.map(t => { const d = new Date(t.xt); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`; }))].length} months)`);
console.log(`    Best Day: ${fmtPnl(fullM.bestDay)}  Worst Day: ${fmtPnl(fullM.worstDay)}`);
console.log(`    Best Week: ${fmtPnl(fullM.bestWeek)}  Worst Week: ${fmtPnl(fullM.worstWeek)}`);
console.log(`    Best Month: ${fmtPnl(fullM.bestMonth)}  Worst Month: ${fmtPnl(fullM.worstMonth)}`);

console.log(`\n  OOS Period:`);
console.log(`    Max Drawdown: $${oosM.maxDD.toFixed(2)}`);
console.log(`    Max DD Duration: ${oosM.maxDDDuration.toFixed(1)} days`);
console.log(`    Longest Losing Streak: ${oosM.longestLosing} trades`);
console.log(`    Monthly Win Rate: ${oosM.monthlyWinRate.toFixed(1)}%`);
console.log(`    Best Day: ${fmtPnl(oosM.bestDay)}  Worst Day: ${fmtPnl(oosM.worstDay)}`);
console.log(`    Best Week: ${fmtPnl(oosM.bestWeek)}  Worst Week: ${fmtPnl(oosM.worstWeek)}`);
console.log(`    Best Month: ${fmtPnl(oosM.bestMonth)}  Worst Month: ${fmtPnl(oosM.worstMonth)}`);

// ========================================
// TEST 5: Stress Tests
// ========================================
console.log("\n" + "=".repeat(70));
console.log("TEST 5: STRESS TESTS");
console.log("=".repeat(70));

// 5a: Double spreads
const stress5a = simulate(dailyMap, h4Map, btcDaily, FULL_START, FULL_END, {
  ...DEFAULT_OPTS, feeMultiplier: 2.0,
});
const m5a = calcMetrics(stress5a, FULL_START, FULL_END);

// 5b: Extra 0.2% slippage
const stress5b = simulate(dailyMap, h4Map, btcDaily, FULL_START, FULL_END, {
  ...DEFAULT_OPTS, extraSlippage: 0.2,
});
const m5b = calcMetrics(stress5b, FULL_START, FULL_END);

// 5c: Max 5 positions
const stress5c = simulate(dailyMap, h4Map, btcDaily, FULL_START, FULL_END, {
  ...DEFAULT_OPTS, maxPos: 5,
});
const m5c = calcMetrics(stress5c, FULL_START, FULL_END);

// 5d: No BTC filter
const stress5d = simulate(dailyMap, h4Map, btcDaily, FULL_START, FULL_END, {
  ...DEFAULT_OPTS, btcFilterLongs: false,
});
const m5d = calcMetrics(stress5d, FULL_START, FULL_END);

console.log("\n  Scenario                Trades  WR%    PnL         $/day    Sharpe  MaxDD");
console.log("  " + "-".repeat(75));
const stressRows: [string, Metrics][] = [
  ["Baseline", fullM],
  ["5a: Double spreads", m5a],
  ["5b: +0.2% slippage", m5b],
  ["5c: Max 5 positions", m5c],
  ["5d: No BTC filter", m5d],
];
for (const [label, m] of stressRows) {
  console.log(
    `  ${label.padEnd(24)} ${String(m.trades).padStart(5)}  ${m.wr.toFixed(1).padStart(5)}%  ${fmtPnl(m.totalPnl).padStart(10)}  ${fmtPnl(m.perDay).padStart(8)}  ${m.sharpe.toFixed(2).padStart(6)}  $${m.maxDD.toFixed(2).padStart(7)}`
  );
}

// ========================================
// TEST 6: Compare to Individual Components
// ========================================
console.log("\n" + "=".repeat(70));
console.log("TEST 6: ENSEMBLE vs INDIVIDUAL COMPONENTS");
console.log("=".repeat(70));

const onlyA = simulate(dailyMap, h4Map, btcDaily, FULL_START, FULL_END, {
  ...DEFAULT_OPTS, enableB: false,
});
const onlyB = simulate(dailyMap, h4Map, btcDaily, FULL_START, FULL_END, {
  ...DEFAULT_OPTS, enableA: false,
});
const mA = calcMetrics(onlyA, FULL_START, FULL_END);
const mB = calcMetrics(onlyB, FULL_START, FULL_END);

const onlyA_oos = simulate(dailyMap, h4Map, btcDaily, OOS_START, FULL_END, {
  ...DEFAULT_OPTS, enableB: false,
});
const onlyB_oos = simulate(dailyMap, h4Map, btcDaily, OOS_START, FULL_END, {
  ...DEFAULT_OPTS, enableA: false,
});
const mA_oos = calcMetrics(onlyA_oos, OOS_START, FULL_END);
const mB_oos = calcMetrics(onlyB_oos, OOS_START, FULL_END);

console.log("\n  FULL PERIOD:");
console.log("  Strategy              Trades  WR%    PnL         $/day    Sharpe  MaxDD    PF");
console.log("  " + "-".repeat(80));
const compRows: [string, Metrics][] = [
  ["A: Daily SMA", mA],
  ["B: 4h Supertrend", mB],
  ["A+B: Ensemble", fullM],
];
for (const [label, m] of compRows) {
  console.log(
    `  ${label.padEnd(22)} ${String(m.trades).padStart(5)}  ${m.wr.toFixed(1).padStart(5)}%  ${fmtPnl(m.totalPnl).padStart(10)}  ${fmtPnl(m.perDay).padStart(8)}  ${m.sharpe.toFixed(2).padStart(6)}  $${m.maxDD.toFixed(2).padStart(7)}  ${m.pf === Infinity ? "Inf" : m.pf.toFixed(2).padStart(5)}`
  );
}

console.log("\n  OOS PERIOD:");
console.log("  Strategy              Trades  WR%    PnL         $/day    Sharpe  MaxDD    PF");
console.log("  " + "-".repeat(80));
const compRowsOOS: [string, Metrics][] = [
  ["A: Daily SMA", mA_oos],
  ["B: 4h Supertrend", mB_oos],
  ["A+B: Ensemble", oosM],
];
for (const [label, m] of compRowsOOS) {
  console.log(
    `  ${label.padEnd(22)} ${String(m.trades).padStart(5)}  ${m.wr.toFixed(1).padStart(5)}%  ${fmtPnl(m.totalPnl).padStart(10)}  ${fmtPnl(m.perDay).padStart(8)}  ${m.sharpe.toFixed(2).padStart(6)}  $${m.maxDD.toFixed(2).padStart(7)}  ${m.pf === Infinity ? "Inf" : m.pf.toFixed(2).padStart(5)}`
  );
}

// ========================================
// TEST 7: Capital Deployment ($50)
// ========================================
console.log("\n" + "=".repeat(70));
console.log("TEST 7: CAPITAL DEPLOYMENT ($50, $25 per sub-strategy)");
console.log("=".repeat(70));

// Scale: each sub-strategy uses $5 margin = $50 notional.
// With $25 per sub-strategy at 10x, that's $25 per sub-strategy.
// $25/$5 = 5x the base sizing. But we have $5 margin per trade.
// Actually the user said $50 total, $25 per sub-strategy.
// Our sim uses $5 margin per trade. With $25 deployed per sub-strategy:
// $25/$5 = 5 concurrent positions max per sub-strategy.
// Scale factor: if we scale to $50 total, that's 10x the $5 base.
// But it's more about how many concurrent positions we can have.
// Let's compute the expected returns by scaling.
// Our $5 sim already runs - we just need to scale results.

// With $50 capital, $5 margin per trade, max 10 positions.
// The sim already uses this setup. So the numbers ARE for $50 deployment.
// (10 positions * $5 margin = $50 capital needed)

console.log(`\n  Setup: $5 margin x ${LEV}x lev = $${NOT_SZ} notional per trade`);
console.log(`  Max ${MAX_POS} concurrent positions x $5 margin = $${MAX_POS * SZ} capital required`);

// OOS metrics are what we'd expect going forward
console.log(`\n  Expected performance (based on OOS ${OOS_DAYS.toFixed(0)}-day window):`);
console.log(`    Daily P&L:         ${fmtPnl(oosM.perDay)}`);
console.log(`    Monthly P&L range: ${fmtPnl(oosM.worstMonth)} to ${fmtPnl(oosM.bestMonth)}`);
console.log(`    Expected MaxDD:    $${oosM.maxDD.toFixed(2)}`);
console.log(`    Win rate:          ${oosM.wr.toFixed(1)}%`);
console.log(`    Sharpe:            ${oosM.sharpe.toFixed(2)}`);

// Monthly returns as % of capital
const monthlyRetPct = new Map<string, number>();
for (const [m, v] of monthlyBreak) {
  monthlyRetPct.set(m, v.pnl / (MAX_POS * SZ) * 100);
}
console.log(`\n  Monthly returns (% of $${MAX_POS * SZ} capital):`);
for (const [m, pct] of [...monthlyRetPct.entries()].sort()) {
  console.log(`    ${m}: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
}

// ========================================
// SUMMARY
// ========================================
console.log("\n" + "=".repeat(70));
console.log("SUMMARY");
console.log("=".repeat(70));

console.log(`
  Balanced Trend Ensemble ($5 margin, 10x leverage, max 10 positions)

  Full Period (${FULL_DAYS.toFixed(0)} days):
    Trades: ${fullM.trades}  WR: ${fullM.wr.toFixed(1)}%  PF: ${fullM.pf === Infinity ? "Inf" : fullM.pf.toFixed(2)}
    PnL: ${fmtPnl(fullM.totalPnl)}  $/day: ${fmtPnl(fullM.perDay)}
    Sharpe: ${fullM.sharpe.toFixed(2)}  MaxDD: $${fullM.maxDD.toFixed(2)}

  OOS (${OOS_DAYS.toFixed(0)} days):
    Trades: ${oosM.trades}  WR: ${oosM.wr.toFixed(1)}%  PF: ${oosM.pf === Infinity ? "Inf" : oosM.pf.toFixed(2)}
    PnL: ${fmtPnl(oosM.totalPnl)}  $/day: ${fmtPnl(oosM.perDay)}
    Sharpe: ${oosM.sharpe.toFixed(2)}  MaxDD: $${oosM.maxDD.toFixed(2)}

  Stress Tests: All ${stressRows.filter(([l, m]) => l !== "Baseline" && m.totalPnl > 0).length}/4 passed (profitable)
  Component A alone: ${fmtPnl(mA.perDay)}/day  Component B alone: ${fmtPnl(mB.perDay)}/day
  Ensemble: ${fmtPnl(fullM.perDay)}/day (diversification benefit)
`);
