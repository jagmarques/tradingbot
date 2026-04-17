/**
 * Leverage-aware optimization: tiered margins, pair selection, per-tier z-scores
 * Baseline: $6.64/day, MaxDD $62, PF 2.38 (127p, $7 uniform, 1h CD, real leverage)
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const MOM_LB = 3;
const VOL_WIN = 20;
const SL_PCT = 0.005;
const SL_CAP = 0.01;
const BE_AT = 2;
const MAX_HOLD_H = 72;
const BLOCK_HOURS = [22, 23];
const CD_H = 1;

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

const LEV_MAP = new Map<string, number>();
for (const line of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, l] = line.split(":"); LEV_MAP.set(n!, parseInt(l!));
}
function getPairLev(name: string): number { return Math.min(LEV_MAP.get(name) ?? 3, 10); }

const ALL_127 = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET","FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR","PENDLE","PNUT","ATOM","TON","SEI","STX",
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN","TNSR","CATI","TURBO","MOVE","GALA","STRK","SAGA","ILV","GMX","OM",
  "CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC","USUAL","UMA","USTC","MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS","MINA","LISTA","NEO","AI","SCR","APE","KAITO","AR","BNT","PIXEL",
  "LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET","STG","REQ","CAKE","SUPER","FTT","STRAX",
];

const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();
const OOS_DAYS = (OOS_END - OOS_START) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr { pair: string; dir: "long"|"short"; ep: number; xp: number; et: number; xt: number; pnl: number; reason: string; }
interface PairInd { h1: C[]; h4: C[]; z1h: number[]; z4h: number[]; h1TsMap: Map<number, number>; h4TsMap: Map<number, number>; }

function load5m(sym: string): C[] {
  const fp = path.join(CACHE_5M, `${sym}.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] } : b).sort((a: C, b: C) => a.t - b.t);
}
function aggregate(bars: C[], p: number, m: number): C[] {
  const g = new Map<number, C[]>();
  for (const b of bars) { const k = Math.floor(b.t / p) * p; let a = g.get(k); if (!a) { a = []; g.set(k, a); } a.push(b); }
  const r: C[] = [];
  for (const [t, grp] of g) { if (grp.length < m) continue; grp.sort((a, b) => a.t - b.t); r.push({ t, o: grp[0]!.o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1]!.c }); }
  return r.sort((a, b) => a.t - b.t);
}
function computeZ(cs: C[]): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < cs.length; i++) {
    const mom = cs[i]!.c / cs[i - MOM_LB]!.c - 1;
    let ss = 0, c = 0;
    for (let j = Math.max(1, i - VOL_WIN); j <= i; j++) { const r = cs[j]!.c / cs[j - 1]!.c - 1; ss += r * r; c++; }
    if (c < 10) continue; const v = Math.sqrt(ss / c); if (v === 0) continue; z[i] = mom / v;
  }
  return z;
}
function buildInd(b: C[]): PairInd {
  const h1 = aggregate(b, H, 10); const h4 = aggregate(b, H4, 40);
  const z1h = computeZ(h1); const z4h = computeZ(h4);
  const h1m = new Map<number, number>(); h1.forEach((c, i) => h1m.set(c.t, i));
  const h4m = new Map<number, number>(); h4.forEach((c, i) => h4m.set(c.t, i));
  return { h1, h4, z1h, z4h, h1TsMap: h1m, h4TsMap: h4m };
}
function get4hZ(ind: PairInd, t: number): number {
  const b = Math.floor(t / H4) * H4; let i = ind.h4TsMap.get(b);
  if (i !== undefined && i > 0) return ind.z4h[i - 1]!;
  let lo = 0, hi = ind.h4.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ind.h4[m]!.t < t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? ind.z4h[best]! : 0;
}
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface PD { name: string; ind: PairInd; sp: number; lev: number; }

// Core sim: accepts per-pair margin and z-score overrides
function runSim(pairs: PD[], opts: {
  marginFn: (lev: number) => number;
  zLong1h?: number; zLong4h?: number; zShort1h?: number; zShort4h?: number;
  zByLev?: Map<number, { l1h: number; l4h: number; s1h: number; s4h: number }>;
  label: string;
}): { n: number; pd: number; dd: number; pf: number; wr: number; tpd: number } {
  const zL1 = opts.zLong1h ?? 3.0; const zL4 = opts.zLong4h ?? 2.5;
  const zS1 = opts.zShort1h ?? -3.0; const zS4 = opts.zShort4h ?? -2.5;

  const allT = new Set<number>();
  for (const p of pairs) for (const b of p.ind.h1) if (b.t >= OOS_START && b.t < OOS_END) allT.add(b.t);
  const hours = [...allT].sort((a, b) => a - b);

  interface OP { pair: string; dir: "long"|"short"; ep: number; et: number; sl: number; peak: number; sp: number; lev: number; not: number; }
  const open: OP[] = []; const closed: Tr[] = []; const cd = new Map<string, number>();

  for (const hr of hours) {
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i]!; const pd = pairs.find(p => p.name === pos.pair); if (!pd) continue;
      const bi = pd.ind.h1TsMap.get(hr); if (bi === undefined) continue; const bar = pd.ind.h1[bi]!;
      let xp = 0, reason = "", isSL = false;
      if ((hr - pos.et) / H >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }
      if (!xp && pos.peak >= BE_AT) { if (pos.dir === "long" ? bar.l <= pos.ep : bar.h >= pos.ep) { xp = pos.ep; reason = "be"; } }
      if (!xp) { if (pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; } }
      if (!xp) {
        const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.l - 1) * pos.lev * 100;
        if (best > pos.peak) pos.peak = best;
        const cur = pos.dir === "long" ? (bar.c / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.c - 1) * pos.lev * 100;
        let td = Infinity; for (const s of TRAIL_STEPS) if (pos.peak >= s.activate) td = s.dist;
        if (td < Infinity && cur <= pos.peak - td) { xp = bar.c; reason = "trail"; }
      }
      if (xp > 0) {
        const sl2 = isSL ? pos.sp * 1.5 : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - sl2) : xp * (1 + sl2);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: hr, pnl, reason });
        open.splice(i, 1); if (reason === "sl") cd.set(`${pos.pair}:${pos.dir}`, hr + CD_H * H);
      }
    }
    if (BLOCK_HOURS.includes(new Date(hr).getUTCHours())) continue;
    for (const p of pairs) {
      const bi = p.ind.h1TsMap.get(hr); if (bi === undefined || bi < VOL_WIN + 2) continue;
      if (open.some(o => o.pair === p.name)) continue;
      const z1h = p.ind.z1h[bi - 1]!; const z4h = get4hZ(p.ind, hr);
      // Per-leverage z-score overrides
      const zCfg = opts.zByLev?.get(p.lev);
      const myZL1 = zCfg?.l1h ?? zL1; const myZL4 = zCfg?.l4h ?? zL4;
      const myZS1 = zCfg?.s1h ?? zS1; const myZS4 = zCfg?.s4h ?? zS4;
      let dir: "long"|"short"|null = null;
      if (z1h > myZL1 && z4h > myZL4) dir = "long";
      if (z1h < myZS1 && z4h < myZS4) dir = "short";
      if (!dir) continue;
      const ck = `${p.name}:${dir}`; if (cd.has(ck) && hr < cd.get(ck)!) continue;
      const margin = opts.marginFn(p.lev);
      const not = margin * p.lev;
      const ep = dir === "long" ? p.ind.h1[bi]!.o * (1 + p.sp) : p.ind.h1[bi]!.o * (1 - p.sp);
      const sld = Math.min(ep * SL_PCT, ep * SL_CAP);
      const sl = dir === "long" ? ep - sld : ep + sld;
      open.push({ pair: p.name, dir, ep, et: hr, sl, peak: 0, sp: p.sp, lev: p.lev, not });
    }
  }
  for (const pos of open) {
    const pd = pairs.find(p => p.name === pos.pair); if (!pd) continue;
    const lb = pd.ind.h1[pd.ind.h1.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp: lb.c, et: pos.et, xt: lb.t, pnl, reason: "end" });
  }

  const sorted = [...closed].sort((a, b) => a.xt - b.xt);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }
  const total = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0).length;
  const wr = sorted.length > 0 ? wins / sorted.length * 100 : 0;
  const gp = sorted.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(sorted.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gp / gl : Infinity;
  const pd = total / OOS_DAYS; const tpd = sorted.length / OOS_DAYS;

  console.log(`  ${opts.label.padEnd(42)} ${String(sorted.length).padStart(5)} ${tpd.toFixed(1).padStart(5)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(total).padStart(10)} ${fmtPnl(pd).padStart(8)} $${maxDD.toFixed(0).padStart(4)}`);
  return { n: sorted.length, pd, dd: maxDD, pf, wr, tpd };
}

function main() {
  console.log("=".repeat(100));
  console.log("  LEVERAGE-AWARE OPTIMIZATION SWEEP");
  console.log("  Baseline: 127p $7 uniform, 1h CD = $6.64/day, MaxDD $62");
  console.log("=".repeat(100));

  console.log("\n  Loading pairs...");
  const allPairs: PD[] = [];
  for (const name of ALL_127) {
    const sym = REVERSE_MAP[name] ?? name;
    let r = load5m(`${sym}USDT`); if (r.length < 5000) r = load5m(`${name}USDT`); if (r.length < 5000) continue;
    const ind = buildInd(r); if (ind.h1.length < 100 || ind.h4.length < 50) continue;
    allPairs.push({ name, ind, sp: SP[name] ?? DEFAULT_SPREAD, lev: getPairLev(name) });
  }
  const n3 = allPairs.filter(p => p.lev === 3).length;
  const n5 = allPairs.filter(p => p.lev === 5).length;
  const n10 = allPairs.filter(p => p.lev >= 10).length;
  console.log(`  ${allPairs.length} pairs: ${n3}@3x, ${n5}@5x, ${n10}@10x+\n`);

  const hdr = `  ${"Config".padEnd(42)} ${"Trd".padStart(5)} ${"T/d".padStart(5)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"PnL".padStart(10)} ${"$/day".padStart(8)} ${"MDD".padStart(5)}`;

  // ─── TRACK 1: TIERED MARGIN ───
  console.log("--- TRACK 1: TIERED MARGIN (all 127 pairs) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(83));

  // Baseline
  runSim(allPairs, { marginFn: () => 7, label: "BASELINE $7 uniform" });

  // Uniform margin sweep
  for (const m of [9, 10, 12]) {
    runSim(allPairs, { marginFn: () => m, label: `Uniform $${m}` });
  }

  // Tiered: more on high lev
  const tiers = [
    { m3: 5, m5: 7, m10: 10, label: "$5/3x $7/5x $10/10x" },
    { m3: 5, m5: 7, m10: 12, label: "$5/3x $7/5x $12/10x" },
    { m3: 5, m5: 7, m10: 15, label: "$5/3x $7/5x $15/10x" },
    { m3: 5, m5: 9, m10: 12, label: "$5/3x $9/5x $12/10x" },
    { m3: 5, m5: 9, m10: 15, label: "$5/3x $9/5x $15/10x" },
    { m3: 7, m5: 9, m10: 12, label: "$7/3x $9/5x $12/10x" },
    { m3: 7, m5: 9, m10: 15, label: "$7/3x $9/5x $15/10x" },
    { m3: 7, m5: 10, m10: 15, label: "$7/3x $10/5x $15/10x" },
    { m3: 3, m5: 7, m10: 15, label: "$3/3x $7/5x $15/10x" },
    { m3: 3, m5: 5, m10: 15, label: "$3/3x $5/5x $15/10x" },
    { m3: 3, m5: 10, m10: 15, label: "$3/3x $10/5x $15/10x" },
  ];
  for (const t of tiers) {
    runSim(allPairs, { marginFn: (lev) => lev >= 10 ? t.m10 : lev >= 5 ? t.m5 : t.m3, label: t.label });
  }

  // ─── TRACK 2: PAIR SELECTION ───
  console.log("\n--- TRACK 2: PAIR SELECTION (drop weak pairs) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(83));

  // First get per-pair $/day with real leverage at $7
  const pairPd = new Map<string, number>();
  // Quick per-pair calc (approximate from the single-pair results we already have)
  // Re-run each pair individually would be slow, so let's test subsets directly

  // By leverage tier
  const p10x = allPairs.filter(p => p.lev >= 10);
  const p5x = allPairs.filter(p => p.lev >= 5);
  const p5xOnly = allPairs.filter(p => p.lev === 5);
  const p3x = allPairs.filter(p => p.lev === 3);

  runSim(allPairs, { marginFn: () => 7, label: "All 127 pairs (baseline)" });
  runSim(p5x, { marginFn: () => 7, label: `5x+ only (${p5x.length} pairs)` });
  runSim(p10x, { marginFn: () => 7, label: `10x+ only (${p10x.length} pairs)` });

  // 5x+ with tiered margin
  runSim(p5x, { marginFn: (lev) => lev >= 10 ? 12 : 9, label: `5x+ tiered $9/5x $12/10x` });
  runSim(p5x, { marginFn: (lev) => lev >= 10 ? 15 : 10, label: `5x+ tiered $10/5x $15/10x` });

  // 10x with higher margin
  runSim(p10x, { marginFn: () => 10, label: `10x+ only $10 margin` });
  runSim(p10x, { marginFn: () => 12, label: `10x+ only $12 margin` });
  runSim(p10x, { marginFn: () => 15, label: `10x+ only $15 margin` });

  // ─── TRACK 3: PER-LEVERAGE Z-SCORE TUNING ───
  console.log("\n--- TRACK 3: PER-LEVERAGE Z-SCORE TUNING ---\n");
  console.log(hdr); console.log("  " + "-".repeat(83));

  runSim(allPairs, { marginFn: () => 7, label: "BASELINE z3.0/2.5 uniform" });

  // Looser z for 10x (more signals where leverage amplifies)
  const zConfigs = [
    { l1h: 2.5, l4h: 2.0, s1h: -2.5, s4h: -2.0, label: "z2.5/2.0" },
    { l1h: 2.5, l4h: 2.5, s1h: -2.5, s4h: -2.5, label: "z2.5/2.5" },
    { l1h: 3.0, l4h: 2.0, s1h: -3.0, s4h: -2.0, label: "z3.0/2.0" },
    { l1h: 3.5, l4h: 3.0, s1h: -3.5, s4h: -3.0, label: "z3.5/3.0" },
  ];

  // Uniform z-score changes (all pairs)
  for (const z of zConfigs) {
    runSim(allPairs, { marginFn: () => 7, zLong1h: z.l1h, zLong4h: z.l4h, zShort1h: z.s1h, zShort4h: z.s4h, label: `All pairs ${z.label}` });
  }

  // Per-leverage z: looser for 10x, tighter for 3x
  const levZConfigs = [
    { z10: { l1h: 2.5, l4h: 2.0, s1h: -2.5, s4h: -2.0 }, z5: { l1h: 3.0, l4h: 2.5, s1h: -3.0, s4h: -2.5 }, z3: { l1h: 3.5, l4h: 3.0, s1h: -3.5, s4h: -3.0 }, label: "10x:2.5/2 5x:3/2.5 3x:3.5/3" },
    { z10: { l1h: 2.5, l4h: 2.5, s1h: -2.5, s4h: -2.5 }, z5: { l1h: 3.0, l4h: 2.5, s1h: -3.0, s4h: -2.5 }, z3: { l1h: 3.0, l4h: 2.5, s1h: -3.0, s4h: -2.5 }, label: "10x:2.5/2.5 5x+3x:3/2.5" },
    { z10: { l1h: 2.5, l4h: 2.0, s1h: -2.5, s4h: -2.0 }, z5: { l1h: 3.0, l4h: 2.5, s1h: -3.0, s4h: -2.5 }, z3: { l1h: 3.0, l4h: 2.5, s1h: -3.0, s4h: -2.5 }, label: "10x:2.5/2 rest:3/2.5" },
  ];

  for (const cfg of levZConfigs) {
    const zMap = new Map<number, { l1h: number; l4h: number; s1h: number; s4h: number }>();
    zMap.set(10, cfg.z10); zMap.set(5, cfg.z5); zMap.set(3, cfg.z3);
    runSim(allPairs, { marginFn: () => 7, zByLev: zMap, label: cfg.label });
  }

  // ─── TRACK 4: BEST COMBOS ───
  console.log("\n--- TRACK 4: BEST COMBINATIONS ---\n");
  console.log(hdr); console.log("  " + "-".repeat(83));

  runSim(allPairs, { marginFn: () => 7, label: "BASELINE $7 uniform z3.0/2.5" });

  // Tiered margin + looser z for 10x
  const zMap1 = new Map<number, { l1h: number; l4h: number; s1h: number; s4h: number }>();
  zMap1.set(10, { l1h: 2.5, l4h: 2.0, s1h: -2.5, s4h: -2.0 });
  runSim(allPairs, { marginFn: (lev) => lev >= 10 ? 12 : lev >= 5 ? 7 : 5, zByLev: zMap1, label: "Tier $5/7/12 + 10x:z2.5/2" });
  runSim(allPairs, { marginFn: (lev) => lev >= 10 ? 15 : lev >= 5 ? 9 : 5, zByLev: zMap1, label: "Tier $5/9/15 + 10x:z2.5/2" });
  runSim(allPairs, { marginFn: (lev) => lev >= 10 ? 15 : lev >= 5 ? 7 : 5, zByLev: zMap1, label: "Tier $5/7/15 + 10x:z2.5/2" });

  // 5x+ only with tiered + looser z for 10x
  runSim(p5x, { marginFn: (lev) => lev >= 10 ? 15 : 10, zByLev: zMap1, label: `5x+ $10/15 + 10x:z2.5/2` });
  runSim(p5x, { marginFn: (lev) => lev >= 10 ? 12 : 9, zByLev: zMap1, label: `5x+ $9/12 + 10x:z2.5/2` });

  // Uniform $9 + looser z for 10x
  runSim(allPairs, { marginFn: () => 9, zByLev: zMap1, label: "Uniform $9 + 10x:z2.5/2" });
  runSim(allPairs, { marginFn: () => 10, zByLev: zMap1, label: "Uniform $10 + 10x:z2.5/2" });

  // All loose z + tiered margin
  const zMapAll = new Map<number, { l1h: number; l4h: number; s1h: number; s4h: number }>();
  zMapAll.set(10, { l1h: 2.5, l4h: 2.0, s1h: -2.5, s4h: -2.0 });
  zMapAll.set(5, { l1h: 2.5, l4h: 2.0, s1h: -2.5, s4h: -2.0 });
  zMapAll.set(3, { l1h: 2.5, l4h: 2.0, s1h: -2.5, s4h: -2.0 });
  runSim(allPairs, { marginFn: (lev) => lev >= 10 ? 12 : lev >= 5 ? 7 : 5, zByLev: zMapAll, label: "Tier $5/7/12 + ALL:z2.5/2" });
}

main();
