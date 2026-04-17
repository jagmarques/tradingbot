# Impossibility Report: $5/day with MaxDD < $20 on $60 account

## TL;DR
**The target is mathematically impossible.** No trading strategy in history has ever achieved anywhere close to this risk/return profile. Requesting it is not a research question — it's asking for the impossible.

## The math that proves it

### Daily return required
$5/day on $60 = **8.33% per day**

### Compounded annualized
$60 × 1.0833^365 = **$60 × 10^12 ≈ $600 BILLION** in one year from a $60 starting account.

### Linear annualized
$5/day × 365 = $1,825/year = **3,042% annual return on $60**

### Benchmark comparison
| Fund | Annual return (best year) |
|---|---|
| S&P 500 (historical avg) | ~10% |
| Typical hedge fund | 10-15% |
| Top hedge funds | 20-30% |
| Renaissance Medallion (best ever) | ~40% after fees |
| **Your target** | **3,042%** |

Your target is **76x better than Medallion** — a fund run by 150 PhDs using proprietary signals, co-location, and decades of R&D.

### Sharpe ratio required
$/day ÷ MDD = $5 / $20 = **0.25 (25% of DD per day)**

For any strategy to sustain 25% of max DD per day, the signal would need a Sharpe ratio approaching infinity. Best hedge funds run Sharpe 2-4. Medallion runs ~7. You're asking for Sharpe >50.

## What this search tested

| Category | Configs tested | Best result |
|---|---|---|
| GARCH z-score (all tunings) | 50+ | +$1.07/day, MDD $47 |
| GARCH asymmetric thresholds | 9 | +$1.03/day, MDD $38 |
| GARCH + BE / multi-trail / maxHold | 35+ | +$1.26/day, MDD $78 |
| Margin scaling ($10→$50) | 20+ | +$2.72/day, MDD $130 (too risky) |
| Z-formula params (momLB, volWin) | 11 | no improvement |
| Donchian breakout | 3 | -$6.93/day (broken or unsuited) |
| RSI mean reversion | 3 | +$0.50/day, MDD $55 |
| RSI+Z confluence | 2 | +$0.55/day, MDD $46 |
| BB breakout | 1 | -$7.32/day |
| Portfolio of 3 configs | 10+ | +$1.26/day, MDD $42 |
| Pair selection | Multiple | Overfits (OOS degrades 50-75%) |
| Hour filtering | Multiple | Overfits |
| Exchange SL + trails | 113 | Verified fix works, bounded max loss |

**Grand total: 300+ configurations tested across 10+ categories.**

**None approach $5/day.** The highest profitable single config is **$2.72/day but requires MDD $130** — 2x your account size. Scaling margin up scales DD proportionally. There is no free lunch.

## Why the ceiling exists

1. **The signal's edge is finite.** The GARCH z-score momentum signal has PF ~1.46 on best config. That means for every $100 of losses, you make $146. With $10 margin and 10x leverage ($100 notional), each trade risks ~$0.30 to make ~$0.44. At 5 trades/day, max edge is ~$0.70/day on $10 margin.

2. **Scaling hits DD wall.** To get 5x profit, you need 5x margin. But MDD scales with margin. On $60 account you can safely use max ~$15-20 margin before DD exceeds 33% of account. This caps you at ~$1-1.50/day no matter what.

3. **Alternative signals don't help.** RSI, BB, Donchian all have equal or worse edges in this OOS period. No single signal beats GARCH meaningfully.

4. **Portfolio diversification is limited.** Combining 3 configs gave +$0.88/day @ MDD $29. Adding more configs adds DD faster than profit (they're not truly uncorrelated — they trade the same pair universe).

5. **Selection/filtering overfits.** Walk-forward testing shows top-30 IS pairs only return 44% of their IS profit on OOS. Any clever "selection" bleeds in live.

## What IS achievable (honest numbers)

For a $60 account with MDD < $20:

| Config | $/day | MDD | Annual est. |
|---|---|---|---|
| Config A (long4/short6 z4=3) m$10 + BE@7% | **$0.35** | $10 | **$128** |
| Config A m$15 + BE@7% | **$0.52** | $16 | **$190** |
| Portfolio A+B+D m$5 each + BE@7% | **$0.63** | $21 | **$230** |
| Portfolio A+B+D m$7 each + BE@7% | **$0.88** | $29 | $321 |

Realistic ceiling on $60 account with strict DD control: **~$0.50-0.90/day**.

That's **5-10x less than your target.** The gap cannot be closed by tuning this signal.

## To actually reach $5/day, you need ONE of:

### Option 1: More capital
To compress $5/day into a safe DD, you need a much bigger account. At the same risk-adjusted ratio:
- **$600 account + single config** = ~$3.50/day @ MDD ~$100 (still doesn't hit $5)
- **$1000 account + portfolio** = ~$5/day @ MDD ~$100
- **Target: grow to ~$1000 first**, then deploy full strategy

### Option 2: Fundamentally different signal
Not GARCH tuning. Something like:
- **True HFT** (sub-second market making, need low-latency infrastructure) — we proved in session 2026-04-05 this is blocked by fee structure
- **News-based alpha** (fast LLM reaction to Trump/Fed/news) — we already tested and killed this as unprofitable
- **Cross-exchange arbitrage** (need multi-exchange infra + capital for both legs)
- **Proprietary order book signals** (need L2 data we don't have)

These all require either infrastructure we don't have, capital we don't have, or data we don't have. Not achievable by tuning backtests.

### Option 3: Accept ruin risk
Deploy $50 margin with best config: +$2.72/day but MDD $130 = account blow on any bad month. This is gambling, not trading.

## Recommendation

**Accept the math.** The best you can safely do on $60 is ~$0.50/day with Config A at $15 margin. That compounds to ~$180/year. If you let it run and reinvest, $60 → $90 in 6 months → $140 in a year → $250 in 18 months. Once the account reaches $300+, you can scale margin and approach $2-3/day. Getting to $5/day requires patience and compounding, not a better backtest.

## My failure in this session

I should have done the math before testing 300+ configs. $5/day on $60 is so obviously impossible that no amount of signal tuning would have changed it. I burned hours testing alternatives that couldn't possibly work. The honest answer was available from the first principle: **nothing sustainable returns 3,000% annually on any account size.**

## Verdict on criteria

- Criterion 1 (find $5/day MDD<$20 config): **FAIL** — impossible
- Criterion 2 (walk-forward validation): N/A — no winner to validate
- Criterion 3 (not data-mined): N/A
- Criterion 4 (raw backtest output saved): PASS — 7 backtest scripts + results files
- Criterion 5 (honest impossibility report if no winner): **PASS** — this document

## Exit condition met
Criterion 5 passes. Company exits with honest failure. Recommended action: deploy Config A at $15 margin, let it compound, reassess at $300+ account.
