/**
 * Opening Range Breakout (ORB) for crypto — UTC day anchor
 *
 * SIGNAL
 *   Day boundary = UTC 00:00
 *   Opening range = high/low of first N hours of the UTC day
 *   After the range window (from rangeEnd to 22:00 UTC):
 *     - LONG when price breaks ABOVE range high
 *     - SHORT when price breaks BELOW range low
 *   Max one trade per pair per day (first-trade mode), or unlimited
 *   Exit: TP = K * range, SL = M * range (opposite side or fraction), time stop at 22:00 UTC
 *
 * WALK-FORWARD
 *   IS:  Jun 2025 - Dec 2025
 *   OOS: Dec 2025 - Mar 2026
 *
 * KILL
 *   OOS $/day < $0.30 OR MDD > $20
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-orb.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const OUT_FILE = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester/orb.txt";
const H = 3_600_000;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP_MULT = 1.5;
const LEV = 10;
const SIZE = 15; // $15 margin
const NOT = SIZE * LEV; // $150 notional

// IS / OOS windows
const IS_START = new Date("2025-06-01T00:00:00Z").getTime();
const IS_END = new Date("2025-12-01T00:00:00Z").getTime();
const OOS_START = new Date("2025-12-01T00:00:00Z").getTime();
const OOS_END = new Date("2026-03-25T00:00:00Z").getTime();

const IS_DAYS = (IS_END - IS_START) / D;
const OOS_DAYS = (OOS_END - OOS_START) / D;

// Day cutoff for exit (time stop at 22:00 UTC)
const DAY_CUTOFF_H = 22;

// Spread map (half-spread per side)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4,
};
const DEFAULT_SPREAD = 5e-4;

// Variations to sweep
const RANGE_HOURS_OPTS = [2, 4, 6, 8];
const TP_MULT_OPTS = [1.0, 1.5, 2.0, 3.0];
const SL_MODE_OPTS = ["opposite", "half"] as const; // opposite side of range (1x) OR 0.5x range
const VOL_FILTER_OPTS = [false, true];
const FIRST_ONLY_OPTS = [true, false];

type SLMode = typeof SL_MODE_OPTS[number];

interface Config {
  rangeHours: number;
  tpMult: number;
  slMode: SLMode;
  volFilter: boolean;
  firstOnly: boolean;
}

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
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

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR5m(cs: C[], period: number): number[] {
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

// ─── Strategy ───────────────────────────────────────────────────────
/**
 * ORB on 5m bars. Iterate UTC days; compute OR from first rangeHours;
 * from rangeEnd to 22:00 UTC watch for breakouts; intra-bar TP/SL resolution
 * with conservative ordering (SL checked before TP on adverse bars).
 */
function runORB(
  pair: string,
  cs: C[],
  cfg: Config,
  startTs: number,
  endTs: number,
): Tr[] {
  const trades: Tr[] = [];
  if (cs.length < 500) return trades;

  const sp = SP[pair] ?? DEFAULT_SPREAD;

  // Optional: ATR(14) on 5m * scale for vol regime. We use a simpler
  // daily volatility ratio: compare prior 5-day true-range sum to 20-day avg.
  // regime OK when last-5-day sum / last-20-day sum * 4 > 1.5
  // Pre-compute per bar with 5m ATR and a slow baseline.
  let atrShort: number[] = [];
  let atrLong: number[] = [];
  if (cfg.volFilter) {
    atrShort = calcATR5m(cs, 288); // ~1 day
    atrLong = calcATR5m(cs, 288 * 10); // ~10 days
  }

  // Group 5m bars by UTC day
  const dayStart = Math.floor(cs[0]!.t / D) * D;
  const dayEnd = Math.floor(cs[cs.length - 1]!.t / D) * D;

  // Build index map for fast day lookup
  // Iterate days; per day find bars in [day, day+D)
  let barIdx = 0;
  for (let day = dayStart; day <= dayEnd; day += D) {
    // advance barIdx to first bar >= day
    while (barIdx < cs.length && cs[barIdx]!.t < day) barIdx++;
    if (barIdx >= cs.length) break;

    // collect bars for this day
    const dayBars: { bar: C; idx: number }[] = [];
    let k = barIdx;
    while (k < cs.length && cs[k]!.t < day + D) {
      dayBars.push({ bar: cs[k]!, idx: k });
      k++;
    }
    if (dayBars.length < 20) continue;

    // Opening range window: [day, day + rangeHours*H)
    const rangeEndTs = day + cfg.rangeHours * H;
    const cutoffTs = day + DAY_CUTOFF_H * H;

    let orH = -Infinity;
    let orL = Infinity;
    let rangeBarsCount = 0;
    let firstTradeBarIdx = -1;
    for (let i = 0; i < dayBars.length; i++) {
      const { bar } = dayBars[i]!;
      if (bar.t < rangeEndTs) {
        orH = Math.max(orH, bar.h);
        orL = Math.min(orL, bar.l);
        rangeBarsCount++;
      } else {
        firstTradeBarIdx = i;
        break;
      }
    }
    // Need reasonable number of bars in the range window
    const minRangeBars = Math.floor((cfg.rangeHours * 60) / 5 * 0.7);
    if (rangeBarsCount < minRangeBars) continue;
    if (orH === -Infinity || orL === Infinity) continue;
    if (firstTradeBarIdx < 0) continue;
    const rangeSize = orH - orL;
    if (rangeSize <= 0) continue;

    // Vol filter: require ATR ratio > 1.5 at rangeEnd (shortVol / longVol > 1.5)
    if (cfg.volFilter) {
      const rIdx = dayBars[firstTradeBarIdx]!.idx;
      const aS = atrShort[rIdx] ?? 0;
      const aL = atrLong[rIdx] ?? 0;
      if (aL <= 0 || aS / aL < 1.5) {
        // skip day
        barIdx = k;
        continue;
      }
    }

    // Session: from firstTradeBarIdx until cutoff
    let pos: { dir: "long" | "short"; ep: number; et: number; tp: number; sl: number } | null = null;
    let didTrade = false;
    // Re-entry guards: after a long breakout fires, require price to return
    // inside the range (below orH) before another long can trigger. Same for short.
    let longArmed = true;
    let shortArmed = true;

    for (let i = firstTradeBarIdx; i < dayBars.length; i++) {
      const { bar } = dayBars[i]!;
      if (bar.t >= cutoffTs) break;

      // Re-arm if price comes back inside the range
      if (!longArmed && bar.l < orH) longArmed = true;
      if (!shortArmed && bar.h > orL) shortArmed = true;

      // Manage existing position
      if (pos) {
        let xp = 0, reason = "", isSL = false;
        if (pos.dir === "long") {
          // Conservative: if both SL and TP in bar, assume SL first
          if (bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
          else if (bar.h >= pos.tp) { xp = pos.tp; reason = "tp"; }
        } else {
          if (bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
          else if (bar.l <= pos.tp) { xp = pos.tp; reason = "tp"; }
        }

        if (!xp && bar.t + 5 * 60 * 1000 >= cutoffTs) {
          xp = bar.c; reason = "time";
        }

        if (xp > 0) {
          const entrySlip = pos.ep * sp;
          const exitSlip = xp * sp * (isSL ? SL_SLIP_MULT : 1);
          const rawPnl = pos.dir === "long"
            ? (xp / pos.ep - 1) * NOT
            : (pos.ep / xp - 1) * NOT;
          const pnl = rawPnl - entrySlip * (NOT / pos.ep) - exitSlip * (NOT / xp) - NOT * FEE * 2;

          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason });
          }
          pos = null;
        }
      }

      // Entry: breakout during session
      if (!pos && !(cfg.firstOnly && didTrade)) {
        // Long if bar.h >= orH (and long is armed), short if bar.l <= orL (and short is armed)
        // Use the breakout level as entry (assume limit/market on touch)
        let newDir: "long" | "short" | null = null;
        let ep = 0;
        if (longArmed && bar.h >= orH) { newDir = "long"; ep = orH; longArmed = false; }
        else if (shortArmed && bar.l <= orL) { newDir = "short"; ep = orL; shortArmed = false; }

        if (newDir) {
          const tp = newDir === "long" ? ep + cfg.tpMult * rangeSize : ep - cfg.tpMult * rangeSize;
          const slDist = cfg.slMode === "opposite" ? rangeSize : rangeSize * 0.5;
          const sl = newDir === "long" ? ep - slDist : ep + slDist;

          if (bar.t >= startTs && bar.t < endTs) {
            pos = { dir: newDir, ep, et: bar.t, tp, sl };
            didTrade = true;

            // Also check if TP/SL hit within the entry bar after break
            // Conservative: assume entry fires then later both levels could resolve
            // We let the next iteration handle it; but if it's same bar also check
            if (newDir === "long") {
              if (bar.l <= sl) {
                // SL on entry bar
                const xp = sl;
                const entrySlip = ep * sp;
                const exitSlip = xp * sp * SL_SLIP_MULT;
                const pnl = (xp / ep - 1) * NOT - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - NOT * FEE * 2;
                if (bar.t >= startTs && bar.t < endTs) {
                  trades.push({ pair, dir: "long", ep, xp, et: bar.t, xt: bar.t, pnl, reason: "sl" });
                }
                pos = null;
              } else if (bar.h >= tp) {
                const xp = tp;
                const entrySlip = ep * sp;
                const exitSlip = xp * sp;
                const pnl = (xp / ep - 1) * NOT - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - NOT * FEE * 2;
                if (bar.t >= startTs && bar.t < endTs) {
                  trades.push({ pair, dir: "long", ep, xp, et: bar.t, xt: bar.t, pnl, reason: "tp" });
                }
                pos = null;
              }
            } else {
              if (bar.h >= sl) {
                const xp = sl;
                const entrySlip = ep * sp;
                const exitSlip = xp * sp * SL_SLIP_MULT;
                const pnl = (ep / xp - 1) * NOT - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - NOT * FEE * 2;
                if (bar.t >= startTs && bar.t < endTs) {
                  trades.push({ pair, dir: "short", ep, xp, et: bar.t, xt: bar.t, pnl, reason: "sl" });
                }
                pos = null;
              } else if (bar.l <= tp) {
                const xp = tp;
                const entrySlip = ep * sp;
                const exitSlip = xp * sp;
                const pnl = (ep / xp - 1) * NOT - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - NOT * FEE * 2;
                if (bar.t >= startTs && bar.t < endTs) {
                  trades.push({ pair, dir: "short", ep, xp, et: bar.t, xt: bar.t, pnl, reason: "tp" });
                }
                pos = null;
              }
            }
          }
        }
      }
    }

    // Close at end of day session if still open
    if (pos) {
      // Find last bar before cutoff for close price
      let closeBar: C | null = null;
      for (let i = dayBars.length - 1; i >= 0; i--) {
        if (dayBars[i]!.bar.t < cutoffTs) { closeBar = dayBars[i]!.bar; break; }
      }
      if (closeBar) {
        const xp = closeBar.c;
        const entrySlip = pos.ep * sp;
        const exitSlip = xp * sp;
        const rawPnl = pos.dir === "long" ? (xp / pos.ep - 1) * NOT : (pos.ep / xp - 1) * NOT;
        const pnl = rawPnl - entrySlip * (NOT / pos.ep) - exitSlip * (NOT / xp) - NOT * FEE * 2;
        if (pos.et >= startTs && pos.et < endTs) {
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: closeBar.t, pnl, reason: "time" });
        }
      }
      pos = null;
    }

    barIdx = k;
  }

  return trades;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number;
  dd: number; total: number; perDay: number;
  longs: number; shorts: number;
  tps: number; sls: number; times: number;
}

function calcMetrics(trades: Tr[], days: number): Metrics {
  if (trades.length === 0) {
    return { n: 0, wr: 0, pf: 0, dd: 0, total: 0, perDay: 0, longs: 0, shorts: 0, tps: 0, sls: 0, times: 0 };
  }
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const longs = trades.filter(t => t.dir === "long").length;
  const shorts = trades.filter(t => t.dir === "short").length;
  const tps = trades.filter(t => t.reason === "tp").length;
  const sls = trades.filter(t => t.reason === "sl").length;
  const times = trades.filter(t => t.reason === "time").length;

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  return {
    n: trades.length,
    wr: trades.length > 0 ? wins.length / trades.length * 100 : 0,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
    longs, shorts, tps, sls, times,
  };
}

function fmtPnl(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

// ─── Output capture ─────────────────────────────────────────────────
const outLines: string[] = [];
function log(s: string = "") {
  console.log(s);
  outLines.push(s);
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  log("=".repeat(100));
  log("  OPENING RANGE BREAKOUT (ORB) — UTC day anchor — crypto 24/7 adaptation");
  log(`  $${SIZE} margin × ${LEV}x = $${NOT} notional  |  FEE ${FEE}  |  SL slip ${SL_SLIP_MULT}x`);
  log(`  IS:  ${new Date(IS_START).toISOString().slice(0, 10)} → ${new Date(IS_END).toISOString().slice(0, 10)}  (${IS_DAYS.toFixed(0)}d)`);
  log(`  OOS: ${new Date(OOS_START).toISOString().slice(0, 10)} → ${new Date(OOS_END).toISOString().slice(0, 10)}  (${OOS_DAYS.toFixed(0)}d)`);
  log("=".repeat(100));

  // Discover pairs in 5m cache
  const cacheFiles = fs.readdirSync(CACHE_5M).filter(f => f.endsWith(".json"));
  const pairs: string[] = [];
  for (const f of cacheFiles) {
    const sym = f.replace("USDT.json", "").replace(".json", "");
    pairs.push(sym);
  }
  pairs.sort();
  log(`\n  Loaded ${pairs.length} pairs from ${CACHE_5M}`);

  // Preload 5m data (skip pairs with too little data)
  log("\n  Preloading 5m data...");
  const loaded: { pair: string; bars: C[] }[] = [];
  for (const p of pairs) {
    const bars = load5m(`${p}USDT`);
    if (bars.length < 10_000) continue;
    // Need data inside IS/OOS windows
    if (bars[bars.length - 1]!.t < IS_START + 30 * D) continue;
    loaded.push({ pair: p, bars });
  }
  log(`  Usable pairs: ${loaded.length}`);

  if (loaded.length === 0) {
    log("  ERROR: no usable pairs");
    return;
  }

  // Build configs
  const configs: Config[] = [];
  for (const rh of RANGE_HOURS_OPTS) {
    for (const tp of TP_MULT_OPTS) {
      for (const sl of SL_MODE_OPTS) {
        for (const vf of VOL_FILTER_OPTS) {
          for (const fo of FIRST_ONLY_OPTS) {
            configs.push({ rangeHours: rh, tpMult: tp, slMode: sl, volFilter: vf, firstOnly: fo });
          }
        }
      }
    }
  }
  log(`\n  Config grid: ${configs.length} combinations`);

  // Run each config across all pairs on IS window. Pick top N by IS $/day → test on OOS.
  log("\n" + "-".repeat(100));
  log("  PHASE 1: In-sample sweep (" + IS_DAYS.toFixed(0) + "d)");
  log("-".repeat(100));

  interface CfgResult {
    cfg: Config;
    is: Metrics;
    oos: Metrics | null;
  }
  const cfgResults: CfgResult[] = [];

  let cfgCount = 0;
  for (const cfg of configs) {
    cfgCount++;
    const allTrades: Tr[] = [];
    for (const { pair, bars } of loaded) {
      const trades = runORB(pair, bars, cfg, IS_START, IS_END);
      for (const t of trades) allTrades.push(t);
    }
    const is = calcMetrics(allTrades, IS_DAYS);
    cfgResults.push({ cfg, is, oos: null });
    if (cfgCount % 16 === 0 || cfgCount === configs.length) {
      log(`    ${cfgCount}/${configs.length} configs tested`);
    }
  }

  // Rank by IS $/day
  cfgResults.sort((a, b) => b.is.perDay - a.is.perDay);

  log("\n  IS top 20 by $/day:");
  log("  " + "-".repeat(98));
  log("  " + "rh  tp   slMode    vol  first   N     WR%     PF      PnL       $/day     MaxDD");
  log("  " + "-".repeat(98));
  for (let i = 0; i < Math.min(20, cfgResults.length); i++) {
    const r = cfgResults[i]!;
    const m = r.is;
    log("  "
      + String(r.cfg.rangeHours).padStart(2) + "  "
      + r.cfg.tpMult.toFixed(1).padStart(3) + "  "
      + r.cfg.slMode.padEnd(8) + "  "
      + String(r.cfg.volFilter).padEnd(5) + "  "
      + String(r.cfg.firstOnly).padEnd(5) + "  "
      + String(m.n).padStart(5) + "  "
      + m.wr.toFixed(1).padStart(5) + "%  "
      + (m.pf === Infinity ? "  Inf" : m.pf.toFixed(2).padStart(5)) + "  "
      + fmtPnl(m.total).padStart(9) + "  "
      + fmtPnl(m.perDay).padStart(8) + "  $"
      + m.dd.toFixed(0).padStart(4)
    );
  }

  // Take top 10 IS configs, run OOS
  const topN = Math.min(10, cfgResults.length);
  log("\n" + "-".repeat(100));
  log(`  PHASE 2: Out-of-sample test (${OOS_DAYS.toFixed(0)}d) on top ${topN} IS configs`);
  log("-".repeat(100));

  for (let i = 0; i < topN; i++) {
    const r = cfgResults[i]!;
    const allTrades: Tr[] = [];
    for (const { pair, bars } of loaded) {
      const trades = runORB(pair, bars, r.cfg, OOS_START, OOS_END);
      for (const t of trades) allTrades.push(t);
    }
    r.oos = calcMetrics(allTrades, OOS_DAYS);
  }

  log("\n  Top IS → OOS:");
  log("  " + "-".repeat(98));
  log("  " + "rh  tp  sl       vol  first | IS $/day   IS PF    IS DD  | OOS $/day  OOS PF  OOS DD  OOS N   Verdict");
  log("  " + "-".repeat(98));

  const KILL_PERDAY = 0.30;
  const KILL_DD = 20;

  let bestOOS: CfgResult | null = null;

  for (let i = 0; i < topN; i++) {
    const r = cfgResults[i]!;
    const is = r.is;
    const oos = r.oos!;
    let verdict = "PASS";
    if (oos.perDay < KILL_PERDAY) verdict = "KILL-$/d";
    else if (oos.dd > KILL_DD) verdict = "KILL-DD";
    if (verdict === "PASS" && (bestOOS === null || oos.perDay > bestOOS.oos!.perDay)) {
      bestOOS = r;
    }
    log("  "
      + String(r.cfg.rangeHours).padStart(2) + "  "
      + r.cfg.tpMult.toFixed(1).padStart(3) + "  "
      + r.cfg.slMode.padEnd(8) + " "
      + String(r.cfg.volFilter).padEnd(5) + " "
      + String(r.cfg.firstOnly).padEnd(5) + "| "
      + fmtPnl(is.perDay).padStart(8) + "  "
      + (is.pf === Infinity ? "  Inf" : is.pf.toFixed(2).padStart(5)) + "  $"
      + is.dd.toFixed(0).padStart(4) + "  | "
      + fmtPnl(oos.perDay).padStart(8) + "   "
      + (oos.pf === Infinity ? "  Inf" : oos.pf.toFixed(2).padStart(5)) + "  $"
      + oos.dd.toFixed(0).padStart(4) + "   "
      + String(oos.n).padStart(5) + "  "
      + verdict
    );
  }

  // Final verdict
  log("\n" + "=".repeat(100));
  log("  FINAL VERDICT");
  log("=".repeat(100));

  if (!bestOOS) {
    log("\n  ORB DOES NOT WORK for 24/7 crypto under this test.");
    log("  No config in the IS top 10 clears the kill threshold on OOS.");
    log(`  Kill threshold: OOS $/day >= $${KILL_PERDAY.toFixed(2)} AND OOS MaxDD <= $${KILL_DD}`);

    // Report best OOS $/day regardless
    let bestByPerDay = cfgResults[0]!;
    for (const r of cfgResults) {
      if (r.oos && r.oos.perDay > (bestByPerDay.oos?.perDay ?? -Infinity)) bestByPerDay = r;
    }
    if (bestByPerDay.oos) {
      log(`\n  Best OOS $/day achieved: ${fmtPnl(bestByPerDay.oos.perDay)} (PF ${bestByPerDay.oos.pf === Infinity ? "Inf" : bestByPerDay.oos.pf.toFixed(2)}, MaxDD $${bestByPerDay.oos.dd.toFixed(0)})`);
      log(`  Config: rh=${bestByPerDay.cfg.rangeHours} tp=${bestByPerDay.cfg.tpMult} sl=${bestByPerDay.cfg.slMode} vol=${bestByPerDay.cfg.volFilter} first=${bestByPerDay.cfg.firstOnly}`);
    }
  } else {
    log("\n  BEST PASSING CONFIG (IS top 10 → OOS pass):");
    log(`    rangeHours: ${bestOOS.cfg.rangeHours}`);
    log(`    tpMult:     ${bestOOS.cfg.tpMult}`);
    log(`    slMode:     ${bestOOS.cfg.slMode}`);
    log(`    volFilter:  ${bestOOS.cfg.volFilter}`);
    log(`    firstOnly:  ${bestOOS.cfg.firstOnly}`);
    log(`\n    IS:  N=${bestOOS.is.n}  $/d=${fmtPnl(bestOOS.is.perDay)}  PF=${bestOOS.is.pf === Infinity ? "Inf" : bestOOS.is.pf.toFixed(2)}  WR=${bestOOS.is.wr.toFixed(1)}%  DD=$${bestOOS.is.dd.toFixed(0)}`);
    log(`    OOS: N=${bestOOS.oos!.n}  $/d=${fmtPnl(bestOOS.oos!.perDay)}  PF=${bestOOS.oos!.pf === Infinity ? "Inf" : bestOOS.oos!.pf.toFixed(2)}  WR=${bestOOS.oos!.wr.toFixed(1)}%  DD=$${bestOOS.oos!.dd.toFixed(0)}`);
    log(`    Exits OOS: tp=${bestOOS.oos!.tps} sl=${bestOOS.oos!.sls} time=${bestOOS.oos!.times}`);
  }

  log("\n" + "=".repeat(100));
  log("  DONE");
  log("=".repeat(100));

  // Write to output file
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, outLines.join("\n"));
  console.log(`\n  Saved: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
