/**
 * Track 2: 15m Z-Score Entry Backtest for GARCH v2
 * Tests whether a 15m z-score entry (between 1h checks) improves performance.
 * Compares 1h-only (baseline), 15m-only, and combined 1h+15m modes.
 * Deployed config: SL 0.5%, BE +2%, z 3.0/2.5, trail 10/5 6-stage, $7, no filters
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M15 = 15 * 60_000;
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const MARGIN = 7;
const NOT = MARGIN * LEV;

const MOM_LB = 3;
const VOL_WIN = 20;
const SL_CAP = 0.01;
const Z_LONG_4H = 2.5;
const Z_SHORT_4H = -2.5;
const MAX_HOLD_H = 72;
const SL_COOLDOWN_H = 1;
const BLOCK_HOURS = [22, 23];
const BE_AT = 2;

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

const REVERSE_MAP: Record<string, string> = {
  kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB",
};

const PAIRS_53 = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET",
  "FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR",
  "PENDLE","PNUT","ATOM","TON","SEI","STX",
];

const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr { pair: string; dir: "long"|"short"; ep: number; xp: number; et: number; xt: number; pnl: number; reason: string; }

function load5m(sym: string): C[] {
  const fp = path.join(CACHE_5M, `${sym}.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(bucket);
    if (!arr) { arr = []; groups.set(bucket, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({ t: ts, o: grp[0]!.o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1]!.c });
  }
  return result.sort((a, b) => a.t - b.t);
}

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i]!.c / cs[i - momLb]!.c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j]!.c / cs[j - 1]!.c - 1;
      sumSq += r * r; count++;
    }
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

interface AllIndicators {
  m15: C[]; h1: C[]; h4: C[];
  z15m: number[]; z1h: number[]; z4h: number[];
  m15TsMap: Map<number, number>; h1TsMap: Map<number, number>; h4TsMap: Map<number, number>;
}

function buildAllIndicators(bars5m: C[]): AllIndicators {
  const m15 = aggregate(bars5m, M15, 2);
  const h1 = aggregate(bars5m, H, 10);
  const h4 = aggregate(bars5m, H4, 40);
  const z15m = computeZScores(m15, MOM_LB, VOL_WIN);
  const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
  const z4h = computeZScores(h4, MOM_LB, VOL_WIN);
  const m15TsMap = new Map<number, number>(); m15.forEach((c, i) => m15TsMap.set(c.t, i));
  const h1TsMap = new Map<number, number>(); h1.forEach((c, i) => h1TsMap.set(c.t, i));
  const h4TsMap = new Map<number, number>(); h4.forEach((c, i) => h4TsMap.set(c.t, i));
  return { m15, h1, h4, z15m, z1h, z4h, m15TsMap, h1TsMap, h4TsMap };
}

function getLatest4hZ(ind: AllIndicators, t: number): number {
  const bucket = Math.floor(t / H4) * H4;
  let idx = ind.h4TsMap.get(bucket);
  if (idx !== undefined && idx > 0) return ind.z4h[idx - 1]!;
  let lo = 0, hi = ind.h4.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ind.h4[mid]!.t < t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return best >= 0 ? ind.z4h[best]! : 0;
}

// mode: "1h" = baseline, "15m" = 15m only, "combined" = both
function runSweepConfig(
  allPairData: { name: string; ind: AllIndicators; sp: number }[],
  mode: "1h" | "15m" | "combined",
  z1hThresh: number, z15mThresh: number, slPct: number, sl15mPct: number,
  label: string,
): { n: number; trPerDay: number; wr: number; pf: number; total: number; perDay: number; maxDD: number } {
  const oosDays = (OOS_END - OOS_START) / D;

  // Collect all time points to iterate through
  const allTimestamps = new Set<number>();
  for (const p of allPairData) {
    if (mode === "1h") {
      for (const bar of p.ind.h1) { if (bar.t >= OOS_START && bar.t < OOS_END) allTimestamps.add(bar.t); }
    } else {
      // For 15m and combined, we iterate on 15m boundaries
      for (const bar of p.ind.m15) { if (bar.t >= OOS_START && bar.t < OOS_END) allTimestamps.add(bar.t); }
    }
  }
  const timePoints = [...allTimestamps].sort((a, b) => a - b);

  interface OpenPos {
    pair: string; dir: "long"|"short"; ep: number; et: number;
    sl: number; peakPnlPct: number; sp: number; source: "1h"|"15m";
  }
  const openPositions: OpenPos[] = [];
  const closedTrades: Tr[] = [];
  const cooldowns = new Map<string, number>();

  for (const ts of timePoints) {
    const hourOfDay = new Date(ts).getUTCHours();
    const isH1Boundary = ts % H === 0;
    const isBlocked = BLOCK_HOURS.includes(hourOfDay);

    // EXIT checks - use the bar resolution matching entry source
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const p = allPairData.find(pd => pd.name === pos.pair);
      if (!p) continue;

      // Find the bar at this timestamp for exit checks
      // Use 15m bars for 15m entries, 1h bars for 1h entries (but check more frequently)
      let bar: C | undefined;
      if (mode === "1h") {
        const idx = p.ind.h1TsMap.get(ts);
        if (idx !== undefined) bar = p.ind.h1[idx];
      } else {
        // For 15m/combined mode, use 15m bars for exit precision
        const idx = p.ind.m15TsMap.get(ts);
        if (idx !== undefined) bar = p.ind.m15[idx];
      }
      if (!bar) continue;

      let xp = 0, reason = "", isSL = false;
      const hoursHeld = (ts - pos.et) / H;
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
        const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * LEV * 100 : (pos.ep / bar.l - 1) * LEV * 100;
        if (best > pos.peakPnlPct) pos.peakPnlPct = best;
        const curr = pos.dir === "long" ? (bar.c / pos.ep - 1) * LEV * 100 : (pos.ep / bar.c - 1) * LEV * 100;
        let trailDist = Infinity;
        for (const step of TRAIL_STEPS) { if (pos.peakPnlPct >= step.activate) trailDist = step.dist; }
        if (trailDist < Infinity && curr <= pos.peakPnlPct - trailDist) { xp = bar.c; reason = "trail"; }
      }
      if (xp > 0) {
        const pnl = calcPnl(pos.dir, pos.ep, xp, pos.sp, isSL);
        closedTrades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: ts, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cooldowns.set(`${pos.pair}:${pos.dir}`, ts + SL_COOLDOWN_H * H);
      }
    }

    if (isBlocked) continue;

    // ENTRY checks
    for (const p of allPairData) {
      if (openPositions.some(op => op.pair === p.name)) continue;

      let dir: "long"|"short"|null = null;
      let entrySl = slPct;
      let source: "1h"|"15m" = "1h";

      const z4h = getLatest4hZ(p.ind, ts);

      // 1h entry (only on 1h boundaries)
      if ((mode === "1h" || mode === "combined") && isH1Boundary) {
        const idx = p.ind.h1TsMap.get(ts);
        if (idx !== undefined && idx >= VOL_WIN + 2) {
          const z1h = p.ind.z1h[idx - 1]!;
          if (z1h > z1hThresh && z4h > Z_LONG_4H) dir = "long";
          if (z1h < -z1hThresh && z4h < Z_SHORT_4H) dir = "short";
          if (dir) { entrySl = slPct; source = "1h"; }
        }
      }

      // 15m entry (on any 15m boundary, but NOT if 1h already fired this bar)
      if (!dir && (mode === "15m" || mode === "combined")) {
        const idx15 = p.ind.m15TsMap.get(ts);
        if (idx15 !== undefined && idx15 >= VOL_WIN + 2) {
          const z15 = p.ind.z15m[idx15 - 1]!;
          if (z15 > z15mThresh && z4h > Z_LONG_4H) dir = "long";
          if (z15 < -z15mThresh && z4h < Z_SHORT_4H) dir = "short";
          if (dir) { entrySl = sl15mPct; source = "15m"; }
        }
      }

      if (!dir) continue;
      const cdKey = `${p.name}:${dir}`;
      const cdUntil = cooldowns.get(cdKey);
      if (cdUntil && ts < cdUntil) continue;

      // Use the appropriate bar for entry price
      let entryBar: C | undefined;
      if (source === "1h") {
        const idx = p.ind.h1TsMap.get(ts);
        if (idx !== undefined) entryBar = p.ind.h1[idx];
      } else {
        const idx = p.ind.m15TsMap.get(ts);
        if (idx !== undefined) entryBar = p.ind.m15[idx];
      }
      if (!entryBar) continue;

      const ep = dir === "long" ? entryBar.o * (1 + p.sp) : entryBar.o * (1 - p.sp);
      const slDist = Math.min(ep * entrySl, ep * SL_CAP);
      const sl = dir === "long" ? ep - slDist : ep + slDist;
      openPositions.push({ pair: p.name, dir, ep, et: ts, sl, peakPnlPct: 0, sp: p.sp, source });
    }
  }

  // Close remaining
  for (const pos of openPositions) {
    const p = allPairData.find(pd => pd.name === pos.pair);
    if (!p) continue;
    const bars = mode === "1h" ? p.ind.h1 : p.ind.m15;
    const lastBar = bars[bars.length - 1]!;
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
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const perDay = totalPnl / oosDays;
  const trPerDay = sorted.length / oosDays;

  console.log(
    `  ${label.padEnd(35)} ${String(sorted.length).padStart(5)} ${trPerDay.toFixed(1).padStart(6)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(totalPnl).padStart(9)} ${fmtPnl(perDay).padStart(8)} $${maxDD.toFixed(0).padStart(4)}`
  );

  return { n: sorted.length, trPerDay, wr, pf, total: totalPnl, perDay, maxDD };
}

function main() {
  console.log("=".repeat(100));
  console.log("  TRACK 2: 15m Z-SCORE ENTRY BACKTEST");
  console.log("  Deployed config + 15m entry path sweep");
  console.log("  53 pairs, OOS 2025-06-01 to 2026-03-25");
  console.log("=".repeat(100));

  // Load all pair data
  console.log("\n  Loading 53 pairs...");
  const allPairData: { name: string; ind: AllIndicators; sp: number }[] = [];
  for (const name of PAIRS_53) {
    const sym = REVERSE_MAP[name] ?? name;
    let raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) raw5m = load5m(`${name}USDT`);
    if (raw5m.length < 5000) { console.log(`  SKIP ${name}`); continue; }
    const ind = buildAllIndicators(raw5m);
    if (ind.h1.length < 100 || ind.h4.length < 50) continue;
    allPairData.push({ name, ind, sp: SP[name] ?? DEFAULT_SPREAD });
  }
  console.log(`  Loaded ${allPairData.length} pairs\n`);

  const hdr = `  ${"Config".padEnd(35)} ${"Trades".padStart(5)} ${"Tr/d".padStart(6)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"PnL".padStart(9)} ${"$/day".padStart(8)} ${"MaxDD".padStart(5)}`;

  // 1h baseline
  console.log("--- BASELINE (1h only, deployed config) ---\n");
  console.log(hdr);
  console.log("  " + "-".repeat(80));
  runSweepConfig(allPairData, "1h", 3.0, 0, 0.005, 0.005, "1h z3.0 SL0.5% (baseline)");

  // 15m only sweep
  console.log("\n--- 15m ONLY (no 1h entries) ---\n");
  console.log(hdr);
  console.log("  " + "-".repeat(80));
  const z15mThresholds = [2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
  const sl15mValues = [0.002, 0.003, 0.004, 0.005];
  for (const z of z15mThresholds) {
    for (const sl of sl15mValues) {
      runSweepConfig(allPairData, "15m", 0, z, 0.005, sl, `15m z${z.toFixed(1)} SL${(sl*100).toFixed(1)}%`);
    }
  }

  // Combined 1h + 15m
  console.log("\n--- COMBINED (1h z3.0 + 15m entry) ---\n");
  console.log(hdr);
  console.log("  " + "-".repeat(80));
  runSweepConfig(allPairData, "1h", 3.0, 0, 0.005, 0.005, "1h z3.0 SL0.5% (baseline)");
  for (const z of [3.0, 3.5, 4.0, 4.5, 5.0]) {
    for (const sl of [0.003, 0.004, 0.005]) {
      runSweepConfig(allPairData, "combined", 3.0, z, 0.005, sl, `1h+15m z${z.toFixed(1)} sl15m=${(sl*100).toFixed(1)}%`);
    }
  }

  console.log("\n" + "=".repeat(100));
  console.log("  DONE");
}

main();
