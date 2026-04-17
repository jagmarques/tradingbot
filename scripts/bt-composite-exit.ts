/**
 * Composite Exit Signal Research
 *
 * Hypothesis: individual exit signals are ~50/50, but 3-4+ agreeing
 * simultaneously might be 65%+ accurate at predicting reversals.
 *
 * Generates Donchian SMA(20/50) + Supertrend(14,1.75) trades on 14 pairs.
 * At each 4h bar during a trade that's in profit, computes 6 signals and
 * tests composite score thresholds (N=2,3,4,5) vs baseline.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-composite-exit.ts
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
const MARGIN = 5;
const LEV = 10;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, AVAX: 2.55e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const WANTED_PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE", "APT",
  "LINK", "ADA", "WLD", "XRP", "UNI", "SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-28").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string; engine: string; dir: Dir;
  ep: number; et: number; sl: number;
  atr: number; bestPnlAtr: number;
}

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number;
  exitReason: string;
  compositeScore: number; // score at exit (-1 if not composite exit)
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
function sma(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) r[i] = sum / period;
  }
  return r;
}

function ema(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  let v = 0;
  let seeded = false;
  for (let i = 0; i < vals.length; i++) {
    if (!seeded) {
      v += vals[i];
      if (i === period - 1) {
        v /= period;
        seeded = true;
        r[i] = v;
      }
    } else {
      v = vals[i] * k + v * (1 - k);
      r[i] = v;
    }
  }
  return r;
}

function atr(bars: Bar[], period: number): (number | null)[] {
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

function rsi(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return r;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  r[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    r[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return r;
}

function supertrend(bars: Bar[], atrPeriod: number, mult: number): { trend: (1 | -1 | null)[] } {
  const atrVals = atr(bars, atrPeriod);
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

function donchianLow(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mn = Infinity;
    for (let j = i - period; j < i; j++) mn = Math.min(mn, closes[j]);
    r[i] = mn;
  }
  return r;
}

function donchianHigh(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mx = -Infinity;
    for (let j = i - period; j < i; j++) mx = Math.max(mx, closes[j]);
    r[i] = mx;
  }
  return r;
}

// ─── Data Prep ──────────────────────────────────────────────────────
interface PairData {
  m5: C[]; h4: Bar[]; daily: Bar[];
  h4Map: Map<number, number>; dailyMap: Map<number, number>;
  // Pre-computed 4h indicators for composite signals
  h4Ema9: (number | null)[];
  h4Rsi14: (number | null)[];
  h4Atr14: (number | null)[];
  h4Sma20: (number | null)[];
}

interface BTCData {
  daily: Bar[]; h4: Bar[];
  dailyEma20: (number | null)[]; dailyEma50: (number | null)[];
  h4Ema12: (number | null)[]; h4Ema21: (number | null)[];
  dailyMap: Map<number, number>; h4Map: Map<number, number>;
}

function prepBTC(m5: C[]): BTCData {
  const daily = aggregate(m5, DAY);
  const h4 = aggregate(m5, H4);
  const dc = daily.map(b => b.c);
  const hc = h4.map(b => b.c);
  return {
    daily, h4,
    dailyEma20: ema(dc, 20), dailyEma50: ema(dc, 50),
    h4Ema12: ema(hc, 12), h4Ema21: ema(hc, 21),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
  };
}

function prepPair(m5: C[]): PairData {
  const h4 = aggregate(m5, H4);
  const daily = aggregate(m5, DAY);
  const h4c = h4.map(b => b.c);
  return {
    m5, h4, daily,
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
    h4Ema9: ema(h4c, 9),
    h4Rsi14: rsi(h4c, 14),
    h4Atr14: atr(h4, 14),
    h4Sma20: sma(h4c, 20),
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

// ─── Composite Score Calculation ────────────────────────────────────
// Returns 0-6 score: count of how many warning signals are active
function computeCompositeScore(
  pos: Position,
  h4i: number, // current 4h bar index for the pair
  pd: PairData,
  btc: BTCData,
  h4T: number, // current 4h timestamp
): number {
  let score = 0;

  // Signal 1: BTC 4h momentum negative (BTC 12-bar ROC < 0)
  // For longs, negative BTC momentum = warning; for shorts, positive = warning
  const btcH4i = getBarAtOrBefore(btc.h4, h4T, btc.h4Map, H4);
  if (btcH4i >= 12) {
    const btcRoc = btc.h4[btcH4i].c / btc.h4[btcH4i - 12].c - 1;
    if (pos.dir === "long" && btcRoc < 0) score++;
    if (pos.dir === "short" && btcRoc > 0) score++;
  }

  // Signal 2: Volume declining (current bar range < 50% of 20-bar avg range)
  if (h4i >= 20) {
    const curRange = pd.h4[h4i].h - pd.h4[h4i].l;
    let rangeSum = 0;
    for (let j = h4i - 20; j < h4i; j++) {
      rangeSum += pd.h4[j].h - pd.h4[j].l;
    }
    const avgRange = rangeSum / 20;
    if (avgRange > 0 && curRange < 0.5 * avgRange) score++;
  }

  // Signal 3: Price below 4h EMA(9) (longs losing support) or above (shorts)
  const ema9 = pd.h4Ema9[h4i];
  if (ema9 !== null) {
    if (pos.dir === "long" && pd.h4[h4i].c < ema9) score++;
    if (pos.dir === "short" && pd.h4[h4i].c > ema9) score++;
  }

  // Signal 4: RSI(14) on 4h declining from above 70 (longs) or rising from below 30 (shorts)
  const rsiNow = pd.h4Rsi14[h4i];
  const rsiPrev = h4i > 0 ? pd.h4Rsi14[h4i - 1] : null;
  if (rsiNow !== null && rsiPrev !== null) {
    if (pos.dir === "long" && rsiPrev > 70 && rsiNow < rsiPrev) score++;
    if (pos.dir === "short" && rsiPrev < 30 && rsiNow > rsiPrev) score++;
  }

  // Signal 5: ATR expanding (current ATR > 1.3x 20-bar avg ATR = volatility spike)
  const atrNow = pd.h4Atr14[h4i];
  if (atrNow !== null && h4i >= 20) {
    let atrSum = 0, atrCnt = 0;
    for (let j = h4i - 20; j < h4i; j++) {
      const a = pd.h4Atr14[j];
      if (a !== null) { atrSum += a; atrCnt++; }
    }
    if (atrCnt > 0) {
      const avgAtr = atrSum / atrCnt;
      if (avgAtr > 0 && atrNow > 1.3 * avgAtr) score++;
    }
  }

  // Signal 6: Distance from SMA(20) shrinking (trend losing steam)
  const sma20now = pd.h4Sma20[h4i];
  const sma20prev = h4i > 0 ? pd.h4Sma20[h4i - 1] : null;
  if (sma20now !== null && sma20prev !== null) {
    const distNow = pos.dir === "long"
      ? pd.h4[h4i].c - sma20now
      : sma20now - pd.h4[h4i].c;
    const distPrev = pos.dir === "long"
      ? pd.h4[h4i - 1].c - sma20prev
      : sma20prev - pd.h4[h4i - 1].c;
    // Only count if distance is positive (above SMA for longs) but shrinking
    if (distPrev > 0 && distNow < distPrev) score++;
  }

  return score;
}

// ─── Forward-Looking Accuracy Check ─────────────────────────────────
// After a composite signal fires, did price actually move against the position
// in the next 6 bars (24h)?
interface AccuracyEvent {
  score: number;
  pair: string;
  dir: Dir;
  h4i: number;
  priceAtSignal: number;
  worstPriceNext6: number; // worst price for position in next 6 bars
  bestPriceNext6: number;  // best price for position in next 6 bars
  wasCorrect: boolean;     // did price move against position (signal was right to warn)?
  moveAgainst: number;     // % move against position in next 6 bars
}

// ─── Backtest Runner ────────────────────────────────────────────────
function runBacktest(scoreThreshold: number): {
  trades: Trade[];
  accuracyEvents: AccuracyEvent[];
  label: string;
} {
  const label = scoreThreshold === 0 ? "BASELINE (no composite exit)" : `SCORE >= ${scoreThreshold}`;

  // Load data
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }
  const btc = prepBTC(btcRaw);

  const available: string[] = [];
  const pairData = new Map<string, PairData>();
  for (const p of WANTED_PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 500) continue;
    available.push(p);
    pairData.set(p, prepPair(m5));
  }

  // Pre-compute Engine A indicators (daily SMA 20/50, Donchian 15, daily ATR 14)
  const engA: Map<string, {
    sma20: (number | null)[]; sma50: (number | null)[];
    donLo15: (number | null)[]; donHi15: (number | null)[];
    atr14: (number | null)[];
  }> = new Map();

  // Pre-compute Engine B indicators (4h supertrend, 4h ATR 14)
  const engB: Map<string, {
    st: (1 | -1 | null)[]; atr14: (number | null)[];
  }> = new Map();

  for (const p of available) {
    const pd = pairData.get(p)!;
    const dc = pd.daily.map(b => b.c);
    engA.set(p, {
      sma20: sma(dc, 20),
      sma50: sma(dc, 50),
      donLo15: donchianLow(dc, 15),
      donHi15: donchianHigh(dc, 15),
      atr14: atr(pd.daily, 14),
    });
    engB.set(p, {
      st: supertrend(pd.h4, 14, 1.75).trend,
      atr14: atr(pd.h4, 14),
    });
  }

  // Simulation
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const accuracyEvents: AccuracyEvent[] = [];

  function btcBullish(t: number): boolean {
    const di = getBarAtOrBefore(btc.daily, t - DAY, btc.dailyMap, DAY);
    if (di < 0) return false;
    const e20 = btc.dailyEma20[di], e50 = btc.dailyEma50[di];
    return e20 !== null && e50 !== null && e20 > e50;
  }

  // BTC 4h EMA(12/21) filter
  function btcH4Bullish(t: number): boolean {
    const hi = getBarAtOrBefore(btc.h4, t - H4, btc.h4Map, H4);
    if (hi < 0) return false;
    const e12 = btc.h4Ema12[hi], e21 = btc.h4Ema21[hi];
    return e12 !== null && e21 !== null && e12 > e21;
  }

  function closePosition(key: string, exitPrice: number, exitTime: number, reason: string, slipMult: number = 1, compScore: number = -1) {
    const pos = positions.get(key);
    if (!pos) return;
    const hs = sp(pos.pair);
    const xp = pos.dir === "long"
      ? exitPrice * (1 - hs * slipMult)
      : exitPrice * (1 + hs * slipMult);
    const notional = MARGIN * LEV;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const cost = notional * FEE * 2;
    const pnl = raw - cost;
    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl,
      exitReason: reason, compositeScore: compScore,
    });
    positions.delete(key);
  }

  // Build daily timestamps
  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) {
    dailyTimestamps.push(t);
  }

  for (const dayT of dailyTimestamps) {
    // ─── CHECK EXISTING POSITIONS (at each 4h bar) ────────────────
    for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
      const h4T = dayT + h4Offset;

      for (const [key, pos] of [...positions.entries()]) {
        if (!positions.has(key)) continue; // may have been closed already
        const pd = pairData.get(pos.pair);
        if (!pd) continue;

        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined) continue;
        const bar = pd.h4[h4i];

        // Stop-loss check
        if (pos.dir === "long" && bar.l <= pos.sl) {
          closePosition(key, pos.sl, h4T, "SL", SL_SLIPPAGE);
          continue;
        }
        if (pos.dir === "short" && bar.h >= pos.sl) {
          closePosition(key, pos.sl, h4T, "SL", SL_SLIPPAGE);
          continue;
        }

        // Max hold (60 days)
        if (h4T - pos.et >= 60 * DAY) {
          closePosition(key, bar.c, h4T, "MAX_HOLD");
          continue;
        }

        // ATR trailing stop (3x -> 2x -> 1.5x as profit grows)
        if (pos.atr > 0) {
          const unrealPnl = pos.dir === "long"
            ? (bar.c - pos.ep) / pos.atr
            : (pos.ep - bar.c) / pos.atr;
          if (unrealPnl > pos.bestPnlAtr) pos.bestPnlAtr = unrealPnl;

          let newSl = pos.sl;
          if (pos.bestPnlAtr >= 3) {
            const trailPrice = pos.dir === "long"
              ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
              : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
            newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
          } else if (pos.bestPnlAtr >= 2) {
            const peakPrice = pos.dir === "long"
              ? pos.ep + pos.bestPnlAtr * pos.atr
              : pos.ep - pos.bestPnlAtr * pos.atr;
            const trailPrice = pos.dir === "long"
              ? peakPrice - 2 * pos.atr
              : peakPrice + 2 * pos.atr;
            newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
          } else if (pos.bestPnlAtr >= 1) {
            newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
          }
          pos.sl = newSl;
        }

        // Engine-specific signal exit
        if (pos.engine === "A") {
          const ea = engA.get(pos.pair);
          const di = getBarAtOrBefore(pd.daily, h4T, pd.dailyMap, DAY);
          if (ea && di > 0) {
            if (pos.dir === "long" && ea.donLo15[di] !== null && pd.daily[di].c < ea.donLo15[di]!) {
              closePosition(key, bar.c, h4T, "DONCH_EXIT");
              continue;
            }
            if (pos.dir === "short" && ea.donHi15[di] !== null && pd.daily[di].c > ea.donHi15[di]!) {
              closePosition(key, bar.c, h4T, "DONCH_EXIT");
              continue;
            }
          }
        }

        if (pos.engine === "B") {
          const eb = engB.get(pos.pair);
          if (eb) {
            const stNow = eb.st[h4i];
            if (stNow !== null) {
              if (pos.dir === "long" && stNow === -1) {
                closePosition(key, bar.c, h4T, "ST_FLIP");
                continue;
              }
              if (pos.dir === "short" && stNow === 1) {
                closePosition(key, bar.c, h4T, "ST_FLIP");
                continue;
              }
            }
          }
        }

        // ─── COMPOSITE EXIT: only if score threshold > 0 ──────────
        if (scoreThreshold > 0) {
          // Check if position is in profit
          const unrealPct = pos.dir === "long"
            ? (bar.c - pos.ep) / pos.ep
            : (pos.ep - bar.c) / pos.ep;

          if (unrealPct > 0) {
            const score = computeCompositeScore(pos, h4i, pd, btc, h4T);
            if (score >= scoreThreshold) {
              closePosition(key, bar.c, h4T, "COMPOSITE", 1, score);
              continue;
            }
          }
        }

        // ─── ACCURACY TRACKING (score >= 0 threshold = baseline) ──
        // Always record accuracy events for research, even in baseline
        if (scoreThreshold === 0) {
          const unrealPct = pos.dir === "long"
            ? (bar.c - pos.ep) / pos.ep
            : (pos.ep - bar.c) / pos.ep;
          if (unrealPct > 0 && h4i + 6 < pd.h4.length) {
            const score = computeCompositeScore(pos, h4i, pd, btc, h4T);
            if (score >= 2) { // only track when there's something to measure
              // Look forward 6 bars (24h)
              let worst = bar.c, best = bar.c;
              for (let fwd = 1; fwd <= 6; fwd++) {
                if (h4i + fwd >= pd.h4.length) break;
                const fb = pd.h4[h4i + fwd];
                if (pos.dir === "long") {
                  worst = Math.min(worst, fb.l);
                  best = Math.max(best, fb.h);
                } else {
                  worst = Math.max(worst, fb.h);
                  best = Math.min(best, fb.l);
                }
              }
              const moveAgainst = pos.dir === "long"
                ? (bar.c - worst) / bar.c
                : (worst - bar.c) / bar.c;
              const moveFor = pos.dir === "long"
                ? (best - bar.c) / bar.c
                : (bar.c - best) / bar.c;
              // "Correct" = price moved against position more than it continued
              const wasCorrect = moveAgainst > moveFor;

              accuracyEvents.push({
                score, pair: pos.pair, dir: pos.dir, h4i,
                priceAtSignal: bar.c,
                worstPriceNext6: worst, bestPriceNext6: best,
                wasCorrect, moveAgainst,
              });
            }
          }
        }
      }
    }

    // ─── ENGINE A: Daily Donchian SMA(20/50) entry ──────────────
    for (const p of available) {
      const key = `A:${p}`;
      if (positions.has(key)) continue;

      const pd = pairData.get(p)!;
      const ea = engA.get(p)!;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 51) continue;

      // Use PREVIOUS bar SMA values (no look-ahead)
      const sma20now = ea.sma20[di - 1], sma50now = ea.sma50[di - 1];
      const sma20prev = ea.sma20[di - 2], sma50prev = ea.sma50[di - 2];
      if (sma20now === null || sma50now === null || sma20prev === null || sma50prev === null) continue;

      let dir: Dir | null = null;
      if (sma20prev <= sma50prev && sma20now > sma50now) {
        if (btcBullish(dayT)) dir = "long";
      }
      if (sma20prev >= sma50prev && sma20now < sma50now) {
        dir = "short";
      }
      if (!dir) continue;

      // ATR from DAILY bars (previous bar, no look-ahead)
      const atrVal = ea.atr14[di - 1];
      if (atrVal === null) continue;

      const hs = sp(p);
      const ep = dir === "long" ? pd.daily[di].o * (1 + hs) : pd.daily[di].o * (1 - hs);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(key, {
        pair: p, engine: "A", dir, ep, et: dayT, sl,
        atr: atrVal, bestPnlAtr: 0,
      });
    }

    // ─── ENGINE B: 4h Supertrend(14,1.75) entry ─────────────────
    for (let h4Offset = 0; h4Offset < DAY; h4Offset += H4) {
      const h4T = dayT + h4Offset;
      for (const p of available) {
        const key = `B:${p}`;
        if (positions.has(key)) continue;

        const pd = pairData.get(p)!;
        const eb = engB.get(p)!;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined || h4i < 21) continue;

        const stNow = eb.st[h4i - 1];
        const stPrev = eb.st[h4i - 2];
        if (stNow === null || stPrev === null || stNow === stPrev) continue;

        const dir: Dir = stNow === 1 ? "long" : "short";

        // BTC 4h EMA(12/21) filter for longs
        if (dir === "long" && !btcH4Bullish(h4T)) continue;

        const atrVal = eb.atr14[h4i - 1];
        if (atrVal === null) continue;

        const hs = sp(p);
        const ep = dir === "long" ? pd.h4[h4i].o * (1 + hs) : pd.h4[h4i].o * (1 - hs);
        let slDist = atrVal * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(key, {
          pair: p, engine: "B", dir, ep, et: h4T, sl,
          atr: atrVal, bestPnlAtr: 0,
        });
      }
    }
  }

  // Close remaining
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairData.get(pos.pair);
    if (!pd || pd.h4.length === 0) continue;
    const lastBar = pd.h4[pd.h4.length - 1];
    closePosition(key, lastBar.c, lastBar.t, "END");
  }

  return { trades, accuracyEvents, label };
}

// ─── Giveback Calculation ───────────────────────────────────────────
// Average % of peak unrealized profit given back at actual exit
function computeGiveback(trades: Trade[], pairData: Map<string, PairData>): number {
  let totalGiveback = 0;
  let count = 0;
  for (const t of trades) {
    if (t.pnl <= 0) continue; // only winning trades
    const pd = pairData.get(t.pair);
    if (!pd) continue;

    // Walk 4h bars between entry and exit to find peak
    let peak = 0;
    for (const bar of pd.h4) {
      if (bar.t <= t.et || bar.t > t.xt) continue;
      const unrealPct = t.dir === "long"
        ? (bar.h - t.ep) / t.ep
        : (t.ep - bar.l) / t.ep;
      if (unrealPct > peak) peak = unrealPct;
    }
    if (peak > 0) {
      const actualPct = t.dir === "long"
        ? (t.xp - t.ep) / t.ep
        : (t.ep - t.xp) / t.ep;
      const giveback = 1 - (actualPct / peak);
      totalGiveback += giveback;
      count++;
    }
  }
  return count > 0 ? totalGiveback / count : 0;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  trades: number; pf: number; sharpe: number; perDay: number; wr: number;
  maxDd: number; totalPnl: number; avgPnl: number; winners: number; losers: number;
  avgHoldDays: number;
}

function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return {
    trades: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0,
    maxDd: 0, totalPnl: 0, avgPnl: 0, winners: 0, losers: 0, avgHoldDays: 0,
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

  const avgHold = filtered.reduce((s, t) => s + (t.xt - t.et), 0) / filtered.length / DAY;

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
    avgHoldDays: Math.round(avgHold * 10) / 10,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=".repeat(110));
console.log("  COMPOSITE EXIT SIGNAL RESEARCH");
console.log("  Hypothesis: 3-4+ weak signals agreeing >> any single signal");
console.log("=".repeat(110));
console.log();

// Load pair data once for giveback calc
const pairDataForGiveback = new Map<string, PairData>();
for (const p of WANTED_PAIRS) {
  const m5 = load5m(p);
  if (m5.length >= 500) pairDataForGiveback.set(p, prepPair(m5));
}

// Run baseline first (no composite exit)
console.log("[1/5] Running BASELINE (no composite exit)...");
const baseline = runBacktest(0);
const baseStats = computeStats(baseline.trades, FULL_START, FULL_END);
const baseGiveback = computeGiveback(baseline.trades, pairDataForGiveback);

// Run each threshold
const results: { threshold: number; trades: Trade[]; stats: Stats; giveback: number; label: string }[] = [];
results.push({ threshold: 0, trades: baseline.trades, stats: baseStats, giveback: baseGiveback, label: baseline.label });

for (const threshold of [2, 3, 4, 5]) {
  console.log(`[${threshold}/5] Running SCORE >= ${threshold}...`);
  const run = runBacktest(threshold);
  const stats = computeStats(run.trades, FULL_START, FULL_END);
  const giveback = computeGiveback(run.trades, pairDataForGiveback);
  results.push({ threshold, trades: run.trades, stats, giveback, label: run.label });
}

// ─── Print Results ──────────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  RESULTS: COMPOSITE EXIT THRESHOLD COMPARISON");
console.log("=".repeat(110));

const hdr = [
  "Variant".padEnd(30),
  "Trades".padStart(7),
  "PF".padStart(6),
  "Sharpe".padStart(7),
  "$/day".padStart(8),
  "WR%".padStart(7),
  "MaxDD".padStart(8),
  "Total$".padStart(10),
  "AvgPnl".padStart(8),
  "Giveback".padStart(9),
  "AvgHold".padStart(8),
].join(" ");
console.log(hdr);
console.log("-".repeat(110));

for (const r of results) {
  const s = r.stats;
  const line = [
    r.label.padEnd(30),
    String(s.trades).padStart(7),
    s.pf.toFixed(2).padStart(6),
    s.sharpe.toFixed(2).padStart(7),
    ("$" + s.perDay.toFixed(2)).padStart(8),
    (s.wr.toFixed(1) + "%").padStart(7),
    ("$" + s.maxDd.toFixed(0)).padStart(8),
    ((s.totalPnl >= 0 ? "+" : "") + "$" + s.totalPnl.toFixed(2)).padStart(10),
    ("$" + s.avgPnl.toFixed(2)).padStart(8),
    ((r.giveback * 100).toFixed(1) + "%").padStart(9),
    (s.avgHoldDays.toFixed(1) + "d").padStart(8),
  ].join(" ");
  console.log(line);
}

// ─── Delta vs Baseline ──────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  DELTA VS BASELINE");
console.log("=".repeat(110));

const bline = results[0].stats;
const bGb = results[0].giveback;
console.log(
  "Variant".padEnd(30) +
  "dTrades".padStart(8) +
  "dPF".padStart(7) +
  "d$/day".padStart(9) +
  "dWR%".padStart(8) +
  "dMaxDD".padStart(9) +
  "dTotal$".padStart(10) +
  "dGiveback".padStart(10)
);
console.log("-".repeat(110));

for (const r of results.slice(1)) {
  const s = r.stats;
  const dt = s.trades - bline.trades;
  const dpf = s.pf - bline.pf;
  const dpd = s.perDay - bline.perDay;
  const dwr = s.wr - bline.wr;
  const ddd = s.maxDd - bline.maxDd;
  const dtot = s.totalPnl - bline.totalPnl;
  const dgb = (r.giveback - bGb) * 100;
  const fmt = (v: number, prefix: string = "") => {
    const sign = v >= 0 ? "+" : "";
    return (sign + prefix + v.toFixed(2)).padStart(prefix ? 10 : 8);
  };
  console.log(
    r.label.padEnd(30) +
    (dt >= 0 ? "+" : "") + String(dt).padStart(7) +
    fmt(dpf) +
    fmt(dpd, "$") +
    ((dwr >= 0 ? "+" : "") + dwr.toFixed(1) + "%").padStart(8) +
    fmt(ddd, "$") +
    fmt(dtot, "$") +
    ((dgb >= 0 ? "+" : "") + dgb.toFixed(1) + "pp").padStart(10)
  );
}

// ─── Per-Signal Accuracy Analysis (from baseline run) ───────────────
console.log("\n" + "=".repeat(110));
console.log("  SIGNAL ACCURACY: forward-looking 24h accuracy by composite score");
console.log("  'Correct' = price moved MORE against position than it continued");
console.log("=".repeat(110));

const accuracyByScore = new Map<number, { total: number; correct: number; avgMoveAgainst: number }>();
for (const ev of baseline.accuracyEvents) {
  let entry = accuracyByScore.get(ev.score);
  if (!entry) { entry = { total: 0, correct: 0, avgMoveAgainst: 0 }; accuracyByScore.set(ev.score, entry); }
  entry.total++;
  if (ev.wasCorrect) entry.correct++;
  entry.avgMoveAgainst += ev.moveAgainst;
}

console.log(
  "Score".padEnd(10) +
  "Events".padStart(8) +
  "Correct".padStart(9) +
  "Accuracy".padStart(10) +
  "AvgMoveAgainst".padStart(16)
);
console.log("-".repeat(55));

for (const score of [2, 3, 4, 5, 6]) {
  const entry = accuracyByScore.get(score);
  if (!entry) {
    console.log(`Score ${score}`.padEnd(10) + "0".padStart(8) + "-".padStart(9) + "-".padStart(10) + "-".padStart(16));
    continue;
  }
  const acc = entry.total > 0 ? (entry.correct / entry.total * 100) : 0;
  const avgMove = entry.total > 0 ? (entry.avgMoveAgainst / entry.total * 100) : 0;
  console.log(
    `Score ${score}`.padEnd(10) +
    String(entry.total).padStart(8) +
    String(entry.correct).padStart(9) +
    (acc.toFixed(1) + "%").padStart(10) +
    (avgMove.toFixed(2) + "%").padStart(16)
  );
}

// Cumulative (score >= N)
console.log("\n" + "Cumulative (score >= N):");
console.log("-".repeat(55));
for (const minScore of [2, 3, 4, 5]) {
  let total = 0, correct = 0, moveSum = 0;
  for (const [sc, entry] of accuracyByScore) {
    if (sc >= minScore) {
      total += entry.total;
      correct += entry.correct;
      moveSum += entry.avgMoveAgainst;
    }
  }
  const acc = total > 0 ? (correct / total * 100) : 0;
  const avgMove = total > 0 ? (moveSum / total * 100) : 0;
  console.log(
    `>= ${minScore}`.padEnd(10) +
    String(total).padStart(8) +
    String(correct).padStart(9) +
    (acc.toFixed(1) + "%").padStart(10) +
    (avgMove.toFixed(2) + "%").padStart(16)
  );
}

// ─── Exit Reason Breakdown ──────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  EXIT REASON BREAKDOWN (per threshold)");
console.log("=".repeat(110));

for (const r of results) {
  const reasons = new Map<string, { count: number; pnl: number }>();
  for (const t of r.trades) {
    let entry = reasons.get(t.exitReason);
    if (!entry) { entry = { count: 0, pnl: 0 }; reasons.set(t.exitReason, entry); }
    entry.count++;
    entry.pnl += t.pnl;
  }
  console.log(`\n  ${r.label}:`);
  console.log("  " + "Reason".padEnd(16) + "Count".padStart(7) + "P&L".padStart(10) + "Avg".padStart(8));
  console.log("  " + "-".repeat(43));
  for (const [reason, data] of [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      "  " + reason.padEnd(16) +
      String(data.count).padStart(7) +
      ("$" + data.pnl.toFixed(2)).padStart(10) +
      ("$" + (data.pnl / data.count).toFixed(2)).padStart(8)
    );
  }
}

// ─── Per-Engine Breakdown ───────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  PER-ENGINE BREAKDOWN (baseline vs best composite)");
console.log("=".repeat(110));

for (const engine of ["A", "B"]) {
  for (const r of [results[0], results[2]]) { // baseline and score>=3
    const engTrades = r.trades.filter(t => t.engine === engine);
    const wins = engTrades.filter(t => t.pnl > 0).length;
    const total = engTrades.length;
    const pnl = engTrades.reduce((s, t) => s + t.pnl, 0);
    const wr = total > 0 ? (wins / total * 100) : 0;
    console.log(
      `  Engine ${engine} [${r.label}]: ` +
      `${total} trades, WR ${wr.toFixed(1)}%, P&L $${pnl.toFixed(2)}`
    );
  }
  console.log();
}

console.log("\nDone.");
