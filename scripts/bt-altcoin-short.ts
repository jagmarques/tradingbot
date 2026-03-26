import * as fs from "fs";
import * as path from "path";
import { EMA } from "technicalindicators";

// ─── Types ────────────────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number }
interface Trade { pair: string; pnl: number; et: number; xt: number }
interface DailyBar { t: number; o: number; h: number; l: number; c: number }
interface Bar4h { t: number; o: number; h: number; l: number; c: number }

// ─── Config ───────────────────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const H = 3600000;
const DAY = 86400000;
const WEEK = 7 * DAY;
const FEE = 0.00035;
const LEV = 10;
const SL_SLIP = 1.5; // 1.5x slippage on SL fills
const SZ = 3; // $3 per position

const ALTS = [
  "OPUSDT", "WIFUSDT", "ARBUSDT", "LDOUSDT", "TRUMPUSDT", "DASHUSDT",
  "DOTUSDT", "ENAUSDT", "DOGEUSDT", "APTUSDT", "LINKUSDT", "ADAUSDT",
  "WLDUSDT", "XRPUSDT", "UNIUSDT", "TIAUSDT", "SOLUSDT",
];

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, SOLUSDT: 1.5e-4, ARBUSDT: 2.6e-4,
  ENAUSDT: 2.55e-4, UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4,
  TRUMPUSDT: 3.65e-4, WLDUSDT: 4e-4, TIAUSDT: 4.2e-4, DOTUSDT: 4.95e-4,
  WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4, LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4,
  DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
};

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-25").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// ─── Data Loading ─────────────────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const f = path.join(CD, pair + ".json");
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8")) as C[];
}

function aggDaily(cs: C[]): DailyBar[] {
  const map = new Map<number, C[]>();
  for (const c of cs) {
    const dayKey = Math.floor(c.t / DAY) * DAY;
    if (!map.has(dayKey)) map.set(dayKey, []);
    map.get(dayKey)!.push(c);
  }
  const bars: DailyBar[] = [];
  for (const [t, candles] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    if (candles.length < 10) continue; // skip incomplete days
    bars.push({
      t,
      o: candles[0].o,
      h: Math.max(...candles.map(c => c.h)),
      l: Math.min(...candles.map(c => c.l)),
      c: candles[candles.length - 1].c,
    });
  }
  return bars;
}

function agg4h(cs: C[]): Bar4h[] {
  const interval = 4 * H;
  const map = new Map<number, C[]>();
  for (const c of cs) {
    const key = Math.floor(c.t / interval) * interval;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(c);
  }
  const bars: Bar4h[] = [];
  for (const [t, candles] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    if (candles.length < 5) continue;
    bars.push({
      t,
      o: candles[0].o,
      h: Math.max(...candles.map(c => c.h)),
      l: Math.min(...candles.map(c => c.l)),
      c: candles[candles.length - 1].c,
    });
  }
  return bars;
}

// ─── Spread + Fee cost for a short trade ──────────────────────────────────────
function shortCost(pair: string, entry: number, exit: number, notional: number): number {
  const sp = SP[pair] ?? 4e-4;
  // Short: sell at entry*(1-spread), buy at exit*(1+spread)
  const adjEntry = entry * (1 - sp);
  const adjExit = exit * (1 + sp);
  const rawPnl = (adjEntry / adjExit - 1) * notional * LEV;
  const fees = notional * LEV * FEE * 2;
  return rawPnl - fees;
}

function longCost(pair: string, entry: number, exit: number, notional: number): number {
  const sp = SP[pair] ?? 4e-4;
  const adjEntry = entry * (1 + sp);
  const adjExit = exit * (1 - sp);
  const rawPnl = (adjExit / adjEntry - 1) * notional * LEV;
  const fees = notional * LEV * FEE * 2;
  return rawPnl - fees;
}

// SL check for short: if intraday high crosses SL, we get stopped out with slippage
function slCheck(high: number, sl: number): number | null {
  if (high >= sl) {
    // SL hit, add slippage: exit above SL
    const slip = (high - sl) * (SL_SLIP - 1);
    return sl + slip;
  }
  return null;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────
interface Metrics {
  trades: number;
  pnl: number;
  wins: number;
  pf: number;
  sharpe: number;
  perDay: number;
  wr: number;
  maxDD: number;
  days: number;
}

function calcMetrics(trades: Trade[], startT: number, endT: number): Metrics {
  const days = (endT - startT) / DAY;
  const n = trades.length;
  if (n === 0) return { trades: 0, pnl: 0, wins: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0, maxDD: 0, days };

  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const gross = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = loss > 0 ? gross / loss : gross > 0 ? 999 : 0;

  // Daily P&L for Sharpe
  const dp = new Map<number, number>();
  for (const t of trades) {
    const dk = Math.floor(t.xt / DAY);
    dp.set(dk, (dp.get(dk) || 0) + t.pnl);
  }
  const dr = [...dp.values()];
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  // MaxDD
  let cum = 0, pk = 0, dd = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > pk) pk = cum;
    if (pk - cum > dd) dd = pk - cum;
  }

  return { trades: n, pnl, wins, pf, sharpe, perDay: pnl / days, wr: wins / n * 100, maxDD: dd, days };
}

function fmtMetrics(m: Metrics): string {
  const p = m.pnl >= 0 ? `+$${m.pnl.toFixed(0)}` : `-$${Math.abs(m.pnl).toFixed(0)}`;
  const d = m.perDay >= 0 ? `+$${m.perDay.toFixed(2)}` : `-$${Math.abs(m.perDay).toFixed(2)}`;
  return `${String(m.trades).padStart(5)}  ${m.wr.toFixed(1).padStart(5)}%  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(6)}  ${p.padStart(8)}  ${d.padStart(7)}  $${m.maxDD.toFixed(0).padStart(5)}`;
}

// ─── Load all data ────────────────────────────────────────────────────────────
console.log("Loading 5m candles and aggregating...");

const raw5m = new Map<string, C[]>();
const dailyData = new Map<string, DailyBar[]>();
const data4h = new Map<string, Bar4h[]>();

for (const p of [...ALTS, "BTCUSDT"]) {
  const c = load5m(p);
  raw5m.set(p, c);
  dailyData.set(p, aggDaily(c));
  data4h.set(p, agg4h(c));
}

console.log(`Loaded ${ALTS.length} alts + BTC`);
for (const p of ALTS) {
  const d = dailyData.get(p)!;
  console.log(`  ${p.padEnd(12)} ${d.length} daily bars  ${new Date(d[0].t).toISOString().slice(0, 10)} -> ${new Date(d[d.length - 1].t).toISOString().slice(0, 10)}`);
}

// BTC EMAs for filter
const btcDaily = dailyData.get("BTCUSDT")!;
const btcClose = btcDaily.map(b => b.c);
const btcEma20 = EMA.calculate({ period: 20, values: btcClose });
const btcEma50 = EMA.calculate({ period: 50, values: btcClose });

function btcBearish(t: number): boolean {
  // Find the daily bar at or before time t
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t <= t) { idx = i; break; }
  }
  if (idx < 0) return false;
  // EMA arrays are shorter by (period-1)
  const e20Idx = idx - (btcDaily.length - btcEma20.length);
  const e50Idx = idx - (btcDaily.length - btcEma50.length);
  if (e20Idx < 0 || e50Idx < 0 || e20Idx >= btcEma20.length || e50Idx >= btcEma50.length) return false;
  return btcEma20[e20Idx] < btcEma50[e50Idx];
}

function btcBullish(t: number): boolean {
  return !btcBearish(t);
}

// Helper: find daily close at or before time t
function dailyClose(pair: string, t: number): number | null {
  const bars = dailyData.get(pair);
  if (!bars) return null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].t <= t) return bars[i].c;
  }
  return null;
}

// Helper: get Mondays between start and end
function getMondays(start: number, end: number): number[] {
  const mondays: number[] = [];
  let t = start;
  // Advance to first Monday
  const d = new Date(t);
  const dow = d.getUTCDay();
  if (dow !== 1) {
    const advance = dow === 0 ? 1 : (8 - dow);
    t += advance * DAY;
  }
  while (t < end) {
    mondays.push(t);
    t += WEEK;
  }
  return mondays;
}

// ─── STRATEGY 1: Always Short Basket (Weekly Rebalance) ──────────────────────
function strat1AlwaysShort(start: number, end: number): Trade[] {
  const trades: Trade[] = [];
  const mondays = getMondays(start, end);

  for (let m = 0; m < mondays.length - 1; m++) {
    const entryTime = mondays[m];
    const exitTime = mondays[m + 1];

    for (const pair of ALTS) {
      const bars = dailyData.get(pair)!;
      const entryBar = bars.find(b => b.t >= entryTime);
      const exitBar = bars.findLast(b => b.t <= exitTime);
      if (!entryBar || !exitBar || entryBar.t >= exitBar.t) continue;

      const entryPrice = entryBar.o;
      const slPrice = entryPrice * 1.05; // 5% SL for short

      // Check intraday SL hits during the week using daily bars
      let stopped = false;
      let exitPrice = exitBar.c;
      let exitT = exitTime;

      for (const bar of bars) {
        if (bar.t < entryBar.t || bar.t > exitBar.t) continue;
        const slHit = slCheck(bar.h, slPrice);
        if (slHit !== null) {
          exitPrice = slHit;
          exitT = bar.t;
          stopped = true;
          break;
        }
      }

      if (!stopped) exitPrice = exitBar.c;

      const pnl = shortCost(pair, entryPrice, exitPrice, SZ);
      trades.push({ pair, pnl, et: entryTime, xt: exitT });
    }
  }
  return trades;
}

// ─── STRATEGY 2: BTC-Filtered Short Basket ───────────────────────────────────
function strat2BtcFiltered(start: number, end: number): Trade[] {
  const trades: Trade[] = [];
  const mondays = getMondays(start, end);

  for (let m = 0; m < mondays.length - 1; m++) {
    const entryTime = mondays[m];
    const exitTime = mondays[m + 1];

    // Only short when BTC is bearish
    if (!btcBearish(entryTime)) continue;

    for (const pair of ALTS) {
      const bars = dailyData.get(pair)!;
      const entryBar = bars.find(b => b.t >= entryTime);
      const exitBar = bars.findLast(b => b.t <= exitTime);
      if (!entryBar || !exitBar || entryBar.t >= exitBar.t) continue;

      const entryPrice = entryBar.o;
      const slPrice = entryPrice * 1.05;

      let stopped = false;
      let exitPrice = exitBar.c;
      let exitT = exitTime;

      for (const bar of bars) {
        if (bar.t < entryBar.t || bar.t > exitBar.t) continue;
        const slHit = slCheck(bar.h, slPrice);
        if (slHit !== null) {
          exitPrice = slHit;
          exitT = bar.t;
          stopped = true;
          break;
        }
      }

      if (!stopped) exitPrice = exitBar.c;

      const pnl = shortCost(pair, entryPrice, exitPrice, SZ);
      trades.push({ pair, pnl, et: entryTime, xt: exitT });
    }
  }
  return trades;
}

// ─── STRATEGY 3: Weak-Alt Short Selection ────────────────────────────────────
function strat3WeakAlt(start: number, end: number): Trade[] {
  const trades: Trade[] = [];
  const mondays = getMondays(start, end);

  for (let m = 0; m < mondays.length - 1; m++) {
    const entryTime = mondays[m];
    const exitTime = mondays[m + 1];
    const lookback = entryTime - 14 * DAY;

    // Rank alts by 14-day performance vs BTC
    const btcNow = dailyClose("BTCUSDT", entryTime);
    const btcPast = dailyClose("BTCUSDT", lookback);
    if (!btcNow || !btcPast || btcPast === 0) continue;
    const btcRet = btcNow / btcPast - 1;

    const perf: { pair: string; relRet: number }[] = [];
    for (const pair of ALTS) {
      const now = dailyClose(pair, entryTime);
      const past = dailyClose(pair, lookback);
      if (!now || !past || past === 0) continue;
      const altRet = now / past - 1;
      perf.push({ pair, relRet: altRet - btcRet });
    }

    // Sort ascending (worst relative performers first)
    perf.sort((a, b) => a.relRet - b.relRet);

    // Short bottom 5
    const toShort = perf.slice(0, 5);

    for (const { pair } of toShort) {
      const bars = dailyData.get(pair)!;
      const entryBar = bars.find(b => b.t >= entryTime);
      const exitBar = bars.findLast(b => b.t <= exitTime);
      if (!entryBar || !exitBar || entryBar.t >= exitBar.t) continue;

      const entryPrice = entryBar.o;
      const slPrice = entryPrice * 1.05;

      let stopped = false;
      let exitPrice = exitBar.c;
      let exitT = exitTime;

      for (const bar of bars) {
        if (bar.t < entryBar.t || bar.t > exitBar.t) continue;
        const slHit = slCheck(bar.h, slPrice);
        if (slHit !== null) {
          exitPrice = slHit;
          exitT = bar.t;
          stopped = true;
          break;
        }
      }

      if (!stopped) exitPrice = exitBar.c;

      const pnl = shortCost(pair, entryPrice, exitPrice, SZ);
      trades.push({ pair, pnl, et: entryTime, xt: exitT });
    }
  }
  return trades;
}

// ─── STRATEGY 4: Momentum Decay Short ────────────────────────────────────────
function strat4MomentumDecay(start: number, end: number): Trade[] {
  const trades: Trade[] = [];
  const mondays = getMondays(start, end);

  for (let m = 0; m < mondays.length; m++) {
    const entryTime = mondays[m];
    const lookback7d = entryTime - 7 * DAY;
    const maxHold = 14 * DAY;

    // BTC filter: only enter when BTC bearish
    if (!btcBearish(entryTime)) continue;

    for (const pair of ALTS) {
      const now = dailyClose(pair, entryTime);
      const past = dailyClose(pair, lookback7d);
      if (!now || !past || past === 0) continue;

      const pump = now / past - 1;
      if (pump < 0.20) continue; // need >20% pump

      const bars = dailyData.get(pair)!;
      const entryBar = bars.find(b => b.t >= entryTime);
      if (!entryBar) continue;

      const entryPrice = entryBar.o;
      const slPrice = entryPrice * 1.05; // 5% SL
      const tpPrice = entryPrice * 0.90; // 10% TP

      let exitPrice = 0;
      let exitT = 0;
      let found = false;

      for (const bar of bars) {
        if (bar.t < entryBar.t) continue;
        if (bar.t > entryTime + maxHold) {
          // Max hold exit
          exitPrice = bar.o; // exit at open of next day after max hold
          exitT = bar.t;
          found = true;
          break;
        }

        // SL check
        const slHit = slCheck(bar.h, slPrice);
        if (slHit !== null) {
          exitPrice = slHit;
          exitT = bar.t;
          found = true;
          break;
        }

        // TP check
        if (bar.l <= tpPrice) {
          exitPrice = tpPrice;
          exitT = bar.t;
          found = true;
          break;
        }
      }

      if (!found) {
        // Use last available bar
        const lastBar = bars[bars.length - 1];
        if (lastBar.t > entryBar.t) {
          exitPrice = lastBar.c;
          exitT = lastBar.t;
          found = true;
        }
      }

      if (found && exitPrice > 0) {
        const pnl = shortCost(pair, entryPrice, exitPrice, SZ);
        trades.push({ pair, pnl, et: entryTime, xt: exitT });
      }
    }
  }
  return trades;
}

// ─── STRATEGY 5: BTC-Hedged Short Basket ─────────────────────────────────────
function strat5BtcHedged(start: number, end: number): Trade[] {
  const trades: Trade[] = [];
  const mondays = getMondays(start, end);

  // Use top 10 most liquid alts for the basket
  const basket = [
    "DOGEUSDT", "XRPUSDT", "SOLUSDT", "LINKUSDT", "ADAUSDT",
    "DOTUSDT", "APTUSDT", "ARBUSDT", "UNIUSDT", "OPUSDT",
  ];

  const btcBars = dailyData.get("BTCUSDT")!;

  for (let m = 0; m < mondays.length - 1; m++) {
    const entryTime = mondays[m];
    const exitTime = mondays[m + 1];

    // --- Alt shorts ($3 each = $30 notional) ---
    for (const pair of basket) {
      const bars = dailyData.get(pair)!;
      const entryBar = bars.find(b => b.t >= entryTime);
      const exitBar = bars.findLast(b => b.t <= exitTime);
      if (!entryBar || !exitBar || entryBar.t >= exitBar.t) continue;

      const entryPrice = entryBar.o;
      const slPrice = entryPrice * 1.05;

      let stopped = false;
      let exitPrice = exitBar.c;
      let exitT = exitTime;

      for (const bar of bars) {
        if (bar.t < entryBar.t || bar.t > exitBar.t) continue;
        const slHit = slCheck(bar.h, slPrice);
        if (slHit !== null) {
          exitPrice = slHit;
          exitT = bar.t;
          stopped = true;
          break;
        }
      }

      if (!stopped) exitPrice = exitBar.c;

      const pnl = shortCost(pair, entryPrice, exitPrice, SZ);
      trades.push({ pair, pnl, et: entryTime, xt: exitT });
    }

    // --- BTC long hedge ($30 notional = $3 x 10 alts) ---
    {
      const entryBar = btcBars.find(b => b.t >= entryTime);
      const exitBar = btcBars.findLast(b => b.t <= exitTime);
      if (entryBar && exitBar && entryBar.t < exitBar.t) {
        const btcNotional = SZ * basket.length; // match alt notional
        const pnl = longCost("BTCUSDT", entryBar.o, exitBar.c, btcNotional);
        trades.push({ pair: "BTCUSDT-HEDGE", pnl, et: entryTime, xt: exitTime });
      }
    }
  }
  return trades;
}

// ─── Run Everything ───────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("  SYSTEMATIC ALTCOIN SHORT BASKET BACKTEST");
console.log("  Inspired by AceVault (PF 3.71, 127% APR)");
console.log("  $3/position, 10x leverage, taker 0.035%, 1.5x SL slippage");
console.log("  Full: 2023-01 to 2026-03 | OOS: 2025-09-01");
console.log("=".repeat(100));

const strats: { name: string; fn: (s: number, e: number) => Trade[] }[] = [
  { name: "1. Always Short Basket", fn: strat1AlwaysShort },
  { name: "2. BTC-Filtered Short", fn: strat2BtcFiltered },
  { name: "3. Weak-Alt Selection", fn: strat3WeakAlt },
  { name: "4. Momentum Decay Short", fn: strat4MomentumDecay },
  { name: "5. BTC-Hedged Basket", fn: strat5BtcHedged },
];

console.log("\n" + "-".repeat(100));
console.log("Strategy                    |  Trades   WR%     PF  Sharpe      PnL    $/day   MaxDD");
console.log("-".repeat(100));

for (const s of strats) {
  // Full period
  const full = s.fn(FULL_START, FULL_END);
  const mFull = calcMetrics(full, FULL_START, FULL_END);

  // IS (before OOS)
  const is = s.fn(FULL_START, OOS_START);
  const mIS = calcMetrics(is, FULL_START, OOS_START);

  // OOS
  const oos = s.fn(OOS_START, FULL_END);
  const mOOS = calcMetrics(oos, OOS_START, FULL_END);

  console.log(`${s.name.padEnd(28)}| FULL ${fmtMetrics(mFull)}`);
  console.log(`${"".padEnd(28)}|   IS ${fmtMetrics(mIS)}`);
  console.log(`${"".padEnd(28)}|  OOS ${fmtMetrics(mOOS)}`);
  console.log("-".repeat(100));
}

// ─── Detailed monthly P&L for each strategy ──────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("  MONTHLY P&L BREAKDOWN");
console.log("=".repeat(100));

for (const s of strats) {
  const trades = s.fn(FULL_START, FULL_END);
  console.log(`\n--- ${s.name} ---`);

  const monthly = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of trades) {
    const m = new Date(t.xt).toISOString().slice(0, 7);
    if (!monthly.has(m)) monthly.set(m, { pnl: 0, trades: 0, wins: 0 });
    const d = monthly.get(m)!;
    d.pnl += t.pnl;
    d.trades++;
    if (t.pnl > 0) d.wins++;
  }

  console.log("Month     Trades  Wins  WR%     PnL");
  let cumPnl = 0;
  for (const [m, d] of [...monthly.entries()].sort()) {
    cumPnl += d.pnl;
    const wr = d.trades > 0 ? (d.wins / d.trades * 100).toFixed(1) : "0.0";
    const p = d.pnl >= 0 ? `+$${d.pnl.toFixed(2)}` : `-$${Math.abs(d.pnl).toFixed(2)}`;
    const c = cumPnl >= 0 ? `+$${cumPnl.toFixed(2)}` : `-$${Math.abs(cumPnl).toFixed(2)}`;
    console.log(`${m}   ${String(d.trades).padStart(5)}  ${String(d.wins).padStart(4)}  ${wr.padStart(5)}%  ${p.padStart(10)}  cum: ${c}`);
  }
}

// ─── Per-pair analysis for Strategy 1 (Always Short) ─────────────────────────
console.log("\n" + "=".repeat(100));
console.log("  PER-PAIR BREAKDOWN: Strategy 1 (Always Short Basket)");
console.log("=".repeat(100));

const allTrades1 = strat1AlwaysShort(FULL_START, FULL_END);
const pairStats = new Map<string, { pnl: number; trades: number; wins: number }>();
for (const t of allTrades1) {
  if (!pairStats.has(t.pair)) pairStats.set(t.pair, { pnl: 0, trades: 0, wins: 0 });
  const d = pairStats.get(t.pair)!;
  d.pnl += t.pnl;
  d.trades++;
  if (t.pnl > 0) d.wins++;
}

console.log("Pair          Trades  Wins  WR%      PnL     $/trade");
console.log("-".repeat(60));
const sorted = [...pairStats.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
for (const [pair, d] of sorted) {
  const wr = d.trades > 0 ? (d.wins / d.trades * 100).toFixed(1) : "0.0";
  const p = d.pnl >= 0 ? `+$${d.pnl.toFixed(2)}` : `-$${Math.abs(d.pnl).toFixed(2)}`;
  const pt = d.trades > 0 ? (d.pnl / d.trades).toFixed(3) : "0.000";
  console.log(`${pair.padEnd(14)} ${String(d.trades).padStart(5)}  ${String(d.wins).padStart(4)}  ${wr.padStart(5)}%  ${p.padStart(9)}  $${pt.padStart(7)}`);
}

// ─── Per-pair analysis for Strategy 5 (BTC-Hedged) ──────────────────────────
console.log("\n" + "=".repeat(100));
console.log("  PER-PAIR BREAKDOWN: Strategy 5 (BTC-Hedged Basket)");
console.log("=".repeat(100));

const allTrades5 = strat5BtcHedged(FULL_START, FULL_END);
const pairStats5 = new Map<string, { pnl: number; trades: number; wins: number }>();
for (const t of allTrades5) {
  if (!pairStats5.has(t.pair)) pairStats5.set(t.pair, { pnl: 0, trades: 0, wins: 0 });
  const d = pairStats5.get(t.pair)!;
  d.pnl += t.pnl;
  d.trades++;
  if (t.pnl > 0) d.wins++;
}

console.log("Pair            Trades  Wins  WR%      PnL     $/trade");
console.log("-".repeat(65));
const sorted5 = [...pairStats5.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
for (const [pair, d] of sorted5) {
  const wr = d.trades > 0 ? (d.wins / d.trades * 100).toFixed(1) : "0.0";
  const p = d.pnl >= 0 ? `+$${d.pnl.toFixed(2)}` : `-$${Math.abs(d.pnl).toFixed(2)}`;
  const pt = d.trades > 0 ? (d.pnl / d.trades).toFixed(3) : "0.000";
  console.log(`${pair.padEnd(16)} ${String(d.trades).padStart(5)}  ${String(d.wins).padStart(4)}  ${wr.padStart(5)}%  ${p.padStart(9)}  $${pt.padStart(7)}`);
}

// ─── Equity curves (yearly) ──────────────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("  YEARLY SUMMARY");
console.log("=".repeat(100));

for (const s of strats) {
  const trades = s.fn(FULL_START, FULL_END);
  console.log(`\n${s.name}:`);

  const yearly = new Map<number, { pnl: number; trades: number }>();
  for (const t of trades) {
    const y = new Date(t.xt).getUTCFullYear();
    if (!yearly.has(y)) yearly.set(y, { pnl: 0, trades: 0 });
    const d = yearly.get(y)!;
    d.pnl += t.pnl;
    d.trades++;
  }

  for (const [y, d] of [...yearly.entries()].sort()) {
    const p = d.pnl >= 0 ? `+$${d.pnl.toFixed(2)}` : `-$${Math.abs(d.pnl).toFixed(2)}`;
    console.log(`  ${y}: ${String(d.trades).padStart(5)} trades  ${p.padStart(10)}`);
  }
}

// ─── Comparison to existing engines ──────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("  COMPARISON TO EXISTING BTC-MR ENGINE");
console.log("=".repeat(100));
console.log(`
  BTC-MR (current, paper): ~$1.50-2.50/day, PF 1.3-1.5, Sharpe 0.8-1.2

  Alt-short strategies above should be compared on:
  - $/day (is it additive?)
  - Correlation (does it diversify?)
  - Capital efficiency ($3/pos x 17 = $51 notional, $5.1 margin at 10x)
  - Survivorship: does it work across ALL market regimes?
`);

console.log("Done.");
