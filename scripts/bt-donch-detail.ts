import * as fs from "fs";
import * as path from "path";

// ─── Types ─────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number }
interface Pos {
  pair: string; dir: "long" | "short"; ep: number; et: number; sl: number;
  entryIdx: number;
}
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; holdDays: number;
  exitReason: "stop-loss" | "donchian-exit" | "max-hold";
}

// ─── Config ────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const DAY = 86_400_000;
const FEE = 0.000_35;      // taker fee per side
const SZ = 10;              // margin per trade
const LEV = 10;             // leverage
const NOTIONAL = SZ * LEV;  // $100
const DONCH_ENTRY = 30;     // 30-day lookback for entry
const DONCH_EXIT = 15;      // 15-day lookback for exit
const ATR_PERIOD = 14;
const ATR_MULT = 3;
const MAX_HOLD = 60;        // days
const OOS_START = new Date("2025-09-01").getTime();

const PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, SUIUSDT: 1.85e-4,
  AVAXUSDT: 2.55e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4,
  TRUMPUSDT: 3.65e-4, WLDUSDT: 4e-4, SEIUSDT: 4.4e-4,
  TONUSDT: 4.6e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4,
  ADAUSDT: 5.55e-4, LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4,
  DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4, ETHUSDT: 1.5e-4,
  SOLUSDT: 2.0e-4, TIAUSDT: 2.5e-4,
};

// ─── Load 5m candles & aggregate to daily ──────────────────────
function load5m(pair: string): C[] {
  const f = path.join(CD, pair + "USDT.json");
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
  );
}

function aggDaily(candles5m: C[]): C[] {
  const dayMap = new Map<number, C[]>();
  for (const c of candles5m) {
    const dayKey = Math.floor(c.t / DAY) * DAY;
    let arr = dayMap.get(dayKey);
    if (!arr) { arr = []; dayMap.set(dayKey, arr); }
    arr.push(c);
  }
  const daily: C[] = [];
  for (const [dayKey, bars] of [...dayMap.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 12) continue; // skip incomplete days (need at least 1h of data)
    bars.sort((a, b) => a.t - b.t);
    daily.push({
      t: dayKey,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return daily;
}

// ─── ATR calculation ───────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c),
    );
    if (i < period) {
      // accumulate
      atr[i] = tr;
    } else if (i === period) {
      let sum = tr;
      for (let j = 1; j < period; j++) sum += Math.max(
        cs[i - j].h - cs[i - j].l,
        Math.abs(cs[i - j].h - cs[i - j - 1].c),
        Math.abs(cs[i - j].l - cs[i - j - 1].c),
      );
      atr[i] = sum / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

// ─── Donchian channels ────────────────────────────────────────
function donchianHigh(cs: C[], idx: number, lb: number): number {
  let hi = -Infinity;
  for (let j = idx - lb; j < idx; j++) {
    if (j >= 0 && cs[j].h > hi) hi = cs[j].h;
  }
  return hi;
}

function donchianLow(cs: C[], idx: number, lb: number): number {
  let lo = Infinity;
  for (let j = idx - lb; j < idx; j++) {
    if (j >= 0 && cs[j].l < lo) lo = cs[j].l;
  }
  return lo;
}

// ─── Load & prepare all pairs ──────────────────────────────────
interface PairData {
  cs: C[];
  atr: number[];
}

const pairData = new Map<string, PairData>();
for (const pair of PAIRS) {
  const raw5m = load5m(pair);
  if (raw5m.length === 0) { console.log(`[WARN] No data for ${pair}`); continue; }
  const cs = aggDaily(raw5m);
  if (cs.length < DONCH_ENTRY + ATR_PERIOD + 5) {
    console.log(`[WARN] Insufficient daily bars for ${pair}: ${cs.length}`);
    continue;
  }
  const atr = calcATR(cs, ATR_PERIOD);
  pairData.set(pair, { cs, atr });
}

// ─── Find OOS end (last available date) ────────────────────────
let oosEnd = 0;
for (const [, pd] of pairData) {
  const last = pd.cs[pd.cs.length - 1].t;
  if (last > oosEnd) oosEnd = last;
}

// ─── Simulation ────────────────────────────────────────────────
const allTrades: Trade[] = [];

for (const [pair, pd] of pairData) {
  const { cs, atr } = pd;
  const sym = pair + "USDT";
  const spread = SP[sym] ?? 4e-4;
  const slSpread = spread * 1.5; // slippage on SL

  let pos: Pos | null = null;

  for (let i = DONCH_ENTRY + 1; i < cs.length; i++) {
    const bar = cs[i];
    if (bar.t < OOS_START) {
      // We still need to track positions that might carry into OOS
      // But we only record trades that close in OOS
      // Actually, let's only run the simulation from a point where we have enough lookback
      // and only record trades entered during OOS
    }

    // ─── Check exits first ─────────────────────────────────
    if (pos) {
      const holdDays = Math.round((bar.t - pos.et) / DAY);
      let xp = 0;
      let exitReason: Trade["exitReason"] = "donchian-exit";

      // Stop-loss check (intra-day via high/low)
      if (pos.dir === "long" && bar.l <= pos.sl) {
        xp = pos.sl * (1 - slSpread);
        exitReason = "stop-loss";
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        xp = pos.sl * (1 + slSpread);
        exitReason = "stop-loss";
      }
      // Donchian exit: close < 15d low (long) or close > 15d high (short)
      else {
        const exitLow = donchianLow(cs, i, DONCH_EXIT);
        const exitHigh = donchianHigh(cs, i, DONCH_EXIT);
        if (pos.dir === "long" && bar.c < exitLow) {
          xp = bar.c * (1 - spread);
          exitReason = "donchian-exit";
        } else if (pos.dir === "short" && bar.c > exitHigh) {
          xp = bar.c * (1 + spread);
          exitReason = "donchian-exit";
        }
        // Max hold
        else if (holdDays >= MAX_HOLD) {
          xp = bar.c * (pos.dir === "long" ? (1 - spread) : (1 + spread));
          exitReason = "max-hold";
        }
      }

      if (xp > 0) {
        const rawPct = pos.dir === "long"
          ? (xp / pos.ep - 1)
          : (pos.ep / xp - 1);
        const rawPnl = rawPct * NOTIONAL;
        const feeCost = NOTIONAL * FEE * 2; // entry + exit
        const pnl = rawPnl - feeCost;

        // Only record trades entered in OOS period
        if (pos.et >= OOS_START) {
          allTrades.push({
            pair, dir: pos.dir, ep: pos.ep, xp,
            et: pos.et, xt: bar.t, pnl, holdDays,
            exitReason,
          });
        }
        pos = null;
      }
    }

    // ─── Check entry (anti-look-ahead: signal on day i-1, entry at day i open) ───
    if (!pos && i >= DONCH_ENTRY + 1 && bar.t >= OOS_START) {
      const prev = cs[i - 1]; // yesterday
      const prevATR = atr[i - 1];
      if (prevATR <= 0) continue;

      // Donchian breakout: yesterday's close > highest high of last 30 days (excluding yesterday)
      const hi30 = donchianHigh(cs, i - 1, DONCH_ENTRY); // high of bars [i-1-30 .. i-2]
      const lo30 = donchianLow(cs, i - 1, DONCH_ENTRY);

      let dir: "long" | "short" | null = null;
      if (prev.c > hi30) dir = "long";
      else if (prev.c < lo30) dir = "short";

      if (dir) {
        const entryPrice = dir === "long"
          ? bar.o * (1 + spread)
          : bar.o * (1 - spread);
        const slPrice = dir === "long"
          ? entryPrice - ATR_MULT * prevATR
          : entryPrice + ATR_MULT * prevATR;

        pos = {
          pair, dir, ep: entryPrice, et: bar.t, sl: slPrice,
          entryIdx: i,
        };
      }
    }
  }
}

// ─── 1. Per-pair breakdown ─────────────────────────────────────
console.log("=== 1. PER-PAIR BREAKDOWN (OOS from 2025-09-01) ===\n");
console.log(
  "Pair".padEnd(8) +
  "Trades".padStart(7) +
  "  WR%".padStart(7) +
  "  TotalPnL".padStart(11) +
  "  Avg/Trade".padStart(11) +
  "  ProfitFactor".padStart(14) +
  "  Status",
);
console.log("-".repeat(75));

const pairStats = new Map<string, Trade[]>();
for (const t of allTrades) {
  let arr = pairStats.get(t.pair);
  if (!arr) { arr = []; pairStats.set(t.pair, arr); }
  arr.push(t);
}

let totalPnl = 0;
let totalTrades = 0;
let totalWins = 0;

const sortedPairs = [...pairStats.entries()].sort((a, b) => {
  const pa = a[1].reduce((s, t) => s + t.pnl, 0);
  const pb = b[1].reduce((s, t) => s + t.pnl, 0);
  return pb - pa;
});

for (const [pair, trades] of sortedPairs) {
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0).length;
  const wr = n > 0 ? (wins / n * 100) : 0;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avg = n > 0 ? pnl / n : 0;
  const grossW = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossL > 0 ? grossW / grossL : grossW > 0 ? Infinity : 0;
  const status = pnl > 0 ? "PROFIT" : "LOSS";
  totalPnl += pnl;
  totalTrades += n;
  totalWins += wins;

  console.log(
    pair.padEnd(8) +
    String(n).padStart(7) +
    wr.toFixed(1).padStart(7) +
    `  ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`.padStart(11) +
    `  ${avg >= 0 ? "+" : ""}$${avg.toFixed(2)}`.padStart(11) +
    `  ${pf === Infinity ? "inf" : pf.toFixed(2)}`.padStart(14) +
    `  ${status}`,
  );
}

// Pairs with zero trades
for (const pair of PAIRS) {
  if (!pairStats.has(pair)) {
    console.log(
      pair.padEnd(8) +
      "0".padStart(7) +
      "  --".padStart(7) +
      "  $0.00".padStart(11) +
      "  --".padStart(11) +
      "  --".padStart(14) +
      "  NO TRADES",
    );
  }
}

console.log("-".repeat(75));
console.log(
  "TOTAL".padEnd(8) +
  String(totalTrades).padStart(7) +
  (totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : "--").padStart(7) +
  `  ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`.padStart(11) +
  `  ${totalTrades > 0 ? (totalPnl >= 0 ? "+" : "") + "$" + (totalPnl / totalTrades).toFixed(2) : "--"}`.padStart(11),
);

// ─── 2. Monthly P&L ───────────────────────────────────────────
console.log("\n=== 2. MONTHLY P&L ===\n");
console.log(
  "Month".padEnd(10) +
  "Trades".padStart(7) +
  "  WR%".padStart(7) +
  "  PnL".padStart(10),
);
console.log("-".repeat(40));

const monthMap = new Map<string, { trades: number; wins: number; pnl: number }>();
for (const t of allTrades) {
  const m = new Date(t.xt).toISOString().slice(0, 7); // month of exit
  const v = monthMap.get(m) || { trades: 0, wins: 0, pnl: 0 };
  v.trades++;
  if (t.pnl > 0) v.wins++;
  v.pnl += t.pnl;
  monthMap.set(m, v);
}

let cumPnl = 0;
for (const [m, v] of [...monthMap.entries()].sort()) {
  cumPnl += v.pnl;
  const wr = v.trades > 0 ? (v.wins / v.trades * 100).toFixed(1) : "--";
  console.log(
    m.padEnd(10) +
    String(v.trades).padStart(7) +
    wr.padStart(7) +
    `  ${v.pnl >= 0 ? "+" : ""}$${v.pnl.toFixed(2)}`.padStart(10),
  );
}
console.log("-".repeat(40));
console.log(`Cumulative: ${cumPnl >= 0 ? "+" : ""}$${cumPnl.toFixed(2)}`);

// ─── 3. Exit reason breakdown ──────────────────────────────────
console.log("\n=== 3. EXIT REASON BREAKDOWN ===\n");
console.log(
  "Exit Reason".padEnd(16) +
  "Count".padStart(6) +
  "  Pct%".padStart(7) +
  "  Avg PnL".padStart(10) +
  "  Total PnL".padStart(12),
);
console.log("-".repeat(55));

const exitMap = new Map<string, { count: number; pnl: number }>();
for (const t of allTrades) {
  const v = exitMap.get(t.exitReason) || { count: 0, pnl: 0 };
  v.count++;
  v.pnl += t.pnl;
  exitMap.set(t.exitReason, v);
}

for (const reason of ["stop-loss", "donchian-exit", "max-hold"]) {
  const v = exitMap.get(reason) || { count: 0, pnl: 0 };
  const pct = totalTrades > 0 ? (v.count / totalTrades * 100) : 0;
  const avg = v.count > 0 ? v.pnl / v.count : 0;
  console.log(
    reason.padEnd(16) +
    String(v.count).padStart(6) +
    pct.toFixed(1).padStart(7) +
    `  ${avg >= 0 ? "+" : ""}$${avg.toFixed(2)}`.padStart(10) +
    `  ${v.pnl >= 0 ? "+" : ""}$${v.pnl.toFixed(2)}`.padStart(12),
  );
}

// ─── 4. Top 5 best and worst trades ───────────────────────────
console.log("\n=== 4. TOP 5 BEST TRADES ===\n");
console.log(
  "Pair".padEnd(8) +
  "Dir".padEnd(6) +
  "Entry".padStart(12) +
  "  Exit".padStart(12) +
  "  HoldDays".padStart(10) +
  "  PnL".padStart(10) +
  "  EntryDate".padStart(13),
);
console.log("-".repeat(75));

const sorted = [...allTrades].sort((a, b) => b.pnl - a.pnl);
for (const t of sorted.slice(0, 5)) {
  console.log(
    t.pair.padEnd(8) +
    t.dir.padEnd(6) +
    `$${t.ep.toFixed(4)}`.padStart(12) +
    `  $${t.xp.toFixed(4)}`.padStart(12) +
    String(t.holdDays).padStart(10) +
    `  ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`.padStart(10) +
    `  ${new Date(t.et).toISOString().slice(0, 10)}`.padStart(13),
  );
}

console.log("\n=== 4b. TOP 5 WORST TRADES ===\n");
console.log(
  "Pair".padEnd(8) +
  "Dir".padEnd(6) +
  "Entry".padStart(12) +
  "  Exit".padStart(12) +
  "  HoldDays".padStart(10) +
  "  PnL".padStart(10) +
  "  EntryDate".padStart(13),
);
console.log("-".repeat(75));

for (const t of sorted.slice(-5).reverse()) {
  console.log(
    t.pair.padEnd(8) +
    t.dir.padEnd(6) +
    `$${t.ep.toFixed(4)}`.padStart(12) +
    `  $${t.xp.toFixed(4)}`.padStart(12) +
    String(t.holdDays).padStart(10) +
    `  ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`.padStart(10) +
    `  ${new Date(t.et).toISOString().slice(0, 10)}`.padStart(13),
  );
}

// ─── 5. Win/loss distribution ──────────────────────────────────
console.log("\n=== 5. WIN/LOSS DISTRIBUTION ===\n");

const winners = allTrades.filter(t => t.pnl > 0);
const losers = allTrades.filter(t => t.pnl <= 0);

const avgWin = winners.length > 0
  ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length
  : 0;
const avgLoss = losers.length > 0
  ? losers.reduce((s, t) => s + t.pnl, 0) / losers.length
  : 0;
const ratio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : Infinity;

console.log(`Total trades:       ${allTrades.length}`);
console.log(`Winners:            ${winners.length} (${(winners.length / allTrades.length * 100).toFixed(1)}%)`);
console.log(`Losers:             ${losers.length} (${(losers.length / allTrades.length * 100).toFixed(1)}%)`);
console.log(`Avg winning trade:  +$${avgWin.toFixed(2)}`);
console.log(`Avg losing trade:   $${avgLoss.toFixed(2)}`);
console.log(`Win/loss ratio:     ${ratio.toFixed(2)}x`);
console.log(`Expectancy:         ${totalTrades > 0 ? (totalPnl >= 0 ? "+" : "") + "$" + (totalPnl / totalTrades).toFixed(2) : "--"}/trade`);

// ─── Additional: avg hold days by exit type ────────────────────
console.log("\n=== ADDITIONAL: AVG HOLD DAYS BY EXIT TYPE ===\n");
for (const reason of ["stop-loss", "donchian-exit", "max-hold"]) {
  const trades = allTrades.filter(t => t.exitReason === reason);
  const avgHold = trades.length > 0
    ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length
    : 0;
  console.log(`${reason.padEnd(16)} avg hold: ${avgHold.toFixed(1)} days`);
}

// ─── Direction breakdown ───────────────────────────────────────
console.log("\n=== ADDITIONAL: DIRECTION BREAKDOWN ===\n");
const longs = allTrades.filter(t => t.dir === "long");
const shorts = allTrades.filter(t => t.dir === "short");
const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
const longWR = longs.length > 0 ? longs.filter(t => t.pnl > 0).length / longs.length * 100 : 0;
const shortWR = shorts.length > 0 ? shorts.filter(t => t.pnl > 0).length / shorts.length * 100 : 0;
console.log(`Long:  ${longs.length} trades, WR ${longWR.toFixed(1)}%, PnL ${longPnl >= 0 ? "+" : ""}$${longPnl.toFixed(2)}`);
console.log(`Short: ${shorts.length} trades, WR ${shortWR.toFixed(1)}%, PnL ${shortPnl >= 0 ? "+" : ""}$${shortPnl.toFixed(2)}`);
