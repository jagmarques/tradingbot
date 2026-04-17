/**
 * bt-failed-breakout.ts
 *
 * FAILED BREAKOUT TRAP (Turtle Soup) — Linda Raschke "Street Smarts"
 *
 * Signal (5m bars, 3-bar setup):
 *   - bar[N-2] "mother": the larger bar
 *   - bar[N-1] INSIDE BAR: high <= mother.h AND low >= mother.l AND range < ratio * mother range
 *   - bar[N]: breaks mother.h OR mother.l by >= breachPct, THEN closes BACK inside mother range
 *
 * Entry at bar[N] close:
 *   - bar[N] broke mother HIGH and closed inside -> SHORT (failed up-breakout)
 *   - bar[N] broke mother LOW and closed inside  -> LONG  (failed down-breakout)
 *   SL = wick extreme + 0.05% buffer
 *   TP = opposite end of mother bar
 *   Max hold = 6 bars (30 min)
 *
 * Also: optional multi-stage trail 3/1 -> 9/0.5 -> 20/0.5 instead of fixed TP
 * Also: 1h timeframe version (slower, less noise)
 *
 * CRITICAL: must have NEGATIVE correlation with Range Expansion (breakouts-continue bet).
 *
 * IS:  2025-06-01 -> 2025-12-01
 * OOS: 2025-12-01 -> 2026-03-25
 * FEE 0.00035, SL_SLIP 1.5, $15 margin, block h22-23.
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const D = 86_400_000;
const FIVE_M = 5 * 60 * 1000;
const FEE = 0.00035;
const SL_SLIP = 1.5;
const BLOCK = new Set([22, 23]);

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DSP = 5e-4;
const RM: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };

const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
const getLev = (n: string) => Math.min(LM.get(n) ?? 3, 10);

const ALL_PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
  "ZEC", "AVAX", "NEAR", "kPEPE", "SUI", "HYPE", "FET",
  "FIL", "ALGO", "BCH", "JTO", "SAND", "BLUR", "TAO", "RENDER", "TRX", "AAVE",
  "JUP", "POL", "CRV", "PYTH", "IMX", "BNB", "ONDO", "XLM", "DYDX", "ICP", "LTC", "MKR",
  "PENDLE", "PNUT", "ATOM", "TON", "SEI", "STX",
  "DYM", "CFX", "ALT", "BIO", "OMNI", "ORDI", "XAI", "SUSHI", "ME", "ZEN",
  "TNSR", "CATI", "TURBO", "MOVE", "GALA", "STRK", "SAGA", "ILV", "GMX", "OM",
  "CYBER", "NTRN", "BOME", "MEME", "ANIME", "BANANA", "ETC", "USUAL", "UMA", "USTC",
  "MAV", "REZ", "NOT", "PENGU", "BIGTIME", "WCT", "EIGEN", "MANTA", "POLYX", "W",
  "FXS", "GMT", "RSR", "PEOPLE", "YGG", "TRB", "ETHFI", "ENS", "OGN", "AXS",
  "MINA", "LISTA", "NEO", "AI", "SCR", "APE", "KAITO", "AR", "BNT", "PIXEL",
  "LAYER", "ZRO", "CELO", "ACE", "COMP", "RDNT", "ZK", "MET", "STG", "REQ",
  "CAKE", "SUPER", "FTT", "STRAX",
];

const IS_S = new Date("2025-06-01").getTime();
const IS_E = new Date("2025-12-01").getTime();
const OOS_S = new Date("2025-12-01").getTime();
const OOS_E = new Date("2026-03-25").getTime();
const IS_D = (IS_E - IS_S) / D;
const OOS_D = (OOS_E - OOS_S) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }

interface PI {
  m5: C[];
  h1: C[];
  rv24: number[];
  rv168: number[];
  h1Map: Map<number, number>;
}
interface PD { name: string; ind: PI; sp: number; lev: number; }

function load(s: string): C[] {
  const f = path.join(CACHE_5M, `${s}.json`);
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as unknown[])
    .map((b: unknown) => {
      if (Array.isArray(b)) return { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
      const o = b as Record<string, number>;
      return { t: +o.t, o: +o.o, h: +o.h, l: +o.l, c: +o.c };
    })
    .sort((a, b) => a.t - b.t);
}

function aggregate(bars: C[], period: number, minBars: number): C[] {
  const g = new Map<number, C[]>();
  for (const c of bars) {
    const k = Math.floor(c.t / period) * period;
    let arr = g.get(k);
    if (!arr) { arr = []; g.set(k, arr); }
    arr.push(c);
  }
  const r: C[] = [];
  for (const [t, grp] of g) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    r.push({ t, o: grp[0]!.o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1]!.c });
  }
  return r.sort((a, b) => a.t - b.t);
}

function computeRVFast(cs: C[], window: number): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < window + 2) return out;
  const r2: number[] = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const r = cs[i]!.c / cs[i - 1]!.c - 1;
    r2[i] = r * r;
  }
  let sum = 0;
  for (let i = 1; i <= window; i++) sum += r2[i]!;
  out[window] = Math.sqrt(sum / window);
  for (let i = window + 1; i < cs.length; i++) {
    sum += r2[i]! - r2[i - window]!;
    out[i] = Math.sqrt(sum / window);
  }
  return out;
}

function computeATR(cs: C[], period: number): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < period + 2) return out;
  const tr: number[] = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const h = cs[i]!.h, l = cs[i]!.l, pc = cs[i - 1]!.c;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  let atr = sum / period;
  out[period] = atr;
  for (let i = period + 1; i < cs.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    out[i] = atr;
  }
  return out;
}

// Pre-detect all Turtle Soup setups on a given bar series.
// Returns array of signal indices: { idx: N (setup bar), dir, motherHi, motherLo, wickExtreme }
interface SoupSig {
  idx: number;       // index of bar N (the setup bar, entry at its close)
  dir: "long" | "short";
  motherHi: number;
  motherLo: number;
  wickExtreme: number; // bar[N].l for long (break down), bar[N].h for short (break up)
}
function detectSoup(
  cs: C[],
  insideRatio: number,
  breachPct: number,
): SoupSig[] {
  const out: SoupSig[] = [];
  for (let i = 2; i < cs.length; i++) {
    const mother = cs[i - 2]!;
    const inside = cs[i - 1]!;
    const bar = cs[i]!;
    const mRange = mother.h - mother.l;
    if (mRange <= 0) continue;
    const iRange = inside.h - inside.l;
    // Inside bar constraint
    if (inside.h > mother.h || inside.l < mother.l) continue;
    if (iRange >= insideRatio * mRange) continue;
    // Break mother high or low by >= breachPct, THEN close back inside mother range
    const breakUp = bar.h > mother.h * (1 + breachPct);
    const breakDn = bar.l < mother.l * (1 - breachPct);
    const closedInside = bar.c <= mother.h && bar.c >= mother.l;
    if (!closedInside) continue;
    if (breakUp && !breakDn) {
      // Failed UP breakout -> SHORT
      out.push({ idx: i, dir: "short", motherHi: mother.h, motherLo: mother.l, wickExtreme: bar.h });
    } else if (breakDn && !breakUp) {
      // Failed DOWN breakout -> LONG
      out.push({ idx: i, dir: "long", motherHi: mother.h, motherLo: mother.l, wickExtreme: bar.l });
    }
    // If both directions broke (very wide bar), skip — unclear signal
  }
  return out;
}

// Pearson correlation
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]!; sb += b[i]!; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i]! - ma, xb = b[i]! - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

interface Cfg {
  label: string;
  tf: "5m" | "1h";
  insideRatio: number;
  breachPct: number;
  slWickBufferPct: number;    // buffer beyond wick extreme for stop (e.g. 0.0005)
  slMaxPct: number;           // cap on SL distance as fraction of entry (safety)
  useTP: boolean;             // true: TP=opposite mother end; false: use trail stages
  trailStages: Array<{ act: number; dist: number }>;
  maxHoldBars: number;        // in bars of tf
  regime: boolean;            // RV24/RV168 filter
  regimeThr: number;
  longOnly: boolean;
  shortOnly: boolean;
  margin: number;
}

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number;
  numTrades: number; maxSingleLoss: number;
  dailyPnl: Map<number, number>;
  reasonCounts: Record<string, number>;
}

interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }

// Simulate Failed Breakout on a single timeframe series per pair.
function simulate(
  pairs: PD[],
  cfg: Cfg,
  startTs: number,
  endTs: number,
  days: number,
): Res {
  const closed: Tr[] = [];
  const dailyPnl = new Map<number, number>();
  const reasonCounts: Record<string, number> = {};

  for (const p of pairs) {
    const cs = cfg.tf === "5m" ? p.ind.m5 : p.ind.h1;
    if (cs.length < 200) continue;
    const sigs = detectSoup(cs, cfg.insideRatio, cfg.breachPct);

    // If using trail stages and no TP, we need to walk forward bar by bar on the
    // SAME timeframe. For 5m tf, pair cache IS 5m. For 1h tf, we walk h1 bars.
    // For stop/TP fills we use bar h/l of the cs series.

    let lastExitTs = 0; // pair-level cooldown: no overlap
    for (const s of sigs) {
      const setupBar = cs[s.idx]!;
      if (setupBar.t < startTs || setupBar.t >= endTs) continue;
      if (setupBar.t < lastExitTs) continue;
      const hour = new Date(setupBar.t).getUTCHours();
      if (BLOCK.has(hour)) continue;

      // regime filter — use h1 rv24/rv168 for both timeframes (daily-ish regime)
      if (cfg.regime) {
        // map setup bar time to h1 bucket
        const hKey = Math.floor(setupBar.t / H) * H;
        const hi = p.ind.h1Map.get(hKey);
        if (hi === undefined) continue;
        const rv24 = p.ind.rv24[hi] ?? 0;
        const rv168 = p.ind.rv168[hi] ?? 0;
        if (rv24 === 0 || rv168 === 0) continue;
        if (rv24 / rv168 < cfg.regimeThr) continue;
      }
      if (cfg.longOnly && s.dir === "short") continue;
      if (cfg.shortOnly && s.dir === "long") continue;

      // Entry at setup bar close (raw) -> +/- spread slippage
      const rawEp = setupBar.c;
      const ep = s.dir === "long" ? rawEp * (1 + p.sp) : rawEp * (1 - p.sp);

      // Stop: wick extreme +/- buffer, but cap by slMaxPct
      let sl: number;
      if (s.dir === "long") {
        const raw = s.wickExtreme * (1 - cfg.slWickBufferPct);
        const cap = ep * (1 - cfg.slMaxPct);
        sl = Math.max(raw, cap); // long: sl is below entry; higher is tighter
      } else {
        const raw = s.wickExtreme * (1 + cfg.slWickBufferPct);
        const cap = ep * (1 + cfg.slMaxPct);
        sl = Math.min(raw, cap); // short: sl is above entry; lower is tighter
      }

      // TP (if enabled): opposite end of mother bar
      const tp = cfg.useTP
        ? (s.dir === "long" ? s.motherHi : s.motherLo)
        : 0;

      const notional = cfg.margin * p.lev;

      // Walk forward on same tf bars starting at s.idx + 1
      let xp = 0, reason = "", isSL = false, pk = 0, exitTs = setupBar.t;
      let bars = 0;
      for (let j = s.idx + 1; j < cs.length; j++) {
        const b = cs[j]!;
        bars++;
        if (b.t >= endTs) break;
        if (bars > cfg.maxHoldBars) { xp = b.o; reason = "maxh"; exitTs = b.t; break; }

        // SL check
        const slHit = s.dir === "long" ? b.l <= sl : b.h >= sl;
        if (slHit) { xp = sl; reason = "sl"; isSL = true; exitTs = b.t; break; }

        // TP check (if using TP)
        if (cfg.useTP) {
          const tpHit = s.dir === "long" ? b.h >= tp : b.l <= tp;
          if (tpHit) { xp = tp; reason = "tp"; exitTs = b.t; break; }
        }

        // Trail check (if not using TP)
        if (!cfg.useTP && cfg.trailStages.length > 0) {
          const best = s.dir === "long"
            ? (b.h / ep - 1) * p.lev * 100
            : (ep / b.l - 1) * p.lev * 100;
          if (best > pk) pk = best;
          const cur = s.dir === "long"
            ? (b.c / ep - 1) * p.lev * 100
            : (ep / b.c - 1) * p.lev * 100;
          // Pick tightest active trail: largest act <= pk
          let activeDist = 0;
          for (const st of cfg.trailStages) {
            if (pk >= st.act) {
              activeDist = st.dist;
            }
          }
          if (activeDist > 0 && cur <= pk - activeDist) {
            xp = b.c; reason = "trail"; exitTs = b.t; break;
          }
        }
      }
      if (xp === 0) {
        const lb = cs[cs.length - 1]!;
        xp = lb.c; reason = "end"; exitTs = lb.t;
      }

      const rsp = isSL ? p.sp * SL_SLIP : p.sp;
      const ex = s.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
      const fees = notional * FEE * 2;
      const pnl = (s.dir === "long" ? (ex / ep - 1) : (ep / ex - 1)) * notional - fees;
      closed.push({ pair: p.name, dir: s.dir, exitTs, pnl, reason });
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;

      const dayKey = Math.floor(exitTs / D);
      dailyPnl.set(dayKey, (dailyPnl.get(dayKey) ?? 0) + pnl);

      lastExitTs = exitTs;
    }
  }

  closed.sort((a, b) => a.exitTs - b.exitTs);

  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const wr = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = glAbs > 0 ? gp / glAbs : (wins.length > 0 ? 99 : 0);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    numTrades: closed.length,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    dailyPnl,
    reasonCounts,
  };
}

// =============================================================
// GARCH v2 baseline (for correlation reference)
// Signal: 1h z-score > 2.0 AND 4h z-score > 1.5 -> long (and inverse for short)
// =============================================================
function computeZ(cs: C[]): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = 22; i < cs.length; i++) {
    const m = cs[i]!.c / cs[i - 3]!.c - 1;
    let ss = 0, c = 0;
    for (let j = Math.max(1, i - 20); j <= i; j++) {
      const r = cs[j]!.c / cs[j - 1]!.c - 1;
      ss += r * r; c++;
    }
    if (c < 10) continue;
    const v = Math.sqrt(ss / c);
    if (v === 0) continue;
    z[i] = m / v;
  }
  return z;
}

interface GarchPI {
  m5: C[]; h1: C[]; h4: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
}
interface GarchPD { name: string; ind: GarchPI; sp: number; lev: number; }

function get4hZ(z4: number[], h4: C[], h4Map: Map<number, number>, t: number): number {
  const H4 = 4 * H;
  const b = Math.floor(t / H4) * H4;
  const i = h4Map.get(b);
  if (i !== undefined && i > 0) return z4[i - 1]!;
  let lo = 0, hi = h4.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (h4[m]!.t < t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? z4[best]! : 0;
}

function simulateGarch(
  pairs: GarchPD[],
  startTs: number,
  endTs: number,
): Map<number, number> {
  const dailyPnl = new Map<number, number>();
  const SL = 0.003;
  const TRAIL_ACT = 9;
  const TRAIL_DIST = 0.5;
  const MAX_HOLD_H = 72;
  const MARGIN = 15;

  for (const p of pairs) {
    const h1 = p.ind.h1;
    const m5 = p.ind.m5;
    let m5i = 0;
    while (m5i < m5.length && m5[m5i]!.t < startTs) m5i++;
    let h1i = 0;
    while (h1i < h1.length && h1[h1i]!.t < startTs) h1i++;

    while (h1i < h1.length && h1[h1i]!.t < endTs) {
      if (h1i < 170) { h1i++; continue; }
      const hour = new Date(h1[h1i]!.t).getUTCHours();
      if (BLOCK.has(hour)) { h1i++; continue; }
      const z1 = p.ind.z1[h1i - 1] ?? 0;
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, h1[h1i]!.t);
      let dir: "long" | "short" | null = null;
      if (z1 > 2.0 && z4 > 1.5) dir = "long";
      else if (z1 < -2.0 && z4 < -1.5) dir = "short";
      if (!dir) { h1i++; continue; }

      const entryTs = h1[h1i]!.t;
      const ep = dir === "long" ? h1[h1i]!.o * (1 + p.sp) : h1[h1i]!.o * (1 - p.sp);
      const sl = dir === "long" ? ep * (1 - SL) : ep * (1 + SL);
      const notional = MARGIN * p.lev;

      while (m5i < m5.length && m5[m5i]!.t < entryTs) m5i++;

      let xp = 0, reason = "", isSL = false, pk = 0, exitTs = entryTs;
      let j = m5i;
      for (; j < m5.length; j++) {
        const b = m5[j]!;
        if (b.t < entryTs) continue;
        if (b.t >= endTs) break;
        if ((b.t - entryTs) / H >= MAX_HOLD_H) { xp = b.c; reason = "maxh"; exitTs = b.t; break; }
        const hit = dir === "long" ? b.l <= sl : b.h >= sl;
        if (hit) { xp = sl; reason = "sl"; isSL = true; exitTs = b.t; break; }
        const best = dir === "long" ? (b.h / ep - 1) * p.lev * 100 : (ep / b.l - 1) * p.lev * 100;
        if (best > pk) pk = best;
        const cur = dir === "long" ? (b.c / ep - 1) * p.lev * 100 : (ep / b.c - 1) * p.lev * 100;
        if (pk >= TRAIL_ACT && cur <= pk - TRAIL_DIST) { xp = b.c; reason = "trail"; exitTs = b.t; break; }
      }
      if (xp === 0) {
        const lb = m5[m5.length - 1]!;
        xp = lb.c; reason = "end"; exitTs = lb.t;
      }
      const rsp = isSL ? p.sp * SL_SLIP : p.sp;
      const ex = dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
      const fees = notional * FEE * 2;
      const pnl = (dir === "long" ? (ex / ep - 1) : (ep / ex - 1)) * notional - fees;
      const dayKey = Math.floor(exitTs / D);
      dailyPnl.set(dayKey, (dailyPnl.get(dayKey) ?? 0) + pnl);
      while (h1i < h1.length && h1[h1i]!.t <= exitTs) h1i++;
      while (m5i < m5.length && m5[m5i]!.t < (h1i < h1.length ? h1[h1i]!.t : endTs)) m5i++;
    }
  }
  return dailyPnl;
}

// =============================================================
// REX baseline (for correlation reference)
// Signal: 1h range > 2.25 * ATR14, close in top/bottom 25% -> continuation
// =============================================================
function computeRangeExpansion(h1: C[], atr1: number[], mult: number, closeThr: number): Int8Array {
  const out = new Int8Array(h1.length);
  for (let i = 14; i < h1.length; i++) {
    const bar = h1[i]!;
    const a = atr1[i];
    if (!a || a <= 0) continue;
    const range = bar.h - bar.l;
    if (range <= 0) continue;
    if (range < mult * a) continue;
    const upperLine = bar.h - range * closeThr;
    const lowerLine = bar.l + range * closeThr;
    if (bar.c >= upperLine) out[i] = 1;
    else if (bar.c <= lowerLine) out[i] = -1;
  }
  return out;
}

interface RexPI { m5: C[]; h1: C[]; atr14: number[]; }
interface RexPD { name: string; ind: RexPI; sp: number; lev: number; }

function simulateRex(pairs: RexPD[], startTs: number, endTs: number): Map<number, number> {
  const dailyPnl = new Map<number, number>();
  const MULT = 2.25, CLOSE_THR = 0.25;
  const SL = 0.0025, TRAIL_ACT = 9, TRAIL_DIST = 0.5;
  const MAX_HOLD_H = 12, MARGIN = 15;

  for (const p of pairs) {
    const h1 = p.ind.h1;
    const m5 = p.ind.m5;
    const sig = computeRangeExpansion(h1, p.ind.atr14, MULT, CLOSE_THR);
    let m5i = 0;
    while (m5i < m5.length && m5[m5i]!.t < startTs) m5i++;
    let h1i = 0;
    while (h1i < h1.length && h1[h1i]!.t < startTs) h1i++;

    while (h1i < h1.length && h1[h1i]!.t < endTs) {
      if (h1i < 170) { h1i++; continue; }
      const hour = new Date(h1[h1i]!.t).getUTCHours();
      if (BLOCK.has(hour)) { h1i++; continue; }
      const s = sig[h1i - 1] ?? 0;
      if (s === 0) { h1i++; continue; }
      const dir: "long" | "short" = s > 0 ? "long" : "short";
      const entryTs = h1[h1i]!.t;
      const ep = dir === "long" ? h1[h1i]!.o * (1 + p.sp) : h1[h1i]!.o * (1 - p.sp);
      const sl = dir === "long" ? ep * (1 - SL) : ep * (1 + SL);
      const notional = MARGIN * p.lev;

      while (m5i < m5.length && m5[m5i]!.t < entryTs) m5i++;
      let xp = 0, reason = "", isSL = false, pk = 0, exitTs = entryTs;
      let j = m5i;
      for (; j < m5.length; j++) {
        const b = m5[j]!;
        if (b.t < entryTs) continue;
        if (b.t >= endTs) break;
        if ((b.t - entryTs) / H >= MAX_HOLD_H) { xp = b.c; reason = "maxh"; exitTs = b.t; break; }
        const hit = dir === "long" ? b.l <= sl : b.h >= sl;
        if (hit) { xp = sl; reason = "sl"; isSL = true; exitTs = b.t; break; }
        const best = dir === "long" ? (b.h / ep - 1) * p.lev * 100 : (ep / b.l - 1) * p.lev * 100;
        if (best > pk) pk = best;
        const cur = dir === "long" ? (b.c / ep - 1) * p.lev * 100 : (ep / b.c - 1) * p.lev * 100;
        if (pk >= TRAIL_ACT && cur <= pk - TRAIL_DIST) { xp = b.c; reason = "trail"; exitTs = b.t; break; }
      }
      if (xp === 0) {
        const lb = m5[m5.length - 1]!;
        xp = lb.c; reason = "end"; exitTs = lb.t;
      }
      const rsp = isSL ? p.sp * SL_SLIP : p.sp;
      const ex = dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
      const fees = notional * FEE * 2;
      const pnl = (dir === "long" ? (ex / ep - 1) : (ep / ex - 1)) * notional - fees;
      const dayKey = Math.floor(exitTs / D);
      dailyPnl.set(dayKey, (dailyPnl.get(dayKey) ?? 0) + pnl);
      while (h1i < h1.length && h1[h1i]!.t <= exitTs) h1i++;
      while (m5i < m5.length && m5[m5i]!.t < (h1i < h1.length ? h1[h1i]!.t : endTs)) m5i++;
    }
  }
  return dailyPnl;
}

// ========================================================================
function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

const LOG: string[] = [];
function log(s: string = "") { console.log(s); LOG.push(s); }

function corrMaps(a: Map<number, number>, b: Map<number, number>): number {
  const days = new Set<number>([...a.keys(), ...b.keys()]);
  const sorted = [...days].sort((x, y) => x - y);
  const va: number[] = [], vb: number[] = [];
  for (const d of sorted) { va.push(a.get(d) ?? 0); vb.push(b.get(d) ?? 0); }
  return pearson(va, vb);
}

function main() {
  log("=".repeat(160));
  log("  FAILED BREAKOUT TRAP (Turtle Soup) — Linda Raschke 'Street Smarts'");
  log("  IS 2025-06-01 -> 2025-12-01  |  OOS 2025-12-01 -> 2026-03-25");
  log("  Cache 5m | 102+ pairs | FEE 0.00035 | SL_SLIP 1.5 | $15 margin | block h22-23");
  log("=".repeat(160));

  log("\nLoading pairs...");
  const pairs: PD[] = [];
  const garchPairs: GarchPD[] = [];
  const rexPairs: RexPD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, 4 * H, 40);
    if (h1.length < 250 || h4.length < 50) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const atr14 = computeATR(h1, 14);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    const sp = SP[n] ?? DSP;
    pairs.push({ name: n, ind: { m5, h1, rv24, rv168, h1Map }, sp, lev });
    garchPairs.push({ name: n, ind: { m5, h1, h4, h1Map, h4Map, z1, z4 }, sp, lev });
    rexPairs.push({ name: n, ind: { m5, h1, atr14 }, sp, lev });
  }
  log(`${pairs.length} pairs loaded`);

  // ---- Build baselines (for correlation) ----
  log("\nComputing GARCH baseline daily P&L...");
  const garchIS = simulateGarch(garchPairs, IS_S, IS_E);
  const garchOOS = simulateGarch(garchPairs, OOS_S, OOS_E);
  const garchISsum = [...garchIS.values()].reduce((s, v) => s + v, 0);
  const garchOOSsum = [...garchOOS.values()].reduce((s, v) => s + v, 0);
  log(`  GARCH IS total: ${fmtD(garchISsum)} (${fmtD(garchISsum / IS_D)}/day)`);
  log(`  GARCH OOS total: ${fmtD(garchOOSsum)} (${fmtD(garchOOSsum / OOS_D)}/day)`);

  log("\nComputing REX baseline daily P&L...");
  const rexIS = simulateRex(rexPairs, IS_S, IS_E);
  const rexOOS = simulateRex(rexPairs, OOS_S, OOS_E);
  const rexISsum = [...rexIS.values()].reduce((s, v) => s + v, 0);
  const rexOOSsum = [...rexOOS.values()].reduce((s, v) => s + v, 0);
  log(`  REX IS total: ${fmtD(rexISsum)} (${fmtD(rexISsum / IS_D)}/day)`);
  log(`  REX OOS total: ${fmtD(rexOOSsum)} (${fmtD(rexOOSsum / OOS_D)}/day)`);

  // ---- Build configs to test ----
  const base: Cfg = {
    label: "base",
    tf: "5m",
    insideRatio: 0.6,
    breachPct: 0.0005,
    slWickBufferPct: 0.0005,
    slMaxPct: 0.01,
    useTP: true,
    trailStages: [],
    maxHoldBars: 6,
    regime: false, regimeThr: 1.0,
    longOnly: false, shortOnly: false,
    margin: 15,
  };

  const configs: Cfg[] = [];

  // 1. Base Raschke
  configs.push({ ...base, label: "Base Raschke (5m, ratio 0.6, breach 0.05%, TP, 6bar)" });

  // 2. Inside bar ratio variants
  for (const r of [0.5, 0.6, 0.7]) {
    configs.push({ ...base, insideRatio: r, label: `Inside ratio ${r}` });
  }

  // 3. Breach size variants
  for (const b of [0.0003, 0.0005, 0.0010]) {
    configs.push({ ...base, breachPct: b, label: `Breach ${(b*100).toFixed(2)}%` });
  }

  // 4. With vol regime filter
  configs.push({ ...base, regime: true, regimeThr: 1.5, label: "Base + regime RV24/168 > 1.5" });
  configs.push({ ...base, regime: true, regimeThr: 1.2, label: "Base + regime RV24/168 > 1.2" });

  // 5. Long-only vs short-only
  configs.push({ ...base, longOnly: true, label: "Long-only (failed-down)" });
  configs.push({ ...base, shortOnly: true, label: "Short-only (failed-up)" });

  // 6. SL width variations (cap)
  for (const s of [0.005, 0.0075, 0.015]) {
    configs.push({ ...base, slMaxPct: s, label: `SL cap ${(s*100).toFixed(2)}%` });
  }

  // 7. Multi-stage trail (no TP)
  const trailStages = [
    { act: 3, dist: 1 },
    { act: 9, dist: 0.5 },
    { act: 20, dist: 0.5 },
  ];
  configs.push({ ...base, useTP: false, trailStages, maxHoldBars: 12, label: "Trail 3/1 -> 9/0.5 -> 20/0.5 (12bar)" });
  configs.push({ ...base, useTP: false, trailStages, maxHoldBars: 24, label: "Trail 3/1 -> 9/0.5 -> 20/0.5 (24bar)" });

  // 8. 1h timeframe version
  configs.push({ ...base, tf: "1h", maxHoldBars: 6, label: "1h timeframe (ratio 0.6, breach 0.05%, TP, 6bar=6h)" });
  configs.push({ ...base, tf: "1h", maxHoldBars: 4, label: "1h timeframe (4bar hold)" });
  configs.push({
    ...base, tf: "1h", useTP: false, trailStages, maxHoldBars: 12,
    label: "1h + trail 3/1 -> 9/0.5 -> 20/0.5 (12h)",
  });

  // Run all
  log("\n" + "=".repeat(160));
  log(`  Testing ${configs.length} configurations`);
  log("=".repeat(160));
  log(
    `${"label".padEnd(60)}${"period".padEnd(6)}${"$/day".padStart(10)}${"MDD".padStart(8)}${"PF".padStart(6)}${"WR%".padStart(7)}${"MaxL".padStart(9)}${"N".padStart(7)}${"corrG".padStart(8)}${"corrR".padStart(8)}`
  );
  log("-".repeat(160));

  interface Row { cfg: Cfg; is: Res; oos: Res; corrGarchOOS: number; corrRexOOS: number; }
  const rows: Row[] = [];

  for (const cfg of configs) {
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    const corrGarchOOS = corrMaps(oos.dailyPnl, garchOOS);
    const corrRexOOS = corrMaps(oos.dailyPnl, rexOOS);
    rows.push({ cfg, is, oos, corrGarchOOS, corrRexOOS });

    const lbl = cfg.label.length > 58 ? cfg.label.slice(0, 58) : cfg.label;
    log(
      `${lbl.padEnd(60)}${"IS".padEnd(6)}${fmtD(is.dollarsPerDay).padStart(10)}${("$"+is.maxDD.toFixed(0)).padStart(8)}${is.pf.toFixed(2).padStart(6)}${is.wr.toFixed(1).padStart(7)}${fmtD(is.maxSingleLoss).padStart(9)}${String(is.numTrades).padStart(7)}${"".padStart(8)}${"".padStart(8)}`
    );
    log(
      `${"".padEnd(60)}${"OOS".padEnd(6)}${fmtD(oos.dollarsPerDay).padStart(10)}${("$"+oos.maxDD.toFixed(0)).padStart(8)}${oos.pf.toFixed(2).padStart(6)}${oos.wr.toFixed(1).padStart(7)}${fmtD(oos.maxSingleLoss).padStart(9)}${String(oos.numTrades).padStart(7)}${corrGarchOOS.toFixed(2).padStart(8)}${corrRexOOS.toFixed(2).padStart(8)}`
    );
    log("-".repeat(160));
  }

  // Verdict
  log("\n" + "=".repeat(160));
  log("  VERDICT");
  log("=".repeat(160));

  const qual = rows.filter(r => r.oos.maxDD < 15 && r.oos.dollarsPerDay >= 0.2 && r.oos.numTrades >= 20);
  log(`Configs passing kill threshold (OOS $/day >= $0.20, MDD < $15, N>=20): ${qual.length}/${rows.length}`);
  qual.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);

  if (qual.length === 0) {
    log("\nNo configuration passes the kill threshold.");
    // best OOS at MDD < $15 anyway (any $/day)
    const alt = rows.filter(r => r.oos.maxDD < 15 && r.oos.numTrades >= 20)
      .sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
    if (alt.length > 0) {
      log(`\nBest at MDD<$15 regardless of threshold:`);
      const r = alt[0]!;
      log(`  ${r.cfg.label}`);
      log(`  OOS $/day ${fmtD(r.oos.dollarsPerDay)}  MDD $${r.oos.maxDD.toFixed(0)}  PF ${r.oos.pf.toFixed(2)}  WR ${r.oos.wr.toFixed(1)}%  N=${r.oos.numTrades}`);
      log(`  corr(GARCH)=${r.corrGarchOOS.toFixed(3)}  corr(REX)=${r.corrRexOOS.toFixed(3)}`);
    }
  } else {
    log(`\nTop passing configs (OOS):`);
    for (let i = 0; i < Math.min(5, qual.length); i++) {
      const r = qual[i]!;
      log(`  #${i+1}: ${r.cfg.label}`);
      log(`       OOS $/day ${fmtD(r.oos.dollarsPerDay)}  MDD $${r.oos.maxDD.toFixed(0)}  PF ${r.oos.pf.toFixed(2)}  WR ${r.oos.wr.toFixed(1)}%  N=${r.oos.numTrades}`);
      log(`       IS  $/day ${fmtD(r.is.dollarsPerDay)}   MDD $${r.is.maxDD.toFixed(0)}   PF ${r.is.pf.toFixed(2)}   WR ${r.is.wr.toFixed(1)}%   N=${r.is.numTrades}`);
      log(`       corr(GARCH)=${r.corrGarchOOS.toFixed(3)}  corr(REX)=${r.corrRexOOS.toFixed(3)}`);
    }
  }

  // Average correlation across all profitable configs
  const profitable = rows.filter(r => r.oos.numTrades >= 20);
  if (profitable.length > 0) {
    const avgCorrGarch = profitable.reduce((s, r) => s + r.corrGarchOOS, 0) / profitable.length;
    const avgCorrRex = profitable.reduce((s, r) => s + r.corrRexOOS, 0) / profitable.length;
    log(`\nAverage OOS correlations (across ${profitable.length} configs with N>=20):`);
    log(`  vs GARCH: ${avgCorrGarch.toFixed(3)}`);
    log(`  vs REX:   ${avgCorrRex.toFixed(3)}   ${avgCorrRex < -0.05 ? "(NEGATIVE as expected)" : avgCorrRex > 0.05 ? "(POSITIVE — NOT a diversifier)" : "(neutral)"}`);
  }

  // Write output
  const outPath = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester/failed-breakout.txt";
  fs.writeFileSync(outPath, LOG.join("\n"));
  log(`\nSaved to ${outPath}`);
}

main();
