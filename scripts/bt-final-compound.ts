import * as fs from "fs";import * as path from "path";import{ADX,EMA,ATR}from"technicalindicators";
interface C{t:number;o:number;h:number;l:number;c:number}
interface P{pair:string;dir:"long"|"short";ep:number;et:number;sl:number;tp:number;sz:number}
interface T{pair:string;pnl:number;et:number;xt:number;sz:number}
interface D{cs:C[];tm:Map<number,number>;z3:number[];adx:number[];e9:number[];e21:number[];atr:number[]}
const CD="/tmp/bt-pair-cache",H=3600000,DAY=86400000,FEE=0.00035,LEV=10;
const SP:Record<string,number>={XRPUSDT:1.05e-4,DOGEUSDT:1.35e-4,ARBUSDT:2.6e-4,ENAUSDT:2.55e-4,UNIUSDT:2.75e-4,APTUSDT:3.2e-4,LINKUSDT:3.45e-4,TRUMPUSDT:3.65e-4,WLDUSDT:4e-4,DOTUSDT:4.95e-4,WIFUSDT:5.05e-4,ADAUSDT:5.55e-4,LDOUSDT:5.8e-4,OPUSDT:6.2e-4,DASHUSDT:7.15e-4,BTCUSDT:0.5e-4};
function ld(p:string):C[]{const f=path.join(CD,p+".json");if(!fs.existsSync(f))return[];return(JSON.parse(fs.readFileSync(f,"utf8"))as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b)}
function gv(a:number[],i:number,l:number):number|null{const x=i-(l-a.length);return x>=0&&x<a.length?a[x]:null}
function zsc(cs:C[]):number[]{const r=new Array(cs.length).fill(0);for(let i=21;i<cs.length;i++){const m=cs[i].c/cs[i-3].c-1;let s=0,n=0;for(let j=Math.max(1,i-19);j<=i;j++){s+=(cs[j].c/cs[j-1].c-1)**2;n++}if(n<10)continue;const v=Math.sqrt(s/n);if(v>0)r[i]=m/v}return r}
function pre(p:string):D|null{const cs=ld(p);if(cs.length<200)return null;const tm=new Map<number,number>();cs.forEach((x,i)=>tm.set(x.t,i));const cl=cs.map(x=>x.c),hi=cs.map(x=>x.h),lo=cs.map(x=>x.l);return{cs,tm,z3:zsc(cs),adx:ADX.calculate({close:cl,high:hi,low:lo,period:14}).map(a=>a.adx),e9:EMA.calculate({period:9,values:cl}),e21:EMA.calculate({period:21,values:cl}),atr:ATR.calculate({period:14,high:hi,low:lo,close:cl})}}

function sim(pairs:string[],maxDir:number,riskPct:number,pdm:Map<string,D>,btc:D,s:number,e:number):{tr:T[],finalEq:number,minEq:number}{
  const pds=new Map<string,D>();for(const p of pairs){const d=pdm.get(p);if(d)pds.set(p,d)}
  const ts=new Set<number>();for(const d of pds.values())for(const c of d.cs)if(c.t>=s&&c.t<e)ts.add(c.t);
  const st=[...ts].sort((a,b)=>a-b);const pos=new Map<string,P>();const tr:T[]=[];
  let equity=200,minEq=200;
  const bd=(t:number):"long"|"short"|null=>{const bi=btc.tm.get(t);if(!bi||bi<1)return null;const e9=gv(btc.e9,bi-1,btc.cs.length),e21=gv(btc.e21,bi-1,btc.cs.length);return e9!==null&&e21!==null?(e9>e21?"long":"short"):null};
  for(const t of st){const cl=new Set<string>();
    for(const[p,ps]of pos){const d=pds.get(p)!;const bi=d.tm.get(t)??-1;if(bi<0)continue;const b=d.cs[bi];const sp=SP[p]??4e-4;let xp=0;
      if(ps.dir==="long"?b.l<=ps.sl:b.h>=ps.sl)xp=ps.dir==="long"?ps.sl*(1-sp):ps.sl*(1+sp);
      else if(ps.tp>0&&(ps.dir==="long"?b.h>=ps.tp:b.l<=ps.tp))xp=ps.dir==="long"?ps.tp*(1-sp):ps.tp*(1+sp);
      else if(t-ps.et>=48*H)xp=ps.dir==="long"?b.c*(1-sp):b.c*(1+sp);
      if(xp>0){const raw=ps.dir==="long"?(xp/ps.ep-1)*ps.sz*LEV:(ps.ep/xp-1)*ps.sz*LEV;const pnl=raw-ps.sz*LEV*FEE*2;tr.push({pair:p,pnl,et:ps.et,xt:t,sz:ps.sz});equity+=pnl;if(equity<minEq)minEq=equity;pos.delete(p);cl.add(p)}}
    const sz=Math.max(10,Math.floor(equity*riskPct/30));
    for(const[p,d]of pds){if(pos.has(p)||cl.has(p))continue;const bi=d.tm.get(t)??-1;if(bi<60)continue;
      const z=d.z3[bi-1]||0;let dir:"long"|"short"|null=null;
      if(z>4.5)dir="long";else if(z<-3.0)dir="short";if(!dir)continue;
      const adx=gv(d.adx,bi-1,d.cs.length);if(!adx||adx<=(dir==="long"?30:25))continue;
      const e9=gv(d.e9,bi-1,d.cs.length),e21=gv(d.e21,bi-1,d.cs.length);if(!e9||!e21||(dir==="long"?e9<=e21:e9>=e21))continue;
      const aN=gv(d.atr,bi-1,d.cs.length),aP=gv(d.atr,bi-6,d.cs.length);if(aN&&aP&&aN<aP*0.9)continue;
      const bt=bd(t);if(!bt||bt!==dir)continue;
      if(maxDir>0){const dc=[...pos.values()].filter(x=>x.dir===dir).length;if(dc>=maxDir)continue}
      const en=d.cs[bi].c;const sp=SP[p]??4e-4;const ent=dir==="long"?en*(1+sp):en*(1-sp);
      pos.set(p,{pair:p,dir,ep:ent,et:t,sl:dir==="long"?ent*0.97:ent*1.03,tp:dir==="long"?ent*1.10:ent*0.90,sz})}}
  return{tr,finalEq:equity,minEq}}

const S=new Date("2025-06-01").getTime(),E=new Date("2026-03-20").getTime(),days=(E-S)/DAY,M=new Date("2025-10-25").getTime();
console.log("Loading...");
const pdm=new Map<string,D>();
const ALL=["OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","TRUMPUSDT","DASHUSDT","DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","LINKUSDT","ADAUSDT","WLDUSDT","XRPUSDT","UNIUSDT","SOLUSDT","BNBUSDT","kPEPEUSDT","kSHIBUSDT","TIAUSDT","NEARUSDT","kBONKUSDT","ONDOUSDT","HYPEUSDT","BTCUSDT"];
for(const p of ALL){const d=pre(p);if(d)pdm.set(p,d)}
const btc=pdm.get("BTCUSDT")!;

const P21=["OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","TRUMPUSDT","DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","LINKUSDT","ADAUSDT","WLDUSDT","XRPUSDT","SOLUSDT","BNBUSDT","kSHIBUSDT","TIAUSDT","NEARUSDT","kBONKUSDT","ONDOUSDT","HYPEUSDT"];

// Compound 4%, no cap, 21 pairs, max 6/dir
const{tr,finalEq,minEq}=sim(P21,6,4,pdm,btc,S,E);
const pnl=tr.reduce((s,t)=>s+t.pnl,0);const w=tr.filter(t=>t.pnl>0).length;
let cum=200,pk=200,maxDd=0;const dp=new Map<number,number>();
for(const t of tr){cum+=t.pnl;if(cum>pk)pk=cum;if((pk-cum)/pk*100>maxDd)maxDd=(pk-cum)/pk*100;dp.set(Math.floor(t.xt/DAY),(dp.get(Math.floor(t.xt/DAY))||0)+t.pnl)}

console.log(`\n=== 21 PAIRS, MAX 6/DIR, COMPOUND 4%, NO SIZE CAP ===\n`);
console.log(`Starting equity:  $200`);
console.log(`Final equity:     $${finalEq.toFixed(0)}`);
console.log(`Min equity:       $${minEq.toFixed(0)}`);
console.log(`Max DD%:          ${maxDd.toFixed(1)}%`);
console.log(`Total PnL:        +$${pnl.toFixed(0)}`);
console.log(`Trades:           ${tr.length} (${(tr.length/days).toFixed(1)}/day)`);
console.log(`WR:               ${(w/tr.length*100).toFixed(1)}%`);
console.log(`$/day avg:        $${(pnl/days).toFixed(2)}`);

// Monthly equity curve
console.log(`\n--- MONTHLY EQUITY ---\n`);
let eq=200;const monthly=new Map<string,{start:number,end:number,pnl:number,trades:number}>();let curM="";
for(const t of tr){const m=new Date(t.xt).toISOString().slice(0,7);if(m!==curM){if(curM)monthly.get(curM)!.end=eq;curM=m;monthly.set(m,{start:eq,end:eq,pnl:0,trades:0})}eq+=t.pnl;const d=monthly.get(m)!;d.pnl+=t.pnl;d.trades++;d.end=eq}
if(curM)monthly.get(curM)!.end=eq;
console.log("Month     Start      End        PnL     Trades");
for(const[m,d]of[...monthly.entries()].sort())console.log(`${m}   $${d.start.toFixed(0).padStart(7)}  $${d.end.toFixed(0).padStart(7)}  ${(d.pnl>=0?"+":"")}$${d.pnl.toFixed(0).padStart(6)}  ${String(d.trades).padStart(6)}`);

// Per-pair breakdown
console.log(`\n--- PER PAIR (sorted by PnL) ---\n`);
console.log("Pair         Trades  Wins  Losses  WR%    GrossW    GrossL    NetPnL    $/trade  LossRatio");
console.log("-".repeat(100));
const pairData=new Map<string,{n:number;w:number;l:number;gw:number;gl:number;pnl:number}>();
for(const t of tr){const s=pairData.get(t.pair)||{n:0,w:0,l:0,gw:0,gl:0,pnl:0};s.n++;s.pnl+=t.pnl;if(t.pnl>0){s.w++;s.gw+=t.pnl}else{s.l++;s.gl+=Math.abs(t.pnl)}pairData.set(t.pair,s)}
const sorted=[...pairData.entries()].sort((a,b)=>b[1].pnl-a[1].pnl);
let totalWins=0,totalLosses=0;
for(const[p,s]of sorted){
  const wr=(s.w/s.n*100).toFixed(1);const lr=s.gw>0?(s.gl/s.gw).toFixed(2):"inf";
  const verdict=s.pnl<0?"  <-- REMOVE":"";
  totalWins+=s.w;totalLosses+=s.l;
  console.log(`${p.replace("USDT","").padEnd(12)} ${String(s.n).padStart(6)}  ${String(s.w).padStart(4)}  ${String(s.l).padStart(6)}  ${wr.padStart(5)}  ${("+$"+s.gw.toFixed(0)).padStart(9)}  ${("-$"+s.gl.toFixed(0)).padStart(9)}  ${(s.pnl>=0?"+$":"-$")+(Math.abs(s.pnl).toFixed(0)).padStart(6)}  ${(s.pnl>=0?"+$":"-$")+(Math.abs(s.pnl/s.n).toFixed(2)).padStart(6)}  ${lr.padStart(9)}${verdict}`);
}

// Show what happens if we remove losing pairs
const keepPairs=sorted.filter(([,s])=>s.pnl>0).map(([p])=>p);
const removePairs=sorted.filter(([,s])=>s.pnl<=0).map(([p])=>p);
console.log(`\nProfitable: ${keepPairs.length} pairs`);
console.log(`Losing: ${removePairs.length} pairs: ${removePairs.map(p=>p.replace("USDT","")).join(", ")}`);

// Re-run with only profitable pairs
if(removePairs.length>0){
  const{tr:tr2,finalEq:fe2,minEq:me2}=sim(keepPairs,6,4,pdm,btc,S,E);
  const pnl2=tr2.reduce((s,t)=>s+t.pnl,0);const w2=tr2.filter(t=>t.pnl>0).length;
  let cum2=200,pk2=200,dd2=0;
  for(const t of tr2){cum2+=t.pnl;if(cum2>pk2)pk2=cum2;if((pk2-cum2)/pk2*100>dd2)dd2=(pk2-cum2)/pk2*100}
  console.log(`\n=== WITHOUT LOSING PAIRS (${keepPairs.length} pairs) ===`);
  console.log(`Final equity: $${fe2.toFixed(0)} (was $${finalEq.toFixed(0)})`);
  console.log(`Min equity:   $${me2.toFixed(0)} (was $${minEq.toFixed(0)})`);
  console.log(`Max DD%:      ${dd2.toFixed(1)}% (was ${maxDd.toFixed(1)}%)`);
  console.log(`Trades:       ${tr2.length} (${(tr2.length/days).toFixed(1)}/day)`);
  console.log(`WR:           ${(w2/tr2.length*100).toFixed(1)}%`);
  console.log(`$/day:        $${(pnl2/days).toFixed(2)} (was $${(pnl/days).toFixed(2)})`);
}
