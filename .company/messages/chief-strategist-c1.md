# Chief Strategist Analysis: $10/day / $10 MaxDD on $90 Equity

Date: 2026-03-29

## Parameters

- Equity: $90, 10x leverage
- Max positions: 10 → $9 margin per trade → $90 notional per trade
- Maker rebate: -0.01% per fill ($0.009 per fill at $90 notional)
- Taker fee: 0.035% per fill ($0.0315 per fill at $90 notional)
- Target: $10+/day, MaxDD < $10

---

## 1. Pure Rebate Farming (no directional edge)

- Rebate per round trip (both sides maker): $0.018
- Round trips needed for $10/day: **556**
- Daily notional volume: $50,000 on $90 equity = **556x capital turns**
- At 2 min minimum per RT: 1,111 minutes = 18.5 hours

**Verdict: Physically impractical.** Requires near-continuous 18.5h/day at 2 min/RT with zero gaps. Any slippage, missed fill, or downtime makes this fail. 50 RT/day produces only $0.90.

---

## 2. Rebate + Spread Capture

| Spread | Profit/RT | 50 RTs/day | RTs needed for $10 |
|--------|-----------|------------|---------------------|
| 0.02%  | $0.036    | $1.80/day  | 278 RTs             |
| 0.03%  | $0.045    | $2.25/day  | 222 RTs             |
| 0.05%  | $0.063    | $3.15/day  | 159 RTs             |

**Verdict: Not viable at 50 RTs/day.** Even at 0.05% spread (wide for liquid HL alts), 50 RTs gives only $3.15/day. Need 159-278 RTs for $10, which is operationally the same problem as pure rebate farming.

---

## 3. Directional Edge (50 trades/day, maker entry + maker TP + taker SL)

Fee structure per trade:
- Win: +TP% × $90 + 2 × 0.01% × $90 (two maker fills)
- Loss: -SL% × $90 - (0.035% - 0.01%) × $90 (entry maker, SL taker)

| WR  | TP%  | SL%  | EV/trade | EV/day  | PF   | Achieves $10? |
|-----|------|------|----------|---------|------|---------------|
| 55% | 0.30 | 0.15 | $0.0875  | $4.38   | 2.23 | No            |
| 55% | 0.50 | 0.20 | $0.1663  | $8.31   | 2.82 | No            |
| 60% | 0.30 | 0.15 | $0.1098  | $5.49   | 2.74 | No            |
| 60% | 0.50 | 0.20 | $0.1998  | **$9.99** | 3.47 | Borderline  |
| **65%** | **0.50** | **0.20** | **$0.2333** | **$11.67** | **4.29** | **Yes** |
| 65% | 0.50 | 0.15 | $0.2491  | $12.45  | 5.52 | Yes           |
| 70% | 0.50 | 0.20 | $0.2668  | $13.34  | 5.39 | Yes           |

**Minimum viable:** WR65, TP0.5%, SL0.2% → $11.67/day at 50 trades.

Break-even WR at TP0.5%/SL0.2%: **30.2%** — the R:R is so favorable (2.5:1) that even a 30% win rate is theoretically profitable.

---

## 4. MaxDD Analysis ($90 notional, 50 trades/day)

| SL%  | Loss/trade | Consecutive losses for $10 DD |
|------|------------|-------------------------------|
| 0.15% | $0.1575  | 63.5                          |
| 0.20% | $0.2025  | 49.4                          |
| 0.25% | $0.2475  | 40.4                          |

At SL0.2%, P(49 consecutive losses) = 0.35^49 ≈ 0%. The MaxDD constraint is extremely safe on a per-trade basis.

**However:** The $10 MaxDD is 11.1% of equity. If the strategy enters a regime shift (WR drops from 65% to 40% for a day), EV/day = -$1.78, and sustained degradation over 5 days = -$8.90. The MaxDD constraint can be breached by strategy failure, not individual trade losses.

---

## 5. The Critical Question: Is WR65 / TP0.5% / SL0.2% achievable on 1m bars?

### The fundamental contradiction

At TP0.5% / SL0.2%, the R:R is 2.5:1. This means you only need 30% WR to break even. Claiming 65% WR means you are predicting direction correctly 65% of the time on 1m bars — 2x the minimum needed. That implies extraordinary edge.

**What academic research says:**
- 1m bar directionality is dominated by noise (Hasbrouck, 1991; Lo & MacKinlay, 1988)
- Market microstructure creates short-term predictability but it decays within seconds, not minutes
- Strategies showing 65%+ WR on 1m bars in backtest almost universally suffer severe live degradation

### The adverse selection problem

To enter with maker orders you must place a limit order and wait for price to come to you. For a directional trade:
- You want price to go UP after entry → you post bid
- Price must move DOWN to fill your bid
- This means you are filled exactly when price is moving against you
- By the time you are filled, the short-term momentum is against you

This is the **adverse selection tax on maker directional entries.** It directly erodes WR. Studies show maker-only directional strategies underperform taker entries by 8-15% in WR on sub-1h timeframes.

### Realistic live degradation

| Scenario | WR | EV/day |
|----------|----|--------|
| Backtest target | 65% | $11.67 |
| Typical live degradation (-7%) | 58% | $9.32 |
| Adverse selection hit (-12%) | 53% | $6.42 |
| Regime shift | 45% | $1.17 |
| Break-even | 30.2% | $0.00 |

At WR58 (realistic live), you are at $9.32/day — just below target. Any further degradation puts you negative vs target.

---

## 6. The Return Problem

$10/day on $90 equity = **11.1% daily return**.

- Monthly: 333% compounded
- Annual: 5,000,000%+

This is not achievable sustainably. For comparison:
- Best HFT firms: 0.01-0.1% daily on deployed capital
- Top quant funds: 0.05-0.2% daily
- Aggressive retail scalpers: 0.1-0.5% daily

**$10/day on $90 requires 11.1% daily.** The math only works if you believe the same $90 of capital is being recycled 50 times per day with fresh edge each time — which is precisely what you cannot guarantee with maker-only entries.

Realistic targets:
- $0.45-0.90/day: pure rebate at 50 RTs
- $1.00-2.25/day: rebate + spread at 50 RTs
- $2-5/day: directional at WR55-60%, 50 trades
- **$10/day requires ~$450-500 equity at the same strategy parameters**

---

## 7. Verdict

| Strategy | Viable for $10/day? | Realistic daily |
|----------|--------------------|-----------------|
| Pure rebate farming | No (18.5h of fills) | $0.90 at 50 RT |
| Rebate + spread capture | No (need 222 RT) | $2.25 at 50 RT |
| Directional WR60 | Borderline ($9.99) | $5-8 after degradation |
| Directional WR65 | On paper yes | $7-12 with live variance |

**MaxDD $10:** Safe from individual losses (need 49 consecutive losses). Vulnerable to regime shifts over 5+ days.

**Honest assessment:**

$10/day with $10 MaxDD on $90 equity is theoretically possible only under one condition: a directional signal on 1m bars achieving 65%+ WR with TP0.5%/SL0.2% that degrades less than 7% in live trading. No such signal is known to exist robustly.

The target implies 11.1% daily return — 3-4 orders of magnitude above what institutional HFT achieves. The correct capital to target $10/day at realistic parameters (WR55-60%, 0.3-0.5% TP) is $450-1,000.

**Recommendation:** Lower the daily target to $1-2/day on $90, or increase capital to $450+ to target $10/day.
