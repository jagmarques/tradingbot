import * as fs from "fs";import * as path from "path";import{ADX,EMA,ATR}from"technicalindicators";
interface C{t:number;o:number;h:number;l:number;c:number}
interface P{pair:string;dir:"long"|"short";ep:number;et:number;sl:number;tp:number;sz:number}
interface T{pnl:number;et:number;xt:number;sz:number}
interface D{cs:C[];tm:Map<number,number>;z3:number[];adx:number[];e9:number[];e21:number[];atr:number[]}
const CD="/tmp/bt-pair-cache",H=3600000,DAY=86400000,FEE=0.00035,LEV=10;
const KEEP=["OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","TRUMPUSDT","DASHUSDT","DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","LINKUSDT","ADAUSDT","WLDUSDT","XRPUSDT","UNIUSDT"];
const SP:Record<string,number>={XRPUSDT:1.05e-4,DOGEUSDT:1.35e-4,ARBUSDT:2.6e-4,ENAUSDT:2.55e-4,UNIUSDT:2.75e-4,APTUSDT:3.2e-4,LINKUSDT:3.45e-4,TRUMPUSDT:3.65e-4,WLDUSDT:4e-4,DOTUSDT:4.95e-4,WIFUSDT:5.05e-4,ADAUSDT:5.55e-4,LDOUSDT:5.8e-4,OPUSDT:6.2e-4,DASHUSDT:7.15e-4,BTCUSDT:0.5e-4};
function ld(p:string):C[]{const f=path.join(CD,p+".json");if(!fs.existsSync(f))return[];return(JSON.parse(fs.readFileSync(f,"utf8"))as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b)}
function gv(a:number[],i:number,l:number):number|null{const x=i-(l-a.length);return x>=0&&x<a.length?a[x]:null}
function zsc(cs:C[]):number[]{const r=new Array(cs.length).fill(0);for(let i=21;i<cs.length;i++){const m=cs[i].c/cs[i-3].c-1;let s=0,n=0;for(let j=Math.max(1,i-19);j<=i;j++){s+=(cs[j].c/cs[j-1].c-1)**2;n++}if(n<10)continue;const v=Math.sqrt(s/n);if(v>0)r[i]=m/v}return r}
function pre(p:string):D|null{const cs=ld(p);if(cs.length<200)return null;const tm=new Map<number,number>();cs.forEach((x,i)=>tm.set(x.t,i));const cl=cs.map(x=>x.c),hi=cs.map(x=>x.h),lo=cs.map(x=>x.l);return{cs,tm,z3:zsc(cs),adx:ADX.calculate({close:cl,high:hi,low:lo,period:14}).map(a=>a.adx),e9:EMA.calculate({period:9,values:cl}),e21:EMA.calculate({period:21,values:cl}),atr:ATR.calculate({period:14,high:hi,low:lo,close:cl})}}

function sim(mode:"fixed"|"compound",startEquity:number,fixedSz:number,riskPct:number,pdm:Map<string,D>,btc:D,s:number,e:number):{trades:T[],finalEq:number,minEq:number}{
  const ts=new Set<number>();for(const p of KEEP){const d=pdm.get(p);if(d)for(const c of d.cs)if(c.t>=s&&c.t<e)ts.add(c.t)}
  const st=[...ts].sort((a,b)=>a-b);const pos=new Map<string,P>();const tr:T[]=[];
  let equity=startEquity;let minEq=startEquity;let peakEq=startEquity;
  const bd=(t:number):"long"|"short"|null=>{const bi=btc.tm.get(t);if(!bi||bi<1)return null;const e9=gv(btc.e9,bi-1,btc.cs.length),e21=gv(btc.e21,bi-1,btc.cs.length);return e9!==null&&e21!==null?(e9>e21?"long":"short"):null};
  for(const t of st){const cl=new Set<string>();
    for(const[p,ps]of pos){const d=pdm.get(p)!;const bi=d.tm.get(t)??-1;if(bi<0)continue;const b=d.cs[bi];const sp=SP[p]??4e-4;let xp=0;
      if(ps.dir==="long"?b.l<=ps.sl:b.h>=ps.sl)xp=ps.dir==="long"?ps.sl*(1-sp):ps.sl*(1+sp);
      else if(ps.tp>0&&(ps.dir==="long"?b.h>=ps.tp:b.l<=ps.tp))xp=ps.dir==="long"?ps.tp*(1-sp):ps.tp*(1+sp);
      else if(t-ps.et>=48*H)xp=ps.dir==="long"?b.c*(1-sp):b.c*(1+sp);
      if(xp>0){const raw=ps.dir==="long"?(xp/ps.ep-1)*ps.sz*LEV:(ps.ep/xp-1)*ps.sz*LEV;const pnl=raw-ps.sz*LEV*FEE*2;
        tr.push({pnl,et:ps.et,xt:t,sz:ps.sz});equity+=pnl;if(equity<minEq)minEq=equity;if(equity>peakEq)peakEq=equity;
        pos.delete(p);cl.add(p)}}
    for(const p of KEEP){const d=pdm.get(p);if(!d||pos.has(p)||cl.has(p))continue;const bi=d.tm.get(t)??-1;if(bi<60)continue;
      const z=d.z3[bi-1]||0;let dir:"long"|"short"|null=null;
      if(z>4.5)dir="long";else if(z<-3.0)dir="short";if(!dir)continue;
      const adx=gv(d.adx,bi-1,d.cs.length);if(!adx||adx<=(dir==="long"?30:25))continue;
      const e9=gv(d.e9,bi-1,d.cs.length),e21=gv(d.e21,bi-1,d.cs.length);if(!e9||!e21||(dir==="long"?e9<=e21:e9>=e21))continue;
      const aN=gv(d.atr,bi-1,d.cs.length),aP=gv(d.atr,bi-6,d.cs.length);if(aN&&aP&&aN<aP*0.9)continue;
      const bt=bd(t);if(!bt||bt!==dir)continue;
      const dc=[...pos.values()].filter(x=>x.dir===dir).length;if(dc>=4)continue;
      // Position sizing
      let sz:number;
      if(mode==="fixed"){sz=fixedSz}
      else{
        // Compound: risk X% of equity per trade. With 3% SL at 10x, loss = sz * 10 * 0.03 = sz * 0.3
        // To risk riskPct% of equity: sz * 0.3 = equity * riskPct/100 => sz = equity * riskPct / 30
        sz=Math.max(10,Math.min(100,Math.floor(equity*riskPct/30)));
      }
      const en=d.cs[bi].o;const sp=SP[p]??4e-4;const ent=dir==="long"?en*(1+sp):en*(1-sp);
      pos.set(p,{pair:p,dir,ep:ent,et:t,sl:dir==="long"?ent*0.97:ent*1.03,tp:dir==="long"?ent*1.10:ent*0.90,sz})}}
  return{trades:tr,finalEq:equity,minEq}}

const S=new Date("2025-06-01").getTime(),E=new Date("2026-03-20").getTime(),days=(E-S)/DAY;
const pdm=new Map<string,D>();for(const p of[...KEEP,"BTCUSDT"]){const d=pre(p);if(d)pdm.set(p,d)}const btc=pdm.get("BTCUSDT")!;

console.log("Starting equity: $200\n");

const configs=[
  {name:"Fixed $20",mode:"fixed" as const,sz:20,risk:0},
  {name:"Compound 3% risk",mode:"compound" as const,sz:0,risk:3},
  {name:"Compound 4% risk",mode:"compound" as const,sz:0,risk:4},
  {name:"Compound 5% risk",mode:"compound" as const,sz:0,risk:5},
  {name:"Compound 2% risk",mode:"compound" as const,sz:0,risk:2},
  {name:"Fixed $10",mode:"fixed" as const,sz:10,risk:0},
  {name:"Fixed $30",mode:"fixed" as const,sz:30,risk:0},
  {name:"Fixed $40",mode:"fixed" as const,sz:40,risk:0},
];

console.log("Strategy            Trades  WR%    TotalPnL   $/day  FinalEq  MinEq   MaxDD%  AvgSize");
console.log("-".repeat(95));

for(const c of configs){
  const{trades:tr,finalEq,minEq}=sim(c.mode,200,c.sz,c.risk,pdm,btc,S,E);
  const pnl=tr.reduce((s,t)=>s+t.pnl,0);const w=tr.filter(t=>t.pnl>0).length;
  const avgSz=tr.length>0?tr.reduce((s,t)=>s+t.sz,0)/tr.length:0;
  let cum=200,pk=200,maxDd=0;
  for(const t of tr){cum+=t.pnl;if(cum>pk)pk=cum;if((pk-cum)/pk*100>maxDd)maxDd=(pk-cum)/pk*100}
  console.log(
    `${c.name.padEnd(19)} ${String(tr.length).padStart(6)}  ${(tr.length>0?w/tr.length*100:0).toFixed(1).padStart(5)}  ${("+$"+pnl.toFixed(0)).padStart(10)}  ${("$"+(pnl/days).toFixed(2)).padStart(6)}  ${("$"+finalEq.toFixed(0)).padStart(7)}  ${("$"+minEq.toFixed(0)).padStart(6)}  ${(maxDd.toFixed(1)+"%").padStart(7)}  ${("$"+avgSz.toFixed(0)).padStart(7)}`
  );
}

// Monthly equity curve for compound 3%
console.log("\n=== MONTHLY EQUITY CURVE: Compound 3% risk ===\n");
const{trades:ctr}=sim("compound",200,0,3,pdm,btc,S,E);
let eq=200;
const monthly=new Map<string,{startEq:number,endEq:number,pnl:number,trades:number}>();
let curMonth="";
for(const t of ctr){
  const m=new Date(t.xt).toISOString().slice(0,7);
  if(m!==curMonth){if(curMonth)monthly.get(curMonth)!.endEq=eq;curMonth=m;monthly.set(m,{startEq:eq,endEq:eq,pnl:0,trades:0})}
  eq+=t.pnl;const d=monthly.get(m)!;d.pnl+=t.pnl;d.trades++;d.endEq=eq;
}
if(curMonth)monthly.get(curMonth)!.endEq=eq;

console.log("Month     StartEq  EndEq    PnL      Trades  AvgSz");
for(const[m,d]of[...monthly.entries()].sort()){
  // Recalculate avg size for this month
  const mTrades=ctr.filter(t=>new Date(t.xt).toISOString().slice(0,7)===m);
  const avgSz=mTrades.length>0?mTrades.reduce((s,t)=>s+t.sz,0)/mTrades.length:0;
  console.log(`${m}   $${d.startEq.toFixed(0).padStart(6)}  $${d.endEq.toFixed(0).padStart(6)}  ${(d.pnl>=0?"+":"")}$${d.pnl.toFixed(0).padStart(5)}  ${String(d.trades).padStart(6)}  $${avgSz.toFixed(0).padStart(4)}`);
}
