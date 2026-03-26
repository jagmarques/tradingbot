/**
 * Full parameter sweep WITH trailing stop options.
 * Same grid as final sweep but adds trailing variants.
 */
import * as fs from "fs";import * as path from "path";import{ADX,EMA,ATR}from"technicalindicators";
interface C{t:number;o:number;h:number;l:number;c:number}
interface P{pair:string;dir:"long"|"short";ep:number;et:number;sl:number;tp:number;pk:number}
interface T{pnl:number;et:number;xt:number}
interface D{cs:C[];tm:Map<number,number>;z3:number[];adx:number[];e9:number[];e21:number[];atr:number[]}
const CD="/tmp/bt-pair-cache",H=3600000,DAY=86400000,FEE=0.00035,SZ=20,LEV=10;
const PP=["OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","AVAXUSDT","TRUMPUSDT","DASHUSDT","DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","SEIUSDT","LINKUSDT","ADAUSDT","WLDUSDT","XRPUSDT","SUIUSDT","TONUSDT","UNIUSDT"];
const SP:Record<string,number>={XRPUSDT:1.05e-4,DOGEUSDT:1.35e-4,SUIUSDT:1.85e-4,AVAXUSDT:2.55e-4,ARBUSDT:2.6e-4,ENAUSDT:2.55e-4,UNIUSDT:2.75e-4,APTUSDT:3.2e-4,LINKUSDT:3.45e-4,TRUMPUSDT:3.65e-4,WLDUSDT:4e-4,SEIUSDT:4.4e-4,TONUSDT:4.6e-4,DOTUSDT:4.95e-4,WIFUSDT:5.05e-4,ADAUSDT:5.55e-4,LDOUSDT:5.8e-4,OPUSDT:6.2e-4,DASHUSDT:7.15e-4,BTCUSDT:0.5e-4};
function ld(p:string):C[]{const f=path.join(CD,p+".json");if(!fs.existsSync(f))return[];return(JSON.parse(fs.readFileSync(f,"utf8"))as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b)}
function gv(a:number[],i:number,l:number):number|null{const x=i-(l-a.length);return x>=0&&x<a.length?a[x]:null}
function zsc(cs:C[]):number[]{const r=new Array(cs.length).fill(0);for(let i=21;i<cs.length;i++){const m=cs[i].c/cs[i-3].c-1;let s=0,n=0;for(let j=Math.max(1,i-19);j<=i;j++){s+=(cs[j].c/cs[j-1].c-1)**2;n++}if(n<10)continue;const v=Math.sqrt(s/n);if(v>0)r[i]=m/v}return r}
function pre(p:string):D|null{const cs=ld(p);if(cs.length<200)return null;const tm=new Map<number,number>();cs.forEach((x,i)=>tm.set(x.t,i));const cl=cs.map(x=>x.c),hi=cs.map(x=>x.h),lo=cs.map(x=>x.l);return{cs,tm,z3:zsc(cs),adx:ADX.calculate({close:cl,high:hi,low:lo,period:14}).map(a=>a.adx),e9:EMA.calculate({period:9,values:cl}),e21:EMA.calculate({period:21,values:cl}),atr:ATR.calculate({period:14,high:hi,low:lo,close:cl})}}

interface Cfg{zL:number;zS:number;aL:number;aS:number;sl:number;tpL:number;tpS:number;mh:number;md:number;trA:number;trD:number}

function sim(c:Cfg,pdm:Map<string,D>,btc:D,s:number,e:number):T[]{
  const ts=new Set<number>();for(const d of pdm.values())for(const x of d.cs)if(x.t>=s&&x.t<e)ts.add(x.t);
  const st=[...ts].sort((a,b)=>a-b);const pos=new Map<string,P>();const tr:T[]=[];
  const bd=(t:number):"long"|"short"|null=>{const bi=btc.tm.get(t);if(!bi||bi<1)return null;const e9=gv(btc.e9,bi-1,btc.cs.length),e21=gv(btc.e21,bi-1,btc.cs.length);return e9!==null&&e21!==null?(e9>e21?"long":"short"):null};
  for(const t of st){const cl=new Set<string>();
    for(const[p,ps]of pos){const d=pdm.get(p)!;const bi=d.tm.get(t)??-1;if(bi<0)continue;const b=d.cs[bi];const sp=SP[p]??4e-4;let xp=0;
      if(ps.dir==="long"?b.l<=ps.sl:b.h>=ps.sl)xp=ps.dir==="long"?ps.sl*(1-sp):ps.sl*(1+sp);
      else if(ps.tp>0&&(ps.dir==="long"?b.h>=ps.tp:b.l<=ps.tp))xp=ps.dir==="long"?ps.tp*(1-sp):ps.tp*(1+sp);
      else if(c.trA>0){const pp=ps.dir==="long"?(b.c-ps.ep)/ps.ep*LEV*100:(ps.ep-b.c)/ps.ep*LEV*100;if(pp>ps.pk)ps.pk=pp;if(ps.pk>=c.trA&&pp<=ps.pk-c.trD)xp=ps.dir==="long"?b.c*(1-sp):b.c*(1+sp)}
      if(!xp&&t-ps.et>=c.mh)xp=ps.dir==="long"?b.c*(1-sp):b.c*(1+sp);
      if(xp>0){const raw=ps.dir==="long"?(xp/ps.ep-1)*SZ*LEV:(ps.ep/xp-1)*SZ*LEV;tr.push({pnl:raw-SZ*LEV*FEE*2,et:ps.et,xt:t});pos.delete(p);cl.add(p)}}
    for(const[p,d]of pdm){if(p==="BTCUSDT"||pos.has(p)||cl.has(p))continue;const bi=d.tm.get(t)??-1;if(bi<60)continue;
      const z=d.z3[bi-1]||0;let dir:"long"|"short"|null=null;
      if(z>c.zL)dir="long";else if(z<-c.zS)dir="short";if(!dir)continue;
      const adx=gv(d.adx,bi-1,d.cs.length);if(!adx||adx<=(dir==="long"?c.aL:c.aS))continue;
      const e9=gv(d.e9,bi-1,d.cs.length),e21=gv(d.e21,bi-1,d.cs.length);if(!e9||!e21||(dir==="long"?e9<=e21:e9>=e21))continue;
      const aN=gv(d.atr,bi-1,d.cs.length),aP=gv(d.atr,bi-6,d.cs.length);if(aN&&aP&&aN<aP*0.9)continue;
      const bt=bd(t);if(!bt||bt!==dir)continue;
      const dc=[...pos.values()].filter(x=>x.dir===dir).length;if(dc>=c.md)continue;
      const en=d.cs[bi].o;const sp=SP[p]??4e-4;const ent=dir==="long"?en*(1+sp):en*(1-sp);
      pos.set(p,{pair:p,dir,ep:ent,et:t,sl:dir==="long"?ent*(1-c.sl/100):ent*(1+c.sl/100),tp:c.tpL>0?(dir==="long"?ent*(1+c.tpL):ent*(1-c.tpS)):0,pk:0})}}
  return tr}

const S=new Date("2025-06-01").getTime(),E=new Date("2026-03-20").getTime(),days=(E-S)/DAY,M=new Date("2025-10-25").getTime();
console.log("Loading...");const pdm=new Map<string,D>();for(const p of[...PP,"BTCUSDT"]){const d=pre(p);if(d)pdm.set(p,d)}const btc=pdm.get("BTCUSDT")!;

// Full grid with trailing
const zLs=[3.0,3.5,4.0,4.5];const zSs=[2.0,2.5,3.0];const aLs=[25,30];const aSs=[20,25];
const sls=[2,3,3.5];const tpLs=[0,0.10,0.12,0.15];const tpSs=[0,0.10,0.12];
const mhs=[24*H,48*H];const mds=[3,4];
// Trail: 0=none, or activation/distance pairs
const trails:number[][]= [[0,0],[15,5],[20,7],[30,10],[40,15]];

let total=zLs.length*zSs.length*aLs.length*aSs.length*sls.length*tpLs.length*tpSs.length*mhs.length*mds.length*trails.length;
console.log(`${total} combos\n`);

const res:{c:Cfg;pnl:number;pd:number;wr:number;sh:number;dd:number;n:number;tpd:number;trn:number;tst:number}[]=[];
let cnt=0;
for(const zL of zLs)for(const zS of zSs)for(const aL of aLs)for(const aS of aSs)
for(const sl of sls)for(const tpL of tpLs)for(const tpS of tpSs)for(const mh of mhs)for(const md of mds)for(const[trA,trD]of trails){
  // Skip invalid: no TP and no trail = only SL/maxhold exits
  if(tpL===0&&trA===0)continue;
  // Skip: trail without TP needs longer hold
  const cfg:Cfg={zL,zS,aL,aS,sl,tpL,tpS:tpS||tpL,mh:trA>0&&tpL===0?Math.max(mh,48*H):mh,md,trA,trD};
  const tr=sim(cfg,pdm,btc,S,E);if(tr.length<30)continue;
  const pnl=tr.reduce((s,t)=>s+t.pnl,0);const w=tr.filter(t=>t.pnl>0).length;
  let cum=0,pk=0,dd=0;const dp=new Map<number,number>();
  for(const t of tr){cum+=t.pnl;if(cum>pk)pk=cum;if(pk-cum>dd)dd=pk-cum;dp.set(Math.floor(t.xt/DAY),(dp.get(Math.floor(t.xt/DAY))||0)+t.pnl)}
  const dr=[...dp.values()];const avg=dr.reduce((s,r)=>s+r,0)/Math.max(dr.length,1);
  const std=Math.sqrt(dr.reduce((s,r)=>s+(r-avg)**2,0)/Math.max(dr.length-1,1));
  const sh=std>0?(avg/std)*Math.sqrt(252):0;
  const trn2=sim(cfg,pdm,btc,S,M);const tst2=sim(cfg,pdm,btc,M,E);
  const trnD=trn2.reduce((a,t)=>a+t.pnl,0)/((M-S)/DAY);const tstD=tst2.reduce((a,t)=>a+t.pnl,0)/((E-M)/DAY);
  if(trnD>0&&tstD>0)res.push({c:cfg,pnl,pd:pnl/days,wr:w/tr.length*100,sh,dd,n:tr.length,tpd:tr.length/days,trn:trnD,tst:tstD});
  cnt++;if(cnt%2000===0)process.stdout.write(`${cnt}/${total}\r`);
}

console.log(`\n${res.length} valid (train+test positive)\n`);

// Balanced score with WR bonus
res.sort((a,b)=>(b.pd*b.sh/Math.max(b.dd,1)*(b.wr/50))-(a.pd*a.sh/Math.max(a.dd,1)*(a.wr/50)));

console.log("=== TOP 25 BALANCED at $20/trade (WITH trailing options) ===\n");
console.log("zL   zS  aL aS  SL  tpL tpS trA/trD hold md | $/day Sharpe  WR%  MaxDD T/day Train  Test  Score");
console.log("-".repeat(110));
for(const r of res.slice(0,25)){const c=r.c;const mh=c.mh===24*H?"24h":"48h";const tr=c.trA>0?`${c.trA}/${c.trD}`:"none";
  const sc=r.pd*r.sh/Math.max(r.dd,1)*(r.wr/50);
  console.log(`${c.zL.toFixed(1)} ${c.zS.toFixed(1)} ${String(c.aL).padStart(3)}${String(c.aS).padStart(3)}  ${c.sl}% ${(c.tpL*100).toFixed(0).padStart(3)}%${(c.tpS*100).toFixed(0).padStart(3)}% ${tr.padStart(7)} ${mh.padStart(3)} ${String(c.md).padStart(2)} | $${r.pd.toFixed(2).padStart(5)} ${r.sh.toFixed(2).padStart(5)} ${r.wr.toFixed(1).padStart(5)} $${r.dd.toFixed(0).padStart(5)} ${r.tpd.toFixed(1).padStart(5)} $${r.trn.toFixed(2).padStart(5)} $${r.tst.toFixed(2).padStart(5)} ${sc.toFixed(4)}`)}

// Top by $/day
res.sort((a,b)=>b.pd-a.pd);
console.log("\n=== TOP 10 BY $/DAY ===\n");
for(const r of res.slice(0,10)){const c=r.c;const mh=c.mh===24*H?"24h":"48h";const tr=c.trA>0?`${c.trA}/${c.trD}`:"none";
  console.log(`zL=${c.zL} zS=${c.zS} aL=${c.aL} aS=${c.aS} sl=${c.sl}% tpL=${(c.tpL*100).toFixed(0)}% tpS=${(c.tpS*100).toFixed(0)}% trail=${tr} ${mh} max=${c.md} | $${r.pd.toFixed(2)}/day WR=${r.wr.toFixed(1)}% Sharpe=${r.sh.toFixed(2)} DD=$${r.dd.toFixed(0)} Train=$${r.trn.toFixed(2)} Test=$${r.tst.toFixed(2)}`)}

// Top by Sharpe
res.sort((a,b)=>b.sh-a.sh);
console.log("\n=== TOP 10 BY SHARPE ===\n");
for(const r of res.slice(0,10)){const c=r.c;const mh=c.mh===24*H?"24h":"48h";const tr=c.trA>0?`${c.trA}/${c.trD}`:"none";
  console.log(`zL=${c.zL} zS=${c.zS} aL=${c.aL} aS=${c.aS} sl=${c.sl}% tpL=${(c.tpL*100).toFixed(0)}% tpS=${(c.tpS*100).toFixed(0)}% trail=${tr} ${mh} max=${c.md} | $${r.pd.toFixed(2)}/day WR=${r.wr.toFixed(1)}% Sharpe=${r.sh.toFixed(2)} DD=$${r.dd.toFixed(0)} Train=$${r.trn.toFixed(2)} Test=$${r.tst.toFixed(2)}`)}

// Lowest DD > $3/day
const decent=res.filter(r=>r.pd>3);decent.sort((a,b)=>a.dd-b.dd);
console.log("\n=== LOWEST DD with $/day > $3 ===\n");
for(const r of decent.slice(0,10)){const c=r.c;const mh=c.mh===24*H?"24h":"48h";const tr=c.trA>0?`${c.trA}/${c.trD}`:"none";
  console.log(`zL=${c.zL} zS=${c.zS} aL=${c.aL} aS=${c.aS} sl=${c.sl}% tpL=${(c.tpL*100).toFixed(0)}% tpS=${(c.tpS*100).toFixed(0)}% trail=${tr} ${mh} max=${c.md} | $${r.pd.toFixed(2)}/day WR=${r.wr.toFixed(1)}% Sharpe=${r.sh.toFixed(2)} DD=$${r.dd.toFixed(0)} Train=$${r.trn.toFixed(2)} Test=$${r.tst.toFixed(2)}`)}

// Highest WR > $3/day
decent.sort((a,b)=>b.wr-a.wr);
console.log("\n=== HIGHEST WR with $/day > $3 ===\n");
for(const r of decent.slice(0,10)){const c=r.c;const mh=c.mh===24*H?"24h":"48h";const tr=c.trA>0?`${c.trA}/${c.trD}`:"none";
  console.log(`zL=${c.zL} zS=${c.zS} aL=${c.aL} aS=${c.aS} sl=${c.sl}% tpL=${(c.tpL*100).toFixed(0)}% tpS=${(c.tpS*100).toFixed(0)}% trail=${tr} ${mh} max=${c.md} | $${r.pd.toFixed(2)}/day WR=${r.wr.toFixed(1)}% Sharpe=${r.sh.toFixed(2)} DD=$${r.dd.toFixed(0)} Train=$${r.trn.toFixed(2)} Test=$${r.tst.toFixed(2)}`)}
