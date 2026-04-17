/**
 * MINIMAL spot-check: one pair (DOGE), one engine (Supertrend 14,1.75 on 4h).
 * Walks 1m bars for every trade and prints full detail so you can manually verify
 * the pullback exit math is correct.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && \
 *      npx tsx scripts/bt-pullback-spot-check.ts
 */
import * as fs from "fs";
import * as path from "path";

// ─── Constants ───────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();

// Pullback config to verify
const PB_DEPTH = 20;   // X: exit when leveraged PnL drops 20% from peak
const PB_MIN_PEAK = 30; // Y: only activate after peak >= 30%

const SPREAD_DOGE = 1.35e-4;

// ─── Data helpers (copied from validation script) ────────────────────
function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) {
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
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// SMA ATR (not Wilder's)
function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c),
    );
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += trs[j];
    atr[i] = s / period;
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period;
      init = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcSupertrend(cs: C[], p: number, m: number): { dir: number[] } {
  const atr = calcATR(cs, p);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  for (let i = p; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let u = hl2 + m * atr[i];
    let l = hl2 - m * atr[i];
    if (i > p) {
      if (!(l > lb[i - 1] || cs[i - 1].c < lb[i - 1])) l = lb[i - 1];
      if (!(u < ub[i - 1] || cs[i - 1].c > ub[i - 1])) u = ub[i - 1];
    }
    ub[i] = u;
    lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i - 1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return { dir: dirs };
}

// ─── Price helpers ───────────────────────────────────────────────────
function entryPx(raw: number, dir: "long" | "short"): number {
  return dir === "long" ? raw * (1 + SPREAD_DOGE) : raw * (1 - SPREAD_DOGE);
}
function exitPx(raw: number, dir: "long" | "short", isSL: boolean): number {
  const slip = isSL ? SPREAD_DOGE * SL_SLIP : SPREAD_DOGE;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long" | "short", ep: number, xp: number, not: number): number {
  return (dir === "long" ? (xp / ep - 1) * not : (ep / xp - 1) * not) - not * FEE * 2;
}

// ─── Load data ───────────────────────────────────────────────────────
console.log("Loading data...");
const doge5m = loadJson(CD_5M, "DOGE");
const btc5m  = loadJson(CD_5M, "BTC");
const doge1m = loadJson(CD_1M, "DOGE");

const dogeH4 = aggregate(doge5m, H4, 40);
const btcDaily = aggregate(btc5m, D, 200);

console.log(`  DOGE 5m: ${doge5m.length} bars`);
console.log(`  DOGE 4h: ${dogeH4.length} bars`);
console.log(`  DOGE 1m: ${doge1m.length} bars`);
console.log(`  BTC daily: ${btcDaily.length} bars`);

// BTC filter
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);
function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t < t) { idx = i; break; }
  }
  if (idx < 0) return false;
  return btcEma20[idx] > btcEma50[idx];
}

// ─── Generate Supertrend signals for DOGE ────────────────────────────
interface Signal {
  dir: "long" | "short";
  entryTime: number;
  rawEntry: number;   // bar open (before spread)
  sl: number;
  exitTime: number;
  rawExit: number;    // engine exit price (before spread)
  exitReason: string;
}

function genSupertrendDoge(): Signal[] {
  const cs = dogeH4;
  const { dir: stDir } = calcSupertrend(cs, 14, 1.75);
  const atr = calcATR(cs, 14);
  const sigs: Signal[] = [];
  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number } | null = null;

  for (let i = 17; i < cs.length; i++) {
    const bar = cs[i];
    const flip = stDir[i - 1] !== stDir[i - 2];

    if (pos) {
      let xp = 0, reason = "";
      if (pos.dir === "long" && bar.l <= pos.sl)     { xp = pos.sl; reason = "sl"; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
      if (!xp && flip)                                 { xp = bar.o; reason = "flip"; }
      if (!xp && (bar.t - pos.et) / H >= 60 * 24)     { xp = bar.c; reason = "mh"; }

      if (xp > 0) {
        if (pos.et >= FULL_START && pos.et < FULL_END) {
          sigs.push({
            dir: pos.dir, entryTime: pos.et, rawEntry: pos.ep,
            sl: pos.sl, exitTime: bar.t, rawExit: xp, exitReason: reason,
          });
        }
        pos = null;
      }
    }

    if (!pos && flip && bar.t >= FULL_START) {
      const dir: "long" | "short" = stDir[i - 1] === 1 ? "long" : "short";
      if (dir === "long" && !btcDailyBullish(bar.t)) continue;
      const prevATR = atr[i - 1];
      if (prevATR <= 0) continue;
      let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
      if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
      else sl = Math.min(sl, bar.o * 1.035);
      pos = { dir, ep: bar.o, et: bar.t, sl };
    }
  }
  return sigs;
}

// ─── Walk 1m bars for each trade ─────────────────────────────────────
function fmt(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

console.log("\nGenerating Supertrend signals for DOGE...");
const signals = genSupertrendDoge();
console.log(`Found ${signals.length} trades.\n`);

const SIZE = 5;
const NOT = SIZE * LEV;

let totalBaselinePnl = 0;
let totalPullbackPnl = 0;
let pullbackExitCount = 0;

console.log("=".repeat(140));
console.log("TRADE-BY-TRADE DETAIL: DOGE Supertrend(14,1.75) | Pullback X=20% Y=30%");
console.log("=".repeat(140));

for (let t = 0; t < signals.length; t++) {
  const sig = signals[t];
  const ep = entryPx(sig.rawEntry, sig.dir);

  // --- Baseline: engine exit with spread/fees ---
  const baseXp = exitPx(sig.rawExit, sig.dir, sig.exitReason === "sl");
  const basePnl = calcPnl(sig.dir, ep, baseXp, NOT);

  // --- Walk 1m bars for pullback ---
  let lo = 0, hi = doge1m.length - 1, startIdx = doge1m.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (doge1m[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; }
    else { lo = mid + 1; }
  }

  let peakLevPct = 0;
  let peakTime = sig.entryTime;
  let peakPrice = sig.rawEntry;
  let pbExitTime = 0;
  let pbExitPrice = 0;
  let pbExitLevPct = 0;
  let pbPnl = 0;
  let pbFired = false;

  for (let i = startIdx; i < doge1m.length; i++) {
    const b = doge1m[i];
    if (b.t > sig.exitTime) break;

    // SL check (same as validation script)
    if (sig.dir === "long" && b.l <= sig.sl) break;
    if (sig.dir === "short" && b.h >= sig.sl) break;

    // Track peak using best intrabar price
    const bestPct = sig.dir === "long"
      ? (b.h / sig.rawEntry - 1) * LEV * 100
      : (sig.rawEntry / b.l - 1) * LEV * 100;
    if (bestPct > peakLevPct) {
      peakLevPct = bestPct;
      peakTime = b.t;
      peakPrice = sig.dir === "long" ? b.h : b.l;
    }

    // Pullback check on bar close
    if (peakLevPct >= PB_MIN_PEAK) {
      const currPct = sig.dir === "long"
        ? (b.c / sig.rawEntry - 1) * LEV * 100
        : (sig.rawEntry / b.c - 1) * LEV * 100;
      if (currPct <= peakLevPct - PB_DEPTH) {
        // Pullback fires
        pbFired = true;
        pbExitTime = b.t;
        pbExitPrice = b.c;
        pbExitLevPct = currPct;
        const xp = exitPx(b.c, sig.dir, false);
        pbPnl = calcPnl(sig.dir, ep, xp, NOT);
        break;
      }
    }
  }

  // If pullback did not fire, use engine exit
  const finalPnl = pbFired ? pbPnl : basePnl;
  const finalReason = pbFired ? "PULLBACK" : sig.exitReason;

  totalBaselinePnl += basePnl;
  totalPullbackPnl += finalPnl;
  if (pbFired) pullbackExitCount++;

  // Print every trade
  console.log(`\n--- Trade #${t + 1} ---`);
  console.log(`  Direction:    ${sig.dir.toUpperCase()}`);
  console.log(`  Entry:        ${fmt(sig.entryTime)} @ $${sig.rawEntry.toFixed(6)} (filled $${ep.toFixed(6)})`);
  console.log(`  SL:           $${sig.sl.toFixed(6)} (${((sig.dir === "long" ? sig.sl / sig.rawEntry - 1 : 1 - sig.sl / sig.rawEntry) * 100).toFixed(2)}% from entry)`);
  console.log(`  Peak lev%:    ${peakLevPct.toFixed(1)}% at ${fmt(peakTime)} @ $${peakPrice.toFixed(6)}`);

  if (pbFired) {
    console.log(`  PULLBACK EXIT: ${fmt(pbExitTime)} @ $${pbExitPrice.toFixed(6)} (lev ${pbExitLevPct.toFixed(1)}%, dropped ${(peakLevPct - pbExitLevPct).toFixed(1)}% from peak)`);
    console.log(`  Pullback P&L:  $${pbPnl.toFixed(4)}`);
  } else {
    console.log(`  Pullback:     did NOT fire (peak ${peakLevPct.toFixed(1)}% < min ${PB_MIN_PEAK}%, or never dropped ${PB_DEPTH}% from peak)`);
  }

  console.log(`  Engine exit:  ${fmt(sig.exitTime)} @ $${sig.rawExit.toFixed(6)} (${sig.exitReason})`);
  console.log(`  Engine P&L:   $${basePnl.toFixed(4)}`);

  if (pbFired) {
    const diff = pbPnl - basePnl;
    console.log(`  Difference:   $${diff.toFixed(4)} (pullback ${diff >= 0 ? "BETTER" : "WORSE"})`);
  }
  console.log(`  Final exit:   ${finalReason} -> P&L $${finalPnl.toFixed(4)}`);
}

// ─── Summary ─────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(140));
console.log("SUMMARY");
console.log("=".repeat(140));
console.log(`Total trades:          ${signals.length}`);
console.log(`Pullback exits fired:  ${pullbackExitCount}`);
console.log(`Baseline total P&L:    $${totalBaselinePnl.toFixed(2)}`);
console.log(`Pullback total P&L:    $${totalPullbackPnl.toFixed(2)}`);
console.log(`Difference:            $${(totalPullbackPnl - totalBaselinePnl).toFixed(2)} (${totalPullbackPnl > totalBaselinePnl ? "pullback BETTER" : totalPullbackPnl < totalBaselinePnl ? "pullback WORSE" : "identical"})`);
console.log(`\nManual verification checklist:`);
console.log(`  1. Check a LONG trade: does peak use bar.h? Does pullback check use bar.c?`);
console.log(`  2. Check a SHORT trade: does peak use bar.l? Does pullback check use bar.c?`);
console.log(`  3. Does SL fire BEFORE pullback when SL is hit first?`);
console.log(`  4. Is the leveraged PnL% = (price move %) * 10?`);
console.log(`  5. Does the pullback fire when peak - current >= 20% (not 20% of peak)?`);
