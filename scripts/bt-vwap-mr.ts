/**
 * VWAP Mean Reversion + Volume Spike backtest
 *
 * Strategy:
 *   - Rolling VWAP over N 5m bars (50/100/200)
 *   - LONG: close < VWAP - K*std AND volume > X*avg (panic selling = reversal)
 *   - SHORT: close > VWAP + K*std AND volume > X*avg (euphoria = reversion)
 *   - TP: reversion to VWAP OR fixed %
 *   - SL: fixed % from entry
 *   - Max hold: 1h to 8h
 *
 * Also tests SMA-ATR variant: close < SMA - K*ATR(14)
 *
 * Indicators precomputed per pair for speed.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-vwap-mr.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const D = 86_400_000;
const MIN5 = 300_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;

const START_TS = new Date("2025-06-01").getTime();
const END_TS = new Date("2026-03-25").getTime();
const DAYS = (END_TS - START_TS) / D;

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
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET",
  "FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR",
  "PENDLE","PNUT","ATOM","TON","SEI","STX",
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN",
  "TNSR","CATI","TURBO","MOVE","GALA","STRK","SAGA","ILV","GMX","OM",
  "CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC","USUAL","UMA","USTC",
  "MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS",
  "MINA","LISTA","NEO","AI","SCR","APE","KAITO","AR","BNT","PIXEL",
  "LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET","STG","REQ",
  "CAKE","SUPER","FTT","STRAX",
];

interface C { t: number; o: number; h: number; l: number; c: number; v: number; }

function load(s: string): C[] {
  const f = path.join(CACHE_5M, `${s}.json`);
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as unknown[])
    .map((b: unknown) => {
      if (Array.isArray(b)) return { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +(b[5] ?? 0) };
      const o = b as Record<string, number>;
      return { t: +o.t, o: +o.o, h: +o.h, l: +o.l, c: +o.c, v: +(o.v ?? 0) };
    })
    .sort((a, b) => a.t - b.t);
}

// ---- Precomputed per-pair indicators ----
interface PairInd {
  // Per window size: rolling VWAP value and std deviation
  vwap: Map<number, Float64Array>;     // window -> array[barIdx]
  vwapStd: Map<number, Float64Array>;  // window -> array[barIdx]
  // SMA per window
  sma: Map<number, Float64Array>;
  // ATR(14)
  atr14: Float64Array;
  // Rolling avg volume (20 bars)
  avgVol20: Float64Array;
}

interface PairData {
  name: string;
  bars: C[];
  barMap: Map<number, number>;
  sp: number;
  lev: number;
  ind: PairInd;
}

function precomputeVWAP(bars: C[], window: number): { vwap: Float64Array; std: Float64Array } {
  const n = bars.length;
  const vwap = new Float64Array(n);
  const std = new Float64Array(n);

  if (n < window) return { vwap, std };

  // Initialize first window
  let sumPV = 0, sumV = 0;
  for (let j = 0; j < window; j++) {
    sumPV += bars[j]!.c * bars[j]!.v;
    sumV += bars[j]!.v;
  }

  for (let i = window - 1; i < n; i++) {
    if (i > window - 1) {
      // Slide window: add new bar, remove oldest
      sumPV += bars[i]!.c * bars[i]!.v;
      sumV += bars[i]!.v;
      sumPV -= bars[i - window]!.c * bars[i - window]!.v;
      sumV -= bars[i - window]!.v;
    }

    if (sumV === 0) continue;
    const v = sumPV / sumV;
    vwap[i] = v;

    // Std of (close - vwap) over window
    let ss = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const diff = bars[j]!.c - v;
      ss += diff * diff;
    }
    std[i] = Math.sqrt(ss / window);
  }

  return { vwap, std };
}

function precomputeSMA(bars: C[], window: number): Float64Array {
  const n = bars.length;
  const sma = new Float64Array(n);
  if (n < window) return sma;

  let sum = 0;
  for (let j = 0; j < window; j++) sum += bars[j]!.c;
  sma[window - 1] = sum / window;
  for (let i = window; i < n; i++) {
    sum += bars[i]!.c - bars[i - window]!.c;
    sma[i] = sum / window;
  }
  return sma;
}

function precomputeATR14(bars: C[]): Float64Array {
  const n = bars.length;
  const atr = new Float64Array(n);
  const period = 14;
  if (n < period + 1) return atr;

  for (let i = period; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tr = Math.max(
        bars[j]!.h - bars[j]!.l,
        Math.abs(bars[j]!.h - bars[j - 1]!.c),
        Math.abs(bars[j]!.l - bars[j - 1]!.c)
      );
      sum += tr;
    }
    atr[i] = sum / period;
  }
  return atr;
}

function precomputeAvgVol(bars: C[], window: number): Float64Array {
  const n = bars.length;
  const avg = new Float64Array(n);
  if (n < window) return avg;

  let sum = 0;
  for (let j = 0; j < window; j++) sum += bars[j]!.v;
  avg[window - 1] = sum / window;
  for (let i = window; i < n; i++) {
    sum += bars[i]!.v - bars[i - window]!.v;
    avg[i] = sum / window;
  }
  return avg;
}

// ---- Load and precompute ----
console.log("Loading data...");
const pairsData: PairData[] = [];
const WINDOWS = [50, 100, 200];

for (const n of ALL_PAIRS) {
  const s = RM[n] ?? n;
  let raw = load(`${s}USDT`);
  if (raw.length < 5000) raw = load(`${n}USDT`);
  if (raw.length < 5000) continue;
  const lookbackStart = START_TS - 250 * MIN5;
  const bars = raw.filter(b => b.t >= lookbackStart && b.t <= END_TS);
  if (bars.length < 300) continue;
  const barMap = new Map<number, number>();
  bars.forEach((b, i) => barMap.set(b.t, i));

  // Precompute indicators
  const vwapMap = new Map<number, Float64Array>();
  const vwapStdMap = new Map<number, Float64Array>();
  const smaMap = new Map<number, Float64Array>();
  for (const w of WINDOWS) {
    const { vwap, std } = precomputeVWAP(bars, w);
    vwapMap.set(w, vwap);
    vwapStdMap.set(w, std);
    smaMap.set(w, precomputeSMA(bars, w));
  }
  const atr14 = precomputeATR14(bars);
  const avgVol20 = precomputeAvgVol(bars, 20);

  pairsData.push({
    name: n, bars, barMap,
    sp: SP[n] ?? DSP, lev: getLev(n),
    ind: { vwap: vwapMap, vwapStd: vwapStdMap, sma: smaMap, atr14, avgVol20 },
  });
}
console.log(`${pairsData.length} pairs loaded & precomputed, ${DAYS.toFixed(0)} days`);

// Fast lookup
const pairDataMap = new Map<string, PairData>();
for (const pd of pairsData) pairDataMap.set(pd.name, pd);

// Collect in-range timepoints
const allTimes = new Set<number>();
for (const p of pairsData) {
  for (const b of p.bars) {
    if (b.t >= START_TS && b.t < END_TS) allTimes.add(b.t);
  }
}
const timepoints = [...allTimes].sort((a, b) => a - b);
console.log(`${timepoints.length} timepoints`);

// ---- Config types ----
type TpMode = "vwap" | "fixed";
type SignalMode = "vwap" | "sma_atr";

interface Cfg {
  signalMode: SignalMode;
  window: number;
  kStd: number;
  volMult: number;
  slPct: number;
  tpMode: TpMode;
  tpFixedPct: number;
  maxHoldBars: number;
  margin: number;
  maxConc: number;
  longOnly: boolean;
}

interface OpenPos {
  pair: string;
  dir: "long" | "short";
  ep: number;
  et: number;
  sl: number;
  tp: number;
  vwapAtEntry: number;
  not: number;
  sp: number;
}

interface Trade {
  pnl: number;
  exitTs: number;
  holdBars: number;
}

interface Result {
  cfg: Cfg;
  trades: number;
  wr: number;
  pf: number;
  totalPnl: number;
  perDay: number;
  mtmMDD: number;
  sharpe: number;
  avgHoldBars: number;
}

function runSim(cfg: Cfg): Result {
  const open: OpenPos[] = [];
  const closed: Trade[] = [];

  let realizedPnl = 0;
  let peakEq = 0;
  let mtmMDD = 0;
  let totalHold = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  const cooldown = new Map<string, number>();

  for (const ts of timepoints) {
    // ---- Exits ----
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i]!;
      const pd = pairDataMap.get(pos.pair)!;
      const bi = pd.barMap.get(ts);
      if (bi === undefined) continue;
      const bar = pd.bars[bi]!;

      let xp = 0;
      let isSL = false;

      const holdBars = (ts - pos.et) / MIN5;
      if (holdBars >= cfg.maxHoldBars) xp = bar.c;

      if (!xp) {
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; }
      }

      if (!xp) {
        if (cfg.tpMode === "vwap") {
          if (pos.dir === "long" && bar.h >= pos.vwapAtEntry) xp = pos.vwapAtEntry;
          else if (pos.dir === "short" && bar.l <= pos.vwapAtEntry) xp = pos.vwapAtEntry;
        } else if (pos.tp > 0) {
          if (pos.dir === "long" && bar.h >= pos.tp) xp = pos.tp;
          else if (pos.dir === "short" && bar.l <= pos.tp) xp = pos.tp;
        }
      }

      if (xp > 0) {
        const slipSp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - slipSp) : xp * (1 + slipSp);
        const fees = pos.not * FEE * 2;
        const rawPnl = pos.dir === "long"
          ? (ex / pos.ep - 1) * pos.not
          : (1 - ex / pos.ep) * pos.not;
        const pnl = rawPnl - fees;
        realizedPnl += pnl;
        if (pnl > 0) { wins++; grossProfit += pnl; } else grossLoss += Math.abs(pnl);
        closed.push({ pnl, exitTs: ts, holdBars });
        totalHold += holdBars;
        cooldown.set(`${pos.pair}_${pos.dir}`, ts);
        open.splice(i, 1);
      }
    }

    // ---- MTM MDD ----
    let unrealized = 0;
    for (const pos of open) {
      const pd = pairDataMap.get(pos.pair)!;
      const bi = pd.barMap.get(ts);
      if (bi === undefined) continue;
      const bar = pd.bars[bi]!;
      const mp = pos.dir === "long" ? bar.c * (1 - pos.sp) : bar.c * (1 + pos.sp);
      const rp = pos.dir === "long"
        ? (mp / pos.ep - 1) * pos.not
        : (1 - mp / pos.ep) * pos.not;
      unrealized += rp - pos.not * FEE * 2;
    }
    const eq = realizedPnl + unrealized;
    if (eq > peakEq) peakEq = eq;
    const dd = peakEq - eq;
    if (dd > mtmMDD) mtmMDD = dd;

    // ---- Entries ----
    for (const pd of pairsData) {
      if (open.length >= cfg.maxConc) break;
      if (open.some(o => o.pair === pd.name)) continue;

      const bi = pd.barMap.get(ts);
      if (bi === undefined) continue;
      const bar = pd.bars[bi]!;

      let dir: "long" | "short" | null = null;
      let vwapLevel = 0;

      if (cfg.signalMode === "vwap") {
        const vwArr = pd.ind.vwap.get(cfg.window)!;
        const vsArr = pd.ind.vwapStd.get(cfg.window)!;
        const vw = vwArr[bi]!;
        const vs = vsArr[bi]!;
        if (vw === 0 || vs === 0) continue;
        const av = pd.ind.avgVol20[bi]!;
        if (av === 0) continue;
        const volRatio = bar.v / av;

        if (bar.c < vw - cfg.kStd * vs && volRatio > cfg.volMult) {
          dir = "long"; vwapLevel = vw;
        } else if (!cfg.longOnly && bar.c > vw + cfg.kStd * vs && volRatio > cfg.volMult) {
          dir = "short"; vwapLevel = vw;
        }
      } else {
        const smaArr = pd.ind.sma.get(cfg.window)!;
        const sm = smaArr[bi]!;
        if (sm === 0) continue;
        const at = pd.ind.atr14[bi]!;
        if (at === 0) continue;
        const av = pd.ind.avgVol20[bi]!;
        if (av === 0) continue;
        const volRatio = bar.v / av;

        if (bar.c < sm - cfg.kStd * at && volRatio > cfg.volMult) {
          dir = "long"; vwapLevel = sm;
        } else if (!cfg.longOnly && bar.c > sm + cfg.kStd * at && volRatio > cfg.volMult) {
          dir = "short"; vwapLevel = sm;
        }
      }

      if (!dir) continue;

      const cdKey = `${pd.name}_${dir}`;
      const lastExit = cooldown.get(cdKey) ?? 0;
      if (ts - lastExit < H) continue;

      const ep = dir === "long" ? bar.c * (1 + pd.sp) : bar.c * (1 - pd.sp);
      const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);

      let tp = 0;
      if (cfg.tpMode === "fixed" && cfg.tpFixedPct > 0) {
        tp = dir === "long" ? ep * (1 + cfg.tpFixedPct) : ep * (1 - cfg.tpFixedPct);
      }

      open.push({
        pair: pd.name, dir, ep, et: ts, sl, tp,
        vwapAtEntry: vwapLevel, not: cfg.margin * pd.lev, sp: pd.sp,
      });
    }
  }

  // Close remaining
  for (const pos of open) {
    const pd = pairDataMap.get(pos.pair)!;
    const lb = pd.bars[pd.bars.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    const rp = pos.dir === "long" ? (ex / pos.ep - 1) * pos.not : (1 - ex / pos.ep) * pos.not;
    const pnl = rp - fees;
    realizedPnl += pnl;
    if (pnl > 0) { wins++; grossProfit += pnl; } else grossLoss += Math.abs(pnl);
    closed.push({ pnl, exitTs: END_TS, holdBars: 0 });
  }

  const n = closed.length;
  const totalPnl = realizedPnl;
  const wr = n > 0 ? (wins / n) * 100 : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 99;
  const perDay = totalPnl / DAYS;

  // Sharpe
  const dayPnl = new Map<number, number>();
  for (const t of closed) {
    const d = Math.floor(t.exitTs / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const avgHoldBars = n > 0 ? totalHold / n : 0;

  return { cfg, trades: n, wr, pf, totalPnl, perDay, mtmMDD, sharpe, avgHoldBars };
}

// ---- Build config sweep ----
function buildConfigs(): Cfg[] {
  const configs: Cfg[] = [];

  const tpModes: { mode: TpMode; pct: number; label: string }[] = [
    { mode: "vwap", pct: 0, label: "VWAP" },
    { mode: "fixed", pct: 0.003, label: "0.3%" },
    { mode: "fixed", pct: 0.005, label: "0.5%" },
    { mode: "fixed", pct: 0.01, label: "1.0%" },
  ];

  // Phase 1: Core VWAP signal sweep (144 configs)
  // window x K x SL x TP = 3*4*3*4 = 144, fixed margin=5, maxConc=3, both dirs, volMult=2.0
  for (const w of [50, 100, 200]) {
    for (const k of [1.5, 2.0, 2.5, 3.0]) {
      for (const sl of [0.003, 0.005, 0.01]) {
        for (const tp of tpModes) {
          configs.push({
            signalMode: "vwap", window: w, kStd: k, volMult: 2.0, slPct: sl,
            tpMode: tp.mode, tpFixedPct: tp.pct, maxHoldBars: 48,
            margin: 5, maxConc: 3, longOnly: false,
          });
        }
      }
    }
  }

  // Phase 2: Volume multiplier sweep (8 configs)
  for (const w of [100, 200]) {
    for (const k of [2.0, 2.5]) {
      for (const vm of [1.5, 3.0]) {
        configs.push({
          signalMode: "vwap", window: w, kStd: k, volMult: vm, slPct: 0.005,
          tpMode: "vwap", tpFixedPct: 0, maxHoldBars: 48,
          margin: 5, maxConc: 3, longOnly: false,
        });
      }
    }
  }

  // Phase 3: Max hold sweep (6 configs)
  for (const mh of [12, 24, 96]) {
    for (const k of [2.0, 2.5]) {
      configs.push({
        signalMode: "vwap", window: 100, kStd: k, volMult: 2.0, slPct: 0.005,
        tpMode: "vwap", tpFixedPct: 0, maxHoldBars: mh,
        margin: 5, maxConc: 3, longOnly: false,
      });
    }
  }

  // Phase 4: Margin sweep (6 configs)
  for (const mg of [3, 7, 10]) {
    for (const k of [2.0, 2.5]) {
      configs.push({
        signalMode: "vwap", window: 100, kStd: k, volMult: 2.0, slPct: 0.005,
        tpMode: "vwap", tpFixedPct: 0, maxHoldBars: 48,
        margin: mg, maxConc: 3, longOnly: false,
      });
    }
  }

  // Phase 5: MaxConc sweep (4 configs)
  for (const mc of [1, 5]) {
    for (const k of [2.0, 2.5]) {
      configs.push({
        signalMode: "vwap", window: 100, kStd: k, volMult: 2.0, slPct: 0.005,
        tpMode: "vwap", tpFixedPct: 0, maxHoldBars: 48,
        margin: 5, maxConc: mc, longOnly: false,
      });
    }
  }

  // Phase 6: Long-only VWAP sweep (18 configs)
  for (const w of [100, 200]) {
    for (const k of [2.0, 2.5, 3.0]) {
      for (const sl of [0.003, 0.005, 0.01]) {
        configs.push({
          signalMode: "vwap", window: w, kStd: k, volMult: 2.0, slPct: sl,
          tpMode: "vwap", tpFixedPct: 0, maxHoldBars: 48,
          margin: 5, maxConc: 3, longOnly: true,
        });
      }
    }
  }

  // Phase 7: SMA-ATR variant (144 configs)
  for (const w of [50, 100, 200]) {
    for (const k of [1.5, 2.0, 2.5, 3.0]) {
      for (const sl of [0.003, 0.005, 0.01]) {
        for (const tp of tpModes) {
          configs.push({
            signalMode: "sma_atr", window: w, kStd: k, volMult: 2.0, slPct: sl,
            tpMode: tp.mode, tpFixedPct: tp.pct, maxHoldBars: 48,
            margin: 5, maxConc: 3, longOnly: false,
          });
        }
      }
    }
  }

  // Phase 8: SMA-ATR long-only (4 configs)
  for (const k of [2.0, 2.5]) {
    for (const sl of [0.005, 0.01]) {
      configs.push({
        signalMode: "sma_atr", window: 100, kStd: k, volMult: 2.0, slPct: sl,
        tpMode: "fixed", tpFixedPct: 0.005, maxHoldBars: 48,
        margin: 5, maxConc: 3, longOnly: true,
      });
    }
  }

  return configs;
}

function cfgLabel(c: Cfg): string {
  const sig = c.signalMode === "vwap" ? "VWAP" : "SMA";
  const tp = c.tpMode === "vwap" ? "vwap" : `${(c.tpFixedPct * 100).toFixed(1)}%`;
  const dir = c.longOnly ? "L" : "B";
  const mh = `${(c.maxHoldBars * 5 / 60).toFixed(0)}h`;
  return `${sig}(${c.window}) K${c.kStd} V${c.volMult} SL${(c.slPct * 100).toFixed(1)} TP:${tp} ${mh} $${c.margin} C${c.maxConc} ${dir}`;
}

// ---- Main ----
function main() {
  const configs = buildConfigs();
  console.log(`\nRunning ${configs.length} configs...\n`);

  const results: Result[] = [];
  let done = 0;
  const t0 = Date.now();

  for (const cfg of configs) {
    const r = runSim(cfg);
    results.push(r);
    done++;
    if (done % 10 === 0 || done === configs.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      process.stdout.write(`\r  ${done}/${configs.length} done (${elapsed}s)`);
    }
  }
  console.log("\n");

  // Filter: MTM MDD < $20 and at least 10 trades
  const filtered = results.filter(r => r.mtmMDD < 20 && r.trades >= 10);
  filtered.sort((a, b) => b.perDay - a.perDay);
  const top = filtered.slice(0, 50);

  const W = 120;
  console.log("=".repeat(W));
  console.log("  VWAP MEAN REVERSION + VOLUME SPIKE BACKTEST");
  console.log(`  Period: 2025-06-01 to 2026-03-25 (${DAYS.toFixed(0)} days) | ${pairsData.length} pairs | ${configs.length} configs`);
  console.log("  Filter: MTM MDD < $20, trades >= 10 | Sorted by $/day");
  console.log("=".repeat(W));
  console.log("");

  const hdr =
    "#".padStart(3) + " " +
    "Config".padEnd(52) +
    "$/day".padStart(7) +
    "Total".padStart(8) +
    " MDD".padStart(7) +
    "  Trd".padStart(6) +
    "  WR%".padStart(6) +
    "  PF".padStart(6) +
    "Sharpe".padStart(7) +
    " AvgH".padStart(6);
  console.log(hdr);
  console.log("-".repeat(W));

  for (let i = 0; i < top.length; i++) {
    const r = top[i]!;
    const label = cfgLabel(r.cfg);
    const avgH = `${(r.avgHoldBars * 5 / 60).toFixed(1)}h`;
    const pd = `${r.perDay >= 0 ? "+" : "-"}$${Math.abs(r.perDay).toFixed(2)}`;
    console.log(
      String(i + 1).padStart(3) + " " +
      label.padEnd(52) +
      pd.padStart(7) +
      `$${r.totalPnl.toFixed(1)}`.padStart(8) +
      `$${r.mtmMDD.toFixed(1)}`.padStart(7) +
      String(r.trades).padStart(6) +
      r.wr.toFixed(1).padStart(6) +
      r.pf.toFixed(2).padStart(6) +
      r.sharpe.toFixed(2).padStart(7) +
      avgH.padStart(6)
    );
  }

  console.log("-".repeat(W));
  console.log(`\n${filtered.length} configs passed filter (MDD<$20, trades>=10) out of ${results.length} total`);

  const allProfitable = results.filter(r => r.perDay > 0);
  const allMDDSafe = results.filter(r => r.mtmMDD < 20);
  console.log(`${allProfitable.length}/${results.length} configs profitable`);
  console.log(`${allMDDSafe.length}/${results.length} configs with MDD < $20`);

  // Best overall
  const bestOverall = [...results].sort((a, b) => b.perDay - a.perDay)[0];
  if (bestOverall) {
    console.log(`\nBest overall (any MDD): ${cfgLabel(bestOverall.cfg)}`);
    console.log(`  $/day: +$${bestOverall.perDay.toFixed(2)}, MDD: $${bestOverall.mtmMDD.toFixed(2)}, Trades: ${bestOverall.trades}, WR: ${bestOverall.wr.toFixed(1)}%, PF: ${bestOverall.pf.toFixed(2)}`);
  }

  // VWAP vs SMA-ATR
  const vwapR = results.filter(r => r.cfg.signalMode === "vwap" && r.trades >= 10);
  const smaR = results.filter(r => r.cfg.signalMode === "sma_atr" && r.trades >= 10);
  if (vwapR.length > 0 && smaR.length > 0) {
    const avgV = vwapR.reduce((s, r) => s + r.perDay, 0) / vwapR.length;
    const avgS = smaR.reduce((s, r) => s + r.perDay, 0) / smaR.length;
    console.log(`\nVWAP avg $/day: ${avgV >= 0 ? "+" : ""}$${Math.abs(avgV).toFixed(3)} (${vwapR.length} configs)`);
    console.log(`SMA-ATR avg $/day: ${avgS >= 0 ? "+" : ""}$${Math.abs(avgS).toFixed(3)} (${smaR.length} configs)`);
  }

  // Long-only vs Both
  const bothR = results.filter(r => !r.cfg.longOnly && r.trades >= 10);
  const longR = results.filter(r => r.cfg.longOnly && r.trades >= 10);
  if (bothR.length > 0 && longR.length > 0) {
    const avgB = bothR.reduce((s, r) => s + r.perDay, 0) / bothR.length;
    const avgL = longR.reduce((s, r) => s + r.perDay, 0) / longR.length;
    console.log(`\nBoth dirs avg $/day: ${avgB >= 0 ? "+" : ""}$${Math.abs(avgB).toFixed(3)} (${bothR.length} configs)`);
    console.log(`Long-only avg $/day: ${avgL >= 0 ? "+" : ""}$${Math.abs(avgL).toFixed(3)} (${longR.length} configs)`);
  }
}

main();
