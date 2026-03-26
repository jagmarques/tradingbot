import * as fs from "fs";
import * as path from "path";

// ── Config ──────────────────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const DAY = 86_400_000;
const FEE = 0.00035; // taker 0.035%
const SZ = 5; // $5 margin
const LEV = 10; // 10x leverage
const NOT = SZ * LEV; // $50 notional

const PAIRS = [
  "OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","TRUMPUSDT",
  "ENAUSDT","APTUSDT","TIAUSDT","UNIUSDT",
];

const SP: Record<string, number> = {
  OPUSDT: 6.2e-4, WIFUSDT: 5.05e-4, ARBUSDT: 2.6e-4,
  LDOUSDT: 5.8e-4, TRUMPUSDT: 3.65e-4, ENAUSDT: 2.55e-4,
  APTUSDT: 3.2e-4, TIAUSDT: 4.5e-4, UNIUSDT: 2.75e-4,
  BTCUSDT: 0.5e-4,
};

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-20").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// ── Types ───────────────────────────────────────────────────────────────────
interface C5 { t: number; o: number; h: number; l: number; c: number; v: number }
interface DailyBar { t: number; o: number; h: number; l: number; c: number; vol: number }
interface Trade { pnl: number; et: number; xt: number; pair: string; dir: "long" | "short"; reason: string }

// ── Load 5m candles ─────────────────────────────────────────────────────────
function load5m(pair: string): C5[] {
  const f = path.join(CD, pair + ".json");
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8")) as C5[];
}

// ── Aggregate 5m -> daily ───────────────────────────────────────────────────
function toDailyBars(cs: C5[]): DailyBar[] {
  const map = new Map<number, C5[]>();
  for (const c of cs) {
    const dayKey = Math.floor(c.t / DAY) * DAY;
    let arr = map.get(dayKey);
    if (!arr) { arr = []; map.set(dayKey, arr); }
    arr.push(c);
  }
  const days: DailyBar[] = [];
  const sorted = [...map.entries()].sort((a, b) => a[0] - b[0]);
  for (const [t, bars] of sorted) {
    if (bars.length < 10) continue; // skip incomplete days
    let vol = 0, hi = -Infinity, lo = Infinity;
    const o = bars[0].o;
    const c = bars[bars.length - 1].c;
    for (const b of bars) {
      vol += b.v * ((b.o + b.c) / 2); // volume in USD terms
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
    }
    days.push({ t, o, h: hi, l: lo, c, vol });
  }
  return days;
}

// ── Load BTC daily for relative strength ────────────────────────────────────
function loadBtcDaily(): Map<number, DailyBar> {
  const cs = load5m("BTCUSDT");
  const bars = toDailyBars(cs);
  const map = new Map<number, DailyBar>();
  for (const b of bars) map.set(b.t, b);
  return map;
}

// ── Helper: daily index -> time mapping ─────────────────────────────────────
function dailyMap(bars: DailyBar[]): Map<number, number> {
  const m = new Map<number, number>();
  bars.forEach((b, i) => m.set(b.t, i));
  return m;
}

// ── Strategy 1: Volume-Price Divergence Short ───────────────────────────────
// When 3-day avg volume > 2x 20-day avg AND 3-day return < -2%, short.
// SL: 4%, exit after 7 days or volume normalizes.
function strat1(pair: string, bars: DailyBar[], start: number, end: number): Trade[] {
  const trades: Trade[] = [];
  let inPos = false;
  let entry = 0, entryTime = 0, sl = 0;
  const sp = SP[pair] ?? 4e-4;

  for (let i = 22; i < bars.length; i++) {
    const b = bars[i];
    if (b.t < start || b.t >= end) continue;

    // Check existing position
    if (inPos) {
      // SL hit (4% from entry)
      if (b.h >= sl) {
        const exitP = sl * (1 + sp);
        const raw = (entry / exitP - 1) * NOT;
        trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "short", reason: "sl" });
        inPos = false;
        continue;
      }
      // Max hold 7 days
      if (b.t - entryTime >= 7 * DAY) {
        const exitP = b.c * (1 + sp);
        const raw = (entry / exitP - 1) * NOT;
        trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "short", reason: "mh" });
        inPos = false;
        continue;
      }
      // Volume normalizes (3-day avg drops below 1.5x 20-day)
      const vol3 = (bars[i].vol + bars[i - 1].vol + bars[i - 2].vol) / 3;
      let vol20 = 0;
      for (let j = i - 22; j < i - 2; j++) vol20 += bars[j].vol;
      vol20 /= 20;
      if (vol20 > 0 && vol3 < vol20 * 1.5) {
        const exitP = b.c * (1 + sp);
        const raw = (entry / exitP - 1) * NOT;
        trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "short", reason: "volnorm" });
        inPos = false;
        continue;
      }
      continue;
    }

    // Entry signal: 3-day avg vol > 2x 20-day avg AND 3-day return < -2%
    const vol3 = (bars[i - 1].vol + bars[i - 2].vol + bars[i - 3].vol) / 3;
    let vol20 = 0;
    for (let j = i - 22; j < i - 2; j++) vol20 += bars[j].vol;
    vol20 /= 20;
    if (vol20 <= 0) continue;

    const volRatio = vol3 / vol20;
    const ret3 = bars[i - 1].c / bars[i - 3].c - 1;

    if (volRatio > 2.0 && ret3 < -0.02) {
      entry = b.o * (1 - sp); // short entry
      entryTime = b.t;
      sl = entry * 1.04; // 4% SL
      inPos = true;
    }
  }

  // Close any open position at end
  if (inPos && bars.length > 0) {
    const b = bars[bars.length - 1];
    const exitP = b.c * (1 + SP[pair] ?? 4e-4);
    const raw = (entry / exitP - 1) * NOT;
    trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "short", reason: "eod" });
  }

  return trades;
}

// ── Strategy 2: Post-Spike Reversal Long ────────────────────────────────────
// After big volume spike + price decline, wait 3 days then go long for recovery.
// TP: 3%, SL: 2%, hold max 5 days.
function strat2(pair: string, bars: DailyBar[], start: number, end: number): Trade[] {
  const trades: Trade[] = [];
  let inPos = false;
  let entry = 0, entryTime = 0, sl = 0, tp = 0;
  const sp = SP[pair] ?? 4e-4;

  // Track spike events
  const spikeDay = new Set<number>(); // indices where spike occurred

  for (let i = 22; i < bars.length; i++) {
    const vol3 = (bars[i].vol + bars[i - 1].vol + bars[i - 2].vol) / 3;
    let vol20 = 0;
    for (let j = i - 22; j < i - 2; j++) vol20 += bars[j].vol;
    vol20 /= 20;
    if (vol20 <= 0) continue;

    const volRatio = vol3 / vol20;
    const ret3 = bars[i].c / bars[i - 2].c - 1;

    // Spike: volume > 2x AND price dropped > 3%
    if (volRatio > 2.0 && ret3 < -0.03) {
      spikeDay.add(i);
    }
  }

  for (let i = 25; i < bars.length; i++) {
    const b = bars[i];
    if (b.t < start || b.t >= end) continue;

    if (inPos) {
      // TP
      if (b.h >= tp) {
        const exitP = tp * (1 - sp);
        const raw = (exitP / entry - 1) * NOT;
        trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "long", reason: "tp" });
        inPos = false;
        continue;
      }
      // SL
      if (b.l <= sl) {
        const exitP = sl * (1 - sp);
        const raw = (exitP / entry - 1) * NOT;
        trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "long", reason: "sl" });
        inPos = false;
        continue;
      }
      // Max hold 5 days
      if (b.t - entryTime >= 5 * DAY) {
        const exitP = b.c * (1 - sp);
        const raw = (exitP / entry - 1) * NOT;
        trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "long", reason: "mh" });
        inPos = false;
        continue;
      }
      continue;
    }

    // Entry: 3 days after a spike event
    if (spikeDay.has(i - 3) && !inPos) {
      entry = b.o * (1 + sp); // long entry
      entryTime = b.t;
      tp = entry * 1.03; // 3% TP
      sl = entry * 0.98; // 2% SL
      inPos = true;
    }
  }

  if (inPos && bars.length > 0) {
    const b = bars[bars.length - 1];
    const exitP = b.c * (1 - (SP[pair] ?? 4e-4));
    const raw = (exitP / entry - 1) * NOT;
    trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "long", reason: "eod" });
  }

  return trades;
}

// ── Strategy 3: Volume Climax + Relative Weakness Short ─────────────────────
// Short pairs with 3-day volume > 3x avg AND underperforming BTC by >3% in 7 days.
// SL: 4%, hold 7d.
function strat3(
  pair: string,
  bars: DailyBar[],
  btcMap: Map<number, DailyBar>,
  start: number,
  end: number,
): Trade[] {
  const trades: Trade[] = [];
  let inPos = false;
  let entry = 0, entryTime = 0, sl = 0;
  const sp = SP[pair] ?? 4e-4;

  for (let i = 22; i < bars.length; i++) {
    const b = bars[i];
    if (b.t < start || b.t >= end) continue;

    if (inPos) {
      // SL
      if (b.h >= sl) {
        const exitP = sl * (1 + sp);
        const raw = (entry / exitP - 1) * NOT;
        trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "short", reason: "sl" });
        inPos = false;
        continue;
      }
      // Max hold 7 days
      if (b.t - entryTime >= 7 * DAY) {
        const exitP = b.c * (1 + sp);
        const raw = (entry / exitP - 1) * NOT;
        trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "short", reason: "mh" });
        inPos = false;
        continue;
      }
      continue;
    }

    // Entry: 3-day volume > 3x 20-day avg AND relative weakness vs BTC > 3% over 7 days
    const vol3 = (bars[i - 1].vol + bars[i - 2].vol + bars[i - 3].vol) / 3;
    let vol20 = 0;
    for (let j = i - 22; j < i - 2; j++) vol20 += bars[j].vol;
    vol20 /= 20;
    if (vol20 <= 0) continue;

    const volRatio = vol3 / vol20;
    if (volRatio <= 3.0) continue;

    // 7-day relative strength vs BTC
    if (i < 7) continue;
    const pairRet7 = bars[i - 1].c / bars[i - 7].c - 1;
    const btcBar0 = btcMap.get(bars[i - 1].t);
    const btcBar7 = btcMap.get(bars[i - 7].t);
    if (!btcBar0 || !btcBar7) continue;

    const btcRet7 = btcBar0.c / btcBar7.c - 1;
    const relStrength = pairRet7 - btcRet7;

    if (relStrength < -0.03) {
      entry = b.o * (1 - sp);
      entryTime = b.t;
      sl = entry * 1.04; // 4% SL
      inPos = true;
    }
  }

  if (inPos && bars.length > 0) {
    const b = bars[bars.length - 1];
    const exitP = b.c * (1 + (SP[pair] ?? 4e-4));
    const raw = (entry / exitP - 1) * NOT;
    trades.push({ pnl: raw - NOT * FEE * 2, et: entryTime, xt: b.t, pair, dir: "short", reason: "eod" });
  }

  return trades;
}

// ── Reporting ───────────────────────────────────────────────────────────────
function report(name: string, trades: Trade[], start: number, end: number): void {
  const days = (end - start) / DAY;
  if (trades.length === 0) {
    console.log(`  ${name.padEnd(12)} No trades`);
    return;
  }

  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const wr = (wins / trades.length) * 100;
  const grossW = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossL > 0 ? grossW / grossL : grossW > 0 ? Infinity : 0;

  // MaxDD
  let cum = 0, pk = 0, dd = 0;
  const dp = new Map<number, number>();
  for (const t of trades) {
    cum += t.pnl;
    if (cum > pk) pk = cum;
    if (pk - cum > dd) dd = pk - cum;
    const dk = Math.floor(t.xt / DAY);
    dp.set(dk, (dp.get(dk) || 0) + t.pnl);
  }

  // Sharpe
  const dr = [...dp.values()];
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sh = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  // Avg win / avg loss
  const avgW = wins > 0 ? grossW / wins : 0;
  const losers = trades.length - wins;
  const avgL = losers > 0 ? grossL / losers : 0;

  // Exit breakdown
  const exits = new Map<string, number>();
  for (const t of trades) exits.set(t.reason, (exits.get(t.reason) || 0) + 1);
  const exitStr = [...exits.entries()].map(([r, n]) => `${r}:${n}`).join(" ");

  const p = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

  console.log(
    `  ${name.padEnd(12)} ` +
    `Trades: ${String(trades.length).padStart(4)}  ` +
    `T/day: ${(trades.length / days).toFixed(2).padStart(5)}  ` +
    `WR: ${wr.toFixed(1).padStart(5)}%  ` +
    `PF: ${pf.toFixed(2).padStart(5)}  ` +
    `PnL: ${p.padStart(10)}  ` +
    `$/day: ${(pnl / days >= 0 ? "+" : "") + "$" + (pnl / days).toFixed(2)}  ` +
    `Sharpe: ${sh.toFixed(2).padStart(6)}  ` +
    `MaxDD: $${dd.toFixed(2).padStart(7)}  ` +
    `AvgW: $${avgW.toFixed(2)}  AvgL: $${avgL.toFixed(2)}  ` +
    `Exits: ${exitStr}`
  );
}

function reportByPair(trades: Trade[], start: number, end: number): void {
  const byPair = new Map<string, Trade[]>();
  for (const t of trades) {
    let arr = byPair.get(t.pair);
    if (!arr) { arr = []; byPair.set(t.pair, arr); }
    arr.push(t);
  }
  const sorted = [...byPair.entries()].sort((a, b) => {
    const pa = a[1].reduce((s, t) => s + t.pnl, 0);
    const pb = b[1].reduce((s, t) => s + t.pnl, 0);
    return pb - pa;
  });
  for (const [pair, pts] of sorted) {
    const pnl = pts.reduce((s, t) => s + t.pnl, 0);
    const w = pts.filter(t => t.pnl > 0).length;
    const wr = pts.length > 0 ? (w / pts.length * 100) : 0;
    const p = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    console.log(`    ${pair.replace("USDT","").padEnd(8)} ${String(pts.length).padStart(3)} trades  WR: ${wr.toFixed(0).padStart(3)}%  PnL: ${p}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
console.log("Loading 5m candle data and aggregating to daily...\n");

const btcMap = loadBtcDaily();
const pairData = new Map<string, DailyBar[]>();

for (const p of PAIRS) {
  const cs = load5m(p);
  if (cs.length === 0) { console.log(`  [SKIP] ${p} - no data`); continue; }
  const daily = toDailyBars(cs);
  pairData.set(p, daily);
  console.log(`  ${p}: ${cs.length} 5m bars -> ${daily.length} daily bars (${new Date(daily[0].t).toISOString().slice(0, 10)} to ${new Date(daily[daily.length - 1].t).toISOString().slice(0, 10)})`);
}

console.log(`\nBTC: ${btcMap.size} daily bars`);
console.log(`\nFull: 2023-01-01 to 2026-03-20 | OOS: 2025-09-01+`);
console.log(`Cost: Taker 0.035% + spreads, 10x leverage, $5 margin ($50 notional)\n`);

// ══════════════════════════════════════════════════════════════════════════════
// STRATEGY 1: Volume-Price Divergence Short
// ══════════════════════════════════════════════════════════════════════════════
console.log("=" .repeat(120));
console.log("STRATEGY 1: Volume-Price Divergence Short");
console.log("Signal: 3-day avg volume > 2x 20-day avg AND 3-day return < -2% -> Short");
console.log("Exit: SL 4% | Max hold 7 days | Volume normalizes (3d < 1.5x 20d avg)");
console.log("=" .repeat(120));

{
  const fullTrades: Trade[] = [];
  const oosTrades: Trade[] = [];
  const isTrades: Trade[] = [];

  for (const [pair, bars] of pairData) {
    const ft = strat1(pair, bars, FULL_START, FULL_END);
    fullTrades.push(...ft);
    oosTrades.push(...ft.filter(t => t.et >= OOS_START));
    isTrades.push(...ft.filter(t => t.et < OOS_START));
  }

  fullTrades.sort((a, b) => a.et - b.et);
  oosTrades.sort((a, b) => a.et - b.et);
  isTrades.sort((a, b) => a.et - b.et);

  console.log("\n  --- Aggregate ---");
  report("Full", fullTrades, FULL_START, FULL_END);
  report("IS", isTrades, FULL_START, OOS_START);
  report("OOS", oosTrades, OOS_START, FULL_END);

  console.log("\n  --- By Pair (Full) ---");
  reportByPair(fullTrades, FULL_START, FULL_END);
}

// ══════════════════════════════════════════════════════════════════════════════
// STRATEGY 2: Post-Spike Reversal Long
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n" + "=" .repeat(120));
console.log("STRATEGY 2: Post-Spike Reversal Long");
console.log("Signal: 3 days after volume spike (>2x avg) with price decline (>3%) -> Long for recovery");
console.log("Exit: TP 3% | SL 2% | Max hold 5 days");
console.log("=" .repeat(120));

{
  const fullTrades: Trade[] = [];
  const oosTrades: Trade[] = [];
  const isTrades: Trade[] = [];

  for (const [pair, bars] of pairData) {
    const ft = strat2(pair, bars, FULL_START, FULL_END);
    fullTrades.push(...ft);
    oosTrades.push(...ft.filter(t => t.et >= OOS_START));
    isTrades.push(...ft.filter(t => t.et < OOS_START));
  }

  fullTrades.sort((a, b) => a.et - b.et);
  oosTrades.sort((a, b) => a.et - b.et);
  isTrades.sort((a, b) => a.et - b.et);

  console.log("\n  --- Aggregate ---");
  report("Full", fullTrades, FULL_START, FULL_END);
  report("IS", isTrades, FULL_START, OOS_START);
  report("OOS", oosTrades, OOS_START, FULL_END);

  console.log("\n  --- By Pair (Full) ---");
  reportByPair(fullTrades, FULL_START, FULL_END);
}

// ══════════════════════════════════════════════════════════════════════════════
// STRATEGY 3: Volume Climax + Relative Weakness Short
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n" + "=" .repeat(120));
console.log("STRATEGY 3: Volume Climax + Relative Weakness vs BTC Short");
console.log("Signal: 3-day volume > 3x 20-day avg AND underperforming BTC by >3% over 7 days -> Short");
console.log("Exit: SL 4% | Max hold 7 days");
console.log("=" .repeat(120));

{
  const fullTrades: Trade[] = [];
  const oosTrades: Trade[] = [];
  const isTrades: Trade[] = [];

  for (const [pair, bars] of pairData) {
    const ft = strat3(pair, bars, btcMap, FULL_START, FULL_END);
    fullTrades.push(...ft);
    oosTrades.push(...ft.filter(t => t.et >= OOS_START));
    isTrades.push(...ft.filter(t => t.et < OOS_START));
  }

  fullTrades.sort((a, b) => a.et - b.et);
  oosTrades.sort((a, b) => a.et - b.et);
  isTrades.sort((a, b) => a.et - b.et);

  console.log("\n  --- Aggregate ---");
  report("Full", fullTrades, FULL_START, FULL_END);
  report("IS", isTrades, FULL_START, OOS_START);
  report("OOS", oosTrades, OOS_START, FULL_END);

  console.log("\n  --- By Pair (Full) ---");
  reportByPair(fullTrades, FULL_START, FULL_END);
}

// ══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n" + "=" .repeat(120));
console.log("SUMMARY - All strategies OOS comparison");
console.log("=" .repeat(120));

{
  const results: { name: string; trades: Trade[] }[] = [];

  // Re-run for summary
  const s1: Trade[] = [], s2: Trade[] = [], s3: Trade[] = [];
  for (const [pair, bars] of pairData) {
    s1.push(...strat1(pair, bars, FULL_START, FULL_END).filter(t => t.et >= OOS_START));
    s2.push(...strat2(pair, bars, FULL_START, FULL_END).filter(t => t.et >= OOS_START));
    s3.push(...strat3(pair, bars, btcMap, FULL_START, FULL_END).filter(t => t.et >= OOS_START));
  }

  const oosDays = (FULL_END - OOS_START) / DAY;

  console.log("\n  Strategy                         Trades  WR%    PF     PnL        $/day   Sharpe  MaxDD");
  console.log("  " + "-".repeat(100));

  for (const [name, tr] of [
    ["S1: Vol-Price Divergence Short", s1],
    ["S2: Post-Spike Reversal Long", s2],
    ["S3: Vol Climax + Rel Weakness", s3],
  ] as [string, Trade[]][]) {
    if (tr.length === 0) {
      console.log(`  ${name.padEnd(35)} No trades`);
      continue;
    }
    const pnl = tr.reduce((s, t) => s + t.pnl, 0);
    const w = tr.filter(t => t.pnl > 0).length;
    const wr = (w / tr.length) * 100;
    const gw = tr.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(tr.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
    let cum = 0, pk = 0, dd = 0;
    const dp = new Map<number, number>();
    for (const t of tr.sort((a, b) => a.et - b.et)) {
      cum += t.pnl;
      if (cum > pk) pk = cum;
      if (pk - cum > dd) dd = pk - cum;
      const dk = Math.floor(t.xt / DAY);
      dp.set(dk, (dp.get(dk) || 0) + t.pnl);
    }
    const dr = [...dp.values()];
    const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
    const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
    const sh = std > 0 ? (avg / std) * Math.sqrt(252) : 0;
    const p = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

    console.log(
      `  ${name.padEnd(35)} ${String(tr.length).padStart(5)}  ${wr.toFixed(1).padStart(5)}%  ${pf.toFixed(2).padStart(5)}  ${p.padStart(10)}  ${((pnl / oosDays >= 0 ? "+" : "") + "$" + (pnl / oosDays).toFixed(2)).padStart(7)}  ${sh.toFixed(2).padStart(6)}  $${dd.toFixed(2).padStart(7)}`
    );
  }
}

console.log("\nDone.");
