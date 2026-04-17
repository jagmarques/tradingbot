# Capital Scaling Plan

**Date:** 2026-03-28
**Baseline:** $100+ USDC on Hyperliquid, 5-engine ensemble

---

## 1. Backtest Position Analysis

### Engine sizing (current 1x)
| Engine | Size | Notional (10x) | Exit style |
|--------|------|-----------------|------------|
| A - Donchian | $2 | $20 | 60d max hold / Donchian channel |
| B - Supertrend | $3 | $30 | Supertrend flip |
| C - GARCH v2 | $9 | $90 | 96h max hold / TP 7% |
| D - Carry | $4 | $40 | Signal flip |
| E - Momentum | $3 | $30 | 48h max hold |
| **Total (1 slot each)** | **$21** | **$210** | |

### Max margin in use at any point

With MAX_POS=20 and 5 engines across 23 pairs, the system can fill all 20 slots simultaneously. Engines open independently per pair, so the worst-case mix is dominated by whichever engine fires most:

- **Lower bound:** All 20 slots at Engine A avg = 20 × $2 = $40 margin
- **Upper bound:** 20 slots at Engine C ($9 each) = $180 margin — not possible because GARCH fires rarely and is capped at 1 per pair
- **Realistic worst case:** Mixed engine load of avg $4.2/position × 20 positions = **$84 margin deployed**

At 10x leverage that represents $840 notional. The system holds $210 average notional under typical conditions (5-10 positions open at once based on signal frequency).

### Max unrealized loss at any point

The SL cap is 3.5% from entry (QUANT_MAX_SL_PCT). Per position:
- Engine C max loss: $9 margin × 10 × 3.5% = $3.15/position
- Engine A max loss: $2 × 10 × 3.5% = $0.70/position
- Portfolio max simultaneous SL: 20 positions × avg $4.2 × 3.5% × 10 = **$29.40**

This is the one-bar gap-down worst case (all positions stop out simultaneously), which is a black-swan scenario. Realistic max unrealized loss based on backtest MaxDD of $147 implies the equity curve drew down that much over time, not instantaneously.

### Capital needed to survive worst drawdown

From backtest: MaxDD = $147 (full-period, including all 4 trail/re-entry configs).
With $100 capital and $147 MaxDD: **this is not survivable at 1x if the worst drawdown occurs immediately.**

The conservative rule: capital = max deployed margin + MaxDD buffer.
- Max deployed margin: ~$84 (worst realistic case)
- MaxDD: $147
- Minimum capital to survive: **$84 + $147 = $231**

However the $147 MaxDD is the worst-case across 3.2 years on a no-trail config. With the preferred 30/7+RE trail config, MaxDD is materially lower. Using a conservative 2× margin multiple as the buffer:
- Practical minimum: MaxDD × 2 = ~$150-200

**Recommendation: do not scale beyond what the account can sustain a full MaxDD from its current equity.**

---

## 2. Scaling Scenarios

Scaling is applied as a uniform multiplier on all engine sizes. MaxDD and $/day scale linearly with margin (backtest evidence: both are driven by notional size, not fixed costs).

Sharpe is approximately stable across scales because it is a ratio of mean to stddev, both of which scale proportionally.

| Scale | Engine sizes | Total margin (1 slot each) | Max deployed margin (20 pos, mixed) | $/day (expected) | MaxDD (expected) | Min capital needed |
|-------|-------------|---------------------------|-------------------------------------|-----------------|------------------|--------------------|
| 1x | $2/$3/$9/$4/$3 | $21 | ~$84 | $3.18 | $147 | $231 |
| 2x | $4/$6/$18/$8/$6 | $42 | ~$168 | $6.36 | $294 | $462 |
| 3x | $6/$9/$27/$12/$9 | $63 | ~$252 | $9.54 | $441 | $693 |
| 5x | $10/$15/$45/$20/$15 | $105 | ~$420 | $15.90 | $735 | $1,155 |

**Notes on these projections:**
- $/day projections assume live performance matches backtest. The research report shows backtested Sharpe has R^2 < 0.025 vs live (academic finding); plan for 30-50% degradation in live performance.
- MaxDD projections scale linearly, which is conservative — in practice larger capital means the same losing streak costs more dollars but not necessarily more in percentage terms.
- Min capital = max deployed margin + MaxDD buffer (to survive worst drawdown without margin call or kill-switch trigger).

### Realistic live performance (30% degradation applied)

| Scale | $/day (realistic) | Monthly (realistic) | MaxDD (realistic) |
|-------|-------------------|---------------------|-------------------|
| 1x | $2.20 | $66 | $147 |
| 2x | $4.40 | $132 | $294 |
| 3x | $6.60 | $198 | $441 |
| 5x | $11.00 | $330 | $735 |

---

## 3. When to Scale

### Minimum live validation period

Trend-following strategies have lumpy P&L. A single month is statistically meaningless. Minimum thresholds before scaling:

**Gate 1 — Time:** 60 days live trading (two full calendar months). This captures at least one full losing streak and one recovery cycle. Below 60 days, any profit figure has too wide a confidence interval to act on.

**Gate 2 — Trade count:** Minimum 40 closed trades. With ~1-2 trades/day across all engines, this is approximately 3-6 weeks. Fewer than 40 trades: sample size too small for any statistical test.

**Gate 3 — Statistical confidence:** Use a one-sided t-test on daily P&L returns.
- H0: mean daily P&L = 0
- Threshold: p < 0.05 (t-statistic > 1.67 for n=60 days)
- At $3.18/day mean and typical daily std of ~$8-12 (from backtest Sharpe 2.74, annualized), this is achievable in 30-60 days

Calculation: required n = (z × σ / μ)² = (1.645 × 10 / 3.18)² ≈ 27 days. Use 60 days to account for live degradation.

**Gate 4 — Live vs backtest match:**
- If live $/day >= 50% of backtest $/day over the measurement window: green
- If live $/day is 30-50% of backtest: yellow, investigate but can proceed cautiously
- If live $/day < 30% of backtest: red, do not scale, investigate regime change

**Gate 5 — Drawdown guard:** Current drawdown from peak must be < 50% of MaxDD before scaling. If currently in a drawdown, wait for recovery.

### Scale-up decision matrix

| Live days | Trades | t-test p | Live vs BT ratio | Action |
|-----------|--------|-----------|------------------|--------|
| < 30 | any | any | any | Wait |
| 30-60 | < 40 | any | any | Wait for more trades |
| 60+ | 40+ | > 0.05 | any | Do not scale |
| 60+ | 40+ | < 0.05 | >= 50% BT | Scale 1x → 2x |
| 90+ | 80+ | < 0.05 | >= 70% BT | Scale 2x → 3x |
| 120+ | 120+ | < 0.05 | >= 70% BT | Consider 3x → 5x |

---

## 4. Risk Management for Scaling

### Scale all engines equally or Kelly-weight?

**Recommendation: scale all engines equally at first, then Kelly-weight after 6 months of live data per engine.**

Rationale: Kelly weighting requires per-engine live win rate and payoff ratio. Backtest per-engine metrics are unreliable for Kelly because the engines interact (shared MAX_POS pool). Without live data per engine, Kelly will be misfitted to backtest noise.

After 6 months live:
- Compute per-engine Kelly fraction: f* = (p × b - q) / b, where p = win rate, b = avg win / avg loss
- Scale engine sizes proportionally to Kelly fractions, normalized so total margin = target
- Cap any single engine at 3× its 1x size (avoid over-concentrating on one signal)

### Should max positions be reduced when scaling?

**No — keep MAX_POS=20 at all scales.**

The position cap exists to limit correlation exposure, not margin. At 2x scale the same 20 positions just cost twice as much. Reducing the cap would reduce expected return proportionally while not meaningfully changing risk profile.

The risk is managed by the capital requirement (min capital = max deployed + MaxDD buffer), not by capping position count.

**Exception:** If scaling causes max deployed margin to exceed 80% of account equity at any moment, either raise capital or reduce MAX_POS. Formula: MAX_POS = floor(0.8 × account_equity / avg_margin_per_position).

### At what capital level does the 20-position cap become a bottleneck?

The 20-position cap blocks trades when all slots are full. The backtest records `blocked` count — at 1x sizing with 23 pairs and 5 engines, blocking happens occasionally but rarely constrains performance materially.

The cap becomes a bottleneck when:
- The number of concurrent signals regularly exceeds 20
- Blocked trades represent > 10% of total attempted trades

With 23 pairs and 5 engines: max possible simultaneous signals = 115, but typical concurrency is 5-12 positions based on engine firing frequency. The 20-slot cap is not a real constraint at current pair count.

**If you expand pairs to 30+**, or add 2+ new engines, reconsider raising MAX_POS to 30. Each additional slot adds ~$4.20 average margin commitment (at 1x).

---

## 5. Hyperliquid Position Size Limits

### Official limits (from HL docs, March 2026)

Hyperliquid sets max notional position per asset based on the asset's max leverage tier:

| Max leverage tier | Max notional position |
|-------------------|-----------------------|
| >= 25x | $15,000,000 |
| 20x - 25x | $5,000,000 |
| 10x - 20x | $2,000,000 |
| < 10x | $500,000 |

Most altcoins in the current pair set (OP, ARB, WIF, LDO, ENA, WLD, DASH, etc.) support 10-20x max leverage. This puts their per-position cap at **$2,000,000 notional**.

At 10x leverage: max margin per position = $200,000 for these assets.

### Where our system hits exchange limits

At 1x: per-position notional is $20-$90. This is 0.001-0.005% of the $2M limit. Completely unconstrained.

At 5x: per-position notional is $100-$450. Still trivially small vs exchange limits.

At what scale do we approach limits?

For Engine C (GARCH, largest size at $9 → $90 notional at 1x):
- $2,000,000 limit / $900 per position (at 100x scale) = 100x scale would hit the limit
- In practice: the exchange limit is not a constraint until **notional per position exceeds ~$200,000**, which requires a scale factor of **2,000+ on Engine C**.

**Conclusion: Hyperliquid exchange limits are not a constraint for any realistic scaling plan below $50,000 account size.**

At $10,000 account: 5x scale, Engine C at $45 margin × 10x = $450 notional. Still far from limits.
At $50,000 account: 20x scale, Engine C at $180 margin × 10x = $1,800 notional. Still far from limits.

The real constraint at larger account sizes is market impact (slippage on entry/exit), not exchange position limits.

**Market impact estimates:**
- OP, ARB, WIF daily volume: $50-200M on HL
- At $1,000 notional our impact is negligible (<0.001% of daily volume)
- Market impact becomes relevant above ~$50,000 notional per trade (0.1% of $50M volume)
- This corresponds to approximately **scale 555x on Engine C** — not a near-term concern

---

## 6. Scaling Roadmap

### Phase 1: Baseline live validation (now through Day 60)

**Capital:** $150-200 (current $100 plus top-up to cover worst-case MaxDD)
**Sizes:** 1x ($2/$3/$9/$4/$3)
**Max positions:** 20
**Success criteria:**
- 60+ days live, 40+ trades
- p < 0.05 on daily P&L t-test
- Live $/day >= 50% of backtest ($1.59+/day)
- No single month > -$60 (0.5× MaxDD trigger)

**Action:** Track per-engine P&L separately. Record every blocked trade.

---

### Phase 2: Scale to 2x (Day 60 to Day 120)

**Unlock conditions:** All Phase 1 success criteria met
**Capital required before scaling:** $462 minimum ($231 × 2)
**Sizes:** $4/$6/$18/$8/$6 = $42 total margin per full slot
**Max positions:** 20
**Expected:** $4.40-$6.36/day, MaxDD up to $294

**How to fund:**
- Withdraw profits from Phase 1 to separate wallet, do not compound into HL account
- Deposit fresh capital to reach $462 minimum before enabling 2x sizes
- Change SIZE constants in engine config, redeploy

**Risk gates at 2x:**
- Daily loss limit: $30 (2× the $15 per-engine, scaled)
- Weekly drawdown limit: $80 (pause all engines if breached, review)
- Kill switch: -20% of account equity

---

### Phase 3: Scale to 3x (Day 120+)

**Unlock conditions:**
- Phase 2 running 60+ days profitably
- Live $/day >= 70% of 2x backtest projection ($4.45+/day)
- Account equity at $693+ minimum
- Apply Kelly weighting per engine if 6 months live data available

**Capital required:** $693
**Sizes:** $6/$9/$27/$12/$9 = $63 total
**Expected:** $6.60-$9.54/day, MaxDD up to $441

---

### Phase 4: Scale to 5x (Month 9+)

**Unlock conditions:**
- 3x profitable for 3+ months
- Per-engine Kelly fractions computed from live data
- Account equity at $1,155+

**Capital required:** $1,155
**Sizes:** $10/$15/$45/$20/$15 = $105 total
**Expected:** $11-$15.90/day, MaxDD up to $735

**Note:** At 5x, Engine C ($45 margin × 10x = $450 notional) starts to show in order books for thinly-traded pairs. Monitor slippage on GARCH entries vs backtest assumptions. If live slippage > 2× backtest spread, cap Engine C at 4x and others at 5x.

---

### Capital top-up schedule

Each scale step requires fresh capital. Do not use compounded profits as the sole source — trend-following P&L is lumpy and you may be in a drawdown exactly when you want to scale.

| Phase | Capital target | Source |
|-------|---------------|--------|
| Current | $150-200 | Top-up now |
| 2x | $462 | Fresh deposit after 60d validation |
| 3x | $693 | Fresh deposit after 120d validation |
| 5x | $1,155 | Fresh deposit after 9 months |

---

### Summary table

| Phase | Scale | Capital | $/day realistic | MaxDD | Timeline |
|-------|-------|---------|-----------------|-------|----------|
| 1 | 1x | $150-200 | $1.59-$3.18 | $147 | Now |
| 2 | 2x | $462 | $3.18-$6.36 | $294 | Day 60+ |
| 3 | 3x | $693 | $4.77-$9.54 | $441 | Day 120+ |
| 4 | 5x | $1,155 | $7.95-$15.90 | $735 | Month 9+ |

---

## 7. Key Risks

**1. Backtest overfitting.** The MaxDD of $147 may be the best observed drawdown over 3.2 years. In a bad regime, it could be 2× worse. The min-capital figures above provide a partial buffer but not a guarantee.

**2. Regime change.** Trend-following only works in trending markets. A 12-month low-volatility sideways regime (2019 BTC-style) would reduce signal frequency and potentially turn the system flat. Scaling into a regime change amplifies the damage.

**3. Correlated losses across engines.** The backtest shows -0.006 to -0.014 inter-engine correlation. This near-zero correlation is the system's main strength. If a black-swan event (exchange hack, regulatory ban) triggers all stops simultaneously, the $29.40 worst-case simultaneous SL still applies at 1x.

**4. Execution degradation.** As scale increases, entry at exact bar-open prices becomes harder to guarantee. At 2-3x, this is negligible. At 10x+, enter limit orders rather than market orders, and accept possible signal misses.

**5. Do not skip phases.** Jumping from 1x to 5x without live validation at 2x and 3x bypasses the regime-risk detection built into the phased timeline. Each phase provides 60+ days of live evidence before committing more capital.
