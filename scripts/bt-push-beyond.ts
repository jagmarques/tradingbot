/**
 * Push beyond $10.28/day: 8 optimization tracks in one script
 * Base: z2.5/2.0, SL 0.3%, trail 3/1.5->8/0.5->20/0.5, no BE, $5, real leverage
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000; const H4 = 4 * H; const D = 86_400_000;
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
interface PI { h1:C[];h4:C[];z1:number[];z4:number[];m1:Map<number,number>;m4:Map<number,number>; }
function ld(s: string): C[] { const f=path.join(CACHE_5M,`${s}.json`); if(!fs.existsSync(f))return[]; return (JSON.parse(fs.readFileSync(f,"utf8")) as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b).sort((a:C,b:C)=>a.t-b.t); }
function agg(b:C[],p:number,m:number):C[] { const g=new Map<number,C[]>(); for(const c of b){const k=Math.floor(c.t/p)*p;let a=g.get(k);if(!a){a=[];g.set(k,a);}a.push(c);} const r:C[]=[]; for(const[t,grp]of g){if(grp.length<m)continue;grp.sort((a,b)=>a.t-b.t);r.push({t,o:grp[0]!.o,h:Math.max(...grp.map(b=>b.h)),l:Math.min(...grp.map(b=>b.l)),c:grp[grp.length-1]!.c});} return r.sort((a,b)=>a.t-b.t); }

function computeZ(cs:C[], momLb: number, volWin: number):number[] { const z=new Array(cs.length).fill(0); for(let i=Math.max(momLb+1,volWin+1);i<cs.length;i++){const m=cs[i]!.c/cs[i-momLb]!.c-1;let ss=0,c=0;for(let j=Math.max(1,i-volWin);j<=i;j++){const r=cs[j]!.c/cs[j-1]!.c-1;ss+=r*r;c++;}if(c<10)continue;const v=Math.sqrt(ss/c);if(v===0)continue;z[i]=m/v;} return z; }
function g4z(z4:number[],h4:C[],m4:Map<number,number>,t:number):number { const b=Math.floor(t/H4)*H4;let i=m4.get(b);if(i!==undefined&&i>0)return z4[i-1]!;let lo=0,hi=h4.length-1,best=-1;while(lo<=hi){const m2=(lo+hi)>>1;if(h4[m2]!.t<t){best=m2;lo=m2+1;}else hi=m2-1;}return best>=0?z4[best]!:0; }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface PD { name:string; ind:PI; sp:number; lev:number; }

interface SimOpts {
  trail: {a:number;d:number}[];
  slPct: number; slCap?: number;
  zl1: number; zl4: number; zs1: number; zs4: number;
  marginFn: (lev:number)=>number;
  blockHours: number[];
  cdH: number;
  maxHoldH: number;
  momLb?: number; volWin?: number;
  // Per-leverage overrides
  slByLev?: Map<number, number>;
  trailByLev?: Map<number, {a:number;d:number}[]>;
  zByLev?: Map<number, {l1:number;l4:number;s1:number;s4:number}>;
  cdByLev?: Map<number, number>;
  label: string;
}

function run(pairs: PD[], opts: SimOpts): number {
  const momLb = opts.momLb ?? 3;
  const volWin = opts.volWin ?? 20;

  // Recompute z-scores if non-default GARCH params
  const needRecompute = momLb !== 3 || volWin !== 20;
  const pairZ = new Map<string, {z1:number[];z4:number[]}>();
  if (needRecompute) {
    for (const p of pairs) {
      pairZ.set(p.name, { z1: computeZ(p.ind.h1, momLb, volWin), z4: computeZ(p.ind.h4, momLb, volWin) });
    }
  }

  const allT=new Set<number>();
  for(const p of pairs) for(const b of p.ind.h1) if(b.t>=OOS_S&&b.t<OOS_E) allT.add(b.t);
  const hours=[...allT].sort((a,b)=>a-b);

  interface OP { pair:string;dir:"long"|"short";ep:number;et:number;sl:number;pk:number;sp:number;lev:number;not:number;trail:{a:number;d:number}[]; }
  const open:OP[]=[]; const closed:{pnl:number;reason:string}[]=[]; const cd=new Map<string,number>();

  for(const hr of hours) {
    for(let i=open.length-1;i>=0;i--) {
      const pos=open[i]!;const pd=pairs.find(p=>p.name===pos.pair);if(!pd)continue;
      const bi2=pd.ind.m1.get(hr);if(bi2===undefined)continue;const bar=pd.ind.h1[bi2]!;
      let xp=0,reason="",isSL=false;
      if((hr-pos.et)/H>=opts.maxHoldH){xp=bar.c;reason="maxh";}
      if(!xp){if(pos.dir==="long"?bar.l<=pos.sl:bar.h>=pos.sl){xp=pos.sl;reason="sl";isSL=true;}}
      if(!xp){const best=pos.dir==="long"?(bar.h/pos.ep-1)*pos.lev*100:(pos.ep/bar.l-1)*pos.lev*100;if(best>pos.pk)pos.pk=best;const cur=pos.dir==="long"?(bar.c/pos.ep-1)*pos.lev*100:(pos.ep/bar.c-1)*pos.lev*100;let td=Infinity;for(const s of pos.trail)if(pos.pk>=s.a)td=s.d;if(td<Infinity&&cur<=pos.pk-td){xp=bar.c;reason="trail";}}
      if(xp>0){const rsp=isSL?pos.sp*1.5:pos.sp;const ex=pos.dir==="long"?xp*(1-rsp):xp*(1+rsp);const pnl=(pos.dir==="long"?(ex/pos.ep-1):(pos.ep/ex-1))*pos.not-pos.not*FEE*2;closed.push({pnl,reason});open.splice(i,1);
        const pairCd = opts.cdByLev?.get(pos.lev) ?? opts.cdH;
        if(reason==="sl")cd.set(`${pos.pair}:${pos.dir}`,hr+pairCd*H);
      }
    }
    if(opts.blockHours.includes(new Date(hr).getUTCHours()))continue;
    for(const p of pairs){
      const bi2=p.ind.m1.get(hr);if(bi2===undefined||bi2<(volWin>20?volWin:20)+2)continue;
      if(open.some(o=>o.pair===p.name))continue;

      const zData = needRecompute ? pairZ.get(p.name)! : { z1: p.ind.z1, z4: p.ind.z4 };
      const z1=zData.z1[bi2-1]!;const z4=g4z(zData.z4,p.ind.h4,p.ind.m4,hr);

      // Per-leverage z overrides
      const zCfg = opts.zByLev?.get(p.lev);
      const myZL1 = zCfg?.l1 ?? opts.zl1; const myZL4 = zCfg?.l4 ?? opts.zl4;
      const myZS1 = zCfg?.s1 ?? opts.zs1; const myZS4 = zCfg?.s4 ?? opts.zs4;

      let dir:"long"|"short"|null=null;
      if(z1>myZL1&&z4>myZL4)dir="long";if(z1<myZS1&&z4<myZS4)dir="short";if(!dir)continue;
      const ck=`${p.name}:${dir}`;if(cd.has(ck)&&hr<cd.get(ck)!)continue;

      const slPct = opts.slByLev?.get(p.lev) ?? opts.slPct;
      const slCapPct = opts.slCap ?? 0.01;
      const margin=opts.marginFn(p.lev);const not=margin*p.lev;
      const ep=dir==="long"?p.ind.h1[bi2]!.o*(1+p.sp):p.ind.h1[bi2]!.o*(1-p.sp);
      const sld=Math.min(ep*slPct,ep*slCapPct);const sl=dir==="long"?ep-sld:ep+sld;
      const trail = opts.trailByLev?.get(p.lev) ?? opts.trail;
      open.push({pair:p.name,dir,ep,et:hr,sl,pk:0,sp:p.sp,lev:p.lev,not,trail});
    }
  }
  for(const pos of open){const pd=pairs.find(p=>p.name===pos.pair);if(!pd)continue;const lb=pd.ind.h1[pd.ind.h1.length-1]!;const ex=pos.dir==="long"?lb.c*(1-pos.sp):lb.c*(1+pos.sp);const pnl=(pos.dir==="long"?(ex/pos.ep-1):(pos.ep/ex-1))*pos.not-pos.not*FEE*2;closed.push({pnl,reason:"end"});}

  const total=closed.reduce((s,t)=>s+t.pnl,0);
  const wins=closed.filter(t=>t.pnl>0).length;
  const wr=closed.length>0?wins/closed.length*100:0;
  const gp=closed.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gl2=Math.abs(closed.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
  const pf=gl2>0?gp/gl2:Infinity;
  let cum=0,peak=0,maxDD=0;
  for(const t of closed){cum+=t.pnl;if(cum>peak)peak=cum;if(peak-cum>maxDD)maxDD=peak-cum;}
  const pd=total/OOS_D;

  console.log(`  ${opts.label.padEnd(55)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(pd).padStart(9)} $${maxDD.toFixed(0).padStart(3)}`);
  return pd;
}

function main() {
  console.log("=".repeat(100));
  console.log("  PUSH BEYOND $10.28/day - 8 OPTIMIZATION TRACKS");
  console.log("=".repeat(100));
  console.log("\n  Loading...");
  const pairs: PD[] = [];
  for (const n of ALL) {
    const s=RM[n]??n; let r=ld(`${s}USDT`); if(r.length<5000)r=ld(`${n}USDT`); if(r.length<5000)continue;
    const h1=agg(r,H,10);const h4=agg(r,H4,40);if(h1.length<100||h4.length<50)continue;
    const z1=computeZ(h1,3,20);const z4=computeZ(h4,3,20);
    const m1=new Map<number,number>();h1.forEach((c,i)=>m1.set(c.t,i));
    const m4=new Map<number,number>();h4.forEach((c,i)=>m4.set(c.t,i));
    pairs.push({name:n,ind:{h1,h4,z1,z4,m1,m4},sp:SP[n]??DSP,lev:gl(n)});
  }
  console.log(`  ${pairs.length} pairs\n`);

  const hdr = `  ${"Config".padEnd(55)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"$/day".padStart(9)} ${"MDD".padStart(4)}`;
  const T = [{a:3,d:1.5},{a:8,d:0.5},{a:20,d:0.5}];
  const base = { trail:T, slPct:0.003, zl1:2.5,zl4:2.0,zs1:-2.5,zs4:-2.0, marginFn:()=>MARGIN, blockHours:[22,23], cdH:1, maxHoldH:72 };

  // BASELINE
  console.log("--- BASELINE ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  run(pairs, {...base, label:"BASELINE z2.5/2 SL0.3% trail3/1.5 CD1h"});

  // 1. ASYMMETRIC Z-SCORES
  console.log("\n--- 1. ASYMMETRIC Z-SCORES (longs vs shorts) ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  run(pairs, {...base, zl1:2.0,zl4:1.5,zs1:-3.0,zs4:-2.5, label:"Loose longs z2/1.5, tight shorts z3/2.5"});
  run(pairs, {...base, zl1:2.0,zl4:2.0,zs1:-3.0,zs4:-2.5, label:"Loose longs z2/2, tight shorts z3/2.5"});
  run(pairs, {...base, zl1:2.5,zl4:2.0,zs1:-2.0,zs4:-1.5, label:"Base longs z2.5/2, loose shorts z2/1.5"});
  run(pairs, {...base, zl1:2.0,zl4:1.5,zs1:-2.5,zs4:-2.0, label:"Loose longs z2/1.5, base shorts z2.5/2"});
  run(pairs, {...base, zl1:2.0,zl4:2.0,zs1:-2.5,zs4:-2.0, label:"Loose longs z2/2, base shorts"});
  run(pairs, {...base, zl1:2.5,zl4:1.5,zs1:-2.5,zs4:-1.5, label:"Loose 4h z1.5 both"});
  run(pairs, {...base, zl1:2.0,zl4:1.5,zs1:-2.0,zs4:-1.5, label:"Very loose z2/1.5 both"});

  // 2. PER-LEVERAGE Z-SCORES
  console.log("\n--- 2. PER-LEVERAGE Z-SCORES ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  const zTight = {l1:3.0,l4:2.5,s1:-3.0,s4:-2.5};
  const zBase = {l1:2.5,l4:2.0,s1:-2.5,s4:-2.0};
  const zLoose = {l1:2.0,l4:1.5,s1:-2.0,s4:-1.5};
  run(pairs, {...base, zByLev:new Map([[10,zLoose],[5,zBase],[3,zTight]]), label:"10x:loose 5x:base 3x:tight"});
  run(pairs, {...base, zByLev:new Map([[10,zBase],[5,zLoose],[3,zLoose]]), label:"10x:base 5x+3x:loose"});
  run(pairs, {...base, zByLev:new Map([[10,zLoose],[5,zLoose],[3,zBase]]), label:"10x+5x:loose 3x:base"});
  run(pairs, {...base, zByLev:new Map([[10,zTight],[5,zBase],[3,zLoose]]), label:"10x:tight 5x:base 3x:loose"});

  // 3. DIFFERENT SL PER LEVERAGE
  console.log("\n--- 3. PER-LEVERAGE SL ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  run(pairs, {...base, slByLev:new Map([[10,0.002],[5,0.003],[3,0.005]]), label:"10x:SL0.2% 5x:SL0.3% 3x:SL0.5%"});
  run(pairs, {...base, slByLev:new Map([[10,0.003],[5,0.003],[3,0.005]]), label:"10x:SL0.3% 5x:SL0.3% 3x:SL0.5%"});
  run(pairs, {...base, slByLev:new Map([[10,0.002],[5,0.003],[3,0.004]]), label:"10x:SL0.2% 5x:SL0.3% 3x:SL0.4%"});
  run(pairs, {...base, slByLev:new Map([[10,0.003],[5,0.004],[3,0.005]]), label:"10x:SL0.3% 5x:SL0.4% 3x:SL0.5%"});
  run(pairs, {...base, slPct:0.002, label:"SL 0.2% uniform"});
  run(pairs, {...base, slPct:0.0025, label:"SL 0.25% uniform"});

  // 4. PER-LEVERAGE COOLDOWN
  console.log("\n--- 4. PER-LEVERAGE COOLDOWN ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  run(pairs, {...base, cdByLev:new Map([[10,0.5],[5,1],[3,2]]), label:"10x:CD0.5h 5x:CD1h 3x:CD2h"});
  run(pairs, {...base, cdByLev:new Map([[10,0],[5,0.5],[3,1]]), label:"10x:CD0h 5x:CD0.5h 3x:CD1h"});
  run(pairs, {...base, cdH:0.5, label:"CD 0.5h uniform"});
  run(pairs, {...base, cdH:0, label:"CD 0h (no cooldown)"});
  run(pairs, {...base, cdH:2, label:"CD 2h uniform"});

  // 5. HOUR BLOCK
  console.log("\n--- 5. HOUR BLOCK ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  run(pairs, {...base, blockHours:[], label:"No hour block"});
  run(pairs, {...base, blockHours:[22], label:"Block h22 only"});
  run(pairs, {...base, blockHours:[21,22,23], label:"Block h21-23"});
  run(pairs, {...base, blockHours:[22,23], label:"Block h22-23 (baseline)"});

  // 6. MAX HOLD
  console.log("\n--- 6. MAX HOLD ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  for (const mh of [24, 36, 48, 72, 96, 120, 168, 999]) {
    run(pairs, {...base, maxHoldH:mh, label:`Max hold ${mh}h`});
  }

  // 7. PER-LEVERAGE TRAIL
  console.log("\n--- 7. PER-LEVERAGE TRAIL ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  const t3x = [{a:5,d:3},{a:15,d:1},{a:30,d:0.5}];
  const t5x = [{a:3,d:1.5},{a:10,d:0.5},{a:20,d:0.5}];
  const t10x = [{a:3,d:1},{a:8,d:0.5},{a:15,d:0.5}];
  run(pairs, {...base, trailByLev:new Map([[10,t10x],[5,t5x],[3,t3x]]), label:"Tiered trail: 3x wide, 10x tight"});

  const t3x2 = [{a:5,d:2},{a:12,d:1},{a:25,d:0.5}];
  const t10x2 = [{a:2,d:1},{a:5,d:0.5},{a:12,d:0.5}];
  run(pairs, {...base, trailByLev:new Map([[10,t10x2],[5,T],[3,t3x2]]), label:"Tiered trail v2: 3x wider, 10x earlier"});

  // 8. GARCH PARAMETERS
  console.log("\n--- 8. GARCH PARAMETERS (momLb / volWin) ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  run(pairs, {...base, momLb:2, volWin:20, label:"momLb=2 volWin=20"});
  run(pairs, {...base, momLb:5, volWin:20, label:"momLb=5 volWin=20"});
  run(pairs, {...base, momLb:3, volWin:15, label:"momLb=3 volWin=15"});
  run(pairs, {...base, momLb:3, volWin:30, label:"momLb=3 volWin=30"});
  run(pairs, {...base, momLb:2, volWin:15, label:"momLb=2 volWin=15"});

  // ─── MEGA COMBOS: best from each track ───
  console.log("\n--- MEGA COMBOS ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  run(pairs, {...base, label:"BASELINE"});

  // Combine best findings
  run(pairs, {...base, zl1:2.0,zl4:1.5,zs1:-2.5,zs4:-2.0, label:"Loose longs z2/1.5 + base shorts"});
  run(pairs, {...base, zl1:2.0,zl4:1.5,zs1:-2.5,zs4:-2.0, slByLev:new Map([[10,0.002],[5,0.003],[3,0.005]]), label:"+tiered SL"});
  run(pairs, {...base, zl1:2.0,zl4:1.5,zs1:-2.5,zs4:-2.0, slByLev:new Map([[10,0.002],[5,0.003],[3,0.005]]), cdH:0.5, label:"+CD 0.5h"});
  run(pairs, {...base, zl1:2.0,zl4:1.5,zs1:-2.5,zs4:-2.0, slByLev:new Map([[10,0.002],[5,0.003],[3,0.005]]), cdH:0.5, blockHours:[], label:"+no hour block"});
  run(pairs, {...base, zl1:2.0,zl4:1.5,zs1:-2.0,zs4:-1.5, label:"Very loose z2/1.5 both"});
  run(pairs, {...base, zl1:2.0,zl4:1.5,zs1:-2.0,zs4:-1.5, slByLev:new Map([[10,0.002],[5,0.003],[3,0.005]]), cdH:0.5, label:"Very loose + tiered SL + CD0.5"});
  run(pairs, {...base, zl1:2.0,zl4:1.5,zs1:-2.0,zs4:-1.5, slPct:0.002, label:"Very loose + SL0.2% uniform"});

  // Stress test top combos at 1.5x spread
  console.log("\n--- STRESS TEST TOP COMBOS AT 1.5x SPREAD ---\n");
  console.log(hdr); console.log("  "+"-".repeat(80));
  // Manually add spread multiplier by adjusting SP
  const pairsWide = pairs.map(p => ({...p, sp: p.sp * 1.5}));
  run(pairsWide, {...base, label:"BASELINE [1.5x spread]"});
  run(pairsWide, {...base, zl1:2.0,zl4:1.5,zs1:-2.5,zs4:-2.0, slByLev:new Map([[10,0.002],[5,0.003],[3,0.005]]), cdH:0.5, label:"Best combo [1.5x spread]"});
  run(pairsWide, {...base, zl1:2.0,zl4:1.5,zs1:-2.0,zs4:-1.5, slByLev:new Map([[10,0.002],[5,0.003],[3,0.005]]), cdH:0.5, label:"Very loose combo [1.5x spread]"});
}

main();
