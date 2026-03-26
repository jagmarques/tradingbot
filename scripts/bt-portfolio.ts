/**
 * Portfolio-level optimization for Daily Donchian Breakout.
 * 5m candles aggregated to daily. OOS from 2025-09-01.
 *
 * Tests: (1) max concurrent positions, (2) ensemble of param sets,
 * (3) drawdown analysis, (4) risk budget (leverage), (5) capital efficiency.
 */
import * as fs from "fs";
import * as path from "path";
import { EMA, ATR } from "technicalindicators";

// ── Types ──
interface C5 { t: number; o: number; h: number; l: number; c: number }
interface DC { t: number; o: number; h: number; l: number; c: number }
interface Pos {
  pair: string; dir: "long" | "short"; ep: number; et: number;
  sl: number; atrAtEntry: number; peakPnl: number; tag: string;
}
interface Trade {
  pair: string; pnl: number; et: number; xt: number; dir: "long" | "short";
  reason: string; tag: string;
}

// ── Constants ──
const CD5 = "/tmp/bt-pair-cache-5m";
const DAY = 86400000;
const FEE = 0.00035;                 // taker fee per side
const SL_SLIP = 1.5;                 // SL slippage multiplier
const MAX_HOLD = 60 * DAY;           // 60 day max hold
const OOS_START = new Date("2025-09-01").getTime();
const END = new Date("2026-03-26").getTime();

const PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4,
  WLDUSDT: 4e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4,
  LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
  ETHUSDT: 0.8e-4, SOLUSDT: 1.2e-4, TIAUSDT: 3.8e-4,
};

// ── Load 5m candles ──
function load5m(pair: string): C5[] {
  const f = path.join(CD5, pair + "USDT.json");
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
  );
}

// ── Aggregate 5m to daily (UTC day boundaries) ──
function toDailyCandles(bars: C5[]): DC[] {
  const byDay = new Map<number, C5[]>();
  for (const b of bars) {
    const dayTs = Math.floor(b.t / DAY) * DAY;
    let arr = byDay.get(dayTs);
    if (!arr) { arr = []; byDay.set(dayTs, arr); }
    arr.push(b);
  }
  const daily: DC[] = [];
  for (const [dayTs, bs] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length < 200) continue; // skip incomplete days (need ~288 5m bars)
    let hi = -Infinity, lo = Infinity;
    for (const b of bs) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
    daily.push({ t: dayTs, o: bs[0].o, h: hi, l: lo, c: bs[bs.length - 1].c });
  }
  return daily;
}

// ── Donchian channel helpers ──
function donchianHigh(cs: DC[], idx: number, period: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - period); i < idx; i++) if (cs[i].h > mx) mx = cs[i].h;
  return mx;
}
function donchianLow(cs: DC[], idx: number, period: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - period); i < idx; i++) if (cs[i].l < mn) mn = cs[i].l;
  return mn;
}

// ── ATR on daily candles ──
function computeATR(cs: DC[], period: number): number[] {
  return ATR.calculate({
    period,
    high: cs.map(c => c.h),
    low: cs.map(c => c.l),
    close: cs.map(c => c.c),
  });
}

// ── BTC trend filter: EMA(20) > EMA(50) ──
interface BtcFilter {
  ema20: number[];
  ema50: number[];
  dailyCs: DC[];
}

function buildBtcFilter(btcDaily: DC[]): BtcFilter {
  const closes = btcDaily.map(c => c.c);
  return {
    ema20: EMA.calculate({ period: 20, values: closes }),
    ema50: EMA.calculate({ period: 50, values: closes }),
    dailyCs: btcDaily,
  };
}

function btcDir(bf: BtcFilter, dayIdx: number): "long" | "short" | null {
  // Use day i-1 for anti-look-ahead
  const prevIdx = dayIdx - 1;
  const len = bf.dailyCs.length;
  const e20i = prevIdx - (len - bf.ema20.length);
  const e50i = prevIdx - (len - bf.ema50.length);
  if (e20i < 0 || e50i < 0 || e20i >= bf.ema20.length || e50i >= bf.ema50.length) return null;
  return bf.ema20[e20i] > bf.ema50[e50i] ? "long" : "short";
}

// ── Core Donchian sim ──
interface DonchianCfg {
  entryLb: number;   // lookback for entry channel
  exitLb: number;    // lookback for exit channel
  atrMult: number;   // ATR multiplier for initial SL
  tag: string;       // label
}

interface SimOpts {
  maxPositions: number;       // 0 = unlimited
  margin: number;             // $ margin per trade
  lev: number;                // leverage
  allowedPairs?: string[];    // subset of pairs, if empty use all
}

function sim(
  cfg: DonchianCfg,
  opts: SimOpts,
  pairData: Map<string, { daily: DC[]; atr: number[] }>,
  bf: BtcFilter,
  startTs: number,
  endTs: number,
): { trades: Trade[]; skipped: number } {
  const allowedSet = new Set(opts.allowedPairs ?? [...pairData.keys()].filter(p => p !== "BTC"));
  const trades: Trade[] = [];
  const positions = new Map<string, Pos>(); // key = pair+tag
  let skipped = 0;

  // Build sorted unique day timestamps in range
  const daySet = new Set<number>();
  for (const [, pd] of pairData) {
    for (const c of pd.daily) {
      if (c.t >= startTs && c.t < endTs) daySet.add(c.t);
    }
  }
  const days = [...daySet].sort((a, b) => a - b);

  // Build pair -> dayTs -> index map
  const pairIdx = new Map<string, Map<number, number>>();
  for (const [p, pd] of pairData) {
    const m = new Map<number, number>();
    pd.daily.forEach((c, i) => m.set(c.t, i));
    pairIdx.set(p, m);
  }

  for (const dayTs of days) {
    const closed = new Set<string>();

    // ── Check exits ──
    for (const [key, pos] of positions) {
      const pd = pairData.get(pos.pair)!;
      const idx = pairIdx.get(pos.pair)!.get(dayTs);
      if (idx === undefined) continue;
      const bar = pd.daily[idx];
      const sp = SP[pos.pair + "USDT"] ?? 4e-4;
      let xp = 0;
      let reason = "";

      // SL hit (with SL slippage)
      if (pos.dir === "long" && bar.l <= pos.sl) {
        xp = pos.sl * (1 - sp * SL_SLIP);
        reason = "sl";
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        xp = pos.sl * (1 + sp * SL_SLIP);
        reason = "sl";
      }

      // ATR trailing stop
      if (!reason) {
        const atrIdx = idx - (pd.daily.length - pd.atr.length);
        const curAtr = atrIdx >= 0 && atrIdx < pd.atr.length ? pd.atr[atrIdx] : null;
        if (curAtr) {
          const pnlAtr = pos.dir === "long"
            ? (bar.c - pos.ep) / curAtr
            : (pos.ep - bar.c) / curAtr;
          // Update peak
          if (pnlAtr > pos.peakPnl) pos.peakPnl = pnlAtr;

          // Determine trail distance
          let trailMult: number | null = null;
          if (pos.peakPnl >= 2) trailMult = 1.5;      // after 2xATR profit, trail at 1.5xATR
          else if (pos.peakPnl >= 1) trailMult = 2;    // after 1xATR profit, trail at 2xATR

          if (trailMult !== null) {
            const trailSl = pos.dir === "long"
              ? bar.c - trailMult * curAtr
              : bar.c + trailMult * curAtr;
            // Update SL if tighter
            if (pos.dir === "long" && trailSl > pos.sl) pos.sl = trailSl;
            if (pos.dir === "short" && trailSl < pos.sl) pos.sl = trailSl;

            // Check if trailing SL was hit this bar
            if (pos.dir === "long" && bar.l <= pos.sl) {
              xp = pos.sl * (1 - sp);
              reason = "trail";
            } else if (pos.dir === "short" && bar.h >= pos.sl) {
              xp = pos.sl * (1 + sp);
              reason = "trail";
            }
          }
        }
      }

      // Donchian exit channel
      if (!reason && idx >= cfg.exitLb) {
        if (pos.dir === "long") {
          const exitLow = donchianLow(pd.daily, idx, cfg.exitLb);
          if (bar.c < exitLow) { xp = bar.c * (1 - sp); reason = "exit-ch"; }
        } else {
          const exitHigh = donchianHigh(pd.daily, idx, cfg.exitLb);
          if (bar.c > exitHigh) { xp = bar.c * (1 + sp); reason = "exit-ch"; }
        }
      }

      // Max hold
      if (!reason && dayTs - pos.et >= MAX_HOLD) {
        xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        reason = "maxhold";
      }

      if (xp > 0) {
        const notional = opts.margin * opts.lev;
        const raw = pos.dir === "long"
          ? (xp / pos.ep - 1) * notional
          : (pos.ep / xp - 1) * notional;
        const pnl = raw - notional * FEE * 2;
        trades.push({ pair: pos.pair, pnl, et: pos.et, xt: dayTs, dir: pos.dir, reason, tag: pos.tag });
        positions.delete(key);
        closed.add(key);
      }
    }

    // ── Check entries ──
    for (const pair of allowedSet) {
      if (pair === "BTC") continue;
      const pd = pairData.get(pair);
      if (!pd) continue;
      const idxMap = pairIdx.get(pair)!;
      const idx = idxMap.get(dayTs);
      if (idx === undefined || idx < cfg.entryLb + 1) continue;

      const key = pair + ":" + cfg.tag;
      if (positions.has(key) || closed.has(key)) continue;

      // Max positions check
      if (opts.maxPositions > 0 && positions.size >= opts.maxPositions) {
        skipped++;
        continue;
      }

      // Anti-look-ahead: signal on day i-1, entry at day i open
      const prevIdx = idx - 1;
      const prevBar = pd.daily[prevIdx];
      const curBar = pd.daily[idx];

      // Donchian breakout on previous day close
      const hiCh = donchianHigh(pd.daily, prevIdx, cfg.entryLb);
      const loCh = donchianLow(pd.daily, prevIdx, cfg.entryLb);

      let dir: "long" | "short" | null = null;
      if (prevBar.c > hiCh) dir = "long";
      else if (prevBar.c < loCh) dir = "short";
      if (!dir) continue;

      // BTC trend filter
      const btcD = btcDir(bf, idx);
      if (!btcD || btcD !== dir) continue;

      // Entry at day i open
      const sp = SP[pair + "USDT"] ?? 4e-4;
      const ep = dir === "long" ? curBar.o * (1 + sp) : curBar.o * (1 - sp);

      // ATR-based SL
      const atrIdx = prevIdx - (pd.daily.length - pd.atr.length);
      const atrVal = atrIdx >= 0 && atrIdx < pd.atr.length ? pd.atr[atrIdx] : null;
      if (!atrVal) continue;

      const sl = dir === "long"
        ? ep - cfg.atrMult * atrVal
        : ep + cfg.atrMult * atrVal;

      // Cap SL at 3.5% from entry
      const maxSlDist = ep * 0.035;
      const slCapped = dir === "long"
        ? Math.max(sl, ep - maxSlDist)
        : Math.min(sl, ep + maxSlDist);

      positions.set(key, {
        pair, dir, ep, et: dayTs, sl: slCapped,
        atrAtEntry: atrVal, peakPnl: 0, tag: cfg.tag,
      });
    }
  }

  // Close remaining positions at last price
  for (const [, pos] of positions) {
    const pd = pairData.get(pos.pair)!;
    const lastBar = pd.daily[pd.daily.length - 1];
    const sp = SP[pos.pair + "USDT"] ?? 4e-4;
    const xp = pos.dir === "long" ? lastBar.c * (1 - sp) : lastBar.c * (1 + sp);
    const notional = opts.margin * opts.lev;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    trades.push({
      pair: pos.pair, pnl: raw - notional * FEE * 2,
      et: pos.et, xt: lastBar.t, dir: pos.dir, reason: "open", tag: pos.tag,
    });
  }

  return { trades, skipped };
}

// ── Metric helpers ──
function metrics(trades: Trade[], startTs: number, endTs: number) {
  const days = (endTs - startTs) / DAY;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
  const avgWin = wins > 0 ? trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const avgLoss = losses > 0 ? trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / losses : 0;
  const pf = avgLoss !== 0 ? Math.abs(avgWin * wins / (avgLoss * losses)) : Infinity;

  // Equity curve & drawdown
  let cum = 0, peak = 0, maxDD = 0;
  const eqCurve: { t: number; eq: number }[] = [];
  for (const t of trades.sort((a, b) => a.xt - b.xt)) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
    eqCurve.push({ t: t.xt, eq: cum });
  }

  // Daily returns for Sharpe
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dailyPnl.set(d, (dailyPnl.get(d) || 0) + t.pnl);
  }
  const dr = [...dailyPnl.values()];
  const avg = dr.length > 0 ? dr.reduce((s, r) => s + r, 0) / dr.length : 0;
  const std = dr.length > 1 ? Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / (dr.length - 1)) : 0;
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  return { pnl, wins, losses, wr, pf, sharpe, maxDD, perDay: pnl / days, trades: trades.length, eqCurve, days };
}

// ── MAIN ──
console.log("Loading 5m candles and aggregating to daily...\n");

const pairData = new Map<string, { daily: DC[]; atr: number[] }>();
for (const p of [...PAIRS]) {
  const raw = load5m(p);
  if (raw.length < 1000) { console.log(`  SKIP ${p}: only ${raw.length} 5m bars`); continue; }
  const daily = toDailyCandles(raw);
  const atr = computeATR(daily, 14);
  pairData.set(p, { daily, atr });
}

// BTC filter
const btcPd = pairData.get("BTC")!;
const bf = buildBtcFilter(btcPd.daily);

console.log(`Loaded ${pairData.size} pairs, BTC has ${btcPd.daily.length} daily bars`);
console.log(`OOS period: 2025-09-01 to 2026-03-26 (${((END - OOS_START) / DAY).toFixed(0)} days)\n`);

// ═══════════════════════════════════════════════════
// TEST 1: Max Concurrent Positions
// ═══════════════════════════════════════════════════
console.log("=".repeat(80));
console.log("TEST 1: MAX CONCURRENT POSITIONS (30d/15d/ATR x3)");
console.log("=".repeat(80));

const baseCfg: DonchianCfg = { entryLb: 30, exitLb: 15, atrMult: 3, tag: "base" };
const posLimits = [3, 5, 8, 10, 15, 999];

console.log("\nMaxPos  Trades  Skipped  WR%    PF     Sharpe  MaxDD   $/day    TotalPnL");
console.log("-".repeat(80));

for (const maxP of posLimits) {
  const { trades, skipped } = sim(baseCfg, { maxPositions: maxP, margin: 10, lev: 10 }, pairData, bf, OOS_START, END);
  const m = metrics(trades, OOS_START, END);
  const label = maxP >= 999 ? "unlim" : String(maxP);
  console.log(
    `${label.padStart(5)}   ${String(m.trades).padStart(6)}  ${String(skipped).padStart(7)}  ` +
    `${m.wr.toFixed(1).padStart(5)}  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(6)}  ` +
    `$${m.maxDD.toFixed(0).padStart(5)}  $${m.perDay.toFixed(2).padStart(6)}  ` +
    `${(m.pnl >= 0 ? "+" : "")}$${m.pnl.toFixed(0)}`
  );
}

// ═══════════════════════════════════════════════════
// TEST 2: Ensemble of Parameter Sets
// ═══════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("TEST 2: ENSEMBLE OF PARAMETER SETS ($3.33 margin each)");
console.log("=".repeat(80));

const fastCfg: DonchianCfg = { entryLb: 20, exitLb: 10, atrMult: 2.5, tag: "fast" };
const medCfg: DonchianCfg = { entryLb: 30, exitLb: 15, atrMult: 3, tag: "medium" };
const slowCfg: DonchianCfg = { entryLb: 50, exitLb: 25, atrMult: 3.5, tag: "slow" };

const ensembleMargin = 10 / 3;  // $3.33 each

console.log("\n--- Individual performance ---\n");
console.log("ParamSet     Trades  WR%    PF     Sharpe  MaxDD   $/day    TotalPnL");
console.log("-".repeat(75));

const allEnsembleTrades: Trade[] = [];

for (const cfg of [fastCfg, medCfg, slowCfg]) {
  const { trades } = sim(cfg, { maxPositions: 0, margin: ensembleMargin, lev: 10 }, pairData, bf, OOS_START, END);
  const m = metrics(trades, OOS_START, END);
  allEnsembleTrades.push(...trades);
  console.log(
    `${cfg.tag.padEnd(12)} ${String(m.trades).padStart(6)}  ` +
    `${m.wr.toFixed(1).padStart(5)}  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(6)}  ` +
    `$${m.maxDD.toFixed(0).padStart(5)}  $${m.perDay.toFixed(2).padStart(6)}  ` +
    `${(m.pnl >= 0 ? "+" : "")}$${m.pnl.toFixed(0)}`
  );
}

const em = metrics(allEnsembleTrades, OOS_START, END);
console.log("-".repeat(75));
console.log(
  `${"COMBINED".padEnd(12)} ${String(em.trades).padStart(6)}  ` +
  `${em.wr.toFixed(1).padStart(5)}  ${em.pf.toFixed(2).padStart(5)}  ${em.sharpe.toFixed(2).padStart(6)}  ` +
  `$${em.maxDD.toFixed(0).padStart(5)}  $${em.perDay.toFixed(2).padStart(6)}  ` +
  `${(em.pnl >= 0 ? "+" : "")}$${em.pnl.toFixed(0)}`
);

// Compare to single medium config at $10 margin
const { trades: singleTrades } = sim(medCfg, { maxPositions: 0, margin: 10, lev: 10 }, pairData, bf, OOS_START, END);
const sm = metrics(singleTrades, OOS_START, END);
console.log(
  `${"Med@$10".padEnd(12)} ${String(sm.trades).padStart(6)}  ` +
  `${sm.wr.toFixed(1).padStart(5)}  ${sm.pf.toFixed(2).padStart(5)}  ${sm.sharpe.toFixed(2).padStart(6)}  ` +
  `$${sm.maxDD.toFixed(0).padStart(5)}  $${sm.perDay.toFixed(2).padStart(6)}  ` +
  `${(sm.pnl >= 0 ? "+" : "")}$${sm.pnl.toFixed(0)}`
);

// ═══════════════════════════════════════════════════
// TEST 3: Drawdown Analysis
// ═══════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("TEST 3: DRAWDOWN ANALYSIS (30d/15d/ATR x3, BTC filter + ATR trail)");
console.log("=".repeat(80));

const { trades: ddTrades } = sim(baseCfg, { maxPositions: 0, margin: 10, lev: 10 }, pairData, bf, OOS_START, END);
const ddM = metrics(ddTrades, OOS_START, END);
const sortedTrades = [...ddTrades].sort((a, b) => a.xt - b.xt);

// Build daily equity curve (fill all days)
const dailyEq = new Map<number, number>();
let cumPnl = 0;
for (const t of sortedTrades) {
  const d = Math.floor(t.xt / DAY) * DAY;
  cumPnl += t.pnl;
  dailyEq.set(d, cumPnl);
}

// Forward-fill equity for all days in range
const allDays: number[] = [];
for (let d = OOS_START; d < END; d += DAY) allDays.push(d);
const eqArr: { t: number; eq: number }[] = [];
let lastEq = 0;
for (const d of allDays) {
  if (dailyEq.has(d)) lastEq = dailyEq.get(d)!;
  eqArr.push({ t: d, eq: lastEq });
}

// Find drawdown periods > $50
interface DDPeriod { startT: number; endT: number; depth: number; recoveryT: number | null }
const ddPeriods: DDPeriod[] = [];
let peak = 0, ddStart = 0, inDD = false;
for (const e of eqArr) {
  if (e.eq > peak) {
    if (inDD && peak - e.eq < peak - (ddPeriods[ddPeriods.length - 1]?.depth ?? 0)) {
      // recovered
    }
    peak = e.eq;
    if (inDD) {
      ddPeriods[ddPeriods.length - 1].recoveryT = e.t;
      inDD = false;
    }
  }
  const dd = peak - e.eq;
  if (dd > 50 && !inDD) {
    inDD = true;
    ddStart = e.t;
    ddPeriods.push({ startT: ddStart, endT: e.t, depth: dd, recoveryT: null });
  }
  if (inDD) {
    const cur = ddPeriods[ddPeriods.length - 1];
    cur.endT = e.t;
    if (dd > cur.depth) cur.depth = dd;
  }
}

// Recompute drawdowns properly
const ddPeriodsClean: DDPeriod[] = [];
{
  let pk = 0, started = -1, maxDd = 0, inDd = false;
  for (let i = 0; i < eqArr.length; i++) {
    const e = eqArr[i];
    if (e.eq >= pk) {
      if (inDd && maxDd > 50) {
        ddPeriodsClean.push({ startT: started, endT: eqArr[i - 1].t, depth: maxDd, recoveryT: e.t });
      }
      pk = e.eq;
      inDd = false;
      maxDd = 0;
    } else {
      const dd = pk - e.eq;
      if (!inDd) { started = e.t; inDd = true; }
      if (dd > maxDd) maxDd = dd;
    }
  }
  if (inDd && maxDd > 50) {
    ddPeriodsClean.push({ startT: started, endT: eqArr[eqArr.length - 1].t, depth: maxDd, recoveryT: null });
  }
}

console.log(`\nMax Drawdown: $${ddM.maxDD.toFixed(2)}`);
console.log(`Average Drawdown (periods >$50): $${ddPeriodsClean.length > 0 ? (ddPeriodsClean.reduce((s, d) => s + d.depth, 0) / ddPeriodsClean.length).toFixed(2) : "N/A"}`);

if (ddPeriodsClean.length > 0) {
  const maxDDPeriod = ddPeriodsClean.reduce((a, b) => a.depth > b.depth ? a : b);
  const maxDDDuration = (maxDDPeriod.endT - maxDDPeriod.startT) / DAY;
  const recoveryDays = maxDDPeriod.recoveryT
    ? ((maxDDPeriod.recoveryT - maxDDPeriod.startT) / DAY).toFixed(0)
    : "not recovered";
  console.log(`Max Drawdown Duration: ${maxDDDuration.toFixed(0)} days`);
  console.log(`Max DD Recovery Time: ${recoveryDays} days`);
}

console.log(`\nDrawdown periods >$50:`);
if (ddPeriodsClean.length === 0) {
  console.log("  None found");
} else {
  console.log("  Start        End          Depth   Duration  Recovery");
  console.log("  " + "-".repeat(65));
  for (const d of ddPeriodsClean) {
    const s = new Date(d.startT).toISOString().slice(0, 10);
    const e = new Date(d.endT).toISOString().slice(0, 10);
    const dur = ((d.endT - d.startT) / DAY).toFixed(0);
    const rec = d.recoveryT ? ((d.recoveryT - d.startT) / DAY).toFixed(0) + "d" : "ongoing";
    console.log(`  ${s}   ${e}   $${d.depth.toFixed(0).padStart(5)}   ${dur.padStart(5)}d    ${rec}`);
  }
}

// Monthly return distribution
const monthlyPnl = new Map<string, number>();
for (const t of sortedTrades) {
  const m = new Date(t.xt).toISOString().slice(0, 7);
  monthlyPnl.set(m, (monthlyPnl.get(m) || 0) + t.pnl);
}
const monthVals = [...monthlyPnl.values()];
monthVals.sort((a, b) => a - b);
const monthMean = monthVals.reduce((s, v) => s + v, 0) / monthVals.length;
const monthMedian = monthVals[Math.floor(monthVals.length / 2)];
const monthStd = Math.sqrt(monthVals.reduce((s, v) => s + (v - monthMean) ** 2, 0) / Math.max(monthVals.length - 1, 1));

console.log("\nMonthly Return Distribution:");
console.log(`  Mean:   $${monthMean.toFixed(2)}`);
console.log(`  Median: $${monthMedian.toFixed(2)}`);
console.log(`  Std:    $${monthStd.toFixed(2)}`);
console.log(`  Worst:  $${monthVals[0].toFixed(2)}`);
console.log(`  Best:   $${monthVals[monthVals.length - 1].toFixed(2)}`);

console.log("\n  Month      PnL      Trades");
console.log("  " + "-".repeat(35));
for (const [m, p] of [...monthlyPnl.entries()].sort()) {
  const cnt = sortedTrades.filter(t => new Date(t.xt).toISOString().slice(0, 7) === m).length;
  console.log(`  ${m}   ${(p >= 0 ? "+" : "")}$${p.toFixed(2).padStart(8)}   ${String(cnt).padStart(4)}`);
}

// Longest losing streak
let maxStreak = 0, curStreak = 0;
for (const t of sortedTrades) {
  if (t.pnl <= 0) { curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
  else curStreak = 0;
}
console.log(`\nLongest consecutive losing streak: ${maxStreak} trades`);

// ═══════════════════════════════════════════════════
// TEST 4: Risk Budget (Leverage)
// ═══════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("TEST 4: RISK BUDGET - LEVERAGE LEVELS ($10 margin)");
console.log("=".repeat(80));

const levLevels = [3, 5, 7, 10, 15, 20];

console.log("\nLev   Trades  WR%    PF     Sharpe  MaxDD     $/day    TotalPnL");
console.log("-".repeat(70));

for (const lev of levLevels) {
  const { trades } = sim(baseCfg, { maxPositions: 0, margin: 10, lev }, pairData, bf, OOS_START, END);
  const m = metrics(trades, OOS_START, END);
  console.log(
    `${String(lev).padStart(3)}x  ${String(m.trades).padStart(6)}  ` +
    `${m.wr.toFixed(1).padStart(5)}  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(6)}  ` +
    `$${m.maxDD.toFixed(0).padStart(7)}  $${m.perDay.toFixed(2).padStart(7)}  ` +
    `${(m.pnl >= 0 ? "+" : "")}$${m.pnl.toFixed(0)}`
  );
}

// ═══════════════════════════════════════════════════
// TEST 5: Capital Efficiency
// ═══════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("TEST 5: CAPITAL EFFICIENCY ($50 total, 10x leverage)");
console.log("=".repeat(80));

// Determine best 5 and best 10 pairs by individual OOS performance
const pairPerf: { pair: string; pnl: number }[] = [];
for (const pair of [...pairData.keys()].filter(p => p !== "BTC")) {
  const { trades } = sim(baseCfg, { maxPositions: 0, margin: 10, lev: 10, allowedPairs: [pair] }, pairData, bf, OOS_START, END);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  pairPerf.push({ pair, pnl });
}
pairPerf.sort((a, b) => b.pnl - a.pnl);

console.log("\nPer-pair OOS performance (30d/15d/ATR x3, $10 margin):");
for (const p of pairPerf) {
  console.log(`  ${p.pair.padEnd(8)} ${(p.pnl >= 0 ? "+" : "")}$${p.pnl.toFixed(2)}`);
}

const top5 = pairPerf.slice(0, 5).map(p => p.pair);
const top10 = pairPerf.slice(0, 10).map(p => p.pair);
const all18 = pairPerf.map(p => p.pair);

console.log(`\nBest 5: ${top5.join(", ")}`);
console.log(`Best 10: ${top10.join(", ")}`);

const allocations = [
  { name: "5 pairs x $10", pairs: top5, margin: 10 },
  { name: "10 pairs x $5", pairs: top10, margin: 5 },
  { name: `${all18.length} pairs x $${(50 / all18.length).toFixed(2)}`, pairs: all18, margin: 50 / all18.length },
];

console.log("\nAllocation         Pairs  Trades  WR%    PF     Sharpe  MaxDD   $/day    TotalPnL");
console.log("-".repeat(85));

for (const a of allocations) {
  const { trades } = sim(baseCfg, { maxPositions: 0, margin: a.margin, lev: 10, allowedPairs: a.pairs }, pairData, bf, OOS_START, END);
  const m = metrics(trades, OOS_START, END);
  console.log(
    `${a.name.padEnd(18)} ${String(a.pairs.length).padStart(5)}  ${String(m.trades).padStart(6)}  ` +
    `${m.wr.toFixed(1).padStart(5)}  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(6)}  ` +
    `$${m.maxDD.toFixed(0).padStart(5)}  $${m.perDay.toFixed(2).padStart(6)}  ` +
    `${(m.pnl >= 0 ? "+" : "")}$${m.pnl.toFixed(0)}`
  );
}

console.log("\nDone.");
