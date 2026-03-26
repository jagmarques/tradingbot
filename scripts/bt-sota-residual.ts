/**
 * BTC-Neutral Residual Mean Reversion Backtest
 *
 * Academic SOTA strategy #5: removes BTC beta from each altcoin,
 * then mean-reverts on the residual z-score.
 *
 * Fundamentally different from trend following - potentially complementary.
 */

import * as fs from "fs";
import * as path from "path";

// ── Config ──────────────────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const PAIRS = [
  "ADA", "APT", "ARB", "DASH", "DOGE", "DOT", "ENA", "ETH",
  "LDO", "LINK", "OP", "SOL", "TIA", "TRUMP", "UNI", "WIF", "WLD", "XRP",
];
const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-25").getTime();
const OOS_START = new Date("2025-09-01").getTime();
const DAY = 86_400_000;

const MARGIN = 5;
const LEV = 10;
const NOTIONAL = MARGIN * LEV; // $50

const SPREAD: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, AVAXUSDT: 2.55e-4,
  ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4, UNIUSDT: 2.75e-4,
  APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4,
  WLDUSDT: 4e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4,
  ADAUSDT: 5.55e-4, LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4,
  DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4, ETHUSDT: 1.0e-4,
  SOLUSDT: 1.5e-4, TIAUSDT: 3.5e-4,
};

// ── Types ───────────────────────────────────────────────────────────────────
interface Bar { t: number; o: number; h: number; l: number; c: number }
interface DailyBar { t: number; o: number; h: number; l: number; c: number }
interface Position {
  pair: string;
  dir: "long" | "short";
  entry: number;
  entryDay: number; // index in daily array
  entryTime: number;
  margin: number;
}
interface Trade {
  pair: string;
  dir: "long" | "short";
  entry: number;
  exit: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  holdDays: number;
  reason: string;
}

// ── Load & aggregate to daily ───────────────────────────────────────────────
function load5m(sym: string): Bar[] {
  const f = path.join(CACHE_DIR, sym + ".json");
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8")) as Bar[];
}

function aggregateDaily(bars: Bar[]): DailyBar[] {
  const dayMap = new Map<number, Bar[]>();
  for (const b of bars) {
    const dayKey = Math.floor(b.t / DAY) * DAY;
    if (!dayMap.has(dayKey)) dayMap.set(dayKey, []);
    dayMap.get(dayKey)!.push(b);
  }
  const daily: DailyBar[] = [];
  for (const [t, bs] of [...dayMap.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length < 12) continue; // need at least 1h of data
    daily.push({
      t,
      o: bs[0].o,
      h: Math.max(...bs.map(b => b.h)),
      l: Math.min(...bs.map(b => b.l)),
      c: bs[bs.length - 1].c,
    });
  }
  return daily;
}

// ── Statistics helpers ──────────────────────────────────────────────────────
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

// ── Compute rolling betas and residual z-scores ─────────────────────────────
interface PairData {
  pair: string;
  daily: DailyBar[];
  dayIndex: Map<number, number>; // t -> index
  altRet: number[];   // daily returns, index-aligned
  beta: number[];     // rolling beta, index-aligned
  residual: number[]; // residual return, index-aligned
  cumResid: number[]; // cumulative residual over zscore window
  zScore: number[];   // z-score of cumulative residual
}

function computePairData(
  pair: string,
  altDaily: DailyBar[],
  btcDaily: DailyBar[],
  betaWindow: number,
  zWindow: number,
): PairData | null {
  // Build BTC return lookup by day timestamp
  const btcRetMap = new Map<number, number>();
  for (let i = 1; i < btcDaily.length; i++) {
    btcRetMap.set(btcDaily[i].t, btcDaily[i].c / btcDaily[i - 1].c - 1);
  }

  // Compute alt returns aligned with BTC
  const altRet: number[] = new Array(altDaily.length).fill(0);
  const btcRetAligned: number[] = new Array(altDaily.length).fill(0);
  const dayIndex = new Map<number, number>();

  for (let i = 0; i < altDaily.length; i++) {
    dayIndex.set(altDaily[i].t, i);
    if (i > 0) {
      altRet[i] = altDaily[i].c / altDaily[i - 1].c - 1;
      btcRetAligned[i] = btcRetMap.get(altDaily[i].t) ?? 0;
    }
  }

  // Rolling beta
  const beta: number[] = new Array(altDaily.length).fill(0);
  for (let i = betaWindow; i < altDaily.length; i++) {
    const aSlice = altRet.slice(i - betaWindow + 1, i + 1);
    const bSlice = btcRetAligned.slice(i - betaWindow + 1, i + 1);
    const c = corr(aSlice, bSlice);
    const altVol = std(aSlice);
    const btcVol = std(bSlice);
    beta[i] = btcVol > 0 ? (c * altVol) / btcVol : 1;
  }

  // Residual return
  const residual: number[] = new Array(altDaily.length).fill(0);
  for (let i = betaWindow; i < altDaily.length; i++) {
    residual[i] = altRet[i] - beta[i] * btcRetAligned[i];
  }

  // Cumulative residual over zWindow, then z-score
  const cumResid: number[] = new Array(altDaily.length).fill(0);
  for (let i = betaWindow + 1; i < altDaily.length; i++) {
    // Sum residual over last zWindow days
    const start = Math.max(betaWindow, i - zWindow + 1);
    let s = 0;
    for (let j = start; j <= i; j++) s += residual[j];
    cumResid[i] = s;
  }

  const zScore: number[] = new Array(altDaily.length).fill(0);
  const minIdx = betaWindow + zWindow;
  for (let i = minIdx; i < altDaily.length; i++) {
    const slice = cumResid.slice(i - zWindow + 1, i + 1);
    const m = mean(slice);
    const s = std(slice);
    zScore[i] = s > 1e-10 ? (cumResid[i] - m) / s : 0;
  }

  return { pair, daily: altDaily, dayIndex, altRet, beta, residual, cumResid, zScore };
}

// ── BTC trend filter ────────────────────────────────────────────────────────
function btcTrend(btcDaily: DailyBar[], idx: number, lookback: number = 20): "up" | "down" | "flat" {
  if (idx < lookback) return "flat";
  const ret = btcDaily[idx].c / btcDaily[idx - lookback].c - 1;
  if (ret > 0.02) return "up";
  if (ret < -0.02) return "down";
  return "flat";
}

// ── Backtest engine ─────────────────────────────────────────────────────────
interface Config {
  betaWindow: number;
  zWindow: number;
  zEntry: number;
  zExit: number;
  zStop: number;
  maxHold: number;
  feePct: number;
  slSlippage: number;
  btcFilter: boolean;
  label: string;
}

interface Result {
  label: string;
  fullTrades: number;
  fullPnl: number;
  fullPF: number;
  fullSharpe: number;
  fullWR: number;
  fullDaysTraded: number;
  fullPerDay: number;
  fullMaxDD: number;
  oosTrades: number;
  oosPnl: number;
  oosPF: number;
  oosSharpe: number;
  oosWR: number;
  oosDaysTraded: number;
  oosPerDay: number;
  oosMaxDD: number;
  dailyPnls: Map<number, number>; // dayTimestamp -> pnl
}

function runBacktest(
  pairsData: PairData[],
  btcDaily: DailyBar[],
  config: Config,
): Result {
  const {
    zEntry, zExit, zStop, maxHold, feePct, slSlippage, btcFilter,
  } = config;

  const btcDayIndex = new Map<number, number>();
  btcDaily.forEach((b, i) => btcDayIndex.set(b.t, i));

  const trades: Trade[] = [];
  const positions = new Map<string, Position>();
  const dailyPnls = new Map<number, number>();

  // Collect all unique day timestamps across all pairs
  const allDays = new Set<number>();
  for (const pd of pairsData) {
    for (const d of pd.daily) {
      if (d.t >= FULL_START && d.t <= FULL_END) allDays.add(d.t);
    }
  }
  const sortedDays = [...allDays].sort((a, b) => a - b);

  for (const dayT of sortedDays) {
    // Check exits first
    for (const [pairKey, pos] of [...positions.entries()]) {
      const pd = pairsData.find(p => p.pair === pairKey)!;
      const idx = pd.dayIndex.get(dayT);
      if (idx === undefined) continue;

      const holdDays = Math.round((dayT - pos.entryTime) / DAY);
      const zNow = pd.zScore[idx];
      const sp = SPREAD[pairKey + "USDT"] ?? 4e-4;
      let exitPrice = 0;
      let reason = "";

      // Stop-loss: z-score moves to ±zStop against you
      if (pos.dir === "long" && zNow < -zStop) {
        exitPrice = pd.daily[idx].o * (1 - sp * slSlippage);
        reason = "z-stop";
      } else if (pos.dir === "short" && zNow > zStop) {
        exitPrice = pd.daily[idx].o * (1 + sp * slSlippage);
        reason = "z-stop";
      }
      // Mean reversion complete: z-score returns within [-zExit, zExit]
      else if (Math.abs(zNow) <= zExit) {
        exitPrice = pd.daily[idx].o * (pos.dir === "long" ? 1 - sp : 1 + sp);
        reason = "mr-exit";
      }
      // Max hold
      else if (holdDays >= maxHold) {
        exitPrice = pd.daily[idx].o * (pos.dir === "long" ? 1 - sp : 1 + sp);
        reason = "max-hold";
      }

      if (exitPrice > 0) {
        const rawPnl = pos.dir === "long"
          ? (exitPrice / pos.entry - 1) * NOTIONAL
          : (pos.entry / exitPrice - 1) * NOTIONAL;
        const fees = NOTIONAL * feePct * 2;
        const pnl = rawPnl - fees;

        trades.push({
          pair: pairKey,
          dir: pos.dir,
          entry: pos.entry,
          exit: exitPrice,
          entryTime: pos.entryTime,
          exitTime: dayT,
          pnl,
          holdDays,
          reason,
        });

        const prev = dailyPnls.get(dayT) ?? 0;
        dailyPnls.set(dayT, prev + pnl);

        positions.delete(pairKey);
      }
    }

    // Check entries (signal on day i-1, entry at day i open = anti-look-ahead)
    for (const pd of pairsData) {
      if (positions.has(pd.pair)) continue;
      const idx = pd.dayIndex.get(dayT);
      if (idx === undefined || idx < 2) continue;

      // Signal from previous day
      const zPrev = pd.zScore[idx - 1];
      if (Math.abs(zPrev) < zEntry) continue;

      const dir: "long" | "short" = zPrev < -zEntry ? "long" : "short";

      // BTC trend filter
      if (btcFilter) {
        const btcIdx = btcDayIndex.get(dayT);
        if (btcIdx !== undefined) {
          const trend = btcTrend(btcDaily, btcIdx - 1);
          // Only long when BTC trending up, short when BTC trending down
          if (dir === "long" && trend === "down") continue;
          if (dir === "short" && trend === "up") continue;
        }
      }

      const sp = SPREAD[pd.pair + "USDT"] ?? 4e-4;
      const entryPrice = dir === "long"
        ? pd.daily[idx].o * (1 + sp)
        : pd.daily[idx].o * (1 - sp);

      positions.set(pd.pair, {
        pair: pd.pair,
        dir,
        entry: entryPrice,
        entryDay: idx,
        entryTime: dayT,
        margin: MARGIN,
      });
    }

    // Record zero-pnl days for Sharpe calculation
    if (!dailyPnls.has(dayT)) dailyPnls.set(dayT, 0);
  }

  // Close remaining positions at last day
  for (const [pairKey, pos] of positions) {
    const pd = pairsData.find(p => p.pair === pairKey)!;
    const lastDay = pd.daily[pd.daily.length - 1];
    const sp = SPREAD[pairKey + "USDT"] ?? 4e-4;
    const exitPrice = pos.dir === "long"
      ? lastDay.c * (1 - sp)
      : lastDay.c * (1 + sp);
    const rawPnl = pos.dir === "long"
      ? (exitPrice / pos.entry - 1) * NOTIONAL
      : (pos.entry / exitPrice - 1) * NOTIONAL;
    const fees = NOTIONAL * feePct * 2;
    const pnl = rawPnl - fees;
    trades.push({
      pair: pairKey, dir: pos.dir, entry: pos.entry, exit: exitPrice,
      entryTime: pos.entryTime, exitTime: lastDay.t, pnl,
      holdDays: Math.round((lastDay.t - pos.entryTime) / DAY),
      reason: "eod",
    });
    const prev = dailyPnls.get(lastDay.t) ?? 0;
    dailyPnls.set(lastDay.t, prev + pnl);
  }

  // Compute metrics
  const computeMetrics = (tr: Trade[], dpnls: number[]) => {
    const wins = tr.filter(t => t.pnl > 0);
    const losses = tr.filter(t => t.pnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
    const totalPnl = tr.reduce((s, t) => s + t.pnl, 0);
    const wr = tr.length > 0 ? wins.length / tr.length : 0;
    const sharpe = dpnls.length > 1 ? (mean(dpnls) / std(dpnls)) * Math.sqrt(365) : 0;

    // Max drawdown
    let peak = 0, dd = 0, maxDd = 0;
    let cum = 0;
    for (const p of dpnls) {
      cum += p;
      if (cum > peak) peak = cum;
      dd = peak - cum;
      if (dd > maxDd) maxDd = dd;
    }

    return { trades: tr.length, pnl: totalPnl, pf, sharpe, wr, maxDd };
  };

  const allDailyPnls = [...dailyPnls.entries()].sort((a, b) => a[0] - b[0]);
  const fullDpnls = allDailyPnls.map(x => x[1]);
  const oosDpnls = allDailyPnls.filter(x => x[0] >= OOS_START).map(x => x[1]);
  const fullTrades = trades;
  const oosTrades = trades.filter(t => t.entryTime >= OOS_START);

  const fullDays = allDailyPnls.length;
  const oosDays = oosDpnls.length;

  const fm = computeMetrics(fullTrades, fullDpnls);
  const om = computeMetrics(oosTrades, oosDpnls);

  return {
    label: config.label,
    fullTrades: fm.trades, fullPnl: fm.pnl, fullPF: fm.pf,
    fullSharpe: fm.sharpe, fullWR: fm.wr, fullDaysTraded: fullDays,
    fullPerDay: fullDays > 0 ? fm.pnl / fullDays : 0, fullMaxDD: fm.maxDd,
    oosTrades: om.trades, oosPnl: om.pnl, oosPF: om.pf,
    oosSharpe: om.sharpe, oosWR: om.wr, oosDaysTraded: oosDays,
    oosPerDay: oosDays > 0 ? om.pnl / oosDays : 0, oosMaxDD: om.maxDd,
    dailyPnls,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  console.log("=== BTC-NEUTRAL RESIDUAL MEAN REVERSION BACKTEST ===\n");
  console.log(`Pairs: ${PAIRS.join(", ")}`);
  console.log(`Period: 2023-01 to 2026-03 | OOS: 2025-09-01+`);
  console.log(`Margin: $${MARGIN}, Leverage: ${LEV}x, Notional: $${NOTIONAL}\n`);

  // Load data
  console.log("Loading and aggregating 5m -> daily candles...");
  const btc5m = load5m("BTCUSDT");
  const btcDaily = aggregateDaily(btc5m);
  console.log(`  BTC: ${btcDaily.length} daily bars (${new Date(btcDaily[0].t).toISOString().slice(0, 10)} to ${new Date(btcDaily[btcDaily.length - 1].t).toISOString().slice(0, 10)})`);

  const altDailies = new Map<string, DailyBar[]>();
  for (const pair of PAIRS) {
    const bars = load5m(pair + "USDT");
    const daily = aggregateDaily(bars);
    altDailies.set(pair, daily);
    console.log(`  ${pair}: ${daily.length} daily bars (${new Date(daily[0].t).toISOString().slice(0, 10)} to ${new Date(daily[daily.length - 1].t).toISOString().slice(0, 10)})`);
  }

  // ── Parameter sweep ─────────────────────────────────────────────────────
  const zEntries = [1.5, 2.0, 2.5, 3.0];
  const betaWindows = [30, 60, 90];
  const maxHolds = [5, 10, 20];
  const btcFilters = [false, true];
  const feeModes: Array<{ label: string; fee: number }> = [
    { label: "taker", fee: 0.00035 },
    { label: "maker", fee: 0.0001 },
  ];

  const Z_WINDOW = 20; // fixed
  const Z_EXIT = 0.5;
  const Z_STOP = 3.5;
  const SL_SLIPPAGE = 1.5;

  const results: Result[] = [];

  // First, run the full sweep with taker fees, no BTC filter
  console.log("\n=== A. Z-SCORE THRESHOLD SWEEP (beta=60, hold=10, taker, no BTC filter) ===\n");
  console.log("Z-Entry  | FULL: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD | OOS: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD");
  console.log("-".repeat(130));

  for (const zEntry of zEntries) {
    const pairsData: PairData[] = [];
    for (const pair of PAIRS) {
      const pd = computePairData(pair, altDailies.get(pair)!, btcDaily, 60, Z_WINDOW);
      if (pd) pairsData.push(pd);
    }
    const r = runBacktest(pairsData, btcDaily, {
      betaWindow: 60, zWindow: Z_WINDOW, zEntry, zExit: Z_EXIT, zStop: Z_STOP,
      maxHold: 10, feePct: 0.00035, slSlippage: SL_SLIPPAGE,
      btcFilter: false, label: `z=${zEntry}`,
    });
    results.push(r);
    printRow(r);
  }

  // B. Beta window sweep
  console.log("\n=== B. BETA WINDOW SWEEP (z=2.0, hold=10, taker, no BTC filter) ===\n");
  console.log("Beta-Win | FULL: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD | OOS: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD");
  console.log("-".repeat(130));

  for (const bw of betaWindows) {
    const pairsData: PairData[] = [];
    for (const pair of PAIRS) {
      const pd = computePairData(pair, altDailies.get(pair)!, btcDaily, bw, Z_WINDOW);
      if (pd) pairsData.push(pd);
    }
    const r = runBacktest(pairsData, btcDaily, {
      betaWindow: bw, zWindow: Z_WINDOW, zEntry: 2.0, zExit: Z_EXIT, zStop: Z_STOP,
      maxHold: 10, feePct: 0.00035, slSlippage: SL_SLIPPAGE,
      btcFilter: false, label: `beta=${bw}`,
    });
    results.push(r);
    printRow(r);
  }

  // C. Max hold sweep
  console.log("\n=== C. MAX HOLD SWEEP (z=2.0, beta=60, taker, no BTC filter) ===\n");
  console.log("MaxHold  | FULL: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD | OOS: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD");
  console.log("-".repeat(130));

  for (const mh of maxHolds) {
    const pairsData: PairData[] = [];
    for (const pair of PAIRS) {
      const pd = computePairData(pair, altDailies.get(pair)!, btcDaily, 60, Z_WINDOW);
      if (pd) pairsData.push(pd);
    }
    const r = runBacktest(pairsData, btcDaily, {
      betaWindow: 60, zWindow: Z_WINDOW, zEntry: 2.0, zExit: Z_EXIT, zStop: Z_STOP,
      maxHold: mh, feePct: 0.00035, slSlippage: SL_SLIPPAGE,
      btcFilter: false, label: `hold=${mh}`,
    });
    results.push(r);
    printRow(r);
  }

  // D. BTC trend filter
  console.log("\n=== D. BTC TREND FILTER (z=2.0, beta=60, hold=10, taker) ===\n");
  console.log("Filter   | FULL: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD | OOS: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD");
  console.log("-".repeat(130));

  for (const bf of btcFilters) {
    const pairsData: PairData[] = [];
    for (const pair of PAIRS) {
      const pd = computePairData(pair, altDailies.get(pair)!, btcDaily, 60, Z_WINDOW);
      if (pd) pairsData.push(pd);
    }
    const r = runBacktest(pairsData, btcDaily, {
      betaWindow: 60, zWindow: Z_WINDOW, zEntry: 2.0, zExit: Z_EXIT, zStop: Z_STOP,
      maxHold: 10, feePct: 0.00035, slSlippage: SL_SLIPPAGE,
      btcFilter: bf, label: bf ? "BTC-filt" : "No-filt",
    });
    results.push(r);
    printRow(r);
  }

  // E. Fee comparison
  console.log("\n=== E. FEE COMPARISON (z=2.0, beta=60, hold=10, no BTC filter) ===\n");
  console.log("Fees     | FULL: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD | OOS: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD");
  console.log("-".repeat(130));

  let takerResult: Result | null = null;
  let makerResult: Result | null = null;
  for (const fm of feeModes) {
    const pairsData: PairData[] = [];
    for (const pair of PAIRS) {
      const pd = computePairData(pair, altDailies.get(pair)!, btcDaily, 60, Z_WINDOW);
      if (pd) pairsData.push(pd);
    }
    const r = runBacktest(pairsData, btcDaily, {
      betaWindow: 60, zWindow: Z_WINDOW, zEntry: 2.0, zExit: Z_EXIT, zStop: Z_STOP,
      maxHold: 10, feePct: fm.fee, slSlippage: SL_SLIPPAGE,
      btcFilter: false, label: fm.label,
    });
    results.push(r);
    if (fm.label === "taker") takerResult = r;
    if (fm.label === "maker") makerResult = r;
    printRow(r);
  }

  // ── Best config detail ────────────────────────────────────────────────────
  console.log("\n=== BEST CONFIGURATION DETAIL ===\n");

  // Find best by OOS Sharpe
  const bestByOosSharpe = [...results].sort((a, b) => b.oosSharpe - a.oosSharpe)[0];
  const bestByOosPnl = [...results].sort((a, b) => b.oosPnl - a.oosPnl)[0];
  console.log(`Best OOS Sharpe: ${bestByOosSharpe.label} (Sharpe=${bestByOosSharpe.oosSharpe.toFixed(2)}, PnL=$${bestByOosSharpe.oosPnl.toFixed(0)})`);
  console.log(`Best OOS PnL:    ${bestByOosPnl.label} (PnL=$${bestByOosPnl.oosPnl.toFixed(0)}, Sharpe=${bestByOosPnl.oosSharpe.toFixed(2)})`);

  // Run detailed analysis on best config (z=2.0, beta=60, hold=10, taker)
  console.log("\n--- Detailed: z=2.0, beta=60, hold=10, taker, no BTC filter ---\n");
  const detailPairsData: PairData[] = [];
  for (const pair of PAIRS) {
    const pd = computePairData(pair, altDailies.get(pair)!, btcDaily, 60, Z_WINDOW);
    if (pd) detailPairsData.push(pd);
  }

  // Per-pair breakdown
  console.log("Per-pair breakdown (OOS only):");
  console.log("Pair      Trades   WR%   PnL     Avg    Sharpe");
  console.log("-".repeat(55));

  for (const pair of PAIRS) {
    const pd = computePairData(pair, altDailies.get(pair)!, btcDaily, 60, Z_WINDOW);
    if (!pd) continue;
    const r = runBacktest([pd], btcDaily, {
      betaWindow: 60, zWindow: Z_WINDOW, zEntry: 2.0, zExit: Z_EXIT, zStop: Z_STOP,
      maxHold: 10, feePct: 0.00035, slSlippage: SL_SLIPPAGE,
      btcFilter: false, label: pair,
    });
    const s = r.oosSharpe.toFixed(2).padStart(6);
    console.log(
      `${pair.padEnd(10)} ${String(r.oosTrades).padStart(5)}  ${(r.oosWR * 100).toFixed(0).padStart(4)}%  $${r.oosPnl.toFixed(1).padStart(7)}  $${r.oosTrades > 0 ? (r.oosPnl / r.oosTrades).toFixed(2).padStart(6) : "  0.00"}  ${s}`
    );
  }

  // Monthly PnL for base config
  console.log("\n--- Monthly PnL (z=2.0, beta=60, hold=10, taker) ---\n");
  if (takerResult) {
    const monthlyPnl = new Map<string, number>();
    for (const [t, pnl] of takerResult.dailyPnls) {
      const m = new Date(t).toISOString().slice(0, 7);
      monthlyPnl.set(m, (monthlyPnl.get(m) ?? 0) + pnl);
    }
    console.log("Month       PnL");
    console.log("-".repeat(25));
    for (const [m, pnl] of [...monthlyPnl.entries()].sort()) {
      const bar = pnl >= 0 ? "+".repeat(Math.min(50, Math.round(pnl / 2))) : "-".repeat(Math.min(50, Math.round(Math.abs(pnl) / 2)));
      console.log(`${m}  ${(pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(0).replace("-", "")}${pnl < 0 ? " " : "  "}${pnl < 0 ? "-$" + Math.abs(pnl).toFixed(0) : ""}`.replace(/\s+$/, ""));
    }
    // Simpler monthly output
    console.log("\nMonth       PnL        Cum");
    console.log("-".repeat(35));
    let cum = 0;
    for (const [m, pnl] of [...monthlyPnl.entries()].sort()) {
      cum += pnl;
      console.log(`${m}   ${(pnl >= 0 ? "+" : "-")}$${Math.abs(pnl).toFixed(0).padStart(5)}   $${cum.toFixed(0).padStart(7)}`);
    }
  }

  // ── Correlation with Donchian ───────────────────────────────────────────
  console.log("\n=== CORRELATION WITH DAILY DONCHIAN 30d ===\n");

  // Simulate a simple Donchian trend-following daily PnL as a proxy
  // Use BTC 20-day breakout as proxy for Donchian trend strategy
  const donchDailyPnl = new Map<number, number>();
  let donchPos: { dir: "long" | "short"; entry: number; entryT: number } | null = null;

  for (let i = 30; i < btcDaily.length; i++) {
    const dayT = btcDaily[i].t;
    if (dayT < FULL_START || dayT > FULL_END) continue;

    // Exit
    if (donchPos) {
      const exitCh = btcDaily.slice(i - 10, i).map(b => donchPos!.dir === "long" ? b.l : b.h);
      const exitLevel = donchPos.dir === "long" ? Math.min(...exitCh) : Math.max(...exitCh);
      const shouldExit = donchPos.dir === "long"
        ? btcDaily[i].l <= exitLevel
        : btcDaily[i].h >= exitLevel;

      if (shouldExit) {
        const pnl = donchPos.dir === "long"
          ? (exitLevel / donchPos.entry - 1) * NOTIONAL
          : (donchPos.entry / exitLevel - 1) * NOTIONAL;
        donchDailyPnl.set(dayT, (donchDailyPnl.get(dayT) ?? 0) + pnl);
        donchPos = null;
      }
    }

    // Entry
    if (!donchPos) {
      const highs = btcDaily.slice(i - 30, i).map(b => b.h);
      const lows = btcDaily.slice(i - 30, i).map(b => b.l);
      const hi = Math.max(...highs);
      const lo = Math.min(...lows);

      if (btcDaily[i].h >= hi) {
        donchPos = { dir: "long", entry: btcDaily[i].o, entryT: dayT };
      } else if (btcDaily[i].l <= lo) {
        donchPos = { dir: "short", entry: btcDaily[i].o, entryT: dayT };
      }
    }

    if (!donchDailyPnl.has(dayT)) donchDailyPnl.set(dayT, 0);
  }

  // Compute correlation between residual MR and Donchian daily PnLs
  if (takerResult) {
    const commonDays = [...takerResult.dailyPnls.keys()]
      .filter(t => donchDailyPnl.has(t) && t >= OOS_START)
      .sort((a, b) => a - b);

    const mrPnls = commonDays.map(t => takerResult!.dailyPnls.get(t) ?? 0);
    const donchPnls = commonDays.map(t => donchDailyPnl.get(t) ?? 0);

    const c = corr(mrPnls, donchPnls);
    console.log(`Common OOS days: ${commonDays.length}`);
    console.log(`Daily PnL correlation (OOS): ${c.toFixed(4)}`);
    console.log(`Interpretation: ${Math.abs(c) < 0.1 ? "VERY LOW - excellent diversification" : Math.abs(c) < 0.2 ? "LOW - good diversification" : Math.abs(c) < 0.3 ? "MODERATE - some diversification" : "HIGH - limited diversification"}`);

    // Full period correlation too
    const commonDaysFull = [...takerResult.dailyPnls.keys()]
      .filter(t => donchDailyPnl.has(t))
      .sort((a, b) => a - b);
    const mrPnlsFull = commonDaysFull.map(t => takerResult!.dailyPnls.get(t) ?? 0);
    const donchPnlsFull = commonDaysFull.map(t => donchDailyPnl.get(t) ?? 0);
    const cFull = corr(mrPnlsFull, donchPnlsFull);
    console.log(`Daily PnL correlation (Full): ${cFull.toFixed(4)}`);

    // Ensemble stats
    console.log("\n--- Ensemble (MR + Donchian) OOS ---");
    const ensemblePnls = commonDays.map(t => (takerResult!.dailyPnls.get(t) ?? 0) + (donchDailyPnl.get(t) ?? 0));
    const ensembleSharpe = std(ensemblePnls) > 0 ? (mean(ensemblePnls) / std(ensemblePnls)) * Math.sqrt(365) : 0;
    const ensembleTotal = ensemblePnls.reduce((a, b) => a + b, 0);
    console.log(`Ensemble OOS PnL: $${ensembleTotal.toFixed(0)}`);
    console.log(`Ensemble OOS Sharpe: ${ensembleSharpe.toFixed(2)}`);
    console.log(`Ensemble OOS $/day: $${(ensembleTotal / commonDays.length).toFixed(2)}`);

    // Individual for comparison
    const mrOosTotal = mrPnls.reduce((a, b) => a + b, 0);
    const donchOosTotal = donchPnls.reduce((a, b) => a + b, 0);
    const mrOosSharpe = std(mrPnls) > 0 ? (mean(mrPnls) / std(mrPnls)) * Math.sqrt(365) : 0;
    const donchOosSharpe = std(donchPnls) > 0 ? (mean(donchPnls) / std(donchPnls)) * Math.sqrt(365) : 0;
    console.log(`\nMR alone    - PnL: $${mrOosTotal.toFixed(0)}, Sharpe: ${mrOosSharpe.toFixed(2)}`);
    console.log(`Donchian alone - PnL: $${donchOosTotal.toFixed(0)}, Sharpe: ${donchOosSharpe.toFixed(2)}`);
  }

  // ── Summary table ─────────────────────────────────────────────────────
  console.log("\n=== ALL RESULTS SUMMARY (sorted by OOS Sharpe) ===\n");
  console.log("Config          | FULL: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD | OOS: Trades   PF  Sharpe  WR%    PnL   $/day  MaxDD");
  console.log("-".repeat(135));

  for (const r of [...results].sort((a, b) => b.oosSharpe - a.oosSharpe)) {
    printRow(r);
  }
}

function printRow(r: Result) {
  const fmt = (n: number, d: number = 0) => n.toFixed(d);
  const fmtPnl = (n: number) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(0);

  console.log(
    `${r.label.padEnd(8)} | FULL: ${String(r.fullTrades).padStart(5)}  ${fmt(r.fullPF, 2).padStart(5)}  ${fmt(r.fullSharpe, 2).padStart(6)}  ${(r.fullWR * 100).toFixed(0).padStart(3)}%  ${fmtPnl(r.fullPnl).padStart(7)}  ${("$" + fmt(r.fullPerDay, 2)).padStart(6)}  ${("$" + fmt(r.fullMaxDD, 0)).padStart(5)} | OOS: ${String(r.oosTrades).padStart(5)}  ${fmt(r.oosPF, 2).padStart(5)}  ${fmt(r.oosSharpe, 2).padStart(6)}  ${(r.oosWR * 100).toFixed(0).padStart(3)}%  ${fmtPnl(r.oosPnl).padStart(7)}  ${("$" + fmt(r.oosPerDay, 2)).padStart(6)}  ${("$" + fmt(r.oosMaxDD, 0)).padStart(5)}`
  );
}

main();
