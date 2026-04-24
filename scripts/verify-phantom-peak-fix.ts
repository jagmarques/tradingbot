// Reproduces the APE phantom-peak scenario from 2026-04-24 16:01:38 to verify
// the fix (skip bar if timestamp <= openedAtMs) prevents the spurious trail exit.
//
// Scenario: position opens at 16:01:38 at 0.16896. The in-progress 1m bar (16:01)
// has high=0.17521 (pre-entry spike) and close=0.16771 (post-entry drop).
// OLD behavior: peak = (0.17521/0.16896 - 1) * 5 * 100 = 18.5% → trail fires
// NEW behavior: bar skipped (timestamp 16:01:00 < 16:01:38), falls back to mid
// price (0.16896) → peak = 0 → no phantom trail

const entryTime = new Date("2026-04-24T16:01:38Z").getTime();
const barTimestamp = new Date("2026-04-24T16:01:00Z").getTime(); // 1m bar open
const entryPrice = 0.16896;
const leverage = 5;

const bar = { timestamp: barTimestamp, high: 0.17521, low: 0.16771, close: 0.16886 };
const midPrice = 0.16886;

// Config values from live code
const BE_PCT = 5, BE2_PCT = 10, TRAIL_ACT = 15, TRAIL_DIST = 5;

function simulate(useFix: boolean): { peak: number; be: boolean; be2: boolean; trailFired: boolean } {
  const openedAtMs = entryTime;
  let barPostEntry: boolean;
  if (useFix) {
    barPostEntry = bar.timestamp > openedAtMs;
  } else {
    barPostEntry = true; // old bug: always used bar regardless of timing
  }
  const h = barPostEntry ? bar.high : midPrice;
  const l = barPostEntry ? bar.low : midPrice;
  const c = barPostEntry ? bar.close : midPrice;

  const peak = ((h - entryPrice) / entryPrice) * leverage * 100;
  const current = ((c - entryPrice) / entryPrice) * leverage * 100;

  const be = peak >= BE_PCT;
  const be2 = peak >= BE2_PCT;
  const trailFired = peak >= TRAIL_ACT && current <= peak - TRAIL_DIST;

  console.log(`  bar used: ${barPostEntry} (timestamp=${new Date(bar.timestamp).toISOString()}, openedAt=${new Date(openedAtMs).toISOString()})`);
  console.log(`  h/l/c: ${h.toFixed(5)}/${l.toFixed(5)}/${c.toFixed(5)}`);
  console.log(`  peak: +${peak.toFixed(1)}% lev  current: ${current.toFixed(1)}% lev`);
  console.log(`  BE fired: ${be}   BE2 fired: ${be2}   Trail fired: ${trailFired}`);
  return { peak, be, be2, trailFired };
}

console.log("=== OLD behavior (buggy) ===");
const oldRes = simulate(false);

console.log("\n=== NEW behavior (fixed) ===");
const newRes = simulate(true);

console.log("\n=== Verdict ===");
const pass = !newRes.trailFired && oldRes.trailFired;
console.log(pass ? "PASS: phantom trail suppressed after fix" : "FAIL");
process.exit(pass ? 0 : 1);
