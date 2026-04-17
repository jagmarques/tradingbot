# Company Status — Push GARCH to $5/day MDD<$20

## Goal
Find GARCH z-score backtest config achieving >$5/day AND MaxDD <$20.

## VERDICT: IMPOSSIBLE — 2 cycles, 644 configs tested

The $5/day + MDD<$20 target is structurally unachievable with the GARCH z-score strategy. The Calmar ratio ($/day per $1 MDD) caps at 0.177 across all configs. At MDD $20, maximum achievable is $3.54/day.

## Best Config Found (MDD < $20)

**top5+alt5C $16mrg mc3 tr80/8 SL3%+zrev (parallel engine)**

| Metric | Value |
|--------|-------|
| $/day | +$3.31 |
| MaxDD | $19 |
| Profit Factor | 3.94 |
| Win Rate | 52.9% |
| Avg Win | +$4.33 |
| Avg Loss | -$1.23 |
| Max Single Loss | -$4.96 |
| Trades | 575 (297 days) |

Engine 1: ETH, SOL, DOGE, XRP, LINK ($16 margin, mc3)
Engine 2: SUI, ENA, HYPE, FET, WIF ($16 margin, mc3)
Both: z1h>3.0, z4h>2.0, SL 3% exchange, z-reversal exit, trail 80/8

## If MDD Constraint Relaxed

| Config | $/day | MDD | PF |
|--------|-------|-----|-----|
| top5+alt5C $22mrg mc3 | $4.55 | $26 | 3.94 |
| top5+alt5B $30mrg mc3 | $5.55 | $35 | 2.84 |
| top5+alt5C $30mrg mc3 | $6.20 | $36 | 3.94 |
| QUAD all4sets $22mrg mc2 | $6.94 | $51 | 2.78 |
| allPairs $30mrg mc15 (125 pairs) | $8.14 | $55 | 1.98 |

## Key Findings

1. **Calmar ceiling at 0.177** — consistent across all pair universes, margin levels, trails. No config breaks this.

2. **Parallel engines work** — running two non-overlapping 5-pair sets gives additive profit with sub-additive MDD due to decorrelation.

3. **alt5C is the best complement to top5** — SUI, ENA, HYPE, FET, WIF have PF 3.94 combined vs 2.84 for alt5B and 2.58 for alt5A.

4. **Loose trails dominate** — tr80/8 > tr50/5 > tr30/3 > tr9/0.5. Z-score momentum produces occasional 50-100% leveraged winners; tight trails cut them.

5. **More pairs hurt after ~20** — 125 pairs dropped PF from 3.00 to 1.98 vs 22 pairs. Microcaps have weaker z-score signals.

6. **Multi-stage trails don't help** — early activation at +10% locks small gains z-reversal already captures.

## Exhaustive Search Space

- Margins: $5, $7, $8, $9, $10, $12, $14, $15, $16, $17, $18, $19, $20, $22, $25, $30, $35, $40, $45, $50, $55, $60
- Pair universes: top5, top8, top10, top12, top15, alt5A/B/C, allPairs (22 and 125)
- Trails: 9/0.5 through 120/12, multi-stage (8 variants), no-trail
- Z-thresholds: z1.5/1 through z3/2
- MaxConcurrent: 1 to 25
- Risk wrappers: cooldowns 4-48h, daily stops $3-$15, loss streak stops 3-8
- Direction: both, long-only
- Exits: z-reversal, conditional z-reversal (losing only), BTC regime, time-based
- Parallel engines: 2-engine (6 combos), triple, quad, asymmetric margin
- SL widths: 1.5%, 2%, 3%, 4%, 5%, 7%

## Scripts
- `scripts/bt-push-profit.ts` — 1100-line parallel-engine backtest
- `scripts/bt-exchange-sl-research.ts` — 1300-line exchange SL research (earlier work)

## Recommendation

Deploy the **top5+alt5C $16mrg mc3 tr80/8 SL3%+zrev** config for $3.31/day at MDD $19.
Or accept MDD $26 and use $22 margin for $4.55/day.
$5/day requires MDD $35+ — no way around it with z-score momentum.
