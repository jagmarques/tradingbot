/**
 * Binance Derivatives Signals as Filters on Supertrend Engine
 *
 * Downloads FREE Binance futures data (no auth needed):
 *   - Global Long/Short Account Ratio (4h)
 *   - Top Trader Long/Short Position Ratio (4h)
 *   - Taker Buy/Sell Volume Ratio (4h)
 * Also attempts SOPR from BGeometrics.
 *
 * Problem: Binance only returns ~28 days of 4h data (168 bars).
 * Solution: Run TWO backtests:
 *   A) Full 3-year Supertrend baseline (context)
 *   B) Signal-window test (~28 days) with NO volume/BTC filters
 *      to maximize trade count, then test Binance signals as replacement filters.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-binance-signals.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const BINANCE_DIR = "/tmp/binance-signals";
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const SL_SLIPPAGE = 1.5;

const SPREAD: Record<string, number> = {
  BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4, XRP: 1.05e-4,
  DOGE: 1.35e-4, LINK: 3.45e-4,
};
const DFLT_SPREAD = 4e-4;

const PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "LINK"];
const BINANCE_SYMBOLS: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT",
  XRP: "XRPUSDT", DOGE: "DOGEUSDT", LINK: "LINKUSDT",
};

const MARGIN = 5;
const LEV = 10;

const FULL_START = new Date("2023-06-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string; dir: Dir; ep: number; et: number; sl: number;
  margin: number; lev: number; atr: number; bestPnlAtr: number;
}

interface Trade {
  pair: string; dir: Dir; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

interface BinanceRatio {
  timestamp: number;
  value: number;
}

interface SoprEntry {
  timestamp: number;
  sopr: number;
}

interface Stats {
  trades: number; pf: number; sharpe: number; perDay: number; wr: number;
  maxDd: number; totalPnl: number; avgPnl: number; winners: number; losers: number;
}

// ─── Step 1: Download Binance Data ──────────────────────────────────
async function downloadBinanceData(): Promise<void> {
  if (!fs.existsSync(BINANCE_DIR)) fs.mkdirSync(BINANCE_DIR, { recursive: true });

  const endpoints = [
    { name: "globalLongShort", url: "https://fapi.binance.com/futures/data/globalLongShortAccountRatio" },
    { name: "topTraderPositions", url: "https://fapi.binance.com/futures/data/topLongShortPositionRatio" },
    { name: "takerBuySell", url: "https://fapi.binance.com/futures/data/takerlongshortRatio" },
  ];

  for (const pair of PAIRS) {
    const symbol = BINANCE_SYMBOLS[pair];
    for (const ep of endpoints) {
      const fp = path.join(BINANCE_DIR, `${pair}_${ep.name}.json`);
      if (fs.existsSync(fp)) {
        try {
          const existing = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
          const ageH = (Date.now() - fs.statSync(fp).mtimeMs) / H1;
          if (existing.length >= 100 && ageH < 4) {
            console.log(`  [cache] ${pair} ${ep.name} (${existing.length} records)`);
            continue;
          }
        } catch { /* re-download */ }
      }

      const url = `${ep.url}?symbol=${symbol}&period=4h&limit=500`;
      console.log(`  Fetching ${pair} ${ep.name}...`);
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          console.log(`  WARN: ${pair} ${ep.name} HTTP ${resp.status}`);
          continue;
        }
        const data = await resp.json();
        fs.writeFileSync(fp, JSON.stringify(data, null, 0));
        console.log(`  OK: ${(data as any[]).length} records`);
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        console.log(`  ERR: ${pair} ${ep.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Also download 1h data for finer resolution
  for (const pair of PAIRS) {
    const symbol = BINANCE_SYMBOLS[pair];
    for (const ep of endpoints) {
      const fp = path.join(BINANCE_DIR, `${pair}_${ep.name}_1h.json`);
      if (fs.existsSync(fp)) {
        try {
          const existing = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
          const ageH = (Date.now() - fs.statSync(fp).mtimeMs) / H1;
          if (existing.length >= 100 && ageH < 4) {
            console.log(`  [cache] ${pair} ${ep.name}_1h (${existing.length} records)`);
            continue;
          }
        } catch { /* re-download */ }
      }

      const url = `${ep.url}?symbol=${symbol}&period=1h&limit=500`;
      console.log(`  Fetching ${pair} ${ep.name} (1h)...`);
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          console.log(`  WARN: ${pair} ${ep.name} 1h HTTP ${resp.status}`);
          continue;
        }
        const data = await resp.json();
        fs.writeFileSync(fp, JSON.stringify(data, null, 0));
        console.log(`  OK: ${(data as any[]).length} 1h records`);
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        console.log(`  ERR: ${pair} ${ep.name} 1h: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

async function downloadSopr(): Promise<void> {
  const fp = path.join(BINANCE_DIR, "sopr.json");
  if (fs.existsSync(fp)) {
    try {
      const existing = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
      if (existing.length > 10) {
        console.log(`  [cache] SOPR (${existing.length} records)`);
        return;
      }
    } catch { /* re-download */ }
  }

  console.log("  Fetching SOPR from BGeometrics...");
  try {
    const resp = await fetch("https://bitcoin-data.com/v1/sopr", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) {
      console.log(`  WARN: SOPR HTTP ${resp.status} (rate limited)`);
      return;
    }
    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0) {
      fs.writeFileSync(fp, JSON.stringify(data, null, 0));
      console.log(`  OK: ${data.length} SOPR records`);
    }
  } catch (err) {
    console.log(`  ERR: SOPR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Load Data ──────────────────────────────────────────────────────
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

function loadBinanceRatio(pair: string, name: string, suffix: string = ""): BinanceRatio[] {
  const fp = path.join(BINANCE_DIR, `${pair}_${name}${suffix}.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((r: any) => ({
    timestamp: typeof r.timestamp === "number" ? r.timestamp : parseInt(r.timestamp, 10),
    value: parseFloat(r.longShortRatio ?? r.buySellRatio ?? "1"),
  })).sort((a: BinanceRatio, b: BinanceRatio) => a.timestamp - b.timestamp);
}

function loadSopr(): SoprEntry[] {
  const fp = path.join(BINANCE_DIR, "sopr.json");
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
    return raw.map((r: any) => {
      let ts: number;
      if (r.timestamp) ts = typeof r.timestamp === "number" ? r.timestamp : new Date(r.timestamp).getTime();
      else if (r.date) ts = new Date(r.date).getTime();
      else if (r.t) ts = typeof r.t === "number" ? r.t : new Date(r.t).getTime();
      else return null;
      const sopr = parseFloat(r.sopr ?? r.SOPR ?? r.value ?? "1");
      if (isNaN(ts) || isNaN(sopr)) return null;
      return { timestamp: Math.floor(ts / DAY) * DAY, sopr };
    }).filter((x: any): x is SoprEntry => x !== null);
  } catch {
    return [];
  }
}

// ─── Indicators ─────────────────────────────────────────────────────
function atrFn(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c),
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

function emaArr(vals: number[], period: number): number[] {
  const r: number[] = [];
  const k = 2 / (period + 1);
  let v = vals[0];
  for (let i = 0; i < vals.length; i++) {
    if (i === 0) v = vals[i];
    else v = vals[i] * k + v * (1 - k);
    r.push(v);
  }
  return r;
}

// ─── Build Signal Maps ──────────────────────────────────────────────
function buildSignalMap(ratios: BinanceRatio[], period: number = H4): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of ratios) {
    const key = Math.floor(r.timestamp / period) * period;
    m.set(key, r.value);
  }
  return m;
}

function buildSoprMap(entries: SoprEntry[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const e of entries) m.set(e.timestamp, e.sopr);
  return m;
}

function getSignalAtOrBefore(map: Map<number, number>, t: number, period: number): number | null {
  const aligned = Math.floor(t / period) * period;
  // Use completed bar
  const lookupT = aligned - period;
  for (let dt = 0; dt <= 5 * period; dt += period) {
    const val = map.get(lookupT - dt);
    if (val !== undefined) return val;
  }
  return null;
}

function getSoprAtOrBefore(map: Map<number, number>, t: number): number | null {
  const dayT = Math.floor(t / DAY) * DAY;
  for (let dt = DAY; dt <= 5 * DAY; dt += DAY) {
    const val = map.get(dayT - dt);
    if (val !== undefined) return val;
  }
  return null;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

function closeTrade(pos: Position, exitPrice: number, exitTime: number, reason: string, slipMult: number = 1): Trade {
  const sp_ = sp(pos.pair);
  const xp = pos.dir === "long"
    ? exitPrice * (1 - sp_ * slipMult)
    : exitPrice * (1 + sp_ * slipMult);
  const notional = pos.margin * pos.lev;
  const raw = pos.dir === "long"
    ? (xp / pos.ep - 1) * notional
    : (pos.ep / xp - 1) * notional;
  const cost = notional * FEE * 2;
  return {
    pair: pos.pair, dir: pos.dir, ep: pos.ep, xp,
    et: pos.et, xt: exitTime, pnl: raw - cost, reason,
  };
}

// ─── Backtest Engine ────────────────────────────────────────────────
interface PairPrecomp {
  name: string;
  h4: Bar[];
  h4Map: Map<number, number>;
  stTrend: (1 | -1 | null)[];
  atr14: (number | null)[];
}

interface BTCPrecomp {
  daily: Bar[];
  dailyEma20: number[];
  dailyEma50: number[];
}

type FilterFn = (pair: string, dir: Dir, barTs: number) => boolean;

function runBacktest(
  pairs: PairPrecomp[],
  btcData: BTCPrecomp,
  filterFn: FilterFn,
  startMs: number,
  endMs: number,
  useVolFilter: boolean,
  useBtcFilter: boolean,
): Trade[] {
  const trades: Trade[] = [];
  const positions = new Map<string, Position>();

  const allTimestamps = new Set<number>();
  for (const pp of pairs) {
    for (const bar of pp.h4) {
      if (bar.t >= startMs && bar.t < endMs) allTimestamps.add(bar.t);
    }
  }
  const sortedTs = [...allTimestamps].sort((a, b) => a - b);

  function btcBullish(t: number): boolean {
    const dayT = Math.floor(t / DAY) * DAY - DAY;
    let bestIdx = -1;
    for (let i = btcData.daily.length - 1; i >= 0; i--) {
      if (btcData.daily[i].t <= dayT) { bestIdx = i; break; }
    }
    if (bestIdx < 0) return false;
    return btcData.dailyEma20[bestIdx] > btcData.dailyEma50[bestIdx];
  }

  for (const ts of sortedTs) {
    // ─── Exit logic ──────────────────────────────────────────
    for (const [key, pos] of [...positions.entries()]) {
      const pp = pairs.find(p => p.name === pos.pair);
      if (!pp) continue;
      const h4i = pp.h4Map.get(ts);
      if (h4i === undefined) continue;
      const bar = pp.h4[h4i];

      // Stop-loss
      if (pos.dir === "long" && bar.l <= pos.sl) {
        trades.push(closeTrade(pos, pos.sl, ts, "sl", SL_SLIPPAGE));
        positions.delete(key); continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        trades.push(closeTrade(pos, pos.sl, ts, "sl", SL_SLIPPAGE));
        positions.delete(key); continue;
      }

      // Max hold: 60 days
      if (ts - pos.et >= 60 * DAY) {
        trades.push(closeTrade(pos, bar.c, ts, "maxhold"));
        positions.delete(key); continue;
      }

      // ATR trailing
      if (pos.atr > 0) {
        const unrealPnlAtr = pos.dir === "long"
          ? (bar.c - pos.ep) / pos.atr
          : (pos.ep - bar.c) / pos.atr;
        if (unrealPnlAtr > pos.bestPnlAtr) pos.bestPnlAtr = unrealPnlAtr;

        let newSl = pos.sl;
        if (pos.bestPnlAtr >= 3) {
          const tp = pos.dir === "long"
            ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
            : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
          newSl = pos.dir === "long" ? Math.max(pos.sl, tp) : Math.min(pos.sl, tp);
        } else if (pos.bestPnlAtr >= 2) {
          const tp = pos.dir === "long"
            ? bar.h - 2 * pos.atr
            : bar.l + 2 * pos.atr;
          newSl = pos.dir === "long" ? Math.max(pos.sl, tp) : Math.min(pos.sl, tp);
        } else if (pos.bestPnlAtr >= 1) {
          newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
        }
        pos.sl = newSl;
      }

      // Supertrend flip exit
      const stNow = pp.stTrend[h4i];
      if (stNow !== null) {
        if ((pos.dir === "long" && stNow === -1) || (pos.dir === "short" && stNow === 1)) {
          trades.push(closeTrade(pos, bar.c, ts, "st-flip"));
          positions.delete(key); continue;
        }
      }
    }

    // ─── Entry logic ─────────────────────────────────────────
    for (const pp of pairs) {
      const key = pp.name;
      if (positions.has(key)) continue;

      const h4i = pp.h4Map.get(ts);
      if (h4i === undefined || h4i < 21) continue;

      // Supertrend flip (completed bars)
      const stNow = pp.stTrend[h4i - 1];
      const stPrev = pp.stTrend[h4i - 2];
      if (stNow === null || stPrev === null || stNow === stPrev) continue;

      const dir: Dir = stNow === 1 ? "long" : "short";

      // Volume confirmation (optional)
      if (useVolFilter) {
        const flipBar = pp.h4[h4i - 1];
        let volSum = 0;
        for (let j = h4i - 21; j < h4i - 1; j++) {
          if (j >= 0) volSum += pp.h4[j].v;
        }
        const avgVol = volSum / 20;
        if (avgVol <= 0 || flipBar.v < 1.5 * avgVol) continue;
      }

      // BTC directional filter (optional)
      if (useBtcFilter && dir === "long" && !btcBullish(ts)) continue;

      // Binance signal filter
      if (!filterFn(pp.name, dir, ts)) continue;

      const atrVal = pp.atr14[h4i - 1];
      if (atrVal === null) continue;

      const sp_ = sp(pp.name);
      const ep = dir === "long" ? pp.h4[h4i].o * (1 + sp_) : pp.h4[h4i].o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(key, {
        pair: pp.name, dir, ep, et: ts, sl, margin: MARGIN, lev: LEV,
        atr: atrVal, bestPnlAtr: 0,
      });
    }
  }

  // Close remaining
  for (const [key, pos] of positions) {
    const pp = pairs.find(p => p.name === pos.pair);
    if (!pp) continue;
    const lastBar = pp.h4[pp.h4.length - 1];
    trades.push(closeTrade(pos, lastBar.c, lastBar.t, "end"));
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
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

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log("=== Binance Derivatives Signals as Supertrend Filters ===\n");

  // Step 1: Download
  console.log("Step 1: Downloading Binance data...");
  await downloadBinanceData();
  await downloadSopr();
  console.log("");

  // Step 2: Load candle data
  console.log("Step 2: Loading candle data...");
  const pairPrecomps: PairPrecomp[] = [];

  for (const pair of PAIRS) {
    const m5 = load5m(pair);
    if (m5.length < 1000) {
      console.log(`  SKIP ${pair}: only ${m5.length} 5m candles`);
      continue;
    }
    const h4 = aggregate(m5, H4);
    const stResult = supertrend(h4, 14, 1.75);
    const atr14 = atrFn(h4, 14);
    const h4Map = new Map(h4.map((b, i) => [b.t, i]));

    pairPrecomps.push({ name: pair, h4, h4Map, stTrend: stResult.trend, atr14 });
    console.log(`  ${pair}: ${h4.length} 4h bars (${new Date(h4[0].t).toISOString().slice(0, 10)} to ${new Date(h4[h4.length - 1].t).toISOString().slice(0, 10)})`);
  }

  const btcM5 = load5m("BTC");
  const btcDaily = aggregate(btcM5, DAY);
  const btcCloses = btcDaily.map(b => b.c);
  const btcEma20 = emaArr(btcCloses, 20);
  const btcEma50 = emaArr(btcCloses, 50);
  const btcPrecomp: BTCPrecomp = { daily: btcDaily, dailyEma20: btcEma20, dailyEma50: btcEma50 };
  console.log(`  BTC daily: ${btcDaily.length} bars\n`);

  // Step 3: Load Binance signals
  console.log("Step 3: Loading signal data...");

  const globalLSMaps = new Map<string, Map<number, number>>();
  const topTraderMaps = new Map<string, Map<number, number>>();
  const takerBSMaps = new Map<string, Map<number, number>>();
  // Also load 1h data and aggregate to 4h (average of 4 hourly values)
  const globalLS1hMaps = new Map<string, Map<number, number>>();
  const topTrader1hMaps = new Map<string, Map<number, number>>();
  const takerBS1hMaps = new Map<string, Map<number, number>>();

  for (const pair of PAIRS.filter(p => pairPrecomps.some(pp => pp.name === p))) {
    const gls = loadBinanceRatio(pair, "globalLongShort");
    const tt = loadBinanceRatio(pair, "topTraderPositions");
    const tbs = loadBinanceRatio(pair, "takerBuySell");

    globalLSMaps.set(pair, buildSignalMap(gls));
    topTraderMaps.set(pair, buildSignalMap(tt));
    takerBSMaps.set(pair, buildSignalMap(tbs));

    // 1h data
    const gls1h = loadBinanceRatio(pair, "globalLongShort", "_1h");
    const tt1h = loadBinanceRatio(pair, "topTraderPositions", "_1h");
    const tbs1h = loadBinanceRatio(pair, "takerBuySell", "_1h");

    globalLS1hMaps.set(pair, buildSignalMap(gls1h, H1));
    topTrader1hMaps.set(pair, buildSignalMap(tt1h, H1));
    takerBS1hMaps.set(pair, buildSignalMap(tbs1h, H1));

    console.log(`  ${pair}: 4h GLS=${gls.length} TT=${tt.length} TBS=${tbs.length} | 1h GLS=${gls1h.length} TT=${tt1h.length} TBS=${tbs1h.length}`);
  }

  const soprEntries = loadSopr();
  const soprMap = buildSoprMap(soprEntries);
  console.log(`  SOPR: ${soprEntries.length} daily records`);

  // Determine signal window
  let signalStart = 0;
  let signalEnd = 0;
  for (const pair of PAIRS.filter(p => pairPrecomps.some(pp => pp.name === p))) {
    const gls = globalLSMaps.get(pair)!;
    const keys = [...gls.keys()].sort((a, b) => a - b);
    if (keys.length > 0) {
      if (signalStart === 0 || keys[0] > signalStart) signalStart = keys[0];
      if (signalEnd === 0 || keys[keys.length - 1] > signalEnd) signalEnd = keys[keys.length - 1];
    }
  }
  signalStart += 2 * H4; // minimal warmup
  signalEnd += H4;

  const signalDays = Math.round((signalEnd - signalStart) / DAY);
  console.log(`\n  Signal window: ${new Date(signalStart).toISOString().slice(0, 16)} to ${new Date(signalEnd).toISOString().slice(0, 16)} (~${signalDays} days)`);

  // Signal distributions
  console.log("\nStep 4: Signal distributions (4h)...");
  for (const pair of PAIRS.filter(p => pairPrecomps.some(pp => pp.name === p))) {
    const gls = [...(globalLSMaps.get(pair)?.values() ?? [])].sort((a, b) => a - b);
    const tt = [...(topTraderMaps.get(pair)?.values() ?? [])].sort((a, b) => a - b);
    const tbs = [...(takerBSMaps.get(pair)?.values() ?? [])].sort((a, b) => a - b);
    if (gls.length > 0) {
      const p = (f: number) => gls[Math.floor(gls.length * f)].toFixed(3);
      console.log(`  ${pair.padEnd(5)} GLS: [${gls[0].toFixed(3)} .. ${p(0.25)} | ${p(0.5)} | ${p(0.75)} .. ${gls[gls.length - 1].toFixed(3)}]`);
    }
    if (tt.length > 0) {
      const p = (f: number) => tt[Math.floor(tt.length * f)].toFixed(3);
      console.log(`  ${pair.padEnd(5)} TT:  [${tt[0].toFixed(3)} .. ${p(0.25)} | ${p(0.5)} | ${p(0.75)} .. ${tt[tt.length - 1].toFixed(3)}]`);
    }
    if (tbs.length > 0) {
      const p = (f: number) => tbs[Math.floor(tbs.length * f)].toFixed(3);
      console.log(`  ${pair.padEnd(5)} TBS: [${tbs[0].toFixed(3)} .. ${p(0.25)} | ${p(0.5)} | ${p(0.75)} .. ${tbs[tbs.length - 1].toFixed(3)}]`);
    }
  }

  // ─── Helper to get a 4h-aligned 1h signal (average of 4 hours) ────
  function get1hAvgAt4h(map1h: Map<number, number>, t: number): number | null {
    const aligned = Math.floor(t / H4) * H4;
    const prev4h = aligned - H4;
    let sum = 0, cnt = 0;
    for (let h = 0; h < 4; h++) {
      const val = map1h.get(prev4h + h * H1);
      if (val !== undefined) { sum += val; cnt++; }
    }
    return cnt >= 2 ? sum / cnt : null;
  }

  // ─── Define Filters ──────────────────────────────────────────
  interface FilterConfig { label: string; filter: FilterFn; }

  const noFilter: FilterFn = () => true;

  const filters: FilterConfig[] = [
    // ── SECTION A: signal-window tests, no vol/BTC filters (maximum trade count) ──
    { label: "A0. No filters (raw ST)", filter: noFilter },
    {
      label: "A1. L/S Contrarian 1.5",
      filter: (pair, dir, ts) => {
        const val = getSignalAtOrBefore(globalLSMaps.get(pair)!, ts, H4);
        if (val === null) return true;
        if (val > 1.5 && dir === "long") return false;
        if (val < 0.67 && dir === "short") return false;
        return true;
      },
    },
    {
      label: "A2. Taker B/S 0.55",
      filter: (pair, dir, ts) => {
        const val = getSignalAtOrBefore(takerBSMaps.get(pair)!, ts, H4);
        if (val === null) return true;
        if (dir === "long" && val < 0.45) return false;
        if (dir === "short" && val > 0.55) return false;
        return true;
      },
    },
    {
      label: "A3. Top Trader C. 0.6",
      filter: (pair, dir, ts) => {
        const val = getSignalAtOrBefore(topTraderMaps.get(pair)!, ts, H4);
        if (val === null) return true;
        if (val > 0.6 && dir === "long") return false;
        if (val < 0.4 && dir === "short") return false;
        return true;
      },
    },
    {
      label: "A4. Combined all 3",
      filter: (pair, dir, ts) => {
        const gls = getSignalAtOrBefore(globalLSMaps.get(pair)!, ts, H4);
        const tbs = getSignalAtOrBefore(takerBSMaps.get(pair)!, ts, H4);
        const tt = getSignalAtOrBefore(topTraderMaps.get(pair)!, ts, H4);
        if (gls !== null) { if (gls > 1.5 && dir === "long") return false; if (gls < 0.67 && dir === "short") return false; }
        if (tbs !== null) { if (dir === "long" && tbs < 0.45) return false; if (dir === "short" && tbs > 0.55) return false; }
        if (tt !== null) { if (tt > 0.6 && dir === "long") return false; if (tt < 0.4 && dir === "short") return false; }
        return true;
      },
    },
    {
      label: "A5. SOPR regime",
      filter: (_pair, dir, ts) => {
        const sopr = getSoprAtOrBefore(soprMap, ts);
        if (sopr === null) return true;
        if (sopr < 1.0 && dir === "short") return false;
        if (sopr > 1.05 && dir === "long") return false;
        return true;
      },
    },
    // Relaxed thresholds based on distributions
    {
      label: "A6. L/S Contrar. 1.3",
      filter: (pair, dir, ts) => {
        const val = getSignalAtOrBefore(globalLSMaps.get(pair)!, ts, H4);
        if (val === null) return true;
        if (val > 1.3 && dir === "long") return false;
        if (val < 0.77 && dir === "short") return false;
        return true;
      },
    },
    {
      label: "A7. Taker B/S 0.52",
      filter: (pair, dir, ts) => {
        const val = getSignalAtOrBefore(takerBSMaps.get(pair)!, ts, H4);
        if (val === null) return true;
        if (dir === "long" && val < 0.48) return false;
        if (dir === "short" && val > 0.52) return false;
        return true;
      },
    },
    {
      label: "A8. Top Trader C. 0.55",
      filter: (pair, dir, ts) => {
        const val = getSignalAtOrBefore(topTraderMaps.get(pair)!, ts, H4);
        if (val === null) return true;
        if (val > 0.55 && dir === "long") return false;
        if (val < 0.45 && dir === "short") return false;
        return true;
      },
    },
    {
      label: "A9. L/S + Taker combo",
      filter: (pair, dir, ts) => {
        const gls = getSignalAtOrBefore(globalLSMaps.get(pair)!, ts, H4);
        const tbs = getSignalAtOrBefore(takerBSMaps.get(pair)!, ts, H4);
        if (gls !== null) { if (gls > 1.3 && dir === "long") return false; if (gls < 0.77 && dir === "short") return false; }
        if (tbs !== null) { if (dir === "long" && tbs < 0.48) return false; if (dir === "short" && tbs > 0.52) return false; }
        return true;
      },
    },
    // 1h signal variants (average 4 hourly readings)
    {
      label: "A10. L/S 1h-avg C.1.3",
      filter: (pair, dir, ts) => {
        const val = get1hAvgAt4h(globalLS1hMaps.get(pair)!, ts);
        if (val === null) return true;
        if (val > 1.3 && dir === "long") return false;
        if (val < 0.77 && dir === "short") return false;
        return true;
      },
    },
    {
      label: "A11. Taker 1h-avg 0.52",
      filter: (pair, dir, ts) => {
        const val = get1hAvgAt4h(takerBS1hMaps.get(pair)!, ts);
        if (val === null) return true;
        if (dir === "long" && val < 0.48) return false;
        if (dir === "short" && val > 0.52) return false;
        return true;
      },
    },
  ];

  // ═══ RUN BACKTESTS ═══════════════════════════════════════════

  console.log("\n\n" + "=".repeat(130));
  console.log("PART 1: FULL 3-YEAR BASELINE (context)");
  console.log("=".repeat(130));
  {
    const trades = runBacktest(pairPrecomps, btcPrecomp, noFilter, FULL_START, FULL_END, true, true);
    const stats = computeStats(trades, FULL_START, FULL_END);
    const fullDays = Math.round((FULL_END - FULL_START) / DAY);
    console.log(`\nSupertrend(14,1.75) + volume + BTC filter | ${new Date(FULL_START).toISOString().slice(0, 10)} to ${new Date(FULL_END).toISOString().slice(0, 10)} (~${fullDays} days)`);
    console.log(`Trades: ${stats.trades} | WR: ${stats.wr}% | PF: ${stats.pf} | Sharpe: ${stats.sharpe} | $/day: ${stats.perDay} | Total: $${stats.totalPnl} | MaxDD: $${stats.maxDd}`);

    // Also show the signal-window slice
    const swStats = computeStats(trades, signalStart, signalEnd);
    console.log(`\nSame engine during signal window only (${signalDays} days):`);
    console.log(`Trades: ${swStats.trades} | WR: ${swStats.wr}% | PF: ${swStats.pf} | $/day: ${swStats.perDay} | Total: $${swStats.totalPnl}`);
  }

  console.log("\n\n" + "=".repeat(130));
  console.log("PART 2: SIGNAL-WINDOW TEST -- Raw Supertrend (NO vol/BTC filters) + Binance signal filters");
  console.log(`Window: ${new Date(signalStart).toISOString().slice(0, 10)} to ${new Date(signalEnd).toISOString().slice(0, 10)} (~${signalDays} days)`);
  console.log("Logic: Remove our existing vol/BTC filters. Test if Binance signals can serve as BETTER entry filters.");
  console.log("=".repeat(130));
  console.log("");

  interface Result { label: string; stats: Stats; trades: Trade[]; }
  const results: Result[] = [];

  for (const fc of filters) {
    const trades = runBacktest(pairPrecomps, btcPrecomp, fc.filter, signalStart, signalEnd, false, false);
    const stats = computeStats(trades, signalStart, signalEnd);
    results.push({ label: fc.label, stats, trades });
  }

  function pad(s: string, n: number): string { return s.padStart(n); }
  function fmtPnl(v: number): string { return (v >= 0 ? "+" : "") + v.toFixed(2); }

  const hdr = "Filter".padEnd(25)
    + pad("Trades", 7) + pad("W", 5) + pad("L", 5)
    + pad("WR%", 7) + pad("PF", 7) + pad("Sharpe", 8)
    + pad("$/day", 8) + pad("Total$", 9) + pad("MaxDD$", 9)
    + pad("Avg$", 8);
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  const baseline = results[0].stats;

  for (const r of results) {
    const s = r.stats;
    const delta = s.perDay - baseline.perDay;
    const deltaStr = r.label.includes("A0.") ? "" : ` (${fmtPnl(delta)})`;
    console.log(
      r.label.padEnd(25)
      + pad(String(s.trades), 7)
      + pad(String(s.winners), 5)
      + pad(String(s.losers), 5)
      + pad(s.wr + "%", 7)
      + pad(String(s.pf), 7)
      + pad(String(s.sharpe), 8)
      + pad(fmtPnl(s.perDay), 8)
      + pad(fmtPnl(s.totalPnl), 9)
      + pad(s.maxDd.toFixed(0), 9)
      + pad(fmtPnl(s.avgPnl), 8)
      + deltaStr,
    );
  }

  // ═══ PART 3: Also test WITH vol+BTC filters + Binance on top ═══
  console.log("\n\n" + "=".repeat(130));
  console.log("PART 3: SIGNAL-WINDOW -- WITH vol+BTC filters + Binance signals on TOP");
  console.log("Logic: Our standard Supertrend setup + Binance signal as additional layer.");
  console.log("=".repeat(130));
  console.log("");

  const results3: Result[] = [];
  for (const fc of filters) {
    const trades = runBacktest(pairPrecomps, btcPrecomp, fc.filter, signalStart, signalEnd, true, true);
    const stats = computeStats(trades, signalStart, signalEnd);
    results3.push({ label: fc.label, stats, trades });
  }

  console.log(hdr);
  console.log("-".repeat(hdr.length));
  const baseline3 = results3[0].stats;
  for (const r of results3) {
    const s = r.stats;
    const delta = s.perDay - baseline3.perDay;
    const deltaStr = r.label.includes("A0.") ? "" : ` (${fmtPnl(delta)})`;
    console.log(
      r.label.padEnd(25)
      + pad(String(s.trades), 7)
      + pad(String(s.winners), 5)
      + pad(String(s.losers), 5)
      + pad(s.wr + "%", 7)
      + pad(String(s.pf), 7)
      + pad(String(s.sharpe), 8)
      + pad(fmtPnl(s.perDay), 8)
      + pad(fmtPnl(s.totalPnl), 9)
      + pad(s.maxDd.toFixed(0), 9)
      + pad(fmtPnl(s.avgPnl), 8)
      + deltaStr,
    );
  }

  // ─── Filter blocking analysis ──────────────────────────────
  console.log("\n\nFilter blocking analysis (Part 2 - no vol/BTC):");
  console.log("Filter".padEnd(25) + "Blocked".padStart(8) + "  % blocked" + "  Blocked longs".padStart(16) + "  Blocked shorts".padStart(17));
  console.log("-".repeat(80));
  const baseTrades = results[0].trades;
  for (const r of results) {
    if (r.label.includes("A0.")) continue;
    const blocked = baseline.trades - r.stats.trades;
    const pct = baseline.trades > 0 ? (blocked / baseline.trades * 100).toFixed(1) : "0.0";
    const blockedLongs = baseTrades.filter(t => t.dir === "long").length - r.trades.filter(t => t.dir === "long").length;
    const blockedShorts = baseTrades.filter(t => t.dir === "short").length - r.trades.filter(t => t.dir === "short").length;
    console.log(
      r.label.padEnd(25)
      + pad(String(blocked), 8) + "  " + pct + "%"
      + pad(String(blockedLongs), 16)
      + pad(String(blockedShorts), 17),
    );
  }

  // ─── Direction analysis ────────────────────────────────────
  console.log("\n\nDirection analysis (Part 2 baseline):");
  const longs = baseTrades.filter(t => t.dir === "long");
  const shorts = baseTrades.filter(t => t.dir === "short");
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  const longWr = longs.length > 0 ? longs.filter(t => t.pnl > 0).length / longs.length : 0;
  const shortWr = shorts.length > 0 ? shorts.filter(t => t.pnl > 0).length / shorts.length : 0;
  console.log(`  Longs:  ${longs.length} trades, WR ${(longWr * 100).toFixed(1)}%, total $${longPnl.toFixed(2)}`);
  console.log(`  Shorts: ${shorts.length} trades, WR ${(shortWr * 100).toFixed(1)}%, total $${shortPnl.toFixed(2)}`);

  // ─── Per-pair breakdown ────────────────────────────────────
  console.log("\n\nPer-pair trade count (Part 2 baseline):");
  for (const pair of PAIRS.filter(p => pairPrecomps.some(pp => pp.name === p))) {
    const pt = baseTrades.filter(t => t.pair === pair);
    const pnl = pt.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${pair.padEnd(5)} ${pt.length} trades, $${pnl.toFixed(2)}`);
  }

  // ─── Exit reason breakdown ────────────────────────────────
  console.log("\n\nExit reasons (Part 2 baseline):");
  const reasons = new Map<string, { count: number; pnl: number }>();
  for (const t of baseTrades) {
    const r = reasons.get(t.reason) ?? { count: 0, pnl: 0 };
    r.count++;
    r.pnl += t.pnl;
    reasons.set(t.reason, r);
  }
  for (const [reason, data] of [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(12)} ${String(data.count).padStart(4)} trades  $${data.pnl.toFixed(2)}`);
  }

  // ─── Individual trade log (Part 2 baseline) ───────────────
  if (baseTrades.length <= 30) {
    console.log("\n\nTrade log (Part 2 baseline, all trades):");
    console.log("Pair  Dir    Entry Date         Exit Date          EP          XP         PnL$  Reason");
    console.log("-".repeat(100));
    for (const t of [...baseTrades].sort((a, b) => a.et - b.et)) {
      console.log(
        `${t.pair.padEnd(6)}${t.dir.padEnd(7)}`
        + `${new Date(t.et).toISOString().slice(0, 16).padEnd(19)}`
        + `${new Date(t.xt).toISOString().slice(0, 16).padEnd(19)}`
        + `${t.ep.toFixed(4).padStart(11)}`
        + `${t.xp.toFixed(4).padStart(11)}`
        + `${fmtPnl(t.pnl).padStart(9)}`
        + `  ${t.reason}`,
      );
    }
  }

  // ─── SOPR detail ──────────────────────────────────────────
  if (soprEntries.length > 0) {
    console.log("\n\nSOPR distribution:");
    const vals = soprEntries.map(e => e.sopr).sort((a, b) => a - b);
    console.log(`  Records: ${vals.length}`);
    console.log(`  Min: ${vals[0].toFixed(4)}, Max: ${vals[vals.length - 1].toFixed(4)}`);
    const below1 = vals.filter(v => v < 1).length;
    const above105 = vals.filter(v => v > 1.05).length;
    console.log(`  Below 1.0: ${below1} (${(below1 / vals.length * 100).toFixed(1)}%), Above 1.05: ${above105} (${(above105 / vals.length * 100).toFixed(1)}%)`);
  } else {
    console.log("\n\nSOPR: No data available (BGeometrics API rate-limited, try again later)");
  }

  // ─── KEY INSIGHT ──────────────────────────────────────────
  console.log("\n\n" + "=".repeat(130));
  console.log("KEY INSIGHT");
  console.log("=".repeat(130));
  console.log(`Binance free API returns only ~${signalDays} days of 4h data (168 bars per endpoint).`);
  console.log("This is fundamentally too short for a statistically significant Supertrend backtest.");
  console.log(`With 6 pairs and ${signalDays} days, even the raw (no-filter) Supertrend produces only ${baseline.trades} trades.`);
  if (baseline.trades < 30) {
    console.log("VERDICT: Insufficient data for reliable conclusions. Minimum ~100 trades needed.");
    console.log("OPTIONS:");
    console.log("  1. Use Binance signals as a LIVE filter (forward test with paper trades)");
    console.log("  2. Download longer history from a paid data provider (CryptoQuant, Coinglass, Glassnode)");
    console.log("  3. Use the signals on a higher-frequency strategy (1h entries) to get more trades per day");
  } else {
    // Find best result
    const best = results.reduce((a, b) => a.stats.sharpe > b.stats.sharpe ? a : b);
    console.log(`Best filter: ${best.label} (Sharpe ${best.stats.sharpe}, PF ${best.stats.pf}, ${fmtPnl(best.stats.perDay)}/day)`);
  }

  console.log("\n=== DONE ===");
}

main().catch(console.error);
