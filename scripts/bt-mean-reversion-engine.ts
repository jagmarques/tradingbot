// Conditional mean reversion engine research
// 5 strategies tested on 5m data resampled to 1h/4h/daily bars
// $3 margin, 10x leverage, 2% SL, BTC 4h EMA(12/21) filter

import * as fs from "fs";
import * as path from "path";
import { RSI, EMA, ATR, SMA, BollingerBands } from "technicalindicators";

interface C { t: number; o: number; h: number; l: number; c: number; v: number }
interface P { pair: string; strat: string; dir: "long" | "short"; ep: number; et: number; sl: number; tp: number }
interface T { pair: string; strat: string; dir: "long" | "short"; pnl: number; et: number; xt: number; reason: string }

const CD = "/tmp/bt-pair-cache-5m";
const M5 = 300000;
const H = 3600000;
const DAY = 86400000;
const FEE = 0.00035;
const SZ = 3;
const LEV = 10;
const SL_PCT = 0.02;

const PAIRS = [
  "OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","TRUMPUSDT","DASHUSDT","DOTUSDT",
  "ENAUSDT","DOGEUSDT","APTUSDT","LINKUSDT","ADAUSDT","WLDUSDT","XRPUSDT","UNIUSDT"
];
const SP: Record<string,number> = {
  XRPUSDT:1.05e-4,DOGEUSDT:1.35e-4,ARBUSDT:2.6e-4,ENAUSDT:2.55e-4,UNIUSDT:2.75e-4,
  APTUSDT:3.2e-4,LINKUSDT:3.45e-4,TRUMPUSDT:3.65e-4,WLDUSDT:4e-4,DOTUSDT:4.95e-4,
  WIFUSDT:5.05e-4,ADAUSDT:5.55e-4,LDOUSDT:5.8e-4,OPUSDT:6.2e-4,DASHUSDT:7.15e-4,
  BTCUSDT:0.5e-4
};

// Resample 5m candles into larger timeframe bars
function resample(cs: C[], intervalMs: number): C[] {
  const out: C[] = [];
  let cur: C | null = null;
  for (const c of cs) {
    const barStart = Math.floor(c.t / intervalMs) * intervalMs;
    if (!cur || cur.t !== barStart) {
      if (cur) out.push(cur);
      cur = { t: barStart, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function ld5m(p: string): C[] {
  const f = path.join(CD, p + ".json");
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as any[]).map((b: any) =>
    Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[5] }
    : { ...b, v: b.v ?? 0 }
  );
}

interface PairData {
  m5: C[];
  h1: C[];
  h4: C[];
  d1: C[];
  // 1h indicators
  rsi14_1h: number[];
  sma20_1h: number[];
  sma50_1h: number[];
  ema12_1h: number[];
  ema21_1h: number[];
  atr14_1h: number[];
  vol20_1h: number[];   // 20-bar avg volume on 1h
  // 4h indicators
  bb20_4h: { upper: number; middle: number; lower: number }[];
  sma50_4h: number[];
  ema12_4h: number[];
  ema21_4h: number[];
  atr14_4h: number[];
  vol20_4h: number[];
  // daily indicators
  sma20_d: number[];
  sma50_d: number[];
  // lookup maps
  tm1h: Map<number, number>;
  tm4h: Map<number, number>;
  tmd: Map<number, number>;
}

function gv(a: number[], i: number, total: number): number | null {
  const x = i - (total - a.length);
  return x >= 0 && x < a.length ? a[x] : null;
}

function gvBB(a: {upper:number;middle:number;lower:number}[], i: number, total: number) {
  const x = i - (total - a.length);
  return x >= 0 && x < a.length ? a[x] : null;
}

function buildPairData(pair: string): PairData | null {
  const m5 = ld5m(pair);
  if (m5.length < 500) return null;

  const h1 = resample(m5, H);
  const h4 = resample(m5, 4 * H);
  const d1 = resample(m5, DAY);

  const cl1h = h1.map(c => c.c);
  const hi1h = h1.map(c => c.h);
  const lo1h = h1.map(c => c.l);
  const v1h  = h1.map(c => c.v);

  const cl4h = h4.map(c => c.c);
  const hi4h = h4.map(c => c.h);
  const lo4h = h4.map(c => c.l);
  const v4h  = h4.map(c => c.v);

  const cld = d1.map(c => c.c);

  // 1h
  const rsi14_1h = RSI.calculate({ period: 14, values: cl1h });
  const sma20_1h = SMA.calculate({ period: 20, values: cl1h });
  const sma50_1h = SMA.calculate({ period: 50, values: cl1h });
  const ema12_1h = EMA.calculate({ period: 12, values: cl1h });
  const ema21_1h = EMA.calculate({ period: 21, values: cl1h });
  const atr14_1h = ATR.calculate({ period: 14, high: hi1h, low: lo1h, close: cl1h });

  // 20-bar avg volume 1h using SMA
  const vol20_1h = SMA.calculate({ period: 20, values: v1h });

  // 4h
  const bbRaw = BollingerBands.calculate({ period: 20, stdDev: 2, values: cl4h });
  const bb20_4h = bbRaw.map(b => ({ upper: b.upper, middle: b.middle, lower: b.lower }));
  const sma50_4h = SMA.calculate({ period: 50, values: cl4h });
  const ema12_4h = EMA.calculate({ period: 12, values: cl4h });
  const ema21_4h = EMA.calculate({ period: 21, values: cl4h });
  const atr14_4h = ATR.calculate({ period: 14, high: hi4h, low: lo4h, close: cl4h });
  const vol20_4h = SMA.calculate({ period: 20, values: v4h });

  // daily
  const sma20_d = SMA.calculate({ period: 20, values: cld });
  const sma50_d = SMA.calculate({ period: 50, values: cld });

  const tm1h = new Map<number, number>();
  h1.forEach((c, i) => tm1h.set(c.t, i));
  const tm4h = new Map<number, number>();
  h4.forEach((c, i) => tm4h.set(c.t, i));
  const tmd = new Map<number, number>();
  d1.forEach((c, i) => tmd.set(c.t, i));

  return {
    m5, h1, h4, d1,
    rsi14_1h, sma20_1h, sma50_1h, ema12_1h, ema21_1h, atr14_1h, vol20_1h,
    bb20_4h, sma50_4h, ema12_4h, ema21_4h, atr14_4h, vol20_4h,
    sma20_d, sma50_d,
    tm1h, tm4h, tmd
  };
}

// Get 1h bar index for a given timestamp (floor to 1h boundary)
function get1hIdx(pd: PairData, t: number): number {
  const barT = Math.floor(t / H) * H;
  return pd.tm1h.get(barT) ?? -1;
}

function get4hIdx(pd: PairData, t: number): number {
  const barT = Math.floor(t / (4 * H)) * (4 * H);
  return pd.tm4h.get(barT) ?? -1;
}

function getDIdx(pd: PairData, t: number): number {
  const barT = Math.floor(t / DAY) * DAY;
  return pd.tmd.get(barT) ?? -1;
}

// BTC 4h EMA(12/21) filter: true = BTC is bullish
function btcBullish4h(btc: PairData, t: number): boolean {
  const bi = get4hIdx(btc, t);
  if (bi < 1) return false;
  const e12 = gv(btc.ema12_4h, bi - 1, btc.h4.length);
  const e21 = gv(btc.ema21_4h, bi - 1, btc.h4.length);
  return e12 !== null && e21 !== null && e12 > e21;
}

function btcBearish4h(btc: PairData, t: number): boolean {
  const bi = get4hIdx(btc, t);
  if (bi < 1) return false;
  const e12 = gv(btc.ema12_4h, bi - 1, btc.h4.length);
  const e21 = gv(btc.ema21_4h, bi - 1, btc.h4.length);
  return e12 !== null && e21 !== null && e12 < e21;
}

// ---- Strategy signal functions ----
// Each returns { dir, tp } or null. tp = 0 means exit-only (RSI/time/BB exit)
type Signal = { dir: "long" | "short"; tp: number } | null;

// S1: Oversold bounce in uptrend
// RSI(14) < 25 on 1h WHILE daily SMA(20) > SMA(50)
// Long only. Exit when RSI > 50 or after 12h.
function sigS1(pd: PairData, btc: PairData, t: number): Signal {
  if (!btcBullish4h(btc, t)) return null;
  const di = getDIdx(pd, t);
  if (di < 1) return null;
  const sm20d = gv(pd.sma20_d, di - 1, pd.d1.length);
  const sm50d = gv(pd.sma50_d, di - 1, pd.d1.length);
  if (!sm20d || !sm50d || sm20d <= sm50d) return null;
  const bi = get1hIdx(pd, t);
  if (bi < 20) return null;
  const rsi = gv(pd.rsi14_1h, bi - 1, pd.h1.length);
  if (rsi === null || rsi >= 25) return null;
  return { dir: "long", tp: 0 };
}

// S2: Gap fill on 4h bars
// 4h open > 2% from previous 4h close -> fade (short if gapped up, long if gapped down)
// Exit at prev close price (tp) or after 8h (2 bars)
function sigS2(pd: PairData, btc: PairData, t: number): Signal {
  const bi4 = get4hIdx(pd, t);
  if (bi4 < 2) return null;
  const cur = pd.h4[bi4];
  const prev = pd.h4[bi4 - 1];
  if (!cur || !prev) return null;
  // Only check at 4h bar open (t must equal bar start)
  const barT = Math.floor(t / (4 * H)) * (4 * H);
  if (t !== barT) return null;
  const gapPct = (cur.o - prev.c) / prev.c;
  if (Math.abs(gapPct) < 0.02) return null;
  if (gapPct > 0) {
    // Gapped up -> short (fade), BTC filter: BTC must be bearish or neutral
    if (btcBullish4h(btc, t)) return null; // skip strong bull
    return { dir: "short", tp: prev.c };
  } else {
    // Gapped down -> long (fade), BTC must be bullish
    if (!btcBullish4h(btc, t)) return null;
    return { dir: "long", tp: prev.c };
  }
}

// S3: Bollinger Band lower touch on 4h while above daily SMA(50)
// Long only. Exit at middle band or after 24h.
function sigS3(pd: PairData, btc: PairData, t: number): Signal {
  if (!btcBullish4h(btc, t)) return null;
  const di = getDIdx(pd, t);
  if (di < 1) return null;
  const sm50d = gv(pd.sma50_d, di - 1, pd.d1.length);
  const bi4 = get4hIdx(pd, t);
  if (bi4 < 1) return null;
  const cur4 = pd.h4[bi4];
  if (!cur4 || !sm50d || cur4.c < sm50d) return null; // below daily SMA50
  const bb = gvBB(pd.bb20_4h, bi4 - 1, pd.h4.length);
  if (!bb) return null;
  // Price touches lower band: low <= lower BB
  if (cur4.l > bb.lower) return null;
  return { dir: "long", tp: bb.middle };
}

// S4: Volume spike reversion
// When volume > 3x 20-bar avg AND price moved > 3% in 1 bar (1h), fade move 2 bars later
// Wait exactly 2 bars after spike, enter opposite direction
function sigS4(pd: PairData, btc: PairData, t: number): Signal {
  const bi = get1hIdx(pd, t);
  if (bi < 25) return null;
  // Check 2 bars ago for the spike
  const spikeI = bi - 2;
  const spikeBar = pd.h1[spikeI];
  if (!spikeBar) return null;
  const vol2ago = spikeBar.v;
  const avgVol = gv(pd.vol20_1h, spikeI - 1, pd.h1.length);
  if (!avgVol || avgVol === 0) return null;
  if (vol2ago < avgVol * 3) return null;
  const prevBar = pd.h1[spikeI - 1];
  if (!prevBar) return null;
  const movePct = (spikeBar.c - prevBar.c) / prevBar.c;
  if (Math.abs(movePct) < 0.03) return null;
  // Fade: if spike was up, go short; if spike was down, go long
  if (movePct > 0) {
    if (btcBullish4h(btc, t)) return null;
    return { dir: "short", tp: 0 };
  } else {
    if (!btcBullish4h(btc, t)) return null;
    return { dir: "long", tp: 0 };
  }
}

// S5: Price proxy for funding rate extreme
// When price has risen > 5% in 24h without a pullback (min within period > entry * 0.98), short expecting reversion
// BTC must also be in same condition (consistent overextension)
function sigS5(pd: PairData, btc: PairData, t: number): Signal {
  // Only shorts when BTC is bearish on 4h (overextended rally cooling)
  if (!btcBearish4h(btc, t)) return null;
  const bi = get1hIdx(pd, t);
  if (bi < 26) return null;
  const cur = pd.h1[bi];
  if (!cur) return null;
  // Price 24h ago
  const bi24 = bi - 24;
  if (bi24 < 0) return null;
  const p24 = pd.h1[bi24].c;
  const rise = (cur.c - p24) / p24;
  if (rise < 0.05) return null; // less than 5% rise
  // Check no major pullback in between: min low > entry * 0.97
  let minLow = Infinity;
  for (let i = bi24; i <= bi; i++) minLow = Math.min(minLow, pd.h1[i].l);
  if (minLow < p24 * 0.97) return null; // had a pullback, skip
  return { dir: "short", tp: p24 };
}

// ---- Simulator ----
interface StratCfg {
  name: string;
  maxHoldMs: number;
  sig: (pd: PairData, btc: PairData, t: number) => Signal;
  // For RSI-exit strategies
  rsiExit?: { threshold: number; dir: "long" | "short" };
}

const STRATS: StratCfg[] = [
  {
    name: "S1-OversoldBounce",
    maxHoldMs: 12 * H,
    sig: sigS1,
    rsiExit: { threshold: 50, dir: "long" },
  },
  {
    name: "S2-GapFill",
    maxHoldMs: 8 * H,
    sig: sigS2,
  },
  {
    name: "S3-BBReversion",
    maxHoldMs: 24 * H,
    sig: sigS3,
  },
  {
    name: "S4-VolSpike",
    maxHoldMs: 6 * H,
    sig: sigS4,
  },
  {
    name: "S5-FundingProxy",
    maxHoldMs: 12 * H,
    sig: sigS5,
  },
];

function simulate(
  strat: StratCfg,
  pairData: Map<string, PairData>,
  btc: PairData,
  startMs: number,
  endMs: number
): T[] {
  // Build sorted set of 1h bar timestamps across all pairs
  const ts = new Set<number>();
  for (const pd of pairData.values()) {
    for (const c of pd.h1) {
      if (c.t >= startMs && c.t < endMs) ts.add(c.t);
    }
  }
  const sortedTs = [...ts].sort((a, b) => a - b);

  const pos = new Map<string, P>(); // key = pair
  const trades: T[] = [];

  for (const t of sortedTs) {
    const closed = new Set<string>();

    // Check exits
    for (const [pair, ps] of pos) {
      if (ps.strat !== strat.name) continue;
      const pd = pairData.get(pair)!;
      const bi = get1hIdx(pd, t);
      if (bi < 0) continue;
      const bar = pd.h1[bi];
      const sp = SP[pair] ?? 4e-4;

      let xp = 0;
      let reason = "";

      // SL
      if (ps.dir === "long" ? bar.l <= ps.sl : bar.h >= ps.sl) {
        xp = ps.dir === "long" ? ps.sl * (1 - sp) : ps.sl * (1 + sp);
        reason = "sl";
      }

      // TP (fixed price target, e.g. gap fill to prev close, BB middle)
      if (!reason && ps.tp > 0) {
        if (ps.dir === "long" && bar.h >= ps.tp) {
          xp = ps.tp * (1 - sp);
          reason = "tp";
        } else if (ps.dir === "short" && bar.l <= ps.tp) {
          xp = ps.tp * (1 + sp);
          reason = "tp";
        }
      }

      // RSI exit
      if (!reason && strat.rsiExit) {
        const rsi = gv(pd.rsi14_1h, bi, pd.h1.length);
        if (rsi !== null) {
          if (strat.rsiExit.dir === "long" && rsi >= strat.rsiExit.threshold) {
            xp = ps.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
            reason = "rsi";
          }
        }
      }

      // BB middle exit for S3
      if (!reason && strat.name === "S3-BBReversion") {
        const bi4 = get4hIdx(pd, t);
        if (bi4 >= 1) {
          const bb = gvBB(pd.bb20_4h, bi4, pd.h4.length);
          if (bb && ps.dir === "long" && bar.c >= bb.middle) {
            xp = bar.c * (1 - sp);
            reason = "bb-mid";
          }
        }
      }

      // Max hold
      if (!reason && t - ps.et >= strat.maxHoldMs) {
        xp = ps.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        reason = "maxhold";
      }

      if (xp > 0) {
        const raw = ps.dir === "long"
          ? (xp / ps.ep - 1) * SZ * LEV
          : (ps.ep / xp - 1) * SZ * LEV;
        const fees = SZ * LEV * FEE * 2;
        trades.push({ pair, strat: strat.name, dir: ps.dir, pnl: raw - fees, et: ps.et, xt: t, reason });
        pos.delete(pair);
        closed.add(pair);
      }
    }

    // Check entries
    for (const pair of PAIRS) {
      if (pos.has(pair) || closed.has(pair)) continue;
      const pd = pairData.get(pair);
      if (!pd) continue;
      const bi = get1hIdx(pd, t);
      if (bi < 60) continue;

      const sig = strat.sig(pd, btc, t);
      if (!sig) continue;

      const bar = pd.h1[bi];
      const sp = SP[pair] ?? 4e-4;
      const ep = sig.dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
      const sl = sig.dir === "long" ? ep * (1 - SL_PCT) : ep * (1 + SL_PCT);

      // Compute TP price if given as a target price
      let tp = 0;
      if (sig.tp > 0) {
        // Sanity check: TP must be on correct side
        if (sig.dir === "long" && sig.tp > ep) tp = sig.tp;
        else if (sig.dir === "short" && sig.tp < ep) tp = sig.tp;
        // If not valid (TP already passed), skip
        if (tp === 0 && sig.tp > 0) continue;
      }

      pos.set(pair, { pair, strat: strat.name, dir: sig.dir, ep, et: t, sl, tp });
    }
  }

  return trades;
}

function stats(trades: T[], startMs: number, endMs: number) {
  const days = (endMs - startMs) / DAY;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const wr = trades.length > 0 ? wins / trades.length * 100 : 0;

  let cum = 0, peak = 0, maxDD = 0;
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
    const day = Math.floor(t.xt / DAY);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
  }

  const dr = [...dailyPnl.values()];
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;
  const worstDay = dr.length > 0 ? Math.min(...dr) : 0;

  const pf = (() => {
    const g = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const l = trades.filter(t => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
    return l > 0 ? g / l : trades.length > 0 ? 99 : 0;
  })();

  return { pnl, wr, sharpe, maxDD, worstDay, pf, perDay: pnl / days, trades: trades.length };
}

// Split dates
const S = new Date("2023-01-01").getTime();
const E = new Date("2026-03-25").getTime();
const SPLIT = new Date("2024-09-01").getTime(); // train/test split ~60/40
const DAYS = (E - S) / DAY;

console.log("Loading 5m candle data and resampling...");
const pairData = new Map<string, PairData>();
for (const p of [...PAIRS, "BTCUSDT"]) {
  const pd = buildPairData(p);
  if (pd) {
    pairData.set(p, pd);
    process.stdout.write(".");
  }
}
const btc = pairData.get("BTCUSDT")!;
console.log(`\nLoaded ${pairData.size} pairs\n`);

console.log(`Period: ${new Date(S).toISOString().slice(0,10)} to ${new Date(E).toISOString().slice(0,10)} (${DAYS.toFixed(0)} days)`);
console.log(`Train:  ${new Date(S).toISOString().slice(0,10)} to ${new Date(SPLIT).toISOString().slice(0,10)}`);
console.log(`Test:   ${new Date(SPLIT).toISOString().slice(0,10)} to ${new Date(E).toISOString().slice(0,10)}`);
console.log(`Config: $${SZ} margin, ${LEV}x leverage ($${SZ*LEV} notional), SL=${SL_PCT*100}%, fee=${FEE*100}%/side\n`);

console.log(
  "Strategy".padEnd(22) +
  " Trades  T/day   WR%    PF    $/day  Sharpe  MaxDD  WorstDay  Train$/d  Test$/d  Exits"
);
console.log("-".repeat(130));

for (const strat of STRATS) {
  const all = simulate(strat, pairData, btc, S, E);
  const train = simulate(strat, pairData, btc, S, SPLIT);
  const test = simulate(strat, pairData, btc, SPLIT, E);

  const a = stats(all, S, E);
  const tr = stats(train, S, SPLIT);
  const ts2 = stats(test, SPLIT, E);

  // Exit breakdown
  const exits = new Map<string, number>();
  for (const t of all) exits.set(t.reason, (exits.get(t.reason) ?? 0) + 1);
  const exitStr = [...exits.entries()].map(([r, n]) => `${r}:${n}`).join(" ");

  const pnlStr = a.pnl >= 0 ? `+$${a.pnl.toFixed(0)}` : `-$${Math.abs(a.pnl).toFixed(0)}`;
  const dayStr = (v: number) => (v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`);

  console.log(
    strat.name.padEnd(22) +
    ` ${String(a.trades).padStart(6)}` +
    `  ${(a.trades / DAYS).toFixed(1).padStart(5)}` +
    `  ${a.wr.toFixed(1).padStart(5)}` +
    `  ${a.pf.toFixed(2).padStart(5)}` +
    `  ${dayStr(a.perDay).padStart(7)}` +
    `  ${a.sharpe.toFixed(2).padStart(6)}` +
    `  ${("$" + a.maxDD.toFixed(0)).padStart(6)}` +
    `  ${("$" + Math.abs(a.worstDay).toFixed(0)).padStart(8)}` +
    `  ${dayStr(tr.perDay).padStart(8)}` +
    `  ${dayStr(ts2.perDay).padStart(7)}` +
    `  ${exitStr}`
  );
}

console.log("\n--- Per-pair breakdown (all strategies combined) ---\n");
console.log("Pair".padEnd(12) + " Trades   WR%    PnL     $/day");
console.log("-".repeat(55));
const allTrades: T[] = [];
for (const strat of STRATS) {
  allTrades.push(...simulate(strat, pairData, btc, S, E));
}
const byPair = new Map<string, T[]>();
for (const t of allTrades) {
  if (!byPair.has(t.pair)) byPair.set(t.pair, []);
  byPair.get(t.pair)!.push(t);
}
const pairRows = [...byPair.entries()]
  .map(([pair, ts]) => {
    const pnl = ts.reduce((s, t) => s + t.pnl, 0);
    const wr = ts.filter(t => t.pnl > 0).length / ts.length * 100;
    return { pair, n: ts.length, wr, pnl };
  })
  .sort((a, b) => b.pnl - a.pnl);
for (const row of pairRows) {
  const ps = row.pnl >= 0 ? `+$${row.pnl.toFixed(1)}` : `-$${Math.abs(row.pnl).toFixed(1)}`;
  console.log(
    row.pair.padEnd(12) +
    ` ${String(row.n).padStart(6)}` +
    `  ${row.wr.toFixed(1).padStart(5)}` +
    `  ${ps.padStart(8)}` +
    `  ${(row.pnl >= 0 ? "+" : "-") + "$" + (Math.abs(row.pnl) / DAYS).toFixed(2)}`
  );
}

console.log("\n--- Best strategy per direction ---");
const byStrat = new Map<string, T[]>();
for (const t of allTrades) {
  if (!byStrat.has(t.strat)) byStrat.set(t.strat, []);
  byStrat.get(t.strat)!.push(t);
}
for (const [sName, ts] of byStrat) {
  const longs = ts.filter(t => t.dir === "long");
  const shorts = ts.filter(t => t.dir === "short");
  const lPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const sPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  const lWr = longs.length > 0 ? longs.filter(t => t.pnl > 0).length / longs.length * 100 : 0;
  const sWr = shorts.length > 0 ? shorts.filter(t => t.pnl > 0).length / shorts.length * 100 : 0;
  console.log(`${sName}: longs=${longs.length}(WR=${lWr.toFixed(0)}% pnl=$${lPnl.toFixed(1)}) shorts=${shorts.length}(WR=${sWr.toFixed(0)}% pnl=$${sPnl.toFixed(1)})`);
}
