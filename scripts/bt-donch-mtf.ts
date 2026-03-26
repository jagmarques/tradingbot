/**
 * Multi-Timeframe Donchian Breakout Backtest
 *
 * Tests 5 strategies that use daily + 4h confirmation or filtering.
 * Data source: 5m candles aggregated to 4h and daily.
 */
import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 10; // $10 margin
const NOT = SIZE * LEV; // $100 notional
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const H4 = 4 * 3600000; // 4 hours in ms

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, AVAX: 2.55e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, SEI: 4.4e-4,
  TON: 4.6e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
  ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
};

const ALL_PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const OOS_START = new Date("2025-09-01").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; holdBars: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c,
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles: C[]): C[] {
  // Group by 4h slots (48 5m bars per 4h bar)
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const slotTs = Math.floor(c.t / H4) * H4;
    const arr = groups.get(slotTs) ?? [];
    arr.push(c);
    groups.set(slotTs, arr);
  }
  const bars: C[] = [];
  for (const [ts, grp] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (grp.length < 40) continue; // need most bars (48 expected)
    bars.push({
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  return bars;
}

function aggregateToDaily(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const dayTs = Math.floor(c.t / DAY) * DAY;
    const arr = groups.get(dayTs) ?? [];
    arr.push(c);
    groups.set(dayTs, arr);
  }
  const daily: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 200) continue;
    daily.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return daily;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c),
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(
          cs[j].h - cs[j].l,
          Math.abs(cs[j].h - cs[j - 1].c),
          Math.abs(cs[j].l - cs[j - 1].c),
        );
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcEMA(cs: C[], period: number): number[] {
  const ema = new Array(cs.length).fill(0);
  const k = 2 / (period + 1);
  for (let i = 0; i < cs.length; i++) {
    if (i < period - 1) { ema[i] = 0; continue; }
    if (i === period - 1) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += cs[j].c;
      ema[i] = s / period;
    } else {
      ema[i] = cs[i].c * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function donchianHigh(cs: C[], idx: number, lookback: number): number {
  let max = -Infinity;
  for (let i = Math.max(0, idx - lookback); i < idx; i++) max = Math.max(max, cs[i].h);
  return max;
}

function donchianLow(cs: C[], idx: number, lookback: number): number {
  let min = Infinity;
  for (let i = Math.max(0, idx - lookback); i < idx; i++) min = Math.min(min, cs[i].l);
  return min;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE_TAKER * 2;
  const cost = entrySlip * (NOT / ep) + exitSlip * (NOT / xp) + fees;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - cost;
}

// ─── Helper: find daily bar index for a 4h timestamp ────────────────
function findDailyIdx(daily: C[], ts: number): number {
  const dayTs = Math.floor(ts / DAY) * DAY;
  for (let i = 0; i < daily.length; i++) {
    if (daily[i].t === dayTs) return i;
  }
  // Closest before
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].t <= dayTs) return i;
  }
  return -1;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  total: number; perDay: number; maxDD: number;
}

function calcMetrics(trades: Tr[]): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, total: 0, perDay: 0, maxDD: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  // Max drawdown
  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Sharpe: bucket by day
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()].map(p => p / SIZE);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const firstT = Math.min(...trades.map(t => t.et));
  const lastT = Math.max(...trades.map(t => t.xt));
  const days = (lastT - firstT) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    total,
    perDay: days > 0 ? total / days : 0,
    maxDD,
  };
}

function fmtMetrics(m: Metrics): string {
  const pnlStr = (m.total >= 0 ? "+" : "-") + "$" + Math.abs(m.total).toFixed(2);
  const dayStr = (m.perDay >= 0 ? "+" : "-") + "$" + Math.abs(m.perDay).toFixed(2);
  return [
    String(m.n).padStart(6),
    (m.wr.toFixed(1) + "%").padStart(7),
    m.pf.toFixed(2).padStart(6),
    m.sharpe.toFixed(2).padStart(7),
    pnlStr.padStart(10),
    dayStr.padStart(8),
    ("-$" + m.maxDD.toFixed(2)).padStart(10),
  ].join("  ");
}

// ═══════════════════════════════════════════════════════════════════
// Strategy 1: Daily + 4h Confirmation
// ═══════════════════════════════════════════════════════════════════
function strat1_dailyPlus4hConfirm(
  pair: string, h4: C[], daily: C[], startTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const atrDaily = calcATR(daily, 14);
  const ENTRY_LB_D = 30;   // daily Donchian lookback
  const ENTRY_LB_4H = 20;  // 4h confirmation Donchian
  const EXIT_LB_4H = 10;   // 4h exit channel
  const CONFIRM_WINDOW = 12; // 2 days = 12 4h bars
  const ATR_MULT = 3;

  interface PendingSignal {
    dir: "long" | "short";
    dailyBarTs: number;
    dailyATR: number;
    expiresBar: number; // 4h bar index deadline
  }

  let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;
  let pending: PendingSignal | null = null;

  const warmup4h = Math.max(ENTRY_LB_4H, EXIT_LB_4H) + 1;

  for (let i = warmup4h; i < h4.length; i++) {
    const bar = h4[i];

    // Check exit for open position
    if (pos) {
      let xp = 0, reason = "";

      // SL check
      if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

      // Donchian exit (4h, 10-bar)
      if (!xp) {
        const exitLow = donchianLow(h4, i, EXIT_LB_4H);
        const exitHigh = donchianHigh(h4, i, EXIT_LB_4H);
        if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
        else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
      }

      if (xp > 0) {
        const isSL = reason === "stop-loss";
        const holdBars = Math.round((bar.t - pos.et) / H4);
        const tr: Tr = {
          pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
          pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
          reason, holdBars,
        };
        if (pos.et >= startTs) trades.push(tr);
        pos = null;
      }
    }

    // Check for daily signal on previous day boundary
    if (!pos && !pending) {
      const prevBar = h4[i - 1];
      const dIdx = findDailyIdx(daily, prevBar.t);
      if (dIdx >= ENTRY_LB_D + 14 && dIdx >= 1) {
        const dPrev = daily[dIdx]; // signal on this daily bar
        const dHigh = donchianHigh(daily, dIdx, ENTRY_LB_D);
        const dLow = donchianLow(daily, dIdx, ENTRY_LB_D);
        const curATR = atrDaily[dIdx];
        if (curATR > 0) {
          let dir: "long" | "short" | null = null;
          if (dPrev.c > dHigh) dir = "long";
          else if (dPrev.c < dLow) dir = "short";
          if (dir) {
            pending = {
              dir,
              dailyBarTs: dPrev.t,
              dailyATR: curATR,
              expiresBar: i + CONFIRM_WINDOW,
            };
          }
        }
      }
    }

    // Check pending for 4h confirmation
    if (pending && !pos) {
      if (i >= pending.expiresBar) {
        pending = null; // expired
      } else {
        const prev4h = h4[i - 1];
        const h4High = donchianHigh(h4, i - 1, ENTRY_LB_4H);
        const h4Low = donchianLow(h4, i - 1, ENTRY_LB_4H);
        let confirmed = false;
        if (pending.dir === "long" && prev4h.c > h4High) confirmed = true;
        if (pending.dir === "short" && prev4h.c < h4Low) confirmed = true;

        if (confirmed) {
          const ep = bar.o; // entry at current bar open
          const sl = pending.dir === "long"
            ? ep - ATR_MULT * pending.dailyATR
            : ep + ATR_MULT * pending.dailyATR;
          pos = { dir: pending.dir, ep, et: bar.t, sl };
          pending = null;
        }
      }
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// Strategy 2: 4h Donchian with Daily Trend Alignment
// ═══════════════════════════════════════════════════════════════════
function strat2_4hDailyTrend(
  pair: string, h4: C[], daily: C[], startTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const atr4h = calcATR(h4, 14);
  const ema20d = calcEMA(daily, 20);
  const ema50d = calcEMA(daily, 50);
  const ENTRY_LB = 20;
  const EXIT_LB = 10;
  const ATR_MULT = 3;
  const TRAIL_ATR = 2;
  const TRAIL_ACTIVATE_ATR = 1; // activate trailing after 1x ATR profit
  const MAX_HOLD = 120; // 4h bars

  let pos: {
    dir: "long"|"short"; ep: number; et: number; sl: number;
    peak: number; atrAtEntry: number; trailActive: boolean;
  } | null = null;

  const warmup = Math.max(ENTRY_LB, EXIT_LB, 14) + 1;

  for (let i = warmup; i < h4.length; i++) {
    const bar = h4[i];

    if (pos) {
      let xp = 0, reason = "";
      const barsHeld = Math.round((bar.t - pos.et) / H4);

      // Update peak
      if (pos.dir === "long") pos.peak = Math.max(pos.peak, bar.h);
      else pos.peak = Math.min(pos.peak, bar.l);

      // SL
      if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

      // Trailing stop (activate after 1x ATR profit)
      if (!xp) {
        const profitFromEntry = pos.dir === "long"
          ? pos.peak - pos.ep : pos.ep - pos.peak;
        if (profitFromEntry >= TRAIL_ACTIVATE_ATR * pos.atrAtEntry && !pos.trailActive) {
          pos.trailActive = true;
        }
        if (pos.trailActive) {
          const trailSL = pos.dir === "long"
            ? pos.peak - TRAIL_ATR * pos.atrAtEntry
            : pos.peak + TRAIL_ATR * pos.atrAtEntry;
          // Use better of original SL and trail SL
          if (pos.dir === "long") {
            pos.sl = Math.max(pos.sl, trailSL);
            if (bar.l <= pos.sl) { xp = pos.sl; reason = "trail-stop"; }
          } else {
            pos.sl = Math.min(pos.sl, trailSL);
            if (bar.h >= pos.sl) { xp = pos.sl; reason = "trail-stop"; }
          }
        }
      }

      // Donchian exit
      if (!xp) {
        const exitLow = donchianLow(h4, i, EXIT_LB);
        const exitHigh = donchianHigh(h4, i, EXIT_LB);
        if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
        else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
      }

      // Max hold
      if (!xp && barsHeld >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

      if (xp > 0) {
        const isSL = reason === "stop-loss" || reason === "trail-stop";
        const tr: Tr = {
          pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
          pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
          reason, holdBars: barsHeld,
        };
        if (pos.et >= startTs) trades.push(tr);
        pos = null;
      }
    }

    // Entry: signal on bar i-1, enter at bar i open
    if (!pos) {
      const prev = h4[i - 1];
      const dHigh = donchianHigh(h4, i - 1, ENTRY_LB);
      const dLow = donchianLow(h4, i - 1, ENTRY_LB);
      const curATR = atr4h[i - 1];
      if (curATR <= 0) continue;

      let dir: "long" | "short" | null = null;
      if (prev.c > dHigh) dir = "long";
      else if (prev.c < dLow) dir = "short";
      if (!dir) continue;

      // Daily trend filter
      const dIdx = findDailyIdx(daily, prev.t);
      if (dIdx < 50) continue;
      const e20 = ema20d[dIdx];
      const e50 = ema50d[dIdx];
      if (e20 === 0 || e50 === 0) continue;
      // Only trade in direction of daily trend
      if (dir === "long" && e20 <= e50) continue;
      if (dir === "short" && e20 >= e50) continue;

      const ep = bar.o;
      const sl = dir === "long" ? ep - ATR_MULT * curATR : ep + ATR_MULT * curATR;
      pos = {
        dir, ep, et: bar.t, sl,
        peak: ep, atrAtEntry: curATR, trailActive: false,
      };
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// Strategy 3: 4h Donchian with BTC 4h Trend Filter
// ═══════════════════════════════════════════════════════════════════
function strat3_4hBtcFilter(
  pair: string, h4: C[], btc4h: C[], startTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const atr4h = calcATR(h4, 14);
  const btcEma20 = calcEMA(btc4h, 20);
  const btcEma50 = calcEMA(btc4h, 50);
  // Build BTC timestamp index
  const btcIdx = new Map<number, number>();
  btc4h.forEach((b, i) => btcIdx.set(b.t, i));

  const ENTRY_LB = 20;
  const EXIT_LB = 10;
  const ATR_MULT = 3;
  const TRAIL_ATR = 2;
  const TRAIL_ACTIVATE_ATR = 1;
  const MAX_HOLD = 120;

  let pos: {
    dir: "long"|"short"; ep: number; et: number; sl: number;
    peak: number; atrAtEntry: number; trailActive: boolean;
  } | null = null;

  const warmup = Math.max(ENTRY_LB, EXIT_LB, 14) + 1;

  for (let i = warmup; i < h4.length; i++) {
    const bar = h4[i];

    if (pos) {
      let xp = 0, reason = "";
      const barsHeld = Math.round((bar.t - pos.et) / H4);

      if (pos.dir === "long") pos.peak = Math.max(pos.peak, bar.h);
      else pos.peak = Math.min(pos.peak, bar.l);

      if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

      if (!xp) {
        const profitFromEntry = pos.dir === "long"
          ? pos.peak - pos.ep : pos.ep - pos.peak;
        if (profitFromEntry >= TRAIL_ACTIVATE_ATR * pos.atrAtEntry && !pos.trailActive)
          pos.trailActive = true;
        if (pos.trailActive) {
          const trailSL = pos.dir === "long"
            ? pos.peak - TRAIL_ATR * pos.atrAtEntry
            : pos.peak + TRAIL_ATR * pos.atrAtEntry;
          if (pos.dir === "long") {
            pos.sl = Math.max(pos.sl, trailSL);
            if (bar.l <= pos.sl) { xp = pos.sl; reason = "trail-stop"; }
          } else {
            pos.sl = Math.min(pos.sl, trailSL);
            if (bar.h >= pos.sl) { xp = pos.sl; reason = "trail-stop"; }
          }
        }
      }

      if (!xp) {
        const exitLow = donchianLow(h4, i, EXIT_LB);
        const exitHigh = donchianHigh(h4, i, EXIT_LB);
        if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
        else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
      }

      if (!xp && barsHeld >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

      if (xp > 0) {
        const isSL = reason === "stop-loss" || reason === "trail-stop";
        const tr: Tr = {
          pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
          pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
          reason, holdBars: barsHeld,
        };
        if (pos.et >= startTs) trades.push(tr);
        pos = null;
      }
    }

    if (!pos) {
      const prev = h4[i - 1];
      const dHigh = donchianHigh(h4, i - 1, ENTRY_LB);
      const dLow = donchianLow(h4, i - 1, ENTRY_LB);
      const curATR = atr4h[i - 1];
      if (curATR <= 0) continue;

      let dir: "long" | "short" | null = null;
      if (prev.c > dHigh) dir = "long";
      else if (prev.c < dLow) dir = "short";
      if (!dir) continue;

      // BTC 4h trend filter
      const btcBarIdx = btcIdx.get(prev.t);
      if (btcBarIdx === undefined || btcBarIdx < 50) continue;
      const b20 = btcEma20[btcBarIdx];
      const b50 = btcEma50[btcBarIdx];
      if (b20 === 0 || b50 === 0) continue;
      if (dir === "long" && b20 <= b50) continue;
      if (dir === "short" && b20 >= b50) continue;

      const ep = bar.o;
      const sl = dir === "long" ? ep - ATR_MULT * curATR : ep + ATR_MULT * curATR;
      pos = {
        dir, ep, et: bar.t, sl,
        peak: ep, atrAtEntry: curATR, trailActive: false,
      };
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// Strategy 4: 4h Donchian Pure (no filter), variable lookback
// ═══════════════════════════════════════════════════════════════════
function strat4_4hPure(
  pair: string, h4: C[], entryLB: number, startTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const atr4h = calcATR(h4, 14);
  const EXIT_LB = Math.round(entryLB / 2);
  const ATR_MULT = 3;

  let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;
  const warmup = Math.max(entryLB, EXIT_LB, 14) + 1;

  for (let i = warmup; i < h4.length; i++) {
    const bar = h4[i];

    if (pos) {
      let xp = 0, reason = "";

      if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

      if (!xp) {
        const exitLow = donchianLow(h4, i, EXIT_LB);
        const exitHigh = donchianHigh(h4, i, EXIT_LB);
        if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
        else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
      }

      if (xp > 0) {
        const isSL = reason === "stop-loss";
        const barsHeld = Math.round((bar.t - pos.et) / H4);
        const tr: Tr = {
          pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
          pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
          reason, holdBars: barsHeld,
        };
        if (pos.et >= startTs) trades.push(tr);
        pos = null;
      }
    }

    if (!pos) {
      const prev = h4[i - 1];
      const dHigh = donchianHigh(h4, i - 1, entryLB);
      const dLow = donchianLow(h4, i - 1, entryLB);
      const curATR = atr4h[i - 1];
      if (curATR <= 0) continue;

      let dir: "long" | "short" | null = null;
      if (prev.c > dHigh) dir = "long";
      else if (prev.c < dLow) dir = "short";
      if (!dir) continue;

      const ep = bar.o;
      const sl = dir === "long" ? ep - ATR_MULT * curATR : ep + ATR_MULT * curATR;
      pos = { dir, ep, et: bar.t, sl };
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// Strategy 5: Daily Donchian, enter on 4h pullback to EMA(9)
// ═══════════════════════════════════════════════════════════════════
function strat5_dailyPullback(
  pair: string, h4: C[], daily: C[], startTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const atrDaily = calcATR(daily, 14);
  const ema9_4h = calcEMA(h4, 9);
  const ENTRY_LB_D = 30;
  const EXIT_LB_4H = 10;
  const ATR_MULT = 3;
  const PULLBACK_TIMEOUT = 30; // 5 days = 30 4h bars

  interface PendingPB {
    dir: "long" | "short";
    dailyATR: number;
    expiresBar: number;
  }

  let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;
  let pending: PendingPB | null = null;

  const warmup4h = Math.max(EXIT_LB_4H, 9, 14) + 1;

  for (let i = warmup4h; i < h4.length; i++) {
    const bar = h4[i];

    // Check exit
    if (pos) {
      let xp = 0, reason = "";

      if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

      if (!xp) {
        const exitLow = donchianLow(h4, i, EXIT_LB_4H);
        const exitHigh = donchianHigh(h4, i, EXIT_LB_4H);
        if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
        else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
      }

      if (xp > 0) {
        const isSL = reason === "stop-loss";
        const holdBars = Math.round((bar.t - pos.et) / H4);
        const tr: Tr = {
          pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
          pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
          reason, holdBars,
        };
        if (pos.et >= startTs) trades.push(tr);
        pos = null;
      }
    }

    // Check for daily breakout signal
    if (!pos && !pending) {
      const prev = h4[i - 1];
      const dIdx = findDailyIdx(daily, prev.t);
      if (dIdx >= ENTRY_LB_D + 14 && dIdx >= 1) {
        const dBar = daily[dIdx];
        const dHigh = donchianHigh(daily, dIdx, ENTRY_LB_D);
        const dLow = donchianLow(daily, dIdx, ENTRY_LB_D);
        const curATR = atrDaily[dIdx];
        if (curATR > 0) {
          let dir: "long" | "short" | null = null;
          if (dBar.c > dHigh) dir = "long";
          else if (dBar.c < dLow) dir = "short";
          if (dir) {
            pending = {
              dir,
              dailyATR: curATR,
              expiresBar: i + PULLBACK_TIMEOUT,
            };
          }
        }
      }
    }

    // Check pullback to EMA(9)
    if (pending && !pos) {
      if (i >= pending.expiresBar) {
        pending = null;
      } else {
        const prev4h = h4[i - 1];
        const ema = ema9_4h[i - 1];
        if (ema <= 0) continue;
        let touched = false;
        if (pending.dir === "long" && prev4h.l <= ema && prev4h.c >= ema) touched = true;
        if (pending.dir === "short" && prev4h.h >= ema && prev4h.c <= ema) touched = true;

        if (touched) {
          const ep = bar.o;
          const sl = pending.dir === "long"
            ? ep - ATR_MULT * pending.dailyATR
            : ep + ATR_MULT * pending.dailyATR;
          pos = { dir: pending.dir, ep, et: bar.t, sl };
          pending = null;
        }
      }
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════
console.log("Loading 5m data and aggregating to 4h + daily...\n");

const h4Data = new Map<string, C[]>();
const dailyData = new Map<string, C[]>();

for (const pair of ALL_PAIRS) {
  const raw = load5m(pair);
  if (raw.length === 0) { console.log(`  WARN: no data for ${pair}`); continue; }
  const h4 = aggregateTo4h(raw);
  const daily = aggregateToDaily(raw);
  h4Data.set(pair, h4);
  dailyData.set(pair, daily);
  console.log(`  ${pair}: ${raw.length} 5m -> ${h4.length} 4h bars, ${daily.length} daily bars`);
}

const btc4h = h4Data.get("BTC") ?? [];

// ═══════════════════════════════════════════════════════════════════
// Run strategies
// ═══════════════════════════════════════════════════════════════════

const header = "  Trades      WR%      PF   Sharpe       Total     $/day       MaxDD";
const sep = "-".repeat(80);

// --- Strategy 1: Daily + 4h Confirmation ---
console.log("\n" + "=".repeat(80));
console.log("STRATEGY 1: Daily 30d Donchian + 4h 20-bar Confirmation (2-day window)");
console.log("  Exit: 4h 10-bar Donchian | SL: 3x daily ATR");
console.log("=".repeat(80));
{
  const allTrades: Tr[] = [];
  for (const pair of ALL_PAIRS) {
    const h4 = h4Data.get(pair);
    const daily = dailyData.get(pair);
    if (!h4 || !daily) continue;
    const tr = strat1_dailyPlus4hConfirm(pair, h4, daily, OOS_START);
    allTrades.push(...tr);
  }
  console.log(header);
  console.log(sep);
  const m = calcMetrics(allTrades);
  console.log(fmtMetrics(m));

  // Per-pair breakdown
  console.log("\nPer-pair breakdown:");
  console.log("  Pair    Trades  WR%     PF   Sharpe     Total    $/day");
  console.log("  " + "-".repeat(60));
  for (const pair of ALL_PAIRS) {
    const pt = allTrades.filter(t => t.pair === pair);
    if (pt.length === 0) continue;
    const pm = calcMetrics(pt);
    const pnlStr = (pm.total >= 0 ? "+" : "-") + "$" + Math.abs(pm.total).toFixed(2);
    const dayStr = (pm.perDay >= 0 ? "+" : "-") + "$" + Math.abs(pm.perDay).toFixed(2);
    console.log(
      `  ${pair.padEnd(6)}  ${String(pm.n).padStart(6)}  ${(pm.wr.toFixed(1)+"%").padStart(6)}  ${pm.pf.toFixed(2).padStart(5)}  ${pm.sharpe.toFixed(2).padStart(6)}  ${pnlStr.padStart(8)}  ${dayStr.padStart(7)}`
    );
  }

  // Exit reason breakdown
  const reasons = new Map<string, number>();
  for (const t of allTrades) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
  console.log("\nExit reasons:");
  for (const [r, c] of reasons) console.log(`  ${r}: ${c}`);
}

// --- Strategy 2: 4h Donchian + Daily Trend ---
console.log("\n" + "=".repeat(80));
console.log("STRATEGY 2: 4h Donchian (20/10) + Daily EMA(20/50) Trend Filter");
console.log("  SL: 3x 4h ATR | Trail: 2x ATR after 1x ATR profit | Max hold: 120 bars (20d)");
console.log("=".repeat(80));
{
  const allTrades: Tr[] = [];
  for (const pair of ALL_PAIRS) {
    const h4 = h4Data.get(pair);
    const daily = dailyData.get(pair);
    if (!h4 || !daily) continue;
    const tr = strat2_4hDailyTrend(pair, h4, daily, OOS_START);
    allTrades.push(...tr);
  }
  console.log(header);
  console.log(sep);
  const m = calcMetrics(allTrades);
  console.log(fmtMetrics(m));

  console.log("\nPer-pair breakdown:");
  console.log("  Pair    Trades  WR%     PF   Sharpe     Total    $/day");
  console.log("  " + "-".repeat(60));
  for (const pair of ALL_PAIRS) {
    const pt = allTrades.filter(t => t.pair === pair);
    if (pt.length === 0) continue;
    const pm = calcMetrics(pt);
    const pnlStr = (pm.total >= 0 ? "+" : "-") + "$" + Math.abs(pm.total).toFixed(2);
    const dayStr = (pm.perDay >= 0 ? "+" : "-") + "$" + Math.abs(pm.perDay).toFixed(2);
    console.log(
      `  ${pair.padEnd(6)}  ${String(pm.n).padStart(6)}  ${(pm.wr.toFixed(1)+"%").padStart(6)}  ${pm.pf.toFixed(2).padStart(5)}  ${pm.sharpe.toFixed(2).padStart(6)}  ${pnlStr.padStart(8)}  ${dayStr.padStart(7)}`
    );
  }

  const reasons = new Map<string, number>();
  for (const t of allTrades) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
  console.log("\nExit reasons:");
  for (const [r, c] of reasons) console.log(`  ${r}: ${c}`);
}

// --- Strategy 3: 4h Donchian + BTC 4h Trend ---
console.log("\n" + "=".repeat(80));
console.log("STRATEGY 3: 4h Donchian (20/10) + BTC 4h EMA(20/50) Trend Filter");
console.log("  SL: 3x 4h ATR | Trail: 2x ATR after 1x ATR profit | Max hold: 120 bars (20d)");
console.log("=".repeat(80));
{
  const allTrades: Tr[] = [];
  for (const pair of ALL_PAIRS) {
    if (pair === "BTC") continue; // Don't trade BTC on BTC filter
    const h4 = h4Data.get(pair);
    if (!h4 || btc4h.length === 0) continue;
    const tr = strat3_4hBtcFilter(pair, h4, btc4h, OOS_START);
    allTrades.push(...tr);
  }
  console.log(header);
  console.log(sep);
  const m = calcMetrics(allTrades);
  console.log(fmtMetrics(m));

  console.log("\nPer-pair breakdown:");
  console.log("  Pair    Trades  WR%     PF   Sharpe     Total    $/day");
  console.log("  " + "-".repeat(60));
  for (const pair of ALL_PAIRS) {
    if (pair === "BTC") continue;
    const pt = allTrades.filter(t => t.pair === pair);
    if (pt.length === 0) continue;
    const pm = calcMetrics(pt);
    const pnlStr = (pm.total >= 0 ? "+" : "-") + "$" + Math.abs(pm.total).toFixed(2);
    const dayStr = (pm.perDay >= 0 ? "+" : "-") + "$" + Math.abs(pm.perDay).toFixed(2);
    console.log(
      `  ${pair.padEnd(6)}  ${String(pm.n).padStart(6)}  ${(pm.wr.toFixed(1)+"%").padStart(6)}  ${pm.pf.toFixed(2).padStart(5)}  ${pm.sharpe.toFixed(2).padStart(6)}  ${pnlStr.padStart(8)}  ${dayStr.padStart(7)}`
    );
  }

  const reasons = new Map<string, number>();
  for (const t of allTrades) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
  console.log("\nExit reasons:");
  for (const [r, c] of reasons) console.log(`  ${r}: ${c}`);
}

// --- Strategy 4: 4h Donchian Pure (multiple lookbacks) ---
console.log("\n" + "=".repeat(80));
console.log("STRATEGY 4: 4h Donchian Pure (no filter) - Variable Lookbacks");
console.log("  Exit: LB/2 | SL: 3x 4h ATR | No max hold");
console.log("=".repeat(80));
console.log(header.replace("  Trades", "  LB  Trades"));
console.log(sep);
{
  for (const lb of [15, 20, 30, 40]) {
    const allTrades: Tr[] = [];
    for (const pair of ALL_PAIRS) {
      const h4 = h4Data.get(pair);
      if (!h4) continue;
      const tr = strat4_4hPure(pair, h4, lb, OOS_START);
      allTrades.push(...tr);
    }
    const m = calcMetrics(allTrades);
    const pnlStr = (m.total >= 0 ? "+" : "-") + "$" + Math.abs(m.total).toFixed(2);
    const dayStr = (m.perDay >= 0 ? "+" : "-") + "$" + Math.abs(m.perDay).toFixed(2);
    console.log(
      `  ${String(lb).padStart(2)}  ${String(m.n).padStart(6)}  ${(m.wr.toFixed(1)+"%").padStart(7)}  ${m.pf.toFixed(2).padStart(6)}  ${m.sharpe.toFixed(2).padStart(7)}  ${pnlStr.padStart(10)}  ${dayStr.padStart(8)}  ${("-$"+m.maxDD.toFixed(2)).padStart(10)}`
    );
  }

  // Detailed breakdown for LB=20 (baseline comparable)
  console.log("\nDetailed per-pair for LB=20:");
  console.log("  Pair    Trades  WR%     PF   Sharpe     Total    $/day");
  console.log("  " + "-".repeat(60));
  for (const pair of ALL_PAIRS) {
    const h4 = h4Data.get(pair);
    if (!h4) continue;
    const pt = strat4_4hPure(pair, h4, 20, OOS_START);
    if (pt.length === 0) continue;
    const pm = calcMetrics(pt);
    const pnlStr = (pm.total >= 0 ? "+" : "-") + "$" + Math.abs(pm.total).toFixed(2);
    const dayStr = (pm.perDay >= 0 ? "+" : "-") + "$" + Math.abs(pm.perDay).toFixed(2);
    console.log(
      `  ${pair.padEnd(6)}  ${String(pm.n).padStart(6)}  ${(pm.wr.toFixed(1)+"%").padStart(6)}  ${pm.pf.toFixed(2).padStart(5)}  ${pm.sharpe.toFixed(2).padStart(6)}  ${pnlStr.padStart(8)}  ${dayStr.padStart(7)}`
    );
  }
}

// --- Strategy 5: Daily Donchian + 4h Pullback Entry ---
console.log("\n" + "=".repeat(80));
console.log("STRATEGY 5: Daily 30d Donchian, 4h Pullback to EMA(9) Entry");
console.log("  Timeout: 5 days | Exit: 4h 10-bar Donchian | SL: 3x daily ATR");
console.log("=".repeat(80));
{
  const allTrades: Tr[] = [];
  for (const pair of ALL_PAIRS) {
    const h4 = h4Data.get(pair);
    const daily = dailyData.get(pair);
    if (!h4 || !daily) continue;
    const tr = strat5_dailyPullback(pair, h4, daily, OOS_START);
    allTrades.push(...tr);
  }
  console.log(header);
  console.log(sep);
  const m = calcMetrics(allTrades);
  console.log(fmtMetrics(m));

  console.log("\nPer-pair breakdown:");
  console.log("  Pair    Trades  WR%     PF   Sharpe     Total    $/day");
  console.log("  " + "-".repeat(60));
  for (const pair of ALL_PAIRS) {
    const pt = allTrades.filter(t => t.pair === pair);
    if (pt.length === 0) continue;
    const pm = calcMetrics(pt);
    const pnlStr = (pm.total >= 0 ? "+" : "-") + "$" + Math.abs(pm.total).toFixed(2);
    const dayStr = (pm.perDay >= 0 ? "+" : "-") + "$" + Math.abs(pm.perDay).toFixed(2);
    console.log(
      `  ${pair.padEnd(6)}  ${String(pm.n).padStart(6)}  ${(pm.wr.toFixed(1)+"%").padStart(6)}  ${pm.pf.toFixed(2).padStart(5)}  ${pm.sharpe.toFixed(2).padStart(6)}  ${pnlStr.padStart(8)}  ${dayStr.padStart(7)}`
    );
  }

  const reasons = new Map<string, number>();
  for (const t of allTrades) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
  console.log("\nExit reasons:");
  for (const [r, c] of reasons) console.log(`  ${r}: ${c}`);
}

// ═══════════════════════════════════════════════════════════════════
// Summary comparison
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("STRATEGY COMPARISON SUMMARY (OOS from 2025-09-01)");
console.log("=".repeat(80));
console.log("  Strategy                               Trades    WR%      PF   Sharpe      Total     $/day      MaxDD");
console.log("  " + "-".repeat(100));

// Re-run all for summary
const summaryResults: { name: string; m: Metrics }[] = [];

// S1
{
  const tr: Tr[] = [];
  for (const pair of ALL_PAIRS) {
    const h4 = h4Data.get(pair); const daily = dailyData.get(pair);
    if (h4 && daily) tr.push(...strat1_dailyPlus4hConfirm(pair, h4, daily, OOS_START));
  }
  summaryResults.push({ name: "S1: Daily+4h Confirm", m: calcMetrics(tr) });
}
// S2
{
  const tr: Tr[] = [];
  for (const pair of ALL_PAIRS) {
    const h4 = h4Data.get(pair); const daily = dailyData.get(pair);
    if (h4 && daily) tr.push(...strat2_4hDailyTrend(pair, h4, daily, OOS_START));
  }
  summaryResults.push({ name: "S2: 4h+Daily Trend", m: calcMetrics(tr) });
}
// S3
{
  const tr: Tr[] = [];
  for (const pair of ALL_PAIRS) {
    if (pair === "BTC") continue;
    const h4 = h4Data.get(pair);
    if (h4 && btc4h.length > 0) tr.push(...strat3_4hBtcFilter(pair, h4, btc4h, OOS_START));
  }
  summaryResults.push({ name: "S3: 4h+BTC Trend", m: calcMetrics(tr) });
}
// S4 variants
for (const lb of [15, 20, 30, 40]) {
  const tr: Tr[] = [];
  for (const pair of ALL_PAIRS) {
    const h4 = h4Data.get(pair);
    if (h4) tr.push(...strat4_4hPure(pair, h4, lb, OOS_START));
  }
  summaryResults.push({ name: `S4: 4h Pure LB=${lb}`, m: calcMetrics(tr) });
}
// S5
{
  const tr: Tr[] = [];
  for (const pair of ALL_PAIRS) {
    const h4 = h4Data.get(pair); const daily = dailyData.get(pair);
    if (h4 && daily) tr.push(...strat5_dailyPullback(pair, h4, daily, OOS_START));
  }
  summaryResults.push({ name: "S5: Daily+4h Pullback", m: calcMetrics(tr) });
}

for (const r of summaryResults) {
  const m = r.m;
  const pnlStr = (m.total >= 0 ? "+" : "-") + "$" + Math.abs(m.total).toFixed(2);
  const dayStr = (m.perDay >= 0 ? "+" : "-") + "$" + Math.abs(m.perDay).toFixed(2);
  console.log(
    `  ${r.name.padEnd(40)} ${String(m.n).padStart(6)}  ${(m.wr.toFixed(1)+"%").padStart(6)}  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(6)}  ${pnlStr.padStart(9)}  ${dayStr.padStart(8)}  ${("-$"+m.maxDD.toFixed(2)).padStart(9)}`
  );
}

console.log("\nDone.");
