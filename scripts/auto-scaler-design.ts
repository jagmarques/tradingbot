/**
 * GARCH Auto-Scaler Design
 * ========================
 *
 * Goal: compound faster as equity grows, protect capital as equity shrinks.
 *
 * Approach chosen: Option A — inline dynamic sizing inside runGarchV2Cycle().
 *
 * Why Option A over B/C:
 * - No new module, no shared mutable state, no env-var writes.
 * - Balance is already fetched on every scheduler cycle (15 min) via getLiveBalance().
 * - One call site, one place to audit. Minimizes blast radius.
 * - In paper mode falls back to QUANT_VIRTUAL_BALANCE so backtests are unaffected.
 *
 * Formula:
 *   targetSize = floor(equity * SCALE_FACTOR)   // 10% of equity, rounded down to $1
 *   clamp(targetSize, MIN_SIZE, MAX_SIZE)
 *
 * Constants:
 *   SCALE_FACTOR = 0.10   (10% of equity)
 *   MIN_SIZE     = $3
 *   MAX_SIZE     = $20
 *
 * Examples:
 *   $60  equity  ->  $6  margin
 *   $90  equity  ->  $9  margin  (current hard-coded value)
 *   $120 equity  -> $12  margin
 *   $150 equity  -> $15  margin
 *   $200 equity  -> $20  margin  (cap)
 *   $250 equity  -> $20  margin  (cap, no further growth)
 *
 * Guardrails:
 * - Minimum $3 prevents zero-sizing on extreme drawdown.
 * - Maximum $20 caps risk even if equity balloons (e.g. a very large deposit).
 * - In paper mode getLiveBalance returns 0 -> falls back to QUANT_VIRTUAL_BALANCE env var.
 * - Balance fetch failure returns 0 -> falls back to last known size or static default.
 *
 * ============================================================
 * IMPLEMENTATION — changes to garch-v2-engine.ts
 * ============================================================
 *
 * The diff below is the minimal change required.  Everything else in the engine
 * (z-score logic, EMA filters, SL/TP, cooldowns) is untouched.
 */

// ── helpers (add to garch-v2-engine.ts) ─────────────────────────────────────

import { getLiveBalance } from "../src/services/hyperliquid/live-executor.js";
import { isPaperMode } from "../src/config/env.js";
import { loadEnv } from "../src/config/env.js";

const GARCH_SCALE_FACTOR = 0.10;
const GARCH_MIN_SIZE_USD = 3;
const GARCH_MAX_SIZE_USD = 20;

/**
 * Compute GARCH position size for the current cycle.
 *
 * - Live mode:  10% of spot USDC equity, clamped [$3, $20].
 * - Paper mode: 10% of QUANT_VIRTUAL_BALANCE env var, same clamp.
 * - On any fetch error: returns GARCH_MIN_SIZE_USD as a safe fallback.
 */
async function computeGarchSize(): Promise<number> {
  try {
    let equity: number;

    if (isPaperMode()) {
      // Paper: use virtual balance from env (e.g. 100 -> $10 target)
      equity = loadEnv().QUANT_VIRTUAL_BALANCE;
    } else {
      equity = await getLiveBalance();
    }

    if (equity <= 0) {
      console.log("[GarchV2] Could not determine equity, using min size");
      return GARCH_MIN_SIZE_USD;
    }

    const raw = equity * GARCH_SCALE_FACTOR;
    const size = Math.max(GARCH_MIN_SIZE_USD, Math.min(GARCH_MAX_SIZE_USD, Math.floor(raw)));
    console.log(`[GarchV2] Auto-size: equity=$${equity.toFixed(2)} -> $${size} margin`);
    return size;
  } catch {
    console.log("[GarchV2] Auto-size fetch failed, using min size");
    return GARCH_MIN_SIZE_USD;
  }
}

// ── modified runGarchV2Cycle (top of function body) ──────────────────────────
//
// BEFORE (line 8 of garch-v2-engine.ts):
//   const GARCH_POSITION_SIZE_USD = 9; // Optimized for $90 equity, MaxDD $59
//
// AFTER:
//   (remove the const; compute dynamically at start of each cycle)
//
// Inside runGarchV2Cycle(), at the very start (after BTC candles fetch):
//
//   const garchSizeUsd = await computeGarchSize();
//
// Then on the openPosition call (line 136-138):
//
//   const pos = await openPosition(
//     pair, direction,
//     garchSizeUsd * getEventSizeMultiplier() * getRegimeSizeMultiplier(),
//     ENSEMBLE_LEVERAGE, stopLoss, takeProfit,
//     "trending", TRADE_TYPE, indicators, entryPrice,
//   );
//
// That is the entire change.  No other file needs to be touched.

// ── FULL updated runGarchV2Cycle for copy-paste reference ────────────────────
//
// (Only the changed lines are marked with //  <-- CHANGED)

/*
export async function runGarchV2Cycle(): Promise<void> {
  const btcCandles = await fetchCandles("BTC", "1h", 80);
  if (btcCandles.length < 30) {
    console.log("[GarchV2] Insufficient BTC candles, skipping");
    return;
  }

  const garchSizeUsd = await computeGarchSize();                    // <-- CHANGED

  const btcCompleted = btcCandles.slice(0, -1);
  const btcBullish = isBtcBullish(btcCompleted, BTC_EMA_FAST, BTC_EMA_SLOW);

  // ... (rest of the function is unchanged until openPosition call)

      const pos = await openPosition(
        pair, direction,
        garchSizeUsd * getEventSizeMultiplier() * getRegimeSizeMultiplier(), // <-- CHANGED
        ENSEMBLE_LEVERAGE,
        stopLoss, takeProfit, "trending", TRADE_TYPE, indicators, entryPrice,
      );
*/

// ── NOTES ────────────────────────────────────────────────────────────────────
//
// 1. getLiveBalance already handles unified account (perps equity <= marginUsed
//    -> falls back to spot USDC). No change needed there.
//
// 2. computeGarchSize is called once per cycle, not once per pair, so the
//    extra API call is made at most every 15 minutes.
//
// 3. getEventSizeMultiplier() and getRegimeSizeMultiplier() already apply on
//    top of this, so event/regime dampening still works correctly.
//
// 4. QUANT_VIRTUAL_BALANCE default is 100 (from env.ts), so paper mode would
//    start at $10 target size, same as live with $100 equity.
//
// 5. To change the scale factor or caps, edit the three constants at the top
//    of this module (GARCH_SCALE_FACTOR, GARCH_MIN_SIZE_USD, GARCH_MAX_SIZE_USD).
//    They are not in constants.ts intentionally — they are engine-specific, not
//    shared configuration.
