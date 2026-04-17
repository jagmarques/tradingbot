/**
 * Time-Decay Exit Research
 *
 * Generates Donchian SMA(20/50) + Supertrend(14,1.75) trades on 14 pairs using 5m data.
 * Then tracks per-trade peak PnL on 1m bars and tests "time since last new high" exits.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && \
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-time-decay-exit.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const CACHE_1M = "/tmp/bt-pair-cache-1m";
const M1 = 60_000;
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const MARGIN = 5;
const NOTIONAL = MARGIN * LEV; // $50
const SL_CAP = 0.035;
const MAX_HOLD_MS = 60 * DAY;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4,
  OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP",
];

const START = new Date("2023-06-01").getTime();
const END = new Date("2026-03-23").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface RawTrade {
  pair: string;
  engine: string;
  dir: Dir;
  ep: number;    // entry price (after spread)
  et: number;    // entry time
  sl: number;    // stop-loss price
  atr: number;   // ATR at entry
  xp: number;    // exit price (baseline)
  xt: number;    // exit time (baseline)
  pnl: number;   // baseline PnL (already deducted fees)
  exitReason: string;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function load1m(pair: string): C[] {
  const fp = path.join(CACHE_1M, `${pair}USDT.json`);
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
  // Seed with SMA of first `period` values
  let seedSum = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i < period) {
      seedSum += vals[i];
      if (i === period - 1) {
        r[i] = seedSum / period;
      }
    } else {
      const k = 2 / (period + 1);
      const prev = r[i - 1]!;
      r[i] = vals[i] * k + prev * (1 - k);
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
  // Wilder smoothing
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
  m5: C[];
  h4: Bar[];
  daily: Bar[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
}

interface BTCData {
  h4: Bar[];
  h4Ema12: (number | null)[];
  h4Ema21: (number | null)[];
  h4Map: Map<number, number>;
}

function prepBTC(m5: C[]): BTCData {
  const h4 = aggregate(m5, H4);
  const hc = h4.map(b => b.c);
  return {
    h4,
    h4Ema12: ema(hc, 12),
    h4Ema21: ema(hc, 21),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
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

function getBarAtOrBefore(barMap: Map<number, number>, t: number, period: number): number {
  const aligned = Math.floor(t / period) * period;
  const idx = barMap.get(aligned);
  if (idx !== undefined) return idx;
  for (let dt = period; dt <= 10 * period; dt += period) {
    const idx2 = barMap.get(aligned - dt);
    if (idx2 !== undefined) return idx2;
  }
  return -1;
}

// ─── Trade Generation (5m resolution, same for all overlays) ────────
function generateTrades(pairData: Map<string, PairData>, btc: BTCData): RawTrade[] {
  // Pre-compute indicators
  const engA = new Map<string, {
    sma20: (number | null)[]; sma50: (number | null)[];
    donLo15: (number | null)[]; donHi15: (number | null)[];
    atr14: (number | null)[];
  }>();
  const engB = new Map<string, {
    st: (1 | -1 | null)[]; atr14: (number | null)[];
  }>();

  for (const [p, pd] of pairData) {
    if (p === "BTC") continue;
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

  // BTC 4h EMA(12/21) bullish filter
  function btcH4Bullish(t: number): boolean {
    const h4i = getBarAtOrBefore(btc.h4Map, t - H4, H4);
    if (h4i < 0) return false;
    const e12 = btc.h4Ema12[h4i], e21 = btc.h4Ema21[h4i];
    return e12 !== null && e21 !== null && e12 > e21;
  }

  interface Pos {
    pair: string;
    engine: string;
    dir: Dir;
    ep: number;
    et: number;
    sl: number;
    atr: number;
    bestPnlAtr: number;
  }

  const positions = new Map<string, Pos>();
  const trades: RawTrade[] = [];

  // Build daily timestamps
  const dailyTs: number[] = [];
  for (let t = START; t < END; t += DAY) dailyTs.push(t);

  function closePos(key: string, exitPrice: number, exitTime: number, reason: string, slipMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sp(pos.pair) * slipMult;
    const xp = pos.dir === "long" ? exitPrice * (1 - sp_) : exitPrice * (1 + sp_);
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * NOTIONAL
      : (pos.ep / xp - 1) * NOTIONAL;
    const cost = NOTIONAL * FEE * 2;
    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, et: pos.et, sl: pos.sl, atr: pos.atr,
      xp, xt: exitTime, pnl: raw - cost, exitReason: reason,
    });
    positions.delete(key);
  }

  for (const dayT of dailyTs) {
    // ─── EXIT CHECK ─────────────────────────────────────────────
    for (const [key, pos] of [...positions.entries()]) {
      const pd = pairData.get(pos.pair);
      if (!pd) continue;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;
      const bar = pd.daily[di];

      // Stop-loss (intraday touch)
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePos(key, pos.sl, dayT, "sl", 1.5);
        continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closePos(key, pos.sl, dayT, "sl", 1.5);
        continue;
      }

      // Max hold
      if (dayT - pos.et >= MAX_HOLD_MS) {
        closePos(key, bar.c, dayT, "maxhold");
        continue;
      }

      // ATR trailing stop management (3x -> 2x -> 1.5x as profit grows)
      if (pos.atr > 0) {
        const unrealAtr = pos.dir === "long"
          ? (bar.c - pos.ep) / pos.atr
          : (pos.ep - bar.c) / pos.atr;
        if (unrealAtr > pos.bestPnlAtr) pos.bestPnlAtr = unrealAtr;

        let newSl = pos.sl;
        if (pos.bestPnlAtr >= 3) {
          const trail = pos.dir === "long"
            ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
            : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
          newSl = pos.dir === "long" ? Math.max(pos.sl, trail) : Math.min(pos.sl, trail);
        } else if (pos.bestPnlAtr >= 2) {
          const trail = pos.dir === "long"
            ? bar.h - 2 * pos.atr
            : bar.l + 2 * pos.atr;
          newSl = pos.dir === "long" ? Math.max(pos.sl, trail) : Math.min(pos.sl, trail);
        } else if (pos.bestPnlAtr >= 1) {
          newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
        }
        pos.sl = newSl;
      }

      // Engine A: Donchian channel exit
      if (pos.engine === "A") {
        const ea = engA.get(pos.pair);
        if (ea && di > 0) {
          if (pos.dir === "long" && ea.donLo15[di] !== null && bar.c < ea.donLo15[di]!) {
            closePos(key, bar.c, dayT, "donch");
            continue;
          }
          if (pos.dir === "short" && ea.donHi15[di] !== null && bar.c > ea.donHi15[di]!) {
            closePos(key, bar.c, dayT, "donch");
            continue;
          }
        }
      }

      // Engine B: Supertrend flip exit
      if (pos.engine === "B") {
        for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
          const h4T = dayT + h4Off;
          const eb = engB.get(pos.pair);
          if (!eb) continue;
          const h4i = pd.h4Map.get(h4T);
          if (h4i === undefined || h4i < 2) continue;
          const stNow = eb.st[h4i - 1];
          if (stNow === null) continue;
          // Flip against position
          if (pos.dir === "long" && stNow === -1) {
            const h4Bar = pd.h4[h4i];
            if (h4Bar) closePos(key, h4Bar.o, h4T, "stflip");
            break;
          }
          if (pos.dir === "short" && stNow === 1) {
            const h4Bar = pd.h4[h4i];
            if (h4Bar) closePos(key, h4Bar.o, h4T, "stflip");
            break;
          }
        }
      }
    }

    // ─── ENGINE A: Daily SMA(20/50) Cross ───────────────────────
    for (const p of PAIRS) {
      const key = `A:${p}`;
      if (positions.has(key)) continue;

      const pd = pairData.get(p);
      if (!pd) continue;
      const ea = engA.get(p);
      if (!ea) continue;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 51) continue;

      // i-1 = completed bar, i-2 = previous completed bar (no look-ahead)
      const sma20now = ea.sma20[di - 1], sma50now = ea.sma50[di - 1];
      const sma20prev = ea.sma20[di - 2], sma50prev = ea.sma50[di - 2];
      if (sma20now === null || sma50now === null || sma20prev === null || sma50prev === null) continue;

      let dir: Dir | null = null;
      // Golden cross: SMA20 crosses above SMA50
      if (sma20prev <= sma50prev && sma20now > sma50now) {
        if (btcH4Bullish(dayT)) dir = "long";
      }
      // Death cross (no BTC filter for shorts)
      if (sma20prev >= sma50prev && sma20now < sma50now) {
        dir = "short";
      }
      if (!dir) continue;

      // ATR-based stop from DAILY bars
      const atrVal = ea.atr14[di - 1];
      if (atrVal === null) continue;

      const sp_ = sp(p);
      const bar = pd.daily[di];
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > SL_CAP) slDist = ep * SL_CAP;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(key, {
        pair: p, engine: "A", dir, ep, et: dayT, sl, atr: atrVal, bestPnlAtr: 0,
      });
    }

    // ─── ENGINE B: 4h Supertrend(14, 1.75) Flip ────────────────
    for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
      const h4T = dayT + h4Off;
      for (const p of PAIRS) {
        const key = `B:${p}`;
        if (positions.has(key)) continue;

        const pd = pairData.get(p);
        if (!pd) continue;
        const eb = engB.get(p);
        if (!eb) continue;
        const h4i = pd.h4Map.get(h4T);
        if (h4i === undefined || h4i < 21) continue;

        // Supertrend flip on completed bars (i-1 vs i-2)
        const stNow = eb.st[h4i - 1];
        const stPrev = eb.st[h4i - 2];
        if (stNow === null || stPrev === null || stNow === stPrev) continue;

        const dir: Dir = stNow === 1 ? "long" : "short";
        // BTC EMA filter for longs only
        if (dir === "long" && !btcH4Bullish(h4T)) continue;

        const atrVal = eb.atr14[h4i - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p);
        const pd2 = pairData.get(p)!;
        const h4Bar = pd2.h4[h4i];
        if (!h4Bar) continue;
        const ep = dir === "long" ? h4Bar.o * (1 + sp_) : h4Bar.o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > SL_CAP) slDist = ep * SL_CAP;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(key, {
          pair: p, engine: "B", dir, ep, et: h4T, sl, atr: atrVal, bestPnlAtr: 0,
        });
      }
    }
  }

  // Close remaining
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairData.get(pos.pair);
    if (!pd || pd.daily.length === 0) continue;
    const last = pd.daily[pd.daily.length - 1];
    closePos(key, last.c, last.t, "end");
  }

  return trades;
}

// ─── 1m Peak Tracking ───────────────────────────────────────────────
interface TradeMinuteProfile {
  tradeIdx: number;
  peakLevPnlPct: number;    // highest leveraged PnL% ever reached
  // For each minute bar: { t, levPnlPct, peakSoFar, hoursSincePeak }
  minuteCurve: { t: number; pnl: number; peak: number; hSincePeak: number }[];
}

function buildMinuteProfiles(trades: RawTrade[], m1bars: C[]): TradeMinuteProfile[] {
  const profiles: TradeMinuteProfile[] = [];

  for (let ti = 0; ti < trades.length; ti++) {
    const trade = trades[ti];

    if (m1bars.length === 0) {
      profiles.push({ tradeIdx: ti, peakLevPnlPct: 0, minuteCurve: [] });
      continue;
    }

    // Binary search for start index
    let lo = 0, hi = m1bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (m1bars[mid].t < trade.et) lo = mid + 1; else hi = mid;
    }

    const curve: { t: number; pnl: number; peak: number; hSincePeak: number }[] = [];
    let peak = 0;
    let peakTime = trade.et;

    for (let i = lo; i < m1bars.length; i++) {
      const bar = m1bars[i];
      if (bar.t > trade.xt) break;

      // Use close price for PnL tracking
      const levPnl = trade.dir === "long"
        ? (bar.c - trade.ep) / trade.ep * LEV * 100
        : (trade.ep - bar.c) / trade.ep * LEV * 100;

      if (levPnl > peak) {
        peak = levPnl;
        peakTime = bar.t;
      }

      const hSincePeak = (bar.t - peakTime) / H1;
      curve.push({ t: bar.t, pnl: levPnl, peak, hSincePeak });
    }

    profiles.push({ tradeIdx: ti, peakLevPnlPct: peak, minuteCurve: curve });
  }

  return profiles;
}

// ─── Time-Decay Exit Overlays ───────────────────────────────────────
interface OverlayResult {
  name: string;
  totalPnl: number;
  perDay: number;
  maxDD: number;
  tradesAffected: number;
  totalTrades: number;
  avgGivebackPct: number;  // avg peak-to-exit giveback on affected trades
  netVsBaseline: number;
}

// Flat N-hour: exit if no new peak for N hours (only when in profit AND peak >= 20%)
function applyFlatDecay(
  trades: RawTrade[],
  profiles: TradeMinuteProfile[],
  nHours: number,
  days: number,
): OverlayResult {
  let totalPnl = 0;
  let cum = 0, eqPeak = 0, maxDD = 0;
  let affected = 0;
  let givebackSum = 0;

  for (let ti = 0; ti < trades.length; ti++) {
    const trade = trades[ti];
    const prof = profiles[ti];

    let pnl = trade.pnl; // default: baseline PnL
    let wasAffected = false;

    if (prof.minuteCurve.length > 0) {
      // Scan minute curve for exit trigger
      for (const pt of prof.minuteCurve) {
        // Only trigger when position is in profit AND peak >= 20% leveraged
        if (pt.peak >= 20 && pt.pnl > 0 && pt.hSincePeak >= nHours) {
          // Exit here
          const exitPnl = pt.pnl / 100 / LEV * NOTIONAL; // convert lev% back to $
          const cost = NOTIONAL * FEE * 2;
          pnl = exitPnl - cost;
          wasAffected = true;
          const giveback = pt.peak > 0 ? (pt.peak - pt.pnl) / pt.peak * 100 : 0;
          givebackSum += giveback;
          break;
        }
      }
    }

    if (wasAffected) affected++;
    totalPnl += pnl;
    cum += pnl;
    if (cum > eqPeak) eqPeak = cum;
    if (eqPeak - cum > maxDD) maxDD = eqPeak - cum;
  }

  return {
    name: `Flat-${nHours}h`,
    totalPnl,
    perDay: totalPnl / days,
    maxDD,
    tradesAffected: affected,
    totalTrades: trades.length,
    avgGivebackPct: affected > 0 ? givebackSum / affected : 0,
    netVsBaseline: 0, // filled later
  };
}

// Decaying threshold: tighter retention required as time passes since peak
// Schedule: 4h -> 90%, 8h -> 80%, 16h -> 70%, 24h -> 60%
function applyDecayingThreshold(
  trades: RawTrade[],
  profiles: TradeMinuteProfile[],
  days: number,
): OverlayResult {
  const schedule: { hours: number; retain: number }[] = [
    { hours: 4, retain: 0.90 },
    { hours: 8, retain: 0.80 },
    { hours: 16, retain: 0.70 },
    { hours: 24, retain: 0.60 },
  ];

  let totalPnl = 0;
  let cum = 0, eqPeak = 0, maxDD = 0;
  let affected = 0;
  let givebackSum = 0;

  for (let ti = 0; ti < trades.length; ti++) {
    const trade = trades[ti];
    const prof = profiles[ti];

    let pnl = trade.pnl;
    let wasAffected = false;

    if (prof.minuteCurve.length > 0) {
      for (const pt of prof.minuteCurve) {
        // Only when in profit AND peak >= 20% leveraged
        if (pt.peak < 20 || pt.pnl <= 0) continue;

        // Find the applicable threshold
        let triggerRetain: number | null = null;
        for (let s = schedule.length - 1; s >= 0; s--) {
          if (pt.hSincePeak >= schedule[s].hours) {
            triggerRetain = schedule[s].retain;
            break;
          }
        }
        if (triggerRetain === null) continue;

        // Exit if current PnL < peak * retain
        if (pt.pnl < pt.peak * triggerRetain) {
          const exitPnl = pt.pnl / 100 / LEV * NOTIONAL;
          const cost = NOTIONAL * FEE * 2;
          pnl = exitPnl - cost;
          wasAffected = true;
          const giveback = pt.peak > 0 ? (pt.peak - pt.pnl) / pt.peak * 100 : 0;
          givebackSum += giveback;
          break;
        }
      }
    }

    if (wasAffected) affected++;
    totalPnl += pnl;
    cum += pnl;
    if (cum > eqPeak) eqPeak = cum;
    if (eqPeak - cum > maxDD) maxDD = eqPeak - cum;
  }

  return {
    name: "Decay-4/8/16/24",
    totalPnl,
    perDay: totalPnl / days,
    maxDD,
    tradesAffected: affected,
    totalTrades: trades.length,
    avgGivebackPct: affected > 0 ? givebackSum / affected : 0,
    netVsBaseline: 0,
  };
}

// ─── Baseline (no overlay) ──────────────────────────────────────────
function computeBaseline(trades: RawTrade[], days: number): OverlayResult {
  let totalPnl = 0;
  let cum = 0, eqPeak = 0, maxDD = 0;

  for (const t of trades) {
    totalPnl += t.pnl;
    cum += t.pnl;
    if (cum > eqPeak) eqPeak = cum;
    if (eqPeak - cum > maxDD) maxDD = eqPeak - cum;
  }

  return {
    name: "BASELINE",
    totalPnl,
    perDay: totalPnl / days,
    maxDD,
    tradesAffected: 0,
    totalTrades: trades.length,
    avgGivebackPct: 0,
    netVsBaseline: 0,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=== Time-Decay Exit Research ===\n");
console.log("Loading 5m data...");

const pairData = new Map<string, PairData>();
const btcRaw5m = load5m("BTC");
if (btcRaw5m.length === 0) { console.log("No BTC 5m data!"); process.exit(1); }
const btc = prepBTC(btcRaw5m);

for (const p of PAIRS) {
  const m5 = load5m(p);
  if (m5.length < 500) { console.log(`  skip ${p} (${m5.length} bars)`); continue; }
  pairData.set(p, prepPair(m5));
}
console.log(`Loaded ${pairData.size} pairs: ${[...pairData.keys()].join(", ")}`);

// Generate baseline trades
console.log("\nGenerating trades (Donchian SMA20/50 + Supertrend 14/1.75)...");
const rawTrades = generateTrades(pairData, btc);
console.log(`Generated ${rawTrades.length} trades`);

// Sort trades by entry time (important for equity curve)
rawTrades.sort((a, b) => a.et - b.et);

// Stats breakdown
const engATrades = rawTrades.filter(t => t.engine === "A");
const engBTrades = rawTrades.filter(t => t.engine === "B");
console.log(`  Engine A (Donchian): ${engATrades.length} trades`);
console.log(`  Engine B (Supertrend): ${engBTrades.length} trades`);

const exitReasons = new Map<string, number>();
for (const t of rawTrades) {
  exitReasons.set(t.exitReason, (exitReasons.get(t.exitReason) ?? 0) + 1);
}
console.log("  Exit reasons:", Object.fromEntries(exitReasons));

// Free 5m data - no longer needed
pairData.clear();

// Now load 1m data per pair and build minute profiles
console.log("\nLoading 1m data and building peak profiles...");

const tradePairs = [...new Set(rawTrades.map(t => t.pair))];
const allProfiles: TradeMinuteProfile[] = new Array(rawTrades.length);

// Initialize with empty profiles
for (let i = 0; i < rawTrades.length; i++) {
  allProfiles[i] = { tradeIdx: i, peakLevPnlPct: 0, minuteCurve: [] };
}

for (const p of tradePairs) {
  process.stdout.write(`  ${p}...`);
  const m1 = load1m(p);
  if (m1.length === 0) { console.log(" no 1m data"); continue; }

  // Build profiles for this pair's trades
  const pairTradeIdxs = rawTrades
    .map((t, i) => t.pair === p ? i : -1)
    .filter(i => i >= 0);

  const pairTrades = pairTradeIdxs.map(i => rawTrades[i]);
  const profiles = buildMinuteProfiles(pairTrades, m1);

  for (let j = 0; j < profiles.length; j++) {
    allProfiles[pairTradeIdxs[j]] = profiles[j];
    allProfiles[pairTradeIdxs[j]].tradeIdx = pairTradeIdxs[j];
  }

  console.log(` ${m1.length} bars, ${pairTradeIdxs.length} trades`);
}

// Summarize peak distribution
const peaksOver20 = allProfiles.filter(p => p.peakLevPnlPct >= 20).length;
const peaksOver50 = allProfiles.filter(p => p.peakLevPnlPct >= 50).length;
console.log(`\nTrades with peak >= 20% leveraged: ${peaksOver20}`);
console.log(`Trades with peak >= 50% leveraged: ${peaksOver50}`);

// ─── Run All Overlays ───────────────────────────────────────────────
const days = (END - START) / DAY;
const results: OverlayResult[] = [];

// Baseline
const baseline = computeBaseline(rawTrades, days);
results.push(baseline);

// Flat N-hour exits
const flatHours = [4, 8, 12, 16, 24, 36, 48];
for (const n of flatHours) {
  const r = applyFlatDecay(rawTrades, allProfiles, n, days);
  r.netVsBaseline = r.totalPnl - baseline.totalPnl;
  results.push(r);
}

// Decaying threshold
const decay = applyDecayingThreshold(rawTrades, allProfiles, days);
decay.netVsBaseline = decay.totalPnl - baseline.totalPnl;
results.push(decay);

// ─── Print Results ──────────────────────────────────────────────────
console.log("\n" + "=".repeat(130));
console.log("TIME-DECAY EXIT OVERLAY COMPARISON");
console.log(`${rawTrades.length} trades, ${days.toFixed(0)} days, $${MARGIN} margin x ${LEV}x leverage`);
console.log("Decay only triggers when: position in profit AND peak leveraged PnL >= 20%");
console.log("=".repeat(130));
console.log("");
console.log(
  "Strategy".padEnd(22) +
  "$/day".padStart(8) +
  "Total$".padStart(10) +
  "MaxDD".padStart(8) +
  "Affected".padStart(10) +
  "Total".padStart(8) +
  "AvgGiveback%".padStart(14) +
  "Net vs Base".padStart(13)
);
console.log("-".repeat(93));

for (const r of results) {
  const net = r.name === "BASELINE" ? "-" : (r.netVsBaseline >= 0 ? "+" : "") + "$" + r.netVsBaseline.toFixed(2);
  console.log(
    r.name.padEnd(22) +
    ("$" + r.perDay.toFixed(2)).padStart(8) +
    ("$" + r.totalPnl.toFixed(2)).padStart(10) +
    ("$" + r.maxDD.toFixed(2)).padStart(8) +
    String(r.tradesAffected).padStart(10) +
    String(r.totalTrades).padStart(8) +
    (r.avgGivebackPct > 0 ? r.avgGivebackPct.toFixed(1) + "%" : "-").padStart(14) +
    net.padStart(13)
  );
}

// ─── Per-Trade Detail for Affected Trades ───────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TOP 15 TRADES WHERE DECAY EXIT WOULD HAVE HELPED (24h flat)");
console.log("=".repeat(100));

// Find trades where 24h flat exit gives better PnL than baseline
const h24Results: { ti: number; basePnl: number; decayPnl: number; peakPct: number; diff: number }[] = [];
for (let ti = 0; ti < rawTrades.length; ti++) {
  const trade = rawTrades[ti];
  const prof = allProfiles[ti];
  if (prof.minuteCurve.length === 0 || prof.peakLevPnlPct < 20) continue;

  let decayPnl = trade.pnl;
  for (const pt of prof.minuteCurve) {
    if (pt.peak >= 20 && pt.pnl > 0 && pt.hSincePeak >= 24) {
      decayPnl = pt.pnl / 100 / LEV * NOTIONAL - NOTIONAL * FEE * 2;
      break;
    }
  }

  const diff = decayPnl - trade.pnl;
  if (diff !== 0) {
    h24Results.push({ ti, basePnl: trade.pnl, decayPnl, peakPct: prof.peakLevPnlPct, diff });
  }
}

// Sort by improvement
h24Results.sort((a, b) => b.diff - a.diff);
console.log(
  "Pair".padEnd(8) + "Engine".padEnd(8) + "Dir".padEnd(6) +
  "PeakLev%".padStart(10) + "BasePnL$".padStart(10) + "DecayPnL$".padStart(10) +
  "Diff$".padStart(8) + "  Entry Date"
);
console.log("-".repeat(80));
for (const r of h24Results.slice(0, 15)) {
  const t = rawTrades[r.ti];
  const d = new Date(t.et).toISOString().slice(0, 10);
  console.log(
    t.pair.padEnd(8) + t.engine.padEnd(8) + t.dir.padEnd(6) +
    r.peakPct.toFixed(1).padStart(10) + ("$" + r.basePnl.toFixed(2)).padStart(10) +
    ("$" + r.decayPnl.toFixed(2)).padStart(10) +
    ((r.diff >= 0 ? "+" : "") + "$" + r.diff.toFixed(2)).padStart(8) +
    "  " + d
  );
}

// Also show worst (where decay exit hurt)
console.log("\nTOP 15 TRADES WHERE DECAY EXIT HURT (24h flat)");
console.log("-".repeat(80));
h24Results.sort((a, b) => a.diff - b.diff);
for (const r of h24Results.slice(0, 15)) {
  const t = rawTrades[r.ti];
  const d = new Date(t.et).toISOString().slice(0, 10);
  console.log(
    t.pair.padEnd(8) + t.engine.padEnd(8) + t.dir.padEnd(6) +
    r.peakPct.toFixed(1).padStart(10) + ("$" + r.basePnl.toFixed(2)).padStart(10) +
    ("$" + r.decayPnl.toFixed(2)).padStart(10) +
    ((r.diff >= 0 ? "+" : "") + "$" + r.diff.toFixed(2)).padStart(8) +
    "  " + d
  );
}

// ─── Giveback Distribution ──────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log("PEAK-TO-EXIT GIVEBACK DISTRIBUTION (all eligible trades)");
console.log("=".repeat(60));

const eligible = allProfiles.filter(p => p.peakLevPnlPct >= 20);
const givebacks: number[] = [];
for (const prof of eligible) {
  const lastPt = prof.minuteCurve[prof.minuteCurve.length - 1];
  if (lastPt && prof.peakLevPnlPct > 0) {
    const gb = (prof.peakLevPnlPct - lastPt.pnl) / prof.peakLevPnlPct * 100;
    givebacks.push(gb);
  }
}

if (givebacks.length > 0) {
  givebacks.sort((a, b) => a - b);
  const avg = givebacks.reduce((s, g) => s + g, 0) / givebacks.length;
  const p25 = givebacks[Math.floor(givebacks.length * 0.25)];
  const p50 = givebacks[Math.floor(givebacks.length * 0.50)];
  const p75 = givebacks[Math.floor(givebacks.length * 0.75)];
  const p90 = givebacks[Math.floor(givebacks.length * 0.90)];
  console.log(`Eligible trades (peak >= 20% lev): ${givebacks.length}`);
  console.log(`Avg giveback: ${avg.toFixed(1)}%`);
  console.log(`P25: ${p25.toFixed(1)}%  P50: ${p50.toFixed(1)}%  P75: ${p75.toFixed(1)}%  P90: ${p90.toFixed(1)}%`);
  console.log(`Trades that gave back > 50%: ${givebacks.filter(g => g > 50).length}`);
  console.log(`Trades that gave back > 100% (exit below entry): ${givebacks.filter(g => g > 100).length}`);
}

console.log("\nDone.");
