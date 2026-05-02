# ZEC Trail-Close Re-Entry Investigation - STATUS (2026-05-02)

## Verdict: **NOT A BUG. Immaterial impact either way.**

## Live event recap
- 2026-05-01: bot OPEN LONG ZEC @ 362.67, peak +19.91%, trail-close @ 367.89 (+$0.39)
- 5 minutes later: bot OPEN LONG ZEC @ 376.44, peak +22.5%, trail-close @ 383.64 (+$0.55)
- Net: +$0.94 across 2 trades on same pair same direction.

## Why it happened (mechanical trace)

The engine has 6 entry gates in `runGarchV2Cycle` (`garch-v2-engine.ts:60-81`):
1. open-pairs dedup (currently-open only)
2. ensemble max-concurrent (7)
3. blocked UTC hours 22-23
4. H1 entry window (first 5 min)
5. z-score (z1h>=3, z4h>=1.5)
6. SL cooldown (4h, **SL hits only**)

After ZEC trail-closed:
- gate 1: ZEC no longer in `openPairs` -> pass
- gate 6: `isInStopLossCooldown` returns false because trail close path skips `recordStopLossCooldown` (`position-monitor.ts:272-275` and `408-413`) -> pass
- z-score remained >3.0 next cycle -> pass
- engine opened a fresh ZEC long

## This is INTENTIONAL

Two git commits prove deliberate design:

| Commit | Date | Message |
|--------|------|---------|
| `9ba08b3` | earlier | Add stop-loss cooldown to prevent re-entry loops |
| `9e14a4f` | 2026-04-24 | **Match backtest no cooldown on trail exits** |

Commit `9e14a4f` explicitly DELETED `recordStopLossCooldown(...)` from both trail-stop call sites because the backtest does not apply cooldown to trail exits — and the deployed validation ($0.59/day, Calmar 0.029, MDD $20, 297d OOS) was produced WITH this behavior.

## Backtest evidence (full top-15, 297-day OOS, with corrected SL+spreads)

| Metric | Value |
|--------|-------|
| Total trades | 200 (trail 152 / sl 48 / maxh 0) |
| Total $/day | $0.55 ($1.10 at $20 margin) |
| Re-entry events | **5** (trail-close → same pair+dir open within 60min) |
| Re-entry win rate | 40% (2/5 winners) |
| Re-entry avg P&L | -$0.250/trade |
| Worse-fill rate | 80% (4/5 had worse entry than prior close) |
| Counterfactual hold | -$5.05 (vs actual +$11.80 combined) |
| Counterfactual beats actual | 20% of events (1/5) |
| 1h cooldown $/day delta | **+$0.004/day = $1.46/year** |

Re-entries are slightly -EV, but the absolute impact is negligible: 5 events × -$0.25 ≈ -$1.50/year. Adding cooldown would save ~$1.46/year — rounding error vs strategy total ($402/year at $20 margin).

Note: re-entry events cluster on event days. 3 of 5 happened on 2025-12-01 (market squeeze), 1 on 2026-01-19, 1 on 2026-03-15.

## Trail tightness sweep (full top-15)

| Variant | $/day | MDD | Calmar | WR% |
|---------|------:|----:|-------:|----:|
| **T15/4 (deployed)** | **0.56** | **15.5** | **0.0358** | 76% |
| T15/3 | 0.54 | 15.5 | 0.0349 | 76% |
| T20/5 | 0.60 | 21.5 | 0.0278 | 69% |
| T25/8 | 0.59 | 29.1 | 0.0202 | 62% |
| T30/10 | 0.65 | 30.4 | 0.0215 | 58% |
| No trail + z-rev | 0.47 | 241.9 | 0.0020 | 38% |

**T15/4 wins Calmar.** Walk-forward 4/4 quarters profitable. Pure z-rev catastrophic (MDD $242). Trail IS the MDD control.

## Pair count sweep (full top-50, 297-day OOS, $20 margin)

| #pairs | $/day | MDD | PF | Calmar |
|-------:|------:|----:|---:|-------:|
| 10 | 0.94 | 27.1 | 3.49 | **0.035** |
| **15 (deployed)** | **1.11** | **31.5** | **2.83** | **0.035** ✓ |
| 20 | 1.04 | 35.0 | 2.38 | 0.030 |
| 25 | 1.09 | 37.5 | 2.27 | 0.029 |
| 35 | 1.19 | 40.0 | 2.07 | 0.030 |
| 50 | 1.22 | 42.6 | 1.89 | 0.029 |

Top-50 makes 10% more $/day but MDD 35% worse → Calmar drops 17%. **KEEP TOP-15.**

## Honest limits — what the backtest doesn't model

| Issue | Direction | Magnitude |
|-------|-----------|----------:|
| Funding cost on shorts | Backtest TOO OPTIMISTIC | -$0.20/day adverse (~$73/year) |
| Maker rebate (live tries maker first) | Backtest TOO PESSIMISTIC | +$0.05/day favorable |
| API/exchange downtime | Backtest TOO OPTIMISTIC | -1-2% rare events |
| Real fill on micro-caps | Now bumped to 15bp (was 12bp) | -$0.02/day fixed |
| Survivorship bias | Slightly optimistic | <1% |

**Realistic forward expectation: ~$0.85-0.90/day at $20 margin** ($25-30/month). Funding cost on shorts is the biggest unmodeled drag, 48× larger than the re-entry "issue".

## What the user should do

**Nothing.** The behavior is intentional, the absolute impact ($1.46/year) is rounding error, and the validated $/day already accounts for re-entries. If looking for $/day improvements, focus on funding cost on shorts, not re-entry cooldown.

## Files produced
- `.company/messages/cto-trail-trace.md` (code trace, file:line cited)
- `.company/messages/backtester-reentry.md` (200 trades, 5 re-entry events)
- `.company/messages/risk-trail-tightness.md` (8-variant trail sweep + walk-forward)
- `scripts/bt-reentry-analysis.ts` (engine + re-entry counter, fixed SL constants)
- `scripts/bt-trail-tightness.ts` (8-variant trail sweep, fixed spreads)
- `scripts/bt-pair-count-c2.ts` (10-50 pair sweep on C2 config, fixed SL+spreads)
