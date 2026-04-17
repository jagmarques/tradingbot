/**
 * Sweep: margin, maxConcurrent, SL, z-thresholds, trail configs, cooldown
 * Finds best $/day with MDD < $30 on 125 pairs
 */
import * as fs from "fs";

const CACHE = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
const MOM_LB = 1;
const VOL_WIN = 30;
const MAX_HOLD_H = 72;
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
const RENAME: Record<string, string> = {
  kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB",
};

const leverageMap = new Map<string, number>();
for (const line of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [name, val] = line.split(":");
  leverageMap.set(name!, parseInt(val!));
}
function getLeverage(pair: string): number {
  return Math.min(leverageMap.get(pair) ?? 3, 10);
}

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
  z1h: number[]; z4h: number[];
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

function computeZScores(candles: Candle[]): number[] {
  const z: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < VOL_WIN + MOM_LB + 1) { z.push(0); continue; }
    const momentum = candles[i]!.c / candles[i - MOM_LB]!.c - 1;
    const returns: number[] = [];
    for (let j = Math.max(1, i - VOL_WIN); j <= i; j++) {
      returns.push(candles[j]!.c / candles[j - 1]!.c - 1);
    }
    const volatility = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
    z.push(volatility === 0 ? 0 : momentum / volatility);
  }
  return z;
}

// Load data once
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
  const z1h = computeZScores(h1);
  const z4h = computeZScores(h4);
  const h1Map = new Map<number, number>();
  h1.forEach((c, i) => h1Map.set(c.t, i));
  const m5 = raw.filter(b => b.t >= OOS_START - 24 * H && b.t <= OOS_END + 24 * H);
  const m5Map = new Map<number, number>();
  m5.forEach((c, i) => m5Map.set(c.t, i));
  pairs.push({ name, h1, h4, m5, z1h, z4h, h1Map, m5Map, spread: SP[name] ?? DEFAULT_SPREAD, leverage: getLeverage(name) });
}
console.log(`${pairs.length} pairs loaded`);

const allTimestamps = new Set<number>();
for (const p of pairs) {
  for (const b of p.m5) {
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
  margin: number;
  mc: number;
  slLow: number;
  slHigh: number;
  z1h: number;
  z4h: number;
  trail: { a: number; d: number }[];
  cooldownH: number;
}

function simulate(cfg: Config): { pnlDay: number; mdd: number; pf: number; wr: number; trades: number; calmar: number } {
  const openPositions: Position[] = [];
  let realizedPnl = 0;
  let mtmPeak = 0;
  let mtmMaxDD = 0;
  let totalTrades = 0;
  let totalWins = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  // Cooldown tracking: pair+direction -> earliest re-entry time
  const cooldowns = new Map<string, number>();

  for (const ts of timepoints) {
    const isH1Boundary = ts % H === 0;

    // EXIT
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const pd = pairByName.get(pos.pair)!;
      const bi = pd.m5Map.get(ts);
      if (bi === undefined) continue;
      const bar = pd.m5[bi]!;

      let exitPrice = 0;
      let reason = "";

      if ((ts - pos.entryTime) / H >= MAX_HOLD_H) { exitPrice = bar.c; reason = "maxh"; }

      if (!exitPrice && bar.l <= pos.stopLoss) { exitPrice = pos.stopLoss; reason = "sl"; }

      const bestLevPnl = (bar.h / pos.entryPrice - 1) * pos.leverage * 100;
      if (bestLevPnl > pos.peakLevPnlPct) pos.peakLevPnlPct = bestLevPnl;

      if (!exitPrice && isH1Boundary) {
        const currentLevPnl = (bar.c / pos.entryPrice - 1) * pos.leverage * 100;
        let trailDist = Infinity;
        for (const step of cfg.trail) {
          if (pos.peakLevPnlPct >= step.a) { trailDist = step.d; break; }
        }
        if (trailDist < Infinity && currentLevPnl <= pos.peakLevPnlPct - trailDist) { exitPrice = bar.c; reason = "trail"; }
      }

      if (exitPrice > 0) {
        const exitSpread = reason === "sl" ? pos.spread * 1.5 : pos.spread;
        const fillPrice = exitPrice * (1 - exitSpread);
        const pnl = (fillPrice / pos.entryPrice - 1) * pos.notional - pos.notional * FEE * 2;
        openPositions.splice(i, 1);
        realizedPnl += pnl;
        totalTrades++;
        if (pnl > 0) { totalWins++; grossProfit += pnl; } else { grossLoss += Math.abs(pnl); }
        if (reason === "sl" && cfg.cooldownH > 0) {
          cooldowns.set(`${pos.pair}:long`, ts + cfg.cooldownH * H);
        }
      }
    }

    // MTM MDD
    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      const pd = pairByName.get(pos.pair)!;
      const bi = pd.m5Map.get(ts);
      if (bi === undefined) continue;
      const bar = pd.m5[bi]!;
      const midExit = bar.c * (1 - pos.spread);
      unrealizedPnl += (midExit / pos.entryPrice - 1) * pos.notional - pos.notional * FEE * 2;
    }
    const totalEquity = realizedPnl + unrealizedPnl;
    if (totalEquity > mtmPeak) mtmPeak = totalEquity;
    if (mtmPeak - totalEquity > mtmMaxDD) mtmMaxDD = mtmPeak - totalEquity;

    // ENTRY
    if (!isH1Boundary) continue;
    if (BLOCK_HOURS.has(new Date(ts).getUTCHours())) continue;
    if (openPositions.length >= cfg.mc) continue;

    for (const p of pairs) {
      if (openPositions.length >= cfg.mc) break;
      if (openPositions.some(pos => pos.pair === p.name)) continue;

      // Cooldown check
      if (cfg.cooldownH > 0) {
        const cdKey = `${p.name}:long`;
        const cdUntil = cooldowns.get(cdKey);
        if (cdUntil && ts < cdUntil) continue;
      }

      const h1Idx = p.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < VOL_WIN + MOM_LB + 2) continue;

      const z1 = p.z1h[h1Idx - 1]!;
      if (z1 <= cfg.z1h) continue;

      const z4 = get4hZ(p, ts);
      if (z4 <= cfg.z4h) continue;

      const entryPrice = p.h1[h1Idx]!.o * (1 + p.spread);
      const slPct = p.leverage >= 10 ? cfg.slHigh : cfg.slLow;
      const stopLoss = entryPrice * (1 - slPct);
      const notional = cfg.margin * p.leverage;

      openPositions.push({
        pair: p.name, entryPrice, entryTime: ts, stopLoss,
        peakLevPnlPct: 0, spread: p.spread, leverage: p.leverage,
        notional, direction: "long",
      });
    }
  }

  const pnlDay = realizedPnl / OOS_DAYS;
  const wr = totalTrades > 0 ? totalWins / totalTrades * 100 : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const calmar = mtmMaxDD > 0 ? pnlDay / mtmMaxDD : 0;
  return { pnlDay, mdd: mtmMaxDD, pf, wr, trades: totalTrades, calmar };
}

// Define sweep space
const margins = [5, 7, 10, 15, 20];
const mcs = [3, 5, 7, 10, 15, 20, 999];
const slConfigs = [
  { low: 0.0015, high: 0.003, label: "0.15/0.30" },
  { low: 0.002, high: 0.004, label: "0.20/0.40" },
  { low: 0.003, high: 0.005, label: "0.30/0.50" },
  { low: 0.005, high: 0.005, label: "0.50/0.50" },
];
const zConfigs = [
  { z1h: 2.0, z4h: 1.5, label: "z2.0/1.5" },
  { z1h: 2.5, z4h: 2.0, label: "z2.5/2.0" },
  { z1h: 1.5, z4h: 1.0, label: "z1.5/1.0" },
  { z1h: 3.0, z4h: 2.0, label: "z3.0/2.0" },
];
const trailConfigs = [
  { trail: [{ a: 3, d: 1 }, { a: 9, d: 0.5 }, { a: 20, d: 0.5 }], label: "3/1-9/0.5-20/0.5" },
  { trail: [{ a: 5, d: 2 }, { a: 10, d: 1 }, { a: 20, d: 0.5 }], label: "5/2-10/1-20/0.5" },
  { trail: [{ a: 7, d: 3 }, { a: 15, d: 2 }, { a: 30, d: 1 }], label: "7/3-15/2-30/1" },
  { trail: [{ a: 2, d: 0.5 }, { a: 5, d: 0.3 }, { a: 10, d: 0.3 }], label: "2/0.5-5/0.3-10/0.3" },
];
const cooldowns = [0, 1, 2, 4];

// Total configs
const total = margins.length * mcs.length * slConfigs.length * zConfigs.length * trailConfigs.length * cooldowns.length;
console.log(`\nSweeping ${total} configs...\n`);

interface Result {
  label: string; pnlDay: number; mdd: number; pf: number; wr: number; trades: number; calmar: number;
}

const results: Result[] = [];
let count = 0;

for (const margin of margins) {
  for (const mc of mcs) {
    for (const sl of slConfigs) {
      for (const zc of zConfigs) {
        for (const tc of trailConfigs) {
          for (const cd of cooldowns) {
            count++;
            if (count % 100 === 0) process.stdout.write(`\r${count}/${total}`);

            const r = simulate({
              margin, mc, slLow: sl.low, slHigh: sl.high,
              z1h: zc.z1h, z4h: zc.z4h, trail: tc.trail, cooldownH: cd,
            });

            if (r.trades < 50) continue; // skip insignificant
            results.push({
              label: `$${margin} mc${mc} ${sl.label} ${zc.label} ${tc.label} cd${cd}h`,
              ...r,
            });
          }
        }
      }
    }
  }
}

console.log(`\n\n${"=".repeat(80)}`);
console.log("TOP 20 BY CALMAR ($/day per $1 MDD)");
console.log("=".repeat(80));
results.sort((a, b) => b.calmar - a.calmar);
console.log(`${"Config".padEnd(65)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of results.slice(0, 20)) {
  console.log(`${r.label.padEnd(65)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\n${"=".repeat(80)}`);
console.log("TOP 20 BY $/DAY (MDD < $35)");
console.log("=".repeat(80));
const filtered = results.filter(r => r.mdd < 35);
filtered.sort((a, b) => b.pnlDay - a.pnlDay);
console.log(`${"Config".padEnd(65)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of filtered.slice(0, 20)) {
  console.log(`${r.label.padEnd(65)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\n${"=".repeat(80)}`);
console.log("TOP 20 BY $/DAY (MDD < $25)");
console.log("=".repeat(80));
const tight = results.filter(r => r.mdd < 25);
tight.sort((a, b) => b.pnlDay - a.pnlDay);
console.log(`${"Config".padEnd(65)} $/day   MDD    PF   WR%  Trades Calmar`);
for (const r of tight.slice(0, 20)) {
  console.log(`${r.label.padEnd(65)} ${r.pnlDay.toFixed(2).padStart(5)}  ${r.mdd.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(4)}  ${r.wr.toFixed(1).padStart(4)}  ${String(r.trades).padStart(5)}  ${r.calmar.toFixed(4)}`);
}

console.log(`\nTotal configs tested: ${count}`);
console.log(`Configs with >50 trades: ${results.length}`);
