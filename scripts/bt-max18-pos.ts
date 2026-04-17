/**
 * Quick backtest: z2.0/1.5, SL 0.3%, trail 7/3->15/2->30/1, $5, real leverage
 * WITH max 18 concurrent positions (realistic for $90 equity)
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000; const H4 = 4 * H; const D = 86_400_000;
const FEE = 0.00035; const MARGIN = 5; const MOM_LB = 3; const VOL_WIN = 20;
const SL_PCT = 0.003; const SL_CAP = 0.01; const MAX_HOLD_H = 72; const CD_H = 1;
const ZL1 = 2.0; const ZL4 = 1.5; const ZS1 = -2.0; const ZS4 = -1.5;
const BLOCK_HOURS = [22, 23];
const TRAIL = [{a:7,d:3},{a:15,d:2},{a:30,d:1}];

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
function computeZ(cs:C[]):number[] { const z=new Array(cs.length).fill(0); for(let i=Math.max(MOM_LB+1,VOL_WIN+1);i<cs.length;i++){const m=cs[i]!.c/cs[i-MOM_LB]!.c-1;let ss=0,c=0;for(let j=Math.max(1,i-VOL_WIN);j<=i;j++){const r=cs[j]!.c/cs[j-1]!.c-1;ss+=r*r;c++;}if(c<10)continue;const v=Math.sqrt(ss/c);if(v===0)continue;z[i]=m/v;} return z; }
function g4z(z4:number[],h4:C[],m4:Map<number,number>,t:number):number { const b=Math.floor(t/H4)*H4;let i=m4.get(b);if(i!==undefined&&i>0)return z4[i-1]!;let lo=0,hi=h4.length-1,best=-1;while(lo<=hi){const m2=(lo+hi)>>1;if(h4[m2]!.t<t){best=m2;lo=m2+1;}else hi=m2-1;}return best>=0?z4[best]!:0; }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface PD { name:string; ind:PI; sp:number; lev:number; not:number; }

function run(pairs: PD[], maxPos: number, label: string) {
  const allT=new Set<number>();
  for(const p of pairs) for(const b of p.ind.h1) if(b.t>=OOS_S&&b.t<OOS_E) allT.add(b.t);
  const hours=[...allT].sort((a,b)=>a-b);
  interface OP { pair:string;dir:"long"|"short";ep:number;et:number;sl:number;pk:number;sp:number;lev:number;not:number; }
  const open:OP[]=[]; const closed:{pnl:number}[]=[]; const cd=new Map<string,number>();
  let skipped = 0;
  for(const hr of hours) {
    for(let i=open.length-1;i>=0;i--) {
      const pos=open[i]!;const pd=pairs.find(p=>p.name===pos.pair);if(!pd)continue;
      const bi2=pd.ind.m1.get(hr);if(bi2===undefined)continue;const bar=pd.ind.h1[bi2]!;
      let xp=0,isSL=false;
      if((hr-pos.et)/H>=MAX_HOLD_H){xp=bar.c;}
      if(!xp){if(pos.dir==="long"?bar.l<=pos.sl:bar.h>=pos.sl){xp=pos.sl;isSL=true;}}
      if(!xp){const best=pos.dir==="long"?(bar.h/pos.ep-1)*pos.lev*100:(pos.ep/bar.l-1)*pos.lev*100;if(best>pos.pk)pos.pk=best;const cur=pos.dir==="long"?(bar.c/pos.ep-1)*pos.lev*100:(pos.ep/bar.c-1)*pos.lev*100;let td=Infinity;for(const s of TRAIL)if(pos.pk>=s.a)td=s.d;if(td<Infinity&&cur<=pos.pk-td){xp=bar.c;}}
      if(xp>0){const rsp=isSL?pos.sp*1.5:pos.sp;const ex=pos.dir==="long"?xp*(1-rsp):xp*(1+rsp);const pnl=(pos.dir==="long"?(ex/pos.ep-1):(pos.ep/ex-1))*pos.not-pos.not*FEE*2;closed.push({pnl});open.splice(i,1);if(isSL)cd.set(`${pos.pair}:${pos.dir}`,hr+CD_H*H);}
    }
    if(BLOCK_HOURS.includes(new Date(hr).getUTCHours()))continue;

    // Collect signals, sort by z magnitude
    interface Sig { pair:string; dir:"long"|"short"; z:number; bi:number; sp:number; lev:number; not:number; }
    const sigs: Sig[] = [];
    for(const p of pairs){
      const bi2=p.ind.m1.get(hr);if(bi2===undefined||bi2<VOL_WIN+2)continue;
      if(open.some(o=>o.pair===p.name))continue;
      const z1=p.ind.z1[bi2-1]!;const z4=g4z(p.ind.z4,p.ind.h4,p.ind.m4,hr);
      let dir:"long"|"short"|null=null;
      if(z1>ZL1&&z4>ZL4)dir="long";if(z1<ZS1&&z4<ZS4)dir="short";if(!dir)continue;
      const ck=`${p.name}:${dir}`;if(cd.has(ck)&&hr<cd.get(ck)!)continue;
      sigs.push({pair:p.name,dir,z:Math.abs(z1),bi:bi2,sp:p.sp,lev:p.lev,not:p.not});
    }
    sigs.sort((a,b)=>b.z-a.z); // strongest first

    for(const sig of sigs){
      if(open.length >= maxPos) { skipped++; break; }
      const p=pairs.find(pp=>pp.name===sig.pair)!;
      const ep=sig.dir==="long"?p.ind.h1[sig.bi]!.o*(1+sig.sp):p.ind.h1[sig.bi]!.o*(1-sig.sp);
      const sld=Math.min(ep*SL_PCT,ep*SL_CAP);const sl=sig.dir==="long"?ep-sld:ep+sld;
      open.push({pair:sig.pair,dir:sig.dir,ep,et:hr,sl,pk:0,sp:sig.sp,lev:sig.lev,not:sig.not});
    }
  }
  for(const pos of open){const pd=pairs.find(p=>p.name===pos.pair);if(!pd)continue;const lb=pd.ind.h1[pd.ind.h1.length-1]!;const ex=pos.dir==="long"?lb.c*(1-pos.sp):lb.c*(1+pos.sp);const pnl=(pos.dir==="long"?(ex/pos.ep-1):(pos.ep/ex-1))*pos.not-pos.not*FEE*2;closed.push({pnl});}

  const total=closed.reduce((s,t)=>s+t.pnl,0);
  const wins=closed.filter(t=>t.pnl>0).length;
  const wr=closed.length>0?wins/closed.length*100:0;
  const gp=closed.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gl2=Math.abs(closed.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
  const pf=gl2>0?gp/gl2:Infinity;
  let cum=0,peak=0,maxDD=0;
  for(const t of closed){cum+=t.pnl;if(cum>peak)peak=cum;if(peak-cum>maxDD)maxDD=peak-cum;}

  console.log(`  ${label.padEnd(40)} ${String(closed.length).padStart(6)} ${(closed.length/OOS_D).toFixed(1).padStart(5)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(total/OOS_D).padStart(9)} $${maxDD.toFixed(0).padStart(3)} ${String(skipped).padStart(6)}`);
}

function main() {
  console.log("=".repeat(95));
  console.log("  REALISTIC POSITION LIMIT TEST");
  console.log("  z2.0/1.5 SL0.3% trail 7/3->15/2->30/1 $5 real-lev");
  console.log("=".repeat(95));
  console.log("\n  Loading...");
  const pairs: PD[] = [];
  for (const n of ALL) {
    const s=RM[n]??n; let r=ld(`${s}USDT`); if(r.length<5000)r=ld(`${n}USDT`); if(r.length<5000)continue;
    const h1=agg(r,H,10);const h4=agg(r,H4,40);if(h1.length<100||h4.length<50)continue;
    const z1=computeZ(h1);const z4=computeZ(h4);
    const m1=new Map<number,number>();h1.forEach((c,i)=>m1.set(c.t,i));
    const m4=new Map<number,number>();h4.forEach((c,i)=>m4.set(c.t,i));
    const lev=gl(n); pairs.push({name:n,ind:{h1,h4,z1,z4,m1,m4},sp:SP[n]??DSP,lev,not:MARGIN*lev});
  }
  console.log(`  ${pairs.length} pairs\n`);

  const hdr = `  ${"Config".padEnd(40)} ${"Trd".padStart(6)} ${"T/d".padStart(5)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"$/day".padStart(9)} ${"MDD".padStart(4)} ${"Skip".padStart(6)}`;
  console.log(hdr); console.log("  "+"-".repeat(85));

  for (const max of [5, 8, 10, 12, 15, 18, 20, 25, 30, 40, 50, 999]) {
    run(pairs, max, `Max ${max} concurrent`);
  }
}

main();
