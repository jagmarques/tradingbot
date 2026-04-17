/**
 * RSI MEAN REVERSION BACKTEST
 *
 * Buy oversold (RSI < threshold), sell overbought (RSI > threshold).
 * Tight TP targets, fixed SL, fast exits on 5m bars.
 *
 * Performance:
 * - Process each core combo (rsi, tp, sl, maxHold, longOnly) and immediately
 *   apply maxConc filters, then discard raw trades (no memory accumulation)
 * - Margin is a pure linear scaler: simulate at margin=$1, scale PnL+MDD after
 * - Only 3 maxConc variants per core combo (not 12 margin x 3 maxConc)
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const BAR_MS = 5 * 60_000;
const D = 86_400_000;
const FEE = 0.00035;

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DSP = 5e-4;
const RM: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };

const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
const getLev = (n: string) => Math.min(LM.get(n) ?? 3, 10);

const ALL_PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
  "ZEC", "AVAX", "NEAR", "kPEPE", "SUI", "HYPE", "FET",
  "FIL", "ALGO", "BCH", "JTO", "SAND", "BLUR", "TAO", "RENDER", "TRX", "AAVE",
  "JUP", "POL", "CRV", "PYTH", "IMX", "BNB", "ONDO", "XLM", "DYDX", "ICP", "LTC", "MKR",
  "PENDLE", "PNUT", "ATOM", "TON", "SEI", "STX",
  "DYM", "CFX", "ALT", "BIO", "OMNI", "ORDI", "XAI", "SUSHI", "ME", "ZEN",
  "TNSR", "CATI", "TURBO", "MOVE", "GALA", "STRK", "SAGA", "ILV", "GMX", "OM",
  "CYBER", "NTRN", "BOME", "MEME", "ANIME", "BANANA", "ETC", "USUAL", "UMA", "USTC",
  "MAV", "REZ", "NOT", "PENGU", "BIGTIME", "WCT", "EIGEN", "MANTA", "POLYX", "W",
  "FXS", "GMT", "RSR", "PEOPLE", "YGG", "TRB", "ETHFI", "ENS", "OGN", "AXS",
  "MINA", "LISTA", "NEO", "AI", "SCR", "APE", "KAITO", "AR", "BNT", "PIXEL",
  "LAYER", "ZRO", "CELO", "ACE", "COMP", "RDNT", "ZK", "MET", "STG", "REQ",
  "CAKE", "SUPER", "FTT", "STRAX",
];

const START_TS = new Date("2025-06-01").getTime();
const END_TS = new Date("2026-03-25").getTime();
const DAYS = (END_TS - START_TS) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface PairData {
  name: string; idx: number; m5: C[];
  rsi: Float64Array; sp: number; lev: number;
}

function load(s: string): C[] {
  const f = path.join(CACHE_5M, `${s}.json`);
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as unknown[])
    .map((b: unknown) => {
      if (Array.isArray(b)) return { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
      const o = b as Record<string, number>;
      return { t: +o.t, o: +o.o, h: +o.h, l: +o.l, c: +o.c };
    })
    .sort((a, b) => a.t - b.t);
}

function computeRSI(bars: C[]): Float64Array {
  const n = bars.length;
  const rsi = new Float64Array(n);
  const period = 14;
  if (n < period + 1) return rsi;
  let sumGain = 0, sumLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = bars[i]!.c - bars[i - 1]!.c;
    if (d > 0) sumGain += d; else sumLoss -= d;
  }
  let ag = sumGain / period, al = sumLoss / period;
  rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  const a = 1 / period;
  for (let i = period + 1; i < n; i++) {
    const d = bars[i]!.c - bars[i - 1]!.c;
    ag = ag * (1 - a) + (d > 0 ? d : 0) * a;
    al = al * (1 - a) + (d < 0 ? -d : 0) * a;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

/* ── Lightweight trade record (margin-independent) ───────────── */
interface RTrade {
  entryTs: number;
  exitTs: number;
  pnlPerNotional: number; // PnL per $1 notional
  holdBars: number;
  lev: number;
}

/**
 * Resolve all trades for a given core config. Processes each pair independently
 * (pair exclusion + cooldowns are per-pair). Returns trades sorted by entryTs.
 */
function resolveAll(
  pairs: PairData[], rsiLong: number, rsiShort: number, longOnly: boolean,
  tpPct: number, slPct: number, maxHoldBars: number,
): RTrade[] {
  const results: RTrade[] = [];

  for (const p of pairs) {
    let pairFree = 0;
    let cdL = 0, cdS = 0;

    for (let bi = 15; bi < p.m5.length; bi++) {
      const bar = p.m5[bi]!;
      if (bar.t < START_TS || bar.t >= END_TS) continue;
      if (bar.t < pairFree) continue;

      const rsiVal = p.rsi[bi - 1]!;
      if (rsiVal === 0) continue;

      let dir = -1; // 0=long, 1=short
      if (rsiVal < rsiLong && bar.t - cdL >= H) dir = 0;
      else if (!longOnly && rsiVal > rsiShort && bar.t - cdS >= H) dir = 1;
      if (dir < 0) continue;

      const ep = dir === 0 ? bar.o * (1 + p.sp) : bar.o * (1 - p.sp);
      const slP = dir === 0 ? ep * (1 - slPct) : ep * (1 + slPct);
      const tpP = dir === 0 ? ep * (1 + tpPct) : ep * (1 - tpPct);

      const endIdx = Math.min(bi + maxHoldBars, p.m5.length - 1);
      let exitBi = endIdx;
      let exitPnl = 0;
      let isSL = false;
      let found = false;

      for (let j = bi; j <= endIdx; j++) {
        const b = p.m5[j]!;
        // SL
        if (dir === 0 && b.l <= slP) {
          exitPnl = (slP * (1 - p.sp * 1.5) / ep - 1) - FEE * 2;
          exitBi = j; isSL = true; found = true; break;
        }
        if (dir === 1 && b.h >= slP) {
          exitPnl = (1 - slP * (1 + p.sp * 1.5) / ep) - FEE * 2;
          exitBi = j; isSL = true; found = true; break;
        }
        // TP
        if (dir === 0 && b.h >= tpP) {
          exitPnl = (tpP * (1 - p.sp) / ep - 1) - FEE * 2;
          exitBi = j; found = true; break;
        }
        if (dir === 1 && b.l <= tpP) {
          exitPnl = (1 - tpP * (1 + p.sp) / ep) - FEE * 2;
          exitBi = j; found = true; break;
        }
      }

      if (!found && exitBi > bi) {
        const b = p.m5[exitBi]!;
        const ex = dir === 0 ? b.c * (1 - p.sp) : b.c * (1 + p.sp);
        exitPnl = dir === 0 ? (ex / ep - 1) - FEE * 2 : (1 - ex / ep) - FEE * 2;
      }

      const exitTs = exitBi < p.m5.length ? p.m5[exitBi]!.t : p.m5[p.m5.length - 1]!.t;

      results.push({ entryTs: bar.t, exitTs, pnlPerNotional: exitPnl, holdBars: exitBi - bi, lev: p.lev });

      pairFree = exitTs + BAR_MS;
      if (isSL) { if (dir === 0) cdL = exitTs; else cdS = exitTs; }
    }
  }

  results.sort((a, b) => a.entryTs - b.entryTs);
  return results;
}

/**
 * Apply maxConc filter and compute stats. Margin is a linear scaler
 * applied at the end.
 */
interface Stats {
  n: number; wins: number; gwScaled: number; glScaled: number;
  pnlScaled: number; mddScaled: number; holdH: number;
}

function applyMaxConcAndStats(trades: RTrade[], maxConc: number, margin: number): Stats {
  // Track active positions via sorted exit-time list
  const activeExits: number[] = [];
  let pnl = 0, gw = 0, gl = 0, wins = 0, holdH = 0, n = 0;

  // For realized-only MDD tracking
  let peak = 0, mdd = 0;

  // We process signals in order and build exit events simultaneously
  // Using two pointers: signals in entry-order, exits in exit-order
  const exitPnls: { ts: number; pnl: number }[] = [];

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]!;

    // Remove expired positions
    while (activeExits.length > 0 && activeExits[0]! <= t.entryTs) {
      activeExits.shift();
    }

    if (activeExits.length >= maxConc) continue;

    // Accept this trade
    const notional = margin * t.lev;
    const tpnl = t.pnlPerNotional * notional;

    n++;
    pnl += tpnl;
    holdH += t.holdBars * 5 / 60;
    if (tpnl > 0) { wins++; gw += tpnl; } else gl += Math.abs(tpnl);

    exitPnls.push({ ts: t.exitTs, pnl: tpnl });

    // Insert exit time in sorted order (binary search)
    const ets = t.exitTs;
    let lo = 0, hi = activeExits.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (activeExits[m]! < ets) lo = m + 1; else hi = m; }
    activeExits.splice(lo, 0, ets);
  }

  if (n === 0) return { n: 0, wins: 0, gwScaled: 0, glScaled: 0, pnlScaled: 0, mddScaled: 0, holdH: 0 };

  // Compute realized MDD from exit events in chronological order
  exitPnls.sort((a, b) => a.ts - b.ts);
  let realized = 0;
  for (const ev of exitPnls) {
    realized += ev.pnl;
    if (realized > peak) peak = realized;
    const dd = peak - realized;
    if (dd > mdd) mdd = dd;
  }

  return { n, wins, gwScaled: gw, glScaled: gl, pnlScaled: pnl, mddScaled: mdd, holdH };
}

/* ── Config and Result types ─────────────────────────────────── */
interface Cfg {
  rsiLong: number; rsiShort: number;
  tpPct: number; slPct: number; maxHoldH: number;
  margin: number; maxConc: number; longOnly: boolean;
}

interface Result {
  cfg: Cfg; totalPnl: number; trades: number; wins: number;
  pf: number; wr: number; mdd: number; dolPerDay: number; avgHold: number;
}

/* ── Main ────────────────────────────────────────────────────── */
function main() {
  console.log("=".repeat(130));
  console.log("  RSI MEAN REVERSION BACKTEST");
  console.log("  RSI(14) on 5m bars | Buy oversold, sell overbought | Tight TP targets");
  console.log(`  Period: 2025-06-01 to 2026-03-25 (${DAYS.toFixed(0)} days)`);
  console.log("=".repeat(130));

  console.log("\nLoading pairs...");
  const pairs: PairData[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const warmupStart = START_TS - 24 * H;
    const m5 = raw.filter(b => b.t >= warmupStart && b.t <= END_TS);
    if (m5.length < 1000) continue;
    const rsi = computeRSI(m5);
    const lev = getLev(n);
    pairs.push({ name: n, idx: pairs.length, m5, rsi, sp: SP[n] ?? DSP, lev });
  }
  console.log(`${pairs.length} pairs loaded\n`);

  const RSI_LONG = [20, 25, 30];
  const RSI_SHORT = [70, 75, 80];
  const TP_PCT = [0.002, 0.003, 0.005, 0.007, 0.01];
  const SL_PCT = [0.0015, 0.002, 0.003, 0.005];
  const MAX_HOLD_H = [2, 4, 8, 12];
  const MARGIN = [3, 5, 7, 10];
  const MAX_CONC = [1, 3, 5];
  const LONG_ONLY_OPTS = [false, true];

  // Count core combos
  const totalCore = RSI_LONG.length * RSI_SHORT.length * LONG_ONLY_OPTS.length
    * TP_PCT.length * SL_PCT.length * MAX_HOLD_H.length; // 1440
  const totalConfigs = totalCore * MARGIN.length * MAX_CONC.length; // 17280

  console.log(`Core combos: ${totalCore}, total configs: ${totalConfigs}`);
  console.log("Processing (resolve + filter per core combo, no memory accumulation)...\n");

  const results: Result[] = [];
  const t0 = Date.now();
  let coreIdx = 0;

  for (const rsiL of RSI_LONG) {
    for (const rsiS of RSI_SHORT) {
      for (const lo of LONG_ONLY_OPTS) {
        for (const tp of TP_PCT) {
          for (const sl of SL_PCT) {
            for (const mh of MAX_HOLD_H) {
              coreIdx++;
              if (coreIdx % 50 === 0 || coreIdx === 1) {
                const el = (Date.now() - t0) / 1000;
                const rate = coreIdx > 1 ? (coreIdx - 1) / el : 0;
                const eta = rate > 0 ? (totalCore - coreIdx) / rate : 0;
                console.log(`  [${coreIdx}/${totalCore}] elapsed=${el.toFixed(0)}s rate=${rate.toFixed(1)}/s ETA=${eta.toFixed(0)}s`);
              }

              const maxHoldBars = mh * 12;
              const trades = resolveAll(pairs, rsiL, rsiS, lo, tp, sl, maxHoldBars);

              // Apply all margin x maxConc combos
              for (const mc of MAX_CONC) {
                // Since margin is linear, compute at margin=1 and scale
                const base = applyMaxConcAndStats(trades, mc, 1);
                if (base.n < 10) continue;

                for (const mg of MARGIN) {
                  const pnl = base.pnlScaled * mg;
                  const mdd = base.mddScaled * mg;
                  const gw = base.gwScaled * mg;
                  const gl = base.glScaled * mg;
                  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
                  const wr = (base.wins / base.n) * 100;
                  const avgHold = base.holdH / base.n;

                  results.push({
                    cfg: { rsiLong: rsiL, rsiShort: rsiS, tpPct: tp, slPct: sl,
                           maxHoldH: mh, margin: mg, maxConc: mc, longOnly: lo },
                    totalPnl: pnl, trades: base.n, wins: base.wins,
                    pf, wr, mdd, dolPerDay: pnl / DAYS, avgHold,
                  });
                }
              }
              // trades array is GC'd here
            }
          }
        }
      }
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\nDone in ${elapsed.toFixed(0)}s. ${results.length} results with >=10 trades.\n`);

  // Filter MDD < $20, sort by $/day
  const filtered = results.filter(r => r.mdd < 20 && r.mdd > 0);
  filtered.sort((a, b) => b.dolPerDay - a.dolPerDay);
  const top = filtered.slice(0, 50);

  console.log("=".repeat(155));
  console.log("  TOP 50 CONFIGS (realized MDD < $20, sorted by $/day)");
  console.log("=".repeat(155));

  const hdr =
    "Rk".padStart(3) + " " +
    "RSI-L".padStart(5) + " " +
    "RSI-S".padStart(5) + " " +
    " TP%".padStart(5) + " " +
    " SL%".padStart(5) + " " +
    "MaxH".padStart(4) + " " +
    " $Mg".padStart(4) + " " +
    "MaxC".padStart(4) + " " +
    "LO".padStart(3) + " " +
    "  $/day".padStart(8) + " " +
    "  TotPnl".padStart(9) + " " +
    "  MDD$".padStart(7) + " " +
    "   PF".padStart(5) + " " +
    "  WR%".padStart(6) + " " +
    " Trades".padStart(7) + " " +
    "AvgHld".padStart(6);

  console.log(hdr);
  console.log("-".repeat(155));

  for (let i = 0; i < top.length; i++) {
    const r = top[i]!;
    const c = r.cfg;
    console.log(
      String(i + 1).padStart(3) + " " +
      String(c.rsiLong).padStart(5) + " " +
      String(c.rsiShort).padStart(5) + " " +
      (c.tpPct * 100).toFixed(1).padStart(5) + " " +
      (c.slPct * 100).toFixed(2).padStart(5) + " " +
      String(c.maxHoldH).padStart(4) + " " +
      ("$" + c.margin).padStart(4) + " " +
      String(c.maxConc).padStart(4) + " " +
      (c.longOnly ? "Y" : "N").padStart(3) + " " +
      (r.dolPerDay >= 0 ? "+" : "") + "$" + Math.abs(r.dolPerDay).toFixed(2).padStart(6) + " " +
      (r.totalPnl >= 0 ? "+" : "-") + "$" + Math.abs(r.totalPnl).toFixed(2).padStart(7) + " " +
      ("$" + r.mdd.toFixed(2)).padStart(7) + " " +
      r.pf.toFixed(2).padStart(5) + " " +
      r.wr.toFixed(1).padStart(6) + " " +
      String(r.trades).padStart(7) + " " +
      (r.avgHold.toFixed(1) + "h").padStart(6)
    );
  }

  // Summary
  console.log("\n" + "=".repeat(155));
  console.log("  SUMMARY");
  console.log("=".repeat(155));
  console.log(`Total configs tested: ${totalConfigs}`);
  console.log(`With >=10 trades: ${results.length}`);
  console.log(`With MDD < $20: ${filtered.length}`);
  console.log(`Profitable ($/day > 0, MDD < $20): ${filtered.filter(r => r.dolPerDay > 0).length}`);

  if (top.length > 0) {
    const best = top[0]!;
    console.log(`\nBest config:`);
    console.log(`  RSI Long < ${best.cfg.rsiLong}, RSI Short > ${best.cfg.rsiShort}`);
    console.log(`  TP: ${(best.cfg.tpPct * 100).toFixed(1)}%, SL: ${(best.cfg.slPct * 100).toFixed(2)}%`);
    console.log(`  MaxHold: ${best.cfg.maxHoldH}h, Margin: $${best.cfg.margin}, MaxConc: ${best.cfg.maxConc}`);
    console.log(`  Long-only: ${best.cfg.longOnly ? "Yes" : "No"}`);
    console.log(`  $/day: ${best.dolPerDay >= 0 ? "+" : ""}$${best.dolPerDay.toFixed(2)}`);
    console.log(`  Total PnL: $${best.totalPnl.toFixed(2)}`);
    console.log(`  Realized MDD: $${best.mdd.toFixed(2)}`);
    console.log(`  PF: ${best.pf.toFixed(2)}, WR: ${best.wr.toFixed(1)}%, Trades: ${best.trades}`);
    console.log(`  Avg hold: ${best.avgHold.toFixed(1)}h`);
  }

  // Long-only vs Both analysis
  console.log("\n" + "=".repeat(155));
  console.log("  LONG-ONLY vs BOTH-DIRECTIONS (top 10 each, MDD < $20)");
  console.log("=".repeat(155));

  const loTop = filtered.filter(r => r.cfg.longOnly).slice(0, 10);
  const bothTop = filtered.filter(r => !r.cfg.longOnly).slice(0, 10);

  console.log("\nLong-only top 10:");
  for (const r of loTop)
    console.log(`  RSI<${r.cfg.rsiLong} TP=${(r.cfg.tpPct*100).toFixed(1)}% SL=${(r.cfg.slPct*100).toFixed(2)}% ${r.cfg.maxHoldH}h $${r.cfg.margin} mc=${r.cfg.maxConc} => $${r.dolPerDay.toFixed(2)}/d PF=${r.pf.toFixed(2)} WR=${r.wr.toFixed(1)}% MDD=$${r.mdd.toFixed(2)} (${r.trades}t)`);

  console.log("\nBoth-directions top 10:");
  for (const r of bothTop)
    console.log(`  RSI<${r.cfg.rsiLong}/>${r.cfg.rsiShort} TP=${(r.cfg.tpPct*100).toFixed(1)}% SL=${(r.cfg.slPct*100).toFixed(2)}% ${r.cfg.maxHoldH}h $${r.cfg.margin} mc=${r.cfg.maxConc} => $${r.dolPerDay.toFixed(2)}/d PF=${r.pf.toFixed(2)} WR=${r.wr.toFixed(1)}% MDD=$${r.mdd.toFixed(2)} (${r.trades}t)`);

  // TP/SL analysis
  console.log("\n" + "=".repeat(155));
  console.log("  TP/SL RATIO ANALYSIS (avg $/day for profitable configs, MDD < $20)");
  console.log("=".repeat(155));

  const tpslMap = new Map<string, number[]>();
  for (const r of filtered) {
    if (r.dolPerDay <= 0) continue;
    const key = `TP=${(r.cfg.tpPct*100).toFixed(1)}%/SL=${(r.cfg.slPct*100).toFixed(2)}%`;
    if (!tpslMap.has(key)) tpslMap.set(key, []);
    tpslMap.get(key)!.push(r.dolPerDay);
  }
  const tpslStats = [...tpslMap.entries()]
    .map(([k, vals]) => ({ key: k, avg: vals.reduce((a, b) => a + b, 0) / vals.length, count: vals.length }))
    .sort((a, b) => b.avg - a.avg);
  for (const s of tpslStats.slice(0, 15))
    console.log(`  ${s.key.padEnd(22)} avg=+$${s.avg.toFixed(2)}/d  (${s.count} configs)`);

  // RSI threshold analysis
  console.log("\n" + "=".repeat(155));
  console.log("  RSI THRESHOLD ANALYSIS (avg $/day, MDD < $20, profitable only)");
  console.log("=".repeat(155));

  const rsiMap = new Map<string, number[]>();
  for (const r of filtered) {
    if (r.dolPerDay <= 0) continue;
    const key = r.cfg.longOnly ? `LO RSI<${r.cfg.rsiLong}` : `RSI<${r.cfg.rsiLong}/>${r.cfg.rsiShort}`;
    if (!rsiMap.has(key)) rsiMap.set(key, []);
    rsiMap.get(key)!.push(r.dolPerDay);
  }
  const rsiStats = [...rsiMap.entries()]
    .map(([k, vals]) => ({ key: k, avg: vals.reduce((a, b) => a + b, 0) / vals.length, count: vals.length }))
    .sort((a, b) => b.avg - a.avg);
  for (const s of rsiStats)
    console.log(`  ${s.key.padEnd(22)} avg=+$${s.avg.toFixed(2)}/d  (${s.count} configs)`);

  // MaxHold analysis
  console.log("\n" + "=".repeat(155));
  console.log("  MAX HOLD ANALYSIS (avg $/day, MDD < $20, profitable only)");
  console.log("=".repeat(155));

  const mhMap = new Map<number, number[]>();
  for (const r of filtered) {
    if (r.dolPerDay <= 0) continue;
    if (!mhMap.has(r.cfg.maxHoldH)) mhMap.set(r.cfg.maxHoldH, []);
    mhMap.get(r.cfg.maxHoldH)!.push(r.dolPerDay);
  }
  const mhStats = [...mhMap.entries()]
    .map(([k, vals]) => ({ key: k, avg: vals.reduce((a, b) => a + b, 0) / vals.length, count: vals.length }))
    .sort((a, b) => b.avg - a.avg);
  for (const s of mhStats)
    console.log(`  MaxHold=${s.key}h          avg=+$${s.avg.toFixed(2)}/d  (${s.count} configs)`);

  console.log(`\nTotal runtime: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
