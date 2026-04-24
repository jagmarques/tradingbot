/**
 * Maker-only fee research: re-run best known configs under 4 fee scenarios.
 * Configs tested:
 *   A. Per-pair top-10 @ z1=3.0/z4=2.0 mc5 (Novel research best, Calmar 0.011 pure-taker)
 *   B. BOTH-VTIGHT-LIQ (z1=3.0/z4=1.5, mc=7, SL=2.0/2.5, trail 8/3-15/5-30/10, BE=5, cd=4h, mh=72h)
 *   C. B+ prune top-10 combined (z1=1.8/z4=1.8 mc=7, SL 2.5/3.0, trail 25/3, BE 5 + BE2 20->lock10)
 *
 * Fee scenarios (round-trip on notional):
 *   A_taker:  FEE_IN=0.00045 FEE_OUT=0.00045  (pure taker baseline)
 *   B_mkTk:   FEE_IN=0.00015 FEE_OUT=0.00045  (ALO entry, taker exit — live today)
 *   C_mkMk:   FEE_IN=0.00015 FEE_OUT=0.00015  (maker-only both sides — aspirational)
 *   D_rebate: FEE_IN=-0.0001 FEE_OUT=-0.0001  (HL >$1M/day volume-tier rebate)
 *
 * OOS: 2025-06-01 → 2026-03-25 (297 days), $15 margin, real spreads, 1m candles.
 */
import * as fs from "fs";

const CACHE_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000, H4 = 4 * H, D = 86_400_000;
const MARGIN = 15;
const BLOCK_HOURS = new Set([22, 23]);
const LB = 1;
const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();
const OOS_DAYS = (OOS_END - OOS_START) / D;

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1e-4, SOL: 2e-4, SUI: 1.85e-4, AVAX: 2.55e-4, ARB: 2.6e-4,
  ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, NEAR: 3.5e-4, FET: 4e-4,
  RSR: 22.4e-4, APE: 19.9e-4, IMX: 17.2e-4, MEME: 17.1e-4, ACE: 15.6e-4, CELO: 12.4e-4,
  ORDI: 11.5e-4, PEOPLE: 11.2e-4,
  STRAX: 12e-4, YGG: 12e-4, BANANA: 12e-4, ZEN: 12e-4, BIO: 12e-4, WCT: 12e-4, CYBER: 12e-4,
  STRK: 12e-4, ETHFI: 12e-4, KAITO: 12e-4, PENGU: 12e-4,
};
const DEFAULT_SPREAD = 8e-4;
const RENAME: Record<string, string> = { kPEPE: "1000PEPE" };
const leverageMap = new Map<string, number>();
for (const line of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = line.split(":"); leverageMap.set(n!, parseInt(v!));
}
function getLeverage(p: string): number { return Math.min(leverageMap.get(p) ?? 3, 10); }

// -------------------------------------------------------------
interface TA { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; n: number; }
function loadTA(s: string): TA | null {
  let b: string; try { b = fs.readFileSync(`${CACHE_1M}/${s}.json`, "utf8"); } catch { return null; }
  const r = JSON.parse(b) as Array<{t:number;o:number;h:number;l:number;c:number}>;
  const n = r.length; if (n < 5000) return null;
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
  for (let i = 0; i < n; i++) { t[i] = r[i]!.t; o[i] = r[i]!.o; h[i] = r[i]!.h; l[i] = r[i]!.l; c[i] = r[i]!.c; }
  return { t, o, h, l, c, n };
}
function agg(s: TA, im: number, mb: number): TA | null {
  const oT:number[]=[],oO:number[]=[],oH:number[]=[],oL:number[]=[],oC:number[]=[];
  let cT=-1,cO=0,cH=0,cL=0,cC=0,has=false;
  for (let i=0;i<s.n;i++){const bt=Math.floor(s.t[i]!/im)*im;if(!has||cT!==bt){if(has){oT.push(cT);oO.push(cO);oH.push(cH);oL.push(cL);oC.push(cC);}cT=bt;cO=s.o[i]!;cH=s.h[i]!;cL=s.l[i]!;cC=s.c[i]!;has=true;}else{if(s.h[i]!>cH)cH=s.h[i]!;if(s.l[i]!<cL)cL=s.l[i]!;cC=s.c[i]!;}}
  if(has){oT.push(cT);oO.push(cO);oH.push(cH);oL.push(cL);oC.push(cC);}
  if(oT.length<mb)return null;
  return {t:Float64Array.from(oT),o:Float64Array.from(oO),h:Float64Array.from(oH),l:Float64Array.from(oL),c:Float64Array.from(oC),n:oT.length};
}
function zs(c: TA, vw: number): Float64Array {
  const z = new Float64Array(c.n);
  for (let i=0;i<c.n;i++){if(i<vw+LB+1){z[i]=0;continue;}const mom=c.c[i]!/c.c[i-LB]!-1;let ss=0,cnt=0;for(let j=Math.max(1,i-vw);j<=i;j++){const r=c.c[j]!/c.c[j-1]!-1;ss+=r*r;cnt++;}const vol=Math.sqrt(ss/cnt);z[i]=vol===0?0:mom/vol;}
  return z;
}

interface PD {
  name: string; m1: TA; h1: TA; h4: TA;
  z1h: Float64Array; z4h: Float64Array;
  h1Map: Map<number, number>; m1Map: Map<number, number>; h4Map: Map<number, number>;
  spread: number; leverage: number;
}

function buildPD(name: string): PD | null {
  const sym = RENAME[name] ?? name;
  let raw = loadTA(`${sym}USDT`); if (!raw) raw = loadTA(`${name}USDT`); if (!raw) return null;
  const h1 = agg(raw, H, 200); const h4 = agg(raw, H4, 50); if (!h1 || !h4) return null;
  const z1h = zs(h1, 15); const z4h = zs(h4, 20);
  const ms = OOS_START - 24 * H, me = OOS_END + 24 * H;
  const ki: number[] = []; for (let i = 0; i < raw.n; i++) if (raw.t[i]! >= ms && raw.t[i]! <= me) ki.push(i);
  const mn = ki.length;
  const m1: TA = { t: new Float64Array(mn), o: new Float64Array(mn), h: new Float64Array(mn), l: new Float64Array(mn), c: new Float64Array(mn), n: mn };
  for (let k = 0; k < mn; k++) { const i = ki[k]!; m1.t[k] = raw.t[i]!; m1.o[k] = raw.o[i]!; m1.h[k] = raw.h[i]!; m1.l[k] = raw.l[i]!; m1.c[k] = raw.c[i]!; }
  const h1Map = new Map<number, number>(); for (let i = 0; i < h1.n; i++) h1Map.set(h1.t[i]!, i);
  const m1Map = new Map<number, number>(); for (let i = 0; i < m1.n; i++) m1Map.set(m1.t[i]!, i);
  const h4Map = new Map<number, number>(); for (let i = 0; i < h4.n; i++) h4Map.set(h4.t[i]!, i);
  return { name, m1, h1, h4, z1h, z4h, h1Map, m1Map, h4Map, spread: SP[name] ?? DEFAULT_SPREAD, leverage: getLeverage(name) };
}

function get4h(p: PD, ts: number): number {
  let lo = 0, hi = p.h4.n - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (p.h4.t[m]! < ts) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? p.z4h[best]! : 0;
}

// -------------------------------------------------------------
type Stages = Array<{ a: number; d: number }>;
interface Cfg {
  label: string;
  pairs: string[];    // whitelist (empty = all)
  mc: number;
  slLow: number; slHigh: number;
  trail: Stages;
  bePct: number;
  be2Pct: number; be2Lock: number;
  z1h: number; z4h: number;
  cdH: number;
  maxHoldH: number;
}
interface FeeCfg { label: string; feeIn: number; feeOut: number; }
interface Stats { pnlDay: number; mdd: number; pf: number; wr: number; trades: number; calmar: number; totalPnl: number; }
interface Pos {
  pair: string; entryPrice: number; entryTime: number; stopLoss: number;
  peakLevPnlPct: number; spread: number; leverage: number; notional: number;
  beT: boolean; be2T: boolean;
}

function gts(peak: number, st: Stages): { a: number; d: number } | null {
  for (const s of st) if (peak >= s.a) return s;
  return null;
}

function simulate(pds: PD[], cfg: Cfg, fee: FeeCfg): Stats {
  const pByN = new Map<string, PD>(); pds.forEach(p => pByN.set(p.name, p));
  const allTs = new Set<number>();
  for (const p of pds) for (let i = 0; i < p.m1.n; i++) { const t = p.m1.t[i]!; if (t >= OOS_START && t < OOS_END) allTs.add(t); }
  const tps = [...allTs].sort((a, b) => a - b);

  const open: Pos[] = [];
  let rp = 0, mp = 0, mdd = 0, tt = 0, tw = 0, gp = 0, gl = 0;
  const cd = new Map<string, number>();

  for (const ts of tps) {
    const isH1 = ts % H === 0;
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i]!;
      const pd = pByN.get(pos.pair)!;
      const bi = pd.m1Map.get(ts); if (bi === undefined) continue;
      const bL = pd.m1.l[bi]!, bH = pd.m1.h[bi]!, bC = pd.m1.c[bi]!;
      let xp = 0, rs = "";
      if ((ts - pos.entryTime) / H >= cfg.maxHoldH) { xp = bC; rs = "maxh"; }
      if (!xp && bL <= pos.stopLoss) { xp = pos.stopLoss; rs = "sl"; }
      const bp = (bH / pos.entryPrice - 1) * pos.leverage * 100;
      if (bp > pos.peakLevPnlPct) pos.peakLevPnlPct = bp;
      if (!pos.beT && cfg.bePct > 0 && pos.peakLevPnlPct >= cfg.bePct) { pos.stopLoss = pos.entryPrice; pos.beT = true; }
      if (pos.beT && !pos.be2T && cfg.be2Pct > 0 && pos.peakLevPnlPct >= cfg.be2Pct) {
        pos.stopLoss = pos.entryPrice * (1 + cfg.be2Lock / pos.leverage / 100); pos.be2T = true;
      }
      if (!xp && cfg.trail.length > 0) {
        const step = gts(pos.peakLevPnlPct, cfg.trail);
        if (step) { const cur = (bC / pos.entryPrice - 1) * pos.leverage * 100; if (cur <= pos.peakLevPnlPct - step.d) { xp = bC; rs = "trail"; } }
      }
      if (xp > 0) {
        // SL exits are always taker on HL (they must fill ASAP), regardless of maker-mode.
        // Trail/maxh exits: in maker scenarios we assume patient limit fills at exit price (no half-spread drag).
        const isForcedTaker = rs === "sl";
        const effFeeOut = isForcedTaker ? 0.00045 : fee.feeOut;
        const es = isForcedTaker ? pos.spread * 0.75 : (fee.feeOut <= 0.00015 ? 0 : pos.spread / 2);
        const fp = xp * (1 - es);
        const pnl = (fp / pos.entryPrice - 1) * pos.notional
                    - pos.notional * fee.feeIn
                    - pos.notional * effFeeOut;
        open.splice(i, 1); rp += pnl; tt++;
        if (pnl > 0) { tw++; gp += pnl; } else { gl += Math.abs(pnl); }
        if (rs === "sl") cd.set(`${pos.pair}:long`, ts + cfg.cdH * H);
      }
    }
    let up = 0;
    for (const pos of open) {
      const pd = pByN.get(pos.pair)!; const bi = pd.m1Map.get(ts); if (bi === undefined) continue;
      up += (pd.m1.c[bi]! * (1 - pos.spread) / pos.entryPrice - 1) * pos.notional
            - pos.notional * (fee.feeIn + fee.feeOut);
    }
    const te = rp + up;
    if (te > mp) mp = te;
    if (mp - te > mdd) mdd = mp - te;

    if (!isH1) continue;
    if (BLOCK_HOURS.has(new Date(ts).getUTCHours())) continue;
    if (open.length >= cfg.mc) continue;
    for (const p of pds) {
      if (open.length >= cfg.mc) break;
      if (open.some(po => po.pair === p.name)) continue;
      const cdu = cd.get(`${p.name}:long`); if (cdu && ts < cdu) continue;
      const h1i = p.h1Map.get(ts); if (h1i === undefined || h1i < 20) continue;
      const z1 = p.z1h[h1i - 1]!; if (z1 <= cfg.z1h) continue;
      const z4 = get4h(p, ts); if (z4 <= cfg.z4h) continue;
      // Maker entry: no half-spread slip. Taker pays half-spread (was full = double-counted).
      const entrySpread = fee.feeIn <= 0.00015 ? 0 : p.spread / 2;
      const ep = p.h1.o[h1i]! * (1 + entrySpread);
      const slPct = p.leverage >= 10 ? cfg.slHigh : cfg.slLow;
      const sl = ep * (1 - slPct);
      const no = MARGIN * p.leverage;
      open.push({ pair: p.name, entryPrice: ep, entryTime: ts, stopLoss: sl, peakLevPnlPct: 0, spread: p.spread, leverage: p.leverage, notional: no, beT: false, be2T: false });
    }
  }
  const pnlDay = rp / OOS_DAYS;
  const wr = tt > 0 ? tw / tt * 100 : 0;
  const pf = gl > 0 ? gp / gl : 0;
  const calmar = mdd > 0 ? pnlDay / mdd : 0;
  return { pnlDay, mdd, pf, wr, trades: tt, calmar, totalPnl: rp };
}

// -------------------------------------------------------------
// Best configs from prior research
// Per-pair top-10 from research-novel.ts (UNI, WLD, AVAX, ETH, MKR, ARB, GMX, SOL, ILV, LINK)
const TOP10_PER_PAIR = ["UNI", "WLD", "AVAX", "ETH", "MKR", "ARB", "GMX", "SOL", "ILV", "LINK"];

// B+ prune top-10 — per bt-1m-Bplus-prune.ts, new top-10 after prune pass (best OLD set approximation)
const BPLUS_TOP10 = ["ETH", "ZEC", "YGG", "STRAX", "WLD", "PENGU", "DOGE", "ARB", "FIL", "OP"];

const CONFIGS: Cfg[] = [
  // Config A: Per-pair top-10, z1=3.0/z4=2.0 mc=5 (conservative tight)
  {
    label: "A: PerPair-top10 z3.0/2.0 mc5 SL2.5/3.0 T15/5 BE5 cd4h mh120h",
    pairs: TOP10_PER_PAIR,
    mc: 5, slLow: 0.025, slHigh: 0.030,
    trail: [{ a: 15, d: 5 }],
    bePct: 5, be2Pct: 0, be2Lock: 0,
    z1h: 3.0, z4h: 2.0, cdH: 4, maxHoldH: 120,
  },
  // Config B: BOTH-VTIGHT-LIQ style — tight z plus 3-stage trail; 18 pair liquid subset
  {
    label: "B: VTIGHT-LIQ z3.0/1.5 mc7 SL2.0/2.5 T8/3-15/5-30/10 BE5 cd4h mh72h",
    pairs: ["ETH","SOL","XRP","DOGE","ADA","AVAX","SUI","LINK","UNI","ARB","APT","NEAR","BNB","DOT","LTC","OP","WLD","MKR"],
    mc: 7, slLow: 0.020, slHigh: 0.025,
    trail: [{ a: 30, d: 10 }, { a: 15, d: 5 }, { a: 8, d: 3 }],
    bePct: 5, be2Pct: 0, be2Lock: 0,
    z1h: 3.0, z4h: 1.5, cdH: 4, maxHoldH: 72,
  },
  // Config C: B+ prune top-10 combo — the "all winners" prior champion
  {
    label: "C: Bplus-top10 z1.8/1.8 mc7 SL2.5/3.0 T25/3 BE5+BE2(20→lock10) cd4h mh120h",
    pairs: BPLUS_TOP10,
    mc: 7, slLow: 0.025, slHigh: 0.030,
    trail: [{ a: 25, d: 3 }],
    bePct: 5, be2Pct: 20, be2Lock: 10,
    z1h: 1.8, z4h: 1.8, cdH: 4, maxHoldH: 120,
  },
];

const FEES: FeeCfg[] = [
  { label: "A_taker  (4.5bp/4.5bp)", feeIn: 0.00045, feeOut: 0.00045 },
  { label: "B_mkTk   (1.5bp/4.5bp)", feeIn: 0.00015, feeOut: 0.00045 },
  { label: "C_mkMk   (1.5bp/1.5bp)", feeIn: 0.00015, feeOut: 0.00015 },
  { label: "D_rebate (-1bp/-1bp)",    feeIn: -0.0001, feeOut: -0.0001 },
];

// -------------------------------------------------------------
console.log("=".repeat(95));
console.log("MAKER-ONLY FEE RESEARCH");
console.log("=".repeat(95));
console.log(`OOS: 2025-06-01 → 2026-03-25 (${OOS_DAYS.toFixed(1)} days)`);
console.log(`Note: SL exits always taker (forced ASAP fill). Maker scenarios also zero half-spread on maker fills.\n`);

interface RunKey { cfgIdx: number; feeIdx: number; }
interface RunRes extends RunKey { cfg: string; fee: string; stats: Stats; }
const results: RunRes[] = [];

for (let c = 0; c < CONFIGS.length; c++) {
  const cfg = CONFIGS[c]!;
  console.log(`\n=== Loading config ${cfg.label.split(":")[0]} (${cfg.pairs.length} pairs) ===`);
  const pds: PD[] = [];
  for (const n of cfg.pairs) {
    const pd = buildPD(n); if (pd) pds.push(pd);
    else console.log(`  [skip] ${n} not in cache`);
  }
  console.log(`  Loaded ${pds.length}/${cfg.pairs.length} pairs`);

  for (let f = 0; f < FEES.length; f++) {
    const fee = FEES[f]!;
    process.stdout.write(`  [${fee.label}] ...`);
    const s = simulate(pds, cfg, fee);
    console.log(` $/d ${s.pnlDay.toFixed(3).padStart(6)} | MDD $${s.mdd.toFixed(2).padStart(6)} | PF ${s.pf.toFixed(2)} | WR ${s.wr.toFixed(1)}% | N=${s.trades} | Calmar ${s.calmar.toFixed(4)}`);
    results.push({ cfgIdx: c, feeIdx: f, cfg: cfg.label, fee: fee.label, stats: s });
  }
}

// -------------------------------------------------------------
// Summary tables
console.log(`\n${"=".repeat(95)}`);
console.log("SUMMARY — Calmar by config × fee");
console.log("=".repeat(95));
console.log(`${"Config".padEnd(70)}  ${FEES.map(f => f.label.split(" ")[0]!.padEnd(9)).join(" ")}`);
for (let c = 0; c < CONFIGS.length; c++) {
  const label = CONFIGS[c]!.label.split(":")[0]!.padEnd(5);
  const row = [label.padEnd(70)];
  for (let f = 0; f < FEES.length; f++) {
    const r = results.find(x => x.cfgIdx === c && x.feeIdx === f);
    row.push(r ? r.stats.calmar.toFixed(4).padEnd(9) : "---".padEnd(9));
  }
  console.log(row.join(" "));
}

console.log(`\n${"=".repeat(95)}`);
console.log("SUMMARY — $/day by config × fee");
console.log("=".repeat(95));
console.log(`${"Config".padEnd(70)}  ${FEES.map(f => f.label.split(" ")[0]!.padEnd(9)).join(" ")}`);
for (let c = 0; c < CONFIGS.length; c++) {
  const label = CONFIGS[c]!.label.split(":")[0]!.padEnd(5);
  const row = [label.padEnd(70)];
  for (let f = 0; f < FEES.length; f++) {
    const r = results.find(x => x.cfgIdx === c && x.feeIdx === f);
    row.push(r ? r.stats.pnlDay.toFixed(2).padEnd(9) : "---".padEnd(9));
  }
  console.log(row.join(" "));
}

console.log(`\n${"=".repeat(95)}`);
console.log("SUMMARY — MDD by config × fee");
console.log("=".repeat(95));
console.log(`${"Config".padEnd(70)}  ${FEES.map(f => f.label.split(" ")[0]!.padEnd(9)).join(" ")}`);
for (let c = 0; c < CONFIGS.length; c++) {
  const label = CONFIGS[c]!.label.split(":")[0]!.padEnd(5);
  const row = [label.padEnd(70)];
  for (let f = 0; f < FEES.length; f++) {
    const r = results.find(x => x.cfgIdx === c && x.feeIdx === f);
    row.push(r ? `$${r.stats.mdd.toFixed(1)}`.padEnd(9) : "---".padEnd(9));
  }
  console.log(row.join(" "));
}

// Threshold hits
console.log(`\n${"=".repeat(95)}`);
console.log("THRESHOLD HITS (Calmar targets)");
console.log("=".repeat(95));
for (const thr of [0.05, 0.10, 0.25]) {
  const hits = results.filter(r => r.stats.calmar >= thr);
  console.log(`Calmar >= ${thr}: ${hits.length} hits`);
  for (const h of hits) {
    console.log(`  ${h.cfg.split(":")[0]!.padEnd(5)} × ${h.fee.padEnd(22)} → $/d ${h.stats.pnlDay.toFixed(2)} | MDD $${h.stats.mdd.toFixed(1)} | Calmar ${h.stats.calmar.toFixed(4)}`);
  }
}

// Target hit: $5/day AND MDD<$20
console.log(`\n${"=".repeat(95)}`);
console.log("TARGET HITS ($5/day AND MDD < $20)");
console.log("=".repeat(95));
const targetHits = results.filter(r => r.stats.pnlDay >= 5 && r.stats.mdd < 20);
if (targetHits.length === 0) console.log("  NONE");
for (const h of targetHits) {
  console.log(`  ${h.cfg} × ${h.fee}: $/d ${h.stats.pnlDay.toFixed(2)}, MDD $${h.stats.mdd.toFixed(1)}`);
}

// Delta analysis: how much does maker help per config?
console.log(`\n${"=".repeat(95)}`);
console.log("DELTA — maker savings ($/day) vs pure taker baseline");
console.log("=".repeat(95));
for (let c = 0; c < CONFIGS.length; c++) {
  const base = results.find(r => r.cfgIdx === c && r.feeIdx === 0)!;
  const mkTk = results.find(r => r.cfgIdx === c && r.feeIdx === 1)!;
  const mkMk = results.find(r => r.cfgIdx === c && r.feeIdx === 2)!;
  const reb = results.find(r => r.cfgIdx === c && r.feeIdx === 3)!;
  console.log(`${CONFIGS[c]!.label.split(":")[0]}: base $/d ${base.stats.pnlDay.toFixed(2)}`);
  console.log(`  ALO entry only : +$${(mkTk.stats.pnlDay - base.stats.pnlDay).toFixed(2)}/d  (Calmar ${base.stats.calmar.toFixed(4)} → ${mkTk.stats.calmar.toFixed(4)})`);
  console.log(`  Maker both     : +$${(mkMk.stats.pnlDay - base.stats.pnlDay).toFixed(2)}/d  (Calmar ${base.stats.calmar.toFixed(4)} → ${mkMk.stats.calmar.toFixed(4)})`);
  console.log(`  Rebate tier    : +$${(reb.stats.pnlDay - base.stats.pnlDay).toFixed(2)}/d  (Calmar ${base.stats.calmar.toFixed(4)} → ${reb.stats.calmar.toFixed(4)})`);
}

console.log(`\nDONE. ${results.length} runs.`);
