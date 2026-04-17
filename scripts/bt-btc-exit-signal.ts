/**
 * BTC Exit Signal Research
 *
 * Hypothesis: BTC leads altcoin reversals. If BTC peaks before alts,
 * we can use BTC drawdown as an early exit signal for alt positions.
 *
 * 1. Generate Supertrend(14,1.75) trades on 14 altcoin pairs (4h bars)
 * 2. For each trade, find peak on 5m bars
 * 3. Check BTC peak timing vs altcoin peak timing
 * 4. Test BTC drawdown % thresholds as exit signals
 * 5. Test BTC 1h Supertrend(10,1.5) flip as exit signal
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-btc-exit-signal.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const SIZE = 5; // $5 margin per trade
const NOT = SIZE * LEV; // $50 notional

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};
const DFLT_SPREAD = 4e-4;

const ALT_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA",
  "DOGE","APT","LINK","ADA","WLD","XRP","UNI",
];

// 15 pairs = the live set minus the ones not in 5m cache
// WIF cache starts later, keep it but note it

const START = new Date("2025-06-01").getTime();
const END   = new Date("2026-03-20").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
type Dir = "long" | "short";

interface Trade {
  pair: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number;
  pnl: number; reason: string;
  altPeakT: number; altPeakP: number;
  btcPeakT: number; btcPeakP: number;
  btcLeadH: number; // hours BTC peaked before alt (negative = BTC peaked after)
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c,
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(candles: C[], period: number): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const bars: C[] = [];
  for (const [t, cs] of groups) {
    if (cs.length === 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (const c of cs) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
    }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators (SMA-seeded, no look-ahead) ─────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i-1].c),
      Math.abs(cs[i].l - cs[i-1].c),
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j-1].c), Math.abs(cs[j].l - cs[j-1].c));
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
    }
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

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      const prevUpper = (cs[i-1].h + cs[i-1].l) / 2 + mult * atr[i-1];
      const prevLower = (cs[i-1].h + cs[i-1].l) / 2 - mult * atr[i-1];
      const prevFinalUpper = st[i-1] > 0 && dirs[i-1] === -1 ? st[i-1] : prevUpper;
      const prevFinalLower = st[i-1] > 0 && dirs[i-1] === 1 ? st[i-1] : prevLower;

      if (!(lowerBand > prevFinalLower || cs[i-1].c < prevFinalLower)) {
        lowerBand = prevFinalLower;
      }
      if (!(upperBand < prevFinalUpper || cs[i-1].c > prevFinalUpper)) {
        upperBand = prevFinalUpper;
      }
    }

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i-1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }

    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
}

// ─── PnL calc ───────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: Dir, isSL: boolean): number {
  const sp = SPREAD[pair] ?? DFLT_SPREAD;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

// ─── Find peak price on 5m bars within a time window ────────────────
function findPeak5m(
  candles5m: C[],
  startTs: number,
  endTs: number,
  dir: Dir,
): { peakPrice: number; peakTime: number } {
  let peakPrice = dir === "long" ? -Infinity : Infinity;
  let peakTime = startTs;

  for (const c of candles5m) {
    if (c.t < startTs) continue;
    if (c.t > endTs) break;
    if (dir === "long") {
      if (c.h > peakPrice) { peakPrice = c.h; peakTime = c.t; }
    } else {
      if (c.l < peakPrice) { peakPrice = c.l; peakTime = c.t; }
    }
  }

  return { peakPrice, peakTime };
}

// ─── BTC EMA filter (daily, for longs only) ─────────────────────────
function buildBtcFilter(btcDaily: C[]): { ema20: number[]; ema50: number[] } {
  const closes = btcDaily.map(c => c.c);
  return {
    ema20: calcEMA(closes, 20),
    ema50: calcEMA(closes, 50),
  };
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("Loading 5m data...");

// Load all 5m data
const raw5m = new Map<string, C[]>();
for (const pair of [...ALT_PAIRS, "BTC"]) {
  const data = load5m(pair);
  if (data.length > 0) raw5m.set(pair, data);
}

console.log(`Loaded ${raw5m.size} pairs, aggregating to 4h + 1h...`);

// Aggregate to 4h for Supertrend signals
const data4h = new Map<string, C[]>();
for (const [pair, cs] of raw5m) {
  data4h.set(pair, aggregate(cs, H4));
}

// Aggregate BTC to 1h for Supertrend(10,1.5) exit test
const btc1h = aggregate(raw5m.get("BTC")!, H1);
const btcSt1h = calcSupertrend(btc1h, 10, 1.5);
// Build a quick lookup: timestamp -> dir
const btc1hDirMap = new Map<number, number>();
for (let i = 0; i < btc1h.length; i++) {
  btc1hDirMap.set(btc1h[i].t, btcSt1h.dir[i]);
}

// BTC daily for EMA filter
const btcDaily = aggregate(raw5m.get("BTC")!, DAY);
const btcFilter = buildBtcFilter(btcDaily);

// ─── Generate baseline Supertrend(14,1.75) trades ───────────────────
console.log("Generating Supertrend(14,1.75) trades with ATR stop...");

const ST_PERIOD = 14;
const ST_MULT = 1.75;
const MAX_HOLD = 60 * DAY;
const MAX_SL_PCT = 0.035; // 3.5% cap

interface ActivePos {
  pair: string; dir: Dir; ep: number; et: number;
  sl: number; bestPnlAtr: number; atrAtEntry: number;
}

const allTrades: Trade[] = [];

for (const pair of ALT_PAIRS) {
  const cs4h = data4h.get(pair);
  const cs5m = raw5m.get(pair);
  const btc5m = raw5m.get("BTC")!;
  if (!cs4h || !cs5m || cs4h.length < ST_PERIOD + 20) continue;

  const { dir: stDir } = calcSupertrend(cs4h, ST_PERIOD, ST_MULT);
  const atr4h = calcATR(cs4h, ST_PERIOD);
  let pos: ActivePos | null = null;

  for (let i = ST_PERIOD + 1; i < cs4h.length; i++) {
    if (cs4h[i].t < START && !pos) continue;
    if (cs4h[i].t > END && !pos) continue;

    const prevDir = stDir[i - 1];
    const prevPrevDir = i >= 2 ? stDir[i - 2] : prevDir;
    const flipped = prevDir !== prevPrevDir;

    // Exit logic
    if (pos) {
      const bar = cs4h[i];
      const curATR = atr4h[i - 1];
      let xp = 0;
      let reason = "";

      // ATR trailing stop (3x -> 2x -> 1.5x)
      if (curATR > 0) {
        const pnlAtr = pos.dir === "long"
          ? (bar.h - pos.ep) / curATR
          : (pos.ep - bar.l) / curATR;
        if (pnlAtr > pos.bestPnlAtr) pos.bestPnlAtr = pnlAtr;

        let trailMult = 3;
        if (pos.bestPnlAtr >= 4) trailMult = 2;
        if (pos.bestPnlAtr >= 6) trailMult = 1.5;

        if (pos.dir === "long") {
          const trailSL = bar.h - trailMult * curATR;
          const effectiveSL = Math.max(pos.sl, trailSL);
          if (bar.l <= effectiveSL) {
            xp = effectiveSL;
            reason = "trail";
          }
        } else {
          const trailSL = bar.l + trailMult * curATR;
          const effectiveSL = Math.min(pos.sl, trailSL);
          if (bar.h >= effectiveSL) {
            xp = effectiveSL;
            reason = "trail";
          }
        }
      }

      // Initial SL hit
      if (!reason) {
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
      }

      // Supertrend flip exit
      if (!reason && flipped) { xp = bar.o; reason = "flip"; }

      // Max hold
      if (!reason && bar.t - pos.et >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

      if (xp > 0) {
        const pnl = tradePnl(pair, pos.ep, xp, pos.dir, reason === "sl" || reason === "trail");

        // Find peaks on 5m
        const altPeak = findPeak5m(cs5m, pos.et, bar.t, pos.dir);
        const btcPeak = findPeak5m(btc5m, pos.et, bar.t, pos.dir);
        const btcLeadH = (altPeak.peakTime - btcPeak.peakTime) / H1;

        allTrades.push({
          pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
          pnl, reason,
          altPeakT: altPeak.peakTime, altPeakP: altPeak.peakPrice,
          btcPeakT: btcPeak.peakTime, btcPeakP: btcPeak.peakPrice,
          btcLeadH,
        });
        pos = null;
      }
    }

    // Entry logic
    if (!pos && flipped && cs4h[i].t >= START && cs4h[i].t < END) {
      const newDir: Dir = prevDir === 1 ? "long" : "short";

      // BTC daily EMA filter for longs only
      if (newDir === "long") {
        let btcDayIdx = -1;
        for (let b = btcDaily.length - 1; b >= 0; b--) {
          if (btcDaily[b].t <= cs4h[i].t) { btcDayIdx = b; break; }
        }
        if (btcDayIdx >= 50) {
          // Use previous bar's values (no look-ahead)
          const btcTrend = btcFilter.ema20[btcDayIdx - 1] > btcFilter.ema50[btcDayIdx - 1] ? "long" : "short";
          if (btcTrend !== "long") continue;
        }
      }

      const ep = cs4h[i].o;
      const curATR = atr4h[i - 1];
      const atrStop = curATR * 3;
      const pctStop = ep * MAX_SL_PCT;
      const stopDist = Math.min(atrStop, pctStop);
      const sl = newDir === "long" ? ep - stopDist : ep + stopDist;

      pos = { pair, dir: newDir, ep, et: cs4h[i].t, sl, bestPnlAtr: 0, atrAtEntry: curATR };
    }
  }

  // Close open position at end
  if (pos && pos.et >= START && pos.et < END) {
    const lastBar = cs4h[cs4h.length - 1];
    const cs5mArr = raw5m.get(pair)!;
    const btc5mArr = raw5m.get("BTC")!;
    const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
    const altPeak = findPeak5m(cs5mArr, pos.et, lastBar.t, pos.dir);
    const btcPeak = findPeak5m(btc5mArr, pos.et, lastBar.t, pos.dir);
    const btcLeadH = (altPeak.peakTime - btcPeak.peakTime) / H1;
    allTrades.push({
      pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c,
      et: pos.et, xt: lastBar.t, pnl, reason: "end",
      altPeakT: altPeak.peakTime, altPeakP: altPeak.peakPrice,
      btcPeakT: btcPeak.peakTime, btcPeakP: btcPeak.peakPrice,
      btcLeadH,
    });
  }
}

allTrades.sort((a, b) => a.et - b.et);

// ─── Section 1: Baseline Stats ──────────────────────────────────────
const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
const wins = allTrades.filter(t => t.pnl > 0).length;
const days = (END - START) / DAY;
let cum = 0, peak = 0, maxDD = 0;
for (const t of allTrades) {
  cum += t.pnl;
  if (cum > peak) peak = cum;
  if (peak - cum > maxDD) maxDD = peak - cum;
}

console.log("\n=== BASELINE: Supertrend(14,1.75) 4h + ATR trail + BTC EMA filter ===");
console.log(`Trades: ${allTrades.length}  WR: ${(wins/allTrades.length*100).toFixed(1)}%  PnL: $${totalPnl.toFixed(2)}  $/day: $${(totalPnl/days).toFixed(2)}  MaxDD: $${maxDD.toFixed(2)}`);
console.log(`Exit reasons: ${(() => {
  const m = new Map<string, number>();
  for (const t of allTrades) m.set(t.reason, (m.get(t.reason) ?? 0) + 1);
  return [...m.entries()].map(([r, n]) => `${r}:${n}`).join(" ");
})()}`);

// ─── Section 2: BTC Lead Time Analysis ──────────────────────────────
console.log("\n=== BTC LEAD TIME ANALYSIS ===");
console.log("(Positive = BTC peaked BEFORE alt, negative = BTC peaked AFTER alt)\n");

const btcLeadFirst = allTrades.filter(t => t.btcLeadH > 0);
const btcSame = allTrades.filter(t => Math.abs(t.btcLeadH) <= 1);
const btcLagged = allTrades.filter(t => t.btcLeadH < 0);

console.log(`BTC peaked FIRST:  ${btcLeadFirst.length} / ${allTrades.length} (${(btcLeadFirst.length/allTrades.length*100).toFixed(1)}%)`);
console.log(`BTC peaked SAME:   ${btcSame.length} / ${allTrades.length} (${(btcSame.length/allTrades.length*100).toFixed(1)}%) (within 1h)`);
console.log(`BTC peaked AFTER:  ${btcLagged.length} / ${allTrades.length} (${(btcLagged.length/allTrades.length*100).toFixed(1)}%)`);

if (btcLeadFirst.length > 0) {
  const leads = btcLeadFirst.map(t => t.btcLeadH).sort((a, b) => a - b);
  const median = leads[Math.floor(leads.length / 2)];
  const mean = leads.reduce((s, v) => s + v, 0) / leads.length;
  const p25 = leads[Math.floor(leads.length * 0.25)];
  const p75 = leads[Math.floor(leads.length * 0.75)];
  console.log(`\nWhen BTC leads: mean=${mean.toFixed(1)}h  median=${median.toFixed(1)}h  p25=${p25.toFixed(1)}h  p75=${p75.toFixed(1)}h`);
}

// Lead time distribution histogram
console.log("\nLead time distribution (hours, BTC before alt):");
const buckets = [
  { label: "< -48h", min: -Infinity, max: -48 },
  { label: "-48 to -24h", min: -48, max: -24 },
  { label: "-24 to -12h", min: -24, max: -12 },
  { label: " -12 to -4h", min: -12, max: -4 },
  { label: "  -4 to  0h", min: -4, max: 0 },
  { label: "   0 to  4h", min: 0, max: 4 },
  { label: "   4 to 12h", min: 4, max: 12 },
  { label: "  12 to 24h", min: 12, max: 24 },
  { label: "  24 to 48h", min: 24, max: 48 },
  { label: " > 48h", min: 48, max: Infinity },
];

for (const b of buckets) {
  const cnt = allTrades.filter(t => t.btcLeadH > b.min && t.btcLeadH <= b.max).length;
  const bar = "#".repeat(Math.round(cnt / allTrades.length * 60));
  console.log(`  ${b.label.padEnd(14)} ${String(cnt).padStart(4)} ${(cnt/allTrades.length*100).toFixed(1).padStart(5)}%  ${bar}`);
}

// ─── Section 3: Longs vs Shorts split ───────────────────────────────
console.log("\nBy direction:");
for (const dir of ["long", "short"] as Dir[]) {
  const sub = allTrades.filter(t => t.dir === dir);
  const lead = sub.filter(t => t.btcLeadH > 0);
  const leads = lead.map(t => t.btcLeadH);
  const med = leads.length > 0 ? leads.sort((a, b) => a - b)[Math.floor(leads.length / 2)] : 0;
  console.log(`  ${dir.padEnd(6)}: ${sub.length} trades, BTC leads ${lead.length} (${(lead.length/sub.length*100).toFixed(1)}%), median lead: ${med.toFixed(1)}h`);
}

// ─── Section 4: BTC Drawdown Exit Signal ────────────────────────────
console.log("\n=== BTC DRAWDOWN EXIT SIGNAL TEST ===");
console.log("If BTC drops X% from its running high since alt entry, exit alt position.\n");

const btc5m = raw5m.get("BTC")!;

// Build BTC 5m binary search index
const btc5mTimes = btc5m.map(c => c.t);
function bisect(arr: number[], target: number): number {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function testBtcDrawdownExit(drawdownPct: number): {
  pnl: number; trades: number; wins: number; exitedEarly: number;
  avgSaved: number; maxDD: number;
} {
  let totalPnl = 0;
  let totalWins = 0;
  let exitedEarly = 0;
  let savedSum = 0;
  const pnls: number[] = [];

  for (const trade of allTrades) {
    // Simulate: track BTC running high from alt entry time
    const startIdx = bisect(btc5mTimes, trade.et);
    const endIdx = bisect(btc5mTimes, trade.xt);

    let btcRunHigh = btc5m[startIdx]?.c ?? 0;
    let btcRunLow = btc5m[startIdx]?.c ?? Infinity;
    let earlyExitTime = 0;
    let earlyExitAltPrice = 0;

    // For longs, BTC dropping is bearish -> exit
    // For shorts, BTC pumping is bullish -> exit
    for (let j = startIdx; j <= endIdx && j < btc5m.length; j++) {
      if (trade.dir === "long") {
        if (btc5m[j].h > btcRunHigh) btcRunHigh = btc5m[j].h;
        const dd = (btcRunHigh - btc5m[j].l) / btcRunHigh;
        if (dd >= drawdownPct / 100) {
          earlyExitTime = btc5m[j].t;
          break;
        }
      } else {
        if (btc5m[j].l < btcRunLow) btcRunLow = btc5m[j].l;
        const pump = (btc5m[j].h - btcRunLow) / btcRunLow;
        if (pump >= drawdownPct / 100) {
          earlyExitTime = btc5m[j].t;
          break;
        }
      }
    }

    if (earlyExitTime > 0 && earlyExitTime < trade.xt) {
      // Find alt price at early exit time on 5m
      const altCs = raw5m.get(trade.pair)!;
      const altTimes = altCs.map(c => c.t);
      const altIdx = bisect(altTimes, earlyExitTime);
      earlyExitAltPrice = altCs[Math.min(altIdx, altCs.length - 1)]?.c ?? trade.xp;

      const sp = SPREAD[trade.pair] ?? DFLT_SPREAD;
      const exitPrice = trade.dir === "long"
        ? earlyExitAltPrice * (1 - sp)
        : earlyExitAltPrice * (1 + sp);
      const newPnl = trade.dir === "long"
        ? (exitPrice / trade.ep - 1) * NOT - NOT * FEE * 2
        : (trade.ep / exitPrice - 1) * NOT - NOT * FEE * 2;

      totalPnl += newPnl;
      pnls.push(newPnl);
      if (newPnl > 0) totalWins++;
      exitedEarly++;
      savedSum += newPnl - trade.pnl; // positive = exit was better
    } else {
      // Keep original trade
      totalPnl += trade.pnl;
      pnls.push(trade.pnl);
      if (trade.pnl > 0) totalWins++;
    }
  }

  // MaxDD
  let c2 = 0, p2 = 0, dd2 = 0;
  for (const p of pnls) {
    c2 += p;
    if (c2 > p2) p2 = c2;
    if (p2 - c2 > dd2) dd2 = p2 - c2;
  }

  return {
    pnl: totalPnl,
    trades: allTrades.length,
    wins: totalWins,
    exitedEarly,
    avgSaved: exitedEarly > 0 ? savedSum / exitedEarly : 0,
    maxDD: dd2,
  };
}

const ddTests = [0.5, 1, 1.5, 2, 3, 5];
console.log("Threshold  Exited  PnL       $/day   WR%    MaxDD   Avg$/exit  vs Baseline");
console.log("-".repeat(85));

for (const dd of ddTests) {
  const r = testBtcDrawdownExit(dd);
  const diff = r.pnl - totalPnl;
  const diffStr = diff >= 0 ? `+$${diff.toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
  console.log(
    `  ${dd.toFixed(1)}%`.padEnd(11) +
    `${r.exitedEarly}/${r.trades}`.padEnd(9) +
    `$${r.pnl.toFixed(2)}`.padStart(9) +
    `  $${(r.pnl/days).toFixed(2)}`.padStart(8) +
    `  ${(r.wins/r.trades*100).toFixed(1)}%`.padStart(7) +
    `  $${r.maxDD.toFixed(2)}`.padStart(8) +
    `  $${r.avgSaved.toFixed(2)}`.padStart(10) +
    `  ${diffStr}`.padStart(12)
  );
}

// ─── Section 5: BTC 1h Supertrend Flip Exit ─────────────────────────
console.log("\n=== BTC 1h SUPERTREND(10,1.5) FLIP EXIT ===");
console.log("Exit alt when BTC 1h Supertrend flips against the alt's direction.\n");

function testBtcStFlipExit(): {
  pnl: number; trades: number; wins: number; exitedEarly: number;
  avgSaved: number; maxDD: number;
} {
  let totalPnl = 0;
  let totalWins = 0;
  let exitedEarly = 0;
  let savedSum = 0;
  const pnls: number[] = [];

  for (const trade of allTrades) {
    // Find the first BTC 1h Supertrend flip against our direction after entry
    let earlyExitTime = 0;

    // Walk 1h bars from entry
    const startIdx = bisect(btc1h.map(c => c.t), trade.et);
    for (let j = startIdx + 1; j < btc1h.length; j++) {
      if (btc1h[j].t >= trade.xt) break;

      const curDir = btcSt1h.dir[j];
      const prevDir = btcSt1h.dir[j - 1];
      if (curDir !== prevDir) {
        // Flip happened
        const newBtcDir = curDir === 1 ? "long" : "short";
        if (trade.dir === "long" && newBtcDir === "short") {
          earlyExitTime = btc1h[j].t;
          break;
        }
        if (trade.dir === "short" && newBtcDir === "long") {
          earlyExitTime = btc1h[j].t;
          break;
        }
      }
    }

    if (earlyExitTime > 0 && earlyExitTime < trade.xt) {
      const altCs = raw5m.get(trade.pair)!;
      const altTimes = altCs.map(c => c.t);
      const altIdx = bisect(altTimes, earlyExitTime);
      const exitAltPrice = altCs[Math.min(altIdx, altCs.length - 1)]?.c ?? trade.xp;

      const sp = SPREAD[trade.pair] ?? DFLT_SPREAD;
      const exitPrice = trade.dir === "long"
        ? exitAltPrice * (1 - sp)
        : exitAltPrice * (1 + sp);
      const newPnl = trade.dir === "long"
        ? (exitPrice / trade.ep - 1) * NOT - NOT * FEE * 2
        : (trade.ep / exitPrice - 1) * NOT - NOT * FEE * 2;

      totalPnl += newPnl;
      pnls.push(newPnl);
      if (newPnl > 0) totalWins++;
      exitedEarly++;
      savedSum += newPnl - trade.pnl;
    } else {
      totalPnl += trade.pnl;
      pnls.push(trade.pnl);
      if (trade.pnl > 0) totalWins++;
    }
  }

  let c2 = 0, p2 = 0, dd2 = 0;
  for (const p of pnls) {
    c2 += p;
    if (c2 > p2) p2 = c2;
    if (p2 - c2 > dd2) dd2 = p2 - c2;
  }

  return { pnl: totalPnl, trades: allTrades.length, wins: totalWins, exitedEarly, avgSaved: exitedEarly > 0 ? savedSum / exitedEarly : 0, maxDD: dd2 };
}

const stResult = testBtcStFlipExit();
const stDiff = stResult.pnl - totalPnl;
console.log(`Exited early: ${stResult.exitedEarly} / ${stResult.trades}`);
console.log(`PnL: $${stResult.pnl.toFixed(2)}  $/day: $${(stResult.pnl/days).toFixed(2)}  WR: ${(stResult.wins/stResult.trades*100).toFixed(1)}%  MaxDD: $${stResult.maxDD.toFixed(2)}`);
console.log(`Avg $/early exit: $${stResult.avgSaved.toFixed(2)}  vs Baseline: ${stDiff >= 0 ? "+" : ""}$${stDiff.toFixed(2)}`);

// ─── Section 6: Only exit losing trades that could be saved ─────────
console.log("\n=== CONDITIONAL BTC EXIT: Only exit when trade is still in profit ===");
console.log("Only apply BTC drawdown exit if the alt position is currently profitable.\n");

function testConditionalBtcExit(drawdownPct: number): {
  pnl: number; trades: number; wins: number; exitedEarly: number;
  avgSaved: number; maxDD: number;
} {
  let totalPnl = 0;
  let totalWins = 0;
  let exitedEarly = 0;
  let savedSum = 0;
  const pnls: number[] = [];

  for (const trade of allTrades) {
    const startIdx = bisect(btc5mTimes, trade.et);
    const endIdx = bisect(btc5mTimes, trade.xt);

    let btcRunHigh = btc5m[startIdx]?.c ?? 0;
    let btcRunLow = btc5m[startIdx]?.c ?? Infinity;
    let earlyExitTime = 0;

    const altCs = raw5m.get(trade.pair)!;
    const altTimes = altCs.map(c => c.t);

    for (let j = startIdx; j <= endIdx && j < btc5m.length; j++) {
      let triggered = false;
      if (trade.dir === "long") {
        if (btc5m[j].h > btcRunHigh) btcRunHigh = btc5m[j].h;
        const dd = (btcRunHigh - btc5m[j].l) / btcRunHigh;
        if (dd >= drawdownPct / 100) triggered = true;
      } else {
        if (btc5m[j].l < btcRunLow) btcRunLow = btc5m[j].l;
        const pump = (btc5m[j].h - btcRunLow) / btcRunLow;
        if (pump >= drawdownPct / 100) triggered = true;
      }

      if (triggered) {
        // Check if alt is in profit at this point
        const altIdx = bisect(altTimes, btc5m[j].t);
        const altPrice = altCs[Math.min(altIdx, altCs.length - 1)]?.c ?? trade.ep;
        const altPnlPct = trade.dir === "long"
          ? (altPrice - trade.ep) / trade.ep
          : (trade.ep - altPrice) / trade.ep;

        if (altPnlPct > 0) {
          earlyExitTime = btc5m[j].t;
          break;
        }
        // If in loss, don't exit on BTC signal (let SL handle it)
      }
    }

    if (earlyExitTime > 0 && earlyExitTime < trade.xt) {
      const altIdx = bisect(altTimes, earlyExitTime);
      const exitAltPrice = altCs[Math.min(altIdx, altCs.length - 1)]?.c ?? trade.xp;

      const sp = SPREAD[trade.pair] ?? DFLT_SPREAD;
      const exitPrice = trade.dir === "long"
        ? exitAltPrice * (1 - sp)
        : exitAltPrice * (1 + sp);
      const newPnl = trade.dir === "long"
        ? (exitPrice / trade.ep - 1) * NOT - NOT * FEE * 2
        : (trade.ep / exitPrice - 1) * NOT - NOT * FEE * 2;

      totalPnl += newPnl;
      pnls.push(newPnl);
      if (newPnl > 0) totalWins++;
      exitedEarly++;
      savedSum += newPnl - trade.pnl;
    } else {
      totalPnl += trade.pnl;
      pnls.push(trade.pnl);
      if (trade.pnl > 0) totalWins++;
    }
  }

  let c2 = 0, p2 = 0, dd2 = 0;
  for (const p of pnls) {
    c2 += p;
    if (c2 > p2) p2 = c2;
    if (p2 - c2 > dd2) dd2 = p2 - c2;
  }

  return { pnl: totalPnl, trades: allTrades.length, wins: totalWins, exitedEarly, avgSaved: exitedEarly > 0 ? savedSum / exitedEarly : 0, maxDD: dd2 };
}

console.log("Threshold  Exited  PnL       $/day   WR%    MaxDD   Avg$/exit  vs Baseline");
console.log("-".repeat(85));

for (const dd of ddTests) {
  const r = testConditionalBtcExit(dd);
  const diff = r.pnl - totalPnl;
  const diffStr = diff >= 0 ? `+$${diff.toFixed(2)}` : `-$${Math.abs(diff).toFixed(2)}`;
  console.log(
    `  ${dd.toFixed(1)}%`.padEnd(11) +
    `${r.exitedEarly}/${r.trades}`.padEnd(9) +
    `$${r.pnl.toFixed(2)}`.padStart(9) +
    `  $${(r.pnl/days).toFixed(2)}`.padStart(8) +
    `  ${(r.wins/r.trades*100).toFixed(1)}%`.padStart(7) +
    `  $${r.maxDD.toFixed(2)}`.padStart(8) +
    `  $${r.avgSaved.toFixed(2)}`.padStart(10) +
    `  ${diffStr}`.padStart(12)
  );
}

// ─── Section 7: Per-pair breakdown for best signal ──────────────────
console.log("\n=== PER-PAIR BTC LEAD ANALYSIS ===\n");
console.log("Pair      Trades  BTC leads  %Lead   Median-h  Avg PnL");
console.log("-".repeat(60));

for (const pair of ALT_PAIRS) {
  const sub = allTrades.filter(t => t.pair === pair);
  if (sub.length === 0) continue;
  const leads = sub.filter(t => t.btcLeadH > 0);
  const leadHours = leads.map(t => t.btcLeadH).sort((a, b) => a - b);
  const med = leadHours.length > 0 ? leadHours[Math.floor(leadHours.length / 2)] : 0;
  const avgPnl = sub.reduce((s, t) => s + t.pnl, 0) / sub.length;
  console.log(
    `${pair.padEnd(9)} ${String(sub.length).padStart(6)}  ${String(leads.length).padStart(9)}  ${(leads.length/sub.length*100).toFixed(1).padStart(5)}%  ${med.toFixed(1).padStart(8)}h  $${avgPnl.toFixed(2)}`
  );
}

// ─── Section 8: Winning vs losing trades lead time ──────────────────
console.log("\n=== BTC LEAD: WINNERS vs LOSERS ===\n");

const winners = allTrades.filter(t => t.pnl > 0);
const losers = allTrades.filter(t => t.pnl <= 0);

for (const [label, group] of [["Winners", winners], ["Losers", losers]] as const) {
  const leads = group.filter(t => t.btcLeadH > 0);
  const leadH = leads.map(t => t.btcLeadH).sort((a, b) => a - b);
  const med = leadH.length > 0 ? leadH[Math.floor(leadH.length / 2)] : 0;
  const mean = leadH.length > 0 ? leadH.reduce((s, v) => s + v, 0) / leadH.length : 0;
  console.log(`${label}: ${group.length} trades, BTC leads ${leads.length} (${(leads.length/group.length*100).toFixed(1)}%), median lead: ${med.toFixed(1)}h, mean: ${mean.toFixed(1)}h`);
}

console.log("\n=== VERDICT ===\n");
const leadPct = btcLeadFirst.length / allTrades.length * 100;
if (leadPct > 60) {
  console.log(`BTC leads altcoin peaks ${leadPct.toFixed(0)}% of the time - signal has potential.`);
} else if (leadPct > 45) {
  console.log(`BTC leads altcoin peaks ${leadPct.toFixed(0)}% of the time - roughly coin-flip, weak signal.`);
} else {
  console.log(`BTC leads altcoin peaks only ${leadPct.toFixed(0)}% of the time - hypothesis not supported.`);
}

const best = ddTests.map(d => ({ d, r: testBtcDrawdownExit(d) })).sort((a, b) => b.r.pnl - a.r.pnl)[0];
const bestDiff = best.r.pnl - totalPnl;
if (bestDiff > 0) {
  console.log(`Best BTC drawdown exit (${best.d}%): +$${bestDiff.toFixed(2)} improvement over baseline.`);
} else {
  console.log(`No BTC drawdown threshold improves over baseline. Best: ${best.d}% at ${bestDiff >= 0 ? "+" : ""}$${bestDiff.toFixed(2)}.`);
}

if (stDiff > 0) {
  console.log(`BTC 1h ST flip exit: +$${stDiff.toFixed(2)} improvement.`);
} else {
  console.log(`BTC 1h ST flip exit: ${stDiff >= 0 ? "+" : ""}$${stDiff.toFixed(2)}, does not improve.`);
}
