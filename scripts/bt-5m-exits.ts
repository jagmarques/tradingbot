/**
 * Realistic backtest: 1h bars for ENTRY signals, 5m bars for EXIT checks
 * This simulates the live monitor checking every 10s (5m is closest we have)
 * Tests multiple trail widths to find what survives on 5m resolution
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 5 * 60_000;
const H = 3_600_000; const H4 = 4 * H; const D = 86_400_000;
const MOM_LB = 3; const VOL_WIN = 20; const SL_CAP = 0.01;
const MAX_HOLD_H = 72; const CD_H = 1; const BLOCK_HOURS = [22, 23];
const FEE = 0.00035; const MARGIN = 5;

const SP: Record<string, number> = { XRP:1.05e-4,DOGE:1.35e-4,BTC:0.5e-4,ETH:1.0e-4,SOL:2.0e-4,SUI:1.85e-4,AVAX:2.55e-4,TIA:2.5e-4,ARB:2.6e-4,ENA:2.55e-4,UNI:2.75e-4,APT:3.2e-4,LINK:3.45e-4,TRUMP:3.65e-4,WLD:4e-4,DOT:4.95e-4,WIF:5.05e-4,ADA:5.55e-4,LDO:5.8e-4,OP:6.2e-4,DASH:7.15e-4,NEAR:3.5e-4,FET:4e-4,HYPE:4e-4,ZEC:4e-4 };
const DSP = 5e-4;
const RM: Record<string,string> = { kPEPE:"1000PEPE",kFLOKI:"1000FLOKI",kBONK:"1000BONK",kSHIB:"1000SHIB" };
const LM = new Map<string,number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt","utf8").trim().split("\n")) { const [n,v]=l.split(":"); LM.set(n!,parseInt(v!)); }
function gl(n: string): number { return Math.min(LM.get(n) ?? 3, 10); }

const ALL = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET","FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR","PENDLE","PNUT","ATOM","TON","SEI","STX",
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN","TNSR","CATI","TURBO","MOVE","GALA","STRK","SAGA","ILV","GMX","OM",
  "CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC","USUAL","UMA","USTC","MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS","MINA","LISTA","NEO","AI","SCR","APE","KAITO","AR","BNT","PIXEL",
  "LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET","STG","REQ","CAKE","SUPER","FTT","STRAX",
];
const OOS_S = new Date("2025-06-01").getTime(); const OOS_E = new Date("2026-03-25").getTime();
const OOS_D = (OOS_E - OOS_S) / D;

interface C { t:number; o:number; h:number; l:number; c:number; }
interface Tr { pair:string; dir:"long"|"short"; pnl:number; reason:string; }
interface PI { h1:C[];h4:C[];m5:C[];z1:number[];z4:number[];h1Map:Map<number,number>;h4Map:Map<number,number>; }

function ld(s: string): C[] { const f=path.join(CACHE_5M,`${s}.json`); if(!fs.existsSync(f))return[]; return (JSON.parse(fs.readFileSync(f,"utf8")) as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b).sort((a:C,b:C)=>a.t-b.t); }
function agg(b:C[],p:number,m:number):C[] { const g=new Map<number,C[]>(); for(const c of b){const k=Math.floor(c.t/p)*p;let a=g.get(k);if(!a){a=[];g.set(k,a);}a.push(c);} const r:C[]=[]; for(const[t,grp]of g){if(grp.length<m)continue;grp.sort((a,b)=>a.t-b.t);r.push({t,o:grp[0]!.o,h:Math.max(...grp.map(b=>b.h)),l:Math.min(...grp.map(b=>b.l)),c:grp[grp.length-1]!.c});} return r.sort((a,b)=>a.t-b.t); }
function computeZ(cs:C[]):number[] { const z=new Array(cs.length).fill(0); for(let i=Math.max(MOM_LB+1,VOL_WIN+1);i<cs.length;i++){const m=cs[i]!.c/cs[i-MOM_LB]!.c-1;let ss=0,c=0;for(let j=Math.max(1,i-VOL_WIN);j<=i;j++){const r=cs[j]!.c/cs[j-1]!.c-1;ss+=r*r;c++;}if(c<10)continue;const v=Math.sqrt(ss/c);if(v===0)continue;z[i]=m/v;} return z; }
function g4z(z4:number[],h4:C[],h4Map:Map<number,number>,t:number):number { const b=Math.floor(t/H4)*H4;let i=h4Map.get(b);if(i!==undefined&&i>0)return z4[i-1]!;let lo=0,hi=h4.length-1,best=-1;while(lo<=hi){const m2=(lo+hi)>>1;if(h4[m2]!.t<t){best=m2;lo=m2+1;}else hi=m2-1;}return best>=0?z4[best]!:0; }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface PD { name:string; ind:PI; sp:number; lev:number; not:number; }

function run(pairs: PD[], trail: {a:number;d:number}[], slPct: number, zl1: number, zl4: number, label: string) {
  // Build 5m timeline for each pair
  // ENTRY: check on 1h boundaries using z-scores
  // EXIT: check on EVERY 5m bar (simulates 10s live monitoring)

  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();

  interface OpenPos { pair:string; dir:"long"|"short"; ep:number; et:number; sl:number; pk:number; sp:number; lev:number; not:number; }
  const openPositions: OpenPos[] = [];

  // Collect all 5m timestamps in OOS
  const all5mTimes = new Set<number>();
  for (const p of pairs) {
    for (const b of p.ind.m5) {
      if (b.t >= OOS_S && b.t < OOS_E) all5mTimes.add(b.t);
    }
  }
  const timepoints = [...all5mTimes].sort((a, b) => a - b);

  // Build 5m index per pair
  const m5Maps = new Map<string, Map<number, number>>();
  for (const p of pairs) {
    const m = new Map<number, number>();
    p.ind.m5.forEach((c, i) => m.set(c.t, i));
    m5Maps.set(p.name, m);
  }

  for (const ts of timepoints) {
    const isH1Boundary = ts % H === 0;
    const hourOfDay = new Date(ts).getUTCHours();

    // ─── EXIT on 5m bars (every 5 minutes, like live monitor) ───
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair);
      if (!m5Map) continue;
      const bi = m5Map.get(ts);
      if (bi === undefined) continue;
      const pd = pairs.find(p => p.name === pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;

      // Max hold
      if ((ts - pos.et) / H >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }

      // SL
      if (!xp) {
        const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (slHit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }

      // Trail (checked on every 5m bar, like live)
      if (!xp) {
        const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.l - 1) * pos.lev * 100;
        if (best > pos.pk) pos.pk = best;
        const cur = pos.dir === "long" ? (bar.c / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.c - 1) * pos.lev * 100;
        let td = Infinity;
        for (const s of trail) if (pos.pk >= s.a) td = s.d;
        if (td < Infinity && cur <= pos.pk - td) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * 1.5 : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    // ─── ENTRY only on 1h boundaries (like scheduler) ───
    if (!isH1Boundary) continue;
    if (BLOCK_HOURS.includes(hourOfDay)) continue;

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < VOL_WIN + 2) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;
      const z4 = g4z(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      let dir: "long" | "short" | null = null;
      if (z1 > zl1 && z4 > zl4) dir = "long";
      if (z1 < -zl1 && z4 < -zl4) dir = "short";
      if (!dir) continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const sld = Math.min(ep * slPct, ep * SL_CAP);
      const sl = dir === "long" ? ep - sld : ep + sld;
      openPositions.push({ pair: p.name, dir, ep, et: ts, sl, pk: 0, sp: p.sp, lev: p.lev, not: p.not });
    }
  }

  // Close remaining
  for (const pos of openPositions) {
    const pd = pairs.find(p => p.name === pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, pnl, reason: "end" });
  }

  const total = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0).length;
  const wr = closed.length > 0 ? wins / closed.length * 100 : 0;
  const gp = closed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl2 = Math.abs(closed.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = gl2 > 0 ? gp / gl2 : Infinity;
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }
  const slN = closed.filter(t => t.reason === "sl").length;
  const trN = closed.filter(t => t.reason === "trail").length;

  console.log(`  ${label.padEnd(52)} ${String(closed.length).padStart(5)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(total/OOS_D).padStart(9)} $${maxDD.toFixed(0).padStart(3)} ${String(slN).padStart(5)} ${String(trN).padStart(5)}`);
}

function main() {
  console.log("=".repeat(105));
  console.log("  REALISTIC BACKTEST: 1h entry, 5m exit checks (simulates live 10s monitor)");
  console.log("  z2.5/2.0, SL 0.3%, $5 uniform, 127 pairs, real leverage");
  console.log("=".repeat(105));

  console.log("\n  Loading 5m + 1h + 4h data for all pairs...");
  const pairs: PD[] = [];
  for (const n of ALL) {
    const s = RM[n] ?? n;
    let raw = ld(`${s}USDT`); if (raw.length < 5000) raw = ld(`${n}USDT`); if (raw.length < 5000) continue;
    const h1 = agg(raw, H, 10); const h4 = agg(raw, H4, 40);
    if (h1.length < 100 || h4.length < 50) continue;
    const z1 = computeZ(h1); const z4 = computeZ(h4);
    const h1Map = new Map<number, number>(); h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>(); h4.forEach((c, i) => h4Map.set(c.t, i));
    const lev = gl(n);
    // Keep raw 5m bars for exit checks
    const m5 = raw.filter(b => b.t >= OOS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, z1, z4, h1Map, h4Map }, sp: SP[n] ?? DSP, lev, not: MARGIN * lev });
  }
  console.log(`  ${pairs.length} pairs loaded\n`);

  const hdr = `  ${"Config".padEnd(52)} ${"Trd".padStart(5)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"$/day".padStart(9)} ${"MDD".padStart(4)} ${"SL".padStart(5)} ${"Trl".padStart(5)}`;

  // ─── Compare 1h exit vs 5m exit on same trail ───
  console.log("--- TIGHT TRAILS: 5m EXIT RESOLUTION (like live) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));

  // The previous winner and variants
  run(pairs, [{a:3,d:1.5},{a:5,d:1},{a:10,d:0.5},{a:20,d:0.5}], 0.003, 2.5, 2.0, "TIGHT: 3/1.5->5/1->10/0.5->20/0.5");
  run(pairs, [{a:3,d:1.5},{a:8,d:0.5},{a:20,d:0.5}], 0.003, 2.5, 2.0, "TIGHT: 3/1.5->8/0.5->20/0.5");

  // Wider distances (more live-safe)
  console.log("\n--- WIDER TRAILS: safer for 5m/10s monitoring ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));

  run(pairs, [{a:5,d:3},{a:10,d:2},{a:20,d:1}], 0.003, 2.5, 2.0, "WIDE: 5/3->10/2->20/1");
  run(pairs, [{a:5,d:3},{a:15,d:2},{a:30,d:1}], 0.003, 2.5, 2.0, "WIDE: 5/3->15/2->30/1");
  run(pairs, [{a:5,d:2},{a:10,d:1.5},{a:20,d:1}], 0.003, 2.5, 2.0, "MED: 5/2->10/1.5->20/1");
  run(pairs, [{a:5,d:2},{a:15,d:1},{a:30,d:0.5}], 0.003, 2.5, 2.0, "MED: 5/2->15/1->30/0.5");
  run(pairs, [{a:5,d:2.5},{a:12,d:1.5},{a:25,d:1}], 0.003, 2.5, 2.0, "MED: 5/2.5->12/1.5->25/1");
  run(pairs, [{a:7,d:3},{a:15,d:2},{a:30,d:1}], 0.003, 2.5, 2.0, "WIDE: 7/3->15/2->30/1");
  run(pairs, [{a:7,d:3},{a:20,d:2},{a:40,d:1}], 0.003, 2.5, 2.0, "WIDE: 7/3->20/2->40/1");
  run(pairs, [{a:10,d:4},{a:20,d:2},{a:40,d:1}], 0.003, 2.5, 2.0, "WIDE: 10/4->20/2->40/1");
  run(pairs, [{a:10,d:5},{a:20,d:3},{a:35,d:1.5},{a:50,d:1}], 0.003, 2.5, 2.0, "OLD DEPLOYED: 10/5->20/3->35/1.5->50/1");

  // With BE instead of tight trail
  console.log("\n--- BE + WIDER TRAIL ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));

  // For BE, I need to add it back... actually let me just test wider trails without BE
  // since the sim doesn't have BE parameter exposed here

  // ─── Different SL with wider trails ───
  console.log("\n--- SL SWEEP WITH WIDER TRAILS (5m exits) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));

  for (const sl of [0.003, 0.004, 0.005]) {
    run(pairs, [{a:5,d:3},{a:15,d:2},{a:30,d:1}], sl, 2.5, 2.0, `SL${(sl*100).toFixed(1)}% + 5/3->15/2->30/1`);
    run(pairs, [{a:5,d:2},{a:10,d:1.5},{a:20,d:1}], sl, 2.5, 2.0, `SL${(sl*100).toFixed(1)}% + 5/2->10/1.5->20/1`);
    run(pairs, [{a:7,d:3},{a:15,d:2},{a:30,d:1}], sl, 2.5, 2.0, `SL${(sl*100).toFixed(1)}% + 7/3->15/2->30/1`);
  }

  // ─── Compare z-score thresholds ───
  console.log("\n--- Z-SCORE COMPARISON (5m exits, wider trail) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));

  run(pairs, [{a:5,d:3},{a:15,d:2},{a:30,d:1}], 0.003, 3.0, 2.5, "z3.0/2.5 + 5/3->15/2->30/1");
  run(pairs, [{a:5,d:3},{a:15,d:2},{a:30,d:1}], 0.003, 2.5, 2.0, "z2.5/2.0 + 5/3->15/2->30/1");
  run(pairs, [{a:5,d:3},{a:15,d:2},{a:30,d:1}], 0.003, 2.5, 2.5, "z2.5/2.5 + 5/3->15/2->30/1");
}

main();
