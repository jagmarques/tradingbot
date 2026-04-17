/**
 * GARCH combo test: moderate thresholds + max 15 positions.
 * 2-engine: GARCH ($15) + ST ($5), trail 20/3 + re-entry, BTC 4h EMA(12/21), 23 pairs.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-combo-test.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MIN_1 = 60_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

const SIZE_GARCH = 15;
const SIZE_ST    = 5;

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX",
  "NEAR","SUI","FET",
];

function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  const out: C[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (Array.isArray(b)) {
      out[i] = { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
    } else {
      out[i] = { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c };
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function aggregate(bars: C[], periodMs: number, minBars: number): C[] {
  interface Bucket { t: number; o: number; h: number; l: number; c: number; count: number; }
  const buckets = new Map<number, Bucket>();
  for (const b of bars) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, count: 1 });
    } else {
      if (b.h > existing.h) existing.h = b.h;
      if (b.l < existing.l) existing.l = b.l;
      existing.c = b.c;
      existing.count++;
    }
  }
  const result: C[] = [];
  for (const bk of buckets.values()) {
    if (bk.count < minBars) continue;
    result.push({ t: bk.t, o: bk.o, h: bk.h, l: bk.l, c: bk.c });
  }
  return result.sort((a, b) => a.t - b.t);
}

function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += trs[j];
    atr[i] = s / period;
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
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period;
      init = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcSupertrend(cs: C[], p: number, m: number): { dir: number[] } {
  const atr = calcATR(cs, p);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  for (let i = p; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let u = hl2 + m * atr[i];
    let l = hl2 - m * atr[i];
    if (i > p) {
      if (!(l > lb[i - 1] || cs[i - 1].c < lb[i - 1])) l = lb[i - 1];
      if (!(u < ub[i - 1] || cs[i - 1].c > ub[i - 1])) u = ub[i - 1];
    }
    ub[i] = u;
    lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i - 1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return { dir: dirs };
}

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i].c / cs[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j].c / cs[j - 1].c - 1;
      sumSq += r * r;
      count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function applyEntryPx(pair: string, dir: "long" | "short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function applyExitPx(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long" | "short", ep: number, xp: number, notional: number): number {
  return (dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional) - notional * FEE * 2;
}

console.log("Loading data...");

const raw1m = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();

for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) {
    raw1m.set(p, d);
    h1Data.set(p, aggregate(d, H, 50));
    h4Data.set(p, aggregate(d, H4, 200));
    process.stdout.write(`  ${p}: ${d.length} 1m bars\n`);
  } else {
    console.log(`  WARNING: ${p} not in 1m cache`);
  }
}
console.log(`\nLoaded ${raw1m.size} pairs.\n`);

if (!h4Data.has("BTC")) { console.error("ERROR: BTC data not found."); process.exit(1); }

const btcH4 = h4Data.get("BTC")!;
const btcH4Closes = btcH4.map(c => c.c);
const btcH4Ema12 = calcEMA(btcH4Closes, 12);
const btcH4Ema21 = calcEMA(btcH4Closes, 21);

function btcBullish(t: number): boolean {
  let lo = 0, hi = btcH4.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btcH4[mid].t < t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0) return false;
  return btcH4Ema12[idx] > btcH4Ema21[idx];
}

const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9  = calcEMA(btcH1Closes, 9);
const btcH1Ema21h = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));

function btcH1Trend(t: number): "long" | "short" | null {
  const bucket = Math.floor(t / H) * H;
  const idx = btcH1TsMap.get(bucket);
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  if (btcH1Ema9[prev] > btcH1Ema21h[prev]) return "long";
  if (btcH1Ema9[prev] < btcH1Ema21h[prev]) return "short";
  return null;
}

interface PairIndicators {
  h4: C[]; h4StDir: number[]; h4ATR: number[]; h4TsMap: Map<number, number>; h4Z: number[];
  h1: C[]; h1Z: number[]; h1Ema9: number[]; h1Ema21: number[]; h1TsMap: Map<number, number>;
  bars1m: C[];
}

const pairInd = new Map<string, PairIndicators>();

for (const pair of PAIRS) {
  const h4 = h4Data.get(pair) ?? [];
  const { dir: h4StDir } = calcSupertrend(h4, 14, 1.75);
  const h4ATR = calcATR(h4, 14);
  const h4Z = computeZScores(h4, 3, 20);
  const h1 = h1Data.get(pair) ?? [];
  const h1Z = computeZScores(h1, 3, 20);
  const h1Closes = h1.map(c => c.c);
  const h1Ema9 = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));
  pairInd.set(pair, { h4, h4StDir, h4ATR, h4TsMap, h4Z, h1, h1Z, h1Ema9, h1Ema21, h1TsMap, bars1m: raw1m.get(pair) ?? [] });
}

function bsearch1m(bars: C[], t: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t === t) return mid;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

interface SignalResult {
  dir: "long" | "short"; entryPrice: number; sl: number; engine: "GARCH" | "ST"; size: number;
}

interface GarchThresholds {
  longZ1h: number; longZ4h: number; shortZ1h: number; shortZ4h: number;
}

function checkSupertrend(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  if (cs.length < 50) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;
  const i = barIdx;
  const flip = ind.h4StDir[i - 1] !== ind.h4StDir[i - 2];
  if (!flip) return null;
  const dir: "long" | "short" = ind.h4StDir[i - 1] === 1 ? "long" : "short";
  if (dir === "long" && !btcBullish(cs[i].t)) return null;
  const prevATR = ind.h4ATR[i - 1];
  if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = dir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);
  return { dir, entryPrice: ep, sl, engine: "ST", size: SIZE_ST };
}

function checkSupertrendReentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  if (cs.length < 50) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;
  const i = barIdx;
  const stActive = ind.h4StDir[i - 1] === (wantDir === "long" ? 1 : -1);
  if (!stActive) return null;
  if (wantDir === "long" && !btcBullish(cs[i].t)) return null;
  const prevATR = ind.h4ATR[i - 1];
  if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = wantDir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (wantDir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);
  return { dir: wantDir, entryPrice: ep, sl, engine: "ST", size: SIZE_ST };
}

function checkGarchV2(pair: string, t: number, thr: GarchThresholds): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;
  const i = barIdx;
  const prev = i - 1;
  if (prev < 23) return null;
  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong = z1 > thr.longZ1h;
  const goShort = z1 < thr.shortZ1h;
  if (!goLong && !goShort) return null;
  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong && z4 <= thr.longZ4h) return null;
  if (goShort && z4 >= thr.shortZ4h) return null;
  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;
  const btcT = btcH1Trend(h1[prev].t);
  if (goLong && btcT !== "long") return null;
  if (goShort && btcT !== "short") return null;
  const dir: "long" | "short" = goLong ? "long" : "short";
  const ep = h1[i].o;
  let sl = dir === "long" ? ep * (1 - 0.03) : ep * (1 + 0.03);
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);
  return { dir, entryPrice: ep, sl, engine: "GARCH", size: SIZE_GARCH };
}

function checkGarchV2Reentry(pair: string, t: number, wantDir: "long" | "short", thr: GarchThresholds): SignalResult | null {
  const sig = checkGarchV2(pair, t, thr);
  if (!sig || sig.dir !== wantDir) return null;
  return sig;
}

interface Position {
  pair: string; dir: "long" | "short"; engine: "GARCH" | "ST"; size: number;
  entryPrice: number; effectiveEP: number; sl: number; entryTime: number;
  peakPnlPct: number; isReentry: boolean;
}
interface ClosedTrade {
  pair: string; dir: "long" | "short"; engine: "GARCH" | "ST";
  entryTime: number; exitTime: number; pnl: number; reason: string; isReentry: boolean;
}
interface PendingReentry { pair: string; dir: "long" | "short"; engine: "GARCH" | "ST"; checkTime: number; }

function runSim(thr: GarchThresholds, maxPos: number, trailAct: number, trailDist: number): { trades: ClosedTrade[]; reentries: number; blocked: number } {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0;
  let blockedCount = 0;

  function get1mBar(pair: string, t: number): C | null {
    const ind = pairInd.get(pair);
    if (!ind || ind.bars1m.length === 0) return null;
    const idx = bsearch1m(ind.bars1m, t);
    if (idx < 0) return null;
    return ind.bars1m[idx];
  }

  function hasOpenPos(engine: "GARCH" | "ST", pair: string): boolean {
    return openPositions.some(p => p.engine === engine && p.pair === pair);
  }

  function closePos(idx: number, exitTime: number, rawExitPrice: number, reason: string, isSL: boolean): void {
    const pos = openPositions[idx];
    const notional = pos.size * LEV;
    const xp = applyExitPx(pos.pair, pos.dir, rawExitPrice, isSL);
    const pnl = calcPnl(pos.dir, pos.effectiveEP, xp, notional);
    closedTrades.push({ pair: pos.pair, dir: pos.dir, engine: pos.engine, entryTime: pos.entryTime, exitTime, pnl, reason, isReentry: pos.isReentry });
    if (reason === "trail") {
      let checkTime: number;
      if (pos.engine === "ST") checkTime = (Math.floor(exitTime / H4) + 1) * H4;
      else checkTime = (Math.floor(exitTime / H) + 1) * H;
      pendingReentries.push({ pair: pos.pair, dir: pos.dir, engine: pos.engine, checkTime });
    }
    openPositions.splice(idx, 1);
  }

  function tryOpen(sig: SignalResult, pair: string, t: number, isReentry: boolean): boolean {
    if (openPositions.length >= maxPos) { blockedCount++; return false; }
    if (hasOpenPos(sig.engine, pair)) { blockedCount++; return false; }
    const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
    openPositions.push({ pair, dir: sig.dir, engine: sig.engine, size: sig.size, entryPrice: sig.entryPrice, effectiveEP: ep, sl: sig.sl, entryTime: t, peakPnlPct: 0, isReentry });
    if (isReentry) reentryCount++;
    return true;
  }

  function checkSupertrendExit(pair: string, t: number, dir: "long" | "short", entryTime: number): { exit: boolean; price: number; reason: string } | null {
    const ind = pairInd.get(pair)!;
    const cs = ind.h4;
    const h4Bucket = Math.floor(t / H4) * H4;
    const barIdx = ind.h4TsMap.get(h4Bucket);
    if (barIdx === undefined || barIdx < 17) return null;
    const bar = cs[barIdx];
    if ((bar.t - entryTime) / H >= 60 * 24) return { exit: true, price: bar.c, reason: "mh" };
    const flip = ind.h4StDir[barIdx - 1] !== ind.h4StDir[barIdx - 2];
    if (flip) return { exit: true, price: bar.o, reason: "flip" };
    return null;
  }

  let lastPct = -1;

  for (let t = FULL_START; t < FULL_END; t += MIN_1) {
    const pct = Math.floor(((t - FULL_START) / (FULL_END - FULL_START)) * 20) * 5;
    if (pct > lastPct) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }

    // 1) SL / TP / trail
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const bar = get1mBar(pos.pair, t);
      if (!bar) continue;

      if (pos.dir === "long" && bar.l <= pos.sl) { closePos(pi, t, pos.sl, "sl", true); continue; }
      if (pos.dir === "short" && bar.h >= pos.sl) { closePos(pi, t, pos.sl, "sl", true); continue; }

      if (pos.engine === "GARCH") {
        const tp = pos.dir === "long" ? pos.entryPrice * 1.07 : pos.entryPrice * 0.93;
        if (pos.dir === "long" && bar.h >= tp) { closePos(pi, t, tp, "tp", false); continue; }
        if (pos.dir === "short" && bar.l <= tp) { closePos(pi, t, tp, "tp", false); continue; }
      }

      const bestPct = pos.dir === "long"
        ? (bar.h / pos.entryPrice - 1) * LEV * 100
        : (pos.entryPrice / bar.l - 1) * LEV * 100;
      if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

      if (trailAct > 0 && pos.peakPnlPct >= trailAct) {
        const currPct = pos.dir === "long"
          ? (bar.c / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.c - 1) * LEV * 100;
        if (currPct <= pos.peakPnlPct - trailDist) { closePos(pi, t, bar.c, "trail", false); continue; }
      }
    }

    // 2) Bar-boundary exits
    if (t % H4 === 0) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        if (pos.engine === "ST") {
          const ex = checkSupertrendExit(pos.pair, t, pos.dir, pos.entryTime);
          if (ex && ex.exit) closePos(pi, t, ex.price, ex.reason, false);
        }
      }
    }

    if (t % H === 0) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        if (pos.engine !== "GARCH") continue;
        const ind = pairInd.get(pos.pair)!;
        const h1Bucket = Math.floor(t / H) * H;
        const barIdx = ind.h1TsMap.get(h1Bucket);
        if (barIdx === undefined) continue;
        const bar = ind.h1[barIdx];
        if ((bar.t - pos.entryTime) / H >= 96) closePos(pi, t, bar.c, "mh", false);
      }
    }

    // 3) New entries
    if (t % H4 === 0) {
      for (const pair of PAIRS) {
        const sig = checkSupertrend(pair, t);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }

    if (t % H === 0) {
      for (const pair of PAIRS) {
        const sig = checkGarchV2(pair, t, thr);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }

    // 4) Pending re-entries
    if (pendingReentries.length > 0) {
      for (let ri = pendingReentries.length - 1; ri >= 0; ri--) {
        const re = pendingReentries[ri];
        if (t < re.checkTime) continue;
        let isBoundary = false;
        if (re.engine === "ST" && t % H4 === 0) isBoundary = true;
        else if (re.engine === "GARCH" && t % H === 0) isBoundary = true;
        if (!isBoundary) continue;
        pendingReentries.splice(ri, 1);
        let sig: SignalResult | null = null;
        if (re.engine === "ST") sig = checkSupertrendReentry(re.pair, t, re.dir);
        else sig = checkGarchV2Reentry(re.pair, t, re.dir, thr);
        if (sig) tryOpen(sig, re.pair, t, true);
      }
    }
  }

  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const ind = pairInd.get(pos.pair);
    if (!ind || ind.bars1m.length === 0) continue;
    const lastBar = ind.bars1m[ind.bars1m.length - 1];
    closePos(pi, FULL_END, lastBar.c, "eop", false);
  }

  return { trades: closedTrades, reentries: reentryCount, blocked: blockedCount };
}

function computeMetrics(trades: ClosedTrade[], startTs: number, endTs: number) {
  const days = (endTs - startTs) / D;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.exitTime / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const trailExits = trades.filter(t => t.reason === "trail").length;

  return { wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0, pf: gl > 0 ? gp / gl : 99, total, perDay: total / days, maxDD, sharpe, trailExits };
}

interface SimConfig {
  label: string;
  note: string;
  thr: GarchThresholds;
  maxPos: number;
}

const TRAIL_ACT = 20;
const TRAIL_DIST = 3;

const configs: SimConfig[] = [
  {
    label: "1. Baseline",
    note: "thr 4.5/3.0, max 10 (live config)",
    thr: { longZ1h: 4.5, longZ4h: 3.0, shortZ1h: -3.0, shortZ4h: -3.0 },
    maxPos: 10,
  },
  {
    label: "2. Mod thr",
    note: "thr 3.5/2.5, max 10",
    thr: { longZ1h: 3.5, longZ4h: 2.5, shortZ1h: -2.5, shortZ4h: -2.5 },
    maxPos: 10,
  },
  {
    label: "3. Max 15",
    note: "thr 4.5/3.0, max 15",
    thr: { longZ1h: 4.5, longZ4h: 3.0, shortZ1h: -3.0, shortZ4h: -3.0 },
    maxPos: 15,
  },
  {
    label: "4. Both",
    note: "thr 3.5/2.5, max 15",
    thr: { longZ1h: 3.5, longZ4h: 2.5, shortZ1h: -2.5, shortZ4h: -2.5 },
    maxPos: 15,
  },
  {
    label: "5. Aggressive",
    note: "thr 3.0/2.0, max 15",
    thr: { longZ1h: 3.0, longZ4h: 2.0, shortZ1h: -2.0, shortZ4h: -2.0 },
    maxPos: 15,
  },
];

console.log(`Running ${configs.length} configs (trail ${TRAIL_ACT}/${TRAIL_DIST} + re-entry, GARCH $${SIZE_GARCH} + ST $${SIZE_ST}, BTC 4h EMA 12/21, 23 pairs)...\n`);

interface Result {
  label: string; note: string; maxPos: number;
  trades: number; tradesPerDay: number; reentries: number;
  wr: number; pf: number; total: number; perDay: number; maxDD: number; sharpe: number;
  blocked: number; trailExits: number;
  oosTotal: number; oosPerDay: number; oosPf: number; oosWr: number;
  garchTrades: number; garchPerDay: number; garchPf: number;
  stTrades: number; stPerDay: number; stPf: number;
}

const results: Result[] = [];
const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

for (const cfg of configs) {
  process.stdout.write(`${cfg.label}...`);
  const { trades, reentries, blocked } = runSim(cfg.thr, cfg.maxPos, TRAIL_ACT, TRAIL_DIST);
  const m = computeMetrics(trades, FULL_START, FULL_END);

  const oosTrades = trades.filter(t => t.entryTime >= OOS_START);
  const oosM = computeMetrics(oosTrades, OOS_START, FULL_END);

  const garchTrades = trades.filter(t => t.engine === "GARCH");
  const stTrades    = trades.filter(t => t.engine === "ST");
  const garchWins   = garchTrades.filter(t => t.pnl > 0);
  const garchLosses = garchTrades.filter(t => t.pnl <= 0);
  const garchGp = garchWins.reduce((s, t) => s + t.pnl, 0);
  const garchGl = Math.abs(garchLosses.reduce((s, t) => s + t.pnl, 0));
  const garchTotal = garchTrades.reduce((s, t) => s + t.pnl, 0);
  const stWins   = stTrades.filter(t => t.pnl > 0);
  const stLosses = stTrades.filter(t => t.pnl <= 0);
  const stGp = stWins.reduce((s, t) => s + t.pnl, 0);
  const stGl = Math.abs(stLosses.reduce((s, t) => s + t.pnl, 0));
  const stTotal = stTrades.reduce((s, t) => s + t.pnl, 0);

  results.push({
    label: cfg.label, note: cfg.note, maxPos: cfg.maxPos,
    trades: trades.length, tradesPerDay: trades.length / fullDays, reentries,
    wr: m.wr, pf: m.pf, total: m.total, perDay: m.perDay, maxDD: m.maxDD, sharpe: m.sharpe,
    blocked, trailExits: m.trailExits,
    oosTotal: oosM.total, oosPerDay: oosM.perDay, oosPf: oosM.pf, oosWr: oosM.wr,
    garchTrades: garchTrades.length, garchPerDay: garchTotal / fullDays,
    garchPf: garchGl > 0 ? garchGp / garchGl : 99,
    stTrades: stTrades.length, stPerDay: stTotal / fullDays,
    stPf: stGl > 0 ? stGp / stGl : 99,
  });

  console.log(` done: ${trades.length} trades, $${m.perDay.toFixed(2)}/day, DD $${m.maxDD.toFixed(0)}, OOS $${oosM.perDay.toFixed(2)}/day`);
}

const W = 175;
console.log("\n" + "=".repeat(W));
console.log("GARCH COMBO TEST  |  GARCH $15 + ST $5  |  Trail 20/3 + re-entry  |  BTC 4h EMA(12/21)  |  23 pairs  |  2023-01 to 2026-03");
console.log("OOS: 2025-09 to 2026-03");
console.log("=".repeat(W));

const hdr = [
  "Config".padEnd(15),
  "MaxP".padStart(5),
  "Trades".padStart(7),
  "T/day".padStart(6),
  "Re-ent".padStart(7),
  "WR%".padStart(6),
  "PF".padStart(6),
  "Sharpe".padStart(7),
  "$/day".padStart(8),
  "Total$".padStart(8),
  "MaxDD".padStart(8),
  "Trails".padStart(7),
  "Blkd".padStart(6),
  "OOS$/d".padStart(8),
  "OOS WR".padStart(7),
  "OOS PF".padStart(7),
  "GRCH T".padStart(7),
  "GRCH$/d".padStart(8),
  "GRCHPF".padStart(7),
  "ST T".padStart(6),
  "ST$/d".padStart(7),
  "ST PF".padStart(7),
].join(" ");
console.log(`\n${hdr}`);
console.log("-".repeat(W));

for (const r of results) {
  console.log([
    r.label.padEnd(15),
    String(r.maxPos).padStart(5),
    String(r.trades).padStart(7),
    r.tradesPerDay.toFixed(2).padStart(6),
    String(r.reentries).padStart(7),
    (r.wr.toFixed(1) + "%").padStart(6),
    r.pf.toFixed(2).padStart(6),
    r.sharpe.toFixed(2).padStart(7),
    ("$" + r.perDay.toFixed(2)).padStart(8),
    ("$" + r.total.toFixed(0)).padStart(8),
    ("$" + r.maxDD.toFixed(0)).padStart(8),
    String(r.trailExits).padStart(7),
    String(r.blocked).padStart(6),
    ("$" + r.oosPerDay.toFixed(2)).padStart(8),
    (r.oosWr.toFixed(1) + "%").padStart(7),
    r.oosPf.toFixed(2).padStart(7),
    String(r.garchTrades).padStart(7),
    ("$" + r.garchPerDay.toFixed(2)).padStart(8),
    r.garchPf.toFixed(2).padStart(7),
    String(r.stTrades).padStart(6),
    ("$" + r.stPerDay.toFixed(2)).padStart(7),
    r.stPf.toFixed(2).padStart(7),
  ].join(" "));
}

console.log("\n" + "=".repeat(W));

console.log("\nConfig notes:");
for (const r of results) console.log(`  ${r.label.padEnd(15)} ${r.note}`);

const bestOos = [...results].sort((a, b) => b.oosPerDay - a.oosPerDay)[0];
const bestPf  = [...results].sort((a, b) => b.pf - a.pf)[0];
const bestDD  = [...results].sort((a, b) => a.maxDD - b.maxDD)[0];
console.log("\nTop picks:");
console.log(`  Best OOS $/day: ${bestOos.label} ($${bestOos.oosPerDay.toFixed(2)}/day, PF ${bestOos.oosPf.toFixed(2)}, WR ${bestOos.oosWr.toFixed(1)}%)`);
console.log(`  Best full PF:   ${bestPf.label} (PF ${bestPf.pf.toFixed(2)}, $${bestPf.perDay.toFixed(2)}/day)`);
console.log(`  Lowest MaxDD:   ${bestDD.label} ($${bestDD.maxDD.toFixed(0)} DD, $${bestDD.perDay.toFixed(2)}/day)`);

console.log("\nDone.");
