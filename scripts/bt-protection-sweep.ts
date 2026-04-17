/**
 * GARCH v2 Protection Strategy Sweep
 * Tests non-round trailing levels, breakeven stops, stepped trails, and time-based protection.
 * GARCH v2 only (Engine C), $9 margin, z=4.5/3.0, SL 3%, TP 7%, 72h max hold, max 7 positions.
 * BTC 4h EMA(12/21) filter for longs.
 * 5m bar precision for SL/trail/protection checks.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-protection-sweep.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MIN_5 = 5 * 60_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const GARCH_SIZE = 9;
const MAX_POS = 7;
const GARCH_SL_PCT = 0.03;
const GARCH_TP_PCT = 0.07;
const GARCH_MAX_HOLD_H = 72;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT",
  "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL", "ZEC", "AVAX",
  "NEAR", "SUI", "FET",
];

// --------------- data loading ---------------
function loadJson(pair: string): C[] {
  const fp = path.join(CD_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw
    .map((b: any) =>
      Array.isArray(b)
        ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
        : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
    )
    .sort((a: C, b: C) => a.t - b.t);
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
      t: ts, o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// --------------- indicators ---------------
function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
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
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
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
      const r = cs[j].c / cs[j - 1].c - 1;
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

// --------------- cost helpers ---------------
function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function applyEntryPx(pair: string, dir: "long" | "short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function applyExitPx(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long" | "short", ep: number, xp: number, notional: number): number {
  return (dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional) - notional * FEE * 2;
}

// --------------- load data ---------------
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(p);
  if (d.length > 0) raw5m.set(p, d);
}

const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// BTC 4h EMA(12/21) filter
const btcH4 = h4Data.get("BTC")!;
const btcH4Closes = btcH4.map(c => c.c);
const btcH4Ema12 = calcEMA(btcH4Closes, 12);
const btcH4Ema21 = calcEMA(btcH4Closes, 21);

function btcBullish(t: number): boolean {
  let lo = 0, hi = btcH4.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btcH4[mid].t < t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0) return false;
  return btcH4Ema12[idx] > btcH4Ema21[idx];
}

// BTC h1 for GARCH BTC trend filter
const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));

function btcH1Trend(t: number): "long" | "short" | null {
  const bucket = Math.floor(t / H) * H;
  const idx = btcH1TsMap.get(bucket);
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  if (btcH1Ema9[prev] > btcH1Ema21[prev]) return "long";
  if (btcH1Ema9[prev] < btcH1Ema21[prev]) return "short";
  return null;
}

// Per-pair indicators
interface PairInd {
  h1: C[];
  h1Z: number[];
  h1Ema9: number[];
  h1Ema21: number[];
  h1TsMap: Map<number, number>;
  h4Z: number[];
  h4TsMap: Map<number, number>;
  bars5m: C[];
  bars5mTsMap: Map<number, number>;
}

const pairInd = new Map<string, PairInd>();
for (const pair of PAIRS) {
  const h1 = h1Data.get(pair) ?? [];
  const h1Z = computeZScores(h1, 3, 20);
  const h1Closes = h1.map(c => c.c);
  const h1Ema9 = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));

  const h4 = h4Data.get(pair) ?? [];
  const h4Z = computeZScores(h4, 3, 20);
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));

  const bars5m = raw5m.get(pair) ?? [];
  const bars5mTsMap = new Map<number, number>();
  bars5m.forEach((c, i) => bars5mTsMap.set(c.t, i));

  pairInd.set(pair, { h1, h1Z, h1Ema9, h1Ema21, h1TsMap, h4Z, h4TsMap, bars5m, bars5mTsMap });
}

console.log("Data loaded.\n");

// --------------- GARCH v2 signal ---------------
interface SignalResult {
  dir: "long" | "short";
  entryPrice: number;
  sl: number;
}

function checkGarchV2(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;

  const i = barIdx;
  const prev = i - 1;
  if (prev < 23) return null;

  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong = z1 > 4.5;
  const goShort = z1 < -3.0;
  if (!goLong && !goShort) return null;

  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong && z4 <= 3.0) return null;
  if (goShort && z4 >= -3.0) return null;

  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;

  const btcT = btcH1Trend(h1[prev].t);
  if (goLong && btcT !== "long") return null;
  if (goShort && btcT !== "short") return null;

  const dir: "long" | "short" = goLong ? "long" : "short";
  const ep = h1[i].o;
  let sl = dir === "long" ? ep * (1 - GARCH_SL_PCT) : ep * (1 + GARCH_SL_PCT);
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);

  return { dir, entryPrice: ep, sl };
}

// --------------- protection config types ---------------

// Group 1 + 2: Standard trailing (activation/distance, both in leveraged %)
interface TrailConfig {
  type: "trail";
  activation: number;   // leveraged % to activate
  distance: number;     // leveraged % distance from peak to trigger exit
}

// Group 3: Breakeven stepped (move SL to lock in profit)
// Each step: { triggerPct: leveraged %, lockPct: leveraged % to lock in }
// lockPct=0 means move to entry (breakeven), positive means lock profit
interface BreakevenConfig {
  type: "breakeven";
  steps: { triggerPct: number; lockPct: number }[];
}

// Group 4: Stepped trail (multiple activation levels, trail tightens)
interface SteppedTrailConfig {
  type: "stepped";
  // Steps: sorted by activationPct ascending. Once peak crosses each, trail tightens.
  steps: { activationPct: number; distancePct: number }[];
}

// Group 5: Time-based protection
interface TimeProtectConfig {
  type: "time";
  // After X hours in profit, activate trail at current - offsetPct
  // Each entry: { afterHours, offsetPct }
  triggers: { afterHours: number; offsetPct: number }[];
}

type ProtectionConfig = TrailConfig | BreakevenConfig | SteppedTrailConfig | TimeProtectConfig;

interface RunConfig {
  label: string;
  group: string;
  protection: ProtectionConfig;
}

// --------------- position state ---------------
interface Position {
  pair: string;
  dir: "long" | "short";
  entryPrice: number;  // raw (before spread)
  effectiveEP: number; // with spread applied
  sl: number;
  entryTime: number;
  peakPnlPct: number;  // leveraged %
  // Breakeven: track which steps already applied
  beStepsApplied: Set<number>;
  // Stepped trail: current distance (starts at first step's distance once activated)
  steppedTrailDistance: number;
  steppedTrailActive: boolean;
  // Time-based: track which time triggers applied
  timeTriggerApplied: Set<number>;
  timeTrailFloor: number | null;  // leveraged % floor once activated (current - offset)
  // Used to track hours in profit
  firstProfitTime: number | null;
}

interface ClosedTrade {
  pair: string;
  dir: "long" | "short";
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
}

// --------------- simulation ---------------
function get5mBar(pair: string, t: number): C | null {
  const ind = pairInd.get(pair);
  if (!ind) return null;
  const bucket = Math.floor(t / MIN_5) * MIN_5;
  const idx = ind.bars5mTsMap.get(bucket);
  if (idx === undefined) return null;
  return ind.bars5m[idx];
}

function applyProtection(pos: Position, bar: C, cfg: ProtectionConfig, t: number): { exit: boolean; reason: string } {
  const currPct = pos.dir === "long"
    ? (bar.c / pos.entryPrice - 1) * LEV * 100
    : (pos.entryPrice / bar.c - 1) * LEV * 100;

  const bestPct = pos.dir === "long"
    ? (bar.h / pos.entryPrice - 1) * LEV * 100
    : (pos.entryPrice / bar.l - 1) * LEV * 100;

  if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

  if (cfg.type === "trail") {
    if (cfg.activation > 0 && pos.peakPnlPct >= cfg.activation) {
      if (currPct <= pos.peakPnlPct - cfg.distance) {
        return { exit: true, reason: "trail" };
      }
    }
  } else if (cfg.type === "breakeven") {
    // Check all unapplied steps (highest first to be conservative in step application)
    for (const step of cfg.steps) {
      if (pos.beStepsApplied.has(step.triggerPct)) continue;
      if (pos.peakPnlPct >= step.triggerPct) {
        // Compute new SL: lock in lockPct of leveraged profit from entry
        // lockPct=0 -> breakeven (SL = entry), lockPct=10 -> SL at +10% lev = +1% price move for longs
        const priceLockPct = step.lockPct / LEV / 100;
        let newSl: number;
        if (pos.dir === "long") {
          newSl = pos.entryPrice * (1 + priceLockPct);
          if (newSl > pos.sl) pos.sl = newSl;  // only move SL up
        } else {
          newSl = pos.entryPrice * (1 - priceLockPct);
          if (newSl < pos.sl) pos.sl = newSl;  // only move SL down (closer for shorts)
        }
        pos.beStepsApplied.add(step.triggerPct);
      }
    }
    // No immediate exit from breakeven - SL exit is handled by the main SL check
  } else if (cfg.type === "stepped") {
    // Find the current active step (highest activation reached)
    let activeDistance = 0;
    let anyActive = false;
    for (const step of cfg.steps) {
      if (pos.peakPnlPct >= step.activationPct) {
        activeDistance = step.distancePct;
        anyActive = true;
      }
    }
    if (anyActive) {
      pos.steppedTrailActive = true;
      pos.steppedTrailDistance = activeDistance;
    }
    if (pos.steppedTrailActive && activeDistance > 0) {
      if (currPct <= pos.peakPnlPct - pos.steppedTrailDistance) {
        return { exit: true, reason: "stepped-trail" };
      }
    }
  } else if (cfg.type === "time") {
    // Track first profitable 5m bar
    if (currPct > 0 && pos.firstProfitTime === null) {
      pos.firstProfitTime = t;
    }

    if (pos.firstProfitTime !== null) {
      const hoursInProfit = (t - pos.firstProfitTime) / H;
      for (const trigger of cfg.triggers) {
        if (pos.timeTriggerApplied.has(trigger.afterHours)) continue;
        if (hoursInProfit >= trigger.afterHours && currPct > 0) {
          // Activate trail: floor = currPct - offsetPct
          const floor = currPct - trigger.offsetPct;
          if (pos.timeTrailFloor === null || floor > pos.timeTrailFloor) {
            pos.timeTrailFloor = floor;
          }
          pos.timeTriggerApplied.add(trigger.afterHours);
        }
      }
    }

    if (pos.timeTrailFloor !== null && currPct <= pos.timeTrailFloor) {
      return { exit: true, reason: "time-trail" };
    }
    // Update floor if we've moved higher (trail upward)
    if (pos.timeTrailFloor !== null && pos.timeTriggerApplied.size > 0) {
      // Use tightest offset from applied triggers
      let tightestOffset = Infinity;
      for (const trigger of cfg.triggers) {
        if (pos.timeTriggerApplied.has(trigger.afterHours)) {
          tightestOffset = Math.min(tightestOffset, trigger.offsetPct);
        }
      }
      const newFloor = currPct - tightestOffset;
      if (newFloor > pos.timeTrailFloor) pos.timeTrailFloor = newFloor;
    }
  }

  return { exit: false, reason: "" };
}

function runSim(cfg: ProtectionConfig, startTs: number, endTs: number): ClosedTrade[] {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];

  const simStart = Math.max(startTs, FULL_START);
  const simEnd = Math.min(endTs, FULL_END);

  function closePos(idx: number, exitTime: number, rawExitPrice: number, reason: string, isSL: boolean): void {
    const pos = openPositions[idx];
    const notional = GARCH_SIZE * LEV;
    const xp = applyExitPx(pos.pair, pos.dir, rawExitPrice, isSL);
    const pnl = calcPnl(pos.dir, pos.effectiveEP, xp, notional);
    closedTrades.push({ pair: pos.pair, dir: pos.dir, entryTime: pos.entryTime, exitTime, pnl, reason });
    openPositions.splice(idx, 1);
  }

  function is1hBoundary(t: number): boolean { return t % H === 0; }

  for (let t = simStart; t < simEnd; t += MIN_5) {
    // 1) SL, TP, protection checks on all open positions
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const bar = get5mBar(pos.pair, t);
      if (!bar) continue;

      // SL check
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }

      // TP 7%
      const tp = pos.dir === "long" ? pos.entryPrice * (1 + GARCH_TP_PCT) : pos.entryPrice * (1 - GARCH_TP_PCT);
      if (pos.dir === "long" && bar.h >= tp) {
        closePos(pi, t, tp, "tp", false);
        continue;
      }
      if (pos.dir === "short" && bar.l <= tp) {
        closePos(pi, t, tp, "tp", false);
        continue;
      }

      // Max hold 72h
      if ((t - pos.entryTime) / H >= GARCH_MAX_HOLD_H) {
        closePos(pi, t, bar.c, "mh", false);
        continue;
      }

      // Protection logic
      const result = applyProtection(pos, bar, cfg, t);
      if (result.exit) {
        closePos(pi, t, bar.c, result.reason, false);
        continue;
      }

      // If breakeven moved SL past bar.l, we would have been stopped — check again after SL update
      if (cfg.type === "breakeven") {
        if (pos.dir === "long" && bar.l <= pos.sl) {
          closePos(pi, t, pos.sl, "be-sl", true);
          continue;
        }
        if (pos.dir === "short" && bar.h >= pos.sl) {
          closePos(pi, t, pos.sl, "be-sl", true);
          continue;
        }
      }
    }

    // 2) GARCH entries at 1h boundaries
    if (is1hBoundary(t)) {
      for (const pair of PAIRS) {
        if (openPositions.length >= MAX_POS) break;
        if (openPositions.some(p => p.pair === pair)) continue;

        const sig = checkGarchV2(pair, t);
        if (!sig) continue;

        const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
        openPositions.push({
          pair,
          dir: sig.dir,
          entryPrice: sig.entryPrice,
          effectiveEP: ep,
          sl: sig.sl,
          entryTime: t,
          peakPnlPct: 0,
          beStepsApplied: new Set(),
          steppedTrailDistance: 0,
          steppedTrailActive: false,
          timeTriggerApplied: new Set(),
          timeTrailFloor: null,
          firstProfitTime: null,
        });
      }
    }
  }

  // Close remaining
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const bars = pairInd.get(pos.pair)?.bars5m ?? [];
    if (bars.length > 0) {
      const lastBar = bars[bars.length - 1];
      closePos(pi, simEnd, lastBar.c, "eop", false);
    }
  }

  return closedTrades;
}

// --------------- metrics ---------------
function computeMetrics(trades: ClosedTrade[], startTs: number, endTs: number) {
  const days = (endTs - startTs) / D;
  if (trades.length === 0) return { trades: 0, perDay: 0, pf: 0, sharpe: 0, maxDD: 0, wr: 0, total: 0, trailExits: 0 };

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.exitTime / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const protExits = ["trail", "stepped-trail", "time-trail", "be-sl"];
  const trailExits = trades.filter(t => protExits.includes(t.reason)).length;

  return {
    trades: trades.length,
    wr: (wins.length / trades.length) * 100,
    pf: gl > 0 ? gp / gl : 99,
    total,
    perDay: total / days,
    maxDD,
    sharpe,
    trailExits,
  };
}

// --------------- configs ---------------
const CONFIGS: RunConfig[] = [
  // Baselines
  {
    label: "Baseline (no prot)",
    group: "BL",
    protection: { type: "trail", activation: 0, distance: 0 },
  },
  {
    label: "30/3 (current live)",
    group: "BL",
    protection: { type: "trail", activation: 30, distance: 3 },
  },
  {
    label: "40/3 (prev live)",
    group: "BL",
    protection: { type: "trail", activation: 40, distance: 3 },
  },

  // GROUP 1: Non-round trail activations
  {
    label: "17/3",
    group: "G1",
    protection: { type: "trail", activation: 17, distance: 3 },
  },
  {
    label: "23/3",
    group: "G1",
    protection: { type: "trail", activation: 23, distance: 3 },
  },
  {
    label: "27/3",
    group: "G1",
    protection: { type: "trail", activation: 27, distance: 3 },
  },
  {
    label: "33/3",
    group: "G1",
    protection: { type: "trail", activation: 33, distance: 3 },
  },
  {
    label: "37/3",
    group: "G1",
    protection: { type: "trail", activation: 37, distance: 3 },
  },

  // GROUP 2: Different distances at round 30% activation
  {
    label: "30/2",
    group: "G2",
    protection: { type: "trail", activation: 30, distance: 2 },
  },
  {
    label: "30/4",
    group: "G2",
    protection: { type: "trail", activation: 30, distance: 4 },
  },
  {
    label: "30/5",
    group: "G2",
    protection: { type: "trail", activation: 30, distance: 5 },
  },
  {
    label: "25/2",
    group: "G2",
    protection: { type: "trail", activation: 25, distance: 2 },
  },

  // GROUP 3: Breakeven stop
  {
    label: "BE +15->0%",
    group: "G3",
    protection: {
      type: "breakeven",
      steps: [{ triggerPct: 15, lockPct: 0 }],
    },
  },
  {
    label: "BE +20->+10%",
    group: "G3",
    protection: {
      type: "breakeven",
      steps: [{ triggerPct: 20, lockPct: 10 }],
    },
  },
  {
    label: "BE +25->+15%",
    group: "G3",
    protection: {
      type: "breakeven",
      steps: [{ triggerPct: 25, lockPct: 15 }],
    },
  },
  {
    label: "BE ladder",
    group: "G3",
    protection: {
      type: "breakeven",
      steps: [
        { triggerPct: 15, lockPct: 0 },
        { triggerPct: 20, lockPct: 10 },
        { triggerPct: 25, lockPct: 15 },
      ],
    },
  },

  // GROUP 4: Stepped trail
  {
    label: "Stepped 20/5->30/3->40/2",
    group: "G4",
    protection: {
      type: "stepped",
      steps: [
        { activationPct: 20, distancePct: 5 },
        { activationPct: 30, distancePct: 3 },
        { activationPct: 40, distancePct: 2 },
      ],
    },
  },
  {
    label: "Stepped 25/5->35/3->45/2",
    group: "G4",
    protection: {
      type: "stepped",
      steps: [
        { activationPct: 25, distancePct: 5 },
        { activationPct: 35, distancePct: 3 },
        { activationPct: 45, distancePct: 2 },
      ],
    },
  },

  // GROUP 5: Time-based protection
  {
    label: "Time 12h-3%",
    group: "G5",
    protection: {
      type: "time",
      triggers: [{ afterHours: 12, offsetPct: 3 }],
    },
  },
  {
    label: "Time 24h-2%",
    group: "G5",
    protection: {
      type: "time",
      triggers: [{ afterHours: 24, offsetPct: 2 }],
    },
  },
  {
    label: "Time 12h-3% + 24h-2%",
    group: "G5",
    protection: {
      type: "time",
      triggers: [
        { afterHours: 12, offsetPct: 3 },
        { afterHours: 24, offsetPct: 2 },
      ],
    },
  },
];

// --------------- run all configs ---------------
interface Result {
  label: string;
  group: string;
  trades: number;
  tradesPerDay: number;
  perDay: number;
  pf: number;
  sharpe: number;
  maxDD: number;
  wr: number;
  total: number;
  trailExits: number;
  oosPerDay: number;
  oosPf: number;
  oosTrades: number;
}

const results: Result[] = [];

console.log("Running protection sweep...\n");
console.log(`GARCH v2 only: $${GARCH_SIZE} margin, z=4.5/3.0, SL=${GARCH_SL_PCT*100}%, TP=${GARCH_TP_PCT*100}%, ${GARCH_MAX_HOLD_H}h hold, max ${MAX_POS} pos`);
console.log(`BTC filter: 4h EMA(12/21) + 1h EMA(9/21)`);
console.log(`Full period: 2023-01 to 2026-03 | OOS: 2025-09 to 2026-03`);
console.log(`Pairs: ${PAIRS.length} | 5m precision\n`);

const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

let lastPct = -1;
const totalIter = CONFIGS.length;

for (let ci = 0; ci < CONFIGS.length; ci++) {
  const runCfg = CONFIGS[ci];
  process.stdout.write(`[${ci + 1}/${totalIter}] ${runCfg.group} ${runCfg.label}...`);

  const trades = runSim(runCfg.protection, FULL_START, FULL_END);
  const m = computeMetrics(trades, FULL_START, FULL_END);

  const oosTrades = trades.filter(t => t.entryTime >= OOS_START);
  const oom = computeMetrics(oosTrades, OOS_START, FULL_END);

  results.push({
    label: runCfg.label,
    group: runCfg.group,
    trades: m.trades,
    tradesPerDay: m.trades / fullDays,
    perDay: m.perDay,
    pf: m.pf,
    sharpe: m.sharpe,
    maxDD: m.maxDD,
    wr: m.wr,
    total: m.total,
    trailExits: m.trailExits,
    oosPerDay: oom.perDay,
    oosPf: oom.pf,
    oosTrades: oosTrades.length,
  });

  console.log(` trades=${m.trades}, $/day=$${m.perDay.toFixed(2)}, PF=${m.pf.toFixed(2)}, Sharpe=${m.sharpe.toFixed(2)}, MaxDD=$${m.maxDD.toFixed(0)}, OOS=$${oom.perDay.toFixed(2)}/day, prot_exits=${m.trailExits}`);
}

// --------------- output table ---------------
const SEP = "=".repeat(145);
const sep = "-".repeat(145);

console.log("\n" + SEP);
console.log("GARCH v2 PROTECTION SWEEP RESULTS");
console.log(`GARCH $${GARCH_SIZE} | z=4.5/3.0 | SL 3% | TP 7% | 72h | max ${MAX_POS} | BTC 4h+1h EMA filter | 5m precision`);
console.log(SEP);

const header = [
  "Group".padEnd(5),
  "Config".padEnd(28),
  "Trades".padStart(7),
  "T/day".padStart(7),
  "WR%".padStart(7),
  "$/day".padStart(9),
  "Total".padStart(10),
  "PF".padStart(7),
  "Sharpe".padStart(8),
  "MaxDD".padStart(9),
  "ProtEx".padStart(8),
  "OOS$/d".padStart(9),
  "OOS PF".padStart(8),
].join(" ");
console.log(header);
console.log(sep);

// Group and sort within each group
const groups = ["BL", "G1", "G2", "G3", "G4", "G5"];
const baseline = results.find(r => r.label === "Baseline (no prot)")!;

for (const grp of groups) {
  const grpResults = results.filter(r => r.group === grp);
  // Sort by OOS $/day within group (most predictive of live performance)
  grpResults.sort((a, b) => b.oosPerDay - a.oosPerDay);

  for (const r of grpResults) {
    const ddMark = r.maxDD < baseline.maxDD * 0.85 ? " <DD" : "";
    const profMark = r.oosPerDay > baseline.oosPerDay * 1.1 ? " +OOS" : "";
    const mark = ddMark + profMark;
    console.log([
      r.group.padEnd(5),
      r.label.padEnd(28),
      String(r.trades).padStart(7),
      r.tradesPerDay.toFixed(2).padStart(7),
      r.wr.toFixed(1).padStart(6) + "%",
      ("$" + r.perDay.toFixed(2)).padStart(9),
      ("$" + r.total.toFixed(0)).padStart(10),
      r.pf.toFixed(2).padStart(7),
      r.sharpe.toFixed(2).padStart(8),
      ("$" + r.maxDD.toFixed(0)).padStart(9),
      String(r.trailExits).padStart(8),
      ("$" + r.oosPerDay.toFixed(2)).padStart(9),
      r.oosPf.toFixed(2).padStart(8),
    ].join(" ") + mark);
  }
  if (grp !== "G5") console.log(sep);
}

console.log(SEP);

// --------------- summary tables ---------------
console.log("\n--- TOP 5 BY OOS $/DAY (most predictive) ---");
const byOos = [...results].sort((a, b) => b.oosPerDay - a.oosPerDay);
for (let i = 0; i < Math.min(5, byOos.length); i++) {
  const r = byOos[i];
  const vsBase = r.oosPerDay - baseline.oosPerDay;
  console.log(`  ${i + 1}. [${r.group}] ${r.label}: OOS $${r.oosPerDay.toFixed(2)}/day (${vsBase >= 0 ? "+" : ""}${vsBase.toFixed(2)} vs baseline), MaxDD $${r.maxDD.toFixed(0)}, PF ${r.pf.toFixed(2)}`);
}

console.log("\n--- TOP 5 BY LOWEST MaxDD ---");
const byDD = [...results].sort((a, b) => a.maxDD - b.maxDD);
for (let i = 0; i < Math.min(5, byDD.length); i++) {
  const r = byDD[i];
  const ddRed = ((baseline.maxDD - r.maxDD) / baseline.maxDD * 100);
  console.log(`  ${i + 1}. [${r.group}] ${r.label}: MaxDD $${r.maxDD.toFixed(0)} (${ddRed.toFixed(0)}% less), $${r.perDay.toFixed(2)}/day, OOS $${r.oosPerDay.toFixed(2)}/day`);
}

console.log("\n--- TOP 5 BY RISK-ADJUSTED (OOS$/day * Sharpe / MaxDD) ---");
const byRisk = [...results]
  .filter(r => r.maxDD > 0 && r.sharpe > 0)
  .sort((a, b) => (b.oosPerDay * b.sharpe / b.maxDD) - (a.oosPerDay * a.sharpe / a.maxDD));
for (let i = 0; i < Math.min(5, byRisk.length); i++) {
  const r = byRisk[i];
  const score = r.oosPerDay * r.sharpe / r.maxDD;
  console.log(`  ${i + 1}. [${r.group}] ${r.label}: score ${score.toFixed(4)}, $${r.perDay.toFixed(2)}/day, Sharpe ${r.sharpe.toFixed(2)}, MaxDD $${r.maxDD.toFixed(0)}`);
}

// --------------- group winner summary ---------------
console.log("\n--- BEST PER GROUP (by OOS $/day) ---");
for (const grp of groups) {
  const grpResults = results.filter(r => r.group === grp);
  if (grpResults.length === 0) continue;
  const best = grpResults.reduce((a, b) => a.oosPerDay > b.oosPerDay ? a : b);
  const vsBase = best.oosPerDay - baseline.oosPerDay;
  const ddChange = ((baseline.maxDD - best.maxDD) / baseline.maxDD * 100);
  console.log(`  ${grp}: ${best.label} | OOS $${best.oosPerDay.toFixed(2)}/day (${vsBase >= 0 ? "+" : ""}${vsBase.toFixed(2)}) | MaxDD $${best.maxDD.toFixed(0)} (${ddChange >= 0 ? "-" : "+"}${Math.abs(ddChange).toFixed(0)}%) | PF ${best.pf.toFixed(2)} | Sharpe ${best.sharpe.toFixed(2)}`);
}

console.log("\nDone.");
