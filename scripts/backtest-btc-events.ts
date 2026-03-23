/**
 * BTC event-driven backtest with cooldown/daily-cap variations.
 * Uses local cached data (no API calls).
 * Methodology from backtest-optimize-events.ts: backward-looking events, next-bar entry.
 *
 * Run: npx tsx scripts/backtest-btc-events.ts
 */

import * as fs from "fs";
import * as path from "path";

// ---- Types ----
interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }
interface BtcEvent { ts: number; direction: "long" | "short"; }
interface Position {
  pair: string; direction: "long" | "short";
  entryPrice: number; entryTime: number;
  stopLoss: number; takeProfit: number;
  staleCheckTs: number;
}
interface Trade {
  pair: string; direction: "long" | "short";
  entryPrice: number; exitPrice: number;
  entryTime: number; exitTime: number;
  pnl: number; reason: string;
}

// ---- Constants ----
const CACHE_DIR = "/tmp/bt-pair-cache";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const HL_FEE = 0.00035;
const SIZE = 20;
const LEVERAGE = 10;
const START_TS = new Date("2025-06-01T00:00:00Z").getTime();
const END_TS = new Date("2026-03-20T00:00:00Z").getTime();
const DAYS = (END_TS - START_TS) / DAY_MS;

// Corrected from research: SL 5% not 3%
const TP_PCT = 0.05;
const SL_PCT = 0.05;
const MAX_HOLD_MS = 24 * HOUR_MS;
const STALE_CHECK_MS = HOUR_MS;
const STALE_MIN_MOVE = 0.003;
const EVENT_THRESHOLD = 0.007; // 0.7% BTC move
const DEDUP_WINDOW_MS = HOUR_MS;
const MAX_PER_DIR = 10;

// Proven top10 reactive pairs from research
const TOP10 = ["TIA", "kBONK", "OP", "LDO", "APT", "NEAR", "ARB", "ENA", "WLD", "ADA"];
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

// ---- BTC Event Detection (backward-looking, no look-ahead bias) ----
function loadBtcMoveEvents(): BtcEvent[] {
  const btc1mRaw = JSON.parse(fs.readFileSync("/tmp/btc-1m-candles.json", "utf8")) as number[][];
  const btc1m = btc1mRaw.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }));
  btc1m.sort((a, b) => a.t - b.t);

  const rawEvents: BtcEvent[] = [];

  // Look BACKWARD 15 bars (no look-ahead bias)
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

    const upExceeds = maxUp > EVENT_THRESHOLD;
    const downExceeds = Math.abs(maxDown) > EVENT_THRESHOLD;

    if (upExceeds && downExceeds) {
      rawEvents.push({ ts: candle.t, direction: maxUp >= Math.abs(maxDown) ? "long" : "short" });
    } else if (upExceeds) {
      rawEvents.push({ ts: candle.t, direction: "long" });
    } else if (downExceeds) {
      rawEvents.push({ ts: candle.t, direction: "short" });
    }
  }

  rawEvents.sort((a, b) => a.ts - b.ts);

  // Dedup: 1h window
  const deduped: BtcEvent[] = [];
  let lastTs = -Infinity;
  for (const evt of rawEvents) {
    if (evt.ts - lastTs >= DEDUP_WINDOW_MS) {
      deduped.push(evt);
      lastTs = evt.ts;
    }
  }

  return deduped;
}

// ---- Simulation ----
interface SimConfig {
  name: string;
  cooldownMs: number;      // per-direction cooldown after event (0 = none)
  dailyLossLimit: number;  // $ loss limit per day (0 = none)
  slCooldownMs: number;    // per-pair+direction cooldown after SL hit
}

interface SimResult {
  trades: Trade[];
  equityCurve: number[];
  events: BtcEvent[];
  eventsFiltered: number;
}

function simulate(cfg: SimConfig, events: BtcEvent[], pairDataMap: Map<string, { candles: Candle[]; tsMap: Map<number, number> }>): SimResult {
  // Collect all hourly timestamps from alt data
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

  // Per-direction cooldown tracking
  const dirCooldown = new Map<string, number>(); // "long"|"short" -> next allowed ts
  // Per-pair+direction SL cooldown
  const slCooldown = new Map<string, number>(); // "PAIR:dir" -> next allowed ts
  // Daily loss tracking
  const dailyLoss = new Map<number, number>(); // dayIndex -> cumulative loss

  function getDayIdx(ts: number): number { return Math.floor(ts / DAY_MS); }
  function getDayLoss(ts: number): number { return dailyLoss.get(getDayIdx(ts)) ?? 0; }
  function addDayLoss(ts: number, loss: number): void {
    const d = getDayIdx(ts);
    dailyLoss.set(d, (dailyLoss.get(d) ?? 0) + loss);
  }

  const sortedEvents = [...events].sort((a, b) => a.ts - b.ts);

  for (const ts of sortedTs) {
    const closed = new Set<string>();

    // Events in previous hour (entry on THIS bar = next bar after event)
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

      // SL check (conservative: SL before TP when both could trigger)
      if (pos.direction === "long" ? bar.l <= pos.stopLoss : bar.h >= pos.stopLoss) {
        ep = pos.direction === "long" ? pos.stopLoss * (1 - sp) : pos.stopLoss * (1 + sp);
        reason = "sl";
      }
      // TP check
      if (!reason && (pos.direction === "long" ? bar.h >= pos.takeProfit : bar.l <= pos.takeProfit)) {
        ep = pos.direction === "long" ? pos.takeProfit * (1 - sp) : pos.takeProfit * (1 + sp);
        reason = "tp";
      }
      // Stale check at 1h
      if (!reason && ts >= pos.staleCheckTs) {
        const move = pos.direction === "long"
          ? (bar.c - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - bar.c) / pos.entryPrice;
        if (move < STALE_MIN_MOVE) {
          ep = pos.direction === "long" ? bar.o * (1 - sp) : bar.o * (1 + sp);
          reason = "stale";
        }
      }
      // Max hold 24h
      if (!reason && ts - pos.entryTime >= MAX_HOLD_MS) {
        ep = pos.direction === "long" ? bar.o * (1 - sp) : bar.o * (1 + sp);
        reason = "maxhold";
      }

      if (reason) {
        const f = SIZE * LEVERAGE * HL_FEE * 2;
        const raw = pos.direction === "long"
          ? (ep / pos.entryPrice - 1) * SIZE * LEVERAGE
          : (pos.entryPrice / ep - 1) * SIZE * LEVERAGE;
        const pnl = raw - f;
        cumPnl += pnl;
        trades.push({
          pair: pos.pair, direction: pos.direction,
          entryPrice: pos.entryPrice, exitPrice: ep,
          entryTime: pos.entryTime, exitTime: ts,
          pnl, reason,
        });
        openPos.delete(pk);
        closed.add(pk);

        // Track daily loss and SL cooldown
        if (pnl < 0) addDayLoss(ts, Math.abs(pnl));
        if (reason === "sl" && cfg.slCooldownMs > 0) {
          slCooldown.set(`${pos.pair}:${pos.direction}`, ts + cfg.slCooldownMs);
        }
      }
    }

    // ---- ENTRIES ----
    if (eventsInWindow.length > 0) {
      const evt = eventsInWindow[eventsInWindow.length - 1]; // latest event
      const dir = evt.direction;

      // Direction cooldown
      if (cfg.cooldownMs > 0) {
        const nextAllowed = dirCooldown.get(dir) ?? 0;
        if (ts < nextAllowed) {
          eventsFiltered++;
          // Mark-to-market before continue
          let unrealized = 0;
          for (const [, pos] of openPos) {
            const fn = PAIR_MAP[pos.pair]; if (!fn) continue;
            const pd = pairDataMap.get(fn); if (!pd) continue;
            const bi = pd.tsMap.get(ts) ?? -1; if (bi < 0) continue;
            const price = pd.candles[bi].c;
            const raw = pos.direction === "long" ? (price / pos.entryPrice - 1) * SIZE * LEVERAGE : (pos.entryPrice / price - 1) * SIZE * LEVERAGE;
            unrealized += raw - SIZE * LEVERAGE * HL_FEE * 2;
          }
          eq.push(cumPnl + unrealized);
          continue; // skip this bar entirely for entries
        }
      }

      // Daily loss limit
      if (cfg.dailyLossLimit > 0 && getDayLoss(ts) >= cfg.dailyLossLimit) {
        eventsFiltered++;
      } else {
        // Record cooldown
        if (cfg.cooldownMs > 0) dirCooldown.set(dir, ts + cfg.cooldownMs);

        for (const pair of TOP10) {
          const pk = `n-${pair}`;
          if (openPos.has(pk) || closed.has(pk)) continue;

          // SL cooldown per pair+direction
          if (cfg.slCooldownMs > 0) {
            const nextAllowed = slCooldown.get(`${pair}:${dir}`) ?? 0;
            if (ts < nextAllowed) continue;
          }

          // Max per direction cap
          const dirCount = [...openPos.values()].filter(p => p.direction === dir).length;
          if (dirCount >= MAX_PER_DIR) continue;

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
            stopLoss: dir === "long" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT),
            takeProfit: dir === "long" ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT),
            staleCheckTs: ts + STALE_CHECK_MS,
          });
        }
      }
    }

    // Mark-to-market equity (including unrealized)
    let unrealized = 0;
    for (const [, pos] of openPos) {
      const fn = PAIR_MAP[pos.pair]; if (!fn) continue;
      const pd = pairDataMap.get(fn); if (!pd) continue;
      const bi = pd.tsMap.get(ts) ?? -1; if (bi < 0) continue;
      const price = pd.candles[bi].c;
      const raw = pos.direction === "long"
        ? (price / pos.entryPrice - 1) * SIZE * LEVERAGE
        : (pos.entryPrice / price - 1) * SIZE * LEVERAGE;
      unrealized += raw - SIZE * LEVERAGE * HL_FEE * 2;
    }
    eq.push(cumPnl + unrealized);
  }

  return { trades, equityCurve: eq, events, eventsFiltered };
}

// ---- Stats ----
interface Stats {
  name: string; events: number; eventsFiltered: number; trades: number; wins: number;
  winRate: number; totalPnl: number; perDay: number; maxDd: number;
  sharpe: number; profitFactor: number; avgWin: number; avgLoss: number;
  fees: number; tpExits: number; slExits: number; staleExits: number; maxholdExits: number;
}

function computeStats(name: string, result: SimResult): Stats {
  const { trades, equityCurve, events, eventsFiltered } = result;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const lossTrades = trades.filter(t => t.pnl <= 0);

  // Mark-to-market MaxDD from equity curve
  let maxDd = 0, peak = -Infinity;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDd) maxDd = dd;
  }

  // Sharpe from daily P&L
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
  const fees = trades.length * SIZE * LEVERAGE * HL_FEE * 2;

  const tpExits = trades.filter(t => t.reason === "tp").length;
  const slExits = trades.filter(t => t.reason === "sl").length;
  const staleExits = trades.filter(t => t.reason === "stale").length;
  const maxholdExits = trades.filter(t => t.reason === "maxhold").length;

  return {
    name, events: events.length, eventsFiltered, trades: trades.length,
    wins, winRate: trades.length > 0 ? wins / trades.length * 100 : 0,
    totalPnl, perDay: totalPnl / DAYS, maxDd, sharpe, profitFactor,
    avgWin, avgLoss, fees,
    tpExits, slExits, staleExits, maxholdExits,
  };
}

// ---- Formatting ----
function fmtRow(s: Stats): string {
  return [
    s.name.padEnd(38),
    String(s.events).padStart(5),
    String(s.eventsFiltered).padStart(5),
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
  console.log([
    "Config".padEnd(38), "Evts".padStart(5), "Filt".padStart(5),
    "Trades".padStart(6), "WR%".padStart(5),
    "PnL".padStart(7), "$/day".padStart(8), "MaxDD".padStart(7),
    "Sharpe".padStart(7), "PF".padStart(6),
  ].join(" | "));
  console.log("-".repeat(120));
}

// ---- Main ----
function main(): void {
  console.log("=== BTC EVENT BACKTEST (TP5/SL5, Top10 Reactive) ===");
  console.log(`Period: ${DAYS.toFixed(0)} days (${new Date(START_TS).toISOString().slice(0, 10)} to ${new Date(END_TS).toISOString().slice(0, 10)})`);
  console.log(`Size: $${SIZE} | Leverage: ${LEVERAGE}x | Fee: ${(HL_FEE * 100).toFixed(3)}%`);
  console.log(`TP: ${(TP_PCT * 100).toFixed(0)}% | SL: ${(SL_PCT * 100).toFixed(0)}% | MaxHold: 24h | Stale: 1h@0.3%`);
  console.log(`Pairs: ${TOP10.join(", ")}\n`);

  // Load pair data
  const pairDataMap = new Map<string, { candles: Candle[]; tsMap: Map<number, number> }>();
  for (const [pair, fn] of Object.entries(PAIR_MAP)) {
    const candles = loadCandles(fn);
    if (candles.length < 100) {
      console.log(`  Skipping ${pair} - only ${candles.length} candles`);
      continue;
    }
    const tsMap = new Map<number, number>();
    candles.forEach((c, i) => tsMap.set(c.t, i));
    pairDataMap.set(fn, { candles, tsMap });
    console.log(`  Loaded ${pair} (${fn}): ${candles.length} candles`);
  }

  // Load BTC events
  const events = loadBtcMoveEvents();
  const longEvents = events.filter(e => e.direction === "long").length;
  const shortEvents = events.filter(e => e.direction === "short").length;
  console.log(`\nEvents detected: ${events.length} (${longEvents}L / ${shortEvents}S) after 1h dedup`);
  console.log(`Events per day: ${(events.length / DAYS).toFixed(1)}\n`);

  // ---- Variation testing ----
  const cooldowns = [0, 15 * 60_000, 30 * 60_000, 60 * 60_000]; // none, 15m, 30m, 1h
  const dailyLossLimits = [0, 10, 15, 25]; // none, $10, $15, $25

  const allStats: Stats[] = [];

  console.log("=== COOLDOWN VARIATIONS (no daily loss limit) ===");
  printHeader();
  for (const cd of cooldowns) {
    const cdLabel = cd === 0 ? "none" : `${cd / 60_000}min`;
    const name = `CD=${cdLabel}`;
    const result = simulate({ name, cooldownMs: cd, dailyLossLimit: 0, slCooldownMs: 2 * HOUR_MS }, events, pairDataMap);
    const stats = computeStats(name, result);
    allStats.push(stats);
    console.log(fmtRow(stats));
  }

  console.log("\n=== DAILY LOSS LIMIT VARIATIONS (no cooldown) ===");
  printHeader();
  for (const dll of dailyLossLimits) {
    const dllLabel = dll === 0 ? "none" : `$${dll}`;
    const name = `DLL=${dllLabel}`;
    const result = simulate({ name, cooldownMs: 0, dailyLossLimit: dll, slCooldownMs: 2 * HOUR_MS }, events, pairDataMap);
    const stats = computeStats(name, result);
    allStats.push(stats);
    console.log(fmtRow(stats));
  }

  console.log("\n=== COMBINED: COOLDOWN + DAILY LOSS LIMIT ===");
  printHeader();
  const bestCooldowns = [15 * 60_000, 30 * 60_000, 60 * 60_000];
  const bestDLL = [10, 15, 25];
  for (const cd of bestCooldowns) {
    for (const dll of bestDLL) {
      const cdLabel = `${cd / 60_000}m`;
      const dllLabel = `$${dll}`;
      const name = `CD=${cdLabel}+DLL=${dllLabel}`;
      const result = simulate({ name, cooldownMs: cd, dailyLossLimit: dll, slCooldownMs: 2 * HOUR_MS }, events, pairDataMap);
      const stats = computeStats(name, result);
      allStats.push(stats);
      console.log(fmtRow(stats));
    }
  }

  // ---- Best config detail ----
  const best = allStats.reduce((a, b) => {
    // Rank by Sharpe first, PF second
    const aScore = a.sharpe * 0.6 + a.profitFactor * 0.4;
    const bScore = b.sharpe * 0.6 + b.profitFactor * 0.4;
    return bScore > aScore ? b : a;
  });

  console.log(`\n=== BEST CONFIG: ${best.name} ===`);
  console.log(`Events: ${best.events} (${best.eventsFiltered} filtered)`);
  console.log(`Trades: ${best.trades} (${best.wins} wins, ${best.trades - best.wins} losses)`);
  console.log(`Win Rate: ${best.winRate.toFixed(1)}%`);
  console.log(`Total P&L: $${best.totalPnl.toFixed(2)}`);
  console.log(`Daily Avg: $${best.perDay.toFixed(2)}/day`);
  console.log(`Max Drawdown: $${best.maxDd.toFixed(2)} (mark-to-market)`);
  console.log(`Sharpe: ${best.sharpe.toFixed(2)}`);
  console.log(`Profit Factor: ${best.profitFactor.toFixed(2)}`);
  console.log(`Avg Win: $${best.avgWin.toFixed(2)} | Avg Loss: $${best.avgLoss.toFixed(2)}`);
  console.log(`Exits: TP=${best.tpExits} SL=${best.slExits} Stale=${best.staleExits} MaxHold=${best.maxholdExits}`);
  console.log(`Fees: $${best.fees.toFixed(2)}`);
}

main();
