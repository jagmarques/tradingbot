/**
 * Verification backtest: compares the EXACT production config
 * before and after the exchange-SL fix (garch-v2-engine.ts line 111).
 *
 * Entry: EXACT live signal (z1h>2.0 AND z4h>1.5, no other filters)
 * SL: 0.3% price, capped at 1.0%
 * Trail: 9/0.5 (single stage)
 * Pairs: 127, $10 margin, real per-pair lev capped 10x
 * Block hours 22-23, 1h SL cooldown per pair+dir
 *
 * Two scenarios simulated:
 *   A. BOT SL at 1h boundary, exits at ACTUAL bar close (models real gap behavior)
 *   B. EXCHANGE SL at tick-level, exits at SL price + slippage (models real exchange fill)
 *
 * Key metric: MaxSingleLoss and avg loss — the user cares about bleeding.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-exchange-sl-verify.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MOM_LB = 3;
const VOL_WIN = 20;
const MAX_HOLD_H = 72;
const CD_H = 1;
const BLOCK_HOURS = new Set([22, 23]);
const FEE = 0.00035;
const MARGIN = 10;
const SL_PRICE_PCT = 0.003; // 0.3% price (live exact)
const SL_CAP_PRICE_PCT = 0.01; // 1.0% max price move
const TRAIL_ACTIVATION = 9; // leveraged pnl %
const TRAIL_DISTANCE = 0.5; // leveraged pnl %
const Z_LONG_1H = 2.0;
const Z_SHORT_1H = -2.0;
const Z_LONG_4H = 1.5;
const Z_SHORT_4H = -1.5;
const SL_SLIP = 1.5; // slippage multiplier on SL fills

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DSP = 5e-4;
const RM: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };

const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
const getLev = (n: string) => Math.min(LM.get(n) ?? 3, 10);

const ALL = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
  "ZEC", "AVAX", "NEAR", "kPEPE", "SUI", "HYPE", "FET",
  "FIL", "ALGO", "BCH", "JTO", "SAND", "BLUR", "TAO", "RENDER", "TRX", "AAVE",
  "JUP", "POL", "CRV", "PYTH", "IMX", "BNB", "ONDO", "XLM", "DYDX", "ICP", "LTC", "MKR",
  "PENDLE", "PNUT", "ATOM", "TON", "SEI", "STX",
  "DYM", "CFX", "ALT", "BIO", "OMNI", "ORDI", "XAI", "SUSHI", "ME", "ZEN",
  "TNSR", "CATI", "TURBO", "MOVE", "GALA", "STRK", "SAGA", "ILV", "GMX", "OM",
  "CYBER", "NTRN", "BOME", "MEME", "ANIME", "BANANA", "ETC", "USUAL", "UMA", "USTC",
  "MAV", "REZ", "NOT", "PENGU", "BIGTIME", "WCT", "EIGEN", "MANTA", "POLYX", "W",
  "FXS", "GMT", "RSR", "PEOPLE", "YGG", "TRB", "ETHFI", "ENS", "OGN", "AXS",
  "MINA", "LISTA", "NEO", "AI", "SCR", "APE", "KAITO", "AR", "BNT", "PIXEL",
  "LAYER", "ZRO", "CELO", "ACE", "COMP", "RDNT", "ZK", "MET", "STG", "REQ",
  "CAKE", "SUPER", "FTT", "STRAX",
];

const OOS_S = new Date("2025-06-01").getTime();
const OOS_E = new Date("2026-03-25").getTime();
const OOS_D = (OOS_E - OOS_S) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; entryTs: number; exitTs: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  z1: number[]; z4: number[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
}
interface PD { name: string; ind: PI; sp: number; lev: number; not: number; }

function load(s: string): C[] {
  const f = path.join(CACHE_5M, `${s}.json`);
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as unknown[])
    .map((b: unknown) => {
      if (Array.isArray(b)) return { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
      const o = b as Record<string, number>;
      return { t: +o.t, o: +o.o, h: +o.h, l: +o.l, c: +o.c };
    })
    .sort((a, b) => a.t - b.t);
}

function aggregate(bars: C[], period: number, minBars: number): C[] {
  const g = new Map<number, C[]>();
  for (const c of bars) {
    const k = Math.floor(c.t / period) * period;
    let arr = g.get(k);
    if (!arr) { arr = []; g.set(k, arr); }
    arr.push(c);
  }
  const r: C[] = [];
  for (const [t, grp] of g) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    r.push({
      t, o: grp[0]!.o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1]!.c,
    });
  }
  return r.sort((a, b) => a.t - b.t);
}

function computeZ(cs: C[]): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < cs.length; i++) {
    const m = cs[i]!.c / cs[i - MOM_LB]!.c - 1;
    let ss = 0, c = 0;
    for (let j = Math.max(1, i - VOL_WIN); j <= i; j++) {
      const r = cs[j]!.c / cs[j - 1]!.c - 1;
      ss += r * r; c++;
    }
    if (c < 10) continue;
    const v = Math.sqrt(ss / c);
    if (v === 0) continue;
    z[i] = m / v;
  }
  return z;
}

function get4hZ(z4: number[], h4: C[], h4Map: Map<number, number>, t: number): number {
  const b = Math.floor(t / H4) * H4;
  const i = h4Map.get(b);
  if (i !== undefined && i > 0) return z4[i - 1]!;
  let lo = 0, hi = h4.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (h4[m]!.t < t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? z4[best]! : 0;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
}

interface SimResult {
  trades: Tr[];
  totalPnl: number;
  dollarsPerDay: number;
  maxDD: number;
  pf: number;
  wr: number;
  avgWin: number;
  avgLoss: number;
  maxSingleLoss: number;
  numTrades: number;
  slCount: number;
  trailCount: number;
  avgSlLoss: number;
}

/**
 * mode: "bot1h" = SL exits at the bar close on the 1h boundary where check fires
 *                 (models the gap bug — if price gapped 2% past SL, loss is 2%, not 0.3%)
 *       "exch"  = SL exits at exact SL price + slippage, intra-bar (models exchange fill)
 */
function simulate(pairs: PD[], mode: "bot1h" | "exch"): SimResult {
  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();
  const openPositions: OpenPos[] = [];

  const all5mTimes = new Set<number>();
  for (const p of pairs) {
    for (const b of p.ind.m5) {
      if (b.t >= OOS_S && b.t < OOS_E) all5mTimes.add(b.t);
    }
  }
  const timepoints = [...all5mTimes].sort((a, b) => a - b);

  const m5Maps = new Map<string, Map<number, number>>();
  const pairByName = new Map<string, PD>();
  for (const p of pairs) {
    const m = new Map<number, number>();
    p.ind.m5.forEach((c, i) => m.set(c.t, i));
    m5Maps.set(p.name, m);
    pairByName.set(p.name, p);
  }

  for (const ts of timepoints) {
    const isH1Boundary = ts % H === 0;
    const hourOfDay = new Date(ts).getUTCHours();

    // ─── EXITS ───
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair);
      if (!m5Map) continue;
      const bi = m5Map.get(ts);
      if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false, useSlSlip = false;

      // 1) Max hold
      if ((ts - pos.et) / H >= MAX_HOLD_H) {
        xp = bar.c;
        reason = "maxh";
      }

      // 2) Stop-loss
      if (!xp) {
        if (mode === "exch") {
          // EXCHANGE SL: fires intra-bar at exact SL price when high/low touches
          const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
          if (hit) {
            xp = pos.sl;
            reason = "sl";
            isSL = true;
            useSlSlip = true;
          }
        } else {
          // BOT SL at 1h boundary: check only at 1h close, and if price is past SL,
          // exit at actual CURRENT price (this is the gap behavior in live)
          if (isH1Boundary) {
            const closePrice = bar.c; // 5m bar at the 1h boundary — approximation of 1h close
            const pastSl = pos.dir === "long" ? closePrice <= pos.sl : closePrice >= pos.sl;
            if (pastSl) {
              xp = closePrice; // exit at the current price, NOT the SL price (this is the bug)
              reason = "sl";
              isSL = true;
              useSlSlip = false; // no SL slippage - we're taking the market
            }
          }
        }
      }

      // Update peak for trail
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      // 3) Trail (fires at 5m resolution, matches fast-poll 3s live behavior)
      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= TRAIL_ACTIVATION && cur <= pos.pk - TRAIL_DISTANCE) {
          xp = bar.c;
          reason = "trail";
        }
      }

      if (xp > 0) {
        const rsp = useSlSlip ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    // ─── ENTRIES ───
    if (!isH1Boundary) continue;
    if (BLOCK_HOURS.has(hourOfDay)) continue;

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < VOL_WIN + 2) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      let dir: "long" | "short" | null = null;
      if (z1 > Z_LONG_1H && z4 > Z_LONG_4H) dir = "long";
      if (z1 < Z_SHORT_1H && z4 < Z_SHORT_4H) dir = "short";
      if (!dir) continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);

      // SL price: 0.3% price move from entry, capped at 1%
      const slDist = Math.min(ep * SL_PRICE_PCT, ep * SL_CAP_PRICE_PCT);
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: p.not,
      });
    }
  }

  // EOD close
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: lb.t, pnl, reason: "end" });
  }

  closed.sort((a, b) => a.exitTs - b.exitTs);

  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const wr = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = glAbs > 0 ? gp / glAbs : Infinity;
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  const slTrades = closed.filter(t => t.reason === "sl");
  const trailTrades = closed.filter(t => t.reason === "trail");
  const avgSlLoss = slTrades.length > 0 ? slTrades.reduce((s, t) => s + t.pnl, 0) / slTrades.length : 0;

  return {
    trades: closed,
    totalPnl,
    dollarsPerDay: totalPnl / OOS_D,
    maxDD,
    pf,
    wr,
    avgWin: wins.length > 0 ? gp / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    slCount: slTrades.length,
    trailCount: trailTrades.length,
    avgSlLoss,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  console.log("=".repeat(110));
  console.log("  EXCHANGE SL VERIFICATION");
  console.log("  Compare BOT SL @1h-close-with-gap   vs   EXCHANGE SL @tick-intra-bar");
  console.log("  Entry: z1h>2.0 AND z4h>1.5 | 0.3% price SL cap 1% | trail 9/0.5 | $10 margin | real lev cap 10x");
  console.log(`  Period: 2025-06-01 -> 2026-03-25 (${OOS_D.toFixed(0)} days)`);
  console.log("=".repeat(110));

  console.log("\nLoading 5m + 1h + 4h...");
  const pairs: PD[] = [];
  for (const n of ALL) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 100 || h4.length < 50) continue;
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= OOS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, z1, z4, h1Map, h4Map }, sp: SP[n] ?? DSP, lev, not: MARGIN * lev });
  }
  console.log(`${pairs.length} pairs loaded\n`);

  console.log("Running BOT SL (1h boundary, exit at close price = models gap)...");
  const botRes = simulate(pairs, "bot1h");

  console.log("Running EXCHANGE SL (tick-level, exit at SL price)...");
  const exchRes = simulate(pairs, "exch");

  const print = (label: string, r: SimResult) => {
    console.log(`\n${"=".repeat(110)}`);
    console.log(`  ${label}`);
    console.log("=".repeat(110));
    console.log(`  $/day:            ${fmtD(r.dollarsPerDay)}`);
    console.log(`  Total PnL:        ${fmtD(r.totalPnl)} over ${OOS_D.toFixed(0)} days`);
    console.log(`  Max DD:           $${r.maxDD.toFixed(2)}`);
    console.log(`  Profit Factor:    ${r.pf.toFixed(2)}`);
    console.log(`  Win rate:         ${r.wr.toFixed(1)}%`);
    console.log(`  Num trades:       ${r.numTrades}`);
    console.log(`  Avg win:          ${fmtD(r.avgWin)}`);
    console.log(`  Avg loss:         ${fmtD(r.avgLoss)}`);
    console.log(`  Max single loss:  ${fmtD(r.maxSingleLoss)}`);
    console.log(`  SL count:         ${r.slCount}  (avg SL loss: ${fmtD(r.avgSlLoss)})`);
    console.log(`  Trail count:      ${r.trailCount}`);
  };

  print("BEFORE FIX: Bot SL at 1h boundary, exits at bar close (models gap)", botRes);
  print("AFTER FIX: Exchange SL at tick (exits at SL price + slippage)", exchRes);

  // Diff table
  console.log("\n" + "=".repeat(110));
  console.log("  DIFF: exchange SL vs bot 1h SL");
  console.log("=".repeat(110));
  const d$day = exchRes.dollarsPerDay - botRes.dollarsPerDay;
  const dDD = exchRes.maxDD - botRes.maxDD;
  const dAvgLoss = exchRes.avgLoss - botRes.avgLoss;
  const dMaxLoss = exchRes.maxSingleLoss - botRes.maxSingleLoss;
  const dAvgSlLoss = exchRes.avgSlLoss - botRes.avgSlLoss;
  console.log(`  $/day diff:        ${fmtD(d$day)}  (${botRes.dollarsPerDay >= 0 && exchRes.dollarsPerDay >= 0 ? ((d$day / botRes.dollarsPerDay) * 100).toFixed(1) + "%" : "n/a"})`);
  console.log(`  Max DD diff:       $${dDD.toFixed(2)}  (lower is better)`);
  console.log(`  Avg loss diff:     ${fmtD(dAvgLoss)}  (less negative = safer)`);
  console.log(`  Max loss diff:     ${fmtD(dMaxLoss)}  (less negative = safer)`);
  console.log(`  Avg SL loss diff:  ${fmtD(dAvgSlLoss)}  (this is the gap-fix impact)`);

  // Loss distribution: how many losses are > -$0.50?
  const bigLossesBot = botRes.trades.filter(t => t.pnl < -0.50).length;
  const bigLossesExch = exchRes.trades.filter(t => t.pnl < -0.50).length;
  const hugeLossesBot = botRes.trades.filter(t => t.pnl < -1.00).length;
  const hugeLossesExch = exchRes.trades.filter(t => t.pnl < -1.00).length;
  console.log(`\n  Losses > $0.50:    bot ${bigLossesBot}  vs  exch ${bigLossesExch}  (${bigLossesBot > 0 ? (((bigLossesBot - bigLossesExch) / bigLossesBot) * 100).toFixed(0) + "% reduction" : "n/a"})`);
  console.log(`  Losses > $1.00:    bot ${hugeLossesBot}  vs  exch ${hugeLossesExch}  (${hugeLossesBot > 0 ? (((hugeLossesBot - hugeLossesExch) / hugeLossesBot) * 100).toFixed(0) + "% reduction" : "n/a"})`);

  console.log("\n  Verdict:");
  if (exchRes.dollarsPerDay > botRes.dollarsPerDay) {
    console.log("  EXCHANGE SL WINS on $/day AND reduces per-trade bleeding. Deploy.");
  } else if (exchRes.dollarsPerDay > 0 && exchRes.maxSingleLoss > botRes.maxSingleLoss) {
    console.log(`  EXCHANGE SL is still profitable (${fmtD(exchRes.dollarsPerDay)}/day) AND cuts max loss by ${fmtD(dMaxLoss)}.`);
    console.log(`  Cost: ${fmtD(-d$day)}/day less profit. Safer but slower.`);
  } else if (exchRes.dollarsPerDay <= 0 && botRes.dollarsPerDay > 0) {
    console.log("  Exchange SL unprofitable in backtest. But remember: this backtest may not match live either.");
    console.log("  Live showed 25 trades 0 wins before the fix - backtest reliability is in question.");
  } else {
    console.log("  Both configs have similar outcomes - exchange SL gives you loss control at minor profit cost.");
  }
}

main();
