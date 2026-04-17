/**
 * GARCH v2 backtest with REAL per-pair leverage from Hyperliquid
 * Reads leverage map from /tmp/hl-leverage-map.txt
 * Sweeps cooldown: 0h, 1h, 2h, 4h, 8h, 24h
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const MARGIN = 7;
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

// Load real leverage from HL API dump
const LEV_MAP = new Map<string, number>();
const levLines = fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n");
for (const line of levLines) {
  const [name, lev] = line.split(":");
  LEV_MAP.set(name!, parseInt(lev!));
}

function getPairLev(name: string): number {
  // Cap at 10x even if HL allows more (we use 10x max)
  const maxLev = LEV_MAP.get(name) ?? 3;
  return Math.min(maxLev, 10);
}

const ALL_127 = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET",
  "FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR",
  "PENDLE","PNUT","ATOM","TON","SEI","STX",
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN",
  "TNSR","CATI","TURBO","MOVE","GALA","STRK","SAGA","ILV","GMX","OM",
  "CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC","USUAL","UMA","USTC",
  "MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS",
  "MINA","LISTA","NEO","AI","SCR","APE","KAITO","AR","BNT","PIXEL",
  "LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET","STG","REQ",
  "CAKE","SUPER","FTT","STRAX",
];

const CURRENT_53 = ALL_127.slice(0, 53);

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

interface PairData { name: string; ind: PairInd; sp: number; lev: number; notional: number; }

function runSweep(pairs: PairData[], cooldownH: number, label: string) {
  const allH1Times: number[] = [];
  for (const p of pairs) { for (const bar of p.ind.h1) { if (bar.t >= OOS_START && bar.t < OOS_END) allH1Times.push(bar.t); } }
  const uniqueHours = [...new Set(allH1Times)].sort((a, b) => a - b);

  interface OpenPos { pair: string; dir: "long"|"short"; ep: number; et: number; sl: number; peakPnlPct: number; sp: number; lev: number; notional: number; }
  const openPositions: OpenPos[] = [];
  const closedTrades: Tr[] = [];
  const cooldowns = new Map<string, number>();

  for (const hour of uniqueHours) {
    // EXIT
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
      if (!xp && pos.peakPnlPct >= BE_AT) {
        const beHit = pos.dir === "long" ? bar.l <= pos.ep : bar.h >= pos.ep;
        if (beHit) { xp = pos.ep; reason = "be"; }
      }
      if (!xp) {
        const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (slHit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }
      if (!xp) {
        // Trail uses THIS PAIR'S leverage for PnL% calc
        const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.l - 1) * pos.lev * 100;
        if (best > pos.peakPnlPct) pos.peakPnlPct = best;
        const curr = pos.dir === "long" ? (bar.c / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.c - 1) * pos.lev * 100;
        let trailDist = Infinity;
        for (const step of TRAIL_STEPS) { if (pos.peakPnlPct >= step.activate) trailDist = step.dist; }
        if (trailDist < Infinity && curr <= pos.peakPnlPct - trailDist) { xp = bar.c; reason = "trail"; }
      }
      if (xp > 0) {
        const slip = isSL ? pos.sp * 1.5 : pos.sp;
        const exitPx = pos.dir === "long" ? xp * (1 - slip) : xp * (1 + slip);
        const raw = pos.dir === "long" ? (exitPx / pos.ep - 1) * pos.notional : (pos.ep / exitPx - 1) * pos.notional;
        const pnl = raw - pos.notional * FEE * 2;
        closedTrades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: hour, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cooldowns.set(`${pos.pair}:${pos.dir}`, hour + cooldownH * H);
      }
    }

    // ENTRY
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
      openPositions.push({ pair: p.name, dir, ep, et: hour, sl, peakPnlPct: 0, sp: p.sp, lev: p.lev, notional: p.notional });
    }
  }

  // Close remaining
  for (const pos of openPositions) {
    const pairData = pairs.find(p => p.name === pos.pair);
    if (!pairData) continue;
    const lastBar = pairData.ind.h1[pairData.ind.h1.length - 1]!;
    const slip = pos.sp;
    const exitPx = pos.dir === "long" ? lastBar.c * (1 - slip) : lastBar.c * (1 + slip);
    const raw = pos.dir === "long" ? (exitPx / pos.ep - 1) * pos.notional : (pos.ep / exitPx - 1) * pos.notional;
    const pnl = raw - pos.notional * FEE * 2;
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

  // Days DD > $50
  const dailyPnl = new Map<number, number>();
  for (const t of sorted) { const day = Math.floor(t.xt / D) * D; dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl); }
  const days = [...dailyPnl.entries()].sort((a, b) => a[0] - b[0]);
  let eqCum = 0, eqPeak = 0, dd50Days = 0;
  for (const [, pnl] of days) { eqCum += pnl; if (eqCum > eqPeak) eqPeak = eqCum; if (eqPeak - eqCum >= 50) dd50Days++; }

  console.log(
    `  ${label.padEnd(25)} ${String(sorted.length).padStart(6)} ${trPerDay.toFixed(1).padStart(6)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(totalPnl).padStart(10)} ${fmtPnl(perDay).padStart(8)} $${maxDD.toFixed(0).padStart(4)} ${String(dd50Days).padStart(4)}`
  );
}

function main() {
  console.log("=".repeat(100));
  console.log("  GARCH v2 BACKTEST WITH REAL PER-PAIR LEVERAGE FROM HYPERLIQUID");
  console.log("  $7 margin, real leverage (3x/5x/10x per pair), deployed config");
  console.log("=".repeat(100));

  // Show leverage distribution
  const lev3 = ALL_127.filter(p => getPairLev(p) === 3);
  const lev5 = ALL_127.filter(p => getPairLev(p) === 5);
  const lev10 = ALL_127.filter(p => getPairLev(p) >= 10);
  console.log(`\n  Leverage distribution: ${lev3.length} pairs @3x, ${lev5.length} pairs @5x, ${lev10.length} pairs @10x+`);
  console.log(`  3x notional: $${MARGIN * 3}, 5x: $${MARGIN * 5}, 10x: $${MARGIN * 10}`);

  console.log("\n  Loading pairs...");
  const loadPairs = (pairNames: string[]): PairData[] => {
    const result: PairData[] = [];
    for (const name of pairNames) {
      const sym = REVERSE_MAP[name] ?? name;
      let raw5m = load5m(`${sym}USDT`);
      if (raw5m.length < 5000) raw5m = load5m(`${name}USDT`);
      if (raw5m.length < 5000) continue;
      const ind = buildInd(raw5m);
      if (ind.h1.length < 100 || ind.h4.length < 50) continue;
      const lev = getPairLev(name);
      result.push({ name, ind, sp: SP[name] ?? DEFAULT_SPREAD, lev, notional: MARGIN * lev });
    }
    return result;
  };

  const pairs53 = loadPairs(CURRENT_53);
  const pairs127 = loadPairs(ALL_127);
  // 10x-only subset
  const pairs10x = pairs127.filter(p => p.lev >= 10);

  console.log(`  53 pairs loaded: ${pairs53.length}`);
  console.log(`  127 pairs loaded: ${pairs127.length}`);
  console.log(`  10x+ only: ${pairs10x.length}`);

  // Per-pair results with real leverage
  console.log("\n--- PER-PAIR RESULTS (real leverage, sorted by $/day) ---\n");
  console.log(`  ${"Pair".padEnd(12)} ${"Lev".padStart(4)} ${"Not".padStart(4)} ${"N".padStart(4)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"$/day".padStart(8)} ${"MaxDD".padStart(6)}`);
  console.log("  " + "-".repeat(55));

  interface PairResult { name: string; lev: number; perDay: number; total: number; n: number; wr: number; pf: number; dd: number; }
  const pairResults: PairResult[] = [];
  const oosDays = (OOS_END - OOS_START) / D;

  for (const p of pairs127) {
    // Single-pair backtest
    const trades: Tr[] = [];
    interface Pos { dir: "long"|"short"; ep: number; et: number; sl: number; peakPnlPct: number; }
    let pos: Pos | null = null;
    for (let barIdx = VOL_WIN + 2; barIdx < p.ind.h1.length; barIdx++) {
      const bar = p.ind.h1[barIdx]!;
      const prev = barIdx - 1;
      if (pos) {
        const hoursHeld = (bar.t - pos.et) / H;
        if (hoursHeld >= MAX_HOLD_H) { const slip = p.sp; const xp2 = pos.dir==="long"?bar.c*(1-slip):bar.c*(1+slip); const pnl = pos.dir==="long"?(xp2/pos.ep-1)*p.notional:(pos.ep/xp2-1)*p.notional - p.notional*FEE*2; if (pos.et>=OOS_START&&pos.et<OOS_END) trades.push({pair:p.name,dir:pos.dir,ep:pos.ep,xp:bar.c,et:pos.et,xt:bar.t,pnl,reason:"maxh"}); pos=null; }
        if (pos && pos.peakPnlPct >= BE_AT) { const beHit = pos.dir==="long"?bar.l<=pos.ep:bar.h>=pos.ep; if (beHit) { const slip=p.sp; const xp2=pos.dir==="long"?pos.ep*(1-slip):pos.ep*(1+slip); const pnl=pos.dir==="long"?(xp2/pos.ep-1)*p.notional:(pos.ep/xp2-1)*p.notional-p.notional*FEE*2; if(pos.et>=OOS_START&&pos.et<OOS_END) trades.push({pair:p.name,dir:pos.dir,ep:pos.ep,xp:pos.ep,et:pos.et,xt:bar.t,pnl,reason:"be"}); pos=null; } }
        if (pos) { const slHit=pos.dir==="long"?bar.l<=pos.sl:bar.h>=pos.sl; if(slHit){const slip=p.sp*1.5; const xp2=pos.dir==="long"?pos.sl*(1-slip):pos.sl*(1+slip); const pnl=pos.dir==="long"?(xp2/pos.ep-1)*p.notional:(pos.ep/xp2-1)*p.notional-p.notional*FEE*2; if(pos.et>=OOS_START&&pos.et<OOS_END) trades.push({pair:p.name,dir:pos.dir,ep:pos.ep,xp:pos.sl,et:pos.et,xt:bar.t,pnl,reason:"sl"}); pos=null;} }
        if (pos) {
          const best=pos.dir==="long"?(bar.h/pos.ep-1)*p.lev*100:(pos.ep/bar.l-1)*p.lev*100; if(best>pos.peakPnlPct) pos.peakPnlPct=best;
          const curr=pos.dir==="long"?(bar.c/pos.ep-1)*p.lev*100:(pos.ep/bar.c-1)*p.lev*100;
          let td=Infinity; for(const step of TRAIL_STEPS){if(pos.peakPnlPct>=step.activate)td=step.dist;} if(td<Infinity&&curr<=pos.peakPnlPct-td){const slip=p.sp;const xp2=pos.dir==="long"?bar.c*(1-slip):bar.c*(1+slip);const pnl=pos.dir==="long"?(xp2/pos.ep-1)*p.notional:(pos.ep/xp2-1)*p.notional-p.notional*FEE*2;if(pos.et>=OOS_START&&pos.et<OOS_END) trades.push({pair:p.name,dir:pos.dir,ep:pos.ep,xp:bar.c,et:pos.et,xt:bar.t,pnl,reason:"trail"});pos=null;}
        }
      }
      if (!pos && bar.t >= OOS_START && bar.t < OOS_END) {
        const hourOfDay = new Date(bar.t).getUTCHours(); if (BLOCK_HOURS.includes(hourOfDay)) continue;
        const z1h = p.ind.z1h[prev]!; const z4h = getLatest4hZ(p.ind, bar.t);
        let dir: "long"|"short"|null = null;
        if (z1h > Z_LONG_1H && z4h > Z_LONG_4H) dir = "long";
        if (z1h < Z_SHORT_1H && z4h < Z_SHORT_4H) dir = "short";
        if (dir) { const ep = dir==="long"?bar.o*(1+p.sp):bar.o*(1-p.sp); const slDist=Math.min(ep*SL_PCT,ep*SL_CAP); const sl=dir==="long"?ep-slDist:ep+slDist; pos={dir,ep,et:bar.t,sl,peakPnlPct:0}; }
      }
    }
    if (trades.length === 0) continue;
    const wins = trades.filter(t => t.pnl > 0); const total = trades.reduce((s,t) => s + t.pnl, 0);
    const gp = wins.reduce((s,t)=>s+t.pnl,0); const gl = Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
    const pf = gl > 0 ? gp/gl : Infinity;
    let c2=0,p2=0,dd2=0; for(const t of [...trades].sort((a,b)=>a.xt-b.xt)){c2+=t.pnl;if(c2>p2)p2=c2;if(p2-c2>dd2)dd2=p2-c2;}
    pairResults.push({ name: p.name, lev: p.lev, perDay: total/oosDays, total, n: trades.length, wr: wins.length/trades.length*100, pf, dd: dd2 });
  }

  pairResults.sort((a, b) => b.perDay - a.perDay);
  for (const r of pairResults) {
    console.log(`  ${r.name.padEnd(12)} ${(r.lev+"x").padStart(4)} $${(MARGIN*r.lev).toString().padStart(3)} ${String(r.n).padStart(4)} ${(r.wr.toFixed(1)+"%").padStart(6)} ${r.pf.toFixed(2).padStart(5)} ${fmtPnl(r.perDay).padStart(8)} $${r.dd.toFixed(0).padStart(5)}`);
  }

  const totalPerDay = pairResults.reduce((s, r) => s + r.perDay, 0);
  console.log(`\n  Sum of per-pair $/day: ${fmtPnl(totalPerDay)}`);

  // Portfolio sims with cooldown sweep
  console.log("\n" + "=".repeat(100));
  console.log("  PORTFOLIO SIM WITH REAL LEVERAGE - COOLDOWN SWEEP");
  console.log("=".repeat(100));

  const hdr = `  ${"Config".padEnd(25)} ${"Trades".padStart(6)} ${"Tr/d".padStart(6)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"PnL".padStart(10)} ${"$/day".padStart(8)} ${"MaxDD".padStart(5)} ${"D>50".padStart(4)}`;
  console.log(`\n${hdr}`);
  console.log("  " + "-".repeat(80));

  // Current 53 with real leverage
  for (const cd of [1]) {
    runSweep(pairs53, cd, `53p real-lev CD ${cd}h`);
  }

  console.log("");

  // 127 pairs with real leverage
  for (const cd of [0, 1, 2, 4, 8, 24, 32]) {
    runSweep(pairs127, cd, `127p real-lev CD ${cd}h`);
  }

  console.log("");

  // 10x-only pairs
  for (const cd of [1]) {
    runSweep(pairs10x, cd, `${pairs10x.length}p 10x-only CD 1h`);
  }

  // Compare: what if we use 10x for all (old assumption) vs real leverage
  console.log("\n" + "=".repeat(100));
  console.log("  COMPARISON: 10x ASSUMED vs REAL LEVERAGE (1h cooldown)");
  console.log("=".repeat(100));
  console.log(`\n${hdr}`);
  console.log("  " + "-".repeat(80));

  // Fake 10x for comparison
  const pairs127fake10x = pairs127.map(p => ({ ...p, lev: 10, notional: MARGIN * 10 }));
  runSweep(pairs127fake10x, 1, "127p ALL@10x (old)");
  runSweep(pairs127, 1, "127p REAL leverage");
}

main();
