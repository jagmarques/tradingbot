/**
 * BTC event-driven deep parameter optimization.
 * Sweeps thresholds, TP/SL, stale, pairs, hold times, caps, trend filter, compound sim.
 *
 * Run: npx tsx scripts/backtest-btc-events-optimize.ts
 */

import * as fs from "fs";
import * as path from "path";
import { EMA } from "technicalindicators";

// ---- Types ----
interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }
interface BtcEvent { ts: number; direction: "long" | "short"; }
interface Position {
  pair: string; direction: "long" | "short";
  entryPrice: number; entryTime: number;
  stopLoss: number; takeProfit: number;
  staleCheckTs: number;
  size: number; // for compound mode
}
interface Trade {
  pair: string; direction: "long" | "short";
  entryPrice: number; exitPrice: number;
  entryTime: number; exitTime: number;
  pnl: number; reason: string;
  size: number; // actual position size used
}

// ---- Constants ----
const CACHE_DIR = "/tmp/bt-pair-cache";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const HL_FEE = 0.00035;
const FIXED_SIZE = 20;
const LEVERAGE = 10;
const START_TS = new Date("2025-06-01T00:00:00Z").getTime();
const END_TS = new Date("2026-03-20T00:00:00Z").getTime();
const DAYS = (END_TS - START_TS) / DAY_MS;

// All available pairs + mappings
const ALL_PAIRS = ["TIA", "kBONK", "OP", "LDO", "APT", "NEAR", "ARB", "ENA", "WLD", "ADA"];
const PAIR_MAP: Record<string, string> = {
  TIA: "TIAUSDT", kBONK: "kBONKUSDT", OP: "OPUSDT", LDO: "LDOUSDT", APT: "APTUSDT",
  NEAR: "NEARUSDT", ARB: "ARBUSDT", ENA: "ENAUSDT", WLD: "WLDUSDT", ADA: "ADAUSDT",
};
const SPREAD_MAP: Record<string, number> = {
  TIAUSDT: 5e-4, kBONKUSDT: 5.5e-4, OPUSDT: 6.2e-4, LDOUSDT: 5.8e-4,
  APTUSDT: 3.2e-4, NEARUSDT: 4.5e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  WLDUSDT: 4e-4, ADAUSDT: 5.55e-4,
};

// ---- Data Loading ----
function loadCandles(filename: string): Candle[] {
  const fp = path.join(CACHE_DIR, filename + ".json");
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as unknown[];
  return (raw as (number[] | Candle)[]).map(b =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +(b[5] ?? 0) }
      : { ...b as Candle, v: (b as Candle).v ?? 0 }
  );
}

function getSpread(f: string): number { return SPREAD_MAP[f] ?? 4e-4; }

// ---- BTC Event Detection (parameterized) ----
function loadBtcMoveEvents(threshold: number, dedupMs: number): BtcEvent[] {
  const btc1mRaw = JSON.parse(fs.readFileSync("/tmp/btc-1m-candles.json", "utf8")) as number[][];
  const btc1m = btc1mRaw.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }));
  btc1m.sort((a, b) => a.t - b.t);

  const rawEvents: BtcEvent[] = [];

  for (let i = 15; i < btc1m.length; i++) {
    const candle = btc1m[i];
    if (candle.t < START_TS || candle.t > END_TS) continue;

    const startPrice = btc1m[i - 15].o;
    if (!startPrice || startPrice <= 0) continue;

    let maxUp = 0, maxDown = 0;
    for (let j = i - 15; j <= i; j++) {
      const up = (btc1m[j].h - startPrice) / startPrice;
      const down = (btc1m[j].l - startPrice) / startPrice;
      if (up > maxUp) maxUp = up;
      if (down < maxDown) maxDown = down;
    }

    const upExceeds = maxUp > threshold;
    const downExceeds = Math.abs(maxDown) > threshold;

    if (upExceeds && downExceeds) {
      rawEvents.push({ ts: candle.t, direction: maxUp >= Math.abs(maxDown) ? "long" : "short" });
    } else if (upExceeds) {
      rawEvents.push({ ts: candle.t, direction: "long" });
    } else if (downExceeds) {
      rawEvents.push({ ts: candle.t, direction: "short" });
    }
  }

  rawEvents.sort((a, b) => a.ts - b.ts);

  const deduped: BtcEvent[] = [];
  let lastTs = -Infinity;
  for (const evt of rawEvents) {
    if (evt.ts - lastTs >= dedupMs) {
      deduped.push(evt);
      lastTs = evt.ts;
    }
  }

  return deduped;
}

// ---- BTC Trend (EMA9/21) ----
function computeBtcTrend(): Map<number, "up" | "down"> {
  const btc1h = loadCandles("BTCUSDT");
  if (btc1h.length < 25) return new Map();

  const closes = btc1h.map(c => c.c);
  const ema9vals = EMA.calculate({ period: 9, values: closes });
  const ema21vals = EMA.calculate({ period: 21, values: closes });

  // EMA9 starts at index 8 (period-1), EMA21 starts at index 20
  const trendMap = new Map<number, "up" | "down">();
  const offset9 = 9 - 1;
  const offset21 = 21 - 1;

  for (let i = offset21; i < btc1h.length; i++) {
    const e9idx = i - offset9;
    const e21idx = i - offset21;
    if (e9idx < 0 || e9idx >= ema9vals.length) continue;
    if (e21idx < 0 || e21idx >= ema21vals.length) continue;
    const e9 = ema9vals[e9idx];
    const e21 = ema21vals[e21idx];
    trendMap.set(btc1h[i].t, e9 > e21 ? "up" : "down");
  }

  return trendMap;
}

// ---- Simulation ----
interface SimConfig {
  name: string;
  tp: number;
  sl: number;
  maxHoldMs: number;
  staleCheckMs: number;    // 0 = disabled
  staleMinMove: number;
  pairs: string[];
  maxPerDir: number;
  cooldownMs: number;
  dailyLossLimit: number;
  trendFilter: boolean;
  compound: boolean;
  startEquity: number;
}

interface SimResult {
  trades: Trade[];
  equityCurve: number[];
  events: BtcEvent[];
  eventsFiltered: number;
  finalEquity: number;
  maxEquity: number;
  maxDdPct: number;
  monthlyEquity: { month: string; equity: number }[];
}

function simulate(
  cfg: SimConfig,
  events: BtcEvent[],
  pairDataMap: Map<string, { candles: Candle[]; tsMap: Map<number, number> }>,
  trendMap: Map<number, "up" | "down">,
): SimResult {
  const allTs = new Set<number>();
  for (const [, pd] of pairDataMap) {
    for (const c of pd.candles) {
      if (c.t >= START_TS && c.t < END_TS) allTs.add(c.t);
    }
  }
  const sortedTs = [...allTs].sort((a, b) => a - b);

  const openPos = new Map<string, Position>();
  const trades: Trade[] = [];
  const eq: number[] = [];
  let cumPnl = 0;
  let eventsFiltered = 0;

  // Compound tracking
  let equity = cfg.startEquity;
  let maxEquity = equity;
  let maxDdPct = 0;
  const monthlySnap: { month: string; equity: number }[] = [];
  let lastMonth = "";

  const dirCooldown = new Map<string, number>();
  const slCooldown = new Map<string, number>();
  const dailyLoss = new Map<number, number>();

  function getDayIdx(ts: number): number { return Math.floor(ts / DAY_MS); }
  function getDayLoss(ts: number): number { return dailyLoss.get(getDayIdx(ts)) ?? 0; }
  function addDayLoss(ts: number, loss: number): void {
    const d = getDayIdx(ts);
    dailyLoss.set(d, (dailyLoss.get(d) ?? 0) + loss);
  }

  function getPositionSize(): number {
    if (!cfg.compound) return FIXED_SIZE;
    // Risk 4% of equity per trade: size = equity * 0.04 / (SL * LEVERAGE)
    const riskPerUnit = cfg.sl * LEVERAGE;
    const size = equity * 0.04 / riskPerUnit;
    return Math.max(10, Math.floor(size));
  }

  const sortedEvents = [...events].sort((a, b) => a.ts - b.ts);

  for (const ts of sortedTs) {
    // Month snapshot
    const monthStr = new Date(ts).toISOString().slice(0, 7);
    if (monthStr !== lastMonth && lastMonth !== "") {
      monthlySnap.push({ month: lastMonth, equity: cfg.compound ? equity : cfg.startEquity + cumPnl });
    }
    lastMonth = monthStr;

    const closed = new Set<string>();

    const eventsInWindow = sortedEvents.filter(e => e.ts >= ts - HOUR_MS && e.ts < ts);

    // ---- EXITS ----
    for (const [pk, pos] of openPos) {
      const fn = PAIR_MAP[pos.pair];
      if (!fn) continue;
      const pd = pairDataMap.get(fn);
      if (!pd) continue;
      const bi = pd.tsMap.get(ts) ?? -1;
      if (bi < 0) continue;
      const bar = pd.candles[bi];
      const sp = getSpread(fn);

      let ep = 0, reason = "";

      if (pos.direction === "long" ? bar.l <= pos.stopLoss : bar.h >= pos.stopLoss) {
        ep = pos.direction === "long" ? pos.stopLoss * (1 - sp) : pos.stopLoss * (1 + sp);
        reason = "sl";
      }
      if (!reason && (pos.direction === "long" ? bar.h >= pos.takeProfit : bar.l <= pos.takeProfit)) {
        ep = pos.direction === "long" ? pos.takeProfit * (1 - sp) : pos.takeProfit * (1 + sp);
        reason = "tp";
      }
      if (!reason && cfg.staleCheckMs > 0 && ts >= pos.staleCheckTs) {
        const move = pos.direction === "long"
          ? (bar.c - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - bar.c) / pos.entryPrice;
        if (move < cfg.staleMinMove) {
          ep = pos.direction === "long" ? bar.o * (1 - sp) : bar.o * (1 + sp);
          reason = "stale";
        }
      }
      if (!reason && ts - pos.entryTime >= cfg.maxHoldMs) {
        ep = pos.direction === "long" ? bar.o * (1 - sp) : bar.o * (1 + sp);
        reason = "maxhold";
      }

      if (reason) {
        const sz = pos.size;
        const f = sz * LEVERAGE * HL_FEE * 2;
        const raw = pos.direction === "long"
          ? (ep / pos.entryPrice - 1) * sz * LEVERAGE
          : (pos.entryPrice / ep - 1) * sz * LEVERAGE;
        const pnl = raw - f;
        cumPnl += pnl;

        if (cfg.compound) {
          equity += pnl;
          if (equity > maxEquity) maxEquity = equity;
          const dd = (maxEquity - equity) / maxEquity * 100;
          if (dd > maxDdPct) maxDdPct = dd;
        }

        trades.push({
          pair: pos.pair, direction: pos.direction,
          entryPrice: pos.entryPrice, exitPrice: ep,
          entryTime: pos.entryTime, exitTime: ts,
          pnl, reason, size: sz,
        });
        openPos.delete(pk);
        closed.add(pk);

        if (pnl < 0) addDayLoss(ts, Math.abs(pnl));
        if (reason === "sl") {
          slCooldown.set(`${pos.pair}:${pos.direction}`, ts + 2 * HOUR_MS);
        }
      }
    }

    // ---- ENTRIES ----
    if (eventsInWindow.length > 0) {
      const evt = eventsInWindow[eventsInWindow.length - 1];
      const dir = evt.direction;

      // Trend filter
      if (cfg.trendFilter) {
        // Find closest trend value at or before this timestamp
        let trend: "up" | "down" | undefined;
        // The trendMap keys are hourly, find the one for this bar
        trend = trendMap.get(ts);
        if (!trend) {
          // Find nearest previous
          const hr = Math.floor(ts / HOUR_MS) * HOUR_MS;
          trend = trendMap.get(hr);
        }
        if (trend) {
          if (dir === "long" && trend !== "up") { eventsFiltered++; goto_mtm(); continue; }
          if (dir === "short" && trend !== "down") { eventsFiltered++; goto_mtm(); continue; }
        }
      }

      // Direction cooldown
      if (cfg.cooldownMs > 0) {
        const nextAllowed = dirCooldown.get(dir) ?? 0;
        if (ts < nextAllowed) {
          eventsFiltered++;
          goto_mtm();
          continue;
        }
      }

      // Daily loss limit
      if (cfg.dailyLossLimit > 0 && getDayLoss(ts) >= cfg.dailyLossLimit) {
        eventsFiltered++;
      } else {
        if (cfg.cooldownMs > 0) dirCooldown.set(dir, ts + cfg.cooldownMs);

        const posSize = getPositionSize();

        for (const pair of cfg.pairs) {
          const pk = `n-${pair}`;
          if (openPos.has(pk) || closed.has(pk)) continue;

          const slKey = `${pair}:${dir}`;
          const nextAllowed = slCooldown.get(slKey) ?? 0;
          if (ts < nextAllowed) continue;

          const dirCount = [...openPos.values()].filter(p => p.direction === dir).length;
          if (dirCount >= cfg.maxPerDir) continue;

          const fn = PAIR_MAP[pair];
          if (!fn) continue;
          const pd = pairDataMap.get(fn);
          if (!pd) continue;
          const bi = pd.tsMap.get(ts) ?? -1;
          if (bi < 10) continue;
          const bar = pd.candles[bi];
          const spread = getSpread(fn);
          const entry = dir === "long" ? bar.o * (1 + spread) : bar.o * (1 - spread);

          openPos.set(pk, {
            pair, direction: dir,
            entryPrice: entry, entryTime: ts,
            stopLoss: dir === "long" ? entry * (1 - cfg.sl) : entry * (1 + cfg.sl),
            takeProfit: dir === "long" ? entry * (1 + cfg.tp) : entry * (1 - cfg.tp),
            staleCheckTs: cfg.staleCheckMs > 0 ? ts + cfg.staleCheckMs : Infinity,
            size: posSize,
          });
        }
      }
    }

    goto_mtm();

    function goto_mtm() {
      let unrealized = 0;
      for (const [, pos] of openPos) {
        const fn = PAIR_MAP[pos.pair]; if (!fn) continue;
        const pd = pairDataMap.get(fn); if (!pd) continue;
        const bi = pd.tsMap.get(ts) ?? -1; if (bi < 0) continue;
        const price = pd.candles[bi].c;
        const sz = pos.size;
        const raw = pos.direction === "long"
          ? (price / pos.entryPrice - 1) * sz * LEVERAGE
          : (pos.entryPrice / price - 1) * sz * LEVERAGE;
        unrealized += raw - sz * LEVERAGE * HL_FEE * 2;
      }
      eq.push(cfg.compound ? equity + unrealized : cumPnl + unrealized);
    }
  }

  // Final month snapshot
  if (lastMonth) {
    monthlySnap.push({ month: lastMonth, equity: cfg.compound ? equity : cfg.startEquity + cumPnl });
  }

  // Non-compound MaxDD
  if (!cfg.compound) {
    let peak = -Infinity;
    for (const e of eq) {
      if (e > peak) peak = e;
      const dd = peak - e;
      const ddPct = peak > 0 ? dd / peak * 100 : 0;
      if (ddPct > maxDdPct) maxDdPct = ddPct;
    }
    maxEquity = peak;
  }

  return {
    trades, equityCurve: eq, events, eventsFiltered,
    finalEquity: cfg.compound ? equity : cfg.startEquity + cumPnl,
    maxEquity, maxDdPct, monthlyEquity: monthlySnap,
  };
}

// ---- Stats ----
interface Stats {
  name: string; events: number; eventsFiltered: number; trades: number; wins: number;
  winRate: number; totalPnl: number; perDay: number; maxDd: number; maxDdPct: number;
  sharpe: number; profitFactor: number; avgWin: number; avgLoss: number;
  fees: number; tpExits: number; slExits: number; staleExits: number; maxholdExits: number;
  finalEquity: number; maxEquity: number;
  monthlyEquity: { month: string; equity: number }[];
  riskAdj: number;
  compoundFinal: number;
}

function computeStats(name: string, result: SimResult, cfg: SimConfig): Stats {
  const { trades, equityCurve, events, eventsFiltered } = result;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const lossTrades = trades.filter(t => t.pnl <= 0);

  let maxDd = 0, peak = -Infinity;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDd) maxDd = dd;
  }

  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.exitTime / DAY_MS);
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.pnl);
  }
  const dr = Array.from(dailyPnl.values());
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  const winTrades = trades.filter(t => t.pnl > 0);
  const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length : 0;
  const grossWins = winTrades.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(lossTrades.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : 0;
  const fees = trades.reduce((s, t) => s + t.size * LEVERAGE * HL_FEE * 2, 0);

  const tpExits = trades.filter(t => t.reason === "tp").length;
  const slExits = trades.filter(t => t.reason === "sl").length;
  const staleExits = trades.filter(t => t.reason === "stale").length;
  const maxholdExits = trades.filter(t => t.reason === "maxhold").length;

  const perDay = totalPnl / DAYS;
  const riskAdj = maxDd > 0 && profitFactor > 0 ? perDay * profitFactor / maxDd : 0;

  return {
    name, events: events.length, eventsFiltered, trades: trades.length,
    wins, winRate: trades.length > 0 ? wins / trades.length * 100 : 0,
    totalPnl, perDay, maxDd, maxDdPct: result.maxDdPct, sharpe, profitFactor,
    avgWin, avgLoss, fees,
    tpExits, slExits, staleExits, maxholdExits,
    finalEquity: result.finalEquity, maxEquity: result.maxEquity,
    monthlyEquity: result.monthlyEquity,
    riskAdj,
    compoundFinal: cfg.compound ? result.finalEquity : 0,
  };
}

// ---- Formatting ----
function fmtRow(s: Stats): string {
  return [
    s.name.padEnd(40),
    String(s.events).padStart(5),
    String(s.trades).padStart(6),
    `${s.winRate.toFixed(0)}%`.padStart(5),
    `$${s.totalPnl.toFixed(0)}`.padStart(7),
    `$${s.perDay.toFixed(2)}`.padStart(8),
    `$${s.maxDd.toFixed(0)}`.padStart(7),
    s.sharpe.toFixed(2).padStart(7),
    s.profitFactor.toFixed(2).padStart(6),
  ].join(" | ");
}

function printHeader(): void {
  const hdr = [
    "Config".padEnd(40), "Evts".padStart(5),
    "Trades".padStart(6), "WR%".padStart(5),
    "PnL".padStart(7), "$/day".padStart(8), "MaxDD".padStart(7),
    "Sharpe".padStart(7), "PF".padStart(6),
  ].join(" | ");
  output(hdr);
  output("-".repeat(hdr.length));
}

// Output buffer for file save
const outputLines: string[] = [];
function output(line: string): void {
  console.log(line);
  outputLines.push(line);
}

// ---- Default SimConfig factory ----
function defaultCfg(name: string, overrides: Partial<SimConfig> = {}): SimConfig {
  return {
    name,
    tp: 0.05,
    sl: 0.05,
    maxHoldMs: 24 * HOUR_MS,
    staleCheckMs: HOUR_MS,
    staleMinMove: 0.003,
    pairs: [...ALL_PAIRS],
    maxPerDir: 6,
    cooldownMs: 0,
    dailyLossLimit: 0,
    trendFilter: false,
    compound: false,
    startEquity: 150,
    ...overrides,
  };
}

// ---- Main ----
function main(): void {
  const t0 = Date.now();

  output("=== BTC EVENT DEEP OPTIMIZATION ===");
  output(`Period: ${DAYS.toFixed(0)} days (${new Date(START_TS).toISOString().slice(0, 10)} to ${new Date(END_TS).toISOString().slice(0, 10)})`);
  output(`Fixed Size: $${FIXED_SIZE} | Leverage: ${LEVERAGE}x | Fee: ${(HL_FEE * 100).toFixed(3)}%`);
  output(`Pairs: ${ALL_PAIRS.join(", ")}\n`);

  // Load pair data
  const pairDataMap = new Map<string, { candles: Candle[]; tsMap: Map<number, number> }>();
  for (const [pair, fn] of Object.entries(PAIR_MAP)) {
    const candles = loadCandles(fn);
    if (candles.length < 100) {
      output(`  Skipping ${pair} - only ${candles.length} candles`);
      continue;
    }
    const tsMap = new Map<number, number>();
    candles.forEach((c, i) => tsMap.set(c.t, i));
    pairDataMap.set(fn, { candles, tsMap });
    output(`  Loaded ${pair} (${fn}): ${candles.length} candles`);
  }

  // Compute trend filter
  output("\nComputing BTC EMA9/21 trend...");
  const trendMap = computeBtcTrend();
  output(`  Trend data points: ${trendMap.size}`);

  // Cache events by threshold to avoid recomputation
  const eventCache = new Map<string, BtcEvent[]>();
  function getEvents(threshold: number, dedupMs: number = HOUR_MS): BtcEvent[] {
    const key = `${threshold}:${dedupMs}`;
    if (!eventCache.has(key)) {
      eventCache.set(key, loadBtcMoveEvents(threshold, dedupMs));
    }
    return eventCache.get(key)!;
  }

  const allResults: Stats[] = [];

  function runSim(cfg: SimConfig, events: BtcEvent[]): Stats {
    const result = simulate(cfg, events, pairDataMap, trendMap);
    return computeStats(cfg.name, result, cfg);
  }

  // ============================================================
  // SECTION A: Event Threshold Sweep
  // ============================================================
  output("\n" + "=".repeat(80));
  output("SECTION A: EVENT THRESHOLD SWEEP");
  output("Fixed: top10, TP5/SL5, 24h hold, stale 1h@0.3%, cap 6/dir");
  output("=".repeat(80));
  printHeader();

  const thresholds = [0.005, 0.006, 0.007, 0.008, 0.009, 0.010, 0.012];
  for (const th of thresholds) {
    const events = getEvents(th);
    const name = `Thresh=${(th * 100).toFixed(1)}%`;
    const cfg = defaultCfg(name);
    const stats = runSim(cfg, events);
    allResults.push(stats);
    output(fmtRow(stats));
  }

  // ============================================================
  // SECTION B: Stale Exit Sweep
  // ============================================================
  output("\n" + "=".repeat(80));
  output("SECTION B: STALE EXIT SWEEP");
  output("Fixed: 0.7% threshold, top10, TP5/SL5, 24h hold, cap 6/dir");
  output("=".repeat(80));
  printHeader();

  const events07 = getEvents(0.007);

  const staleCfgs: { label: string; checkMs: number; minMove: number }[] = [
    { label: "NoStale", checkMs: 0, minMove: 0 },
    { label: "1h@0.2%", checkMs: HOUR_MS, minMove: 0.002 },
    { label: "1h@0.3%", checkMs: HOUR_MS, minMove: 0.003 },
    { label: "1h@0.5%", checkMs: HOUR_MS, minMove: 0.005 },
    { label: "2h@0.3%", checkMs: 2 * HOUR_MS, minMove: 0.003 },
    { label: "2h@0.5%", checkMs: 2 * HOUR_MS, minMove: 0.005 },
  ];

  for (const sc of staleCfgs) {
    const name = `Stale=${sc.label}`;
    const cfg = defaultCfg(name, { staleCheckMs: sc.checkMs, staleMinMove: sc.minMove });
    const stats = runSim(cfg, events07);
    allResults.push(stats);
    output(fmtRow(stats));
  }

  // ============================================================
  // SECTION C: TP/SL Sweep
  // ============================================================
  output("\n" + "=".repeat(80));
  output("SECTION C: TP/SL SWEEP");
  output("Fixed: 0.7% threshold, top10, 24h hold, stale 1h@0.3%, cap 6/dir");
  output("=".repeat(80));
  printHeader();

  const tpValues = [0.02, 0.03, 0.05, 0.07, 0.10];
  const slValues = [0.02, 0.03, 0.05, 0.07];

  let bestTpSlScore = -Infinity;
  let bestTp = 0.05, bestSl = 0.05;

  for (const tp of tpValues) {
    for (const sl of slValues) {
      const name = `TP${(tp * 100).toFixed(0)}/SL${(sl * 100).toFixed(0)}`;
      const cfg = defaultCfg(name, { tp, sl });
      const stats = runSim(cfg, events07);
      allResults.push(stats);
      output(fmtRow(stats));

      // Score: weight $/day, PF, WR, low MaxDD
      const score = stats.perDay * 2 + stats.profitFactor * 0.5 - stats.maxDd * 0.01 + (stats.winRate / 100) * 0.5;
      if (score > bestTpSlScore) {
        bestTpSlScore = score;
        bestTp = tp;
        bestSl = sl;
      }
    }
  }

  output(`\n>> Best TP/SL: TP${(bestTp * 100).toFixed(0)}/SL${(bestSl * 100).toFixed(0)} (score=${bestTpSlScore.toFixed(2)})`);

  // ============================================================
  // SECTION D: BTC Trend Filter
  // ============================================================
  output("\n" + "=".repeat(80));
  output("SECTION D: BTC TREND FILTER (EMA9/21)");
  output("Fixed: 0.7% threshold, top10, 24h hold, stale 1h@0.3%, cap 6/dir");
  output("=".repeat(80));
  printHeader();

  // Baseline (no trend filter) with TP5/SL5
  const baseNoTrend = defaultCfg("NoTrend TP5/SL5");
  const statsNoTrend = runSim(baseNoTrend, events07);
  allResults.push(statsNoTrend);
  output(fmtRow(statsNoTrend));

  // With trend filter TP5/SL5
  const withTrend = defaultCfg("WithTrend TP5/SL5", { trendFilter: true });
  const statsTrend = runSim(withTrend, events07);
  allResults.push(statsTrend);
  output(fmtRow(statsTrend));

  // Best TP/SL + no trend
  const bestTpSlNoTrend = defaultCfg(`NoTrend TP${(bestTp*100).toFixed(0)}/SL${(bestSl*100).toFixed(0)}`, { tp: bestTp, sl: bestSl });
  const statsBestNoTrend = runSim(bestTpSlNoTrend, events07);
  allResults.push(statsBestNoTrend);
  output(fmtRow(statsBestNoTrend));

  // Best TP/SL + trend filter
  const bestTpSlTrend = defaultCfg(`WithTrend TP${(bestTp*100).toFixed(0)}/SL${(bestSl*100).toFixed(0)}`, { tp: bestTp, sl: bestSl, trendFilter: true });
  const statsBestTrend = runSim(bestTpSlTrend, events07);
  allResults.push(statsBestTrend);
  output(fmtRow(statsBestTrend));

  // ============================================================
  // SECTION E: Pair Count Sweep
  // ============================================================
  output("\n" + "=".repeat(80));
  output("SECTION E: PAIR COUNT SWEEP");
  output("Fixed: 0.7% threshold, TP5/SL5, 24h hold, stale 1h@0.3%, cap 6/dir");
  output("=".repeat(80));
  printHeader();

  const pairSets: { label: string; pairs: string[] }[] = [
    { label: "top3", pairs: ["TIA", "kBONK", "OP"] },
    { label: "top5", pairs: ["TIA", "kBONK", "OP", "LDO", "APT"] },
    { label: "top7", pairs: ["TIA", "kBONK", "OP", "LDO", "APT", "NEAR", "ARB"] },
    { label: "top10", pairs: [...ALL_PAIRS] },
  ];

  for (const ps of pairSets) {
    const name = `Pairs=${ps.label}(${ps.pairs.length})`;
    const cfg = defaultCfg(name, { pairs: ps.pairs });
    const stats = runSim(cfg, events07);
    allResults.push(stats);
    output(fmtRow(stats));
  }

  // ============================================================
  // SECTION F: Hold Time Sweep
  // ============================================================
  output("\n" + "=".repeat(80));
  output("SECTION F: HOLD TIME SWEEP");
  output("Fixed: 0.7% threshold, top10, TP5/SL5, stale 1h@0.3%, cap 6/dir");
  output("=".repeat(80));
  printHeader();

  const holdTimes = [4, 8, 12, 24, 48];
  for (const h of holdTimes) {
    const name = `Hold=${h}h`;
    const cfg = defaultCfg(name, { maxHoldMs: h * HOUR_MS });
    const stats = runSim(cfg, events07);
    allResults.push(stats);
    output(fmtRow(stats));
  }

  // ============================================================
  // SECTION G: Position Cap Sweep
  // ============================================================
  output("\n" + "=".repeat(80));
  output("SECTION G: POSITION CAP SWEEP");
  output("Fixed: 0.7% threshold, top10, TP5/SL5, 24h hold, stale 1h@0.3%");
  output("=".repeat(80));
  printHeader();

  const caps = [3, 4, 5, 6, 8, 10];
  for (const cap of caps) {
    const name = `Cap=${cap}/dir`;
    const cfg = defaultCfg(name, { maxPerDir: cap });
    const stats = runSim(cfg, events07);
    allResults.push(stats);
    output(fmtRow(stats));
  }

  // ============================================================
  // SECTION H: Daily Loss Limit Sweep
  // ============================================================
  output("\n" + "=".repeat(80));
  output("SECTION H: DAILY LOSS LIMIT SWEEP");
  output("=".repeat(80));
  printHeader();

  const dlls = [0, 5, 10, 15];
  for (const dll of dlls) {
    const name = `DLL=${dll === 0 ? "none" : "$" + dll}`;
    const cfg = defaultCfg(name, { dailyLossLimit: dll });
    const stats = runSim(cfg, events07);
    allResults.push(stats);
    output(fmtRow(stats));
  }

  // ============================================================
  // FIND OVERALL BEST CONFIG
  // ============================================================
  output("\n" + "=".repeat(80));
  output("OVERALL RANKINGS");
  output("=".repeat(80));

  // Filter to configs with >= 100 trades for meaningful stats
  const qualified = allResults.filter(s => s.trades >= 100);

  // TOP 10 BY WIN RATE
  output("\n--- TOP 10 BY WIN RATE (min 100 trades) ---");
  printHeader();
  const byWR = [...qualified].sort((a, b) => b.winRate - a.winRate).slice(0, 10);
  for (const s of byWR) output(fmtRow(s));

  // TOP 10 BY LOWEST MaxDD (profitable only)
  output("\n--- TOP 10 BY LOWEST MaxDD (profitable only) ---");
  printHeader();
  const byDD = [...qualified].filter(s => s.totalPnl > 0).sort((a, b) => a.maxDd - b.maxDd).slice(0, 10);
  for (const s of byDD) output(fmtRow(s));

  // TOP 10 BY $/DAY
  output("\n--- TOP 10 BY $/DAY ---");
  printHeader();
  const byPD = [...qualified].sort((a, b) => b.perDay - a.perDay).slice(0, 10);
  for (const s of byPD) output(fmtRow(s));

  // TOP 10 RISK-ADJUSTED ($/day * PF / MaxDD)
  output("\n--- TOP 10 RISK-ADJUSTED ($/day * PF / MaxDD) ---");
  printHeader();
  const byRA = [...qualified].filter(s => s.maxDd > 0).sort((a, b) => b.riskAdj - a.riskAdj).slice(0, 10);
  for (const s of byRA) output(fmtRow(s));

  // ============================================================
  // DETERMINE BEST OVERALL CONFIG
  // ============================================================
  // Composite score: normalize and weight
  const bestOverall = [...qualified].filter(s => s.totalPnl > 0 && s.maxDd > 0).sort((a, b) => {
    const scoreA = a.perDay * 2 + a.profitFactor + (a.winRate / 100) - a.maxDd * 0.02 + a.sharpe * 0.5;
    const scoreB = b.perDay * 2 + b.profitFactor + (b.winRate / 100) - b.maxDd * 0.02 + b.sharpe * 0.5;
    return scoreB - scoreA;
  });

  const winner = bestOverall[0];
  output("\n" + "=".repeat(80));
  output(`BEST OVERALL CONFIG: ${winner?.name ?? "N/A"}`);
  if (winner) {
    output(`  Events: ${winner.events} | Trades: ${winner.trades} | Wins: ${winner.wins}`);
    output(`  Win Rate: ${winner.winRate.toFixed(1)}%`);
    output(`  Total PnL: $${winner.totalPnl.toFixed(2)}`);
    output(`  $/day: $${winner.perDay.toFixed(2)}`);
    output(`  MaxDD: $${winner.maxDd.toFixed(2)}`);
    output(`  Sharpe: ${winner.sharpe.toFixed(2)}`);
    output(`  PF: ${winner.profitFactor.toFixed(2)}`);
    output(`  Avg Win: $${winner.avgWin.toFixed(2)} | Avg Loss: $${winner.avgLoss.toFixed(2)}`);
    output(`  Exits: TP=${winner.tpExits} SL=${winner.slExits} Stale=${winner.staleExits} MaxHold=${winner.maxholdExits}`);
  }

  // ============================================================
  // SECTION I: COMPOUND SIMULATION with best config
  // ============================================================
  output("\n" + "=".repeat(80));
  output("SECTION I: COMPOUND SIMULATION");
  output(`Using best config: ${winner?.name ?? "TP5/SL5 default"}`);
  output("Start: $150, Risk: 4% per trade");
  output("=".repeat(80));

  // Parse best config params from the winner name or use defaults
  // We'll run compound with the fixed defaults (0.7% thresh, stale 1h@0.3%, etc.)
  // but using the best TP/SL found
  const compCfg = defaultCfg("COMPOUND", {
    tp: bestTp,
    sl: bestSl,
    compound: true,
    startEquity: 150,
  });
  const compResult = simulate(compCfg, events07, pairDataMap, trendMap);
  const compStats = computeStats("COMPOUND", compResult, compCfg);
  allResults.push(compStats);

  output(`\nCompound Simulation Results:`);
  output(`  Starting Equity: $150.00`);
  output(`  Final Equity:    $${compResult.finalEquity.toFixed(2)}`);
  output(`  Max Equity:      $${compResult.maxEquity.toFixed(2)}`);
  output(`  Max Drawdown:    ${compResult.maxDdPct.toFixed(1)}%`);
  output(`  Trades: ${compStats.trades} | Wins: ${compStats.wins} | WR: ${compStats.winRate.toFixed(1)}%`);

  // CAGR
  const years = DAYS / 365;
  const cagr = compResult.finalEquity > 0
    ? (Math.pow(compResult.finalEquity / 150, 1 / years) - 1) * 100
    : -100;
  output(`  CAGR: ${cagr.toFixed(1)}%`);

  output(`\n  Month-by-Month Equity:`);
  output(`  ${"Month".padEnd(10)} | ${"Equity".padStart(12)} | ${"Growth".padStart(10)}`);
  output(`  ${"-".repeat(38)}`);
  let prevEq = 150;
  for (const m of compResult.monthlyEquity) {
    const growth = ((m.equity - prevEq) / prevEq * 100);
    output(`  ${m.month.padEnd(10)} | $${m.equity.toFixed(2).padStart(11)} | ${growth >= 0 ? "+" : ""}${growth.toFixed(1)}%`);
    prevEq = m.equity;
  }

  // Also run compound with trend filter
  output("\n--- Compound + Trend Filter ---");
  const compTrendCfg = defaultCfg("COMPOUND+TREND", {
    tp: bestTp,
    sl: bestSl,
    compound: true,
    startEquity: 150,
    trendFilter: true,
  });
  const compTrendResult = simulate(compTrendCfg, events07, pairDataMap, trendMap);
  const compTrendStats = computeStats("COMPOUND+TREND", compTrendResult, compTrendCfg);
  allResults.push(compTrendStats);

  output(`  Final Equity: $${compTrendResult.finalEquity.toFixed(2)}`);
  output(`  Max DD: ${compTrendResult.maxDdPct.toFixed(1)}%`);
  output(`  Trades: ${compTrendStats.trades} | WR: ${compTrendStats.winRate.toFixed(1)}%`);
  const cagrTrend = compTrendResult.finalEquity > 0
    ? (Math.pow(compTrendResult.finalEquity / 150, 1 / years) - 1) * 100
    : -100;
  output(`  CAGR: ${cagrTrend.toFixed(1)}%`);

  // TOP 10 BY COMPOUND FINAL BALANCE
  output("\n--- TOP 10 BY COMPOUND FINAL BALANCE ---");
  // Run compound for top candidates
  const topCandidates = bestOverall.slice(0, 15);
  const compoundResults: { name: string; finalEq: number; maxDdPct: number; trades: number; wr: number }[] = [];

  // We already have the two compound sims above, add them
  compoundResults.push({
    name: `COMPOUND(TP${(bestTp*100).toFixed(0)}/SL${(bestSl*100).toFixed(0)})`,
    finalEq: compResult.finalEquity,
    maxDdPct: compResult.maxDdPct,
    trades: compStats.trades,
    wr: compStats.winRate,
  });
  compoundResults.push({
    name: `COMPOUND+TREND(TP${(bestTp*100).toFixed(0)}/SL${(bestSl*100).toFixed(0)})`,
    finalEq: compTrendResult.finalEquity,
    maxDdPct: compTrendResult.maxDdPct,
    trades: compTrendStats.trades,
    wr: compTrendStats.winRate,
  });

  // Run compound for various TP/SL combos
  for (const tp of tpValues) {
    for (const sl of slValues) {
      const cCfg = defaultCfg(`cmp-TP${(tp*100).toFixed(0)}/SL${(sl*100).toFixed(0)}`, {
        tp, sl, compound: true, startEquity: 150,
      });
      const cRes = simulate(cCfg, events07, pairDataMap, trendMap);
      compoundResults.push({
        name: `TP${(tp*100).toFixed(0)}/SL${(sl*100).toFixed(0)}`,
        finalEq: cRes.finalEquity,
        maxDdPct: cRes.maxDdPct,
        trades: cRes.trades.length,
        wr: cRes.trades.length > 0 ? cRes.trades.filter(t => t.pnl > 0).length / cRes.trades.length * 100 : 0,
      });
    }
  }

  compoundResults.sort((a, b) => b.finalEq - a.finalEq);
  output(`  ${"Config".padEnd(40)} | ${"Final$".padStart(10)} | ${"MaxDD%".padStart(8)} | ${"Trades".padStart(6)} | ${"WR%".padStart(5)}`);
  output(`  ${"-".repeat(78)}`);
  for (const cr of compoundResults.slice(0, 10)) {
    output(`  ${cr.name.padEnd(40)} | $${cr.finalEq.toFixed(2).padStart(9)} | ${cr.maxDdPct.toFixed(1).padStart(7)}% | ${String(cr.trades).padStart(6)} | ${cr.wr.toFixed(0).padStart(4)}%`);
  }

  // ============================================================
  // FINAL SUMMARY
  // ============================================================
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  output("\n" + "=".repeat(80));
  output(`OPTIMIZATION COMPLETE in ${elapsed}s`);
  output(`Total configurations tested: ${allResults.length}`);
  output(`Best config: ${winner?.name ?? "N/A"}`);
  output(`Best TP/SL: TP${(bestTp*100).toFixed(0)}%/SL${(bestSl*100).toFixed(0)}%`);
  output(`Compound $150 -> $${compResult.finalEquity.toFixed(2)} (${cagr.toFixed(0)}% CAGR)`);
  output("=".repeat(80));

  // Save to file
  fs.writeFileSync("/tmp/338-optimization.txt", outputLines.join("\n"), "utf8");
  output("\nResults saved to /tmp/338-optimization.txt");
}

main();
