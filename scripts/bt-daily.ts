import * as fs from "fs";import * as path from "path";import{ADX,EMA,ATR}from"technicalindicators";
interface C{t:number;o:number;h:number;l:number;c:number}
interface P{pair:string;dir:"long"|"short";ep:number;et:number;sl:number;tp:number}
interface T{pair:string;pnl:number;et:number;xt:number}
interface D{cs:C[];tm:Map<number,number>;z3:number[];adx:number[];e9:number[];e21:number[];atr:number[]}
const CD="/tmp/bt-pair-cache",H=3600000,DAY=86400000,FEE=0.00035,SZ=20,LEV=10;
const KEEP=["OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","TRUMPUSDT","DASHUSDT","DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","LINKUSDT","ADAUSDT","WLDUSDT","XRPUSDT","UNIUSDT"];
const SP:Record<string,number>={XRPUSDT:1.05e-4,DOGEUSDT:1.35e-4,AVAXUSDT:2.55e-4,ARBUSDT:2.6e-4,ENAUSDT:2.55e-4,UNIUSDT:2.75e-4,APTUSDT:3.2e-4,LINKUSDT:3.45e-4,TRUMPUSDT:3.65e-4,WLDUSDT:4e-4,DOTUSDT:4.95e-4,WIFUSDT:5.05e-4,ADAUSDT:5.55e-4,LDOUSDT:5.8e-4,OPUSDT:6.2e-4,DASHUSDT:7.15e-4,BTCUSDT:0.5e-4};
function ld(p:string):C[]{const f=path.join(CD,p+".json");if(!fs.existsSync(f))return[];return(JSON.parse(fs.readFileSync(f,"utf8"))as any[]).map((b:any)=>Array.isArray(b)?{t:+b[0],o:+b[1],h:+b[2],l:+b[3],c:+b[4]}:b)}
function gv(a:number[],i:number,l:number):number|null{const x=i-(l-a.length);return x>=0&&x<a.length?a[x]:null}
function zsc(cs:C[]):number[]{const r=new Array(cs.length).fill(0);for(let i=21;i<cs.length;i++){const m=cs[i].c/cs[i-3].c-1;let s=0,n=0;for(let j=Math.max(1,i-19);j<=i;j++){s+=(cs[j].c/cs[j-1].c-1)**2;n++}if(n<10)continue;const v=Math.sqrt(s/n);if(v>0)r[i]=m/v}return r}
function pre(p:string):D|null{const cs=ld(p);if(cs.length<200)return null;const tm=new Map<number,number>();cs.forEach((x,i)=>tm.set(x.t,i));const cl=cs.map(x=>x.c),hi=cs.map(x=>x.h),lo=cs.map(x=>x.l);return{cs,tm,z3:zsc(cs),adx:ADX.calculate({close:cl,high:hi,low:lo,period:14}).map(a=>a.adx),e9:EMA.calculate({period:9,values:cl}),e21:EMA.calculate({period:21,values:cl}),atr:ATR.calculate({period:14,high:hi,low:lo,close:cl})}}

const S=new Date("2025-06-01").getTime(),E=new Date("2026-03-20").getTime();
const pdm=new Map<string,D>();for(const p of[...KEEP,"BTCUSDT"]){const d=pre(p);if(d)pdm.set(p,d)}const btc=pdm.get("BTCUSDT")!;
const bd=(t:number):"long"|"short"|null=>{const bi=btc.tm.get(t);if(!bi||bi<1)return null;const e9=gv(btc.e9,bi-1,btc.cs.length),e21=gv(btc.e21,bi-1,btc.cs.length);return e9!==null&&e21!==null?(e9>e21?"long":"short"):null};

const ts=new Set<number>();for(const p of KEEP){const d=pdm.get(p);if(d)for(const c of d.cs)if(c.t>=S&&c.t<E)ts.add(c.t)}
const st=[...ts].sort((a,b)=>a-b);const pos=new Map<string,P>();

// Track daily: opens, closes, pnl
const dailyOpens=new Map<string,{pairs:string[],count:number}>();
const dailyCloses=new Map<string,{count:number,pnl:number,wins:number,losses:number}>();

for(const t of st){const cl=new Set<string>();const dateStr=new Date(t).toISOString().slice(0,10);
  for(const[p,ps]of pos){const d=pdm.get(p)!;const bi=d.tm.get(t)??-1;if(bi<0)continue;const b=d.cs[bi];const sp=SP[p]??4e-4;let xp=0;
    if(ps.dir==="long"?b.l<=ps.sl:b.h>=ps.sl)xp=ps.dir==="long"?ps.sl*(1-sp):ps.sl*(1+sp);
    else if(ps.tp>0&&(ps.dir==="long"?b.h>=ps.tp:b.l<=ps.tp))xp=ps.dir==="long"?ps.tp*(1-sp):ps.tp*(1+sp);
    else if(t-ps.et>=48*H)xp=ps.dir==="long"?b.c*(1-sp):b.c*(1+sp);
    if(xp>0){const raw=ps.dir==="long"?(xp/ps.ep-1)*SZ*LEV:(ps.ep/xp-1)*SZ*LEV;const pnl=raw-SZ*LEV*FEE*2;
      const dc=dailyCloses.get(dateStr)||{count:0,pnl:0,wins:0,losses:0};dc.count++;dc.pnl+=pnl;if(pnl>0)dc.wins++;else dc.losses++;dailyCloses.set(dateStr,dc);
      pos.delete(p);cl.add(p)}}
  for(const p of KEEP){const d=pdm.get(p);if(!d||pos.has(p)||cl.has(p))continue;const bi=d.tm.get(t)??-1;if(bi<60)continue;
    const z=d.z3[bi-1]||0;let dir:"long"|"short"|null=null;
    if(z>4.5)dir="long";else if(z<-3.0)dir="short";if(!dir)continue;
    const adx=gv(d.adx,bi-1,d.cs.length);if(!adx||adx<=(dir==="long"?30:25))continue;
    const e9=gv(d.e9,bi-1,d.cs.length),e21=gv(d.e21,bi-1,d.cs.length);if(!e9||!e21||(dir==="long"?e9<=e21:e9>=e21))continue;
    const aN=gv(d.atr,bi-1,d.cs.length),aP=gv(d.atr,bi-6,d.cs.length);if(aN&&aP&&aN<aP*0.9)continue;
    const bt=bd(t);if(!bt||bt!==dir)continue;
    const dc2=[...pos.values()].filter(x=>x.dir===dir).length;if(dc2>=4)continue;
    const en=d.cs[bi].o;const sp=SP[p]??4e-4;const ent=dir==="long"?en*(1+sp):en*(1-sp);
    pos.set(p,{pair:p,dir,ep:ent,et:t,sl:dir==="long"?ent*0.97:ent*1.03,tp:dir==="long"?ent*1.10:ent*0.90});
    const dop=dailyOpens.get(dateStr)||{pairs:[],count:0};dop.pairs.push(p.replace("USDT",""));dop.count++;dailyOpens.set(dateStr,dop)}}

// Show October 2025 as example month
console.log("=== OCTOBER 2025 - DAY BY DAY ===\n");
console.log("Date        Opens  Closes  Pairs Opened                          W/L    DayPnL");
console.log("-".repeat(95));

let monthPnl=0,monthTrades=0,monthOpens=0;
for(let d=new Date("2025-10-01");d<new Date("2025-11-01");d.setDate(d.getDate()+1)){
  const ds=d.toISOString().slice(0,10);
  const opens=dailyOpens.get(ds)||{pairs:[],count:0};
  const closes=dailyCloses.get(ds)||{count:0,pnl:0,wins:0,losses:0};
  monthPnl+=closes.pnl;monthTrades+=closes.count;monthOpens+=opens.count;
  const pairsStr=opens.pairs.join(",");
  const pnlStr=closes.pnl>=0?`+$${closes.pnl.toFixed(1)}`:`-$${Math.abs(closes.pnl).toFixed(1)}`;
  console.log(`${ds}  ${String(opens.count).padStart(5)}  ${String(closes.count).padStart(6)}  ${pairsStr.padEnd(35)} ${closes.wins}W/${closes.losses}L  ${pnlStr.padStart(8)}`);
}
console.log(`\nOctober total: ${monthOpens} opens, ${monthTrades} closes, PnL: +$${monthPnl.toFixed(0)}, avg ${(monthOpens/31).toFixed(1)} opens/day`);

// Summary stats across all months
console.log("\n=== MONTHLY SUMMARY ===\n");
const months=new Map<string,{opens:number;closes:number;pnl:number;days:number}>();
for(const[ds,o]of dailyOpens){const m=ds.slice(0,7);const v=months.get(m)||{opens:0,closes:0,pnl:0,days:0};v.opens+=o.count;months.set(m,v)}
for(const[ds,c]of dailyCloses){const m=ds.slice(0,7);const v=months.get(m)||{opens:0,closes:0,pnl:0,days:0};v.closes+=c.count;v.pnl+=c.pnl;v.days++;months.set(m,v)}

console.log("Month     Opens  Closes  Opens/day  PnL");
for(const[m,v]of[...months.entries()].sort()){
  const daysInMonth=m==="2026-03"?20:30;
  console.log(`${m}   ${String(v.opens).padStart(5)}  ${String(v.closes).padStart(6)}  ${(v.opens/daysInMonth).toFixed(1).padStart(9)}  ${(v.pnl>=0?"+":"")}$${v.pnl.toFixed(0)}`);
}

// Distribution of daily opens
const openCounts=new Map<number,number>();
for(const[,o]of dailyOpens){openCounts.set(o.count,(openCounts.get(o.count)||0)+1)}
// Also count days with 0 opens
const allDates=new Set<string>();for(let d=new Date("2025-06-01");d<new Date("2026-03-20");d.setDate(d.getDate()+1))allDates.add(d.toISOString().slice(0,10));
const zeroDays=allDates.size-dailyOpens.size;
openCounts.set(0,(openCounts.get(0)||0)+zeroDays);

console.log("\n=== DAILY OPENS DISTRIBUTION ===\n");
for(const[n,count]of[...openCounts.entries()].sort((a,b)=>a[0]-b[0])){
  console.log(`${n} trades opened: ${count} days (${(count/allDates.size*100).toFixed(0)}%)`);
}
