/**
 * BTC-Confirmed Exit Research (v2 - Direction-aware)
 *
 * Tests whether BTC+alt confirmed exit rules predict continued adverse moves
 * with >60% accuracy. Direction-aware: BTC drops exit longs, BTC pumps exit shorts.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-btc-confirmed-exit.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const H12 = 12 * H1;
const H24 = 24 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP",
];

const START = new Date("2023-06-01").getTime();
const END = new Date("2026-03-23").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string;
  engine: string;
  dir: Dir;
  ep: number;
  et: number;
  sl: number;
  margin: number;
  lev: number;
  maxHold: number;
  atr: number;
  bestPnlAtr: number;
}

interface ExitEvent {
  pair: string;
  engine: string;
  dir: Dir;
  rule: string;
  exitTime: number;
  exitPrice: number;
  leveragedPnlAtExit: number;
  priceAfter4h: number;
  priceAfter12h: number;
  priceAfter24h: number;
  correct4h: boolean;   // price moved against position (exit saved money)
  correct12h: boolean;
  correct24h: boolean;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(candles: C[], period: number): Bar[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const bars: Bar[] = [];
  for (const [t, cs] of groups) {
    if (cs.length === 0) continue;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of cs) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
      vol += c.v;
    }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c, v: vol });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators (SMA-seeded) ────────────────────────────────────────
function sma(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) r[i] = sum / period;
  }
  return r;
}

function ema(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  let seeded = false;
  let v = 0;
  for (let i = 0; i < vals.length; i++) {
    if (!seeded) {
      if (i < period - 1) continue;
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += vals[j];
      v = s / period;
      r[i] = v;
      seeded = true;
    } else {
      v = vals[i] * k + v * (1 - k);
      r[i] = v;
    }
  }
  return r;
}

function atr(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c),
        );
    trs.push(tr);
  }
  let val = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      val += trs[i];
      if (i === period - 1) { val /= period; r[i] = val; }
    } else {
      val = (val * (period - 1) + trs[i]) / period;
      r[i] = val;
    }
  }
  return r;
}

function donchianHigh(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mx = -Infinity;
    for (let j = i - period; j < i; j++) mx = Math.max(mx, closes[j]);
    r[i] = mx;
  }
  return r;
}

function donchianLow(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mn = Infinity;
    for (let j = i - period; j < i; j++) mn = Math.min(mn, closes[j]);
    r[i] = mn;
  }
  return r;
}

function supertrend(bars: Bar[], atrPeriod: number, mult: number): { trend: (1 | -1 | null)[] } {
  const atrVals = atr(bars, atrPeriod);
  const trend: (1 | -1 | null)[] = new Array(bars.length).fill(null);
  let upperBand = 0, lowerBand = 0, prevTrend = 1;

  for (let i = 0; i < bars.length; i++) {
    const a = atrVals[i];
    if (a === null) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let ub = hl2 + mult * a;
    let lb = hl2 - mult * a;

    if (i > 0 && atrVals[i - 1] !== null) {
      if (lb > lowerBand || bars[i - 1].c < lowerBand) { /* keep lb */ } else lb = lowerBand;
      if (ub < upperBand || bars[i - 1].c > upperBand) { /* keep ub */ } else ub = upperBand;
    }

    let t: 1 | -1;
    if (prevTrend === 1) {
      t = bars[i].c < lowerBand ? -1 : 1;
    } else {
      t = bars[i].c > upperBand ? 1 : -1;
    }

    upperBand = ub;
    lowerBand = lb;
    prevTrend = t;
    trend[i] = t;
  }
  return { trend };
}

// ─── Helpers ────────────────────────────────────────────────────────
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

function getBarAtOrBefore(bars: Bar[], t: number, barMap: Map<number, number>, period: number): number {
  const aligned = Math.floor(t / period) * period;
  const idx = barMap.get(aligned);
  if (idx !== undefined) return idx;
  for (let dt = period; dt <= 10 * period; dt += period) {
    const idx2 = barMap.get(aligned - dt);
    if (idx2 !== undefined) return idx2;
  }
  return -1;
}

function findCandleIdx(candles: C[], target: number): number {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].t < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function priceAt(m5: C[], t: number): number | null {
  const idx = findCandleIdx(m5, t);
  if (idx < m5.length && m5[idx].t === t) return m5[idx].c;
  if (idx > 0) return m5[idx - 1].c;
  return null;
}

function rolling5mHigh(m5: C[], endIdx: number, lookbackMs: number): number {
  const startT = m5[endIdx].t - lookbackMs;
  let hi = -Infinity;
  for (let i = endIdx; i >= 0 && m5[i].t >= startT; i--) {
    if (m5[i].h > hi) hi = m5[i].h;
  }
  return hi;
}

function rolling5mLow(m5: C[], endIdx: number, lookbackMs: number): number {
  const startT = m5[endIdx].t - lookbackMs;
  let lo = Infinity;
  for (let i = endIdx; i >= 0 && m5[i].t >= startT; i--) {
    if (m5[i].l < lo) lo = m5[i].l;
  }
  return lo;
}

// ─── BTC Data Prep ──────────────────────────────────────────────────
interface BTCPrep {
  m5: C[];
  h4: Bar[];
  daily: Bar[];
  dailyEma20: (number | null)[];
  dailyEma50: (number | null)[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
  h4St: (1 | -1 | null)[];  // Supertrend(10, 1.5) on 4h
  m5Map: Map<number, number>;
}

function prepBTC(m5: C[]): BTCPrep {
  const daily = aggregate(m5, DAY);
  const h4 = aggregate(m5, H4);
  const dc = daily.map(b => b.c);
  return {
    m5, h4, daily,
    dailyEma20: ema(dc, 20),
    dailyEma50: ema(dc, 50),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
    h4St: supertrend(h4, 10, 1.5).trend,
    m5Map: new Map(m5.map((b, i) => [b.t, i])),
  };
}

// ─── Alt Data Prep ──────────────────────────────────────────────────
interface AltPrep {
  m5: C[];
  h1: Bar[];
  h4: Bar[];
  daily: Bar[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
  m5Map: Map<number, number>;
  dailySma30: (number | null)[];
  dailySma60: (number | null)[];
  donLo15: (number | null)[];
  donHi15: (number | null)[];
  dailyAtr14: (number | null)[];
  h4St: (1 | -1 | null)[];
  h4Atr14: (number | null)[];
  h1Ema9: (number | null)[];
  h1Ema21: (number | null)[];
  h4Ema9: (number | null)[];
}

function prepAlt(m5: C[]): AltPrep {
  const h1 = aggregate(m5, H1);
  const h4 = aggregate(m5, H4);
  const daily = aggregate(m5, DAY);
  const dc = daily.map(b => b.c);
  const h1c = h1.map(b => b.c);
  const h4c = h4.map(b => b.c);
  return {
    m5, h1, h4, daily,
    h1Map: new Map(h1.map((b, i) => [b.t, i])),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
    m5Map: new Map(m5.map((b, i) => [b.t, i])),
    dailySma30: sma(dc, 30),
    dailySma60: sma(dc, 60),
    donLo15: donchianLow(dc, 15),
    donHi15: donchianHigh(dc, 15),
    dailyAtr14: atr(daily, 14),
    h4St: supertrend(h4, 14, 2).trend,
    h4Atr14: atr(h4, 14),
    h1Ema9: ema(h1c, 9),
    h1Ema21: ema(h1c, 21),
    h4Ema9: ema(h4c, 9),
  };
}

function btcBullish(btc: BTCPrep, t: number): boolean {
  const di = getBarAtOrBefore(btc.daily, t - DAY, btc.dailyMap, DAY);
  if (di < 0) return false;
  const e20 = btc.dailyEma20[di], e50 = btc.dailyEma50[di];
  return e20 !== null && e50 !== null && e20 > e50;
}

// ─── Generate trades ────────────────────────────────────────────────
interface LivePosition extends Position {
  m5StartIdx: number;
}

function generateTrades(btc: BTCPrep, altData: Map<string, AltPrep>): LivePosition[] {
  const all: LivePosition[] = [];

  for (const [pair, alt] of altData) {
    // Engine A: Daily Donchian Trend (SMA 30/60 cross)
    for (let di = 61; di < alt.daily.length; di++) {
      const dayT = alt.daily[di].t;
      if (dayT < START || dayT >= END) continue;

      const s30now = alt.dailySma30[di - 1], s60now = alt.dailySma60[di - 1];
      const s30prev = alt.dailySma30[di - 2], s60prev = alt.dailySma60[di - 2];
      if (s30now === null || s60now === null || s30prev === null || s60prev === null) continue;

      let dir: Dir | null = null;
      if (s30prev <= s60prev && s30now > s60now && btcBullish(btc, dayT)) dir = "long";
      if (s30prev >= s60prev && s30now < s60now) dir = "short";
      if (!dir) continue;

      const atrVal = alt.dailyAtr14[di - 1];
      if (atrVal === null) continue;

      const halfSp = sp(pair);
      const ep = dir === "long" ? alt.daily[di].o * (1 + halfSp) : alt.daily[di].o * (1 - halfSp);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      all.push({
        pair, engine: "A", dir, ep, et: dayT, sl,
        margin: 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
        m5StartIdx: findCandleIdx(alt.m5, dayT),
      });
    }

    // Engine B: 4h Supertrend (14, 2)
    for (let h4i = 21; h4i < alt.h4.length - 1; h4i++) {
      const h4T = alt.h4[h4i].t;
      if (h4T < START || h4T >= END) continue;

      const stNow = alt.h4St[h4i - 1], stPrev = alt.h4St[h4i - 2];
      if (stNow === null || stPrev === null || stNow === stPrev) continue;

      const dir: Dir = stNow === 1 ? "long" : "short";
      if (dir === "long" && !btcBullish(btc, h4T)) continue;

      const atrVal = alt.h4Atr14[h4i - 1];
      if (atrVal === null) continue;

      const nextBar = alt.h4[h4i + 1];
      if (!nextBar) continue;
      const halfSp = sp(pair);
      const ep = dir === "long" ? nextBar.o * (1 + halfSp) : nextBar.o * (1 - halfSp);
      if (!isFinite(ep)) continue;

      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      all.push({
        pair, engine: "B", dir, ep, et: nextBar.t, sl,
        margin: 5, lev: 10, maxHold: 60 * DAY, atr: atrVal, bestPnlAtr: 0,
        m5StartIdx: findCandleIdx(alt.m5, nextBar.t),
      });
    }
  }

  return all;
}

// ─── Direction-aware exit rule checkers ──────────────────────────────
// For LONGS: detect BTC+alt weakness (dropping)
// For SHORTS: detect BTC+alt strength (rising)
// Each returns true only when the signal is ADVERSE to the position direction

// Rule 2: BTC >2% from 24h extreme AND alt >1% from 4h extreme (direction-aware)
function checkRule2(
  btcM5: C[], btcIdx: number,
  altM5: C[], altIdx: number,
  dir: Dir,
): boolean {
  if (btcIdx < 288 || altIdx < 48) return false;
  if (dir === "long") {
    // BTC dropped from 24h high
    const btc24hHigh = rolling5mHigh(btcM5, btcIdx - 1, H24);
    const btcDrop = (btc24hHigh - btcM5[btcIdx].c) / btc24hHigh;
    // Alt dropped from 4h high
    const alt4hHigh = rolling5mHigh(altM5, altIdx - 1, H4);
    const altDrop = (alt4hHigh - altM5[altIdx].c) / alt4hHigh;
    return btcDrop > 0.02 && altDrop > 0.01;
  } else {
    // BTC pumped from 24h low
    const btc24hLow = rolling5mLow(btcM5, btcIdx - 1, H24);
    const btcPump = (btcM5[btcIdx].c - btc24hLow) / btc24hLow;
    // Alt pumped from 4h low
    const alt4hLow = rolling5mLow(altM5, altIdx - 1, H4);
    const altPump = (altM5[altIdx].c - alt4hLow) / alt4hLow;
    return btcPump > 0.02 && altPump > 0.01;
  }
}

// Rule 3: BTC 4h ST(10,1.5) flip adverse AND alt 1h EMA(9) cross adverse
function checkRule3(
  btc: BTCPrep, t: number,
  alt: AltPrep,
  dir: Dir,
): boolean {
  const btcH4Aligned = Math.floor((t - H4) / H4) * H4;
  const btcH4i = btc.h4Map.get(btcH4Aligned);
  if (btcH4i === undefined || btcH4i < 2) return false;

  const stNow = btc.h4St[btcH4i];
  const stPrev = btc.h4St[btcH4i - 1];
  if (stNow === null || stPrev === null) return false;

  if (dir === "long") {
    // BTC ST flipped bearish
    if (!(stPrev === 1 && stNow === -1)) return false;
    // Alt 1h EMA(9) < EMA(21) (bearish)
    const altH1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
    if (altH1i < 21) return false;
    const e9 = alt.h1Ema9[altH1i], e21 = alt.h1Ema21[altH1i];
    if (e9 === null || e21 === null) return false;
    return e9 < e21;
  } else {
    // BTC ST flipped bullish
    if (!(stPrev === -1 && stNow === 1)) return false;
    // Alt 1h EMA(9) > EMA(21) (bullish -- adverse for short)
    const altH1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
    if (altH1i < 21) return false;
    const e9 = alt.h1Ema9[altH1i], e21 = alt.h1Ema21[altH1i];
    if (e9 === null || e21 === null) return false;
    return e9 > e21;
  }
}

// Rule 4: BTC >3% adverse move in 12h AND alt on wrong side of 4h EMA(9)
function checkRule4(
  btcM5: C[], btcIdx: number,
  alt: AltPrep, altM5: C[], altIdx: number, t: number,
  dir: Dir,
): boolean {
  if (btcIdx < 144) return false;
  const btcNow = btcM5[btcIdx].c;
  const btc12hAgoIdx = Math.max(0, btcIdx - 144);
  const btc12hAgo = btcM5[btc12hAgoIdx].c;

  const altH4Aligned = Math.floor((t - H4) / H4) * H4;
  const altH4i = alt.h4Map.get(altH4Aligned);
  if (altH4i === undefined || altH4i < 9) return false;
  const e9 = alt.h4Ema9[altH4i];
  if (e9 === null) return false;
  const altPrice = altM5[altIdx].c;

  if (dir === "long") {
    const btcDrop = (btc12hAgo - btcNow) / btc12hAgo;
    return btcDrop > 0.03 && altPrice < e9;
  } else {
    const btcPump = (btcNow - btc12hAgo) / btc12hAgo;
    return btcPump > 0.03 && altPrice > e9;
  }
}

// Rule 5: BTC >2% adverse move in 4h (funding/panic proxy)
function checkRule5(
  btcM5: C[], btcIdx: number,
  dir: Dir,
): boolean {
  if (btcIdx < 48) return false;
  const btcNow = btcM5[btcIdx].c;
  const btc4hAgoIdx = Math.max(0, btcIdx - 48);
  const btc4hAgo = btcM5[btc4hAgoIdx].c;

  if (dir === "long") {
    return (btc4hAgo - btcNow) / btc4hAgo > 0.02;
  } else {
    return (btcNow - btc4hAgo) / btc4hAgo > 0.02;
  }
}

// Rule 6: BTC AND alt both make adverse extreme on 4h bars
function checkRule6(
  btc: BTCPrep, t: number,
  alt: AltPrep,
  dir: Dir,
): boolean {
  const btcH4Aligned = Math.floor((t - H4) / H4) * H4;
  const btcH4i = btc.h4Map.get(btcH4Aligned);
  if (btcH4i === undefined || btcH4i < 2) return false;

  const altH4Aligned = Math.floor((t - H4) / H4) * H4;
  const altH4i = alt.h4Map.get(altH4Aligned);
  if (altH4i === undefined || altH4i < 2) return false;

  if (dir === "long") {
    // Both make lower lows (bearish)
    return btc.h4[btcH4i].l < btc.h4[btcH4i - 1].l &&
           alt.h4[altH4i].l < alt.h4[altH4i - 1].l;
  } else {
    // Both make higher highs (bullish -- adverse for short)
    return btc.h4[btcH4i].h > btc.h4[btcH4i - 1].h &&
           alt.h4[altH4i].h > alt.h4[altH4i - 1].h;
  }
}

// ─── Main ───────────────────────────────────────────────────────────
function run() {
  console.log("Loading BTC data...");
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data"); return; }
  const btc = prepBTC(btcRaw);
  console.log(`BTC: ${btcRaw.length} 5m bars, ${btc.h4.length} 4h, ${btc.daily.length} daily`);

  console.log("\nLoading alt data...");
  const altData = new Map<string, AltPrep>();
  for (const p of PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 1000) { console.log(`  Skip ${p}`); continue; }
    altData.set(p, prepAlt(m5));
    console.log(`  ${p}: ${m5.length} 5m bars`);
  }

  console.log("\nGenerating baseline trades (Donchian + Supertrend)...");
  const positions = generateTrades(btc, altData);
  console.log(`Generated ${positions.length} positions`);

  // Count longs vs shorts
  const nLongs = positions.filter(p => p.dir === "long").length;
  const nShorts = positions.filter(p => p.dir === "short").length;
  console.log(`  Longs: ${nLongs}, Shorts: ${nShorts}`);

  const CHECK_INTERVAL = 12; // every 1h on 5m bars

  interface TradeResult {
    pair: string; engine: string; dir: Dir;
    ep: number; et: number; exitPrice: number; exitTime: number;
    pnl: number; exitReason: string;
  }

  const baselineTrades: TradeResult[] = [];
  const exitEvents: Map<string, ExitEvent[]> = new Map();
  for (const rule of ["R2", "R3", "R4", "R5", "R6"]) {
    exitEvents.set(rule, []);
  }

  let posCount = 0;
  for (const pos of positions) {
    posCount++;
    if (posCount % 200 === 0) process.stdout.write(`\r  Processing ${posCount}/${positions.length}...`);

    const alt = altData.get(pos.pair)!;
    const halfSpread = sp(pos.pair);

    const firedRules = new Set<string>();
    let currentSl = pos.sl;
    let bestPnlAtr = 0;
    let exitPrice = 0, exitTime = 0, exitReason = "open";

    const maxEndTime = pos.et + pos.maxHold;
    const m5End = Math.min(findCandleIdx(alt.m5, maxEndTime), alt.m5.length);

    for (let i = pos.m5StartIdx; i < m5End; i++) {
      const bar = alt.m5[i];
      if (bar.t < pos.et) continue;

      // Stop-loss check (every bar)
      if (pos.dir === "long" && bar.l <= currentSl) {
        exitPrice = currentSl * (1 - halfSpread * 1.5);
        exitTime = bar.t; exitReason = "SL"; break;
      }
      if (pos.dir === "short" && bar.h >= currentSl) {
        exitPrice = currentSl * (1 + halfSpread * 1.5);
        exitTime = bar.t; exitReason = "SL"; break;
      }

      // Max hold
      if (bar.t - pos.et >= pos.maxHold) {
        exitPrice = pos.dir === "long" ? bar.c * (1 - halfSpread) : bar.c * (1 + halfSpread);
        exitTime = bar.t; exitReason = "maxhold"; break;
      }

      // Engine A: Donchian exit (check once per day)
      if (pos.engine === "A" && bar.t % DAY === 0) {
        const di = getBarAtOrBefore(alt.daily, bar.t - DAY, alt.dailyMap, DAY);
        if (di >= 15) {
          if (pos.dir === "long" && alt.donLo15[di] !== null && bar.c < alt.donLo15[di]!) {
            exitPrice = bar.c * (1 - halfSpread);
            exitTime = bar.t; exitReason = "donchian"; break;
          }
          if (pos.dir === "short" && alt.donHi15[di] !== null && bar.c > alt.donHi15[di]!) {
            exitPrice = bar.c * (1 + halfSpread);
            exitTime = bar.t; exitReason = "donchian"; break;
          }
        }
      }

      // Engine B: Supertrend flip exit (check at 4h boundaries)
      if (pos.engine === "B" && bar.t % H4 === 0) {
        const h4Aligned = Math.floor((bar.t - H4) / H4) * H4;
        const h4i = alt.h4Map.get(h4Aligned);
        if (h4i !== undefined && h4i >= 2) {
          const stNow = alt.h4St[h4i];
          if (stNow !== null) {
            if (pos.dir === "long" && stNow === -1) {
              exitPrice = bar.c * (1 - halfSpread);
              exitTime = bar.t; exitReason = "st_flip"; break;
            }
            if (pos.dir === "short" && stNow === 1) {
              exitPrice = bar.c * (1 + halfSpread);
              exitTime = bar.t; exitReason = "st_flip"; break;
            }
          }
        }
      }

      // Trailing stop update
      if (pos.atr > 0) {
        const unrealPnlAtr = pos.dir === "long"
          ? (bar.c - pos.ep) / pos.atr
          : (pos.ep - bar.c) / pos.atr;
        if (unrealPnlAtr > bestPnlAtr) bestPnlAtr = unrealPnlAtr;

        let newSl = currentSl;
        if (bestPnlAtr >= 3) {
          const trail = pos.dir === "long"
            ? pos.ep + (bestPnlAtr - 1.5) * pos.atr
            : pos.ep - (bestPnlAtr - 1.5) * pos.atr;
          newSl = pos.dir === "long" ? Math.max(currentSl, trail) : Math.min(currentSl, trail);
        } else if (bestPnlAtr >= 2) {
          const trail = pos.dir === "long"
            ? bar.h - 2 * pos.atr
            : bar.l + 2 * pos.atr;
          newSl = pos.dir === "long" ? Math.max(currentSl, trail) : Math.min(currentSl, trail);
        } else if (bestPnlAtr >= 1) {
          newSl = pos.dir === "long" ? Math.max(currentSl, pos.ep) : Math.min(currentSl, pos.ep);
        }
        currentSl = newSl;
      }

      // BTC-confirmed exit rules (every CHECK_INTERVAL bars, only when in profit)
      if ((i - pos.m5StartIdx) % CHECK_INTERVAL !== 0) continue;

      const leveragedPnl = pos.dir === "long"
        ? (bar.c / pos.ep - 1) * pos.lev
        : (pos.ep / bar.c - 1) * pos.lev;
      if (leveragedPnl <= 0) continue;

      const btcIdx = findCandleIdx(btc.m5, bar.t);
      if (btcIdx >= btc.m5.length || btc.m5[btcIdx].t !== bar.t) continue;

      // Rule 2 (direction-aware)
      if (!firedRules.has("R2") && checkRule2(btc.m5, btcIdx, alt.m5, i, pos.dir)) {
        firedRules.add("R2");
        recordExit("R2", pos, alt, bar.t, bar.c, leveragedPnl, exitEvents);
      }

      // Rule 3 (direction-aware)
      if (!firedRules.has("R3") && checkRule3(btc, bar.t, alt, pos.dir)) {
        firedRules.add("R3");
        recordExit("R3", pos, alt, bar.t, bar.c, leveragedPnl, exitEvents);
      }

      // Rule 4 (direction-aware)
      if (!firedRules.has("R4") && checkRule4(btc.m5, btcIdx, alt, alt.m5, i, bar.t, pos.dir)) {
        firedRules.add("R4");
        recordExit("R4", pos, alt, bar.t, bar.c, leveragedPnl, exitEvents);
      }

      // Rule 5 (direction-aware)
      if (!firedRules.has("R5") && checkRule5(btc.m5, btcIdx, pos.dir)) {
        firedRules.add("R5");
        recordExit("R5", pos, alt, bar.t, bar.c, leveragedPnl, exitEvents);
      }

      // Rule 6 (direction-aware)
      if (!firedRules.has("R6") && checkRule6(btc, bar.t, alt, pos.dir)) {
        firedRules.add("R6");
        recordExit("R6", pos, alt, bar.t, bar.c, leveragedPnl, exitEvents);
      }
    }

    if (exitReason === "open") {
      const lastBar = alt.m5[m5End - 1] ?? alt.m5[alt.m5.length - 1];
      exitPrice = pos.dir === "long" ? lastBar.c * (1 - halfSpread) : lastBar.c * (1 + halfSpread);
      exitTime = lastBar.t;
      exitReason = "end";
    }

    const notional = pos.margin * pos.lev;
    const raw = pos.dir === "long"
      ? (exitPrice / pos.ep - 1) * notional
      : (pos.ep / exitPrice - 1) * notional;
    const cost = notional * FEE * 2;
    baselineTrades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, et: pos.et, exitPrice, exitTime,
      pnl: raw - cost, exitReason,
    });
  }

  console.log(`\n\n${"=".repeat(90)}`);
  console.log("BASELINE (no BTC exit)");
  console.log("=".repeat(90));
  printStats(baselineTrades);

  // ─── Per-rule analysis ─────────────────────────────────────────────
  console.log(`\n${"=".repeat(90)}`);
  console.log("BTC-CONFIRMED EXIT ANALYSIS (direction-aware)");
  console.log("=".repeat(90));

  const ruleDesc: Record<string, string> = {
    R2: "BTC >2% from 24h extreme AND alt >1% from 4h extreme",
    R3: "BTC 4h ST(10,1.5) adverse flip AND alt 1h EMA(9) adverse cross",
    R4: "BTC >3% adverse move in 12h AND alt wrong side of 4h EMA(9)",
    R5: "BTC >2% adverse move in 4h (panic proxy)",
    R6: "BTC + alt synchronized adverse 4h extreme",
  };

  for (const [rule, events] of exitEvents) {
    const desc = ruleDesc[rule] ?? rule;
    console.log(`\n--- ${rule}: ${desc} ---`);
    if (events.length === 0) { console.log("  No signals."); continue; }

    const longs = events.filter(e => e.dir === "long");
    const shorts = events.filter(e => e.dir === "short");

    console.log(`  Signals: ${events.length} (${longs.length} longs, ${shorts.length} shorts)`);

    const c4 = events.filter(e => e.correct4h).length;
    const c12 = events.filter(e => e.correct12h).length;
    const c24 = events.filter(e => e.correct24h).length;
    console.log(`  Accuracy 4h:  ${c4}/${events.length} = ${pct(c4, events.length)}`);
    console.log(`  Accuracy 12h: ${c12}/${events.length} = ${pct(c12, events.length)}`);
    console.log(`  Accuracy 24h: ${c24}/${events.length} = ${pct(c24, events.length)}`);

    const avgPnl = events.reduce((s, e) => s + e.leveragedPnlAtExit, 0) / events.length;
    console.log(`  Avg lev P&L at signal: ${(avgPnl * 100).toFixed(1)}%`);

    // Average adverse move after exit (positive = exit saved money)
    const avgSaved4h = events.reduce((s, e) => {
      return s + adverseMove(e, e.priceAfter4h);
    }, 0) / events.length;
    const avgSaved12h = events.reduce((s, e) => {
      return s + adverseMove(e, e.priceAfter12h);
    }, 0) / events.length;
    const avgSaved24h = events.reduce((s, e) => {
      return s + adverseMove(e, e.priceAfter24h);
    }, 0) / events.length;
    console.log(`  Avg adverse move after: 4h=${(avgSaved4h * 100).toFixed(3)}%, 12h=${(avgSaved12h * 100).toFixed(3)}%, 24h=${(avgSaved24h * 100).toFixed(3)}%`);
    console.log(`    (positive = price moved against position = exit correct)`);

    if (longs.length >= 5) {
      const lc4 = longs.filter(e => e.correct4h).length;
      const lc12 = longs.filter(e => e.correct12h).length;
      const lc24 = longs.filter(e => e.correct24h).length;
      console.log(`  LONGS: ${longs.length} signals, 4h=${pct(lc4,longs.length)}, 12h=${pct(lc12,longs.length)}, 24h=${pct(lc24,longs.length)}`);
    }
    if (shorts.length >= 5) {
      const sc4 = shorts.filter(e => e.correct4h).length;
      const sc12 = shorts.filter(e => e.correct12h).length;
      const sc24 = shorts.filter(e => e.correct24h).length;
      console.log(`  SHORTS: ${shorts.length} signals, 4h=${pct(sc4,shorts.length)}, 12h=${pct(sc12,shorts.length)}, 24h=${pct(sc24,shorts.length)}`);
    }

    for (const eng of ["A", "B"]) {
      const ee = events.filter(e => e.engine === eng);
      if (ee.length < 3) continue;
      const ec4 = ee.filter(e => e.correct4h).length;
      const ec12 = ee.filter(e => e.correct12h).length;
      const ec24 = ee.filter(e => e.correct24h).length;
      console.log(`  Engine ${eng}: ${ee.length} signals, 4h=${pct(ec4,ee.length)}, 12h=${pct(ec12,ee.length)}, 24h=${pct(ec24,ee.length)}`);
    }
  }

  // ─── Portfolio impact simulation ──────────────────────────────────
  console.log(`\n${"=".repeat(90)}`);
  console.log("PORTFOLIO IMPACT (early exit vs baseline)");
  console.log("=".repeat(90));

  for (const [rule, events] of exitEvents) {
    if (events.length === 0) continue;

    let savedPnl = 0, countHelped = 0, countHurt = 0, matched = 0;
    for (const evt of events) {
      const bt = baselineTrades.find(
        t => t.pair === evt.pair && t.engine === evt.engine &&
             t.et <= evt.exitTime && t.exitTime >= evt.exitTime
      );
      if (!bt) continue;
      matched++;

      const notional = 5 * 10;
      const earlyPnl = evt.dir === "long"
        ? (evt.exitPrice * (1 - sp(evt.pair)) / bt.ep - 1) * notional - notional * FEE * 2
        : (bt.ep / (evt.exitPrice * (1 + sp(evt.pair))) - 1) * notional - notional * FEE * 2;

      const diff = earlyPnl - bt.pnl;
      savedPnl += diff;
      if (diff > 0) countHelped++; else countHurt++;
    }

    console.log(`  ${rule}: ${matched} matched, ${countHelped} helped, ${countHurt} hurt, net=$${savedPnl.toFixed(2)}, avg=$${(matched > 0 ? savedPnl / matched : 0).toFixed(2)}/signal`);
  }

  // ─── Summary table ─────────────────────────────────────────────────
  console.log(`\n${"=".repeat(90)}`);
  console.log("SUMMARY TABLE");
  console.log("=".repeat(90));
  console.log(
    "Rule".padEnd(6) +
    "N".padStart(6) +
    "Acc4h".padStart(8) +
    "Acc12h".padStart(8) +
    "Acc24h".padStart(8) +
    "AvgSaved24h".padStart(13) +
    "  >60% at 12h?"
  );
  console.log("-".repeat(62));

  for (const [rule, events] of exitEvents) {
    if (events.length === 0) {
      console.log(`${rule.padEnd(6)}${"0".padStart(6)}${"--".padStart(8)}${"--".padStart(8)}${"--".padStart(8)}${"--".padStart(13)}  --`);
      continue;
    }
    const acc4 = events.filter(e => e.correct4h).length / events.length;
    const acc12 = events.filter(e => e.correct12h).length / events.length;
    const acc24 = events.filter(e => e.correct24h).length / events.length;
    const avgSaved24h = events.reduce((s, e) => s + adverseMove(e, e.priceAfter24h), 0) / events.length;
    const pass = acc12 > 0.6 ? "YES" : "no";
    console.log(
      `${rule.padEnd(6)}${String(events.length).padStart(6)}` +
      `${(acc4 * 100).toFixed(1).padStart(7)}%` +
      `${(acc12 * 100).toFixed(1).padStart(7)}%` +
      `${(acc24 * 100).toFixed(1).padStart(7)}%` +
      `${(avgSaved24h * 100).toFixed(3).padStart(12)}%  ${pass}`
    );
  }

  // ─── Longs-only summary (the real question) ───────────────────────
  console.log(`\n${"=".repeat(90)}`);
  console.log("LONGS-ONLY SUMMARY (primary use case: exit longs when BTC dips)");
  console.log("=".repeat(90));
  console.log(
    "Rule".padEnd(6) +
    "N".padStart(6) +
    "Acc4h".padStart(8) +
    "Acc12h".padStart(8) +
    "Acc24h".padStart(8) +
    "AvgSaved24h".padStart(13) +
    "  >60% at 12h?"
  );
  console.log("-".repeat(62));

  for (const [rule, events] of exitEvents) {
    const longs = events.filter(e => e.dir === "long");
    if (longs.length === 0) {
      console.log(`${rule.padEnd(6)}${"0".padStart(6)}${"--".padStart(8)}${"--".padStart(8)}${"--".padStart(8)}${"--".padStart(13)}  --`);
      continue;
    }
    const acc4 = longs.filter(e => e.correct4h).length / longs.length;
    const acc12 = longs.filter(e => e.correct12h).length / longs.length;
    const acc24 = longs.filter(e => e.correct24h).length / longs.length;
    const avgSaved24h = longs.reduce((s, e) => s + adverseMove(e, e.priceAfter24h), 0) / longs.length;
    const pass = acc12 > 0.6 ? "YES" : "no";
    console.log(
      `${rule.padEnd(6)}${String(longs.length).padStart(6)}` +
      `${(acc4 * 100).toFixed(1).padStart(7)}%` +
      `${(acc12 * 100).toFixed(1).padStart(7)}%` +
      `${(acc24 * 100).toFixed(1).padStart(7)}%` +
      `${(avgSaved24h * 100).toFixed(3).padStart(12)}%  ${pass}`
    );
  }

  // ─── Shorts-only summary ──────────────────────────────────────────
  console.log(`\n${"=".repeat(90)}`);
  console.log("SHORTS-ONLY SUMMARY (exit shorts when BTC pumps)");
  console.log("=".repeat(90));
  console.log(
    "Rule".padEnd(6) +
    "N".padStart(6) +
    "Acc4h".padStart(8) +
    "Acc12h".padStart(8) +
    "Acc24h".padStart(8) +
    "AvgSaved24h".padStart(13) +
    "  >60% at 12h?"
  );
  console.log("-".repeat(62));

  for (const [rule, events] of exitEvents) {
    const shorts = events.filter(e => e.dir === "short");
    if (shorts.length === 0) {
      console.log(`${rule.padEnd(6)}${"0".padStart(6)}${"--".padStart(8)}${"--".padStart(8)}${"--".padStart(8)}${"--".padStart(13)}  --`);
      continue;
    }
    const acc4 = shorts.filter(e => e.correct4h).length / shorts.length;
    const acc12 = shorts.filter(e => e.correct12h).length / shorts.length;
    const acc24 = shorts.filter(e => e.correct24h).length / shorts.length;
    const avgSaved24h = shorts.reduce((s, e) => s + adverseMove(e, e.priceAfter24h), 0) / shorts.length;
    const pass = acc12 > 0.6 ? "YES" : "no";
    console.log(
      `${rule.padEnd(6)}${String(shorts.length).padStart(6)}` +
      `${(acc4 * 100).toFixed(1).padStart(7)}%` +
      `${(acc12 * 100).toFixed(1).padStart(7)}%` +
      `${(acc24 * 100).toFixed(1).padStart(7)}%` +
      `${(avgSaved24h * 100).toFixed(3).padStart(12)}%  ${pass}`
    );
  }
}

function recordExit(
  rule: string, pos: LivePosition, alt: AltPrep,
  t: number, currentPrice: number, leveragedPnl: number,
  exitEvents: Map<string, ExitEvent[]>,
) {
  const price4h = priceAt(alt.m5, t + H4) ?? currentPrice;
  const price12h = priceAt(alt.m5, t + H12) ?? currentPrice;
  const price24h = priceAt(alt.m5, t + H24) ?? currentPrice;

  // "correct" = price moved against position after exit (exit saved money)
  const correct4h = pos.dir === "long" ? price4h < currentPrice : price4h > currentPrice;
  const correct12h = pos.dir === "long" ? price12h < currentPrice : price12h > currentPrice;
  const correct24h = pos.dir === "long" ? price24h < currentPrice : price24h > currentPrice;

  exitEvents.get(rule)!.push({
    pair: pos.pair, engine: pos.engine, dir: pos.dir, rule,
    exitTime: t, exitPrice: currentPrice, leveragedPnlAtExit: leveragedPnl,
    priceAfter4h: price4h, priceAfter12h: price12h, priceAfter24h: price24h,
    correct4h, correct12h, correct24h,
  });
}

// Positive = price moved against position (exit was correct)
function adverseMove(e: ExitEvent, futurePrice: number): number {
  if (e.dir === "long") return (e.exitPrice - futurePrice) / e.exitPrice;
  return (futurePrice - e.exitPrice) / e.exitPrice;
}

function pct(n: number, d: number): string {
  return `${(n / d * 100).toFixed(1)}%`;
}

function printStats(trades: { pnl: number; exitReason: string; engine: string; dir: Dir }[]) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  console.log(`  Trades: ${trades.length} (${wins.length}W / ${losses.length}L)`);
  console.log(`  Win rate: ${(wins.length / trades.length * 100).toFixed(1)}%`);
  console.log(`  Total P&L: $${totalPnl.toFixed(2)}`);
  console.log(`  Avg P&L: $${(totalPnl / trades.length).toFixed(2)}`);
  console.log(`  PF: ${pf.toFixed(2)}`);

  const sorted = [...trades as any[]].sort((a: any, b: any) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  let equity = 0, peak = 0, maxDd = 0;
  for (const t of sorted) { equity += t.pnl; if (equity > peak) peak = equity; if (peak - equity > maxDd) maxDd = peak - equity; }
  console.log(`  Max DD: $${maxDd.toFixed(2)}`);

  const reasons = new Map<string, number>();
  for (const t of trades) reasons.set(t.exitReason, (reasons.get(t.exitReason) ?? 0) + 1);
  console.log(`  Exits: ${[...reasons.entries()].map(([r, n]) => `${r}=${n}`).join(", ")}`);

  const longs = trades.filter(t => t.dir === "long");
  const shorts = trades.filter(t => t.dir === "short");
  console.log(`  Longs: ${longs.length} (WR=${(longs.filter(t=>t.pnl>0).length/Math.max(1,longs.length)*100).toFixed(1)}%, PnL=$${longs.reduce((s,t)=>s+t.pnl,0).toFixed(2)})`);
  console.log(`  Shorts: ${shorts.length} (WR=${(shorts.filter(t=>t.pnl>0).length/Math.max(1,shorts.length)*100).toFixed(1)}%, PnL=$${shorts.reduce((s,t)=>s+t.pnl,0).toFixed(2)})`);

  for (const eng of ["A", "B"]) {
    const et = trades.filter(t => t.engine === eng);
    if (et.length === 0) continue;
    const ew = et.filter(t => t.pnl > 0);
    console.log(`  Engine ${eng}: ${et.length} trades, WR=${(ew.length/et.length*100).toFixed(1)}%, PnL=$${et.reduce((s,t)=>s+t.pnl,0).toFixed(2)}`);
  }
}

// ─── Phase 2: Parameter sweep for longs-only (promising rules) ──────
function runSweep(btc: BTCPrep, altData: Map<string, AltPrep>, positions: LivePosition[]) {
  console.log(`\n\n${"=".repeat(90)}`);
  console.log("PHASE 2: PARAMETER SWEEP (longs only, BTC drops -> exit longs)");
  console.log("=".repeat(90));

  const CHECK_INTERVAL = 12;
  const longPositions = positions.filter(p => p.dir === "long");
  console.log(`Testing ${longPositions.length} long positions across parameter combos...\n`);

  interface SweepConfig {
    label: string;
    check: (btcM5: C[], btcIdx: number, alt: AltPrep, altM5: C[], altIdx: number, t: number) => boolean;
  }

  const configs: SweepConfig[] = [
    // R4 variants: BTC drop in 12h AND alt below 4h EMA(9)
    { label: "R4a: BTC>2% 12h + alt<EMA9", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 144) return false;
      const drop = (bm[Math.max(0,bi-144)].c - bm[bi].c) / bm[Math.max(0,bi-144)].c;
      if (drop <= 0.02) return false;
      const h4i = alt.h4Map.get(Math.floor((t-H4)/H4)*H4);
      if (h4i === undefined || h4i < 9) return false;
      const e9 = alt.h4Ema9[h4i];
      return e9 !== null && am[ai].c < e9;
    }},
    { label: "R4b: BTC>1.5% 12h + alt<EMA9", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 144) return false;
      const drop = (bm[Math.max(0,bi-144)].c - bm[bi].c) / bm[Math.max(0,bi-144)].c;
      if (drop <= 0.015) return false;
      const h4i = alt.h4Map.get(Math.floor((t-H4)/H4)*H4);
      if (h4i === undefined || h4i < 9) return false;
      const e9 = alt.h4Ema9[h4i];
      return e9 !== null && am[ai].c < e9;
    }},
    { label: "R4c: BTC>3% 12h + alt<EMA9", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 144) return false;
      const drop = (bm[Math.max(0,bi-144)].c - bm[bi].c) / bm[Math.max(0,bi-144)].c;
      if (drop <= 0.03) return false;
      const h4i = alt.h4Map.get(Math.floor((t-H4)/H4)*H4);
      if (h4i === undefined || h4i < 9) return false;
      const e9 = alt.h4Ema9[h4i];
      return e9 !== null && am[ai].c < e9;
    }},

    // R5 variants: BTC fast drop in 4h
    { label: "R5a: BTC>1.5% 4h drop", check: (bm, bi) => {
      if (bi < 48) return false;
      return (bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c > 0.015;
    }},
    { label: "R5b: BTC>2% 4h drop", check: (bm, bi) => {
      if (bi < 48) return false;
      return (bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c > 0.02;
    }},
    { label: "R5c: BTC>2.5% 4h drop", check: (bm, bi) => {
      if (bi < 48) return false;
      return (bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c > 0.025;
    }},

    // Combined: BTC 4h drop + alt also dropping from recent high
    { label: "R7a: BTC>1.5% 4h + alt>0.5% from 4h high", check: (bm, bi, alt, am, ai) => {
      if (bi < 48 || ai < 48) return false;
      const btcDrop = (bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c;
      if (btcDrop <= 0.015) return false;
      const alt4hHi = rolling5mHigh(am, ai - 1, H4);
      const altDrop = (alt4hHi - am[ai].c) / alt4hHi;
      return altDrop > 0.005;
    }},
    { label: "R7b: BTC>1.5% 4h + alt<1h EMA9", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 48) return false;
      const btcDrop = (bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c;
      if (btcDrop <= 0.015) return false;
      const h1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
      if (h1i < 9) return false;
      const e9 = alt.h1Ema9[h1i];
      return e9 !== null && am[ai].c < e9;
    }},
    { label: "R7c: BTC>2% 4h + alt<1h EMA9", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 48) return false;
      const btcDrop = (bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c;
      if (btcDrop <= 0.02) return false;
      const h1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
      if (h1i < 9) return false;
      const e9 = alt.h1Ema9[h1i];
      return e9 !== null && am[ai].c < e9;
    }},

    // BTC drop from 24h high + alt weakness
    { label: "R8a: BTC>3% from 24h high + alt<1h EMA9", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 288) return false;
      const btc24hHi = rolling5mHigh(bm, bi - 1, H24);
      const btcDrop = (btc24hHi - bm[bi].c) / btc24hHi;
      if (btcDrop <= 0.03) return false;
      const h1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
      if (h1i < 9) return false;
      const e9 = alt.h1Ema9[h1i];
      return e9 !== null && am[ai].c < e9;
    }},
    { label: "R8b: BTC>2.5% from 24h high + alt<1h EMA9", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 288) return false;
      const btc24hHi = rolling5mHigh(bm, bi - 1, H24);
      const btcDrop = (btc24hHi - bm[bi].c) / btc24hHi;
      if (btcDrop <= 0.025) return false;
      const h1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
      if (h1i < 9) return false;
      const e9 = alt.h1Ema9[h1i];
      return e9 !== null && am[ai].c < e9;
    }},

    // Triple confirmation: BTC drop + alt below EMA + alt making lower lows
    { label: "R9: BTC>1.5% 4h + alt<EMA9(1h) + alt 4h lower low", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 48) return false;
      const btcDrop = (bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c;
      if (btcDrop <= 0.015) return false;
      // Alt below 1h EMA9
      const h1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
      if (h1i < 9) return false;
      const e9 = alt.h1Ema9[h1i];
      if (e9 === null || am[ai].c >= e9) return false;
      // Alt 4h lower low
      const altH4i = alt.h4Map.get(Math.floor((t-H4)/H4)*H4);
      if (altH4i === undefined || altH4i < 2) return false;
      return alt.h4[altH4i].l < alt.h4[altH4i - 1].l;
    }},

    // BTC EMA cross (daily EMA20 < EMA50 = bearish regime) + alt weakness
    { label: "R10: BTC bearish regime + alt<4h EMA9", check: (bm, bi, alt, am, ai, t) => {
      // Check if BTC daily EMA(20) just crossed below EMA(50) (use btc global)
      // We'll proxy this: BTC dropped >1% in 24h AND alt below 4h EMA9
      if (bi < 288) return false;
      const btcDrop24h = (bm[Math.max(0,bi-288)].c - bm[bi].c) / bm[Math.max(0,bi-288)].c;
      if (btcDrop24h <= 0.01) return false;
      const h4i = alt.h4Map.get(Math.floor((t-H4)/H4)*H4);
      if (h4i === undefined || h4i < 9) return false;
      const e9 = alt.h4Ema9[h4i];
      return e9 !== null && am[ai].c < e9;
    }},
  ];

  // Run sweep
  console.log("Label".padEnd(45) + "N".padStart(5) + " Acc4h".padStart(7) + " Acc12h".padStart(7) + " Acc24h".padStart(7) + " AvgSaved24h".padStart(12) + "  Pass?");
  console.log("-".repeat(90));

  for (const cfg of configs) {
    const events: ExitEvent[] = [];

    for (const pos of longPositions) {
      const alt = altData.get(pos.pair)!;
      let fired = false;

      const maxEndTime = pos.et + pos.maxHold;
      const m5End = Math.min(findCandleIdx(alt.m5, maxEndTime), alt.m5.length);

      for (let i = pos.m5StartIdx; i < m5End && !fired; i++) {
        const bar = alt.m5[i];
        if (bar.t < pos.et) continue;

        // Only check periodically
        if ((i - pos.m5StartIdx) % CHECK_INTERVAL !== 0) continue;

        // Must be in profit
        const levPnl = (bar.c / pos.ep - 1) * pos.lev;
        if (levPnl <= 0) continue;

        const btcIdx = findCandleIdx(btc.m5, bar.t);
        if (btcIdx >= btc.m5.length || btc.m5[btcIdx].t !== bar.t) continue;

        if (cfg.check(btc.m5, btcIdx, alt, alt.m5, i, bar.t)) {
          fired = true;
          const price4h = priceAt(alt.m5, bar.t + H4) ?? bar.c;
          const price12h = priceAt(alt.m5, bar.t + H12) ?? bar.c;
          const price24h = priceAt(alt.m5, bar.t + H24) ?? bar.c;

          events.push({
            pair: pos.pair, engine: pos.engine, dir: "long", rule: cfg.label,
            exitTime: bar.t, exitPrice: bar.c, leveragedPnlAtExit: levPnl,
            priceAfter4h: price4h, priceAfter12h: price12h, priceAfter24h: price24h,
            correct4h: price4h < bar.c,
            correct12h: price12h < bar.c,
            correct24h: price24h < bar.c,
          });
        }
      }
    }

    if (events.length === 0) {
      console.log(`${cfg.label.padEnd(45)}${"0".padStart(5)}    --     --     --           --   --`);
      continue;
    }

    const acc4 = events.filter(e => e.correct4h).length / events.length;
    const acc12 = events.filter(e => e.correct12h).length / events.length;
    const acc24 = events.filter(e => e.correct24h).length / events.length;
    const avgSaved24h = events.reduce((s, e) => (e.exitPrice - e.priceAfter24h) / e.exitPrice + s, 0) / events.length;
    const pass = acc12 > 0.6 ? "YES" : (acc4 > 0.6 ? "4h" : "no");

    console.log(
      `${cfg.label.padEnd(45)}${String(events.length).padStart(5)}` +
      `${(acc4*100).toFixed(1).padStart(6)}%` +
      `${(acc12*100).toFixed(1).padStart(6)}%` +
      `${(acc24*100).toFixed(1).padStart(6)}%` +
      `${(avgSaved24h*100).toFixed(3).padStart(11)}%  ${pass}`
    );
  }
}

// ─── Phase 3: All-occurrences signal quality (not just first-per-trade) ───
function runAllOccurrences(btc: BTCPrep, altData: Map<string, AltPrep>, positions: LivePosition[]) {
  console.log(`\n\n${"=".repeat(90)}`);
  console.log("PHASE 3: ALL-OCCURRENCE SIGNAL QUALITY (every eligible bar, not first-only)");
  console.log("Measures: if this signal fires NOW, what happens next 4h/12h/24h?");
  console.log("=".repeat(90));

  const CHECK_INTERVAL = 12;
  const longPositions = positions.filter(p => p.dir === "long");
  console.log(`Scanning ${longPositions.length} long positions...\n`);

  // Cooldown: don't count the same signal twice within 4h for the same position
  const COOLDOWN = H4;

  interface SweepConfig {
    label: string;
    check: (btcM5: C[], btcIdx: number, alt: AltPrep, altM5: C[], altIdx: number, t: number) => boolean;
  }

  const configs: SweepConfig[] = [
    // Baseline: random exit (in profit)
    { label: "RANDOM (in profit, every 24h)", check: (bm, bi, alt, am, ai, t) => {
      // Fire at every 24h mark while in profit (to measure baseline accuracy)
      return t % H24 === 0;
    }},

    // BTC fast drops
    { label: "BTC>1.5% 4h drop", check: (bm, bi) => {
      if (bi < 48) return false;
      return (bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c > 0.015;
    }},
    { label: "BTC>2% 4h drop", check: (bm, bi) => {
      if (bi < 48) return false;
      return (bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c > 0.02;
    }},
    { label: "BTC>3% 4h drop", check: (bm, bi) => {
      if (bi < 48) return false;
      return (bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c > 0.03;
    }},

    // BTC from 24h high
    { label: "BTC>3% from 24h high", check: (bm, bi) => {
      if (bi < 288) return false;
      const hi = rolling5mHigh(bm, bi - 1, H24);
      return (hi - bm[bi].c) / hi > 0.03;
    }},
    { label: "BTC>4% from 24h high", check: (bm, bi) => {
      if (bi < 288) return false;
      const hi = rolling5mHigh(bm, bi - 1, H24);
      return (hi - bm[bi].c) / hi > 0.04;
    }},
    { label: "BTC>5% from 24h high", check: (bm, bi) => {
      if (bi < 288) return false;
      const hi = rolling5mHigh(bm, bi - 1, H24);
      return (hi - bm[bi].c) / hi > 0.05;
    }},

    // BTC drop + alt also confirming weakness
    { label: "BTC>2% 4h + alt<1h EMA(9)", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 48) return false;
      if ((bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c <= 0.02) return false;
      const h1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
      if (h1i < 9) return false;
      const e9 = alt.h1Ema9[h1i];
      return e9 !== null && am[ai].c < e9;
    }},
    { label: "BTC>2% 4h + alt<4h EMA(9)", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 48) return false;
      if ((bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c <= 0.02) return false;
      const h4i = alt.h4Map.get(Math.floor((t-H4)/H4)*H4);
      if (h4i === undefined || h4i < 9) return false;
      const e9 = alt.h4Ema9[h4i];
      return e9 !== null && am[ai].c < e9;
    }},
    { label: "BTC>3% from 24h high + alt<1h EMA(9)", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 288) return false;
      const hi = rolling5mHigh(bm, bi - 1, H24);
      if ((hi - bm[bi].c) / hi <= 0.03) return false;
      const h1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
      if (h1i < 9) return false;
      const e9 = alt.h1Ema9[h1i];
      return e9 !== null && am[ai].c < e9;
    }},
    { label: "BTC>3% from 24h high + alt>1% from 4h high", check: (bm, bi, alt, am, ai) => {
      if (bi < 288 || ai < 48) return false;
      const btcHi = rolling5mHigh(bm, bi - 1, H24);
      if ((btcHi - bm[bi].c) / btcHi <= 0.03) return false;
      const altHi = rolling5mHigh(am, ai - 1, H4);
      return (altHi - am[ai].c) / altHi > 0.01;
    }},
    { label: "BTC>4% from 24h high + alt<1h EMA(9)", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 288) return false;
      const hi = rolling5mHigh(bm, bi - 1, H24);
      if ((hi - bm[bi].c) / hi <= 0.04) return false;
      const h1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
      if (h1i < 9) return false;
      const e9 = alt.h1Ema9[h1i];
      return e9 !== null && am[ai].c < e9;
    }},

    // Triple confirmation
    { label: "BTC>2% 4h + alt<1h EMA(9) + alt 4h lower low", check: (bm, bi, alt, am, ai, t) => {
      if (bi < 48) return false;
      if ((bm[Math.max(0,bi-48)].c - bm[bi].c) / bm[Math.max(0,bi-48)].c <= 0.02) return false;
      const h1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
      if (h1i < 9) return false;
      const e9 = alt.h1Ema9[h1i];
      if (e9 === null || am[ai].c >= e9) return false;
      const altH4i = alt.h4Map.get(Math.floor((t-H4)/H4)*H4);
      if (altH4i === undefined || altH4i < 2) return false;
      return alt.h4[altH4i].l < alt.h4[altH4i - 1].l;
    }},

    // BTC 1h EMA(9) < EMA(21) + alt 1h EMA(9) < EMA(21) (both in downtrend on 1h)
    { label: "BTC 1h EMA(9)<EMA(21) + alt 1h EMA(9)<EMA(21)", check: (bm, bi, alt, am, ai, t) => {
      // We need BTC 1h EMAs -- compute on the fly from BTC h4 data? No, too slow.
      // Use BTC daily EMA proxy: check if BTC dropped >1% in last 12h as regime proxy
      if (bi < 144) return false;
      const btcDrop = (bm[Math.max(0,bi-144)].c - bm[bi].c) / bm[Math.max(0,bi-144)].c;
      if (btcDrop <= 0.01) return false;
      const h1i = getBarAtOrBefore(alt.h1, t - H1, alt.h1Map, H1);
      if (h1i < 21) return false;
      const e9 = alt.h1Ema9[h1i], e21 = alt.h1Ema21[h1i];
      return e9 !== null && e21 !== null && e9 < e21;
    }},
  ];

  console.log("Label".padEnd(52) + "N".padStart(6) + " Acc4h".padStart(7) + " Acc12h".padStart(7) + " Acc24h".padStart(7) + " AvgSaved24h".padStart(12) + "  Pass?");
  console.log("-".repeat(100));

  for (const cfg of configs) {
    interface Evt { correct4h: boolean; correct12h: boolean; correct24h: boolean; saved24h: number; }
    const events: Evt[] = [];

    for (const pos of longPositions) {
      const alt = altData.get(pos.pair)!;
      let lastFireTime = -Infinity;

      const maxEndTime = pos.et + pos.maxHold;
      const m5End = Math.min(findCandleIdx(alt.m5, maxEndTime), alt.m5.length);

      for (let i = pos.m5StartIdx; i < m5End; i++) {
        const bar = alt.m5[i];
        if (bar.t < pos.et) continue;
        if ((i - pos.m5StartIdx) % CHECK_INTERVAL !== 0) continue;

        // Must be in profit
        const levPnl = (bar.c / pos.ep - 1) * pos.lev;
        if (levPnl <= 0) continue;

        // Cooldown
        if (bar.t - lastFireTime < COOLDOWN) continue;

        const btcIdx = findCandleIdx(btc.m5, bar.t);
        if (btcIdx >= btc.m5.length || btc.m5[btcIdx].t !== bar.t) continue;

        if (cfg.check(btc.m5, btcIdx, alt, alt.m5, i, bar.t)) {
          lastFireTime = bar.t;

          const price4h = priceAt(alt.m5, bar.t + H4) ?? bar.c;
          const price12h = priceAt(alt.m5, bar.t + H12) ?? bar.c;
          const price24h = priceAt(alt.m5, bar.t + H24) ?? bar.c;

          events.push({
            correct4h: price4h < bar.c,
            correct12h: price12h < bar.c,
            correct24h: price24h < bar.c,
            saved24h: (bar.c - price24h) / bar.c,
          });
        }
      }
    }

    if (events.length === 0) {
      console.log(`${cfg.label.padEnd(52)}${"0".padStart(6)}    --     --     --           --   --`);
      continue;
    }

    const acc4 = events.filter(e => e.correct4h).length / events.length;
    const acc12 = events.filter(e => e.correct12h).length / events.length;
    const acc24 = events.filter(e => e.correct24h).length / events.length;
    const avgSaved24h = events.reduce((s, e) => s + e.saved24h, 0) / events.length;
    const pass = acc12 > 0.6 ? "YES" : (acc4 > 0.6 ? "4h" : "no");

    console.log(
      `${cfg.label.padEnd(52)}${String(events.length).padStart(6)}` +
      `${(acc4*100).toFixed(1).padStart(6)}%` +
      `${(acc12*100).toFixed(1).padStart(6)}%` +
      `${(acc24*100).toFixed(1).padStart(6)}%` +
      `${(avgSaved24h*100).toFixed(3).padStart(11)}%  ${pass}`
    );
  }
}

// ─── Entrypoint ─────────────────────────────────────────────────────
function main() {
  console.log("Loading BTC data...");
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data"); return; }
  const btc = prepBTC(btcRaw);

  const altData = new Map<string, AltPrep>();
  console.log("\nLoading alt data...");
  for (const p of PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 1000) { console.log(`  Skip ${p}`); continue; }
    altData.set(p, prepAlt(m5));
  }
  console.log(`Loaded ${altData.size} pairs`);

  const positions = generateTrades(btc, altData);
  console.log(`\nGenerated ${positions.length} positions (${positions.filter(p=>p.dir==="long").length} longs, ${positions.filter(p=>p.dir==="short").length} shorts)`);

  // Phase 2: first-per-trade sweep
  runSweep(btc, altData, positions);

  // Phase 3: all-occurrences signal quality
  runAllOccurrences(btc, altData, positions);
}

main();
