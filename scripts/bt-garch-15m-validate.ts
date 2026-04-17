/**
 * GARCH 15m Independent Replication
 * Claim: GARCH z-score momentum on 15m bars outperforms 1h variant.
 * z_15m > 4.5 AND z_4h > 3.0 for longs; z_15m < -3.0 AND z_4h < -3.0 for shorts.
 * Architecture: event-driven chronological sim on 5m bars stepped to 15m resolution.
 * Entry at NEXT 15m bar open after signal (anti-look-ahead).
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-garch-15m-validate.ts
 */

import * as fs from "fs";
import * as path from "path";

// --------------- types ---------------
interface C { t: number; o: number; h: number; l: number; c: number; }

// --------------- constants ---------------
const CD_5M = "/tmp/bt-pair-cache-5m";

const MIN_5  = 300_000;
const MIN_15 = 900_000;
const H      = 3_600_000;
const H4     = 4 * H;
const D      = 86_400_000;
const MIN_1  = 60_000;

const FEE     = 0.000_35;
const SL_SLIP = 1.5;
const LEV     = 10;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// Engine parameters (claim to test)
const SL_PCT    = 0.02;   // 2%
const TP_PCT    = 0.05;   // 5%
const MAX_HOLD  = 48 * H; // 48h
const MARGIN    = 9;      // $9
const MAX_POS   = 7;

// Trail parameters
const TRAIL_ACT  = 40;    // activate at +40% leveraged PnL
const TRAIL_DIST = 3;     // trail 3% from peak

// z-score thresholds
const Z15_LONG  =  4.5;
const Z15_SHORT = -3.0;
const Z4H_LONG  =  3.0;
const Z4H_SHORT = -3.0;

// half-spreads (taker)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX",
  "NEAR","SUI","FET",
];

// --------------- data loading ---------------
function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
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

// Aggregate 5m bars into a larger period. Only emit complete buckets.
function aggregate(bars: C[], periodMs: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(bucket);
    if (!arr) { arr = []; groups.set(bucket, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  const barsPerPeriod = Math.round(periodMs / MIN_5);
  for (const [ts, grp] of groups) {
    // require at least 70% fill to count as complete
    if (grp.length < Math.ceil(barsPerPeriod * 0.7)) continue;
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

// --------------- indicators ---------------
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

// z-score: momentum = close[i] / close[i-momLb] - 1, vol = std of 20 returns
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

// --------------- load & aggregate data ---------------
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

console.log("Aggregating timeframes...");
interface PairData {
  m15: C[];
  m15Z: number[];
  m15Ema9: number[];
  m15Ema21: number[];
  m15TsMap: Map<number, number>;

  h4: C[];
  h4Z: number[];
  h4TsMap: Map<number, number>;

  // 5m bars used for tick-level SL/TP/trail checks
  m5: C[];
}

const pairData = new Map<string, PairData>();

for (const pair of PAIRS) {
  const raw = raw5m.get(pair);
  if (!raw || raw.length === 0) continue;

  const m15 = aggregate(raw, MIN_15);
  const m15Closes = m15.map(c => c.c);
  // z-score: momentum lookback 3 bars (45 min), vol window 20 bars
  const m15Z = computeZScores(m15, 3, 20);
  const m15Ema9  = calcEMA(m15Closes, 9);
  const m15Ema21 = calcEMA(m15Closes, 21);
  const m15TsMap = new Map<number, number>();
  m15.forEach((c, i) => m15TsMap.set(c.t, i));

  const h4 = aggregate(raw, H4);
  const h4Closes = h4.map(c => c.c);
  // z-score: momentum lookback 3 bars (12h), vol window 20 bars
  const h4Z = computeZScores(h4, 3, 20);
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));

  pairData.set(pair, {
    m15, m15Z, m15Ema9, m15Ema21, m15TsMap,
    h4, h4Z, h4TsMap,
    m5: raw,
  });
}

// --------------- BTC 4h EMA filter ---------------
const btcRaw = raw5m.get("BTC")!;
const btcH4  = aggregate(btcRaw, H4);
const btcH4Closes = btcH4.map(c => c.c);
const btcH4Ema12 = calcEMA(btcH4Closes, 12);
const btcH4Ema21 = calcEMA(btcH4Closes, 21);
const btcH4TsMap = new Map<number, number>();
btcH4.forEach((c, i) => btcH4TsMap.set(c.t, i));

// Return bullish/bearish status of BTC at time t (uses last COMPLETED 4h bar before t)
function btcBullishAt(t: number): boolean {
  const bucket = Math.floor(t / H4) * H4;
  // Use bar whose ts < t (i.e., the bar that OPENED before t)
  // Actually we want the last completed bar's index
  const idx = btcH4TsMap.get(bucket);
  if (idx === undefined || idx < 1) return false;
  // bar at idx opened at `bucket`; it's complete only if t > bucket + H4
  // For signal check at 15m boundary: use prev bar (idx-1) to be conservative
  const prev = idx - 1;
  return btcH4Ema12[prev] > btcH4Ema21[prev];
}

console.log("Indicators computed.\n");

// --------------- signal check ---------------
interface Signal {
  pair: string;
  dir: "long" | "short";
  entryPrice: number; // open of the NEXT 15m bar (anti-look-ahead)
  sl: number;
}

// Check for GARCH 15m signal at bar boundary t.
// t = open time of the CURRENT 15m bar (just opened).
// We look at the PREVIOUS completed bar (i-1) for z-scores.
// Entry price = open of current bar (i) = anti-look-ahead.
function checkSignal(pair: string, t: number): Signal | null {
  const pd = pairData.get(pair);
  if (!pd) return null;

  const m15 = pd.m15;
  if (m15.length < 30) return null;

  // Current bar bucket
  const bucket = Math.floor(t / MIN_15) * MIN_15;
  const barIdx = pd.m15TsMap.get(bucket);
  if (barIdx === undefined || barIdx < 25) return null;

  const i    = barIdx;        // current bar (just opened)
  const prev = i - 1;         // last completed bar

  // 15m z-score on last completed bar
  const z15 = pd.m15Z[prev];
  if (!z15 || z15 === 0) return null;

  const goLong  = z15 >  Z15_LONG;
  const goShort = z15 <  Z15_SHORT;
  if (!goLong && !goShort) return null;

  // 4h z-score confirmation: use the 4h bar that CONTAINS the prev 15m bar
  const h4Bucket = Math.floor(m15[prev].t / H4) * H4;
  const h4Idx = pd.h4TsMap.get(h4Bucket);
  if (h4Idx === undefined || h4Idx < 23) return null;
  // Use the bar at h4Idx (the bar that opened at h4Bucket, same period as prev)
  // To be conservative use h4Idx - 1 (fully closed 4h bar)
  const h4Prev = h4Idx > 0 ? h4Idx - 1 : 0;
  const z4 = pd.h4Z[h4Prev];
  if (goLong  && z4 <= Z4H_LONG)  return null;
  if (goShort && z4 >= Z4H_SHORT) return null;

  // EMA(9/21) on 15m: use prev bar values
  if (pd.m15Ema9[prev] === 0 || pd.m15Ema21[prev] === 0) return null;
  if (goLong  && pd.m15Ema9[prev] <= pd.m15Ema21[prev]) return null;
  if (goShort && pd.m15Ema9[prev] >= pd.m15Ema21[prev]) return null;

  // BTC 4h EMA(12/21): longs only
  if (goLong && !btcBullishAt(m15[prev].t)) return null;

  const dir: "long" | "short" = goLong ? "long" : "short";

  // Entry = open of the CURRENT bar (already opened, anti-look-ahead)
  const ep = m15[i].o;
  const sl = dir === "long" ? ep * (1 - SL_PCT) : ep * (1 + SL_PCT);

  return { pair, dir, entryPrice: ep, sl };
}

// Re-entry: z-scores and EMAs must still be in the same direction
function checkReentry(pair: string, t: number, wantDir: "long" | "short"): Signal | null {
  const sig = checkSignal(pair, t);
  if (!sig) return null;
  if (sig.dir !== wantDir) return null;
  return sig;
}

// --------------- position types ---------------
interface Position {
  pair: string;
  dir: "long" | "short";
  effectiveEP: number;   // after spread
  rawEP: number;
  sl: number;
  entryTime: number;
  peakPnlPct: number;
  isReentry: boolean;
}

interface ClosedTrade {
  pair: string;
  dir: "long" | "short";
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
  isReentry: boolean;
}

interface PendingReentry {
  pair: string;
  dir: "long" | "short";
  checkTime: number;
}

// --------------- helpers for 5m tick walk ---------------
// Binary search: find 5m bar at exact timestamp
function find5mBar(bars: C[], t: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t === t) return mid;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// --------------- simulation ---------------
function runSim(startTs: number, endTs: number, doReentry: boolean): {
  trades: ClosedTrade[];
  reentryCount: number;
  blockedCount: number;
} {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0;
  let blockedCount = 0;

  function hasOpen(pair: string): boolean {
    return openPositions.some(p => p.pair === pair);
  }

  function closePos(idx: number, exitTime: number, rawExitPrice: number, reason: string, isSL: boolean): void {
    const pos = openPositions[idx];
    const notional = MARGIN * LEV;
    const xp = applyExitPx(pos.pair, pos.dir, rawExitPrice, isSL);
    const pnl = calcPnl(pos.dir, pos.effectiveEP, xp, notional);
    closedTrades.push({
      pair: pos.pair, dir: pos.dir,
      entryTime: pos.entryTime, exitTime,
      pnl, reason, isReentry: pos.isReentry,
    });

    // Schedule re-entry at next 15m boundary after trail exit
    if (reason === "trail" && doReentry) {
      const nextCheck = (Math.floor(exitTime / MIN_15) + 1) * MIN_15;
      pendingReentries.push({ pair: pos.pair, dir: pos.dir, checkTime: nextCheck });
    }

    openPositions.splice(idx, 1);
  }

  function tryOpen(sig: Signal, t: number, isReentry: boolean): boolean {
    if (openPositions.length >= MAX_POS) { blockedCount++; return false; }
    if (hasOpen(sig.pair)) { blockedCount++; return false; }
    const ep = applyEntryPx(sig.pair, sig.dir, sig.entryPrice);
    openPositions.push({
      pair: sig.pair, dir: sig.dir,
      effectiveEP: ep, rawEP: sig.entryPrice, sl: sig.sl,
      entryTime: t, peakPnlPct: 0, isReentry,
    });
    if (isReentry) reentryCount++;
    return true;
  }

  const simStart = Math.max(startTs, FULL_START);
  const simEnd   = Math.min(endTs,   FULL_END);
  let lastPct = -1;

  // Step at 5m resolution (5m bars are the finest granularity available)
  for (let t = simStart; t < simEnd; t += MIN_5) {
    const pct = Math.floor(((t - simStart) / (simEnd - simStart)) * 20) * 5;
    if (pct > lastPct) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }

    // --- 1) SL / TP / Trail / MaxHold on every 5m bar ---
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const pd = pairData.get(pos.pair);
      if (!pd) continue;
      const barIdx = find5mBar(pd.m5, t);
      if (barIdx < 0) continue;
      const bar = pd.m5[barIdx];

      // SL
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }

      // TP 5%
      const tp = pos.dir === "long" ? pos.rawEP * (1 + TP_PCT) : pos.rawEP * (1 - TP_PCT);
      if (pos.dir === "long"  && bar.h >= tp) { closePos(pi, t, tp, "tp", false); continue; }
      if (pos.dir === "short" && bar.l <= tp) { closePos(pi, t, tp, "tp", false); continue; }

      // Max hold 48h
      if (t - pos.entryTime >= MAX_HOLD) { closePos(pi, t, bar.c, "mh", false); continue; }

      // Peak tracking (leveraged %)
      const bestPct = pos.dir === "long"
        ? (bar.h / pos.rawEP - 1) * LEV * 100
        : (pos.rawEP / bar.l - 1) * LEV * 100;
      if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

      // Trail: activate at TRAIL_ACT%, trail TRAIL_DIST% from peak
      if (pos.peakPnlPct >= TRAIL_ACT) {
        const currPct = pos.dir === "long"
          ? (bar.c / pos.rawEP - 1) * LEV * 100
          : (pos.rawEP / bar.c - 1) * LEV * 100;
        if (currPct <= pos.peakPnlPct - TRAIL_DIST) {
          closePos(pi, t, bar.c, "trail", false);
          continue;
        }
      }
    }

    // --- 2) New entries at 15m boundaries ---
    if (t % MIN_15 === 0) {
      for (const pair of PAIRS) {
        const sig = checkSignal(pair, t);
        if (sig) tryOpen(sig, t, false);
      }
    }

    // --- 3) Re-entries at 15m boundaries ---
    if (doReentry && t % MIN_15 === 0 && pendingReentries.length > 0) {
      for (let ri = pendingReentries.length - 1; ri >= 0; ri--) {
        const re = pendingReentries[ri];
        if (t < re.checkTime) continue;
        pendingReentries.splice(ri, 1);
        const sig = checkReentry(re.pair, t, re.dir);
        if (sig) tryOpen(sig, t, true);
      }
    }
  }

  // Close remaining positions at end of period
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const pd = pairData.get(pos.pair);
    if (!pd || pd.m5.length === 0) continue;
    const lastBar = pd.m5[pd.m5.length - 1];
    closePos(pi, simEnd, lastBar.c, "eop", false);
  }

  return { trades: closedTrades, reentryCount, blockedCount };
}

// --------------- metrics ---------------
interface Metrics {
  trades: number;
  wr: number;
  pf: number;
  total: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
  trailExits: number;
  tpExits: number;
  slExits: number;
  mhExits: number;
}

function computeMetrics(trades: ClosedTrade[], startTs: number, endTs: number): Metrics {
  const days = (endTs - startTs) / D;
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  // MaxDD on chronological cumulative equity
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Daily Sharpe
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.exitTime / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std  = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return {
    trades: trades.length,
    wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    pf: gl > 0 ? gp / gl : 99,
    total,
    perDay: total / days,
    maxDD,
    sharpe,
    trailExits: trades.filter(t => t.reason === "trail").length,
    tpExits:    trades.filter(t => t.reason === "tp").length,
    slExits:    trades.filter(t => t.reason === "sl").length,
    mhExits:    trades.filter(t => t.reason === "mh").length,
  };
}

// --------------- run ---------------
console.log("Running simulation...\n");

const FULL_DAYS = (FULL_END - FULL_START) / D;
const OOS_DAYS  = (FULL_END - OOS_START)  / D;

// Run with trail+reentry (the claimed configuration)
process.stdout.write("TRAIL 40/3 + RE-ENTRY...");
const result = runSim(FULL_START, FULL_END, true);
console.log();

const fullMetrics = computeMetrics(result.trades, FULL_START, FULL_END);
const oosTrades   = result.trades.filter(t => t.entryTime >= OOS_START);
const oosMetrics  = computeMetrics(oosTrades, OOS_START, FULL_END);

// Also run without trail for baseline
process.stdout.write("NO TRAIL (baseline)...");
const baseResult = runSim(FULL_START, FULL_END, false);
console.log();

const baseMetrics    = computeMetrics(baseResult.trades, FULL_START, FULL_END);
const baseOosTrades  = baseResult.trades.filter(t => t.entryTime >= OOS_START);
const baseOosMetrics = computeMetrics(baseOosTrades, OOS_START, FULL_END);

// Per-pair breakdown (full period, with trail)
const pairStats = new Map<string, { wins: number; losses: number; pnl: number; trades: number }>();
for (const t of result.trades) {
  const s = pairStats.get(t.pair) ?? { wins: 0, losses: 0, pnl: 0, trades: 0 };
  s.trades++;
  s.pnl += t.pnl;
  if (t.pnl > 0) s.wins++;
  else s.losses++;
  pairStats.set(t.pair, s);
}

// Trades per day stat
const tradeDays = new Set(result.trades.map(t => Math.floor(t.entryTime / D)));
const tradesPerDay = result.trades.length / FULL_DAYS;

// --------------- print results ---------------
const sep = "=".repeat(100);
console.log(`\n${sep}`);
console.log("GARCH 15m INDEPENDENT REPLICATION");
console.log("Claim: z_15m > 4.5 AND z_4h > 3.0 (long) | z_15m < -3.0 AND z_4h < -3.0 (short)");
console.log(`SL ${SL_PCT * 100}% | TP ${TP_PCT * 100}% | MaxHold ${MAX_HOLD / H}h | $${MARGIN} margin | Max ${MAX_POS} pos | Trail ${TRAIL_ACT}/${TRAIL_DIST}`);
console.log("23 pairs | 5m bars aggregated to 15m/4h | Full: 2023-01 to 2026-03 | OOS: 2025-09+");
console.log(sep);

const hdr = [
  "Config".padEnd(20),
  "Trades".padStart(8),
  "Re-ent".padStart(7),
  "WR%".padStart(7),
  "Total".padStart(12),
  "$/day".padStart(10),
  "PF".padStart(7),
  "Sharpe".padStart(8),
  "MaxDD".padStart(10),
  "Blocked".padStart(8),
  "Trail".padStart(6),
  "TP".padStart(5),
  "SL".padStart(5),
  "MH".padStart(5),
  "OOS$/day".padStart(10),
  "OOS PF".padStart(8),
].join(" ");
console.log(`\n${hdr}`);
console.log("-".repeat(140));

function printRow(label: string, m: Metrics, reentries: number, blocked: number, oosM: Metrics): void {
  console.log([
    label.padEnd(20),
    String(m.trades).padStart(8),
    String(reentries).padStart(7),
    m.wr.toFixed(1).padStart(6) + "%",
    ("$" + m.total.toFixed(2)).padStart(12),
    ("$" + m.perDay.toFixed(2)).padStart(10),
    m.pf.toFixed(2).padStart(7),
    m.sharpe.toFixed(2).padStart(8),
    ("$" + m.maxDD.toFixed(0)).padStart(10),
    String(blocked).padStart(8),
    String(m.trailExits).padStart(6),
    String(m.tpExits).padStart(5),
    String(m.slExits).padStart(5),
    String(m.mhExits).padStart(5),
    ("$" + oosM.perDay.toFixed(2)).padStart(10),
    oosM.pf.toFixed(2).padStart(8),
  ].join(" "));
}

printRow("NO TRAIL",       baseMetrics, 0,                     baseResult.blockedCount, baseOosMetrics);
printRow("TRAIL 40/3 + RE", fullMetrics, result.reentryCount,  result.blockedCount,     oosMetrics);

console.log();
console.log(`Trades/day (full period): ${tradesPerDay.toFixed(2)}`);
console.log(`Active trading days: ${tradeDays.size} / ${Math.round(FULL_DAYS)}`);

// Per-pair breakdown
console.log(`\n${"─".repeat(60)}`);
console.log("Per-pair breakdown (Trail 40/3 + RE, full period):");
console.log(`${"─".repeat(60)}`);
const pairRows = [...pairStats.entries()]
  .sort((a, b) => b[1].pnl - a[1].pnl);
for (const [pair, s] of pairRows) {
  const wr = s.trades > 0 ? (s.wins / s.trades * 100).toFixed(0) : "0";
  console.log(
    `  ${pair.padEnd(7)} ${String(s.trades).padStart(4)} trades  WR ${wr.padStart(3)}%  PnL $${s.pnl.toFixed(2).padStart(8)}`
  );
}
