/**
 * TP + Re-entry Research
 *
 * Tests whether closing at a fixed TP level and re-entering when the trend
 * signal is still active beats holding through reversals.
 *
 * Engines:
 *   A: Daily SMA(30/60) crossover, Donchian 15d close exit, ATR(14)x3 stop (capped 3.5%), 60d max hold, $7 margin
 *   B: 4h Supertrend(14,2) flip, exit on flip, ATR(14)x3 stop (capped 3.5%), 60d max hold, $5 margin
 *
 * Configs tested:
 *   1. Baseline: no TP
 *   2. TP +15% (leveraged) with re-entry next bar if signal still active
 *   3. TP +20% with re-entry
 *   4. TP +30% with re-entry
 *   5. TP +15%, NO re-entry
 *   6. TP +20%, NO re-entry
 *
 * Run: npx tsx scripts/bt-tp-reentry.ts
 */

import * as fs from "fs";
import * as path from "path";

// ============ TYPES ============
interface C { t: number; o: number; h: number; l: number; c: number; }

const CD = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const DAY = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const SL_SLIP = 1.5;

const SZ_A = 7;   // Donchian margin
const SZ_B = 5;   // Supertrend margin
const NOT_A = SZ_A * LEV;
const NOT_B = SZ_B * LEV;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();

const SP: Record<string, number> = {
  XRP: 2.1e-4, DOGE: 2.7e-4, ARB: 5.2e-4, ENA: 5.1e-4,
  UNI: 5.5e-4, APT: 6.4e-4, LINK: 6.9e-4, TRUMP: 7.3e-4,
  WLD: 8e-4, DOT: 9.9e-4, ADA: 11.1e-4, LDO: 11.6e-4, OP: 12.4e-4,
  BTC: 1.0e-4, SOL: 4.0e-4,
};

const PAIRS = ["OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "SOL"];

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }

// ============ DATA LOADING ============
function load5m(pair: string): C[] {
  const fp = path.join(CD, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars5m: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(bucket);
    if (!arr) { arr = []; groups.set(bucket, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts, o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  result.sort((a, b) => a.t - b.t);
  return result;
}

// ============ INDICATORS ============
function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period; init = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

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
      for (let j = 1; j <= period; j++)
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function donchCloseLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c);
  return mn;
}
function donchCloseHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c);
  return mx;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];
    if (i > atrPeriod) {
      if (!(lowerBand > lb[i - 1] || cs[i - 1].c < lb[i - 1])) lowerBand = lb[i - 1];
      if (!(upperBand < ub[i - 1] || cs[i - 1].c > ub[i - 1])) upperBand = ub[i - 1];
    }
    ub[i] = upperBand; lb[i] = lowerBand;
    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      dirs[i] = dirs[i - 1] === 1
        ? (cs[i].c < lowerBand ? -1 : 1)
        : (cs[i].c > upperBand ? 1 : -1);
    }
    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }
  return { st, dir: dirs };
}

// ============ CONFIG ============
interface Cfg {
  name: string;
  tpPct: number;    // 0 = no TP, e.g. 0.15 = +15% leveraged move
  reEntry: boolean;  // whether to re-enter after TP if signal still active
}

interface TradeResult {
  pair: string;
  engine: string;
  dir: "long" | "short";
  pnl: number;
  reason: string;
  et: number;
  xt: number;
  isReEntry: boolean;
}

interface SimResult {
  trades: TradeResult[];
  tpExits: number;
  reEntries: number;
  reEntryWins: number;
  reEntryLosses: number;
}

// ============ SIMULATION ============
function simulate(cfg: Cfg): SimResult {
  const trades: TradeResult[] = [];
  let tpExits = 0;
  let reEntries = 0;
  let reEntryWins = 0;
  let reEntryLosses = 0;

  // Load BTC daily for filter
  const btcBars5m = raw5m.get("BTC")!;
  const btcD = dailyData.get("BTC")!;
  const btcCloses = btcD.map(c => c.c);
  const btcEma20 = calcEMA(btcCloses, 20);
  const btcEma50 = calcEMA(btcCloses, 50);

  function btcBullish(t: number): boolean {
    let idx = -1;
    for (let i = btcD.length - 1; i >= 0; i--) { if (btcD[i].t <= t) { idx = i; break; } }
    if (idx < 0) return false;
    if (idx >= btcEma20.length || idx >= btcEma50.length) return false;
    return btcEma20[idx] > 0 && btcEma50[idx] > 0 && btcEma20[idx] > btcEma50[idx];
  }

  // ─── Engine A: Daily Donchian SMA(30/60) ───
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < 65) continue;

    const closes = cs.map(c => c.c);
    const sma30 = calcSMA(closes, 30);
    const sma60 = calcSMA(closes, 60);
    const atr = calcATR(cs, 14);
    const sp = getSpread(pair);

    let inPos = false;
    let posEntry = 0, posDir: "long" | "short" = "long", posSl = 0, posTime = 0;
    let isReEntryPos = false;

    // Signal state: is SMA(30) > SMA(60)?
    function smaSignal(idx: number): "long" | "short" | null {
      if (idx < 59 || sma30[idx] === 0 || sma60[idx] === 0) return null;
      if (sma30[idx] > sma60[idx]) return "long";
      if (sma30[idx] < sma60[idx]) return "short";
      return null;
    }

    for (let i = 61; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < FULL_START || bar.t > FULL_END) continue;

      if (inPos) {
        let xp = 0, reason = "", isSL = false;
        const holdDays = Math.round((bar.t - posTime) / DAY);

        // SL check
        if (posDir === "long" && bar.l <= posSl) { xp = posSl; reason = "sl"; isSL = true; }
        else if (posDir === "short" && bar.h >= posSl) { xp = posSl; reason = "sl"; isSL = true; }

        // TP check (leveraged P&L %)
        if (!xp && cfg.tpPct > 0) {
          if (posDir === "long") {
            const tpPrice = posEntry * (1 + cfg.tpPct / LEV);
            if (bar.h >= tpPrice) { xp = tpPrice; reason = "tp"; }
          } else {
            const tpPrice = posEntry * (1 - cfg.tpPct / LEV);
            if (bar.l <= tpPrice) { xp = tpPrice; reason = "tp"; }
          }
        }

        // Donchian channel exit
        if (!xp && i >= 16) {
          if (posDir === "long") {
            const lo = donchCloseLow(cs, i, 15);
            if (bar.c < lo) { xp = bar.c; reason = "channel"; }
          } else {
            const hi = donchCloseHigh(cs, i, 15);
            if (bar.c > hi) { xp = bar.c; reason = "channel"; }
          }
        }

        // Max hold
        if (!xp && holdDays >= 60) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          const adjEntry = posDir === "long" ? posEntry * (1 + sp) : posEntry * (1 - sp);
          const slipMult = isSL ? SL_SLIP : 1;
          const adjExit = posDir === "long" ? xp * (1 - sp * slipMult) : xp * (1 + sp * slipMult);
          const pnlRaw = posDir === "long"
            ? (adjExit / adjEntry - 1) * NOT_A
            : (adjEntry / adjExit - 1) * NOT_A;
          const pnl = pnlRaw - NOT_A * FEE * 2;

          if (reason === "tp") tpExits++;
          if (isReEntryPos) {
            if (pnl > 0) reEntryWins++;
            else reEntryLosses++;
          }

          trades.push({ pair, engine: "Donchian", dir: posDir, pnl, reason, et: posTime, xt: bar.t, isReEntry: isReEntryPos });
          inPos = false;

          // Re-entry: if TP exit and re-entry enabled, check if signal still active
          if (reason === "tp" && cfg.reEntry) {
            const currentSig = smaSignal(i - 1); // use previous bar's SMA (no look-ahead)
            if (currentSig === posDir) {
              // BTC filter for longs
              if (currentSig === "long" && !btcBullish(bar.t)) { /* skip */ }
              else {
                // Re-enter at next day's open
                if (i + 1 < cs.length) {
                  const nextBar = cs[i + 1];
                  const reEntry = nextBar.o;
                  const prevATR = atr[i];
                  if (prevATR > 0) {
                    let reSl = currentSig === "long" ? reEntry - 3 * prevATR : reEntry + 3 * prevATR;
                    if (currentSig === "long") reSl = Math.max(reSl, reEntry * 0.965);
                    else reSl = Math.min(reSl, reEntry * 1.035);
                    posEntry = reEntry; posDir = currentSig; posSl = reSl;
                    posTime = nextBar.t; inPos = true; isReEntryPos = true;
                    reEntries++;
                    continue;
                  }
                }
              }
            }
          }
        }
      }

      if (!inPos) {
        isReEntryPos = false;
        const prev = i - 1;
        if (sma30[prev] === 0 || sma60[prev] === 0 || sma30[prev - 1] === 0 || sma60[prev - 1] === 0) continue;
        let dir: "long" | "short" | null = null;
        // Cross detection: use bar i-2 vs i-1 (no look-ahead, enter at bar i open)
        if (sma30[prev - 1] <= sma60[prev - 1] && sma30[prev] > sma60[prev]) dir = "long";
        else if (sma30[prev - 1] >= sma60[prev - 1] && sma30[prev] < sma60[prev]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btcBullish(bar.t)) continue;

        const prevATR = atr[prev];
        if (prevATR <= 0) continue;

        posEntry = bar.o; posDir = dir;
        posSl = dir === "long" ? posEntry - 3 * prevATR : posEntry + 3 * prevATR;
        if (dir === "long") posSl = Math.max(posSl, posEntry * 0.965);
        else posSl = Math.min(posSl, posEntry * 1.035);
        posTime = bar.t; inPos = true;
      }
    }
  }

  // ─── Engine B: 4h Supertrend(14, 2) ───
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < 50) continue;

    const { dir: stDir } = calcSupertrend(cs, 14, 2);
    const atr = calcATR(cs, 14);
    const sp = getSpread(pair);

    let inPos = false;
    let posEntry = 0, posDir: "long" | "short" = "long", posSl = 0, posTime = 0;
    let isReEntryPos = false;

    for (let i = 17; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < FULL_START || bar.t > FULL_END) continue;

      // Signal: flip on bar i-1 vs i-2 (enter at bar i open)
      const flip = stDir[i - 1] !== stDir[i - 2] && stDir[i - 2] !== 0 && stDir[i - 1] !== 0;

      if (inPos) {
        let xp = 0, reason = "", isSL = false;

        // SL
        if (posDir === "long" && bar.l <= posSl) { xp = posSl; reason = "sl"; isSL = true; }
        else if (posDir === "short" && bar.h >= posSl) { xp = posSl; reason = "sl"; isSL = true; }

        // TP check (leveraged P&L %)
        if (!xp && cfg.tpPct > 0) {
          if (posDir === "long") {
            const tpPrice = posEntry * (1 + cfg.tpPct / LEV);
            if (bar.h >= tpPrice) { xp = tpPrice; reason = "tp"; }
          } else {
            const tpPrice = posEntry * (1 - cfg.tpPct / LEV);
            if (bar.l <= tpPrice) { xp = tpPrice; reason = "tp"; }
          }
        }

        // Supertrend flip exit
        if (!xp && flip) {
          const newDir = stDir[i - 1] === 1 ? "long" : "short";
          if (newDir !== posDir) { xp = bar.o; reason = "flip"; }
        }

        // Max hold 60d
        if (!xp && (bar.t - posTime) >= 60 * DAY) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          const adjEntry = posDir === "long" ? posEntry * (1 + sp) : posEntry * (1 - sp);
          const slipMult = isSL ? SL_SLIP : 1;
          const adjExit = posDir === "long" ? xp * (1 - sp * slipMult) : xp * (1 + sp * slipMult);
          const pnlRaw = posDir === "long"
            ? (adjExit / adjEntry - 1) * NOT_B
            : (adjEntry / adjExit - 1) * NOT_B;
          const pnl = pnlRaw - NOT_B * FEE * 2;

          if (reason === "tp") tpExits++;
          if (isReEntryPos) {
            if (pnl > 0) reEntryWins++;
            else reEntryLosses++;
          }

          trades.push({ pair, engine: "Supertrend", dir: posDir, pnl, reason, et: posTime, xt: bar.t, isReEntry: isReEntryPos });
          inPos = false;

          // Re-entry: if TP exit, check if supertrend direction matches
          if (reason === "tp" && cfg.reEntry) {
            const currentStDir = stDir[i - 1]; // bar i-1 direction
            const stillInTrend =
              (posDir === "long" && currentStDir === 1) ||
              (posDir === "short" && currentStDir === -1);
            if (stillInTrend) {
              if (posDir === "long" && !btcBullish(bar.t)) { /* skip */ }
              else {
                // Re-enter at next 4h bar open
                if (i + 1 < cs.length) {
                  const nextBar = cs[i + 1];
                  const reEntry = nextBar.o;
                  const prevATR = atr[i];
                  if (prevATR > 0) {
                    let reSl = posDir === "long" ? reEntry - 3 * prevATR : reEntry + 3 * prevATR;
                    if (posDir === "long") reSl = Math.max(reSl, reEntry * 0.965);
                    else reSl = Math.min(reSl, reEntry * 1.035);
                    posEntry = reEntry; posSl = reSl;
                    posTime = nextBar.t; inPos = true; isReEntryPos = true;
                    reEntries++;
                    continue;
                  }
                }
              }
            }
          }

          // If flip caused exit, immediately enter opposite direction
          if (reason === "flip" && !inPos) {
            const newDir: "long" | "short" = stDir[i - 1] === 1 ? "long" : "short";
            if (newDir === "long" && !btcBullish(bar.t)) continue;
            const prevATR = atr[i - 1];
            if (prevATR <= 0) continue;
            posEntry = bar.o; posDir = newDir;
            posSl = newDir === "long" ? posEntry - 3 * prevATR : posEntry + 3 * prevATR;
            if (newDir === "long") posSl = Math.max(posSl, posEntry * 0.965);
            else posSl = Math.min(posSl, posEntry * 1.035);
            posTime = bar.t; inPos = true; isReEntryPos = false;
          }
        }
      }

      if (!inPos && flip && bar.t >= FULL_START) {
        isReEntryPos = false;
        const dir: "long" | "short" = stDir[i - 1] === 1 ? "long" : "short";
        if (dir === "long" && !btcBullish(bar.t)) continue;
        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        posEntry = bar.o; posDir = dir;
        posSl = dir === "long" ? posEntry - 3 * prevATR : posEntry + 3 * prevATR;
        if (dir === "long") posSl = Math.max(posSl, posEntry * 0.965);
        else posSl = Math.min(posSl, posEntry * 1.035);
        posTime = bar.t; inPos = true;
      }
    }
  }

  trades.sort((a, b) => a.xt - b.xt);
  return { trades, tpExits, reEntries, reEntryWins, reEntryLosses };
}

// ============ LOAD DATA ============
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = load5m(p);
  if (d.length > 0) raw5m.set(p, d);
  else console.log(`  WARN: no data for ${p}`);
}

console.log("Aggregating to daily + 4h...");
const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, DAY, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
}

console.log(`Loaded ${PAIRS.length} pairs, daily bars: ${dailyData.get("BTC")?.length ?? 0}, 4h bars: ${h4Data.get("BTC")?.length ?? 0}\n`);

// ============ CONFIGS ============
const configs: Cfg[] = [
  { name: "1. Baseline (no TP)",      tpPct: 0,    reEntry: false },
  { name: "2. TP +15% + re-entry",    tpPct: 0.15, reEntry: true  },
  { name: "3. TP +20% + re-entry",    tpPct: 0.20, reEntry: true  },
  { name: "4. TP +30% + re-entry",    tpPct: 0.30, reEntry: true  },
  { name: "5. TP +15% NO re-entry",   tpPct: 0.15, reEntry: false },
  { name: "6. TP +20% NO re-entry",   tpPct: 0.20, reEntry: false },
];

const days = (FULL_END - FULL_START) / DAY;

// ============ RUN ============
console.log("=".repeat(120));
console.log("TP + RE-ENTRY RESEARCH: Does closing at TP and re-entering beat holding?");
console.log(`Period: 2023-01 to 2026-03 (${days.toFixed(0)} days), ${PAIRS.length} pairs`);
console.log(`Donchian: SMA(30/60), 15d channel exit, ATR(14)x3 stop (cap 3.5%), $7 margin, 10x`);
console.log(`Supertrend: (14,2) flip, ATR(14)x3 stop (cap 3.5%), $5 margin, 10x`);
console.log("=".repeat(120));

interface Summary {
  cfg: Cfg;
  res: SimResult;
  totalPnl: number;
  perDay: number;
  maxDD: number;
  wr: number;
  pf: number;
}

const summaries: Summary[] = [];

for (const cfg of configs) {
  process.stdout.write(`Running ${cfg.name}...`);
  const res = simulate(cfg);
  const totalPnl = res.trades.reduce((s, t) => s + t.pnl, 0);
  const wins = res.trades.filter(t => t.pnl > 0).length;
  const grossWin = res.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(res.trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));

  let cum = 0, pk = 0, maxDD = 0;
  for (const t of res.trades) {
    cum += t.pnl;
    if (cum > pk) pk = cum;
    if (pk - cum > maxDD) maxDD = pk - cum;
  }

  summaries.push({
    cfg, res, totalPnl,
    perDay: totalPnl / days,
    maxDD,
    wr: res.trades.length > 0 ? wins / res.trades.length * 100 : 0,
    pf: grossLoss > 0 ? grossWin / grossLoss : 0,
  });
  console.log(` ${res.trades.length} trades, $${totalPnl.toFixed(0)}`);
}

// ============ SUMMARY TABLE ============
console.log("\n" + "=".repeat(130));
console.log("RESULTS SUMMARY");
console.log("=".repeat(130));
console.log(
  "Config".padEnd(28) +
  "Trades".padStart(7) +
  "WR%".padStart(7) +
  "PF".padStart(7) +
  "TotalPnL".padStart(11) +
  "$/day".padStart(8) +
  "MaxDD".padStart(9) +
  "TP-exits".padStart(10) +
  "Re-entries".padStart(12) +
  "RE-wins".padStart(9) +
  "RE-losses".padStart(11)
);
console.log("-".repeat(130));

for (const s of summaries) {
  const pnlStr = s.totalPnl >= 0 ? `+$${s.totalPnl.toFixed(0)}` : `-$${Math.abs(s.totalPnl).toFixed(0)}`;
  console.log(
    s.cfg.name.padEnd(28) +
    String(s.res.trades.length).padStart(7) +
    s.wr.toFixed(1).padStart(7) +
    s.pf.toFixed(2).padStart(7) +
    pnlStr.padStart(11) +
    `$${s.perDay.toFixed(2)}`.padStart(8) +
    `$${s.maxDD.toFixed(0)}`.padStart(9) +
    String(s.res.tpExits).padStart(10) +
    String(s.res.reEntries).padStart(12) +
    String(s.res.reEntryWins).padStart(9) +
    String(s.res.reEntryLosses).padStart(11)
  );
}

// ============ BY ENGINE ============
for (const eng of ["Donchian", "Supertrend"]) {
  console.log(`\n--- ${eng} ENGINE ONLY ---`);
  console.log(
    "Config".padEnd(28) +
    "Trades".padStart(7) +
    "WR%".padStart(7) +
    "PF".padStart(7) +
    "TotalPnL".padStart(11) +
    "$/day".padStart(8) +
    "MaxDD".padStart(9) +
    "TP-exits".padStart(10)
  );
  console.log("-".repeat(87));
  for (const s of summaries) {
    const et = s.res.trades.filter(t => t.engine === eng);
    const pnl = et.reduce((a, t) => a + t.pnl, 0);
    const w = et.filter(t => t.pnl > 0).length;
    const gw = et.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const gl = Math.abs(et.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
    let cum = 0, pk2 = 0, dd = 0;
    for (const t of et) { cum += t.pnl; if (cum > pk2) pk2 = cum; if (pk2 - cum > dd) dd = pk2 - cum; }
    const tpCount = et.filter(t => t.reason === "tp").length;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
    console.log(
      s.cfg.name.padEnd(28) +
      String(et.length).padStart(7) +
      (et.length > 0 ? (w / et.length * 100).toFixed(1) : "0.0").padStart(7) +
      (gl > 0 ? (gw / gl).toFixed(2) : "0.00").padStart(7) +
      pnlStr.padStart(11) +
      `$${(pnl / days).toFixed(2)}`.padStart(8) +
      `$${dd.toFixed(0)}`.padStart(9) +
      String(tpCount).padStart(10)
    );
  }
}

// ============ RE-ENTRY DETAIL ============
console.log("\n" + "=".repeat(100));
console.log("RE-ENTRY ANALYSIS: How do re-entries perform?");
console.log("=".repeat(100));

for (const s of summaries) {
  if (!s.cfg.reEntry) continue;
  const reTrades = s.res.trades.filter(t => t.isReEntry);
  if (reTrades.length === 0) continue;
  const rePnl = reTrades.reduce((a, t) => a + t.pnl, 0);
  const reWins = reTrades.filter(t => t.pnl > 0).length;
  const avgWin = reTrades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0) / Math.max(reWins, 1);
  const reLosses = reTrades.filter(t => t.pnl <= 0).length;
  const avgLoss = reLosses > 0 ? reTrades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0) / reLosses : 0;

  console.log(`\n${s.cfg.name}:`);
  console.log(`  Re-entry trades: ${reTrades.length}`);
  console.log(`  Re-entry P&L:    $${rePnl.toFixed(2)} ($${(rePnl / days).toFixed(3)}/day)`);
  console.log(`  Re-entry WR:     ${(reWins / reTrades.length * 100).toFixed(1)}% (${reWins}W / ${reLosses}L)`);
  console.log(`  Avg win:         $${avgWin.toFixed(2)}, Avg loss: $${avgLoss.toFixed(2)}`);

  // Compare: TP+re-entry vs TP without re-entry (the difference IS the re-entry value)
  const noReConfig = summaries.find(x => x.cfg.tpPct === s.cfg.tpPct && !x.cfg.reEntry);
  if (noReConfig) {
    const delta = s.totalPnl - noReConfig.totalPnl;
    console.log(`  Value of re-entry: $${delta.toFixed(2)} ($${(delta / days).toFixed(3)}/day) vs no-reentry`);
  }

  // By engine
  for (const eng of ["Donchian", "Supertrend"]) {
    const engRe = reTrades.filter(t => t.engine === eng);
    if (engRe.length === 0) continue;
    const engPnl = engRe.reduce((a, t) => a + t.pnl, 0);
    const engW = engRe.filter(t => t.pnl > 0).length;
    console.log(`  ${eng}: ${engRe.length} re-entries, $${engPnl.toFixed(2)}, WR ${(engW / engRe.length * 100).toFixed(0)}%`);
  }
}

// ============ EXIT REASON DISTRIBUTION ============
console.log("\n" + "=".repeat(100));
console.log("EXIT REASON DISTRIBUTION");
console.log("=".repeat(100));

for (const s of summaries) {
  const reasons = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const t of s.res.trades) {
    const r = reasons.get(t.reason) ?? { count: 0, pnl: 0, wins: 0 };
    r.count++; r.pnl += t.pnl; if (t.pnl > 0) r.wins++;
    reasons.set(t.reason, r);
  }
  console.log(`\n${s.cfg.name}:`);
  for (const [reason, r] of [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
    console.log(`  ${reason.padEnd(12)} ${String(r.count).padStart(5)} trades  WR ${(r.wins / r.count * 100).toFixed(0).padStart(3)}%  P&L ${pnlStr.padStart(7)}`);
  }
}

// ============ DELTA VS BASELINE ============
console.log("\n" + "=".repeat(80));
console.log("DELTA vs BASELINE (no TP)");
console.log("=".repeat(80));

const baseline = summaries[0];
console.log(
  "Config".padEnd(28) +
  "dPnL".padStart(10) +
  "d$/day".padStart(9) +
  "dMaxDD".padStart(9) +
  "dWR".padStart(8) +
  "dPF".padStart(8)
);
console.log("-".repeat(72));
for (const s of summaries.slice(1)) {
  const dp = s.totalPnl - baseline.totalPnl;
  const dpd = s.perDay - baseline.perDay;
  const ddd = s.maxDD - baseline.maxDD;
  const dwr = s.wr - baseline.wr;
  const dpf = s.pf - baseline.pf;
  const dpStr = dp >= 0 ? `+$${dp.toFixed(0)}` : `-$${Math.abs(dp).toFixed(0)}`;
  const dpdStr = dpd >= 0 ? `+$${dpd.toFixed(2)}` : `-$${Math.abs(dpd).toFixed(2)}`;
  const dddStr = ddd <= 0 ? `-$${Math.abs(ddd).toFixed(0)}` : `+$${ddd.toFixed(0)}`;
  console.log(
    s.cfg.name.padEnd(28) +
    dpStr.padStart(10) +
    dpdStr.padStart(9) +
    dddStr.padStart(9) +
    (dwr >= 0 ? `+${dwr.toFixed(1)}` : `${dwr.toFixed(1)}`).padStart(8) +
    (dpf >= 0 ? `+${dpf.toFixed(2)}` : `${dpf.toFixed(2)}`).padStart(8)
  );
}

// ============ MONTHLY BREAKDOWN (Baseline vs best TP config) ============
console.log("\n" + "=".repeat(90));
console.log("MONTHLY P&L: Baseline vs TP+20%+re-entry");
console.log("=".repeat(90));

const baselineTrades = summaries[0].res.trades;
const tp20reTrades = summaries[2].res.trades; // TP +20% + re-entry

function monthlyPnl(trades: TradeResult[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.xt);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    m.set(key, (m.get(key) || 0) + t.pnl);
  }
  return m;
}

const baseMo = monthlyPnl(baselineTrades);
const tp20Mo = monthlyPnl(tp20reTrades);
const allMonths = new Set([...baseMo.keys(), ...tp20Mo.keys()]);

console.log("Month     Baseline    TP20+RE     Delta");
console.log("-".repeat(50));
for (const m of [...allMonths].sort()) {
  const b = baseMo.get(m) ?? 0;
  const t = tp20Mo.get(m) ?? 0;
  const d = t - b;
  const bStr = b >= 0 ? `+$${b.toFixed(0)}` : `-$${Math.abs(b).toFixed(0)}`;
  const tStr = t >= 0 ? `+$${t.toFixed(0)}` : `-$${Math.abs(t).toFixed(0)}`;
  const dStr = d >= 0 ? `+$${d.toFixed(0)}` : `-$${Math.abs(d).toFixed(0)}`;
  console.log(`${m}   ${bStr.padStart(8)}   ${tStr.padStart(8)}   ${dStr.padStart(8)}`);
}

console.log("\nDone.");
