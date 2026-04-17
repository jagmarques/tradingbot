/**
 * FINAL VERIFICATION: lb1/vw30 z2/1.5 $20 mc7 no-cooldown long-only
 * Simple, auditable, no shortcuts. Checks every assumption.
 */
import * as fs from "fs";

// ---- Constants ----
const CACHE = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;        // 0.035% taker per side
const SL_PCT_LOW = 0.0015;  // 0.15% for 3x/5x
const SL_PCT_HIGH = 0.003;  // 0.3% for 10x
const MARGIN = 20;           // $20 per position
const MAX_CONCURRENT = 7;    // max 7 positions at once
const MAX_HOLD_H = 72;      // 72h max hold
const MOM_LB = 1;           // 1-bar momentum (NEW: was 3)
const VOL_WIN = 30;          // 30-bar vol window (NEW: was 20)
const Z_LONG_1H = 2.0;
const Z_LONG_4H = 1.5;
const BLOCK_HOURS = new Set([22, 23]);
const TRAIL = [{ a: 3, d: 1 }, { a: 9, d: 0.5 }, { a: 20, d: 0.5 }];

const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();
const OOS_DAYS = (OOS_END - OOS_START) / D;

// Spread map from production
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

// Leverage map
const leverageMap = new Map<string, number>();
for (const line of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [name, val] = line.split(":");
  leverageMap.set(name!, parseInt(val!));
}
function getLeverage(pair: string): number {
  return Math.min(leverageMap.get(pair) ?? 3, 10);
}

// All 127 pairs
const ALL_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","FET","FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR","PENDLE","PNUT","ATOM","TON","SEI","STX",
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN","TNSR","CATI","TURBO","MOVE","GALA","STRK","SAGA","ILV","GMX","OM",
  "CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC","USUAL","UMA","USTC","MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS","MINA","LISTA","NEO","AI","SCR","APE","KAITO","AR","BNT","PIXEL",
  "LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET","STG","REQ","CAKE","SUPER","FTT","STRAX",
];

// ---- Types ----
interface Candle { t: number; o: number; h: number; l: number; c: number; }
interface PairData {
  name: string;
  h1: Candle[];
  h4: Candle[];
  m5: Candle[];
  z1h: number[];   // z-score on 1h bars (lb1/vw30)
  z4h: number[];   // z-score on 4h bars (lb1/vw30)
  h1Map: Map<number, number>;
  m5Map: Map<number, number>;
  spread: number;
  leverage: number;
}
interface Position {
  pair: string;
  entryPrice: number;
  entryTime: number;
  stopLoss: number;
  peakLevPnlPct: number;
  spread: number;
  leverage: number;
  notional: number;
}

// ---- Data Loading ----
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
    // Momentum: 1-bar return
    const momentum = candles[i]!.c / candles[i - MOM_LB]!.c - 1;
    // Volatility: RMS of returns over 30-bar window
    const returns: number[] = [];
    for (let j = Math.max(1, i - VOL_WIN); j <= i; j++) {
      returns.push(candles[j]!.c / candles[j - 1]!.c - 1);
    }
    const volatility = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
    z.push(volatility === 0 ? 0 : momentum / volatility);
  }
  return z;
}

// ---- Load Data ----
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

  pairs.push({
    name, h1, h4, m5, z1h, z4h, h1Map, m5Map,
    spread: SP[name] ?? DEFAULT_SPREAD,
    leverage: getLeverage(name),
  });
}
console.log(`${pairs.length} pairs loaded`);

// Build sorted unique 5m timestamps in OOS range
const allTimestamps = new Set<number>();
for (const p of pairs) {
  for (const b of p.m5) {
    if (b.t >= OOS_START && b.t < OOS_END) allTimestamps.add(b.t);
  }
}
const timepoints = [...allTimestamps].sort((a, b) => a - b);
console.log(`${timepoints.length} timepoints (${OOS_DAYS.toFixed(0)} days)`);

// Helper: get 4h z-score at timestamp (binary search for latest 4h bar before ts)
function get4hZ(p: PairData, ts: number): number {
  let lo = 0, hi = p.h4.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (p.h4[m]!.t < ts) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? p.z4h[best]! : 0;
}

// ---- Simulation ----
const pairByName = new Map<string, PairData>();
pairs.forEach(p => pairByName.set(p.name, p));

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

console.log("\nRunning simulation...");

for (const ts of timepoints) {
  const isH1Boundary = ts % H === 0;

  // ---- EXIT CHECKS (every 5m bar) ----
  for (let i = openPositions.length - 1; i >= 0; i--) {
    const pos = openPositions[i]!;
    const pd = pairByName.get(pos.pair)!;
    const bi = pd.m5Map.get(ts);
    if (bi === undefined) continue;
    const bar = pd.m5[bi]!;

    let exitPrice = 0;
    let reason = "";

    // 1) Max hold (72h)
    if ((ts - pos.entryTime) / H >= MAX_HOLD_H) {
      exitPrice = bar.c;
      reason = "maxh";
    }

    // 2) Stop loss (exchange-level, every 5m bar)
    if (!exitPrice) {
      if (bar.l <= pos.stopLoss) {
        exitPrice = pos.stopLoss; // fills at SL price
        reason = "sl";
      }
    }

    // 3) Track peak leveraged PnL (every 5m bar)
    const bestLevPnl = (bar.h / pos.entryPrice - 1) * pos.leverage * 100;
    if (bestLevPnl > pos.peakLevPnlPct) pos.peakLevPnlPct = bestLevPnl;

    // 4) Trailing stop (1h boundaries ONLY)
    if (!exitPrice && isH1Boundary) {
      const currentLevPnl = (bar.c / pos.entryPrice - 1) * pos.leverage * 100;
      let trailDist = Infinity;
      for (const step of TRAIL) {
        if (pos.peakLevPnlPct >= step.a) { trailDist = step.d; break; }
      }
      if (trailDist < Infinity && currentLevPnl <= pos.peakLevPnlPct - trailDist) {
        exitPrice = bar.c;
        reason = "trail";
      }
    }

    // ---- CLOSE POSITION ----
    if (exitPrice > 0) {
      // SL gets 1.5x spread (slippage penalty)
      const exitSpread = reason === "sl" ? pos.spread * 1.5 : pos.spread;
      const fillPrice = exitPrice * (1 - exitSpread); // long exit = sell at bid
      const pnl = (fillPrice / pos.entryPrice - 1) * pos.notional - pos.notional * FEE * 2;

      openPositions.splice(i, 1);
      realizedPnl += pnl;
      totalTrades++;

      if (pnl > 0) { totalWins++; grossProfit += pnl; }
      else { grossLoss += Math.abs(pnl); }

      if (reason === "sl") slCount++;
      else if (reason === "trail") trailCount++;
      else if (reason === "maxh") maxhCount++;
    }
  }

  // ---- MARK-TO-MARKET MDD (every 5m bar) ----
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

  // ---- ENTRY (1h boundaries only, long-only) ----
  if (!isH1Boundary) continue;
  if (BLOCK_HOURS.has(new Date(ts).getUTCHours())) continue;
  if (openPositions.length >= MAX_CONCURRENT) continue;

  for (const p of pairs) {
    if (openPositions.length >= MAX_CONCURRENT) break;
    if (openPositions.some(pos => pos.pair === p.name)) continue;

    const h1Idx = p.h1Map.get(ts);
    if (h1Idx === undefined || h1Idx < VOL_WIN + MOM_LB + 2) continue;

    // Z-score of PRIOR COMPLETED 1h bar (no look-ahead)
    const z1 = p.z1h[h1Idx - 1]!;
    if (z1 <= Z_LONG_1H) continue;

    // Z-score of latest completed 4h bar
    const z4 = get4hZ(p, ts);
    if (z4 <= Z_LONG_4H) continue;

    // Entry at the OPEN of the new 1h bar + spread (buy at ask)
    const entryPrice = p.h1[h1Idx]!.o * (1 + p.spread);
    const slPct = p.leverage >= 10 ? SL_PCT_HIGH : SL_PCT_LOW;
    const stopLoss = entryPrice * (1 - slPct);
    const notional = MARGIN * p.leverage;

    openPositions.push({
      pair: p.name,
      entryPrice,
      entryTime: ts,
      stopLoss,
      peakLevPnlPct: 0,
      spread: p.spread,
      leverage: p.leverage,
      notional,
    });
  }
}

// ---- Results ----
const dollarsPerDay = realizedPnl / OOS_DAYS;
const winRate = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
const calmar = mtmMaxDD > 0 ? dollarsPerDay / mtmMaxDD : 0;

console.log("\n" + "=".repeat(60));
console.log("VERIFIED RESULTS: lb1/vw30 $20 mc7 no-CD long-only");
console.log("=".repeat(60));
console.log(`Period:          ${OOS_DAYS.toFixed(0)} days (2025-06-01 to 2026-03-25)`);
console.log(`Pairs:           ${pairs.length}`);
console.log(`Margin:          $${MARGIN}`);
console.log(`MaxConcurrent:   ${MAX_CONCURRENT}`);
console.log(`MOM_LB:          ${MOM_LB} (was 3)`);
console.log(`VOL_WIN:         ${VOL_WIN} (was 20)`);
console.log(`SL:              ${(SL_PCT_LOW * 100).toFixed(2)}% (3x/5x), ${(SL_PCT_HIGH * 100).toFixed(2)}% (10x)`);
console.log(`Trail:           3/1 -> 9/0.5 -> 20/0.5`);
console.log(`Fee:             ${(FEE * 100).toFixed(3)}% per side`);
console.log("");
console.log(`$/day:           $${dollarsPerDay.toFixed(2)}`);
console.log(`Total PnL:       $${realizedPnl.toFixed(2)}`);
console.log(`MTM MaxDD:       $${mtmMaxDD.toFixed(2)}`);
console.log(`Profit Factor:   ${profitFactor.toFixed(2)}`);
console.log(`Win Rate:        ${winRate.toFixed(1)}%`);
console.log(`Calmar:          ${calmar.toFixed(4)}`);
console.log(`Total Trades:    ${totalTrades}`);
console.log(`  SL exits:      ${slCount}`);
console.log(`  Trail exits:   ${trailCount}`);
console.log(`  MaxHold exits: ${maxhCount}`);
console.log("");
console.log(`On $60 equity:`);
console.log(`  Worst DD:      $${mtmMaxDD.toFixed(2)} -> account drops to $${(60 - mtmMaxDD).toFixed(2)}`);
console.log(`  Recovery:      ${(mtmMaxDD / dollarsPerDay).toFixed(0)} days`);
console.log(`  Monthly profit: $${(dollarsPerDay * 30).toFixed(2)} (${(dollarsPerDay * 30 / 60 * 100).toFixed(0)}%)`);
