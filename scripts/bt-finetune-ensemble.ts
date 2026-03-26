/**
 * Fine-Tune All 4 Engines for Higher WR, Lower MaxDD, More $/day
 *
 * Engine A: Donchian (pullback entry, signal-flip exit, tighter channel)
 * Engine B: Supertrend (tighter ATR mult, ADX filter, smaller size, shorter hold)
 * Engine C: GARCH v2 MTF (stricter z, RSI confirm, wider TP, tighter SL)
 * Engine D: Carry Momentum (5d lookback, top-2, volume filter)
 *
 * Combined: max positions sweep, asymmetric sizing, ADX global gate
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-finetune-ensemble.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ─────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; engine: string;
}
interface Position {
  pair: string; dir: "long" | "short"; ep: number; et: number;
  sl: number; engine: string;
}
interface FR { coin: string; fundingRate: string; premium: string; time: number; }
interface HBar { t: number; o: number; h: number; l: number; c: number; funding: number; }
interface CarryTrade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pricePnl: number; fundingPnl: number; totalPnl: number;
}

// ─── Constants ─────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const FUNDING_DIR = "/tmp/hl-funding";
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
const CARRY_PAIRS = [
  "APT", "ARB", "DASH", "DOT", "ENA", "ETH", "LINK",
  "OP", "TRUMP", "UNI", "WIF", "WLD", "XRP",
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

function loadFunding(coin: string): FR[] {
  const fp = path.join(FUNDING_DIR, `${coin}_funding.json`);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function aggregateHourly(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const hTs = Math.floor(c.t / H) * H;
    const arr = groups.get(hTs) ?? [];
    arr.push(c);
    groups.set(hTs, arr);
  }
  const hourly: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 8) continue;
    hourly.push({
      t: ts, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return hourly;
}

function buildHourlyBars(pair: string, funding: FR[], candles: C[]): HBar[] {
  const hourly = aggregateHourly(candles);
  const fMap = new Map<number, number>();
  for (const f of funding) {
    const hTs = Math.floor(f.time / H) * H;
    fMap.set(hTs, parseFloat(f.fundingRate));
  }
  return hourly.map(c => ({ ...c, funding: fMap.get(c.t) ?? 0 }));
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

function calcRSI(values: number[], period: number): number[] {
  const rsi = new Array(values.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period && i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) avgGain += delta; else avgLoss += Math.abs(delta);
  }
  avgGain /= period;
  avgLoss /= period;
  if (period < values.length) {
    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcADX(cs: C[], period: number): number[] {
  const adx = new Array(cs.length).fill(0);
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    if (i === 0) { tr.push(cs[i].h - cs[i].l); plusDM.push(0); minusDM.push(0); continue; }
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
    const upMove = cs[i].h - cs[i - 1].h;
    const downMove = cs[i - 1].l - cs[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  // Smoothed
  let sTR = 0, sPDM = 0, sMDM = 0;
  for (let i = 0; i < period && i < tr.length; i++) { sTR += tr[i]; sPDM += plusDM[i]; sMDM += minusDM[i]; }
  const dx: number[] = [];
  for (let i = period; i < cs.length; i++) {
    if (i > period) {
      sTR = sTR - sTR / period + tr[i];
      sPDM = sPDM - sPDM / period + plusDM[i];
      sMDM = sMDM - sMDM / period + minusDM[i];
    }
    const pdi = sTR > 0 ? 100 * sPDM / sTR : 0;
    const mdi = sTR > 0 ? 100 * sMDM / sTR : 0;
    const dxVal = pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    dx.push(dxVal);
    if (dx.length >= period) {
      if (dx.length === period) {
        adx[i] = dx.reduce((s, v) => s + v, 0) / period;
      } else {
        adx[i] = (adx[i - 1] * (period - 1) + dxVal) / period;
      }
    }
  }
  return adx;
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

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];
    if (i > atrPeriod) {
      if (lowerBand > lb[i - 1] || cs[i - 1].c < lb[i - 1]) { /* keep */ } else lowerBand = lb[i - 1];
      if (upperBand < ub[i - 1] || cs[i - 1].c > ub[i - 1]) { /* keep */ } else upperBand = ub[i - 1];
    }
    ub[i] = upperBand; lb[i] = lowerBand;
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
  if (d.length > 0) { raw5m.set(p, d); console.log(`  ${p}: ${d.length} bars`); }
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
console.log("Aggregated: daily/4h/1h candles ready.\n");

// Load funding for carry
console.log("Loading funding data...");
const pairHourlyBars = new Map<string, HBar[]>();
const pairDailyForCarry = new Map<string, C[]>();
for (const p of CARRY_PAIRS) {
  const funding = loadFunding(p);
  const candles5m = raw5m.get(p);
  if (funding.length > 0 && candles5m) {
    pairHourlyBars.set(p, buildHourlyBars(p, funding, candles5m));
    pairDailyForCarry.set(p, dailyData.get(p) ?? []);
    console.log(`  ${p}: ${funding.length} funding records`);
  }
}
console.log("");

// BTC filters
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

// ────────────────────────────────────────────────────────────────────
// ENGINE A: Daily Donchian
// ────────────────────────────────────────────────────────────────────
interface EngineAOpts {
  smaFast: number; smaSlow: number; exitLb: number;
  atrMult: number; maxHold: number; sz: number;
  pullbackEntry: boolean; pullbackEmaPeriod: number;
  signalFlipExit: boolean;
}

const ENGINE_A_BASELINE: EngineAOpts = {
  smaFast: 30, smaSlow: 60, exitLb: 15,
  atrMult: 3, maxHold: 60, sz: 5,
  pullbackEntry: false, pullbackEmaPeriod: 9,
  signalFlipExit: false,
};

function engineA(startTs: number, endTs: number, opts: EngineAOpts): Trade[] {
  const trades: Trade[] = [];
  const { smaFast, smaSlow, exitLb, atrMult, maxHold, sz, pullbackEntry, pullbackEmaPeriod, signalFlipExit } = opts;

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < smaSlow + 20) continue;

    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, smaFast);
    const slow = calcSMA(closes, smaSlow);
    const atr = calcATR(cs, 14);
    const ema = pullbackEntry ? calcEMA(closes, pullbackEmaPeriod) : [];
    const warmup = smaSlow + 1;

    let pos: Position | null = null;
    let pendingSignal: { dir: "long" | "short"; barIdx: number } | null = null;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      // Exits
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / D);
        let xp = 0, isSL = false;

        // SL
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; }

        // Signal-flip exit: SMA cross reverses
        if (!xp && signalFlipExit) {
          const curFast = fast[i]; const curSlow = slow[i];
          if (curFast > 0 && curSlow > 0) {
            if (pos.dir === "long" && curFast < curSlow) xp = bar.c;
            else if (pos.dir === "short" && curFast > curSlow) xp = bar.c;
          }
        }

        // Donchian channel exit (on closes)
        if (!xp && i >= exitLb + 1) {
          if (pos.dir === "long") {
            const chanLow = donchCloseLow(cs, i, exitLb);
            if (bar.c < chanLow) xp = bar.c;
          } else {
            const chanHigh = donchCloseHigh(cs, i, exitLb);
            if (bar.c > chanHigh) xp = bar.c;
          }
        }

        // Max hold
        if (!xp && holdDays >= maxHold) xp = bar.c;

        if (xp > 0) {
          const xpAdj = exitPrice(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj, sz);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, engine: "A" });
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

        // For pullback: register breakout signal, enter when price touches EMA
        if (pullbackEntry) {
          if (dir) {
            pendingSignal = { dir, barIdx: i };
          }
          if (pendingSignal && !pos) {
            // Allow up to 5 bars for pullback
            if (i - pendingSignal.barIdx > 5) {
              pendingSignal = null;
            } else if (i > pendingSignal.barIdx) {
              const emaOff = cs.length - ema.length;
              const emaIdx = i - emaOff;
              if (emaIdx >= 0 && emaIdx < ema.length) {
                const emaVal = ema[emaIdx];
                const touched = pendingSignal.dir === "long"
                  ? bar.l <= emaVal * 1.002 // within 0.2% of EMA
                  : bar.h >= emaVal * 0.998;
                if (touched) {
                  dir = pendingSignal.dir;
                  pendingSignal = null;
                  // Fall through to actual entry below
                } else {
                  continue;
                }
              } else {
                continue;
              }
            } else {
              continue; // same bar as signal, skip for pullback
            }
          } else if (!dir) {
            continue;
          }
        }

        if (!dir) continue;

        // BTC filter
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPrice(pair, dir, bar.o);
        let sl = dir === "long" ? ep - atrMult * prevATR : ep + atrMult * prevATR;
        if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir, ep, et: bar.t, sl, engine: "A" };
        pendingSignal = null;
      }
    }
  }
  return trades;
}

// ────────────────────────────────────────────────────────────────────
// ENGINE B: 4h Supertrend
// ────────────────────────────────────────────────────────────────────
interface EngineBOpts {
  stPer: number; stMult: number;
  atrMult: number; maxHoldDays: number; sz: number;
  adxFilter: boolean; adxMin: number;
}

const ENGINE_B_BASELINE: EngineBOpts = {
  stPer: 14, stMult: 2,
  atrMult: 3, maxHoldDays: 60, sz: 5,
  adxFilter: false, adxMin: 20,
};

function engineB(startTs: number, endTs: number, opts: EngineBOpts): Trade[] {
  const trades: Trade[] = [];
  const { stPer, stMult, atrMult, maxHoldDays, sz, adxFilter, adxMin } = opts;
  const maxHoldH = maxHoldDays * 24;

  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < stPer + 30) continue;

    const { dir: stDir } = calcSupertrend(cs, stPer, stMult);
    const atr = calcATR(cs, stPer);
    const adxArr = adxFilter ? calcADX(cs, 14) : [];

    let pos: Position | null = null;

    for (let i = stPer + 2; i < cs.length; i++) {
      const bar = cs[i];
      const prevDir = stDir[i - 1];
      const prevPrevDir = stDir[i - 2];
      const flip = prevDir !== prevPrevDir;

      // Exits
      if (pos) {
        let xp = 0, isSL = false;
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; }
        if (!xp && flip) xp = bar.o;
        if (!xp && (bar.t - pos.et) / H >= maxHoldH) xp = bar.c;

        if (xp > 0) {
          const xpAdj = exitPrice(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj, sz);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, engine: "B" });
          }
          pos = null;
        }
      }

      // Entries
      if (!pos && flip && bar.t >= startTs && bar.t < endTs) {
        const dir: "long" | "short" = prevDir === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;

        // ADX filter
        if (adxFilter && adxArr.length > 0) {
          const adxVal = i - 1 < adxArr.length ? adxArr[i - 1] : 0;
          if (adxVal < adxMin) continue;
        }

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const ep = entryPrice(pair, dir, bar.o);
        let sl = dir === "long" ? ep - atrMult * prevATR : ep + atrMult * prevATR;
        if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir, ep, et: bar.t, sl, engine: "B" };
      }
    }
  }
  return trades;
}

// ────────────────────────────────────────────────────────────────────
// ENGINE C: GARCH v2 Multi-TF
// ────────────────────────────────────────────────────────────────────
interface EngineCOpts {
  zLong1H: number; zShort1H: number;
  zLong4H: number; zShort4H: number;
  slPct: number; maxHoldHours: number; sz: number;
  rsiFilter: boolean; rsiLong: number; rsiShort: number;
  tpPct: number; // 0 = no TP
}

const ENGINE_C_BASELINE: EngineCOpts = {
  zLong1H: 4.5, zShort1H: -3.0,
  zLong4H: 3.0, zShort4H: -3.0,
  slPct: 0.04, maxHoldHours: 168, sz: 5,
  rsiFilter: false, rsiLong: 30, rsiShort: 70,
  tpPct: 0,
};

function engineC(startTs: number, endTs: number, opts: EngineCOpts): Trade[] {
  const trades: Trade[] = [];
  const { zLong1H, zShort1H, zLong4H, zShort4H, slPct, maxHoldHours, sz, rsiFilter, rsiLong, rsiShort, tpPct } = opts;
  const MOM_LB = 3, VOL_WIN = 20;
  const EMA_FAST = 9, EMA_SLOW = 21;

  for (const pair of PAIRS) {
    const h1 = h1Data.get(pair);
    const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;

    const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
    const z4h = computeZScores(h4, MOM_LB, VOL_WIN);

    const h1Closes = h1.map(c => c.c);
    const ema9_1h = calcEMA(h1Closes, EMA_FAST);
    const ema21_1h = calcEMA(h1Closes, EMA_SLOW);
    const rsiArr = rsiFilter ? calcRSI(h1Closes, 14) : [];

    const h4TsMap = new Map<number, number>();
    h4.forEach((c, i) => h4TsMap.set(c.t, i));

    let pos: (Position & { tp?: number }) | null = null;

    for (let i = Math.max(VOL_WIN + MOM_LB + 2, EMA_SLOW + 1); i < h1.length; i++) {
      const bar = h1[i];

      // Exits
      if (pos) {
        let xp = 0, isSL = false;
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; }

        // TP check
        if (!xp && pos.tp) {
          if (pos.dir === "long" && bar.h >= pos.tp) xp = pos.tp;
          else if (pos.dir === "short" && bar.l <= pos.tp) xp = pos.tp;
        }

        // Max hold
        if (!xp && (bar.t - pos.et) / H >= maxHoldHours) xp = bar.c;

        if (xp > 0) {
          const xpAdj = exitPrice(pair, pos.dir, xp, isSL);
          const pnl = calcPnl(pos.dir, pos.ep, xpAdj, sz);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: bar.t, pnl, engine: "C" });
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

        const goLong = z1 > zLong1H;
        const goShort = z1 < zShort1H;
        if (!goLong && !goShort) continue;

        // 4h confirmation
        const ts4h = Math.floor(h1[prev].t / H4) * H4;
        const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) continue;
        const z4 = z4h[idx4h];
        if (goLong && z4 <= zLong4H) continue;
        if (goShort && z4 >= zShort4H) continue;

        // EMA filter
        const off9 = h1.length - ema9_1h.length;
        const off21 = h1.length - ema21_1h.length;
        const i9 = prev - off9;
        const i21 = prev - off21;
        if (i9 < 0 || i21 < 0 || i9 >= ema9_1h.length || i21 >= ema21_1h.length) continue;
        if (goLong && ema9_1h[i9] <= ema21_1h[i21]) continue;
        if (goShort && ema9_1h[i9] >= ema21_1h[i21]) continue;

        // RSI filter
        if (rsiFilter && rsiArr.length > 0) {
          const rsiVal = rsiArr[prev] ?? 50;
          if (goLong && rsiVal > rsiLong) continue;
          if (goShort && rsiVal < rsiShort) continue;
        }

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

        pos = { pair, dir, ep, et: bar.t, sl, engine: "C", tp };
      }
    }
  }
  return trades;
}

// ────────────────────────────────────────────────────────────────────
// ENGINE D: Carry Momentum
// ────────────────────────────────────────────────────────────────────
interface EngineDOpts {
  lookbackDays: number; topN: number; sz: number;
  volumeFilter: boolean; minVolume: number; // in USD daily
}

const ENGINE_D_BASELINE: EngineDOpts = {
  lookbackDays: 7, topN: 3, sz: 5,
  volumeFilter: false, minVolume: 10_000_000,
};

function engineD(startTs: number, endTs: number, opts: EngineDOpts): Trade[] {
  const { lookbackDays, topN, sz, volumeFilter, minVolume } = opts;
  const REBAL_H = 7 * 24;
  const LOOKBACK_H = lookbackDays * 24;
  const NOT = sz * LEV;
  const trades: Trade[] = [];

  const pairBarMap = new Map<string, Map<number, HBar>>();
  for (const p of CARRY_PAIRS) {
    const bars = pairHourlyBars.get(p);
    if (!bars) continue;
    const m = new Map<number, HBar>();
    for (const b of bars) m.set(b.t, b);
    pairBarMap.set(p, m);
  }

  // Precompute daily volume per pair (approximate from hourly OHLC)
  const dailyVolumeMap = new Map<string, Map<number, number>>();
  if (volumeFilter) {
    for (const p of CARRY_PAIRS) {
      const bars = pairHourlyBars.get(p);
      if (!bars) continue;
      const vm = new Map<number, number>();
      for (const b of bars) {
        const dayTs = Math.floor(b.t / D) * D;
        // Approximate volume: use price range * notional as proxy
        // We don't have real volume, so use price level * typical range ratio
        const range = Math.abs(b.h - b.l);
        const approxVol = (range / b.c) * b.c * 1000000; // rough proxy
        vm.set(dayTs, (vm.get(dayTs) ?? 0) + approxVol);
      }
      dailyVolumeMap.set(p, vm);
    }
  }

  function getMomentum(pair: string, t: number): number | null {
    const daily = pairDailyForCarry.get(pair);
    if (!daily) return null;
    const dayTs = Math.floor(t / D) * D;
    let todayBar: C | null = null;
    let pastBar: C | null = null;
    for (const d of daily) {
      if (Math.abs(d.t - dayTs) <= 2 * D) todayBar = d;
      if (Math.abs(d.t - (dayTs - lookbackDays * D)) <= 2 * D) pastBar = d;
    }
    if (!todayBar || !pastBar) return null;
    return (todayBar.c / pastBar.c) - 1;
  }

  const allTimes = new Set<number>();
  for (const p of CARRY_PAIRS) {
    const bars = pairHourlyBars.get(p);
    if (!bars) continue;
    for (const b of bars) {
      if (b.t >= startTs && b.t < endTs) allTimes.add(b.t);
    }
  }
  const sortedTimes = [...allTimes].sort((a, b) => a - b);
  if (sortedTimes.length === 0) return trades;

  let nextRebal = startTs;
  const positions = new Map<string, { pair: string; dir: "long" | "short"; ep: number; et: number }>();

  for (const t of sortedTimes) {
    if (t < nextRebal) continue;

    // Close existing
    for (const [, pos] of positions) {
      const bm = pairBarMap.get(pos.pair);
      if (!bm) continue;
      const bar = bm.get(t);
      if (!bar) continue;
      const xp = bar.o;
      const pricePnl = pos.dir === "long"
        ? (xp / pos.ep - 1) * NOT
        : (pos.ep / xp - 1) * NOT;
      let fundPnl = 0;
      const bars = pairHourlyBars.get(pos.pair) ?? [];
      for (const b of bars) {
        if (b.t >= pos.et && b.t < t) {
          if (pos.dir === "short") fundPnl += NOT * b.funding;
          else fundPnl -= NOT * b.funding;
        }
      }
      const sp = SP[pos.pair] ?? 4e-4;
      const cost = NOT * FEE * 2 + NOT * sp * 2;
      const totalPnl = pricePnl + fundPnl - cost;
      trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pnl: totalPnl, engine: "D" });
    }
    positions.clear();

    // Rank by trailing avg funding
    const rankings: { pair: string; avgFunding: number }[] = [];
    for (const pair of CARRY_PAIRS) {
      const bars = pairHourlyBars.get(pair);
      if (!bars) continue;
      let sum = 0, cnt = 0;
      for (const b of bars) {
        if (b.t >= t - LOOKBACK_H * H && b.t < t && b.funding !== 0) {
          sum += b.funding; cnt++;
        }
      }
      if (cnt < 20) continue;
      rankings.push({ pair, avgFunding: sum / cnt });
    }
    rankings.sort((a, b) => b.avgFunding - a.avgFunding);

    // Shorts: highest funding + negative momentum
    let shortCount = 0;
    for (const { pair, avgFunding } of rankings) {
      if (shortCount >= topN) break;
      if (avgFunding <= 0) break;
      const mom = getMomentum(pair, t);
      if (mom === null || mom >= 0) continue;
      const bm = pairBarMap.get(pair);
      const bar = bm?.get(t);
      if (!bar) continue;
      positions.set(pair + "_S", { pair, dir: "short", ep: bar.o, et: t });
      shortCount++;
    }

    // Longs: lowest/negative funding + positive momentum
    let longCount = 0;
    for (let idx = rankings.length - 1; idx >= 0; idx--) {
      if (longCount >= topN) break;
      const { pair, avgFunding } = rankings[idx];
      if (avgFunding >= 0) break;
      const mom = getMomentum(pair, t);
      if (mom === null || mom <= 0) continue;
      const bm = pairBarMap.get(pair);
      const bar = bm?.get(t);
      if (!bar) continue;
      if (positions.has(pair + "_S")) continue;
      positions.set(pair + "_L", { pair, dir: "long", ep: bar.o, et: t });
      longCount++;
    }

    nextRebal = t + REBAL_H * H;
  }

  return trades;
}

// ────────────────────────────────────────────────────────────────────
// METRICS
// ────────────────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
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
  };
}

function fmtPnl(v: number): string { return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }
function fmtRow(label: string, m: Metrics): string {
  return `${label.padEnd(42)} ${String(m.n).padStart(5)}  ${m.wr.toFixed(1).padStart(5)}%  ${fmtPnl(m.total).padStart(12)}  ${m.pf.toFixed(2).padStart(6)}  ${m.sharpe.toFixed(2).padStart(7)}  $${m.dd.toFixed(2).padStart(8)}  ${fmtPnl(m.perDay).padStart(10)}/d`;
}
function printHeader(): void {
  console.log(`${"".padEnd(42)} ${"Trades".padStart(5)}  ${"WR%".padStart(6)}  ${"TotalPnL".padStart(12)}  ${"PF".padStart(6)}  ${"Sharpe".padStart(7)}  ${"MaxDD".padStart(9)}  ${"$/day".padStart(11)}`);
  console.log("-".repeat(110));
}

// ────────────────────────────────────────────────────────────────────
// ENSEMBLE with shared position pool
// ────────────────────────────────────────────────────────────────────
function simulateEnsemble(
  allTrades: Trade[],
  maxPos: number,
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

  for (const evt of events) {
    const key = `${evt.trade.engine}:${evt.trade.pair}`;
    if (evt.type === "exit") {
      open.delete(key);
    } else {
      if (open.has(key)) continue;
      if (open.size >= maxPos) { blocked++; continue; }
      open.set(key, evt.trade);
      accepted.push(evt.trade);
    }
  }
  return { trades: accepted, blocked };
}

// ════════════════════════════════════════════════════════════════════
// MAIN: Run all fine-tuning tests
// ════════════════════════════════════════════════════════════════════

const sep = "=".repeat(110);
const oosStart = OOS_START;
const oosEnd = FULL_END;

// ─── BASELINE ──────────────────────────────────────────────────────
console.log(sep);
console.log("BASELINE (current configuration)");
console.log(sep);
printHeader();

const baseA = engineA(oosStart, oosEnd, ENGINE_A_BASELINE);
const baseB = engineB(oosStart, oosEnd, ENGINE_B_BASELINE);
const baseC = engineC(oosStart, oosEnd, ENGINE_C_BASELINE);
const baseD = engineD(oosStart, oosEnd, ENGINE_D_BASELINE);

const mBaseA = calcMetrics(baseA, oosStart, oosEnd);
const mBaseB = calcMetrics(baseB, oosStart, oosEnd);
const mBaseC = calcMetrics(baseC, oosStart, oosEnd);
const mBaseD = calcMetrics(baseD, oosStart, oosEnd);

console.log(fmtRow("A: Donchian (baseline)", mBaseA));
console.log(fmtRow("B: Supertrend (baseline)", mBaseB));
console.log(fmtRow("C: GARCH v2 MTF (baseline)", mBaseC));
console.log(fmtRow("D: Carry Momentum (baseline)", mBaseD));

const baseAll = [...baseA, ...baseB, ...baseC, ...baseD];
const baseEns = simulateEnsemble(baseAll, 10);
const mBaseEns = calcMetrics(baseEns.trades, oosStart, oosEnd);
console.log(fmtRow("ENSEMBLE (baseline, max 10 pos)", mBaseEns));
console.log(`  Blocked signals: ${baseEns.blocked}`);

// ─── ENGINE A FINE-TUNING ──────────────────────────────────────────
console.log("\n" + sep);
console.log("ENGINE A FINE-TUNING: Donchian");
console.log(sep);
printHeader();

const aTests: { label: string; opts: EngineAOpts }[] = [
  { label: "A1: Pullback entry (EMA 9)", opts: { ...ENGINE_A_BASELINE, pullbackEntry: true, pullbackEmaPeriod: 9 } },
  { label: "A2: Tighter exit channel (10d)", opts: { ...ENGINE_A_BASELINE, exitLb: 10 } },
  { label: "A3: Signal-flip exit", opts: { ...ENGINE_A_BASELINE, signalFlipExit: true } },
  { label: "A4: Pullback + signal-flip", opts: { ...ENGINE_A_BASELINE, pullbackEntry: true, pullbackEmaPeriod: 9, signalFlipExit: true } },
  { label: "A5: Pullback + exit 10d", opts: { ...ENGINE_A_BASELINE, pullbackEntry: true, pullbackEmaPeriod: 9, exitLb: 10 } },
  { label: "A6: Signal-flip + exit 10d", opts: { ...ENGINE_A_BASELINE, signalFlipExit: true, exitLb: 10 } },
  { label: "A7: All 3 combined", opts: { ...ENGINE_A_BASELINE, pullbackEntry: true, pullbackEmaPeriod: 9, signalFlipExit: true, exitLb: 10 } },
  { label: "A8: SMA 20/50 (faster)", opts: { ...ENGINE_A_BASELINE, smaFast: 20, smaSlow: 50 } },
  { label: "A9: SMA 20/50 + signal-flip", opts: { ...ENGINE_A_BASELINE, smaFast: 20, smaSlow: 50, signalFlipExit: true } },
  { label: "A10: Max hold 30d", opts: { ...ENGINE_A_BASELINE, maxHold: 30 } },
];

const aResults: { label: string; m: Metrics; trades: Trade[] }[] = [];
for (const test of aTests) {
  const trades = engineA(oosStart, oosEnd, test.opts);
  const m = calcMetrics(trades, oosStart, oosEnd);
  console.log(fmtRow(test.label, m));
  aResults.push({ label: test.label, m, trades });
}

// ─── ENGINE B FINE-TUNING ──────────────────────────────────────────
console.log("\n" + sep);
console.log("ENGINE B FINE-TUNING: Supertrend");
console.log(sep);
printHeader();

const bTests: { label: string; opts: EngineBOpts }[] = [
  { label: "B1: Tighter ATR mult 1.5", opts: { ...ENGINE_B_BASELINE, stMult: 1.5 } },
  { label: "B2: ADX > 20 filter", opts: { ...ENGINE_B_BASELINE, adxFilter: true, adxMin: 20 } },
  { label: "B3: $3 size", opts: { ...ENGINE_B_BASELINE, sz: 3 } },
  { label: "B4: Max hold 30d", opts: { ...ENGINE_B_BASELINE, maxHoldDays: 30 } },
  { label: "B5: ATR 1.5 + ADX > 20", opts: { ...ENGINE_B_BASELINE, stMult: 1.5, adxFilter: true, adxMin: 20 } },
  { label: "B6: ATR 1.5 + $3 + hold 30d", opts: { ...ENGINE_B_BASELINE, stMult: 1.5, sz: 3, maxHoldDays: 30 } },
  { label: "B7: ADX + $3 + hold 30d", opts: { ...ENGINE_B_BASELINE, adxFilter: true, adxMin: 20, sz: 3, maxHoldDays: 30 } },
  { label: "B8: All combined", opts: { ...ENGINE_B_BASELINE, stMult: 1.5, adxFilter: true, adxMin: 20, sz: 3, maxHoldDays: 30 } },
  { label: "B9: ATR 1.75", opts: { ...ENGINE_B_BASELINE, stMult: 1.75 } },
  { label: "B10: ADX > 25 filter", opts: { ...ENGINE_B_BASELINE, adxFilter: true, adxMin: 25 } },
  { label: "B11: ST period 10", opts: { ...ENGINE_B_BASELINE, stPer: 10 } },
  { label: "B12: ATR 1.5 + ADX 25 + hold 30", opts: { ...ENGINE_B_BASELINE, stMult: 1.5, adxFilter: true, adxMin: 25, maxHoldDays: 30 } },
];

const bResults: { label: string; m: Metrics; trades: Trade[] }[] = [];
for (const test of bTests) {
  const trades = engineB(oosStart, oosEnd, test.opts);
  const m = calcMetrics(trades, oosStart, oosEnd);
  console.log(fmtRow(test.label, m));
  bResults.push({ label: test.label, m, trades });
}

// ─── ENGINE C FINE-TUNING ──────────────────────────────────────────
console.log("\n" + sep);
console.log("ENGINE C FINE-TUNING: GARCH v2 MTF");
console.log(sep);
printHeader();

const cTests: { label: string; opts: EngineCOpts }[] = [
  { label: "C1: Stricter z (5.0/3.5)", opts: { ...ENGINE_C_BASELINE, zLong1H: 5.0, zLong4H: 3.5, zShort1H: -3.5, zShort4H: -3.5 } },
  { label: "C2: RSI filter (30/70)", opts: { ...ENGINE_C_BASELINE, rsiFilter: true } },
  { label: "C3: TP 10%", opts: { ...ENGINE_C_BASELINE, tpPct: 0.10 } },
  { label: "C4: SL 3%", opts: { ...ENGINE_C_BASELINE, slPct: 0.03 } },
  { label: "C5: Stricter z + RSI", opts: { ...ENGINE_C_BASELINE, zLong1H: 5.0, zLong4H: 3.5, zShort1H: -3.5, zShort4H: -3.5, rsiFilter: true } },
  { label: "C6: Stricter z + TP 10%", opts: { ...ENGINE_C_BASELINE, zLong1H: 5.0, zLong4H: 3.5, zShort1H: -3.5, zShort4H: -3.5, tpPct: 0.10 } },
  { label: "C7: SL 3% + TP 10%", opts: { ...ENGINE_C_BASELINE, slPct: 0.03, tpPct: 0.10 } },
  { label: "C8: All combined", opts: { ...ENGINE_C_BASELINE, zLong1H: 5.0, zLong4H: 3.5, zShort1H: -3.5, zShort4H: -3.5, rsiFilter: true, slPct: 0.03, tpPct: 0.10 } },
  { label: "C9: SL 2.5% (very tight)", opts: { ...ENGINE_C_BASELINE, slPct: 0.025 } },
  { label: "C10: TP 7%", opts: { ...ENGINE_C_BASELINE, tpPct: 0.07 } },
  { label: "C11: Max hold 96h", opts: { ...ENGINE_C_BASELINE, maxHoldHours: 96 } },
  { label: "C12: SL 3% + TP 7% + hold 96h", opts: { ...ENGINE_C_BASELINE, slPct: 0.03, tpPct: 0.07, maxHoldHours: 96 } },
];

const cResults: { label: string; m: Metrics; trades: Trade[] }[] = [];
for (const test of cTests) {
  const trades = engineC(oosStart, oosEnd, test.opts);
  const m = calcMetrics(trades, oosStart, oosEnd);
  console.log(fmtRow(test.label, m));
  cResults.push({ label: test.label, m, trades });
}

// ─── ENGINE D FINE-TUNING ──────────────────────────────────────────
console.log("\n" + sep);
console.log("ENGINE D FINE-TUNING: Carry Momentum");
console.log(sep);
printHeader();

const dTests: { label: string; opts: EngineDOpts }[] = [
  { label: "D1: 5-day lookback", opts: { ...ENGINE_D_BASELINE, lookbackDays: 5 } },
  { label: "D2: Top 2 (more selective)", opts: { ...ENGINE_D_BASELINE, topN: 2 } },
  { label: "D3: 5d lookback + top 2", opts: { ...ENGINE_D_BASELINE, lookbackDays: 5, topN: 2 } },
  { label: "D4: 3-day lookback", opts: { ...ENGINE_D_BASELINE, lookbackDays: 3 } },
  { label: "D5: 14-day lookback", opts: { ...ENGINE_D_BASELINE, lookbackDays: 14 } },
  { label: "D6: Top 4 (wider)", opts: { ...ENGINE_D_BASELINE, topN: 4 } },
  { label: "D7: 5d + top 4", opts: { ...ENGINE_D_BASELINE, lookbackDays: 5, topN: 4 } },
];

const dResults: { label: string; m: Metrics; trades: Trade[] }[] = [];
for (const test of dTests) {
  const trades = engineD(oosStart, oosEnd, test.opts);
  const m = calcMetrics(trades, oosStart, oosEnd);
  console.log(fmtRow(test.label, m));
  dResults.push({ label: test.label, m, trades });
}

// ─── FIND BEST PER ENGINE ──────────────────────────────────────────
function balancedScore(m: Metrics): number {
  if (m.dd === 0 || m.n === 0) return 0;
  return (m.wr / 100) * m.perDay / Math.max(m.dd, 0.01);
}

function findBest(results: { label: string; m: Metrics; trades: Trade[] }[], baseM: Metrics): { label: string; m: Metrics; trades: Trade[] } {
  // Pick best by: higher balanced score than baseline, or at least better on 2 of 3 targets
  let best = results[0];
  let bestScore = balancedScore(results[0].m);
  for (const r of results) {
    const score = balancedScore(r.m);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

const bestA = findBest(aResults, mBaseA);
const bestB = findBest(bResults, mBaseB);
const bestC = findBest(cResults, mBaseC);
const bestD = findBest(dResults, mBaseD);

console.log("\n" + sep);
console.log("BEST PER ENGINE (by balanced score = WR * $/day / MaxDD)");
console.log(sep);
printHeader();
console.log(fmtRow(`A BEST: ${bestA.label}`, bestA.m));
console.log(fmtRow(`B BEST: ${bestB.label}`, bestB.m));
console.log(fmtRow(`C BEST: ${bestC.label}`, bestC.m));
console.log(fmtRow(`D BEST: ${bestD.label}`, bestD.m));

// ─── COMBINED OPTIMIZATIONS ────────────────────────────────────────
console.log("\n" + sep);
console.log("COMBINED OPTIMIZATIONS: Position caps + sizing");
console.log(sep);
printHeader();

// Build tuned trades from each best engine
const tunedA = bestA.trades;
const tunedB = bestB.trades;
const tunedC = bestC.trades;
const tunedD = bestD.trades;
const tunedAll = [...tunedA, ...tunedB, ...tunedC, ...tunedD];

// Test max positions
for (const maxP of [8, 10, 12, 15, 20]) {
  const ens = simulateEnsemble(tunedAll, maxP);
  const m = calcMetrics(ens.trades, oosStart, oosEnd);
  console.log(fmtRow(`Tuned engines, max ${maxP} pos`, m) + `  blocked=${ens.blocked}`);
}

// Asymmetric sizing: $3 Supertrend + $5 others
console.log("\n--- Asymmetric sizing tests ---");
printHeader();

// Find the best B config but at $3
const bestBConfig = bTests.find(t => t.label === bestB.label)?.opts ?? ENGINE_B_BASELINE;
const asymB3 = engineB(oosStart, oosEnd, { ...bestBConfig, sz: 3 });
const asymAll3 = [...tunedA, ...asymB3, ...tunedC, ...tunedD];
for (const maxP of [10, 12, 15]) {
  const ens = simulateEnsemble(asymAll3, maxP);
  const m = calcMetrics(ens.trades, oosStart, oosEnd);
  console.log(fmtRow(`$5/$3B/$5/$5 max ${maxP}`, m) + `  blocked=${ens.blocked}`);
}

// ADX-based global gate: half size when ADX < 20
console.log("\n--- ADX global gate tests ---");
printHeader();

// Compute BTC ADX on daily for global market condition
const btcDailyADX = calcADX(btcDaily, 14);
function btcADXAbove(t: number, threshold: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t <= t) { idx = i; break; }
  }
  if (idx < 0 || idx >= btcDailyADX.length) return false;
  return btcDailyADX[idx] >= threshold;
}

// Scale trades: half PnL when ADX < 20
function applyADXGate(trades: Trade[], threshold: number): Trade[] {
  return trades.map(t => {
    const strong = btcADXAbove(t.et, threshold);
    return strong ? t : { ...t, pnl: t.pnl * 0.5 };
  });
}

const adxGated = applyADXGate(tunedAll, 20);
for (const maxP of [10, 12, 15]) {
  const ens = simulateEnsemble(adxGated, maxP);
  const m = calcMetrics(ens.trades, oosStart, oosEnd);
  console.log(fmtRow(`ADX gate (half<20) max ${maxP}`, m) + `  blocked=${ens.blocked}`);
}

// ─── FINAL: Find absolute best combined config ─────────────────────
console.log("\n" + sep);
console.log("FINAL: BEST COMBINED CONFIGURATION");
console.log(sep);

// Collect all combined test results
interface CombinedResult {
  label: string;
  m: Metrics;
  aConfig: string;
  bConfig: string;
  cConfig: string;
  dConfig: string;
  maxPos: number;
  sizing: string;
}

const combinedResults: CombinedResult[] = [];

// Permutations of best engines with different caps and sizing
for (const maxP of [8, 10, 12, 15, 20]) {
  // Standard sizing
  {
    const ens = simulateEnsemble(tunedAll, maxP);
    const m = calcMetrics(ens.trades, oosStart, oosEnd);
    combinedResults.push({
      label: `Tuned $5 all, max ${maxP}`,
      m, aConfig: bestA.label, bConfig: bestB.label,
      cConfig: bestC.label, dConfig: bestD.label,
      maxPos: maxP, sizing: "$5 all",
    });
  }
  // Asymmetric $3 B
  {
    const ens = simulateEnsemble(asymAll3, maxP);
    const m = calcMetrics(ens.trades, oosStart, oosEnd);
    combinedResults.push({
      label: `Tuned $3B, max ${maxP}`,
      m, aConfig: bestA.label, bConfig: bestB.label + " @$3",
      cConfig: bestC.label, dConfig: bestD.label,
      maxPos: maxP, sizing: "$5/$3B/$5/$5",
    });
  }
  // ADX gated
  {
    const ens = simulateEnsemble(adxGated, maxP);
    const m = calcMetrics(ens.trades, oosStart, oosEnd);
    combinedResults.push({
      label: `Tuned ADX gate, max ${maxP}`,
      m, aConfig: bestA.label, bConfig: bestB.label,
      cConfig: bestC.label, dConfig: bestD.label,
      maxPos: maxP, sizing: "$5 ADX-gated",
    });
  }
}

// Also test baseline ensemble at different caps for comparison
for (const maxP of [10, 12, 15]) {
  const ens = simulateEnsemble(baseAll, maxP);
  const m = calcMetrics(ens.trades, oosStart, oosEnd);
  combinedResults.push({
    label: `BASELINE max ${maxP}`,
    m, aConfig: "baseline", bConfig: "baseline",
    cConfig: "baseline", dConfig: "baseline",
    maxPos: maxP, sizing: "$5 all",
  });
}

// Sort by balanced score
combinedResults.sort((a, b) => balancedScore(b.m) - balancedScore(a.m));

printHeader();
for (const r of combinedResults.slice(0, 15)) {
  const score = balancedScore(r.m);
  console.log(fmtRow(r.label, r.m) + `  score=${score.toFixed(6)}`);
}

// Winner
const winner = combinedResults[0];
console.log("\n" + sep);
console.log("BEST CONFIG");
console.log(sep);
console.log(`\nWinner: ${winner.label}`);
console.log(`  Balanced Score (WR * $/day / MaxDD): ${balancedScore(winner.m).toFixed(6)}`);
console.log(`  Trades: ${winner.m.n}`);
console.log(`  Win Rate: ${winner.m.wr.toFixed(1)}%`);
console.log(`  Profit Factor: ${winner.m.pf.toFixed(2)}`);
console.log(`  Sharpe: ${winner.m.sharpe.toFixed(2)}`);
console.log(`  MaxDD: $${winner.m.dd.toFixed(2)}`);
console.log(`  Total PnL: ${fmtPnl(winner.m.total)}`);
console.log(`  $/day: ${fmtPnl(winner.m.perDay)}`);
console.log(`  Max Positions: ${winner.maxPos}`);
console.log(`  Sizing: ${winner.sizing}`);
console.log(`\n  Engine A: ${winner.aConfig}`);
console.log(`  Engine B: ${winner.bConfig}`);
console.log(`  Engine C: ${winner.cConfig}`);
console.log(`  Engine D: ${winner.dConfig}`);

// Compare vs baseline
console.log(`\n--- vs BASELINE (max 10) ---`);
console.log(`  WR:    ${mBaseEns.wr.toFixed(1)}% -> ${winner.m.wr.toFixed(1)}% (${winner.m.wr > mBaseEns.wr ? "+" : ""}${(winner.m.wr - mBaseEns.wr).toFixed(1)}pp)`);
console.log(`  MaxDD: $${mBaseEns.dd.toFixed(2)} -> $${winner.m.dd.toFixed(2)} (${winner.m.dd < mBaseEns.dd ? "IMPROVED" : "worse"})`);
console.log(`  $/day: ${fmtPnl(mBaseEns.perDay)} -> ${fmtPnl(winner.m.perDay)} (${winner.m.perDay > mBaseEns.perDay ? "IMPROVED" : "worse"})`);
console.log(`  PF:    ${mBaseEns.pf.toFixed(2)} -> ${winner.m.pf.toFixed(2)}`);
console.log(`  Sharpe:${mBaseEns.sharpe.toFixed(2)} -> ${winner.m.sharpe.toFixed(2)}`);
