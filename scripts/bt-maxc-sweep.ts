/**
 * MaxConcurrent sweep: find the sweet spot between $/day and MDD
 * by limiting how many positions can be open at once
 */
import * as fs from "fs";
const CACHE = "/tmp/bt-pair-cache-5m";
const M5 = 5*60_000, H = 3_600_000, H4 = 4*H, D = 86_400_000;
const FEE = 0.00035, SL_PCT = 0.15;
const BLOCK_HOURS = new Set([22,23]);
const SP: Record<string,number> = {XRP:1.05e-4,DOGE:1.35e-4,ETH:1e-4,SOL:2e-4,SUI:1.85e-4,AVAX:2.55e-4,ARB:2.6e-4,ENA:2.55e-4,UNI:2.75e-4,APT:3.2e-4,LINK:3.45e-4,DOT:4.95e-4,WIF:5.05e-4,ADA:5.55e-4,LDO:5.8e-4,OP:6.2e-4,NEAR:3.5e-4,FET:4e-4};
const DSP = 5e-4;
const RM: Record<string,string> = {kPEPE:"1000PEPE",kFLOKI:"1000FLOKI",kBONK:"1000BONK",kSHIB:"1000SHIB"};
const LM = new Map<string,number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt","utf8").trim().split("\n")) { const [n,v]=l.split(":"); LM.set(n!,parseInt(v!)); }
const getLev = (n: string) => Math.min(LM.get(n)??3,10);
const ALL = ["OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX","NEAR","kPEPE","SUI","FET","FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE","JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR","PENDLE","PNUT","ATOM","TON","SEI","STX","DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN","TNSR","CATI","TURBO","MOVE","GALA","STRK","SAGA","ILV","GMX","OM","CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC","USUAL","UMA","USTC","MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W","FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS","MINA","LISTA","NEO","AI","SCR","APE","KAITO","AR","BNT","PIXEL","LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET","STG","REQ","CAKE","SUPER","FTT","STRAX"];
const OOS_S = new Date("2025-06-01").getTime(), OOS_E = new Date("2026-03-25").getTime(), OOS_D = (OOS_E-OOS_S)/D;

interface C { t:number; o:number; h:number; l:number; c:number; }
function load(sym:string):C[] { try { return JSON.parse(fs.readFileSync(`${CACHE}/${sym}.json`,"utf8")); } catch { return []; } }
function aggregate(raw:C[],ms:number,min:number):C[] { const bars:C[]=[]; let cur:C|null=null; for(const c of raw){const t=Math.floor(c.t/ms)*ms;if(!cur||cur.t!==t){if(cur)bars.push(cur);cur={t,o:c.o,h:c.h,l:c.l,c:c.c};}else{if(c.h>cur.h)cur.h=c.h;if(c.l<cur.l)cur.l=c.l;cur.c=c.c;}} if(cur)bars.push(cur); return bars.length>=min?bars:[]; }
function computeZ(cs:C[],momLb:number,volWin:number):number[] { const z:number[]=[]; for(let i=0;i<cs.length;i++){if(i<volWin+momLb+1){z.push(0);continue;}const mom=cs[i]!.c/cs[i-momLb]!.c-1;const rets:number[]=[];for(let j=Math.max(1,i-volWin);j<=i;j++)rets.push(cs[j]!.c/cs[j-1]!.c-1);const vol=Math.sqrt(rets.reduce((s,r)=>s+r*r,0)/rets.length);z.push(vol===0?0:mom/vol);} return z; }

console.log("Loading...");
interface PD { name:string; h1:C[]; h4:C[]; m5:C[]; z1:number[]; z4:number[]; h1Map:Map<number,number>; m5Map:Map<number,number>; sp:number; lev:number; }
const pairs: PD[] = [];
for (const n of ALL) { const s=RM[n]??n; let raw=load(`${s}USDT`); if(raw.length<5000) raw=load(`${n}USDT`); if(raw.length<5000) continue; const h1=aggregate(raw,H,900),h4=aggregate(raw,H4,50); if(h1.length<900||h4.length<50) continue; const z1=computeZ(h1,1,30),z4=computeZ(h4,1,30); const h1Map=new Map<number,number>(),m5Map=new Map<number,number>(); h1.forEach((c,i)=>h1Map.set(c.t,i)); const m5=raw.filter(b=>b.t>=OOS_S-24*H&&b.t<=OOS_E+24*H); m5.forEach((c,i)=>m5Map.set(c.t,i)); pairs.push({name:n,h1,h4,m5,z1,z4,h1Map,m5Map,sp:SP[n]??DSP,lev:getLev(n)}); }
console.log(`${pairs.length} pairs`);
const allTs=new Set<number>(); for(const p of pairs) for(const b of p.m5) if(b.t>=OOS_S&&b.t<OOS_E) allTs.add(b.t);
const timepoints=[...allTs].sort((a,b)=>a-b);
const pairByName=new Map<string,PD>(); pairs.forEach(p=>pairByName.set(p.name,p));
function get4hZ(p:PD,ts:number):number { let lo=0,hi=p.h4.length-1,best=-1; while(lo<=hi){const m=(lo+hi)>>1;if(p.h4[m]!.t<ts){best=m;lo=m+1;}else hi=m-1;} return best>=0?p.z4[best]!:0; }

const TRAIL = [{a:3,d:1},{a:9,d:0.5},{a:20,d:0.5}];
interface OP { pair:string; ep:number; et:number; sl:number; pk:number; sp:number; lev:number; not:number; }

function runSim(margin:number, maxC:number): {dpd:number; mdd:number; trades:number} {
  const openPos:OP[]=[];
  let realizedPnl=0,mtmPeak=0,mtmMaxDD=0,trades=0;
  for(const ts of timepoints){
    const isH1=ts%H===0;
    for(let i=openPos.length-1;i>=0;i--){const pos=openPos[i]!;const pd=pairByName.get(pos.pair);if(!pd)continue;const bi=pd.m5Map.get(ts);if(bi===undefined)continue;const bar=pd.m5[bi]!;let xp=0,reason="";if((ts-pos.et)/H>=72){xp=bar.c;reason="maxh";}if(!xp){const slP=pos.ep*(1-SL_PCT/100);if(bar.l<=slP){xp=slP;reason="sl";}}const best=(bar.h/pos.ep-1)*pos.lev*100;if(best>pos.pk)pos.pk=best;if(!xp&&isH1){const cur=(bar.c/pos.ep-1)*pos.lev*100;let td=Infinity;for(const s of TRAIL)if(pos.pk>=s.a){td=s.d;break;}if(td<Infinity&&cur<=pos.pk-td){xp=bar.c;reason="trail";}}if(xp>0){const rsp=reason==="sl"?pos.sp*1.5:pos.sp;const ex=xp*(1-rsp);const pnl=(ex/pos.ep-1)*pos.not-pos.not*FEE*2;openPos.splice(i,1);realizedPnl+=pnl;trades++;}}
    let unrealized=0;for(const pos of openPos){const pd=pairByName.get(pos.pair);if(!pd)continue;const bi=pd.m5Map.get(ts);if(bi===undefined)continue;const b=pd.m5[bi]!;unrealized+=(b.c*(1-pos.sp)/pos.ep-1)*pos.not-pos.not*FEE*2;}
    const eq=realizedPnl+unrealized;if(eq>mtmPeak)mtmPeak=eq;if(mtmPeak-eq>mtmMaxDD)mtmMaxDD=mtmPeak-eq;
    if(!isH1)continue;if(BLOCK_HOURS.has(new Date(ts).getUTCHours()))continue;
    if(maxC>0 && openPos.length>=maxC) continue;
    for(const p of pairs){
      if(maxC>0 && openPos.length>=maxC) break;
      if(openPos.some(o=>o.pair===p.name))continue;const h1i=p.h1Map.get(ts);if(h1i===undefined||h1i<32)continue;if(!(p.z1[h1i-1]!>2.0))continue;if(!(get4hZ(p,ts)>1.5))continue;const ep=p.h1[h1i]!.o*(1+p.sp);openPos.push({pair:p.name,ep,et:ts,sl:ep*(1-SL_PCT/100),pk:0,sp:p.sp,lev:p.lev,not:margin*p.lev});}
  }
  return {dpd:realizedPnl/OOS_D, mdd:mtmMaxDD, trades};
}

console.log("\nlb1/vw30 z2/1.5 long-only, trail 3/1->9/0.5->20/0.5, SL 0.15%");
console.log("\nMargin  MaxC    $/day    MDD    Calmar  Trades  RecovDays  On$60");
console.log("-".repeat(75));
for (const margin of [10, 15, 20, 25, 30]) {
  for (const maxC of [0, 3, 5, 7, 10, 15, 20]) {
    const r = runSim(margin, maxC);
    const mcLabel = maxC === 0 ? "inf" : String(maxC);
    const recDays = r.dpd > 0 ? (r.mdd / r.dpd).toFixed(0) : "inf";
    const calmar = r.mdd > 0 ? (r.dpd / r.mdd).toFixed(4) : "0";
    const bottom = 60 - r.mdd;
    const safe = bottom > 15 ? "SAFE" : bottom > 0 ? "TIGHT" : "DEAD";
    const tag = r.mdd < 20 ? " ***" : r.mdd < 30 ? " *" : "";
    console.log(`$${String(margin).padStart(2)}     ${mcLabel.padStart(3)}    $${r.dpd.toFixed(2).padStart(5)}  $${r.mdd.toFixed(0).padStart(4)}   ${calmar.padStart(6)}   ${String(r.trades).padStart(5)}      ${recDays.padStart(3)}d    $${bottom.toFixed(0).padStart(3)} ${safe}${tag}`);
  }
  console.log("");
}
