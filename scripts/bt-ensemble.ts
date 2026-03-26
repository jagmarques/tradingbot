import * as fs from "fs";
import * as path from "path";
import { ATR, EMA, ADX } from "technicalindicators";

// ─── Types ───
interface C { t: number; o: number; h: number; l: number; c: number }
interface Tr { pair: string; dir: "long" | "short"; ep: number; xp: number; et: number; xt: number; pnl: number; strat: string }

// ─── Constants ───
const CD = "/tmp/bt-pair-cache-5m";
const H = 3600000, DAY = 86400000, FEE = 0.00035, LEV = 10;
const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();
const PAIRS = ["ADAUSDT","APTUSDT","ARBUSDT","BTCUSDT","DASHUSDT","DOGEUSDT","DOTUSDT","ENAUSDT","ETHUSDT","LDOUSDT","LINKUSDT","OPUSDT","SOLUSDT","TIAUSDT","TRUMPUSDT","UNIUSDT","WIFUSDT","WLDUSDT","XRPUSDT"];
const TRADE_PAIRS = PAIRS.filter(p => p !== "BTCUSDT");
const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4,
  WLDUSDT: 4e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4,
  LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
  ETHUSDT: 0.8e-4, SOLUSDT: 1.2e-4, TIAUSDT: 3.8e-4
};
const SL_SLIP = 1.5; // extra slippage on SL fills

// ─── Load & aggregate ───
function ld5m(p: string): C[] {
  const f = path.join(CD, p + ".json");
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as any[]).map((b: any) =>
    Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] } : b
  );
}

function agg(bars5m: C[], n: number): C[] {
  const out: C[] = [];
  const interval = n * 5 * 60000;
  let cur: C | null = null;
  for (const b of bars5m) {
    const slot = Math.floor(b.t / interval) * interval;
    if (!cur || cur.t !== slot) {
      if (cur) out.push(cur);
      cur = { t: slot, o: b.o, h: b.h, l: b.l, c: b.c };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function aggDaily(bars5m: C[]): C[] { return agg(bars5m, 288); } // 288 * 5min = 1440min = 1day
function agg4h(bars5m: C[]): C[] { return agg(bars5m, 48); }    // 48 * 5min = 240min = 4h

// ─── Indicator helpers ───
function calcATR(cs: C[], period: number): number[] {
  return ATR.calculate({ period, high: cs.map(c => c.h), low: cs.map(c => c.l), close: cs.map(c => c.c) });
}
function calcEMA(cs: C[], period: number): number[] {
  return EMA.calculate({ period, values: cs.map(c => c.c) });
}
function calcADX(cs: C[], period: number): number[] {
  return ADX.calculate({ close: cs.map(c => c.c), high: cs.map(c => c.h), low: cs.map(c => c.l), period }).map(a => a.adx);
}

function gv(a: number[], barIdx: number, totalBars: number): number | null {
  const x = barIdx - (totalBars - a.length);
  return x >= 0 && x < a.length ? a[x] : null;
}

// Donchian channel: highest high / lowest low over lookback
function donchianHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].h);
  return mx;
}
function donchianLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].l);
  return mn;
}

// Supertrend
function calcSupertrend(cs: C[], period: number, mult: number): { st: number[]; dir: number[] } {
  const atrArr = calcATR(cs, period);
  const stArr = new Array(cs.length).fill(0);
  const dirArr = new Array(cs.length).fill(1); // 1=up (bullish), -1=down (bearish)
  let upperBand = 0, lowerBand = 0;

  for (let i = 0; i < cs.length; i++) {
    const atrIdx = i - (cs.length - atrArr.length);
    if (atrIdx < 0) { stArr[i] = cs[i].c; continue; }
    const atr = atrArr[atrIdx];
    const mid = (cs[i].h + cs[i].l) / 2;
    let ub = mid + mult * atr;
    let lb = mid - mult * atr;

    if (i > 0) {
      // Lower band only rises
      if (lb > lowerBand || cs[i - 1].c < lowerBand) { /* keep lb */ } else lb = lowerBand;
      // Upper band only falls
      if (ub < upperBand || cs[i - 1].c > upperBand) { /* keep ub */ } else ub = upperBand;
    }

    if (i === 0) {
      dirArr[i] = 1;
    } else if (dirArr[i - 1] === 1) {
      dirArr[i] = cs[i].c < lb ? -1 : 1;
    } else {
      dirArr[i] = cs[i].c > ub ? 1 : -1;
    }

    stArr[i] = dirArr[i] === 1 ? lb : ub;
    upperBand = ub;
    lowerBand = lb;
  }
  return { st: stArr, dir: dirArr };
}

// Cost: fee + spread + SL slippage
function entryCost(pair: string, dir: "long" | "short", price: number): number {
  const sp = SP[pair] ?? 4e-4;
  return dir === "long" ? price * (1 + sp) : price * (1 - sp);
}
function exitCost(pair: string, dir: "long" | "short", price: number, isSL: boolean): number {
  const sp = SP[pair] ?? 4e-4;
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? price * (1 - slip) : price * (1 + slip);
}
function tradePnl(dir: "long" | "short", ep: number, xp: number, sz: number): number {
  const raw = dir === "long" ? (xp / ep - 1) * sz * LEV : (ep / xp - 1) * sz * LEV;
  return raw - sz * LEV * FEE * 2;
}

// ─── Data loading ───
console.log("Loading 5m data for", PAIRS.length, "pairs...");
const raw5m = new Map<string, C[]>();
for (const p of PAIRS) {
  const d = ld5m(p);
  if (d.length > 0) raw5m.set(p, d);
  else console.log("  MISSING:", p);
}

// Build aggregated data
const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggDaily(bars));
  h4Data.set(p, agg4h(bars));
}

// BTC daily EMA for filter (9/21)
const btcDaily = dailyData.get("BTCUSDT")!;
const btcEma9 = calcEMA(btcDaily, 9);
const btcEma21 = calcEMA(btcDaily, 21);
function btcFilter(t: number): "long" | "short" | null {
  // Find the last completed daily bar before t
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t < t) { idx = i; break; }
  }
  if (idx < 0) return null;
  const e9 = gv(btcEma9, idx, btcDaily.length);
  const e21 = gv(btcEma21, idx, btcDaily.length);
  if (e9 === null || e21 === null) return null;
  return e9 > e21 ? "long" : "short";
}

// ─────────────────────────────────────────────────
// Strategy A: Daily Donchian Breakout
// 30d lookback, 15d exit channel, ATR*3 SL, BTC filter, ATR trailing stop
// ─────────────────────────────────────────────────
function stratA(sz: number): Tr[] {
  const trades: Tr[] = [];
  const DON_LB = 30, DON_EX = 15;

  for (const pair of TRADE_PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < DON_LB + 20) continue;
    const atrArr = calcATR(cs, 14);

    interface Pos { dir: "long" | "short"; ep: number; et: number; sl: number; trail: number; pk: number }
    let pos: Pos | null = null;

    for (let i = DON_LB + 1; i < cs.length; i++) {
      if (cs[i].t < OOS_START || cs[i].t >= OOS_END) continue;
      const atr = gv(atrArr, i - 1, cs.length);
      if (!atr || atr <= 0) continue;

      // Check exits
      if (pos) {
        const b = cs[i];
        let xp = 0; let isSL = false;
        // SL check
        if (pos.dir === "long" && b.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && b.h >= pos.sl) { xp = pos.sl; isSL = true; }
        // Donchian exit channel
        if (!xp) {
          if (pos.dir === "long" && b.c < donchianLow(cs, i, DON_EX)) xp = b.c;
          else if (pos.dir === "short" && b.c > donchianHigh(cs, i, DON_EX)) xp = b.c;
        }
        // ATR trailing stop update
        if (!xp && pos.dir === "long") {
          const newTrail = b.c - atr * 3;
          if (newTrail > pos.trail) pos.trail = newTrail;
          if (b.l <= pos.trail) { xp = pos.trail; isSL = true; }
        }
        if (!xp && pos.dir === "short") {
          const newTrail = b.c + atr * 3;
          if (newTrail < pos.trail) pos.trail = newTrail;
          if (b.h >= pos.trail) { xp = pos.trail; isSL = true; }
        }
        // Max hold 30 days
        if (!xp && cs[i].t - pos.et >= 30 * DAY) xp = b.c;

        if (xp) {
          const xpAdj = exitCost(pair, pos.dir, xp, isSL);
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: cs[i].t, pnl: tradePnl(pos.dir, pos.ep, xpAdj, sz), strat: "A" });
          pos = null;
        }
      }

      // Check entries (no position)
      if (!pos) {
        const btcDir = btcFilter(cs[i].t);
        // Use current bar high/low for intrabar breakout, channel from bars before current
        const donHi = donchianHigh(cs, i, DON_LB);
        const donLo = donchianLow(cs, i, DON_LB);

        if (cs[i].h > donHi && (btcDir === "long" || btcDir === null)) {
          const ep = entryCost(pair, "long", Math.max(cs[i].o, donHi));
          pos = { dir: "long", ep, et: cs[i].t, sl: ep - atr * 3, trail: ep - atr * 3, pk: ep };
        } else if (cs[i].l < donLo && (btcDir === "short" || btcDir === null)) {
          const ep = entryCost(pair, "short", Math.min(cs[i].o, donLo));
          pos = { dir: "short", ep, et: cs[i].t, sl: ep + atr * 3, trail: ep + atr * 3, pk: ep };
        }
      }
    }
  }
  return trades;
}

// ─────────────────────────────────────────────────
// Strategy B: 4h EMA Trend Follow
// 9/21 EMA cross, ADX>15, ATR*2.5 initial SL + ATR*2 trailing
// ─────────────────────────────────────────────────
function stratB(sz: number): Tr[] {
  const trades: Tr[] = [];

  for (const pair of TRADE_PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < 50) continue;
    const ema9 = calcEMA(cs, 9);
    const ema21 = calcEMA(cs, 21);
    const adxArr = calcADX(cs, 14);
    const atrArr = calcATR(cs, 14);

    interface Pos { dir: "long" | "short"; ep: number; et: number; sl: number; trail: number }
    let pos: Pos | null = null;
    let prevCrossLong = false, prevCrossShort = false;

    for (let i = 23; i < cs.length; i++) {
      if (cs[i].t < OOS_START || cs[i].t >= OOS_END) continue;
      // Use bar i-1 for signal (completed bar), enter at bar i open (no look-ahead)
      const e9 = gv(ema9, i - 1, cs.length);
      const e21v = gv(ema21, i - 1, cs.length);
      const e9p = gv(ema9, i - 2, cs.length);
      const e21p = gv(ema21, i - 2, cs.length);
      const adx = gv(adxArr, i - 1, cs.length);
      const atr = gv(atrArr, i - 1, cs.length);
      if (!e9 || !e21v || !e9p || !e21p || !adx || !atr) continue;

      const crossLong = e9 > e21v && e9p <= e21p;
      const crossShort = e9 < e21v && e9p >= e21p;

      // Exits
      if (pos) {
        const b = cs[i];
        let xp = 0; let isSL = false;
        // SL
        if (pos.dir === "long" && b.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && b.h >= pos.sl) { xp = pos.sl; isSL = true; }
        // ATR trailing update
        if (!xp && pos.dir === "long") {
          const newTrail = b.c - atr * 2;
          if (newTrail > pos.trail) pos.trail = newTrail;
          if (b.l <= pos.trail) { xp = pos.trail; isSL = true; }
        }
        if (!xp && pos.dir === "short") {
          const newTrail = b.c + atr * 2;
          if (newTrail < pos.trail) pos.trail = newTrail;
          if (b.h >= pos.trail) { xp = pos.trail; isSL = true; }
        }
        // Signal flip exit (using i-1 completed bar EMA values)
        if (!xp && ((pos.dir === "long" && e9 < e21v) || (pos.dir === "short" && e9 > e21v))) xp = cs[i].o;
        // Max hold 5 days
        if (!xp && cs[i].t - pos.et >= 5 * DAY) xp = b.c;

        if (xp) {
          const xpAdj = exitCost(pair, pos.dir, xp, isSL);
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: cs[i].t, pnl: tradePnl(pos.dir, pos.ep, xpAdj, sz), strat: "B" });
          pos = null;
        }
      }

      // Entries
      if (!pos && adx > 15) {
        if (crossLong) {
          const ep = entryCost(pair, "long", cs[i].o);
          pos = { dir: "long", ep, et: cs[i].t, sl: ep - atr * 2.5, trail: ep - atr * 2.5 };
        } else if (crossShort) {
          const ep = entryCost(pair, "short", cs[i].o);
          pos = { dir: "short", ep, et: cs[i].t, sl: ep + atr * 2.5, trail: ep + atr * 2.5 };
        }
      }

      prevCrossLong = crossLong;
      prevCrossShort = crossShort;
    }
  }
  return trades;
}

// ─────────────────────────────────────────────────
// Strategy C: Daily Momentum (weekly rebalance)
// 7-day lookback, long top 5, short bottom 5
// ─────────────────────────────────────────────────
function stratC(sz: number): Tr[] {
  const trades: Tr[] = [];
  // Get all daily bars, find weekly rebalance dates
  const allDailyTs = new Set<number>();
  for (const pair of TRADE_PAIRS) {
    const cs = dailyData.get(pair);
    if (cs) for (const b of cs) if (b.t >= OOS_START && b.t < OOS_END) allDailyTs.add(b.t);
  }
  const allDays = [...allDailyTs].sort((a, b) => a - b);

  // Weekly rebalance: every 7 days
  const rebalDays: number[] = [];
  for (let i = 0; i < allDays.length; i += 7) rebalDays.push(allDays[i]);

  interface MomPos { pair: string; dir: "long" | "short"; ep: number; et: number }
  let positions: MomPos[] = [];

  for (let r = 0; r < rebalDays.length; r++) {
    const rebalT = rebalDays[r];
    const nextRebalT = r + 1 < rebalDays.length ? rebalDays[r + 1] : OOS_END;

    // Close all existing positions at rebalance
    for (const pos of positions) {
      const cs = dailyData.get(pos.pair);
      if (!cs) continue;
      // Find close price at rebalance day
      let xp = 0;
      for (const b of cs) { if (b.t === rebalT) { xp = b.o; break; } }
      if (xp === 0) {
        // Use last available
        for (let i = cs.length - 1; i >= 0; i--) {
          if (cs[i].t <= rebalT) { xp = cs[i].c; break; }
        }
      }
      if (xp > 0) {
        const xpAdj = exitCost(pos.pair, pos.dir, xp, false);
        trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: rebalT, pnl: tradePnl(pos.dir, pos.ep, xpAdj, sz), strat: "C" });
      }
    }
    positions = [];

    // Compute 7-day returns for each pair
    const returns: { pair: string; ret: number }[] = [];
    for (const pair of TRADE_PAIRS) {
      const cs = dailyData.get(pair);
      if (!cs) continue;
      let idxNow = -1;
      for (let i = cs.length - 1; i >= 0; i--) { if (cs[i].t <= rebalT) { idxNow = i; break; } }
      if (idxNow < 7) continue;
      const ret = cs[idxNow].c / cs[idxNow - 7].c - 1;
      returns.push({ pair, ret });
    }

    returns.sort((a, b) => b.ret - a.ret);
    const top5 = returns.slice(0, 5);
    const bot5 = returns.slice(-5);

    // Open long top 5
    for (const { pair } of top5) {
      const cs = dailyData.get(pair);
      if (!cs) continue;
      let openPrice = 0;
      for (const b of cs) { if (b.t === rebalT) { openPrice = b.o; break; } }
      if (!openPrice) {
        for (let i = cs.length - 1; i >= 0; i--) { if (cs[i].t <= rebalT) { openPrice = cs[i].c; break; } }
      }
      if (openPrice > 0) {
        const ep = entryCost(pair, "long", openPrice);
        positions.push({ pair, dir: "long", ep, et: rebalT });
      }
    }

    // Open short bottom 5
    for (const { pair } of bot5) {
      const cs = dailyData.get(pair);
      if (!cs) continue;
      let openPrice = 0;
      for (const b of cs) { if (b.t === rebalT) { openPrice = b.o; break; } }
      if (!openPrice) {
        for (let i = cs.length - 1; i >= 0; i--) { if (cs[i].t <= rebalT) { openPrice = cs[i].c; break; } }
      }
      if (openPrice > 0) {
        const ep = entryCost(pair, "short", openPrice);
        positions.push({ pair, dir: "short", ep, et: rebalT });
      }
    }
  }

  // Close remaining positions at end
  for (const pos of positions) {
    const cs = dailyData.get(pos.pair);
    if (!cs) continue;
    const lastBar = cs[cs.length - 1];
    const xpAdj = exitCost(pos.pair, pos.dir, lastBar.c, false);
    trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: lastBar.t, pnl: tradePnl(pos.dir, pos.ep, xpAdj, sz), strat: "C" });
  }
  return trades;
}

// ─────────────────────────────────────────────────
// Strategy D: 4h Supertrend
// Period 10, multiplier 3. Long when price > supertrend, short when below, exit on flip.
// ─────────────────────────────────────────────────
function stratD(sz: number): Tr[] {
  const trades: Tr[] = [];

  for (const pair of TRADE_PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < 30) continue;
    const { st, dir: stDir } = calcSupertrend(cs, 10, 3);

    interface Pos { dir: "long" | "short"; ep: number; et: number }
    let pos: Pos | null = null;

    for (let i = 16; i < cs.length; i++) {
      if (cs[i].t < OOS_START || cs[i].t >= OOS_END) continue;

      // Use PREVIOUS bar's completed direction (no look-ahead)
      // Flip detected on bar i-1: stDir[i-1] != stDir[i-2]
      // We act on bar i's open
      const prevDir2 = stDir[i - 2];
      const prevDir1 = stDir[i - 1];
      const flip = prevDir1 !== prevDir2;

      // Exit on flip
      if (pos && flip) {
        const xpAdj = exitCost(pair, pos.dir, cs[i].o, false);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: cs[i].t, pnl: tradePnl(pos.dir, pos.ep, xpAdj, sz), strat: "D" });
        pos = null;
      }

      // Enter on flip (prevDir1 is the new confirmed direction)
      if (!pos && flip) {
        const dir: "long" | "short" = prevDir1 === 1 ? "long" : "short";
        const ep = entryCost(pair, dir, cs[i].o);
        pos = { dir, ep, et: cs[i].t };
      }
    }

    // Close remaining
    if (pos) {
      const lastBar = cs[cs.length - 1];
      const xpAdj = exitCost(pair, pos.dir, lastBar.c, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: lastBar.t, pnl: tradePnl(pos.dir, pos.ep, xpAdj, sz), strat: "D" });
    }
  }
  return trades;
}

// ─── Run all strategies ───
console.log("Running Strategy A (Daily Donchian)...");
const tradesA = stratA(2.5);
console.log("Running Strategy B (4h EMA Trend)...");
const tradesB = stratB(2.5);
console.log("Running Strategy C (Daily Momentum)...");
const tradesC = stratC(2.5);
console.log("Running Strategy D (4h Supertrend)...");
const tradesD = stratD(2.5);

// Also run with full $10 for standalone comparison
const tradesA10 = stratA(10);
const tradesB10 = stratB(10);
const tradesC10 = stratC(10);
const tradesD10 = stratD(10);

// ─── Stats helper ───
function stats(trades: Tr[], label: string, sz?: number) {
  const days = (OOS_END - OOS_START) / DAY;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
  const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // Daily P&L for Sharpe
  const dpMap = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / DAY);
    dpMap.set(day, (dpMap.get(day) || 0) + t.pnl);
  }
  const dpArr = [...dpMap.values()];
  const avgD = dpArr.reduce((s, r) => s + r, 0) / Math.max(dpArr.length, 1);
  const stdD = Math.sqrt(dpArr.reduce((s, r) => s + (r - avgD) ** 2, 0) / Math.max(dpArr.length - 1, 1));
  const sharpe = stdD > 0 ? (avgD / stdD) * Math.sqrt(252) : 0;

  // Max drawdown
  let cum = 0, pk = 0, maxDD = 0;
  for (const t of trades.sort((a, b) => a.xt - b.xt)) {
    cum += t.pnl;
    if (cum > pk) pk = cum;
    if (pk - cum > maxDD) maxDD = pk - cum;
  }

  return { label, trades: trades.length, pnl, wr, pf, sharpe, maxDD, perDay: pnl / days, wins, losses };
}

function printStats(s: ReturnType<typeof stats>) {
  const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(1)}` : `-$${Math.abs(s.pnl).toFixed(1)}`;
  console.log(
    `${s.label.padEnd(28)} ${String(s.trades).padStart(5)}  ${s.wr.toFixed(1).padStart(5)}%  ${pnlStr.padStart(10)}  ${s.pf.toFixed(2).padStart(5)}  ${s.sharpe.toFixed(2).padStart(6)}  $${s.maxDD.toFixed(1).padStart(7)}  $${s.perDay.toFixed(2).padStart(6)}`
  );
}

// ─── Individual strategy results ───
console.log("\n" + "=".repeat(90));
console.log("INDIVIDUAL STRATEGIES (standalone, $10 margin each)");
console.log("=".repeat(90));
console.log(`${"Strategy".padEnd(28)} ${"Trades".padStart(5)}  ${"WR%".padStart(6)}  ${"TotalPnL".padStart(10)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"MaxDD".padStart(8)}  ${"$/day".padStart(7)}`);
console.log("-".repeat(90));
const sA = stats(tradesA10, "A: Daily Donchian");
const sB = stats(tradesB10, "B: 4h EMA Trend");
const sC = stats(tradesC10, "C: Daily Momentum");
const sD = stats(tradesD10, "D: 4h Supertrend");
printStats(sA); printStats(sB); printStats(sC); printStats(sD);

// ─── Daily P&L streams for correlation ───
function dailyPnlStream(trades: Tr[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / DAY);
    m.set(day, (m.get(day) || 0) + t.pnl);
  }
  return m;
}

const dpA = dailyPnlStream(tradesA10);
const dpB = dailyPnlStream(tradesB10);
const dpC = dailyPnlStream(tradesC10);
const dpD = dailyPnlStream(tradesD10);

function pearson(m1: Map<number, number>, m2: Map<number, number>): number {
  const allDays = new Set([...m1.keys(), ...m2.keys()]);
  const v1: number[] = [], v2: number[] = [];
  for (const d of allDays) { v1.push(m1.get(d) || 0); v2.push(m2.get(d) || 0); }
  const n = v1.length;
  if (n < 3) return 0;
  const mean1 = v1.reduce((s, x) => s + x, 0) / n;
  const mean2 = v2.reduce((s, x) => s + x, 0) / n;
  let cov = 0, var1 = 0, var2 = 0;
  for (let i = 0; i < n; i++) {
    const d1 = v1[i] - mean1, d2 = v2[i] - mean2;
    cov += d1 * d2; var1 += d1 * d1; var2 += d2 * d2;
  }
  return var1 > 0 && var2 > 0 ? cov / Math.sqrt(var1 * var2) : 0;
}

console.log("\n" + "=".repeat(60));
console.log("CORRELATION MATRIX (Pearson of daily P&L)");
console.log("=".repeat(60));
const streams = [{ n: "A:Donchian", d: dpA }, { n: "B:EMA", d: dpB }, { n: "C:Momentum", d: dpC }, { n: "D:Supertrend", d: dpD }];
console.log("              " + streams.map(s => s.n.padStart(12)).join(""));
for (const s1 of streams) {
  let row = s1.n.padEnd(14);
  for (const s2 of streams) {
    const r = pearson(s1.d, s2.d);
    row += r.toFixed(3).padStart(12);
  }
  console.log(row);
}

// Find least correlated pairs
const corrPairs: { a: string; b: string; r: number }[] = [];
for (let i = 0; i < streams.length; i++) {
  for (let j = i + 1; j < streams.length; j++) {
    const r = pearson(streams[i].d, streams[j].d);
    corrPairs.push({ a: streams[i].n, b: streams[j].n, r });
  }
}
corrPairs.sort((a, b) => a.r - b.r);
console.log("\nLeast correlated pairs:");
for (const cp of corrPairs) {
  const tag = cp.r < 0.3 ? " <-- DIVERSIFIES WELL" : cp.r < 0.5 ? " (moderate)" : " (high)";
  console.log(`  ${cp.a} vs ${cp.b}: ${cp.r.toFixed(3)}${tag}`);
}

// ═══════════════════════════════════════════════════
// ENSEMBLE 1: Equal Weight
// Each strategy gets $2.50 margin. Combine all trades.
// ═══════════════════════════════════════════════════
console.log("\n" + "=".repeat(90));
console.log("ENSEMBLE 1: EQUAL WEIGHT ($2.50/strategy, 4 strategies)");
console.log("=".repeat(90));
const ens1Trades = [...tradesA, ...tradesB, ...tradesC, ...tradesD];
const sEns1 = stats(ens1Trades, "Equal Weight Ensemble");
console.log(`${"Strategy".padEnd(28)} ${"Trades".padStart(5)}  ${"WR%".padStart(6)}  ${"TotalPnL".padStart(10)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"MaxDD".padStart(8)}  ${"$/day".padStart(7)}`);
console.log("-".repeat(90));
printStats(sEns1);
// Component contributions
console.log("\nComponent contributions ($2.50 each):");
const sA25 = stats(tradesA, "  A: Donchian");
const sB25 = stats(tradesB, "  B: EMA Trend");
const sC25 = stats(tradesC, "  C: Momentum");
const sD25 = stats(tradesD, "  D: Supertrend");
printStats(sA25); printStats(sB25); printStats(sC25); printStats(sD25);

// ═══════════════════════════════════════════════════
// ENSEMBLE 2: Signal Agreement (Voting)
// Only trade when 2+ strategies agree on direction for same pair on same day
// ═══════════════════════════════════════════════════
console.log("\n" + "=".repeat(90));
console.log("ENSEMBLE 2: SIGNAL AGREEMENT (2+ strategies must agree)");
console.log("=".repeat(90));

// For each day and pair, determine what direction each strategy holds
function getHoldings(trades: Tr[], strat: string): Map<string, { dir: "long" | "short"; et: number; xt: number }[]> {
  const m = new Map<string, { dir: "long" | "short"; et: number; xt: number }[]>();
  for (const t of trades) {
    const arr = m.get(t.pair) || [];
    arr.push({ dir: t.dir, et: t.et, xt: t.xt });
    m.set(t.pair, arr);
  }
  return m;
}

function dirOnDay(holdings: Map<string, { dir: "long" | "short"; et: number; xt: number }[]>, pair: string, dayStart: number): "long" | "short" | null {
  const arr = holdings.get(pair);
  if (!arr) return null;
  for (const h of arr) {
    if (h.et <= dayStart && h.xt > dayStart) return h.dir;
  }
  return null;
}

// Build holdings from $10 trades (full size strategies for signal detection)
const holdA = getHoldings(tradesA10, "A");
const holdB = getHoldings(tradesB10, "B");
const holdC = getHoldings(tradesC10, "C");
const holdD = getHoldings(tradesD10, "D");
const allHoldings = [holdA, holdB, holdC, holdD];

const ens2Trades: Tr[] = [];
// Iterate through each day
const dayStart = Math.floor(OOS_START / DAY) * DAY;
const dayEnd = Math.floor(OOS_END / DAY) * DAY;

interface VotePos { pair: string; dir: "long" | "short"; ep: number; et: number }
const votePosMap = new Map<string, VotePos>();

for (let day = dayStart; day <= dayEnd; day += DAY) {
  // Check each pair
  for (const pair of TRADE_PAIRS) {
    const votes = { long: 0, short: 0 };
    for (const hold of allHoldings) {
      const d = dirOnDay(hold, pair, day);
      if (d === "long") votes.long++;
      if (d === "short") votes.short++;
    }

    const existingPos = votePosMap.get(pair);

    // Determine consensus direction (2+ agree)
    let consensusDir: "long" | "short" | null = null;
    if (votes.long >= 2) consensusDir = "long";
    else if (votes.short >= 2) consensusDir = "short";

    // Close if direction changed or no consensus
    if (existingPos && (consensusDir !== existingPos.dir)) {
      // Find exit price: daily open of this day
      const cs = dailyData.get(pair);
      if (cs) {
        let xp = 0;
        for (const b of cs) { if (b.t >= day && b.t < day + DAY) { xp = b.o; break; } }
        if (!xp) {
          for (let i = cs.length - 1; i >= 0; i--) { if (cs[i].t <= day) { xp = cs[i].c; break; } }
        }
        if (xp > 0) {
          const xpAdj = exitCost(pair, existingPos.dir, xp, false);
          ens2Trades.push({ pair, dir: existingPos.dir, ep: existingPos.ep, xp: xpAdj, et: existingPos.et, xt: day, pnl: tradePnl(existingPos.dir, existingPos.ep, xpAdj, 10), strat: "VOTE" });
        }
      }
      votePosMap.delete(pair);
    }

    // Open if consensus and no position
    if (consensusDir && !votePosMap.has(pair)) {
      const cs = dailyData.get(pair);
      if (cs) {
        let openPrice = 0;
        for (const b of cs) { if (b.t >= day && b.t < day + DAY) { openPrice = b.o; break; } }
        if (!openPrice) {
          for (let i = cs.length - 1; i >= 0; i--) { if (cs[i].t <= day) { openPrice = cs[i].c; break; } }
        }
        if (openPrice > 0) {
          const ep = entryCost(pair, consensusDir, openPrice);
          votePosMap.set(pair, { pair, dir: consensusDir, ep, et: day });
        }
      }
    }
  }
}
// Close remaining
for (const [pair, pos] of votePosMap) {
  const cs = dailyData.get(pair);
  if (cs) {
    const xp = cs[cs.length - 1].c;
    const xpAdj = exitCost(pair, pos.dir, xp, false);
    ens2Trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: xpAdj, et: pos.et, xt: cs[cs.length - 1].t, pnl: tradePnl(pos.dir, pos.ep, xpAdj, 10), strat: "VOTE" });
  }
}

const sEns2 = stats(ens2Trades, "Signal Agreement (Vote)");
console.log(`${"Strategy".padEnd(28)} ${"Trades".padStart(5)}  ${"WR%".padStart(6)}  ${"TotalPnL".padStart(10)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"MaxDD".padStart(8)}  ${"$/day".padStart(7)}`);
console.log("-".repeat(90));
printStats(sEns2);

// ═══════════════════════════════════════════════════
// ENSEMBLE 3: Best-Recent Adaptive
// Every 30 days, check which strategies were profitable in last 60 days
// Only allocate to profitable ones
// ═══════════════════════════════════════════════════
console.log("\n" + "=".repeat(90));
console.log("ENSEMBLE 3: BEST-RECENT ADAPTIVE (30d rebalance, 60d lookback)");
console.log("=".repeat(90));

const stratTrades = [
  { name: "A", trades: tradesA10 },
  { name: "B", trades: tradesB10 },
  { name: "C", trades: tradesC10 },
  { name: "D", trades: tradesD10 }
];

// Build 30-day windows
const ens3Trades: Tr[] = [];
const windowSize = 30 * DAY;
const lookback = 60 * DAY;

const adaptiveLog: string[] = [];

for (let windowStart = OOS_START; windowStart < OOS_END; windowStart += windowSize) {
  const windowEnd = Math.min(windowStart + windowSize, OOS_END);
  const lookbackStart = windowStart - lookback;

  // Evaluate each strategy over lookback
  const stratPerf: { name: string; pnl: number; profitable: boolean }[] = [];
  for (const { name, trades } of stratTrades) {
    const lookbackTrades = trades.filter(t => t.xt >= lookbackStart && t.xt < windowStart);
    const pnl = lookbackTrades.reduce((s, t) => s + t.pnl, 0);
    stratPerf.push({ name, pnl, profitable: pnl > 0 });
  }

  const profitableStrats = stratPerf.filter(s => s.profitable);
  const dateStr = new Date(windowStart).toISOString().slice(0, 10);
  const profNames = profitableStrats.length > 0 ? profitableStrats.map(s => s.name).join(",") : "NONE";
  adaptiveLog.push(`${dateStr}: Active=[${profNames}] (${profitableStrats.length}/${stratPerf.length})`);

  if (profitableStrats.length === 0) continue;

  // Equal weight among profitable strategies
  const perStrat = 10 / profitableStrats.length;

  for (const ps of profitableStrats) {
    const src = stratTrades.find(s => s.name === ps.name)!;
    const windowTrades = src.trades.filter(t => t.et >= windowStart && t.et < windowEnd);
    // Rescale PnL for the allocation
    for (const t of windowTrades) {
      const scaledPnl = tradePnl(t.dir, t.ep, t.xp, perStrat);
      ens3Trades.push({ ...t, pnl: scaledPnl, strat: "ADAPT-" + ps.name });
    }
  }
}

const sEns3 = stats(ens3Trades, "Best-Recent Adaptive");
console.log(`${"Strategy".padEnd(28)} ${"Trades".padStart(5)}  ${"WR%".padStart(6)}  ${"TotalPnL".padStart(10)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"MaxDD".padStart(8)}  ${"$/day".padStart(7)}`);
console.log("-".repeat(90));
printStats(sEns3);
console.log("\nAdaptive allocation log:");
for (const l of adaptiveLog) console.log("  " + l);

// ═══════════════════════════════════════════════════
// ENSEMBLE 4: Anti-Correlated Mix
// Combine 2-3 least correlated strategies with inverse-variance weights
// ═══════════════════════════════════════════════════
console.log("\n" + "=".repeat(90));
console.log("ENSEMBLE 4: ANTI-CORRELATED MIX (inverse-variance weighted)");
console.log("=".repeat(90));

// Compute variance of daily P&L for each strategy
function dailyVariance(dp: Map<number, number>): number {
  const vals = [...dp.values()];
  if (vals.length < 2) return 1;
  const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  return vals.reduce((s, x) => s + (x - mean) ** 2, 0) / (vals.length - 1);
}

const variances = [
  { name: "A", var: dailyVariance(dpA), dp: dpA, trades10: tradesA10 },
  { name: "B", var: dailyVariance(dpB), dp: dpB, trades10: tradesB10 },
  { name: "C", var: dailyVariance(dpC), dp: dpC, trades10: tradesC10 },
  { name: "D", var: dailyVariance(dpD), dp: dpD, trades10: tradesD10 }
];

console.log("\nDaily P&L variance per strategy:");
for (const v of variances) {
  console.log(`  ${v.name}: variance=${v.var.toFixed(4)}, stdev=$${Math.sqrt(v.var).toFixed(3)}`);
}

// Find least correlated 2-3 combo
// Try all 2-combos and 3-combos, pick best by lowest average correlation
const combos2: { strats: string[]; avgCorr: number; indices: number[] }[] = [];
for (let i = 0; i < 4; i++) {
  for (let j = i + 1; j < 4; j++) {
    const r = pearson(streams[i].d, streams[j].d);
    combos2.push({ strats: [variances[i].name, variances[j].name], avgCorr: r, indices: [i, j] });
  }
}
combos2.sort((a, b) => a.avgCorr - b.avgCorr);

const combos3: { strats: string[]; avgCorr: number; indices: number[] }[] = [];
for (let i = 0; i < 4; i++) {
  for (let j = i + 1; j < 4; j++) {
    for (let k = j + 1; k < 4; k++) {
      const r1 = pearson(streams[i].d, streams[j].d);
      const r2 = pearson(streams[i].d, streams[k].d);
      const r3 = pearson(streams[j].d, streams[k].d);
      combos3.push({ strats: [variances[i].name, variances[j].name, variances[k].name], avgCorr: (r1 + r2 + r3) / 3, indices: [i, j, k] });
    }
  }
}
combos3.sort((a, b) => a.avgCorr - b.avgCorr);

console.log("\nBest 2-strategy combo (lowest avg correlation):");
console.log(`  ${combos2[0].strats.join(" + ")}, avg corr: ${combos2[0].avgCorr.toFixed(3)}`);
console.log("Best 3-strategy combo (lowest avg correlation):");
console.log(`  ${combos3[0].strats.join(" + ")}, avg corr: ${combos3[0].avgCorr.toFixed(3)}`);

// Build inverse-variance weighted ensemble for best 2 and best 3
function buildInvVarEnsemble(indices: number[], label: string): Tr[] {
  const selected = indices.map(i => variances[i]);
  const invVars = selected.map(s => s.var > 0 ? 1 / s.var : 1);
  const totalInvVar = invVars.reduce((s, x) => s + x, 0);
  const weights = invVars.map(iv => iv / totalInvVar);

  console.log(`\n  ${label} weights:`);
  for (let i = 0; i < selected.length; i++) {
    const alloc = weights[i] * 10;
    console.log(`    ${selected[i].name}: weight=${(weights[i] * 100).toFixed(1)}%, alloc=$${alloc.toFixed(2)}`);
  }

  const ens: Tr[] = [];
  for (let i = 0; i < selected.length; i++) {
    const sz = weights[i] * 10;
    for (const t of selected[i].trades10) {
      const scaledPnl = tradePnl(t.dir, t.ep, t.xp, sz);
      ens.push({ ...t, pnl: scaledPnl, strat: "ANTI-" + selected[i].name });
    }
  }
  return ens;
}

const ens4_2 = buildInvVarEnsemble(combos2[0].indices, "Best-2");
const ens4_3 = buildInvVarEnsemble(combos3[0].indices, "Best-3");

console.log("");
console.log(`${"Strategy".padEnd(28)} ${"Trades".padStart(5)}  ${"WR%".padStart(6)}  ${"TotalPnL".padStart(10)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"MaxDD".padStart(8)}  ${"$/day".padStart(7)}`);
console.log("-".repeat(90));
const sAnti2 = stats(ens4_2, "Anti-Corr Best-2");
const sAnti3 = stats(ens4_3, "Anti-Corr Best-3");
printStats(sAnti2);
printStats(sAnti3);

// ═══════════════════════════════════════════════════
// COMPARISON SUMMARY
// ═══════════════════════════════════════════════════
console.log("\n" + "=".repeat(90));
console.log("FINAL COMPARISON: All Ensembles vs Best Single Strategy");
console.log("=".repeat(90));

const allResults = [sA, sB, sC, sD, sEns1, sEns2, sEns3, sAnti2, sAnti3];
const bestSingle = [sA, sB, sC, sD].sort((a, b) => b.pnl - a.pnl)[0];

console.log(`\nBest single strategy: ${bestSingle.label} ($${bestSingle.pnl.toFixed(1)} total, $${bestSingle.perDay.toFixed(2)}/day)\n`);
console.log(`${"Strategy".padEnd(28)} ${"Trades".padStart(5)}  ${"WR%".padStart(6)}  ${"TotalPnL".padStart(10)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"MaxDD".padStart(8)}  ${"$/day".padStart(7)}  ${"vs Best".padStart(8)}`);
console.log("-".repeat(98));

for (const s of allResults) {
  const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(1)}` : `-$${Math.abs(s.pnl).toFixed(1)}`;
  const vsStr = s.pnl >= bestSingle.pnl ? `+${((s.pnl / bestSingle.pnl - 1) * 100).toFixed(0)}%` :
    `-${((1 - s.pnl / bestSingle.pnl) * 100).toFixed(0)}%`;
  console.log(
    `${s.label.padEnd(28)} ${String(s.trades).padStart(5)}  ${s.wr.toFixed(1).padStart(5)}%  ${pnlStr.padStart(10)}  ${s.pf.toFixed(2).padStart(5)}  ${s.sharpe.toFixed(2).padStart(6)}  $${s.maxDD.toFixed(1).padStart(7)}  $${s.perDay.toFixed(2).padStart(6)}  ${vsStr.padStart(8)}`
  );
}

// Monthly breakdown for best ensemble
const bestEns = [sEns1, sEns2, sEns3, sAnti2, sAnti3].sort((a, b) => b.sharpe - a.sharpe)[0];
const bestEnsTrades = bestEns === sEns1 ? ens1Trades :
  bestEns === sEns2 ? ens2Trades :
  bestEns === sEns3 ? ens3Trades :
  bestEns === sAnti2 ? ens4_2 : ens4_3;

console.log(`\n${"=".repeat(60)}`);
console.log(`MONTHLY BREAKDOWN: ${bestEns.label} (best Sharpe ensemble)`);
console.log("=".repeat(60));

const monthlyPnl = new Map<string, { pnl: number; trades: number; wins: number }>();
for (const t of bestEnsTrades.sort((a, b) => a.xt - b.xt)) {
  const m = new Date(t.xt).toISOString().slice(0, 7);
  const d = monthlyPnl.get(m) || { pnl: 0, trades: 0, wins: 0 };
  d.pnl += t.pnl; d.trades++; if (t.pnl > 0) d.wins++;
  monthlyPnl.set(m, d);
}

console.log(`${"Month".padEnd(10)} ${"Trades".padStart(6)}  ${"WR%".padStart(5)}  ${"PnL".padStart(10)}  ${"$/day".padStart(7)}`);
console.log("-".repeat(45));
for (const [m, d] of [...monthlyPnl.entries()].sort()) {
  const daysInMonth = m === "2026-03" ? 25 : 30;
  const pnlStr = d.pnl >= 0 ? `+$${d.pnl.toFixed(1)}` : `-$${Math.abs(d.pnl).toFixed(1)}`;
  console.log(`${m.padEnd(10)} ${String(d.trades).padStart(6)}  ${(d.trades > 0 ? d.wins / d.trades * 100 : 0).toFixed(1).padStart(5)}  ${pnlStr.padStart(10)}  $${(d.pnl / daysInMonth).toFixed(2).padStart(6)}`);
}

console.log("\nDone.");
