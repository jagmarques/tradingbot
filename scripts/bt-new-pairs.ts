/**
 * New Pairs Research: Download 5m data & run Supertrend(14, 1.75) on 4h bars
 *
 * Phase 1: Download missing 5m candles from Binance for candidate pairs
 * Phase 2: Aggregate 5m -> 4h, run Supertrend backtest per pair
 * Phase 3: Rank by PF and $/day, recommend pairs with PF > 1.1 and positive $/day
 *
 * BTC 4h EMA(12/21) filter for longs, shorts always allowed
 * ATR*3 SL capped 3.5%, $5 margin, 10x leverage, Supertrend flip exit, 60d stag
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-new-pairs.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const D = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const SIZE = 5; // $5 margin
const NOT = SIZE * LEV; // $50 notional

const ST_ATR_PERIOD = 14;
const ST_MULT = 1.75;
const ST_SL_ATR_MULT = 3.0;
const ST_SL_MAX_PCT = 0.035;
const ST_STAG_BARS = 360; // 60 days at 4h bars (360 x 4h)

// BTC EMA filter periods (on 4h bars)
const BTC_EMA_FAST = 12;
const BTC_EMA_SLOW = 21;

// Spread map (half-spread per side)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4,
};
const DEFAULT_SPREAD = 5e-4; // conservative for new/less liquid pairs

// Current 25 pairs (production set)
const CURRENT_25 = new Set([
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH",
  "TIA", "SOL", "ZEC", "AVAX", "NEAR", "kPEPE", "SUI", "HYPE", "FET",
]);

// Binance symbol -> display name mapping for special cases
const DISPLAY_MAP: Record<string, string> = {
  "1000PEPE": "kPEPE",
  "1000FLOKI": "kFLOKI",
  "1000BONK": "kBONK",
  "1000SHIB": "kSHIB",
};

// Candidate pairs to download and test
const CANDIDATES_TO_DOWNLOAD = [
  // Pairs from 1h cache not in 5m
  "ALGO", "ATOM", "FIL", "HBAR", "ICP", "PENDLE", "PNUT", "POL",
  "POPCAT", "RENDER", "RUNE", "SNX", "STX", "TAO",
  // Popular HL pairs explicitly requested
  "JUP", "SEI", "TON", "AAVE", "ONDO", "INJ", "SAND", "MANA", "CRV",
  // Current 25 pairs missing from 5m cache
  "ZEC", "AVAX", "NEAR", "SUI", "HYPE",
  // Binance special naming
  "1000FLOKI", "RNDR", "1000PEPE",
];

// OOS window
const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

// ─── Data Download ──────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function download5m(sym: string): Promise<number> {
  const cacheFile = path.join(CACHE_5M, `${sym}.json`);

  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    if (stat.size > 1_000_000) {
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as any[];
      console.log(`  [cache] ${sym}: ${data.length} candles`);
      return data.length;
    }
  }

  console.log(`  [download] ${sym}: fetching from Binance...`);
  const allCandles: C[] = [];
  const startTime = new Date("2023-01-01").getTime();
  const endTime = new Date("2026-03-28").getTime();
  const chunkMs = 1000 * 5 * 60 * 1000;

  for (let t = startTime; t < endTime; t += chunkMs) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=5m` +
      `&startTime=${t}&limit=1000`;

    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        if (res.status === 400) {
          console.log(`  [download] ${sym}: not found on Binance (400)`);
          return 0;
        }
        console.warn(`  [download] ${sym}: HTTP ${res.status}`);
        break;
      }
      const raw = (await res.json()) as unknown[][];
      if (!Array.isArray(raw) || raw.length === 0) break;

      for (const r of raw) {
        allCandles.push({
          t: r[0] as number,
          o: +(r[1] as string),
          h: +(r[2] as string),
          l: +(r[3] as string),
          c: +(r[4] as string),
        });
      }

      if (raw.length < 1000) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [download] ${sym}: fetch error - ${msg}`);
      break;
    }

    await sleep(80);
  }

  if (allCandles.length === 0) return 0;

  allCandles.sort((a, b) => a.t - b.t);
  fs.writeFileSync(cacheFile, JSON.stringify(allCandles));
  const s = new Date(allCandles[0]!.t).toISOString().slice(0, 10);
  const e = new Date(allCandles[allCandles.length - 1]!.t).toISOString().slice(0, 10);
  console.log(`  [download] ${sym}: ${allCandles.length} candles, ${s} to ${e}`);
  return allCandles.length;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(sym: string): C[] {
  const fp = path.join(CACHE_5M, `${sym}.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / (4 * H)) * (4 * H);
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const result: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 36) continue; // need at least 36 of 48 5m bars
    result.push({
      t: ts,
      o: bars[0]!.o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1]!.c,
    });
  }
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i]!.h - cs[i]!.l,
      Math.abs(cs[i]!.h - cs[i - 1]!.c),
      Math.abs(cs[i]!.l - cs[i - 1]!.c)
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(
          cs[j]!.h - cs[j]!.l,
          Math.abs(cs[j]!.h - cs[j - 1]!.c),
          Math.abs(cs[j]!.l - cs[j - 1]!.c)
        );
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1]! * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period && i < values.length; i++) {
    sum += values[i]!;
  }
  if (values.length >= period) {
    ema[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
      ema[i] = values[i]! * k + ema[i - 1]! * (1 - k);
    }
  }
  return ema;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i]!.h + cs[i]!.l) / 2;
    let upperBand = hl2 + mult * atr[i]!;
    let lowerBand = hl2 - mult * atr[i]!;

    if (i > atrPeriod) {
      const prevUpper = (cs[i - 1]!.h + cs[i - 1]!.l) / 2 + mult * atr[i - 1]!;
      const prevLower = (cs[i - 1]!.h + cs[i - 1]!.l) / 2 - mult * atr[i - 1]!;
      const prevFinalUpper = st[i - 1]! > 0 && dirs[i - 1] === -1 ? st[i - 1]! : prevUpper;
      const prevFinalLower = st[i - 1]! > 0 && dirs[i - 1] === 1 ? st[i - 1]! : prevLower;

      if (!(lowerBand > prevFinalLower || cs[i - 1]!.c < prevFinalLower)) {
        lowerBand = prevFinalLower;
      }
      if (!(upperBand < prevFinalUpper || cs[i - 1]!.c > prevFinalUpper)) {
        upperBand = prevFinalUpper;
      }
    }

    if (i === atrPeriod) {
      dirs[i] = cs[i]!.c > upperBand ? 1 : -1;
    } else {
      if (dirs[i - 1] === 1) {
        dirs[i] = cs[i]!.c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i]!.c > upperBand ? 1 : -1;
      }
    }

    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
}

// ─── BTC EMA Filter ─────────────────────────────────────────────────
function buildBtcFilter(btc4h: C[]): (t: number) => "long" | "short" | null {
  const closes = btc4h.map(c => c.c);
  const emaFast = calcEMA(closes, BTC_EMA_FAST);
  const emaSlow = calcEMA(closes, BTC_EMA_SLOW);
  const timeMap = new Map<number, number>();
  btc4h.forEach((c, i) => timeMap.set(c.t, i));

  return (t: number) => {
    const idx = timeMap.get(t);
    if (idx === undefined || idx < BTC_EMA_SLOW) return null;
    if (emaFast[idx]! > emaSlow[idx]!) return "long";
    return "short";
  };
}

// ─── Strategy ───────────────────────────────────────────────────────
function runSupertrend(
  pair: string,
  cs: C[],
  btcFilter: (t: number) => "long" | "short" | null,
  startTs: number,
  endTs: number,
): Tr[] {
  const trades: Tr[] = [];
  if (cs.length < ST_ATR_PERIOD + 30) return trades;

  const { dir } = calcSupertrend(cs, ST_ATR_PERIOD, ST_MULT);
  const atr = calcATR(cs, ST_ATR_PERIOD);
  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; entryIdx: number } | null = null;
  const sp = SP[pair] ?? DEFAULT_SPREAD;

  for (let i = ST_ATR_PERIOD + 1; i < cs.length; i++) {
    const bar = cs[i]!;
    const prevDir = dir[i - 1];
    const prevPrevDir = i >= 2 ? dir[i - 2] : prevDir;
    const flipped = prevDir !== prevPrevDir;

    // EXIT
    if (pos) {
      let xp = 0, reason = "", isSL = false;

      if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

      if (!xp && flipped) { xp = bar.o; reason = "flip"; }

      if (!xp) {
        const barsHeld = i - pos.entryIdx;
        if (barsHeld >= ST_STAG_BARS) { xp = bar.c; reason = "stag"; }
      }

      if (xp > 0) {
        const entrySlip = pos.ep * sp;
        const exitSlip = xp * sp * (isSL ? 1.5 : 1);
        const rawPnl = pos.dir === "long" ? (xp / pos.ep - 1) * NOT : (pos.ep / xp - 1) * NOT;
        const pnl = rawPnl - entrySlip * (NOT / pos.ep) - exitSlip * (NOT / xp) - NOT * FEE * 2;

        if (pos.et >= startTs && pos.et < endTs) {
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason });
        }
        pos = null;
      }
    }

    // ENTRY on Supertrend flip
    if (!pos && flipped && bar.t >= startTs && bar.t < endTs) {
      const newDir: "long" | "short" = prevDir === 1 ? "long" : "short";

      // BTC EMA filter: longs only when BTC bullish, shorts always allowed
      if (newDir === "long") {
        const btcDir = btcFilter(bar.t);
        if (btcDir !== "long") continue;
      }

      const curATR = atr[i] || atr[i - 1] || 0;
      let slDist = curATR * ST_SL_ATR_MULT;
      const maxDist = bar.o * ST_SL_MAX_PCT;
      if (slDist > maxDist) slDist = maxDist;
      const sl = newDir === "long" ? bar.o - slDist : bar.o + slDist;

      pos = { dir: newDir, ep: bar.o, et: bar.t, sl, entryIdx: i };
    }
  }

  // Close open position at end
  if (pos && pos.et >= startTs && pos.et < endTs) {
    const lastBar = cs[cs.length - 1]!;
    const rawPnl = pos.dir === "long" ? (lastBar.c / pos.ep - 1) * NOT : (pos.ep / lastBar.c - 1) * NOT;
    const pnl = rawPnl - NOT * FEE * 2;
    trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
  }

  return trades;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number;
  dd: number; total: number; perDay: number;
  longs: number; shorts: number;
}

function calcMetrics(trades: Tr[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, dd: 0, total: 0, perDay: 0, longs: 0, shorts: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const longs = trades.filter(t => t.dir === "long").length;
  const shorts = trades.filter(t => t.dir === "short").length;

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const days = (endTs - startTs) / D;

  return {
    n: trades.length,
    wr: trades.length > 0 ? wins.length / trades.length * 100 : 0,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
    longs,
    shorts,
  };
}

function fmtPnl(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  console.log("=".repeat(90));
  console.log("  NEW PAIRS RESEARCH: Supertrend(14, 1.75) on 4h bars");
  console.log("  5m candles -> 4h | BTC EMA(12/21) filter for longs | ATR*3 SL (cap 3.5%)");
  console.log("  $5 margin, 10x lev, 0.035% taker, spread map, 60d stag, flip exit");
  console.log("=".repeat(90));

  fs.mkdirSync(CACHE_5M, { recursive: true });

  // ─── Phase 1: Download missing pairs ────────────────────────────
  console.log("\n--- PHASE 1: Download missing 5m candle data ---\n");

  for (const pair of CANDIDATES_TO_DOWNLOAD) {
    const sym = `${pair}USDT`;
    await download5m(sym);
  }

  // ─── Phase 2: Load all data and run backtests ──────────────────
  console.log("\n--- PHASE 2: Load data and run Supertrend backtest ---\n");

  // Load BTC first
  const btc5m = load5m("BTCUSDT");
  const btc4h = aggregateTo4h(btc5m);
  console.log(`  BTC: ${btc5m.length} 5m -> ${btc4h.length} 4h bars`);
  const btcFilter = buildBtcFilter(btc4h);

  // Discover ALL available 5m data files
  const cacheFiles = fs.readdirSync(CACHE_5M).filter(f => f.endsWith(".json"));
  const allSymbols: string[] = [];
  for (const f of cacheFiles) {
    const sym = f.replace("USDT.json", "");
    if (sym === "BTC") continue;
    allSymbols.push(sym);
  }
  allSymbols.sort();

  console.log(`  Found ${allSymbols.length} pairs in 5m cache (excluding BTC)\n`);

  // Map display names
  function displayName(sym: string): string {
    return DISPLAY_MAP[sym] ?? sym;
  }

  // Categorize
  const newPairs: string[] = [];
  const currentPairs: string[] = [];
  for (const sym of allSymbols) {
    const dn = displayName(sym);
    if (CURRENT_25.has(dn) || CURRENT_25.has(sym)) {
      currentPairs.push(sym);
    } else {
      newPairs.push(sym);
    }
  }

  console.log(`  Current pairs with 5m data: ${currentPairs.length} (${currentPairs.join(", ")})`);
  console.log(`  New candidates with 5m data: ${newPairs.length} (${newPairs.join(", ")})\n`);

  // Load and backtest all pairs
  interface PairResult {
    pair: string;
    display: string;
    h4Bars: number;
    metrics: Metrics;
    isNew: boolean;
    exits: Map<string, number>;
  }

  const results: PairResult[] = [];
  const oosDays = (OOS_END - OOS_START) / D;

  for (const sym of [...currentPairs, ...newPairs]) {
    const raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) {
      console.log(`  SKIP ${sym}: only ${raw5m.length} 5m bars (need 5000+)`);
      continue;
    }

    const h4 = aggregateTo4h(raw5m);
    if (h4.length < 100) {
      console.log(`  SKIP ${sym}: only ${h4.length} 4h bars after aggregation`);
      continue;
    }

    const dn = displayName(sym);
    const trades = runSupertrend(dn, h4, btcFilter, OOS_START, OOS_END);
    const metrics = calcMetrics(trades, OOS_START, OOS_END);

    const exits = new Map<string, number>();
    for (const t of trades) {
      exits.set(t.reason, (exits.get(t.reason) ?? 0) + 1);
    }

    const isNew = !CURRENT_25.has(dn) && !CURRENT_25.has(sym);
    results.push({ pair: sym, display: dn, h4Bars: h4.length, metrics, isNew, exits });

    const tag = isNew ? "NEW" : "CUR";
    if (metrics.n > 0) {
      console.log(
        `  [${tag}] ${dn.padEnd(12)} ${String(h4.length).padStart(5)} 4h | `
        + `N=${String(metrics.n).padStart(3)} WR=${metrics.wr.toFixed(1).padStart(5)}% `
        + `PF=${(metrics.pf === Infinity ? " Inf" : metrics.pf.toFixed(2)).padStart(5)} `
        + `PnL=${fmtPnl(metrics.total).padStart(9)} $/d=${fmtPnl(metrics.perDay).padStart(7)} `
        + `DD=$${metrics.dd.toFixed(0).padStart(4)}`
      );
    } else {
      console.log(`  [${tag}] ${dn.padEnd(12)} ${String(h4.length).padStart(5)} 4h | no trades in OOS window`);
    }
  }

  // ─── Phase 3: Rankings ─────────────────────────────────────────
  console.log("\n" + "=".repeat(90));
  console.log("  PHASE 3: RANKINGS");
  console.log("=".repeat(90));

  // Current pairs performance
  const curResults = results.filter(r => !r.isNew && r.metrics.n > 0);
  curResults.sort((a, b) => b.metrics.pf - a.metrics.pf);

  console.log("\n  CURRENT PAIRS (reference):");
  console.log("  " + "-".repeat(86));
  console.log(
    "  " + "Pair".padEnd(12) + "Trades".padStart(7) + "  L/S".padStart(8)
    + "   WR%".padStart(7) + "    PF".padStart(7) + "       PnL".padStart(11)
    + "    $/day".padStart(9) + "   MaxDD".padStart(8) + "  Exits"
  );
  console.log("  " + "-".repeat(86));

  for (const r of curResults) {
    const m = r.metrics;
    const exitStr = [...r.exits.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
    console.log(
      "  " + r.display.padEnd(12)
      + String(m.n).padStart(7)
      + `  ${m.longs}/${m.shorts}`.padStart(8)
      + ("  " + m.wr.toFixed(1) + "%").padStart(7)
      + ("  " + (m.pf === Infinity ? "  Inf" : m.pf.toFixed(2))).padStart(7)
      + ("  " + fmtPnl(m.total)).padStart(11)
      + ("  " + fmtPnl(m.perDay)).padStart(9)
      + ("  $" + m.dd.toFixed(0)).padStart(8)
      + "  " + exitStr
    );
  }

  // New pairs ranked by PF
  const newResults = results.filter(r => r.isNew && r.metrics.n > 0);
  newResults.sort((a, b) => b.metrics.pf - a.metrics.pf);

  console.log("\n  NEW PAIR CANDIDATES (ranked by PF):");
  console.log("  " + "-".repeat(86));
  console.log(
    "  " + "Pair".padEnd(12) + "Trades".padStart(7) + "  L/S".padStart(8)
    + "   WR%".padStart(7) + "    PF".padStart(7) + "       PnL".padStart(11)
    + "    $/day".padStart(9) + "   MaxDD".padStart(8) + "  Verdict"
  );
  console.log("  " + "-".repeat(86));

  for (const r of newResults) {
    const m = r.metrics;
    let verdict = "SKIP";
    if (m.pf > 1.1 && m.perDay > 0) verdict = "ADD";
    else if (m.pf > 1.0 && m.perDay > 0) verdict = "MAYBE";
    else if (m.total > 0) verdict = "WEAK";

    console.log(
      "  " + r.display.padEnd(12)
      + String(m.n).padStart(7)
      + `  ${m.longs}/${m.shorts}`.padStart(8)
      + ("  " + m.wr.toFixed(1) + "%").padStart(7)
      + ("  " + (m.pf === Infinity ? "  Inf" : m.pf.toFixed(2))).padStart(7)
      + ("  " + fmtPnl(m.total)).padStart(11)
      + ("  " + fmtPnl(m.perDay)).padStart(9)
      + ("  $" + m.dd.toFixed(0)).padStart(8)
      + "  " + verdict
    );
  }

  // Pairs with zero trades
  const zeroTrades = results.filter(r => r.isNew && r.metrics.n === 0);
  if (zeroTrades.length > 0) {
    console.log(`\n  Zero trades in OOS: ${zeroTrades.map(r => r.display).join(", ")}`);
  }

  // Pairs that failed download
  const loadedSyms = new Set(results.map(r => r.pair));
  const noData: string[] = [];
  for (const p of CANDIDATES_TO_DOWNLOAD) {
    if (!loadedSyms.has(p) && !currentPairs.includes(p)) {
      noData.push(p);
    }
  }
  if (noData.length > 0) {
    console.log(`  No Binance data: ${noData.join(", ")}`);
  }

  // ─── Final recommendation ──────────────────────────────────────
  console.log("\n" + "=".repeat(90));
  console.log("  RECOMMENDATIONS (PF > 1.1 and positive $/day)");
  console.log("=".repeat(90));

  const recommended = newResults.filter(r => r.metrics.pf > 1.1 && r.metrics.perDay > 0);
  recommended.sort((a, b) => b.metrics.perDay - a.metrics.perDay);

  if (recommended.length === 0) {
    console.log("\n  No new pairs meet the criteria (PF > 1.1 and positive $/day).");
  } else {
    console.log("\n  Ranked by $/day:");
    for (const r of recommended) {
      const m = r.metrics;
      console.log(
        `    ${r.display.padEnd(12)} PF=${m.pf.toFixed(2).padStart(5)}  `
        + `$/d=${fmtPnl(m.perDay).padStart(7)}  `
        + `WR=${m.wr.toFixed(1).padStart(5)}%  `
        + `N=${String(m.n).padStart(3)}  `
        + `DD=$${m.dd.toFixed(0).padStart(4)}  `
        + `L/S=${m.longs}/${m.shorts}`
      );
    }
  }

  const maybe = newResults.filter(r => r.metrics.pf > 1.0 && r.metrics.perDay > 0 && r.metrics.pf <= 1.1);
  if (maybe.length > 0) {
    console.log("\n  Borderline (PF 1.0-1.1, positive $/day):");
    for (const r of maybe) {
      const m = r.metrics;
      console.log(
        `    ${r.display.padEnd(12)} PF=${m.pf.toFixed(2).padStart(5)}  `
        + `$/d=${fmtPnl(m.perDay).padStart(7)}  `
        + `WR=${m.wr.toFixed(1).padStart(5)}%  `
        + `N=${String(m.n).padStart(3)}  `
        + `DD=$${m.dd.toFixed(0).padStart(4)}`
      );
    }
  }

  // Summary
  const curTotal = curResults.reduce((s, r) => s + r.metrics.total, 0);
  const curPerDay = curTotal / oosDays;
  const addTotal = recommended.reduce((s, r) => s + r.metrics.total, 0);
  const addPerDay = addTotal / oosDays;

  console.log("\n  Summary:");
  console.log(`    Current pairs combined: ${fmtPnl(curTotal)} (${fmtPnl(curPerDay)}/day)`);
  if (recommended.length > 0) {
    console.log(`    New pairs would add:    ${fmtPnl(addTotal)} (${fmtPnl(addPerDay)}/day)`);
    console.log(`    Combined:               ${fmtPnl(curTotal + addTotal)} (${fmtPnl(curPerDay + addPerDay)}/day)`);
    console.log(`\n    Proposed additions: ${recommended.map(r => r.display).join(", ")}`);
  }

  console.log("\n" + "=".repeat(90));
  console.log("  DONE");
  console.log("=".repeat(90));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
