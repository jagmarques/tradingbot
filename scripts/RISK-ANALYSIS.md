# Risk Analysis - $90 Equity, 10x Leverage

Date: 2026-03-29
Equity: $90
Leverage: 10x
GARCH SL: 3% fixed → loss per dollar = size × 0.30
ST SL: 3.5% ATR-capped → loss per dollar = size × 0.35

---

## Config 1: GARCH $9 only, max 8 positions

| Metric | Value |
|---|---|
| Max margin deployed | 8 × $9 = $72 |
| Margin utilization | $72 / $90 = **80.0%** |
| Margin buffer | $90 − $72 = **$18** |
| Max single SL loss | $9 × 0.30 = **$2.70** |
| Max simultaneous SL (all 8) | 8 × $2.70 = **$21.60** |
| Equity after worst case | $90 − $21.60 = **$68.40** |
| Liquidation risk | Low — $18 buffer covers 2× worst single loss |

Notes: Max simultaneous loss is 24% of equity. Comfortable buffer. Realistic worst case is 3-4 positions stopping simultaneously (~$8-11 loss).

---

## Config 2: GARCH $7 only, max 8 positions

| Metric | Value |
|---|---|
| Max margin deployed | 8 × $7 = $56 |
| Margin utilization | $56 / $90 = **62.2%** |
| Margin buffer | $90 − $56 = **$34** |
| Max single SL loss | $7 × 0.30 = **$2.10** |
| Max simultaneous SL (all 8) | 8 × $2.10 = **$16.80** |
| Equity after worst case | $90 − $16.80 = **$73.20** |
| Liquidation risk | Very low — $34 buffer, 18.7% max drawdown |

Notes: Conservative. Underutilizes capital at 62%. Max simultaneous loss is only 18.7% of equity.

---

## Config 3: GARCH $5 only, max 8 positions

| Metric | Value |
|---|---|
| Max margin deployed | 8 × $5 = $40 |
| Margin utilization | $40 / $90 = **44.4%** |
| Margin buffer | $90 − $40 = **$50** |
| Max single SL loss | $5 × 0.30 = **$1.50** |
| Max simultaneous SL (all 8) | 8 × $1.50 = **$12.00** |
| Equity after worst case | $90 − $12.00 = **$78.00** |
| Liquidation risk | Negligible — 13.3% max drawdown |

Notes: Very safe but only 44% capital utilization. Returns will be lower relative to equity. Too conservative for $90.

---

## Config 4: GARCH $5 + ST $3, max 8 positions

Assume worst case: all 8 slots filled by the higher-loss engine (GARCH $5 for absolute loss, but ST $3 has higher SL rate).

Per-position SL loss: GARCH = $5 × 0.30 = $1.50 | ST = $3 × 0.35 = $1.05

Worst case: all 8 slots are GARCH $5.

| Metric | Value |
|---|---|
| Max margin deployed (8 GARCH) | 8 × $5 = $40 |
| Max margin deployed (8 ST) | 8 × $3 = $24 |
| Max margin deployed (mixed 4+4) | 4 × $5 + 4 × $3 = $32 |
| Margin utilization (worst: 8 GARCH) | $40 / $90 = **44.4%** |
| Margin buffer (worst) | **$50** |
| Max single SL loss (GARCH) | **$1.50** |
| Max single SL loss (ST) | **$1.05** |
| Max simultaneous SL (8 GARCH) | 8 × $1.50 = **$12.00** |
| Max simultaneous SL (8 ST) | 8 × $1.05 = **$8.40** |
| Max simultaneous SL (4+4 mixed) | 4 × $1.50 + 4 × $1.05 = **$10.20** |
| Equity after worst case (8 GARCH) | $90 − $12.00 = **$78.00** |
| Liquidation risk | Negligible |

Notes: Both engines combined stay well below 50% margin utilization. Very safe. Mirrors current live config scaled down from $130 → $90.

---

## Config 5: GARCH $7 + ST $3, max 7 positions

Worst case: all 7 slots are GARCH $7.

| Metric | Value |
|---|---|
| Max margin deployed (7 GARCH) | 7 × $7 = $49 |
| Max margin deployed (7 ST) | 7 × $3 = $21 |
| Max margin deployed (mixed ~4G+3ST) | 4 × $7 + 3 × $3 = $37 |
| Margin utilization (worst: 7 GARCH) | $49 / $90 = **54.4%** |
| Margin buffer (worst) | $90 − $49 = **$41** |
| Max single SL loss (GARCH) | $7 × 0.30 = **$2.10** |
| Max single SL loss (ST) | $3 × 0.35 = **$1.05** |
| Max simultaneous SL (7 GARCH) | 7 × $2.10 = **$14.70** |
| Max simultaneous SL (7 ST) | 7 × $1.05 = **$7.35** |
| Max simultaneous SL (4G+3ST) | 4 × $2.10 + 3 × $1.05 = $8.40 + $3.15 = **$11.55** |
| Equity after worst case (7 GARCH) | $90 − $14.70 = **$75.30** |
| Liquidation risk | Very low — 16.3% max drawdown |

Notes: Good balance. GARCH $7 provides meaningful per-trade returns. 54% max utilization keeps risk manageable.

---

## Maximum GARCH Size: Keep Simultaneous SL Under $30 (33% of $90)

Formula: max_positions × size × 0.30 ≤ $30

At max 8 positions: size ≤ $30 / (8 × 0.30) = $30 / 2.40 = **$12.50**
At max 7 positions: size ≤ $30 / (7 × 0.30) = $30 / 2.10 = **$14.29**
At max 6 positions: size ≤ $30 / (6 × 0.30) = $30 / 1.80 = **$16.67**

At the current max 10 cap: size ≤ $30 / (10 × 0.30) = $30 / 3.00 = **$10.00**

For $90 equity, **GARCH $10 with max 10 positions** is the theoretical ceiling before breaching the 33% rule.
However: 10 × $10 = $100 margin > $90 equity — that would exceed available capital.
Corrected ceiling: max_positions = floor($90 / $10) = 9, and 9 × $10 × 0.30 = $27.00 < $30. Safe.
Or simply: GARCH $10, max 9 = $27 worst loss (30% of equity). Margin = $90 = 100% utilization — too aggressive.

Practical ceiling: **GARCH $9, max 8** — margin $72 (80%), worst loss $21.60 (24%). Well inside the $30 limit.

---

## Summary Comparison

| Config | Margin Used | Utilization | Max Single Loss | Max Simultaneous Loss | Buffer | DD% |
|---|---|---|---|---|---|---|
| GARCH $9, 8 max | $72 | 80% | $2.70 | $21.60 | $18 | 24.0% |
| GARCH $7, 8 max | $56 | 62% | $2.10 | $16.80 | $34 | 18.7% |
| GARCH $5, 8 max | $40 | 44% | $1.50 | $12.00 | $50 | 13.3% |
| GARCH $5 + ST $3, 8 max | $40 | 44% | $1.50 / $1.05 | $12.00 | $50 | 13.3% |
| GARCH $7 + ST $3, 7 max | $49 | 54% | $2.10 / $1.05 | $14.70 | $41 | 16.3% |

---

## Recommendation

**GARCH $9, max 8** is the best single-engine config for $90:
- 80% capital utilization (efficient)
- $2.70 max single loss (acceptable)
- $21.60 worst-case total loss (24% DD, within tolerance)
- $18 buffer protects against simultaneous stops

**GARCH $7 + ST $3, max 7** is the best two-engine config:
- 54% utilization (room to grow)
- $14.70 worst-case loss (16.3% DD, very safe)
- Two independent signals reduce correlation risk

Do not exceed **GARCH $10 with 8+ positions** — that pushes simultaneous SL above $24 and margin utilization to 89%+, leaving insufficient buffer for gap risk.
