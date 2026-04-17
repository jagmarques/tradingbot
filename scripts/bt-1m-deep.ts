/**
 * Deep 1m sweep: no 1h gate, trail checked every 1m bar
 * Tests wider trails, no-trail (SL-only), TP targets, breakeven stops
 */
import * as fs from "fs";

const CACHE_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
const MARGIN = 15;
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
console.log(`${timepoints.length} timepoints`);
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
  trailA: number; trailD: number; // 0/0 = no trail
  tpPct: number; // 0 = no TP
  bePct: number; // 0 = no breakeven, else move SL to entry at this leveraged %
  maxHoldH: number;
  cdH: number;
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

      // Max hold
      if ((ts - pos.entryTime) / H >= cfg.maxHoldH) { exitPrice = bar.c; reason = "maxh"; }

      // SL
      if (!exitPrice && bar.l <= pos.stopLoss) { exitPrice = pos.stopLoss; reason = "sl"; }

      // Track peak
      const bestLevPnl = (bar.h / pos.entryPrice - 1) * pos.leverage * 100;
      if (bestLevPnl > pos.peakLevPnlPct) pos.peakLevPnlPct = bestLevPnl;

      // Breakeven: move SL to entry when peak reaches bePct
      if (!pos.beTriggered && cfg.bePct > 0 && pos.peakLevPnlPct >= cfg.bePct) {
        pos.stopLoss = pos.entryPrice;
        pos.beTriggered = true;
      }

      // TP: close at fixed leveraged profit %
      if (!exitPrice && cfg.tpPct > 0) {
        const currentLevPnl = (bar.h / pos.entryPrice - 1) * pos.leverage * 100;
        if (currentLevPnl >= cfg.tpPct) {
          exitPrice = pos.entryPrice * (1 + cfg.tpPct / 100 / pos.leverage);
          reason = "tp";
        }
      }

      // Trail (every 1m bar)
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

    // MTM
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

    // Entry at 1h boundaries
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
      if (z1 <= 1.5) continue;
      const z4 = get4hZ(p, ts);
      if (z4 <= 1.0) continue;
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

// A) Trail-only configs (wider trails)
for (const mc of [5, 7, 10, 15]) {
  for (const sl of [
    { low: 0.003, high: 0.005, l: "0.30/0.50" },
    { low: 0.005, high: 0.008, l: "0.50/0.80" },
    { low: 0.008, high: 0.01, l: "0.80/1.0" },
    { low: 0.01, high: 0.015, l: "1.0/1.5" },
  ]) {
    for (const trail of [
      { a: 10, d: 5, l: "10/5" }, { a: 15, d: 5, l: "15/5" }, { a: 20, d: 5, l: "20/5" },
      { a: 20, d: 8, l: "20/8" }, { a: 20, d: 10, l: "20/10" }, { a: 30, d: 10, l: "30/10" },
      { a: 30, d: 15, l: "30/15" }, { a: 50, d: 20, l: "50/20" },
    ]) {
      for (const cd of [2, 4]) {
        for (const mh of [72, 120, 999]) {
          configs.push({ label: `mc${mc} ${sl.l} T${trail.l} cd${cd}h mh${mh}`, cfg: { mc, slLow: sl.low, slHigh: sl.high, trailA: trail.a, trailD: trail.d, tpPct: 0, bePct: 0, maxHoldH: mh, cdH: cd } });
        }
      }
    }
  }
}

// B) TP-only (no trail, fixed take profit)
for (const mc of [5, 7, 10, 15]) {
  for (const sl of [
    { low: 0.003, high: 0.005, l: "0.30/0.50" },
    { low: 0.005, high: 0.008, l: "0.50/0.80" },
    { low: 0.01, high: 0.015, l: "1.0/1.5" },
  ]) {
    for (const tp of [3, 5, 8, 10, 15, 20, 30]) {
      for (const cd of [2, 4]) {
        configs.push({ label: `mc${mc} ${sl.l} TP${tp}% cd${cd}h`, cfg: { mc, slLow: sl.low, slHigh: sl.high, trailA: 0, trailD: 0, tpPct: tp, bePct: 0, maxHoldH: 120, cdH: cd } });
      }
    }
  }
}

// C) BE + Trail (breakeven then trail)
for (const mc of [5, 7, 10, 15]) {
  for (const sl of [
    { low: 0.003, high: 0.005, l: "0.30/0.50" },
    { low: 0.005, high: 0.008, l: "0.50/0.80" },
  ]) {
    for (const be of [3, 5, 8]) {
      for (const trail of [
        { a: 10, d: 5, l: "10/5" }, { a: 15, d: 5, l: "15/5" }, { a: 20, d: 10, l: "20/10" },
        { a: 30, d: 10, l: "30/10" }, { a: 50, d: 20, l: "50/20" },
      ]) {
        configs.push({ label: `mc${mc} ${sl.l} BE${be}% T${trail.l} cd4h`, cfg: { mc, slLow: sl.low, slHigh: sl.high, trailA: trail.a, trailD: trail.d, tpPct: 0, bePct: be, maxHoldH: 120, cdH: 4 } });
      }
    }
  }
}

// D) BE + TP (breakeven then take profit)
for (const mc of [5, 7, 10, 15]) {
  for (const sl of [
    { low: 0.005, high: 0.008, l: "0.50/0.80" },
    { low: 0.01, high: 0.015, l: "1.0/1.5" },
  ]) {
    for (const be of [3, 5]) {
      for (const tp of [10, 15, 20, 30, 50]) {
        configs.push({ label: `mc${mc} ${sl.l} BE${be}% TP${tp}% cd4h`, cfg: { mc, slLow: sl.low, slHigh: sl.high, trailA: 0, trailD: 0, tpPct: tp, bePct: be, maxHoldH: 120, cdH: 4 } });
      }
    }
  }
}

// E) No trail, no TP (SL + max hold only)
for (const mc of [5, 7, 10, 15]) {
  for (const sl of [
    { low: 0.005, high: 0.008, l: "0.50/0.80" },
    { low: 0.01, high: 0.015, l: "1.0/1.5" },
    { low: 0.015, high: 0.02, l: "1.5/2.0" },
  ]) {
    for (const mh of [24, 48, 72, 120]) {
      for (const cd of [2, 4]) {
        configs.push({ label: `mc${mc} ${sl.l} SLonly mh${mh} cd${cd}h`, cfg: { mc, slLow: sl.low, slHigh: sl.high, trailA: 0, trailD: 0, tpPct: 0, bePct: 0, maxHoldH: mh, cdH: cd } });
      }
    }
  }
}

console.log(`\nSweeping ${configs.length} configs (1m resolution)...\n`);

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
console.log("TOP 30 BY $/DAY");
console.log("=".repeat(90));
results.sort((a, b) => b.pnlDay - a.pnlDay);
console.log(`${"Config".padEnd(50)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of results.slice(0, 30)) {
  console.log(`${r.label.padEnd(50)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\n${"=".repeat(90)}`);
console.log("TOP 30 BY CALMAR");
console.log("=".repeat(90));
results.sort((a, b) => b.calmar - a.calmar);
console.log(`${"Config".padEnd(50)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of results.slice(0, 30)) {
  console.log(`${r.label.padEnd(50)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\n${"=".repeat(90)}`);
console.log("TOP 20 BY $/DAY (MDD < $60)");
console.log("=".repeat(90));
const safe = results.filter(r => r.mdd < 60);
safe.sort((a, b) => b.pnlDay - a.pnlDay);
console.log(`${"Config".padEnd(50)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of safe.slice(0, 20)) {
  console.log(`${r.label.padEnd(50)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\nTotal configs tested: ${configs.length}`);
