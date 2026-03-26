/**
 * Pyramid (adding to winners) backtest on Daily Donchian(30d) strategy
 * 5m candle data aggregated to daily, 19 pairs, full + OOS periods
 */
import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const DAY = 86_400_000;
const FEE = 0.000_35;
const BASE_SZ = 5;       // $5 margin per layer
const LEV = 10;
const NOT = BASE_SZ * LEV; // $50 notional per layer
const DONCH_ENTRY = 30;
const DONCH_EXIT = 15;
const ATR_PERIOD = 14;
const ATR_MULT = 3;
const MAX_HOLD = 60;

const FULL_START = new Date("2023-01-01").getTime();
const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-26").getTime();

const PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, AVAX: 2.55e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, SEI: 4.4e-4,
  TON: 4.6e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
  ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
};

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number }
interface Layer { ep: number; addTime: number; margin: number; notional: number }
interface Pos {
  pair: string; dir: "long" | "short"; et: number; sl: number;
  atrAtEntry: number; layers: Layer[]; peakPrice: number;
}
interface Trade {
  pair: string; dir: "long" | "short"; et: number; xt: number;
  pnl: number; reason: string; holdDays: number; numLayers: number;
  basePnl: number; pyramidPnl: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
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

function aggDaily(candles5m: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles5m) {
    const dayTs = Math.floor(c.t / DAY) * DAY;
    const arr = groups.get(dayTs) ?? [];
    arr.push(c);
    groups.set(dayTs, arr);
  }
  const daily: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 12) continue; // need at least 1h of data
    bars.sort((a, b) => a.t - b.t);
    daily.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return daily;
}

// ─── Indicators ─────────────────────────────────────────────────────
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
      for (let j = 1; j <= period; j++) {
        s += Math.max(
          cs[j].h - cs[j].l,
          Math.abs(cs[j].h - cs[j - 1].c),
          Math.abs(cs[j].l - cs[j - 1].c),
        );
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
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

function donchianHigh(cs: C[], idx: number, lb: number): number {
  let max = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) max = Math.max(max, cs[i].h);
  return max;
}

function donchianLow(cs: C[], idx: number, lb: number): number {
  let min = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) min = Math.min(min, cs[i].l);
  return min;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function layerPnl(
  pair: string, ep: number, xp: number, dir: "long" | "short",
  isSL: boolean, margin: number,
): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const not = margin * LEV;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = not * FEE * 2;
  const rawPnl = dir === "long" ? (xp / ep - 1) * not : (ep / xp - 1) * not;
  return rawPnl - entrySlip * (not / ep) - exitSlip * (not / xp) - fees;
}

// ─── Pyramid Config ─────────────────────────────────────────────────
interface PyramidCfg {
  name: string;
  // Each trigger: [atrMultiple, newStopAtrFromEntry, layerMargin]
  triggers: { atrProfit: number; newStopAtr: number; margin: number }[];
}

const PYRAMID_CONFIGS: PyramidCfg[] = [
  {
    name: "Baseline (no pyramid)",
    triggers: [],
  },
  {
    name: "Pyr @1xATR, max 2 layers",
    triggers: [
      { atrProfit: 1, newStopAtr: 0.5, margin: 5 },
    ],
  },
  {
    name: "Pyr @2xATR, max 2 layers",
    triggers: [
      { atrProfit: 2, newStopAtr: 1.0, margin: 5 },
    ],
  },
  {
    name: "Pyr @1x+2x ATR, max 3",
    triggers: [
      { atrProfit: 1, newStopAtr: 0, margin: 5 },   // breakeven stop
      { atrProfit: 2, newStopAtr: 1, margin: 5 },   // lock 1xATR
    ],
  },
  {
    name: "Aggressive 4 layers",
    triggers: [
      { atrProfit: 1, newStopAtr: -1, margin: 5 },  // stop = (N-2)*ATR => -1*ATR for layer 2
      { atrProfit: 2, newStopAtr: 0, margin: 5 },   // 0*ATR for layer 3
      { atrProfit: 3, newStopAtr: 1, margin: 5 },   // 1*ATR for layer 4
    ],
  },
  {
    name: "Decreasing size 5/3/2",
    triggers: [
      { atrProfit: 1, newStopAtr: 0, margin: 3 },
      { atrProfit: 2, newStopAtr: 1, margin: 2 },
    ],
  },
];

// ─── Simulation ─────────────────────────────────────────────────────
function simulate(
  pairDaily: Map<string, { cs: C[]; atr: number[] }>,
  btcEma20: number[],
  btcEma50: number[],
  btcCs: C[],
  cfg: PyramidCfg,
  startTs: number,
  endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  const maxLayers = 1 + cfg.triggers.length;

  for (const pair of PAIRS) {
    const pd = pairDaily.get(pair);
    if (!pd) continue;
    const { cs, atr } = pd;
    const warmup = Math.max(DONCH_ENTRY, ATR_PERIOD) + 2;

    let pos: Pos | null = null;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t > endTs) break;

      // ─── Check exits for open position ─────────────────────────
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / DAY);
        let xp = 0;
        let reason = "";
        const isSL = (): boolean => reason === "stop-loss";

        // Track peak for stop logic
        if (pos.dir === "long" && bar.h > pos.peakPrice) pos.peakPrice = bar.h;
        if (pos.dir === "short" && bar.l < pos.peakPrice) pos.peakPrice = bar.l;

        // Stop-loss (intraday)
        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl;
          reason = "stop-loss";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl;
          reason = "stop-loss";
        }

        // Donchian exit
        if (!xp) {
          const exitLow = donchianLow(cs, i, DONCH_EXIT);
          const exitHigh = donchianHigh(cs, i, DONCH_EXIT);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        // Max hold
        if (!xp && holdDays >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          // Close ALL layers at the same exit price
          let totalPnl = 0;
          let basePnl = 0;
          let pyramidPnl = 0;

          for (let li = 0; li < pos.layers.length; li++) {
            const layer = pos.layers[li];
            const lp = layerPnl(pair, layer.ep, xp, pos.dir, reason === "stop-loss", layer.margin);
            totalPnl += lp;
            if (li === 0) basePnl = lp;
            else pyramidPnl += lp;
          }

          if (pos.et >= startTs) {
            trades.push({
              pair,
              dir: pos.dir,
              et: pos.et,
              xt: bar.t,
              pnl: totalPnl,
              reason,
              holdDays,
              numLayers: pos.layers.length,
              basePnl,
              pyramidPnl,
            });
          }
          pos = null;
        }

        // ─── Pyramid adds (if still open) ──────────────────────
        if (pos && cfg.triggers.length > 0) {
          const layerCount = pos.layers.length;
          if (layerCount < maxLayers) {
            const triggerIdx = layerCount - 1; // which trigger to check (0-based)
            if (triggerIdx < cfg.triggers.length) {
              const trigger = cfg.triggers[triggerIdx];
              const baseEntry = pos.layers[0].ep;
              const atrVal = pos.atrAtEntry;
              const profitTarget = pos.dir === "long"
                ? baseEntry + trigger.atrProfit * atrVal
                : baseEntry - trigger.atrProfit * atrVal;

              const triggered = pos.dir === "long"
                ? bar.h >= profitTarget
                : bar.l <= profitTarget;

              if (triggered) {
                // Add new layer at current close (conservative: we detect intraday, execute at close)
                const addPrice = bar.c;
                pos.layers.push({
                  ep: addPrice,
                  addTime: bar.t,
                  margin: trigger.margin,
                  notional: trigger.margin * LEV,
                });

                // Move stop based on trigger config
                const newSl = pos.dir === "long"
                  ? baseEntry + trigger.newStopAtr * atrVal
                  : baseEntry - trigger.newStopAtr * atrVal;

                // Only move stop in favorable direction
                if (pos.dir === "long" && newSl > pos.sl) pos.sl = newSl;
                if (pos.dir === "short" && newSl < pos.sl) pos.sl = newSl;
              }
            }
          }
        }
      }

      // ─── Entry signal (signal on day i-1, entry at day i open) ──
      if (!pos && bar.t >= startTs) {
        const prev = cs[i - 1];
        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const hi30 = donchianHigh(cs, i - 1, DONCH_ENTRY);
        const lo30 = donchianLow(cs, i - 1, DONCH_ENTRY);

        let dir: "long" | "short" | null = null;
        if (prev.c > hi30) dir = "long";
        else if (prev.c < lo30) dir = "short";
        if (!dir) continue;

        // BTC EMA filter: EMA(20) > EMA(50) for longs only
        if (dir === "long") {
          // Find BTC bar for this day
          const btcIdx = btcCs.findIndex(b => b.t === bar.t);
          if (btcIdx < 0 || btcIdx < 50) continue;
          const be20 = btcEma20[btcIdx - 1];
          const be50 = btcEma50[btcIdx - 1];
          if (!be20 || !be50 || be20 <= be50) continue;
        }

        const ep = bar.o;
        const sl = dir === "long"
          ? ep - ATR_MULT * prevATR
          : ep + ATR_MULT * prevATR;

        pos = {
          pair, dir, et: bar.t, sl, atrAtEntry: prevATR,
          layers: [{ ep, addTime: bar.t, margin: BASE_SZ, notional: NOT }],
          peakPrice: ep,
        };
      }
    }
  }

  return trades;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; pyramidAdds: number; wr: number; pf: number;
  sharpe: number; dd: number; total: number; perDay: number;
  avgLayersWin: number; avgLayersLose: number; pyramidContrib: number;
}

function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0)
    return { n: 0, pyramidAdds: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, avgLayersWin: 0, avgLayersLose: 0, pyramidContrib: 0 };

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const pyramidAdds = trades.reduce((s, t) => s + (t.numLayers - 1), 0);
  const pyramidContrib = trades.reduce((s, t) => s + t.pyramidPnl, 0);

  const avgLayersWin = wins.length > 0
    ? wins.reduce((s, t) => s + t.numLayers, 0) / wins.length : 0;
  const avgLayersLose = losses.length > 0
    ? losses.reduce((s, t) => s + t.numLayers, 0) / losses.length : 0;

  // Sharpe: bucket by day
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // Max drawdown
  let peak = 0, equity = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const days = (endTs - startTs) / DAY;

  return {
    n: trades.length,
    pyramidAdds,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
    avgLayersWin,
    avgLayersLose,
    pyramidContrib,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("Loading 5m data and aggregating to daily...\n");

const pairDaily = new Map<string, { cs: C[]; atr: number[] }>();
for (const pair of PAIRS) {
  const raw = load5m(pair);
  if (raw.length === 0) { console.log(`  WARN: no data for ${pair}`); continue; }
  const cs = aggDaily(raw);
  const atr = calcATR(cs, ATR_PERIOD);
  pairDaily.set(pair, { cs, atr });
  console.log(`  ${pair}: ${raw.length} 5m -> ${cs.length} daily bars`);
}

// BTC EMA filter
const btcData = pairDaily.get("BTC");
if (!btcData) { console.log("ERROR: no BTC data"); process.exit(1); }
const btcCloses = btcData.cs.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);

// ─── Run all configs ────────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("PYRAMID BACKTEST: Daily Donchian(30d entry, 15d exit, ATR x3 stop, 60d max hold)");
console.log("Base: $5 margin/layer, 10x leverage, BTC EMA(20)>EMA(50) filter for longs");
console.log("=".repeat(110));

function fmtMoney(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function printResults(label: string, configs: PyramidCfg[], startTs: number, endTs: number): void {
  console.log(`\n${"=".repeat(110)}`);
  console.log(`${label}`);
  console.log(`${"=".repeat(110)}\n`);

  console.log(
    "Strategy".padEnd(28) +
    "Trades".padStart(7) +
    "  PyrAdds".padStart(9) +
    "  WR%".padStart(7) +
    "    PF".padStart(7) +
    "  Sharpe".padStart(8) +
    "  TotalPnL".padStart(11) +
    "  $/day".padStart(9) +
    "  MaxDD".padStart(9) +
    "  AvgLyrW".padStart(9) +
    "  AvgLyrL".padStart(9) +
    "  PyrContrib".padStart(12),
  );
  console.log("-".repeat(119));

  for (const cfg of configs) {
    const trades = simulate(pairDaily, btcEma20, btcEma50, btcData!.cs, cfg, startTs, endTs);
    const m = calcMetrics(trades, startTs, endTs);

    console.log(
      cfg.name.padEnd(28) +
      String(m.n).padStart(7) +
      String(m.pyramidAdds).padStart(9) +
      m.wr.toFixed(1).padStart(7) +
      (m.pf === Infinity ? "  inf" : m.pf.toFixed(2).padStart(7)) +
      m.sharpe.toFixed(2).padStart(8) +
      fmtMoney(m.total).padStart(11) +
      fmtMoney(m.perDay).padStart(9) +
      ("$" + m.dd.toFixed(2)).padStart(9) +
      m.avgLayersWin.toFixed(2).padStart(9) +
      m.avgLayersLose.toFixed(2).padStart(9) +
      fmtMoney(m.pyramidContrib).padStart(12),
    );
  }
}

// Full period
printResults(
  `FULL PERIOD: ${new Date(FULL_START).toISOString().slice(0, 10)} to ${new Date(OOS_END).toISOString().slice(0, 10)}`,
  PYRAMID_CONFIGS, FULL_START, OOS_END,
);

// OOS only
printResults(
  `OUT-OF-SAMPLE: ${new Date(OOS_START).toISOString().slice(0, 10)} to ${new Date(OOS_END).toISOString().slice(0, 10)}`,
  PYRAMID_CONFIGS, OOS_START, OOS_END,
);

// ─── Detailed comparison: Baseline vs each variant (OOS) ────────────
console.log("\n" + "=".repeat(110));
console.log("DETAILED COMPARISON vs BASELINE (OOS)");
console.log("=".repeat(110));

const baselineTrades = simulate(pairDaily, btcEma20, btcEma50, btcData!.cs, PYRAMID_CONFIGS[0], OOS_START, OOS_END);
const baselineM = calcMetrics(baselineTrades, OOS_START, OOS_END);

for (let ci = 1; ci < PYRAMID_CONFIGS.length; ci++) {
  const cfg = PYRAMID_CONFIGS[ci];
  const trades = simulate(pairDaily, btcEma20, btcEma50, btcData!.cs, cfg, OOS_START, OOS_END);
  const m = calcMetrics(trades, OOS_START, OOS_END);

  console.log(`\n--- ${cfg.name} vs Baseline ---`);
  console.log(`  Trades:       ${m.n} vs ${baselineM.n} (${m.n === baselineM.n ? "same" : (m.n > baselineM.n ? "+" : "") + (m.n - baselineM.n)})`);
  console.log(`  Pyramid adds: ${m.pyramidAdds}`);
  console.log(`  Total PnL:    ${fmtMoney(m.total)} vs ${fmtMoney(baselineM.total)} (delta: ${fmtMoney(m.total - baselineM.total)})`);
  console.log(`  $/day:        ${fmtMoney(m.perDay)} vs ${fmtMoney(baselineM.perDay)}`);
  console.log(`  PF:           ${m.pf.toFixed(2)} vs ${baselineM.pf.toFixed(2)}`);
  console.log(`  Sharpe:       ${m.sharpe.toFixed(2)} vs ${baselineM.sharpe.toFixed(2)}`);
  console.log(`  Max DD:       $${m.dd.toFixed(2)} vs $${baselineM.dd.toFixed(2)}`);
  console.log(`  Win rate:     ${m.wr.toFixed(1)}% vs ${baselineM.wr.toFixed(1)}%`);
  console.log(`  Avg layers (winners): ${m.avgLayersWin.toFixed(2)} | (losers): ${m.avgLayersLose.toFixed(2)}`);
  console.log(`  Pyramid-only P&L contribution: ${fmtMoney(m.pyramidContrib)}`);

  // Show trades that got pyramid adds
  const pyramidTrades = trades.filter(t => t.numLayers > 1);
  const pyramidWins = pyramidTrades.filter(t => t.pnl > 0);
  const pyramidLosses = pyramidTrades.filter(t => t.pnl <= 0);
  console.log(`  Trades with pyramid adds: ${pyramidTrades.length} (${pyramidWins.length}W / ${pyramidLosses.length}L)`);
  if (pyramidTrades.length > 0) {
    const avgPyrPnl = pyramidTrades.reduce((s, t) => s + t.pnl, 0) / pyramidTrades.length;
    console.log(`  Avg PnL of pyramided trades: ${fmtMoney(avgPyrPnl)}`);
  }
}

// ─── Per-pair breakdown for best variant (OOS) ──────────────────────
console.log("\n" + "=".repeat(110));
console.log("PER-PAIR BREAKDOWN: Baseline vs Best Pyramid Variant (OOS)");
console.log("=".repeat(110) + "\n");

// Find best variant by total PnL (OOS)
let bestIdx = 0;
let bestPnl = -Infinity;
for (let ci = 0; ci < PYRAMID_CONFIGS.length; ci++) {
  const trades = simulate(pairDaily, btcEma20, btcEma50, btcData!.cs, PYRAMID_CONFIGS[ci], OOS_START, OOS_END);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  if (total > bestPnl) { bestPnl = total; bestIdx = ci; }
}

const bestCfg = PYRAMID_CONFIGS[bestIdx];
const bestTrades = simulate(pairDaily, btcEma20, btcEma50, btcData!.cs, bestCfg, OOS_START, OOS_END);

console.log(`Best variant: "${bestCfg.name}"\n`);

console.log(
  "Pair".padEnd(8) +
  " | Baseline".padEnd(14) +
  " | Pyramid".padEnd(13) +
  " | Delta".padEnd(12) +
  " | PyrAdds".padEnd(10) +
  " | AvgLayers",
);
console.log("-".repeat(68));

for (const pair of PAIRS) {
  const basePairTrades = baselineTrades.filter(t => t.pair === pair);
  const bestPairTrades = bestTrades.filter(t => t.pair === pair);
  const basePnl = basePairTrades.reduce((s, t) => s + t.pnl, 0);
  const bestPnl2 = bestPairTrades.reduce((s, t) => s + t.pnl, 0);
  const delta = bestPnl2 - basePnl;
  const pyrAdds = bestPairTrades.reduce((s, t) => s + (t.numLayers - 1), 0);
  const avgLayers = bestPairTrades.length > 0
    ? bestPairTrades.reduce((s, t) => s + t.numLayers, 0) / bestPairTrades.length : 0;

  console.log(
    pair.padEnd(8) +
    (" | " + fmtMoney(basePnl)).padEnd(14) +
    (" | " + fmtMoney(bestPnl2)).padEnd(13) +
    (" | " + fmtMoney(delta)).padEnd(12) +
    (" | " + String(pyrAdds)).padEnd(10) +
    " | " + avgLayers.toFixed(2),
  );
}

// ─── Monthly P&L comparison (OOS) ──────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("MONTHLY P&L COMPARISON (OOS): Baseline vs " + bestCfg.name);
console.log("=".repeat(110) + "\n");

console.log(
  "Month".padEnd(10) +
  " | Base Trades".padEnd(14) +
  " | Base PnL".padEnd(13) +
  " | Pyr Trades".padEnd(14) +
  " | Pyr PnL".padEnd(13) +
  " | Delta",
);
console.log("-".repeat(72));

const allMonths = new Set<string>();
for (const t of [...baselineTrades, ...bestTrades]) {
  allMonths.add(new Date(t.xt).toISOString().slice(0, 7));
}

for (const m of [...allMonths].sort()) {
  const baseMonth = baselineTrades.filter(t => new Date(t.xt).toISOString().slice(0, 7) === m);
  const bestMonth = bestTrades.filter(t => new Date(t.xt).toISOString().slice(0, 7) === m);
  const baseMPnl = baseMonth.reduce((s, t) => s + t.pnl, 0);
  const bestMPnl = bestMonth.reduce((s, t) => s + t.pnl, 0);

  console.log(
    m.padEnd(10) +
    (" | " + String(baseMonth.length)).padEnd(14) +
    (" | " + fmtMoney(baseMPnl)).padEnd(13) +
    (" | " + String(bestMonth.length)).padEnd(14) +
    (" | " + fmtMoney(bestMPnl)).padEnd(13) +
    " | " + fmtMoney(bestMPnl - baseMPnl),
  );
}

// ─── Exit reason breakdown (OOS) ───────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("EXIT REASON BREAKDOWN (OOS): " + bestCfg.name);
console.log("=".repeat(110) + "\n");

console.log(
  "Reason".padEnd(16) +
  "Count".padStart(6) +
  "  AvgPnL".padStart(10) +
  "  AvgLayers".padStart(11) +
  "  TotalPnL".padStart(12),
);
console.log("-".repeat(58));

for (const reason of ["stop-loss", "donchian-exit", "max-hold"]) {
  const rt = bestTrades.filter(t => t.reason === reason);
  const rpnl = rt.reduce((s, t) => s + t.pnl, 0);
  const avgPnl = rt.length > 0 ? rpnl / rt.length : 0;
  const avgLayers = rt.length > 0 ? rt.reduce((s, t) => s + t.numLayers, 0) / rt.length : 0;

  console.log(
    reason.padEnd(16) +
    String(rt.length).padStart(6) +
    fmtMoney(avgPnl).padStart(10) +
    avgLayers.toFixed(2).padStart(11) +
    fmtMoney(rpnl).padStart(12),
  );
}

console.log("\nDone.");
