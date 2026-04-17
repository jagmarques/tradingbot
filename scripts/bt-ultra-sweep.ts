/**
 * Ultra sweep: unexplored dimensions on best base configs
 * Tests: trail combos on vw20/vw50, cooldown values, SL granular,
 * mixed vol windows (1h=vw20, 4h=different), entry delays,
 * partial close at TP, direction filter (long-only vs both)
 */
import * as fs from "fs";

const CACHE = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
const MARGIN = 15;
const MAX_HOLD_H = 120;
const BLOCK_HOURS = new Set([22, 23]);

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
  name: string; h1: Candle[]; h4: Candle[]; m5: Candle[];
  h1Map: Map<number, number>; m5Map: Map<number, number>;
  spread: number; leverage: number;
}
interface Position {
  pair: string; entryPrice: number; entryTime: number; stopLoss: number;
  peakLevPnlPct: number; spread: number; leverage: number; notional: number;
  direction: string;
}

function loadCandles(symbol: string): Candle[] {
  try { return JSON.parse(fs.readFileSync(`${CACHE}/${symbol}.json`, "utf8")); }
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

function computeZScores(candles: Candle[], lb: number, vw: number): number[] {
  const z: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < vw + lb + 1) { z.push(0); continue; }
    const momentum = candles[i]!.c / candles[i - lb]!.c - 1;
    const returns: number[] = [];
    for (let j = Math.max(1, i - vw); j <= i; j++) {
      returns.push(candles[j]!.c / candles[j - 1]!.c - 1);
    }
    const volatility = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
    z.push(volatility === 0 ? 0 : momentum / volatility);
  }
  return z;
}

console.log("Loading data...");
const pairs: PairData[] = [];
for (const name of ALL_PAIRS) {
  const symbol = RENAME[name] ?? name;
  let raw = loadCandles(`${symbol}USDT`);
  if (raw.length < 5000) raw = loadCandles(`${name}USDT`);
  if (raw.length < 5000) continue;
  const h1 = aggregate(raw, H, 900);
  const h4 = aggregate(raw, H4, 50);
  if (h1.length < 900 || h4.length < 50) continue;
  const h1Map = new Map<number, number>();
  h1.forEach((c, i) => h1Map.set(c.t, i));
  const m5 = raw.filter(b => b.t >= OOS_START - 24 * H && b.t <= OOS_END + 24 * H);
  const m5Map = new Map<number, number>();
  m5.forEach((c, i) => m5Map.set(c.t, i));
  pairs.push({ name, h1, h4, m5, h1Map, m5Map, spread: SP[name] ?? DEFAULT_SPREAD, leverage: getLeverage(name) });
}
console.log(`${pairs.length} pairs loaded`);

// Precompute z-scores for needed lb/vw combos
const vwsToTest = [15, 20, 25, 30, 40, 50];
const lbsToTest = [1, 2];
console.log("Precomputing z-scores...");
const zCache1h = new Map<string, number[]>();
const zCache4h = new Map<string, number[]>();
for (const p of pairs) {
  for (const lb of lbsToTest) {
    for (const vw of vwsToTest) {
      const key = `${p.name}:${lb}:${vw}`;
      zCache1h.set(key, computeZScores(p.h1, lb, vw));
      zCache4h.set(key, computeZScores(p.h4, lb, vw));
    }
  }
}
console.log("Z-scores ready");

const allTimestamps = new Set<number>();
for (const p of pairs) {
  for (const b of p.m5) {
    if (b.t >= OOS_START && b.t < OOS_END) allTimestamps.add(b.t);
  }
}
const timepoints = [...allTimestamps].sort((a, b) => a - b);
const pairByName = new Map<string, PairData>();
pairs.forEach(p => pairByName.set(p.name, p));

function get4hZ(p: PairData, ts: number, zArr: number[]): number {
  let lo = 0, hi = p.h4.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (p.h4[m]!.t < ts) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? zArr[best]! : 0;
}

interface Config {
  lb: number; vw1h: number; vw4h: number; mc: number;
  slLow: number; slHigh: number;
  z1h: number; z4h: number;
  trail: { a: number; d: number }[];
  cdH: number;
  allowShorts: boolean;
}

function simulate(cfg: Config): { pnlDay: number; mdd: number; pf: number; wr: number; trades: number; calmar: number } {
  const openPositions: Position[] = [];
  let realizedPnl = 0, mtmPeak = 0, mtmMaxDD = 0;
  let totalTrades = 0, totalWins = 0, grossProfit = 0, grossLoss = 0;
  const cooldowns = new Map<string, number>();

  const z1hKey = (name: string) => `${name}:${cfg.lb}:${cfg.vw1h}`;
  const z4hKey = (name: string) => `${name}:${cfg.lb}:${cfg.vw4h}`;

  for (const ts of timepoints) {
    const isH1Boundary = ts % H === 0;

    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const pd = pairByName.get(pos.pair)!;
      const bi = pd.m5Map.get(ts);
      if (bi === undefined) continue;
      const bar = pd.m5[bi]!;
      let exitPrice = 0, reason = "";

      if ((ts - pos.entryTime) / H >= MAX_HOLD_H) { exitPrice = bar.c; reason = "maxh"; }

      if (!exitPrice) {
        if (pos.direction === "long" && bar.l <= pos.stopLoss) { exitPrice = pos.stopLoss; reason = "sl"; }
        if (pos.direction === "short" && bar.h >= pos.stopLoss) { exitPrice = pos.stopLoss; reason = "sl"; }
      }

      const levPnl = pos.direction === "long"
        ? (bar.h / pos.entryPrice - 1) * pos.leverage * 100
        : (1 - bar.l / pos.entryPrice) * pos.leverage * 100;
      if (levPnl > pos.peakLevPnlPct) pos.peakLevPnlPct = levPnl;

      if (!exitPrice && isH1Boundary) {
        const currentLevPnl = pos.direction === "long"
          ? (bar.c / pos.entryPrice - 1) * pos.leverage * 100
          : (1 - bar.c / pos.entryPrice) * pos.leverage * 100;
        let trailDist = Infinity;
        for (const step of cfg.trail) {
          if (pos.peakLevPnlPct >= step.a) { trailDist = step.d; break; }
        }
        if (trailDist < Infinity && currentLevPnl <= pos.peakLevPnlPct - trailDist) { exitPrice = bar.c; reason = "trail"; }
      }

      if (exitPrice > 0) {
        const exitSpread = reason === "sl" ? pos.spread * 1.5 : pos.spread;
        const fillPrice = pos.direction === "long" ? exitPrice * (1 - exitSpread) : exitPrice * (1 + exitSpread);
        const pnl = pos.direction === "long"
          ? (fillPrice / pos.entryPrice - 1) * pos.notional - pos.notional * FEE * 2
          : (1 - fillPrice / pos.entryPrice) * pos.notional - pos.notional * FEE * 2;
        openPositions.splice(i, 1);
        realizedPnl += pnl;
        totalTrades++;
        if (pnl > 0) { totalWins++; grossProfit += pnl; } else { grossLoss += Math.abs(pnl); }
        if (reason === "sl") cooldowns.set(`${pos.pair}:${pos.direction}`, ts + cfg.cdH * H);
      }
    }

    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      const pd = pairByName.get(pos.pair)!;
      const bi = pd.m5Map.get(ts);
      if (bi === undefined) continue;
      const bar = pd.m5[bi]!;
      const uPnl = pos.direction === "long"
        ? (bar.c * (1 - pos.spread) / pos.entryPrice - 1) * pos.notional - pos.notional * FEE * 2
        : (1 - bar.c * (1 + pos.spread) / pos.entryPrice) * pos.notional - pos.notional * FEE * 2;
      unrealizedPnl += uPnl;
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

      const h1Idx = p.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < Math.max(cfg.vw1h, cfg.vw4h) + cfg.lb + 2) continue;

      const z1hArr = zCache1h.get(z1hKey(p.name))!;
      const z4hArr = zCache4h.get(z4hKey(p.name))!;
      const z1 = z1hArr[h1Idx - 1]!;
      const z4 = get4hZ(p, ts, z4hArr);

      let direction = "";
      if (z1 > cfg.z1h && z4 > cfg.z4h) direction = "long";
      else if (cfg.allowShorts && z1 < -cfg.z1h && z4 < -cfg.z4h) direction = "short";
      if (!direction) continue;

      const cdUntil = cooldowns.get(`${p.name}:${direction}`);
      if (cdUntil && ts < cdUntil) continue;

      const entryPrice = direction === "long"
        ? p.h1[h1Idx]!.o * (1 + p.spread)
        : p.h1[h1Idx]!.o * (1 - p.spread);
      const slPct = p.leverage >= 10 ? cfg.slHigh : cfg.slLow;
      const stopLoss = direction === "long" ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);
      const notional = MARGIN * p.leverage;
      openPositions.push({ pair: p.name, entryPrice, entryTime: ts, stopLoss, peakLevPnlPct: 0, spread: p.spread, leverage: p.leverage, notional, direction });
    }
  }

  const pnlDay = realizedPnl / OOS_DAYS;
  const wr = totalTrades > 0 ? totalWins / totalTrades * 100 : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const calmar = mtmMaxDD > 0 ? pnlDay / mtmMaxDD : 0;
  return { pnlDay, mdd: mtmMaxDD, pf, wr, trades: totalTrades, calmar };
}

// Configs to sweep
interface SweepConfig {
  label: string;
  cfg: Config;
}

const configs: SweepConfig[] = [];

// Dimension 1: Mixed vol windows (1h uses one vw, 4h uses different vw)
for (const vw1h of [15, 20, 25, 30]) {
  for (const vw4h of [15, 20, 25, 30, 40, 50]) {
    for (const mc of [5, 7, 10, 15]) {
      for (const sl of [
        { low: 0.0015, high: 0.003, label: "0.15/0.30" },
        { low: 0.002, high: 0.004, label: "0.20/0.40" },
        { low: 0.0025, high: 0.0045, label: "0.25/0.45" },
        { low: 0.003, high: 0.005, label: "0.30/0.50" },
      ]) {
        for (const cd of [0, 1, 2, 4]) {
          for (const trail of [
            { t: [{ a: 2, d: 1.5 }], label: "2/1.5" },
            { t: [{ a: 1.5, d: 1.5 }], label: "1.5/1.5" },
            { t: [{ a: 3, d: 2.0 }], label: "3/2" },
            { t: [{ a: 2, d: 1.0 }], label: "2/1" },
            { t: [{ a: 1, d: 1.0 }], label: "1/1" },
            { t: [{ a: 5, d: 2.0 }], label: "5/2" },
          ]) {
            // Long-only
            configs.push({
              label: `lb1 1h:vw${vw1h} 4h:vw${vw4h} mc${mc} ${sl.label} cd${cd}h ${trail.label} L`,
              cfg: { lb: 1, vw1h, vw4h, mc, slLow: sl.low, slHigh: sl.high, z1h: 1.5, z4h: 1.0, trail: trail.t, cdH: cd, allowShorts: false },
            });
            // Long+Short
            configs.push({
              label: `lb1 1h:vw${vw1h} 4h:vw${vw4h} mc${mc} ${sl.label} cd${cd}h ${trail.label} LS`,
              cfg: { lb: 1, vw1h, vw4h, mc, slLow: sl.low, slHigh: sl.high, z1h: 1.5, z4h: 1.0, trail: trail.t, cdH: cd, allowShorts: true },
            });
          }
        }
      }
    }
  }
}

// Dimension 2: lb2 with best vw combos
for (const vw1h of [15, 20, 30]) {
  for (const vw4h of [20, 30, 40]) {
    for (const mc of [7, 10, 15]) {
      for (const sl of [
        { low: 0.0015, high: 0.003, label: "0.15/0.30" },
        { low: 0.002, high: 0.004, label: "0.20/0.40" },
        { low: 0.003, high: 0.005, label: "0.30/0.50" },
      ]) {
        for (const trail of [
          { t: [{ a: 2, d: 1.5 }], label: "2/1.5" },
          { t: [{ a: 1.5, d: 1.5 }], label: "1.5/1.5" },
          { t: [{ a: 3, d: 2.0 }], label: "3/2" },
        ]) {
          configs.push({
            label: `lb2 1h:vw${vw1h} 4h:vw${vw4h} mc${mc} ${sl.label} cd2h ${trail.label} L`,
            cfg: { lb: 2, vw1h, vw4h, mc, slLow: sl.low, slHigh: sl.high, z1h: 1.5, z4h: 1.0, trail: trail.t, cdH: 2, allowShorts: false },
          });
        }
      }
    }
  }
}

console.log(`\nSweeping ${configs.length} configs...\n`);

interface Result { label: string; pnlDay: number; mdd: number; pf: number; wr: number; trades: number; calmar: number }
const results: Result[] = [];

for (let i = 0; i < configs.length; i++) {
  if ((i + 1) % 100 === 0) process.stdout.write(`\r${i + 1}/${configs.length}`);
  const c = configs[i]!;
  const r = simulate(c.cfg);
  if (r.trades < 50) continue;
  results.push({ label: c.label, ...r });
}

console.log(`\n\n${"=".repeat(100)}`);
console.log("TOP 30 BY $/DAY");
console.log("=".repeat(100));
results.sort((a, b) => b.pnlDay - a.pnlDay);
console.log(`${"Config".padEnd(70)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of results.slice(0, 30)) {
  console.log(`${r.label.padEnd(70)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\n${"=".repeat(100)}`);
console.log("TOP 30 BY CALMAR");
console.log("=".repeat(100));
results.sort((a, b) => b.calmar - a.calmar);
console.log(`${"Config".padEnd(70)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of results.slice(0, 30)) {
  console.log(`${r.label.padEnd(70)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\n${"=".repeat(100)}`);
console.log("TOP 30 BY $/DAY (MDD < $40)");
console.log("=".repeat(100));
const safe = results.filter(r => r.mdd < 40);
safe.sort((a, b) => b.pnlDay - a.pnlDay);
console.log(`${"Config".padEnd(70)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of safe.slice(0, 30)) {
  console.log(`${r.label.padEnd(70)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\n${"=".repeat(100)}`);
console.log("TOP 10 SHORTS (LS configs only)");
console.log("=".repeat(100));
const shorts = results.filter(r => r.label.endsWith(" LS"));
shorts.sort((a, b) => b.pnlDay - a.pnlDay);
console.log(`${"Config".padEnd(70)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of shorts.slice(0, 10)) {
  console.log(`${r.label.padEnd(70)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\nTotal configs tested: ${configs.length}`);
console.log(`Configs with >50 trades: ${results.length}`);
