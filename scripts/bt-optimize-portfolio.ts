/**
 * Portfolio Optimization: pair count, position limits, sizing split, per-pair profitability.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-optimize-portfolio.ts
 */
import * as fs from "fs";
import * as path from "path";
import { EMA, ATR } from "technicalindicators";

// ─── Types ───────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; strat: string;
}
interface TFData {
  candles: C[];
  tsMap: Map<number, number>;
  zScores: number[];
  ema9: number[];
  ema21: number[];
}
interface PairMTF { h1: TFData; h4: TFData }

// ─── Constants ───────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const DAY = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const SL_SLIP = 1.5;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// Spread map (DOUBLED as requested in cost model)
const SP_BASE: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
  ETH: 0.8e-4, SOL: 1.2e-4, TIA: 3.8e-4,
};
// Doubled spreads per spec
const SP: Record<string, number> = {};
for (const [k, v] of Object.entries(SP_BASE)) SP[k] = v * 2;

const CURRENT_15 = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "SOL", "DASH",
];

// ─── Data loading ────────────────────────────────────────────────
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

function aggDaily(bars5m: C[]): C[] { return aggregate(bars5m, DAY, 200); }

// ─── Indicator helpers ───────────────────────────────────────────
function calcATRVals(cs: C[], period: number): number[] {
  return ATR.calculate({ period, high: cs.map(c => c.h), low: cs.map(c => c.l), close: cs.map(c => c.c) });
}
function calcEMAVals(cs: C[], period: number): number[] {
  return EMA.calculate({ period, values: cs.map(c => c.c) });
}
function gv(a: number[], barIdx: number, totalBars: number): number | null {
  const x = barIdx - (totalBars - a.length);
  return x >= 0 && x < a.length ? a[x] : null;
}

// Z-score computation
const MOM_LB = 3;
const VOL_WIN = 20;

function computeZScores(candles: C[]): number[] {
  const z = new Array(candles.length).fill(0);
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < candles.length; i++) {
    const mom = candles[i].c / candles[i - MOM_LB].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - VOL_WIN + 1); j <= i; j++) {
      const r = candles[j].c / candles[j - 1].c - 1;
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

function buildTFData(candles: C[]): TFData | null {
  if (candles.length < 200) return null;
  const tsMap = new Map<number, number>();
  candles.forEach((c, i) => tsMap.set(c.t, i));
  const closes = candles.map(c => c.c);
  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const zScores = computeZScores(candles);
  return { candles, tsMap, zScores, ema9, ema21 };
}

function precompute(pair: string, bars5m: C[]): PairMTF | null {
  if (bars5m.length < 200) return null;
  const h1 = buildTFData(aggregate(bars5m, H, 10));
  const h4 = buildTFData(aggregate(bars5m, H4, 40));
  if (!h1 || !h4) return null;
  return { h1, h4 };
}

// Cost helpers (doubled spread baked in via SP)
function entryCost(pair: string, dir: "long" | "short", price: number): number {
  const sp = SP[pair] ?? 8e-4;
  return dir === "long" ? price * (1 + sp) : price * (1 - sp);
}
function exitCost(pair: string, dir: "long" | "short", price: number, isSL: boolean): number {
  const sp = SP[pair] ?? 8e-4;
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? price * (1 - slip) : price * (1 + slip);
}
function tradePnl(dir: "long" | "short", ep: number, xp: number, sz: number): number {
  const not = sz * LEV;
  const raw = dir === "long" ? (xp / ep - 1) * not : (ep / xp - 1) * not;
  return raw - not * FEE * 2;
}

// Donchian helpers
function donchianHighClose(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c);
  return mx;
}
function donchianLowClose(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c);
  return mn;
}

// ─────────────────────────────────────────────────────────────────
// LOAD ALL DATA
// ─────────────────────────────────────────────────────────────────
const files = fs.readdirSync(CD).filter(f => f.endsWith("USDT.json"));
const ALL_PAIRS = files.map(f => f.replace("USDT.json", "")).sort();
console.log(`\nAvailable pairs in /tmp/bt-pair-cache-5m/: ${ALL_PAIRS.length}`);
console.log(ALL_PAIRS.join(", "));
console.log();

const raw5m = new Map<string, C[]>();
const pairMTF = new Map<string, PairMTF>();
const dailyData = new Map<string, C[]>();

console.log("Loading and precomputing data...");
for (const p of ALL_PAIRS) {
  const bars = load5m(p);
  if (bars.length === 0) { console.log(`  SKIP ${p}: no data`); continue; }
  raw5m.set(p, bars);
  const mtf = precompute(p, bars);
  if (mtf) pairMTF.set(p, mtf);
  const d = aggDaily(bars);
  if (d.length > 0) dailyData.set(p, d);
}

// BTC 1h for MTF filter
const btcMTF = pairMTF.get("BTC");
if (!btcMTF) { console.error("No BTC data!"); process.exit(1); }
const btcH1 = btcMTF.h1;

// BTC daily for Donchian filter
const btcDaily = dailyData.get("BTC")!;
const btcEma20 = calcEMAVals(btcDaily, 20);
const btcEma50 = calcEMAVals(btcDaily, 50);

function btcDailyDir(t: number): "long" | "short" | null {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t < t) { idx = i; break; }
  }
  if (idx < 0) return null;
  const e20 = gv(btcEma20, idx, btcDaily.length);
  const e50 = gv(btcEma50, idx, btcDaily.length);
  if (e20 === null || e50 === null) return null;
  return e20 > e50 ? "long" : "short";
}

// ─────────────────────────────────────────────────────────────────
// STRATEGY 1: GARCH v2 MTF z-score (1h timeframe)
// ─────────────────────────────────────────────────────────────────
function mtfSignal(pd: PairMTF, barIdx1h: number): "long" | "short" | null {
  const prev = barIdx1h - 1;
  if (prev < VOL_WIN + MOM_LB) return null;

  const z1h = pd.h1.zScores[prev];
  if (isNaN(z1h) || z1h === 0) return null;

  const goLong = z1h > 4.5;
  const goShort = z1h < -3.0;
  if (!goLong && !goShort) return null;

  // 4h z-score confirmation
  const ts1h = pd.h1.candles[prev].t;
  const ts4h = Math.floor(ts1h / H4) * H4;
  const idx4h = pd.h4.tsMap.get(ts4h);
  if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) return null;

  const z4h = pd.h4.zScores[idx4h];
  if (goLong && z4h <= 3.0) return null;
  if (goShort && z4h >= -3.0) return null;

  // EMA 9/21 on 1h
  const e9 = gv(pd.h1.ema9, prev, pd.h1.candles.length);
  const e21 = gv(pd.h1.ema21, prev, pd.h1.candles.length);
  if (e9 === null || e21 === null) return null;
  if (goLong && e9 <= e21) return null;
  if (goShort && e9 >= e21) return null;

  // BTC 1h EMA filter
  const btcIdx = btcH1.tsMap.get(ts1h);
  if (btcIdx === undefined || btcIdx < 1) return null;
  const btcPrev = btcIdx - 1;
  const be9 = gv(btcH1.ema9, btcPrev, btcH1.candles.length);
  const be21 = gv(btcH1.ema21, btcPrev, btcH1.candles.length);
  if (be9 === null || be21 === null) return null;
  if (goLong && be9 <= be21) return null;
  if (goShort && be9 >= be21) return null;

  return goLong ? "long" : "short";
}

interface Position { pair: string; direction: "long" | "short"; entryPrice: number; entryTime: number; stopLoss: number }

function runGarchMTF(
  pairs: string[], sz: number, startTs: number, endTs: number, maxPos = Infinity,
): Trade[] {
  const pd = new Map<string, PairMTF>();
  for (const p of pairs) { const d = pairMTF.get(p); if (d) pd.set(p, d); }

  const allTs = new Set<number>();
  for (const d of pd.values()) {
    for (const c of d.h1.candles) {
      if (c.t >= startTs && c.t < endTs) allTs.add(c.t);
    }
  }
  const sorted = [...allTs].sort((a, b) => a - b);
  const open = new Map<string, Position>();
  const trades: Trade[] = [];
  const NOT = sz * LEV;
  const MAX_HOLD_H = 168;

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // EXITS
    for (const [p, pos] of open) {
      const d = pd.get(p)!;
      const bi = d.h1.tsMap.get(ts) ?? -1;
      if (bi < 0) continue;
      const bar = d.h1.candles[bi];
      const sp = SP[p] ?? 8e-4;
      let exitPrice = 0, reason = "";

      // SL
      if (pos.direction === "long" && bar.l <= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 - sp * SL_SLIP); reason = "sl";
      } else if (pos.direction === "short" && bar.h >= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 + sp * SL_SLIP); reason = "sl";
      }

      // Max hold
      if (!reason) {
        const barsHeld = Math.floor((ts - pos.entryTime) / H);
        if (barsHeld >= MAX_HOLD_H) {
          exitPrice = pos.direction === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }
      }

      if (reason) {
        const raw = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * NOT
          : (pos.entryPrice / exitPrice - 1) * NOT;
        trades.push({
          pair: p, dir: pos.direction, ep: pos.entryPrice, xp: exitPrice,
          et: pos.entryTime, xt: ts, pnl: raw - NOT * FEE * 2, reason, strat: "GARCH",
        });
        open.delete(p);
        closedThisBar.add(p);
      }
    }

    // ENTRIES
    for (const [p, d] of pd) {
      if (open.has(p) || closedThisBar.has(p)) continue;
      if (open.size >= maxPos) break;
      if (p === "BTC") continue;
      const bi = d.h1.tsMap.get(ts) ?? -1;
      if (bi < 60) continue;

      const dir = mtfSignal(d, bi);
      if (!dir) continue;

      const entryRaw = d.h1.candles[bi].o;
      const sp = SP[p] ?? 8e-4;
      const entry = dir === "long" ? entryRaw * (1 + sp) : entryRaw * (1 - sp);
      const sl = dir === "long" ? entry * (1 - 0.04) : entry * (1 + 0.04);

      open.set(p, { pair: p, direction: dir, entryPrice: entry, entryTime: ts, stopLoss: sl });
    }
  }

  return trades;
}

// ─────────────────────────────────────────────────────────────────
// STRATEGY 2: Daily Donchian (SMA 30/60 cross entry)
// ─────────────────────────────────────────────────────────────────
function runDailyDonchian(
  pairs: string[], sz: number, startTs: number, endTs: number, maxPos = Infinity,
): Trade[] {
  const NOT = sz * LEV;
  const trades: Trade[] = [];

  // Precompute pair daily data
  type PairDailyData = { daily: C[]; atr: number[]; sma30: number[]; sma60: number[] };
  const pairDD = new Map<string, PairDailyData>();
  for (const p of pairs) {
    if (p === "BTC") continue;
    const d = dailyData.get(p);
    if (!d || d.length < 80) continue;
    const atr = calcATRVals(d, 14);
    const closes = d.map(c => c.c);
    // SMA
    const sma30: number[] = [];
    const sma60: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (i >= 29) {
        let s = 0; for (let j = i - 29; j <= i; j++) s += closes[j]; sma30.push(s / 30);
      }
      if (i >= 59) {
        let s = 0; for (let j = i - 59; j <= i; j++) s += closes[j]; sma60.push(s / 60);
      }
    }
    pairDD.set(p, { daily: d, atr, sma30, sma60 });
  }

  // Collect all day timestamps in range
  const daySet = new Set<number>();
  for (const [, pd] of pairDD) {
    for (const c of pd.daily) {
      if (c.t >= startTs && c.t < endTs) daySet.add(c.t);
    }
  }
  const days = [...daySet].sort((a, b) => a - b);

  // Pair index maps
  const pairIdx = new Map<string, Map<number, number>>();
  for (const [p, pd] of pairDD) {
    const m = new Map<number, number>();
    pd.daily.forEach((c, i) => m.set(c.t, i));
    pairIdx.set(p, m);
  }

  interface DonchPos { pair: string; dir: "long" | "short"; ep: number; et: number; sl: number }
  const open = new Map<string, DonchPos>();

  for (const dayTs of days) {
    const closedThisDay = new Set<string>();
    const btcDir = btcDailyDir(dayTs);

    // EXITS
    for (const [key, pos] of open) {
      const pd = pairDD.get(pos.pair);
      if (!pd) continue;
      const idx = pairIdx.get(pos.pair)!.get(dayTs);
      if (idx === undefined) continue;
      const bar = pd.daily[idx];
      const sp = SP[pos.pair] ?? 8e-4;
      let xp = 0, reason = "", isSL = false;

      // SL
      if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

      // Donchian exit: close below 15-day low (using closes)
      if (!reason) {
        if (pos.dir === "long" && bar.c < donchianLowClose(pd.daily, idx, 15)) { xp = bar.c; reason = "don-exit"; }
        else if (pos.dir === "short" && bar.c > donchianHighClose(pd.daily, idx, 15)) { xp = bar.c; reason = "don-exit"; }
      }

      // Max hold 60d
      if (!reason && dayTs - pos.et >= 60 * DAY) { xp = bar.c; reason = "mh"; }

      if (reason) {
        const exitP = exitCost(pos.pair, pos.dir, xp, isSL);
        const raw = pos.dir === "long"
          ? (exitP / pos.ep - 1) * NOT
          : (pos.ep / exitP - 1) * NOT;
        trades.push({
          pair: pos.pair, dir: pos.dir, ep: pos.ep, xp: exitP,
          et: pos.et, xt: dayTs, pnl: raw - NOT * FEE * 2, reason, strat: "DONCH",
        });
        open.delete(key);
        closedThisDay.add(pos.pair);
      }
    }

    // ENTRIES
    for (const [p, pd] of pairDD) {
      if (open.has(p) || closedThisDay.has(p)) continue;
      if (open.size >= maxPos) break;
      const idx = pairIdx.get(p)!.get(dayTs);
      if (idx === undefined || idx < 61) continue;

      const atrIdx = idx - (pd.daily.length - pd.atr.length);
      if (atrIdx < 0 || atrIdx >= pd.atr.length) continue;
      const atr = pd.atr[atrIdx];
      if (!atr || atr <= 0) continue;

      // SMA 30/60 cross on previous bar (anti-look-ahead)
      const sma30Idx = (idx - 1) - 29; // index into sma30 array
      const sma60Idx = (idx - 1) - 59; // index into sma60 array
      const sma30IdxPrev = (idx - 2) - 29;
      const sma60IdxPrev = (idx - 2) - 59;

      if (sma30Idx < 0 || sma60Idx < 0 || sma30IdxPrev < 0 || sma60IdxPrev < 0) continue;
      if (sma30Idx >= pd.sma30.length || sma60Idx >= pd.sma60.length) continue;
      if (sma30IdxPrev >= pd.sma30.length || sma60IdxPrev >= pd.sma60.length) continue;

      const s30now = pd.sma30[sma30Idx];
      const s60now = pd.sma60[sma60Idx];
      const s30prev = pd.sma30[sma30IdxPrev];
      const s60prev = pd.sma60[sma60IdxPrev];

      const crossLong = s30now > s60now && s30prev <= s60prev;
      const crossShort = s30now < s60now && s30prev >= s60prev;

      if (!crossLong && !crossShort) continue;

      // BTC filter
      if (crossLong && btcDir !== "long" && btcDir !== null) continue;
      if (crossShort && btcDir !== "short" && btcDir !== null) continue;

      const dir: "long" | "short" = crossLong ? "long" : "short";
      const ep = entryCost(p, dir, pd.daily[idx].o);
      let slDist = atr * 3;
      const maxSlDist = ep * 0.035;
      if (slDist > maxSlDist) slDist = maxSlDist;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      open.set(p, { pair: p, dir, ep, et: dayTs, sl });
    }
  }

  return trades;
}

// ─────────────────────────────────────────────────────────────────
// STATS HELPER
// ─────────────────────────────────────────────────────────────────
function calcStats(trades: Trade[], label: string, startTs: number, endTs: number) {
  const days = (endTs - startTs) / DAY;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
  const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // Daily P&L for Sharpe
  const dpMap = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / DAY);
    dpMap.set(day, (dpMap.get(day) || 0) + t.pnl);
  }
  const dpArr = [...dpMap.values()];
  const avgD = dpArr.reduce((s, r) => s + r, 0) / Math.max(dpArr.length, 1);
  const stdD = Math.sqrt(dpArr.reduce((s, r) => s + (r - avgD) ** 2, 0) / Math.max(dpArr.length - 1, 1));
  const sharpe = stdD > 0 ? (avgD / stdD) * Math.sqrt(252) : 0;

  // Max drawdown
  let cum = 0, pk = 0, maxDD = 0;
  const sorted = trades.slice().sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > pk) pk = cum;
    if (pk - cum > maxDD) maxDD = pk - cum;
  }

  return { label, n: trades.length, pnl, wr, pf, sharpe, maxDD, perDay: pnl / days, wins, losses };
}

function printStatLine(s: ReturnType<typeof calcStats>) {
  const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(1)}` : `-$${Math.abs(s.pnl).toFixed(1)}`;
  console.log(
    `${s.label.padEnd(30)} ${String(s.n).padStart(5)}  ${s.wr.toFixed(1).padStart(5)}%  ${pnlStr.padStart(10)}  ${s.pf.toFixed(2).padStart(5)}  ${s.sharpe.toFixed(2).padStart(6)}  $${s.maxDD.toFixed(1).padStart(7)}  $${s.perDay.toFixed(2).padStart(6)}`
  );
}

function printHeader() {
  console.log(`${"Config".padEnd(30)} ${"Trades".padStart(5)}  ${"WR%".padStart(6)}  ${"TotalPnL".padStart(10)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"MaxDD".padStart(8)}  ${"$/day".padStart(7)}`);
  console.log("-".repeat(95));
}

// ═════════════════════════════════════════════════════════════════
// TEST 1: Current 15 pairs vs All available
// ═════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(95));
console.log("TEST 1: GARCH MTF — Current 15 pairs vs All available pairs");
console.log("=".repeat(95));

const tradeable = ALL_PAIRS.filter(p => p !== "BTC");
const current15Filtered = CURRENT_15.filter(p => pairMTF.has(p));
const allFiltered = tradeable.filter(p => pairMTF.has(p));

console.log(`Current 15 (with data): ${current15Filtered.join(", ")}`);
console.log(`All tradeable (with data): ${allFiltered.join(", ")}`);
console.log();

// OOS only
const garch15 = runGarchMTF(current15Filtered, 5, OOS_START, FULL_END);
const garchAll = runGarchMTF(allFiltered, 5, OOS_START, FULL_END);

// Full period
const garch15Full = runGarchMTF(current15Filtered, 5, FULL_START, FULL_END);
const garchAllFull = runGarchMTF(allFiltered, 5, FULL_START, FULL_END);

console.log("--- OOS (2025-09-01 to 2026-03-26) ---");
printHeader();
printStatLine(calcStats(garch15, "Current 15 pairs", OOS_START, FULL_END));
printStatLine(calcStats(garchAll, "All available pairs", OOS_START, FULL_END));

console.log("\n--- Full Period (2023-01 to 2026-03) ---");
printHeader();
printStatLine(calcStats(garch15Full, "Current 15 pairs (full)", FULL_START, FULL_END));
printStatLine(calcStats(garchAllFull, "All available pairs (full)", FULL_START, FULL_END));

// Extra pairs contribution
const extraPairs = allFiltered.filter(p => !CURRENT_15.includes(p));
console.log(`\nExtra pairs not in current 15: ${extraPairs.join(", ")}`);
for (const p of extraPairs) {
  const t = garchAllFull.filter(t => t.pair === p);
  if (t.length > 0) {
    const pnl = t.reduce((s, tr) => s + tr.pnl, 0);
    console.log(`  ${p}: ${t.length} trades, PnL $${pnl.toFixed(1)}`);
  } else {
    console.log(`  ${p}: 0 trades`);
  }
}

// ═════════════════════════════════════════════════════════════════
// TEST 2: Position limit sweep (combined GARCH + Donchian)
// ═════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(95));
console.log("TEST 2: Position Limit Sweep (GARCH MTF + Daily Donchian combined)");
console.log("=".repeat(95));

const posLimits = [5, 8, 10, 15, 20, 999];
const posLabels = ["5", "8", "10", "15", "20", "Unlim"];

printHeader();
for (let i = 0; i < posLimits.length; i++) {
  const lim = posLimits[i];
  // Run both engines with same position limit, then merge
  const gTrades = runGarchMTF(allFiltered, 5, OOS_START, FULL_END, lim);
  const dTrades = runDailyDonchian(allFiltered, 5, OOS_START, FULL_END, lim);
  const combined = [...gTrades, ...dTrades];
  printStatLine(calcStats(combined, `MaxPos = ${posLabels[i]}`, OOS_START, FULL_END));
}

// Full period too
console.log("\n--- Full Period ---");
printHeader();
for (let i = 0; i < posLimits.length; i++) {
  const lim = posLimits[i];
  const gTrades = runGarchMTF(allFiltered, 5, FULL_START, FULL_END, lim);
  const dTrades = runDailyDonchian(allFiltered, 5, FULL_START, FULL_END, lim);
  const combined = [...gTrades, ...dTrades];
  printStatLine(calcStats(combined, `MaxPos = ${posLabels[i]}`, FULL_START, FULL_END));
}

// ═════════════════════════════════════════════════════════════════
// TEST 3: Optimal sizing split
// ═════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(95));
console.log("TEST 3: Sizing Split — GARCH / Donchian / SuperMTF allocation");
console.log("=".repeat(95));
console.log("(SuperMTF = GARCH MTF with relaxed thresholds: z1h>3.0, z4h>2.0 to simulate a 2nd MTF signal set)");
console.log();

// "Supertrend-like" engine = GARCH MTF with relaxed thresholds (more signals)
function runGarchRelaxed(
  pairs: string[], sz: number, startTs: number, endTs: number, maxPos = Infinity,
): Trade[] {
  const pd = new Map<string, PairMTF>();
  for (const p of pairs) { const d = pairMTF.get(p); if (d) pd.set(p, d); }

  const allTs = new Set<number>();
  for (const d of pd.values()) {
    for (const c of d.h1.candles) {
      if (c.t >= startTs && c.t < endTs) allTs.add(c.t);
    }
  }
  const sorted = [...allTs].sort((a, b) => a - b);
  const open = new Map<string, Position>();
  const trades: Trade[] = [];
  const NOT = sz * LEV;

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // EXITS
    for (const [p, pos] of open) {
      const d = pd.get(p)!;
      const bi = d.h1.tsMap.get(ts) ?? -1;
      if (bi < 0) continue;
      const bar = d.h1.candles[bi];
      const sp = SP[p] ?? 8e-4;
      let exitPrice = 0, reason = "";

      if (pos.direction === "long" && bar.l <= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 - sp * SL_SLIP); reason = "sl";
      } else if (pos.direction === "short" && bar.h >= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 + sp * SL_SLIP); reason = "sl";
      }

      if (!reason) {
        const barsHeld = Math.floor((ts - pos.entryTime) / H);
        if (barsHeld >= 168) {
          exitPrice = pos.direction === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }
      }

      if (reason) {
        const raw = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * NOT
          : (pos.entryPrice / exitPrice - 1) * NOT;
        trades.push({
          pair: p, dir: pos.direction, ep: pos.entryPrice, xp: exitPrice,
          et: pos.entryTime, xt: ts, pnl: raw - NOT * FEE * 2, reason, strat: "RELAXED",
        });
        open.delete(p);
        closedThisBar.add(p);
      }
    }

    // ENTRIES — relaxed thresholds
    for (const [p, d] of pd) {
      if (open.has(p) || closedThisBar.has(p)) continue;
      if (open.size >= maxPos) break;
      if (p === "BTC") continue;
      const bi = d.h1.tsMap.get(ts) ?? -1;
      if (bi < 60) continue;

      const prev = bi - 1;
      if (prev < VOL_WIN + MOM_LB) continue;
      const z1h = d.h1.zScores[prev];
      if (isNaN(z1h) || z1h === 0) continue;

      const goLong = z1h > 3.0;
      const goShort = z1h < -2.0;
      if (!goLong && !goShort) continue;

      const ts1h = d.h1.candles[prev].t;
      const ts4h = Math.floor(ts1h / H4) * H4;
      const idx4h = d.h4.tsMap.get(ts4h);
      if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) continue;
      const z4h = d.h4.zScores[idx4h];
      if (goLong && z4h <= 2.0) continue;
      if (goShort && z4h >= -2.0) continue;

      // EMA filter
      const e9 = gv(d.h1.ema9, prev, d.h1.candles.length);
      const e21 = gv(d.h1.ema21, prev, d.h1.candles.length);
      if (e9 === null || e21 === null) continue;
      if (goLong && e9 <= e21) continue;
      if (goShort && e9 >= e21) continue;

      // BTC filter
      const btcIdx = btcH1.tsMap.get(ts1h);
      if (btcIdx === undefined || btcIdx < 1) continue;
      const btcPrev = btcIdx - 1;
      const be9 = gv(btcH1.ema9, btcPrev, btcH1.candles.length);
      const be21 = gv(btcH1.ema21, btcPrev, btcH1.candles.length);
      if (be9 === null || be21 === null) continue;
      if (goLong && be9 <= be21) continue;
      if (goShort && be9 >= be21) continue;

      const dir: "long" | "short" = goLong ? "long" : "short";
      const entryRaw = d.h1.candles[bi].o;
      const sp = SP[p] ?? 8e-4;
      const entry = dir === "long" ? entryRaw * (1 + sp) : entryRaw * (1 - sp);
      const sl = dir === "long" ? entry * (1 - 0.04) : entry * (1 + 0.04);

      open.set(p, { pair: p, direction: dir, entryPrice: entry, entryTime: ts, stopLoss: sl });
    }
  }
  return trades;
}

const allocations = [
  { label: "Equal $5/$5/$5", garch: 5, donch: 5, relaxed: 5 },
  { label: "Relaxed heavy $3/$5/$7", garch: 3, donch: 5, relaxed: 7 },
  { label: "GARCH heavy $9/$3/$3", garch: 9, donch: 3, relaxed: 3 },
  { label: "Donchian heavy $3/$7/$5", garch: 3, donch: 7, relaxed: 5 },
];

console.log("--- OOS ---");
printHeader();
for (const a of allocations) {
  const g = runGarchMTF(allFiltered, a.garch, OOS_START, FULL_END);
  const d = runDailyDonchian(allFiltered, a.donch, OOS_START, FULL_END);
  const r = runGarchRelaxed(allFiltered, a.relaxed, OOS_START, FULL_END);
  const combined = [...g, ...d, ...r];
  printStatLine(calcStats(combined, a.label, OOS_START, FULL_END));
}

console.log("\n--- Full Period ---");
printHeader();
for (const a of allocations) {
  const g = runGarchMTF(allFiltered, a.garch, FULL_START, FULL_END);
  const d = runDailyDonchian(allFiltered, a.donch, FULL_START, FULL_END);
  const r = runGarchRelaxed(allFiltered, a.relaxed, FULL_START, FULL_END);
  const combined = [...g, ...d, ...r];
  printStatLine(calcStats(combined, a.label, FULL_START, FULL_END));
}

// ═════════════════════════════════════════════════════════════════
// TEST 4: Per-pair profitability across engines
// ═════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(95));
console.log("TEST 4: Per-Pair Profitability (OOS, $5 margin)");
console.log("=".repeat(95));

// Run all 3 engines on all pairs OOS
const garchPerPair = runGarchMTF(allFiltered, 5, OOS_START, FULL_END);
const donchPerPair = runDailyDonchian(allFiltered, 5, OOS_START, FULL_END);
const relaxedPerPair = runGarchRelaxed(allFiltered, 5, OOS_START, FULL_END);

// Build per-pair stats
interface PairEngineStats { trades: number; pnl: number; pf: number; wr: number }

function pairStats(trades: Trade[], pair: string): PairEngineStats {
  const pt = trades.filter(t => t.pair === pair);
  if (pt.length === 0) return { trades: 0, pnl: 0, pf: 0, wr: 0 };
  const pnl = pt.reduce((s, t) => s + t.pnl, 0);
  const wins = pt.filter(t => t.pnl > 0).length;
  const gw = pt.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(pt.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  return { trades: pt.length, pnl, pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, wr: wins / pt.length * 100 };
}

console.log(`${"Pair".padEnd(8)} | ${"GARCH MTF".padEnd(25)} | ${"Donchian Daily".padEnd(25)} | ${"Relaxed MTF".padEnd(25)} | ${"Total".padEnd(10)}`);
console.log("-".repeat(105));

const pairTotals: { pair: string; totalPnl: number; totalTrades: number }[] = [];

for (const p of allFiltered.sort()) {
  const gs = pairStats(garchPerPair, p);
  const ds = pairStats(donchPerPair, p);
  const rs = pairStats(relaxedPerPair, p);
  const totalPnl = gs.pnl + ds.pnl + rs.pnl;
  const totalTrades = gs.trades + ds.trades + rs.trades;
  pairTotals.push({ pair: p, totalPnl, totalTrades });

  const fmtStat = (s: PairEngineStats) => {
    if (s.trades === 0) return "     --        ".padEnd(25);
    const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(1)}` : `-$${Math.abs(s.pnl).toFixed(1)}`;
    return `${String(s.trades).padStart(3)}t ${pnlStr.padStart(8)} PF${s.pf.toFixed(1).padStart(4)}`.padEnd(25);
  };

  const totalStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(1)}` : `-$${Math.abs(totalPnl).toFixed(1)}`;
  console.log(`${p.padEnd(8)} | ${fmtStat(gs)} | ${fmtStat(ds)} | ${fmtStat(rs)} | ${totalStr.padStart(10)}`);
}

// Summary: pairs to drop
console.log("\n--- Recommendation ---");
const losers = pairTotals.filter(p => p.totalPnl < 0 && p.totalTrades >= 3).sort((a, b) => a.totalPnl - b.totalPnl);
const winners = pairTotals.filter(p => p.totalPnl > 0).sort((a, b) => b.totalPnl - a.totalPnl);

if (losers.length > 0) {
  console.log("Pairs to consider dropping (negative PnL, 3+ trades):");
  for (const p of losers) {
    console.log(`  ${p.pair}: ${p.totalTrades} trades, $${p.totalPnl.toFixed(1)}`);
  }
} else {
  console.log("No consistently losing pairs found.");
}
console.log("\nTop performing pairs:");
for (const p of winners.slice(0, 5)) {
  console.log(`  ${p.pair}: ${p.totalTrades} trades, +$${p.totalPnl.toFixed(1)}`);
}

// Full-period per-pair check too
console.log("\n" + "=".repeat(95));
console.log("TEST 4b: Per-Pair Profitability (FULL PERIOD, $5 margin)");
console.log("=".repeat(95));

const garchFull = runGarchMTF(allFiltered, 5, FULL_START, FULL_END);
const donchFull = runDailyDonchian(allFiltered, 5, FULL_START, FULL_END);
const relaxedFull = runGarchRelaxed(allFiltered, 5, FULL_START, FULL_END);

console.log(`${"Pair".padEnd(8)} | ${"GARCH MTF".padEnd(25)} | ${"Donchian Daily".padEnd(25)} | ${"Relaxed MTF".padEnd(25)} | ${"Total".padEnd(10)}`);
console.log("-".repeat(105));

const pairTotalsFull: { pair: string; totalPnl: number; totalTrades: number }[] = [];

for (const p of allFiltered.sort()) {
  const gs = pairStats(garchFull, p);
  const ds = pairStats(donchFull, p);
  const rs = pairStats(relaxedFull, p);
  const totalPnl = gs.pnl + ds.pnl + rs.pnl;
  const totalTrades = gs.trades + ds.trades + rs.trades;
  pairTotalsFull.push({ pair: p, totalPnl, totalTrades });

  const fmtStat = (s: PairEngineStats) => {
    if (s.trades === 0) return "     --        ".padEnd(25);
    const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(1)}` : `-$${Math.abs(s.pnl).toFixed(1)}`;
    return `${String(s.trades).padStart(3)}t ${pnlStr.padStart(8)} PF${s.pf.toFixed(1).padStart(4)}`.padEnd(25);
  };

  const totalStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(1)}` : `-$${Math.abs(totalPnl).toFixed(1)}`;
  console.log(`${p.padEnd(8)} | ${fmtStat(gs)} | ${fmtStat(ds)} | ${fmtStat(rs)} | ${totalStr.padStart(10)}`);
}

const losersFull = pairTotalsFull.filter(p => p.totalPnl < 0 && p.totalTrades >= 5).sort((a, b) => a.totalPnl - b.totalPnl);
if (losersFull.length > 0) {
  console.log("\nFull-period losers (5+ trades):");
  for (const p of losersFull) {
    console.log(`  ${p.pair}: ${p.totalTrades} trades, $${p.totalPnl.toFixed(1)}`);
  }
}

console.log("\nDone.");
