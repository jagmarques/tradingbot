# Quant Backtester - Re-entry Analysis

## Configuration
SOURCE: scripts/bt-reentry-analysis.ts
- Pairs: top-15 (loaded 15/15)
- Period: 2025-06-01 to 2026-03-25, 297 days
- Config: z1h=3/3 symmetric, z4h=1.5/1.5, SL 3.5%/3.0% (high/low lev), trail T15/4 single-stage, no-BE, max hold 120h, block hours 22-23 UTC, 4h SL-only cooldown.
- Total trades simulated: 200  (trail 152 | sl 48 | maxh 0)

## Re-entry Events
FINDING: 5 re-entry events found (trail-close → same-pair same-dir open within 60min)
SOURCE: /tmp/reentry-analysis.csv  **WARNING**: small sample (N<30), low confidence.

## Re-entry P&L
FINDING: $-1.25 total, $-0.250 avg/trade, 40.0% WR
- Exit reasons (re-entry trades): trail=2 sl=3 maxh=0
- Comparison: re-entry avg=$-0.250 vs all other trades avg=$0.852 (n_other=195)
- Worse-entry rate: 80.0% (4/5) — share of re-entries with WORSE fill than the previous trail-close price
SOURCE: aggregate over csv rows

## Counterfactual (hold instead of re-enter)
FINDING: counterfactual-hold sum = $-5.05; actual (close+reopen) sum = $11.80; delta = $-16.85 (CF − actual)
- Counterfactual beats close+reopen in 20.0% of events (1/5)
- Per-event mean delta: $-3.371
SOURCE: per-event simulation in counterfactualHold()

## Aggregate impact
FINDING: rule "no re-entry within 60min after trail-close on same pair+dir" → P&L delta = $0.004/day (+EV: removes losing trades)

## Verdict
Re-entry pattern is NET NEGATIVE (avg $-0.250/trade, total $-1.25). Adding 1h cooldown would SAVE $0.004/day — likely +EV.
