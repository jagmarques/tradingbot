/**
 * Pair-count sweep on DEPLOYED C2 config:
 *   z=3.0/1.5 LONG + z=-3.0/-1.5 SHORT (symmetric)
 *   SL 3.0% (lev>=10) / 3.5% (lev<10)
 *   Trail T15/4 single-stage (peak >=15% lev → lock at peak-4pp)
 *   no-BE, max hold 120h, block hours 22-23 UTC, mc=7, 4h SL-only cooldown
 *   $20 margin (deployed today)
 *
 * Tests: 10, 15 (deployed), 20, 25, 35, all-loaded (up to 50).
 * Goal: does adding more pairs to deployed C2 config help or hurt Calmar?
 */
import * as fs from "fs";

const CACHE_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000, H4 = 4 * H, D = 86_400_000;
const FEE = 0.00045, MARGIN = 20, MAX_HOLD_H = 120;
// Match deployed garch-v2-engine.ts: SL_PCT_HIGH_LEV=0.035 (lev>=10), SL_PCT_LOW_LEV=0.030 (lev<10)
const SL_LOW = 0.030, SL_HIGH = 0.035;
const BLOCK_HOURS = new Set([22, 23]);
const LB = 1, MC = 7;
const Z1_LONG = 3.0, Z4_LONG = 1.5;
const Z1_SHORT = 3.0, Z4_SHORT = 1.5; // symmetric
const CD_H = 4;
const TRAIL_ARM = 15, TRAIL_DROP = 4; // T15/4
const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();
const OOS_DAYS = (OOS_END - OOS_START) / D;

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1e-4, SOL: 2e-4, SUI: 1.85e-4, AVAX: 2.55e-4, ARB: 2.6e-4,
  ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, NEAR: 3.5e-4, FET: 4e-4, FIL: 5e-4, ZEC: 8e-4, WLD: 8e-4,
  RSR: 22.4e-4, APE: 19.9e-4, IMX: 17.2e-4, MEME: 17.1e-4, ACE: 15.6e-4, CELO: 12.4e-4,
  ORDI: 11.5e-4, PEOPLE: 11.2e-4, TURBO: 14e-4, ZK: 10e-4, EIGEN: 10e-4, STX: 8e-4,
  AAVE: 4e-4, BANANA: 15e-4, TIA: 6e-4, ETC: 4e-4, DYDX: 8e-4, BIO: 15e-4, CAKE: 8e-4,
  SAND: 8e-4, ZEN: 15e-4, ICP: 6e-4, STRK: 15e-4, PENDLE: 8e-4, ETHFI: 15e-4, RENDER: 6e-4,
  // Micro-caps bumped to 15bp (more realistic on $200 fills with thin orderbooks)
  CYBER: 15e-4, STRAX: 15e-4, YGG: 15e-4, WCT: 15e-4, KAITO: 15e-4, PENGU: 15e-4,
  NEO: 8e-4, SUSHI: 10e-4, JTO: 10e-4,
};
const DEFAULT_SPREAD = 8e-4;

const TOP50 = ["ETH","ZEC","YGG","STRAX","WLD","PENGU","DOGE","ARB","FIL","OP","AVAX","NEO","JTO","KAITO","SUSHI","EIGEN","LINK","ADA","ZK","CELO","STX","AAVE","BANANA","FET","PEOPLE","UNI","ORDI","TURBO","WCT","TIA","MEME","ETC","DYDX","BIO","CAKE","APE","ENA","SAND","IMX","ZEN","SOL","ICP","STRK","APT","PENDLE","RSR","ETHFI","RENDER","ACE","CYBER"];

const leverageMap = new Map<string, number>();
for (const line of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = line.split(":");
  leverageMap.set(n!, parseInt(v!));
}
function getLeverage(p: string): number { return Math.min(leverageMap.get(p) ?? 3, 10); }

interface TA { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; n: number; }
function loadTA(s: string): TA | null {
  let b: string;
  try { b = fs.readFileSync(`${CACHE_1M}/${s}.json`, "utf8"); } catch { return null; }
  const r = JSON.parse(b) as Array<{t:number;o:number;h:number;l:number;c:number}>;
  const n = r.length;
  if (n < 5000) return null;
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
  for (let i = 0; i < n; i++) { t[i] = r[i]!.t; o[i] = r[i]!.o; h[i] = r[i]!.h; l[i] = r[i]!.l; c[i] = r[i]!.c; }
  return { t, o, h, l, c, n };
}
function agg(s: TA, im: number, mb: number): TA | null {
  const oT:number[]=[],oO:number[]=[],oH:number[]=[],oL:number[]=[],oC:number[]=[];
  let cT=-1,cO=0,cH=0,cL=0,cC=0,has=false;
  for (let i=0;i<s.n;i++){
    const bt=Math.floor(s.t[i]!/im)*im;
    if(!has||cT!==bt){
      if(has){oT.push(cT);oO.push(cO);oH.push(cH);oL.push(cL);oC.push(cC);}
      cT=bt;cO=s.o[i]!;cH=s.h[i]!;cL=s.l[i]!;cC=s.c[i]!;has=true;
    } else {
      if(s.h[i]!>cH)cH=s.h[i]!;
      if(s.l[i]!<cL)cL=s.l[i]!;
      cC=s.c[i]!;
    }
  }
  if(has){oT.push(cT);oO.push(cO);oH.push(cH);oL.push(cL);oC.push(cC);}
  if(oT.length<mb)return null;
  return {t:Float64Array.from(oT),o:Float64Array.from(oO),h:Float64Array.from(oH),l:Float64Array.from(oL),c:Float64Array.from(oC),n:oT.length};
}
function zs(c: TA, vw: number): Float64Array {
  const z = new Float64Array(c.n);
  for (let i=0;i<c.n;i++){
    if(i<vw+LB+1){z[i]=0;continue;}
    const mom=c.c[i]!/c.c[i-LB]!-1;
    let ss=0,cnt=0;
    for(let j=Math.max(1,i-vw);j<=i;j++){
      const r=c.c[j]!/c.c[j-1]!-1;
      ss+=r*r;cnt++;
    }
    const vol=Math.sqrt(ss/cnt);
    z[i]=vol===0?0:mom/vol;
  }
  return z;
}

interface PD { name: string; m1: TA; h1: TA; h4: TA; z1h: Float64Array; z4h: Float64Array; h1Map: Map<number, number>; m1Map: Map<number, number>; h4Map: Map<number, number>; spread: number; leverage: number; }

console.log("Loading top-50 caches...");
const allPairs: PD[] = [];
const skipped: string[] = [];
for (const name of TOP50) {
  const raw = loadTA(`${name}USDT`);
  if (!raw) { skipped.push(name); continue; }
  const h1 = agg(raw, H, 200);
  const h4 = agg(raw, H4, 50);
  if (!h1 || !h4) { skipped.push(name); continue; }
  const z1h = zs(h1, 15);
  const z4h = zs(h4, 20);
  const ms = OOS_START - 24 * H, me = OOS_END + 24 * H;
  const ki: number[] = [];
  for (let i = 0; i < raw.n; i++) if (raw.t[i]! >= ms && raw.t[i]! <= me) ki.push(i);
  const mn = ki.length;
  const m1: TA = { t: new Float64Array(mn), o: new Float64Array(mn), h: new Float64Array(mn), l: new Float64Array(mn), c: new Float64Array(mn), n: mn };
  for (let k = 0; k < mn; k++) {
    const i = ki[k]!;
    m1.t[k] = raw.t[i]!; m1.o[k] = raw.o[i]!; m1.h[k] = raw.h[i]!; m1.l[k] = raw.l[i]!; m1.c[k] = raw.c[i]!;
  }
  const h1Map = new Map<number, number>();
  for (let i = 0; i < h1.n; i++) h1Map.set(h1.t[i]!, i);
  const m1Map = new Map<number, number>();
  for (let i = 0; i < m1.n; i++) m1Map.set(m1.t[i]!, i);
  const h4Map = new Map<number, number>();
  for (let i = 0; i < h4.n; i++) h4Map.set(h4.t[i]!, i);
  allPairs.push({ name, m1, h1, h4, z1h, z4h, h1Map, m1Map, h4Map, spread: SP[name] ?? DEFAULT_SPREAD, leverage: getLeverage(name) });
}
console.log(`Loaded ${allPairs.length}/${TOP50.length}, skipped: ${skipped.join(",") || "(none)"}`);
if (allPairs.length < 10) { console.error("Need at least 10 pairs"); process.exit(1); }

interface Stats { pnlDay: number; mdd: number; pf: number; wr: number; trades: number; calmar: number; tradesPerDay: number; maxLoss: number; maxLossStreak: number; longTrades: number; shortTrades: number; }
interface Pos { pair: string; direction: 1 | -1; entryPrice: number; entryTime: number; stopLoss: number; peakLevPnlPct: number; spread: number; leverage: number; notional: number; }

function get4h(p: PD, ts: number): number {
  const b = Math.floor(ts / H4) * H4;
  const i = p.h4Map.get(b);
  if (i !== undefined && i > 0) return p.z4h[i - 1]!;
  let lo = 0, hi = p.h4.n - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (p.h4.t[m]! + H4 <= ts) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? p.z4h[best]! : 0;
}

function sim(pairs: PD[]): Stats {
  const pByN = new Map<string, PD>();
  pairs.forEach(p => pByN.set(p.name, p));
  const allTs = new Set<number>();
  for (const p of pairs) for (let i = 0; i < p.m1.n; i++) {
    const t = p.m1.t[i]!;
    if (t >= OOS_START && t < OOS_END) allTs.add(t);
  }
  const timepoints = [...allTs].sort((a, b) => a - b);

  const open: Pos[] = [];
  let rp = 0, mp = 0, mdd = 0, tt = 0, tw = 0, gp = 0, gl = 0;
  let maxLoss = 0, maxStreak = 0, curStreak = 0;
  let longT = 0, shortT = 0;
  const cd = new Map<string, number>();
  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i]!;
      const pd = pByN.get(pos.pair)!;
      const bi = pd.m1Map.get(ts);
      if (bi === undefined) continue;
      const bL = pd.m1.l[bi]!, bH = pd.m1.h[bi]!, bC = pd.m1.c[bi]!;
      let xp = 0, rs = "";
      if ((ts - pos.entryTime) / H >= MAX_HOLD_H) { xp = bC; rs = "maxh"; }
      if (!xp) {
        if (pos.direction === 1 && bL <= pos.stopLoss) { xp = pos.stopLoss; rs = "sl"; }
        else if (pos.direction === -1 && bH >= pos.stopLoss) { xp = pos.stopLoss; rs = "sl"; }
      }
      const move = pos.direction === 1 ? bH / pos.entryPrice - 1 : 1 - bL / pos.entryPrice;
      const bp = move * pos.leverage * 100;
      if (bp > pos.peakLevPnlPct) pos.peakLevPnlPct = bp;
      if (!xp && pos.peakLevPnlPct >= TRAIL_ARM) {
        const cur = (pos.direction === 1 ? bC / pos.entryPrice - 1 : 1 - bC / pos.entryPrice) * pos.leverage * 100;
        if (cur <= pos.peakLevPnlPct - TRAIL_DROP) { xp = bC; rs = "trail"; }
      }
      if (xp > 0) {
        const es = rs === "sl" ? pos.spread * 0.75 : pos.spread / 2;
        const fp = pos.direction === 1 ? xp * (1 - es) : xp * (1 + es);
        const ret = pos.direction === 1 ? fp / pos.entryPrice - 1 : 1 - fp / pos.entryPrice;
        const pnl = ret * pos.notional - pos.notional * FEE * 2;
        open.splice(i, 1);
        rp += pnl; tt++;
        if (pos.direction === 1) longT++; else shortT++;
        if (pnl > 0) { tw++; gp += pnl; curStreak = 0; }
        else { gl += Math.abs(pnl); if (Math.abs(pnl) > maxLoss) maxLoss = Math.abs(pnl); curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
        if (rs === "sl") cd.set(`${pos.pair}:${pos.direction}`, ts + CD_H * H);
      }
    }
    let up = 0;
    for (const pos of open) {
      const pd = pByN.get(pos.pair)!;
      const bi = pd.m1Map.get(ts);
      if (bi === undefined) continue;
      const ret = pos.direction === 1 ? pd.m1.c[bi]! / pos.entryPrice - 1 : 1 - pd.m1.c[bi]! / pos.entryPrice;
      up += ret * pos.notional - pos.notional * FEE * 2;
    }
    const te = rp + up;
    if (te > mp) mp = te;
    if (mp - te > mdd) mdd = mp - te;
    if (!isH1) continue;
    if (BLOCK_HOURS.has(new Date(ts).getUTCHours())) continue;
    if (open.length >= MC) continue;
    for (const p of pairs) {
      if (open.length >= MC) break;
      if (open.some(po => po.pair === p.name)) continue;
      const h1i = p.h1Map.get(ts);
      if (h1i === undefined || h1i < 20) continue;
      const z1 = p.z1h[h1i - 1]!;
      const z4 = get4h(p, ts);
      // LONG
      if (z1 > Z1_LONG && z4 > Z4_LONG) {
        const cdL = cd.get(`${p.name}:1`);
        if (!cdL || ts >= cdL) {
          const ep = p.h1.o[h1i]! * (1 + p.spread / 2);
          const slPct = p.leverage >= 10 ? SL_HIGH : SL_LOW;
          const sl = ep * (1 - slPct);
          const no = MARGIN * p.leverage;
          open.push({ pair: p.name, direction: 1, entryPrice: ep, entryTime: ts, stopLoss: sl, peakLevPnlPct: 0, spread: p.spread, leverage: p.leverage, notional: no });
          continue;
        }
      }
      // SHORT
      if (z1 < -Z1_SHORT && z4 < -Z4_SHORT) {
        const cdS = cd.get(`${p.name}:-1`);
        if (!cdS || ts >= cdS) {
          const ep = p.h1.o[h1i]! * (1 - p.spread / 2);
          const slPct = p.leverage >= 10 ? SL_HIGH : SL_LOW;
          const sl = ep * (1 + slPct);
          const no = MARGIN * p.leverage;
          open.push({ pair: p.name, direction: -1, entryPrice: ep, entryTime: ts, stopLoss: sl, peakLevPnlPct: 0, spread: p.spread, leverage: p.leverage, notional: no });
        }
      }
    }
  }
  const pnlDay = rp / OOS_DAYS;
  const wr = tt > 0 ? tw / tt * 100 : 0;
  const pf = gl > 0 ? gp / gl : 0;
  const calmar = mdd > 0 ? pnlDay / mdd : 0;
  const tradesPerDay = tt / OOS_DAYS;
  return { pnlDay, mdd, pf, wr, trades: tt, calmar, tradesPerDay, maxLoss, maxLossStreak: maxStreak, longTrades: longT, shortTrades: shortT };
}

const CANDIDATE_SETS = [10, 15, 20, 25, 35, 50];
const SETS = CANDIDATE_SETS.filter(n => n <= allPairs.length);
if (allPairs.length > Math.max(...SETS)) SETS.push(allPairs.length);

console.log("\n" + "=".repeat(130));
console.log(`PAIR-COUNT SWEEP (DEPLOYED C2) | $${MARGIN} margin | mc=${MC} | z=${Z1_LONG}/${Z4_LONG} symm L+S | T${TRAIL_ARM}/${TRAIL_DROP} | SL ${SL_HIGH*100}/${SL_LOW*100}% | ${OOS_DAYS.toFixed(0)} days OOS`);
console.log("=".repeat(130));
console.log(`${"#pairs".padStart(7)} ${"$/day".padStart(7)} ${"MDD".padStart(6)} ${"PF".padStart(5)} ${"WR%".padStart(5)} ${"T".padStart(5)} ${"L:S".padStart(8)} ${"T/d".padStart(5)} ${"MaxL".padStart(6)} ${"Strk".padStart(4)} ${"Calmar".padStart(7)} ${"$/mo".padStart(6)}`);

const results: Array<{ n: number; r: Stats }> = [];
for (const n of SETS) {
  if (n > allPairs.length) continue;
  const subset = allPairs.slice(0, n);
  const r = sim(subset);
  results.push({ n, r });
  const monthly = r.pnlDay * 30;
  const ls = `${r.longTrades}:${r.shortTrades}`;
  console.log(`${String(n).padStart(7)} ${r.pnlDay.toFixed(2).padStart(7)} ${r.mdd.toFixed(1).padStart(6)} ${r.pf.toFixed(2).padStart(5)} ${r.wr.toFixed(1).padStart(5)} ${String(r.trades).padStart(5)} ${ls.padStart(8)} ${r.tradesPerDay.toFixed(2).padStart(5)} ${r.maxLoss.toFixed(2).padStart(6)} ${String(r.maxLossStreak).padStart(4)} ${r.calmar.toFixed(3).padStart(7)} ${monthly.toFixed(2).padStart(6)}`);
}

console.log("\n--- DEPLOYED (top-15) vs WIDER ---");
const r15 = results.find(r => r.n === 15)?.r;
if (r15) {
  for (const { n, r } of results) {
    if (n === 15) continue;
    const dDay = r.pnlDay - r15.pnlDay;
    const dMdd = r.mdd - r15.mdd;
    const dCal = r.calmar - r15.calmar;
    const verdict =
      dCal > 0.005 && r.mdd <= r15.mdd * 1.2 ? "BETTER" :
      dCal < -0.005 ? "WORSE" : "neutral";
    console.log(`Top-${n}: $/day ${dDay >= 0 ? "+" : ""}${dDay.toFixed(2)}, MDD ${dMdd >= 0 ? "+" : ""}$${dMdd.toFixed(1)}, Calmar ${dCal >= 0 ? "+" : ""}${dCal.toFixed(3)} [${verdict}]`);
  }
}

console.log("\n--- WINNER ---");
const sorted = [...results].sort((a, b) => b.r.calmar - a.r.calmar);
const winner = sorted[0]!;
console.log(`Highest Calmar: top-${winner.n} (Calmar ${winner.r.calmar.toFixed(3)}, $/day ${winner.r.pnlDay.toFixed(2)}, MDD $${winner.r.mdd.toFixed(1)})`);
if (winner.n !== 15) {
  console.log(`>>> CONSIDER: switching from top-15 to top-${winner.n}`);
} else {
  console.log(`>>> KEEP DEPLOYED: top-15 is the Calmar winner`);
}
