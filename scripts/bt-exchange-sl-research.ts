/**
 * Exchange Stop-Loss Research Backtest
 *
 * Goal: Find profitable GARCH v2 exit config using EXCHANGE stop-loss (tick-level,
 * fires immediately on intra-bar high/low) instead of the current 1h-boundary bot SL,
 * to reduce per-trade gap losses user is experiencing live.
 *
 * Setup:
 *   - Entry: EXACT live signal (1h z-score > 2.0 AND 4h z-score > 1.5 for longs, mirrored shorts)
 *   - Pairs: QUANT_TRADING_PAIRS (127)
 *   - Margin: $10, real per-pair leverage capped at 10x
 *   - Block hours 22-23 UTC, 1h SL cooldown per pair+direction
 *   - Entry: checked only at 1h bar boundaries (matches scheduler)
 *   - Exit: checked at every 5m bar intra-bar (simulates exchange tick fills)
 *
 * Tests 7 categories of exit strategies (80+ configs total).
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-exchange-sl-research.ts
 */

import * as fs from "fs";
import * as path from "path";

// ───── Constants ─────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 5 * 60_000;
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MOM_LB = 3;
const VOL_WIN = 20;
const MAX_HOLD_H = 72;
const CD_H = 1;
const BLOCK_HOURS = new Set([22, 23]);
const FEE = 0.00035; // 0.035% taker per side
const MARGIN = 10;
const Z_LONG_1H = 2.0;
const Z_SHORT_1H = -2.0;
const Z_LONG_4H = 1.5;
const Z_SHORT_4H = -1.5;

// Spread per pair (from production)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DSP = 5e-4;
const RM: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };

// Real HL max leverage map
const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
function getLev(n: string): number {
  return Math.min(LM.get(n) ?? 3, 10);
}

// 127 pairs from QUANT_TRADING_PAIRS
const ALL = [
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

const OOS_S = new Date("2025-06-01").getTime();
const OOS_E = new Date("2026-03-25").getTime();
const OOS_D = (OOS_E - OOS_S) / D;

// ───── Types ─────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string;
  dir: "long" | "short";
  entryTs: number;
  exitTs: number;
  pnl: number;
  reason: string;
  peakPnlPct: number; // leveraged peak PnL in %
}
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  z1: number[]; z4: number[];
  atr14_1h: number[]; // ATR on 1h closes, in price units
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  ema9_1h: number[];
  ema21_1h: number[];
}
interface PD { name: string; ind: PI; sp: number; lev: number; not: number; }

// ───── Data ─────
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

// ATR over 1h candles using Wilder smoothing, returns array aligned to cs length
function computeATR(cs: C[], period = 14): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < cs.length; i++) {
    const hi = cs[i]!.h, lo = cs[i]!.l, pc = cs[i - 1]!.c;
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  // First ATR = simple mean of first `period` TRs
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  out[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
    out[i + 1] = atr;
  }
  return out;
}

// EMA on closes
function computeEMA(cs: C[], period: number): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < period) return out;
  const k = 2 / (period + 1);
  let ema = cs.slice(0, period).reduce((s, c) => s + c.c, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < cs.length; i++) {
    ema = cs[i]!.c * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// Lookup 4h z-score prev bar at or before ts
function get4hZ(z4: number[], h4: C[], h4Map: Map<number, number>, t: number): number {
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

// Lookup 1h z-score at or before ts (for z-reversal exit)
function get1hZNow(pd: PI, t: number): number {
  let lo = 0, hi = pd.h1.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (pd.h1[m]!.t <= t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? pd.z1[best]! : 0;
}

// Lookup BTC EMA trend at time ts: +1 bull, -1 bear
function getBtcTrend(btc: PI, t: number): number {
  let lo = 0, hi = btc.h1.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (btc.h1[m]!.t <= t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  if (best < 0) return 0;
  const e9 = btc.ema9_1h[best]!, e21 = btc.ema21_1h[best]!;
  if (!e9 || !e21) return 0;
  return e9 > e21 ? 1 : -1;
}

// ───── Strategy Config ─────
interface TrailStep { a: number; d: number; }
interface StratConfig {
  label: string;
  category: string;
  slPct: number;                  // Fixed exchange SL width (% from entry, unleveraged)
  slMode: "fixed" | "atr";        // Fixed pct or ATR-based
  atrMult?: number;                // Multiplier if slMode=atr
  trail?: TrailStep[];             // Optional trailing stop (in leveraged %)
  tpPct?: number;                  // Optional fixed leveraged TP %
  partialAt?: number;              // Close 50% at this leveraged % profit
  timeExitH?: number;              // Close if unprofitable after this many hours
  zReversal?: boolean;             // Close if 1h z crosses through 0
  btcRegime?: boolean;             // Close if BTC EMA flips against position
  slBoundary1h?: boolean;          // BASELINE: check SL only at 1h boundaries (default false = exchange)
  // ── Risk wrappers (for MDD control) ──
  maxConcurrent?: number;          // Cap simultaneously open positions (across all pairs)
  entryCdH?: number;               // Per-pair+dir cooldown after ANY exit (hours)
  dailyLossStop?: number;          // Halt new entries for 24h after losing $X in rolling 24h
  lossStreakStop?: number;         // Halt new entries for 24h after N consecutive losing trades
  // ── NEW: entry/universe overrides (fresh exploration) ──
  z1hThresh?: number;              // Override long z1h threshold (abs value, mirrored for short)
  z4hThresh?: number;              // Override long z4h threshold
  marginUsd?: number;              // Override global MARGIN per trade
  longOnly?: boolean;              // Disable short entries
  shortOnly?: boolean;             // Disable long entries
  pairAllow?: Set<string>;         // Restrict universe to these pairs
  maxHoldH?: number;               // Override MAX_HOLD_H per-config
  requireConsecutive?: number;     // Require N consecutive h1 bars with signal (confirmation)
  hoursAllowed?: Set<number>;      // Only allow entries on these UTC hours
}

// ───── Simulation ─────
interface OpenPos {
  pair: string;
  dir: "long" | "short";
  ep: number;
  et: number;
  sl: number;
  pk: number; // peak leveraged PnL %
  sp: number;
  lev: number;
  not: number;
  partialTaken: boolean;
  entryZ1: number; // sign of entry z-score for reversal check
}

interface SimResult {
  trades: Tr[];
  totalPnl: number;
  dollarsPerDay: number;
  maxDD: number;
  pf: number;
  wr: number;
  avgWin: number;
  avgLoss: number;
  maxSingleLoss: number;
  numTrades: number;
}

// Preload shared structures across simulate() calls to avoid rebuilding per config
let __timepoints: number[] | null = null;
let __m5Maps: Map<string, Map<number, number>> | null = null;
let __pairByName: Map<string, PD> | null = null;

function prepareShared(pairs: PD[]): void {
  if (__timepoints && __m5Maps && __pairByName) return;
  const all = new Set<number>();
  __m5Maps = new Map();
  __pairByName = new Map();
  for (const p of pairs) {
    __pairByName.set(p.name, p);
    const m = new Map<number, number>();
    for (let i = 0; i < p.ind.m5.length; i++) {
      const b = p.ind.m5[i]!;
      m.set(b.t, i);
      if (b.t >= OOS_S && b.t < OOS_E) all.add(b.t);
    }
    __m5Maps.set(p.name, m);
  }
  __timepoints = [...all].sort((a, b) => a - b);
}

function simulate(pairs: PD[], btc: PI, cfg: StratConfig): SimResult {
  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();
  const openPositions: OpenPos[] = [];

  // Portfolio risk state
  let portfolioHaltUntil = 0;         // entry freeze timestamp (daily loss / streak)
  let lossStreak = 0;
  const recentLosses: Array<{ ts: number; pnl: number }> = [];

  prepareShared(pairs);
  const timepoints = __timepoints!;
  const m5Maps = __m5Maps!;
  const pairByName = __pairByName!;

  for (const ts of timepoints) {
    const isH1Boundary = ts % H === 0;
    const hourOfDay = new Date(ts).getUTCHours();

    // ─── EXIT checks ───
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair);
      if (!m5Map) continue;
      const bi = m5Map.get(ts);
      if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;
      const barsHeld = (ts - pos.et) / H;

      // 1) Max hold (per-config override)
      const maxHold = cfg.maxHoldH ?? MAX_HOLD_H;
      if (barsHeld >= maxHold) { xp = bar.c; reason = "maxh"; }

      // 2) Stop-loss
      if (!xp) {
        if (cfg.slBoundary1h) {
          // BASELINE: check SL only on 1h close
          if (isH1Boundary && bi >= 0) {
            const h1Close = bar.c; // 5m bar at 1h boundary, use its close as 1h close approximation
            const slHit = pos.dir === "long" ? h1Close <= pos.sl : h1Close >= pos.sl;
            if (slHit) { xp = pos.sl; reason = "sl"; isSL = true; }
          }
        } else {
          // EXCHANGE SL: intra-bar hit
          const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
          if (slHit) { xp = pos.sl; reason = "sl"; isSL = true; }
        }
      }

      // Compute peak for trail/partial/TP
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      // 3) Fixed TP (tpPct is PRICE %)
      if (!xp && cfg.tpPct !== undefined) {
        const tpPrice = pos.dir === "long"
          ? pos.ep * (1 + cfg.tpPct / 100)
          : pos.ep * (1 - cfg.tpPct / 100);
        const hit = pos.dir === "long" ? bar.h >= tpPrice : bar.l <= tpPrice;
        if (hit) { xp = tpPrice; reason = "tp"; }
      }

      // 4) Partial close at +X% PRICE: reduce notional by 50%
      if (!xp && cfg.partialAt !== undefined && !pos.partialTaken) {
        const partPrice = pos.dir === "long"
          ? pos.ep * (1 + cfg.partialAt / 100)
          : pos.ep * (1 - cfg.partialAt / 100);
        const hit = pos.dir === "long" ? bar.h >= partPrice : bar.l <= partPrice;
        if (hit) {
          // Record partial as its own trade at half notional
          const halfNot = pos.not / 2;
          const ex = pos.dir === "long" ? partPrice * (1 - pos.sp) : partPrice * (1 + pos.sp);
          const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * halfNot - halfNot * FEE * 2;
          closed.push({ pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: ts, pnl, reason: "partial", peakPnlPct: pos.pk });
          pos.not = halfNot;
          pos.partialTaken = true;
        }
      }

      // 5) Trailing stop (leveraged %)
      if (!xp && cfg.trail) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        let td = Infinity;
        for (const s of cfg.trail) if (pos.pk >= s.a) td = s.d;
        if (td < Infinity && cur <= pos.pk - td) { xp = bar.c; reason = "trail"; }
      }

      // 6) Time-based exit: close if unprofitable after N hours
      if (!xp && cfg.timeExitH !== undefined && barsHeld >= cfg.timeExitH) {
        const curLev = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (curLev <= 0) { xp = bar.c; reason = "time"; }
      }

      // 7) Z-reversal exit: check on 1h boundary
      if (!xp && cfg.zReversal && isH1Boundary) {
        const zNow = get1hZNow(pd.ind, ts);
        if (pos.dir === "long" && pos.entryZ1 > 0 && zNow < 0) { xp = bar.c; reason = "zrev"; }
        if (pos.dir === "short" && pos.entryZ1 < 0 && zNow > 0) { xp = bar.c; reason = "zrev"; }
      }

      // 8) BTC regime exit: check on 1h boundary
      if (!xp && cfg.btcRegime && isH1Boundary) {
        const bt = getBtcTrend(btc, ts);
        if (pos.dir === "long" && bt < 0) { xp = bar.c; reason = "btcreg"; }
        if (pos.dir === "short" && bt > 0) { xp = bar.c; reason = "btcreg"; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * 1.5 : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: ts, pnl, reason, peakPnlPct: pos.pk });
        openPositions.splice(i, 1);
        // ── SL cooldown (default 1h) ──
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
        // ── Generic per-pair+dir cooldown after ANY exit ──
        if (cfg.entryCdH !== undefined && cfg.entryCdH > 0) {
          cdMap.set(`${pos.pair}:${pos.dir}`, ts + cfg.entryCdH * H);
        }
        // ── Loss streak tracking ──
        if (pnl < 0) lossStreak++;
        else lossStreak = 0;
        if (cfg.lossStreakStop !== undefined && lossStreak >= cfg.lossStreakStop) {
          portfolioHaltUntil = ts + 24 * H;
          lossStreak = 0;
        }
        // ── Rolling 24h daily loss tracking ──
        if (cfg.dailyLossStop !== undefined && pnl < 0) {
          recentLosses.push({ ts, pnl });
          // Evict stale
          while (recentLosses.length > 0 && recentLosses[0]!.ts < ts - 24 * H) recentLosses.shift();
          const recent24hLoss = recentLosses.reduce((s, x) => s + x.pnl, 0);
          if (-recent24hLoss >= cfg.dailyLossStop) {
            portfolioHaltUntil = ts + 24 * H;
            recentLosses.length = 0;
          }
        }
      }
    }

    // ─── ENTRY on 1h boundaries ───
    if (!isH1Boundary) continue;
    if (BLOCK_HOURS.has(hourOfDay)) continue;

    // ── Portfolio halt check ──
    if (ts < portfolioHaltUntil) continue;

    // ── Max concurrent cap ──
    if (cfg.maxConcurrent !== undefined && openPositions.length >= cfg.maxConcurrent) continue;

    // ── Per-config hour-of-day filter (in addition to global BLOCK_HOURS) ──
    if (cfg.hoursAllowed && !cfg.hoursAllowed.has(hourOfDay)) continue;

    // Entry thresholds (per-config overrides)
    const zL1 = cfg.z1hThresh ?? Z_LONG_1H;
    const zL4 = cfg.z4hThresh ?? Z_LONG_4H;
    const zS1 = -zL1;
    const zS4 = -zL4;

    for (const p of pairs) {
      if (cfg.maxConcurrent !== undefined && openPositions.length >= cfg.maxConcurrent) break;
      if (cfg.pairAllow && !cfg.pairAllow.has(p.name)) continue;
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < VOL_WIN + 2) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!; // anti-lookahead
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      let dir: "long" | "short" | null = null;
      if (z1 > zL1 && z4 > zL4) dir = "long";
      if (z1 < zS1 && z4 < zS4) dir = "short";
      if (!dir) continue;
      if (cfg.longOnly && dir !== "long") continue;
      if (cfg.shortOnly && dir !== "short") continue;

      // Require N consecutive h1 bars with matching signal
      if (cfg.requireConsecutive && cfg.requireConsecutive > 1) {
        let ok = true;
        for (let k = 1; k < cfg.requireConsecutive; k++) {
          const idx = h1Idx - 1 - k;
          if (idx < VOL_WIN + 2) { ok = false; break; }
          const pz = p.ind.z1[idx]!;
          if (dir === "long"  && !(pz > zL1)) { ok = false; break; }
          if (dir === "short" && !(pz < zS1)) { ok = false; break; }
        }
        if (!ok) continue;
      }

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);

      // Compute SL based on mode
      let slPrice: number;
      if (cfg.slMode === "atr") {
        const atr = p.ind.atr14_1h[h1Idx - 1] ?? ep * 0.01;
        const dist = atr * (cfg.atrMult ?? 2);
        slPrice = dir === "long" ? ep - dist : ep + dist;
      } else {
        // slPct is PRICE percentage (unleveraged move). At 10x, 3% price = 30% leveraged.
        const dist = ep * (cfg.slPct / 100);
        slPrice = dir === "long" ? ep - dist : ep + dist;
      }

      // Per-config margin override (effective notional)
      const effMargin = cfg.marginUsd ?? MARGIN;
      const effNot = effMargin * p.lev;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl: slPrice, pk: 0,
        sp: p.sp, lev: p.lev, not: effNot,
        partialTaken: false,
        entryZ1: z1,
      });
    }
  }

  // Close any remaining at EOD
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: lb.t, pnl, reason: "end", peakPnlPct: pos.pk });
  }

  // Sort by exit time for DD computation
  closed.sort((a, b) => a.exitTs - b.exitTs);

  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const wr = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = glAbs > 0 ? gp / glAbs : Infinity;
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  const avgWin = wins.length > 0 ? gp / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  let maxSingleLoss = 0;
  for (const t of losses) if (t.pnl < maxSingleLoss) maxSingleLoss = t.pnl;

  return {
    trades: closed,
    totalPnl,
    dollarsPerDay: totalPnl / OOS_D,
    maxDD,
    pf,
    wr,
    avgWin,
    avgLoss,
    maxSingleLoss,
    numTrades: closed.length,
  };
}

// ───── Config Generator ─────
function buildConfigs(): StratConfig[] {
  const configs: StratConfig[] = [];

  // BASELINE: current live config (SL 0.3% PRICE, 1h-boundary bot SL, 5m trail)
  configs.push({
    label: "BASELINE: SL 0.3%@1h + trail 9/0.5",
    category: "baseline",
    slPct: 0.3, slMode: "fixed",
    trail: [{ a: 9, d: 0.5 }],
    slBoundary1h: true,
  });
  // Reference: same as baseline but with EXCHANGE SL (tick-level) — shows the gap-loss fix alone
  configs.push({
    label: "REF: SL 0.3% exch + trail 9/0.5",
    category: "baseline",
    slPct: 0.3, slMode: "fixed",
    trail: [{ a: 9, d: 0.5 }],
  });

  // CATEGORY 1: Exchange SL + trail (10 SL widths × 5 trails = 50 configs, trim to essential)
  // SL width is in leveraged % (so 5% means 5% leveraged pnl drop)
  const slWidths = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15];
  const trails: Array<{ name: string; steps: TrailStep[] }> = [
    { name: "t9/0.5", steps: [{ a: 9, d: 0.5 }] },
    { name: "t7/0.5", steps: [{ a: 7, d: 0.5 }] },
    { name: "t12/0.5", steps: [{ a: 12, d: 0.5 }] },
    { name: "t15/1", steps: [{ a: 15, d: 1 }] },
    { name: "t20/2", steps: [{ a: 20, d: 2 }] },
  ];
  for (const sl of slWidths) {
    for (const t of trails) {
      configs.push({
        label: `ExchSL ${sl}% + ${t.name}`,
        category: "exch_sl_trail",
        slPct: sl, slMode: "fixed",
        trail: t.steps,
      });
    }
  }

  // CATEGORY 2: Exchange SL + Fixed TP (no trail)
  const tpLevels = [5, 7, 10, 15, 20];
  for (const sl of [3, 5, 7, 10]) {
    for (const tp of tpLevels) {
      configs.push({
        label: `ExchSL ${sl}% + TP ${tp}%`,
        category: "exch_sl_tp",
        slPct: sl, slMode: "fixed",
        tpPct: tp,
      });
    }
  }

  // CATEGORY 3: Partial close (50% at +5%, runner with trail)
  for (const sl of [3, 5, 7, 10]) {
    configs.push({
      label: `ExchSL ${sl}% + partial@5% + trail 9/0.5`,
      category: "partial",
      slPct: sl, slMode: "fixed",
      partialAt: 5,
      trail: [{ a: 9, d: 0.5 }],
    });
    configs.push({
      label: `ExchSL ${sl}% + partial@7% + trail 12/0.5`,
      category: "partial",
      slPct: sl, slMode: "fixed",
      partialAt: 7,
      trail: [{ a: 12, d: 0.5 }],
    });
  }

  // CATEGORY 4: Time-based (close if unprofitable after Nh)
  for (const sl of [3, 5, 7, 10]) {
    for (const th of [4, 6, 8, 12]) {
      configs.push({
        label: `ExchSL ${sl}% + time-exit ${th}h + trail 9/0.5`,
        category: "time",
        slPct: sl, slMode: "fixed",
        timeExitH: th,
        trail: [{ a: 9, d: 0.5 }],
      });
    }
  }

  // CATEGORY 5: ATR-based exchange SL
  for (const mult of [1.5, 2, 2.5, 3, 4]) {
    configs.push({
      label: `ATR ${mult}x SL + trail 9/0.5`,
      category: "atr",
      slPct: 0, slMode: "atr", atrMult: mult,
      trail: [{ a: 9, d: 0.5 }],
    });
    configs.push({
      label: `ATR ${mult}x SL + trail 15/1`,
      category: "atr",
      slPct: 0, slMode: "atr", atrMult: mult,
      trail: [{ a: 15, d: 1 }],
    });
  }

  // CATEGORY 6: Z-reversal exit
  for (const sl of [3, 5, 7, 10]) {
    configs.push({
      label: `ExchSL ${sl}% + z-reversal + trail 9/0.5`,
      category: "zrev",
      slPct: sl, slMode: "fixed",
      zReversal: true,
      trail: [{ a: 9, d: 0.5 }],
    });
  }

  // CATEGORY 7: BTC regime exit
  for (const sl of [3, 5, 7, 10]) {
    configs.push({
      label: `ExchSL ${sl}% + BTC-regime + trail 9/0.5`,
      category: "btcreg",
      slPct: sl, slMode: "fixed",
      btcRegime: true,
      trail: [{ a: 9, d: 0.5 }],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CATEGORY R: RISK WRAPPERS — drive MaxDD < $20
  // ═══════════════════════════════════════════════════════════════
  // The raw strategies above have MDD $225-$1200 because 28k trades
  // accumulate variance. To bring MDD under $20 we need to reduce
  // trade count AND cap concurrent exposure.

  type Base = { label: string; slPct: number; zrev: boolean; trail: TrailStep[]; partialAt?: number };
  const bases: Base[] = [
    { label: "SL3%+zrev+tr9/0.5",  slPct: 3, zrev: true,  trail: [{ a: 9, d: 0.5 }] },
    { label: "SL5%+zrev+tr9/0.5",  slPct: 5, zrev: true,  trail: [{ a: 9, d: 0.5 }] },
    { label: "SL5%+tr20/2",        slPct: 5, zrev: false, trail: [{ a: 20, d: 2 }] },
    { label: "SL6%+tr20/2",        slPct: 6, zrev: false, trail: [{ a: 20, d: 2 }] },
  ];

  // R1: base × maxConcurrent (1, 2, 3, 5)
  for (const b of bases) {
    for (const mc of [1, 2, 3, 5]) {
      configs.push({
        label: `${b.label} + maxC${mc}`,
        category: "risk_maxC",
        slPct: b.slPct, slMode: "fixed",
        trail: b.trail, zReversal: b.zrev,
        maxConcurrent: mc,
      });
    }
  }

  // R2: base × per-pair+dir cooldown {4h, 12h, 24h, 48h}
  for (const b of bases) {
    for (const cd of [4, 12, 24, 48]) {
      configs.push({
        label: `${b.label} + cd${cd}h`,
        category: "risk_cd",
        slPct: b.slPct, slMode: "fixed",
        trail: b.trail, zReversal: b.zrev,
        entryCdH: cd,
      });
    }
  }

  // R3: base × dailyLossStop {$5, $10, $15}
  for (const b of bases) {
    for (const dl of [5, 10, 15]) {
      configs.push({
        label: `${b.label} + dailyStop$${dl}`,
        category: "risk_daily",
        slPct: b.slPct, slMode: "fixed",
        trail: b.trail, zReversal: b.zrev,
        dailyLossStop: dl,
      });
    }
  }

  // R4: base × lossStreakStop {3, 5, 8}
  for (const b of bases) {
    for (const ls of [3, 5, 8]) {
      configs.push({
        label: `${b.label} + streak${ls}`,
        category: "risk_streak",
        slPct: b.slPct, slMode: "fixed",
        trail: b.trail, zReversal: b.zrev,
        lossStreakStop: ls,
      });
    }
  }

  // R5: stacked risk wrappers (maxC + cd + daily)
  const stacks = [
    { mc: 1, cd: 12, dl: 5,  lbl: "mc1+cd12h+dl$5" },
    { mc: 2, cd: 12, dl: 10, lbl: "mc2+cd12h+dl$10" },
    { mc: 3, cd: 24, dl: 10, lbl: "mc3+cd24h+dl$10" },
    { mc: 1, cd: 24, dl: 5,  lbl: "mc1+cd24h+dl$5" },
    { mc: 2, cd: 24, dl: 10, lbl: "mc2+cd24h+dl$10" },
    { mc: 5, cd: 12, dl: 15, lbl: "mc5+cd12h+dl$15" },
  ];
  for (const b of bases) {
    for (const s of stacks) {
      configs.push({
        label: `${b.label} + ${s.lbl}`,
        category: "risk_stack",
        slPct: b.slPct, slMode: "fixed",
        trail: b.trail, zReversal: b.zrev,
        maxConcurrent: s.mc,
        entryCdH: s.cd,
        dailyLossStop: s.dl,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // R6: EXTREME MDD control (maxC=1 + long cooldowns + tight stops)
  // Goal: MaxDD < $20
  // ═══════════════════════════════════════════════════════════════
  const tightBases: Base[] = [
    { label: "SL2%+zrev+tr9/0.5",   slPct: 2, zrev: true,  trail: [{ a: 9, d: 0.5 }] },
    { label: "SL3%+zrev+tr9/0.5",   slPct: 3, zrev: true,  trail: [{ a: 9, d: 0.5 }] },
    { label: "SL5%+zrev+tr9/0.5",   slPct: 5, zrev: true,  trail: [{ a: 9, d: 0.5 }] },
    { label: "SL3%+tr9/0.5",        slPct: 3, zrev: false, trail: [{ a: 9, d: 0.5 }] },
    { label: "SL5%+tr20/2",         slPct: 5, zrev: false, trail: [{ a: 20, d: 2 }] },
  ];

  // Extreme stacks: single position, long cooldowns, very tight daily/streak stops
  const tightStacks = [
    { mc: 1, cd: 6,   dl: 3,  ls: 3, lbl: "mc1+cd6h+dl$3+s3" },
    { mc: 1, cd: 12,  dl: 3,  ls: 3, lbl: "mc1+cd12h+dl$3+s3" },
    { mc: 1, cd: 24,  dl: 3,  ls: 3, lbl: "mc1+cd24h+dl$3+s3" },
    { mc: 1, cd: 6,   dl: 5,  ls: 5, lbl: "mc1+cd6h+dl$5+s5" },
    { mc: 1, cd: 12,  dl: 5,  ls: 5, lbl: "mc1+cd12h+dl$5+s5" },
    { mc: 1, cd: 24,  dl: 5,  ls: 5, lbl: "mc1+cd24h+dl$5+s5" },
    { mc: 1, cd: 48,  dl: 5,  ls: 5, lbl: "mc1+cd48h+dl$5+s5" },
    { mc: 2, cd: 6,   dl: 3,  ls: 3, lbl: "mc2+cd6h+dl$3+s3" },
    { mc: 2, cd: 12,  dl: 5,  ls: 5, lbl: "mc2+cd12h+dl$5+s5" },
    { mc: 2, cd: 24,  dl: 5,  ls: 5, lbl: "mc2+cd24h+dl$5+s5" },
    { mc: 3, cd: 24,  dl: 5,  ls: 5, lbl: "mc3+cd24h+dl$5+s5" },
  ];
  for (const b of tightBases) {
    for (const s of tightStacks) {
      configs.push({
        label: `${b.label} + ${s.lbl}`,
        category: "risk_tight",
        slPct: b.slPct, slMode: "fixed",
        trail: b.trail, zReversal: b.zrev,
        maxConcurrent: s.mc,
        entryCdH: s.cd,
        dailyLossStop: s.dl,
        lossStreakStop: s.ls,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // R7: TIGHT-SL variants (0.5%, 1%, 1.5%, 2%) + maxC ∈ {1,2,3} + trail only
  // Tight SL = small max single loss; maxC = cap simultaneous exposure;
  // trail 9/0.5 = lock gains quickly. Goal: keep MDD small by low trade count.
  // ═══════════════════════════════════════════════════════════════
  const tinyBases: Array<{ label: string; slPct: number; trail: TrailStep[] }> = [
    { label: "SL0.5%+tr9/0.5", slPct: 0.5, trail: [{ a: 9, d: 0.5 }] },
    { label: "SL1%+tr9/0.5",   slPct: 1,   trail: [{ a: 9, d: 0.5 }] },
    { label: "SL1.5%+tr9/0.5", slPct: 1.5, trail: [{ a: 9, d: 0.5 }] },
    { label: "SL2%+tr9/0.5",   slPct: 2,   trail: [{ a: 9, d: 0.5 }] },
    { label: "SL0.5%+tr7/0.5", slPct: 0.5, trail: [{ a: 7, d: 0.5 }] },
    { label: "SL1%+tr7/0.5",   slPct: 1,   trail: [{ a: 7, d: 0.5 }] },
  ];
  const mcOptions = [
    { mc: 1, cd: 1,  lbl: "mc1" },
    { mc: 2, cd: 1,  lbl: "mc2" },
    { mc: 3, cd: 1,  lbl: "mc3" },
    { mc: 1, cd: 6,  lbl: "mc1+cd6h" },
    { mc: 1, cd: 12, lbl: "mc1+cd12h" },
    { mc: 2, cd: 6,  lbl: "mc2+cd6h" },
    { mc: 3, cd: 6,  lbl: "mc3+cd6h" },
  ];
  for (const b of tinyBases) {
    for (const m of mcOptions) {
      configs.push({
        label: `${b.label} + ${m.lbl}`,
        category: "risk_tiny",
        slPct: b.slPct, slMode: "fixed",
        trail: b.trail,
        maxConcurrent: m.mc,
        entryCdH: m.cd,
      });
    }
  }

  // R8: tight SL with z-reversal safety exit
  for (const slPct of [0.5, 1, 1.5, 2]) {
    for (const mc of [1, 2, 3]) {
      configs.push({
        label: `SL${slPct}%+zrev+tr9/0.5 + mc${mc}`,
        category: "risk_tiny",
        slPct, slMode: "fixed",
        trail: [{ a: 9, d: 0.5 }],
        zReversal: true,
        maxConcurrent: mc,
        entryCdH: 1,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPLORE: completely new parameter space (fresh approach)
  // Forget prior values — sweep entries, margin, universe, direction
  // ═══════════════════════════════════════════════════════════════
  const MAJORS = new Set([
    "ETH", "SOL", "DOGE", "ADA", "XRP", "LINK", "DOT", "AVAX", "LDO", "OP",
    "ARB", "SUI", "APT", "UNI", "NEAR", "TIA", "HYPE", "FET", "ENA", "WIF",
  ]);
  const TOP5 = new Set(["ETH", "SOL", "DOGE", "XRP", "LINK"]);
  const MAJOR_BLUE_CHIPS = new Set(["ETH", "SOL", "XRP", "DOGE"]);

  // ── X1: sweep z-thresholds on all pairs with best exit (SL3%+zrev+tr9/0.5) ──
  const zSweep = [
    { z1: 1.5, z4: 1.0 }, { z1: 2.0, z4: 1.5 },
    { z1: 2.5, z4: 1.5 }, { z1: 2.5, z4: 2.0 },
    { z1: 3.0, z4: 2.0 }, { z1: 3.0, z4: 2.5 },
    { z1: 3.5, z4: 2.5 }, { z1: 4.0, z4: 3.0 },
    { z1: 5.0, z4: 3.0 },
  ];
  for (const z of zSweep) {
    configs.push({
      label: `X1 z${z.z1}/${z.z4} SL3%+zrev+tr9/0.5`,
      category: "explore_zsweep",
      slPct: 3, slMode: "fixed",
      trail: [{ a: 9, d: 0.5 }], zReversal: true,
      z1hThresh: z.z1, z4hThresh: z.z4,
    });
  }

  // ── X2: majors-only universe with various entries ──
  for (const uni of [
    { set: MAJORS, name: "maj20" },
    { set: TOP5, name: "top5" },
    { set: MAJOR_BLUE_CHIPS, name: "blue4" },
  ]) {
    for (const z of [{ z1: 2, z4: 1.5 }, { z1: 2.5, z4: 2 }, { z1: 3, z4: 2 }]) {
      configs.push({
        label: `X2 ${uni.name} z${z.z1}/${z.z4} SL3%+zrev+tr9/0.5`,
        category: "explore_uni",
        slPct: 3, slMode: "fixed",
        trail: [{ a: 9, d: 0.5 }], zReversal: true,
        pairAllow: uni.set,
        z1hThresh: z.z1, z4hThresh: z.z4,
      });
      configs.push({
        label: `X2 ${uni.name} z${z.z1}/${z.z4} SL5%+tr20/2`,
        category: "explore_uni",
        slPct: 5, slMode: "fixed",
        trail: [{ a: 20, d: 2 }],
        pairAllow: uni.set,
        z1hThresh: z.z1, z4hThresh: z.z4,
      });
    }
  }

  // ── X3: smaller margin ($3, $5) with various configs ──
  for (const m of [3, 5]) {
    configs.push({
      label: `X3 $${m}mrg SL3%+zrev+tr9/0.5`,
      category: "explore_margin",
      slPct: 3, slMode: "fixed",
      trail: [{ a: 9, d: 0.5 }], zReversal: true,
      marginUsd: m,
    });
    configs.push({
      label: `X3 $${m}mrg z3/2 SL3%+zrev+tr9/0.5`,
      category: "explore_margin",
      slPct: 3, slMode: "fixed",
      trail: [{ a: 9, d: 0.5 }], zReversal: true,
      marginUsd: m, z1hThresh: 3, z4hThresh: 2,
    });
    configs.push({
      label: `X3 $${m}mrg maj20 z3/2 SL3%+zrev+tr9/0.5`,
      category: "explore_margin",
      slPct: 3, slMode: "fixed",
      trail: [{ a: 9, d: 0.5 }], zReversal: true,
      marginUsd: m, pairAllow: MAJORS,
      z1hThresh: 3, z4hThresh: 2,
    });
    configs.push({
      label: `X3 $${m}mrg top5 z3/2 SL3%+zrev+tr9/0.5`,
      category: "explore_margin",
      slPct: 3, slMode: "fixed",
      trail: [{ a: 9, d: 0.5 }], zReversal: true,
      marginUsd: m, pairAllow: TOP5,
      z1hThresh: 3, z4hThresh: 2,
    });
  }

  // ── X4: long-only (shorts have been losers OOS per prior research) ──
  for (const z of [{ z1: 2, z4: 1.5 }, { z1: 2.5, z4: 2 }, { z1: 3, z4: 2 }]) {
    configs.push({
      label: `X4 longOnly z${z.z1}/${z.z4} SL3%+zrev+tr9/0.5`,
      category: "explore_longOnly",
      slPct: 3, slMode: "fixed",
      trail: [{ a: 9, d: 0.5 }], zReversal: true,
      longOnly: true,
      z1hThresh: z.z1, z4hThresh: z.z4,
    });
    configs.push({
      label: `X4 longOnly maj20 z${z.z1}/${z.z4} SL3%+zrev+tr9/0.5`,
      category: "explore_longOnly",
      slPct: 3, slMode: "fixed",
      trail: [{ a: 9, d: 0.5 }], zReversal: true,
      longOnly: true, pairAllow: MAJORS,
      z1hThresh: z.z1, z4hThresh: z.z4,
    });
  }

  // ── X5: require N consecutive signal bars (confirmation filter) ──
  for (const n of [2, 3]) {
    for (const z of [{ z1: 2, z4: 1.5 }, { z1: 2.5, z4: 1.5 }]) {
      configs.push({
        label: `X5 req${n}x z${z.z1}/${z.z4} SL3%+zrev+tr9/0.5`,
        category: "explore_confirm",
        slPct: 3, slMode: "fixed",
        trail: [{ a: 9, d: 0.5 }], zReversal: true,
        z1hThresh: z.z1, z4hThresh: z.z4,
        requireConsecutive: n,
      });
    }
  }

  // ── X6: short max-hold + tight constraints ──
  for (const maxH of [4, 8, 12, 24]) {
    configs.push({
      label: `X6 maxH${maxH}h SL3%+zrev+tr9/0.5`,
      category: "explore_time",
      slPct: 3, slMode: "fixed",
      trail: [{ a: 9, d: 0.5 }], zReversal: true,
      maxHoldH: maxH,
    });
  }

  // ── X7: "kitchen sink" — stack everything aggressive on majors ──
  const kitchen = [
    { u: MAJORS,            un: "maj20" },
    { u: TOP5,              un: "top5" },
    { u: MAJOR_BLUE_CHIPS,  un: "blue4" },
  ];
  for (const k of kitchen) {
    for (const mrg of [3, 5, 10]) {
      for (const z of [{ z1: 2.5, z4: 1.5 }, { z1: 3, z4: 2 }, { z1: 3.5, z4: 2.5 }]) {
        for (const mc of [1, 2, 3]) {
          configs.push({
            label: `X7 ${k.un} $${mrg}mrg z${z.z1}/${z.z4} mc${mc}`,
            category: "explore_kitchen",
            slPct: 3, slMode: "fixed",
            trail: [{ a: 9, d: 0.5 }], zReversal: true,
            longOnly: true,
            pairAllow: k.u,
            marginUsd: mrg,
            z1hThresh: z.z1, z4hThresh: z.z4,
            maxConcurrent: mc,
            entryCdH: 4,
            maxHoldH: 24,
          });
        }
      }
    }
  }

  // ── X8: very picky entries (z > 4) on all pairs, small margin ──
  for (const z of [3.5, 4, 5, 6]) {
    for (const mrg of [5, 10]) {
      configs.push({
        label: `X8 z${z} $${mrg}mrg SL3%+zrev+tr9/0.5`,
        category: "explore_picky",
        slPct: 3, slMode: "fixed",
        trail: [{ a: 9, d: 0.5 }], zReversal: true,
        z1hThresh: z, z4hThresh: z * 0.7,
        marginUsd: mrg,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Y: PUSH $/DAY HIGHER while keeping MDD < $20
  // Strategy: more pair universes, bigger margin, different trails,
  // relaxed z + tight pair universe, longer max-hold
  // ═══════════════════════════════════════════════════════════════
  const ALT5_A = new Set(["AVAX", "DOT", "ADA", "LDO", "OP"]);
  const ALT5_B = new Set(["ARB", "UNI", "NEAR", "APT", "TIA"]);
  const ALT5_C = new Set(["SUI", "ENA", "HYPE", "FET", "WIF"]);
  const TOP8  = new Set(["ETH", "SOL", "DOGE", "XRP", "LINK", "AVAX", "DOT", "ADA"]);
  const TOP10 = new Set([...TOP8, "LDO", "OP"]);
  const TOP12 = new Set([...TOP10, "ARB", "UNI"]);
  const ETHSOL = new Set(["ETH", "SOL"]);

  // Y1: alt universes (uncorrelated with top5 — potential to diversify)
  for (const uni of [
    { set: ALT5_A, name: "alt5A" },
    { set: ALT5_B, name: "alt5B" },
    { set: ALT5_C, name: "alt5C" },
    { set: TOP8,   name: "top8" },
    { set: TOP10,  name: "top10" },
    { set: TOP12,  name: "top12" },
    { set: ETHSOL, name: "ethsol" },
  ]) {
    for (const z of [{ z1: 2.5, z4: 1.5 }, { z1: 3, z4: 2 }, { z1: 2, z4: 1.5 }]) {
      configs.push({
        label: `Y1 ${uni.name} z${z.z1}/${z.z4} SL3%+zrev+tr9/0.5`,
        category: "y_uni",
        slPct: 3, slMode: "fixed",
        trail: [{ a: 9, d: 0.5 }], zReversal: true,
        pairAllow: uni.set,
        z1hThresh: z.z1, z4hThresh: z.z4,
      });
    }
  }

  // Y2: top5 with larger margin (more $/day, but will it blow MDD?)
  for (const mrg of [15, 20, 25, 30]) {
    configs.push({
      label: `Y2 top5 $${mrg}mrg z3/2 SL3%+zrev+tr9/0.5`,
      category: "y_mrg",
      slPct: 3, slMode: "fixed",
      trail: [{ a: 9, d: 0.5 }], zReversal: true,
      pairAllow: TOP5,
      marginUsd: mrg,
      z1hThresh: 3, z4hThresh: 2,
    });
  }

  // Y3: top5 z3/2 with different trail variants (find profit squeeze)
  const y3Trails = [
    { a: 5,  d: 0.5, lbl: "tr5/0.5" },
    { a: 7,  d: 0.5, lbl: "tr7/0.5" },
    { a: 9,  d: 0.25,lbl: "tr9/0.25" },
    { a: 9,  d: 1,   lbl: "tr9/1" },
    { a: 12, d: 0.5, lbl: "tr12/0.5" },
    { a: 15, d: 1,   lbl: "tr15/1" },
    { a: 20, d: 2,   lbl: "tr20/2" },
  ];
  for (const t of y3Trails) {
    configs.push({
      label: `Y3 top5 z3/2 SL3%+zrev+${t.lbl}`,
      category: "y_trail",
      slPct: 3, slMode: "fixed",
      trail: [{ a: t.a, d: t.d }], zReversal: true,
      pairAllow: TOP5, z1hThresh: 3, z4hThresh: 2,
    });
    configs.push({
      label: `Y3 top5 z2.5/1.5 SL3%+zrev+${t.lbl}`,
      category: "y_trail",
      slPct: 3, slMode: "fixed",
      trail: [{ a: t.a, d: t.d }], zReversal: true,
      pairAllow: TOP5, z1hThresh: 2.5, z4hThresh: 1.5,
    });
  }

  // Y4: top5 z3/2 with wider SL variants (let winners run)
  for (const slPct of [2, 4, 5, 7, 10]) {
    configs.push({
      label: `Y4 top5 z3/2 SL${slPct}%+zrev+tr9/0.5`,
      category: "y_sl",
      slPct, slMode: "fixed",
      trail: [{ a: 9, d: 0.5 }], zReversal: true,
      pairAllow: TOP5, z1hThresh: 3, z4hThresh: 2,
    });
  }

  // Y5: top5/maj20 with various maxConcurrent + margin (allow >1 pos but control via MC)
  for (const uni of [
    { set: TOP5, name: "top5" },
    { set: MAJORS, name: "maj20" },
    { set: TOP10, name: "top10" },
  ]) {
    for (const mrg of [10, 15, 20]) {
      for (const mc of [2, 3, 5]) {
        configs.push({
          label: `Y5 ${uni.name} $${mrg}mrg z3/2 mc${mc}`,
          category: "y_mc",
          slPct: 3, slMode: "fixed",
          trail: [{ a: 9, d: 0.5 }], zReversal: true,
          pairAllow: uni.set,
          marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
      }
    }
  }

  // Y6: long-only on majors with looser z (capture bull momentum, skip losing shorts)
  for (const uni of [
    { set: TOP5, name: "top5" },
    { set: TOP8, name: "top8" },
    { set: MAJORS, name: "maj20" },
  ]) {
    for (const z of [{ z1: 2, z4: 1.5 }, { z1: 2.5, z4: 1.5 }, { z1: 2.5, z4: 2 }]) {
      for (const mrg of [10, 15, 20]) {
        configs.push({
          label: `Y6 ${uni.name} LONG z${z.z1}/${z.z4} $${mrg}mrg SL3%+zrev+tr9/0.5`,
          category: "y_long",
          slPct: 3, slMode: "fixed",
          trail: [{ a: 9, d: 0.5 }], zReversal: true,
          longOnly: true,
          pairAllow: uni.set,
          marginUsd: mrg,
          z1hThresh: z.z1, z4hThresh: z.z4,
        });
      }
    }
  }

  // Y7: extended max-hold on top performers (maybe cutting winners early)
  for (const maxH of [120, 168, 240]) {
    for (const z of [{ z1: 2.5, z4: 1.5 }, { z1: 3, z4: 2 }]) {
      configs.push({
        label: `Y7 top5 z${z.z1}/${z.z4} maxH${maxH}h SL3%+zrev+tr9/0.5`,
        category: "y_hold",
        slPct: 3, slMode: "fixed",
        trail: [{ a: 9, d: 0.5 }], zReversal: true,
        pairAllow: TOP5,
        z1hThresh: z.z1, z4hThresh: z.z4,
        maxHoldH: maxH,
      });
    }
  }

  // Y8: "stacked" runs — sets that might combine without correlation
  // Note: each tested alone to see individual profile; user can run two in parallel live.
  // (also useful: top5 z3/2 + alt5 z3/2 as two engines)

  // Y10: push the winning Y5 top5 $20mrg mc3 with different trail variants
  const y10Trails = [
    { a: 7, d: 0.5, lbl: "tr7/0.5" },
    { a: 9, d: 0.5, lbl: "tr9/0.5" },
    { a: 12, d: 0.5, lbl: "tr12/0.5" },
    { a: 15, d: 1,   lbl: "tr15/1" },
    { a: 20, d: 2,   lbl: "tr20/2" },
    { a: 25, d: 2,   lbl: "tr25/2" },
    { a: 30, d: 3,   lbl: "tr30/3" },
    { a: 40, d: 4,   lbl: "tr40/4" },
    { a: 50, d: 5,   lbl: "tr50/5" },
    { a: 60, d: 6,   lbl: "tr60/6" },
    { a: 80, d: 8,   lbl: "tr80/8" },
  ];
  for (const tr of y10Trails) {
    for (const mrg of [15, 18, 20, 22, 25]) {
      for (const mc of [2, 3, 4]) {
        configs.push({
          label: `Y10 top5 $${mrg}mrg z3/2 mc${mc} ${tr.lbl}`,
          category: "y_push",
          slPct: 3, slMode: "fixed",
          trail: [{ a: tr.a, d: tr.d }], zReversal: true,
          pairAllow: TOP5,
          marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
      }
    }
  }

  // Y11: looser z on top5 with mc + bigger margin (more trades, same MDD?)
  for (const z of [{ z1: 2.5, z4: 1.5 }, { z1: 2.5, z4: 2 }, { z1: 2, z4: 1.5 }]) {
    for (const mrg of [10, 15, 20]) {
      for (const mc of [2, 3]) {
        configs.push({
          label: `Y11 top5 z${z.z1}/${z.z4} $${mrg}mrg mc${mc}`,
          category: "y_push",
          slPct: 3, slMode: "fixed",
          trail: [{ a: 9, d: 0.5 }], zReversal: true,
          pairAllow: TOP5,
          marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: z.z1, z4hThresh: z.z4,
        });
      }
    }
  }

  // Y12: expand to top8/top10 with larger margin + mc3 (more diversification)
  for (const uni of [
    { set: TOP8, name: "top8" },
    { set: TOP10, name: "top10" },
  ]) {
    for (const mrg of [15, 20, 25]) {
      for (const mc of [3, 4, 5]) {
        configs.push({
          label: `Y12 ${uni.name} $${mrg}mrg z3/2 mc${mc}`,
          category: "y_push",
          slPct: 3, slMode: "fixed",
          trail: [{ a: 9, d: 0.5 }], zReversal: true,
          pairAllow: uni.set,
          marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
        configs.push({
          label: `Y12 ${uni.name} $${mrg}mrg z3/2 mc${mc} tr20/2`,
          category: "y_push",
          slPct: 3, slMode: "fixed",
          trail: [{ a: 20, d: 2 }], zReversal: true,
          pairAllow: uni.set,
          marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
      }
    }
  }

  // Y13: top5 winning config with wider trail + bigger margin
  for (const mrg of [15, 20, 25]) {
    for (const tr of [[15, 1], [20, 2], [25, 2]]) {
      for (const mc of [2, 3]) {
        configs.push({
          label: `Y13 top5 $${mrg}mrg z3/2 mc${mc} tr${tr[0]}/${tr[1]}`,
          category: "y_push",
          slPct: 3, slMode: "fixed",
          trail: [{ a: tr[0]!, d: tr[1]! }], zReversal: true,
          pairAllow: TOP5,
          marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
      }
    }
  }

  // Y14: top5 without zrev (let trail + SL do the work, wider SL)
  for (const mrg of [15, 20]) {
    for (const sl of [3, 5, 7]) {
      for (const tr of [[9, 0.5], [15, 1], [20, 2]]) {
        for (const mc of [2, 3]) {
          configs.push({
            label: `Y14 top5 $${mrg}mrg z3/2 mc${mc} SL${sl}% tr${tr[0]}/${tr[1]}`,
            category: "y_push",
            slPct: sl, slMode: "fixed",
            trail: [{ a: tr[0]!, d: tr[1]! }],
            pairAllow: TOP5,
            marginUsd: mrg, maxConcurrent: mc,
            z1hThresh: 3, z4hThresh: 2,
          });
        }
      }
    }
  }

  // Y9: NO z-reversal exit (pure trail, let winners run on top5)
  for (const z of [{ z1: 2.5, z4: 1.5 }, { z1: 3, z4: 2 }]) {
    for (const sl of [2, 3, 5]) {
      for (const t of [[9, 0.5], [7, 0.5], [15, 1]]) {
        configs.push({
          label: `Y9 top5 z${z.z1}/${z.z4} SL${sl}%+tr${t[0]}/${t[1]} (no zrev)`,
          category: "y_nozrev",
          slPct: sl, slMode: "fixed",
          trail: [{ a: t[0]!, d: t[1]! }],
          pairAllow: TOP5,
          z1hThresh: z.z1, z4hThresh: z.z4,
        });
      }
    }
  }

  return configs;
}

// ───── Main ─────
function fmtDollar(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function main() {
  console.log("=".repeat(140));
  console.log("  EXCHANGE SL RESEARCH: Find tick-level SL config that beats 1h-boundary baseline");
  console.log("  Entry: z1h>2.0 AND z4h>1.5, 127 pairs, $10 margin, real lev (cap 10x), block h22-23, 1h SL CD");
  console.log("  Period: 2025-06-01 to 2026-03-25 (" + OOS_D.toFixed(0) + " days)");
  console.log("=".repeat(140));

  console.log("\nLoading 5m + 1h + 4h data for all pairs...");
  const pairs: PD[] = [];
  let btc: PI | null = null;
  for (const n of ALL) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 100 || h4.length < 50) continue;
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const atr14_1h = computeATR(h1, 14);
    const ema9 = computeEMA(h1, 9);
    const ema21 = computeEMA(h1, 21);
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= OOS_S - 24 * H && b.t <= OOS_E + 24 * H);
    const ind: PI = { h1, h4, m5, z1, z4, atr14_1h, h1Map, h4Map, ema9_1h: ema9, ema21_1h: ema21 };
    pairs.push({ name: n, ind, sp: SP[n] ?? DSP, lev, not: MARGIN * lev });
  }
  console.log(`${pairs.length} pairs loaded`);

  // BTC data for BTC-regime exit
  let btcRaw = load("BTCUSDT");
  if (btcRaw.length > 0) {
    const bh1 = aggregate(btcRaw, H, 10);
    const bh4 = aggregate(btcRaw, H4, 40);
    const bz1 = computeZ(bh1);
    const bz4 = computeZ(bh4);
    const batr = computeATR(bh1, 14);
    const bema9 = computeEMA(bh1, 9);
    const bema21 = computeEMA(bh1, 21);
    const bh1Map = new Map<number, number>();
    bh1.forEach((c, i) => bh1Map.set(c.t, i));
    const bh4Map = new Map<number, number>();
    bh4.forEach((c, i) => bh4Map.set(c.t, i));
    btc = {
      h1: bh1, h4: bh4, m5: btcRaw,
      z1: bz1, z4: bz4, atr14_1h: batr,
      h1Map: bh1Map, h4Map: bh4Map,
      ema9_1h: bema9, ema21_1h: bema21,
    };
    console.log(`BTC loaded: ${bh1.length} 1h bars for regime filter`);
  } else {
    console.log("BTC not loaded - BTC regime configs will be skipped");
  }

  const configs = buildConfigs();
  console.log(`\nTesting ${configs.length} configs...\n`);

  // Header
  const hdr = `${"Config".padEnd(55)} ${"Cat".padEnd(12)} ${"$/day".padStart(9)} ${"MDD".padStart(6)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"AvgW".padStart(7)} ${"AvgL".padStart(7)} ${"MaxL".padStart(7)} ${"N".padStart(5)}`;
  console.log(hdr);
  console.log("-".repeat(140));

  const results: Array<{ cfg: StratConfig; res: SimResult }> = [];
  for (const cfg of configs) {
    if (cfg.btcRegime && !btc) continue;
    const res = simulate(pairs, btc!, cfg);
    results.push({ cfg, res });
    const line = `${cfg.label.padEnd(55).slice(0, 55)} ${cfg.category.padEnd(12)} ${fmtDollar(res.dollarsPerDay).padStart(9)} ${("$" + res.maxDD.toFixed(0)).padStart(6)} ${res.pf.toFixed(2).padStart(6)} ${res.wr.toFixed(1).padStart(6)} ${fmtDollar(res.avgWin).padStart(7)} ${fmtDollar(res.avgLoss).padStart(7)} ${fmtDollar(res.maxSingleLoss).padStart(7)} ${String(res.numTrades).padStart(5)}`;
    console.log(line);
  }

  // Top 10 ranked by $/day
  console.log("\n" + "=".repeat(140));
  console.log("TOP 10 BY $/DAY (profitable only)");
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("-".repeat(140));
  const profitable = results.filter(r => r.res.dollarsPerDay > 0).sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of profitable.slice(0, 10)) {
    const line = `${r.cfg.label.padEnd(55).slice(0, 55)} ${r.cfg.category.padEnd(12)} ${fmtDollar(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(6)} ${r.res.pf.toFixed(2).padStart(6)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtDollar(r.res.avgWin).padStart(7)} ${fmtDollar(r.res.avgLoss).padStart(7)} ${fmtDollar(r.res.maxSingleLoss).padStart(7)} ${String(r.res.numTrades).padStart(5)}`;
    console.log(line);
  }

  // Top 10 ranked by smallest MaxSingleLoss among profitable
  console.log("\n" + "=".repeat(140));
  console.log("TOP 10 BY SMALLEST MAX-SINGLE-LOSS (profitable only, must beat $1/day)");
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("-".repeat(140));
  const viable = profitable.filter(r => r.res.dollarsPerDay > 1);
  const bySafety = [...viable].sort((a, b) => b.res.maxSingleLoss - a.res.maxSingleLoss);
  for (const r of bySafety.slice(0, 10)) {
    const line = `${r.cfg.label.padEnd(55).slice(0, 55)} ${r.cfg.category.padEnd(12)} ${fmtDollar(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(6)} ${r.res.pf.toFixed(2).padStart(6)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtDollar(r.res.avgWin).padStart(7)} ${fmtDollar(r.res.avgLoss).padStart(7)} ${fmtDollar(r.res.maxSingleLoss).padStart(7)} ${String(r.res.numTrades).padStart(5)}`;
    console.log(line);
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN TARGET: MaxDD < $20, sorted by $/day
  // ═══════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(140));
  console.log("*** MaxDD < $20 (MAIN TARGET) *** — top 25 sorted by $/day");
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("-".repeat(140));
  const mddOk = results.filter(r => r.res.maxDD < 20 && r.res.dollarsPerDay > 0)
    .sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  if (mddOk.length === 0) {
    console.log("  NO configs achieved MaxDD < $20");
  } else {
    for (const r of mddOk.slice(0, 25)) {
      const line = `${r.cfg.label.padEnd(55).slice(0, 55)} ${r.cfg.category.padEnd(12)} ${fmtDollar(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(6)} ${r.res.pf.toFixed(2).padStart(6)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtDollar(r.res.avgWin).padStart(7)} ${fmtDollar(r.res.avgLoss).padStart(7)} ${fmtDollar(r.res.maxSingleLoss).padStart(7)} ${String(r.res.numTrades).padStart(5)}`;
      console.log(line);
    }
  }

  // Show MDD < $50 too (near-miss) for context
  console.log("\n" + "=".repeat(140));
  console.log("MaxDD < $50 (near-miss bucket) — top 15 by $/day");
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("-".repeat(140));
  const mdd50 = results.filter(r => r.res.maxDD < 50 && r.res.maxDD >= 20 && r.res.dollarsPerDay > 0)
    .sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of mdd50.slice(0, 15)) {
    const line = `${r.cfg.label.padEnd(55).slice(0, 55)} ${r.cfg.category.padEnd(12)} ${fmtDollar(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(6)} ${r.res.pf.toFixed(2).padStart(6)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtDollar(r.res.avgWin).padStart(7)} ${fmtDollar(r.res.avgLoss).padStart(7)} ${fmtDollar(r.res.maxSingleLoss).padStart(7)} ${String(r.res.numTrades).padStart(5)}`;
    console.log(line);
  }

  // Top 3 detailed
  console.log("\n" + "=".repeat(140));
  console.log("TOP 3 DETAILED (by $/day, profitable)");
  console.log("=".repeat(140));
  for (let i = 0; i < Math.min(3, profitable.length); i++) {
    const r = profitable[i]!;
    console.log(`\n#${i + 1}: ${r.cfg.label}`);
    console.log(`  Category:        ${r.cfg.category}`);
    console.log(`  $/day:           ${fmtDollar(r.res.dollarsPerDay)}`);
    console.log(`  Total PnL:       ${fmtDollar(r.res.totalPnl)} over ${OOS_D.toFixed(0)} days`);
    console.log(`  Max DD:          $${r.res.maxDD.toFixed(2)}`);
    console.log(`  Profit Factor:   ${r.res.pf.toFixed(2)}`);
    console.log(`  Win rate:        ${r.res.wr.toFixed(1)}%`);
    console.log(`  Avg win:         ${fmtDollar(r.res.avgWin)}`);
    console.log(`  Avg loss:        ${fmtDollar(r.res.avgLoss)}`);
    console.log(`  Max single loss: ${fmtDollar(r.res.maxSingleLoss)}  (user is worried about this)`);
    console.log(`  Num trades:      ${r.res.numTrades}`);
    // Reason breakdown
    const reasonCounts = new Map<string, { n: number; pnl: number }>();
    for (const t of r.res.trades) {
      const ex = reasonCounts.get(t.reason) ?? { n: 0, pnl: 0 };
      ex.n++; ex.pnl += t.pnl;
      reasonCounts.set(t.reason, ex);
    }
    console.log(`  Exit breakdown:`);
    for (const [reason, v] of reasonCounts) {
      console.log(`    ${reason.padEnd(10)} ${String(v.n).padStart(5)} trades  ${fmtDollar(v.pnl).padStart(9)}`);
    }
  }

  // Baseline comparison
  const baseline = results.find(r => r.cfg.category === "baseline");
  if (baseline) {
    console.log("\n" + "=".repeat(140));
    console.log("BASELINE (current live config)");
    console.log("=".repeat(140));
    const r = baseline.res;
    console.log(`  $/day:           ${fmtDollar(r.dollarsPerDay)}`);
    console.log(`  Max DD:          $${r.maxDD.toFixed(2)}`);
    console.log(`  Profit Factor:   ${r.pf.toFixed(2)}`);
    console.log(`  Win rate:        ${r.wr.toFixed(1)}%`);
    console.log(`  Max single loss: ${fmtDollar(r.maxSingleLoss)}`);
    console.log(`  Num trades:      ${r.numTrades}`);
  }
}

main();
