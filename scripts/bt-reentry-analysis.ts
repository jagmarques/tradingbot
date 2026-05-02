/**
 * Re-entry analysis: when the trail exits a position on pair X direction D,
 * does opening a new position on (X, D) within 60min lose money on average?
 * Replicates deployed GARCH v2 LONG+SHORT config (top-15, z=3.0/1.5 symmetric,
 * SL 3.0%/3.5% by leverage tier, trail T15/4 single stage, block h22-23,
 * 4h SL-only cooldown, max hold 120h, $10 margin, mc=7).
 *
 * For each (trail-close on pair P dir D) -> (next entry on P D within 60min):
 *  - log the second trade's full lifecycle as a "re-entry"
 *  - simulate counterfactual: hold the original position past the trail-close
 *    point, exit only on SL / maxhold (no trail) and compare outcomes.
 *
 * Outputs:
 *  - /tmp/reentry-analysis.csv   (one row per re-entry event)
 *  - .company/messages/backtester-reentry.md  (summary)
 */
import * as fs from "fs";

const CACHE_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000, H4 = 4 * H, D = 86_400_000;
const FEE = 0.00045, MARGIN = 10, MAX_HOLD_H = 120;
const BLOCK_HOURS = new Set([22, 23]);
const LB = 1, MC = 7, CD_H = 4;
// Trail T15/4: lock at peak-4pp once peak>=15% leveraged (per task spec)
const TRAIL_ARM = 15, TRAIL_DROP = 4;
// Re-entry window
const REENTRY_WINDOW_MS = 60 * 60 * 1000;
const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();
const OOS_DAYS = (OOS_END - OOS_START) / D;

// Config per task: z=3.0 symmetric, SL 3.0%/3.5% by leverage tier
const Z1_LONG = 3.0, Z4_LONG = 1.5;
const Z1_SHORT = 3.0, Z4_SHORT = 1.5;
// Match deployed garch-v2-engine.ts: SL_PCT_HIGH_LEV=0.035 (lev>=10), SL_PCT_LOW_LEV=0.030 (lev<10)
const SL_HIGH_LEV = 0.035; // leverage >= 10 (10x pairs)
const SL_LOW_LEV  = 0.030; // leverage < 10 (3-5x pairs)

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1e-4, SOL: 2e-4, SUI: 1.85e-4, AVAX: 2.55e-4, ARB: 2.6e-4,
  ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, NEAR: 3.5e-4, FET: 4e-4, FIL: 5e-4, ZEC: 8e-4, WLD: 8e-4,
  // Micro-caps bumped to 15bp (more realistic than 12bp on $200 fills with thin orderbooks)
  STRAX: 15e-4, YGG: 15e-4, BANANA: 15e-4, ZEN: 15e-4, BIO: 15e-4, WCT: 15e-4, CYBER: 15e-4,
  STRK: 15e-4, ETHFI: 15e-4, KAITO: 15e-4, PENGU: 15e-4, NEO: 8e-4, SUSHI: 10e-4, JTO: 10e-4,
};
const DEFAULT_SPREAD = 8e-4;

const TOP15 = ["ETH","ZEC","YGG","STRAX","WLD","PENGU","DOGE","ARB","FIL","OP","AVAX","NEO","JTO","KAITO","SUSHI"];

// Load leverage map
const leverageMap = new Map<string, number>();
for (const line of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = line.split(":");
  leverageMap.set(n!, parseInt(v!));
}
function getLeverage(p: string): number { return Math.min(leverageMap.get(p) ?? 3, 10); }

interface TA { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; n: number; }
function loadTA(s: string): TA | null {
  let b: string;
  try { b = fs.readFileSync(`${CACHE_1M}/${s}.json`, "utf8"); } catch { return null; }
  const r = JSON.parse(b) as Array<{t:number;o:number;h:number;l:number;c:number}>;
  const n = r.length; if (n < 5000) return null;
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
  for (let i = 0; i < n; i++) { t[i] = r[i]!.t; o[i] = r[i]!.o; h[i] = r[i]!.h; l[i] = r[i]!.l; c[i] = r[i]!.c; }
  return { t, o, h, l, c, n };
}
function agg(s: TA, im: number, mb: number): TA | null {
  const oT:number[]=[],oO:number[]=[],oH:number[]=[],oL:number[]=[],oC:number[]=[];
  let cT=-1,cO=0,cH=0,cL=0,cC=0,has=false;
  for (let i=0;i<s.n;i++){
    const bt=Math.floor(s.t[i]!/im)*im;
    if(!has||cT!==bt){
      if(has){oT.push(cT);oO.push(cO);oH.push(cH);oL.push(cL);oC.push(cC);}
      cT=bt;cO=s.o[i]!;cH=s.h[i]!;cL=s.l[i]!;cC=s.c[i]!;has=true;
    } else {
      if(s.h[i]!>cH)cH=s.h[i]!;
      if(s.l[i]!<cL)cL=s.l[i]!;
      cC=s.c[i]!;
    }
  }
  if(has){oT.push(cT);oO.push(cO);oH.push(cH);oL.push(cL);oC.push(cC);}
  if(oT.length<mb)return null;
  return {t:Float64Array.from(oT),o:Float64Array.from(oO),h:Float64Array.from(oH),l:Float64Array.from(oL),c:Float64Array.from(oC),n:oT.length};
}
function zs(c: TA, vw: number): Float64Array {
  const z = new Float64Array(c.n);
  for (let i=0;i<c.n;i++){
    if(i<vw+LB+1){z[i]=0;continue;}
    const mom=c.c[i]!/c.c[i-LB]!-1;
    let ss=0,cnt=0;
    for(let j=Math.max(1,i-vw);j<=i;j++){
      const r=c.c[j]!/c.c[j-1]!-1;
      ss+=r*r;cnt++;
    }
    const vol=Math.sqrt(ss/cnt);
    z[i]=vol===0?0:mom/vol;
  }
  return z;
}

interface PD {
  name: string; m1: TA; h1: TA; z1h: Float64Array; z4h: Float64Array;
  h1Map: Map<number, number>; m1Map: Map<number, number>; h4Map: Map<number, number>;
  spread: number; leverage: number;
}

console.log("Loading top-15 1m caches...");
const pairs: PD[] = [];
const skipped: string[] = [];
for (const name of TOP15) {
  let raw = loadTA(`${name}USDT`);
  if (!raw) { skipped.push(name); continue; }
  const h1 = agg(raw, H, 200);
  const h4 = agg(raw, H4, 50);
  if (!h1 || !h4) { skipped.push(name); continue; }
  const z1h = zs(h1, 15);
  const z4h = zs(h4, 20);
  const ms = OOS_START - 24 * H, me = OOS_END + 24 * H;
  const ki: number[] = [];
  for (let i = 0; i < raw.n; i++) if (raw.t[i]! >= ms && raw.t[i]! <= me) ki.push(i);
  const mn = ki.length;
  const m1: TA = {
    t: new Float64Array(mn), o: new Float64Array(mn), h: new Float64Array(mn),
    l: new Float64Array(mn), c: new Float64Array(mn), n: mn,
  };
  for (let k = 0; k < mn; k++) {
    const i = ki[k]!;
    m1.t[k] = raw.t[i]!; m1.o[k] = raw.o[i]!; m1.h[k] = raw.h[i]!; m1.l[k] = raw.l[i]!; m1.c[k] = raw.c[i]!;
  }
  const h1Map = new Map<number, number>();
  for (let i = 0; i < h1.n; i++) h1Map.set(h1.t[i]!, i);
  const m1Map = new Map<number, number>();
  for (let i = 0; i < m1.n; i++) m1Map.set(m1.t[i]!, i);
  const h4Map = new Map<number, number>();
  for (let i = 0; i < h4.n; i++) h4Map.set(h4.t[i]!, i);
  pairs.push({
    name, m1, h1, z1h, z4h, h1Map, m1Map, h4Map,
    spread: SP[name] ?? DEFAULT_SPREAD, leverage: getLeverage(name),
  });
}
console.log(`Loaded ${pairs.length}/${TOP15.length} pairs. Skipped: ${skipped.join(", ") || "(none)"}`);
if (pairs.length === 0) { console.error("No pairs loaded — abort."); process.exit(1); }

const pByN = new Map<string, PD>();
pairs.forEach(p => pByN.set(p.name, p));

const allTs = new Set<number>();
for (const p of pairs) for (let i = 0; i < p.m1.n; i++) {
  const t = p.m1.t[i]!;
  if (t >= OOS_START && t < OOS_END) allTs.add(t);
}
const timepoints = [...allTs].sort((a, b) => a - b);
console.log(`Timepoints: ${timepoints.length}`);

function get4h(p: PD, ts: number): number {
  const b = Math.floor(ts / H4) * H4;
  const i = p.h4Map.get(b);
  if (i !== undefined && i > 0) return p.z4h[i - 1]!;
  return 0;
}

interface Pos {
  pair: string; direction: 1 | -1; entryPrice: number; entryTime: number;
  stopLoss: number; peakLevPnlPct: number;
  spread: number; leverage: number; notional: number;
}

interface ClosedTrade {
  pair: string; direction: 1 | -1;
  entryTime: number; entryPrice: number;
  exitTime: number; exitPrice: number; exitReason: "sl" | "trail" | "maxh";
  peakLevPnlPct: number; pnlUsd: number; pnlPctLev: number;
  leverage: number;
}

const closed: ClosedTrade[] = [];
const open: Pos[] = [];
const cd = new Map<string, number>(); // SL cooldown only

for (const ts of timepoints) {
  const isH1 = ts % H === 0;
  // Update open positions / process exits
  for (let i = open.length - 1; i >= 0; i--) {
    const pos = open[i]!;
    const pd = pByN.get(pos.pair)!;
    const bi = pd.m1Map.get(ts);
    if (bi === undefined) continue;
    const bL = pd.m1.l[bi]!, bH = pd.m1.h[bi]!, bC = pd.m1.c[bi]!;
    let xp = 0;
    let rs: "sl" | "trail" | "maxh" | "" = "";
    if ((ts - pos.entryTime) / H >= MAX_HOLD_H) { xp = bC; rs = "maxh"; }
    if (!xp) {
      if (pos.direction === 1 && bL <= pos.stopLoss) { xp = pos.stopLoss; rs = "sl"; }
      else if (pos.direction === -1 && bH >= pos.stopLoss) { xp = pos.stopLoss; rs = "sl"; }
    }
    const move = pos.direction === 1 ? bH / pos.entryPrice - 1 : 1 - bL / pos.entryPrice;
    const bp = move * pos.leverage * 100;
    if (bp > pos.peakLevPnlPct) pos.peakLevPnlPct = bp;
    if (!xp && pos.peakLevPnlPct >= TRAIL_ARM) {
      const cur = (pos.direction === 1 ? bC / pos.entryPrice - 1 : 1 - bC / pos.entryPrice) * pos.leverage * 100;
      if (cur <= pos.peakLevPnlPct - TRAIL_DROP) { xp = bC; rs = "trail"; }
    }
    if (xp > 0 && rs !== "") {
      const es = rs === "sl" ? pos.spread * 0.75 : pos.spread / 2;
      const fpx = pos.direction === 1 ? xp * (1 - es) : xp * (1 + es);
      const ret = pos.direction === 1 ? fpx / pos.entryPrice - 1 : 1 - fpx / pos.entryPrice;
      const pnl = ret * pos.notional - pos.notional * FEE * 2;
      const pnlPctLev = ret * pos.leverage * 100;
      open.splice(i, 1);
      closed.push({
        pair: pos.pair, direction: pos.direction,
        entryTime: pos.entryTime, entryPrice: pos.entryPrice,
        exitTime: ts, exitPrice: fpx, exitReason: rs,
        peakLevPnlPct: pos.peakLevPnlPct, pnlUsd: pnl, pnlPctLev,
        leverage: pos.leverage,
      });
      if (rs === "sl") cd.set(`${pos.pair}:${pos.direction}`, ts + CD_H * H);
    }
  }
  if (!isH1) continue;
  if (BLOCK_HOURS.has(new Date(ts).getUTCHours())) continue;
  if (open.length >= MC) continue;
  for (const p of pairs) {
    if (open.length >= MC) break;
    if (open.some(po => po.pair === p.name)) continue;
    const h1i = p.h1Map.get(ts);
    if (h1i === undefined || h1i < 20) continue;
    const z1 = p.z1h[h1i - 1]!;
    const z4 = get4h(p, ts);
    // LONG entry
    if (z1 > Z1_LONG && z4 > Z4_LONG) {
      const cdL = cd.get(`${p.name}:1`);
      if (!cdL || ts >= cdL) {
        const ep = p.h1.o[h1i]! * (1 + p.spread / 2);
        const slPct = p.leverage >= 10 ? SL_HIGH_LEV : SL_LOW_LEV;
        const sl = ep * (1 - slPct);
        const no = MARGIN * p.leverage;
        open.push({
          pair: p.name, direction: 1, entryPrice: ep, entryTime: ts,
          stopLoss: sl, peakLevPnlPct: 0, spread: p.spread, leverage: p.leverage, notional: no,
        });
        continue;
      }
    }
    // SHORT entry
    if (z1 < -Z1_SHORT && z4 < -Z4_SHORT) {
      const cdS = cd.get(`${p.name}:-1`);
      if (!cdS || ts >= cdS) {
        const ep = p.h1.o[h1i]! * (1 - p.spread / 2);
        const slPct = p.leverage >= 10 ? SL_HIGH_LEV : SL_LOW_LEV;
        const sl = ep * (1 + slPct);
        const no = MARGIN * p.leverage;
        open.push({
          pair: p.name, direction: -1, entryPrice: ep, entryTime: ts,
          stopLoss: sl, peakLevPnlPct: 0, spread: p.spread, leverage: p.leverage, notional: no,
        });
      }
    }
  }
}

console.log(`\nSimulation done. Total trades: ${closed.length}`);
const trailCount = closed.filter(t => t.exitReason === "trail").length;
const slCount    = closed.filter(t => t.exitReason === "sl").length;
const maxhCount  = closed.filter(t => t.exitReason === "maxh").length;
const totalPnl   = closed.reduce((a, t) => a + t.pnlUsd, 0);
console.log(`  trail: ${trailCount}  sl: ${slCount}  maxh: ${maxhCount}`);
console.log(`  total pnl: $${totalPnl.toFixed(2)}  /day: $${(totalPnl/OOS_DAYS).toFixed(2)}`);

// Sort closed by entry time so we can find re-entries cleanly.
closed.sort((a, b) => a.entryTime - b.entryTime);

// Re-entry detection: for each (trail-close on pair, dir), find next entry on
// same pair+dir whose entryTime - exitTime <= 60min.
interface ReentryEvent {
  pair: string; direction: 1 | -1;
  origEntryTime: number; origEntryPrice: number;
  origExitTime: number; origExitPrice: number; origPeakLev: number; origPnlUsd: number;
  reEntryTime: number; reEntryPrice: number;
  reExitTime: number; reExitPrice: number; reExitReason: string;
  rePnlUsd: number; rePnlPctLev: number; rePeakLev: number;
  gapMinutes: number; worseEntry: boolean; // entry vs prev close
  counterfactualPnl: number; counterfactualReason: string;
  leverage: number;
}

const reentries: ReentryEvent[] = [];
const closedByPairDir = new Map<string, ClosedTrade[]>();
for (const t of closed) {
  const key = `${t.pair}:${t.direction}`;
  if (!closedByPairDir.has(key)) closedByPairDir.set(key, []);
  closedByPairDir.get(key)!.push(t);
}

// Counterfactual sim: from origExitTime onward, hold the position (still using
// original entryPrice / SL / leverage). Apply max-hold from entryTime. No trail.
function counterfactualHold(orig: ClosedTrade): { pnlUsd: number; reason: string; exitTime: number; peakLev: number } {
  const pd = pByN.get(orig.pair)!;
  // Find m1 index >= origExitTime
  let i = pd.m1Map.get(orig.exitTime);
  if (i === undefined) {
    // fallback: linear search
    for (let k = 0; k < pd.m1.n; k++) if (pd.m1.t[k]! >= orig.exitTime) { i = k; break; }
    if (i === undefined) return { pnlUsd: 0, reason: "no-data", exitTime: orig.exitTime, peakLev: orig.peakLevPnlPct };
  }
  const slPct = orig.leverage >= 10 ? SL_HIGH_LEV : SL_LOW_LEV;
  const stopLoss = orig.direction === 1 ? orig.entryPrice * (1 - slPct) : orig.entryPrice * (1 + slPct);
  const notional = MARGIN * orig.leverage;
  let peakLev = orig.peakLevPnlPct;
  for (; i < pd.m1.n; i++) {
    const ts = pd.m1.t[i]!;
    const bL = pd.m1.l[i]!, bH = pd.m1.h[i]!, bC = pd.m1.c[i]!;
    if ((ts - orig.entryTime) / H >= MAX_HOLD_H) {
      const fpx = orig.direction === 1 ? bC * (1 - pd.spread / 2) : bC * (1 + pd.spread / 2);
      const ret = orig.direction === 1 ? fpx / orig.entryPrice - 1 : 1 - fpx / orig.entryPrice;
      const pnl = ret * notional - notional * FEE * 2;
      return { pnlUsd: pnl, reason: "maxh", exitTime: ts, peakLev };
    }
    if (orig.direction === 1 && bL <= stopLoss) {
      const fpx = stopLoss * (1 - pd.spread * 0.75);
      const ret = fpx / orig.entryPrice - 1;
      const pnl = ret * notional - notional * FEE * 2;
      return { pnlUsd: pnl, reason: "sl", exitTime: ts, peakLev };
    }
    if (orig.direction === -1 && bH >= stopLoss) {
      const fpx = stopLoss * (1 + pd.spread * 0.75);
      const ret = 1 - fpx / orig.entryPrice;
      const pnl = ret * notional - notional * FEE * 2;
      return { pnlUsd: pnl, reason: "sl", exitTime: ts, peakLev };
    }
    const move = orig.direction === 1 ? bH / orig.entryPrice - 1 : 1 - bL / orig.entryPrice;
    const bp = move * orig.leverage * 100;
    if (bp > peakLev) peakLev = bp;
  }
  // Ran off the end of data — close at last close price
  const lastIdx = pd.m1.n - 1;
  const bC = pd.m1.c[lastIdx]!;
  const fpx = orig.direction === 1 ? bC * (1 - pd.spread / 2) : bC * (1 + pd.spread / 2);
  const ret = orig.direction === 1 ? fpx / orig.entryPrice - 1 : 1 - fpx / orig.entryPrice;
  const pnl = ret * notional - notional * FEE * 2;
  return { pnlUsd: pnl, reason: "data-end", exitTime: pd.m1.t[lastIdx]!, peakLev };
}

for (const orig of closed) {
  if (orig.exitReason !== "trail") continue;
  const list = closedByPairDir.get(`${orig.pair}:${orig.direction}`) || [];
  // Find next trade in same pair+dir whose entry is within REENTRY_WINDOW_MS after orig.exitTime
  const next = list.find(t => t.entryTime > orig.exitTime && (t.entryTime - orig.exitTime) <= REENTRY_WINDOW_MS);
  if (!next) continue;
  const worseEntry = orig.direction === 1
    ? next.entryPrice > orig.exitPrice
    : next.entryPrice < orig.exitPrice;
  const cf = counterfactualHold(orig);
  reentries.push({
    pair: orig.pair, direction: orig.direction,
    origEntryTime: orig.entryTime, origEntryPrice: orig.entryPrice,
    origExitTime: orig.exitTime, origExitPrice: orig.exitPrice, origPeakLev: orig.peakLevPnlPct, origPnlUsd: orig.pnlUsd,
    reEntryTime: next.entryTime, reEntryPrice: next.entryPrice,
    reExitTime: next.exitTime, reExitPrice: next.exitPrice, reExitReason: next.exitReason,
    rePnlUsd: next.pnlUsd, rePnlPctLev: next.pnlPctLev, rePeakLev: next.peakLevPnlPct,
    gapMinutes: (next.entryTime - orig.exitTime) / 60000,
    worseEntry,
    counterfactualPnl: cf.pnlUsd, counterfactualReason: cf.reason,
    leverage: orig.leverage,
  });
}

console.log(`\nRe-entry events: ${reentries.length}`);

// CSV output
const csvHeader = [
  "pair","direction","leverage","gap_min","worse_entry",
  "orig_entry_time","orig_exit_time","orig_exit_price","orig_peak_lev_pct","orig_pnl_usd",
  "re_entry_time","re_entry_price","re_exit_time","re_exit_price","re_exit_reason",
  "re_pnl_usd","re_pnl_pct_lev","re_peak_lev_pct",
  "actual_combined_pnl","counterfactual_hold_pnl","counterfactual_reason","cf_minus_actual",
].join(",");
const csvRows: string[] = [csvHeader];
for (const e of reentries) {
  const actualCombined = e.origPnlUsd + e.rePnlUsd;
  const delta = e.counterfactualPnl - actualCombined;
  csvRows.push([
    e.pair, e.direction, e.leverage, e.gapMinutes.toFixed(1), e.worseEntry ? "1" : "0",
    new Date(e.origEntryTime).toISOString(), new Date(e.origExitTime).toISOString(),
    e.origExitPrice.toFixed(6), e.origPeakLev.toFixed(2), e.origPnlUsd.toFixed(4),
    new Date(e.reEntryTime).toISOString(), e.reEntryPrice.toFixed(6),
    new Date(e.reExitTime).toISOString(), e.reExitPrice.toFixed(6), e.reExitReason,
    e.rePnlUsd.toFixed(4), e.rePnlPctLev.toFixed(2), e.rePeakLev.toFixed(2),
    actualCombined.toFixed(4), e.counterfactualPnl.toFixed(4), e.counterfactualReason,
    delta.toFixed(4),
  ].join(","));
}
fs.writeFileSync("/tmp/reentry-analysis.csv", csvRows.join("\n") + "\n");
console.log("CSV: /tmp/reentry-analysis.csv");

// Compute summary metrics
const N = reentries.length;
const reEntryPnlSum  = reentries.reduce((a, e) => a + e.rePnlUsd, 0);
const reEntryWinCnt  = reentries.filter(e => e.rePnlUsd > 0).length;
const reEntryWR      = N > 0 ? (reEntryWinCnt / N) * 100 : 0;
const reEntryAvg     = N > 0 ? reEntryPnlSum / N : 0;
const reEntryTrailCnt = reentries.filter(e => e.reExitReason === "trail").length;
const reEntrySlCnt    = reentries.filter(e => e.reExitReason === "sl").length;
const reEntryMaxhCnt  = reentries.filter(e => e.reExitReason === "maxh").length;

// Re-entry trades vs all OTHER trades (non-re-entry seconds)
const reEntryKeys = new Set(reentries.map(e => `${e.pair}:${e.direction}:${e.reEntryTime}`));
const otherTrades = closed.filter(t => !reEntryKeys.has(`${t.pair}:${t.direction}:${t.entryTime}`));
const otherAvg = otherTrades.length > 0 ? otherTrades.reduce((a, t) => a + t.pnlUsd, 0) / otherTrades.length : 0;

const worseCount = reentries.filter(e => e.worseEntry).length;
const worsePct = N > 0 ? (worseCount / N) * 100 : 0;

// Counterfactual aggregate
const actualCombinedSum   = reentries.reduce((a, e) => a + e.origPnlUsd + e.rePnlUsd, 0);
const counterfactualSum   = reentries.reduce((a, e) => a + e.counterfactualPnl, 0);
const cfBetterCount       = reentries.filter(e => e.counterfactualPnl > (e.origPnlUsd + e.rePnlUsd)).length;
const cfBetterPct         = N > 0 ? (cfBetterCount / N) * 100 : 0;

// $/day impact of "no re-entry within 60min after trail-close" rule:
//   Removing the re-entry trades. Net = -reEntryPnlSum (we'd lose those P&Ls).
const noReentryDeltaPerDay = -reEntryPnlSum / OOS_DAYS;

console.log("\n=== Summary ===");
console.log(`Total trades: ${closed.length}  (trail ${trailCount} | sl ${slCount} | maxh ${maxhCount})`);
console.log(`Re-entry events: ${N}`);
console.log(`Re-entry trades: pnl_sum=$${reEntryPnlSum.toFixed(2)}  avg=$${reEntryAvg.toFixed(3)}  WR=${reEntryWR.toFixed(1)}%`);
console.log(`  exit breakdown: trail=${reEntryTrailCnt}  sl=${reEntrySlCnt}  maxh=${reEntryMaxhCnt}`);
console.log(`Other trades avg: $${otherAvg.toFixed(3)}  (n=${otherTrades.length})`);
console.log(`Worse-entry rate: ${worsePct.toFixed(1)}% (${worseCount}/${N})`);
console.log(`Counterfactual hold: $${counterfactualSum.toFixed(2)} vs actual $${actualCombinedSum.toFixed(2)} (delta $${(counterfactualSum-actualCombinedSum).toFixed(2)})`);
console.log(`  CF beats actual: ${cfBetterPct.toFixed(1)}% (${cfBetterCount}/${N})`);
console.log(`Adding 1h cooldown after trail-close removes re-entries: $/day delta = ${noReentryDeltaPerDay.toFixed(3)}`);

// Verdict
let verdict: string;
if (reEntryAvg > 0 && reEntryPnlSum > 0) verdict = `Re-entry pattern is NET POSITIVE (avg $${reEntryAvg.toFixed(3)}/trade, total $${reEntryPnlSum.toFixed(2)}). Adding 1h cooldown would COST $${(-noReentryDeltaPerDay).toFixed(3)}/day — likely -EV.`;
else if (reEntryAvg < 0 && reEntryPnlSum < 0) verdict = `Re-entry pattern is NET NEGATIVE (avg $${reEntryAvg.toFixed(3)}/trade, total $${reEntryPnlSum.toFixed(2)}). Adding 1h cooldown would SAVE $${noReentryDeltaPerDay.toFixed(3)}/day — likely +EV.`;
else verdict = `Re-entry pattern is approximately NEUTRAL (total $${reEntryPnlSum.toFixed(2)}, $${noReentryDeltaPerDay.toFixed(3)}/day). 1h cooldown is approximately EV-neutral.`;

const sample = N < 30 ? "  **WARNING**: small sample (N<30), low confidence." : "";

const startDate = new Date(OOS_START).toISOString().slice(0, 10);
const endDate   = new Date(OOS_END).toISOString().slice(0, 10);

const md = `# Quant Backtester - Re-entry Analysis

## Configuration
SOURCE: scripts/bt-reentry-analysis.ts
- Pairs: top-15 (loaded ${pairs.length}/${TOP15.length}${skipped.length > 0 ? `, skipped: ${skipped.join(", ")}` : ""})
- Period: ${startDate} to ${endDate}, ${OOS_DAYS.toFixed(0)} days
- Config: z1h=${Z1_LONG}/${Z1_SHORT} symmetric, z4h=${Z4_LONG}/${Z4_SHORT}, SL ${(SL_HIGH_LEV*100).toFixed(1)}%/${(SL_LOW_LEV*100).toFixed(1)}% (high/low lev), trail T${TRAIL_ARM}/${TRAIL_DROP} single-stage, no-BE, max hold ${MAX_HOLD_H}h, block hours 22-23 UTC, ${CD_H}h SL-only cooldown.
- Total trades simulated: ${closed.length}  (trail ${trailCount} | sl ${slCount} | maxh ${maxhCount})

## Re-entry Events
FINDING: ${N} re-entry events found (trail-close → same-pair same-dir open within ${REENTRY_WINDOW_MS/60000}min)
SOURCE: /tmp/reentry-analysis.csv${sample}

## Re-entry P&L
FINDING: $${reEntryPnlSum.toFixed(2)} total, $${reEntryAvg.toFixed(3)} avg/trade, ${reEntryWR.toFixed(1)}% WR
- Exit reasons (re-entry trades): trail=${reEntryTrailCnt} sl=${reEntrySlCnt} maxh=${reEntryMaxhCnt}
- Comparison: re-entry avg=$${reEntryAvg.toFixed(3)} vs all other trades avg=$${otherAvg.toFixed(3)} (n_other=${otherTrades.length})
- Worse-entry rate: ${worsePct.toFixed(1)}% (${worseCount}/${N}) — share of re-entries with WORSE fill than the previous trail-close price
SOURCE: aggregate over csv rows

## Counterfactual (hold instead of re-enter)
FINDING: counterfactual-hold sum = $${counterfactualSum.toFixed(2)}; actual (close+reopen) sum = $${actualCombinedSum.toFixed(2)}; delta = $${(counterfactualSum - actualCombinedSum).toFixed(2)} (CF − actual)
- Counterfactual beats close+reopen in ${cfBetterPct.toFixed(1)}% of events (${cfBetterCount}/${N})
- Per-event mean delta: $${N > 0 ? ((counterfactualSum - actualCombinedSum)/N).toFixed(3) : "n/a"}
SOURCE: per-event simulation in counterfactualHold()

## Aggregate impact
FINDING: rule "no re-entry within 60min after trail-close on same pair+dir" → P&L delta = $${noReentryDeltaPerDay.toFixed(3)}/day (${noReentryDeltaPerDay >= 0 ? "+EV: removes losing trades" : "-EV: removes winning trades"})

## Verdict
${verdict}
`;

fs.writeFileSync(
  "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/messages/backtester-reentry.md",
  md,
);
console.log("\nWrote: .company/messages/backtester-reentry.md");
