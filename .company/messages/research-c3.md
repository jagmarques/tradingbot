# Head of Research Report - Cycle 3: Untested Strategies

Date: 2026-03-29
Author: Head of Research
Cycle: 3 (web-sourced, first-principles filtered)

Context: Cycles 1-2 exhausted trend following (Donchian, Supertrend, GARCH), mean
reversion (RSI, BB, VWAP), HFT (scalping, grid, spread capture, market making),
inter-pair (beta MR, correlation, lead-lag), and confluence strategies. GARCH v2
multi-TF z-score is the surviving benchmark: $2.38/day, MaxDD $59, Sharpe 4.29.

Goal: Find something structurally different from GARCH that could beat it on $90 equity.
All seven search queries were executed. Findings are reported with brutal honesty.

---

## QUERY 1: Ornstein-Uhlenbeck (OU) Process Trading

### What It Is

OU is the mathematical model behind classic pairs trading / statistical arbitrage.
It says a spread S_t reverts to a long-run mean at rate theta: dS = theta*(mu - S)*dt + sigma*dW.
Optimal entry: enter when S deviates beyond Z standard deviations, exit at mean.
Academic research confirms it works for PAIRS spreads, specifically cointegrated pairs.

### Can It Work on $90?

For SINGLE assets (applying OU to individual BTC price): No. Crypto perpetuals are
NOT mean-reverting at meaningful timescales. BTC exhibits H > 0.5 (trending) on
most timeframes. OU applied to a single perp would lose money in trending markets.

For PAIR SPREADS (two cointegrated assets): Partially tested. Cycle 2 tested
DOGE/WIF pairs and yielded +$0.61/day, 16x short of target. That WAS OU-based
even if not labeled as such.

### Is This Fundamentally Different from GARCH?

No. GARCH v2 is already a z-score mean reversion model on individual assets. OU on
single assets is structurally identical to GARCH z-score — both look for "stretched"
deviations and fade them. The OU pair spread variant IS different (requires two legs)
but was tested in Cycle 2 and produced $0.61/day.

### Verdict: ALREADY TESTED (GARCH = OU on single assets; pairs = Cycle 2)

The one untested OU extension is multi-pair basket spread: take a portfolio of 5-6
cointegrated pairs, trade the spread as a single entity. This requires more capital
(multiple simultaneous positions), adds implementation complexity, and has
diminishing marginal improvement over single-pair MR in a $90 account. Not worth
pursuing.

---

## QUERY 2: Order Flow Imbalance (OFI)

### What It Is

OFI measures real-time buyer vs seller aggression by tracking whether trades hit
the bid or ask. Trade flow imbalance (how many dollars crossed bid vs ask in the
last N seconds) has been shown in academic literature to have "a strong linear
relationship with contemporaneous price changes" (ScienceDirect, 2026). The
Anastasopoulos & Gradojevic paper (EFMA 2025) shows out-of-sample predictive
ability for DAILY crypto returns using international OFI + ML conditioning.

### Data Requirements

Real-time OFI requires tick-by-tick trade data with aggressor side (buy/sell flag).
HL's WebSocket provides this via the `trades` subscription. We CAN collect this.

### Can It Work on $90?

The signal horizon is where this breaks down. Academic results are strongest at:
- Sub-60 second horizons: real edge, decays within minutes
- Daily horizons: weak edge, heavily conditioned on macro factors

There is a dead zone between 1 minute and 4 hours where OFI provides almost no
predictive power. Our GARCH runs on 15-minute scheduler cycles. By the time our
engine fires, any OFI signal from the prior minute is fully arbitraged away by
faster actors.

HFT firms exploit OFI at millisecond latency. We cannot compete there.
Cycle 2's HFT researcher already identified OFI as a useful FILTER at entry time
(fetch l2Book once when GARCH fires, check imbalance) but not a standalone signal.

That remains the correct framing. Adding OFI as a same-second entry filter to GARCH
is a Tier 1 addition (already recommended in Cycle 2), not a new strategy.

### Is This Fundamentally Different from GARCH?

Yes in mechanism, No in practice for our architecture. It would need a sub-1-minute
execution loop to express as a standalone strategy — an architectural overhaul.

### Verdict: NOT A NEW STRATEGY. Useful as a filter (Cycle 2 Tier 1 recommendation confirmed)

---

## QUERY 3: Machine Learning for Crypto Trading

### What Research Actually Shows

Published papers show DRL/ML strategies achieving 12-63% ROI in backtests.
The critical caveat from peer review (OpenReview, ArXiv 2209.05559): "Existing works
optimistically report increased profits in backtesting, which may suffer from the
false positive issue due to overfitting." The DRL paper at OpenReview specifically
addresses the backtest overfitting problem because it is so widespread.

One ML system (ScienceDirect 2025) combined LSTM + XGBoost feature selection for a
system that produced $250 profit over 2 months in real trading with 300+ trades. That
is $4/day on an unknown capital base.

### Why ML Fails for $90 Accounts

1. Feature engineering requires 1m/5m/15m OHLCV + volume + funding + OI.
   We have most of this but not normalized, not labeled for supervised learning.

2. DRL models (A2C, PPO, DQN) require training on historical data. The same
   research showing DQN achieved +63% ROI on BinanceCoin also showed A2C and
   RPPO had NEGATIVE ROI on other coins. Model selection risk is extreme.

3. The regime problem: ML models trained on 2021-2023 data fail in 2024-2025
   market structure changes (perps dominance shift, new pairs). The Springer
   chapter title says it directly: "Forecasting and Trading Cryptocurrencies with
   Machine Learning Under CHANGING MARKET CONDITIONS."

4. Infrastructure cost: Training a DRL model requires GPU compute. Inference
   at 15-minute intervals is feasible on CPU but requires model serving, feature
   pipeline, and continuous retraining to avoid decay.

5. We cannot validate ML edge at $90. The capital is too small to distinguish
   genuine ML alpha from noise over any meaningful sample.

### The Honest ML Assessment

ML is not a strategy — it is a method. Every strategy in Cycles 1-2 COULD be
implemented with ML feature conditioning. Doing so would add complexity,
overfit risk, and maintenance burden without a demonstrated edge lift over
our existing GARCH signal.

The one ML-adjacent approach with documented live results is gradient boosted
ensemble on funding rate + OI + price features for 1h directional prediction.
This is structurally identical to GARCH but with a black-box decision boundary
instead of a z-score threshold. There is no documented case of this beating a
well-calibrated z-score model on crypto perps with out-of-sample testing.

### Verdict: TOO COMPLEX FOR $90 ACCOUNT, NO DEMONSTRATED EDGE OVER GARCH

---

## QUERY 4: Volatility Surface Trading

### What It Is

Volatility surface trading exploits mispricings between implied volatility (from options)
and realized volatility. Classic strategies: vol surface arbitrage, vega-neutral
gamma scalping, variance swaps.

### Data Requirements

Crypto options are available on Deribit (BTC, ETH only). Hyperliquid does not have
options. Our 25 traded pairs are perps only.

### Fatal Constraint for Our Setup

We trade perps on HL. Perp contracts have no implied volatility. There is no
vol surface to trade. Any volatility-surface strategy would require:
1. Switching to Deribit
2. Hedging with perps on another exchange
3. New infrastructure, new API, new risk model

This is not an $90 extension of our existing system — it is a different business.

One sub-strategy that DOES apply: using historical realized volatility as a regime
filter. When realized 30-day vol is high, reduce position sizes or pause entries
(because our SLs are fixed % and high vol means more random noise). This is already
implicit in GARCH — the z-score is normalized by sigma, so high-vol periods require
a larger absolute move to trigger. Our engine is already vol-adaptive by construction.

### Verdict: NOT APPLICABLE (requires options market, no perps equivalent)

---

## QUERY 5: Hurst Exponent as Trading Signal

### What It Is

The Hurst exponent H measures time-series persistence:
- H < 0.5: anti-persistent (mean-reverting)
- H = 0.5: random walk
- H > 0.5: trending (momentum)

A 2024 MDPI paper (Mathematics 12/18/2911) directly studied "Anti-Persistent Values
of the Hurst Exponent Anticipate Mean Reversion in Pairs Trading: The Cryptocurrencies
Market." Key finding: H < 0.5 indicates faster mean reversion, and strategies using
Hurst to filter entry timing outperform naive pairs trading in backtests 2019-2024.

### Can It Work Standalone?

Hurst is a regime detector, not a directional signal. It cannot tell you:
- Which direction to trade
- When to enter
- Where to put a stop

It answers one question: "Is this asset currently mean-reverting or trending?"

### Value as a GARCH Enhancement

GARCH + Hurst filter would work as follows:
- Compute rolling 20-period Hurst on 4h bars for each asset
- When GARCH z-score fires a long/short: confirm H < 0.5 (mean-reverting regime) before entering
- Skip entries in trending assets (H > 0.5) where z-score fades are likely to be run over

This is a genuine, untested, implementable addition to GARCH. Hurst is computable
from existing OHLC data (no new data sources). Rolling Hurst on 20-40 periods of 4h
bars is computationally cheap. The MDPI 2024 paper provides academic backing.

### Is This Fundamentally Different from GARCH?

No — it is a regime filter ON GARCH. But it addresses GARCH's main failure mode:
entering a z-score trade during a strong trend, where the z-score keeps expanding
and the trade runs at max loss until SL is hit. Hurst would gate out those entries.

### Expected Impact

If 20-30% of GARCH losses come from trending regimes (H > 0.5 at entry), filtering
those out could reduce MaxDD by $10-15 and improve Sharpe without reducing trade count
significantly (trending assets cycle through trending and ranging phases).

### Implementation Cost: Low (~half day). Backtestable on existing 1h/4h data.

### Verdict: BEST NEW ADDITION TO GARCH. Not a standalone strategy but a real improvement.

---

## QUERY 6: Crypto Microstructure Alpha for Retail

### What Research Shows

The 2025 example of a retail trader turning $6.8K into $1.5M was maker fee rebate
farming at scale on a DEX perps exchange. The strategy posted single-sided quotes,
harvested rebates from every fill, and ran at near-continuous volume. This requires:
- Custom smart contract routing
- Direct protocol integration
- Near-zero slippage on every fill
- Thousands of round trips per day

Cycle 1 of our research already proved this is impossible at $90/$130 account size.
The chief strategist showed 556 round trips per day are needed for $10/day on $90
via rebates alone — 18.5 hours of continuous fills at 2-minute minimum per RT.

The Talos "Execution Alphas" research (2025) discusses predicting volume, volatility,
and spreads to reduce slippage — this is execution optimization, not a strategy.
Useful for minimizing our taker fees but not an alpha source.

### The Microstructure Dead Zone

For retail traders on HL, microstructure alpha lives at two extremes:
1. Sub-second: HFT rebate farming (requires institutional infrastructure, proven impossible at $90)
2. Sub-1-minute OFI signals: requires architectural overhaul (covered in Query 2)

There is no microstructure strategy accessible at the 15-minute scheduler frequency
that has not already been tested in Cycles 1-2.

### Verdict: NO NEW STRATEGIES. Confirms Cycle 1-2 conclusions.

---

## QUERY 7: TWAP/VWAP Execution Alpha

### What It Is

TWAP and VWAP are execution algorithms, not prediction strategies. They reduce
market impact on large orders. A 2025 study showed TWAP reduces slippage by
15-22% vs market orders during medium volatility. The Arxiv paper (2502.13722,
Feb 2025) "Deep Learning for VWAP Execution in Crypto Markets" uses ML to predict
optimal execution timing — but this is for institutional-scale orders.

### Relevance to $90 Account

Our entire position is $90 notional. Market impact on a $90 trade on HL (which
does $10B+/day volume) is exactly zero. TWAP/VWAP matter when your order is large
enough to move the market. At $90 notional, we are 1/100,000 of daily volume.

There is no VWAP strategy here. The execution algorithms used by VCs placing $666,000
orders (the 2024 INST example) are irrelevant to our scale.

### Verdict: NOT APPLICABLE at $90 notional. Zero market impact = zero execution alpha.

---

## ADDITIONAL SEARCH: Funding Rate Carry

The funding rate carry trade (go long perp + short spot to collect positive funding,
or reverse for negative funding) was covered in the Cycle 2 HFT researcher report.
Summary: requires 0.15%/hr minimum funding to break even after fees. HL spot market
only covers BTC, ETH, SOL for delta-neutral hedging. Our 25 pairs are perp-only.
The 2025 ScienceDirect paper confirmed "funding rate arbitrage exhibits no correlation
with HODL strategies" — so it IS uncorrelated with GARCH. But feasibility requires
$10,000+ position to net meaningful dollars at typical funding rates.

---

## SYNTHESIS: RANKED FINDINGS

### TIER 1 — Actionable additions to existing GARCH (not new strategies)

1. **HURST EXPONENT REGIME FILTER**
   - Add to GARCH entry check: compute rolling Hurst on 20 × 4h candles per asset
   - Skip entry if H > 0.5 (trending regime, z-score fade likely to fail)
   - Academic backing: MDPI 2024 study on crypto pairs
   - Data: existing 4h OHLC (already fetched by Supertrend engine)
   - Implementation cost: ~half day
   - Expected impact: reduce MaxDD by $10-15, improve Sharpe
   - Risk: may reduce trade frequency if too many assets are in trending regime

2. **OFI SAME-SECOND ENTRY FILTER** (Cycle 2 Tier 1 — confirming)
   - Fetch l2Book at moment GARCH fires, check bid/ask imbalance top-5 levels
   - Skip entry if imbalance >3:1 against direction
   - No backtest needed — conservative filter only skips obviously adverse entries

### TIER 2 — Interesting but needs investigation

3. **FUNDING Z-SCORE FILTER ON GARCH ENTRIES** (Cycle 2 Tier 1 — confirming)
   - Skip GARCH longs when HL funding rate is >2 std devs above 30-day mean
   - Already identified in Cycle 2 by HFT researcher
   - Directly addresses crowded-long failure mode

### TIER 3 — Theoretically sound but architecturally different

4. **MULTI-PAIR OU BASKET SPREAD**
   - Trade 4-6 cointegrated pairs as a basket spread (e.g., DOGE + WIF + PEPE vs SOL + BTC)
   - Potentially more stable OU process than single pairs
   - Requires 6-8 simultaneous positions, reducing available margin for GARCH
   - Likely cannibalizes GARCH capacity rather than running alongside it

### TIER 4 — Rejected

| Strategy | Reason |
|----------|--------|
| Volatility surface / vol arb | Requires options market (Deribit), no perps equivalent |
| ML / DRL | No demonstrated OOS edge over GARCH, extreme overfit risk |
| Microstructure HFT | Impossible at $90 (proven Cycle 1) |
| TWAP/VWAP execution | Zero market impact at $90 notional |
| Single-asset OU | Structurally identical to GARCH (already tested) |
| Funding carry / spot-perp arb | Only viable on BTC/ETH/SOL, needs $10K+ to net dollars |
| Liquidation front-running | HL whitelist blocks external bots (Cycle 2) |

---

## HONEST OVERALL ASSESSMENT

Seven search queries. Two new findings with actionable potential:

1. Hurst exponent regime filter — genuinely untested in our system, academic backing, low
   implementation cost. This is a GARCH improvement, not a new strategy.

2. Nothing else clears the bar of being fundamentally different from GARCH AND
   implementable at $90 AND having demonstrated OOS edge.

### The Uncomfortable Truth

The academic literature for 2024-2026 on crypto quantitative trading converges on
the same conclusion we reached in Cycles 1-2:

- **HFT strategies** require institutional infrastructure and capital scale
- **Mean reversion strategies** (OU, BB, RSI, z-score) all converge to the same
  signal family — GARCH z-score is already near the efficient frontier for this class
- **ML/DRL** adds complexity and overfit risk without demonstrated live advantage over
  well-calibrated parametric models
- **Microstructure edges** decay too fast for a 15-minute scheduler and require
  speed advantages we cannot achieve

The search for something "fundamentally different from GARCH" reveals that in the
accessible-to-retail, $90-account, 15-minute-scheduler parameter space, there is no
untested strategy category remaining. We have covered the full space.

### Path Forward

The honest recommendation after Cycle 3 is to stop searching for new strategies and
instead focus on improving GARCH's existing edge through filters:

1. **Hurst regime filter** on GARCH entries (Tier 1 — implement)
2. **OFI same-second filter** on GARCH entries (Tier 1 — implement)
3. **Funding z-score filter** on GARCH entries (already Cycle 2 Tier 1)

These three additions require ~1.5 days of work combined, use existing data sources,
and target GARCH's documented failure modes. Together they are likely worth more in
risk-adjusted terms than any new strategy category found in this cycle.

**The $10/day target at $90 equity remains mathematically unreachable** without either
(a) compounding to $450-500 equity or (b) accepting a strategy with catastrophic MaxDD.
The path is patience + compound, not a new strategy.

---

*Research complete. No further search cycles recommended unless capital base changes
significantly or a new exchange/instrument class becomes available.*
