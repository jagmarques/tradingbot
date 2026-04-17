/**
 * Test tighter entries (higher z-score) to find low-MDD same-profit configs
 * 1m resolution with breakeven stop
 */
import * as fs from "fs";

const CACHE_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
const MARGIN = 15;
const MAX_HOLD_H = 120;
const BLOCK_HOURS = new Set([22, 23]);
const LB = 1;

const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();
const OOS_DAYS = (OOS_END - OOS_START) / D;

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1e-4, SOL: 2e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  NEAR: 3.5e-4, FET: 4e-4,
};
const DEFAULT_SPREAD = 5e-4;
const RENAME: Record<string, string> = { kPEPE: "1000PEPE" };

const leverageMap = new Map<string, number>();
for (const line of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [name, val] = line.split(":");
  leverageMap.set(name!, parseInt(val!));
}
function getLeverage(pair: string): number { return Math.min(leverageMap.get(pair) ?? 3, 10); }

const ALL_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","FET","FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR","PENDLE","PNUT","ATOM","TON","SEI","STX",
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN","TNSR","CATI","TURBO","MOVE","GALA","STRK","SAGA","ILV","GMX","OM",
  "CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC","USUAL","UMA","USTC","MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS","MINA","LISTA","NEO","AI","SCR","APE","KAITO","AR","BNT","PIXEL",
  "LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET","STG","REQ","CAKE","SUPER","FTT","STRAX",
];

interface Candle { t: number; o: number; h: number; l: number; c: number; }
interface PairData {
  name: string; h1: Candle[]; h4: Candle[]; m1: Candle[];
  z1h: number[]; z4h: number[];
  h1Map: Map<number, number>; m1Map: Map<number, number>;
  spread: number; leverage: number;
}
interface Position {
  pair: string; entryPrice: number; entryTime: number; stopLoss: number;
  peakLevPnlPct: number; spread: number; leverage: number; notional: number;
  beTriggered: boolean;
}

function loadCandles(symbol: string): Candle[] {
  try { return JSON.parse(fs.readFileSync(`${CACHE_1M}/${symbol}.json`, "utf8")); }
  catch { return []; }
}

function aggregate(raw: Candle[], intervalMs: number, minBars: number): Candle[] {
  const bars: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of raw) {
    const t = Math.floor(c.t / intervalMs) * intervalMs;
    if (!cur || cur.t !== t) {
      if (cur) bars.push(cur);
      cur = { t, o: c.o, h: c.h, l: c.l, c: c.c };
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
    }
  }
  if (cur) bars.push(cur);
  return bars.length >= minBars ? bars : [];
}

function computeZScores(candles: Candle[], vw: number): number[] {
  const z: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < vw + LB + 1) { z.push(0); continue; }
    const momentum = candles[i]!.c / candles[i - LB]!.c - 1;
    const returns: number[] = [];
    for (let j = Math.max(1, i - vw); j <= i; j++) {
      returns.push(candles[j]!.c / candles[j - 1]!.c - 1);
    }
    const volatility = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
    z.push(volatility === 0 ? 0 : momentum / volatility);
  }
  return z;
}

console.log("Loading 1m data...");
const pairs: PairData[] = [];
for (const name of ALL_PAIRS) {
  const symbol = RENAME[name] ?? name;
  let raw = loadCandles(`${symbol}USDT`);
  if (raw.length < 5000) raw = loadCandles(`${name}USDT`);
  if (raw.length < 5000) continue;
  const h1 = aggregate(raw, H, 200);
  const h4 = aggregate(raw, H4, 50);
  if (h1.length < 200 || h4.length < 50) continue;
  const z1h = computeZScores(h1, 15);
  const z4h = computeZScores(h4, 20);
  const h1Map = new Map<number, number>();
  h1.forEach((c, i) => h1Map.set(c.t, i));
  const m1 = raw.filter(b => b.t >= OOS_START - 24 * H && b.t <= OOS_END + 24 * H);
  const m1Map = new Map<number, number>();
  m1.forEach((c, i) => m1Map.set(c.t, i));
  pairs.push({ name, h1, h4, m1, z1h, z4h, h1Map, m1Map, spread: SP[name] ?? DEFAULT_SPREAD, leverage: getLeverage(name) });
}
console.log(`${pairs.length} pairs loaded`);

const allTimestamps = new Set<number>();
for (const p of pairs) {
  for (const b of p.m1) {
    if (b.t >= OOS_START && b.t < OOS_END) allTimestamps.add(b.t);
  }
}
const timepoints = [...allTimestamps].sort((a, b) => a - b);
const pairByName = new Map<string, PairData>();
pairs.forEach(p => pairByName.set(p.name, p));

function get4hZ(p: PairData, ts: number): number {
  let lo = 0, hi = p.h4.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (p.h4[m]!.t < ts) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? p.z4h[best]! : 0;
}

interface Config {
  mc: number; slLow: number; slHigh: number;
  trailA: number; trailD: number; bePct: number;
  z1h: number; z4h: number; cdH: number;
}

function simulate(cfg: Config): { pnlDay: number; mdd: number; pf: number; wr: number; trades: number; calmar: number } {
  const openPositions: Position[] = [];
  let realizedPnl = 0, mtmPeak = 0, mtmMaxDD = 0;
  let totalTrades = 0, totalWins = 0, grossProfit = 0, grossLoss = 0;
  const cooldowns = new Map<string, number>();

  for (const ts of timepoints) {
    const isH1Boundary = ts % H === 0;

    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const pd = pairByName.get(pos.pair)!;
      const bi = pd.m1Map.get(ts);
      if (bi === undefined) continue;
      const bar = pd.m1[bi]!;
      let exitPrice = 0, reason = "";

      if ((ts - pos.entryTime) / H >= MAX_HOLD_H) { exitPrice = bar.c; reason = "maxh"; }
      if (!exitPrice && bar.l <= pos.stopLoss) { exitPrice = pos.stopLoss; reason = "sl"; }

      const bestLevPnl = (bar.h / pos.entryPrice - 1) * pos.leverage * 100;
      if (bestLevPnl > pos.peakLevPnlPct) pos.peakLevPnlPct = bestLevPnl;

      if (!pos.beTriggered && cfg.bePct > 0 && pos.peakLevPnlPct >= cfg.bePct) {
        pos.stopLoss = pos.entryPrice;
        pos.beTriggered = true;
      }

      if (!exitPrice && cfg.trailA > 0) {
        const currentLevPnl = (bar.c / pos.entryPrice - 1) * pos.leverage * 100;
        if (pos.peakLevPnlPct >= cfg.trailA && currentLevPnl <= pos.peakLevPnlPct - cfg.trailD) {
          exitPrice = bar.c; reason = "trail";
        }
      }

      if (exitPrice > 0) {
        const exitSpread = reason === "sl" ? pos.spread * 1.5 : pos.spread;
        const fillPrice = exitPrice * (1 - exitSpread);
        const pnl = (fillPrice / pos.entryPrice - 1) * pos.notional - pos.notional * FEE * 2;
        openPositions.splice(i, 1);
        realizedPnl += pnl;
        totalTrades++;
        if (pnl > 0) { totalWins++; grossProfit += pnl; } else { grossLoss += Math.abs(pnl); }
        if (reason === "sl") cooldowns.set(`${pos.pair}:long`, ts + cfg.cdH * H);
      }
    }

    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      const pd = pairByName.get(pos.pair)!;
      const bi = pd.m1Map.get(ts);
      if (bi === undefined) continue;
      const bar = pd.m1[bi]!;
      unrealizedPnl += (bar.c * (1 - pos.spread) / pos.entryPrice - 1) * pos.notional - pos.notional * FEE * 2;
    }
    const totalEquity = realizedPnl + unrealizedPnl;
    if (totalEquity > mtmPeak) mtmPeak = totalEquity;
    if (mtmPeak - totalEquity > mtmMaxDD) mtmMaxDD = mtmPeak - totalEquity;

    if (!isH1Boundary) continue;
    if (BLOCK_HOURS.has(new Date(ts).getUTCHours())) continue;
    if (openPositions.length >= cfg.mc) continue;

    for (const p of pairs) {
      if (openPositions.length >= cfg.mc) break;
      if (openPositions.some(pos => pos.pair === p.name)) continue;
      const cdUntil = cooldowns.get(`${p.name}:long`);
      if (cdUntil && ts < cdUntil) continue;
      const h1Idx = p.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 20) continue;
      const z1 = p.z1h[h1Idx - 1]!;
      if (z1 <= cfg.z1h) continue;
      const z4 = get4hZ(p, ts);
      if (z4 <= cfg.z4h) continue;
      const entryPrice = p.h1[h1Idx]!.o * (1 + p.spread);
      const slPct = p.leverage >= 10 ? cfg.slHigh : cfg.slLow;
      const stopLoss = entryPrice * (1 - slPct);
      const notional = MARGIN * p.leverage;
      openPositions.push({ pair: p.name, entryPrice, entryTime: ts, stopLoss, peakLevPnlPct: 0, spread: p.spread, leverage: p.leverage, notional, beTriggered: false });
    }
  }

  const pnlDay = realizedPnl / OOS_DAYS;
  const wr = totalTrades > 0 ? totalWins / totalTrades * 100 : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const calmar = mtmMaxDD > 0 ? pnlDay / mtmMaxDD : 0;
  return { pnlDay, mdd: mtmMaxDD, pf, wr, trades: totalTrades, calmar };
}

const configs: { label: string; cfg: Config }[] = [];

// Quality entries: higher z-score thresholds
const zPairs = [
  { z1: 1.5, z4: 1.0 }, { z1: 2.0, z4: 1.0 }, { z1: 2.0, z4: 1.5 },
  { z1: 2.5, z4: 1.5 }, { z1: 2.5, z4: 2.0 }, { z1: 3.0, z4: 2.0 },
];
for (const mc of [5, 7, 10]) {
  for (const sl of [
    { l: 0.01, h: 0.015, lbl: "1.0/1.5" },
    { l: 0.015, h: 0.02, lbl: "1.5/2.0" },
    { l: 0.02, h: 0.025, lbl: "2.0/2.5" },
  ]) {
    for (const trail of [
      { a: 10, d: 3, l: "10/3" }, { a: 10, d: 5, l: "10/5" },
      { a: 15, d: 5, l: "15/5" }, { a: 15, d: 8, l: "15/8" },
      { a: 20, d: 8, l: "20/8" },
    ]) {
      for (const be of [0, 3, 5, 8]) {
        for (const z of zPairs) {
          configs.push({
            label: `mc${mc} z${z.z1}/${z.z4} SL${sl.lbl} T${trail.l} BE${be}% cd4h`,
            cfg: { mc, slLow: sl.l, slHigh: sl.h, trailA: trail.a, trailD: trail.d, bePct: be, z1h: z.z1, z4h: z.z4, cdH: 4 },
          });
        }
      }
    }
  }
}

console.log(`\nSweeping ${configs.length} quality configs (1m)...\n`);

interface Result { label: string; pnlDay: number; mdd: number; pf: number; wr: number; trades: number; calmar: number }
const results: Result[] = [];

for (let i = 0; i < configs.length; i++) {
  if ((i + 1) % 10 === 0) process.stdout.write(`\r${i + 1}/${configs.length}`);
  const c = configs[i]!;
  const r = simulate(c.cfg);
  if (r.trades < 50) continue;
  results.push({ label: c.label, ...r });
}

console.log(`\n\n${"=".repeat(90)}`);
console.log("TOP 30 BY CALMAR (best edge efficiency)");
console.log("=".repeat(90));
results.sort((a, b) => b.calmar - a.calmar);
console.log(`${"Config".padEnd(55)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of results.slice(0, 30)) {
  console.log(`${r.label.padEnd(55)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\n${"=".repeat(90)}`);
console.log("TOP 20 $/DAY >= $3.86 AND MDD < $40");
console.log("=".repeat(90));
const target = results.filter(r => r.pnlDay >= 3.86 && r.mdd < 40);
target.sort((a, b) => b.pnlDay - a.pnlDay);
if (target.length === 0) {
  console.log("  NONE - can't get $3.86/day with MDD < $40");
} else {
  console.log(`${"Config".padEnd(55)} $/day   MDD    PF   WR%  Trades Calmar`);
  for (const r of target.slice(0, 20)) {
    console.log(`${r.label.padEnd(55)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
  }
}

console.log(`\n${"=".repeat(90)}`);
console.log("TOP 20 $/DAY >= $3.0 AND MDD < $30");
console.log("=".repeat(90));
const low = results.filter(r => r.pnlDay >= 3.0 && r.mdd < 30);
low.sort((a, b) => b.pnlDay - a.pnlDay);
if (low.length === 0) {
  console.log("  NONE - can't get $3.0/day with MDD < $30");
} else {
  console.log(`${"Config".padEnd(55)} $/day   MDD    PF   WR%  Trades Calmar`);
  for (const r of low.slice(0, 20)) {
    console.log(`${r.label.padEnd(55)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
  }
}

console.log(`\nTotal configs tested: ${configs.length}`);
