/**
 * DD analysis with REAL leverage per pair, $9 margin
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000; const H4 = 4 * H; const D = 86_400_000;
const FEE = 0.000_35; const MARGIN = 9;
const MOM_LB = 3; const VOL_WIN = 20; const SL_PCT = 0.005; const SL_CAP = 0.01;
const BE_AT = 2; const MAX_HOLD_H = 72; const CD_H = 1; const BLOCK_HOURS = [22, 23];
const ZL1 = 3.0; const ZL4 = 2.5; const ZS1 = -3.0; const ZS4 = -2.5;
const TRAIL = [{ a: 10, d: 5 },{ a: 15, d: 4 },{ a: 20, d: 3 },{ a: 25, d: 2 },{ a: 35, d: 1.5 },{ a: 50, d: 1 }];
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

interface C { t:number; o:number; h:number; l:number; c:number; }
interface Tr { pair:string; dir:"long"|"short"; ep:number; xp:number; et:number; xt:number; pnl:number; reason:string; }

function ld(s: string): C[] { const f=path.join(CACHE_5M,`${s}.json`); if(!fs.existsSync(f))return[]; return (JSON.parse(fs.readFileSync(f,"utf8")) as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b).sort((a:C,b:C)=>a.t-b.t); }
function agg(b:C[],p:number,m:number):C[] { const g=new Map<number,C[]>(); for(const c of b){const k=Math.floor(c.t/p)*p;let a=g.get(k);if(!a){a=[];g.set(k,a);}a.push(c);} const r:C[]=[]; for(const[t,grp]of g){if(grp.length<m)continue;grp.sort((a,b)=>a.t-b.t);r.push({t,o:grp[0]!.o,h:Math.max(...grp.map(b=>b.h)),l:Math.min(...grp.map(b=>b.l)),c:grp[grp.length-1]!.c});} return r.sort((a,b)=>a.t-b.t); }
function cz(cs:C[]):number[] { const z=new Array(cs.length).fill(0); for(let i=Math.max(MOM_LB+1,VOL_WIN+1);i<cs.length;i++){const m=cs[i]!.c/cs[i-MOM_LB]!.c-1;let ss=0,c=0;for(let j=Math.max(1,i-VOL_WIN);j<=i;j++){const r=cs[j]!.c/cs[j-1]!.c-1;ss+=r*r;c++;}if(c<10)continue;const v=Math.sqrt(ss/c);if(v===0)continue;z[i]=m/v;} return z; }
interface PI { h1:C[];h4:C[];z1:number[];z4:number[];m1:Map<number,number>;m4:Map<number,number>; }
function bi(b:C[]):PI { const h1=agg(b,H,10);const h4=agg(b,H4,40);const z1=cz(h1);const z4=cz(h4);const m1=new Map<number,number>();h1.forEach((c,i)=>m1.set(c.t,i));const m4=new Map<number,number>();h4.forEach((c,i)=>m4.set(c.t,i));return{h1,h4,z1,z4,m1,m4}; }
function g4z(ind:PI,t:number):number { const b=Math.floor(t/H4)*H4;let i=ind.m4.get(b);if(i!==undefined&&i>0)return ind.z4[i-1]!;let lo=0,hi=ind.h4.length-1,best=-1;while(lo<=hi){const m=(lo+hi)>>1;if(ind.h4[m]!.t<t){best=m;lo=m+1;}else hi=m-1;}return best>=0?ind.z4[best]!:0; }

interface PD { name:string; ind:PI; sp:number; lev:number; not:number; }

function main() {
  console.log("Loading...");
  const pairs: PD[] = [];
  for (const n of ALL) {
    const s=RM[n]??n; let r=ld(`${s}USDT`); if(r.length<5000)r=ld(`${n}USDT`); if(r.length<5000)continue;
    const ind=bi(r); if(ind.h1.length<100||ind.h4.length<50)continue;
    const lev=gl(n); pairs.push({name:n,ind,sp:SP[n]??DSP,lev,not:MARGIN*lev});
  }
  console.log(`${pairs.length} pairs, $${MARGIN} margin, real leverage\n`);

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
      if(!xp&&pos.pk>=BE_AT){if(pos.dir==="long"?bar.l<=pos.ep:bar.h>=pos.ep){xp=pos.ep;reason="be";}}
      if(!xp){if(pos.dir==="long"?bar.l<=pos.sl:bar.h>=pos.sl){xp=pos.sl;reason="sl";isSL=true;}}
      if(!xp){const best=pos.dir==="long"?(bar.h/pos.ep-1)*pos.lev*100:(pos.ep/bar.l-1)*pos.lev*100;if(best>pos.pk)pos.pk=best;const cur=pos.dir==="long"?(bar.c/pos.ep-1)*pos.lev*100:(pos.ep/bar.c-1)*pos.lev*100;let td=Infinity;for(const s of TRAIL)if(pos.pk>=s.a)td=s.d;if(td<Infinity&&cur<=pos.pk-td){xp=bar.c;reason="trail";}}
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
  // Daily equity
  const dp=new Map<number,number>();
  for(const t of sorted){const day=Math.floor(t.xt/D)*D;dp.set(day,(dp.get(day)??0)+t.pnl);}
  const days=[...dp.entries()].sort((a,b)=>a[0]-b[0]);
  let cum=0,peak=0;
  const hist:{date:string;dd:number;eq:number;pnl:number}[]=[];
  for(const[day,pnl]of days){cum+=pnl;if(cum>peak)peak=cum;hist.push({date:new Date(day).toISOString().slice(0,10),dd:peak-cum,eq:cum,pnl});}
  const maxDD=Math.max(...hist.map(d=>d.dd));
  const totalPnl=cum;
  const oosDays=(OOS_E-OOS_S)/D;

  console.log("=".repeat(80));
  console.log(`  127 PAIRS, $${MARGIN} MARGIN, REAL LEVERAGE, 1h COOLDOWN`);
  console.log(`  ${sorted.length} trades, +$${(totalPnl/oosDays).toFixed(2)}/day, MaxDD $${maxDD.toFixed(0)}`);
  console.log("=".repeat(80));

  // DD brackets
  const brackets=[10,20,30,40,50,60,70,80,90,100];
  console.log(`\n  DAYS IN EACH DRAWDOWN BRACKET (of ${hist.length} trading days)\n`);
  console.log(`  ${"Range".padEnd(18)} ${"Days".padStart(5)} ${"% time".padStart(8)}`);
  console.log("  "+"-".repeat(35));
  const at0=hist.filter(d=>d.dd<1).length;
  console.log(`  ${"No drawdown".padEnd(18)} ${String(at0).padStart(5)} ${(at0/hist.length*100).toFixed(1).padStart(7)}%`);
  for(let i=0;i<brackets.length;i++){
    const lo=i===0?1:brackets[i-1]!;const hi=brackets[i]!;
    const c=hist.filter(d=>d.dd>=lo&&d.dd<hi).length;
    console.log(`  ${`$${lo} - $${hi}`.padEnd(18)} ${String(c).padStart(5)} ${(c/hist.length*100).toFixed(1).padStart(7)}%`);
  }
  const over=hist.filter(d=>d.dd>=100).length;
  console.log(`  ${"> $100".padEnd(18)} ${String(over).padStart(5)} ${(over/hist.length*100).toFixed(1).padStart(7)}%`);

  // Consecutive days
  console.log(`\n  MAX CONSECUTIVE DAYS IN DRAWDOWN\n`);
  console.log(`  ${"Threshold".padEnd(15)} ${"Max days".padStart(10)} ${"Episodes".padStart(10)}`);
  console.log("  "+"-".repeat(38));
  for(const th of [10,20,30,40,50,60,70,80]){
    let s=0,ms=0,ep=0,ts2=0;
    for(const d of hist){if(d.dd>=th){s++;if(s>ms)ms=s;}else{if(s>0){ep++;ts2+=s;}s=0;}}
    if(s>0){ep++;ts2+=s;}
    console.log(`  ${`DD > $${th}`.padEnd(15)} ${(ms+"d").padStart(10)} ${String(ep).padStart(10)}`);
  }

  // Worst days
  console.log(`\n  WORST 5 SINGLE-DAY LOSSES\n`);
  const worst=[...hist].sort((a,b)=>a.pnl-b.pnl).slice(0,5);
  for(const d of worst) console.log(`    ${d.date}  Loss=$${Math.abs(d.pnl).toFixed(2).padStart(6)}  DD=$${d.dd.toFixed(0).padStart(3)}`);

  // Recovery
  console.log(`\n  RECOVERY FROM DD > $40\n`);
  let inDD=false,ddStart="",ddIdx=0,ddPk=0;
  for(let i=0;i<hist.length;i++){const d=hist[i]!;if(d.dd>=40&&!inDD){inDD=true;ddStart=d.date;ddIdx=i;ddPk=d.dd;}if(inDD&&d.dd>ddPk)ddPk=d.dd;if(inDD&&d.dd<3){console.log(`    ${ddStart} -> ${d.date}: ${i-ddIdx}d, peak DD=$${ddPk.toFixed(0)}`);inDD=false;}}
  if(inDD)console.log(`    ${ddStart} -> ongoing, peak DD=$${ddPk.toFixed(0)}`);

  // Monthly
  console.log(`\n  MONTHLY P&L\n`);
  const mp=new Map<string,{pnl:number;days:number}>();
  for(const d of hist){const m=d.date.slice(0,7);const v=mp.get(m)??{pnl:0,days:0};v.pnl+=d.pnl;v.days++;mp.set(m,v);}
  console.log(`  ${"Month".padEnd(10)} ${"P&L".padStart(10)} ${"$/day".padStart(8)} ${"Losing days".padStart(12)}`);
  console.log("  "+"-".repeat(42));
  for(const[m,v]of[...mp.entries()].sort()){
    const lossDays=hist.filter(d=>d.date.startsWith(m)&&d.pnl<0).length;
    console.log(`  ${m.padEnd(10)} ${((v.pnl>=0?"+":"")+`$${Math.abs(v.pnl).toFixed(2)}`).padStart(10)} ${((v.pnl/v.days>=0?"+":"")+`$${Math.abs(v.pnl/v.days).toFixed(2)}`).padStart(8)} ${(lossDays+"/"+v.days).padStart(12)}`);
  }
}
main();
