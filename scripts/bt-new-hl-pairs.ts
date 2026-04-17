/**
 * Track 1: Download + Backtest ALL new Hyperliquid pairs
 * Uses DEPLOYED config: SL 0.5%, BE +2%, z 3.0/2.5, trail 10/5 6-stage, $7, no EMA/BTC filter
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

// DEPLOYED config
const MOM_LB = 3;
const VOL_WIN = 20;
const Z_LONG_1H = 3.0;
const Z_LONG_4H = 2.5;
const Z_SHORT_1H = -3.0;
const Z_SHORT_4H = -2.5;
const SL_PCT = 0.005;
const SL_CAP = 0.01;
const BE_AT = 2; // breakeven at +2% leveraged PnL
const MAX_HOLD_H = 72;
const SL_COOLDOWN_H = 1;
const BLOCK_HOURS = [22, 23];

const TRAIL_STEPS = [
  { activate: 10, dist: 5 },
  { activate: 15, dist: 4 },
  { activate: 20, dist: 3 },
  { activate: 25, dist: 2 },
  { activate: 35, dist: 1.5 },
  { activate: 50, dist: 1 },
];

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DEFAULT_SPREAD = 5e-4;

const DISPLAY_MAP: Record<string, string> = {
  "1000PEPE": "kPEPE", "1000FLOKI": "kFLOKI", "1000BONK": "kBONK",
  "1000SHIB": "kSHIB", "1000DOGS": "kDOGS", "1000LUNC": "kLUNC",
};
const REVERSE_MAP: Record<string, string> = {
  kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK",
  kSHIB: "1000SHIB", kDOGS: "1000DOGS", kLUNC: "1000LUNC",
};

// Current 53 deployed pairs
const CURRENT_PAIRS = new Set([
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET",
  "FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR",
  "PENDLE","PNUT","ATOM","TON","SEI","STX",
]);

// New HL pairs to try downloading
const NEW_PAIRS = [
  "ACE","AERO","AI","ALT","ANIME","APE","APEX","AR","ARK","AXS",
  "BADGER","BANANA","BIGTIME","BIO","BLAST","BLZ","BNT","BOME","BRETT","BSV",
  "CAKE","CANTO","CATI","CELO","CFX","COMP","CYBER",
  "DYM","EIGEN","ENS","ETC","ETHFI",
  "FARTCOIN","FRIEND","FTM","FTT","FXS","GALA","GAS","GMT","GMX","GOAT","GRASS",
  "ILV","IO","IOTA",
  "JELLY","KAITO","KAS",
  "LAYER","LISTA","LIT","LOOM",
  "MANTA","MATIC","MAV","ME","MELANIA","MEME","MET","MEW","MINA","MNT","MOODENG","MORPHO","MOVE","MYRO",
  "NEIROETH","NEO","NOT","NTRN",
  "OGN","OM","OMNI","ORBS","ORDI",
  "PANDORA","PAXG","PENGU","PEOPLE","PIXEL","POLYX","POPCAT",
  "RDNT","REQ","REZ","RLB","RSR",
  "SAGA","SCR","SKY","SPX","STG","STRAX","STRK","SUPER","SUSHI",
  "TNSR","TRB","TURBO","UMA",
  "USTC","USUAL",
  "W","WCT",
  "XAI","XMR",
  "YGG",
  "ZEN","ZETA","ZK","ZRO",
  "kBONK","kFLOKI","kSHIB","kDOGS","kLUNC","kNEIRO","kPEPE",
];

const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function download5m(sym: string): Promise<number> {
  const cacheFile = path.join(CACHE_5M, `${sym}.json`);
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    if (stat.size > 1_000_000) {
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as any[];
      return data.length;
    }
  }

  const allCandles: C[] = [];
  const startTime = new Date("2023-01-01").getTime();
  const endTime = new Date("2026-04-07").getTime();
  const chunkMs = 1000 * 5 * 60 * 1000;

  for (let t = startTime; t < endTime; t += chunkMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=5m&startTime=${t}&limit=1000`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        if (res.status === 400) return 0;
        break;
      }
      const raw = (await res.json()) as unknown[][];
      if (!Array.isArray(raw) || raw.length === 0) break;
      for (const r of raw) {
        allCandles.push({ t: r[0] as number, o: +(r[1] as string), h: +(r[2] as string), l: +(r[3] as string), c: +(r[4] as string) });
      }
      if (raw.length < 1000) break;
    } catch {
      break;
    }
    await sleep(80);
  }

  if (allCandles.length === 0) return 0;
  allCandles.sort((a, b) => a.t - b.t);
  fs.writeFileSync(cacheFile, JSON.stringify(allCandles));
  return allCandles.length;
}

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
    result.push({
      t: ts, o: grp[0]!.o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1]!.c,
    });
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
      sumSq += r * r;
      count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

interface PairIndicators {
  h1: C[]; h4: C[]; z1h: number[]; z4h: number[];
  h1TsMap: Map<number, number>; h4TsMap: Map<number, number>;
}

function buildPairIndicators(bars5m: C[]): PairIndicators {
  const h1 = aggregate(bars5m, H, 10);
  const h4 = aggregate(bars5m, H4, 40);
  const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
  const z4h = computeZScores(h4, MOM_LB, VOL_WIN);
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  return { h1, h4, z1h, z4h, h1TsMap, h4TsMap };
}

function getLatest4hZ(ind: PairIndicators, t: number): number {
  const bucket = Math.floor(t / H4) * H4;
  let idx = ind.h4TsMap.get(bucket);
  if (idx !== undefined && idx > 0) return ind.z4h[idx - 1]!;
  let lo = 0, hi = ind.h4.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ind.h4[mid]!.t < t) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best >= 0 ? ind.z4h[best]! : 0;
}

function calcPnl(dir: "long" | "short", ep: number, xp: number, sp: number, isSL: boolean): number {
  const slip = isSL ? sp * 1.5 : sp;
  const exitPx = dir === "long" ? xp * (1 - slip) : xp * (1 + slip);
  const raw = dir === "long" ? (exitPx / ep - 1) * NOT : (ep / exitPx - 1) * NOT;
  return raw - NOT * FEE * 2;
}

function fmtPnl(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

// Unified portfolio sim
function runPortfolio(pairNames: string[], label: string): { total: number; perDay: number; maxDD: number; n: number; wr: number; pf: number; trPerDay: number } {
  interface PairData { name: string; ind: PairIndicators; sp: number; }
  const pairs: PairData[] = [];
  for (const name of pairNames) {
    const sym = REVERSE_MAP[name] ?? name;
    let raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) raw5m = load5m(`${name}USDT`);
    if (raw5m.length < 5000) continue;
    const ind = buildPairIndicators(raw5m);
    if (ind.h1.length < 100 || ind.h4.length < 50) continue;
    pairs.push({ name, ind, sp: SP[name] ?? DEFAULT_SPREAD });
  }

  const allH1Times: number[] = [];
  for (const p of pairs) {
    for (const bar of p.ind.h1) {
      if (bar.t >= OOS_START && bar.t < OOS_END) allH1Times.push(bar.t);
    }
  }
  const uniqueHours = [...new Set(allH1Times)].sort((a, b) => a - b);

  interface OpenPos {
    pair: string; dir: "long" | "short"; ep: number; et: number;
    sl: number; peakPnlPct: number; sp: number;
  }
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
        closedTrades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: hour, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cooldowns.set(`${pos.pair}:${pos.dir}`, hour + SL_COOLDOWN_H * H);
      }
    }

    const hourOfDay = new Date(hour).getUTCHours();
    if (BLOCK_HOURS.includes(hourOfDay)) continue;

    interface Signal { pair: string; dir: "long" | "short"; z1h: number; ep: number; sl: number; sp: number; }
    const signals: Signal[] = [];

    for (const p of pairs) {
      const barIdx = p.ind.h1TsMap.get(hour);
      if (barIdx === undefined || barIdx < VOL_WIN + 2) continue;
      const bar = p.ind.h1[barIdx]!;
      const prev = barIdx - 1;
      if (openPositions.some(op => op.pair === p.name)) continue;

      const z1h = p.ind.z1h[prev]!;
      const z4h = getLatest4hZ(p.ind, hour);
      let dir: "long" | "short" | null = null;
      if (z1h > Z_LONG_1H && z4h > Z_LONG_4H) dir = "long";
      if (z1h < Z_SHORT_1H && z4h < Z_SHORT_4H) dir = "short";
      if (!dir) continue;

      const cdKey = `${p.name}:${dir}`;
      const cdUntil = cooldowns.get(cdKey);
      if (cdUntil && hour < cdUntil) continue;

      const ep = dir === "long" ? bar.o * (1 + p.sp) : bar.o * (1 - p.sp);
      const slDist = Math.min(ep * SL_PCT, ep * SL_CAP);
      const sl = dir === "long" ? ep - slDist : ep + slDist;
      signals.push({ pair: p.name, dir, z1h, ep, sl, sp: p.sp });
    }

    signals.sort((a, b) => Math.abs(b.z1h) - Math.abs(a.z1h));
    for (const sig of signals) {
      openPositions.push({ pair: sig.pair, dir: sig.dir, ep: sig.ep, et: hour, sl: sig.sl, peakPnlPct: 0, sp: sig.sp });
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
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const oosDays = (OOS_END - OOS_START) / D;
  const perDay = totalPnl / oosDays;
  const trPerDay = sorted.length / oosDays;

  console.log(
    `  ${label.padEnd(40)} ${String(sorted.length).padStart(5)} ${trPerDay.toFixed(1).padStart(6)} ${(wr.toFixed(1) + "%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(totalPnl).padStart(9)} ${fmtPnl(perDay).padStart(8)} $${maxDD.toFixed(0).padStart(4)}`
  );

  return { total: totalPnl, perDay, maxDD, n: sorted.length, wr, pf, trPerDay };
}

async function main() {
  console.log("=".repeat(100));
  console.log("  TRACK 1: NEW HYPERLIQUID PAIRS - DOWNLOAD + BACKTEST");
  console.log("  Deployed: SL 0.5%, BE +2%, z 3.0/2.5, trail 10/5 6-stage, $7, no filters");
  console.log("  OOS: 2025-06-01 to 2026-03-25");
  console.log("=".repeat(100));

  fs.mkdirSync(CACHE_5M, { recursive: true });

  // Phase 1: Download
  console.log("\n--- PHASE 1: Download new pairs from Binance ---\n");
  const downloaded: string[] = [];
  const failed: string[] = [];

  for (const hlName of NEW_PAIRS) {
    const binanceName = REVERSE_MAP[hlName] ?? hlName;
    const variants = [`${binanceName}USDT`];
    if (binanceName !== hlName) variants.push(`${hlName}USDT`);

    let found = false;
    for (const sym of variants) {
      const cacheFile = path.join(CACHE_5M, `${sym}.json`);
      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 1_000_000) {
        const data = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as any[];
        console.log(`  [cache] ${hlName} -> ${sym}: ${data.length} candles`);
        downloaded.push(hlName);
        found = true;
        break;
      }

      const count = await download5m(sym);
      if (count > 10000) {
        console.log(`  [new] ${hlName} -> ${sym}: ${count} candles`);
        downloaded.push(hlName);
        found = true;
        break;
      }
    }
    if (!found) failed.push(hlName);
  }

  console.log(`\n  Downloaded: ${downloaded.length} | Not on Binance: ${failed.length}`);
  if (failed.length > 0) console.log(`  Failed: ${failed.join(", ")}`);

  // Phase 2: Backtest each new pair individually
  console.log("\n--- PHASE 2: Per-pair GARCH v2 backtest ---\n");

  interface PairResult { name: string; n: number; wr: number; pf: number; perDay: number; maxDD: number; total: number; }
  const results: PairResult[] = [];
  const oosDays = (OOS_END - OOS_START) / D;

  for (const hlName of downloaded) {
    const sym = REVERSE_MAP[hlName] ?? hlName;
    let raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) raw5m = load5m(`${hlName}USDT`);
    if (raw5m.length < 5000) continue;

    const ind = buildPairIndicators(raw5m);
    if (ind.h1.length < 100 || ind.h4.length < 50) continue;

    const trades: Tr[] = [];
    const sp = SP[hlName] ?? DEFAULT_SPREAD;

    interface Pos { dir: "long" | "short"; ep: number; et: number; sl: number; peakPnlPct: number; }
    let pos: Pos | null = null;

    for (let barIdx = VOL_WIN + 2; barIdx < ind.h1.length; barIdx++) {
      const bar = ind.h1[barIdx]!;
      const prev = barIdx - 1;

      if (pos) {
        const hoursHeld = (bar.t - pos.et) / H;
        if (hoursHeld >= MAX_HOLD_H) {
          const pnl = calcPnl(pos.dir, pos.ep, bar.c, sp, false);
          if (pos.et >= OOS_START && pos.et < OOS_END) trades.push({ pair: hlName, dir: pos.dir, ep: pos.ep, xp: bar.c, et: pos.et, xt: bar.t, pnl, reason: "maxh" });
          pos = null;
        }
        if (pos && pos.peakPnlPct >= BE_AT) {
          const beHit = pos.dir === "long" ? bar.l <= pos.ep : bar.h >= pos.ep;
          if (beHit) {
            const pnl = calcPnl(pos.dir, pos.ep, pos.ep, sp, false);
            if (pos.et >= OOS_START && pos.et < OOS_END) trades.push({ pair: hlName, dir: pos.dir, ep: pos.ep, xp: pos.ep, et: pos.et, xt: bar.t, pnl, reason: "be" });
            pos = null;
          }
        }
        if (pos) {
          const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
          if (slHit) {
            const pnl = calcPnl(pos.dir, pos.ep, pos.sl, sp, true);
            if (pos.et >= OOS_START && pos.et < OOS_END) trades.push({ pair: hlName, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: bar.t, pnl, reason: "sl" });
            pos = null;
          }
        }
        if (pos) {
          const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * LEV * 100 : (pos.ep / bar.l - 1) * LEV * 100;
          if (best > pos.peakPnlPct) pos.peakPnlPct = best;
          const curr = pos.dir === "long" ? (bar.c / pos.ep - 1) * LEV * 100 : (pos.ep / bar.c - 1) * LEV * 100;
          let trailDist = Infinity;
          for (const step of TRAIL_STEPS) { if (pos.peakPnlPct >= step.activate) trailDist = step.dist; }
          if (trailDist < Infinity && curr <= pos.peakPnlPct - trailDist) {
            const pnl = calcPnl(pos.dir, pos.ep, bar.c, sp, false);
            if (pos.et >= OOS_START && pos.et < OOS_END) trades.push({ pair: hlName, dir: pos.dir, ep: pos.ep, xp: bar.c, et: pos.et, xt: bar.t, pnl, reason: "trail" });
            pos = null;
          }
        }
      }

      if (!pos && bar.t >= OOS_START && bar.t < OOS_END) {
        const hourOfDay = new Date(bar.t).getUTCHours();
        if (BLOCK_HOURS.includes(hourOfDay)) continue;
        const z1h = ind.z1h[prev]!;
        const z4h = getLatest4hZ(ind, bar.t);
        let dir: "long" | "short" | null = null;
        if (z1h > Z_LONG_1H && z4h > Z_LONG_4H) dir = "long";
        if (z1h < Z_SHORT_1H && z4h < Z_SHORT_4H) dir = "short";
        if (dir) {
          const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
          const slDist = Math.min(ep * SL_PCT, ep * SL_CAP);
          const sl = dir === "long" ? ep - slDist : ep + slDist;
          pos = { dir, ep, et: bar.t, sl, peakPnlPct: 0 };
        }
      }
    }

    if (trades.length === 0) continue;

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
    let cum2 = 0, peak2 = 0, maxDD2 = 0;
    const sorted2 = [...trades].sort((a, b) => a.xt - b.xt);
    for (const t of sorted2) { cum2 += t.pnl; if (cum2 > peak2) peak2 = cum2; if (peak2 - cum2 > maxDD2) maxDD2 = peak2 - cum2; }
    const perDay = total / oosDays;

    const verdict = pf > 1.3 && perDay > 0 && trades.length >= 3 ? "ADD"
      : pf > 1.1 && perDay > 0 && trades.length >= 3 ? "MAYBE"
      : total > 0 ? "WEAK" : "SKIP";

    console.log(
      `  ${hlName.padEnd(12)} N=${String(trades.length).padStart(4)} WR=${(wins.length / trades.length * 100).toFixed(1).padStart(5)}% `
      + `PF=${(pf === Infinity ? "  Inf" : pf.toFixed(2)).padStart(5)} PnL=${fmtPnl(total).padStart(9)} `
      + `$/d=${fmtPnl(perDay).padStart(8)} DD=$${maxDD2.toFixed(0).padStart(4)}  ${verdict}`
    );

    results.push({ name: hlName, n: trades.length, wr: wins.length / trades.length * 100, pf, perDay, maxDD: maxDD2, total });
  }

  // Phase 3: Rankings
  console.log("\n" + "=".repeat(100));
  console.log("  NEW PAIR RANKINGS (sorted by $/day)");
  console.log("=".repeat(100));

  const addPairs = results.filter(r => r.pf > 1.1 && r.perDay > 0 && r.n >= 3);
  addPairs.sort((a, b) => b.perDay - a.perDay);

  console.log(`\n  Pairs meeting criteria (PF>1.1, $/d>0, N>=3): ${addPairs.length}`);
  if (addPairs.length > 0) {
    console.log(`\n  ${"Pair".padEnd(12)} ${"N".padStart(4)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"$/day".padStart(8)} ${"MaxDD".padStart(6)} ${"Total".padStart(9)}`);
    console.log("  " + "-".repeat(60));
    for (const r of addPairs) {
      console.log(`  ${r.name.padEnd(12)} ${String(r.n).padStart(4)} ${(r.wr.toFixed(1) + "%").padStart(6)} ${r.pf.toFixed(2).padStart(6)} ${fmtPnl(r.perDay).padStart(8)} $${r.maxDD.toFixed(0).padStart(5)} ${fmtPnl(r.total).padStart(9)}`);
    }
  }

  // Phase 4: Unified portfolio sims
  console.log("\n" + "=".repeat(100));
  console.log("  UNIFIED PORTFOLIO SIM");
  console.log("=".repeat(100));

  const currentList = [...CURRENT_PAIRS];
  const newWinners = addPairs.map(r => r.name);
  const allPairs = [...currentList, ...newWinners];

  const hdr = `  ${"Config".padEnd(40)} ${"Trades".padStart(5)} ${"Tr/d".padStart(6)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"PnL".padStart(9)} ${"$/day".padStart(8)} ${"MaxDD".padStart(5)}`;
  console.log(`\n${hdr}`);
  console.log("  " + "-".repeat(85));

  const baseline = runPortfolio(currentList, `Current 53 pairs`);
  if (newWinners.length > 0) {
    runPortfolio(newWinners, `New winners only (${newWinners.length})`);
    const combined = runPortfolio(allPairs, `Combined (${allPairs.length} pairs)`);
    console.log(`\n  Delta: ${fmtPnl(combined.perDay - baseline.perDay)}/day, MaxDD change: ${fmtPnl(combined.maxDD - baseline.maxDD)}`);
    console.log(`\n  Recommended additions: ${newWinners.join(", ")}`);
  } else {
    console.log("\n  No new pairs meet criteria. Current 53 is the best set.");
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
