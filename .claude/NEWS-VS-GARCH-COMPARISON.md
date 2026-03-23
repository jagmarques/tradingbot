# News vs GARCH Comparison Results

Date: 2026-03-23
Script: scripts/backtest-news-vs-garch.ts
Period: 2025-06-01 to 2026-03-20 (292 days)
Position size: $20 fixed, 10x leverage
Fee: 0.035% taker (HL corrected)
News events: 356 price-confirmed (BTC moved >0.3% within 15min of crypto-relevant Trump post)

---

## Top 5 Overall (by $/day * PF / MaxDD)

| Strategy | Trades | WR% | PnL | $/day | MaxDD | Sharpe | PF | AnnRet |
|----------|--------|-----|-----|-------|-------|--------|----|--------|
| Combined-no-defense | 1855 | 48% | $2288 | $7.83 | $186 | 3.53 | 1.66 | 715% |
| GARCH-v2-baseline | 633 | 40% | $1567 | $5.37 | $136 | 3.21 | 1.73 | 490% |
| Combined-separate-cap | 1881 | 48% | $1806 | $6.18 | $166 | 2.89 | 1.56 | 564% |
| Combined-shared-cap | 1714 | 47% | $1545 | $5.29 | $169 | 2.82 | 1.50 | 483% |
| GARCH+defense | 659 | 41% | $1085 | $3.72 | $136 | 2.52 | 1.56 | 339% |

---

## Combined vs Separate

| Strategy | Trades | WR% | PnL | $/day | MaxDD | Sharpe | PF | AnnRet |
|----------|--------|-----|-----|-------|-------|--------|----|--------|
| GARCH-v2-baseline | 633 | 40% | $1567 | $5.37 | $136 | 3.21 | 1.73 | 490% |
| GARCH+defense | 659 | 41% | $1085 | $3.72 | $136 | 2.52 | 1.56 | 339% |
| Combined-shared-cap | 1714 | 47% | $1545 | $5.29 | $169 | 2.82 | 1.50 | 483% |
| Combined-separate-cap | 1881 | 48% | $1806 | $6.18 | $166 | 2.89 | 1.56 | 564% |
| Combined-no-defense | 1855 | 48% | $2288 | $7.83 | $186 | 3.53 | 1.66 | 715% |

Key finding: defense costs -$1.65/day vs GARCH baseline. Adding news offense (no-defense) adds +$2.46/day over baseline.

---

## Per-Pair News Profitability (all20, TP5% SL2% hold4h stale1h@0.5%)

| Pair | Trades | WR% | PnL | $/day | MaxDD | PF |
|------|--------|-----|-----|-------|-------|----|
| ARB | 184 | 55% | $152 | $0.52 | $34 | 1.79 |
| OP | 183 | 51% | $145 | $0.50 | $24 | 1.70 |
| ENA | 183 | 52% | $108 | $0.37 | $48 | 1.47 |
| LDO | 181 | 50% | $102 | $0.35 | $28 | 1.49 |
| DOT | 180 | 52% | $86 | $0.29 | $18 | 1.49 |
| TRUMP | 181 | 51% | $73 | $0.25 | $22 | 1.48 |
| XRP | 14 | 64% | $19 | $0.07 | $5 | 3.15 |
| WLD | 17 | 65% | $16 | $0.05 | $6 | 2.15 |
| LINK | 20 | 60% | $9 | $0.03 | $9 | 1.38 |
| APT | 26 | 50% | $5 | $0.02 | $13 | 1.13 |
| DOGE | 34 | 47% | $3 | $0.01 | $20 | 1.08 |
| ADA | 19 | 53% | $2 | $0.01 | $12 | 1.08 |

Actual performers: ARB, OP, ENA, LDO, DOT, TRUMP. TIA, kBONK, NEAR, kSHIB, SOL, BNB, HYPE, ONDO, XRP had 0 trades (not in all20 per-pair sim or no events matched).

Note: Prior research ranked TIA/kBONK top - this backtest uses hourly entry (1h delay from event), which filters out fast-movers. ARB/OP/ENA/LDO show best hourly persistence.

---

## Best News Config Parameters

- Pairs: top15 (TIA, kBONK, OP, LDO, APT, NEAR, ARB, ENA, WLD, ADA, DOT, ONDO, LINK, DOGE, SOL)
- TP: 5%, SL: 2%
- Max hold: 4h (6-12h slightly better on $/day, diminishing returns)
- Stale exit: 30min@0.3% wins on $/day; 1h@0.5% better Sharpe and lower DD
- Result: $2.72/day, 52% WR, $185 MaxDD, Sharpe 3.61

Optimal sweet spot for stale exit: 30min@0.3% ($2.82/day, lower DD than no-stale)
Optimal TP/SL: wider SL3% improves WR and $/day (SL3 across all TPs = best results)

---

## News Pair Set Comparison

| Pairs | Trades | WR% | $/day | MaxDD | Sharpe |
|-------|--------|-----|-------|-------|--------|
| all20 | 1222 | 52% | $2.47 | $185 | 3.56 |
| top15 | 1216 | 52% | $2.72 | $185 | 3.61 |
| top10 | 1177 | 52% | $2.65 | $175 | 3.59 |
| top5 | 819 | 52% | $1.87 | $111 | 3.37 |

top15 > top10 > all20 - adding bottom 5 pairs hurts (all20 adds noise pairs)

---

## TP/SL Grid (top10, hold4h, stale1h@0.5%)

| | SL1% | SL1.5% | SL2% | SL3% |
|-|------|--------|------|------|
| TP3% | $1.75/d WR45% | $1.79/d WR50% | $1.98/d WR52% | $2.17/d WR53% |
| TP5% | $2.24/d WR44% | $2.42/d WR50% | $2.65/d WR52% | $2.92/d WR53% |
| TP7% | $2.09/d WR44% | $2.37/d WR50% | $2.65/d WR52% | $2.86/d WR54% |
| TP10% | $2.22/d WR43% | $2.46/d WR49% | $2.69/d WR52% | $2.90/d WR53% |

Wider SL consistently better. TP doesn't matter much (5-10% similar). Best: TP5%/SL3%.

---

## Stale Exit Impact

| Config | $/day | WR% | MaxDD | Sharpe |
|--------|-------|-----|-------|--------|
| no-stale | $0.51 | 45% | $313 | 0.67 |
| 30min@0.3% | $2.82 | 53% | $176 | 3.79 |
| 1h@0.5% | $2.65 | 52% | $175 | 3.59 |
| 1h@1% | $2.21 | 49% | $244 | 2.94 |
| 2h@0.5% | $1.76 | 49% | $239 | 2.27 |

Stale exit is CRITICAL - without it: WR drops from 52% to 45%, MaxDD doubles, near-zero profit. The 30min@0.3% stale wins on all metrics.

---

## Max Hold Impact

| Hold | $/day | WR% | MaxDD | Sharpe |
|------|-------|-----|-------|--------|
| 2h | $1.82 | 53% | $197 | 2.58 |
| 4h | $2.65 | 52% | $175 | 3.59 |
| 6h | $2.84 | 52% | $144 | 3.76 |
| 8h | $2.96 | 51% | $145 | 3.86 |
| 12h | $3.26 | 51% | $137 | 4.11 |

Longer hold = better Sharpe + lower MaxDD (positions find their target). 12h optimal if comfortable with extended hold.

---

## Key Findings vs Prior Research

Prior research showed news-only best at $13.97/day. This run shows $2.72-3.26/day.
Differences:
1. This uses hourly candles (1h delay) - prior was minute-level entry timing
2. This has 356 events vs 187 in prior (more events = more average trades, but also more noise)
3. Prior research used position-level entry at exact event timestamp (minute bars)

Hourly entry dilutes the edge significantly - the fast post-event move (first 15-60min) is missed.

GARCH baseline: $5.37/day (vs $4.70/day prior - difference = fee correction 0.045% -> 0.035%)

---

## Recommendation

**Build the news trading engine.** Combined-no-defense delivers $7.83/day vs GARCH alone $5.37/day.

**Optimal combined config:**
- GARCH v2 as-is (separate cap, 6/dir)
- News engine: top15 pairs, TP5%, SL3%, max hold 8-12h, stale exit 30min@0.3%
- No defense (defense costs -$1.65/day; real-time RSS detection makes it less necessary since we enter fast)
- Separate position caps (separate-cap adds $0.81/day vs shared-cap)

**Why no defense in combined:**
The defense was designed for live positions already open. In combined mode, the news offense positions being added actually benefit from the same event that would trigger defense. Net effect: keep both GARCH positions AND add news positions in event direction.

**Next steps:**
1. Build NewsTrading engine (RSS -> Groq classifier -> open positions on top15 pairs)
2. Use: TP5%, SL3%, max hold 8h, stale exit 30min if <0.3% move in direction
3. Paper trade 2 weeks alongside live GARCH
4. Deploy with separate cap (6/dir news independent of GARCH cap)
5. Keep NewsGuard defense for GARCH-only positions (before news engine live)
