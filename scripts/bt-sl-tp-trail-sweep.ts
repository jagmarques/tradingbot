/**
 * SL / TP / Trailing-Stop / ATR-Period Sweep for Supertrend(14,1.75) engine
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-sl-tp-trail-sweep.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const SL_SLIPPAGE = 1.5;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, AVAX: 2.55e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const WANTED_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-27").getTime();

const MARGIN = 5;
const LEV = 10;

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string; dir: Dir;
  ep: number; et: number; sl: number; tp: number;
  atr: number; bestPnlAtr: number;
}

interface Trade {
  pair: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number;
}

// ─── Trailing ladder config ─────────────────────────────────────────
interface TrailStep {
  triggerAtr: number;   // profit in ATR multiples to activate this step
  trailAtr: number;     // trail distance in ATR (from peak for tight, from price for medium)
  isBreakeven?: boolean; // if true, just move SL to entry (no trail)
}

interface TrailProfile {
  label: string;
  steps: TrailStep[];   // sorted ascending by triggerAtr
}

// ─── Sweep variant config ───────────────────────────────────────────
interface SweepConfig {
  label: string;
  slMult: number;        // ATR multiplier for initial SL
  tpPct: number;         // fixed TP as fraction (0 = no TP)
  trail: TrailProfile;
  atrPeriod: number;     // ATR lookback period
  stAtrPeriod: number;   // Supertrend ATR period (for indicator)
  stMult: number;        // Supertrend multiplier
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(candles: C[], period: number): Bar[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const bars: Bar[] = [];
  for (const [t, cs] of groups) {
    if (cs.length === 0) continue;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of cs) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
      vol += c.v;
    }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c, v: vol });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators ─────────────────────────────────────────────────────
function ema(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  let v = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i === 0) { v = vals[i]; }
    else { v = vals[i] * k + v * (1 - k); }
    if (i >= period - 1) r[i] = v;
  }
  return r;
}

function atrFn(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c)
        );
    trs.push(tr);
  }
  let val = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      val += trs[i];
      if (i === period - 1) { val /= period; r[i] = val; }
    } else {
      val = (val * (period - 1) + trs[i]) / period;
      r[i] = val;
    }
  }
  return r;
}

function supertrend(bars: Bar[], atrPeriod: number, mult: number): { trend: (1 | -1 | null)[] } {
  const atrVals = atrFn(bars, atrPeriod);
  const trend: (1 | -1 | null)[] = new Array(bars.length).fill(null);
  let upperBand = 0, lowerBand = 0, prevTrend = 1;

  for (let i = 0; i < bars.length; i++) {
    const a = atrVals[i];
    if (a === null) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let ub = hl2 + mult * a;
    let lb = hl2 - mult * a;

    if (i > 0 && atrVals[i - 1] !== null) {
      if (lb > lowerBand || bars[i - 1].c < lowerBand) { /* keep lb */ } else lb = lowerBand;
      if (ub < upperBand || bars[i - 1].c > upperBand) { /* keep ub */ } else ub = upperBand;
    }

    let t: 1 | -1;
    if (prevTrend === 1) {
      t = bars[i].c < lowerBand ? -1 : 1;
    } else {
      t = bars[i].c > upperBand ? 1 : -1;
    }

    upperBand = ub;
    lowerBand = lb;
    prevTrend = t;
    trend[i] = t;
  }
  return { trend };
}

// ─── Data Prep ──────────────────────────────────────────────────────
interface PairData {
  m5: C[]; h4: Bar[]; daily: Bar[];
  h4Map: Map<number, number>; dailyMap: Map<number, number>;
}

interface BTCData {
  daily: Bar[]; h1: Bar[];
  dailyEma20: (number | null)[]; dailyEma50: (number | null)[];
  dailyMap: Map<number, number>;
}

function prepBTC(m5: C[]): BTCData {
  const daily = aggregate(m5, DAY);
  const h1 = aggregate(m5, H1);
  const dc = daily.map(b => b.c);
  return {
    daily, h1,
    dailyEma20: ema(dc, 20), dailyEma50: ema(dc, 50),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
  };
}

function prepPair(m5: C[]): PairData {
  const h4 = aggregate(m5, H4);
  const daily = aggregate(m5, DAY);
  return {
    m5, h4, daily,
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
  };
}

function getBarAtOrBefore(bars: Bar[], t: number, barMap: Map<number, number>, period: number): number {
  const aligned = Math.floor(t / period) * period;
  const idx = barMap.get(aligned);
  if (idx !== undefined) return idx;
  for (let dt = period; dt <= 10 * period; dt += period) {
    const idx2 = barMap.get(aligned - dt);
    if (idx2 !== undefined) return idx2;
  }
  return -1;
}

function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Global data ────────────────────────────────────────────────────
let btcData: BTCData;
let available: string[] = [];
let pairDataMap: Map<string, PairData>;

function loadAllData() {
  console.log("Loading data...");
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }
  btcData = prepBTC(btcRaw);

  pairDataMap = new Map();
  available = [];
  for (const p of WANTED_PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 500) continue;
    available.push(p);
    pairDataMap.set(p, prepPair(m5));
  }
  console.log(`Loaded ${available.length} pairs: ${available.join(", ")}`);
}

// ─── BTC filters (from reference) ───────────────────────────────────
function btcBullish(t: number): boolean {
  const di = getBarAtOrBefore(btcData.daily, t - DAY, btcData.dailyMap, DAY);
  if (di < 0) return false;
  const e20 = btcData.dailyEma20[di], e50 = btcData.dailyEma50[di];
  return e20 !== null && e50 !== null && e20 > e50;
}

function btc30dRet(t: number): number {
  const di = getBarAtOrBefore(btcData.daily, t - DAY, btcData.dailyMap, DAY);
  if (di < 0 || di < 30) return 0;
  return btcData.daily[di].c / btcData.daily[di - 30].c - 1;
}

// ─── Supertrend Backtest ────────────────────────────────────────────
function runSupertrend(cfg: SweepConfig): Trade[] {
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];

  // Pre-compute supertrend + ATR per pair
  const stMap = new Map<string, { st: (1 | -1 | null)[]; atr: (number | null)[] }>();
  for (const p of available) {
    const pd = pairDataMap.get(p)!;
    const st = supertrend(pd.h4, cfg.stAtrPeriod, cfg.stMult).trend;
    const atr = atrFn(pd.h4, cfg.atrPeriod);
    stMap.set(p, { st, atr });
  }

  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    dailyTimestamps.push(t);
  }

  function closePosition(key: string, exitPrice: number, exitTime: number, slippageMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sp(pos.pair);
    const xp = pos.dir === "long"
      ? exitPrice * (1 - sp_ * slippageMult)
      : exitPrice * (1 + sp_ * slippageMult);
    const notional = MARGIN * LEV;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const cost = notional * FEE * 2;
    const pnl = raw - cost;
    trades.push({
      pair: pos.pair, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl,
    });
    positions.delete(key);
  }

  for (const dayT of dailyTimestamps) {
    // ─── CHECK EXISTING POSITIONS (on 4h bars within this day) ────
    for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
      const h4T = dayT + h4Offset;

      for (const [key, pos] of [...positions.entries()]) {
        const pd = pairDataMap.get(pos.pair);
        if (!pd) continue;

        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined) continue;
        const bar = pd.h4[h4i];

        // Stop-loss check
        let stopped = false;
        if (pos.dir === "long" && bar.l <= pos.sl) {
          closePosition(key, pos.sl, h4T, SL_SLIPPAGE);
          stopped = true;
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          closePosition(key, pos.sl, h4T, SL_SLIPPAGE);
          stopped = true;
        }
        if (stopped) continue;

        // TP check
        if (pos.tp > 0) {
          if (pos.dir === "long" && bar.h >= pos.tp) {
            closePosition(key, pos.tp, h4T); continue;
          } else if (pos.dir === "short" && bar.l <= pos.tp) {
            closePosition(key, pos.tp, h4T); continue;
          }
        }

        // Max hold (60 days for supertrend)
        if (h4T - pos.et >= 60 * DAY) {
          closePosition(key, bar.c, h4T); continue;
        }

        // Trailing stop ladder
        if (pos.atr > 0 && cfg.trail.steps.length > 0) {
          const unrealPnl = pos.dir === "long"
            ? (bar.c - pos.ep) / pos.atr
            : (pos.ep - bar.c) / pos.atr;
          if (unrealPnl > pos.bestPnlAtr) pos.bestPnlAtr = unrealPnl;

          let newSl = pos.sl;

          // Walk steps from highest trigger to lowest
          for (let si = cfg.trail.steps.length - 1; si >= 0; si--) {
            const step = cfg.trail.steps[si];
            if (pos.bestPnlAtr < step.triggerAtr) continue;

            if (step.isBreakeven) {
              // Move SL to entry
              newSl = pos.dir === "long"
                ? Math.max(pos.sl, pos.ep)
                : Math.min(pos.sl, pos.ep);
            } else {
              // Trail: set SL at (peak - trailAtr * ATR) from the best price implied by bestPnlAtr
              const peakPrice = pos.dir === "long"
                ? pos.ep + pos.bestPnlAtr * pos.atr
                : pos.ep - pos.bestPnlAtr * pos.atr;
              const trailPrice = pos.dir === "long"
                ? peakPrice - step.trailAtr * pos.atr
                : peakPrice + step.trailAtr * pos.atr;
              newSl = pos.dir === "long"
                ? Math.max(pos.sl, trailPrice)
                : Math.min(pos.sl, trailPrice);
            }
            break; // highest matching step wins
          }
          pos.sl = newSl;
        }

        // Supertrend signal-flip exit
        const sm = stMap.get(pos.pair);
        if (sm) {
          const stNow = sm.st[h4i];
          if (stNow !== null) {
            if (pos.dir === "long" && stNow === -1) {
              closePosition(key, bar.c, h4T); continue;
            }
            if (pos.dir === "short" && stNow === 1) {
              closePosition(key, bar.c, h4T); continue;
            }
          }
        }
      }
    }

    // ─── ENTRY: check each 4h bar for supertrend flip ────────────
    for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
      const h4T = dayT + h4Offset;
      for (const p of available) {
        const key = `B:${p}`;
        if (positions.has(key)) continue;

        const pd = pairDataMap.get(p)!;
        const sm = stMap.get(p)!;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined || h4i < 21) continue;

        const stNow = sm.st[h4i - 1];
        const stPrev = sm.st[h4i - 2];
        if (stNow === null || stPrev === null || stNow === stPrev) continue;

        const dir: Dir = stNow === 1 ? "long" : "short";

        // Volume filter: bar volume > 1.5x 20-bar avg
        const h4Bar = pd.h4[h4i - 1];
        let volSum = 0;
        for (let j = h4i - 21; j < h4i - 1; j++) {
          if (j >= 0) volSum += pd.h4[j].v;
        }
        const avgVol = volSum / 20;
        if (avgVol <= 0 || h4Bar.v < 1.5 * avgVol) continue;

        // BTC filters
        const btcRet = btc30dRet(h4T);
        if (btcRet < -0.10 && dir === "long") continue;
        if (btcRet > 0.15 && dir === "short") continue;
        if (dir === "long" && !btcBullish(h4T)) continue;

        const atrVal = sm.atr[h4i - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p);
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + sp_) : pd.h4[h4i].o * (1 - sp_);

        // SL
        let slDist = atrVal * cfg.slMult;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        // TP
        const tp = cfg.tpPct > 0
          ? (dir === "long" ? ep * (1 + cfg.tpPct) : ep * (1 - cfg.tpPct))
          : 0;

        positions.set(key, {
          pair: p, dir, ep, et: h4T, sl, tp,
          atr: atrVal, bestPnlAtr: 0,
        });
      }
    }
  }

  // Close remaining positions at last bar close
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairDataMap.get(pos.pair);
    if (!pd || pd.h4.length === 0) continue;
    const lastBar = pd.h4[pd.h4.length - 1];
    closePosition(key, lastBar.c, lastBar.t);
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  trades: number; pf: number; sharpe: number; perDay: number; wr: number;
  maxDd: number; totalPnl: number; avgPnl: number; winners: number; losers: number;
}

function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return {
    trades: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0,
    maxDd: 0, totalPnl: 0, avgPnl: 0, winners: 0, losers: 0,
  };

  const sorted = [...filtered].sort((a, b) => a.xt - b.xt);
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const wr = filtered.length > 0 ? wins.length / filtered.length : 0;

  const days = (endMs - startMs) / DAY;
  const perDay = totalPnl / days;

  const dailyPnl = new Map<number, number>();
  for (const t of sorted) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.pnl);
  }
  const dpVals = [...dailyPnl.values()];
  const mean = dpVals.length > 0 ? dpVals.reduce((a, b) => a + b, 0) / dpVals.length : 0;
  const std = dpVals.length > 1
    ? Math.sqrt(dpVals.reduce((s, v) => s + (v - mean) ** 2, 0) / (dpVals.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  let equity = 0, peak = 0, maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades: filtered.length,
    pf: Math.round(pf * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    perDay: Math.round(perDay * 100) / 100,
    wr: Math.round(wr * 1000) / 10,
    maxDd: Math.round(maxDd * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round((totalPnl / filtered.length) * 100) / 100,
    winners: wins.length,
    losers: losses.length,
  };
}

// ─── Output Helpers ─────────────────────────────────────────────────
function pad(s: string, n: number): string { return s.padStart(n); }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "") + "$" + v.toFixed(2); }
function fmtPct(v: number): string { return v.toFixed(1) + "%"; }

function printHeader() {
  console.log(
    `${"Variant".padEnd(32)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
    `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 8)} ${pad("Total", 11)} ${pad("Avg", 8)}`
  );
  console.log("-".repeat(105));
}

function printRow(label: string, s: Stats) {
  console.log(
    `${label.padEnd(32)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 8)} ` +
    `${pad(fmtPnl(s.totalPnl), 11)} ${pad(fmtPnl(s.avgPnl), 8)}`
  );
}

// ─── Trail Profiles ─────────────────────────────────────────────────
const TRAIL_CURRENT: TrailProfile = {
  label: "Current",
  steps: [
    { triggerAtr: 1, trailAtr: 0, isBreakeven: true },   // breakeven at 1xATR profit
    { triggerAtr: 2, trailAtr: 2 },                       // trail 2xATR at 2x profit
    { triggerAtr: 3, trailAtr: 1.5 },                     // trail 1.5xATR at 3x profit
  ],
};

const TRAIL_AGGRESSIVE: TrailProfile = {
  label: "Aggressive",
  steps: [
    { triggerAtr: 0.5, trailAtr: 0, isBreakeven: true },
    { triggerAtr: 1.5, trailAtr: 1.5 },
    { triggerAtr: 2.5, trailAtr: 1.0 },
  ],
};

const TRAIL_CONSERVATIVE: TrailProfile = {
  label: "Conservative",
  steps: [
    { triggerAtr: 2, trailAtr: 0, isBreakeven: true },
    { triggerAtr: 3, trailAtr: 2.5 },
    { triggerAtr: 4, trailAtr: 2.0 },
  ],
};

const TRAIL_NO_TRAIL: TrailProfile = {
  label: "No trail (BE@1x)",
  steps: [
    { triggerAtr: 1, trailAtr: 0, isBreakeven: true },
  ],
};

const TRAIL_NONE: TrailProfile = {
  label: "None (SL+signal)",
  steps: [],
};

const TRAIL_FAST_LOCK: TrailProfile = {
  label: "Fast lock",
  steps: [
    { triggerAtr: 0.5, trailAtr: 0, isBreakeven: true },
    { triggerAtr: 1.0, trailAtr: 1.0 },
  ],
};

// ─── Build sweep configs ────────────────────────────────────────────

const sweepConfigs: { sweep: string; configs: SweepConfig[] }[] = [];

// SWEEP 1: SL multiplier
{
  const cfgs: SweepConfig[] = [];
  for (const slm of [1.5, 2.0, 2.5, 3.0, 3.5, 4.0]) {
    cfgs.push({
      label: `SL ATR x${slm}`,
      slMult: slm, tpPct: 0, trail: TRAIL_CURRENT, atrPeriod: 14, stAtrPeriod: 14, stMult: 1.75,
    });
  }
  sweepConfigs.push({ sweep: "SWEEP 1: SL Multiplier", configs: cfgs });
}

// SWEEP 2: Trailing ladder profiles
{
  const profiles = [
    TRAIL_CURRENT, TRAIL_AGGRESSIVE, TRAIL_CONSERVATIVE,
    TRAIL_NO_TRAIL, TRAIL_NONE, TRAIL_FAST_LOCK,
  ];
  const cfgs: SweepConfig[] = [];
  for (const tp of profiles) {
    cfgs.push({
      label: `Trail: ${tp.label}`,
      slMult: 3, tpPct: 0, trail: tp, atrPeriod: 14, stAtrPeriod: 14, stMult: 1.75,
    });
  }
  sweepConfigs.push({ sweep: "SWEEP 2: Trailing Ladder Profile", configs: cfgs });
}

// SWEEP 3: Fixed TP
{
  const cfgs: SweepConfig[] = [];
  for (const tpPct of [0, 0.05, 0.07, 0.10, 0.15, 0.20]) {
    cfgs.push({
      label: `TP ${tpPct === 0 ? "None" : (tpPct * 100) + "%"}`,
      slMult: 3, tpPct, trail: TRAIL_CURRENT, atrPeriod: 14, stAtrPeriod: 14, stMult: 1.75,
    });
  }
  sweepConfigs.push({ sweep: "SWEEP 3: Fixed Take-Profit", configs: cfgs });
}

// SWEEP 4: ATR period
{
  const cfgs: SweepConfig[] = [];
  for (const ap of [7, 10, 14, 20, 28]) {
    cfgs.push({
      label: `ATR(${ap})`,
      slMult: 3, tpPct: 0, trail: TRAIL_CURRENT, atrPeriod: ap, stAtrPeriod: 14, stMult: 1.75,
    });
  }
  sweepConfigs.push({ sweep: "SWEEP 4: ATR Period", configs: cfgs });
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=".repeat(110));
console.log("  SL / TP / TRAIL / ATR SWEEP - Supertrend(14, 1.75) + Volume Filter");
console.log("  18 pairs, 2023-01 to 2026-03, 5m candles -> 4h bars, $5 margin, 10x lev");
console.log("  Cost: Taker 0.035%, standard spreads, 1.5x SL slippage");
console.log("=".repeat(110));

loadAllData();

interface SweepResult {
  label: string;
  full: Stats;
  y23: Stats; y24: Stats; y25: Stats; y26: Stats;
}

const allResults: { sweep: string; results: SweepResult[] }[] = [];

for (const { sweep, configs } of sweepConfigs) {
  console.log("\n\n" + "#".repeat(110));
  console.log(`  ${sweep}`);
  console.log("#".repeat(110));

  const results: SweepResult[] = [];

  for (const cfg of configs) {
    const trades = runSupertrend(cfg);
    const full = computeStats(trades, FULL_START, FULL_END);
    const y23 = computeStats(trades, new Date("2023-01-01").getTime(), new Date("2024-01-01").getTime());
    const y24 = computeStats(trades, new Date("2024-01-01").getTime(), new Date("2025-01-01").getTime());
    const y25 = computeStats(trades, new Date("2025-01-01").getTime(), new Date("2026-01-01").getTime());
    const y26 = computeStats(trades, new Date("2026-01-01").getTime(), FULL_END);
    results.push({ label: cfg.label, full, y23, y24, y25, y26 });
  }

  // Print full-period table
  console.log("\n--- Full Period (2023-01 to 2026-03) ---");
  printHeader();
  for (const r of results) {
    printRow(r.label, r.full);
  }

  // Print per-year $/day comparison
  console.log("\n--- Per-Year $/day ---");
  console.log(
    `${"Variant".padEnd(32)} ${pad("'23$/d", 8)} ${pad("'24$/d", 8)} ${pad("'25$/d", 8)} ${pad("'26$/d", 8)} ${pad("Full$/d", 9)}`
  );
  console.log("-".repeat(80));
  for (const r of results) {
    console.log(
      `${r.label.padEnd(32)} ${pad(fmtPnl(r.y23.perDay), 8)} ${pad(fmtPnl(r.y24.perDay), 8)} ` +
      `${pad(fmtPnl(r.y25.perDay), 8)} ${pad(fmtPnl(r.y26.perDay), 8)} ${pad(fmtPnl(r.full.perDay), 9)}`
    );
  }

  allResults.push({ sweep, results });
}

// ─── GRAND RANKED TABLE ─────────────────────────────────────────────
console.log("\n\n" + "=".repeat(130));
console.log("  GRAND RANKED TABLE - All Variants (sorted by $/day)");
console.log("=".repeat(130));

const allFlat: SweepResult[] = [];
for (const { results } of allResults) {
  for (const r of results) allFlat.push(r);
}
allFlat.sort((a, b) => b.full.perDay - a.full.perDay);

console.log(
  `${"#".padEnd(3)} ${"Variant".padEnd(32)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
  `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 8)} ${pad("Total", 11)} ` +
  `${pad("'23$/d", 8)} ${pad("'24$/d", 8)} ${pad("'25$/d", 8)} ${pad("'26$/d", 8)}`
);
console.log("-".repeat(130));

for (let i = 0; i < allFlat.length; i++) {
  const r = allFlat[i];
  const s = r.full;
  console.log(
    `${String(i + 1).padEnd(3)} ${r.label.padEnd(32)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 8)} ${pad(fmtPnl(s.totalPnl), 11)} ` +
    `${pad(fmtPnl(r.y23.perDay), 8)} ${pad(fmtPnl(r.y24.perDay), 8)} ${pad(fmtPnl(r.y25.perDay), 8)} ${pad(fmtPnl(r.y26.perDay), 8)}`
  );
}

// ─── BEST PER SWEEP ─────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(110));
console.log("  BEST PER SWEEP");
console.log("=".repeat(110));

for (const { sweep, results } of allResults) {
  const best = [...results].sort((a, b) => b.full.perDay - a.full.perDay)[0];
  const current = results.find(r => r.label.includes("Current") || r.label.includes("ATR x3") || r.label.includes("ATR(14)") || r.label.includes("None"));
  const baseline = results[0]; // first is always a reference point

  console.log(`\n${sweep}`);
  console.log(`  Best:     ${best.label}  ->  ${fmtPnl(best.full.perDay)}/day, PF ${best.full.pf}, Sharpe ${best.full.sharpe}, MaxDD $${best.full.maxDd.toFixed(0)}`);
  if (current && current.label !== best.label) {
    console.log(`  Current:  ${current.label}  ->  ${fmtPnl(current.full.perDay)}/day, PF ${current.full.pf}`);
    console.log(`  Delta:    ${fmtPnl(best.full.perDay - current.full.perDay)}/day`);
  }

  // Year consistency check
  const allYearsPositive = best.y23.perDay > 0 && best.y24.perDay > 0 && best.y25.perDay > 0;
  console.log(`  Years:    '23=${fmtPnl(best.y23.perDay)}/d  '24=${fmtPnl(best.y24.perDay)}/d  '25=${fmtPnl(best.y25.perDay)}/d  '26=${fmtPnl(best.y26.perDay)}/d  ${allYearsPositive ? "ALL POSITIVE" : "NOT ALL POSITIVE"}`);
}

// ─── RECOMMENDATION ─────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(110));
console.log("  RECOMMENDATION");
console.log("=".repeat(110));

const grandBest = allFlat[0];
const currentBaseline = allFlat.find(r => r.label === "SL ATR x3")!;

console.log(`
Grand best:   ${grandBest.label}  ->  ${fmtPnl(grandBest.full.perDay)}/day, PF ${grandBest.full.pf}, Sharpe ${grandBest.full.sharpe}
Current cfg:  ${currentBaseline.label}  ->  ${fmtPnl(currentBaseline.full.perDay)}/day, PF ${currentBaseline.full.pf}, Sharpe ${currentBaseline.full.sharpe}
Improvement:  ${fmtPnl(grandBest.full.perDay - currentBaseline.full.perDay)}/day (${((grandBest.full.perDay / Math.max(currentBaseline.full.perDay, 0.01) - 1) * 100).toFixed(1)}%)

Grand best yearly:
  2023: ${fmtPnl(grandBest.y23.perDay)}/day (PF ${grandBest.y23.pf})
  2024: ${fmtPnl(grandBest.y24.perDay)}/day (PF ${grandBest.y24.pf})
  2025: ${fmtPnl(grandBest.y25.perDay)}/day (PF ${grandBest.y25.pf})
  2026: ${fmtPnl(grandBest.y26.perDay)}/day (PF ${grandBest.y26.pf})
`);

const allPositive = grandBest.y23.perDay > 0 && grandBest.y24.perDay > 0 && grandBest.y25.perDay > 0;
if (allPositive && grandBest.full.pf > 1.2) {
  console.log(`VERDICT: ${grandBest.label} is robust -- positive all years, PF > 1.2.`);
} else if (grandBest.full.pf > 1.0) {
  console.log(`CAUTION: ${grandBest.label} has PF > 1.0 but check year consistency before adopting.`);
} else {
  console.log(`WARNING: No variant clearly better. Stick with current parameters.`);
}
