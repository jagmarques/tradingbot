import * as fs from "fs";import * as path from "path";import{ADX,EMA,ATR}from"technicalindicators";
interface C{t:number;o:number;h:number;l:number;c:number}
interface P{pair:string;dir:"long"|"short";ep:number;et:number;sl:number;tp:number;pk:number}
interface T{pnl:number;et:number;xt:number;reason:string}
interface D{cs:C[];tm:Map<number,number>;z3:number[];adx:number[];e9:number[];e21:number[];atr:number[]}
const CD="/tmp/bt-pair-cache",H=3600000,DAY=86400000,FEE=0.00035,SZ=20,LEV=10;
const PP=["OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","AVAXUSDT","TRUMPUSDT","DASHUSDT","DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","SEIUSDT","LINKUSDT","ADAUSDT","WLDUSDT","XRPUSDT","SUIUSDT","TONUSDT","UNIUSDT"];
const SP:Record<string,number>={XRPUSDT:1.05e-4,DOGEUSDT:1.35e-4,SUIUSDT:1.85e-4,AVAXUSDT:2.55e-4,ARBUSDT:2.6e-4,ENAUSDT:2.55e-4,UNIUSDT:2.75e-4,APTUSDT:3.2e-4,LINKUSDT:3.45e-4,TRUMPUSDT:3.65e-4,WLDUSDT:4e-4,SEIUSDT:4.4e-4,TONUSDT:4.6e-4,DOTUSDT:4.95e-4,WIFUSDT:5.05e-4,ADAUSDT:5.55e-4,LDOUSDT:5.8e-4,OPUSDT:6.2e-4,DASHUSDT:7.15e-4,BTCUSDT:0.5e-4};
function ld(p:string):C[]{const f=path.join(CD,p+".json");if(!fs.existsSync(f))return[];return(JSON.parse(fs.readFileSync(f,"utf8"))as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b)}
function gv(a:number[],i:number,l:number):number|null{const x=i-(l-a.length);return x>=0&&x<a.length?a[x]:null}
function zsc(cs:C[]):number[]{const r=new Array(cs.length).fill(0);for(let i=21;i<cs.length;i++){const m=cs[i].c/cs[i-3].c-1;let s=0,n=0;for(let j=Math.max(1,i-19);j<=i;j++){s+=(cs[j].c/cs[j-1].c-1)**2;n++}if(n<10)continue;const v=Math.sqrt(s/n);if(v>0)r[i]=m/v}return r}
function pre(p:string):D|null{const cs=ld(p);if(cs.length<200)return null;const tm=new Map<number,number>();cs.forEach((x,i)=>tm.set(x.t,i));const cl=cs.map(x=>x.c),hi=cs.map(x=>x.h),lo=cs.map(x=>x.l);return{cs,tm,z3:zsc(cs),adx:ADX.calculate({close:cl,high:hi,low:lo,period:14}).map(a=>a.adx),e9:EMA.calculate({period:9,values:cl}),e21:EMA.calculate({period:21,values:cl}),atr:ATR.calculate({period:14,high:hi,low:lo,close:cl})}}

function sim(pdm:Map<string,D>,btc:D,s:number,e:number,tp:number,trA:number,trD:number):T[]{
  const ts=new Set<number>();for(const d of pdm.values())for(const x of d.cs)if(x.t>=s&&x.t<e)ts.add(x.t);
  const st=[...ts].sort((a,b)=>a-b);const pos=new Map<string,P>();const tr:T[]=[];
  const bd=(t:number):"long"|"short"|null=>{const bi=btc.tm.get(t);if(!bi||bi<1)return null;const e9=gv(btc.e9,bi-1,btc.cs.length),e21=gv(btc.e21,bi-1,btc.cs.length);return e9!==null&&e21!==null?(e9>e21?"long":"short"):null};
  for(const t of st){const cl=new Set<string>();
    for(const[p,ps]of pos){const d=pdm.get(p)!;const bi=d.tm.get(t)??-1;if(bi<0)continue;const b=d.cs[bi];const sp=SP[p]??4e-4;let xp=0,reason="";
      if(ps.dir==="long"?b.l<=ps.sl:b.h>=ps.sl){xp=ps.dir==="long"?ps.sl*(1-sp):ps.sl*(1+sp);reason="sl"}
      if(!reason&&ps.tp>0&&(ps.dir==="long"?b.h>=ps.tp:b.l<=ps.tp)){xp=ps.dir==="long"?ps.tp*(1-sp):ps.tp*(1+sp);reason="tp"}
      if(!reason&&trA>0){const pp=ps.dir==="long"?(b.c-ps.ep)/ps.ep*LEV*100:(ps.ep-b.c)/ps.ep*LEV*100;if(pp>ps.pk)ps.pk=pp;if(ps.pk>=trA&&pp<=ps.pk-trD){xp=ps.dir==="long"?b.c*(1-sp):b.c*(1+sp);reason="trail"}}
      if(!reason&&t-ps.et>=48*H){xp=ps.dir==="long"?b.c*(1-sp):b.c*(1+sp);reason="mh"}
      if(xp>0){const raw=ps.dir==="long"?(xp/ps.ep-1)*SZ*LEV:(ps.ep/xp-1)*SZ*LEV;tr.push({pnl:raw-SZ*LEV*FEE*2,et:ps.et,xt:t,reason});pos.delete(p);cl.add(p)}}
    for(const[p,d]of pdm){if(p==="BTCUSDT"||pos.has(p)||cl.has(p))continue;const bi=d.tm.get(t)??-1;if(bi<60)continue;
      const z=d.z3[bi-1]||0;let dir:"long"|"short"|null=null;
      if(z>4.5)dir="long";else if(z<-3.0)dir="short";if(!dir)continue;
      const adx=gv(d.adx,bi-1,d.cs.length);if(!adx||adx<=(dir==="long"?30:25))continue;
      const e9=gv(d.e9,bi-1,d.cs.length),e21=gv(d.e21,bi-1,d.cs.length);if(!e9||!e21||(dir==="long"?e9<=e21:e9>=e21))continue;
      const aN=gv(d.atr,bi-1,d.cs.length),aP=gv(d.atr,bi-6,d.cs.length);if(aN&&aP&&aN<aP*0.9)continue;
      const bt=bd(t);if(!bt||bt!==dir)continue;
      const dc=[...pos.values()].filter(x=>x.dir===dir).length;if(dc>=4)continue;
      const en=d.cs[bi].o;const sp=SP[p]??4e-4;const ent=dir==="long"?en*(1+sp):en*(1-sp);
      pos.set(p,{pair:p,dir,ep:ent,et:t,sl:dir==="long"?ent*0.97:ent*1.03,tp:tp>0?(dir==="long"?ent*(1+tp):ent*(1-tp)):0,pk:0})}}
  return tr}

const S=new Date("2025-06-01").getTime(),E=new Date("2026-03-20").getTime(),days=(E-S)/DAY,M=new Date("2025-10-25").getTime();
console.log("Loading...");const pdm=new Map<string,D>();for(const p of[...PP,"BTCUSDT"]){const d=pre(p);if(d)pdm.set(p,d)}const btc=pdm.get("BTCUSDT")!;

const configs=[
  {name:"TP15+Trail8/2",tp:0.15,trA:8,trD:2},
  {name:"TP10-noTrail (prev best)",tp:0.10,trA:0,trD:0},
  {name:"TP15-noTrail",tp:0.15,trA:0,trD:0},
  {name:"TP15+Trail5/2",tp:0.15,trA:5,trD:2},
  {name:"TP15+Trail10/3",tp:0.15,trA:10,trD:3},
  {name:"noTP+Trail8/2",tp:0,trA:8,trD:2},
];

console.log("\nz=4.5/3.0, ADX 30/25, SL 3%, $20/trade, max 4/dir, 48h hold\n");
console.log("Config                    Trades  T/day  WR%    PnL       $/day  Sharpe  MaxDD   Train   Test   Exits");
console.log("-".repeat(120));

for(const c of configs){
  const tr=sim(pdm,btc,S,E,c.tp,c.trA,c.trD);
  const pnl=tr.reduce((s,t)=>s+t.pnl,0);const w=tr.filter(t=>t.pnl>0).length;
  let cum=0,pk=0,dd=0;const dp=new Map<number,number>();
  for(const t of tr){cum+=t.pnl;if(cum>pk)pk=cum;if(pk-cum>dd)dd=pk-cum;dp.set(Math.floor(t.xt/DAY),(dp.get(Math.floor(t.xt/DAY))||0)+t.pnl)}
  const dr=[...dp.values()];const avg=dr.reduce((s,r)=>s+r,0)/Math.max(dr.length,1);
  const std=Math.sqrt(dr.reduce((s,r)=>s+(r-avg)**2,0)/Math.max(dr.length-1,1));
  const sh=std>0?(avg/std)*Math.sqrt(252):0;
  const trn=sim(pdm,btc,S,M,c.tp,c.trA,c.trD);const tst=sim(pdm,btc,M,E,c.tp,c.trA,c.trD);
  const trnD=trn.reduce((a,t)=>a+t.pnl,0)/((M-S)/DAY);const tstD=tst.reduce((a,t)=>a+t.pnl,0)/((E-M)/DAY);
  // Exit breakdown
  const exits=new Map<string,number>();for(const t of tr){exits.set(t.reason,(exits.get(t.reason)||0)+1)}
  const exitStr=[...exits.entries()].map(([r,n])=>`${r}:${n}`).join(" ");
  const p=pnl>=0?`+$${pnl.toFixed(0)}`:`-$${Math.abs(pnl).toFixed(0)}`;
  console.log(`${c.name.padEnd(25)} ${String(tr.length).padStart(6)}  ${(tr.length/days).toFixed(1).padStart(5)}  ${(tr.length>0?w/tr.length*100:0).toFixed(1).padStart(5)}  ${p.padStart(8)}  ${("$"+(pnl/days).toFixed(2)).padStart(6)}  ${sh.toFixed(2).padStart(6)}  ${("$"+dd.toFixed(0)).padStart(6)}  $${trnD.toFixed(2).padStart(5)}  $${tstD.toFixed(2).padStart(5)}   ${exitStr}`);
}
