/**
 * EWMAC (Exponentially Weighted Moving Average Crossover) multi-speed trend strategy
 * Rob Carver's pysystemtrade framework applied to crypto on Hyperliquid
 *
 * Variants tested:
 * 1. Individual EWMAC speeds: (8,32), (16,64), (32,128), (64,256)
 * 2. Combined 4-speed (equal-weighted average)
 * 3. Combined 2-speed: (16,64) + (64,256)
 * 4. Combined + Donchian: EWMAC combined > 0 AND Donchian 30d breakout
 * 5. No forecast sizing (fixed $5, direction only)
 * 6. Baseline Donchian(30d) for comparison
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const DAY = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const ATR_PERIOD = 14;
const ATR_MULT = 3;
const MAX_HOLD = 60; // days
const OOS_START = new Date("2025-09-01").getTime();
const FULL_START = new Date("2023-01-01").getTime();
const FORECAST_THRESHOLD = 2;
const FORECAST_CAP = 20;

const PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, AVAX: 2.55e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, SEI: 4.4e-4,
  TON: 4.6e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
  ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
};

const EWMAC_SPEEDS: [number, number][] = [
  [8, 32], [16, 64], [32, 128], [64, 256],
];

// ─── Types ──────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number }
interface Pos {
  pair: string; dir: "long" | "short"; ep: number; et: number; sl: number;
  margin: number; // actual margin used for sizing
}
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; holdDays: number;
  exitReason: "stop-loss" | "forecast-flat" | "max-hold";
  margin: number;
}

// ─── Data Loading ───────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CD, pair + "USDT.json");
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggDaily(candles5m: C[]): C[] {
  const dayMap = new Map<number, C[]>();
  for (const c of candles5m) {
    const dayKey = Math.floor(c.t / DAY) * DAY;
    let arr = dayMap.get(dayKey);
    if (!arr) { arr = []; dayMap.set(dayKey, arr); }
    arr.push(c);
  }
  const daily: C[] = [];
  for (const [dayKey, bars] of [...dayMap.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 12) continue;
    bars.sort((a, b) => a.t - b.t);
    daily.push({
      t: dayKey,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return daily;
}

// ─── Indicators ─────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c),
    );
    if (i < period) {
      atr[i] = tr;
    } else if (i === period) {
      let sum = tr;
      for (let j = 1; j < period; j++) sum += Math.max(
        cs[i - j].h - cs[i - j].l,
        Math.abs(cs[i - j].h - cs[i - j - 1].c),
        Math.abs(cs[i - j].l - cs[i - j - 1].c),
      );
      atr[i] = sum / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let initialized = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      ema[i] = 0;
    } else if (!initialized) {
      // SMA seed
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      ema[i] = sum / period;
      initialized = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function rollingStd(returns: number[], window: number): number[] {
  const std = new Array(returns.length).fill(0);
  for (let i = window; i < returns.length; i++) {
    let sum = 0, sum2 = 0;
    for (let j = i - window; j < i; j++) {
      sum += returns[j];
      sum2 += returns[j] * returns[j];
    }
    const mean = sum / window;
    const variance = sum2 / window - mean * mean;
    std[i] = Math.sqrt(Math.max(0, variance));
  }
  return std;
}

// ─── EWMAC Forecast Calculation ─────────────────────────────────
function calcEWMACForecasts(cs: C[], speeds: [number, number][]): number[][] {
  const closes = cs.map(c => c.c);
  const returns = cs.map((c, i) => i > 0 ? c.c / cs[i - 1].c - 1 : 0);
  const volStd = rollingStd(returns, 20);

  const forecasts: number[][] = [];
  for (const [fast, slow] of speeds) {
    const emaFast = calcEMA(closes, fast);
    const emaSlow = calcEMA(closes, slow);
    const forecast = new Array(cs.length).fill(0);

    for (let i = slow + 20; i < cs.length; i++) {
      if (emaFast[i] === 0 || emaSlow[i] === 0 || volStd[i] === 0 || closes[i] === 0) continue;
      const rawSignal = emaFast[i] - emaSlow[i];
      const normalized = rawSignal / (volStd[i] * closes[i]);
      const scaled = normalized * 10;
      forecast[i] = Math.max(-FORECAST_CAP, Math.min(FORECAST_CAP, scaled));
    }
    forecasts.push(forecast);
  }
  return forecasts;
}

// ─── Donchian helpers ───────────────────────────────────────────
function donchianHigh(cs: C[], idx: number, lb: number): number {
  let hi = -Infinity;
  for (let j = idx - lb; j < idx; j++) {
    if (j >= 0 && cs[j].h > hi) hi = cs[j].h;
  }
  return hi;
}

function donchianLow(cs: C[], idx: number, lb: number): number {
  let lo = Infinity;
  for (let j = idx - lb; j < idx; j++) {
    if (j >= 0 && cs[j].l < lo) lo = cs[j].l;
  }
  return lo;
}

// ─── BTC regime filter ──────────────────────────────────────────
interface PairData {
  cs: C[];
  atr: number[];
  forecasts: number[][]; // one per speed
}

const pairData = new Map<string, PairData>();
for (const pair of PAIRS) {
  const raw5m = load5m(pair);
  if (raw5m.length === 0) { console.log(`[WARN] No data for ${pair}`); continue; }
  const cs = aggDaily(raw5m);
  if (cs.length < 300) {
    console.log(`[WARN] Insufficient daily bars for ${pair}: ${cs.length}`);
    continue;
  }
  const atr = calcATR(cs, ATR_PERIOD);
  const forecasts = calcEWMACForecasts(cs, EWMAC_SPEEDS);
  pairData.set(pair, { cs, atr, forecasts });
}

// BTC EMA filter for longs
const btcData = pairData.get("BTC");
const btcEma20 = btcData ? calcEMA(btcData.cs.map(c => c.c), 20) : [];
const btcEma50 = btcData ? calcEMA(btcData.cs.map(c => c.c), 50) : [];
const btcDayMap = new Map<number, number>();
if (btcData) {
  btcData.cs.forEach((c, i) => btcDayMap.set(c.t, i));
}

function btcBullish(dayTs: number): boolean {
  const idx = btcDayMap.get(dayTs);
  if (idx === undefined || idx < 50) return false;
  return btcEma20[idx] > btcEma50[idx];
}

// ─── Simulation Engine ──────────────────────────────────────────
type VariantConfig = {
  name: string;
  getSignal: (pair: string, dayIdx: number, dayTs: number) => { dir: "long" | "short" | null; forecast: number };
  forecastSizing: boolean; // true = $5 * abs(forecast)/10, false = fixed $5
};

function runVariant(config: VariantConfig): Trade[] {
  const allTrades: Trade[] = [];

  for (const [pair, pd] of pairData) {
    const { cs, atr } = pd;
    const spread = SP[pair] ?? 4e-4;
    const slSpread = spread * 1.5;

    let pos: Pos | null = null;

    for (let i = 257; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < FULL_START) continue;

      // ─── Check exits first ─────────────────────────────
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / DAY);
        let xp = 0;
        let exitReason: Trade["exitReason"] = "forecast-flat";
        const notional = pos.margin * LEV;

        // Stop-loss
        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - slSpread);
          exitReason = "stop-loss";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + slSpread);
          exitReason = "stop-loss";
        }
        // Max hold
        else if (holdDays >= MAX_HOLD) {
          xp = bar.c * (pos.dir === "long" ? (1 - spread) : (1 + spread));
          exitReason = "max-hold";
        }
        // Signal check: if forecast flips to flat zone, exit at close
        else {
          const sig = config.getSignal(pair, i - 1, cs[i - 1].t);
          if (sig.dir === null || sig.dir !== pos.dir) {
            xp = bar.c * (pos.dir === "long" ? (1 - spread) : (1 + spread));
            exitReason = "forecast-flat";
          }
        }

        if (xp > 0) {
          const rawPct = pos.dir === "long"
            ? (xp / pos.ep - 1)
            : (pos.ep / xp - 1);
          const rawPnl = rawPct * notional;
          const feeCost = notional * FEE * 2;
          const pnl = rawPnl - feeCost;

          allTrades.push({
            pair, dir: pos.dir, ep: pos.ep, xp,
            et: pos.et, xt: bar.t, pnl, holdDays, exitReason,
            margin: pos.margin,
          });
          pos = null;
        }
      }

      // ─── Check entry (anti-look-ahead: signal on day i-1, entry at day i open) ───
      if (!pos && bar.t >= FULL_START) {
        const sig = config.getSignal(pair, i - 1, cs[i - 1].t);
        if (!sig.dir) continue;

        // BTC EMA filter for longs only
        if (sig.dir === "long" && !btcBullish(cs[i - 1].t)) continue;

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        // Sizing
        let margin: number;
        if (config.forecastSizing) {
          margin = Math.min(10, 5 * (Math.abs(sig.forecast) / 10));
          margin = Math.max(1, margin); // min $1
        } else {
          margin = 5;
        }

        const entryPrice = sig.dir === "long"
          ? bar.o * (1 + spread)
          : bar.o * (1 - spread);
        const slPrice = sig.dir === "long"
          ? entryPrice - ATR_MULT * prevATR
          : entryPrice + ATR_MULT * prevATR;

        pos = { pair, dir: sig.dir, ep: entryPrice, et: bar.t, sl: slPrice, margin };
      }
    }
  }

  return allTrades;
}

// ─── Variant definitions ────────────────────────────────────────

// Helper: get combined forecast from specific speed indices
function getCombinedForecast(pair: string, dayIdx: number, speedIndices: number[]): number {
  const pd = pairData.get(pair);
  if (!pd) return 0;
  let sum = 0;
  for (const si of speedIndices) {
    sum += pd.forecasts[si][dayIdx] ?? 0;
  }
  return sum / speedIndices.length;
}

// Variant 1a-1d: Individual EWMAC speeds
function makeIndividualVariant(speedIdx: number, label: string): VariantConfig {
  return {
    name: label,
    forecastSizing: true,
    getSignal(pair, dayIdx) {
      const pd = pairData.get(pair);
      if (!pd) return { dir: null, forecast: 0 };
      const f = pd.forecasts[speedIdx][dayIdx] ?? 0;
      if (f > FORECAST_THRESHOLD) return { dir: "long", forecast: f };
      if (f < -FORECAST_THRESHOLD) return { dir: "short", forecast: f };
      return { dir: null, forecast: 0 };
    },
  };
}

// Variant 2: Combined 4-speed
const variant4Speed: VariantConfig = {
  name: "Combined 4-speed",
  forecastSizing: true,
  getSignal(pair, dayIdx) {
    const f = getCombinedForecast(pair, dayIdx, [0, 1, 2, 3]);
    if (f > FORECAST_THRESHOLD) return { dir: "long", forecast: f };
    if (f < -FORECAST_THRESHOLD) return { dir: "short", forecast: f };
    return { dir: null, forecast: 0 };
  },
};

// Variant 3: Combined 2-speed (16,64) + (64,256)
const variant2Speed: VariantConfig = {
  name: "Combined 2-speed (16,64)+(64,256)",
  forecastSizing: true,
  getSignal(pair, dayIdx) {
    const f = getCombinedForecast(pair, dayIdx, [1, 3]);
    if (f > FORECAST_THRESHOLD) return { dir: "long", forecast: f };
    if (f < -FORECAST_THRESHOLD) return { dir: "short", forecast: f };
    return { dir: null, forecast: 0 };
  },
};

// Variant 4: Combined + Donchian filter
const variantEwmacDonch: VariantConfig = {
  name: "EWMAC+Donchian(30d)",
  forecastSizing: true,
  getSignal(pair, dayIdx) {
    const pd = pairData.get(pair);
    if (!pd) return { dir: null, forecast: 0 };
    const f = getCombinedForecast(pair, dayIdx, [0, 1, 2, 3]);
    if (f <= 0) return { dir: null, forecast: 0 }; // EWMAC must be positive

    // Donchian 30d breakout check
    const cs = pd.cs;
    if (dayIdx < 30) return { dir: null, forecast: 0 };
    const hi30 = donchianHigh(cs, dayIdx, 30);
    const lo30 = donchianLow(cs, dayIdx, 30);
    const prev = cs[dayIdx];

    if (prev.c > hi30 && f > FORECAST_THRESHOLD) return { dir: "long", forecast: f };
    if (prev.c < lo30 && f < -FORECAST_THRESHOLD) return { dir: "short", forecast: f };
    return { dir: null, forecast: 0 };
  },
};

// Variant 5: No forecast sizing (fixed $5)
const variantNoSizing: VariantConfig = {
  name: "Combined 4-speed (no sizing)",
  forecastSizing: false,
  getSignal(pair, dayIdx) {
    const f = getCombinedForecast(pair, dayIdx, [0, 1, 2, 3]);
    if (f > FORECAST_THRESHOLD) return { dir: "long", forecast: f };
    if (f < -FORECAST_THRESHOLD) return { dir: "short", forecast: f };
    return { dir: null, forecast: 0 };
  },
};

// Variant 6: Baseline Donchian(30d)
const variantDonchBaseline: VariantConfig = {
  name: "Baseline Donchian(30d)",
  forecastSizing: false,
  getSignal(pair, dayIdx) {
    const pd = pairData.get(pair);
    if (!pd) return { dir: null, forecast: 0 };
    const cs = pd.cs;
    if (dayIdx < 30) return { dir: null, forecast: 0 };
    const hi30 = donchianHigh(cs, dayIdx, 30);
    const lo30 = donchianLow(cs, dayIdx, 30);
    const prev = cs[dayIdx];

    if (prev.c > hi30) return { dir: "long", forecast: 10 };
    if (prev.c < lo30) return { dir: "short", forecast: 10 };
    return { dir: null, forecast: 0 };
  },
};

// ─── Metrics ────────────────────────────────────────────────────
interface Metrics {
  trades: number;
  wins: number;
  pnl: number;
  grossWin: number;
  grossLoss: number;
  maxDD: number;
  dailyPnls: number[];
  avgHold: number;
}

function calcMetrics(trades: Trade[], startTs: number, endTs?: number): Metrics {
  const filtered = trades.filter(t => t.et >= startTs && (!endTs || t.et < endTs));
  const wins = filtered.filter(t => t.pnl > 0).length;
  const pnl = filtered.reduce((s, t) => s + t.pnl, 0);
  const grossWin = filtered.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(filtered.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const avgHold = filtered.length > 0
    ? filtered.reduce((s, t) => s + t.holdDays, 0) / filtered.length
    : 0;

  // Daily P&L for Sharpe and MaxDD
  const dayPnlMap = new Map<number, number>();
  for (const t of filtered) {
    const dayKey = Math.floor(t.xt / DAY) * DAY;
    dayPnlMap.set(dayKey, (dayPnlMap.get(dayKey) ?? 0) + t.pnl);
  }

  // Fill in all days in range
  const allDays: number[] = [];
  const minDay = startTs;
  const maxDay = endTs ?? Date.now();
  for (let d = minDay; d <= maxDay; d += DAY) {
    allDays.push(Math.floor(d / DAY) * DAY);
  }

  const dailyPnls = allDays.map(d => dayPnlMap.get(d) ?? 0);

  // MaxDD
  let cum = 0, peak = 0, maxDD = 0;
  for (const dp of dailyPnls) {
    cum += dp;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades: filtered.length, wins, pnl, grossWin, grossLoss,
    maxDD, dailyPnls, avgHold,
  };
}

function sharpe(dailyPnls: number[]): number {
  if (dailyPnls.length < 10) return 0;
  const mean = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
  const variance = dailyPnls.reduce((s, x) => s + (x - mean) ** 2, 0) / dailyPnls.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(365);
}

function fmtRow(label: string, m: Metrics, numDays: number): string {
  const pf = m.grossLoss > 0 ? m.grossWin / m.grossLoss : m.grossWin > 0 ? Infinity : 0;
  const wr = m.trades > 0 ? (m.wins / m.trades * 100) : 0;
  const perDay = numDays > 0 ? m.pnl / numDays : 0;
  const sh = sharpe(m.dailyPnls);

  return [
    label.padEnd(36),
    String(m.trades).padStart(6),
    (pf === Infinity ? "inf" : pf.toFixed(2)).padStart(7),
    sh.toFixed(2).padStart(7),
    `${m.pnl >= 0 ? "+" : ""}$${m.pnl.toFixed(0)}`.padStart(9),
    `${wr.toFixed(1)}%`.padStart(7),
    `$${perDay.toFixed(2)}`.padStart(8),
    `$${m.maxDD.toFixed(0)}`.padStart(7),
    `${m.avgHold.toFixed(1)}d`.padStart(7),
  ].join(" ");
}

// ─── Run all variants ───────────────────────────────────────────
console.log("Loading data and computing forecasts...");
console.log(`Pairs loaded: ${pairData.size}`);
for (const [pair, pd] of pairData) {
  console.log(`  ${pair}: ${pd.cs.length} daily bars (${new Date(pd.cs[0].t).toISOString().slice(0, 10)} to ${new Date(pd.cs[pd.cs.length - 1].t).toISOString().slice(0, 10)})`);
}

const variants: VariantConfig[] = [
  makeIndividualVariant(0, "EWMAC(8,32)"),
  makeIndividualVariant(1, "EWMAC(16,64)"),
  makeIndividualVariant(2, "EWMAC(32,128)"),
  makeIndividualVariant(3, "EWMAC(64,256)"),
  variant4Speed,
  variant2Speed,
  variantEwmacDonch,
  variantNoSizing,
  variantDonchBaseline,
];

const results: { name: string; trades: Trade[] }[] = [];

for (const v of variants) {
  console.log(`Running ${v.name}...`);
  const trades = runVariant(v);
  results.push({ name: v.name, trades });
}

// ─── Full period metrics ────────────────────────────────────────
const fullEnd = new Date("2026-03-26").getTime();
const fullDays = Math.round((fullEnd - FULL_START) / DAY);
const oosDays = Math.round((fullEnd - OOS_START) / DAY);

console.log("\n" + "=".repeat(105));
console.log("EWMAC MULTI-SPEED TREND STRATEGY - FULL RESULTS");
console.log("=".repeat(105));

console.log("\n--- FULL PERIOD (2023-01 to 2026-03) ---\n");
console.log([
  "Variant".padEnd(36),
  "Trades".padStart(6),
  "PF".padStart(7),
  "Sharpe".padStart(7),
  "PnL".padStart(9),
  "WR".padStart(7),
  "$/day".padStart(8),
  "MaxDD".padStart(7),
  "Hold".padStart(7),
].join(" "));
console.log("-".repeat(105));

for (const r of results) {
  const m = calcMetrics(r.trades, FULL_START, fullEnd);
  console.log(fmtRow(r.name, m, fullDays));
}

console.log("\n--- OOS PERIOD (2025-09-01 onwards) ---\n");
console.log([
  "Variant".padEnd(36),
  "Trades".padStart(6),
  "PF".padStart(7),
  "Sharpe".padStart(7),
  "PnL".padStart(9),
  "WR".padStart(7),
  "$/day".padStart(8),
  "MaxDD".padStart(7),
  "Hold".padStart(7),
].join(" "));
console.log("-".repeat(105));

for (const r of results) {
  const m = calcMetrics(r.trades, OOS_START, fullEnd);
  console.log(fmtRow(r.name, m, oosDays));
}

// ─── Per-pair breakdown for best variant ────────────────────────
console.log("\n" + "=".repeat(90));
console.log("PER-PAIR BREAKDOWN - Combined 4-speed (OOS)");
console.log("=".repeat(90));

const combo4 = results.find(r => r.name === "Combined 4-speed")!;
const oosTrades = combo4.trades.filter(t => t.et >= OOS_START);

console.log("\n" + [
  "Pair".padEnd(8),
  "Trades".padStart(7),
  "WR%".padStart(7),
  "PnL".padStart(10),
  "Avg".padStart(10),
  "PF".padStart(8),
  "AvgHold".padStart(8),
].join(" "));
console.log("-".repeat(65));

const pairGroups = new Map<string, Trade[]>();
for (const t of oosTrades) {
  let arr = pairGroups.get(t.pair);
  if (!arr) { arr = []; pairGroups.set(t.pair, arr); }
  arr.push(t);
}

const sortedPairEntries = [...pairGroups.entries()].sort((a, b) => {
  const pa = a[1].reduce((s, t) => s + t.pnl, 0);
  const pb = b[1].reduce((s, t) => s + t.pnl, 0);
  return pb - pa;
});

for (const [pair, trades] of sortedPairEntries) {
  const n = trades.length;
  const w = trades.filter(t => t.pnl > 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avg = n > 0 ? pnl / n : 0;
  const gw = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
  const ah = trades.reduce((s, t) => s + t.holdDays, 0) / n;

  console.log([
    pair.padEnd(8),
    String(n).padStart(7),
    `${(w / n * 100).toFixed(1)}%`.padStart(7),
    `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`.padStart(10),
    `${avg >= 0 ? "+" : ""}$${avg.toFixed(2)}`.padStart(10),
    (pf === Infinity ? "inf" : pf.toFixed(2)).padStart(8),
    `${ah.toFixed(1)}d`.padStart(8),
  ].join(" "));
}

// Pairs with no OOS trades
for (const pair of PAIRS) {
  if (!pairGroups.has(pair)) {
    console.log(`${pair.padEnd(8)} ${"0".padStart(7)}    --        --        --      --      --`);
  }
}

// ─── Exit reason breakdown for 4-speed ──────────────────────────
console.log("\n" + "=".repeat(60));
console.log("EXIT REASON BREAKDOWN - Combined 4-speed (OOS)");
console.log("=".repeat(60));

const exitGroups = new Map<string, { count: number; pnl: number }>();
for (const t of oosTrades) {
  const v = exitGroups.get(t.exitReason) || { count: 0, pnl: 0 };
  v.count++;
  v.pnl += t.pnl;
  exitGroups.set(t.exitReason, v);
}

console.log("\n" + [
  "Reason".padEnd(18),
  "Count".padStart(6),
  "Pct%".padStart(7),
  "AvgPnL".padStart(10),
  "TotalPnL".padStart(12),
].join(" "));
console.log("-".repeat(58));

for (const reason of ["stop-loss", "forecast-flat", "max-hold"]) {
  const v = exitGroups.get(reason) || { count: 0, pnl: 0 };
  const pct = oosTrades.length > 0 ? (v.count / oosTrades.length * 100) : 0;
  const avg = v.count > 0 ? v.pnl / v.count : 0;
  console.log([
    reason.padEnd(18),
    String(v.count).padStart(6),
    `${pct.toFixed(1)}%`.padStart(7),
    `${avg >= 0 ? "+" : ""}$${avg.toFixed(2)}`.padStart(10),
    `${v.pnl >= 0 ? "+" : ""}$${v.pnl.toFixed(2)}`.padStart(12),
  ].join(" "));
}

// ─── Direction breakdown for 4-speed (OOS) ─────────────────────
console.log("\n" + "=".repeat(60));
console.log("DIRECTION BREAKDOWN - Combined 4-speed (OOS)");
console.log("=".repeat(60));

const longs = oosTrades.filter(t => t.dir === "long");
const shorts = oosTrades.filter(t => t.dir === "short");
const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
const longWR = longs.length > 0 ? longs.filter(t => t.pnl > 0).length / longs.length * 100 : 0;
const shortWR = shorts.length > 0 ? shorts.filter(t => t.pnl > 0).length / shorts.length * 100 : 0;

console.log(`\nLong:  ${longs.length} trades, WR ${longWR.toFixed(1)}%, PnL ${longPnl >= 0 ? "+" : ""}$${longPnl.toFixed(2)}`);
console.log(`Short: ${shorts.length} trades, WR ${shortWR.toFixed(1)}%, PnL ${shortPnl >= 0 ? "+" : ""}$${shortPnl.toFixed(2)}`);

// ─── Monthly P&L for 4-speed ────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log("MONTHLY P&L - Combined 4-speed (full period)");
console.log("=".repeat(60));

const monthMap = new Map<string, { trades: number; wins: number; pnl: number }>();
for (const t of combo4.trades) {
  const m = new Date(t.xt).toISOString().slice(0, 7);
  const v = monthMap.get(m) || { trades: 0, wins: 0, pnl: 0 };
  v.trades++;
  if (t.pnl > 0) v.wins++;
  v.pnl += t.pnl;
  monthMap.set(m, v);
}

console.log("\n" + [
  "Month".padEnd(10),
  "Trades".padStart(7),
  "WR%".padStart(7),
  "PnL".padStart(10),
  "CumPnL".padStart(10),
].join(" "));
console.log("-".repeat(50));

let cumPnl = 0;
for (const [m, v] of [...monthMap.entries()].sort()) {
  cumPnl += v.pnl;
  const wr = v.trades > 0 ? (v.wins / v.trades * 100).toFixed(1) : "--";
  console.log([
    m.padEnd(10),
    String(v.trades).padStart(7),
    `${wr}%`.padStart(7),
    `${v.pnl >= 0 ? "+" : ""}$${v.pnl.toFixed(0)}`.padStart(10),
    `${cumPnl >= 0 ? "+" : ""}$${cumPnl.toFixed(0)}`.padStart(10),
  ].join(" "));
}

// ─── Forecast distribution sample ──────────────────────────────
console.log("\n" + "=".repeat(60));
console.log("FORECAST DISTRIBUTION SAMPLE - Combined 4-speed");
console.log("=".repeat(60));

// Show forecast distribution for BTC and ETH
for (const pair of ["BTC", "ETH", "SOL"]) {
  const pd = pairData.get(pair);
  if (!pd) continue;
  const combinedForecasts: number[] = [];
  for (let i = 257; i < pd.cs.length; i++) {
    const f = getCombinedForecast(pair, i, [0, 1, 2, 3]);
    combinedForecasts.push(f);
  }
  const nonZero = combinedForecasts.filter(f => f !== 0);
  const absF = nonZero.map(Math.abs);
  absF.sort((a, b) => a - b);
  const mean = absF.reduce((a, b) => a + b, 0) / absF.length;
  const p50 = absF[Math.floor(absF.length * 0.5)];
  const p90 = absF[Math.floor(absF.length * 0.9)];
  const above2 = nonZero.filter(f => Math.abs(f) > 2).length;
  const above10 = nonZero.filter(f => Math.abs(f) > 10).length;
  console.log(`\n${pair}: ${nonZero.length} non-zero forecasts`);
  console.log(`  Mean |f|: ${mean.toFixed(2)}, Median |f|: ${p50.toFixed(2)}, P90 |f|: ${p90.toFixed(2)}`);
  console.log(`  |f|>2: ${above2} (${(above2/nonZero.length*100).toFixed(1)}%), |f|>10: ${above10} (${(above10/nonZero.length*100).toFixed(1)}%)`);
  console.log(`  Long signals (f>2): ${nonZero.filter(f => f > 2).length}, Short signals (f<-2): ${nonZero.filter(f => f < -2).length}`);
}

// ─── Top 5 best and worst trades (4-speed OOS) ─────────────────
console.log("\n" + "=".repeat(85));
console.log("TOP 5 BEST & WORST TRADES - Combined 4-speed (OOS)");
console.log("=".repeat(85));

const sortedOOS = [...oosTrades].sort((a, b) => b.pnl - a.pnl);

console.log("\nBest:");
console.log([
  "Pair".padEnd(8), "Dir".padEnd(6), "Entry".padStart(12), "Exit".padStart(12),
  "Hold".padStart(6), "PnL".padStart(10), "Date".padStart(12), "Reason".padStart(14),
].join(" "));
console.log("-".repeat(85));

for (const t of sortedOOS.slice(0, 5)) {
  console.log([
    t.pair.padEnd(8), t.dir.padEnd(6),
    `$${t.ep.toFixed(4)}`.padStart(12), `$${t.xp.toFixed(4)}`.padStart(12),
    `${t.holdDays}d`.padStart(6),
    `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`.padStart(10),
    new Date(t.et).toISOString().slice(0, 10).padStart(12),
    t.exitReason.padStart(14),
  ].join(" "));
}

console.log("\nWorst:");
console.log([
  "Pair".padEnd(8), "Dir".padEnd(6), "Entry".padStart(12), "Exit".padStart(12),
  "Hold".padStart(6), "PnL".padStart(10), "Date".padStart(12), "Reason".padStart(14),
].join(" "));
console.log("-".repeat(85));

for (const t of sortedOOS.slice(-5).reverse()) {
  console.log([
    t.pair.padEnd(8), t.dir.padEnd(6),
    `$${t.ep.toFixed(4)}`.padStart(12), `$${t.xp.toFixed(4)}`.padStart(12),
    `${t.holdDays}d`.padStart(6),
    `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`.padStart(10),
    new Date(t.et).toISOString().slice(0, 10).padStart(12),
    t.exitReason.padStart(14),
  ].join(" "));
}

console.log("\nDone.");
