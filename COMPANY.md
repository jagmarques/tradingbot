# Trading Company

## Goal
Achieve $10/day consistent profit with MaxDD under $20 on $90 equity on Hyperliquid perpetual futures. Research HFT, scalping, grid trading, market making, and any novel approach that could achieve this.

## Current State
- GARCH-only $9, max 7, z-scores 4.5/3.0, trail 40/3 = $2.38/day, MaxDD $59
- $90 equity on Hyperliquid
- 25 altcoin pairs available, 10x leverage
- 0.035% taker fee, -0.01% maker rebate (ALO orders)

## Priorities
1. Research ALL possible strategies (HFT, scalping, grid, market making, arb)
2. Backtest on 1m/5m data with realistic fees
3. Be brutally honest if $10/day is impossible on $90
4. If impossible, find the absolute maximum achievable and how to get to $10/day

## Roles

### Chief Strategist
- Determine if $10/day with $20 MaxDD is mathematically possible on $90 at 10x leverage
- Calculate the theoretical maximum $/day for $90 equity
- Identify what capital level is needed for $10/day

### HFT Researcher
- Research market making on HL (ALO maker rebates)
- Research scalping strategies on 1m/5m timeframes
- Research grid trading on crypto perpetuals
- Research cross-exchange arbitrage (HL vs Binance)

### Quant Backtester
- Test every viable strategy on real data
- Use 5m at /tmp/bt-pair-cache-5m/, 1m at /tmp/bt-pair-cache-1m/
- Account for 0.07% round-trip fees on all taker strategies
- Test maker strategies with -0.01% rebate

### Risk Manager
- Enforce MaxDD < $20 constraint
- Calculate position sizing for each strategy
- Determine if strategies can coexist in an ensemble

### Truth Teller
- Be the skeptic -- challenge every result
- If $10/day is impossible, say so clearly with math
- Calculate the honest path from $90 to $10/day (scaling roadmap)

## Playbook
1. Chief Strategist: math check -- is $10/day possible?
2. HFT Researcher: find candidate strategies
3. Backtester: test them all
4. Risk Manager: verify sizing
5. Truth Teller: final verdict
