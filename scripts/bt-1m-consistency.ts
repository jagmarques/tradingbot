/**
 * Consistency-focused sweep on top-50.
 * Goal: more trades per day + tighter locks + lower variance = fewer "dry hours" AND fewer loss chains.
 * Also tracks max single loss and loss streak stats for each config.
 */
import * as fs from "fs";

const CACHE_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000, H4 = 4 * H, D = 86_400_000;
const FEE = 0.00045, MARGIN = 15, MAX_HOLD_H = 120; // 0.045% HL taker base rate
const BLOCK_HOURS = new Set([22, 23]);
const LB = 1;
const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();
const OOS_DAYS = (OOS_END - OOS_START) / D;
// Spreads measured from HL L2 book 2026-04-24. Values in fraction (e.g. 1e-4 = 1bp).
// Illiquid pairs added: RSR 22bp, APE 20bp, IMX 17bp, MEME 17bp, ACE 16bp, CELO 12bp, ORDI 11bp, PEOPLE 11bp.
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1e-4, SOL: 2e-4, SUI: 1.85e-4, AVAX: 2.55e-4, ARB: 2.6e-4,
  ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, NEAR: 3.5e-4, FET: 4e-4,
  RSR: 22.4e-4, APE: 19.9e-4, IMX: 17.2e-4, MEME: 17.1e-4, ACE: 15.6e-4, CELO: 12.4e-4,
  ORDI: 11.5e-4, PEOPLE: 11.2e-4,
};
const DEFAULT_SPREAD = 8e-4; // raised from 5bp to 8bp; covers illiquid pairs not explicitly mapped
const RENAME: Record<string, string> = { kPEPE: "1000PEPE" };
const leverageMap = new Map<string, number>();
for (const line of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) { const [n, v] = line.split(":"); leverageMap.set(n!, parseInt(v!)); }
function getLeverage(p: string): number { return Math.min(leverageMap.get(p) ?? 3, 10); }

const TOP50 = ["ETH","ZEC","YGG","STRAX","WLD","PENGU","DOGE","ARB","FIL","OP","AVAX","NEO","JTO","KAITO","SUSHI","EIGEN","LINK","ADA","ZK","CELO","STX","AAVE","BANANA","FET","PEOPLE","UNI","ORDI","TURBO","WCT","TIA","MEME","ETC","DYDX","BIO","CAKE","APE","ENA","SAND","IMX","ZEN","SOL","ICP","STRK","APT","PENDLE","RSR","ETHFI","RENDER","ACE","CYBER"];

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

interface PD { name: string; m1: TA; h1: TA; h4: TA; z1h: Float64Array; z4h: Float64Array; h1Map: Map<number, number>; m1Map: Map<number, number>; h4Map: Map<number, number>; spread: number; leverage: number; }

console.log("Loading top-50...");
const pairs: PD[] = [];
for (const name of TOP50) {
  const sym = RENAME[name] ?? name;
  let raw = loadTA(`${sym}USDT`); if (!raw) raw = loadTA(`${name}USDT`); if (!raw) continue;
  const h1 = agg(raw, H, 200); const h4 = agg(raw, H4, 50); if (!h1 || !h4) continue;
  const z1h = zs(h1, 15); const z4h = zs(h4, 20);
  const ms = OOS_START - 24 * H, me = OOS_END + 24 * H;
  const ki: number[] = []; for (let i = 0; i < raw.n; i++) if (raw.t[i]! >= ms && raw.t[i]! <= me) ki.push(i);
  const mn = ki.length;
  const m1: TA = { t: new Float64Array(mn), o: new Float64Array(mn), h: new Float64Array(mn), l: new Float64Array(mn), c: new Float64Array(mn), n: mn };
  for (let k = 0; k < mn; k++) { const i = ki[k]!; m1.t[k] = raw.t[i]!; m1.o[k] = raw.o[i]!; m1.h[k] = raw.h[i]!; m1.l[k] = raw.l[i]!; m1.c[k] = raw.c[i]!; }
  const h1Map = new Map<number, number>(); for (let i = 0; i < h1.n; i++) h1Map.set(h1.t[i]!, i);
  const m1Map = new Map<number, number>(); for (let i = 0; i < m1.n; i++) m1Map.set(m1.t[i]!, i);
  const h4Map = new Map<number, number>(); for (let i = 0; i < h4.n; i++) h4Map.set(h4.t[i]!, i);
  pairs.push({ name, m1, h1, h4, z1h, z4h, h1Map, m1Map, h4Map, spread: SP[name] ?? DEFAULT_SPREAD, leverage: getLeverage(name) });
}
console.log(`Loaded ${pairs.length}/${TOP50.length}`);
const pByN = new Map<string, PD>(); pairs.forEach(p => pByN.set(p.name, p));
const allTs = new Set<number>();
for (const p of pairs) for (let i = 0; i < p.m1.n; i++) { const t = p.m1.t[i]!; if (t >= OOS_START && t < OOS_END) allTs.add(t); }
const timepoints = [...allTs].sort((a, b) => a - b);

type Stages = Array<{ a: number; d: number }>;
interface Cfg { mc: number; slLow: number; slHigh: number; trail: Stages; bePct: number; be2Pct: number; be2Lock: number; z1h: number; z4h: number; cdH: number; }
interface Stats {
  pnlDay: number; mdd: number; pf: number; wr: number; trades: number; calmar: number;
  maxLoss: number;    // largest single losing trade
  maxLossStreak: number; // max consecutive losing trades
  tradesPerDay: number;
  dryDays: number;    // days with zero trades
}
interface Pos { pair: string; entryPrice: number; entryTime: number; stopLoss: number; peakLevPnlPct: number; spread: number; leverage: number; notional: number; beT: boolean; be2T: boolean; }

// No-lookahead: at time ts, use z-score from the 4h bar that has ALREADY CLOSED
// (i.e., the bar preceding the one that contains ts). Mirrors live which uses
// completed4h.slice(0, -1) and takes z of the last element.
function get4h(p: PD, ts: number): number {
  const b = Math.floor(ts / H4) * H4; // the 4h bucket containing ts
  const i = p.h4Map.get(b);
  if (i !== undefined && i > 0) return p.z4h[i - 1]!; // previous (closed) bar
  // fallback: largest bar with t + H4 <= ts (bar closed at or before ts)
  let lo = 0, hi = p.h4.n - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (p.h4.t[m]! + H4 <= ts) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? p.z4h[best]! : 0;
}
function gts(peak: number, st: Stages): { a: number; d: number } | null {
  for (const s of st) if (peak >= s.a) return s;
  return null;
}

function sim(cfg: Cfg): Stats {
  const open: Pos[] = [];
  let rp = 0, mp = 0, mdd = 0, tt = 0, tw = 0, gp = 0, gl = 0;
  let maxLoss = 0, maxStreak = 0, curStreak = 0;
  const cd = new Map<string, number>();
  const daysWithTrades = new Set<number>();
  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i]!;
      const pd = pByN.get(pos.pair)!;
      const bi = pd.m1Map.get(ts); if (bi === undefined) continue;
      const bL = pd.m1.l[bi]!, bH = pd.m1.h[bi]!, bC = pd.m1.c[bi]!;
      let xp = 0, rs = "";
      if ((ts - pos.entryTime) / H >= MAX_HOLD_H) { xp = bC; rs = "maxh"; }
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
        const es = rs === "sl" ? pos.spread * 1.5 : pos.spread;
        const fp = xp * (1 - es);
        const pnl = (fp / pos.entryPrice - 1) * pos.notional - pos.notional * FEE * 2;
        open.splice(i, 1); rp += pnl; tt++;
        daysWithTrades.add(Math.floor(ts / D));
        if (pnl > 0) { tw++; gp += pnl; curStreak = 0; }
        else { gl += Math.abs(pnl); if (Math.abs(pnl) > maxLoss) maxLoss = Math.abs(pnl); curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
        if (rs === "sl") cd.set(`${pos.pair}:long`, ts + cfg.cdH * H);
      }
    }
    let up = 0;
    for (const pos of open) {
      const pd = pByN.get(pos.pair)!;
      const bi = pd.m1Map.get(ts); if (bi === undefined) continue;
      up += (pd.m1.c[bi]! * (1 - pos.spread) / pos.entryPrice - 1) * pos.notional - pos.notional * FEE * 2;
    }
    const te = rp + up;
    if (te > mp) mp = te;
    if (mp - te > mdd) mdd = mp - te;
    if (!isH1) continue;
    if (BLOCK_HOURS.has(new Date(ts).getUTCHours())) continue;
    if (open.length >= cfg.mc) continue;
    for (const p of pairs) {
      if (open.length >= cfg.mc) break;
      if (open.some(po => po.pair === p.name)) continue;
      const cdu = cd.get(`${p.name}:long`); if (cdu && ts < cdu) continue;
      const h1i = p.h1Map.get(ts); if (h1i === undefined || h1i < 20) continue;
      const z1 = p.z1h[h1i - 1]!; if (z1 <= cfg.z1h) continue;
      const z4 = get4h(p, ts); if (z4 <= cfg.z4h) continue;
      const ep = p.h1.o[h1i]! * (1 + p.spread);
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
  const tradesPerDay = tt / OOS_DAYS;
  const dryDays = OOS_DAYS - daysWithTrades.size;
  return { pnlDay, mdd, pf, wr, trades: tt, calmar, maxLoss, maxLossStreak: maxStreak, tradesPerDay, dryDays };
}

// CONSISTENCY-FOCUSED SWEEP: lower z, tight trails, early locks
const TRAILS: Array<{ lbl: string; s: Stages }> = [
  { lbl: "T5/2", s: [{ a: 5, d: 2 }] },
  { lbl: "T8/2", s: [{ a: 8, d: 2 }] },
  { lbl: "T8/3", s: [{ a: 8, d: 3 }] },
  { lbl: "T10/2", s: [{ a: 10, d: 2 }] },
  { lbl: "T10/3", s: [{ a: 10, d: 3 }] },
  { lbl: "T12/3", s: [{ a: 12, d: 3 }] },
  { lbl: "T15/3", s: [{ a: 15, d: 3 }] },
  { lbl: "T15/5", s: [{ a: 15, d: 5 }] },
  { lbl: "T20/3", s: [{ a: 20, d: 3 }] },
  { lbl: "T25/3", s: [{ a: 25, d: 3 }] },
  { lbl: "T30/2", s: [{ a: 30, d: 2 }] },
  // Stepped tight
  { lbl: "T20/2-10/3", s: [{ a: 20, d: 2 }, { a: 10, d: 3 }] },
  { lbl: "T30/2-15/3", s: [{ a: 30, d: 2 }, { a: 15, d: 3 }] },
];
const BE2S = [
  { p: 0, l: 0, lbl: "off" },
  { p: 8, l: 3, lbl: "8->3" },
  { p: 10, l: 5, lbl: "10->5" },
  { p: 15, l: 5, lbl: "15->5" },
];

const configs: { lbl: string; c: Cfg }[] = [];
for (const mc of [5, 7, 10]) {
  for (const z of [
    { z1: 1.3, z4: 1.0 }, { z1: 1.5, z4: 1.2 }, { z1: 1.5, z4: 1.5 },
    { z1: 1.8, z4: 1.3 }, { z1: 1.8, z4: 1.5 }, { z1: 1.8, z4: 1.8 },
  ]) {
    for (const sl of [
      { l: 0.02, h: 0.025, lbl: "2.0/2.5" },
      { l: 0.025, h: 0.03, lbl: "2.5/3.0" },
    ]) {
      for (const be of [2, 3, 5]) {
        for (const be2 of BE2S) {
          for (const t of TRAILS) {
            configs.push({
              lbl: `mc${mc} z${z.z1}/${z.z4} SL${sl.lbl} ${t.lbl} BE${be}%+${be2.lbl}`,
              c: { mc, slLow: sl.l, slHigh: sl.h, trail: t.s, bePct: be, be2Pct: be2.p, be2Lock: be2.l, z1h: z.z1, z4h: z.z4, cdH: 4 },
            });
          }
        }
      }
    }
  }
}
console.log(`\nSweeping ${configs.length} consistency configs...`);

interface R extends Stats { lbl: string }
const results: R[] = [];
for (let i = 0; i < configs.length; i++) {
  if ((i + 1) % 200 === 0) process.stdout.write(`${i + 1}/${configs.length} `);
  const c = configs[i]!;
  const r = sim(c.c);
  if (r.trades < 200) continue;
  results.push({ lbl: c.lbl, ...r });
}

console.log("\n\n" + "=".repeat(125));
console.log("TOP 30 BY CALMAR (WR>=40%, MDD<$20, >=8 trades/day)");
console.log("=".repeat(125));
const filtered = results.filter(r => r.wr >= 40 && r.mdd < 20 && r.tradesPerDay >= 8).sort((a, b) => b.calmar - a.calmar);
console.log(`${"Config".padEnd(70)} $/day  MDD   PF   WR%  T/day MaxL  Streak  Dry  Calmar`);
for (const r of filtered.slice(0, 30)) {
  console.log(`${r.lbl.padEnd(70)} ${r.pnlDay.toFixed(2).padStart(4)} ${r.mdd.toFixed(1).padStart(4)} ${r.pf.toFixed(2).padStart(4)} ${r.wr.toFixed(0).padStart(3)} ${r.tradesPerDay.toFixed(1).padStart(4)} ${r.maxLoss.toFixed(2).padStart(4)} ${String(r.maxLossStreak).padStart(3)} ${String(Math.round(r.dryDays)).padStart(3)}  ${r.calmar.toFixed(3)}`);
}

console.log("\n" + "=".repeat(125));
console.log("TOP 20 BY TRADES/DAY (high consistency, any profit)");
console.log("=".repeat(125));
const highVol = results.filter(r => r.pnlDay > 1.0 && r.wr >= 40).sort((a, b) => b.tradesPerDay - a.tradesPerDay);
console.log(`${"Config".padEnd(70)} $/day  MDD   PF   WR%  T/day MaxL  Streak  Dry  Calmar`);
for (const r of highVol.slice(0, 20)) {
  console.log(`${r.lbl.padEnd(70)} ${r.pnlDay.toFixed(2).padStart(4)} ${r.mdd.toFixed(1).padStart(4)} ${r.pf.toFixed(2).padStart(4)} ${r.wr.toFixed(0).padStart(3)} ${r.tradesPerDay.toFixed(1).padStart(4)} ${r.maxLoss.toFixed(2).padStart(4)} ${String(r.maxLossStreak).padStart(3)} ${String(Math.round(r.dryDays)).padStart(3)}  ${r.calmar.toFixed(3)}`);
}

console.log("\n" + "=".repeat(125));
console.log("TOP 20 BALANCED: MDD<$15, >=10 trades/day, WR>=45%, sorted by $/day");
console.log("=".repeat(125));
const balanced = results.filter(r => r.mdd < 15 && r.tradesPerDay >= 10 && r.wr >= 45).sort((a, b) => b.pnlDay - a.pnlDay);
console.log(`${"Config".padEnd(70)} $/day  MDD   PF   WR%  T/day MaxL  Streak  Dry  Calmar`);
for (const r of balanced.slice(0, 20)) {
  console.log(`${r.lbl.padEnd(70)} ${r.pnlDay.toFixed(2).padStart(4)} ${r.mdd.toFixed(1).padStart(4)} ${r.pf.toFixed(2).padStart(4)} ${r.wr.toFixed(0).padStart(3)} ${r.tradesPerDay.toFixed(1).padStart(4)} ${r.maxLoss.toFixed(2).padStart(4)} ${String(r.maxLossStreak).padStart(3)} ${String(Math.round(r.dryDays)).padStart(3)}  ${r.calmar.toFixed(3)}`);
}

console.log(`\nTotal valid: ${results.length}/${configs.length}`);
