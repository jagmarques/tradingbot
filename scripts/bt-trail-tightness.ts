/**
 * Trail tightness sweep for deployed C2 (long+short asymm, top-15, mc=7).
 * Tests T15/4 (deployed) vs alternatives, plus a no-trail z-reversal exit.
 *
 * Data: /tmp/bt-pair-cache-1m/ (1m bars, Binance futures). If missing, auto-fetches
 * for the 15 deployed pairs only. Leverage map: /tmp/hl-leverage-map.txt — if
 * missing, fetched from Hyperliquid public meta (no auth).
 *
 * Output: console table + walk-forward by quarter for top-3 by Calmar.
 * Mirrors engine pattern from scripts/bt-add-shorts.ts.
 */
import * as fs from "fs";

const CACHE_1M = "/tmp/bt-pair-cache-1m";
const LEV_MAP_PATH = "/tmp/hl-leverage-map.txt";
const H = 3_600_000, H4 = 4 * H, D = 86_400_000, MIN = 60_000;
const FEE = 0.00045, MARGIN = 10, MAX_HOLD_H = 120;
const BLOCK_HOURS = new Set([22, 23]);
const LB = 1, MC = 7, CD_H = 4;
const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();
const OOS_DAYS = (OOS_END - OOS_START) / D;
// Deployed entry config C2 (long+short symmetric since cycle 7 reconciliation)
const LONG_Z1 = 3.0, LONG_Z4 = 1.5, SHORT_Z1 = 3.0, SHORT_Z4 = 1.5;
// Deployed SL: SL_PCT_HIGH_LEV=0.035 (lev>=10), SL_PCT_LOW_LEV=0.030 (lev<10)
const LONG_SL_HIGH = 0.035, LONG_SL_LOW = 0.030;
const SHORT_SL_HIGH = 0.035, SHORT_SL_LOW = 0.030;

const TOP15 = ["ETH","ZEC","YGG","STRAX","WLD","PENGU","DOGE","ARB","FIL","OP","AVAX","NEO","JTO","KAITO","SUSHI"];
const RENAME: Record<string, string> = { kPEPE: "1000PEPE" };

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1e-4, SOL: 2e-4, SUI: 1.85e-4, AVAX: 2.55e-4, ARB: 2.6e-4,
  ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, NEAR: 3.5e-4, FET: 4e-4, FIL: 5e-4, ZEC: 8e-4, WLD: 8e-4,
  // Micro-caps bumped to 15bp (more realistic on $200 fills with thin orderbooks)
  STRAX: 15e-4, YGG: 15e-4, BANANA: 15e-4, ZEN: 15e-4, BIO: 15e-4, WCT: 15e-4, CYBER: 15e-4,
  STRK: 15e-4, ETHFI: 15e-4, KAITO: 15e-4, PENGU: 15e-4, NEO: 8e-4, JTO: 10e-4, SUSHI: 10e-4,
};
const DEFAULT_SPREAD = 8e-4;

// ───────────────────────── Leverage map (HL meta) ─────────────────────────
async function ensureLeverageMap(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (fs.existsSync(LEV_MAP_PATH)) {
    for (const line of fs.readFileSync(LEV_MAP_PATH, "utf8").trim().split("\n")) {
      const [n, v] = line.split(":");
      if (n && v) m.set(n, parseInt(v));
    }
    return m;
  }
  console.log(`[setup] fetching leverage map from Hyperliquid…`);
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "meta" }),
  });
  if (!res.ok) throw new Error(`HL meta failed: ${res.status}`);
  const j = await res.json() as { universe: Array<{ name: string; maxLeverage: number }> };
  const out: string[] = [];
  for (const u of j.universe) {
    m.set(u.name, u.maxLeverage);
    out.push(`${u.name}:${u.maxLeverage}`);
  }
  fs.writeFileSync(LEV_MAP_PATH, out.join("\n"));
  console.log(`[setup] wrote ${out.length} pairs to ${LEV_MAP_PATH}`);
  return m;
}

// ───────────────────────── 1m candle fetcher (Binance futures) ─────────────
async function fetchKlines(symbol: string, startTime: number, limit = 1500): Promise<any[][]> {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=${limit}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status === 418) {
        const wait = 5000 * (attempt + 1);
        console.log(`[fetch] ${symbol} rate-limit, sleeping ${wait}ms`);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json() as any[][];
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(res => setTimeout(res, 2000));
    }
  }
  return [];
}

async function ensureCache(symbol: string, startMs: number, endMs: number): Promise<void> {
  if (!fs.existsSync(CACHE_1M)) fs.mkdirSync(CACHE_1M, { recursive: true });
  const path = `${CACHE_1M}/${symbol}.json`;
  if (fs.existsSync(path)) {
    try {
      const data = JSON.parse(fs.readFileSync(path, "utf8")) as Array<{ t: number }>;
      if (data.length > 0) {
        const first = data[0]!.t, last = data[data.length-1]!.t;
        // Accept if cache covers most of OOS window (allow 1d tolerance on each end)
        if (first <= startMs + D && last >= endMs - 2 * D) {
          console.log(`[cache] ${symbol}: ${data.length} rows ${new Date(first).toISOString().slice(0,10)}..${new Date(last).toISOString().slice(0,10)} (skip)`);
          return;
        }
        console.log(`[cache] ${symbol}: incomplete (${data.length} rows ${new Date(first).toISOString().slice(0,10)}..${new Date(last).toISOString().slice(0,10)}) — refetching`);
      }
    } catch { /* corrupt — refetch */ }
  }
  console.log(`[fetch] ${symbol}: downloading 1m bars from ${new Date(startMs).toISOString().slice(0,10)} to ${new Date(endMs).toISOString().slice(0,10)}`);
  const out: Array<{ t: number; o: number; h: number; l: number; c: number }> = [];
  let cursor = startMs, lastTs = 0, calls = 0;
  while (cursor < endMs) {
    const batch = await fetchKlines(symbol, cursor);
    calls++;
    if (batch.length === 0) break;
    for (const k of batch) {
      const t = k[0] as number;
      if (t <= lastTs) continue;
      out.push({ t, o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]) });
      lastTs = t;
    }
    cursor = lastTs + MIN;
    if (calls % 50 === 0) process.stdout.write(`[${symbol}:${(out.length/1000).toFixed(0)}k] `);
    await new Promise(r => setTimeout(r, 250));
  }
  fs.writeFileSync(path, JSON.stringify(out));
  console.log(`\n[fetch] ${symbol}: ${out.length} rows -> ${path}`);
}

// ───────────────────────── Engine (mirror of bt-add-shorts.ts) ─────────────
interface TA { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; n: number; }
function loadTA(s: string): TA | null {
  let b: string; try { b = fs.readFileSync(`${CACHE_1M}/${s}.json`, "utf8"); } catch { return null; }
  const r = JSON.parse(b) as Array<{t:number;o:number;h:number;l:number;c:number}>;
  const n = r.length; if (n < 5000) return null;
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
  for (let i = 0; i < n; i++) { t[i] = r[i]!.t; o[i] = r[i]!.o; h[i] = r[i]!.h; l[i] = r[i]!.l; c[i] = r[i]!.c; }
  return { t, o, h, l, c, n };
}
function agg(s: TA, im: number, mb: number): TA | null {
  const oT:number[]=[],oO:number[]=[],oH:number[]=[],oL:number[]=[],oC:number[]=[];
  let cT=-1,cO=0,cH=0,cL=0,cC=0,has=false;
  for (let i=0;i<s.n;i++){const bt=Math.floor(s.t[i]!/im)*im;if(!has||cT!==bt){if(has){oT.push(cT);oO.push(cO);oH.push(cH);oL.push(cL);oC.push(cC);}cT=bt;cO=s.o[i]!;cH=s.h[i]!;cL=s.l[i]!;cC=s.c[i]!;has=true;}else{if(s.h[i]!>cH)cH=s.h[i]!;if(s.l[i]!<cL)cL=s.l[i]!;cC=s.c[i]!;}}
  if(has){oT.push(cT);oO.push(cO);oH.push(cH);oL.push(cL);oC.push(cC);}
  if(oT.length<mb)return null;
  return {t:Float64Array.from(oT),o:Float64Array.from(oO),h:Float64Array.from(oH),l:Float64Array.from(oL),c:Float64Array.from(oC),n:oT.length};
}
function zs(c: TA, vw: number): Float64Array {
  const z = new Float64Array(c.n);
  for (let i=0;i<c.n;i++){if(i<vw+LB+1){z[i]=0;continue;}const mom=c.c[i]!/c.c[i-LB]!-1;let ss=0,cnt=0;for(let j=Math.max(1,i-vw);j<=i;j++){const r=c.c[j]!/c.c[j-1]!-1;ss+=r*r;cnt++;}const vol=Math.sqrt(ss/cnt);z[i]=vol===0?0:mom/vol;}
  return z;
}
interface PD { name: string; m1: TA; h1: TA; z1h: Float64Array; z4h: Float64Array; h1Map: Map<number, number>; m1Map: Map<number, number>; h4Map: Map<number, number>; spread: number; leverage: number; }

interface Stats {
  pnlDay: number; mdd: number; calmar: number; trades: number;
  trailExits: number; slExits: number; maxhExits: number; zrevExits: number;
  avgPeak: number; wr: number;
  pnlTotal: number;
}
interface Pos {
  pair: string; direction: 1 | -1; entryPrice: number; entryTime: number;
  stopLoss: number; peakLevPnlPct: number; entryZ1h: number;
  spread: number; leverage: number; notional: number;
}

interface TrailCfg {
  label: string;
  // null trail = no trail (use z-reversal exit)
  trail: { a: number; d: number } | null;
  zReversalExit: boolean;
  maxHoldH: number;
}

function sim(pairs: PD[], pByN: Map<string, PD>, timepoints: number[], cfg: TrailCfg, fromTs: number, toTs: number): Stats {
  const open: Pos[] = [];
  let rp = 0, mp = 0, mdd = 0, tt = 0, tw = 0;
  let trailExits = 0, slExits = 0, maxhExits = 0, zrevExits = 0;
  let peakSum = 0;
  const cd = new Map<string, number>();

  const days = (toTs - fromTs) / D;

  for (const ts of timepoints) {
    if (ts < fromTs || ts >= toTs) continue;
    const isH1 = ts % H === 0;

    // Snapshot z1h-at-bar for z-reversal logic (use prev hour's close-of-bar z)
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i]!;
      const pd = pByN.get(pos.pair)!;
      const bi = pd.m1Map.get(ts); if (bi === undefined) continue;
      const bL = pd.m1.l[bi]!, bH = pd.m1.h[bi]!, bC = pd.m1.c[bi]!;

      let xp = 0, rs = "";
      if ((ts - pos.entryTime) / H >= cfg.maxHoldH) { xp = bC; rs = "maxh"; }

      // SL
      if (!xp) {
        if (pos.direction === 1 && bL <= pos.stopLoss) { xp = pos.stopLoss; rs = "sl"; }
        else if (pos.direction === -1 && bH >= pos.stopLoss) { xp = pos.stopLoss; rs = "sl"; }
      }

      // Update peak
      const move = pos.direction === 1 ? bH / pos.entryPrice - 1 : 1 - bL / pos.entryPrice;
      const bp = move * pos.leverage * 100;
      if (bp > pos.peakLevPnlPct) pos.peakLevPnlPct = bp;

      // Trail
      if (!xp && cfg.trail) {
        if (pos.peakLevPnlPct >= cfg.trail.a) {
          const cur = (pos.direction === 1 ? bC / pos.entryPrice - 1 : 1 - bC / pos.entryPrice) * pos.leverage * 100;
          if (cur <= pos.peakLevPnlPct - cfg.trail.d) { xp = bC; rs = "trail"; }
        }
      }

      // Z-reversal exit (evaluated only on H1 boundary, using prev-bar z1h)
      if (!xp && cfg.zReversalExit && isH1) {
        const h1i = pd.h1Map.get(ts);
        if (h1i !== undefined && h1i > 0) {
          const z = pd.z1h[h1i - 1]!;
          // Long: exit when z crosses back through 0 from positive (i.e. z<=0 now, was >0 at entry)
          // Short: exit when z>=0 now, was <0 at entry
          if (pos.direction === 1 && z <= 0) { xp = pd.h1.o[h1i]!; rs = "zrev"; }
          else if (pos.direction === -1 && z >= 0) { xp = pd.h1.o[h1i]!; rs = "zrev"; }
        }
      }

      if (xp > 0) {
        const es = rs === "sl" ? pos.spread * 0.75 : pos.spread/2;
        const fpx = pos.direction === 1 ? xp * (1 - es) : xp * (1 + es);
        const ret = pos.direction === 1 ? fpx / pos.entryPrice - 1 : 1 - fpx / pos.entryPrice;
        const pnl = ret * pos.notional - pos.notional * FEE * 2;
        peakSum += pos.peakLevPnlPct;
        open.splice(i, 1); rp += pnl; tt++;
        if (pnl > 0) tw++;
        if (rs === "trail") trailExits++;
        else if (rs === "sl") slExits++;
        else if (rs === "maxh") maxhExits++;
        else if (rs === "zrev") zrevExits++;
        if (rs === "sl") cd.set(`${pos.pair}:${pos.direction}`, ts + CD_H * H);
      }
    }

    // Equity / drawdown
    let up = 0;
    for (const pos of open) {
      const pd = pByN.get(pos.pair)!;
      const bi = pd.m1Map.get(ts); if (bi === undefined) continue;
      const px = pd.m1.c[bi]!;
      const ret = pos.direction === 1 ? px * (1 - pos.spread) / pos.entryPrice - 1 : 1 - px * (1 + pos.spread) / pos.entryPrice;
      up += ret * pos.notional - pos.notional * FEE * 2;
    }
    const te = rp + up;
    if (te > mp) mp = te;
    if (mp - te > mdd) mdd = mp - te;

    if (!isH1) continue;
    if (BLOCK_HOURS.has(new Date(ts).getUTCHours())) continue;
    if (open.length >= MC) continue;

    for (const p of pairs) {
      if (open.length >= MC) break;
      if (open.some(po => po.pair === p.name)) continue;
      const h1i = p.h1Map.get(ts); if (h1i === undefined || h1i < 20) continue;
      const z1 = p.z1h[h1i - 1]!;
      const b4 = Math.floor(ts / H4) * H4;
      const h4i = p.h4Map.get(b4);
      const z4 = (h4i !== undefined && h4i > 0) ? p.z4h[h4i - 1]! : 0;

      // LONG
      if (z1 > LONG_Z1 && z4 > LONG_Z4) {
        const cdL = cd.get(`${p.name}:1`);
        if (!cdL || ts >= cdL) {
          const ep = p.h1.o[h1i]! * (1 + p.spread/2);
          const slPct = p.leverage >= 10 ? LONG_SL_HIGH : LONG_SL_LOW;
          const sl = ep * (1 - slPct);
          const no = MARGIN * p.leverage;
          open.push({ pair: p.name, direction: 1, entryPrice: ep, entryTime: ts, stopLoss: sl, peakLevPnlPct: 0, entryZ1h: z1, spread: p.spread, leverage: p.leverage, notional: no });
          continue;
        }
      }
      // SHORT
      if (z1 < -SHORT_Z1 && z4 < -SHORT_Z4) {
        const cdS = cd.get(`${p.name}:-1`);
        if (!cdS || ts >= cdS) {
          const ep = p.h1.o[h1i]! * (1 - p.spread/2);
          const slPct = p.leverage >= 10 ? SHORT_SL_HIGH : SHORT_SL_LOW;
          const sl = ep * (1 + slPct);
          const no = MARGIN * p.leverage;
          open.push({ pair: p.name, direction: -1, entryPrice: ep, entryTime: ts, stopLoss: sl, peakLevPnlPct: 0, entryZ1h: z1, spread: p.spread, leverage: p.leverage, notional: no });
        }
      }
    }
  }

  const pnlDay = days > 0 ? rp / days : 0;
  const calmar = mdd > 0 ? pnlDay / mdd : 0;
  const wr = tt > 0 ? tw / tt * 100 : 0;
  const avgPeak = tt > 0 ? peakSum / tt : 0;
  return { pnlDay, mdd, calmar, trades: tt, trailExits, slExits, maxhExits, zrevExits, avgPeak, wr, pnlTotal: rp };
}

// ───────────────────────── Main ─────────────────────────
async function main() {
  // Step 1: leverage map
  const leverageMap = await ensureLeverageMap();
  const getLeverage = (p: string) => Math.min(leverageMap.get(p) ?? 3, 10);

  // Step 2: ensure 1m caches (sequential to respect Binance rate limits)
  const fetchStart = OOS_START;
  const fetchEnd = OOS_END;
  for (const name of TOP15) {
    const sym = (RENAME[name] ?? name) + "USDT";
    try { await ensureCache(sym, fetchStart, fetchEnd); }
    catch (e) { console.log(`[fetch-err] ${sym}: ${e}`); }
  }

  // Step 3: load
  console.log("\nLoading top-15…");
  const pairs: PD[] = [];
  for (const name of TOP15) {
    const sym = RENAME[name] ?? name;
    let raw = loadTA(`${sym}USDT`); if (!raw) raw = loadTA(`${name}USDT`);
    if (!raw) { console.log(`  ${name}: missing`); continue; }
    const h1 = agg(raw, H, 200); const h4 = agg(raw, H4, 50);
    if (!h1 || !h4) { console.log(`  ${name}: insufficient bars`); continue; }
    const z1h = zs(h1, 15); const z4h = zs(h4, 20);
    const ms = OOS_START - 24 * H, me = OOS_END + 24 * H;
    const ki: number[] = []; for (let i = 0; i < raw.n; i++) if (raw.t[i]! >= ms && raw.t[i]! <= me) ki.push(i);
    const mn = ki.length;
    const m1: TA = { t: new Float64Array(mn), o: new Float64Array(mn), h: new Float64Array(mn), l: new Float64Array(mn), c: new Float64Array(mn), n: mn };
    for (let k = 0; k < mn; k++) { const i = ki[k]!; m1.t[k] = raw.t[i]!; m1.o[k] = raw.o[i]!; m1.h[k] = raw.h[i]!; m1.l[k] = raw.l[i]!; m1.c[k] = raw.c[i]!; }
    const h1Map = new Map<number, number>(); for (let i = 0; i < h1.n; i++) h1Map.set(h1.t[i]!, i);
    const m1Map = new Map<number, number>(); for (let i = 0; i < m1.n; i++) m1Map.set(m1.t[i]!, i);
    const h4Map = new Map<number, number>(); for (let i = 0; i < h4.n; i++) h4Map.set(h4.t[i]!, i);
    pairs.push({ name, m1, h1, z1h, z4h, h1Map, m1Map, h4Map, spread: SP[name] ?? DEFAULT_SPREAD, leverage: getLeverage(name) });
  }
  console.log(`Loaded ${pairs.length}/${TOP15.length}`);
  if (pairs.length < 10) { console.log("Too few pairs loaded — abort."); return; }

  const pByN = new Map<string, PD>(); pairs.forEach(p => pByN.set(p.name, p));
  const allTs = new Set<number>();
  for (const p of pairs) for (let i = 0; i < p.m1.n; i++) { const t = p.m1.t[i]!; if (t >= OOS_START && t < OOS_END) allTs.add(t); }
  const timepoints = [...allTs].sort((a, b) => a - b);
  console.log(`Timepoints: ${timepoints.length} (${OOS_DAYS.toFixed(0)} days)`);

  // Step 4: variants
  const variants: TrailCfg[] = [
    { label: "T15/4 (deployed)",            trail: { a: 15, d: 4 },  zReversalExit: false, maxHoldH: 120 },
    { label: "T20/5",                       trail: { a: 20, d: 5 },  zReversalExit: false, maxHoldH: 120 },
    { label: "T25/6",                       trail: { a: 25, d: 6 },  zReversalExit: false, maxHoldH: 120 },
    { label: "T25/8",                       trail: { a: 25, d: 8 },  zReversalExit: false, maxHoldH: 120 },
    { label: "T30/10",                      trail: { a: 30, d: 10 }, zReversalExit: false, maxHoldH: 120 },
    { label: "T15/3 (tighter)",             trail: { a: 15, d: 3 },  zReversalExit: false, maxHoldH: 120 },
    { label: "No trail + z-rev exit",       trail: null,             zReversalExit: true,  maxHoldH: 99999 },
    { label: "No trail + z-rev + maxH 120", trail: null,             zReversalExit: true,  maxHoldH: 120 },
  ];

  console.log("\n" + "=".repeat(140));
  console.log("TRAIL TIGHTNESS SWEEP — top-15, 297 days OOS, $10 margin, mc=7, deployed entry/SL config");
  console.log("=".repeat(140));
  console.log(`${"Variant".padEnd(36)} ${"$/day".padStart(7)} ${"MDD".padStart(7)} ${"Calmar".padStart(8)} ${"Trades".padStart(7)} ${"Trail".padStart(7)} ${"SL".padStart(5)} ${"MaxH".padStart(5)} ${"ZRev".padStart(5)} ${"AvgPk%".padStart(7)} ${"WR%".padStart(5)}`);

  const results: Array<{ cfg: TrailCfg; s: Stats }> = [];
  for (const v of variants) {
    const s = sim(pairs, pByN, timepoints, v, OOS_START, OOS_END);
    results.push({ cfg: v, s });
    console.log(`${v.label.padEnd(36)} ${s.pnlDay.toFixed(2).padStart(7)} ${s.mdd.toFixed(1).padStart(7)} ${s.calmar.toFixed(4).padStart(8)} ${String(s.trades).padStart(7)} ${String(s.trailExits).padStart(7)} ${String(s.slExits).padStart(5)} ${String(s.maxhExits).padStart(5)} ${String(s.zrevExits).padStart(5)} ${s.avgPeak.toFixed(1).padStart(7)} ${s.wr.toFixed(1).padStart(5)}`);
  }

  // Step 5: top 3 by Calmar (positive $/day only)
  const ranked = [...results].filter(r => r.s.pnlDay > 0).sort((a, b) => b.s.calmar - a.s.calmar).slice(0, 3);
  console.log("\n--- TOP 3 BY CALMAR ---");
  for (const r of ranked) {
    console.log(`  ${r.cfg.label}: $${r.s.pnlDay.toFixed(2)}/day, MDD $${r.s.mdd.toFixed(1)}, Calmar ${r.s.calmar.toFixed(4)}, ${r.s.trades} trades`);
  }

  // Step 6: walk-forward — split OOS into 4 quarters
  console.log("\n--- WALK-FORWARD (4 QUARTERS) ON TOP 3 ---");
  const wfBoundaries: Array<[number, number, string]> = [];
  const totalSpan = OOS_END - OOS_START;
  for (let q = 0; q < 4; q++) {
    const a = OOS_START + Math.floor(totalSpan * q / 4);
    const b = OOS_START + Math.floor(totalSpan * (q + 1) / 4);
    wfBoundaries.push([a, b, `Q${q+1}`]);
  }
  console.log(`${"Variant".padEnd(36)} ${"Q1 $/d".padStart(8)} ${"Q1 MDD".padStart(8)} ${"Q1 Cal".padStart(8)} ${"Q2 $/d".padStart(8)} ${"Q2 MDD".padStart(8)} ${"Q2 Cal".padStart(8)} ${"Q3 $/d".padStart(8)} ${"Q3 MDD".padStart(8)} ${"Q3 Cal".padStart(8)} ${"Q4 $/d".padStart(8)} ${"Q4 MDD".padStart(8)} ${"Q4 Cal".padStart(8)} ${"Q+".padStart(4)}`);
  for (const r of ranked) {
    let row = r.cfg.label.padEnd(36);
    let posQ = 0;
    for (const [a, b] of wfBoundaries) {
      const s = sim(pairs, pByN, timepoints, r.cfg, a, b);
      if (s.pnlDay > 0) posQ++;
      row += ` ${s.pnlDay.toFixed(2).padStart(7)} ${s.mdd.toFixed(1).padStart(7)} ${s.calmar.toFixed(3).padStart(7)}`;
    }
    row += ` ${String(posQ + "/4").padStart(4)}`;
    console.log(row);
  }

  // Step 7: side-by-side deployed vs best
  const deployed = results.find(r => r.cfg.label.startsWith("T15/4"))!;
  const best = ranked[0]!;
  console.log("\n--- DEPLOYED vs BEST ---");
  console.log(`Deployed (T15/4):  $${deployed.s.pnlDay.toFixed(2)}/day, MDD $${deployed.s.mdd.toFixed(1)}, Calmar ${deployed.s.calmar.toFixed(4)}, ${deployed.s.trades} trades, AvgPeak ${deployed.s.avgPeak.toFixed(1)}%`);
  console.log(`Best by Calmar:    ${best.cfg.label}: $${best.s.pnlDay.toFixed(2)}/day, MDD $${best.s.mdd.toFixed(1)}, Calmar ${best.s.calmar.toFixed(4)}, ${best.s.trades} trades, AvgPeak ${best.s.avgPeak.toFixed(1)}%`);
  const dDay = best.s.pnlDay - deployed.s.pnlDay;
  const dCal = best.s.calmar - deployed.s.calmar;
  const dMdd = best.s.mdd - deployed.s.mdd;
  console.log(`Delta: $/day ${dDay >= 0 ? "+" : ""}${dDay.toFixed(2)}, Calmar ${dCal >= 0 ? "+" : ""}${dCal.toFixed(4)}, MDD ${dMdd >= 0 ? "+" : ""}${dMdd.toFixed(1)}`);

  // emit machine-readable JSON for the message file
  const payload = {
    sweep: results.map(r => ({ label: r.cfg.label, ...r.s })),
    top3: ranked.map(r => r.cfg.label),
    deployed: { label: deployed.cfg.label, ...deployed.s },
    best: { label: best.cfg.label, ...best.s },
  };
  fs.writeFileSync("/tmp/bt-trail-tightness-results.json", JSON.stringify(payload, null, 2));
  console.log(`\nResults JSON: /tmp/bt-trail-tightness-results.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
