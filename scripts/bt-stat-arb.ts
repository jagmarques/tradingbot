import * as fs from "fs";
import * as path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────
interface Candle { t: number; o: number; h: number; l: number; c: number }
interface Trade { pnl: number; et: number; xt: number; pair: string; dir: "long" | "short"; sz: number }
interface Stats {
  trades: number; wins: number; pf: number; sharpe: number; totalPnl: number;
  wr: number; perDay: number; maxDd: number; dailyPnls: number[];
}

// ─── Config ──────────────────────────────────────────────────────────────────
const CACHE = "/tmp/bt-pair-cache-5m";
const H = 3600000;
const DAY = 86400000;
const FEE = 0.00035;
const LEV = 10;
const SL_SLIP = 1.5;
const MARGIN = 5; // $5 per side
const OOS_START = new Date("2025-09-01").getTime();

const PAIRS = [
  "ADA", "APT", "ARB", "DASH", "DOGE", "DOT", "ENA", "ETH",
  "LDO", "LINK", "OP", "SOL", "TIA", "TRUMP", "UNI", "WIF", "WLD", "XRP"
];

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4,
  WLDUSDT: 4e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4,
  LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
  ETHUSDT: 0.8e-4, SOLUSDT: 1.2e-4, TIAUSDT: 4.5e-4,
};

// ─── Data Loading ────────────────────────────────────────────────────────────
function load5m(pair: string): Candle[] {
  const f = path.join(CACHE, pair + "USDT.json");
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
  );
}

function agg1h(candles5m: Candle[]): Candle[] {
  const map = new Map<number, Candle[]>();
  for (const c of candles5m) {
    const hKey = Math.floor(c.t / H) * H;
    if (!map.has(hKey)) map.set(hKey, []);
    map.get(hKey)!.push(c);
  }
  const out: Candle[] = [];
  for (const [t, bars] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 10) continue; // need at least 10 of 12 bars
    out.push({
      t,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return out;
}

// ─── Data Store ──────────────────────────────────────────────────────────────
console.log("Loading and aggregating candle data...");
const pairData = new Map<string, Candle[]>();
const pairIdx = new Map<string, Map<number, number>>();

for (const p of [...PAIRS, "BTC"]) {
  const raw = load5m(p);
  const hourly = agg1h(raw);
  pairData.set(p, hourly);
  const idx = new Map<number, number>();
  hourly.forEach((c, i) => idx.set(c.t, i));
  pairIdx.set(p, idx);
}

const btcCandles = pairData.get("BTC")!;
const btcIdx = pairIdx.get("BTC")!;

// Common timestamps where all pairs have data
const allTs = new Set<number>();
for (const c of btcCandles) allTs.add(c.t);

// Global time range
const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = btcCandles[btcCandles.length - 1].t;

console.log(`BTC candles: ${btcCandles.length}, range: ${new Date(btcCandles[0].t).toISOString().slice(0, 10)} to ${new Date(FULL_END).toISOString().slice(0, 10)}`);
console.log(`Pairs: ${PAIRS.length}, OOS from: 2025-09-01\n`);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function spread(pair: string): number {
  return SP[pair + "USDT"] ?? 4e-4;
}

function entryCost(pair: string, dir: "long" | "short", price: number): number {
  const sp = spread(pair);
  const slippage = dir === "long" ? price * (1 + sp) : price * (1 - sp);
  return slippage;
}

function exitCost(pair: string, dir: "long" | "short", price: number, isStop: boolean): number {
  const sp = spread(pair) * (isStop ? SL_SLIP : 1);
  return dir === "long" ? price * (1 - sp) : price * (1 + sp);
}

function tradePnl(pair: string, dir: "long" | "short", entryPrice: number, exitPrice: number, margin: number, isStop: boolean): number {
  const ep = entryCost(pair, dir, entryPrice);
  const xp = exitCost(pair, dir, exitPrice, isStop);
  const raw = dir === "long"
    ? (xp / ep - 1) * margin * LEV
    : (ep / xp - 1) * margin * LEV;
  const fees = margin * LEV * FEE * 2;
  return raw - fees;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function calcStats(trades: Trade[], startT: number, endT: number): Stats {
  const filtered = trades.filter(t => t.et >= startT && t.et < endT);
  const days = (endT - startT) / DAY;
  const totalPnl = filtered.reduce((s, t) => s + t.pnl, 0);
  const wins = filtered.filter(t => t.pnl > 0).length;
  const grossWin = filtered.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(filtered.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  // Daily PnL for Sharpe
  const dayMap = new Map<number, number>();
  for (const t of filtered) {
    const dayKey = Math.floor(t.xt / DAY) * DAY;
    dayMap.set(dayKey, (dayMap.get(dayKey) || 0) + t.pnl);
  }
  const dailyPnls: number[] = [];
  for (let d = Math.floor(startT / DAY) * DAY; d < endT; d += DAY) {
    dailyPnls.push(dayMap.get(d) || 0);
  }
  const avgDaily = mean(dailyPnls);
  const stdDaily = stdDev(dailyPnls);
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(365) : 0;

  // MaxDD
  let cum = 0, peak = 0, maxDd = 0;
  for (const t of filtered) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }

  return {
    trades: filtered.length,
    wins,
    pf,
    sharpe,
    totalPnl,
    wr: filtered.length > 0 ? (wins / filtered.length) * 100 : 0,
    perDay: totalPnl / days,
    maxDd,
    dailyPnls,
  };
}

function printStats(label: string, s: Stats): void {
  console.log(
    `  ${label.padEnd(8)} | Trades: ${String(s.trades).padStart(5)} | PF: ${s.pf.toFixed(2).padStart(5)} | Sharpe: ${s.sharpe.toFixed(2).padStart(6)} | PnL: ${(s.totalPnl >= 0 ? "+" : "") + "$" + s.totalPnl.toFixed(2).padStart(8)} | WR: ${s.wr.toFixed(1).padStart(5)}% | $/day: ${(s.totalPnl >= 0 ? "+" : "") + "$" + s.perDay.toFixed(2).padStart(6)} | MaxDD: $${s.maxDd.toFixed(2)}`
  );
}

// ─── Get price at timestamp for a pair ───────────────────────────────────────
function priceAt(pair: string, t: number): number | null {
  const idx = pairIdx.get(pair);
  const data = pairData.get(pair);
  if (!idx || !data) return null;
  const i = idx.get(t);
  if (i === undefined) return null;
  return data[i].c;
}

function closePriceSeries(pair: string): { t: number; c: number }[] {
  const data = pairData.get(pair);
  if (!data) return [];
  return data.map(c => ({ t: c.t, c: c.c }));
}

// ─── STRATEGY 1: Pairs Trading (Cointegration) ──────────────────────────────
function strategyPairsTrading(): Trade[] {
  console.log("  Computing cointegration for all pair combinations...");
  const trades: Trade[] = [];

  // Step 1: Find most cointegrated pairs using Engle-Granger on full IS period
  // Use first 60% of data for cointegration testing
  const testEnd = OOS_START;
  const testStart = FULL_START;

  interface PairCoint { a: string; b: string; adfStat: number }
  const cointResults: PairCoint[] = [];

  for (let i = 0; i < PAIRS.length; i++) {
    for (let j = i + 1; j < PAIRS.length; j++) {
      const a = PAIRS[i], b = PAIRS[j];
      const dataA = pairData.get(a), dataB = pairData.get(b);
      if (!dataA || !dataB) continue;

      // Get aligned prices in test window
      const pricesA: number[] = [], pricesB: number[] = [];
      for (const ca of dataA) {
        if (ca.t < testStart || ca.t >= testEnd) continue;
        const pb = priceAt(b, ca.t);
        if (pb !== null) {
          pricesA.push(ca.c);
          pricesB.push(pb);
        }
      }
      if (pricesA.length < 500) continue;

      // Simple OLS: regress A on B -> residual
      const mA = mean(pricesA), mB = mean(pricesB);
      let num = 0, den = 0;
      for (let k = 0; k < pricesA.length; k++) {
        num += (pricesB[k] - mB) * (pricesA[k] - mA);
        den += (pricesB[k] - mB) ** 2;
      }
      if (den === 0) continue;
      const beta = num / den;
      const alpha = mA - beta * mB;

      // Compute residuals
      const residuals = pricesA.map((pa, k) => pa - alpha - beta * pricesB[k]);

      // ADF test (simplified Dickey-Fuller): regress delta_resid on lagged resid
      const dResid: number[] = [], lagResid: number[] = [];
      for (let k = 1; k < residuals.length; k++) {
        dResid.push(residuals[k] - residuals[k - 1]);
        lagResid.push(residuals[k - 1]);
      }
      const mD = mean(dResid), mL = mean(lagResid);
      let numAdf = 0, denAdf = 0;
      for (let k = 0; k < dResid.length; k++) {
        numAdf += (lagResid[k] - mL) * (dResid[k] - mD);
        denAdf += (lagResid[k] - mL) ** 2;
      }
      if (denAdf === 0) continue;
      const gamma = numAdf / denAdf;
      // SE of gamma
      const fitted = lagResid.map(l => mD + gamma * (l - mL));
      const ssResid = dResid.reduce((s, d, k) => s + (d - fitted[k]) ** 2, 0) / (dResid.length - 2);
      const seGamma = Math.sqrt(ssResid / denAdf);
      if (seGamma === 0) continue;
      const adfStat = gamma / seGamma;

      cointResults.push({ a, b, adfStat });
    }
  }

  // Sort by most negative ADF stat (most cointegrated)
  cointResults.sort((x, y) => x.adfStat - y.adfStat);
  const topPairs = cointResults.slice(0, 10);

  console.log("  Top 10 cointegrated pairs:");
  for (const p of topPairs) {
    console.log(`    ${p.a}/${p.b}: ADF = ${p.adfStat.toFixed(2)}`);
  }

  // Step 2: Trade each pair
  const WINDOW = 60 * 24; // 60 days in 1h bars
  const MAX_HOLD = 48; // 48 hours

  for (const { a, b } of topPairs) {
    const dataA = pairData.get(a)!, dataB = pairData.get(b)!;
    const idxA = pairIdx.get(a)!, idxB = pairIdx.get(b)!;

    // Build aligned time series
    const aligned: { t: number; ia: number; ib: number }[] = [];
    for (const ca of dataA) {
      if (ca.t < FULL_START) continue;
      const ib = idxB.get(ca.t);
      const ia = idxA.get(ca.t);
      if (ib !== undefined && ia !== undefined) {
        aligned.push({ t: ca.t, ia, ib });
      }
    }

    // Position tracking
    let inTrade = false;
    let tradeDir: "long_a_short_b" | "short_a_long_b" = "long_a_short_b";
    let entryA = 0, entryB = 0, entryT = 0;

    for (let k = WINDOW; k < aligned.length; k++) {
      const { t, ia, ib } = aligned[k];
      const prA = dataA[ia].c, prB = dataB[ib].c;

      // Compute rolling spread ratio and z-score
      const ratios: number[] = [];
      for (let w = k - WINDOW; w <= k; w++) {
        const wa = dataA[aligned[w].ia].c;
        const wb = dataB[aligned[w].ib].c;
        if (wb > 0) ratios.push(wa / wb);
      }
      if (ratios.length < WINDOW * 0.8) continue;

      const mR = mean(ratios);
      const sR = stdDev(ratios);
      if (sR === 0) continue;
      const z = (prA / prB - mR) / sR;

      if (inTrade) {
        const holdHours = (t - entryT) / H;
        // Exit on mean reversion (z crosses 0) or max hold
        const shouldExit =
          (tradeDir === "short_a_long_b" && z <= 0) ||
          (tradeDir === "long_a_short_b" && z >= 0) ||
          holdHours >= MAX_HOLD;

        if (shouldExit) {
          const isStop = holdHours >= MAX_HOLD;
          // Close both legs
          if (tradeDir === "short_a_long_b") {
            // Was: short A, long B. Close: buy A, sell B
            const pnlA = tradePnl(a, "short", entryA, prA, MARGIN, isStop);
            const pnlB = tradePnl(b, "long", entryB, prB, MARGIN, isStop);
            trades.push({ pnl: pnlA, et: entryT, xt: t, pair: `${a}/${b}`, dir: "short", sz: MARGIN });
            trades.push({ pnl: pnlB, et: entryT, xt: t, pair: `${b}/${a}`, dir: "long", sz: MARGIN });
          } else {
            const pnlA = tradePnl(a, "long", entryA, prA, MARGIN, isStop);
            const pnlB = tradePnl(b, "short", entryB, prB, MARGIN, isStop);
            trades.push({ pnl: pnlA, et: entryT, xt: t, pair: `${a}/${b}`, dir: "long", sz: MARGIN });
            trades.push({ pnl: pnlB, et: entryT, xt: t, pair: `${b}/${a}`, dir: "short", sz: MARGIN });
          }
          inTrade = false;
        }
      }

      if (!inTrade) {
        if (z > 2) {
          // A overperforming B -> short A, long B
          tradeDir = "short_a_long_b";
          entryA = prA;
          entryB = prB;
          entryT = t;
          inTrade = true;
        } else if (z < -2) {
          // B overperforming A -> long A, short B
          tradeDir = "long_a_short_b";
          entryA = prA;
          entryB = prB;
          entryT = t;
          inTrade = true;
        }
      }
    }
  }

  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ─── STRATEGY 2: Cross-Sectional Momentum ───────────────────────────────────
function strategyCrossMomentum(): Trade[] {
  const trades: Trade[] = [];
  const HOLD_H = 24;
  const REBAL_H = 4; // rebalance every 4h
  const LOOKBACK_H = 24; // 24h return

  // Get all timestamps where we can trade
  const btc = pairData.get("BTC")!;
  const timestamps = btc.filter(c => c.t >= FULL_START).map(c => c.t);

  interface Pos { pair: string; dir: "long" | "short"; entry: number; entryT: number }
  let positions: Pos[] = [];
  let lastRebal = 0;

  for (const t of timestamps) {
    // Check if we should close existing positions (held 24h)
    const toClose = positions.filter(p => t - p.entryT >= HOLD_H * H);
    for (const pos of toClose) {
      const price = priceAt(pos.pair, t);
      if (price === null) continue;
      const pnl = tradePnl(pos.pair, pos.dir, pos.entry, price, MARGIN, false);
      trades.push({ pnl, et: pos.entryT, xt: t, pair: pos.pair, dir: pos.dir, sz: MARGIN });
    }
    positions = positions.filter(p => t - p.entryT < HOLD_H * H);

    // Rebalance every 4h
    if (t - lastRebal < REBAL_H * H) continue;
    lastRebal = t;

    // Rank pairs by 24h return
    const returns: { pair: string; ret: number }[] = [];
    for (const p of PAIRS) {
      const data = pairData.get(p);
      const idx = pairIdx.get(p);
      if (!data || !idx) continue;
      const i = idx.get(t);
      if (i === undefined || i < LOOKBACK_H) continue;
      // Find price 24h ago
      const targetT = t - LOOKBACK_H * H;
      const prevI = idx.get(targetT);
      if (prevI === undefined) continue;
      const ret = data[i].c / data[prevI].c - 1;
      returns.push({ pair: p, ret });
    }
    if (returns.length < 6) continue;

    returns.sort((a, b) => b.ret - a.ret);
    const top3 = returns.slice(0, 3);
    const bot3 = returns.slice(-3);

    // Don't open duplicate positions
    const openPairs = new Set(positions.map(p => p.pair + p.dir));

    for (const { pair } of top3) {
      if (openPairs.has(pair + "long")) continue;
      const price = priceAt(pair, t);
      if (price === null) continue;
      positions.push({ pair, dir: "long", entry: price, entryT: t });
    }
    for (const { pair } of bot3) {
      if (openPairs.has(pair + "short")) continue;
      const price = priceAt(pair, t);
      if (price === null) continue;
      positions.push({ pair, dir: "short", entry: price, entryT: t });
    }
  }

  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ─── STRATEGY 3: Cross-Sectional Mean Reversion (Intraday) ──────────────────
function strategyCrossMeanRev(): Trade[] {
  const trades: Trade[] = [];
  const HOLD_H = 4;
  const REBAL_H = 4;

  const btc = pairData.get("BTC")!;
  const timestamps = btc.filter(c => c.t >= FULL_START).map(c => c.t);

  interface Pos { pair: string; dir: "long" | "short"; entry: number; entryT: number }
  let positions: Pos[] = [];
  let lastRebal = 0;

  for (const t of timestamps) {
    // Close positions held >= 4h
    const toClose = positions.filter(p => t - p.entryT >= HOLD_H * H);
    for (const pos of toClose) {
      const price = priceAt(pos.pair, t);
      if (price === null) continue;
      const pnl = tradePnl(pos.pair, pos.dir, pos.entry, price, MARGIN, false);
      trades.push({ pnl, et: pos.entryT, xt: t, pair: pos.pair, dir: pos.dir, sz: MARGIN });
    }
    positions = positions.filter(p => t - p.entryT < HOLD_H * H);

    if (t - lastRebal < REBAL_H * H) continue;
    lastRebal = t;

    // Rank by 4h return
    const returns: { pair: string; ret: number }[] = [];
    for (const p of PAIRS) {
      const idx = pairIdx.get(p);
      const data = pairData.get(p);
      if (!idx || !data) continue;
      const i = idx.get(t);
      if (i === undefined || i < 4) continue;
      const targetT = t - HOLD_H * H;
      const prevI = idx.get(targetT);
      if (prevI === undefined) continue;
      const ret = data[i].c / data[prevI].c - 1;
      returns.push({ pair: p, ret });
    }
    if (returns.length < 6) continue;

    returns.sort((a, b) => b.ret - a.ret);
    const top3 = returns.slice(0, 3); // overperformers -> short
    const bot3 = returns.slice(-3); // underperformers -> long

    const openPairs = new Set(positions.map(p => p.pair + p.dir));

    // Mean reversion: short winners, long losers
    for (const { pair } of top3) {
      if (openPairs.has(pair + "short")) continue;
      const price = priceAt(pair, t);
      if (price === null) continue;
      positions.push({ pair, dir: "short", entry: price, entryT: t });
    }
    for (const { pair } of bot3) {
      if (openPairs.has(pair + "long")) continue;
      const price = priceAt(pair, t);
      if (price === null) continue;
      positions.push({ pair, dir: "long", entry: price, entryT: t });
    }
  }

  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ─── STRATEGY 4: Beta-Adjusted Pairs ────────────────────────────────────────
function strategyBetaAdjusted(): Trade[] {
  const trades: Trade[] = [];
  const BETA_WINDOW = 30 * 24; // 30 days in 1h bars
  const HOLD_H = 24;
  const REBAL_H = 24;

  const btc = pairData.get("BTC")!;
  const btcI = pairIdx.get("BTC")!;
  const timestamps = btc.filter(c => c.t >= FULL_START).map(c => c.t);

  interface Pos { pair: string; dir: "long" | "short"; entry: number; entryT: number }
  let positions: Pos[] = [];
  let lastRebal = 0;

  for (const t of timestamps) {
    // Close held positions
    const toClose = positions.filter(p => t - p.entryT >= HOLD_H * H);
    for (const pos of toClose) {
      const price = priceAt(pos.pair, t);
      if (price === null) continue;
      const pnl = tradePnl(pos.pair, pos.dir, pos.entry, price, MARGIN, false);
      trades.push({ pnl, et: pos.entryT, xt: t, pair: pos.pair, dir: pos.dir, sz: MARGIN });
    }
    positions = positions.filter(p => t - p.entryT < HOLD_H * H);

    if (t - lastRebal < REBAL_H * H) continue;
    lastRebal = t;

    const bi = btcI.get(t);
    if (bi === undefined || bi < BETA_WINDOW + 1) continue;

    // BTC 24h return
    const btcNow = btc[bi].c;
    const btcPrevT = t - 24 * H;
    const btcPrevI = btcI.get(btcPrevT);
    if (btcPrevI === undefined) continue;
    const btcRet = btcNow / btc[btcPrevI].c - 1;

    // Compute beta and alpha residual for each pair
    const alphas: { pair: string; alpha: number }[] = [];

    for (const p of PAIRS) {
      const data = pairData.get(p);
      const idx = pairIdx.get(p);
      if (!data || !idx) continue;
      const pi = idx.get(t);
      if (pi === undefined || pi < BETA_WINDOW + 1) continue;

      // Compute rolling beta (30-day hourly returns)
      const pairRets: number[] = [], btcRets: number[] = [];
      for (let w = 1; w <= BETA_WINDOW; w++) {
        const tW = aligned(t, w, idx, data);
        const tW1 = aligned(t, w + 1, idx, data);
        const bW = aligned(t, w, btcI, btc);
        const bW1 = aligned(t, w + 1, btcI, btc);
        if (tW !== null && tW1 !== null && bW !== null && bW1 !== null) {
          pairRets.push(tW / tW1 - 1);
          btcRets.push(bW / bW1 - 1);
        }
      }
      if (pairRets.length < BETA_WINDOW * 0.5) continue;

      const mP = mean(pairRets), mB = mean(btcRets);
      let cov = 0, varB = 0;
      for (let k = 0; k < pairRets.length; k++) {
        cov += (pairRets[k] - mP) * (btcRets[k] - mB);
        varB += (btcRets[k] - mB) ** 2;
      }
      if (varB === 0) continue;
      const beta = cov / varB;

      // Pair 24h return
      const pairPrevT = t - 24 * H;
      const pairPrevI = idx.get(pairPrevT);
      if (pairPrevI === undefined) continue;
      const pairRet = data[pi].c / data[pairPrevI].c - 1;

      const expectedRet = beta * btcRet;
      const alphaResidual = pairRet - expectedRet;
      alphas.push({ pair: p, alpha: alphaResidual });
    }

    if (alphas.length < 6) continue;
    alphas.sort((a, b) => a.alpha - b.alpha);

    const mostNeg = alphas.slice(0, 3); // underperformed -> long
    const mostPos = alphas.slice(-3); // overperformed -> short

    const openPairs = new Set(positions.map(p => p.pair + p.dir));

    for (const { pair } of mostNeg) {
      if (openPairs.has(pair + "long")) continue;
      const price = priceAt(pair, t);
      if (price === null) continue;
      positions.push({ pair, dir: "long", entry: price, entryT: t });
    }
    for (const { pair } of mostPos) {
      if (openPairs.has(pair + "short")) continue;
      const price = priceAt(pair, t);
      if (price === null) continue;
      positions.push({ pair, dir: "short", entry: price, entryT: t });
    }
  }

  trades.sort((a, b) => a.et - b.et);
  return trades;
}

function aligned(t: number, offset: number, idx: Map<number, number>, data: Candle[]): number | null {
  const tTarget = t - offset * H;
  const i = idx.get(tTarget);
  if (i === undefined) return null;
  return data[i].c;
}

// ─── STRATEGY 5: Correlation Breakdown ──────────────────────────────────────
function strategyCorrelationBreakdown(): Trade[] {
  const trades: Trade[] = [];
  const CORR_WINDOW = 20 * 24; // 20 days
  const CORR_AVG_WINDOW = 60 * 24; // 60 days
  const MAX_HOLD_H = 48;

  const btc = pairData.get("BTC")!;
  const btcI = pairIdx.get("BTC")!;
  const timestamps = btc.filter(c => c.t >= FULL_START).map(c => c.t);

  interface Pos { pair: string; dir: "long" | "short"; entry: number; entryT: number }
  const positions = new Map<string, Pos>();

  // Cache correlations
  function rollingCorr(pair: string, t: number, window: number): number | null {
    const data = pairData.get(pair);
    const idx = pairIdx.get(pair);
    if (!data || !idx) return null;

    const pRets: number[] = [], bRets: number[] = [];
    for (let w = 0; w < window - 1; w++) {
      const t1 = t - w * H, t2 = t - (w + 1) * H;
      const pi1 = idx.get(t1), pi2 = idx.get(t2);
      const bi1 = btcI.get(t1), bi2 = btcI.get(t2);
      if (pi1 === undefined || pi2 === undefined || bi1 === undefined || bi2 === undefined) continue;
      pRets.push(data[pi1].c / data[pi2].c - 1);
      bRets.push(btc[bi1].c / btc[bi2].c - 1);
    }
    if (pRets.length < window * 0.5) return null;

    const mP = mean(pRets), mB = mean(bRets);
    let cov = 0, varP = 0, varB = 0;
    for (let k = 0; k < pRets.length; k++) {
      cov += (pRets[k] - mP) * (bRets[k] - mB);
      varP += (pRets[k] - mP) ** 2;
      varB += (bRets[k] - mB) ** 2;
    }
    const denom = Math.sqrt(varP * varB);
    if (denom === 0) return null;
    return cov / denom;
  }

  // Check every 4h to reduce compute
  let lastCheck = 0;

  for (const t of timestamps) {
    // Close expired positions
    for (const [key, pos] of positions) {
      if (t - pos.entryT >= MAX_HOLD_H * H) {
        const price = priceAt(pos.pair, t);
        if (price !== null) {
          const pnl = tradePnl(pos.pair, pos.dir, pos.entry, price, MARGIN, true);
          trades.push({ pnl, et: pos.entryT, xt: t, pair: pos.pair, dir: pos.dir, sz: MARGIN });
        }
        positions.delete(key);
      }
    }

    // Also check for mean-reversion exits every hour
    for (const [key, pos] of positions) {
      const corr = rollingCorr(pos.pair, t, CORR_WINDOW);
      if (corr !== null && corr > 0.7) {
        // Correlation restored -> exit
        const price = priceAt(pos.pair, t);
        if (price !== null) {
          const pnl = tradePnl(pos.pair, pos.dir, pos.entry, price, MARGIN, false);
          trades.push({ pnl, et: pos.entryT, xt: t, pair: pos.pair, dir: pos.dir, sz: MARGIN });
        }
        positions.delete(key);
      }
    }

    if (t - lastCheck < 4 * H) continue;
    lastCheck = t;

    for (const p of PAIRS) {
      if (positions.has(p)) continue;

      const corr20 = rollingCorr(p, t, CORR_WINDOW);
      if (corr20 === null) continue;

      // Rolling average and std of 20-day correlations over 60-day window
      // Sample correlations at several offsets
      const corrHistory: number[] = [];
      for (let off = 0; off < CORR_AVG_WINDOW; off += 24) { // sample daily
        const c = rollingCorr(p, t - off * H, CORR_WINDOW);
        if (c !== null) corrHistory.push(c);
      }
      if (corrHistory.length < 20) continue;

      const mCorr = mean(corrHistory);
      const sCorr = stdDev(corrHistory);
      if (sCorr === 0) continue;

      const zCorr = (corr20 - mCorr) / sCorr;

      if (zCorr < -1) {
        // Decoupling detected
        // Check if outperforming or underperforming BTC in last 24h
        const data = pairData.get(p);
        const idx = pairIdx.get(p);
        if (!data || !idx) continue;
        const pi = idx.get(t);
        const prevT = t - 24 * H;
        const prevI = idx.get(prevT);
        const bi = btcI.get(t);
        const bPrevI = btcI.get(prevT);
        if (pi === undefined || prevI === undefined || bi === undefined || bPrevI === undefined) continue;

        const pairRet = data[pi].c / data[prevI].c - 1;
        const btcRet = btc[bi].c / btc[bPrevI].c - 1;

        const price = priceAt(p, t);
        if (price === null) continue;

        if (pairRet > btcRet + 0.01) {
          // Outperforming -> short (divergence will revert)
          positions.set(p, { pair: p, dir: "short", entry: price, entryT: t });
        } else if (pairRet < btcRet - 0.01) {
          // Underperforming -> long
          positions.set(p, { pair: p, dir: "long", entry: price, entryT: t });
        }
      }
    }
  }

  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ─── SMA Cross Trend Proxy for Correlation ──────────────────────────────────
function trendProxyDailyPnls(): number[] {
  // Simple SMA 30/60 cross on all pairs, daily PnL
  const SMA_SHORT = 30;
  const SMA_LONG = 60;
  const dayPnlMap = new Map<number, number>();

  for (const p of PAIRS) {
    const data = pairData.get(p);
    if (!data) continue;

    const closes = data.map(c => c.c);
    let inTrade = false;
    let dir: "long" | "short" = "long";
    let entry = 0;
    let entryT = 0;

    for (let i = SMA_LONG; i < data.length; i++) {
      const smaS = mean(closes.slice(i - SMA_SHORT, i));
      const smaL = mean(closes.slice(i - SMA_LONG, i));
      const t = data[i].t;

      if (inTrade) {
        // Exit on cross
        const shouldExit =
          (dir === "long" && smaS < smaL) || (dir === "short" && smaS > smaL);
        if (shouldExit || (t - entryT >= 48 * H)) {
          const pnl = tradePnl(p, dir, entry, data[i].c, MARGIN, false);
          const dayKey = Math.floor(t / DAY) * DAY;
          dayPnlMap.set(dayKey, (dayPnlMap.get(dayKey) || 0) + pnl);
          inTrade = false;
        }
      }

      if (!inTrade) {
        if (smaS > smaL) {
          dir = "long";
          entry = data[i].c;
          entryT = t;
          inTrade = true;
        } else if (smaS < smaL) {
          dir = "short";
          entry = data[i].c;
          entryT = t;
          inTrade = true;
        }
      }
    }
  }

  // Convert to array sorted by day
  const days: number[] = [];
  for (let d = Math.floor(FULL_START / DAY) * DAY; d <= FULL_END; d += DAY) {
    days.push(dayPnlMap.get(d) || 0);
  }
  return days;
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 10) return 0;
  const mA = mean(a.slice(0, n)), mB = mean(b.slice(0, n));
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - mA) * (b[i] - mB);
    varA += (a[i] - mA) ** 2;
    varB += (b[i] - mB) ** 2;
  }
  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 0;
}

// ─── Run All Strategies ─────────────────────────────────────────────────────
console.log("=" .repeat(120));
console.log("STRATEGY 1: PAIRS TRADING (COINTEGRATION)");
console.log("=" .repeat(120));
const trades1 = strategyPairsTrading();
const stats1Full = calcStats(trades1, FULL_START, FULL_END);
const stats1OOS = calcStats(trades1, OOS_START, FULL_END);
printStats("FULL", stats1Full);
printStats("OOS", stats1OOS);

console.log("\n" + "=" .repeat(120));
console.log("STRATEGY 2: CROSS-SECTIONAL MOMENTUM (24h lookback, 24h hold)");
console.log("=" .repeat(120));
const trades2 = strategyCrossMomentum();
const stats2Full = calcStats(trades2, FULL_START, FULL_END);
const stats2OOS = calcStats(trades2, OOS_START, FULL_END);
printStats("FULL", stats2Full);
printStats("OOS", stats2OOS);

console.log("\n" + "=" .repeat(120));
console.log("STRATEGY 3: CROSS-SECTIONAL MEAN REVERSION (4h lookback, 4h hold)");
console.log("=" .repeat(120));
const trades3 = strategyCrossMeanRev();
const stats3Full = calcStats(trades3, FULL_START, FULL_END);
const stats3OOS = calcStats(trades3, OOS_START, FULL_END);
printStats("FULL", stats3Full);
printStats("OOS", stats3OOS);

console.log("\n" + "=" .repeat(120));
console.log("STRATEGY 4: BETA-ADJUSTED PAIRS (alpha residual, 24h rebalance)");
console.log("=" .repeat(120));
const trades4 = strategyBetaAdjusted();
const stats4Full = calcStats(trades4, FULL_START, FULL_END);
const stats4OOS = calcStats(trades4, OOS_START, FULL_END);
printStats("FULL", stats4Full);
printStats("OOS", stats4OOS);

console.log("\n" + "=" .repeat(120));
console.log("STRATEGY 5: CORRELATION BREAKDOWN (decoupling detector)");
console.log("=" .repeat(120));
const trades5 = strategyCorrelationBreakdown();
const stats5Full = calcStats(trades5, FULL_START, FULL_END);
const stats5OOS = calcStats(trades5, OOS_START, FULL_END);
printStats("FULL", stats5Full);
printStats("OOS", stats5OOS);

// ─── Trend Correlation ──────────────────────────────────────────────────────
console.log("\n" + "=" .repeat(120));
console.log("CORRELATION WITH TREND FOLLOWING (SMA 30/60 cross proxy)");
console.log("=" .repeat(120));

console.log("Computing trend proxy...");
const trendDaily = trendProxyDailyPnls();

const allStrats = [
  { name: "Pairs Trading", trades: trades1, stats: stats1Full },
  { name: "Cross Momentum", trades: trades2, stats: stats2Full },
  { name: "Cross MeanRev", trades: trades3, stats: stats3Full },
  { name: "Beta-Adjusted", trades: trades4, stats: stats4Full },
  { name: "Corr Breakdown", trades: trades5, stats: stats5Full },
];

for (const s of allStrats) {
  const corr = correlation(s.stats.dailyPnls, trendDaily.slice(0, s.stats.dailyPnls.length));
  console.log(`  ${s.name.padEnd(20)} vs Trend:  r = ${corr.toFixed(3)}`);
}

// ─── Cross-strategy correlations ─────────────────────────────────────────────
console.log("\n" + "=" .repeat(120));
console.log("CROSS-STRATEGY DAILY PNL CORRELATIONS");
console.log("=" .repeat(120));

for (let i = 0; i < allStrats.length; i++) {
  for (let j = i + 1; j < allStrats.length; j++) {
    const a = allStrats[i], b = allStrats[j];
    const n = Math.min(a.stats.dailyPnls.length, b.stats.dailyPnls.length);
    const corr = correlation(a.stats.dailyPnls.slice(0, n), b.stats.dailyPnls.slice(0, n));
    console.log(`  ${a.name.padEnd(20)} vs ${b.name.padEnd(20)}: r = ${corr.toFixed(3)}`);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log("\n" + "=" .repeat(120));
console.log("SUMMARY COMPARISON (OOS period: 2025-09-01 onwards)");
console.log("=" .repeat(120));
console.log(
  "Strategy".padEnd(30) +
  "Trades".padStart(7) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "PnL".padStart(12) +
  "WR%".padStart(7) +
  "$/day".padStart(8) +
  "MaxDD".padStart(10)
);
console.log("-".repeat(89));

const oosStats = [
  { name: "1. Pairs Trading", stats: stats1OOS },
  { name: "2. Cross Momentum", stats: stats2OOS },
  { name: "3. Cross MeanRev", stats: stats3OOS },
  { name: "4. Beta-Adjusted", stats: stats4OOS },
  { name: "5. Corr Breakdown", stats: stats5OOS },
];

for (const { name, stats: s } of oosStats) {
  console.log(
    name.padEnd(30) +
    String(s.trades).padStart(7) +
    s.pf.toFixed(2).padStart(7) +
    s.sharpe.toFixed(2).padStart(8) +
    ((s.totalPnl >= 0 ? "+$" : "-$") + Math.abs(s.totalPnl).toFixed(2)).padStart(12) +
    s.wr.toFixed(1).padStart(7) +
    ((s.perDay >= 0 ? "+$" : "-$") + Math.abs(s.perDay).toFixed(2)).padStart(8) +
    ("$" + s.maxDd.toFixed(2)).padStart(10)
  );
}

console.log("\nDone.");
