# HFT Researcher Report - Maker-Only Strategies on Hyperliquid

Date: 2026-03-29
Agent: HFT Researcher

---

## CRITICAL CORRECTION TO BRIEF

The brief assumes HL charges 0.035% taker and gives -0.01% maker rebate. The actual fee structure is different and significantly changes the math.

FINDING: Base tier (Tier 0, no volume minimum) maker fee is +0.015% (a COST, not a rebate). The -0.001% to -0.003% rebates require holding 0.5%, 1.5%, or 3.0% of ALL maker volume on Hyperliquid over a 14-day window.
SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees

FINDING: To reach rebate Tier 1 (-0.001%), a bot needs >0.5% of total maker volume. With HL daily perp volume at ~$6.6B, total maker volume is roughly $3-4B/day on a 14-day basis. 0.5% of that is approximately $15-20M in maker volume per 14-day window, or ~$1-1.5M/day. A $130 account cannot reach this threshold - it would need to churn its capital ~10,000x per day.
SOURCE: NOVEL - needs validation (calculated from HL volume data + fee docs)

FINDING: The viral "$6,800 to $1.5M" maker rebate case ran $1.4B in volume over 14 days (~$100M/day), accounted for >3% of all maker volume (hitting Tier 3 at -0.003%), and had >$200k in capital. This is NOT a small-account strategy - it is institutional HFT scaled to dominate the liquidity pool.
SOURCE: https://beincrypto.com/hyperliquid-trader-earns-millions-from-maker-strategy/ (via search summary)

---

## ACTUAL FEE STRUCTURE FOR A $130 ACCOUNT

| Order Type | Fee | Per $90 notional trade |
|------------|-----|------------------------|
| Taker      | 0.045% | $0.0405 cost |
| Maker (Tier 0) | 0.015% | $0.0135 cost (NOT a rebate) |
| Maker (Tier 1, -0.001%) | -0.001% | $0.0009 rebate |
| Maker (Tier 2, -0.002%) | -0.002% | $0.0018 rebate |
| Maker (Tier 3, -0.003%) | -0.003% | $0.0027 rebate |

FINDING: At Tier 0 (realistic for $130 capital), maker orders cost 0.015% per fill, not receive a rebate. The rebate structure requires institutional-scale volume share. The brief's assumption of -0.01% rebate at small scale is incorrect.
SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees

---

## REVISED MATH FOR $130 ACCOUNT

At Tier 0, 100 maker fills/day at $90 notional:
- Fee cost: 100 x $90 x 0.00015 = $1.35/day in fees
- Break-even: each trade needs >0.015% favorable price move just to cover fees
- Need $9.10/day profit from edge PLUS $1.35 in fees = $10.45/day total
- That requires 0.116% average move per $90 notional trade (50 round trips)
- At 10x leverage, 0.116% notional = 1.16% on underlying price per trade

FINDING: At Tier 0 maker, the math is WORSE than the brief assumed. No rebate accrues; instead, 0.015% per fill is a cost. The strategy requires real directional edge, not just rebate harvesting.
SOURCE: NOVEL - calculation based on confirmed fee structure

---

## ALO ORDER MECHANICS

FINDING: ALO (post-only) orders have the highest processing priority in each block on HL's L1. Cancels and post-only orders are prioritized above GTC and IOC orders at the consensus layer itself.
SOURCE: https://hyperliquid.medium.com/latency-and-transaction-ordering-on-hyperliquid-cf28df3648eb

FINDING: When an ALO order would cross the spread (i.e., would execute as taker), it is CANCELED, not executed. This guarantees maker status but means the order fails to fill if price has moved through your level.
SOURCE: https://hiperwire.io/explainers/hyperliquid-order-types-complete-guide

FINDING: Toxic flow (predatory HFT taker vs maker) is 10x lower on HL than other venues due to the cancel/ALO priority system. This means maker orders face less adverse selection than on Binance/OKX.
SOURCE: https://hyperliquid.medium.com/latency-and-transaction-ordering-on-hyperliquid-cf28df3648eb

---

## BID-ASK SPREAD ON HL ALTCOINS

FINDING: BTC perpetual spread on HL is ~0.3%, matching Binance depth. Altcoins (WIF example) show spreads of ~1.5% post-stress, indicating significantly wider spreads on lower-cap pairs in volatile conditions.
SOURCE: https://blockchain.news/flashnews/hyperliquid-50x-trader-faces-243k-loss-on-10x-wif-short-impact-on-altcoin-trading-strategies (via search)

FINDING: Our 25 traded pairs (WIF, DOGE, LINK, etc.) likely have spreads of 0.05-0.3% in normal conditions and 0.5-2% in stress. At Tier 0 maker fee of 0.015% per side (0.03% round-trip), the spread capture math is viable IF fill rate is adequate - the spread revenue needs to exceed the 0.03% round-trip fee plus inventory risk.
SOURCE: NOVEL - extrapolated from available spread data

---

## FILL RATE REALITY FOR ALTCOINS

FINDING: No public data on ALO fill rates per-pair. Fill rate depends on: (1) how close to mid-price orders are placed, (2) market volatility, (3) order queue depth. Tight quotes get filled faster but risk more adverse selection. Wide quotes get filled less but capture more spread.
SOURCE: NOVEL - needs validation via live testing

FINDING: HL allows up to 5,000 resting orders with no gas cost for cancels/modifications. This enables dense ladder grids and free order management - a structural advantage over CEXs where API rate limits constrain market makers.
SOURCE: https://vadim.blog/hyperliquid-gasless-trading-strategies

---

## VIABLE MAKER STRATEGIES WITHOUT DIRECTIONAL PREDICTION

### Strategy 1: Spread Capture with Inventory Hedging
Place ALO bids AND asks simultaneously at mid +/- half-spread. Pocket the spread when both sides fill. Cancel whichever side hasn't filled after N seconds if price moves. Risk: inventory builds on one side if trend is strong.

FINDING: The key constraint is that spread must exceed 0.03% round-trip (0.015% each side at Tier 0) plus inventory holding cost. For a $90 notional trade needing 0.03% edge, the underlying must move 0.03% in your favor before adverse inventory risk builds.
SOURCE: NOVEL - needs validation

### Strategy 2: One-Sided Quoting (Directional Bias Required)
Post bids only when expecting upward movement, cancel and post asks only when expecting downward. The viral $6800 bot did this. Requires directional signal - not truly "no prediction" but much lower bar than traditional trading.

FINDING: This IS the actual strategy that generated viral returns. It is not pure rebate farming - it requires a directional signal (e.g., trend, momentum, order flow) to choose which side to quote. Without the signal, one-sided quoting just accumulates position in the wrong direction.
SOURCE: https://www.bitget.com/news/detail/12560604971542 (via search summary)

### Strategy 3: Passive Maker Ladder
Dense post-only ladders at multiple price levels. Earn 0.015% fee savings per fill (vs taker paying 0.045%) plus any spread. No net rebate at Tier 0, but significant fee reduction vs taker strategies.

FINDING: At $130 capital, the main maker benefit is NOT rebate income but fee savings. Using maker vs taker on 50 round trips/day at $90 notional saves: 50 x 2 x $90 x (0.045% - 0.015%) = $2.70/day in fees avoided.
SOURCE: NOVEL - calculated from confirmed fee structure

---

## HONEST ASSESSMENT: CAN THIS WORK AT $130?

### What works:
1. Fee savings: Maker vs taker saves $2.70/day on 50 round trips. Real and guaranteed.
2. Reduced toxic flow: HL's cancel priority means maker orders are less likely to be front-run.
3. Free order management: No gas on cancels means iterating on quotes costs nothing.

### What does NOT work:
1. Rebate farming: Requires >$1M/day volume. Impossible at $130 capital without 10,000x daily turnover.
2. Pure spread capture without direction: Inventory risk will exceed fee income on trending markets.
3. The "$6800 to $1.5M" playbook: That account had institutional infrastructure, $200k+ working capital, and generated 3%+ of HL maker volume over 14 days.

### The real bar:
To earn $10/day net (covering $1.35 in fees + $9.10 profit target) on 50 round trips at $90 notional:
- Need average edge of 0.116% per trade on notional
- At 10x leverage: 0.0116% average price move captured per underlying trade
- This is achievable with a solid short-term directional signal + maker execution to reduce fees
- It is NOT achievable through rebates alone at this scale

FINDING: HFT maker-only strategy at $130 capital is viable as a FEE-REDUCTION layer on top of a directional strategy, NOT as a standalone rebate farming approach. The maker fee saves 0.030% per round-trip vs taker. Over 50 daily round trips, that's $2.70/day in fee savings - meaningful on $130 capital (2%/day compounding).
SOURCE: NOVEL - synthesized from fee structure + volume math

---

## RECOMMENDATION

The only viable HFT angle for a $130 account is:
1. Use ALO orders on all limit entries to pay 0.015% instead of 0.045% (saves 67% on fees)
2. Combine with a short-term directional signal (existing GARCH/ST or a new 1m/5m signal)
3. Do NOT expect rebates - the threshold to earn rebates requires institutional volume

Pure market-making (no directional prediction, just spread capture) is theoretically possible but requires fill rate data and backtesting to validate against inventory risk on our specific 25 pairs.

Next step: Live test ALO fill rates on 3-4 of our pairs (WIF, DOGE, LINK, HYPE) by placing tight limit orders and measuring fill time vs spread capture. 1-week paper test minimum before any capital allocation.
