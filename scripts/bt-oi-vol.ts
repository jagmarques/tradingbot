// Volatility pattern and volume-based strategy backtest
// Uses 5m data aggregated to 1h, 4h, and daily
import * as fs from "fs";
import * as path from "path";
import { ATR, EMA, BollingerBands, KeltnerChannels } from "technicalindicators";

interface C { t: number; o: number; h: number; l: number; c: number; v: number }
interface Pos { pair: string; dir: "long" | "short"; ep: number; et: number; sl: number; tp: number; meta: any }
interface Trade { pnl: number; et: number; xt: number }

const CD5 = "/tmp/bt-pair-cache-5m";
const H = 3600000, H4 = 4 * H, DAY = 86400000;
const FEE = 0.00035, SZ = 5, LEV = 10, SL_SLIP = 1.5;
const PP = [
  "OPUSDT", "WIFUSDT", "ARBUSDT", "LDOUSDT", "TRUMPUSDT", "DASHUSDT",
  "DOTUSDT", "ENAUSDT", "DOGEUSDT", "APTUSDT", "LINKUSDT", "ADAUSDT",
  "WLDUSDT", "XRPUSDT", "UNIUSDT", "ETHUSDT", "TIAUSDT", "SOLUSDT",
];
const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4,
  WLDUSDT: 4e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4,
  LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
  ETHUSDT: 1.2e-4, TIAUSDT: 3.8e-4, SOLUSDT: 1.6e-4,
};

// Load 5m data
function ld5(p: string): C[] {
  const f = path.join(CD5, p + ".json");
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as any[]).map((b: any) =>
    ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 })
  );
}

// Aggregate 5m bars to target period
function agg(bars: C[], period: number): C[] {
  const m = new Map<number, C>();
  for (const b of bars) {
    const key = Math.floor(b.t / period) * period;
    const e = m.get(key);
    if (!e) { m.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); }
    else { e.h = Math.max(e.h, b.h); e.l = Math.min(e.l, b.l); e.c = b.c; e.v += b.v; }
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

// Compute indicators
function computeATR(cs: C[], period: number): number[] {
  return ATR.calculate({ period, high: cs.map(x => x.h), low: cs.map(x => x.l), close: cs.map(x => x.c) });
}
function computeEMA(vals: number[], period: number): number[] {
  return EMA.calculate({ period, values: vals });
}
function computeBB(vals: number[], period: number, stdDev: number): { upper: number; middle: number; lower: number; pb: number }[] {
  return BollingerBands.calculate({ period, stdDev, values: vals });
}

// Helper: get indicator value aligned to bar index
function gv(a: number[], bi: number, totalBars: number): number | null {
  const x = bi - (totalBars - a.length);
  return x >= 0 && x < a.length ? a[x] : null;
}
function gvBB(a: { upper: number; middle: number; lower: number; pb: number }[], bi: number, totalBars: number) {
  const x = bi - (totalBars - a.length);
  return x >= 0 && x < a.length ? a[x] : null;
}

// Cost model
function entryCost(sp: number): number { return FEE + sp / 2; }
function exitCost(sp: number): number { return FEE + sp / 2; }
function slCost(sp: number): number { return FEE + sp * SL_SLIP / 2; }

// BTC EMA trend
function btcTrend(btcBars: C[], btcE20: number[], btcE50: number[], t: number, btcTm: Map<number, number>): "up" | "down" | null {
  const bi = btcTm.get(t);
  if (bi === undefined || bi < 1) return null;
  const e20 = gv(btcE20, bi - 1, btcBars.length);
  const e50 = gv(btcE50, bi - 1, btcBars.length);
  if (e20 === null || e50 === null) return null;
  return e20 > e50 ? "up" : "down";
}

// Stats computation
function stats(tr: Trade[], s: number, e: number) {
  const days = (e - s) / DAY;
  const n = tr.length;
  const w = tr.filter(t => t.pnl > 0).length;
  const pnl = tr.reduce((a, t) => a + t.pnl, 0);
  const wr = n > 0 ? w / n * 100 : 0;
  const grossW = tr.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossL = Math.abs(tr.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  const pf = grossL > 0 ? grossW / grossL : grossW > 0 ? 999 : 0;
  let cum = 0, pk = 0, dd = 0;
  const dp = new Map<number, number>();
  for (const t of tr) {
    cum += t.pnl;
    if (cum > pk) pk = cum;
    if (pk - cum > dd) dd = pk - cum;
    dp.set(Math.floor(t.xt / DAY), (dp.get(Math.floor(t.xt / DAY)) || 0) + t.pnl);
  }
  const dr = [...dp.values()];
  const avg = dr.reduce((a, r) => a + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((a, r) => a + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sh = std > 0 ? (avg / std) * Math.sqrt(252) : 0;
  return { n, wr, pnl, pf, sh, dd, dPnl: pnl / days };
}

function fmt(s: ReturnType<typeof stats>): string {
  const p = s.pnl >= 0 ? `+$${s.pnl.toFixed(0)}` : `-$${Math.abs(s.pnl).toFixed(0)}`;
  return [
    String(s.n).padStart(6),
    s.pf.toFixed(2).padStart(5),
    s.sh.toFixed(2).padStart(6),
    ("$" + s.dPnl.toFixed(2)).padStart(7),
    (s.wr.toFixed(1) + "%").padStart(6),
    ("$" + s.dd.toFixed(0)).padStart(6),
  ].join("  ");
}

// ==================== MAIN ====================
const FULL_S = new Date("2023-01-01").getTime();
const FULL_E = new Date("2026-03-25").getTime();
const OOS_S = new Date("2025-09-01").getTime();

console.log("Loading 5m data and aggregating...");

// Load and aggregate for all pairs + BTC
type PairData = {
  h1: C[]; h4: C[]; d1: C[];
  h1Tm: Map<number, number>; h4Tm: Map<number, number>; d1Tm: Map<number, number>;
};

const allPairs = [...PP, "BTCUSDT"];
const pairData = new Map<string, PairData>();

for (const p of allPairs) {
  const raw = ld5(p);
  if (raw.length < 1000) { console.log(`  SKIP ${p}: only ${raw.length} 5m bars`); continue; }
  const h1 = agg(raw, H);
  const h4 = agg(raw, H4);
  const d1 = agg(raw, DAY);
  const h1Tm = new Map<number, number>(); h1.forEach((x, i) => h1Tm.set(x.t, i));
  const h4Tm = new Map<number, number>(); h4.forEach((x, i) => h4Tm.set(x.t, i));
  const d1Tm = new Map<number, number>(); d1.forEach((x, i) => d1Tm.set(x.t, i));
  pairData.set(p, { h1, h4, d1, h1Tm, h4Tm, d1Tm });
}

const btcPd = pairData.get("BTCUSDT")!;
// BTC EMA on 4h for strategies using 4h
const btcE20_4h = computeEMA(btcPd.h4.map(x => x.c), 20);
const btcE50_4h = computeEMA(btcPd.h4.map(x => x.c), 50);
// BTC EMA on 1h
const btcE20_1h = computeEMA(btcPd.h1.map(x => x.c), 20);
const btcE50_1h = computeEMA(btcPd.h1.map(x => x.c), 50);
// BTC EMA on daily
const btcE20_d = computeEMA(btcPd.d1.map(x => x.c), 20);
const btcE50_d = computeEMA(btcPd.d1.map(x => x.c), 50);

function btcUp4h(t: number): boolean {
  return btcTrend(btcPd.h4, btcE20_4h, btcE50_4h, t, btcPd.h4Tm) === "up";
}
function btcDn4h(t: number): boolean {
  return btcTrend(btcPd.h4, btcE20_4h, btcE50_4h, t, btcPd.h4Tm) === "down";
}
function btcUp1h(t: number): boolean {
  return btcTrend(btcPd.h1, btcE20_1h, btcE50_1h, t, btcPd.h1Tm) === "up";
}
function btcUpD(t: number): boolean {
  return btcTrend(btcPd.d1, btcE20_d, btcE50_d, t, btcPd.d1Tm) === "up";
}

console.log(`Loaded ${pairData.size} pairs. BTC 4h bars: ${btcPd.h4.length}, 1h: ${btcPd.h1.length}, daily: ${btcPd.d1.length}`);

// ==================== STRATEGY 1: Volatility Contraction Breakout (4h) ====================
function strat1(): { full: Trade[]; oos: Trade[] } {
  const allTrades: Trade[] = [];

  for (const p of PP) {
    const pd = pairData.get(p);
    if (!pd) continue;
    const cs = pd.h4;
    if (cs.length < 150) continue;

    const bb = computeBB(cs.map(x => x.c), 20, 2);
    const atr = computeATR(cs, 14);
    const sp = SP[p] ?? 4e-4;
    const pos: Pos | null = null;
    let curPos: Pos | null = null;

    for (let i = 120; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < FULL_S) continue;

      // Check exits first
      if (curPos) {
        const elapsed = (bar.t - curPos.et) / H4;
        let xp = 0;
        // SL check
        if (curPos.dir === "long" && bar.l <= curPos.sl) {
          xp = curPos.sl * (1 - sp * SL_SLIP);
        } else if (curPos.dir === "short" && bar.h >= curPos.sl) {
          xp = curPos.sl * (1 + sp * SL_SLIP);
        }
        // TP check
        if (!xp && curPos.tp > 0) {
          if (curPos.dir === "long" && bar.h >= curPos.tp) {
            xp = curPos.tp * (1 - sp);
          } else if (curPos.dir === "short" && bar.l <= curPos.tp) {
            xp = curPos.tp * (1 + sp);
          }
        }
        // Max hold
        if (!xp && elapsed >= 48) {
          xp = curPos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        }
        if (xp > 0) {
          const raw = curPos.dir === "long"
            ? (xp / curPos.ep - 1) * SZ * LEV
            : (curPos.ep / xp - 1) * SZ * LEV;
          const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
          allTrades.push({ pnl: raw - fees, et: curPos.et, xt: bar.t });
          curPos = null;
        }
      }

      // Entry logic
      if (curPos) continue;

      const bbCur = gvBB(bb, i, cs.length);
      const bbPrev = gvBB(bb, i - 1, cs.length);
      if (!bbCur || !bbPrev) continue;

      // BB width
      const widthCur = (bbCur.upper - bbCur.lower) / bbCur.middle;
      const widthPrev = (bbPrev.upper - bbPrev.lower) / bbPrev.middle;

      // 20th percentile of width over last 100 bars
      const widths: number[] = [];
      for (let j = Math.max(0, i - 99); j <= i; j++) {
        const b = gvBB(bb, j, cs.length);
        if (b && b.middle > 0) widths.push((b.upper - b.lower) / b.middle);
      }
      if (widths.length < 50) continue;
      widths.sort((a, b) => a - b);
      const pct20 = widths[Math.floor(widths.length * 0.2)];

      // Was in squeeze (prev width below 20th pctile), now expanded
      const wasSqueeze = widthPrev <= pct20;
      const nowExpanded = widthCur > pct20;
      if (!wasSqueeze || !nowExpanded) continue;

      const atrVal = gv(atr, i, cs.length);
      if (!atrVal || atrVal <= 0) continue;

      let dir: "long" | "short" | null = null;
      if (bar.c > bbCur.upper) dir = "long";
      else if (bar.c < bbCur.lower) dir = "short";
      if (!dir) continue;

      // BTC filter for longs
      if (dir === "long" && !btcUp4h(bar.t)) continue;

      const ent = dir === "long" ? bar.c * (1 + sp) : bar.c * (1 - sp);
      const sl = dir === "long" ? ent - atrVal * 2 : ent + atrVal * 2;
      const tp = dir === "long" ? ent + atrVal * 3 : ent - atrVal * 3;

      curPos = { pair: p, dir, ep: ent, et: bar.t, sl, tp, meta: {} };
    }

    // Close open position at end
    if (curPos) {
      const last = cs[cs.length - 1];
      const xp = curPos.dir === "long" ? last.c * (1 - sp) : last.c * (1 + sp);
      const raw = curPos.dir === "long"
        ? (xp / curPos.ep - 1) * SZ * LEV
        : (curPos.ep / xp - 1) * SZ * LEV;
      const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
      allTrades.push({ pnl: raw - fees, et: curPos.et, xt: last.t });
    }
  }

  allTrades.sort((a, b) => a.et - b.et);
  return {
    full: allTrades.filter(t => t.et >= FULL_S && t.xt <= FULL_E),
    oos: allTrades.filter(t => t.et >= OOS_S && t.xt <= FULL_E),
  };
}

// ==================== STRATEGY 2: Volume Climax Reversal (1h) ====================
function strat2(): { full: Trade[]; oos: Trade[] } {
  const allTrades: Trade[] = [];

  for (const p of PP) {
    const pd = pairData.get(p);
    if (!pd) continue;
    const cs = pd.h1;
    if (cs.length < 200) continue;

    const sp = SP[p] ?? 4e-4;
    let curPos: Pos | null = null;

    for (let i = 60; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < FULL_S) continue;

      // Check exits
      if (curPos) {
        let xp = 0;
        // SL: 2%
        if (curPos.dir === "long" && bar.l <= curPos.sl) {
          xp = curPos.sl * (1 - sp * SL_SLIP);
        } else if (curPos.dir === "short" && bar.h >= curPos.sl) {
          xp = curPos.sl * (1 + sp * SL_SLIP);
        }
        // TP: 4%
        if (!xp && curPos.tp > 0) {
          if (curPos.dir === "long" && bar.h >= curPos.tp) {
            xp = curPos.tp * (1 - sp);
          } else if (curPos.dir === "short" && bar.l <= curPos.tp) {
            xp = curPos.tp * (1 + sp);
          }
        }
        // Max hold: 24h = 24 bars
        if (!xp && bar.t - curPos.et >= 24 * H) {
          xp = curPos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        }
        if (xp > 0) {
          const raw = curPos.dir === "long"
            ? (xp / curPos.ep - 1) * SZ * LEV
            : (curPos.ep / xp - 1) * SZ * LEV;
          const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
          allTrades.push({ pnl: raw - fees, et: curPos.et, xt: bar.t });
          curPos = null;
        }
      }

      if (curPos) continue;

      // Volume climax: volume > 3x 50-bar avg
      let volSum = 0;
      for (let j = i - 50; j < i; j++) volSum += cs[j].v;
      const avgVol = volSum / 50;
      if (avgVol <= 0 || bar.v <= avgVol * 3) continue;

      const isBearish = bar.c < bar.o;
      const isBullish = bar.c > bar.o;
      if (!isBearish && !isBullish) continue;

      // Selling climax (bearish + high vol) -> long next bar
      // Buying climax (bullish + high vol) -> short next bar
      let dir: "long" | "short" | null = null;
      if (isBearish) dir = "long";   // selling climax -> reversal long
      if (isBullish) dir = "short";  // buying climax -> reversal short

      if (!dir) continue;

      // BTC filter
      if (dir === "long" && !btcUp1h(bar.t)) continue;

      // Enter next bar
      if (i + 1 >= cs.length) continue;
      const nextBar = cs[i + 1];
      const ent = dir === "long" ? nextBar.o * (1 + sp) : nextBar.o * (1 - sp);
      const sl = dir === "long" ? ent * (1 - 0.02) : ent * (1 + 0.02);
      const tp = dir === "long" ? ent * (1 + 0.04) : ent * (1 - 0.04);

      curPos = { pair: p, dir, ep: ent, et: nextBar.t, sl, tp, meta: {} };
    }

    if (curPos) {
      const last = cs[cs.length - 1];
      const xp = curPos.dir === "long" ? last.c * (1 - sp) : last.c * (1 + sp);
      const raw = curPos.dir === "long"
        ? (xp / curPos.ep - 1) * SZ * LEV
        : (curPos.ep / xp - 1) * SZ * LEV;
      const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
      allTrades.push({ pnl: raw - fees, et: curPos.et, xt: last.t });
    }
  }

  allTrades.sort((a, b) => a.et - b.et);
  return {
    full: allTrades.filter(t => t.et >= FULL_S && t.xt <= FULL_E),
    oos: allTrades.filter(t => t.et >= OOS_S && t.xt <= FULL_E),
  };
}

// ==================== STRATEGY 3: Range Expansion (Daily) ====================
function strat3(): { full: Trade[]; oos: Trade[] } {
  const allTrades: Trade[] = [];

  for (const p of PP) {
    const pd = pairData.get(p);
    if (!pd) continue;
    const cs = pd.d1;
    if (cs.length < 100) continue;

    const atr = computeATR(cs, 14);
    const sp = SP[p] ?? 4e-4;
    let curPos: Pos | null = null;

    // Donchian 10d for exit
    function donchianHigh(idx: number, lb: number): number {
      let mx = -Infinity;
      for (let j = idx - lb; j < idx; j++) { if (j >= 0) mx = Math.max(mx, cs[j].h); }
      return mx;
    }
    function donchianLow(idx: number, lb: number): number {
      let mn = Infinity;
      for (let j = idx - lb; j < idx; j++) { if (j >= 0) mn = Math.min(mn, cs[j].l); }
      return mn;
    }

    for (let i = 30; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < FULL_S) continue;

      // Check exits
      if (curPos) {
        let xp = 0;
        // SL: ATR*2
        if (curPos.dir === "long" && bar.l <= curPos.sl) {
          xp = curPos.sl * (1 - sp * SL_SLIP);
        } else if (curPos.dir === "short" && bar.h >= curPos.sl) {
          xp = curPos.sl * (1 + sp * SL_SLIP);
        }
        // Donchian 10d exit
        if (!xp) {
          if (curPos.dir === "long" && bar.c < donchianLow(i, 10)) {
            xp = bar.c * (1 - sp);
          } else if (curPos.dir === "short" && bar.c > donchianHigh(i, 10)) {
            xp = bar.c * (1 + sp);
          }
        }
        // Max hold: 30 days
        if (!xp && bar.t - curPos.et >= 30 * DAY) {
          xp = curPos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        }
        if (xp > 0) {
          const raw = curPos.dir === "long"
            ? (xp / curPos.ep - 1) * SZ * LEV
            : (curPos.ep / xp - 1) * SZ * LEV;
          const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
          allTrades.push({ pnl: raw - fees, et: curPos.et, xt: bar.t });
          curPos = null;
        }
      }

      if (curPos) continue;

      // Range expansion: today's range > 2x 20-day average range
      const todayRange = (bar.h - bar.l) / bar.c;
      let rangeSum = 0;
      for (let j = i - 20; j < i; j++) {
        if (j >= 0) rangeSum += (cs[j].h - cs[j].l) / cs[j].c;
      }
      const avgRange = rangeSum / 20;
      if (todayRange <= avgRange * 2) continue;

      const isBullish = bar.c > bar.o;
      const dir: "long" | "short" = isBullish ? "long" : "short";

      // BTC filter for longs
      if (dir === "long" && !btcUpD(bar.t)) continue;

      // Enter next day
      if (i + 1 >= cs.length) continue;
      const nextBar = cs[i + 1];
      const ent = dir === "long" ? nextBar.o * (1 + sp) : nextBar.o * (1 - sp);

      const atrVal = gv(atr, i, cs.length);
      if (!atrVal || atrVal <= 0) continue;
      const sl = dir === "long" ? ent - atrVal * 2 : ent + atrVal * 2;

      curPos = { pair: p, dir, ep: ent, et: nextBar.t, sl, tp: 0, meta: {} };
    }

    if (curPos) {
      const last = cs[cs.length - 1];
      const xp = curPos.dir === "long" ? last.c * (1 - sp) : last.c * (1 + sp);
      const raw = curPos.dir === "long"
        ? (xp / curPos.ep - 1) * SZ * LEV
        : (curPos.ep / xp - 1) * SZ * LEV;
      const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
      allTrades.push({ pnl: raw - fees, et: curPos.et, xt: last.t });
    }
  }

  allTrades.sort((a, b) => a.et - b.et);
  return {
    full: allTrades.filter(t => t.et >= FULL_S && t.xt <= FULL_E),
    oos: allTrades.filter(t => t.et >= OOS_S && t.xt <= FULL_E),
  };
}

// ==================== STRATEGY 4: ATR Breakout (4h) ====================
function strat4(): { full: Trade[]; oos: Trade[] } {
  const allTrades: Trade[] = [];

  for (const p of PP) {
    const pd = pairData.get(p);
    if (!pd) continue;
    const cs = pd.h4;
    if (cs.length < 100) continue;

    const atr = computeATR(cs, 14);
    const sp = SP[p] ?? 4e-4;
    let curPos: Pos | null = null;

    for (let i = 20; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < FULL_S) continue;

      // Check exits
      if (curPos) {
        let xp = 0;
        // SL
        if (curPos.dir === "long" && bar.l <= curPos.sl) {
          xp = curPos.sl * (1 - sp * SL_SLIP);
        } else if (curPos.dir === "short" && bar.h >= curPos.sl) {
          xp = curPos.sl * (1 + sp * SL_SLIP);
        }
        // TP
        if (!xp && curPos.tp > 0) {
          if (curPos.dir === "long" && bar.h >= curPos.tp) {
            xp = curPos.tp * (1 - sp);
          } else if (curPos.dir === "short" && bar.l <= curPos.tp) {
            xp = curPos.tp * (1 + sp);
          }
        }
        // Max hold: 48h = 12 4h bars
        if (!xp && bar.t - curPos.et >= 48 * H) {
          xp = curPos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        }
        if (xp > 0) {
          const raw = curPos.dir === "long"
            ? (xp / curPos.ep - 1) * SZ * LEV
            : (curPos.ep / xp - 1) * SZ * LEV;
          const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
          allTrades.push({ pnl: raw - fees, et: curPos.et, xt: bar.t });
          curPos = null;
        }
      }

      if (curPos) continue;

      // ATR breakout: single bar move > 2x ATR(14) from prev close
      const prevClose = cs[i - 1].c;
      const atrVal = gv(atr, i - 1, cs.length);
      if (!atrVal || atrVal <= 0) continue;

      const move = bar.c - prevClose;
      const absMove = Math.abs(move);
      if (absMove <= atrVal * 2) continue;

      const bigBarRange = bar.h - bar.l;
      if (bigBarRange <= 0) continue;

      const dir: "long" | "short" = move > 0 ? "long" : "short";

      // BTC filter for longs
      if (dir === "long" && !btcUp4h(bar.t)) continue;

      const ent = dir === "long" ? bar.c * (1 + sp) : bar.c * (1 - sp);
      // SL: 50% of big bar range
      const sl = dir === "long" ? ent - bigBarRange * 0.5 : ent + bigBarRange * 0.5;
      // TP: 1.5x big bar range
      const tp = dir === "long" ? ent + bigBarRange * 1.5 : ent - bigBarRange * 1.5;

      curPos = { pair: p, dir, ep: ent, et: bar.t, sl, tp, meta: {} };
    }

    if (curPos) {
      const last = cs[cs.length - 1];
      const xp = curPos.dir === "long" ? last.c * (1 - sp) : last.c * (1 + sp);
      const raw = curPos.dir === "long"
        ? (xp / curPos.ep - 1) * SZ * LEV
        : (curPos.ep / xp - 1) * SZ * LEV;
      const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
      allTrades.push({ pnl: raw - fees, et: curPos.et, xt: last.t });
    }
  }

  allTrades.sort((a, b) => a.et - b.et);
  return {
    full: allTrades.filter(t => t.et >= FULL_S && t.xt <= FULL_E),
    oos: allTrades.filter(t => t.et >= OOS_S && t.xt <= FULL_E),
  };
}

// ==================== STRATEGY 5: Keltner Channel Breakout (4h) ====================
function strat5(): { full: Trade[]; oos: Trade[] } {
  const allTrades: Trade[] = [];

  for (const p of PP) {
    const pd = pairData.get(p);
    if (!pd) continue;
    const cs = pd.h4;
    if (cs.length < 150) continue;

    const bb = computeBB(cs.map(x => x.c), 20, 2);
    const atr10 = computeATR(cs, 10);
    const atr14 = computeATR(cs, 14);
    const ema20 = computeEMA(cs.map(x => x.c), 20);
    const sp = SP[p] ?? 4e-4;
    let curPos: Pos | null = null;

    for (let i = 50; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < FULL_S) continue;

      // Check exits
      if (curPos) {
        let xp = 0;
        // SL: EMA(20)
        const emaVal = gv(ema20, i, cs.length);
        if (emaVal) {
          if (curPos.dir === "long" && bar.l <= emaVal) {
            xp = emaVal * (1 - sp * SL_SLIP);
          } else if (curPos.dir === "short" && bar.h >= emaVal) {
            xp = emaVal * (1 + sp * SL_SLIP);
          }
        }
        // TP: 3x ATR
        if (!xp && curPos.tp > 0) {
          if (curPos.dir === "long" && bar.h >= curPos.tp) {
            xp = curPos.tp * (1 - sp);
          } else if (curPos.dir === "short" && bar.l <= curPos.tp) {
            xp = curPos.tp * (1 + sp);
          }
        }
        // Max hold: 48 4h bars
        if (!xp && bar.t - curPos.et >= 48 * H4) {
          xp = curPos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        }
        if (xp > 0) {
          const raw = curPos.dir === "long"
            ? (xp / curPos.ep - 1) * SZ * LEV
            : (curPos.ep / xp - 1) * SZ * LEV;
          const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
          allTrades.push({ pnl: raw - fees, et: curPos.et, xt: bar.t });
          curPos = null;
        }
      }

      if (curPos) continue;

      // Keltner channel: EMA(20) +/- 2*ATR(10)
      const emaVal = gv(ema20, i, cs.length);
      const atr10Val = gv(atr10, i, cs.length);
      const atr14Val = gv(atr14, i, cs.length);
      const bbVal = gvBB(bb, i, cs.length);
      if (!emaVal || !atr10Val || !atr14Val || !bbVal) continue;

      const kcUpper = emaVal + 2 * atr10Val;
      const kcLower = emaVal - 2 * atr10Val;

      // Check previous bar: was inside BOTH Keltner AND BB = double squeeze
      const prevEma = gv(ema20, i - 1, cs.length);
      const prevAtr10 = gv(atr10, i - 1, cs.length);
      const prevBb = gvBB(bb, i - 1, cs.length);
      if (!prevEma || !prevAtr10 || !prevBb) continue;

      const prevKcU = prevEma + 2 * prevAtr10;
      const prevKcL = prevEma - 2 * prevAtr10;
      const prevClose = cs[i - 1].c;

      const wasInsideKC = prevClose < prevKcU && prevClose > prevKcL;
      const wasInsideBB = prevClose < prevBb.upper && prevClose > prevBb.lower;
      if (!wasInsideKC || !wasInsideBB) continue;

      // Current bar: close outside BOTH
      const outsideKC = bar.c > kcUpper || bar.c < kcLower;
      const outsideBB = bar.c > bbVal.upper || bar.c < bbVal.lower;
      if (!outsideKC || !outsideBB) continue;

      const dir: "long" | "short" = bar.c > kcUpper ? "long" : "short";

      // BTC filter for longs
      if (dir === "long" && !btcUp4h(bar.t)) continue;

      const ent = dir === "long" ? bar.c * (1 + sp) : bar.c * (1 - sp);
      // SL: EMA(20) - handled dynamically in exit
      const sl = dir === "long" ? emaVal : emaVal; // placeholder, actual SL is dynamic EMA
      // TP: 3x ATR
      const tp = dir === "long" ? ent + atr14Val * 3 : ent - atr14Val * 3;

      curPos = { pair: p, dir, ep: ent, et: bar.t, sl, tp, meta: {} };
    }

    if (curPos) {
      const last = cs[cs.length - 1];
      const xp = curPos.dir === "long" ? last.c * (1 - sp) : last.c * (1 + sp);
      const raw = curPos.dir === "long"
        ? (xp / curPos.ep - 1) * SZ * LEV
        : (curPos.ep / xp - 1) * SZ * LEV;
      const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
      allTrades.push({ pnl: raw - fees, et: curPos.et, xt: last.t });
    }
  }

  allTrades.sort((a, b) => a.et - b.et);
  return {
    full: allTrades.filter(t => t.et >= FULL_S && t.xt <= FULL_E),
    oos: allTrades.filter(t => t.et >= OOS_S && t.xt <= FULL_E),
  };
}

// ==================== STRATEGY 6: Session Gap Fade (1h) ====================
// Crypto has no overnight close, so we define "gap" as:
// Compare the 08:00 UTC 1h bar open to the 00:00 UTC 1h bar close (8h session gap proxy)
// If gap > 1%, fade it. Exit when price fills back to 00:00 close or after 24h.
function strat6(): { full: Trade[]; oos: Trade[] } {
  const allTrades: Trade[] = [];

  for (const p of PP) {
    const pd = pairData.get(p);
    if (!pd) continue;
    const cs = pd.h1;
    if (cs.length < 200) continue;

    const sp = SP[p] ?? 4e-4;
    let curPos: Pos | null = null;

    // Build a map of day -> { close00: close at 00:00 bar, open08: open at 08:00 bar, idx08: bar index }
    for (let i = 10; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < FULL_S) continue;

      // Check exits
      if (curPos) {
        let xp = 0;
        // SL: 2%
        if (curPos.dir === "long" && bar.l <= curPos.sl) {
          xp = curPos.sl * (1 - sp * SL_SLIP);
        } else if (curPos.dir === "short" && bar.h >= curPos.sl) {
          xp = curPos.sl * (1 + sp * SL_SLIP);
        }
        // Target: price returns to reference close
        if (!xp && curPos.meta.target) {
          if (curPos.dir === "long" && bar.h >= curPos.meta.target) {
            xp = curPos.meta.target * (1 - sp);
          } else if (curPos.dir === "short" && bar.l <= curPos.meta.target) {
            xp = curPos.meta.target * (1 + sp);
          }
        }
        // Max hold: 24h
        if (!xp && bar.t - curPos.et >= 24 * H) {
          xp = curPos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        }
        if (xp > 0) {
          const raw = curPos.dir === "long"
            ? (xp / curPos.ep - 1) * SZ * LEV
            : (curPos.ep / xp - 1) * SZ * LEV;
          const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
          allTrades.push({ pnl: raw - fees, et: curPos.et, xt: bar.t });
          curPos = null;
        }
      }

      if (curPos) continue;

      // Only trigger at 08:00 UTC bars
      const hour = new Date(bar.t).getUTCHours();
      if (hour !== 8) continue;

      // Find the 00:00 UTC bar (8 bars back)
      const refIdx = i - 8;
      if (refIdx < 0) continue;
      const refBar = cs[refIdx];
      const refHour = new Date(refBar.t).getUTCHours();
      if (refHour !== 0) continue; // sanity check

      // Gap: 08:00 open vs 00:00 close
      const gap = (bar.o - refBar.c) / refBar.c;

      let dir: "long" | "short" | null = null;
      if (gap > 0.01) dir = "short";      // gap up -> fade -> short
      else if (gap < -0.01) dir = "long";  // gap down -> fade -> long

      if (!dir) continue;

      const ent = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
      const sl = dir === "long" ? ent * (1 - 0.02) : ent * (1 + 0.02);

      curPos = { pair: p, dir, ep: ent, et: bar.t, sl, tp: 0, meta: { target: refBar.c } };
    }

    if (curPos) {
      const last = cs[cs.length - 1];
      const xp = curPos.dir === "long" ? last.c * (1 - sp) : last.c * (1 + sp);
      const raw = curPos.dir === "long"
        ? (xp / curPos.ep - 1) * SZ * LEV
        : (curPos.ep / xp - 1) * SZ * LEV;
      const fees = SZ * LEV * (entryCost(sp) + exitCost(sp));
      allTrades.push({ pnl: raw - fees, et: curPos.et, xt: last.t });
    }
  }

  allTrades.sort((a, b) => a.et - b.et);
  return {
    full: allTrades.filter(t => t.et >= FULL_S && t.xt <= FULL_E),
    oos: allTrades.filter(t => t.et >= OOS_S && t.xt <= FULL_E),
  };
}

// ==================== RUN ALL ====================
console.log("\n=== VOLATILITY & VOLUME PATTERN STRATEGIES ===");
console.log(`Full period: 2023-01 to 2026-03 | OOS: 2025-09-01+`);
console.log(`Cost: Taker ${FEE * 100}%, spread map, ${SL_SLIP}x SL slip, ${LEV}x lev, $${SZ}/trade\n`);

const header = "                          Trades    PF  Sharpe   $/day    WR%   MaxDD";
const sep = "-".repeat(72);

interface StratResult {
  name: string;
  desc: string;
  fn: () => { full: Trade[]; oos: Trade[] };
}

const strategies: StratResult[] = [
  { name: "1. BB Squeeze Breakout", desc: "4h BB width squeeze->expand + close outside BB", fn: strat1 },
  { name: "2. Volume Climax Rev", desc: "1h vol>3x avg + reversal", fn: strat2 },
  { name: "3. Range Expansion", desc: "Daily range>2x avg -> trend continuation", fn: strat3 },
  { name: "4. ATR Breakout", desc: "4h single bar > 2x ATR move", fn: strat4 },
  { name: "5. Keltner+BB Squeeze", desc: "4h double squeeze breakout", fn: strat5 },
  { name: "6. Session Gap Fade", desc: "1h 08:00 vs 00:00 gap >1% -> fade", fn: strat6 },
];

for (const s of strategies) {
  console.log(`\n--- ${s.name} ---`);
  console.log(`    ${s.desc}`);
  const r = s.fn();
  const fullS = stats(r.full, FULL_S, FULL_E);
  const oosS = stats(r.oos, OOS_S, FULL_E);
  console.log(header);
  console.log(sep);
  console.log(`  FULL:  ${fmt(fullS)}`);
  console.log(`  OOS:   ${fmt(oosS)}`);
}

// Summary table
console.log("\n\n=== SUMMARY TABLE ===\n");
console.log("Strategy                    | Period | Trades |   PF | Sharpe |  $/day |   WR% |  MaxDD");
console.log("-".repeat(95));

for (const s of strategies) {
  const r = s.fn();
  const fullS = stats(r.full, FULL_S, FULL_E);
  const oosS = stats(r.oos, OOS_S, FULL_E);
  const nm = s.name.padEnd(27);
  const fPnl = fullS.pnl >= 0 ? `+$${fullS.dPnl.toFixed(2)}` : `-$${Math.abs(fullS.dPnl).toFixed(2)}`;
  const oPnl = oosS.pnl >= 0 ? `+$${oosS.dPnl.toFixed(2)}` : `-$${Math.abs(oosS.dPnl).toFixed(2)}`;
  console.log(`${nm} |  FULL  | ${String(fullS.n).padStart(6)} | ${fullS.pf.toFixed(2).padStart(4)} | ${fullS.sh.toFixed(2).padStart(6)} | ${fPnl.padStart(6)} | ${(fullS.wr.toFixed(1) + "%").padStart(5)} | $${fullS.dd.toFixed(0).padStart(5)}`);
  console.log(`${" ".repeat(27)} |  OOS   | ${String(oosS.n).padStart(6)} | ${oosS.pf.toFixed(2).padStart(4)} | ${oosS.sh.toFixed(2).padStart(6)} | ${oPnl.padStart(6)} | ${(oosS.wr.toFixed(1) + "%").padStart(5)} | $${oosS.dd.toFixed(0).padStart(5)}`);
  console.log("-".repeat(95));
}
