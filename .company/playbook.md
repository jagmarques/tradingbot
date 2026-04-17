## Session 2026-04-05

WORKED: GARCH z-score momentum at $9/max 7/strict z-scores/40/3 trail = $2.38/day, MaxDD $59, Sharpe 4.29. Best achievable on $90 equity.

FAILED: HFT/scalping on 1m data — fees kill everything. Spread capture loses $11/day. MR scalp loses $0.26/day. Even with maker orders, edge is $0.22-0.73/day max (15x short of $10 target).

FAILED: Maker rebate farming — rebate (-0.01%) only applies at >$1M/day volume. At $90 capital, you PAY +0.015% maker fee.

FAILED: $10/day target on $90 equity — mathematically impossible. Requires Sharpe 50+ (best ever: 4.29).

USE INSTEAD: Compound the GARCH strategy. $90 -> $140 (1 month) -> $220 (2 months) -> $500 (6 months) -> $10/day achievable.

INEFFICIENT: Running 50+ agents to prove impossibility. Next time, run the math check FIRST before backtesting.

TOP: Chief Strategist (definitive math), Backtester (clean 4-strategy comparison)
FIRE: none — all contributed meaningfully

## Session 2026-04-06

WORKED: Full codebase cleanup in 1 cycle. Deleted 5 dead folders, 14 dead files, 2 OneDrive conflicts. Fixed imports in 6 files. tsc --noEmit clean.

WORKED: risk/manager.ts correctly identified as still-active (5 importers) despite cleanup plan marking it dead. Always verify imports before deleting.

WORKED: DT/ST/CM Telegram labels correctly kept for legacy DB positions (60d stagnation window) and permanent historical stats.

FAILED: Cleanup plan incorrectly marked risk/manager.ts as dead. Always grep for importers before trusting a deletion list.

INEFFICIENT: Nothing — single cycle, parallel workers, clean result.

TOP: CTO (clean execution), Internal Reviewer (thorough 7-point verification)
HIRE: none needed
FIRE: none

## Session 2026-04-07

WORKED: Adding 74 new pairs to GARCH v2 portfolio. Combined 127 pairs: $14.53/day (was $4.97), PF 2.52, MaxDD $124. 2.9x improvement from pairs alone.

WORKED: Look-ahead bias audit caught two critical bugs in BB Squeeze and Vol Spike engines. BB Squeeze went from PF 7.16 ($48/day) to PF ~2.0 ($2.64/day) after fix. Always check: does the signal use current bar's close/volume/range? If yes and entry is at same bar's open, that's look-ahead.

WORKED: Correlation analysis showed all 4 candidate engines have 75%+ entry overlap with GARCH. Testing signal independence before combining engines is mandatory.

FAILED: 15m z-score entry as additive to 1h. Catches same moves slightly earlier, combined mode always worse. Different timeframes on same indicator are not independent signals.

FAILED: All second engine candidates (RSI MR, BB Squeeze, Vol Spike, Stochastic). After fixing bias, none worth deploying — either too weak or too correlated.

FAILED: Downloading candle data from HL API — only serves 5000 candles (17 days of 5m). Must use Binance for historical data. HL API only useful for very recent data.

INEFFICIENT: Downloading 120+ pairs from Binance serially at 30s each = 60+ min. Next time consider parallel downloads (batches of 5-10) or pre-caching in a separate session.

INEFFICIENT: Track 3 GARCH baseline recomputed z-scores inside signal function (millions of calls). Pre-compute indicators ONCE, store in data struct, reference by index.

TOP: Quant Backtester (found 74 new profitable pairs), Truth Teller (caught look-ahead bias)
HIRE: none
FIRE: none

## Session 2026-04-10

WORKED: Comprehensive exchange-SL research — 113 configs across 6 categories (exch_sl_trail, exch_sl_tp, partial, time, atr, zrev). Baseline (1h SL + trail 9/0.5) delivers +$22.06/day $17 MDD PF 4.36 in new $10-margin 102-pair sim. Every tick-level exchange SL variant underperforms: best alternative is ExchSL 10% + z-reversal + trail 9/0.5 at $5.21/day (76% less than baseline).

WORKED: Z-reversal exit (close when 1h z-score crosses back through 0) dramatically reduces MaxDD — $178 for zrev vs $1000+ for all other exchange-SL variants — because it forces exits when momentum dies instead of bleeding via trail.

FAILED: Immediate exchange SL at ANY width (2-15%) at tick resolution. All combos with trail/TP/partial/time/ATR lose money or barely break even. The z-score signal's profit lives in 1h-boundary resolution; intra-bar wicks shake out winners prematurely.

FAILED: Previous session told user backtest max loss was -$0.03. Actual backtest max single loss is -$2.76 across 29,461 baseline trades. User's live -$1.10 gap losses are WITHIN normal backtest bounds, not a bug. Always verify "this is bad" against backtest distribution before trying to fix.

INEFFICIENT: The load() function falls back to `${n}USDT` if `${RM[n]}USDT` is empty — but BTC/ETH/etc. aren't in the cache at all. BTC regime category (4 configs) was silently skipped. Next time explicitly assert critical pairs exist before running.

INEFFICIENT: `pairs.find(p => p.name === pos.pair)!` inside exit loop per 5m timestep per open position. At 30k trades and 127 pairs this is O(n) per lookup in hot path. Use Map<pair, PD> for O(1).

TOP: Quant Backtester (writes 627-line comprehensive script in one pass), Truth Teller (caught that user was misinformed about backtest baseline stats)
HIRE: none
FIRE: none

## Session 2026-04-12

WORKED: Parallel engine approach — running two non-overlapping 5-pair sets simultaneously. top5+alt5C at $16mrg mc3 = $3.31/day, MDD $19, PF 3.94. Best Calmar ratio 0.177. This is the absolute best config found across 644 configs tested.

WORKED: Downloading 104 missing pairs from Binance in parallel batches of 5. Total cache now 125 pairs. Parallel downloads (5 concurrent) take ~3 min vs 30+ min serial.

WORKED: Loose trails (tr80/8, tr100/10, tr120/12) dominate tight trails (tr9/0.5). The z-score signal produces occasional 50-100% leveraged winners; tight trails cut them at +9%.

WORKED: alt5C (SUI, ENA, HYPE, FET, WIF) is the best complementary pair set to top5. PF 3.94 combined vs 2.84 for alt5B and 2.58 for alt5A. These newer high-vol alts have cleaner z-score signals.

FAILED: $5/day + MDD<$20 target — structurally impossible with GARCH z-score. Calmar ratio caps at 0.177 across all configs. At MDD $20, max achievable is $3.54/day. No lever breaks this ceiling.

FAILED: Adding more pairs (125 vs 22) — microcap/small pairs have weaker z-score signals. allPairs mc20 PF dropped from 3.00 (22 pairs) to 1.98 (125 pairs). Only the top ~20 majors produce reliable z-score momentum.

FAILED: Multi-stage trails ([10/1, 30/3, 60/6, 100/10]) underperform single-stage tr80/8. Early trail activation at +10% locks in small gains that z-reversal would have captured anyway.

FAILED: Conditional z-reversal (only when losing) — makes MDD worse because losing positions held longer waiting for z-reversal.

FAILED: Very wide SL (5-10%) on high margin — max single loss exceeds $20 which guarantees MDD>$20 after any loss.

FAILED: No-trail pure-z-reversal — slightly worse PF than trail because z-reversal sometimes fires too early on brief mean-reversion within a trend.

USE INSTEAD: To reach $5/day, accept MDD $26 (top5+alt5C $22mrg mc3 = $4.55/day, PF 3.94) or $35 (top5+alt5B $30mrg mc3 = $5.55/day, PF 2.84).

INEFFICIENT: The script tested 644 configs but many are linearly redundant (margin $5,$7,$8,$9,$10,$12...). Next time test fewer margins with wider spacing.

TOP: Quant Backtester (comprehensive 1100-line script with parallel engine simulation), Chief Strategist (identified Calmar ceiling)
HIRE: none
FIRE: none
