# HFT Researcher Report - Cycle 2: Hyperliquid-Specific Edges

Date: 2026-03-29
Agent: HFT Researcher
Cycle: 2 (Standard HFT failed in Cycle 1 — investigating HL-native edges)

---

## CONTEXT FROM CYCLE 1

Cycle 1 established that maker-only fee rebate farming is impossible at $130 capital
(requires >$1M/day volume to reach rebate tiers). The real Cycle 1 conclusion: maker
orders are a fee-reduction layer on directional strategies, not a standalone strategy.

This cycle focuses on Hyperliquid-specific structural edges: hourly funding, transparent
liquidation engine, on-chain order book, HLP vault reverse-engineering, and builder codes.

---

## FINDING 1: HOURLY FUNDING — 3x MORE EVENTS, BUT MATH IS TIGHT

Hyperliquid pays funding every hour at 1/8 of the 8-hour computed rate.
Formula: F = Average Premium Index (P) + clamp(interest - P, -0.0005, 0.0005)
Fixed interest component: 0.00125%/hour (11.6% APR, always paid to shorts)
Cap: 4% per hour maximum (much higher ceiling than Binance's 0.75% per 8h)
Premium sampled every 5 seconds, averaged per hour.

FINDING: Break-even for spot-perp delta-neutral arb requires >0.11%/hour funding
(maker orders) or >0.15%/hour (realistic minimum for profit). Full round-trip cost
is 0.11% (spot buy 0.04% + perp short 0.015% + spot sell 0.04% + perp close 0.015%).
SOURCE: https://docs.chainstack.com/docs/hyperliquid-funding-rate-arbitrage

FINDING: Spot-perp arb is only possible on BTC, ETH, SOL — the handful of pairs
available in both spot and perp on HL. Our 25 traded pairs are perp-only (no HL spot
counterpart), making classic spot-perp hedging structurally impossible for most of them.
SOURCE: https://docs.chainstack.com/docs/hyperliquid-funding-rate-arbitrage + HL docs

FINDING: Tactical funding scalp (enter 10-15 minutes before the hourly funding, exit
immediately after collecting) reduces price exposure to a short window but demands
spreads <0.05% to remain profitable at realistic funding rates. At 0.15%/hour, a
$10,000 position earns $15 gross but pays $11 in fees, netting $4 — 0.04% net.
For our $130 account, that is $0.052/trade, requiring almost perfect execution.
SOURCE: https://docs.chainstack.com/docs/hyperliquid-funding-rate-arbitrage

FINDING: The hourly cadence IS a structural edge vs Binance: 24 funding events/day vs 3.
For funding SIGNAL trading (use extreme funding as a mean-reversion indicator rather
than harvesting it), hourly resolution provides 8x more signal updates per day than CEX.
High positive funding = crowded longs = fade signal. Our GARCH engine already filters
on EMA trend — adding a funding z-score filter could improve precision.
SOURCE: NOVEL — needs validation via backtest on our 25-pair universe

ASSESSMENT: Direct funding harvesting is not viable at $130. Using hourly funding as a
regime/signal filter for existing engines is worth backtesting. Low implementation cost.

---

## FINDING 2: LIQUIDATION CASCADE — HIGH SHARPE CLAIMED, BUT ALPHA IS FAKE

FINDING: A published strategy (Tigro Blanc, Feb 2026) claims +299% cumulative return
and Sharpe 3.58 on 72 liquidation cascade trades over 5-year walk-forward. Entry signal:
BTC -3% within 1 hour + volume >2x 24h average. Hold 48 hours. Mean return: +2.33%.
SOURCE: https://medium.com/@tigroblanc/chasing-liquidation-cascade-alpha-in-crypto-how-to-get-299-return-with-sharpe-3-58-322ef625a8d1

FINDING: Beta decomposition invalidates the strategy. 54% of returns are explained by
BTC movement alone. Regression alpha p-value = 0.182 (not significant). The strategy
is long BTC recovery, not a liquidation cascade edge. The author himself acknowledges
this but presents it as "structural" alpha.
SOURCE: Same article — self-reported statistical disclosure

FINDING: Liquidation data on HL is transparent via API. Liquidation heatmaps are
publicly available (Kiyotaka.ai). However, the liquidation engine itself uses a
whitelist-only architecture: only pre-approved addresses can execute liquidations.
Standard traders cannot front-run liquidations — the whitelist blocks external bots.
SOURCE: https://blog.can.ac/2025/12/20/reverse-engineering-hyperliquid/ (reverse engineering analysis)
SOURCE: https://kiyotaka.ai/blog/liquidation-heatmaps-for-hyperliquid/

FINDING: Liquidation ZONES (areas of dense stop clustering) are visible and can be used
as support/resistance targets. Not front-running, but awareness of structural price
magnets. Glassnode and Kiyotaka provide real-time heatmaps — no custom data pipeline needed.
SOURCE: https://insights.glassnode.com/liquidation-heatmaps/
SOURCE: https://kiyotaka.ai/blog/liquidation-heatmaps-for-hyperliquid/

ASSESSMENT: Cannot front-run liquidations (whitelist blocks this). Cascade signal as
entry trigger is not real alpha — it is just buying BTC dips. Liquidation zone awareness
is a useful filter but not a standalone strategy.

---

## FINDING 3: ORDER BOOK IMBALANCE — REAL SIGNAL, SHORT HORIZON ONLY

FINDING: Order Book Imbalance (OBI) = dollar-weighted bid depth vs ask depth within
N% of mid-price. Academic research confirms near-linear relationship between order
flow imbalance and short-horizon price changes (tens of seconds to a few minutes).
The signal decays rapidly — it is a microstructure signal, not a trend signal.
SOURCE: https://www.buildix.trade/blog/long-short-ratio-is-misleading-order-book-imbalance-better-2026
SOURCE: https://arxiv.org/html/2507.22712v1 (academic: "Order Book Filtration and Directional Signal Extraction at High Frequency")

FINDING: HL's order book is fully on-chain and freely streamable via WebSocket
(`l2Book` subscription). Returns up to 20 levels per side with price, size, and
order count. Public endpoint, no authentication, <100ms latency. This is structurally
identical to CEX order book access — no HL-specific advantage here over Binance.
SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions

FINDING: A public GitHub bot (tar-ser/Hyperliquid-Order-Book-Imbalance-Sniper-Bot)
implements OBI trading on HL. The repo is public, meaning the signal is already being
arbed by others. No backtested results are published by the author. Edge decay from
competition is unknown but likely high given public availability.
SOURCE: https://github.com/tar-ser/Hyperliquid-Order-Book-Imbalance-Sniper-Bot (404 on direct fetch — repo may be removed or private)

FINDING: OBI is useful as a FILTER for existing entries, not a standalone signal at
our 15-minute scheduler cadence. At 15-minute entry checks, by the time our engine
fires, any OBI signal from seconds ago is stale. Would require sub-minute execution
loop to act on OBI directly — architectural change, not a minor addition.
SOURCE: NOVEL — derived from signal decay research + our known scheduler architecture

ASSESSMENT: OBI is a real signal with academic backing but operates on a 10-60 second
horizon. Incompatible with our 15-minute scheduler without architectural overhaul.
Could be used at entry time as a same-second filter: if OBI is strongly adverse when
our signal fires, delay or skip the entry. Low-risk addition to explore.

---

## FINDING 4: HLP VAULT — REVERSE-ENGINEERING SHOWS PROTOCOL RISK, NOT TRADEABLE EDGE

FINDING: HLP has earned ~$375M on $2.5M net deposits. It operates as the backstop
counterparty for unmatched trades and profits primarily from liquidations (buying
distressed positions at favorable prices) and bid-ask spread capture across 100+ pairs.
SOURCE: https://arx.trade/blog/hyperliquid-vaults-explained/
SOURCE: https://blog.can.ac/2025/12/20/reverse-engineering-hyperliquid/

FINDING: HLP does not publish its market-making quotes or position data in real time.
Its on-chain account is observable (trades appear on-chain) but with a lag of block
finality (~1-2 seconds). Reconstructing HLP's quoting behavior from historical trade
data is possible but would require sustained data collection and is unlikely to yield
a stable forward-looking signal — HLP adapts its strategy dynamically.
SOURCE: https://www.chaincatcher.com/en/article/2215058 (HL Head Vault Strategy Analysis)

FINDING: The JELLY incident (March 2025) demonstrates HLP's real risk profile: a
trader manipulated external oracle feeds, forcing HLP to absorb $12M in losses before
Hyperliquid froze the market and overrode prices via admin intervention. This is
protocol-level counterparty risk, not a trading edge we can exploit safely.
SOURCE: https://blog.can.ac/2025/12/20/reverse-engineering-hyperliquid/

FINDING: HL's oracle is controlled by a single privileged address with no timelock,
no deviation bounds, and no multi-sig. Governance can override any price feed.
This is systemic risk — not something to trade around, but important to know as
a capital-at-risk disclosure.
SOURCE: https://blog.can.ac/2025/12/20/reverse-engineering-hyperliquid/

ASSESSMENT: HLP vault signals are not practically reverse-engineerable in real time.
The vault's edge comes from whitelist-only liquidation access and admin-level controls
that are not available to external traders. Watching HLP as a sentiment indicator
is theoretically interesting but has no validated implementation path.

---

## FINDING 5: BUILDER CODES — FEE OFFSET IS REAL, BUT REQUIRES SEPARATE WALLET

FINDING: Builder codes allow an address to earn up to 0.1% per fill on perp trades
routed through it. The builder address collects fees on top of (or instead of) normal
trading fees paid by the user. Requires 100 USDC minimum in the builder perps account.
Max fee: 0.1% per side on perps, 1% on spot (selling side only).
SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes

FINDING: $40M+ in builder code revenue has been earned since launch. Phantom wallet
earns ~$100,000/day. PVP.trade has $7.2M lifetime. This is a real, functioning
revenue mechanism — not theoretical.
SOURCE: https://www.dwellir.com/blog/hyperliquid-builder-codes

FINDING: A self-operated builder setup would require: (1) main wallet approves builder
address for max fee via ApproveBuilderFee action, (2) bot routes all orders through
builder address, (3) builder fee accrues to builder address. Docs do not explicitly
prohibit this but require structural separation between user wallet and builder wallet.
At 0.1% builder fee on a $90 notional trade: $0.09/trade. On 50 daily trades:
$4.50/day gross builder revenue, but this is charged ON TOP of what the user pays —
meaning the user (us) is paying ourselves. It is not a free income source — it is
a cost transfer between our own wallets with no net gain unless we are routing
third-party trades.
SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes + NOVEL calculation

FINDING: Builder codes as a third-party service (building a UI or bot that other
users trade through) IS a viable revenue stream — but that is a product business,
not a trading strategy. Not applicable to our $130 self-operated account.
SOURCE: NOVEL — derived from mechanics + revenue examples

ASSESSMENT: Self-referral builder code setup nets zero (paying ourselves). Only
valuable if routing external user volume. Not a trading edge for a self-operated bot.

---

## FINDING 6: WEBSOCKET + L1 TRANSPARENCY — STRUCTURAL ADVANTAGE IS REAL

FINDING: HL's WebSocket streams l2Book, trades, candles, userEvents, and orderUpdates
with full real-time access. Public endpoint allows 100 simultaneous connections and
1,000 subscriptions. No authentication required for market data. Block finality
is ~1-2 seconds, faster than most L1s but slower than a CEX matching engine.
SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
SOURCE: https://www.dwellir.com/blog/how-to-use-hyperliquid-orderbook-server

FINDING: ALO (post-only) orders are prioritized in block ordering above GTC/IOC.
This means a bot posting ALO orders gets earlier slot in each block vs taker orders.
Combined with no gas cost on cancels/modifications, this enables free, high-frequency
order management that would cost significant gas on other L1s.
SOURCE: Cycle 1 research (confirmed, carried forward)

FINDING: On-chain trade history allows reconstruction of any wallet's full trading
history. HLP, whale wallets, and known vault addresses are observable. A wallet
monitoring service could detect when large accounts are accumulating — a form of
on-chain copy trading without needing off-chain intelligence.
SOURCE: https://blog.can.ac/2025/12/20/reverse-engineering-hyperliquid/ + NOVEL

FINDING: Cross-exchange funding divergence between HL and Binance/Bybit is a
documented signal source. When HL funding diverges significantly from Binance
(e.g., HL pays 0.15%/hr while Binance pays 0.01%/8h), it indicates excess directional
positioning on HL specifically. This is an HL-native sentiment signal not visible
on other exchanges. Mean-reversion from extreme HL-only funding divergence is untested
but theoretically sound.
SOURCE: https://medium.com/@tigroblanc/chasing-liquidation-cascade-alpha-in-crypto-how-to-get-299-return-with-sharpe-3-58-322ef625a8d1 (Composite Fragility Index methodology)
SOURCE: NOVEL — applying CFI concept to HL-specific divergence

---

## SYNTHESIS: RANKED OPPORTUNITIES FOR $130 ACCOUNT

### TIER 1 — Actionable with low implementation cost

1. HOURLY FUNDING Z-SCORE AS ENTRY FILTER
   Add funding rate z-score (relative to 30-day rolling mean, per-asset) as a filter
   on GARCH engine entries. Skip longs when funding is already extremely positive
   (crowded longs about to get squeezed). Skip shorts when funding is deeply negative.
   Implementation: hourly funding fetch from HL API, rolling z-score, add as boolean
   filter to existing GARCH entry check. ~1 day of work. Backtestable on existing data.
   SOURCE: NOVEL — derived from funding mechanics + existing GARCH architecture

2. OBI AS SAME-SECOND ENTRY CONFIRMATION
   At the moment GARCH/ST fires an entry signal, fetch live l2Book and compute OBI
   for top 5 levels. If OBI strongly opposes direction (e.g., 3:1 ask-heavy for a
   long entry), delay 1-2 minutes and re-check before entering. Not a standalone
   signal — a friction filter to avoid entering into immediate adverse flow.
   Implementation: single l2Book fetch at entry time, OBI calculation, threshold gate.
   ~half day of work. No backtest needed — it is a conservative filter.
   SOURCE: NOVEL — derived from OBI research + HL WebSocket availability

### TIER 2 — Potentially interesting, requires validation

3. HL-SPECIFIC FUNDING DIVERGENCE SIGNAL
   Monitor funding rate divergence between HL and Binance for the same asset.
   When HL funding is >3 std devs above Binance for an asset, the position is
   overcrowded on HL specifically. Use as a stronger GARCH short entry trigger or
   existing long exit signal. Requires fetching Binance funding data alongside HL.
   SOURCE: NOVEL — needs backtest validation

4. LIQUIDATION ZONE AVOIDANCE
   Use Kiyotaka or HL's own liquidation data to identify dense stop clusters within
   1-3% of current price. Avoid entering positions where a small adverse move would
   trigger a cascade through our stop and beyond. Reduces getting stopped by cascade
   rather than genuine trend reversal.
   SOURCE: https://kiyotaka.ai/blog/liquidation-heatmaps-for-hyperliquid/

### TIER 3 — Not viable for $130 self-operated account

5. Spot-perp funding arbitrage: Requires BTC/ETH/SOL spot on HL + >0.15%/hr funding.
   Even then, $4/trade on a $10,000 position = impractical at $130.

6. Builder code self-referral: Nets zero (cost transfer between own wallets).

7. HLP reverse-engineering: No real-time signal; whitelist advantage not replicable.

8. Liquidation front-running: Whitelist-blocked; external bots cannot execute.

---

## HONEST ASSESSMENT

The two genuinely HL-specific advantages available to a $130 account are:
(a) ALO order priority = cheaper, less toxic maker fills (validated in Cycle 1)
(b) Hourly funding resolution = 8x more regime signal updates per day vs CEX

Everything else — liquidation cascades, HLP signals, builder codes — either requires
institutional scale, whitelist access, or nets zero at self-operated scale.

The highest-ROI addition is the hourly funding z-score filter on GARCH entries.
It costs <1 day to implement, is backtestable, and directly addresses one of GARCH's
known failure modes: entering long into an already-crowded, high-funding environment.
