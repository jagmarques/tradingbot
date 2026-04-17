/**
 * Maximum profit search: combine every lever we have
 * Tight trail + SL variants + tiered margin + z-score loosening + pair selection
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000; const H4 = 4 * H; const D = 86_400_000;
const MOM_LB = 3; const VOL_WIN = 20; const SL_CAP = 0.01;
const MAX_HOLD_H = 72; const CD_H = 1; const BLOCK_HOURS = [22, 23];
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
interface Tr { pair:string; dir:"long"|"short"; ep:number; xp:number; et:number; xt:number; pnl:number; reason:string; }
interface PI { h1:C[];h4:C[];z1:number[];z4:number[];m1:Map<number,number>;m4:Map<number,number>; }
function ld(s: string): C[] { const f=path.join(CACHE_5M,`${s}.json`); if(!fs.existsSync(f))return[]; return (JSON.parse(fs.readFileSync(f,"utf8")) as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b).sort((a:C,b:C)=>a.t-b.t); }
function agg(b:C[],p:number,m:number):C[] { const g=new Map<number,C[]>(); for(const c of b){const k=Math.floor(c.t/p)*p;let a=g.get(k);if(!a){a=[];g.set(k,a);}a.push(c);} const r:C[]=[]; for(const[t,grp]of g){if(grp.length<m)continue;grp.sort((a,b)=>a.t-b.t);r.push({t,o:grp[0]!.o,h:Math.max(...grp.map(b=>b.h)),l:Math.min(...grp.map(b=>b.l)),c:grp[grp.length-1]!.c});} return r.sort((a,b)=>a.t-b.t); }
function cz(cs:C[]):number[] { const z=new Array(cs.length).fill(0); for(let i=Math.max(MOM_LB+1,VOL_WIN+1);i<cs.length;i++){const m=cs[i]!.c/cs[i-MOM_LB]!.c-1;let ss=0,c=0;for(let j=Math.max(1,i-VOL_WIN);j<=i;j++){const r=cs[j]!.c/cs[j-1]!.c-1;ss+=r*r;c++;}if(c<10)continue;const v=Math.sqrt(ss/c);if(v===0)continue;z[i]=m/v;} return z; }
function bi(b:C[]):PI { const h1=agg(b,H,10);const h4=agg(b,H4,40);const z1=cz(h1);const z4=cz(h4);const m1=new Map<number,number>();h1.forEach((c,i)=>m1.set(c.t,i));const m4=new Map<number,number>();h4.forEach((c,i)=>m4.set(c.t,i));return{h1,h4,z1,z4,m1,m4}; }
function g4z(ind:PI,t:number):number { const b=Math.floor(t/H4)*H4;let i=ind.m4.get(b);if(i!==undefined&&i>0)return ind.z4[i-1]!;let lo=0,hi=ind.h4.length-1,best=-1;while(lo<=hi){const m2=(lo+hi)>>1;if(ind.h4[m2]!.t<t){best=m2;lo=m2+1;}else hi=m2-1;}return best>=0?ind.z4[best]!:0; }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface PD { name:string; ind:PI; sp:number; lev:number; }

function run(pairs: PD[], trail: {a:number;d:number}[], beAt: number, slPct: number, marginFn: (lev:number)=>number,
  zl1: number, zl4: number, zs1: number, zs4: number, feePct: number, spreadMult: number, label: string) {
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
      if(!xp&&beAt>0&&pos.pk>=beAt){if(pos.dir==="long"?bar.l<=pos.ep:bar.h>=pos.ep){xp=pos.ep;reason="be";}}
      if(!xp){if(pos.dir==="long"?bar.l<=pos.sl:bar.h>=pos.sl){xp=pos.sl;reason="sl";isSL=true;}}
      if(!xp){const best=pos.dir==="long"?(bar.h/pos.ep-1)*pos.lev*100:(pos.ep/bar.l-1)*pos.lev*100;if(best>pos.pk)pos.pk=best;const cur=pos.dir==="long"?(bar.c/pos.ep-1)*pos.lev*100:(pos.ep/bar.c-1)*pos.lev*100;let td=Infinity;for(const s of trail)if(pos.pk>=s.a)td=s.d;if(td<Infinity&&cur<=pos.pk-td){xp=bar.c;reason="trail";}}
      if(xp>0){const rsp=pos.sp*spreadMult;const sl2=isSL?rsp*1.5:rsp;const ex=pos.dir==="long"?xp*(1-sl2):xp*(1+sl2);const pnl=(pos.dir==="long"?(ex/pos.ep-1):(pos.ep/ex-1))*pos.not-pos.not*feePct*2;closed.push({pair:pos.pair,dir:pos.dir,ep:pos.ep,xp,et:pos.et,xt:hr,pnl,reason});open.splice(i,1);if(reason==="sl")cd.set(`${pos.pair}:${pos.dir}`,hr+CD_H*H);}
    }
    if(BLOCK_HOURS.includes(new Date(hr).getUTCHours()))continue;
    for(const p of pairs){
      const bi2=p.ind.m1.get(hr);if(bi2===undefined||bi2<VOL_WIN+2)continue;
      if(open.some(o=>o.pair===p.name))continue;
      const z1=p.ind.z1[bi2-1]!;const z4=g4z(p.ind,hr);
      let dir:"long"|"short"|null=null;
      if(z1>zl1&&z4>zl4)dir="long";if(z1<zs1&&z4<zs4)dir="short";if(!dir)continue;
      const ck=`${p.name}:${dir}`;if(cd.has(ck)&&hr<cd.get(ck)!)continue;
      const margin=marginFn(p.lev);const not=margin*p.lev;
      const rsp=p.sp*spreadMult;
      const ep=dir==="long"?p.ind.h1[bi2]!.o*(1+rsp):p.ind.h1[bi2]!.o*(1-rsp);
      const sld=Math.min(ep*slPct,ep*SL_CAP);const sl=dir==="long"?ep-sld:ep+sld;
      open.push({pair:p.name,dir,ep,et:hr,sl,pk:0,sp:p.sp,lev:p.lev,not});
    }
  }
  for(const pos of open){const pd=pairs.find(p=>p.name===pos.pair);if(!pd)continue;const lb=pd.ind.h1[pd.ind.h1.length-1]!;const rsp=pos.sp*spreadMult;const ex=pos.dir==="long"?lb.c*(1-rsp):lb.c*(1+rsp);const pnl=(pos.dir==="long"?(ex/pos.ep-1):(pos.ep/ex-1))*pos.not-pos.not*feePct*2;closed.push({pair:pos.pair,dir:pos.dir,ep:pos.ep,xp:lb.c,et:pos.et,xt:lb.t,pnl,reason:"end"});}

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

  console.log(`  ${label.padEnd(55)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(pd).padStart(8)} $${maxDD.toFixed(0).padStart(3)} ${fmtPnl(total).padStart(10)}`);
  return { pd, maxDD, pf };
}

function main() {
  console.log("=".repeat(110));
  console.log("  MAXIMUM PROFIT SEARCH - every lever combined");
  console.log("=".repeat(110));
  console.log("\n  Loading...");
  const all: PD[] = [];
  for (const n of ALL) {
    const s=RM[n]??n; let r=ld(`${s}USDT`); if(r.length<5000)r=ld(`${n}USDT`); if(r.length<5000)continue;
    const ind=bi(r); if(ind.h1.length<100||ind.h4.length<50)continue;
    all.push({name:n,ind,sp:SP[n]??DSP,lev:gl(n)});
  }
  const p5x = all.filter(p => p.lev >= 5);
  console.log(`  ${all.length} pairs (${all.filter(p=>p.lev>=10).length}@10x, ${all.filter(p=>p.lev===5).length}@5x, ${all.filter(p=>p.lev===3).length}@3x)\n`);

  const hdr = `  ${"Config".padEnd(55)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"$/day".padStart(8)} ${"MDD".padStart(4)} ${"Total".padStart(10)}`;
  const T = [{a:3,d:1.5},{a:5,d:1},{a:10,d:0.5},{a:20,d:0.5}];
  const fee = 0.00035;

  // ─── Ultra tight SL ───
  console.log("--- ULTRA TIGHT SL + TIGHT TRAIL (normal spread) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));
  for (const sl of [0.002, 0.0025, 0.003, 0.0035, 0.004, 0.005]) {
    run(all, T, 0, sl, ()=>5, 3.0, 2.5, -3.0, -2.5, fee, 1.0, `SL ${(sl*100).toFixed(2)}% $5 z3.0/2.5`);
  }

  // ─── Tiered margin + tight trail + SL sweep ───
  console.log("\n--- TIERED MARGIN + TIGHT TRAIL + SL SWEEP ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));
  for (const sl of [0.003, 0.0035, 0.004]) {
    run(all, T, 0, sl, (lev)=>lev>=10?9:lev>=5?7:3, 3.0, 2.5, -3.0, -2.5, fee, 1.0, `SL${(sl*100).toFixed(1)}% tier $3/7/9`);
    run(all, T, 0, sl, (lev)=>lev>=10?10:lev>=5?7:5, 3.0, 2.5, -3.0, -2.5, fee, 1.0, `SL${(sl*100).toFixed(1)}% tier $5/7/10`);
    run(all, T, 0, sl, (lev)=>lev>=10?12:lev>=5?7:3, 3.0, 2.5, -3.0, -2.5, fee, 1.0, `SL${(sl*100).toFixed(1)}% tier $3/7/12`);
  }

  // ─── Looser z-scores + tight trail + tight SL ───
  console.log("\n--- LOOSER Z-SCORES + TIGHT TRAIL + TIGHT SL ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));
  run(all, T, 0, 0.003, ()=>5, 3.0, 2.5, -3.0, -2.5, fee, 1.0, "BASELINE: z3.0/2.5 SL0.3% $5");
  run(all, T, 0, 0.003, ()=>5, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "z2.5/2.0 SL0.3% $5");
  run(all, T, 0, 0.003, ()=>5, 2.5, 2.5, -2.5, -2.5, fee, 1.0, "z2.5/2.5 SL0.3% $5");
  run(all, T, 0, 0.003, ()=>5, 3.0, 2.0, -3.0, -2.0, fee, 1.0, "z3.0/2.0 SL0.3% $5");
  run(all, T, 0, 0.0035, ()=>5, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "z2.5/2.0 SL0.35% $5");
  run(all, T, 0, 0.0035, ()=>5, 2.5, 2.5, -2.5, -2.5, fee, 1.0, "z2.5/2.5 SL0.35% $5");
  run(all, T, 0, 0.004, ()=>5, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "z2.5/2.0 SL0.4% $5");

  // ─── MEGA COMBOS: tier + loose z + tight SL ───
  console.log("\n--- MEGA COMBOS (tier margin + loose z + tight SL + tight trail) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));
  run(all, T, 0, 0.003, (lev)=>lev>=10?9:lev>=5?7:3, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "z2.5/2 SL0.3% tier $3/7/9");
  run(all, T, 0, 0.003, (lev)=>lev>=10?12:lev>=5?7:3, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "z2.5/2 SL0.3% tier $3/7/12");
  run(all, T, 0, 0.003, (lev)=>lev>=10?9:lev>=5?7:3, 2.5, 2.5, -2.5, -2.5, fee, 1.0, "z2.5/2.5 SL0.3% tier $3/7/9");
  run(all, T, 0, 0.003, (lev)=>lev>=10?12:lev>=5?7:3, 2.5, 2.5, -2.5, -2.5, fee, 1.0, "z2.5/2.5 SL0.3% tier $3/7/12");
  run(all, T, 0, 0.0035, (lev)=>lev>=10?9:lev>=5?7:3, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "z2.5/2 SL0.35% tier $3/7/9");
  run(all, T, 0, 0.0035, (lev)=>lev>=10?12:lev>=5?7:3, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "z2.5/2 SL0.35% tier $3/7/12");
  run(all, T, 0, 0.0035, (lev)=>lev>=10?9:lev>=5?7:5, 2.5, 2.5, -2.5, -2.5, fee, 1.0, "z2.5/2.5 SL0.35% tier $5/7/9");
  run(all, T, 0, 0.004, (lev)=>lev>=10?9:lev>=5?7:3, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "z2.5/2 SL0.4% tier $3/7/9");

  // ─── 5x+ only combos (drop weak 3x pairs) ───
  console.log("\n--- 5x+ PAIRS ONLY (drop all 3x) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));
  run(p5x, T, 0, 0.003, ()=>7, 3.0, 2.5, -3.0, -2.5, fee, 1.0, "5x+ SL0.3% $7 z3.0/2.5");
  run(p5x, T, 0, 0.003, ()=>7, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "5x+ SL0.3% $7 z2.5/2.0");
  run(p5x, T, 0, 0.003, (lev)=>lev>=10?10:7, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "5x+ SL0.3% $7/10 z2.5/2.0");
  run(p5x, T, 0, 0.0035, (lev)=>lev>=10?10:7, 2.5, 2.0, -2.5, -2.0, fee, 1.0, "5x+ SL0.35% $7/10 z2.5/2.0");

  // ─── STRESS TEST TOP 5 at 1.5x spread ───
  console.log("\n--- TOP CONFIGS AT 1.5x SPREAD (live realistic) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(95));
  run(all, T, 0, 0.003, ()=>5, 3.0, 2.5, -3.0, -2.5, fee, 1.5, "SL0.3% $5 z3.0/2.5 [1.5xSpr]");
  run(all, T, 0, 0.003, (lev)=>lev>=10?9:lev>=5?7:3, 2.5, 2.0, -2.5, -2.0, fee, 1.5, "z2.5/2 SL0.3% tier $3/7/9 [1.5xSpr]");
  run(all, T, 0, 0.003, (lev)=>lev>=10?12:lev>=5?7:3, 2.5, 2.0, -2.5, -2.0, fee, 1.5, "z2.5/2 SL0.3% tier $3/7/12 [1.5xSpr]");
  run(all, T, 0, 0.0035, (lev)=>lev>=10?9:lev>=5?7:3, 2.5, 2.0, -2.5, -2.0, fee, 1.5, "z2.5/2 SL0.35% tier $3/7/9 [1.5xSpr]");
  run(all, T, 0, 0.0035, (lev)=>lev>=10?12:lev>=5?7:3, 2.5, 2.0, -2.5, -2.0, fee, 1.5, "z2.5/2 SL0.35% tier $3/7/12 [1.5xSpr]");
  run(p5x, T, 0, 0.003, (lev)=>lev>=10?10:7, 2.5, 2.0, -2.5, -2.0, fee, 1.5, "5x+ SL0.3% $7/10 z2.5/2.0 [1.5xSpr]");
  run(all, T, 0, 0.0035, ()=>5, 3.0, 2.5, -3.0, -2.5, fee, 1.5, "SL0.35% $5 z3.0/2.5 [1.5xSpr]");
}

main();
