/**
 * ADX REGIME-SWITCH STRATEGY (Backtester #26)
 *
 * Hypothesis: Use ADX(14) on 1h to classify trending vs ranging markets,
 * trade MOMENTUM (breakout) in trending, MEAN REVERSION (fade z) in ranging.
 *
 * Trending regime (ADX > adxHigh):
 *   Long  if +DI > -DI AND close > max(high[1..lb])
 *   Short if -DI > +DI AND close < min(low [1..lb])
 *   SL 0.15% (exchange), trail 3/1 -> 9/0.5 -> 20/0.5, max hold 48h
 *
 * Ranging regime (ADX < adxLow):
 *   Long  if z1 < -zThr
 *   Short if z1 >  zThr
 *   SL 0.15% (exchange), exit when z crosses 0, max hold 12h
 *
 * Transition (adxLow <= ADX <= adxHigh): NO new entries.
 *
 * ADX formula (Wilder 1978, standard smoothing, period = 14):
 *   TR      = max(h-l, |h-c_prev|, |l-c_prev|)
 *   +DM     = (h - h_prev > l_prev - l) && (h - h_prev > 0) ? h - h_prev : 0
 *   -DM     = (l_prev - l > h - h_prev) && (l_prev - l > 0) ? l_prev - l : 0
 *   Wilder smooth:
 *     first ATR_14  = sum(TR,  1..14)
 *     first +DM_14  = sum(+DM, 1..14)
 *     first -DM_14  = sum(-DM, 1..14)
 *     then  ATR_i   = ATR_{i-1} - ATR_{i-1}/14 + TR_i   (same for +DM, -DM)
 *   +DI_i = 100 * +DM_14_i / ATR_i
 *   -DI_i = 100 * -DM_14_i / ATR_i
 *   DX_i  = 100 * | +DI_i - -DI_i | / (+DI_i + -DI_i)
 *   first ADX_14 = average(DX, 14..27)           [needs 2*period - 1 bars]
 *   then  ADX_i  = (ADX_{i-1}*13 + DX_i) / 14    [Wilder smoothing again]
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const D = 86_400_000;
const FEE = 0.00035;
const SL_SLIP_MULT = 1.5;
const MARGIN = 15;
const BLOCK = [22, 23];

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1e-4, SOL: 2e-4, SUI: 1.85e-4,
  AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DSP = 5e-4;
const RM: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };
const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
function gl(n: string): number { return Math.min(LM.get(n) ?? 3, 10); }

const ALL = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET","FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR","PENDLE","PNUT","ATOM","TON","SEI","STX",
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN","TNSR","CATI","TURBO","MOVE","GALA","STRK","SAGA","ILV","GMX","OM",
  "CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC","USUAL","UMA","USTC","MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS","MINA","LISTA","NEO","AI","SCR","APE","KAITO","AR","BNT","PIXEL",
  "LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET","STG","REQ","CAKE","SUPER","FTT","STRAX",
];

// Walk-forward windows
const IS_S = new Date("2025-06-01").getTime();
const IS_E = new Date("2025-12-01").getTime();
const OOS_S = new Date("2025-12-01").getTime();
const OOS_E = new Date("2026-03-25").getTime();
const IS_D = (IS_E - IS_S) / D;
const OOS_D = (OOS_E - OOS_S) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }

function ld(s: string): C[] {
  const f = path.join(CACHE_5M, `${s}.json`);
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as any[])
    .map((b: any) => Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] } : b)
    .sort((a: C, b: C) => a.t - b.t);
}

function agg(b: C[], p: number, m: number): C[] {
  const g = new Map<number, C[]>();
  for (const c of b) {
    const k = Math.floor(c.t / p) * p;
    let a = g.get(k);
    if (!a) { a = []; g.set(k, a); }
    a.push(c);
  }
  const r: C[] = [];
  for (const [t, grp] of g) {
    if (grp.length < m) continue;
    grp.sort((a, b) => a.t - b.t);
    r.push({
      t,
      o: grp[0]!.o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1]!.c,
    });
  }
  return r.sort((a, b) => a.t - b.t);
}

// Z-score (momentum / vol) on 1h closes — same formula used elsewhere in this repo
const MOM_LB = 3;
const VOL_WIN = 20;
function computeZ(cs: C[]): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < cs.length; i++) {
    const m = cs[i]!.c / cs[i - MOM_LB]!.c - 1;
    let ss = 0, c = 0;
    for (let j = Math.max(1, i - VOL_WIN); j <= i; j++) {
      const r = cs[j]!.c / cs[j - 1]!.c - 1;
      ss += r * r;
      c++;
    }
    if (c < 10) continue;
    const v = Math.sqrt(ss / c);
    if (v === 0) continue;
    z[i] = m / v;
  }
  return z;
}

/**
 * Wilder ADX(14) on 1h bars. Returns arrays aligned to cs.
 * adx[i] is ADX value AS OF close of bar i (usable at start of bar i+1).
 */
function computeADX(cs: C[], period = 14): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const n = cs.length;
  const adx = new Array(n).fill(0);
  const plusDI = new Array(n).fill(0);
  const minusDI = new Array(n).fill(0);
  if (n < 2 * period + 1) return { adx, plusDI, minusDI };

  const tr = new Array(n).fill(0);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const h = cs[i]!.h, l = cs[i]!.l, cp = cs[i - 1]!.c;
    const hp = cs[i - 1]!.h, lp = cs[i - 1]!.l;
    tr[i] = Math.max(h - l, Math.abs(h - cp), Math.abs(l - cp));
    const up = h - hp;
    const dn = lp - l;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
  }

  // Wilder-smoothed ATR, +DM, -DM starting at i = period (sum of 1..period)
  const atr = new Array(n).fill(0);
  const pdmS = new Array(n).fill(0);
  const mdmS = new Array(n).fill(0);
  let trSum = 0, pSum = 0, mSum = 0;
  for (let i = 1; i <= period; i++) { trSum += tr[i]; pSum += pdm[i]; mSum += mdm[i]; }
  atr[period] = trSum;
  pdmS[period] = pSum;
  mdmS[period] = mSum;
  for (let i = period + 1; i < n; i++) {
    atr[i]  = atr[i - 1]  - atr[i - 1]  / period + tr[i];
    pdmS[i] = pdmS[i - 1] - pdmS[i - 1] / period + pdm[i];
    mdmS[i] = mdmS[i - 1] - mdmS[i - 1] / period + mdm[i];
  }

  const dx = new Array(n).fill(0);
  for (let i = period; i < n; i++) {
    if (atr[i] === 0) { plusDI[i] = 0; minusDI[i] = 0; continue; }
    const pDI = 100 * pdmS[i] / atr[i];
    const mDI = 100 * mdmS[i] / atr[i];
    plusDI[i] = pDI;
    minusDI[i] = mDI;
    const sum = pDI + mDI;
    dx[i] = sum > 0 ? 100 * Math.abs(pDI - mDI) / sum : 0;
  }

  // First ADX = average of DX over [period .. 2*period - 1], stored at index 2*period - 1
  const firstIdx = 2 * period - 1;
  if (firstIdx >= n) return { adx, plusDI, minusDI };
  let dxSum = 0;
  for (let i = period; i <= firstIdx; i++) dxSum += dx[i];
  adx[firstIdx] = dxSum / period;
  for (let i = firstIdx + 1; i < n; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }
  return { adx, plusDI, minusDI };
}

function fmtPnl(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface PD {
  name: string;
  m5: C[]; h1: C[];
  z1: number[];
  adx: number[]; pDI: number[]; mDI: number[];
  h1Map: Map<number, number>;
  m5Map: Map<number, number>;
  sp: number; lev: number; not: number;
}

interface Opts {
  adxLow: number;
  adxHigh: number;
  zThr: number;
  breakoutLB: number;       // lookback bars for prior high/low
  slPct: number;            // exchange SL
  trail: { a: number; d: number }[];
  maxHoldTrendH: number;
  maxHoldRangeH: number;
  label: string;
}

interface OP {
  pair: string;
  dir: "long" | "short";
  regime: "trend" | "range";
  ep: number;
  et: number;
  sl: number;
  pk: number;
  sp: number;
  lev: number;
  not: number;
}

function runWindow(pairs: PD[], winS: number, winE: number, opts: Opts) {
  // Union of 5m timestamps in window
  const all5m = new Set<number>();
  for (const p of pairs) for (const b of p.m5) if (b.t >= winS && b.t < winE) all5m.add(b.t);
  const tps = [...all5m].sort((a, b) => a - b);

  const open: OP[] = [];
  const closed: { pnl: number; reason: string; regime: "trend" | "range" }[] = [];

  for (const ts of tps) {
    const isH1 = ts % H === 0;

    // ── EXITS on every 5m bar ──
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i]!;
      const pd = pairs.find(p => p.name === pos.pair)!;
      const m5i = pd.m5Map.get(ts);
      if (m5i === undefined) continue;
      const bar = pd.m5[m5i]!;

      let xp = 0, reason = "", isSL = false;

      const maxH = pos.regime === "trend" ? opts.maxHoldTrendH : opts.maxHoldRangeH;
      if ((ts - pos.et) / H >= maxH) { xp = bar.c; reason = "maxh"; }

      // Exchange SL (fires on 5m)
      if (!xp && pos.sl > 0) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }

      // Trend: trailing stop on 1h boundary
      if (!xp && pos.regime === "trend") {
        const best = pos.dir === "long"
          ? (bar.h / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.l - 1) * pos.lev * 100;
        if (best > pos.pk) pos.pk = best;
        if (isH1) {
          const cur = pos.dir === "long"
            ? (bar.c / pos.ep - 1) * pos.lev * 100
            : (pos.ep / bar.c - 1) * pos.lev * 100;
          let td = Infinity;
          for (const s of opts.trail) if (pos.pk >= s.a) td = s.d;
          if (td < Infinity && cur <= pos.pk - td) { xp = bar.c; reason = "trail"; }
        }
      }

      // Range: exit when z crosses 0 (checked at 1h boundary)
      if (!xp && pos.regime === "range" && isH1) {
        const h1i = pd.h1Map.get(ts);
        if (h1i !== undefined && h1i >= 1) {
          const zNow = pd.z1[h1i - 1]!;
          if ((pos.dir === "long" && zNow >= 0) || (pos.dir === "short" && zNow <= 0)) {
            xp = bar.c; reason = "z-cross";
          }
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP_MULT : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pnl, reason, regime: pos.regime });
        open.splice(i, 1);
      }
    }

    // ── ENTRIES only on 1h boundaries ──
    if (!isH1) continue;
    if (BLOCK.includes(new Date(ts).getUTCHours())) continue;

    for (const p of pairs) {
      const h1i = p.h1Map.get(ts);
      if (h1i === undefined) continue;
      if (h1i < Math.max(VOL_WIN + 2, 2 * 14 + opts.breakoutLB + 2)) continue;
      if (open.some(o => o.pair === p.name)) continue;

      // Signals use data from prior bar (h1i - 1) to avoid look-ahead
      const prevIdx = h1i - 1;
      const adx = p.adx[prevIdx]!;
      const pDI = p.pDI[prevIdx]!;
      const mDI = p.mDI[prevIdx]!;
      const z1  = p.z1[prevIdx]!;

      let dir: "long" | "short" | null = null;
      let regime: "trend" | "range" | null = null;

      if (adx > opts.adxHigh) {
        // Trending: breakout entry on prior bar
        const cl   = p.h1[prevIdx]!.c;
        let hh = -Infinity, ll = Infinity;
        for (let k = 1; k <= opts.breakoutLB; k++) {
          const idx = prevIdx - k;
          if (idx < 0) break;
          if (p.h1[idx]!.h > hh) hh = p.h1[idx]!.h;
          if (p.h1[idx]!.l < ll) ll = p.h1[idx]!.l;
        }
        if (pDI > mDI && cl > hh) { dir = "long";  regime = "trend"; }
        else if (mDI > pDI && cl < ll) { dir = "short"; regime = "trend"; }
      } else if (adx < opts.adxLow) {
        // Ranging: fade z extreme
        if (z1 >  opts.zThr) { dir = "short"; regime = "range"; }
        else if (z1 < -opts.zThr) { dir = "long"; regime = "range"; }
      }

      if (!dir || !regime) continue;

      const ep = dir === "long"
        ? p.h1[h1i]!.o * (1 + p.sp)
        : p.h1[h1i]!.o * (1 - p.sp);
      const slDist = ep * opts.slPct;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      open.push({ pair: p.name, dir, regime, ep, et: ts, sl, pk: 0, sp: p.sp, lev: p.lev, not: p.not });
    }
  }

  // Close residual positions at last bar
  for (const pos of open) {
    const pd = pairs.find(p => p.name === pos.pair)!;
    const lb = pd.m5[pd.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pnl, reason: "end", regime: pos.regime });
  }

  const total = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0).length;
  const wr = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  const gp = closed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl2 = Math.abs(closed.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = gl2 > 0 ? gp / gl2 : Infinity;
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  const tTrd = closed.filter(t => t.regime === "trend");
  const rTrd = closed.filter(t => t.regime === "range");
  const tPnl = tTrd.reduce((s, t) => s + t.pnl, 0);
  const rPnl = rTrd.reduce((s, t) => s + t.pnl, 0);
  const tWr = tTrd.length > 0 ? tTrd.filter(t => t.pnl > 0).length / tTrd.length * 100 : 0;
  const rWr = rTrd.length > 0 ? rTrd.filter(t => t.pnl > 0).length / rTrd.length * 100 : 0;

  return {
    trades: closed.length, wr, pf, total, maxDD,
    trendTrd: tTrd.length, trendPnl: tPnl, trendWr: tWr,
    rangeTrd: rTrd.length, rangePnl: rPnl, rangeWr: rWr,
  };
}

function fmtRow(label: string, r: ReturnType<typeof runWindow>, days: number): string {
  return `  ${label.padEnd(46)} ${String(r.trades).padStart(5)} ${(r.wr.toFixed(1) + "%").padStart(6)} ${r.pf.toFixed(2).padStart(5)} ${fmtPnl(r.total / days).padStart(9)} $${r.maxDD.toFixed(0).padStart(3)}   ${String(r.trendTrd).padStart(4)}/${(r.trendWr.toFixed(0)+"%").padStart(4)}/${fmtPnl(r.trendPnl).padStart(8)}   ${String(r.rangeTrd).padStart(4)}/${(r.rangeWr.toFixed(0)+"%").padStart(4)}/${fmtPnl(r.rangePnl).padStart(8)}`;
}

function main() {
  console.log("=".repeat(140));
  console.log("  ADX REGIME-SWITCH BACKTEST #26");
  console.log("  Wilder ADX(14) 1h — trending: breakout+trail, ranging: z-fade → z-cross");
  console.log("  $15 margin, SL 0.15%, real leverage, walk-forward IS Jun-Dec 2025, OOS Dec-Mar 2026");
  console.log("=".repeat(140));

  console.log("\n  Loading 5m data, aggregating 1h, computing ADX + z-score...");
  const pairs: PD[] = [];
  for (const n of ALL) {
    const s = RM[n] ?? n;
    let raw = ld(`${s}USDT`); if (raw.length < 5000) raw = ld(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = agg(raw, H, 10);
    if (h1.length < 100) continue;
    const z1 = computeZ(h1);
    const { adx, plusDI, minusDI } = computeADX(h1, 14);
    const h1Map = new Map<number, number>(); h1.forEach((c, i) => h1Map.set(c.t, i));
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    const m5Map = new Map<number, number>(); m5.forEach((c, i) => m5Map.set(c.t, i));
    const lev = gl(n);
    pairs.push({
      name: n, m5, h1, z1,
      adx, pDI: plusDI, mDI: minusDI,
      h1Map, m5Map,
      sp: SP[n] ?? DSP, lev, not: MARGIN * lev,
    });
  }
  console.log(`  ${pairs.length} pairs loaded\n`);

  // Sanity check ADX on BTC/ETH if present
  for (const n of ["BTC", "ETH", "SOL"]) {
    const p = pairs.find(x => x.name === n);
    if (p) {
      const nz = p.adx.filter(v => v > 0);
      if (nz.length > 0) {
        const avg = nz.reduce((a, b) => a + b, 0) / nz.length;
        const max = Math.max(...nz);
        const min = Math.min(...nz);
        console.log(`  ADX sanity ${n.padEnd(5)}: non-zero bars=${nz.length} avg=${avg.toFixed(1)} min=${min.toFixed(1)} max=${max.toFixed(1)}`);
      }
    }
  }
  console.log();

  const TRAIL = [{ a: 3, d: 1 }, { a: 9, d: 0.5 }, { a: 20, d: 0.5 }];

  // Build configs: ADX thresholds x z thresholds x breakout lookback
  const adxCombos = [
    { lo: 20, hi: 25 }, // current
    { lo: 18, hi: 28 },
    { lo: 22, hi: 28 },
  ];
  const zThrs = [2.0, 2.5, 3.0];
  const lbs = [1, 3, 5];

  interface Run { label: string; opts: Opts; is: ReturnType<typeof runWindow>; oos: ReturnType<typeof runWindow> | null; }
  const results: Run[] = [];

  const hdr = `  ${"Config".padEnd(46)} ${"Trd".padStart(5)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"$/day".padStart(9)} ${"MDD".padStart(4)}   Trend:${"nTrd/WR/Pnl".padStart(18)}   Range:${"nTrd/WR/Pnl".padStart(18)}`;

  console.log("=".repeat(140));
  console.log("  IN-SAMPLE (Jun 2025 - Dec 2025)");
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("  " + "-".repeat(135));

  for (const a of adxCombos) {
    for (const z of zThrs) {
      for (const lb of lbs) {
        const opts: Opts = {
          adxLow: a.lo, adxHigh: a.hi, zThr: z, breakoutLB: lb,
          slPct: 0.0015,
          trail: TRAIL,
          maxHoldTrendH: 48, maxHoldRangeH: 12,
          label: `ADX${a.lo}/${a.hi} z${z.toFixed(1)} lb${lb}`,
        };
        const is = runWindow(pairs, IS_S, IS_E, opts);
        console.log(fmtRow(opts.label, is, IS_D));
        results.push({ label: opts.label, opts, is, oos: null });
      }
    }
  }

  // Filter IS survivors: $/day > 0.50 AND PF > 1.2 AND MDD < 30 AND trades > 20
  const survivors = results
    .filter(r => r.is.total / IS_D > 0.5 && r.is.pf > 1.2 && r.is.maxDD < 30 && r.is.trades > 20)
    .sort((a, b) => (b.is.total / IS_D) - (a.is.total / IS_D));

  console.log(`\n  IS survivors: ${survivors.length}/${results.length}`);

  const topN = Math.min(10, survivors.length);
  console.log(`\n${"=".repeat(140)}`);
  console.log(`  OUT-OF-SAMPLE (Dec 2025 - Mar 2026) — top ${topN} IS survivors`);
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("  " + "-".repeat(135));

  const topOos: Run[] = [];
  for (const r of survivors.slice(0, topN)) {
    r.oos = runWindow(pairs, OOS_S, OOS_E, r.opts);
    console.log(fmtRow(r.label, r.oos, OOS_D));
    topOos.push(r);
  }

  // Also run the single-strategy baselines on OOS to compare whether regime-switch adds edge
  console.log(`\n${"=".repeat(140)}`);
  console.log("  BASELINE: single-strategy (regime classifier disabled) on OOS");
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("  " + "-".repeat(135));

  // Pure breakout (always trend logic): set adxLow = adxHigh = -1 so everything > adxHigh
  // Easiest: pass adxLow = -1 and adxHigh = -1 (then adx > -1 always true for trend branch)
  const pureTrend: Opts = { adxLow: -1, adxHigh: -1, zThr: 999, breakoutLB: 3, slPct: 0.0015, trail: TRAIL, maxHoldTrendH: 48, maxHoldRangeH: 12, label: "PURE-BREAKOUT lb3" };
  const pureTrend5: Opts = { ...pureTrend, breakoutLB: 5, label: "PURE-BREAKOUT lb5" };
  const pureTrend1: Opts = { ...pureTrend, breakoutLB: 1, label: "PURE-BREAKOUT lb1" };
  // Pure mean reversion (always range logic): set adxHigh = 9999 and adxLow = 9999
  const pureMR25: Opts = { adxLow: 9999, adxHigh: 9999, zThr: 2.5, breakoutLB: 3, slPct: 0.0015, trail: TRAIL, maxHoldTrendH: 48, maxHoldRangeH: 12, label: "PURE-MR z2.5" };
  const pureMR20: Opts = { ...pureMR25, zThr: 2.0, label: "PURE-MR z2.0" };
  const pureMR30: Opts = { ...pureMR25, zThr: 3.0, label: "PURE-MR z3.0" };

  for (const o of [pureTrend1, pureTrend, pureTrend5, pureMR20, pureMR25, pureMR30]) {
    const r = runWindow(pairs, OOS_S, OOS_E, o);
    console.log(fmtRow(o.label, r, OOS_D));
  }

  // Pick best OOS
  console.log(`\n${"=".repeat(140)}`);
  console.log("  FINAL RANKING (IS survivors sorted by OOS $/day, kill if OOS < $0.30/day or MDD > $20)");
  console.log("=".repeat(140));
  console.log(`  ${"Config".padEnd(46)} ${"IS $/d".padStart(9)} ${"OOS $/d".padStart(9)} ${"OOS PF".padStart(7)} ${"OOS MDD".padStart(8)} ${"OOS Trd".padStart(8)} ${"OOS WR".padStart(7)} ${"verdict".padStart(10)}`);
  console.log("  " + "-".repeat(130));
  topOos.sort((a, b) => (b.oos!.total / OOS_D) - (a.oos!.total / OOS_D));
  for (const r of topOos) {
    const oos = r.oos!;
    const dpd = oos.total / OOS_D;
    const verdict = (dpd < 0.30 || oos.maxDD > 20) ? "KILL" : "KEEP";
    console.log(`  ${r.label.padEnd(46)} ${fmtPnl(r.is.total / IS_D).padStart(9)} ${fmtPnl(dpd).padStart(9)} ${oos.pf.toFixed(2).padStart(7)} ${("$"+oos.maxDD.toFixed(0)).padStart(8)} ${String(oos.trades).padStart(8)} ${(oos.wr.toFixed(1)+"%").padStart(7)} ${verdict.padStart(10)}`);
  }
}

main();
