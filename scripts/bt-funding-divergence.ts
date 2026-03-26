/**
 * Cross-Venue Funding Divergence Backtest -- HL vs Binance
 *
 * Downloads Binance 8h funding rate history, merges with cached HL hourly funding,
 * computes annualised divergence, and tests 3 strategies:
 *
 *   A. Fade HL Overcrowding  (|div| > 50% ann, normalise < 20% or 72h max)
 *   B. Directional + Funding Income  (same as A, also tracks funding earned)
 *   C. Extreme Divergence Only  (|div| > 100% ann)
 *
 * Cost model: taker 0.035%, spread map, 10x lev, $5 margin
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const FUNDING_DIR = "/tmp/hl-funding";
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const BINANCE_CACHE_DIR = "/tmp/binance-funding";
const H = 3600_000;
const DAY = 86_400_000;
const FEE = 0.000_35; // 0.035% taker
const SIZE = 5; // $5 margin
const LEV = 10;
const NOT = SIZE * LEV; // $50 notional

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  ARB: 2.6e-4, APT: 3.2e-4, LINK: 3.45e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4,
};

const PAIRS = ["ETH", "SOL", "DOGE", "XRP", "LINK", "DOT", "ADA", "ARB", "WLD", "APT"];

// Map HL coin names to Binance symbol names
const BINANCE_SYMBOL: Record<string, string> = {
  ETH: "ETHUSDT", SOL: "SOLUSDT", DOGE: "DOGEUSDT", XRP: "XRPUSDT",
  LINK: "LINKUSDT", DOT: "DOTUSDT", ADA: "ADAUSDT", ARB: "ARBUSDT",
  WLD: "WLDUSDT", APT: "APTUSDT",
};

const DL_START = new Date("2024-01-01").getTime();
const FULL_START = new Date("2024-03-01").getTime(); // 2 months warmup
const OOS_START = new Date("2025-09-01").getTime();
const END = new Date("2026-03-26").getTime();

const MAX_HOLD_H = 72; // 72 hours max hold
const ENTRY_DIV_ANN = 0.50; // 50% annualised divergence threshold
const EXIT_DIV_ANN = 0.20; // normalise below 20% to exit
const EXTREME_DIV_ANN = 1.00; // 100% annualised for Strategy C

// ─── Types ──────────────────────────────────────────────────────────
interface FR { coin: string; fundingRate: string; premium: string; time: number; }
interface BinanceFR { symbol: string; fundingRate: string; fundingTime: number; markPrice: string; }
interface Candle { t: number; o: number; h: number; l: number; c: number; }
interface HourlyBar { t: number; o: number; h: number; l: number; c: number; hlFunding: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pricePnl: number; fundingPnl: number; totalPnl: number;
  entryDiv: number; exitDiv: number; holdH: number;
}
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number; dd: number;
  total: number; perDay: number; avgFundPnl: number; avgHoldH: number;
}
interface DivergencePoint {
  t: number; // Binance funding timestamp
  hlAvg8h: number; // HL avg hourly funding over 8h period
  binRate: number; // Binance 8h funding rate
  hlAnn: number; // HL annualised
  binAnn: number; // Binance annualised
  divAnn: number; // divergence annualised (HL - Binance)
}

// ─── Step 1: Download Binance Funding Rate History ──────────────────
async function downloadBinanceFunding(symbol: string): Promise<BinanceFR[]> {
  if (!fs.existsSync(BINANCE_CACHE_DIR)) fs.mkdirSync(BINANCE_CACHE_DIR, { recursive: true });
  const cacheFile = path.join(BINANCE_CACHE_DIR, `${symbol}.json`);

  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    // Use cache if less than 12h old
    if (Date.now() - stat.mtimeMs < 12 * H) {
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      return data;
    }
  }

  console.log(`  Downloading Binance funding for ${symbol}...`);
  const all: BinanceFR[] = [];
  let startTime = DL_START;

  while (startTime < Date.now()) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&limit=1000`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`    ${symbol} Binance API error: ${resp.status}`);
      break;
    }
    const batch: BinanceFR[] = await resp.json() as BinanceFR[];
    if (batch.length === 0) break;
    all.push(...batch);
    startTime = batch[batch.length - 1].fundingTime + 1;

    if (batch.length < 1000) break;
    await new Promise(r => setTimeout(r, 200));
  }

  if (all.length > 0) {
    fs.writeFileSync(cacheFile, JSON.stringify(all));
  }
  console.log(`    ${symbol}: ${all.length} Binance funding records`);
  return all;
}

// ─── Step 2: Load HL Funding (cached) ──────────────────────────────
function loadHLFunding(coin: string): FR[] {
  const fp = path.join(FUNDING_DIR, `${coin}_funding.json`);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

// ─── Step 3: Load & Aggregate Price Data ────────────────────────────
function load5m(pair: string): Candle[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c,
  })).sort((a: Candle, b: Candle) => a.t - b.t);
}

function aggregateToHourly(candles: Candle[]): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const c of candles) {
    const hourTs = Math.floor(c.t / H) * H;
    const arr = groups.get(hourTs) ?? [];
    arr.push(c);
    groups.set(hourTs, arr);
  }
  const hourly: Candle[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 8) continue;
    hourly.push({
      t: ts, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return hourly;
}

// ─── Build Hourly Bars with HL Funding ─────────────────────────────
function buildHourlyBars(pair: string, funding: FR[], candles: Candle[]): HourlyBar[] {
  const hourlyCandles = aggregateToHourly(candles);
  const fundingMap = new Map<number, number>();
  for (const f of funding) {
    const hTs = Math.floor(f.time / H) * H;
    fundingMap.set(hTs, parseFloat(f.fundingRate));
  }
  return hourlyCandles.map(c => ({
    ...c,
    hlFunding: fundingMap.get(c.t) ?? 0,
  }));
}

// ─── Step 3: Merge and Find Divergence Events ──────────────────────
function buildDivergenceSeries(
  hlFunding: FR[],
  binanceFunding: BinanceFR[],
): DivergencePoint[] {
  // Build HL hourly funding map
  const hlMap = new Map<number, number>();
  for (const f of hlFunding) {
    const hTs = Math.floor(f.time / H) * H;
    hlMap.set(hTs, parseFloat(f.fundingRate));
  }

  const points: DivergencePoint[] = [];

  for (const bf of binanceFunding) {
    const binTs = bf.fundingTime;
    const binRate = parseFloat(bf.fundingRate);

    // Average HL hourly funding over the 8h period ending at this Binance timestamp
    // Binance funding is settled every 8h (00:00, 08:00, 16:00 UTC)
    // The rate covers the preceding 8h
    const periodEnd = Math.floor(binTs / H) * H;
    const periodStart = periodEnd - 8 * H;

    let hlSum = 0;
    let hlCount = 0;
    for (let t = periodStart; t < periodEnd; t += H) {
      const rate = hlMap.get(t);
      if (rate !== undefined) {
        hlSum += rate;
        hlCount++;
      }
    }

    if (hlCount < 4) continue; // Need at least 4 of 8 hours of data

    const hlAvg8h = hlSum; // Sum of hourly rates over 8h period (not average -- this IS the 8h equivalent)

    // Annualise: Binance 8h rate * 3 * 365 (3 settlements per day)
    const binAnn = binRate * 3 * 365;
    // HL: sum of hourly rates over 8h, so per day it's sum * 3, annualised * 365
    const hlAnn = hlAvg8h * 3 * 365;

    const divAnn = hlAnn - binAnn;

    points.push({ t: binTs, hlAvg8h, binRate, hlAnn, binAnn, divAnn });
  }

  return points.sort((a, b) => a.t - b.t);
}

// ─── Cost Helpers ───────────────────────────────────────────────────
function roundTripCost(pair: string): number {
  const sp = SPREAD[pair] ?? 4e-4;
  return NOT * FEE * 2 + NOT * sp * 2;
}

// ─── Metrics Calculation ────────────────────────────────────────────
function calcMetrics(trades: Trade[], startMs: number, endMs: number): Metrics {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, avgFundPnl: 0, avgHoldH: 0 };

  const wins = trades.filter(t => t.totalPnl > 0);
  const losses = trades.filter(t => t.totalPnl <= 0);
  const wr = (wins.length / n) * 100;
  const grossWin = wins.reduce((s, t) => s + t.totalPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.totalPnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const total = trades.reduce((s, t) => s + t.totalPnl, 0);
  const days = (endMs - startMs) / DAY;
  const perDay = total / days;

  // Sharpe from daily returns
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.totalPnl);
  }
  const dr = [...dailyPnl.values()];
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  // MaxDD
  let cum = 0, peak = 0, dd = 0;
  for (const t of trades.sort((a, b) => a.xt - b.xt)) {
    cum += t.totalPnl;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }

  const avgFundPnl = trades.reduce((s, t) => s + t.fundingPnl, 0) / n;
  const avgHoldH = trades.reduce((s, t) => s + t.holdH, 0) / n;

  return { n, wr, pf, sharpe, dd, total, perDay, avgFundPnl, avgHoldH };
}

// ─── Strategy Runner ────────────────────────────────────────────────
function runStrategy(
  pair: string,
  divSeries: DivergencePoint[],
  hourlyBars: HourlyBar[],
  entryThreshold: number, // annualised divergence threshold for entry
  exitThreshold: number, // annualised divergence threshold for exit
  maxHoldHours: number,
  trackFunding: boolean,
  startMs: number,
  endMs: number,
): Trade[] {
  const trades: Trade[] = [];
  const barMap = new Map<number, HourlyBar>();
  for (const b of hourlyBars) barMap.set(b.t, b);

  // Build funding map for quick lookup
  const fundingMap = new Map<number, number>();
  for (const b of hourlyBars) fundingMap.set(b.t, b.hlFunding);

  let inPosition = false;
  let pos: { dir: "long" | "short"; ep: number; et: number; entryDiv: number } | null = null;

  for (const dp of divSeries) {
    if (dp.t < startMs || dp.t >= endMs) continue;

    // Find price bar closest to this divergence point
    const barTs = Math.floor(dp.t / H) * H;
    const bar = barMap.get(barTs) ?? barMap.get(barTs + H) ?? barMap.get(barTs - H);
    if (!bar) continue;

    if (inPosition && pos) {
      // Check exit conditions
      const holdHours = (dp.t - pos.et) / H;
      const divNormalised = Math.abs(dp.divAnn) < exitThreshold;
      const maxHoldReached = holdHours >= maxHoldHours;

      if (divNormalised || maxHoldReached) {
        const xp = bar.c;
        const pricePnl = pos.dir === "long"
          ? (xp / pos.ep - 1) * NOT
          : (pos.ep / xp - 1) * NOT;

        // Calculate cumulative funding over hold period
        let fundPnl = 0;
        if (trackFunding) {
          for (let t = Math.floor(pos.et / H) * H; t <= barTs; t += H) {
            const fr = fundingMap.get(t) ?? 0;
            // If short, we RECEIVE positive funding; if long, we PAY positive funding
            if (pos.dir === "short") fundPnl += NOT * fr;
            else fundPnl -= NOT * fr;
          }
        }

        const cost = roundTripCost(pair);
        const totalPnl = pricePnl + fundPnl - cost;
        trades.push({
          pair, dir: pos.dir, ep: pos.ep, xp,
          et: pos.et, xt: dp.t,
          pricePnl, fundingPnl: fundPnl, totalPnl,
          entryDiv: pos.entryDiv, exitDiv: dp.divAnn,
          holdH: holdHours,
        });
        inPosition = false;
        pos = null;
      }
    }

    if (!inPosition) {
      // Check entry conditions
      if (Math.abs(dp.divAnn) > entryThreshold) {
        // HL funding much higher than Binance -> overcrowded longs on HL -> short
        // HL funding much lower than Binance -> overcrowded shorts on HL -> long
        const dir: "long" | "short" = dp.divAnn > 0 ? "short" : "long";
        pos = { dir, ep: bar.c, et: dp.t, entryDiv: dp.divAnn };
        inPosition = true;
      }
    }
  }

  // Close any open position at end
  if (inPosition && pos) {
    const lastBar = hourlyBars[hourlyBars.length - 1];
    if (lastBar) {
      const xp = lastBar.c;
      const holdHours = (lastBar.t - pos.et) / H;
      const pricePnl = pos.dir === "long"
        ? (xp / pos.ep - 1) * NOT
        : (pos.ep / xp - 1) * NOT;
      let fundPnl = 0;
      if (trackFunding) {
        for (let t = Math.floor(pos.et / H) * H; t <= lastBar.t; t += H) {
          const fr = fundingMap.get(t) ?? 0;
          if (pos.dir === "short") fundPnl += NOT * fr;
          else fundPnl -= NOT * fr;
        }
      }
      const cost = roundTripCost(pair);
      trades.push({
        pair, dir: pos.dir, ep: pos.ep, xp,
        et: pos.et, xt: lastBar.t,
        pricePnl, fundingPnl: fundPnl, totalPnl: pricePnl + fundPnl - cost,
        entryDiv: pos.entryDiv, exitDiv: 0,
        holdH: holdHours,
      });
    }
  }

  return trades;
}

// ─── Format Helpers ─────────────────────────────────────────────────
function fmtMetrics(m: Metrics, label: string): string {
  return [
    `  ${label}:`,
    `    Trades: ${m.n}  |  WR: ${m.wr.toFixed(1)}%  |  PF: ${m.pf.toFixed(2)}`,
    `    Sharpe: ${m.sharpe.toFixed(2)}  |  MaxDD: $${m.dd.toFixed(2)}`,
    `    Total: $${m.total.toFixed(2)}  |  $/day: $${m.perDay.toFixed(3)}`,
    `    Avg Funding P&L: $${m.avgFundPnl.toFixed(4)}  |  Avg Hold: ${m.avgHoldH.toFixed(1)}h`,
  ].join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log("=== CROSS-VENUE FUNDING DIVERGENCE BACKTEST ===");
  console.log(`Pairs: ${PAIRS.join(", ")}`);
  console.log(`Full: ${new Date(FULL_START).toISOString().slice(0, 10)} to ${new Date(END).toISOString().slice(0, 10)}`);
  console.log(`OOS:  ${new Date(OOS_START).toISOString().slice(0, 10)} to ${new Date(END).toISOString().slice(0, 10)}`);
  console.log(`Margin: $${SIZE}  |  Lev: ${LEV}x  |  Notional: $${NOT}`);
  console.log(`Entry threshold: ${(ENTRY_DIV_ANN * 100).toFixed(0)}% ann  |  Exit: <${(EXIT_DIV_ANN * 100).toFixed(0)}% ann  |  Max hold: ${MAX_HOLD_H}h`);
  console.log();

  // Step 1: Download Binance funding for all pairs
  console.log("--- Step 1: Download Binance Funding ---");
  const binanceFunding = new Map<string, BinanceFR[]>();
  for (const pair of PAIRS) {
    const sym = BINANCE_SYMBOL[pair];
    const data = await downloadBinanceFunding(sym);
    binanceFunding.set(pair, data);
  }
  console.log();

  // Step 2: Load HL funding and price data
  console.log("--- Step 2: Load HL Funding & Price Data ---");
  const hlFunding = new Map<string, FR[]>();
  const hourlyBars = new Map<string, HourlyBar[]>();
  const divSeries = new Map<string, DivergencePoint[]>();

  for (const pair of PAIRS) {
    const hl = loadHLFunding(pair);
    hlFunding.set(pair, hl);
    const candles = load5m(pair);
    const bars = buildHourlyBars(pair, hl, candles);
    hourlyBars.set(pair, bars);

    const bin = binanceFunding.get(pair) ?? [];
    const div = buildDivergenceSeries(hl, bin);
    divSeries.set(pair, div);

    // Print divergence stats
    const inRange = div.filter(d => d.t >= FULL_START && d.t < END);
    const extreme = inRange.filter(d => Math.abs(d.divAnn) > ENTRY_DIV_ANN);
    const veryExtreme = inRange.filter(d => Math.abs(d.divAnn) > EXTREME_DIV_ANN);
    console.log(`  ${pair}: ${hl.length} HL records, ${bin.length} Binance records, ${inRange.length} merged points, ${extreme.length} >50% div, ${veryExtreme.length} >100% div`);
  }
  console.log();

  // Step 3: Print divergence distribution
  console.log("--- Step 3: Divergence Distribution ---");
  const allDiv: DivergencePoint[] = [];
  for (const pair of PAIRS) {
    const div = divSeries.get(pair) ?? [];
    allDiv.push(...div.filter(d => d.t >= FULL_START && d.t < END));
  }
  const absDivs = allDiv.map(d => Math.abs(d.divAnn)).sort((a, b) => a - b);
  const pcts = [10, 25, 50, 75, 90, 95, 99];
  console.log("  Percentiles of |divergence| (annualised):");
  for (const p of pcts) {
    const idx = Math.floor(absDivs.length * p / 100);
    console.log(`    p${p}: ${(absDivs[idx] * 100).toFixed(1)}%`);
  }
  const avgDiv = absDivs.reduce((s, d) => s + d, 0) / absDivs.length;
  console.log(`    Mean: ${(avgDiv * 100).toFixed(1)}%`);
  console.log();

  // Show top 10 divergence events
  console.log("--- Top 10 Largest Divergence Events ---");
  const allDivWithPair = PAIRS.flatMap(pair =>
    (divSeries.get(pair) ?? [])
      .filter(d => d.t >= FULL_START && d.t < END)
      .map(d => ({ ...d, pair }))
  );
  allDivWithPair.sort((a, b) => Math.abs(b.divAnn) - Math.abs(a.divAnn));
  for (const d of allDivWithPair.slice(0, 10)) {
    console.log(`  ${d.pair} ${new Date(d.t).toISOString().slice(0, 16)} | HL_ann=${(d.hlAnn * 100).toFixed(1)}% Bin_ann=${(d.binAnn * 100).toFixed(1)}% Div=${(d.divAnn * 100).toFixed(1)}%`);
  }
  console.log();

  // Step 4: Run strategies
  console.log("=== STRATEGY A: Fade HL Overcrowding (>50% ann) ===");
  const allTradesA: Trade[] = [];
  for (const pair of PAIRS) {
    const div = divSeries.get(pair) ?? [];
    const bars = hourlyBars.get(pair) ?? [];
    const trades = runStrategy(pair, div, bars, ENTRY_DIV_ANN, EXIT_DIV_ANN, MAX_HOLD_H, false, FULL_START, END);
    allTradesA.push(...trades);
  }
  const fullA = allTradesA.filter(t => t.et >= FULL_START && t.xt < END);
  const oosA = allTradesA.filter(t => t.et >= OOS_START && t.xt < END);
  console.log(fmtMetrics(calcMetrics(fullA, FULL_START, END), "Full Period"));
  console.log(fmtMetrics(calcMetrics(oosA, OOS_START, END), "OOS"));

  // Per-pair breakdown for A
  console.log("\n  Per-pair (Full):");
  for (const pair of PAIRS) {
    const pt = fullA.filter(t => t.pair === pair);
    if (pt.length === 0) { console.log(`    ${pair}: 0 trades`); continue; }
    const m = calcMetrics(pt, FULL_START, END);
    console.log(`    ${pair}: ${m.n} trades | WR=${m.wr.toFixed(0)}% PF=${m.pf.toFixed(2)} Total=$${m.total.toFixed(2)} $/day=$${m.perDay.toFixed(3)}`);
  }
  console.log();

  console.log("=== STRATEGY B: Directional + Funding Income (>50% ann) ===");
  const allTradesB: Trade[] = [];
  for (const pair of PAIRS) {
    const div = divSeries.get(pair) ?? [];
    const bars = hourlyBars.get(pair) ?? [];
    const trades = runStrategy(pair, div, bars, ENTRY_DIV_ANN, EXIT_DIV_ANN, MAX_HOLD_H, true, FULL_START, END);
    allTradesB.push(...trades);
  }
  const fullB = allTradesB.filter(t => t.et >= FULL_START && t.xt < END);
  const oosB = allTradesB.filter(t => t.et >= OOS_START && t.xt < END);
  console.log(fmtMetrics(calcMetrics(fullB, FULL_START, END), "Full Period"));
  console.log(fmtMetrics(calcMetrics(oosB, OOS_START, END), "OOS"));

  // Funding breakdown
  const totalFundingIncome = fullB.reduce((s, t) => s + t.fundingPnl, 0);
  const totalPricePnl = fullB.reduce((s, t) => s + t.pricePnl, 0);
  console.log(`\n  P&L Decomposition (Full):  Price=$${totalPricePnl.toFixed(2)}  Funding=$${totalFundingIncome.toFixed(2)}  Costs=$${(fullB.length * roundTripCost("ETH")).toFixed(2)}`);

  console.log("\n  Per-pair (Full):");
  for (const pair of PAIRS) {
    const pt = fullB.filter(t => t.pair === pair);
    if (pt.length === 0) { console.log(`    ${pair}: 0 trades`); continue; }
    const m = calcMetrics(pt, FULL_START, END);
    const fundIncome = pt.reduce((s, t) => s + t.fundingPnl, 0);
    console.log(`    ${pair}: ${m.n} trades | WR=${m.wr.toFixed(0)}% PF=${m.pf.toFixed(2)} Total=$${m.total.toFixed(2)} Fund=$${fundIncome.toFixed(3)} $/day=$${m.perDay.toFixed(3)}`);
  }
  console.log();

  console.log("=== STRATEGY C: Extreme Divergence Only (>100% ann) ===");
  const allTradesC: Trade[] = [];
  for (const pair of PAIRS) {
    const div = divSeries.get(pair) ?? [];
    const bars = hourlyBars.get(pair) ?? [];
    const trades = runStrategy(pair, div, bars, EXTREME_DIV_ANN, EXIT_DIV_ANN, MAX_HOLD_H, true, FULL_START, END);
    allTradesC.push(...trades);
  }
  const fullC = allTradesC.filter(t => t.et >= FULL_START && t.xt < END);
  const oosC = allTradesC.filter(t => t.et >= OOS_START && t.xt < END);
  console.log(fmtMetrics(calcMetrics(fullC, FULL_START, END), "Full Period"));
  console.log(fmtMetrics(calcMetrics(oosC, OOS_START, END), "OOS"));

  console.log("\n  Per-pair (Full):");
  for (const pair of PAIRS) {
    const pt = fullC.filter(t => t.pair === pair);
    if (pt.length === 0) { console.log(`    ${pair}: 0 trades`); continue; }
    const m = calcMetrics(pt, FULL_START, END);
    const fundIncome = pt.reduce((s, t) => s + t.fundingPnl, 0);
    console.log(`    ${pair}: ${m.n} trades | WR=${m.wr.toFixed(0)}% PF=${m.pf.toFixed(2)} Total=$${m.total.toFixed(2)} Fund=$${fundIncome.toFixed(3)} $/day=$${m.perDay.toFixed(3)}`);
  }
  console.log();

  // ─── Summary Table ─────────────────────────────────────────────────
  console.log("=== SUMMARY TABLE ===");
  console.log("Strategy                      | Period | Trades | WR%   | PF   | Sharpe | MaxDD  | Total   | $/day  | AvgFund | AvgHold");
  console.log("-".repeat(120));

  const rows: [string, string, Metrics][] = [
    ["A: Fade Overcrowding >50%", "Full", calcMetrics(fullA, FULL_START, END)],
    ["A: Fade Overcrowding >50%", "OOS", calcMetrics(oosA, OOS_START, END)],
    ["B: Directional+Funding >50%", "Full", calcMetrics(fullB, FULL_START, END)],
    ["B: Directional+Funding >50%", "OOS", calcMetrics(oosB, OOS_START, END)],
    ["C: Extreme Only >100%", "Full", calcMetrics(fullC, FULL_START, END)],
    ["C: Extreme Only >100%", "OOS", calcMetrics(oosC, OOS_START, END)],
  ];

  for (const [name, period, m] of rows) {
    console.log(
      `${name.padEnd(30)}| ${period.padEnd(7)}| ${String(m.n).padEnd(7)}| ${m.wr.toFixed(1).padStart(5)}% | ${m.pf.toFixed(2).padStart(4)} | ${m.sharpe.toFixed(2).padStart(6)} | $${m.dd.toFixed(2).padStart(5)} | $${m.total.toFixed(2).padStart(7)} | $${m.perDay.toFixed(3).padStart(6)} | $${m.avgFundPnl.toFixed(4).padStart(7)} | ${m.avgHoldH.toFixed(1).padStart(5)}h`
    );
  }

  // ─── Monthly Breakdown for Best Strategy ───────────────────────────
  const bestTrades = allTradesB; // B includes funding tracking
  console.log("\n=== MONTHLY P&L (Strategy B - Full) ===");
  const monthly = new Map<string, { pnl: number; n: number; wins: number }>();
  for (const t of fullB) {
    const key = new Date(t.xt).toISOString().slice(0, 7);
    const entry = monthly.get(key) ?? { pnl: 0, n: 0, wins: 0 };
    entry.pnl += t.totalPnl;
    entry.n++;
    if (t.totalPnl > 0) entry.wins++;
    monthly.set(key, entry);
  }
  for (const [month, data] of [...monthly.entries()].sort()) {
    const wr = data.n > 0 ? (data.wins / data.n * 100) : 0;
    console.log(`  ${month}: $${data.pnl.toFixed(2).padStart(8)} | ${data.n} trades | WR=${wr.toFixed(0)}%`);
  }

  // ─── Long/Short Breakdown ─────────────────────────────────────────
  console.log("\n=== LONG vs SHORT BREAKDOWN (Strategy B - Full) ===");
  const longs = fullB.filter(t => t.dir === "long");
  const shorts = fullB.filter(t => t.dir === "short");
  console.log(`  LONG:  ${longs.length} trades | Total=$${longs.reduce((s, t) => s + t.totalPnl, 0).toFixed(2)} | WR=${(longs.filter(t => t.totalPnl > 0).length / Math.max(longs.length, 1) * 100).toFixed(1)}%`);
  console.log(`  SHORT: ${shorts.length} trades | Total=$${shorts.reduce((s, t) => s + t.totalPnl, 0).toFixed(2)} | WR=${(shorts.filter(t => t.totalPnl > 0).length / Math.max(shorts.length, 1) * 100).toFixed(1)}%`);

  // ─── Exit Reason Breakdown ─────────────────────────────────────────
  console.log("\n=== EXIT REASONS (Strategy B - Full) ===");
  const normExits = fullB.filter(t => t.holdH < MAX_HOLD_H);
  const maxHoldExits = fullB.filter(t => t.holdH >= MAX_HOLD_H);
  console.log(`  Normalised (<${EXIT_DIV_ANN * 100}% div): ${normExits.length} trades | Total=$${normExits.reduce((s, t) => s + t.totalPnl, 0).toFixed(2)} | WR=${(normExits.filter(t => t.totalPnl > 0).length / Math.max(normExits.length, 1) * 100).toFixed(1)}%`);
  console.log(`  Max Hold (${MAX_HOLD_H}h): ${maxHoldExits.length} trades | Total=$${maxHoldExits.reduce((s, t) => s + t.totalPnl, 0).toFixed(2)} | WR=${(maxHoldExits.filter(t => t.totalPnl > 0).length / Math.max(maxHoldExits.length, 1) * 100).toFixed(1)}%`);

  console.log("\nDone.");
}

main().catch(console.error);
