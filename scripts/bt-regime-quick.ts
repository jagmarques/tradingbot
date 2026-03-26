// Quick regime filter test: ADX slope + BB width regime
import * as fs from "fs";
import * as path from "path";
import { ATR, ADX, EMA, BollingerBands } from "technicalindicators";

interface C{t:number;o:number;h:number;l:number;c:number}
interface P{pair:string;dir:"long"|"short";ep:number;et:number;sl:number;tp:number;pk:number}
interface T{pair:string;dir:"long"|"short";ep:number;xp:number;et:number;xt:number;pnl:number}
interface D{cs:C[];tm:Map<number,number>;z3:number[];adx:number[];e9:number[];e21:number[];bbw:number[]}

const CD="/tmp/bt-pair-cache",H=3600000,D2=86400000,FEE=0.00035;
const PP=["OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","AVAXUSDT","TRUMPUSDT","DASHUSDT","DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","SEIUSDT","LINKUSDT","ADAUSDT","WLDUSDT","XRPUSDT","SUIUSDT","TONUSDT","UNIUSDT"];
const SP:Record<string,number>={XRPUSDT:1.05e-4,DOGEUSDT:1.35e-4,SUIUSDT:1.85e-4,AVAXUSDT:2.55e-4,ARBUSDT:2.6e-4,ENAUSDT:2.55e-4,UNIUSDT:2.75e-4,APTUSDT:3.2e-4,LINKUSDT:3.45e-4,TRUMPUSDT:3.65e-4,WLDUSDT:4e-4,SEIUSDT:4.4e-4,TONUSDT:4.6e-4,DOTUSDT:4.95e-4,WIFUSDT:5.05e-4,ADAUSDT:5.55e-4,LDOUSDT:5.8e-4,OPUSDT:6.2e-4,DASHUSDT:7.15e-4,BTCUSDT:0.5e-4};
function ld(p:string):C[]{const f=path.join(CD,p+".json");if(!fs.existsSync(f))return[];return(JSON.parse(fs.readFileSync(f,"utf8"))as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b)}
function gv(a:number[],i:number,l:number):number|null{const x=i-(l-a.length);return x>=0&&x<a.length?a[x]:null}
function zs(cs:C[]):number[]{const r=new Array(cs.length).fill(0);for(let i=21;i<cs.length;i++){const m=cs[i].c/cs[i-3].c-1;let s=0,n=0;for(let j=Math.max(1,i-19);j<=i;j++){s+=(cs[j].c/cs[j-1].c-1)**2;n++}if(n<10)continue;const v=Math.sqrt(s/n);if(v>0)r[i]=m/v}return r}
function pre(p:string):D|null{const cs=ld(p);if(cs.length<200)return null;const tm=new Map<number,number>();cs.forEach((x,i)=>tm.set(x.t,i));const cl=cs.map(x=>x.c),hi=cs.map(x=>x.h),lo=cs.map(x=>x.l);const bb=BollingerBands.calculate({period:20,stdDev:2,values:cl});const bbw=bb.map(b=>b.middle>0?(b.upper-b.lower)/b.middle:0);return{cs,tm,z3:zs(cs),adx:ADX.calculate({close:cl,high:hi,low:lo,period:14}).map(a=>a.adx),e9:EMA.calculate({period:9,values:cl}),e21:EMA.calculate({period:21,values:cl}),bbw}}

type SF=(d:D,bi:number,btc:D)=>"long"|"short"|null;
function sim(name:string,sig:SF,pdm:Map<string,D>,btc:D,s:number,e:number):T[]{
  const ts=new Set<number>();for(const d of pdm.values())for(const c of d.cs)if(c.t>=s&&c.t<e)ts.add(c.t);
  const st=[...ts].sort((a,b)=>a-b);const pos=new Map<string,P>();const tr:T[]=[];
  for(const t of st){const cl=new Set<string>();
    for(const[p,ps]of pos){const d=pdm.get(p)!;const bi=d.tm.get(t)??-1;if(bi<0)continue;const b=d.cs[bi];const sp=SP[p]??4e-4;let xp=0;
      if(ps.dir==="long"?b.l<=ps.sl:b.h>=ps.sl){xp=ps.dir==="long"?ps.sl*(1-sp):ps.sl*(1+sp)}
      else if(ps.tp>0&&(ps.dir==="long"?b.h>=ps.tp:b.l<=ps.tp)){xp=ps.dir==="long"?ps.tp*(1-sp):ps.tp*(1+sp)}
      else if(t-ps.et>=24*H){xp=ps.dir==="long"?b.c*(1-sp):b.c*(1+sp)}
      if(xp>0){const fees=10*10*FEE*2;const raw=ps.dir==="long"?(xp/ps.ep-1)*100:(ps.ep/xp-1)*100;tr.push({pair:p,dir:ps.dir,ep:ps.ep,xp,et:ps.et,xt:t,pnl:raw-fees});pos.delete(p);cl.add(p)}}
    for(const[p,d]of pdm){if(p==="BTCUSDT"||pos.has(p)||cl.has(p))continue;const bi=d.tm.get(t)??-1;if(bi<60)continue;
      const dir=sig(d,bi,btc);if(!dir)continue;
      const dc=[...pos.values()].filter(x=>x.dir===dir).length;if(dc>=5)continue;
      const en=d.cs[bi].o;const sp=SP[p]??4e-4;const ent=dir==="long"?en*(1+sp):en*(1-sp);
      pos.set(p,{pair:p,dir,ep:ent,et:t,sl:dir==="long"?ent*0.97:ent*1.03,tp:dir==="long"?ent*1.10:ent*1.08,pk:0})}}
  return tr}

const S=new Date("2025-06-01").getTime(),E=new Date("2026-03-20").getTime(),M=new Date("2025-10-25").getTime(),days=(E-S)/D2;
console.log("Loading...");const pdm=new Map<string,D>();for(const p of[...PP,"BTCUSDT"]){const d=pre(p);if(d)pdm.set(p,d)}const btc=pdm.get("BTCUSDT")!;

const btcUp=(t:number)=>{const bi=btc.tm.get(t);if(!bi||bi<1)return false;const e9=gv(btc.e9,bi-1,btc.cs.length),e21=gv(btc.e21,bi-1,btc.cs.length);return e9!==null&&e21!==null&&e9>e21};
const btcDn=(t:number)=>{const bi=btc.tm.get(t);if(!bi||bi<1)return false;const e9=gv(btc.e9,bi-1,btc.cs.length),e21=gv(btc.e21,bi-1,btc.cs.length);return e9!==null&&e21!==null&&e9<e21};

// Base signal
const baseSig=(d:D,bi:number):("long"|"short"|null)=>{
  const z=bi>0?d.z3[bi-1]:0;let dir:("long"|"short"|null)=z>3?"long":z<-2?"short":null;if(!dir)return null;
  const a=gv(d.adx,bi-1,d.cs.length);if(!a||a<=(dir==="long"?30:20))return null;
  const e9=gv(d.e9,bi-1,d.cs.length),e21=gv(d.e21,bi-1,d.cs.length);if(!e9||!e21||(dir==="long"?e9<=e21:e9>=e21))return null;
  const aN=gv(d.adx,bi-1,d.cs.length)!,aP=gv(d.adx,bi-6,d.cs.length);// vol filter uses ATR but we use ADX slope here
  return dir;
};

const strategies:{name:string;sig:SF}[]=[
  {name:"BASELINE",sig:(d,bi,b)=>{const dir=baseSig(d,bi);if(!dir)return null;const t=d.cs[bi]?.t??0;if(dir==="long"&&!btcUp(t))return null;if(dir==="short"&&!btcDn(t))return null;return dir}},

  // ADX rising (slope > 0 over 3 bars)
  {name:"+ADX-rising",sig:(d,bi,b)=>{const dir=baseSig(d,bi);if(!dir)return null;const t=d.cs[bi]?.t??0;if(dir==="long"&&!btcUp(t))return null;if(dir==="short"&&!btcDn(t))return null;const a1=gv(d.adx,bi-1,d.cs.length),a3=gv(d.adx,bi-4,d.cs.length);if(a1===null||a3===null||a1<=a3)return null;return dir}},

  // ADX rising fast (slope > 2 points)
  {name:"+ADX-rising-fast",sig:(d,bi,b)=>{const dir=baseSig(d,bi);if(!dir)return null;const t=d.cs[bi]?.t??0;if(dir==="long"&&!btcUp(t))return null;if(dir==="short"&&!btcDn(t))return null;const a1=gv(d.adx,bi-1,d.cs.length),a3=gv(d.adx,bi-4,d.cs.length);if(a1===null||a3===null||a1-a3<2)return null;return dir}},

  // BB width expanding (vol expanding)
  {name:"+BBw-expanding",sig:(d,bi,b)=>{const dir=baseSig(d,bi);if(!dir)return null;const t=d.cs[bi]?.t??0;if(dir==="long"&&!btcUp(t))return null;if(dir==="short"&&!btcDn(t))return null;const bw1=gv(d.bbw,bi-1,d.cs.length),bw3=gv(d.bbw,bi-4,d.cs.length);if(bw1===null||bw3===null||bw1<=bw3)return null;return dir}},

  // BB width high (above median ~0.04)
  {name:"+BBw-high",sig:(d,bi,b)=>{const dir=baseSig(d,bi);if(!dir)return null;const t=d.cs[bi]?.t??0;if(dir==="long"&&!btcUp(t))return null;if(dir==="short"&&!btcDn(t))return null;const bw=gv(d.bbw,bi-1,d.cs.length);if(bw===null||bw<0.05)return null;return dir}},

  // BTC ADX also rising (both trending)
  {name:"+BTC-ADX-rising",sig:(d,bi,b)=>{const dir=baseSig(d,bi);if(!dir)return null;const t=d.cs[bi]?.t??0;if(dir==="long"&&!btcUp(t))return null;if(dir==="short"&&!btcDn(t))return null;const bbi=b.tm.get(t);if(!bbi||bbi<4)return null;const ba1=gv(b.adx,bbi-1,b.cs.length),ba3=gv(b.adx,bbi-4,b.cs.length);if(ba1===null||ba3===null||ba1<=ba3)return null;return dir}},

  // Combined: ADX rising + BBw expanding
  {name:"+ADXrise+BBwExp",sig:(d,bi,b)=>{const dir=baseSig(d,bi);if(!dir)return null;const t=d.cs[bi]?.t??0;if(dir==="long"&&!btcUp(t))return null;if(dir==="short"&&!btcDn(t))return null;const a1=gv(d.adx,bi-1,d.cs.length),a3=gv(d.adx,bi-4,d.cs.length);if(a1===null||a3===null||a1<=a3)return null;const bw1=gv(d.bbw,bi-1,d.cs.length),bw3=gv(d.bbw,bi-4,d.cs.length);if(bw1===null||bw3===null||bw1<=bw3)return null;return dir}},

  // Hurst approximation: variance ratio test
  {name:"+variance-ratio",sig:(d,bi,b)=>{const dir=baseSig(d,bi);if(!dir)return null;const t=d.cs[bi]?.t??0;if(dir==="long"&&!btcUp(t))return null;if(dir==="short"&&!btcDn(t))return null;
    // Simple variance ratio: var(2-bar returns) / (2 * var(1-bar returns))
    // VR > 1 = trending, VR < 1 = mean-reverting
    if(bi<22)return null;const rets1:number[]=[];const rets2:number[]=[];
    for(let i=bi-20;i<bi;i++){rets1.push(d.cs[i].c/d.cs[i-1].c-1);if(i>bi-19)rets2.push(d.cs[i].c/d.cs[i-2].c-1)}
    const v1=rets1.reduce((s,r)=>s+r*r,0)/rets1.length;const v2=rets2.reduce((s,r)=>s+r*r,0)/rets2.length;
    const vr=v1>0?v2/(2*v1):1;if(vr<1.1)return null;return dir}},
];

console.log(`\nTesting ${strategies.length} regime filters\n`);
console.log("Strategy                 Trades  T/day  WR%    PnL        $/day  Sharpe  MaxDD   Train   Test");
console.log("-".repeat(110));

for(const{name,sig}of strategies){
  const tr=sim(name,sig,pdm,btc,S,E);
  const pnl=tr.reduce((s,t)=>s+t.pnl,0);const w=tr.filter(t=>t.pnl>0).length;
  let cum=0,pk=0,dd=0;const dp=new Map<number,number>();
  for(const t of tr){cum+=t.pnl;if(cum>pk)pk=cum;if(pk-cum>dd)dd=pk-cum;dp.set(Math.floor(t.xt/D2),(dp.get(Math.floor(t.xt/D2))||0)+t.pnl)}
  const dr=[...dp.values()];const avg=dr.reduce((s,r)=>s+r,0)/Math.max(dr.length,1);
  const std=Math.sqrt(dr.reduce((s,r)=>s+(r-avg)**2,0)/Math.max(dr.length-1,1));
  const sh=std>0?(avg/std)*Math.sqrt(252):0;
  const trn=sim(name,sig,pdm,btc,S,M);const tst=sim(name,sig,pdm,btc,M,E);
  const trnD=trn.reduce((a,t)=>a+t.pnl,0)/((M-S)/D2);const tstD=tst.reduce((a,t)=>a+t.pnl,0)/((E-M)/D2);
  const p=pnl>=0?`+$${pnl.toFixed(0)}`:`-$${Math.abs(pnl).toFixed(0)}`;
  console.log(`${name.padEnd(24)} ${String(tr.length).padStart(6)}  ${(tr.length/days).toFixed(1).padStart(5)}  ${(tr.length>0?w/tr.length*100:0).toFixed(1).padStart(5)}  ${p.padStart(8)}  ${("$"+(pnl/days).toFixed(2)).padStart(6)}  ${sh.toFixed(2).padStart(6)}  ${("$"+dd.toFixed(0)).padStart(6)}  $${trnD.toFixed(2).padStart(5)}  $${tstD.toFixed(2).padStart(5)}`);
}
