/**
 * Drawdown DURATION Reduction Study: 3-Engine Ensemble
 *
 * Supertrend(14,1.75) + GARCH v2 MTF + Donchian(SMA 20/50, 15d exit)
 * Tests 8 techniques to shorten DD duration and recovery time.
 * Target: <15 day DD duration, <20 day recovery.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-reduce-dd-duration.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ─────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; engine: string; reason: string;
}
interface Position {
  pair: string; dir: "long" | "short"; ep: number; et: number;
  sl: number; engine: string; tp?: number;
}

// ─── Constants ─────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const SL_SLIP = 1.5;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
  ETH: 0.8e-4, SOL: 1.2e-4, TIA: 3.8e-4,
};

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

// ─── Data Loading ──────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CD, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars5m: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
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
      t: ts, o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  result.sort((a, b) => a.t - b.t);
  return result;
}

// ─── Indicators ────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++)
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period; init = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);
  const ubArr = new Array(cs.length).fill(0);
  const lbArr = new Array(cs.length).fill(0);
  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];
    if (i > atrPeriod) {
      if (lowerBand > lbArr[i - 1] || cs[i - 1].c < lbArr[i - 1]) { /* keep */ } else lowerBand = lbArr[i - 1];
      if (upperBand < ubArr[i - 1] || cs[i - 1].c > ubArr[i - 1]) { /* keep */ } else upperBand = ubArr[i - 1];
    }
    ubArr[i] = upperBand; lbArr[i] = lowerBand;
    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i - 1] === 1) dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      else dirs[i] = cs[i].c > upperBand ? 1 : -1;
    }
    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }
  return { st, dir: dirs };
}

function computeZScores(candles: C[], momLb: number, volWin: number): number[] {
  const z = new Array(candles.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < candles.length; i++) {
    const mom = candles[i].c / candles[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin + 1); j <= i; j++) {
      const r = candles[j].c / candles[j - 1].c - 1;
      sumSq += r * r; count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

function donchCloseHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c);
  return mx;
}
function donchCloseLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c);
  return mn;
}

// ─── Cost model ────────────────────────────────────────────────────
function getSpread(pair: string): number { return SP[pair] ?? 4e-4; }
function entryPrice(pair: string, dir: "long" | "short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function exitPrice(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long" | "short", ep: number, xp: number, sz: number): number {
  const notional = sz * LEV;
  const raw = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return raw - notional * FEE * 2;
}

// ─── Load data ─────────────────────────────────────────────────────
console.log("Loading 5m candle data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = load5m(p);
  if (d.length > 0) { raw5m.set(p, d); }
  else console.log(`  ${p}: MISSING`);
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}
console.log(`Loaded ${raw5m.size} pairs, aggregated to daily/4h/1h.\n`);

// BTC trend filters
const btcDaily = dailyData.get("BTC")!;
const btcDailyCloses = btcDaily.map(c => c.c);
const btcDailyEma20 = calcEMA(btcDailyCloses, 20);
const btcDailyEma50 = calcEMA(btcDailyCloses, 50);

const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);

function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t <= t) { idx = i; break; }
  }
  if (idx < 0) return false;
  const i20 = idx - (btcDaily.length - btcDailyEma20.length);
  const i50 = idx - (btcDaily.length - btcDailyEma50.length);
  if (i20 < 0 || i50 < 0 || i20 >= btcDailyEma20.length || i50 >= btcDailyEma50.length) return false;
  return btcDailyEma20[i20] > btcDailyEma50[i50];
}

function btcH1Trend(t: number): "long" | "short" | null {
  let idx: number | undefined;
  for (let i = btcH1.length - 1; i >= 0; i--) {
    if (btcH1[i].t <= t) { idx = i; break; }
  }
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  const off9 = btcH1.length - btcH1Ema9.length;
  const off21 = btcH1.length - btcH1Ema21.length;
  const i9 = prev - off9;
  const i21 = prev - off21;
  if (i9 < 0 || i21 < 0 || i9 >= btcH1Ema9.length || i21 >= btcH1Ema21.length) return null;
  if (btcH1Ema9[i9] > btcH1Ema21[i21]) return "long";
  if (btcH1Ema9[i9] < btcH1Ema21[i21]) return "short";
  return null;
}

// ════════════════════════════════════════════════════════════════════
// ENGINE A: Supertrend(14, 1.75) + volume filter + regime gate
// $3 margin, 4h timeframe
// ════════════════════════════════════════════════════════════════════
interface SupertrendOpts {
  stPer: number; stMult: number;
  maxHoldDays: number; sz: number;
  breakevenAfterATR?: boolean;   // T2: move SL to entry after 1xATR profit
  timeStopDays?: number;         // T1: close if not profitable after N days
}

function engineSupertrend(startTs: number, endTs: number, opts: SupertrendOpts): Trade[] {
  const trades: Trade[] = [];
  const { stPer, stMult, maxHoldDays, sz, breakevenAfterATR, timeStopDays } = opts;
  const maxHoldMs = maxHoldDays * D;

  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < stPer + 30) continue;

    const { dir: stDir } = calcSupertrend(cs, stPer, stMult);
    const atr = calcATR(cs, stPer);

    let pos: (Position & { origSl: number }) | null = null;

    for (let i = stPer + 2; i < cs.length; i++) {
      const bar = cs[i];
      const prevDir = stDir[i - 1];
      const prevPrevDir = stDir[i - 2];
      const flip = prevDir !== prevPrevDir;

      // Exits
      if (pos) {
        let xp = 0, isSL = false, reason = "";

        // SL check
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; reason = "sl"; }

        // Supertrend flip exit
        if (!xp && flip) { xp = bar.o; reason = "flip"; }

        // Time stop: close if not profitable after N days
        if (!xp && timeStopDays) {
          const holdMs = bar.t - pos.et;
          if (holdMs >= timeStopDays * D) {
            const curPnl = pos.dir === "long"
              ? (bar.c / pos.ep - 1) * sz * LEV
              : (pos.ep / bar.c - 1) * sz * LEV;
            if (curPnl <= 0) { xp = bar.c; reason = "time-stop"; }
          }
        }

        // Max hold
        if (!xp && bar.t - pos.et >= maxHoldMs) { xp = bar.c; reason = "stag"; }

        // Breakeven stop: move SL to entry once up 1xATR
        if (!xp && breakevenAfterATR) {
          const curATR = atr[i - 1];
          if (curATR > 0) {
            if (pos.dir === "long" && bar.h >= pos.ep + curATR) {
              pos.sl = Math.max(pos.sl, pos.ep);
            } else if (pos.dir === "short" && bar.l <= pos.ep - curATR) {
              pos.sl = Math.min(pos.sl, pos.ep);
            }
          }
        }

        if (xp > 0) {
          const xpAdj = exitPrice(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj, sz);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, engine: "ST", reason });
          }
          pos = null;
        }
      }

      // Entries
      if (!pos && flip && bar.t >= startTs && bar.t < endTs) {
        const dir: "long" | "short" = prevDir === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPrice(pair, dir, bar.o);
        const atrSL = prevATR * 3;
        const capSL = ep * 0.035;
        const slDist = Math.min(atrSL, capSL);
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        pos = { pair, dir, ep, et: bar.t, sl, engine: "ST", origSl: sl };
      }
    }
  }
  return trades;
}

// ════════════════════════════════════════════════════════════════════
// ENGINE B: GARCH v2 MTF (1h+4h z-score) + vol+range filter
// $5 margin, SL 3%, TP 7%, 96h hold
// ════════════════════════════════════════════════════════════════════
interface GarchOpts {
  slPct: number; tpPct: number;
  maxHoldHours: number; sz: number;
  breakevenAfterATR?: boolean;
  timeStopDays?: number;
}

function engineGarch(startTs: number, endTs: number, opts: GarchOpts): Trade[] {
  const trades: Trade[] = [];
  const { slPct, tpPct, maxHoldHours, sz, breakevenAfterATR, timeStopDays } = opts;
  const MOM_LB = 3, VOL_WIN = 20;
  const EMA_FAST = 9, EMA_SLOW = 21;
  const Z_LONG_1H = 4.5, Z_SHORT_1H = -3.0;
  const Z_LONG_4H = 3.0, Z_SHORT_4H = -3.0;

  for (const pair of PAIRS) {
    const h1 = h1Data.get(pair);
    const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;

    const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
    const z4h = computeZScores(h4, MOM_LB, VOL_WIN);
    const h1Closes = h1.map(c => c.c);
    const ema9_1h = calcEMA(h1Closes, EMA_FAST);
    const ema21_1h = calcEMA(h1Closes, EMA_SLOW);
    const atr1h = calcATR(h1, 14);

    const h4TsMap = new Map<number, number>();
    h4.forEach((c, i) => h4TsMap.set(c.t, i));

    let pos: (Position & { tp?: number }) | null = null;

    for (let i = Math.max(VOL_WIN + MOM_LB + 2, EMA_SLOW + 1); i < h1.length; i++) {
      const bar = h1[i];

      // Exits
      if (pos) {
        let xp = 0, isSL = false, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; reason = "sl"; }

        // TP
        if (!xp && pos.tp) {
          if (pos.dir === "long" && bar.h >= pos.tp) { xp = pos.tp; reason = "tp"; }
          else if (pos.dir === "short" && bar.l <= pos.tp) { xp = pos.tp; reason = "tp"; }
        }

        // Time stop
        if (!xp && timeStopDays) {
          const holdMs = bar.t - pos.et;
          if (holdMs >= timeStopDays * D) {
            const curPnl = pos.dir === "long"
              ? (bar.c / pos.ep - 1) * sz * LEV
              : (pos.ep / bar.c - 1) * sz * LEV;
            if (curPnl <= 0) { xp = bar.c; reason = "time-stop"; }
          }
        }

        // Max hold
        if (!xp && (bar.t - pos.et) / H >= maxHoldHours) { xp = bar.c; reason = "stag"; }

        // Breakeven stop
        if (!xp && breakevenAfterATR) {
          const curATR = atr1h[i - 1];
          if (curATR > 0) {
            if (pos.dir === "long" && bar.h >= pos.ep + curATR) {
              pos.sl = Math.max(pos.sl, pos.ep);
            } else if (pos.dir === "short" && bar.l <= pos.ep - curATR) {
              pos.sl = Math.min(pos.sl, pos.ep);
            }
          }
        }

        if (xp > 0) {
          const xpAdj = exitPrice(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj, sz);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, engine: "GH", reason });
          }
          pos = null;
        }
      }

      // Entries
      if (!pos && bar.t >= startTs && bar.t < endTs) {
        const prev = i - 1;
        if (prev < VOL_WIN + MOM_LB) continue;

        const z1 = z1h[prev];
        if (isNaN(z1) || z1 === 0) continue;

        const goLong = z1 > Z_LONG_1H;
        const goShort = z1 < Z_SHORT_1H;
        if (!goLong && !goShort) continue;

        // 4h confirmation
        const ts4h = Math.floor(h1[prev].t / H4) * H4;
        const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) continue;
        const z4 = z4h[idx4h];
        if (goLong && z4 <= Z_LONG_4H) continue;
        if (goShort && z4 >= Z_SHORT_4H) continue;

        // EMA filter
        const off9 = h1.length - ema9_1h.length;
        const off21 = h1.length - ema21_1h.length;
        const i9 = prev - off9;
        const i21 = prev - off21;
        if (i9 < 0 || i21 < 0 || i9 >= ema9_1h.length || i21 >= ema21_1h.length) continue;
        if (goLong && ema9_1h[i9] <= ema21_1h[i21]) continue;
        if (goShort && ema9_1h[i9] >= ema21_1h[i21]) continue;

        // BTC trend
        const btcTrend = btcH1Trend(h1[prev].t);
        if (goLong && btcTrend !== "long") continue;
        if (goShort && btcTrend !== "short") continue;

        const dir: "long" | "short" = goLong ? "long" : "short";
        const ep = entryPrice(pair, dir, bar.o);
        let sl = dir === "long" ? ep * (1 - slPct) : ep * (1 + slPct);
        if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        let tp: number | undefined;
        if (tpPct > 0) {
          tp = dir === "long" ? ep * (1 + tpPct) : ep * (1 - tpPct);
        }

        pos = { pair, dir, ep, et: bar.t, sl, engine: "GH", tp };
      }
    }
  }
  return trades;
}

// ════════════════════════════════════════════════════════════════════
// ENGINE C: Donchian (SMA 20/50, 15d exit, ATR*3, 60d hold, $5)
// ════════════════════════════════════════════════════════════════════
interface DonchianOpts {
  smaFast: number; smaSlow: number; exitLb: number;
  atrMult: number; maxHoldDays: number; sz: number;
  breakevenAfterATR?: boolean;
  timeStopDays?: number;
}

function engineDonchian(startTs: number, endTs: number, opts: DonchianOpts): Trade[] {
  const trades: Trade[] = [];
  const { smaFast, smaSlow, exitLb, atrMult, maxHoldDays, sz, breakevenAfterATR, timeStopDays } = opts;

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < smaSlow + 20) continue;

    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, smaFast);
    const slow = calcSMA(closes, smaSlow);
    const atr = calcATR(cs, 14);
    const warmup = smaSlow + 1;

    let pos: (Position & { origSl: number }) | null = null;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      // Exits
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / D);
        let xp = 0, isSL = false, reason = "";

        // SL
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; reason = "sl"; }

        // Donchian channel exit
        if (!xp && i >= exitLb + 1) {
          if (pos.dir === "long") {
            const chanLow = donchCloseLow(cs, i, exitLb);
            if (bar.c < chanLow) { xp = bar.c; reason = "chan-exit"; }
          } else {
            const chanHigh = donchCloseHigh(cs, i, exitLb);
            if (bar.c > chanHigh) { xp = bar.c; reason = "chan-exit"; }
          }
        }

        // Time stop
        if (!xp && timeStopDays) {
          if (holdDays >= timeStopDays) {
            const curPnl = pos.dir === "long"
              ? (bar.c / pos.ep - 1) * sz * LEV
              : (pos.ep / bar.c - 1) * sz * LEV;
            if (curPnl <= 0) { xp = bar.c; reason = "time-stop"; }
          }
        }

        // Max hold
        if (!xp && holdDays >= maxHoldDays) { xp = bar.c; reason = "stag"; }

        // Breakeven stop
        if (!xp && breakevenAfterATR) {
          const curATR = atr[i - 1];
          if (curATR > 0) {
            if (pos.dir === "long" && bar.h >= pos.ep + curATR) {
              pos.sl = Math.max(pos.sl, pos.ep);
            } else if (pos.dir === "short" && bar.l <= pos.ep - curATR) {
              pos.sl = Math.min(pos.sl, pos.ep);
            }
          }
        }

        if (xp > 0) {
          const xpAdj = exitPrice(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj, sz);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, engine: "DN", reason });
          }
          pos = null;
        }
      }

      // Entries
      if (!pos && bar.t >= startTs && bar.t < endTs) {
        const prev = i - 1;
        const prevFast = fast[prev]; const prevSlow = slow[prev];
        const curFast = fast[i]; const curSlow = slow[i];
        if (prevFast === 0 || prevSlow === 0 || curFast === 0 || curSlow === 0) continue;

        let dir: "long" | "short" | null = null;
        if (prevFast <= prevSlow && curFast > curSlow) dir = "long";
        else if (prevFast >= prevSlow && curFast < curSlow) dir = "short";
        if (!dir) continue;

        // BTC filter
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPrice(pair, dir, bar.o);
        let sl = dir === "long" ? ep - atrMult * prevATR : ep + atrMult * prevATR;
        if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir, ep, et: bar.t, sl, engine: "DN", origSl: sl };
      }
    }
  }
  return trades;
}

// ════════════════════════════════════════════════════════════════════
// ENSEMBLE SIMULATOR with portfolio-level controls
// ════════════════════════════════════════════════════════════════════
interface EnsembleOpts {
  maxPos: number;
  portfolioTimeStopDays?: number;    // T3: close all if portfolio in DD >N days
  portfolioPauseDays?: number;       // T3: wait N days after portfolio stop
  dailyLossLimit?: number;           // T6: halt all engines if daily loss >$N
  dailyPauseHours?: number;          // T6: pause duration after daily limit hit
}

interface DDMetrics {
  maxDDDuration: number;     // days
  maxRecoveryTime: number;   // days
  longestLosingStreak: number; // days
}

function simulateEnsemble(
  allTrades: Trade[],
  opts: EnsembleOpts,
): { trades: Trade[]; blocked: number } {
  interface Event { t: number; type: "entry" | "exit"; trade: Trade; }
  const events: Event[] = [];
  for (const tr of allTrades) {
    events.push({ t: tr.et, type: "entry", trade: tr });
    events.push({ t: tr.xt, type: "exit", trade: tr });
  }
  events.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));

  const open = new Map<string, Trade>();
  const accepted: Trade[] = [];
  let blocked = 0;

  // Portfolio-level state
  let cumPnl = 0;
  let peakPnl = 0;
  let ddStartTs = 0;
  let pauseUntil = 0;

  // Daily loss tracking
  const dailyPnl = new Map<number, number>();
  let dailyPauseUntil = 0;

  for (const evt of events) {
    const key = `${evt.trade.engine}:${evt.trade.pair}`;

    if (evt.type === "exit") {
      if (open.has(key)) {
        const tr = open.get(key)!;
        cumPnl += tr.pnl;

        // Track daily PnL
        const dayKey = Math.floor(evt.t / D);
        dailyPnl.set(dayKey, (dailyPnl.get(dayKey) ?? 0) + tr.pnl);

        // Check daily loss limit
        if (opts.dailyLossLimit !== undefined) {
          const todayPnl = dailyPnl.get(dayKey) ?? 0;
          if (todayPnl < -opts.dailyLossLimit) {
            dailyPauseUntil = evt.t + (opts.dailyPauseHours ?? 24) * H;
          }
        }

        if (cumPnl > peakPnl) {
          peakPnl = cumPnl;
          ddStartTs = 0;
        } else if (cumPnl < peakPnl && ddStartTs === 0) {
          ddStartTs = evt.t;
        }

        // Portfolio time stop: if in DD for > N days, close all
        if (opts.portfolioTimeStopDays && ddStartTs > 0) {
          const ddDuration = (evt.t - ddStartTs) / D;
          if (ddDuration >= opts.portfolioTimeStopDays) {
            // Close all open positions (they exit at their normal times, but block new entries)
            pauseUntil = evt.t + (opts.portfolioPauseDays ?? 2) * D;
            ddStartTs = 0; // reset
          }
        }

        open.delete(key);
      }
    } else {
      if (open.has(key)) continue;
      if (open.size >= opts.maxPos) { blocked++; continue; }
      if (evt.t < pauseUntil) { blocked++; continue; }
      if (evt.t < dailyPauseUntil) { blocked++; continue; }
      open.set(key, evt.trade);
      accepted.push(evt.trade);
    }
  }
  return { trades: accepted, blocked };
}

// ════════════════════════════════════════════════════════════════════
// METRICS (with DD duration tracking)
// ════════════════════════════════════════════════════════════════════
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
  ddDuration: number;    // max DD duration in days
  recoveryTime: number;  // max recovery time in days
  longestLosing: number; // longest consecutive losing days
}

function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  const empty: Metrics = { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, ddDuration: 0, recoveryTime: 0, longestLosing: 0 };
  if (trades.length === 0) return empty;

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  // Sort by exit time for equity curve
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);

  // Max DD (dollar)
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // DD duration and recovery time (day-by-day equity curve)
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }

  // Build continuous daily equity curve
  const startDay = Math.floor(startTs / D);
  const endDay = Math.floor(endTs / D);
  let equity = 0;
  let eqPeak = 0;
  let ddStartDay = -1;
  let maxDDDuration = 0;
  let maxRecoveryTime = 0;
  let curLosing = 0;
  let maxLosing = 0;

  for (let day = startDay; day <= endDay; day++) {
    const pnl = dayPnl.get(day) ?? 0;
    equity += pnl;

    // Track losing streaks (consecutive days with negative cumulative since last peak)
    if (pnl < 0) { curLosing++; maxLosing = Math.max(maxLosing, curLosing); }
    else if (pnl > 0) curLosing = 0;

    if (equity >= eqPeak) {
      // New peak: calculate recovery time if we were in DD
      if (ddStartDay >= 0) {
        const recoveryDays = day - ddStartDay;
        maxRecoveryTime = Math.max(maxRecoveryTime, recoveryDays);
      }
      eqPeak = equity;
      ddStartDay = -1;
    } else {
      // In drawdown
      if (ddStartDay < 0) ddStartDay = day;
      const ddDays = day - ddStartDay;
      maxDDDuration = Math.max(maxDDDuration, ddDays);
    }
  }
  // If still in DD at end
  if (ddStartDay >= 0) {
    maxDDDuration = Math.max(maxDDDuration, endDay - ddStartDay);
    maxRecoveryTime = Math.max(maxRecoveryTime, endDay - ddStartDay);
  }

  // Sharpe
  const returns = [...dayPnl.values()];
  const mean = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const std = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = Math.max((endTs - startTs) / D, 1);
  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe, dd: maxDD, total, perDay: total / days,
    ddDuration: maxDDDuration,
    recoveryTime: maxRecoveryTime,
    longestLosing: maxLosing,
  };
}

// ════════════════════════════════════════════════════════════════════
// FORMATTING
// ════════════════════════════════════════════════════════════════════
function fmtPnl(v: number): string { return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }

function fmtRow(label: string, m: Metrics): string {
  return `${label.padEnd(48)} `
    + `N=${String(m.n).padStart(4)}  `
    + `WR=${m.wr.toFixed(1).padStart(5)}%  `
    + `PF=${m.pf.toFixed(2).padStart(5)}  `
    + `Sh=${m.sharpe.toFixed(2).padStart(5)}  `
    + `${fmtPnl(m.perDay).padStart(8)}/d  `
    + `MaxDD=$${m.dd.toFixed(2).padStart(6)}  `
    + `DDdur=${String(m.ddDuration).padStart(3)}d  `
    + `Rec=${String(m.recoveryTime).padStart(3)}d  `
    + `LoseStrk=${String(m.longestLosing).padStart(2)}d`;
}

// ════════════════════════════════════════════════════════════════════
// GENERATE ENSEMBLE TRADES (run all 3 engines)
// ════════════════════════════════════════════════════════════════════
type TechniqueConfig = {
  label: string;
  stOpts: SupertrendOpts;
  garchOpts: GarchOpts;
  donchOpts: DonchianOpts;
  ensembleOpts: EnsembleOpts;
};

function runTechnique(cfg: TechniqueConfig): { m: Metrics; trades: Trade[] } {
  const stTrades = engineSupertrend(OOS_START, FULL_END, cfg.stOpts);
  const ghTrades = engineGarch(OOS_START, FULL_END, cfg.garchOpts);
  const dnTrades = engineDonchian(OOS_START, FULL_END, cfg.donchOpts);
  const allTrades = [...stTrades, ...ghTrades, ...dnTrades];
  const { trades } = simulateEnsemble(allTrades, cfg.ensembleOpts);
  const m = calcMetrics(trades, OOS_START, FULL_END);
  return { m, trades };
}

// ════════════════════════════════════════════════════════════════════
// BASELINE CONFIG
// ════════════════════════════════════════════════════════════════════
const BASELINE_ST: SupertrendOpts = { stPer: 14, stMult: 1.75, maxHoldDays: 60, sz: 3 };
const BASELINE_GH: GarchOpts = { slPct: 0.03, tpPct: 0.07, maxHoldHours: 96, sz: 5 };
const BASELINE_DN: DonchianOpts = { smaFast: 20, smaSlow: 50, exitLb: 15, atrMult: 3, maxHoldDays: 60, sz: 5 };
const BASELINE_ENS: EnsembleOpts = { maxPos: 10 };

// ════════════════════════════════════════════════════════════════════
// MAIN: Run all 8 techniques
// ════════════════════════════════════════════════════════════════════
const sep = "=".repeat(150);

console.log(sep);
console.log("DRAWDOWN DURATION REDUCTION STUDY: 3-Engine Ensemble (Supertrend + GARCH + Donchian)");
console.log("OOS: 2025-09-01 to 2026-03-26 | Cost: Taker 0.035%, spread map, 1.5x SL slip, 10x lev");
console.log("Target: MaxDD duration <15d, Recovery <20d");
console.log(sep);

// 0. BASELINE
console.log("\n--- T0: BASELINE ---");
const baseResult = runTechnique({
  label: "0. Baseline",
  stOpts: { ...BASELINE_ST },
  garchOpts: { ...BASELINE_GH },
  donchOpts: { ...BASELINE_DN },
  ensembleOpts: { ...BASELINE_ENS },
});
console.log(fmtRow("0. Baseline (ST14/1.75 + GH 96h + DN 60d)", baseResult.m));

// 1. AGGRESSIVE TIME-STOP: Close losing positions after 5 days
console.log("\n--- T1: AGGRESSIVE TIME-STOP (5d) ---");
const t1Result = runTechnique({
  label: "1. Time-stop 5d",
  stOpts: { ...BASELINE_ST, timeStopDays: 5 },
  garchOpts: { ...BASELINE_GH, timeStopDays: 5 },
  donchOpts: { ...BASELINE_DN, timeStopDays: 5 },
  ensembleOpts: { ...BASELINE_ENS },
});
console.log(fmtRow("1. Time-stop 5d (close losers after 5d)", t1Result.m));

// 2. BREAKEVEN STOP AFTER 1xATR
console.log("\n--- T2: BREAKEVEN STOP AFTER 1xATR ---");
const t2Result = runTechnique({
  label: "2. Breakeven 1xATR",
  stOpts: { ...BASELINE_ST, breakevenAfterATR: true },
  garchOpts: { ...BASELINE_GH, breakevenAfterATR: true },
  donchOpts: { ...BASELINE_DN, breakevenAfterATR: true },
  ensembleOpts: { ...BASELINE_ENS },
});
console.log(fmtRow("2. Breakeven stop after 1xATR profit", t2Result.m));

// 3. PORTFOLIO-LEVEL TIME-STOP (7d DD -> close all, wait 48h)
console.log("\n--- T3: PORTFOLIO TIME-STOP (7d DD -> pause 48h) ---");
const t3Result = runTechnique({
  label: "3. Portfolio time-stop",
  stOpts: { ...BASELINE_ST },
  garchOpts: { ...BASELINE_GH },
  donchOpts: { ...BASELINE_DN },
  ensembleOpts: { ...BASELINE_ENS, portfolioTimeStopDays: 7, portfolioPauseDays: 2 },
});
console.log(fmtRow("3. Portfolio: DD>7d -> pause 48h", t3Result.m));

// 4. FASTER DONCHIAN EXIT (7d exit channel instead of 15d)
console.log("\n--- T4: FASTER DONCHIAN EXIT (7d vs 15d) ---");
const t4Result = runTechnique({
  label: "4. Donch exit 7d",
  stOpts: { ...BASELINE_ST },
  garchOpts: { ...BASELINE_GH },
  donchOpts: { ...BASELINE_DN, exitLb: 7 },
  ensembleOpts: { ...BASELINE_ENS },
});
console.log(fmtRow("4. Donchian exit channel 7d (vs 15d)", t4Result.m));

// 5. FASTER SUPERTREND: ST(10, 1.5) instead of ST(14, 1.75)
console.log("\n--- T5: FASTER SUPERTREND (10, 1.5) ---");
const t5Result = runTechnique({
  label: "5. ST(10,1.5)",
  stOpts: { ...BASELINE_ST, stPer: 10, stMult: 1.5 },
  garchOpts: { ...BASELINE_GH },
  donchOpts: { ...BASELINE_DN },
  ensembleOpts: { ...BASELINE_ENS },
});
console.log(fmtRow("5. Supertrend(10,1.5) tighter bands", t5Result.m));

// 6. DAILY LOSS PAUSE: >$3 daily loss -> halt 24h
console.log("\n--- T6: DAILY LOSS PAUSE ($3 -> 24h halt) ---");
const t6Result = runTechnique({
  label: "6. Daily loss pause",
  stOpts: { ...BASELINE_ST },
  garchOpts: { ...BASELINE_GH },
  donchOpts: { ...BASELINE_DN },
  ensembleOpts: { ...BASELINE_ENS, dailyLossLimit: 3, dailyPauseHours: 24 },
});
console.log(fmtRow("6. Daily loss >$3 -> halt 24h", t6Result.m));

// 7. REDUCE MAX HOLD TIMES: DN 60->30d, ST 60->14d, GH 96->48h
console.log("\n--- T7: REDUCED MAX HOLD TIMES ---");
const t7Result = runTechnique({
  label: "7. Shorter holds",
  stOpts: { ...BASELINE_ST, maxHoldDays: 14 },
  garchOpts: { ...BASELINE_GH, maxHoldHours: 48 },
  donchOpts: { ...BASELINE_DN, maxHoldDays: 30 },
  ensembleOpts: { ...BASELINE_ENS },
});
console.log(fmtRow("7. Hold: ST 14d, GH 48h, DN 30d", t7Result.m));

// ════════════════════════════════════════════════════════════════════
// FIND TOP 3 DD-DURATION SHORTENERS
// ════════════════════════════════════════════════════════════════════
const results = [
  { name: "T1 Time-stop 5d", result: t1Result, stOpts: { ...BASELINE_ST, timeStopDays: 5 }, garchOpts: { ...BASELINE_GH, timeStopDays: 5 }, donchOpts: { ...BASELINE_DN, timeStopDays: 5 }, ensOpts: { ...BASELINE_ENS } },
  { name: "T2 Breakeven 1xATR", result: t2Result, stOpts: { ...BASELINE_ST, breakevenAfterATR: true }, garchOpts: { ...BASELINE_GH, breakevenAfterATR: true }, donchOpts: { ...BASELINE_DN, breakevenAfterATR: true }, ensOpts: { ...BASELINE_ENS } },
  { name: "T3 Portfolio stop", result: t3Result, stOpts: { ...BASELINE_ST }, garchOpts: { ...BASELINE_GH }, donchOpts: { ...BASELINE_DN }, ensOpts: { ...BASELINE_ENS, portfolioTimeStopDays: 7, portfolioPauseDays: 2 } },
  { name: "T4 Donch exit 7d", result: t4Result, stOpts: { ...BASELINE_ST }, garchOpts: { ...BASELINE_GH }, donchOpts: { ...BASELINE_DN, exitLb: 7 }, ensOpts: { ...BASELINE_ENS } },
  { name: "T5 ST(10,1.5)", result: t5Result, stOpts: { ...BASELINE_ST, stPer: 10, stMult: 1.5 }, garchOpts: { ...BASELINE_GH }, donchOpts: { ...BASELINE_DN }, ensOpts: { ...BASELINE_ENS } },
  { name: "T6 Daily loss $3", result: t6Result, stOpts: { ...BASELINE_ST }, garchOpts: { ...BASELINE_GH }, donchOpts: { ...BASELINE_DN }, ensOpts: { ...BASELINE_ENS, dailyLossLimit: 3, dailyPauseHours: 24 } },
  { name: "T7 Shorter holds", result: t7Result, stOpts: { ...BASELINE_ST, maxHoldDays: 14 }, garchOpts: { ...BASELINE_GH, maxHoldHours: 48 }, donchOpts: { ...BASELINE_DN, maxHoldDays: 30 }, ensOpts: { ...BASELINE_ENS } },
];

// Sort by DD duration (lower = better), then by recovery time
const sortedByDD = [...results].sort((a, b) => {
  const ddDiff = a.result.m.ddDuration - b.result.m.ddDuration;
  if (ddDiff !== 0) return ddDiff;
  return a.result.m.recoveryTime - b.result.m.recoveryTime;
});

console.log("\n" + sep);
console.log("RANKING BY DD DURATION (lower = better)");
console.log(sep);
console.log(`Baseline: DDdur=${baseResult.m.ddDuration}d  Rec=${baseResult.m.recoveryTime}d  LoseStrk=${baseResult.m.longestLosing}d  $/d=${fmtPnl(baseResult.m.perDay)}`);
console.log("-".repeat(150));

for (let i = 0; i < sortedByDD.length; i++) {
  const r = sortedByDD[i];
  const ddChg = r.result.m.ddDuration - baseResult.m.ddDuration;
  const recChg = r.result.m.recoveryTime - baseResult.m.recoveryTime;
  const pnlChg = r.result.m.perDay - baseResult.m.perDay;
  console.log(
    `${String(i + 1).padStart(2)}. ${r.name.padEnd(25)} `
    + `DDdur=${String(r.result.m.ddDuration).padStart(3)}d (${ddChg >= 0 ? "+" : ""}${ddChg}d)  `
    + `Rec=${String(r.result.m.recoveryTime).padStart(3)}d (${recChg >= 0 ? "+" : ""}${recChg}d)  `
    + `LoseStrk=${String(r.result.m.longestLosing).padStart(2)}d  `
    + `PF=${r.result.m.pf.toFixed(2)}  `
    + `${fmtPnl(r.result.m.perDay)}/d (${pnlChg >= 0 ? "+" : ""}${pnlChg.toFixed(2)})  `
    + `MaxDD=$${r.result.m.dd.toFixed(2)}`
  );
}

// ════════════════════════════════════════════════════════════════════
// T8: COMBINED BEST (top 3 DD-shortening techniques stacked)
// ════════════════════════════════════════════════════════════════════
console.log("\n" + sep);
console.log("T8: COMBINED BEST (top 3 DD-shortening techniques stacked)");
console.log(sep);

const top3 = sortedByDD.slice(0, 3);
console.log(`Stacking: ${top3.map(t => t.name).join(" + ")}`);

// Merge all opts from top 3
let combinedST: SupertrendOpts = { ...BASELINE_ST };
let combinedGH: GarchOpts = { ...BASELINE_GH };
let combinedDN: DonchianOpts = { ...BASELINE_DN };
let combinedENS: EnsembleOpts = { ...BASELINE_ENS };

for (const t of top3) {
  combinedST = { ...combinedST, ...t.stOpts };
  combinedGH = { ...combinedGH, ...t.garchOpts };
  combinedDN = { ...combinedDN, ...t.donchOpts };
  combinedENS = { ...combinedENS, ...t.ensOpts };
}

const t8Result = runTechnique({
  label: "8. Combined best",
  stOpts: combinedST,
  garchOpts: combinedGH,
  donchOpts: combinedDN,
  ensembleOpts: combinedENS,
});
console.log(fmtRow("8. Combined top-3 stacked", t8Result.m));

// Compare to baseline
const ddChg8 = t8Result.m.ddDuration - baseResult.m.ddDuration;
const recChg8 = t8Result.m.recoveryTime - baseResult.m.recoveryTime;
const pnlChg8 = t8Result.m.perDay - baseResult.m.perDay;
console.log(`\nVs baseline: DDdur ${ddChg8 >= 0 ? "+" : ""}${ddChg8}d | Rec ${recChg8 >= 0 ? "+" : ""}${recChg8}d | $/d ${pnlChg8 >= 0 ? "+" : ""}${pnlChg8.toFixed(2)}`);

// ════════════════════════════════════════════════════════════════════
// EXTRA: Try aggressive combined variant
// ════════════════════════════════════════════════════════════════════
console.log("\n" + sep);
console.log("BONUS: AGGRESSIVE COMBINED (all 7 techniques stacked)");
console.log(sep);

const aggressiveResult = runTechnique({
  label: "ALL stacked",
  stOpts: { stPer: 10, stMult: 1.5, maxHoldDays: 14, sz: 3, breakevenAfterATR: true, timeStopDays: 5 },
  garchOpts: { slPct: 0.03, tpPct: 0.07, maxHoldHours: 48, sz: 5, breakevenAfterATR: true, timeStopDays: 5 },
  donchOpts: { smaFast: 20, smaSlow: 50, exitLb: 7, atrMult: 3, maxHoldDays: 30, sz: 5, breakevenAfterATR: true, timeStopDays: 5 },
  ensembleOpts: { maxPos: 10, portfolioTimeStopDays: 7, portfolioPauseDays: 2, dailyLossLimit: 3, dailyPauseHours: 24 },
});
console.log(fmtRow("ALL: Every technique stacked", aggressiveResult.m));

const ddChgAll = aggressiveResult.m.ddDuration - baseResult.m.ddDuration;
const recChgAll = aggressiveResult.m.recoveryTime - baseResult.m.recoveryTime;
const pnlChgAll = aggressiveResult.m.perDay - baseResult.m.perDay;
console.log(`Vs baseline: DDdur ${ddChgAll >= 0 ? "+" : ""}${ddChgAll}d | Rec ${recChgAll >= 0 ? "+" : ""}${recChgAll}d | $/d ${pnlChgAll >= 0 ? "+" : ""}${pnlChgAll.toFixed(2)}`);

// ════════════════════════════════════════════════════════════════════
// SUMMARY TABLE
// ════════════════════════════════════════════════════════════════════
console.log("\n" + sep);
console.log("FULL COMPARISON TABLE");
console.log(sep);
console.log(
  `${"Technique".padEnd(48)} `
  + `${"Trades".padStart(6)}  `
  + `${"WR%".padStart(6)}  `
  + `${"PF".padStart(6)}  `
  + `${"Sharpe".padStart(6)}  `
  + `${"$/day".padStart(9)}  `
  + `${"MaxDD$".padStart(8)}  `
  + `${"DDdur".padStart(6)}  `
  + `${"RecDays".padStart(7)}  `
  + `${"LoseStr".padStart(7)}`
);
console.log("-".repeat(150));

const allResults = [
  { label: "0. Baseline", m: baseResult.m },
  { label: "1. Time-stop 5d (close losers)", m: t1Result.m },
  { label: "2. Breakeven stop after 1xATR", m: t2Result.m },
  { label: "3. Portfolio DD>7d -> pause 48h", m: t3Result.m },
  { label: "4. Donchian exit 7d (vs 15d)", m: t4Result.m },
  { label: "5. Supertrend(10,1.5) tighter", m: t5Result.m },
  { label: "6. Daily loss >$3 -> halt 24h", m: t6Result.m },
  { label: "7. Shorter holds (ST14/GH48/DN30)", m: t7Result.m },
  { label: "8. Combined top-3", m: t8Result.m },
  { label: "9. ALL techniques stacked", m: aggressiveResult.m },
];

for (const r of allResults) {
  console.log(fmtRow(r.label, r.m));
}

// Target check
console.log("\n" + sep);
console.log("TARGET CHECK: DDdur <15d, Recovery <20d");
console.log(sep);
for (const r of allResults) {
  const ddOk = r.m.ddDuration < 15;
  const recOk = r.m.recoveryTime < 20;
  const status = ddOk && recOk ? "PASS" : "FAIL";
  console.log(
    `${status} ${r.label.padEnd(48)} DDdur=${String(r.m.ddDuration).padStart(3)}d ${ddOk ? "OK" : "XX"}  `
    + `Rec=${String(r.m.recoveryTime).padStart(3)}d ${recOk ? "OK" : "XX"}  `
    + `${fmtPnl(r.m.perDay)}/d`
  );
}

console.log("\nDone.");
