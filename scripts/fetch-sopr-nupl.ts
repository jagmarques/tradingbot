/**
 * SOPR / NUPL / MVRV-Z On-Chain Data Fetch + Analysis
 *
 * Step 1: Download on-chain data from BGeometrics with retry logic
 * Step 2: Analyze correlations with BTC daily returns
 * Step 3: Test SOPR as a filter on Supertrend(14,1.75) backtest
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";

// ─── Config ─────────────────────────────────────────────────────────
const OUT_DIR = "/tmp/onchain-data";
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10_000;

const LEV = 10;
const SIZE = 10;
const NOT = SIZE * LEV;
const FEE_TAKER = 0.00035;
const DAY = 86400000;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const ALL_PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const OOS_START = new Date("2025-09-01").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}
interface OnChainPoint { date: string; timestamp: number; value: number; }

// ─── Step 1: Download with retries ──────────────────────────────────
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", (d) => body += d);
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
        return;
      }
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, label: string): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[${label}] Attempt ${attempt}/${MAX_RETRIES} ...`);
      const data = await httpGet(url);
      console.log(`[${label}] OK (${data.length} bytes)`);
      return data;
    } catch (err: any) {
      console.log(`[${label}] Failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`[${label}] Waiting ${RETRY_DELAY_MS / 1000}s before retry...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  console.log(`[${label}] All ${MAX_RETRIES} attempts failed.`);
  return null;
}

function parseOnChainData(raw: string, label: string): OnChainPoint[] {
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed.data ?? parsed.values ?? []);
    if (!Array.isArray(arr) || arr.length === 0) {
      console.log(`[${label}] Parsed but empty or unexpected structure. Keys: ${Object.keys(parsed).slice(0, 10)}`);
      return [];
    }
    // Try to normalize - data could be [{date, value}, {timestamp, sopr}, etc.]
    const points: OnChainPoint[] = [];
    for (const item of arr) {
      const date = item.date ?? item.timestamp ?? item.d ?? item.time ?? "";
      const value = item.value ?? item.sopr ?? item.nupl ?? item.mvrv_z ?? item.mvrv ?? item.v ?? item.z_score ?? 0;
      if (date && value !== undefined) {
        const dateStr = typeof date === "number" ? new Date(date > 1e12 ? date : date * 1000).toISOString().split("T")[0] : String(date).split("T")[0];
        const ts = new Date(dateStr + "T00:00:00Z").getTime();
        points.push({ date: dateStr, timestamp: ts, value: +value });
      }
    }
    return points.sort((a, b) => a.timestamp - b.timestamp);
  } catch (err: any) {
    console.log(`[${label}] JSON parse failed: ${err.message}`);
    console.log(`[${label}] First 300 chars: ${raw.slice(0, 300)}`);
    return [];
  }
}

// ─── Step 2: Data Loading & Analysis ─────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregateToDaily(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const dayTs = Math.floor(c.t / DAY) * DAY;
    const arr = groups.get(dayTs) ?? [];
    arr.push(c);
    groups.set(dayTs, arr);
  }
  const daily: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 200) continue;
    daily.push({
      t: ts, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, b) => s + b.v, 0),
    });
  }
  return daily;
}

function aggregateTo4h(candles: C[]): C[] {
  const barsPerGroup = 48; // 48 x 5m = 4h
  const result: C[] = [];
  for (let i = 0; i < candles.length; i += barsPerGroup) {
    const group = candles.slice(i, i + barsPerGroup);
    if (group.length < barsPerGroup * 0.8) continue;
    result.push({
      t: group[0].t,
      o: group[0].o,
      h: Math.max(...group.map(g => g.h)),
      l: Math.min(...group.map(g => g.l)),
      c: group[group.length - 1].c,
      v: group.reduce((s, g) => s + g.v, 0),
    });
  }
  return result;
}

function correlation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 10) return 0;
  const mx = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

function analyzeExtremes(
  data: OnChainPoint[],
  btcDaily: C[],
  label: string,
  lowThresh: number,
  highThresh: number,
) {
  const btcByDate = new Map<number, C>();
  for (const c of btcDaily) btcByDate.set(c.t, c);
  const btcDates = btcDaily.map(c => c.t).sort((a, b) => a - b);

  function futureReturn(ts: number, daysAhead: number): number | null {
    const targetTs = ts + daysAhead * DAY;
    // Find nearest BTC bar at or after target
    const startBar = btcByDate.get(ts);
    if (!startBar) return null;
    let bestTs = 0;
    for (const d of btcDates) {
      if (d >= targetTs) { bestTs = d; break; }
    }
    if (!bestTs) return null;
    const endBar = btcByDate.get(bestTs);
    if (!endBar) return null;
    return (endBar.c / startBar.c - 1) * 100;
  }

  const lowExtremes = data.filter(p => p.value < lowThresh);
  const highExtremes = data.filter(p => p.value > highThresh);

  console.log(`\n--- ${label} Extreme Analysis ---`);
  console.log(`Low extremes (< ${lowThresh}): ${lowExtremes.length} days`);

  if (lowExtremes.length > 0) {
    const ret7: number[] = [];
    const ret30: number[] = [];
    for (const p of lowExtremes) {
      const r7 = futureReturn(p.timestamp, 7);
      const r30 = futureReturn(p.timestamp, 30);
      if (r7 !== null) ret7.push(r7);
      if (r30 !== null) ret30.push(r30);
    }
    if (ret7.length > 0) {
      const avg7 = ret7.reduce((s, v) => s + v, 0) / ret7.length;
      const pct7 = ret7.filter(r => r > 0).length / ret7.length * 100;
      console.log(`  7d forward: avg ${avg7.toFixed(2)}%, positive ${pct7.toFixed(0)}% of time (n=${ret7.length})`);
    }
    if (ret30.length > 0) {
      const avg30 = ret30.reduce((s, v) => s + v, 0) / ret30.length;
      const pct30 = ret30.filter(r => r > 0).length / ret30.length * 100;
      console.log(`  30d forward: avg ${avg30.toFixed(2)}%, positive ${pct30.toFixed(0)}% of time (n=${ret30.length})`);
    }
  }

  console.log(`High extremes (> ${highThresh}): ${highExtremes.length} days`);
  if (highExtremes.length > 0) {
    const ret7: number[] = [];
    const ret30: number[] = [];
    for (const p of highExtremes) {
      const r7 = futureReturn(p.timestamp, 7);
      const r30 = futureReturn(p.timestamp, 30);
      if (r7 !== null) ret7.push(r7);
      if (r30 !== null) ret30.push(r30);
    }
    if (ret7.length > 0) {
      const avg7 = ret7.reduce((s, v) => s + v, 0) / ret7.length;
      const pct7 = ret7.filter(r => r > 0).length / ret7.length * 100;
      console.log(`  7d forward: avg ${avg7.toFixed(2)}%, positive ${pct7.toFixed(0)}% of time (n=${ret7.length})`);
    }
    if (ret30.length > 0) {
      const avg30 = ret30.reduce((s, v) => s + v, 0) / ret30.length;
      const pct30 = ret30.filter(r => r > 0).length / ret30.length * 100;
      console.log(`  30d forward: avg ${avg30.toFixed(2)}%, positive ${pct30.toFixed(0)}% of time (n=${ret30.length})`);
    }
  }
}

// ─── Step 3: Supertrend Backtest Engine ──────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j-1].c), Math.abs(cs[j].l - cs[j-1].c));
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      const prevUpper = (cs[i-1].h + cs[i-1].l) / 2 + mult * atr[i-1];
      const prevLower = (cs[i-1].h + cs[i-1].l) / 2 - mult * atr[i-1];
      const prevFinalUpper = st[i-1] > 0 && dirs[i-1] === -1 ? st[i-1] : prevUpper;
      const prevFinalLower = st[i-1] > 0 && dirs[i-1] === 1 ? st[i-1] : prevLower;

      if (!(lowerBand > prevFinalLower || cs[i-1].c < prevFinalLower)) {
        lowerBand = prevFinalLower;
      }
      if (!(upperBand < prevFinalUpper || cs[i-1].c > prevFinalUpper)) {
        upperBand = prevFinalUpper;
      }
    }

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i-1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }
    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }
  return { st, dir: dirs };
}

function calcVolumeMA(cs: C[], period: number): number[] {
  const ma = new Array(cs.length).fill(0);
  for (let i = period - 1; i < cs.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += cs[j].v;
    ma[i] = s / period;
  }
  return ma;
}

function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE_TAKER * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

function calcMetrics(trades: Tr[], startTs?: number, endTs?: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()].map(p => p / SIZE);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const firstT = startTs ?? Math.min(...trades.map(t => t.et));
  const lastT = endTs ?? Math.max(...trades.map(t => t.xt));
  const days = (lastT - firstT) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

function fmtMetrics(label: string, m: Metrics): string {
  return `${label.padEnd(35)} n=${String(m.n).padStart(5)} wr=${m.wr.toFixed(1).padStart(5)}% pf=${m.pf.toFixed(2).padStart(5)} sharpe=${m.sharpe.toFixed(2).padStart(6)} dd=$${m.dd.toFixed(2).padStart(7)} total=$${m.total.toFixed(2).padStart(8)} $/day=${m.perDay.toFixed(2).padStart(6)}`;
}

// ─── Supertrend Backtest with optional SOPR filter ───────────────────
function runSupertrendBacktest(
  pair: string,
  cs4h: C[],
  atrPer: number,
  mult: number,
  volPer: number,
  soprFilter: null | { soprByDay: Map<number, number>; longMax: number; shortMin: number },
): Tr[] {
  const { dir } = calcSupertrend(cs4h, atrPer, mult);
  const atr = calcATR(cs4h, atrPer);
  const volMA = calcVolumeMA(cs4h, volPer);
  const trades: Tr[] = [];

  let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;

  for (let i = atrPer + volPer; i < cs4h.length; i++) {
    const bar = cs4h[i];

    // Check stop-loss
    if (pos) {
      const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
      if (hit) {
        const xp = pos.sl;
        trades.push({
          pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
          pnl: tradePnl(pair, pos.ep, xp, pos.dir, true), reason: "SL",
        });
        pos = null;
      }
    }

    // Check supertrend flip exit
    if (pos) {
      const flipExit = (pos.dir === "long" && dir[i] === -1) || (pos.dir === "short" && dir[i] === 1);
      if (flipExit) {
        const xp = bar.c;
        trades.push({
          pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
          pnl: tradePnl(pair, pos.ep, xp, pos.dir, false), reason: "flip",
        });
        pos = null;
      }
    }

    // Stagnation exit (48h = 12 bars at 4h)
    if (pos && (bar.t - pos.et) >= 48 * 3600 * 1000) {
      const xp = bar.c;
      trades.push({
        pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
        pnl: tradePnl(pair, pos.ep, xp, pos.dir, false), reason: "stagnation",
      });
      pos = null;
    }

    // Entry
    if (!pos && i > 0) {
      const prevDir = dir[i - 1];
      const curDir = dir[i];
      const volOk = bar.v > volMA[i] * 1.0; // volume above MA
      const flip = prevDir !== curDir && curDir !== 0;

      if (flip && volOk) {
        const newDir: "long" | "short" = curDir === 1 ? "long" : "short";

        // SOPR filter
        if (soprFilter) {
          const barDay = Math.floor(bar.t / DAY) * DAY;
          // Look back up to 2 days for SOPR data
          let soprVal: number | undefined;
          for (let d = 0; d <= 2; d++) {
            soprVal = soprFilter.soprByDay.get(barDay - d * DAY);
            if (soprVal !== undefined) break;
          }
          if (soprVal !== undefined) {
            if (newDir === "long" && soprVal > soprFilter.longMax) continue;
            if (newDir === "short" && soprVal < soprFilter.shortMin) continue;
          }
          // If no SOPR data available, allow the trade
        }

        const ep = bar.c;
        const slDist = atr[i] * 3;
        const maxSlDist = ep * 0.035;
        const effectiveSlDist = Math.min(slDist, maxSlDist);
        const sl = newDir === "long" ? ep - effectiveSlDist : ep + effectiveSlDist;
        pos = { dir: newDir, ep, et: bar.t, sl };
      }
    }
  }

  // Close any remaining position
  if (pos && cs4h.length > 0) {
    const lastBar = cs4h[cs4h.length - 1];
    trades.push({
      pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t,
      pnl: tradePnl(pair, pos.ep, lastBar.c, pos.dir, false), reason: "EOD",
    });
  }

  return trades;
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log("=== SOPR / NUPL / MVRV-Z On-Chain Data Analysis ===\n");

  // Ensure output directory exists
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // ─── Step 1: Download ─────────────────────────────────────────────
  console.log("--- Step 1: Downloading on-chain data ---\n");

  const endpoints = [
    { url: "https://bitcoin-data.com/v1/sopr", label: "SOPR", file: "sopr.json" },
    { url: "https://bitcoin-data.com/v1/nupl", label: "NUPL", file: "nupl.json" },
    { url: "https://bitcoin-data.com/v1/mvrv-z-score", label: "MVRV-Z", file: "mvrv-z.json" },
  ];

  const datasets: Record<string, OnChainPoint[]> = {};
  let anySuccess = false;

  for (const ep of endpoints) {
    const raw = await fetchWithRetry(ep.url, ep.label);
    if (raw) {
      fs.writeFileSync(path.join(OUT_DIR, ep.file), raw);
      console.log(`[${ep.label}] Saved to ${path.join(OUT_DIR, ep.file)}`);
      const parsed = parseOnChainData(raw, ep.label);
      datasets[ep.label] = parsed;
      if (parsed.length > 0) {
        anySuccess = true;
        console.log(`[${ep.label}] ${parsed.length} data points, range: ${parsed[0].date} to ${parsed[parsed.length - 1].date}`);
        // Show a few sample values
        const samples = [parsed[0], parsed[Math.floor(parsed.length/2)], parsed[parsed.length-1]];
        console.log(`[${ep.label}] Samples: ${samples.map(s => `${s.date}=${s.value.toFixed(4)}`).join(", ")}`);
      }
    }
    // Small delay between endpoints to be respectful
    if (ep !== endpoints[endpoints.length - 1]) await sleep(2000);
  }

  if (!anySuccess) {
    console.log("\nNo on-chain data downloaded successfully. Exiting.");
    return;
  }

  // ─── Step 2: Correlations & Extremes ───────────────────────────────
  console.log("\n--- Step 2: Correlation & Extreme Analysis ---\n");

  // Load BTC daily
  const btc5m = load5m("BTC");
  const btcDaily = aggregateToDaily(btc5m);
  console.log(`BTC daily candles: ${btcDaily.length} (${new Date(btcDaily[0]?.t).toISOString().split("T")[0]} to ${new Date(btcDaily[btcDaily.length-1]?.t).toISOString().split("T")[0]})`);

  // Compute BTC daily returns
  const btcReturns: { ts: number; ret: number }[] = [];
  for (let i = 1; i < btcDaily.length; i++) {
    btcReturns.push({
      ts: btcDaily[i].t,
      ret: (btcDaily[i].c / btcDaily[i - 1].c - 1) * 100,
    });
  }

  // For each dataset, compute correlation with BTC daily returns
  for (const [label, points] of Object.entries(datasets)) {
    if (points.length === 0) continue;

    // Align by date
    const onchainByDay = new Map<number, number>();
    for (const p of points) onchainByDay.set(p.timestamp, p.value);

    const aligned: { ocVal: number; btcRet: number }[] = [];
    for (const r of btcReturns) {
      const ocVal = onchainByDay.get(r.ts);
      if (ocVal !== undefined) aligned.push({ ocVal, btcRet: r.ret });
    }

    if (aligned.length < 10) {
      console.log(`[${label}] Only ${aligned.length} aligned points, skipping correlation.`);
      continue;
    }

    const corr = correlation(
      aligned.map(a => a.ocVal),
      aligned.map(a => a.btcRet),
    );
    console.log(`[${label}] Correlation with BTC daily returns: ${corr.toFixed(4)} (n=${aligned.length})`);

    // Also compute correlation with next-day returns (predictive)
    const alignedPred: { ocVal: number; nextRet: number }[] = [];
    const btcRetByDay = new Map<number, number>();
    for (const r of btcReturns) btcRetByDay.set(r.ts, r.ret);

    for (const p of points) {
      const nextDayTs = p.timestamp + DAY;
      const nextRet = btcRetByDay.get(nextDayTs);
      if (nextRet !== undefined) alignedPred.push({ ocVal: p.value, nextRet });
    }
    if (alignedPred.length > 10) {
      const predCorr = correlation(
        alignedPred.map(a => a.ocVal),
        alignedPred.map(a => a.nextRet),
      );
      console.log(`[${label}] Predictive corr (value -> next day BTC return): ${predCorr.toFixed(4)} (n=${alignedPred.length})`);
    }
  }

  // Extreme analysis
  if (datasets["SOPR"]?.length > 0) {
    analyzeExtremes(datasets["SOPR"], btcDaily, "SOPR", 0.95, 1.05);
  }
  if (datasets["NUPL"]?.length > 0) {
    analyzeExtremes(datasets["NUPL"], btcDaily, "NUPL", 0, 0.75);
  }
  if (datasets["MVRV-Z"]?.length > 0) {
    analyzeExtremes(datasets["MVRV-Z"], btcDaily, "MVRV-Z", 0, 3.0);
  }

  // ─── Step 3: SOPR-Filtered Supertrend Backtest ─────────────────────
  const soprData = datasets["SOPR"] ?? [];
  if (soprData.length < 200) {
    console.log(`\n--- Step 3: SKIPPED (only ${soprData.length} SOPR points, need >200) ---`);
    return;
  }

  console.log("\n--- Step 3: SOPR-Filtered Supertrend(14,1.75) Backtest ---\n");

  const soprByDay = new Map<number, number>();
  for (const p of soprData) soprByDay.set(p.timestamp, p.value);

  // Run backtest for each pair: baseline vs SOPR-filtered
  const allBaseline: Tr[] = [];
  const allFilterA: Tr[] = [];
  const allFilterB: Tr[] = [];
  const allFilterAB: Tr[] = [];

  for (const pair of ALL_PAIRS) {
    const raw5m = load5m(pair);
    if (raw5m.length === 0) continue;
    const cs4h = aggregateTo4h(raw5m);
    if (cs4h.length < 100) continue;

    // Baseline: no filter
    const baseline = runSupertrendBacktest(pair, cs4h, 14, 1.75, 20, null);
    allBaseline.push(...baseline);

    // Filter A: only longs when SOPR < 0.98
    const filterA = runSupertrendBacktest(pair, cs4h, 14, 1.75, 20, {
      soprByDay, longMax: 0.98, shortMin: -Infinity,
    });
    allFilterA.push(...filterA);

    // Filter B: only shorts when SOPR > 1.03
    const filterB = runSupertrendBacktest(pair, cs4h, 14, 1.75, 20, {
      soprByDay, longMax: Infinity, shortMin: 1.03,
    });
    allFilterB.push(...filterB);

    // Filter AB: both filters combined
    const filterAB = runSupertrendBacktest(pair, cs4h, 14, 1.75, 20, {
      soprByDay, longMax: 0.98, shortMin: 1.03,
    });
    allFilterAB.push(...filterAB);
  }

  // Full period metrics
  console.log("=== Full Period ===");
  console.log(fmtMetrics("Baseline (no filter)", calcMetrics(allBaseline)));
  console.log(fmtMetrics("Filter A (longs SOPR<0.98)", calcMetrics(allFilterA)));
  console.log(fmtMetrics("Filter B (shorts SOPR>1.03)", calcMetrics(allFilterB)));
  console.log(fmtMetrics("Filter AB (both)", calcMetrics(allFilterAB)));

  // OOS metrics
  const oosBaseline = allBaseline.filter(t => t.et >= OOS_START);
  const oosFilterA = allFilterA.filter(t => t.et >= OOS_START);
  const oosFilterB = allFilterB.filter(t => t.et >= OOS_START);
  const oosFilterAB = allFilterAB.filter(t => t.et >= OOS_START);

  console.log("\n=== OOS (from 2025-09-01) ===");
  console.log(fmtMetrics("Baseline (no filter)", calcMetrics(oosBaseline, OOS_START)));
  console.log(fmtMetrics("Filter A (longs SOPR<0.98)", calcMetrics(oosFilterA, OOS_START)));
  console.log(fmtMetrics("Filter B (shorts SOPR>1.03)", calcMetrics(oosFilterB, OOS_START)));
  console.log(fmtMetrics("Filter AB (both)", calcMetrics(oosFilterAB, OOS_START)));

  // SOPR distribution for context
  console.log("\n=== SOPR Distribution ===");
  const soprValues = soprData.map(p => p.value);
  const sortedSopr = [...soprValues].sort((a, b) => a - b);
  const p5 = sortedSopr[Math.floor(sortedSopr.length * 0.05)];
  const p25 = sortedSopr[Math.floor(sortedSopr.length * 0.25)];
  const p50 = sortedSopr[Math.floor(sortedSopr.length * 0.50)];
  const p75 = sortedSopr[Math.floor(sortedSopr.length * 0.75)];
  const p95 = sortedSopr[Math.floor(sortedSopr.length * 0.95)];
  console.log(`p5=${p5.toFixed(4)} p25=${p25.toFixed(4)} median=${p50.toFixed(4)} p75=${p75.toFixed(4)} p95=${p95.toFixed(4)}`);

  const below098 = soprValues.filter(v => v < 0.98).length;
  const above103 = soprValues.filter(v => v > 1.03).length;
  console.log(`Days with SOPR < 0.98: ${below098} (${(below098/soprValues.length*100).toFixed(1)}%)`);
  console.log(`Days with SOPR > 1.03: ${above103} (${(above103/soprValues.length*100).toFixed(1)}%)`);

  console.log("\nDone.");
}

main().catch(console.error);
