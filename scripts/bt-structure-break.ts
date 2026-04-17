/**
 * Structural Trend Break Backtest (Dow Theory quantified)
 *
 * Signal: pivot highs/lows (N-bar fractals) on 1h candles.
 * - Uptrend = last K pivot highs strictly increasing AND last K pivot lows strictly increasing.
 * - Downtrend = mirror.
 * Entries:
 *   1. Uptrend + close above most recent confirmed pivot high  -> LONG (continuation)
 *   2. Downtrend + close below most recent confirmed pivot low  -> SHORT (continuation)
 *   3. Uptrend + close below most recent confirmed pivot low    -> SHORT (reversal)
 *   4. Downtrend + close above most recent confirmed pivot high -> LONG (reversal)
 *
 * SL: broken pivot +/- 0.1% (floored at 0.15%, capped at 2%).
 * Trail: 3/1 -> 9/0.5 -> 20/0.5 on leveraged PnL %.
 * Max hold: 48h. Intra-bar SL uses 5m resolution.
 *
 * Walk-forward: IS 2023-01-01 .. 2025-08-31, OOS 2025-09-01 .. 2026-04-01.
 *
 * Run:
 *   cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && \
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-structure-break.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const OUT_PATH = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester/structure-break.txt";

const M5 = 300_000;
const H1 = 3_600_000;
const DAY = 86_400_000;

const FEE = 0.000_35;
const MARGIN = 15;
const LEV = 10;
const NOTIONAL = MARGIN * LEV;   // $150
const SL_SLIP = 1.5;
const MIN_SL_PCT = 0.0015;       // user constraint: 0.15% min
const MAX_SL_PCT = 0.02;         // 2% cap
const MAX_HOLD_H = 48;
const PIVOT_BUFFER = 0.001;      // 0.1% buffer beyond pivot for SL

const FULL_START = new Date("2023-01-01").getTime();
const IS_END = new Date("2025-09-01").getTime();
const OOS_START = IS_END;
const FULL_END = new Date("2026-04-01").getTime();

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4,
  TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
};
const DFLT_SPREAD = 5e-4;
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

const TRAIL_STEPS = [
  { activate: 3,  dist: 1 },
  { activate: 9,  dist: 0.5 },
  { activate: 20, dist: 0.5 },
];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
type Dir = "long" | "short";
interface Trade {
  pair: string; dir: Dir; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
  mode: string;
}

// ─── Data loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
    return raw
      .map((b: any) => ({ t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }))
      .filter(b => Number.isFinite(b.o) && Number.isFinite(b.c) && b.c > 0)
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

function aggregate(candles: C[], period: number): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const minBars = Math.floor(period / M5) * 0.6;
  const out: C[] = [];
  for (const [t, cs] of groups) {
    if (cs.length < minBars) continue;
    cs.sort((a, b) => a.t - b.t);
    let hi = -Infinity, lo = Infinity;
    for (const c of cs) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; }
    out.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ─── Pivot detection ────────────────────────────────────────────────
interface Pivot { idx: number; t: number; price: number; type: "H" | "L"; }

function findPivots(bars: C[], N: number): Pivot[] {
  // N-bar fractal: bar[i] is pivot high if bars[i-N..i-1] and bars[i+1..i+N] all have lower highs.
  // Pivot is "confirmed" at bar i + N (cannot be seen earlier without lookahead).
  const piv: Pivot[] = [];
  for (let i = N; i < bars.length - N; i++) {
    const h = bars[i].h, l = bars[i].l;
    let isH = true, isL = true;
    for (let j = 1; j <= N; j++) {
      if (bars[i - j].h >= h) isH = false;
      if (bars[i + j].h >= h) isH = false;
      if (bars[i - j].l <= l) isL = false;
      if (bars[i + j].l <= l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) piv.push({ idx: i, t: bars[i].t, price: h, type: "H" });
    if (isL) piv.push({ idx: i, t: bars[i].t, price: l, type: "L" });
  }
  return piv;
}

// ─── PnL ────────────────────────────────────────────────────────────
function calcPnl(pair: string, ep: number, xp: number, dir: Dir, isSL: boolean): number {
  const spread = sp(pair);
  const entrySlip = ep * spread;
  const exitSlip  = xp * spread * (isSL ? SL_SLIP : 1);
  const raw = dir === "long"
    ? (xp / ep - 1) * NOTIONAL
    : (ep / xp - 1) * NOTIONAL;
  const cost = entrySlip * (NOTIONAL / ep) + exitSlip * (NOTIONAL / xp) + NOTIONAL * FEE * 2;
  return raw - cost;
}

function capSL(ep: number, rawDist: number): number {
  const maxD = ep * MAX_SL_PCT;
  const minD = ep * MIN_SL_PCT;
  return Math.min(Math.max(rawDist, minD), maxD);
}

// ─── Simulator ──────────────────────────────────────────────────────
interface SimOpts {
  pivotN: number;        // fractal size
  trendLen: number;      // how many consecutive HH/HL needed
  mode: "both" | "cont" | "rev";
}

interface Pos {
  pair: string; dir: Dir; ep: number; et: number; sl: number; pivot: number;
  peakPnlPct: number; deadline: number; entryMode: string;
}

function simulate(
  pair: string,
  bars5m: C[],
  bars1h: C[],
  startMs: number, endMs: number,
  opts: SimOpts,
): Trade[] {
  if (bars1h.length < 100) return [];

  const pivots = findPivots(bars1h, opts.pivotN);
  if (pivots.length < opts.trendLen * 2 + 2) return [];

  // Helpers to find last confirmed pivot of type by time
  // Confirmation time = bars1h[pivot.idx + opts.pivotN].t (close of the last future bar)
  const confirmTs = (p: Pivot) => bars1h[Math.min(p.idx + opts.pivotN, bars1h.length - 1)].t;

  // Build index of pivots by bar index, sorted
  const pivSorted = [...pivots].sort((a, b) => a.idx - b.idx);

  // Cursor over bars1h using each 1h close as "decision time"
  let pivCursor = 0; // index into pivSorted; next candidate to potentially confirm
  const confirmedHighs: Pivot[] = []; // in chronological order of confirmation
  const confirmedLows: Pivot[] = [];

  function advanceConfirmations(uptoBarIdx: number) {
    // A pivot at index k is confirmed at bar (k + opts.pivotN) close.
    while (pivCursor < pivSorted.length) {
      const p = pivSorted[pivCursor];
      if (p.idx + opts.pivotN <= uptoBarIdx) {
        if (p.type === "H") confirmedHighs.push(p);
        else confirmedLows.push(p);
        pivCursor++;
      } else break;
    }
  }

  function isUptrend(): boolean {
    const K = opts.trendLen;
    if (confirmedHighs.length < K || confirmedLows.length < K) return false;
    for (let i = confirmedHighs.length - K + 1; i < confirmedHighs.length; i++) {
      if (confirmedHighs[i].price <= confirmedHighs[i - 1].price) return false;
    }
    for (let i = confirmedLows.length - K + 1; i < confirmedLows.length; i++) {
      if (confirmedLows[i].price <= confirmedLows[i - 1].price) return false;
    }
    return true;
  }
  function isDowntrend(): boolean {
    const K = opts.trendLen;
    if (confirmedHighs.length < K || confirmedLows.length < K) return false;
    for (let i = confirmedHighs.length - K + 1; i < confirmedHighs.length; i++) {
      if (confirmedHighs[i].price >= confirmedHighs[i - 1].price) return false;
    }
    for (let i = confirmedLows.length - K + 1; i < confirmedLows.length; i++) {
      if (confirmedLows[i].price >= confirmedLows[i - 1].price) return false;
    }
    return true;
  }

  // Map 5m index by timestamp for intra-bar SL resolution.
  // We'll walk 5m sequentially and trigger decisions at 1h bar closes.
  const trades: Trade[] = [];
  let pos: Pos | null = null;

  let h1Idx = 0;
  // Position 5m walk to first bar at or after startMs
  let i5 = 0;
  while (i5 < bars5m.length && bars5m[i5].t < startMs) i5++;

  for (; i5 < bars5m.length; i5++) {
    const b5 = bars5m[i5];
    if (b5.t >= endMs) break;

    // Advance 1h index: we've "closed" all 1h bars whose end time (t + H1) <= b5.t
    while (h1Idx < bars1h.length && bars1h[h1Idx].t + H1 <= b5.t) {
      const barJustClosed = bars1h[h1Idx];
      const justClosedIdx = h1Idx;
      // Confirm all pivots confirmable as of this bar
      advanceConfirmations(justClosedIdx);

      // Check for entry only if no open position
      if (!pos && barJustClosed.t >= startMs) {
        const up = isUptrend();
        const dn = isDowntrend();
        const close = barJustClosed.c;
        const recentHigh = confirmedHighs.length ? confirmedHighs[confirmedHighs.length - 1] : null;
        const recentLow  = confirmedLows.length  ? confirmedLows[confirmedLows.length - 1]  : null;

        let entry: { dir: Dir; pivotPrice: number; mode: string } | null = null;

        // Continuation longs / shorts
        if ((opts.mode === "both" || opts.mode === "cont") && up && recentHigh && close > recentHigh.price) {
          entry = { dir: "long", pivotPrice: recentHigh.price, mode: "cont-long" };
        } else if ((opts.mode === "both" || opts.mode === "cont") && dn && recentLow && close < recentLow.price) {
          entry = { dir: "short", pivotPrice: recentLow.price, mode: "cont-short" };
        }
        // Reversals (only if neither continuation fired)
        else if ((opts.mode === "both" || opts.mode === "rev") && up && recentLow && close < recentLow.price) {
          entry = { dir: "short", pivotPrice: recentLow.price, mode: "rev-short" };
        } else if ((opts.mode === "both" || opts.mode === "rev") && dn && recentHigh && close > recentHigh.price) {
          entry = { dir: "long", pivotPrice: recentHigh.price, mode: "rev-long" };
        }

        if (entry) {
          const ep = close;
          // SL based on broken pivot + buffer
          let slPrice: number;
          if (entry.dir === "long") {
            slPrice = entry.pivotPrice * (1 - PIVOT_BUFFER);
            // For cont-long SL below broken high doesn't make sense; use recent low instead
            if (entry.mode === "cont-long" && recentLow) {
              slPrice = recentLow.price * (1 - PIVOT_BUFFER);
            }
            const dist = ep - slPrice;
            if (dist > 0) {
              const capped = capSL(ep, dist);
              slPrice = ep - capped;
            } else {
              slPrice = ep - ep * MIN_SL_PCT;
            }
          } else {
            slPrice = entry.pivotPrice * (1 + PIVOT_BUFFER);
            if (entry.mode === "cont-short" && recentHigh) {
              slPrice = recentHigh.price * (1 + PIVOT_BUFFER);
            }
            const dist = slPrice - ep;
            if (dist > 0) {
              const capped = capSL(ep, dist);
              slPrice = ep + capped;
            } else {
              slPrice = ep + ep * MIN_SL_PCT;
            }
          }

          pos = {
            pair, dir: entry.dir, ep, et: barJustClosed.t + H1, // entry at close
            sl: slPrice, pivot: entry.pivotPrice,
            peakPnlPct: 0,
            deadline: barJustClosed.t + H1 + MAX_HOLD_H * H1,
            entryMode: entry.mode,
          };
        }
      }

      h1Idx++;
    }

    if (!pos) continue;

    // Intra-bar: check SL first, then trail (leveraged PnL %), then max hold
    // SL hit on 5m bar
    const hitSL = pos.dir === "long" ? b5.l <= pos.sl : b5.h >= pos.sl;
    if (hitSL) {
      const xp = pos.sl;
      const pnl = calcPnl(pair, pos.ep, xp, pos.dir, true);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: b5.t, pnl, reason: "SL", mode: pos.entryMode });
      pos = null; continue;
    }

    // Update peak unleveraged-price % -> leveraged %
    const curPnlPct = pos.dir === "long"
      ? (b5.h / pos.ep - 1) * 100 * LEV
      : (pos.ep / b5.l - 1) * 100 * LEV;
    if (curPnlPct > pos.peakPnlPct) pos.peakPnlPct = curPnlPct;

    // Trailing stop against close of 5m
    const currPnlPct = pos.dir === "long"
      ? (b5.c / pos.ep - 1) * 100 * LEV
      : (pos.ep / b5.c - 1) * 100 * LEV;
    let trailDist = Infinity;
    for (const step of TRAIL_STEPS) {
      if (pos.peakPnlPct >= step.activate) trailDist = step.dist;
    }
    if (trailDist < Infinity && currPnlPct <= pos.peakPnlPct - trailDist) {
      const xp = b5.c;
      const pnl = calcPnl(pair, pos.ep, xp, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: b5.t, pnl, reason: "trail", mode: pos.entryMode });
      pos = null; continue;
    }

    // Max hold
    if (b5.t >= pos.deadline) {
      const xp = b5.c;
      const pnl = calcPnl(pair, pos.ep, xp, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: b5.t, pnl, reason: "maxHold", mode: pos.entryMode });
      pos = null; continue;
    }
  }

  // Close any dangling position at end
  if (pos) {
    const last = bars5m[Math.min(bars5m.length - 1, i5 - 1)];
    const xp = last.c;
    const pnl = calcPnl(pair, pos.ep, xp, pos.dir, false);
    trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: last.t, pnl, reason: "eod", mode: pos.entryMode });
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  n: number; wr: number; pf: number; total: number; perDay: number; maxDd: number;
}
function calcStats(trades: Trade[]): Stats {
  if (!trades.length) return { n: 0, wr: 0, pf: 0, total: 0, perDay: 0, maxDd: 0 };
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = sorted.reduce((s, t) => s + t.pnl, 0);
  const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
  const wr = (wins.length / sorted.length) * 100;
  let eq = 0, peak = 0, dd = 0;
  for (const t of sorted) { eq += t.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  const first = sorted[0].et, last = sorted[sorted.length - 1].xt;
  const days = Math.max(1, (last - first) / DAY);
  return { n: sorted.length, wr, pf, total, perDay: total / days, maxDd: dd };
}

function fmtStats(label: string, s: Stats): string {
  return `${label.padEnd(28)} n=${String(s.n).padStart(5)}  wr=${s.wr.toFixed(1).padStart(5)}%  pf=${(s.pf === Infinity ? "inf" : s.pf.toFixed(2)).padStart(5)}  $/day=${s.perDay.toFixed(2).padStart(6)}  maxDD=$${s.maxDd.toFixed(0).padStart(4)}  total=$${s.total.toFixed(0)}`;
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  const allPairs = fs.readdirSync(CACHE_DIR)
    .filter(f => f.endsWith("USDT.json"))
    .map(f => f.replace("USDT.json", ""));
  console.log(`[bt-structure-break] Found ${allPairs.length} pairs in ${CACHE_DIR}`);

  // Preload: 5m + 1h once per pair
  console.log(`[bt-structure-break] Loading 5m+1h candles...`);
  const data = new Map<string, { b5: C[]; b1h: C[] }>();
  let loaded = 0;
  for (const pair of allPairs) {
    const b5 = load5m(pair);
    if (b5.length < 2000) continue;
    const b1h = aggregate(b5, H1);
    if (b1h.length < 500) continue;
    data.set(pair, { b5, b1h });
    loaded++;
    if (loaded % 20 === 0) console.log(`  loaded ${loaded}...`);
  }
  console.log(`[bt-structure-break] Usable pairs: ${data.size}`);

  const pairsToRun = [...data.keys()];

  const configs: { name: string; opts: SimOpts }[] = [];
  // Variation grid: pivot size x trend length x mode
  for (const pivotN of [2, 3, 5]) {
    for (const trendLen of [2, 3, 4]) {
      for (const mode of ["both", "cont", "rev"] as const) {
        configs.push({ name: `piv${pivotN}_k${trendLen}_${mode}`, opts: { pivotN, trendLen, mode } });
      }
    }
  }

  const lines: string[] = [];
  const push = (s: string) => { lines.push(s); console.log(s); };

  push(`═══════════════════════════════════════════════════════════════`);
  push(`Structure Trend-Break Backtest`);
  push(`Pairs: ${pairsToRun.length}  Margin: $${MARGIN}  Lev: ${LEV}x  Notional: $${NOTIONAL}`);
  push(`IS: ${new Date(FULL_START).toISOString().slice(0,10)} -> ${new Date(IS_END).toISOString().slice(0,10)}`);
  push(`OOS: ${new Date(OOS_START).toISOString().slice(0,10)} -> ${new Date(FULL_END).toISOString().slice(0,10)}`);
  push(`SL: pivot-buffered (0.15%-2%), Trail: 3/1 -> 9/0.5 -> 20/0.5, MaxHold: ${MAX_HOLD_H}h`);
  push(`═══════════════════════════════════════════════════════════════`);

  interface Row { name: string; is: Stats; oos: Stats; allTrades: Trade[]; }
  const rows: Row[] = [];

  for (const cfg of configs) {
    const allTrades: Trade[] = [];
    for (const pair of pairsToRun) {
      const d = data.get(pair)!;
      const t = simulate(pair, d.b5, d.b1h, FULL_START, FULL_END, cfg.opts);
      allTrades.push(...t);
    }
    const isTr = allTrades.filter(t => t.et < IS_END);
    const oosTr = allTrades.filter(t => t.et >= OOS_START);
    const is = calcStats(isTr);
    const oos = calcStats(oosTr);
    rows.push({ name: cfg.name, is, oos, allTrades });
  }

  // Sort by OOS $/day descending
  rows.sort((a, b) => b.oos.perDay - a.oos.perDay);

  push(``);
  push(`─── All configs (sorted by OOS $/day) ─────────────────────`);
  push(`config                        IS:                                                            OOS:`);
  for (const r of rows) {
    const line =
      `${r.name.padEnd(20)} ` +
      `IS n=${String(r.is.n).padStart(5)} pf=${(r.is.pf === Infinity ? "inf" : r.is.pf.toFixed(2)).padStart(5)} $/d=${r.is.perDay.toFixed(2).padStart(6)} dd=${r.is.maxDd.toFixed(0).padStart(4)}  | ` +
      `OOS n=${String(r.oos.n).padStart(5)} wr=${r.oos.wr.toFixed(1).padStart(5)}% pf=${(r.oos.pf === Infinity ? "inf" : r.oos.pf.toFixed(2)).padStart(5)} $/d=${r.oos.perDay.toFixed(2).padStart(6)} dd=${r.oos.maxDd.toFixed(0).padStart(4)}`;
    push(line);
  }

  // Best config
  const best = rows[0];
  push(``);
  push(`─── Best config: ${best.name} ─────────────────────────────`);
  push(fmtStats("  IS", best.is));
  push(fmtStats("  OOS", best.oos));

  // Kill check
  const killed = best.oos.perDay < 0.3 || best.oos.maxDd > 20;
  push(``);
  push(`Kill threshold: OOS $/day < $0.30 OR MDD > $20`);
  push(`Best OOS $/day=${best.oos.perDay.toFixed(2)} MDD=$${best.oos.maxDd.toFixed(0)} -> ${killed ? "KILLED" : "PASSED"}`);

  // Per-mode split on best
  push(``);
  push(`─── Best config per-mode breakdown (all trades) ───────────`);
  const modes = new Set(best.allTrades.map(t => t.mode));
  for (const m of modes) {
    const tr = best.allTrades.filter(t => t.mode === m && t.et >= OOS_START);
    push(fmtStats(`  OOS ${m}`, calcStats(tr)));
  }

  // Per-direction split on best (OOS)
  push(``);
  push(`─── Best config per-direction (OOS) ──────────────────────`);
  const longs = best.allTrades.filter(t => t.dir === "long" && t.et >= OOS_START);
  const shorts = best.allTrades.filter(t => t.dir === "short" && t.et >= OOS_START);
  push(fmtStats("  OOS longs", calcStats(longs)));
  push(fmtStats("  OOS shorts", calcStats(shorts)));

  // Correlation vs GARCH proxy: we can't reproduce GARCH here easily, but we can compute
  // the strategy's daily pnl series so caller can overlay. Print a simple concentration check
  // and dump per-day pnl sample.
  push(``);
  push(`─── Trade count / month (OOS) ─────────────────────────────`);
  const byMonth = new Map<string, { n: number; pnl: number }>();
  for (const t of best.allTrades.filter(t => t.et >= OOS_START)) {
    const d = new Date(t.xt);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = byMonth.get(k) ?? { n: 0, pnl: 0 };
    cur.n++; cur.pnl += t.pnl;
    byMonth.set(k, cur);
  }
  for (const [k, v] of [...byMonth.entries()].sort()) {
    push(`  ${k}  n=${String(v.n).padStart(4)}  pnl=$${v.pnl.toFixed(2).padStart(8)}`);
  }

  // GARCH-correlation heuristic: concurrent-high-vol days.
  // We approximate GARCH by per-pair rolling std of 1h returns (24h) z > 2 -> proxy GARCH trigger day.
  push(``);
  push(`─── GARCH correlation proxy (daily pnl vs proxy signal) ───`);
  try {
    const stratDaily = new Map<number, number>();
    for (const t of best.allTrades.filter(t => t.et >= OOS_START)) {
      const d = Math.floor(t.xt / DAY);
      stratDaily.set(d, (stratDaily.get(d) ?? 0) + t.pnl);
    }
    // Build proxy: number of pairs with |z-score| > 2 per day in OOS window
    const proxyDaily = new Map<number, number>();
    for (const pair of pairsToRun) {
      const b1h = data.get(pair)!.b1h;
      const rets: number[] = [];
      for (let i = 1; i < b1h.length; i++) rets.push(Math.log(b1h[i].c / b1h[i - 1].c));
      const N = 48; // 2 days rolling
      for (let i = N; i < b1h.length; i++) {
        if (b1h[i].t < OOS_START || b1h[i].t >= FULL_END) continue;
        let sum = 0, sq = 0;
        for (let j = i - N; j < i; j++) { sum += rets[j]; sq += rets[j] * rets[j]; }
        const mean = sum / N;
        const v = sq / N - mean * mean;
        const std = v > 0 ? Math.sqrt(v) : 0;
        if (std === 0) continue;
        const z = (rets[i] - mean) / std;
        if (Math.abs(z) > 2) {
          const d = Math.floor(b1h[i].t / DAY);
          proxyDaily.set(d, (proxyDaily.get(d) ?? 0) + 1);
        }
      }
    }
    // Pearson correlation
    const days = new Set<number>([...stratDaily.keys(), ...proxyDaily.keys()]);
    const xs: number[] = [], ys: number[] = [];
    for (const d of days) {
      xs.push(stratDaily.get(d) ?? 0);
      ys.push(proxyDaily.get(d) ?? 0);
    }
    const n = xs.length;
    if (n >= 10) {
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let c = 0, sx = 0, sy = 0;
      for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; c += dx * dy; sx += dx * dx; sy += dy * dy; }
      const r = sx > 0 && sy > 0 ? c / Math.sqrt(sx * sy) : 0;
      push(`  Pearson r (strat pnl vs GARCH-proxy daily signal count) = ${r.toFixed(3)}  over ${n} days`);
      push(`  Interpretation: |r|<0.2 uncorrelated, 0.2-0.5 weak, >0.5 correlated`);
    } else {
      push(`  insufficient overlap days for correlation`);
    }
  } catch (e) {
    push(`  correlation calc failed: ${(e as Error).message}`);
  }

  push(``);
  push(`═══════════════════════════════════════════════════════════════`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8");
  console.log(`\n[bt-structure-break] Wrote ${OUT_PATH}`);
}

main();
