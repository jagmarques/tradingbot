/**
 * Parameter sweep for GARCH-chan engine.
 * Tests combinations of: z-threshold, chandelier mult, SL cap, trailing activation/distance, max hold.
 * Uses 1s intra-bar data for realistic fills.
 *
 * npx tsx scripts/sweep-garch.ts
 */

import { execSync, spawnSync } from "child_process";

interface Combo {
  zThresh: number;
  chanMult: number;
  slCap: number;
  trailA: number;
  trailD: number;
  maxHold: number; // hours
}

interface Result extends Combo {
  trades: number;
  winRate: number;
  pnl: number;
  sharpe: number;
  maxDd: number;
  perDay: number;
  avgHold: number;
}

// Parameter grid
const Z_THRESHOLDS = [0.5, 0.7, 1.0, 1.3];
const CHAN_MULTS = [4, 6, 8];
const SL_CAPS = [2.0, 3.0, 3.5, 5.0];
const TRAIL_ACTIVATIONS = [0, 5, 8, 12];  // 0 = disabled
const TRAIL_DISTANCES = [3, 5, 8];
const MAX_HOLDS = [48, 80, 120]; // hours

// Only test meaningful trail combos (skip distance when activation=0)
function generateCombos(): Combo[] {
  const combos: Combo[] = [];
  for (const z of Z_THRESHOLDS) {
    for (const cm of CHAN_MULTS) {
      for (const sl of SL_CAPS) {
        for (const ta of TRAIL_ACTIVATIONS) {
          const distances = ta === 0 ? [5] : TRAIL_DISTANCES; // Only one distance when trail disabled
          for (const td of distances) {
            for (const mh of MAX_HOLDS) {
              combos.push({ zThresh: z, chanMult: cm, slCap: sl, trailA: ta, trailD: td, maxHold: mh });
            }
          }
        }
      }
    }
  }
  return combos;
}

function runBacktest(combo: Combo): Result | null {
  try {
    // The backtest.ts uses hardcoded GARCH constants. We pass overrides via env vars.
    const env = {
      ...process.env,
      BT_GARCH_THRESHOLD: String(combo.zThresh),
      BT_CHAN_MULT: String(combo.chanMult),
      BT_SL_CAP: String(combo.slCap),
      BT_TRAIL_A: String(combo.trailA),
      BT_TRAIL_D: String(combo.trailD),
      BT_MAX_HOLD: String(combo.maxHold),
    };

    // Show a ticking dot every 5s so user knows it's working
    const dots = setInterval(() => process.stdout.write("."), 5000);
    const result = spawnSync("npx", [
      "tsx", "scripts/backtest.ts",
      "--train-start", "2025-12-19", "--train-end", "2026-02-15",
      "--test-start", "2026-02-15", "--test-end", "2026-03-17",
    ], { env, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
    clearInterval(dots);
    if (result.error || result.status !== 0) return null;
    const output = result.stdout.toString();

    // Parse TEST results
    const testMatch = output.match(/=== TEST.*?\n([\s\S]*?)(?:=== COMBINED|$)/);
    if (!testMatch) return null;

    const block = testMatch[1];
    const trades = parseInt(block.match(/Trades: (\d+)/)?.[1] || "0");
    const wr = parseFloat(block.match(/WR:([0-9.]+)%/)?.[1] || "0");
    const pnl = parseFloat(block.match(/P&L: \$([0-9.-]+)/)?.[1] || "0");
    const sharpe = parseFloat(block.match(/Sharpe: ([0-9.-]+)/)?.[1] || "0");
    const maxDd = parseFloat(block.match(/MaxDD: \$([0-9.]+)/)?.[1] || "0");
    const perDay = parseFloat(block.match(/\$\/day: \$([0-9.-]+)/)?.[1] || "0");
    const avgHold = parseFloat(block.match(/AvgHold: ([0-9.]+)h/)?.[1] || "0");

    if (trades < 20) return null; // Not enough trades to be meaningful

    return { ...combo, trades, winRate: wr, pnl, sharpe, maxDd, perDay, avgHold };
  } catch {
    return null;
  }
}

function main(): void {
  const combos = generateCombos();
  console.log(`GARCH Parameter Sweep: ${combos.length} combinations`);
  console.log(`Test period: 2026-02-15 to 2026-03-17 (30 days OOS)\n`);

  const results: Result[] = [];
  let done = 0;

  const startTime = Date.now();

  for (const combo of combos) {
    done++;
    const pct = ((done / combos.length) * 100).toFixed(0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const avgSec = done > 1 ? (Date.now() - startTime) / (done - 1) / 1000 : 0;
    const eta = avgSec > 0 ? ((combos.length - done) * avgSec / 60).toFixed(0) : "?";

    console.log(`[${pct}%] ${done}/${combos.length} | ${elapsed}s elapsed | ETA ${eta}min | z=${combo.zThresh} cm=${combo.chanMult} sl=${combo.slCap} ta=${combo.trailA} td=${combo.trailD} mh=${combo.maxHold}`);

    const r = runBacktest(combo);
    if (r) {
      results.push(r);
      console.log(`  -> ${r.trades} trades, Sharpe=${r.sharpe.toFixed(2)}, $${r.perDay.toFixed(2)}/day, WR=${r.winRate.toFixed(1)}%, MaxDD=$${r.maxDd.toFixed(0)}`);
    } else {
      console.log(`  -> skipped (no trades or error)`);
    }
  }

  console.log(`\n\n=== TOP 10 BY SHARPE (OOS) ===\n`);
  results.sort((a, b) => b.sharpe - a.sharpe);

  console.log("Rank  Sharpe  $/day   WR%   Trades  MaxDD   AvgHold  z    cm   sl   ta   td   mh");
  console.log("-".repeat(95));

  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    console.log(
      `${String(i + 1).padStart(4)}  ${r.sharpe.toFixed(2).padStart(6)}  ` +
      `${("$" + r.perDay.toFixed(2)).padStart(7)}  ${r.winRate.toFixed(1).padStart(5)}  ` +
      `${String(r.trades).padStart(6)}  ${("$" + r.maxDd.toFixed(0)).padStart(6)}  ` +
      `${r.avgHold.toFixed(0).padStart(7)}h  ` +
      `${r.zThresh.toFixed(1)}  ${String(r.chanMult).padStart(2)}   ${r.slCap.toFixed(1)}  ` +
      `${String(r.trailA).padStart(2)}   ${String(r.trailD).padStart(2)}  ${String(r.maxHold).padStart(3)}`
    );
  }

  console.log(`\n=== TOP 10 BY $/DAY ===\n`);
  results.sort((a, b) => b.perDay - a.perDay);

  console.log("Rank  $/day   Sharpe  WR%   Trades  MaxDD   AvgHold  z    cm   sl   ta   td   mh");
  console.log("-".repeat(95));

  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    console.log(
      `${String(i + 1).padStart(4)}  ${("$" + r.perDay.toFixed(2)).padStart(7)}  ` +
      `${r.sharpe.toFixed(2).padStart(6)}  ${r.winRate.toFixed(1).padStart(5)}  ` +
      `${String(r.trades).padStart(6)}  ${("$" + r.maxDd.toFixed(0)).padStart(6)}  ` +
      `${r.avgHold.toFixed(0).padStart(7)}h  ` +
      `${r.zThresh.toFixed(1)}  ${String(r.chanMult).padStart(2)}   ${r.slCap.toFixed(1)}  ` +
      `${String(r.trailA).padStart(2)}   ${String(r.trailD).padStart(2)}  ${String(r.maxHold).padStart(3)}`
    );
  }

  // Current live params for comparison
  console.log(`\n=== CURRENT LIVE PARAMS ===`);
  console.log(`z=0.7  cm=6  sl=3.5  ta=8  td=5  mh=80`);
  const current = results.find(r =>
    r.zThresh === 0.7 && r.chanMult === 6 && r.slCap === 3.5 &&
    r.trailA === 8 && r.trailD === 5 && r.maxHold === 80
  );
  if (current) {
    console.log(`Sharpe=${current.sharpe.toFixed(2)} $/day=$${current.perDay.toFixed(2)} WR=${current.winRate.toFixed(1)}% MaxDD=$${current.maxDd.toFixed(0)}`);
  }
}

main();
