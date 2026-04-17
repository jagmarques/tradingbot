/**
 * 3-Stage Stepped Trail Fine-Tune: GARCH-only
 *
 * Strategy: GARCH $9, z1h>4.5 & z4h>3.0, SL 3%, TP 7%, 72h hold, max 7 positions
 * BTC 4h EMA(12/21) filter (longs: BTC bullish; shorts: always allowed)
 *
 * Trail: 3 stages — each stage has activation% and trail distance%
 *   Stage 1 fires first; once active it replaces SL with (peak - dist1)
 *   Stage 2 activates when peak >= act2, updates trail to (peak - dist2)
 *   Stage 3 activates when peak >= act3, updates trail to (peak - dist3)
 *
 * 3-sweep approach:
 *   Sweep 1: Fix s2=30/3 s3=35/1, vary s1 (21 combos)
 *   Sweep 2: Fix s1=25/6 s3=35/1, vary s2 (18 combos)
 *   Sweep 3: Fix s1=25/6 s2=30/3, vary s3 (12 combos)
 *   Final:   Best from each sweep + 2 extras (5-10 combos)
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-finetune-trail.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface C { t: number; o: number; h: number; l: number; c: number; }

// ─── Constants ──────────────────────────────────────────────────────────────────

const CD_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const MAX_POS = 7;
const GARCH_MARGIN = 9;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4,  ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4,   LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4,    DOT: 4.95e-4,  ADA: 5.55e-4,  LDO: 5.8e-4,
  OP:  6.2e-4,  BTC: 0.5e-4,   SOL: 2.0e-4,   ETH: 1.0e-4,
  WIF: 5.05e-4, DASH: 7.15e-4, TIA: 4e-4,     AVAX: 3e-4,
  NEAR: 4e-4,   SUI: 3e-4,     FET: 4e-4,     ZEC: 4e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX","NEAR","SUI","FET",
];

// ─── Data loading ──────────────────────────────────────────────────────────────

function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t,  o: +b.o,  h: +b.h,  l: +b.l,  c: +b.c  },
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(bucket);
    if (!arr) { arr = []; groups.set(bucket, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// ─── Indicators ─────────────────────────────────────────────────────────────────

function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i-1].c),
      Math.abs(cs[i].l - cs[i-1].c),
    );
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += trs[j];
    atr[i] = s / period;
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period;
      init = true;
    } else {
      ema[i] = values[i] * k + ema[i-1] * (1 - k);
    }
  }
  return ema;
}

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i].c / cs[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j].c / cs[j-1].c - 1;
      sumSq += r * r;
      count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

// ─── Price helpers ────────────────────────────────────────────────────────────

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }

function entryPx(pair: string, dir: "long"|"short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}

function exitPx(pair: string, dir: "long"|"short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}

function calcPnl(dir: "long"|"short", ep: number, xp: number, notional: number): number {
  return (dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional) - notional * FEE * 2;
}

// ─── Load data ────────────────────────────────────────────────────────────────

console.log("Loading 5m data and aggregating...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// ─── BTC 4h EMA(12/21) filter ────────────────────────────────────────────────

const btcH4 = h4Data.get("BTC")!;
const btcH4Closes = btcH4.map(c => c.c);
const btcH4Ema12 = calcEMA(btcH4Closes, 12);
const btcH4Ema21 = calcEMA(btcH4Closes, 21);

function btcH4Bullish(t: number): boolean {
  // Find last completed 4h bar before t
  let idx = -1;
  for (let i = btcH4.length - 1; i >= 0; i--) {
    if (btcH4[i].t < t) { idx = i; break; }
  }
  if (idx < 0) return false;
  const off12 = btcH4.length - btcH4Ema12.length;
  const off21 = btcH4.length - btcH4Ema21.length;
  const i12 = idx - off12;
  const i21 = idx - off21;
  return i12 >= 0 && i21 >= 0 && btcH4Ema12[i12] > btcH4Ema21[i21];
}

console.log(`  Loaded ${raw5m.size} pairs (5m), BTC 4h: ${btcH4.length} bars\n`);

// ─── Signal type ──────────────────────────────────────────────────────────────

interface Signal {
  id: number;
  pair: string;
  dir: "long"|"short";
  entryTime: number;
  entryPrice: number;
  sl: number;
  exitTime: number;
  exitPrice: number;
  exitReason: string;
}

// ─── GARCH v2 signal generation ───────────────────────────────────────────────
// z1h>4.5 & z4h>3.0 for longs; z1h<-3.0 & z4h<-3.0 for shorts
// 1h EMA(9) > EMA(21) both directions (pair-level trend)
// BTC 4h EMA(12/21) for longs only; shorts always allowed
// SL: 3% from entry (capped 3.5%), TP: 7%, max hold: 72h

function genGarch(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const h1 = h1Data.get(pair);
    const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;

    const z1h = computeZScores(h1, 3, 20);
    const z4h = computeZScores(h4, 3, 20);
    const h1Closes = h1.map(c => c.c);
    const ema9  = calcEMA(h1Closes, 9);
    const ema21 = calcEMA(h1Closes, 21);

    const h4TsMap = new Map<number, number>();
    h4.forEach((c, i) => h4TsMap.set(c.t, i));

    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;

    for (let i = 24; i < h1.length; i++) {
      const bar = h1[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long"  && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp) {
          const tp = pos.dir === "long" ? pos.ep * 1.07 : pos.ep * 0.93;
          if (pos.dir === "long"  && bar.h >= tp) { xp = tp; reason = "tp"; }
          if (pos.dir === "short" && bar.l <= tp) { xp = tp; reason = "tp"; }
        }
        if (!xp && (bar.t - pos.et) / H >= 72) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END) {
            sigs.push({
              id: 0, pair,
              dir: pos.dir,
              entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl,
              exitTime: bar.t,   exitPrice: xp,       exitReason: reason,
            });
          }
          pos = null;
        }
      }

      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i - 1;
        if (prev < 23) continue;
        const z1 = z1h[prev];
        if (isNaN(z1) || z1 === 0) continue;
        const goLong  = z1 > 4.5;
        const goShort = z1 < -3.0;
        if (!goLong && !goShort) continue;

        const ts4h = Math.floor(h1[prev].t / H4) * H4;
        const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < 23) continue;
        const z4 = z4h[idx4h];
        if (goLong  && z4 <= 3.0)  continue;
        if (goShort && z4 >= -3.0) continue;

        // Pair 1h EMA trend
        const off9  = h1.length - ema9.length;
        const off21 = h1.length - ema21.length;
        const i9  = prev - off9;
        const i21 = prev - off21;
        if (i9 < 0 || i21 < 0) continue;
        if (goLong  && ema9[i9] <= ema21[i21]) continue;
        if (goShort && ema9[i9] >= ema21[i21]) continue;

        // BTC 4h EMA filter
        if (goLong && !btcH4Bullish(h1[prev].t)) continue;

        const dir: "long"|"short" = goLong ? "long" : "short";
        let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
        if (dir === "long")  sl = Math.max(sl, bar.o * 0.965);
        else                  sl = Math.min(sl, bar.o * 1.035);

        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ─── Phase 1+2: Generate signals ─────────────────────────────────────────────

console.log("Phase 1: Generating GARCH signals...");
const allSignals = genGarch();
allSignals.forEach((s, i) => s.id = i);
console.log(`  GARCH signals: ${allSignals.length}\n`);

// ─── Phase 2: Pre-compute trade results using 5m bars ────────────────────────

interface TrailCheckpoint {
  t: number;
  peakPct: number;   // highest leveraged P&L % seen so far (via bar high/low)
  closePct: number;  // close-based leveraged P&L % at this bar
  closePrice: number;
}

interface PrecomputedTrade {
  sig: Signal;
  noTrailPnl: number;
  noTrailReason: string;
  noTrailExitTime: number;
  checkpoints: TrailCheckpoint[];
}

console.log("Phase 2: Pre-computing trade results with 5m precision (per-pair)...");

const sigsByPair = new Map<string, Signal[]>();
for (const sig of allSignals) {
  let arr = sigsByPair.get(sig.pair);
  if (!arr) { arr = []; sigsByPair.set(sig.pair, arr); }
  arr.push(sig);
}

const precomputed = new Map<number, PrecomputedTrade>();

for (const pair of PAIRS) {
  const pairSigs = sigsByPair.get(pair);
  if (!pairSigs || pairSigs.length === 0) continue;

  const bars5m = raw5m.get(pair) ?? [];
  process.stdout.write(`  ${pair} (${pairSigs.length} sigs)...`);

  for (const sig of pairSigs) {
    const NOT = GARCH_MARGIN * LEV;
    const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

    if (bars5m.length === 0) {
      const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
      precomputed.set(sig.id, {
        sig,
        noTrailPnl: calcPnl(sig.dir, ep, xp, NOT),
        noTrailReason: sig.exitReason,
        noTrailExitTime: sig.exitTime,
        checkpoints: [],
      });
      continue;
    }

    // Binary search for start index
    let lo = 0, hi = bars5m.length - 1, startIdx = bars5m.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars5m[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }

    let peakPnlPct = 0;
    const checkpoints: TrailCheckpoint[] = [];
    let noTrailPnl = 0;
    let noTrailReason = sig.exitReason;
    let noTrailExitTime = sig.exitTime;
    let earlyExit = false;

    for (let i = startIdx; i < bars5m.length; i++) {
      const b = bars5m[i];
      if (b.t > sig.exitTime) break;

      // SL check
      if (sig.dir === "long"  && b.l <= sig.sl) {
        const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
        noTrailPnl = calcPnl(sig.dir, ep, xp, NOT);
        noTrailReason = "sl"; noTrailExitTime = b.t;
        earlyExit = true; break;
      }
      if (sig.dir === "short" && b.h >= sig.sl) {
        const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
        noTrailPnl = calcPnl(sig.dir, ep, xp, NOT);
        noTrailReason = "sl"; noTrailExitTime = b.t;
        earlyExit = true; break;
      }

      // TP check (7%)
      const tp = sig.dir === "long" ? sig.entryPrice * 1.07 : sig.entryPrice * 0.93;
      if (sig.dir === "long"  && b.h >= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        noTrailPnl = calcPnl(sig.dir, ep, xp, NOT);
        noTrailReason = "tp"; noTrailExitTime = b.t;
        earlyExit = true; break;
      }
      if (sig.dir === "short" && b.l <= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        noTrailPnl = calcPnl(sig.dir, ep, xp, NOT);
        noTrailReason = "tp"; noTrailExitTime = b.t;
        earlyExit = true; break;
      }

      // Peak tracking (use best intrabar price)
      const bestPct = sig.dir === "long"
        ? (b.h / sig.entryPrice - 1) * LEV * 100
        : (sig.entryPrice / b.l - 1) * LEV * 100;
      if (bestPct > peakPnlPct) peakPnlPct = bestPct;

      // Close-based P&L %
      const closePct = sig.dir === "long"
        ? (b.c / sig.entryPrice - 1) * LEV * 100
        : (sig.entryPrice / b.c - 1) * LEV * 100;

      checkpoints.push({ t: b.t, peakPct: peakPnlPct, closePct, closePrice: b.c });
    }

    if (!earlyExit) {
      const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
      noTrailPnl = calcPnl(sig.dir, ep, xp, NOT);
    }

    precomputed.set(sig.id, {
      sig,
      noTrailPnl,
      noTrailReason,
      noTrailExitTime,
      checkpoints,
    });
  }

  console.log(" done");
}

console.log(`  Pre-computed ${precomputed.size} trades\n`);

// ─── Phase 3: Chronological pool simulation with 3-stage trail ───────────────
// Stage 1: activates when peak >= act1; trail = peak - dist1
// Stage 2: activates when peak >= act2; trail = peak - dist2 (tighter)
// Stage 3: activates when peak >= act3; trail = peak - dist3 (tightest)
// Trail fires when closePct <= current trail level

interface TradeResult {
  pair: string;
  dir: "long"|"short";
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
}

interface ConfigResult {
  label: string;
  s1act: number; s1dist: number;
  s2act: number; s2dist: number;
  s3act: number; s3dist: number;
  trades: number;
  wr: number;
  perDay: number;
  pf: number;
  maxDD: number;
  oosPerDay: number;
  oosPf: number;
  total: number;
  trailExits: number;
  score: number;
}

function runConfig(
  s1act: number, s1dist: number,
  s2act: number, s2dist: number,
  s3act: number, s3dist: number,
  startTs: number,
  endTs: number,
): TradeResult[] {

  const inRange = allSignals.filter(s => s.entryTime >= startTs && s.entryTime < endTs);

  // Determine exit for each signal under the 3-stage trail
  interface Outcome {
    sig: Signal;
    exitTime: number;
    pnl: number;
    reason: string;
  }

  const outcomes: Outcome[] = [];
  for (const sig of inRange) {
    const pc = precomputed.get(sig.id)!;

    if (pc.checkpoints.length === 0) {
      outcomes.push({ sig, exitTime: pc.noTrailExitTime, pnl: pc.noTrailPnl, reason: pc.noTrailReason });
      continue;
    }

    const NOT = GARCH_MARGIN * LEV;
    const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

    let trailFired = false;
    for (const cp of pc.checkpoints) {
      // Determine active stage and corresponding trail level
      let activeTrail: number | null = null;
      if (cp.peakPct >= s3act) {
        // Stage 3 active
        activeTrail = cp.peakPct - s3dist;
      } else if (cp.peakPct >= s2act) {
        // Stage 2 active
        activeTrail = cp.peakPct - s2dist;
      } else if (cp.peakPct >= s1act) {
        // Stage 1 active
        activeTrail = cp.peakPct - s1dist;
      }

      if (activeTrail !== null && cp.closePct <= activeTrail) {
        const xp = exitPx(sig.pair, sig.dir, cp.closePrice, false);
        outcomes.push({ sig, exitTime: cp.t, pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "trail" });
        trailFired = true;
        break;
      }
    }

    if (!trailFired) {
      outcomes.push({ sig, exitTime: pc.noTrailExitTime, pnl: pc.noTrailPnl, reason: pc.noTrailReason });
    }
  }

  // Chronological pool simulation
  interface Evt {
    t: number;
    type: "entry" | "exit";
    idx: number;
    key: string;
  }

  const events: Evt[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    const key = `GARCH:${o.sig.pair}`;
    events.push({ t: o.sig.entryTime, type: "entry", idx: i, key });
    events.push({ t: o.exitTime,      type: "exit",  idx: i, key });
  }
  events.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));

  const openPool = new Map<string, number>();
  const accepted = new Set<number>();

  for (const evt of events) {
    if (evt.type === "exit") {
      if (openPool.get(evt.key) === evt.idx) openPool.delete(evt.key);
    } else {
      if (openPool.has(evt.key)) continue;
      if (openPool.size >= MAX_POS) continue;
      openPool.set(evt.key, evt.idx);
      accepted.add(evt.idx);
    }
  }

  return [...accepted].map(i => ({
    pair:      outcomes[i].sig.pair,
    dir:       outcomes[i].sig.dir,
    entryTime: outcomes[i].sig.entryTime,
    exitTime:  outcomes[i].exitTime,
    pnl:       outcomes[i].pnl,
    reason:    outcomes[i].reason,
  }));
}

function computeStats(
  trades: TradeResult[],
  totalDays: number,
): { wr: number; pf: number; total: number; perDay: number; maxDD: number; trailExits: number } {
  if (trades.length === 0) {
    return { wr: 0, pf: 0, total: 0, perDay: 0, maxDD: 0, trailExits: 0 };
  }
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp     = wins.reduce((s, t) => s + t.pnl, 0);
  const gl     = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total  = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const trailExits = trades.filter(t => t.reason === "trail").length;

  return {
    wr:       wins.length / trades.length * 100,
    pf:       gl > 0 ? gp / gl : 99,
    total,
    perDay:   total / totalDays,
    maxDD,
    trailExits,
  };
}

function evalConfig(
  s1act: number, s1dist: number,
  s2act: number, s2dist: number,
  s3act: number, s3dist: number,
  label: string,
): ConfigResult {
  const fullDays = (FULL_END - FULL_START) / D;
  const oosDays  = (FULL_END - OOS_START)  / D;

  const fullTrades = runConfig(s1act, s1dist, s2act, s2dist, s3act, s3dist, FULL_START, FULL_END);
  const oosTrades  = runConfig(s1act, s1dist, s2act, s2dist, s3act, s3dist, OOS_START,  FULL_END);

  const fs = computeStats(fullTrades, fullDays);
  const os = computeStats(oosTrades,  oosDays);

  const score = (fs.perDay * 100) - (fs.maxDD * 2);

  return {
    label, s1act, s1dist, s2act, s2dist, s3act, s3dist,
    trades: fullTrades.length,
    wr: fs.wr, perDay: fs.perDay, pf: fs.pf,
    maxDD: fs.maxDD, total: fs.total,
    oosPerDay: os.perDay, oosPf: os.pf,
    trailExits: fs.trailExits,
    score,
  };
}

// ─── Config grids ─────────────────────────────────────────────────────────────

// Baseline (no trail)
const baselineResult = evalConfig(0, 0, 0, 0, 0, 0, "Baseline");

// ── Sweep 1: Fix s2=30/3, s3=35/1; vary s1 ───────────────────────────────────
console.log("Phase 3a: Sweep 1 — vary Stage 1 (fix s2=30/3, s3=35/1)...");
const sweep1Results: ConfigResult[] = [];
for (const act1 of [22, 23, 24, 25, 26, 27, 28]) {
  for (const dist1 of [5, 6, 7]) {
    const lbl = `S1 ${act1}/${dist1} | 30/3 | 35/1`;
    const r = evalConfig(act1, dist1, 30, 3, 35, 1, lbl);
    sweep1Results.push(r);
    console.log(`  ${lbl.padEnd(28)} $${r.perDay.toFixed(2)}/day  MaxDD $${r.maxDD.toFixed(0)}  PF ${r.pf.toFixed(2)}  OOS $${r.oosPerDay.toFixed(2)}`);
  }
}

// ── Sweep 2: Fix s1=25/6, s3=35/1; vary s2 ───────────────────────────────────
console.log("\nPhase 3b: Sweep 2 — vary Stage 2 (fix s1=25/6, s3=35/1)...");
const sweep2Results: ConfigResult[] = [];
for (const act2 of [28, 29, 30, 31, 32, 33]) {
  for (const dist2 of [2, 3, 4]) {
    const lbl = `25/6 | S2 ${act2}/${dist2} | 35/1`;
    const r = evalConfig(25, 6, act2, dist2, 35, 1, lbl);
    sweep2Results.push(r);
    console.log(`  ${lbl.padEnd(28)} $${r.perDay.toFixed(2)}/day  MaxDD $${r.maxDD.toFixed(0)}  PF ${r.pf.toFixed(2)}  OOS $${r.oosPerDay.toFixed(2)}`);
  }
}

// ── Sweep 3: Fix s1=25/6, s2=30/3; vary s3 ───────────────────────────────────
console.log("\nPhase 3c: Sweep 3 — vary Stage 3 (fix s1=25/6, s2=30/3)...");
const sweep3Results: ConfigResult[] = [];
for (const act3 of [33, 34, 35, 36, 37, 38]) {
  for (const dist3 of [1, 2]) {
    const lbl = `25/6 | 30/3 | S3 ${act3}/${dist3}`;
    const r = evalConfig(25, 6, 30, 3, act3, dist3, lbl);
    sweep3Results.push(r);
    console.log(`  ${lbl.padEnd(28)} $${r.perDay.toFixed(2)}/day  MaxDD $${r.maxDD.toFixed(0)}  PF ${r.pf.toFixed(2)}  OOS $${r.oosPerDay.toFixed(2)}`);
  }
}

// ── Sweep best picks ─────────────────────────────────────────────────────────
// Sort each sweep by score, pick top 2
sweep1Results.sort((a, b) => b.score - a.score);
sweep2Results.sort((a, b) => b.score - a.score);
sweep3Results.sort((a, b) => b.score - a.score);

const best1 = sweep1Results[0];
const best2 = sweep2Results[0];
const best3 = sweep3Results[0];

// ── Sweep 4: Final combinations ───────────────────────────────────────────────
console.log("\nPhase 3d: Final combinations from sweep winners...");
const finalResults: ConfigResult[] = [];

// Reference config
finalResults.push(evalConfig(25, 6, 30, 3, 35, 1, "REF 25/6|30/3|35/1"));

// Cross-combine best stage params from each sweep
const bestS1act  = best1.s1act;  const bestS1dist  = best1.s1dist;
const bestS2act  = best2.s2act;  const bestS2dist  = best2.s2dist;
const bestS3act  = best3.s3act;  const bestS3dist  = best3.s3dist;

// Best from each sweep independently (with the other two fixed at reference)
if (!(bestS1act === 25 && bestS1dist === 6)) {
  finalResults.push(evalConfig(bestS1act, bestS1dist, 30, 3, 35, 1, `BestS1 ${bestS1act}/${bestS1dist}|30/3|35/1`));
}
if (!(bestS2act === 30 && bestS2dist === 3)) {
  finalResults.push(evalConfig(25, 6, bestS2act, bestS2dist, 35, 1, `25/6|BestS2 ${bestS2act}/${bestS2dist}|35/1`));
}
if (!(bestS3act === 35 && bestS3dist === 1)) {
  finalResults.push(evalConfig(25, 6, 30, 3, bestS3act, bestS3dist, `25/6|30/3|BestS3 ${bestS3act}/${bestS3dist}`));
}

// Full combination of all best stages
const fullBestLabel = `${bestS1act}/${bestS1dist}|${bestS2act}/${bestS2dist}|${bestS3act}/${bestS3dist}`;
finalResults.push(evalConfig(bestS1act, bestS1dist, bestS2act, bestS2dist, bestS3act, bestS3dist, `BEST ${fullBestLabel}`));

// Top 2 from sweep1 combined with best s2/s3
const s1_2nd = sweep1Results[1];
if (s1_2nd) {
  finalResults.push(evalConfig(s1_2nd.s1act, s1_2nd.s1dist, bestS2act, bestS2dist, bestS3act, bestS3dist,
    `2nd ${s1_2nd.s1act}/${s1_2nd.s1dist}|${bestS2act}/${bestS2dist}|${bestS3act}/${bestS3dist}`));
}

// Top 2 from sweep2 combined with best s1/s3
const s2_2nd = sweep2Results[1];
if (s2_2nd) {
  finalResults.push(evalConfig(bestS1act, bestS1dist, s2_2nd.s2act, s2_2nd.s2dist, bestS3act, bestS3dist,
    `${bestS1act}/${bestS1dist}|2nd ${s2_2nd.s2act}/${s2_2nd.s2dist}|${bestS3act}/${bestS3dist}`));
}

// Top 2 from sweep3 combined with best s1/s2
const s3_2nd = sweep3Results[1];
if (s3_2nd) {
  finalResults.push(evalConfig(bestS1act, bestS1dist, bestS2act, bestS2dist, s3_2nd.s3act, s3_2nd.s3dist,
    `${bestS1act}/${bestS1dist}|${bestS2act}/${bestS2dist}|2nd ${s3_2nd.s3act}/${s3_2nd.s3dist}`));
}

// Extra: no-trail baseline for comparison
finalResults.push(baselineResult);

for (const r of finalResults) {
  console.log(`  ${r.label.padEnd(32)} $${r.perDay.toFixed(2)}/day  MaxDD $${r.maxDD.toFixed(0)}  PF ${r.pf.toFixed(2)}  OOS $${r.oosPerDay.toFixed(2)}  score ${r.score.toFixed(1)}`);
}

// ─── Output ──────────────────────────────────────────────────────────────────

const fullDays = (FULL_END - FULL_START) / D;
const oosDays  = (FULL_END - OOS_START)  / D;

const W = 160;
const LINE = "=".repeat(W);

console.log("\n" + LINE);
console.log("3-STAGE STEPPED TRAIL FINE-TUNE: GARCH ONLY");
console.log(`GARCH: $9 margin, z1h>4.5 & z4h>3.0, SL 3%, TP 7%, 72h hold, max ${MAX_POS} positions`);
console.log("BTC filter: 4h EMA(12/21) for longs, shorts always allowed");
console.log(`Full: 2023-01 to 2026-03 (${fullDays.toFixed(0)}d) | OOS: 2025-09+ (${oosDays.toFixed(0)}d)`);
console.log("Score = ($/day * 100) - (MaxDD * 2)");
console.log(LINE);

// ── Sweep 1 results table ─────────────────────────────────────────────────────
console.log("\nSWEEP 1 — Stage 1 variation (fix s2=30/3, s3=35/1)");
console.log("-".repeat(W));
const hdr1 = "Config".padEnd(30) + "Trades".padStart(7) + "WR%".padStart(7) + "Total$".padStart(9) + "$/day".padStart(8) + "PF".padStart(6) + "MaxDD".padStart(8) + "Trails".padStart(7) + " | " + "OOS$/d".padStart(8) + "Score".padStart(8);
console.log(hdr1);
console.log("-".repeat(W));
sweep1Results.sort((a, b) => b.score - a.score);
for (const r of sweep1Results) {
  console.log(
    r.label.padEnd(30) +
    String(r.trades).padStart(7) +
    (r.wr.toFixed(1) + "%").padStart(7) +
    ("$" + r.total.toFixed(0)).padStart(9) +
    ("$" + r.perDay.toFixed(2)).padStart(8) +
    r.pf.toFixed(2).padStart(6) +
    ("$" + r.maxDD.toFixed(0)).padStart(8) +
    String(r.trailExits).padStart(7) +
    " | " +
    ("$" + r.oosPerDay.toFixed(2)).padStart(8) +
    r.score.toFixed(1).padStart(8),
  );
}

// ── Sweep 2 results table ─────────────────────────────────────────────────────
console.log("\nSWEEP 2 — Stage 2 variation (fix s1=25/6, s3=35/1)");
console.log("-".repeat(W));
console.log(hdr1);
console.log("-".repeat(W));
sweep2Results.sort((a, b) => b.score - a.score);
for (const r of sweep2Results) {
  console.log(
    r.label.padEnd(30) +
    String(r.trades).padStart(7) +
    (r.wr.toFixed(1) + "%").padStart(7) +
    ("$" + r.total.toFixed(0)).padStart(9) +
    ("$" + r.perDay.toFixed(2)).padStart(8) +
    r.pf.toFixed(2).padStart(6) +
    ("$" + r.maxDD.toFixed(0)).padStart(8) +
    String(r.trailExits).padStart(7) +
    " | " +
    ("$" + r.oosPerDay.toFixed(2)).padStart(8) +
    r.score.toFixed(1).padStart(8),
  );
}

// ── Sweep 3 results table ─────────────────────────────────────────────────────
console.log("\nSWEEP 3 — Stage 3 variation (fix s1=25/6, s2=30/3)");
console.log("-".repeat(W));
console.log(hdr1);
console.log("-".repeat(W));
sweep3Results.sort((a, b) => b.score - a.score);
for (const r of sweep3Results) {
  console.log(
    r.label.padEnd(30) +
    String(r.trades).padStart(7) +
    (r.wr.toFixed(1) + "%").padStart(7) +
    ("$" + r.total.toFixed(0)).padStart(9) +
    ("$" + r.perDay.toFixed(2)).padStart(8) +
    r.pf.toFixed(2).padStart(6) +
    ("$" + r.maxDD.toFixed(0)).padStart(8) +
    String(r.trailExits).padStart(7) +
    " | " +
    ("$" + r.oosPerDay.toFixed(2)).padStart(8) +
    r.score.toFixed(1).padStart(8),
  );
}

// ── Final candidates table ────────────────────────────────────────────────────
finalResults.sort((a, b) => b.score - a.score);
console.log("\nFINAL CANDIDATES (sorted by score)");
console.log("-".repeat(W));
const hdr2 = "Config".padEnd(40) + "Trades".padStart(7) + "WR%".padStart(7) + "Total$".padStart(9) + "$/day".padStart(8) + "PF".padStart(6) + "MaxDD".padStart(8) + "Trails".padStart(7) + " | " + "OOS$/d".padStart(8) + "OOS PF".padStart(8) + "Score".padStart(8);
console.log(hdr2);
console.log("-".repeat(W));
for (const r of finalResults) {
  const mark = r.label === "Baseline" ? " <<< no trail" : "";
  console.log(
    r.label.padEnd(40) +
    String(r.trades).padStart(7) +
    (r.wr.toFixed(1) + "%").padStart(7) +
    ("$" + r.total.toFixed(0)).padStart(9) +
    ("$" + r.perDay.toFixed(2)).padStart(8) +
    r.pf.toFixed(2).padStart(6) +
    ("$" + r.maxDD.toFixed(0)).padStart(8) +
    String(r.trailExits).padStart(7) +
    " | " +
    ("$" + r.oosPerDay.toFixed(2)).padStart(8) +
    r.oosPf.toFixed(2).padStart(8) +
    r.score.toFixed(1).padStart(8) +
    mark,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n" + LINE);
const baseline = finalResults.find(r => r.label === "Baseline")!;
const winner   = finalResults.filter(r => r.label !== "Baseline")[0];
console.log("SUMMARY");
console.log("-".repeat(W));
if (baseline) {
  console.log(`  Baseline (no trail): $${baseline.perDay.toFixed(2)}/day, MaxDD $${baseline.maxDD.toFixed(0)}, PF ${baseline.pf.toFixed(2)}, OOS $${baseline.oosPerDay.toFixed(2)}/day`);
}
if (winner) {
  console.log(`  Best trail config:   ${winner.label}`);
  console.log(`    $/day $${winner.perDay.toFixed(2)}, MaxDD $${winner.maxDD.toFixed(0)}, PF ${winner.pf.toFixed(2)}, OOS $${winner.oosPerDay.toFixed(2)}/day, score ${winner.score.toFixed(1)}`);
  if (baseline) {
    const delta = winner.perDay - baseline.perDay;
    console.log(`    vs baseline: ${delta >= 0 ? "+" : ""}$${delta.toFixed(2)}/day`);
  }
}

// Stage-by-stage best
console.log("\n  Sweep winners:");
console.log(`    Stage 1 best: act=${best1.s1act}, dist=${best1.s1dist}  (score ${best1.score.toFixed(1)})`);
console.log(`    Stage 2 best: act=${best2.s2act}, dist=${best2.s2dist}  (score ${best2.score.toFixed(1)})`);
console.log(`    Stage 3 best: act=${best3.s3act}, dist=${best3.s3dist}  (score ${best3.score.toFixed(1)})`);

console.log("\nDone.");
