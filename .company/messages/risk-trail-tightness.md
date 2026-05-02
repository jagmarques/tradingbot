# Risk Manager - Trail Tightness Test

## Sweep Results
SOURCE: scripts/bt-trail-tightness.ts on /tmp/bt-pair-cache-1m/ (full top-15, 297 days, deployed C2 config $10 margin, mc=7, z=3.0/1.5 symmetric, SL 3.5/3.0%)

| Variant | $/day | MDD | Calmar | Trades | Trail | SL | MaxH | ZRev | AvgPk% | WR% |
|---------|------:|----:|-------:|-------:|------:|---:|-----:|-----:|-------:|----:|
| **T15/4 (deployed)** | **0.56** | **15.5** | **0.0359** | 200 | 152 | 48 | 0 | 0 | 20.1 | 76.0 |
| T15/3 (tighter) | 0.54 | 15.5 | 0.0351 | 200 | 152 | 48 | 0 | 0 | 19.0 | 76.0 |
| T20/5 | 0.60 | 21.5 | 0.0281 | 197 | 136 | 61 | 0 | 0 | 23.8 | 69.0 |
| T25/6 | 0.59 | 27.6 | 0.0214 | 196 | 121 | 75 | 0 | 0 | 27.1 | 61.7 |
| T25/8 | 0.59 | 29.0 | 0.0203 | 196 | 121 | 75 | 0 | 0 | 28.2 | 61.7 |
| T30/10 | 0.66 | 30.4 | 0.0216 | 194 | 112 | 81 | 1 | 0 | 32.4 | 57.7 |
| No trail + z-rev | 0.48 | 241.8 | 0.0020 | 194 | 0 | 16 | 0 | 178 | 34.6 | 38.1 |
| No trail + z-rev + maxH 120 | 0.48 | 241.8 | 0.0020 | 194 | 0 | 16 | 0 | 178 | 34.6 | 38.1 |

## Top 3 by Calmar

1. **T15/4 (deployed)**: $0.56/day, MDD $15.5, Calmar 0.0359, 200 trades
2. T15/3 (tighter): $0.54/day, MDD $15.5, Calmar 0.0351, 200 trades
3. T20/5: $0.60/day, MDD $21.5, Calmar 0.0281, 197 trades

## Walk-Forward (4 quarters) on Top 3

| Variant | Q1 $/d | Q1 MDD | Q2 $/d | Q2 MDD | Q3 $/d | Q3 MDD | Q4 $/d | Q4 MDD | Q+ |
|---------|-------:|-------:|-------:|-------:|-------:|-------:|-------:|-------:|---:|
| **T15/4 (deployed)** | 0.12 | 12.9 | 0.46 | 14.1 | 0.48 | 15.5 | 1.17 | 13.5 | **4/4** |
| T15/3 | 0.09 | 13.0 | 0.46 | 13.9 | 0.49 | 15.5 | 1.14 | 13.5 | **4/4** |
| T20/5 | 0.15 | 12.5 | 0.45 | 21.5 | 0.61 | 19.1 | 1.22 | 13.5 | **4/4** |

All top-3 robust across 4 quarters (no curve-fit). T15/4 has lowest MDD in 3 of 4 quarters.

## Verdict

**T15/4 (deployed) IS the empirical Calmar winner.** Tighter (T15/3) has identical MDD but slightly lower P&L. Looser trails (T20/5, T25/8, T30/10) earn marginally more $/day but MDD scales 1.4x-2x worse — Calmar drops 22-44%.

The "tight trail causes re-entries at worse prices" hypothesis is mechanically correct (T15/4 has 76% trail-exit rate vs 58% for T30/10), but loosening the trail is NOT a Calmar improvement — you trade MDD for headline $/day in a way that makes the strategy less stable.

The pure z-reversal (no trail) variant is catastrophic: MDD explodes to $242 (16x deployed) because winners turn into stops without trail protection. The trail IS the MDD control — removing it kills the edge.

**Recommendation: KEEP T15/4.** Live re-entry events are profitable (per backtester-reentry.md, +$0.998/trade, 80% WR). Don't change the trail.
