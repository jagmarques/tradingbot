/**
 * Trail step sweep with REAL per-pair leverage, $5 margin
 * Tests adding earlier trail steps (5/2, 5/3, 3/2, etc.)
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000; const H4 = 4 * H; const D = 86_400_000;
const FEE = 0.000_35; const MARGIN = 5;
const MOM_LB = 3; const VOL_WIN = 20; const SL_PCT = 0.005; const SL_CAP = 0.01;
const MAX_HOLD_H = 72; const CD_H = 1; const BLOCK_HOURS = [22, 23];
const ZL1 = 3.0; const ZL4 = 2.5; const ZS1 = -3.0; const ZS4 = -2.5;

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

interface PD { name:string; ind:PI; sp:number; lev:number; not:number; }

function runSim(pairs: PD[], trail: {a:number;d:number}[], beAt: number, label: string) {
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
      if(!xp){
        const best=pos.dir==="long"?(bar.h/pos.ep-1)*pos.lev*100:(pos.ep/bar.l-1)*pos.lev*100;
        if(best>pos.pk)pos.pk=best;
        const cur=pos.dir==="long"?(bar.c/pos.ep-1)*pos.lev*100:(pos.ep/bar.c-1)*pos.lev*100;
        let td=Infinity;for(const s of trail)if(pos.pk>=s.a)td=s.d;
        if(td<Infinity&&cur<=pos.pk-td){xp=bar.c;reason="trail";}
      }
      if(xp>0){const sl2=isSL?pos.sp*1.5:pos.sp;const ex=pos.dir==="long"?xp*(1-sl2):xp*(1+sl2);const pnl=(pos.dir==="long"?(ex/pos.ep-1):(pos.ep/ex-1))*pos.not-pos.not*FEE*2;closed.push({pair:pos.pair,dir:pos.dir,ep:pos.ep,xp,et:pos.et,xt:hr,pnl,reason});open.splice(i,1);if(reason==="sl")cd.set(`${pos.pair}:${pos.dir}`,hr+CD_H*H);}
    }
    if(BLOCK_HOURS.includes(new Date(hr).getUTCHours()))continue;
    for(const p of pairs){
      const bi2=p.ind.m1.get(hr);if(bi2===undefined||bi2<VOL_WIN+2)continue;
      if(open.some(o=>o.pair===p.name))continue;
      const z1=p.ind.z1[bi2-1]!;const z4=g4z(p.ind,hr);
      let dir:"long"|"short"|null=null;
      if(z1>ZL1&&z4>ZL4)dir="long";if(z1<ZS1&&z4<ZS4)dir="short";if(!dir)continue;
      const ck=`${p.name}:${dir}`;if(cd.has(ck)&&hr<cd.get(ck)!)continue;
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
  const pd=total/OOS_D; const tpd=sorted.length/OOS_D;

  // Exit breakdown
  const slN=sorted.filter(t=>t.reason==="sl").length;
  const beN=sorted.filter(t=>t.reason==="be").length;
  const trN=sorted.filter(t=>t.reason==="trail").length;
  const mhN=sorted.filter(t=>t.reason==="maxh").length;

  console.log(
    `  ${label.padEnd(45)} ${String(sorted.length).padStart(5)} ${tpd.toFixed(1).padStart(5)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(pd).padStart(8)} $${maxDD.toFixed(0).padStart(4)} ${String(slN).padStart(5)} ${String(beN).padStart(5)} ${String(trN).padStart(6)} ${String(mhN).padStart(5)}`
  );
}

function main() {
  console.log("=".repeat(105));
  console.log("  TRAIL STEP SWEEP - 127 pairs, $5 margin, real leverage");
  console.log("=".repeat(105));

  console.log("\n  Loading...");
  const pairs: PD[] = [];
  for (const n of ALL) {
    const s=RM[n]??n; let r=ld(`${s}USDT`); if(r.length<5000)r=ld(`${n}USDT`); if(r.length<5000)continue;
    const ind=bi(r); if(ind.h1.length<100||ind.h4.length<50)continue;
    const lev=gl(n); pairs.push({name:n,ind,sp:SP[n]??DSP,lev,not:MARGIN*lev});
  }
  console.log(`  ${pairs.length} pairs loaded\n`);

  const hdr = `  ${"Config".padEnd(45)} ${"Trd".padStart(5)} ${"T/d".padStart(5)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"$/day".padStart(8)} ${"MDD".padStart(5)} ${"SL".padStart(5)} ${"BE".padStart(5)} ${"Trail".padStart(6)} ${"MaxH".padStart(5)}`;

  // Current deployed trail
  const T_CURRENT = [{a:10,d:5},{a:15,d:4},{a:20,d:3},{a:25,d:2},{a:35,d:1.5},{a:50,d:1}];

  // ─── SECTION 1: Add early trail steps ───
  console.log("--- ADD EARLY TRAIL STEP (before 10%) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(100));

  runSim(pairs, T_CURRENT, 2, "BASELINE: 10/5->15/4->20/3->25/2->35/1.5->50/1 BE2%");

  // Add step at 3%
  runSim(pairs, [{a:3,d:2},...T_CURRENT], 2, "+3/2 step");
  runSim(pairs, [{a:3,d:1.5},...T_CURRENT], 2, "+3/1.5 step");
  runSim(pairs, [{a:3,d:1},...T_CURRENT], 2, "+3/1 step");

  // Add step at 5%
  runSim(pairs, [{a:5,d:3},...T_CURRENT], 2, "+5/3 step");
  runSim(pairs, [{a:5,d:2.5},...T_CURRENT], 2, "+5/2.5 step");
  runSim(pairs, [{a:5,d:2},...T_CURRENT], 2, "+5/2 step");
  runSim(pairs, [{a:5,d:1.5},...T_CURRENT], 2, "+5/1.5 step");
  runSim(pairs, [{a:5,d:1},...T_CURRENT], 2, "+5/1 step");

  // Add step at 7%
  runSim(pairs, [{a:7,d:3},...T_CURRENT], 2, "+7/3 step");
  runSim(pairs, [{a:7,d:2},...T_CURRENT], 2, "+7/2 step");

  // ─── SECTION 2: Replace BE with tighter trail ───
  console.log("\n--- REPLACE BE WITH TIGHTER TRAIL (BE=0) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(100));

  // No BE, just tighter trail
  runSim(pairs, [{a:2,d:1.5},...T_CURRENT], 0, "No BE, trail 2/1.5->10/5->...");
  runSim(pairs, [{a:2,d:1},...T_CURRENT], 0, "No BE, trail 2/1->10/5->...");
  runSim(pairs, [{a:3,d:2},...T_CURRENT], 0, "No BE, trail 3/2->10/5->...");
  runSim(pairs, [{a:3,d:1.5},...T_CURRENT], 0, "No BE, trail 3/1.5->10/5->...");
  runSim(pairs, [{a:3,d:1},...T_CURRENT], 0, "No BE, trail 3/1->10/5->...");
  runSim(pairs, [{a:5,d:2},...T_CURRENT], 0, "No BE, trail 5/2->10/5->...");
  runSim(pairs, [{a:5,d:1.5},...T_CURRENT], 0, "No BE, trail 5/1.5->10/5->...");

  // ─── SECTION 3: Different BE levels with early trail ───
  console.log("\n--- BE LEVEL + EARLY TRAIL COMBOS ---\n");
  console.log(hdr); console.log("  " + "-".repeat(100));

  // BE at 1.5% with early trail
  runSim(pairs, [{a:5,d:2},...T_CURRENT], 1.5, "BE 1.5% + 5/2");
  runSim(pairs, [{a:3,d:1.5},...T_CURRENT], 1.5, "BE 1.5% + 3/1.5");

  // BE at 3% with early trail
  runSim(pairs, [{a:5,d:2},...T_CURRENT], 3, "BE 3% + 5/2");
  runSim(pairs, [{a:5,d:2},...T_CURRENT], 4, "BE 4% + 5/2");

  // ─── SECTION 4: Aggressive tight trails ───
  console.log("\n--- AGGRESSIVE TIGHT TRAILS ---\n");
  console.log(hdr); console.log("  " + "-".repeat(100));

  runSim(pairs, [{a:3,d:1.5},{a:5,d:1},{a:10,d:0.5},{a:20,d:0.5}], 0, "Tight: 3/1.5->5/1->10/0.5->20/0.5 noBS");
  runSim(pairs, [{a:5,d:2},{a:8,d:1.5},{a:12,d:1},{a:20,d:0.5}], 0, "Tight: 5/2->8/1.5->12/1->20/0.5 noBE");
  runSim(pairs, [{a:5,d:2},{a:10,d:1.5},{a:15,d:1},{a:25,d:0.5}], 2, "5/2->10/1.5->15/1->25/0.5 BE2%");
  runSim(pairs, [{a:3,d:2},{a:7,d:1.5},{a:12,d:1},{a:20,d:0.5},{a:35,d:0.5}], 2, "3/2->7/1.5->12/1->20/0.5->35/0.5 BE2%");

  // ─── SECTION 5: Wider trails (let winners run more) ───
  console.log("\n--- WIDER TRAILS (let winners run) ---\n");
  console.log(hdr); console.log("  " + "-".repeat(100));

  runSim(pairs, [{a:10,d:7},{a:20,d:5},{a:35,d:3},{a:50,d:2}], 2, "Wide: 10/7->20/5->35/3->50/2 BE2%");
  runSim(pairs, [{a:15,d:8},{a:25,d:5},{a:40,d:3},{a:60,d:2}], 2, "Wide: 15/8->25/5->40/3->60/2 BE2%");
  runSim(pairs, T_CURRENT, 0, "Current trail NO BE");
  runSim(pairs, T_CURRENT, 2, "Current trail BE 2% (baseline)");
  runSim(pairs, T_CURRENT, 3, "Current trail BE 3%");
}

main();
