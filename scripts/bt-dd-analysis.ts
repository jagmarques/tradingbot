/**
 * Drawdown frequency + duration analysis for the combined 127-pair portfolio
 * Shows: DD brackets, days in each bracket, worst streaks, recovery times
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
const SL_COOLDOWN_H = 1;
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

// All 127 pairs (current 53 + 74 new)
const ALL_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET",
  "FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR",
  "PENDLE","PNUT","ATOM","TON","SEI","STX",
  // 74 new
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN","TNSR","CATI","TURBO","MOVE",
  "GALA","STRK","SAGA","ILV","GMX","OM","CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC",
  "USUAL","UMA","USTC","MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS","MINA","LISTA","NEO","AI",
  "SCR","APE","KAITO","AR","BNT","PIXEL","LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET",
  "STG","REQ","CAKE","SUPER","FTT","STRAX",
];

const CURRENT_53 = ALL_PAIRS.slice(0, 53);

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

function runPortfolioDD(pairNames: string[], label: string) {
  interface PairData { name: string; ind: PairInd; sp: number; }
  const pairs: PairData[] = [];
  for (const name of pairNames) {
    const sym = REVERSE_MAP[name] ?? name;
    let raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) raw5m = load5m(`${name}USDT`);
    if (raw5m.length < 5000) continue;
    const ind = buildInd(raw5m);
    if (ind.h1.length < 100 || ind.h4.length < 50) continue;
    pairs.push({ name, ind, sp: SP[name] ?? DEFAULT_SPREAD });
  }

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
        if (reason === "sl") cooldowns.set(`${pos.pair}:${pos.dir}`, hour + SL_COOLDOWN_H * H);
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

  // Build daily equity curve
  const dailyPnl = new Map<number, number>();
  for (const t of sorted) { const day = Math.floor(t.xt / D) * D; dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl); }
  const days = [...dailyPnl.entries()].sort((a, b) => a[0] - b[0]);

  let cum = 0, peak = 0;
  const ddHistory: { date: string; dd: number; eq: number; dayPnl: number }[] = [];
  for (const [day, pnl] of days) {
    cum += pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    ddHistory.push({ date: new Date(day).toISOString().slice(0, 10), dd, eq: cum, dayPnl: pnl });
  }

  const maxDD = Math.max(...ddHistory.map(d => d.dd));
  const totalPnl = cum;
  const oosDays = (OOS_END - OOS_START) / D;
  const perDay = totalPnl / oosDays;

  console.log(`\n${"=".repeat(80)}`);
  console.log(`  ${label}`);
  console.log(`  ${sorted.length} trades, ${perDay >= 0 ? "+" : ""}$${Math.abs(perDay).toFixed(2)}/day, MaxDD $${maxDD.toFixed(0)}`);
  console.log(`${"=".repeat(80)}`);

  // DD brackets: how many days spent in each DD range
  const brackets = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130];
  console.log(`\n  DRAWDOWN FREQUENCY (of ${ddHistory.length} trading days)`);
  console.log(`  ${"DD Range".padEnd(20)} ${"Days".padStart(5)} ${"% of time".padStart(10)}`);
  console.log("  " + "-".repeat(40));

  const ddZero = ddHistory.filter(d => d.dd < 1).length;
  console.log(`  ${"At equity peak".padEnd(20)} ${String(ddZero).padStart(5)} ${(ddZero/ddHistory.length*100).toFixed(1).padStart(9)}%`);

  for (let i = 0; i < brackets.length; i++) {
    const lo = i === 0 ? 1 : brackets[i-1]!;
    const hi = brackets[i]!;
    const count = ddHistory.filter(d => d.dd >= lo && d.dd < hi).length;
    console.log(`  ${`$${lo}-$${hi}`.padEnd(20)} ${String(count).padStart(5)} ${(count/ddHistory.length*100).toFixed(1).padStart(9)}%`);
  }
  const over130 = ddHistory.filter(d => d.dd >= 130).length;
  console.log(`  ${">$130".padEnd(20)} ${String(over130).padStart(5)} ${(over130/ddHistory.length*100).toFixed(1).padStart(9)}%`);

  // Consecutive days in DD > $X
  console.log(`\n  CONSECUTIVE DAYS IN DRAWDOWN`);
  console.log(`  ${"Threshold".padEnd(15)} ${"Max streak".padStart(12)} ${"Avg streak".padStart(12)} ${"# episodes".padStart(12)}`);
  console.log("  " + "-".repeat(55));

  for (const thresh of [10, 20, 30, 50, 75, 100]) {
    let streak = 0, maxStreak = 0, episodes = 0, totalStreakDays = 0;
    for (const d of ddHistory) {
      if (d.dd >= thresh) {
        streak++;
        if (streak > maxStreak) maxStreak = streak;
      } else {
        if (streak > 0) { episodes++; totalStreakDays += streak; }
        streak = 0;
      }
    }
    if (streak > 0) { episodes++; totalStreakDays += streak; }
    const avg = episodes > 0 ? (totalStreakDays / episodes).toFixed(1) : "0";
    console.log(`  ${`DD > $${thresh}`.padEnd(15)} ${(maxStreak + "d").padStart(12)} ${(avg + "d").padStart(12)} ${String(episodes).padStart(12)}`);
  }

  // Worst 10 DD days
  console.log(`\n  WORST 10 DRAWDOWN DAYS (peak-to-trough)`);
  const worstDD = [...ddHistory].sort((a, b) => b.dd - a.dd).slice(0, 10);
  for (const d of worstDD) {
    console.log(`    ${d.date}  DD=$${d.dd.toFixed(0).padStart(4)}  Equity=$${d.eq.toFixed(0).padStart(5)}  DayPnL=${d.dayPnl >= 0 ? "+" : ""}$${Math.abs(d.dayPnl).toFixed(2)}`);
  }

  // Worst 10 single-day losses
  console.log(`\n  WORST 10 SINGLE-DAY LOSSES`);
  const worstDays = [...ddHistory].sort((a, b) => a.dayPnl - b.dayPnl).slice(0, 10);
  for (const d of worstDays) {
    console.log(`    ${d.date}  Loss=$${Math.abs(d.dayPnl).toFixed(2).padStart(6)}  DD=$${d.dd.toFixed(0).padStart(4)}  Equity=$${d.eq.toFixed(0).padStart(5)}`);
  }

  // Recovery analysis: for each time DD exceeds $50, how long to recover
  console.log(`\n  RECOVERY FROM DRAWDOWNS > $50`);
  let inDD = false, ddStartDate = "", ddStartIdx = 0, ddPeak = 0;
  for (let i = 0; i < ddHistory.length; i++) {
    const d = ddHistory[i]!;
    if (d.dd >= 50 && !inDD) { inDD = true; ddStartDate = d.date; ddStartIdx = i; ddPeak = d.dd; }
    if (inDD && d.dd > ddPeak) ddPeak = d.dd;
    if (inDD && d.dd < 5) {
      const recovDays = i - ddStartIdx;
      console.log(`    ${ddStartDate} -> ${d.date}: ${recovDays}d to recover, peak DD=$${ddPeak.toFixed(0)}`);
      inDD = false;
    }
  }
  if (inDD) console.log(`    ${ddStartDate} -> ongoing: peak DD=$${ddPeak.toFixed(0)} (not recovered by end of OOS)`);

  // Monthly P&L breakdown
  console.log(`\n  MONTHLY P&L`);
  const monthlyPnl = new Map<string, number>();
  for (const d of ddHistory) {
    const month = d.date.slice(0, 7);
    monthlyPnl.set(month, (monthlyPnl.get(month) ?? 0) + d.dayPnl);
  }
  console.log(`  ${"Month".padEnd(10)} ${"P&L".padStart(10)} ${"$/day".padStart(8)}`);
  console.log("  " + "-".repeat(30));
  for (const [month, pnl] of [...monthlyPnl.entries()].sort()) {
    const daysInMonth = ddHistory.filter(d => d.date.startsWith(month)).length;
    const pd = pnl / daysInMonth;
    console.log(`  ${month.padEnd(10)} ${(pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toFixed(2)}${" ".repeat(Math.max(0, 9 - ((pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toFixed(2)).length))} ${(pd >= 0 ? "+" : "") + "$" + Math.abs(pd).toFixed(2)}`);
  }
}

function main() {
  console.log("DRAWDOWN ANALYSIS - Current 53 vs Combined 127 pairs");

  runPortfolioDD(CURRENT_53, "CURRENT 53 PAIRS (baseline)");
  runPortfolioDD(ALL_PAIRS, "COMBINED 127 PAIRS (with new additions)");
}

main();
