/**
 * Capital-constrained backtest: $45 starting equity, $15 margin per position
 * Only opens positions when free margin is available
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
const MARGIN = 15;
const MAX_CONCURRENT = 5;
const SL_LOW = 0.0015;
const SL_HIGH = 0.003;
const Z1H = 1.5;
const Z4H = 1.0;
const CD_H = 2;
const STARTING_CAPITAL = 45;
const TRAIL = [{ a: 10, d: 0.3 }, { a: 5, d: 0.3 }, { a: 2, d: 0.5 }];

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
  z1h: number[]; z4h: number[];
  h1Map: Map<number, number>; m5Map: Map<number, number>;
  spread: number; leverage: number;
}
interface Position {
  pair: string; entryPrice: number; entryTime: number; stopLoss: number;
  peakLevPnlPct: number; spread: number; leverage: number; notional: number;
  margin: number;
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

// Capital tracking
let walletBalance = STARTING_CAPITAL;
const openPositions: Position[] = [];
let realizedPnl = 0;
let mtmPeak = 0;
let mtmMaxDD = 0;
let totalTrades = 0;
let slCount = 0;
let trailCount = 0;
let maxhCount = 0;
let totalWins = 0;
let grossProfit = 0;
let grossLoss = 0;
let skippedNoMargin = 0;
let lowestEquity = STARTING_CAPITAL;
let maxOpenAtOnce = 0;

// Monthly tracking
const monthlyPnl = new Map<string, number>();
const cooldowns = new Map<string, number>();

console.log(`\nStarting sim: $${STARTING_CAPITAL} equity, $${MARGIN} margin, mc${MAX_CONCURRENT}`);
console.log(`Max positions at start: ${Math.floor(STARTING_CAPITAL / MARGIN)}\n`);

for (const ts of timepoints) {
  const isH1Boundary = ts % H === 0;

  // EXIT
  for (let i = openPositions.length - 1; i >= 0; i--) {
    const pos = openPositions[i]!;
    const pd = pairByName.get(pos.pair)!;
    const bi = pd.m5Map.get(ts);
    if (bi === undefined) continue;
    const bar = pd.m5[bi]!;
    let exitPrice = 0, reason = "";

    if ((ts - pos.entryTime) / H >= MAX_HOLD_H) { exitPrice = bar.c; reason = "maxh"; }
    if (!exitPrice && bar.l <= pos.stopLoss) { exitPrice = pos.stopLoss; reason = "sl"; }

    const bestLevPnl = (bar.h / pos.entryPrice - 1) * pos.leverage * 100;
    if (bestLevPnl > pos.peakLevPnlPct) pos.peakLevPnlPct = bestLevPnl;

    if (!exitPrice && isH1Boundary) {
      const currentLevPnl = (bar.c / pos.entryPrice - 1) * pos.leverage * 100;
      let trailDist = Infinity;
      for (const step of TRAIL) {
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
      walletBalance += pos.margin + pnl; // margin returned + pnl
      totalTrades++;
      if (pnl > 0) { totalWins++; grossProfit += pnl; } else { grossLoss += Math.abs(pnl); }
      if (reason === "sl") { slCount++; cooldowns.set(`${pos.pair}:long`, ts + CD_H * H); }
      else if (reason === "trail") trailCount++;
      else if (reason === "maxh") maxhCount++;

      const month = new Date(ts).toISOString().slice(0, 7);
      monthlyPnl.set(month, (monthlyPnl.get(month) ?? 0) + pnl);
    }
  }

  // MTM equity
  let unrealizedPnl = 0;
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const bi = pd.m5Map.get(ts);
    if (bi === undefined) continue;
    const bar = pd.m5[bi]!;
    unrealizedPnl += (bar.c * (1 - pos.spread) / pos.entryPrice - 1) * pos.notional - pos.notional * FEE * 2;
  }
  const marginInUse = openPositions.reduce((s, p) => s + p.margin, 0);
  const totalEquity = walletBalance + marginInUse + unrealizedPnl;
  // Note: walletBalance already has margin deducted when opening, so total = wallet + margin_locked + unrealized
  // Simpler: totalEquity = STARTING_CAPITAL + realizedPnl + unrealizedPnl
  const totalEquitySimple = STARTING_CAPITAL + realizedPnl + unrealizedPnl;

  if (totalEquitySimple > mtmPeak) mtmPeak = totalEquitySimple;
  if (mtmPeak - totalEquitySimple > mtmMaxDD) mtmMaxDD = mtmPeak - totalEquitySimple;
  if (totalEquitySimple < lowestEquity) lowestEquity = totalEquitySimple;

  // ENTRY
  if (!isH1Boundary) continue;
  if (BLOCK_HOURS.has(new Date(ts).getUTCHours())) continue;
  if (openPositions.length >= MAX_CONCURRENT) continue;

  for (const p of pairs) {
    if (openPositions.length >= MAX_CONCURRENT) break;
    if (openPositions.some(pos => pos.pair === p.name)) continue;

    // Capital constraint: need $15 free margin
    if (walletBalance < MARGIN) { skippedNoMargin++; continue; }

    const cdUntil = cooldowns.get(`${p.name}:long`);
    if (cdUntil && ts < cdUntil) continue;

    const h1Idx = p.h1Map.get(ts);
    if (h1Idx === undefined || h1Idx < VOL_WIN + MOM_LB + 2) continue;
    const z1 = p.z1h[h1Idx - 1]!;
    if (z1 <= Z1H) continue;
    const z4 = get4hZ(p, ts);
    if (z4 <= Z4H) continue;

    const entryPrice = p.h1[h1Idx]!.o * (1 + p.spread);
    const slPct = p.leverage >= 10 ? SL_HIGH : SL_LOW;
    const stopLoss = entryPrice * (1 - slPct);
    const notional = MARGIN * p.leverage;

    walletBalance -= MARGIN; // lock margin
    openPositions.push({
      pair: p.name, entryPrice, entryTime: ts, stopLoss,
      peakLevPnlPct: 0, spread: p.spread, leverage: p.leverage,
      notional, margin: MARGIN,
    });

    if (openPositions.length > maxOpenAtOnce) maxOpenAtOnce = openPositions.length;
  }
}

const dollarsPerDay = realizedPnl / OOS_DAYS;
const winRate = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
const calmar = mtmMaxDD > 0 ? dollarsPerDay / mtmMaxDD : 0;
const finalEquity = STARTING_CAPITAL + realizedPnl;

console.log("=".repeat(60));
console.log(`CAPITAL-CONSTRAINED: $${STARTING_CAPITAL} start, $${MARGIN} mc${MAX_CONCURRENT}`);
console.log("=".repeat(60));
console.log(`Period:           ${OOS_DAYS.toFixed(0)} days`);
console.log(`Pairs:            ${pairs.length}`);
console.log(`Trail:            2/0.5 -> 5/0.3 -> 10/0.3`);
console.log(`Cooldown:         ${CD_H}h`);
console.log("");
console.log(`Starting equity:  $${STARTING_CAPITAL}`);
console.log(`Final equity:     $${finalEquity.toFixed(2)}`);
console.log(`Total PnL:        $${realizedPnl.toFixed(2)}`);
console.log(`$/day:            $${dollarsPerDay.toFixed(2)}`);
console.log(`Monthly:          $${(dollarsPerDay * 30).toFixed(2)} (${(dollarsPerDay * 30 / STARTING_CAPITAL * 100).toFixed(0)}%)`);
console.log("");
console.log(`MTM MaxDD:        $${mtmMaxDD.toFixed(2)}`);
console.log(`Lowest equity:    $${lowestEquity.toFixed(2)}`);
console.log(`Profit Factor:    ${profitFactor.toFixed(2)}`);
console.log(`Win Rate:         ${winRate.toFixed(1)}%`);
console.log(`Calmar:           ${calmar.toFixed(4)}`);
console.log("");
console.log(`Total Trades:     ${totalTrades}`);
console.log(`  SL exits:       ${slCount} (${(slCount/totalTrades*100).toFixed(0)}%)`);
console.log(`  Trail exits:    ${trailCount} (${(trailCount/totalTrades*100).toFixed(0)}%)`);
console.log(`  MaxHold exits:  ${maxhCount}`);
console.log(`Max open at once: ${maxOpenAtOnce}`);
console.log(`Skipped (no $):   ${skippedNoMargin}`);
console.log("");
console.log("Monthly breakdown:");
const months = [...monthlyPnl.entries()].sort();
for (const [month, pnl] of months) {
  const bar = pnl > 0 ? "+".repeat(Math.min(Math.round(pnl / 2), 40)) : "-".repeat(Math.min(Math.round(Math.abs(pnl) / 2), 40));
  console.log(`  ${month}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2).padStart(7)} ${bar}`);
}
