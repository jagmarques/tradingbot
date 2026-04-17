/**
 * SL FIX: Test 3 options with 5m SL resolution + 1h trail resolution
 * The problem: exchange SL fires on ticks (5m simulates this), but backtest checked SL on 1h
 *
 * Option A: Wider exchange SL (0.5%-2%) checked on 5m, trail on 1h
 * Option B: Wide exchange SL (2%) on 5m + tight bot SL (0.3%) on 1h boundaries
 * Option C: All exits on 1h only (SL + trail) -- no exchange stop
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 5*60_000; const H = 3_600_000; const H4 = 4*H; const D = 86_400_000;
const FEE = 0.00035; const MARGIN = 10; const MOM_LB = 3; const VOL_WIN = 20;
const MAX_HOLD_H = 72; const CD_H = 1; const BLOCK = [22,23]; const MAX_POS = 8;
const ZL1 = 2.0; const ZL4 = 1.5; const ZS1 = -2.0; const ZS4 = -1.5;
const TRAIL = [{a:7,d:3},{a:15,d:2},{a:30,d:1}];
const SL_CAP = 0.02; // wider cap for options that use wide SL

const SP: Record<string,number> = { XRP:1.05e-4,DOGE:1.35e-4,BTC:0.5e-4,ETH:1e-4,SOL:2e-4,SUI:1.85e-4,AVAX:2.55e-4,TIA:2.5e-4,ARB:2.6e-4,ENA:2.55e-4,UNI:2.75e-4,APT:3.2e-4,LINK:3.45e-4,TRUMP:3.65e-4,WLD:4e-4,DOT:4.95e-4,WIF:5.05e-4,ADA:5.55e-4,LDO:5.8e-4,OP:6.2e-4,DASH:7.15e-4,NEAR:3.5e-4,FET:4e-4,HYPE:4e-4,ZEC:4e-4 };
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
function ld(s: string): C[] { const f=path.join(CACHE_5M,`${s}.json`); if(!fs.existsSync(f))return[]; return (JSON.parse(fs.readFileSync(f,"utf8")) as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b).sort((a:C,b:C)=>a.t-b.t); }
function agg(b:C[],p:number,m:number):C[] { const g=new Map<number,C[]>(); for(const c of b){const k=Math.floor(c.t/p)*p;let a=g.get(k);if(!a){a=[];g.set(k,a);}a.push(c);} const r:C[]=[]; for(const[t,grp]of g){if(grp.length<m)continue;grp.sort((a,b)=>a.t-b.t);r.push({t,o:grp[0]!.o,h:Math.max(...grp.map(b=>b.h)),l:Math.min(...grp.map(b=>b.l)),c:grp[grp.length-1]!.c});} return r.sort((a,b)=>a.t-b.t); }
function computeZ(cs:C[]):number[] { const z=new Array(cs.length).fill(0); for(let i=Math.max(MOM_LB+1,VOL_WIN+1);i<cs.length;i++){const m=cs[i]!.c/cs[i-MOM_LB]!.c-1;let ss=0,c=0;for(let j=Math.max(1,i-VOL_WIN);j<=i;j++){const r=cs[j]!.c/cs[j-1]!.c-1;ss+=r*r;c++;}if(c<10)continue;const v=Math.sqrt(ss/c);if(v===0)continue;z[i]=m/v;} return z; }
function g4z(z4:number[],h4:C[],m4:Map<number,number>,t:number):number { const b=Math.floor(t/H4)*H4;let i=m4.get(b);if(i!==undefined&&i>0)return z4[i-1]!;let lo=0,hi=h4.length-1,best=-1;while(lo<=hi){const m2=(lo+hi)>>1;if(h4[m2]!.t<t){best=m2;lo=m2+1;}else hi=m2-1;}return best>=0?z4[best]!:0; }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface PD { name:string; m5:C[]; h1:C[]; h4:C[]; z1:number[]; z4:number[]; h1Map:Map<number,number>; h4Map:Map<number,number>; m5Map:Map<number,number>; sp:number; lev:number; not:number; }

interface Opts {
  exchangeSlPct: number;  // SL checked on 5m bars (exchange stop, tick-level)
  botSlPct: number;       // SL checked on 1h bars only (bot-monitored)
  label: string;
}

function run(pairs: PD[], opts: Opts) {
  // Collect all 5m timestamps for exit checks
  const all5m = new Set<number>();
  for (const p of pairs) for (const b of p.m5) if (b.t >= OOS_S && b.t < OOS_E) all5m.add(b.t);
  const timepoints = [...all5m].sort((a, b) => a - b);

  interface OP { pair:string;dir:"long"|"short";ep:number;et:number;exchangeSl:number;botSl:number;pk:number;sp:number;lev:number;not:number; }
  const open: OP[] = []; const closed: {pnl:number;reason:string}[] = []; const cd = new Map<string,number>();
  let skip = 0;

  for (const ts of timepoints) {
    const isH1 = ts % H === 0;

    // EXIT on every 5m bar
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i]!;
      const m5i = pairs.find(p => p.name === pos.pair)?.m5Map.get(ts);
      if (m5i === undefined) continue;
      const pd = pairs.find(p => p.name === pos.pair)!;
      const bar = pd.m5[m5i]!;

      let xp = 0, reason = "", isSL = false;

      // Max hold
      if ((ts - pos.et) / H >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }

      // Exchange SL: fires on 5m bars (simulates tick-level exchange stop)
      if (!xp && pos.exchangeSl > 0) {
        const hit = pos.dir === "long" ? bar.l <= pos.exchangeSl : bar.h >= pos.exchangeSl;
        if (hit) { xp = pos.exchangeSl; reason = "exchange-sl"; isSL = true; }
      }

      // Bot SL: fires only on 1h boundaries
      if (!xp && isH1 && pos.botSl > 0) {
        const hit = pos.dir === "long" ? bar.l <= pos.botSl : bar.h >= pos.botSl;
        if (hit) { xp = pos.botSl; reason = "bot-sl"; isSL = true; }
      }

      // Trail: fires only on 1h boundaries
      if (!xp) {
        // Always update peak on every 5m bar
        const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.l - 1) * pos.lev * 100;
        if (best > pos.pk) pos.pk = best;

        // But trail EXIT only on 1h boundary
        if (isH1) {
          const cur = pos.dir === "long" ? (bar.c / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.c - 1) * pos.lev * 100;
          let td = Infinity;
          for (const s of TRAIL) if (pos.pk >= s.a) td = s.d;
          if (td < Infinity && cur <= pos.pk - td) { xp = bar.c; reason = "trail"; }
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * 1.5 : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pnl, reason });
        open.splice(i, 1);
        if (isSL) cd.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    // ENTRY only on 1h boundaries
    if (!isH1) continue;
    if (BLOCK.includes(new Date(ts).getUTCHours())) continue;

    interface Sig { pair:string; dir:"long"|"short"; z:number; h1Idx:number; sp:number; lev:number; not:number; }
    const sigs: Sig[] = [];
    for (const p of pairs) {
      const h1Idx = p.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < VOL_WIN + 2) continue;
      if (open.some(o => o.pair === p.name)) continue;
      const z1 = p.z1[h1Idx - 1]!; const z4 = g4z(p.z4, p.h4, p.h4Map, ts);
      let dir: "long"|"short"|null = null;
      if (z1 > ZL1 && z4 > ZL4) dir = "long";
      if (z1 < ZS1 && z4 < ZS4) dir = "short";
      if (!dir) continue;
      const ck = `${p.name}:${dir}`; if (cd.has(ck) && ts < cd.get(ck)!) continue;
      sigs.push({ pair: p.name, dir, z: Math.abs(z1), h1Idx, sp: p.sp, lev: p.lev, not: p.not });
    }
    sigs.sort((a, b) => b.z - a.z);

    for (const sig of sigs) {
      if (open.length >= MAX_POS) { skip++; break; }
      const p = pairs.find(pp => pp.name === sig.pair)!;
      const ep = sig.dir === "long" ? p.h1[sig.h1Idx]!.o * (1 + sig.sp) : p.h1[sig.h1Idx]!.o * (1 - sig.sp);

      // Exchange SL (wide, placed on exchange, fires on ticks)
      const exSlDist = ep * opts.exchangeSlPct;
      const exchangeSl = opts.exchangeSlPct > 0 ? (sig.dir === "long" ? ep - exSlDist : ep + exSlDist) : 0;

      // Bot SL (tight, checked at 1h boundary only)
      const botSlDist = ep * opts.botSlPct;
      const botSl = opts.botSlPct > 0 ? (sig.dir === "long" ? ep - botSlDist : ep + botSlDist) : 0;

      open.push({ pair: sig.pair, dir: sig.dir, ep, et: ts, exchangeSl, botSl, pk: 0, sp: sig.sp, lev: sig.lev, not: sig.not });
    }
  }

  // Close remaining
  for (const pos of open) {
    const pd = pairs.find(p => p.name === pos.pair)!;
    const lb = pd.m5[pd.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pnl, reason: "end" });
  }

  const total = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0).length;
  const wr = closed.length > 0 ? wins / closed.length * 100 : 0;
  const gp = closed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl2 = Math.abs(closed.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = gl2 > 0 ? gp / gl2 : Infinity;
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  const exSlN = closed.filter(t => t.reason === "exchange-sl").length;
  const botSlN = closed.filter(t => t.reason === "bot-sl").length;
  const trN = closed.filter(t => t.reason === "trail").length;

  console.log(`  ${opts.label.padEnd(52)} ${String(closed.length).padStart(5)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(total/OOS_D).padStart(9)} $${maxDD.toFixed(0).padStart(3)} ${String(exSlN).padStart(5)} ${String(botSlN).padStart(5)} ${String(trN).padStart(5)}`);
}

function main() {
  console.log("=".repeat(105));
  console.log("  SL FIX: 5m exchange SL + 1h bot SL + 1h trail");
  console.log("  z2.0/1.5, $10 margin, max 8, trail 7/3->15/2->30/1, real leverage");
  console.log("=".repeat(105));

  console.log("\n  Loading 5m + 1h + 4h data...");
  const pairs: PD[] = [];
  for (const n of ALL) {
    const s = RM[n] ?? n;
    let raw = ld(`${s}USDT`); if (raw.length < 5000) raw = ld(`${n}USDT`); if (raw.length < 5000) continue;
    const h1 = agg(raw, H, 10); const h4 = agg(raw, H4, 40);
    if (h1.length < 100 || h4.length < 50) continue;
    const z1 = computeZ(h1); const z4 = computeZ(h4);
    const h1Map = new Map<number, number>(); h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>(); h4.forEach((c, i) => h4Map.set(c.t, i));
    const m5Map = new Map<number, number>(); raw.forEach((c, i) => m5Map.set(c.t, i));
    const lev = gl(n);
    // Only keep 5m bars in OOS range (+buffer)
    const m5 = raw.filter(b => b.t >= OOS_S - 24*H && b.t <= OOS_E + 24*H);
    const m5Map2 = new Map<number, number>(); m5.forEach((c, i) => m5Map2.set(c.t, i));
    pairs.push({ name: n, m5, h1, h4, z1, z4, h1Map, h4Map, m5Map: m5Map2, sp: SP[n] ?? DSP, lev, not: MARGIN * lev });
  }
  console.log(`  ${pairs.length} pairs loaded\n`);

  const hdr = `  ${"Config".padEnd(52)} ${"Trd".padStart(5)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"$/day".padStart(9)} ${"MDD".padStart(4)} ${"ExSL".padStart(5)} ${"BotSL".padStart(5)} ${"Trail".padStart(5)}`;

  // ─── BASELINE: All exits on 1h (what backtest assumed) ───
  console.log("--- BASELINE: All exits on 1h bars (ideal backtest) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(100));
  // Simulate 1h-only by setting exchange SL to 0 (disabled) and bot SL on 1h
  run(pairs, { exchangeSlPct: 0, botSlPct: 0.003, label: "C: SL 0.3% on 1h only (ideal backtest)" });
  run(pairs, { exchangeSlPct: 0, botSlPct: 0.005, label: "C: SL 0.5% on 1h only" });
  run(pairs, { exchangeSlPct: 0, botSlPct: 0.01, label: "C: SL 1.0% on 1h only" });

  // ─── OPTION A: Wider exchange SL on 5m (what live does now) ───
  console.log("\n--- OPTION A: Exchange SL on 5m bars (current live behavior) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(100));
  run(pairs, { exchangeSlPct: 0.003, botSlPct: 0, label: "A: Exchange SL 0.3% on 5m (CURRENT)" });
  run(pairs, { exchangeSlPct: 0.005, botSlPct: 0, label: "A: Exchange SL 0.5% on 5m" });
  run(pairs, { exchangeSlPct: 0.0075, botSlPct: 0, label: "A: Exchange SL 0.75% on 5m" });
  run(pairs, { exchangeSlPct: 0.01, botSlPct: 0, label: "A: Exchange SL 1.0% on 5m" });
  run(pairs, { exchangeSlPct: 0.015, botSlPct: 0, label: "A: Exchange SL 1.5% on 5m" });
  run(pairs, { exchangeSlPct: 0.02, botSlPct: 0, label: "A: Exchange SL 2.0% on 5m" });

  // ─── OPTION B: Wide exchange SL + tight bot SL on 1h ───
  console.log("\n--- OPTION B: Wide exchange SL (5m) + tight bot SL (1h) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(100));
  // Exchange SL at 2% (emergency only), bot SL at various tights on 1h
  run(pairs, { exchangeSlPct: 0.02, botSlPct: 0.003, label: "B: Exch 2% + Bot 0.3% on 1h" });
  run(pairs, { exchangeSlPct: 0.02, botSlPct: 0.005, label: "B: Exch 2% + Bot 0.5% on 1h" });
  run(pairs, { exchangeSlPct: 0.02, botSlPct: 0.0075, label: "B: Exch 2% + Bot 0.75% on 1h" });
  run(pairs, { exchangeSlPct: 0.02, botSlPct: 0.01, label: "B: Exch 2% + Bot 1.0% on 1h" });
  run(pairs, { exchangeSlPct: 0.015, botSlPct: 0.003, label: "B: Exch 1.5% + Bot 0.3% on 1h" });
  run(pairs, { exchangeSlPct: 0.015, botSlPct: 0.005, label: "B: Exch 1.5% + Bot 0.5% on 1h" });
  run(pairs, { exchangeSlPct: 0.01, botSlPct: 0.003, label: "B: Exch 1.0% + Bot 0.3% on 1h" });
  run(pairs, { exchangeSlPct: 0.01, botSlPct: 0.005, label: "B: Exch 1.0% + Bot 0.5% on 1h" });

  // ─── OPTION C: No exchange SL, all exits on 1h ───
  console.log("\n--- OPTION C: No exchange SL, bot SL on 1h only ---\n");
  console.log(hdr); console.log("  " + "-".repeat(100));
  run(pairs, { exchangeSlPct: 0, botSlPct: 0.003, label: "C: Bot SL 0.3% on 1h (no exchange SL)" });
  run(pairs, { exchangeSlPct: 0, botSlPct: 0.005, label: "C: Bot SL 0.5% on 1h" });
  run(pairs, { exchangeSlPct: 0, botSlPct: 0.0075, label: "C: Bot SL 0.75% on 1h" });
  run(pairs, { exchangeSlPct: 0, botSlPct: 0.01, label: "C: Bot SL 1.0% on 1h" });
  run(pairs, { exchangeSlPct: 0, botSlPct: 0.015, label: "C: Bot SL 1.5% on 1h" });
  run(pairs, { exchangeSlPct: 0, botSlPct: 0.02, label: "C: Bot SL 2.0% on 1h" });
}

main();
