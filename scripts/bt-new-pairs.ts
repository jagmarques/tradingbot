import * as fs from "fs";import * as path from "path";import{ADX,EMA,ATR}from"technicalindicators";
interface C{t:number;o:number;h:number;l:number;c:number}
interface P{pair:string;dir:"long"|"short";ep:number;et:number;sl:number;tp:number}
interface T{pair:string;pnl:number;et:number;xt:number}
interface D{cs:C[];tm:Map<number,number>;z3:number[];adx:number[];e9:number[];e21:number[];atr:number[]}
const CD="/tmp/bt-pair-cache",H=3600000,DAY=86400000,FEE=0.00035,SZ=20,LEV=10;
const SP_DEFAULT=4e-4;
function ld(p:string):C[]{const f=path.join(CD,p+".json");if(!fs.existsSync(f))return[];return(JSON.parse(fs.readFileSync(f,"utf8"))as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b)}
function gv(a:number[],i:number,l:number):number|null{const x=i-(l-a.length);return x>=0&&x<a.length?a[x]:null}
function zsc(cs:C[]):number[]{const r=new Array(cs.length).fill(0);for(let i=21;i<cs.length;i++){const m=cs[i].c/cs[i-3].c-1;let s=0,n=0;for(let j=Math.max(1,i-19);j<=i;j++){s+=(cs[j].c/cs[j-1].c-1)**2;n++}if(n<10)continue;const v=Math.sqrt(s/n);if(v>0)r[i]=m/v}return r}
function pre(p:string):D|null{const cs=ld(p);if(cs.length<200)return null;const tm=new Map<number,number>();cs.forEach((x,i)=>tm.set(x.t,i));const cl=cs.map(x=>x.c),hi=cs.map(x=>x.h),lo=cs.map(x=>x.l);return{cs,tm,z3:zsc(cs),adx:ADX.calculate({close:cl,high:hi,low:lo,period:14}).map(a=>a.adx),e9:EMA.calculate({period:9,values:cl}),e21:EMA.calculate({period:21,values:cl}),atr:ATR.calculate({period:14,high:hi,low:lo,close:cl})}}

// Test each pair individually with v2 params
const NEW_10X = ["SOLUSDT","BNBUSDT","INJUSDT","kPEPEUSDT","AAVEUSDT","MKRUSDT","kSHIBUSDT","TIAUSDT","NEARUSDT","kBONKUSDT","JUPUSDT","ONDOUSDT","HYPEUSDT"];

const S=new Date("2025-06-01").getTime(),E=new Date("2026-03-20").getTime(),days=(E-S)/DAY,M=new Date("2025-10-25").getTime();
console.log("Loading BTC...");
const btc=pre("BTCUSDT")!;
const bd=(t:number):"long"|"short"|null=>{const bi=btc.tm.get(t);if(!bi||bi<1)return null;const e9=gv(btc.e9,bi-1,btc.cs.length),e21=gv(btc.e21,bi-1,btc.cs.length);return e9!==null&&e21!==null?(e9>e21?"long":"short"):null};

function simPair(pair:string,pd:D):T[]{
  const ts:number[]=[];for(const c of pd.cs)if(c.t>=S&&c.t<E)ts.push(c.t);
  ts.sort((a,b)=>a-b);const pos=new Map<string,P>();const tr:T[]=[];
  for(const t of ts){const cl=new Set<string>();
    for(const[p,ps]of pos){const bi=pd.tm.get(t)??-1;if(bi<0)continue;const b=pd.cs[bi];const sp=SP_DEFAULT;let xp=0;
      if(ps.dir==="long"?b.l<=ps.sl:b.h>=ps.sl)xp=ps.dir==="long"?ps.sl*(1-sp):ps.sl*(1+sp);
      else if(ps.tp>0&&(ps.dir==="long"?b.h>=ps.tp:b.l<=ps.tp))xp=ps.dir==="long"?ps.tp*(1-sp):ps.tp*(1+sp);
      else if(t-ps.et>=48*H)xp=ps.dir==="long"?b.c*(1-sp):b.c*(1+sp);
      if(xp>0){const raw=ps.dir==="long"?(xp/ps.ep-1)*SZ*LEV:(ps.ep/xp-1)*SZ*LEV;tr.push({pair:p,pnl:raw-SZ*LEV*FEE*2,et:ps.et,xt:t});pos.delete(p);cl.add(p)}}
    if(pos.has(pair)||cl.has(pair))continue;
    const bi=pd.tm.get(t)??-1;if(bi<60)continue;
    const z=pd.z3[bi-1]||0;let dir:"long"|"short"|null=null;
    if(z>4.5)dir="long";else if(z<-3.0)dir="short";if(!dir)continue;
    const adx=gv(pd.adx,bi-1,pd.cs.length);if(!adx||adx<=(dir==="long"?30:25))continue;
    const e9=gv(pd.e9,bi-1,pd.cs.length),e21=gv(pd.e21,bi-1,pd.cs.length);if(!e9||!e21||(dir==="long"?e9<=e21:e9>=e21))continue;
    const aN=gv(pd.atr,bi-1,pd.cs.length),aP=gv(pd.atr,bi-6,pd.cs.length);if(aN&&aP&&aN<aP*0.9)continue;
    const bt=bd(t);if(!bt||bt!==dir)continue;
    const en=pd.cs[bi].c;const sp=SP_DEFAULT;const ent=dir==="long"?en*(1+sp):en*(1-sp);
    pos.set(pair,{pair,dir,ep:ent,et:t,sl:dir==="long"?ent*0.97:ent*1.03,tp:dir==="long"?ent*1.10:ent*0.90})}
  return tr}

console.log("\nPair         Candles  InRange  Trades  WR%    PnL       $/trade  Train   Test    Verdict");
console.log("-".repeat(100));

for(const pair of NEW_10X){
  const pd=pre(pair);
  if(!pd){console.log(`${pair.replace("USDT","").padEnd(12)} NO DATA`);continue}
  const inRange=pd.cs.filter(c=>c.t>=S&&c.t<E).length;
  const tr=simPair(pair,pd);
  if(tr.length===0){console.log(`${pair.replace("USDT","").padEnd(12)} ${String(pd.cs.length).padStart(6)}  ${String(inRange).padStart(7)}       0  -       -         -        -       -       SKIP (no signals)`);continue}
  const pnl=tr.reduce((s,t)=>s+t.pnl,0);const w=tr.filter(t=>t.pnl>0).length;
  const trnTr=tr.filter(t=>t.xt<M);const tstTr=tr.filter(t=>t.xt>=M);
  const trnPnl=trnTr.reduce((s,t)=>s+t.pnl,0);const tstPnl=tstTr.reduce((s,t)=>s+t.pnl,0);
  const verdict=pnl>0&&tstPnl>0?"ADD":pnl>0?"MAYBE":"SKIP";
  console.log(
    `${pair.replace("USDT","").padEnd(12)} ${String(pd.cs.length).padStart(6)}  ${String(inRange).padStart(7)}  ${String(tr.length).padStart(6)}  ${(w/tr.length*100).toFixed(1).padStart(5)}  ${(pnl>=0?"+":"")}$${pnl.toFixed(0).padStart(5)}  ${(pnl>=0?"+":"")}$${(pnl/tr.length).toFixed(2).padStart(6)}  ${(trnPnl>=0?"+":"")}$${trnPnl.toFixed(0).padStart(5)}  ${(tstPnl>=0?"+":"")}$${tstPnl.toFixed(0).padStart(5)}  ${verdict}`
  );
}

// Also re-test existing 15 pairs for comparison
console.log("\n--- Existing 15 pairs for comparison ---");
const EXISTING=["OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","TRUMPUSDT","DASHUSDT","DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","LINKUSDT","ADAUSDT","WLDUSDT","XRPUSDT","UNIUSDT"];
for(const pair of EXISTING){
  const pd=pre(pair);if(!pd)continue;
  const tr=simPair(pair,pd);if(tr.length===0)continue;
  const pnl=tr.reduce((s,t)=>s+t.pnl,0);const w=tr.filter(t=>t.pnl>0).length;
  const trnTr=tr.filter(t=>t.xt<M);const tstTr=tr.filter(t=>t.xt>=M);
  const trnPnl=trnTr.reduce((s,t)=>s+t.pnl,0);const tstPnl=tstTr.reduce((s,t)=>s+t.pnl,0);
  console.log(`${pair.replace("USDT","").padEnd(12)} ${String(tr.length).padStart(6)}  ${(w/tr.length*100).toFixed(1).padStart(5)}  ${(pnl>=0?"+":"")}$${pnl.toFixed(0).padStart(5)}  ${(pnl>=0?"+":"")}$${(pnl/tr.length).toFixed(2).padStart(6)}  ${(trnPnl>=0?"+":"")}$${trnPnl.toFixed(0).padStart(5)}  ${(tstPnl>=0?"+":"")}$${tstPnl.toFixed(0).padStart(5)}`);
}
