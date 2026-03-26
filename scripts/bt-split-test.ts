import * as fs from "fs";
import * as path from "path";
import { ATR, ADX, EMA } from "technicalindicators";

interface Candle { t: number; o: number; h: number; l: number; c: number; }
interface Position { pair: string; direction: "long"|"short"; entryPrice: number; entryTime: number; size: number; leverage: number; stopLoss: number; takeProfit: number; peakPnlPct: number; }
interface Trade { pair: string; direction: "long"|"short"; entryPrice: number; exitPrice: number; entryTime: number; exitTime: number; pnl: number; reason: string; }
interface PD { candles: Candle[]; tsMap: Map<number,number>; zScores: number[]; adx14: number[]; ema9: number[]; ema21: number[]; }

const CD="/tmp/bt-pair-cache", H=3600000, D=86400000, FEE=0.00035;
const PAIRS=["OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","AVAXUSDT","TRUMPUSDT","DASHUSDT","DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","SEIUSDT","LINKUSDT","ADAUSDT","WLDUSDT","XRPUSDT","SUIUSDT","TONUSDT","UNIUSDT"];
const SP:Record<string,number>={XRPUSDT:1.05e-4,DOGEUSDT:1.35e-4,SUIUSDT:1.85e-4,AVAXUSDT:2.55e-4,ARBUSDT:2.6e-4,ENAUSDT:2.55e-4,UNIUSDT:2.75e-4,APTUSDT:3.2e-4,LINKUSDT:3.45e-4,TRUMPUSDT:3.65e-4,WLDUSDT:4e-4,SEIUSDT:4.4e-4,TONUSDT:4.6e-4,DOTUSDT:4.95e-4,WIFUSDT:5.05e-4,ADAUSDT:5.55e-4,LDOUSDT:5.8e-4,OPUSDT:6.2e-4,DASHUSDT:7.15e-4,BTCUSDT:0.5e-4};

function load(p:string):Candle[]{const f=path.join(CD,p+".json");if(!fs.existsSync(f))return[];const r=JSON.parse(fs.readFileSync(f,"utf8"))as unknown[];return(r as(number[]|Candle)[]).map(b=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b as Candle)}
function gv(a:number[],i:number,l:number):number|null{const x=i-(l-a.length);return x>=0&&x<a.length?a[x]:null}
function zs(cs:Candle[],lb:number,vw:number):number[]{const r=new Array(cs.length).fill(0);for(let i=Math.max(lb+1,vw+1);i<cs.length;i++){const m=cs[i].c/cs[i-lb].c-1;let s=0,n=0;for(let j=Math.max(1,i-vw+1);j<=i;j++){const ret=cs[j].c/cs[j-1].c-1;s+=ret*ret;n++}if(n<10)continue;const v=Math.sqrt(s/n);if(v>0)r[i]=m/v}return r}

function pre(p:string):PD|null{const c=load(p);if(c.length<200)return null;const t=new Map<number,number>();c.forEach((x,i)=>t.set(x.t,i));const cl=c.map(x=>x.c),hi=c.map(x=>x.h),lo=c.map(x=>x.l);return{candles:c,tsMap:t,zScores:zs(c,3,20),adx14:ADX.calculate({close:cl,high:hi,low:lo,period:14}).map(a=>a.adx),ema9:EMA.calculate({period:9,values:cl}),ema21:EMA.calculate({period:21,values:cl})}}

function sim(pdm:Map<string,PD>,btc:PD|null,s:number,e:number,sz:number,zT:number,tp:number):Trade[]{
  const pd=new Map<string,PD>();for(const p of PAIRS){const d=pdm.get(p);if(d)pd.set(p,d)}
  const ts=new Set<number>();for(const d of pd.values())for(const c of d.candles)if(c.t>=s&&c.t<e)ts.add(c.t);
  const st=[...ts].sort((a,b)=>a-b);const op=new Map<string,Position>();const tr:Trade[]=[];
  for(const t of st){const cl=new Set<string>();
    for(const[p,pos]of op){const d=pd.get(p)!;const bi=d.tsMap.get(t)??-1;if(bi<0)continue;const b=d.candles[bi];const sp=SP[p]??4e-4;let ep=0,r="";
      if(pos.direction==="long"?b.l<=pos.stopLoss:b.h>=pos.stopLoss){ep=pos.direction==="long"?pos.stopLoss*(1-sp):pos.stopLoss*(1+sp);r="sl"}
      if(!r&&pos.takeProfit>0&&(pos.direction==="long"?b.h>=pos.takeProfit:b.l<=pos.takeProfit)){ep=pos.direction==="long"?pos.takeProfit*(1-sp):pos.takeProfit*(1+sp);r="tp"}
      if(!r&&t-pos.entryTime>=24*H){ep=pos.direction==="long"?b.c*(1-sp):b.c*(1+sp);r="mh"}
      if(r){const f=sz*10*FEE*2;const raw=pos.direction==="long"?(ep/pos.entryPrice-1)*sz*10:(pos.entryPrice/ep-1)*sz*10;tr.push({pair:p,direction:pos.direction,entryPrice:pos.entryPrice,exitPrice:ep,entryTime:pos.entryTime,exitTime:t,pnl:raw-f,reason:r});op.delete(p);cl.add(p)}}
    for(const[p,d]of pd){if(op.has(p)||cl.has(p))continue;const bi=d.tsMap.get(t)??-1;if(bi<60)continue;
      const z=bi>0?d.zScores[bi-1]:0;let dir:("long"|"short"|null)=z>zT?"long":z<-zT?"short":null;if(!dir)continue;
      const a=gv(d.adx14,bi-1,d.candles.length);if(a===null||a<=20)continue;
      const e9=gv(d.ema9,bi-1,d.candles.length),e21=gv(d.ema21,bi-1,d.candles.length);if(e9===null||e21===null)continue;
      const trend=e9>e21?"long":"short";if(dir!==trend)continue;
      if(btc){const bbi=btc.tsMap.get(t);if(bbi!==undefined&&bbi>0){const be9=gv(btc.ema9,bbi-1,btc.candles.length),be21=gv(btc.ema21,bbi-1,btc.candles.length);if(be9!==null&&be21!==null){const bt=be9>be21?"long":"short";if(bt!==dir)continue}}}
      const dc=[...op.values()].filter(x=>x.direction===dir).length;if(dc>=10)continue;
      const en=d.candles[bi].o;const sp=SP[p]??4e-4;const ent=dir==="long"?en*(1+sp):en*(1-sp);
      const sl=dir==="long"?ent*(1-0.03):ent*(1+0.03);const tpv=dir==="long"?ent*(1+tp):ent*(1-tp);
      op.set(p,{pair:p,direction:dir,entryPrice:ent,entryTime:t,size:sz,leverage:10,stopLoss:sl,takeProfit:tpv,peakPnlPct:0})}}
  return tr}

const pdm=new Map<string,PD>();for(const p of[...PAIRS,"BTCUSDT"]){const d=pre(p);if(d)pdm.set(p,d)}
const btc=pdm.get("BTCUSDT")||null;

console.log("=== TRAIN/TEST SPLIT VALIDATION ===\n");

const configs=[
  {name:"z3+BTC-tp10-$10",z:3,tp:0.10,sz:10},
  {name:"z3+BTC-tp10-$25",z:3,tp:0.10,sz:25},
  {name:"v3+BTC-$10",z:2,tp:0.08,sz:10},
  {name:"ADX30+BTC-$25",z:2,tp:0.08,sz:25},
];

const fullStart=new Date("2025-06-01").getTime();
const mid=new Date("2025-10-25").getTime();
const fullEnd=new Date("2026-03-20").getTime();

for(const c of configs){
  const train=sim(pdm,btc,fullStart,mid,c.sz,c.z,c.tp);
  const test=sim(pdm,btc,mid,fullEnd,c.sz,c.z,c.tp);
  const trainPnl=train.reduce((s,t)=>s+t.pnl,0);
  const testPnl=test.reduce((s,t)=>s+t.pnl,0);
  const trainD=(mid-fullStart)/D;
  const testD=(fullEnd-mid)/D;
  const trainW=train.filter(t=>t.pnl>0).length;
  const testW=test.filter(t=>t.pnl>0).length;

  console.log(`${c.name}:`);
  console.log(`  Train (Jun-Oct): ${train.length} trades, WR=${(trainW/train.length*100).toFixed(1)}%, PnL=${trainPnl>=0?"+":""}$${trainPnl.toFixed(0)}, $${(trainPnl/trainD).toFixed(2)}/day`);
  console.log(`  Test  (Nov-Mar): ${test.length} trades, WR=${(testW/test.length*100).toFixed(1)}%, PnL=${testPnl>=0?"+":""}$${testPnl.toFixed(0)}, $${(testPnl/testD).toFixed(2)}/day`);
  const pct=trainPnl!==0?((testPnl/testD)/(trainPnl/trainD)*100).toFixed(0):"N/A";
  console.log(`  Test vs Train: ${pct}%\n`);
}

// Also test on 3-month rolling windows
console.log("=== 3-MONTH ROLLING WINDOWS (z3+BTC-tp10-$25) ===\n");
const windows=[
  {name:"Jun-Aug 25",s:"2025-06-01",e:"2025-09-01"},
  {name:"Sep-Nov 25",s:"2025-09-01",e:"2025-12-01"},
  {name:"Dec-Feb 26",s:"2025-12-01",e:"2026-03-01"},
  {name:"Jan-Mar 26",s:"2026-01-01",e:"2026-03-20"},
];
for(const w of windows){
  const trades=sim(pdm,btc,new Date(w.s).getTime(),new Date(w.e).getTime(),25,3,0.10);
  const pnl=trades.reduce((s,t)=>s+t.pnl,0);
  const d=(new Date(w.e).getTime()-new Date(w.s).getTime())/D;
  const wins=trades.filter(t=>t.pnl>0).length;
  console.log(`${w.name}: ${trades.length} trades, WR=${(wins/trades.length*100).toFixed(1)}%, PnL=${pnl>=0?"+":""}$${pnl.toFixed(0)}, $${(pnl/d).toFixed(2)}/day`);
}
