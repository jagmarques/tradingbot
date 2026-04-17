/**
 * Cooldown period sweep on 127-pair portfolio
 * Tests: 0h, 1h, 2h, 3h, 4h, 6h, 8h, 12h, 24h
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const MARGIN = 7;
const NOT = MARGIN * LEV;
const MOM_LB = 3;
const VOL_WIN = 20;
const SL_PCT = 0.005;
const SL_CAP = 0.01;
const BE_AT = 2;
const MAX_HOLD_H = 72;
const BLOCK_HOURS = [22, 23];
const Z_LONG_1H = 3.0;
const Z_LONG_4H = 2.5;
const Z_SHORT_1H = -3.0;
const Z_SHORT_4H = -2.5;

const TRAIL_STEPS = [
  { activate: 10, dist: 5 }, { activate: 15, dist: 4 }, { activate: 20, dist: 3 },
  { activate: 25, dist: 2 }, { activate: 35, dist: 1.5 }, { activate: 50, dist: 1 },
];

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DEFAULT_SPREAD = 5e-4;
const REVERSE_MAP: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };

const ALL_127 = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET",
  "FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR",
  "PENDLE","PNUT","ATOM","TON","SEI","STX",
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN","TNSR","CATI","TURBO","MOVE",
  "GALA","STRK","SAGA","ILV","GMX","OM","CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC",
  "USUAL","UMA","USTC","MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS","MINA","LISTA","NEO","AI",
  "SCR","APE","KAITO","AR","BNT","PIXEL","LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET",
  "STG","REQ","CAKE","SUPER","FTT","STRAX",
];

const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr { pair: string; dir: "long"|"short"; ep: number; xp: number; et: number; xt: number; pnl: number; reason: string; }

function load5m(sym: string): C[] {
  const fp = path.join(CACHE_5M, `${sym}.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] } : { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) { const bucket = Math.floor(b.t / periodMs) * periodMs; let arr = groups.get(bucket); if (!arr) { arr = []; groups.set(bucket, arr); } arr.push(b); }
  const result: C[] = [];
  for (const [ts, grp] of groups) { if (grp.length < minBars) continue; grp.sort((a, b) => a.t - b.t); result.push({ t: ts, o: grp[0]!.o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1]!.c }); }
  return result.sort((a, b) => a.t - b.t);
}

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i]!.c / cs[i - momLb]!.c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) { const r = cs[j]!.c / cs[j - 1]!.c - 1; sumSq += r * r; count++; }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

function calcPnl(dir: "long"|"short", ep: number, xp: number, sp: number, isSL: boolean): number {
  const slip = isSL ? sp * 1.5 : sp;
  const exitPx = dir === "long" ? xp * (1 - slip) : xp * (1 + slip);
  const raw = dir === "long" ? (exitPx / ep - 1) * NOT : (ep / exitPx - 1) * NOT;
  return raw - NOT * FEE * 2;
}

function fmtPnl(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface PairInd { h1: C[]; h4: C[]; z1h: number[]; z4h: number[]; h1TsMap: Map<number, number>; h4TsMap: Map<number, number>; }

function buildInd(bars5m: C[]): PairInd {
  const h1 = aggregate(bars5m, H, 10);
  const h4 = aggregate(bars5m, H4, 40);
  const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
  const z4h = computeZScores(h4, MOM_LB, VOL_WIN);
  const h1TsMap = new Map<number, number>(); h1.forEach((c, i) => h1TsMap.set(c.t, i));
  const h4TsMap = new Map<number, number>(); h4.forEach((c, i) => h4TsMap.set(c.t, i));
  return { h1, h4, z1h, z4h, h1TsMap, h4TsMap };
}

function getLatest4hZ(ind: PairInd, t: number): number {
  const bucket = Math.floor(t / H4) * H4;
  let idx = ind.h4TsMap.get(bucket);
  if (idx !== undefined && idx > 0) return ind.z4h[idx - 1]!;
  let lo = 0, hi = ind.h4.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ind.h4[mid]!.t < t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return best >= 0 ? ind.z4h[best]! : 0;
}

function runSweep(pairs: { name: string; ind: PairInd; sp: number }[], cooldownH: number, label: string) {
  const allH1Times: number[] = [];
  for (const p of pairs) { for (const bar of p.ind.h1) { if (bar.t >= OOS_START && bar.t < OOS_END) allH1Times.push(bar.t); } }
  const uniqueHours = [...new Set(allH1Times)].sort((a, b) => a - b);

  interface OpenPos { pair: string; dir: "long"|"short"; ep: number; et: number; sl: number; peakPnlPct: number; sp: number; }
  const openPositions: OpenPos[] = [];
  const closedTrades: Tr[] = [];
  const cooldowns = new Map<string, number>();

  for (const hour of uniqueHours) {
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const pairData = pairs.find(p => p.name === pos.pair);
      if (!pairData) continue;
      const barIdx = pairData.ind.h1TsMap.get(hour);
      if (barIdx === undefined) continue;
      const bar = pairData.ind.h1[barIdx]!;
      let xp = 0, reason = "", isSL = false;
      const hoursHeld = (hour - pos.et) / H;
      if (hoursHeld >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }
      if (!xp && pos.peakPnlPct >= BE_AT) { const beHit = pos.dir === "long" ? bar.l <= pos.ep : bar.h >= pos.ep; if (beHit) { xp = pos.ep; reason = "be"; } }
      if (!xp) { const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl; if (slHit) { xp = pos.sl; reason = "sl"; isSL = true; } }
      if (!xp) {
        const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * LEV * 100 : (pos.ep / bar.l - 1) * LEV * 100;
        if (best > pos.peakPnlPct) pos.peakPnlPct = best;
        const curr = pos.dir === "long" ? (bar.c / pos.ep - 1) * LEV * 100 : (pos.ep / bar.c - 1) * LEV * 100;
        let trailDist = Infinity;
        for (const step of TRAIL_STEPS) { if (pos.peakPnlPct >= step.activate) trailDist = step.dist; }
        if (trailDist < Infinity && curr <= pos.peakPnlPct - trailDist) { xp = bar.c; reason = "trail"; }
      }
      if (xp > 0) {
        const pnl = calcPnl(pos.dir, pos.ep, xp, pos.sp, isSL);
        closedTrades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: hour, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cooldowns.set(`${pos.pair}:${pos.dir}`, hour + cooldownH * H);
      }
    }
    const hourOfDay = new Date(hour).getUTCHours();
    if (BLOCK_HOURS.includes(hourOfDay)) continue;
    for (const p of pairs) {
      const barIdx = p.ind.h1TsMap.get(hour);
      if (barIdx === undefined || barIdx < VOL_WIN + 2) continue;
      const bar = p.ind.h1[barIdx]!;
      const prev = barIdx - 1;
      if (openPositions.some(op => op.pair === p.name)) continue;
      const z1h = p.ind.z1h[prev]!;
      const z4h = getLatest4hZ(p.ind, hour);
      let dir: "long"|"short"|null = null;
      if (z1h > Z_LONG_1H && z4h > Z_LONG_4H) dir = "long";
      if (z1h < Z_SHORT_1H && z4h < Z_SHORT_4H) dir = "short";
      if (!dir) continue;
      const cdKey = `${p.name}:${dir}`;
      const cdUntil = cooldowns.get(cdKey);
      if (cdUntil && hour < cdUntil) continue;
      const ep = dir === "long" ? bar.o * (1 + p.sp) : bar.o * (1 - p.sp);
      const slDist = Math.min(ep * SL_PCT, ep * SL_CAP);
      const sl = dir === "long" ? ep - slDist : ep + slDist;
      openPositions.push({ pair: p.name, dir, ep, et: hour, sl, peakPnlPct: 0, sp: p.sp });
    }
  }
  for (const pos of openPositions) {
    const pairData = pairs.find(p => p.name === pos.pair);
    if (!pairData) continue;
    const lastBar = pairData.ind.h1[pairData.ind.h1.length - 1]!;
    const pnl = calcPnl(pos.dir, pos.ep, lastBar.c, pos.sp, false);
    closedTrades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
  }

  const sorted = [...closedTrades].sort((a, b) => a.xt - b.xt);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0).length;
  const wr = sorted.length > 0 ? wins / sorted.length * 100 : 0;
  const grossProfit = sorted.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(sorted.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const oosDays = (OOS_END - OOS_START) / D;
  const perDay = totalPnl / oosDays;
  const trPerDay = sorted.length / oosDays;

  const slCount = sorted.filter(t => t.reason === "sl").length;
  const beCount = sorted.filter(t => t.reason === "be").length;
  const trailCount = sorted.filter(t => t.reason === "trail").length;

  // Days DD > $50
  const dailyPnl = new Map<number, number>();
  for (const t of sorted) { const day = Math.floor(t.xt / D) * D; dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl); }
  const days = [...dailyPnl.entries()].sort((a, b) => a[0] - b[0]);
  let eqCum = 0, eqPeak = 0;
  let dd50Days = 0;
  for (const [, pnl] of days) {
    eqCum += pnl;
    if (eqCum > eqPeak) eqPeak = eqCum;
    if (eqPeak - eqCum >= 50) dd50Days++;
  }

  console.log(
    `  ${label.padEnd(20)} ${String(sorted.length).padStart(6)} ${trPerDay.toFixed(1).padStart(6)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(totalPnl).padStart(10)} ${fmtPnl(perDay).padStart(8)} $${maxDD.toFixed(0).padStart(4)} ${String(dd50Days).padStart(4)} ${String(slCount).padStart(5)} ${String(beCount).padStart(5)} ${String(trailCount).padStart(6)}`
  );
}

function main() {
  console.log("=".repeat(100));
  console.log("  COOLDOWN PERIOD SWEEP - 127 PAIRS");
  console.log("  All deployed params: SL 0.5%, BE +2%, trail 10/5 6-stage, $7, no filters");
  console.log("=".repeat(100));

  console.log("\n  Loading 127 pairs...");
  const allPairData: { name: string; ind: PairInd; sp: number }[] = [];
  for (const name of ALL_127) {
    const sym = REVERSE_MAP[name] ?? name;
    let raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) raw5m = load5m(`${name}USDT`);
    if (raw5m.length < 5000) continue;
    const ind = buildInd(raw5m);
    if (ind.h1.length < 100 || ind.h4.length < 50) continue;
    allPairData.push({ name, ind, sp: SP[name] ?? DEFAULT_SPREAD });
  }
  console.log(`  Loaded ${allPairData.length} pairs\n`);

  const hdr = `  ${"Cooldown".padEnd(20)} ${"Trades".padStart(6)} ${"Tr/d".padStart(6)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"PnL".padStart(10)} ${"$/day".padStart(8)} ${"MaxDD".padStart(5)} ${"D>50".padStart(4)} ${"SL".padStart(5)} ${"BE".padStart(5)} ${"Trail".padStart(6)}`;
  console.log(hdr);
  console.log("  " + "-".repeat(95));

  const cooldowns = [0, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 24, 32];
  for (const cd of cooldowns) {
    runSweep(allPairData, cd, `CD ${cd}h`);
  }

  // Also test cooldown per-pair (both directions) vs per-direction
  console.log("\n  Note: cooldown is per pair+direction (long/short independent)");
}

main();
