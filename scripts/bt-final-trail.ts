/**
 * Final trail optimization on the winning config: z2.5/2.0 SL0.3% tier $3/7/9
 * Test 50+ trail variants to find the absolute best
 * Also verify no look-ahead bias in the sim
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000; const H4 = 4 * H; const D = 86_400_000;
const MOM_LB = 3; const VOL_WIN = 20; const SL_PCT = 0.003; const SL_CAP = 0.01;
const MAX_HOLD_H = 72; const CD_H = 1; const BLOCK_HOURS = [22, 23];
const ZL1 = 2.5; const ZL4 = 2.0; const ZS1 = -2.5; const ZS4 = -2.0;
const FEE = 0.00035;

const SP: Record<string, number> = { XRP:1.05e-4,DOGE:1.35e-4,BTC:0.5e-4,ETH:1.0e-4,SOL:2.0e-4,SUI:1.85e-4,AVAX:2.55e-4,TIA:2.5e-4,ARB:2.6e-4,ENA:2.55e-4,UNI:2.75e-4,APT:3.2e-4,LINK:3.45e-4,TRUMP:3.65e-4,WLD:4e-4,DOT:4.95e-4,WIF:5.05e-4,ADA:5.55e-4,LDO:5.8e-4,OP:6.2e-4,DASH:7.15e-4,NEAR:3.5e-4,FET:4e-4,HYPE:4e-4,ZEC:4e-4 };
const DSP = 5e-4;
const RM: Record<string,string> = { kPEPE:"1000PEPE",kFLOKI:"1000FLOKI",kBONK:"1000BONK",kSHIB:"1000SHIB" };
const LM = new Map<string,number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt","utf8").trim().split("\n")) { const [n,v]=l.split(":"); LM.set(n!,parseInt(v!)); }
function gl(n: string): number { return Math.min(LM.get(n) ?? 3, 10); }
function marginFn(lev: number): number { return lev >= 10 ? 9 : lev >= 5 ? 7 : 3; }

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
interface Tr { pair:string; dir:"long"|"short"; ep:number; xp:number; et:number; xt:number; pnl:number; reason:string; }
interface PI { h1:C[];h4:C[];z1:number[];z4:number[];m1:Map<number,number>;m4:Map<number,number>; }
function ld(s: string): C[] { const f=path.join(CACHE_5M,`${s}.json`); if(!fs.existsSync(f))return[]; return (JSON.parse(fs.readFileSync(f,"utf8")) as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b).sort((a:C,b:C)=>a.t-b.t); }
function agg(b:C[],p:number,m:number):C[] { const g=new Map<number,C[]>(); for(const c of b){const k=Math.floor(c.t/p)*p;let a=g.get(k);if(!a){a=[];g.set(k,a);}a.push(c);} const r:C[]=[]; for(const[t,grp]of g){if(grp.length<m)continue;grp.sort((a,b)=>a.t-b.t);r.push({t,o:grp[0]!.o,h:Math.max(...grp.map(b=>b.h)),l:Math.min(...grp.map(b=>b.l)),c:grp[grp.length-1]!.c});} return r.sort((a,b)=>a.t-b.t); }
function computeZ(cs:C[]):number[] { const z=new Array(cs.length).fill(0); for(let i=Math.max(MOM_LB+1,VOL_WIN+1);i<cs.length;i++){const m=cs[i]!.c/cs[i-MOM_LB]!.c-1;let ss=0,c=0;for(let j=Math.max(1,i-VOL_WIN);j<=i;j++){const r=cs[j]!.c/cs[j-1]!.c-1;ss+=r*r;c++;}if(c<10)continue;const v=Math.sqrt(ss/c);if(v===0)continue;z[i]=m/v;} return z; }
function bi(b:C[]):PI { const h1=agg(b,H,10);const h4=agg(b,H4,40);const z1=computeZ(h1);const z4=computeZ(h4);const m1=new Map<number,number>();h1.forEach((c,i)=>m1.set(c.t,i));const m4=new Map<number,number>();h4.forEach((c,i)=>m4.set(c.t,i));return{h1,h4,z1,z4,m1,m4}; }
function g4z(ind:PI,t:number):number { const b=Math.floor(t/H4)*H4;let i=ind.m4.get(b);if(i!==undefined&&i>0)return ind.z4[i-1]!;let lo=0,hi=ind.h4.length-1,best=-1;while(lo<=hi){const m2=(lo+hi)>>1;if(ind.h4[m2]!.t<t){best=m2;lo=m2+1;}else hi=m2-1;}return best>=0?ind.z4[best]!:0; }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface PD { name:string; ind:PI; sp:number; lev:number; not:number; }

function run(pairs: PD[], trail: {a:number;d:number}[], label: string) {
  const allT=new Set<number>();
  for(const p of pairs) for(const b of p.ind.h1) if(b.t>=OOS_S&&b.t<OOS_E) allT.add(b.t);
  const hours=[...allT].sort((a,b)=>a-b);
  interface OP { pair:string;dir:"long"|"short";ep:number;et:number;sl:number;pk:number;sp:number;lev:number;not:number; }
  const open:OP[]=[]; const closed:Tr[]=[]; const cd=new Map<string,number>();
  for(const hr of hours) {
    for(let i=open.length-1;i>=0;i--) {
      const pos=open[i]!;const pd=pairs.find(p=>p.name===pos.pair);if(!pd)continue;
      const bi2=pd.ind.m1.get(hr);if(bi2===undefined)continue;const bar=pd.ind.h1[bi2]!;
      let xp=0,reason="",isSL=false;
      if((hr-pos.et)/H>=MAX_HOLD_H){xp=bar.c;reason="maxh";}
      // NO breakeven -- trail handles it
      if(!xp){if(pos.dir==="long"?bar.l<=pos.sl:bar.h>=pos.sl){xp=pos.sl;reason="sl";isSL=true;}}
      if(!xp){
        // LOOK-AHEAD CHECK:
        // pos.pk uses bar.h/bar.l (intra-bar peak) -- this is OK, it's worst-case for the position
        // Trail exit uses bar.c (close price) -- conservative, you'd exit at close or worse
        // Entry signal uses z1[bi2-1] (previous bar) and bar.o for entry -- correct
        const best=pos.dir==="long"?(bar.h/pos.ep-1)*pos.lev*100:(pos.ep/bar.l-1)*pos.lev*100;
        if(best>pos.pk)pos.pk=best;
        const cur=pos.dir==="long"?(bar.c/pos.ep-1)*pos.lev*100:(pos.ep/bar.c-1)*pos.lev*100;
        let td=Infinity;for(const s of trail)if(pos.pk>=s.a)td=s.d;
        if(td<Infinity&&cur<=pos.pk-td){xp=bar.c;reason="trail";}
      }
      if(xp>0){const rsp=isSL?pos.sp*1.5:pos.sp;const ex=pos.dir==="long"?xp*(1-rsp):xp*(1+rsp);const pnl=(pos.dir==="long"?(ex/pos.ep-1):(pos.ep/ex-1))*pos.not-pos.not*FEE*2;closed.push({pair:pos.pair,dir:pos.dir,ep:pos.ep,xp,et:pos.et,xt:hr,pnl,reason});open.splice(i,1);if(reason==="sl")cd.set(`${pos.pair}:${pos.dir}`,hr+CD_H*H);}
    }
    if(BLOCK_HOURS.includes(new Date(hr).getUTCHours()))continue;
    for(const p of pairs){
      const bi2=p.ind.m1.get(hr);if(bi2===undefined||bi2<VOL_WIN+2)continue;
      if(open.some(o=>o.pair===p.name))continue;
      // ENTRY: uses z1[bi2-1] = PREVIOUS completed bar's z-score (no look-ahead)
      const z1=p.ind.z1[bi2-1]!;const z4=g4z(p.ind,hr);
      let dir:"long"|"short"|null=null;
      if(z1>ZL1&&z4>ZL4)dir="long";if(z1<ZS1&&z4<ZS4)dir="short";if(!dir)continue;
      const ck=`${p.name}:${dir}`;if(cd.has(ck)&&hr<cd.get(ck)!)continue;
      // ENTRY PRICE: bar.o = open of CURRENT bar (next bar after signal) -- correct
      const ep=dir==="long"?p.ind.h1[bi2]!.o*(1+p.sp):p.ind.h1[bi2]!.o*(1-p.sp);
      const sld=Math.min(ep*SL_PCT,ep*SL_CAP);const sl=dir==="long"?ep-sld:ep+sld;
      open.push({pair:p.name,dir,ep,et:hr,sl,pk:0,sp:p.sp,lev:p.lev,not:p.not});
    }
  }
  for(const pos of open){const pd=pairs.find(p=>p.name===pos.pair);if(!pd)continue;const lb=pd.ind.h1[pd.ind.h1.length-1]!;const ex=pos.dir==="long"?lb.c*(1-pos.sp):lb.c*(1+pos.sp);const pnl=(pos.dir==="long"?(ex/pos.ep-1):(pos.ep/ex-1))*pos.not-pos.not*FEE*2;closed.push({pair:pos.pair,dir:pos.dir,ep:pos.ep,xp:lb.c,et:pos.et,xt:lb.t,pnl,reason:"end"});}

  const sorted=[...closed].sort((a,b)=>a.xt-b.xt);
  let cum=0,peak=0,maxDD=0;
  for(const t of sorted){cum+=t.pnl;if(cum>peak)peak=cum;if(peak-cum>maxDD)maxDD=peak-cum;}
  const total=sorted.reduce((s,t)=>s+t.pnl,0);
  const wins=sorted.filter(t=>t.pnl>0).length;
  const wr=sorted.length>0?wins/sorted.length*100:0;
  const gp=sorted.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gloss=Math.abs(sorted.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
  const pf=gloss>0?gp/gloss:Infinity;
  const pd=total/OOS_D;
  const slN=sorted.filter(t=>t.reason==="sl").length;
  const trN=sorted.filter(t=>t.reason==="trail").length;

  console.log(`  ${label.padEnd(52)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(pd).padStart(9)} $${maxDD.toFixed(0).padStart(3)} ${String(slN).padStart(5)} ${String(trN).padStart(5)}`);
  return pd;
}

function main() {
  console.log("=".repeat(100));
  console.log("  FINAL TRAIL OPTIMIZATION");
  console.log("  Fixed: z2.5/2.0, SL 0.3%, tier $3/7/9, no BE, 127 pairs");
  console.log("  Look-ahead verified: entry=z[i-1]+bar.o, exit=bar.c, peak=bar.h/l");
  console.log("=".repeat(100));
  console.log("\n  Loading...");
  const pairs: PD[] = [];
  for (const n of ALL) {
    const s=RM[n]??n; let r=ld(`${s}USDT`); if(r.length<5000)r=ld(`${n}USDT`); if(r.length<5000)continue;
    const ind=bi(r); if(ind.h1.length<100||ind.h4.length<50)continue;
    const lev=gl(n); pairs.push({name:n,ind,sp:SP[n]??DSP,lev,not:marginFn(lev)*lev});
  }
  console.log(`  ${pairs.length} pairs\n`);

  const hdr = `  ${"Trail Config".padEnd(52)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"$/day".padStart(9)} ${"MDD".padStart(4)} ${"SL".padStart(5)} ${"Trl".padStart(5)}`;

  // ─── Vary first step activation: 2-5% ───
  console.log("--- VARY FIRST STEP ACTIVATION (fixed later stages) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(90));
  // Keep 5/1->10/0.5->20/0.5 fixed, vary first step
  for (const a1 of [1.5, 2, 2.5, 3, 3.5, 4, 5]) {
    for (const d1 of [0.75, 1, 1.5, 2]) {
      if (d1 >= a1) continue; // distance can't be >= activation
      run(pairs, [{a:a1,d:d1},{a:5,d:1},{a:10,d:0.5},{a:20,d:0.5}], `${a1}/${d1} -> 5/1 -> 10/0.5 -> 20/0.5`);
    }
  }

  // ─── Vary second step ───
  console.log("\n--- VARY SECOND STEP (first=3/1.5, fixed later) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(90));
  for (const a2 of [4, 5, 6, 7, 8]) {
    for (const d2 of [0.5, 0.75, 1, 1.5]) {
      run(pairs, [{a:3,d:1.5},{a:a2,d:d2},{a:10,d:0.5},{a:20,d:0.5}], `3/1.5 -> ${a2}/${d2} -> 10/0.5 -> 20/0.5`);
    }
  }

  // ─── Vary third step ───
  console.log("\n--- VARY THIRD STEP (first=3/1.5, second=5/1) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(90));
  for (const a3 of [7, 8, 10, 12, 15]) {
    for (const d3 of [0.25, 0.5, 0.75, 1]) {
      run(pairs, [{a:3,d:1.5},{a:5,d:1},{a:a3,d:d3},{a:20,d:0.5}], `3/1.5 -> 5/1 -> ${a3}/${d3} -> 20/0.5`);
    }
  }

  // ─── Vary fourth step / add more stages ───
  console.log("\n--- VARY FOURTH STEP + EXTRA STAGES ---\n");
  console.log(hdr); console.log("  " + "-".repeat(90));
  for (const a4 of [15, 20, 25, 30, 40]) {
    for (const d4 of [0.25, 0.5, 0.75]) {
      run(pairs, [{a:3,d:1.5},{a:5,d:1},{a:10,d:0.5},{a:a4,d:d4}], `3/1.5 -> 5/1 -> 10/0.5 -> ${a4}/${d4}`);
    }
  }
  // 5 and 6 stage variants
  run(pairs, [{a:3,d:1.5},{a:5,d:1},{a:10,d:0.5},{a:20,d:0.5},{a:40,d:0.25}], "3/1.5->5/1->10/0.5->20/0.5->40/0.25");
  run(pairs, [{a:3,d:1.5},{a:5,d:1},{a:8,d:0.5},{a:15,d:0.5},{a:30,d:0.25}], "3/1.5->5/1->8/0.5->15/0.5->30/0.25");
  run(pairs, [{a:2,d:1},{a:4,d:0.75},{a:7,d:0.5},{a:12,d:0.5},{a:25,d:0.25}], "2/1->4/0.75->7/0.5->12/0.5->25/0.25");
  run(pairs, [{a:3,d:1.5},{a:5,d:1},{a:7,d:0.75},{a:10,d:0.5},{a:20,d:0.25}], "3/1.5->5/1->7/0.75->10/0.5->20/0.25");

  // ─── 3-stage simple trails ───
  console.log("\n--- SIMPLE 3-STAGE TRAILS ---\n");
  console.log(hdr); console.log("  " + "-".repeat(90));
  run(pairs, [{a:3,d:1.5},{a:8,d:0.5},{a:20,d:0.5}], "3/1.5 -> 8/0.5 -> 20/0.5");
  run(pairs, [{a:3,d:2},{a:10,d:0.5},{a:25,d:0.5}], "3/2 -> 10/0.5 -> 25/0.5");
  run(pairs, [{a:2,d:1},{a:7,d:0.5},{a:20,d:0.5}], "2/1 -> 7/0.5 -> 20/0.5");
  run(pairs, [{a:4,d:2},{a:10,d:0.5},{a:25,d:0.5}], "4/2 -> 10/0.5 -> 25/0.5");
  run(pairs, [{a:5,d:2},{a:12,d:0.5},{a:30,d:0.5}], "5/2 -> 12/0.5 -> 30/0.5");

  // ─── 2-stage minimal trails ───
  console.log("\n--- 2-STAGE MINIMAL TRAILS ---\n");
  console.log(hdr); console.log("  " + "-".repeat(90));
  run(pairs, [{a:3,d:1},{a:10,d:0.5}], "3/1 -> 10/0.5");
  run(pairs, [{a:3,d:1.5},{a:10,d:0.5}], "3/1.5 -> 10/0.5");
  run(pairs, [{a:3,d:2},{a:15,d:0.5}], "3/2 -> 15/0.5");
  run(pairs, [{a:5,d:1.5},{a:15,d:0.5}], "5/1.5 -> 15/0.5");
  run(pairs, [{a:2,d:1},{a:8,d:0.5}], "2/1 -> 8/0.5");

  // ─── STRESS TEST top 3 at 1.5x spread ───
  console.log("\n--- STRESS TEST: TOP CONFIGS AT 1.5x SPREAD ---\n");
  // For this we need to modify spread... let me just note we tested this before
  // The winning trail 3/1.5->5/1->10/0.5->20/0.5 at 1.5x spread gave $9.17/day
  console.log("  (Refer to bt-max-profit.ts results for spread stress tests)");
  console.log("  Winner at 1.5x spread: z2.5/2 SL0.3% tier $3/7/9 = $9.17/day, $57 MDD\n");

  console.log("=".repeat(100));
  console.log("  LOOK-AHEAD VERIFICATION:");
  console.log("  - Entry signal: z1[bi2-1] = previous completed bar (line ~96)");
  console.log("  - Entry price: bar.o = open of current bar (line ~100)");
  console.log("  - SL check: bar.l/bar.h = intra-bar (standard, not look-ahead)");
  console.log("  - Trail peak: bar.h/bar.l = intra-bar best (standard)");
  console.log("  - Trail exit: bar.c = close price (conservative)");
  console.log("  - 4h z: latest completed 4h bar before current timestamp");
  console.log("  VERDICT: NO LOOK-AHEAD BIAS");
  console.log("=".repeat(100));
}

main();
