> **Update (2026-03-24):** Live engine now uses adaptive trailing by impact level (HIGH: 5%/2%, MEDIUM: 2%/1%, LOW: 1%/0.5%). Reversal logic added: stronger opposing signal closes all positions and reverses. Backtest used fixed 5%/2% trail - live results will differ slightly across impact tiers.

# Final Results - March 24, 2026 (Corrected)

## Winning Strategy: News Trading (trail-only, all 20 pairs, no cap)

| Metric | Value |
|--------|-------|
| Events (Trump-only) | 73 (with trend filter) |
| Trades | 768 |
| Win Rate | 74% |
| PnL | $8,897 |
| $/day | $30.47 |
| MaxDD | $100 |
| Sharpe | 2.85 |
| Profit Factor | 25.16 |
| SL | 2% (20% margin at 10x) |
| TP | None - trail only |
| Trail | 5% activate, 2% distance |
| Stale exit | 1h if < 0.3% directional move |
| Max hold | 24h |

Note: Backtest uses Trump posts only (~0.25 events/day). Live system has 9 RSS + Tavily = estimated 1+ events/day.

## Audit Fixes Applied
- 0.1% slippage modeled
- Per-event risk cap (4% split across pairs)
- $500 max position per pair
- Stale exit uses directional move (not absolute)
- Orphan detection skips news-trade pairs
- Defense only closes garch-chan positions

---

# News vs GARCH Comparison Results (v2 - corrected)

Date: 2026-03-23
Script: scripts/backtest-news-vs-garch.ts
Period: 2025-06-01 to 2026-03-20 (292 days)
Position size: $20 fixed, 10x leverage
Fee: 0.035% taker (HL corrected)
News events: 163 price-confirmed (BTC moved >0.3% within 15min of crypto-relevant Trump post)
Direction split: 75 BULLISH, 88 BEARISH

## Fixes Applied (v2)

1. **Tighter keyword list** - removed "rate", "tax", "economy", "shutdown", "china", "russia", "iran", etc. that matched non-crypto posts. Events: 356 -> 163 (closer to prior research's 187)
2. **Same-bar entry** - news entry now uses the SAME hourly bar's open where event falls (not next bar). If event at hour X minute 5, enter at hour X open. Simulates real-time RSS detection (3-11s latency)
3. **Stale exit hourly granularity** - 30min stale can't fire until next hourly bar anyway, so relabeled to 1h@0.3% (honest minimum granularity with 1h data)
4. **Mark-to-market MaxDD** - equity curve now includes unrealized P&L of open positions at each bar, not just realized trade P&L. MaxDD is more realistic (higher for GARCH: $320 vs prior $136)
5. **Direction tiebreaker** - when both up and down exceed 0.3% threshold in 15min window, takes the larger absolute move (not always bullish first)

---

## Top 5 Overall (by $/day * PF / MaxDD)

| Strategy | Trades | WR% | PnL | $/day | MaxDD | Sharpe | PF | AnnRet |
|----------|--------|-----|-----|-------|-------|--------|----|--------|
| News-top10-TP10-SL3 | 416 | 69% | $1059 | $3.63 | $46 | 8.12 | 4.92 | 331% |
| News-top10-TP7-SL3 | 420 | 69% | $1027 | $3.52 | $46 | 8.15 | 4.72 | 321% |
| News-top10-TP10-SL2 | 416 | 67% | $1006 | $3.44 | $48 | 7.56 | 4.22 | 314% |
| News-top10-TP7-SL2 | 420 | 67% | $976 | $3.34 | $48 | 7.61 | 4.08 | 305% |
| News-top10-TP10-SL1.5 | 416 | 65% | $975 | $3.34 | $48 | 7.26 | 3.96 | 305% |

---

## Combined vs Separate

| Strategy | Trades | WR% | PnL | $/day | MaxDD | Sharpe | PF | AnnRet |
|----------|--------|-----|-----|-------|-------|--------|----|--------|
| GARCH-v2-baseline | 633 | 40% | $1567 | $5.37 | $320 | 3.21 | 1.73 | 490% |
| GARCH+defense | 631 | 41% | $1409 | $4.82 | $320 | 3.05 | 1.70 | 440% |
| Combined-shared-cap | 1013 | 51% | $2055 | $7.04 | $320 | 3.74 | 1.89 | 642% |
| Combined-separate-cap | 1062 | 52% | $2236 | $7.66 | $320 | 3.90 | 1.96 | 699% |
| Combined-no-defense | 1064 | 51% | $2394 | $8.20 | $320 | 4.09 | 1.97 | 748% |

Key finding: defense costs -$0.54/day vs GARCH baseline. Adding news offense (no-defense) adds +$2.83/day over baseline.

---

## Per-Pair News Profitability (all20, TP5% SL2% hold4h stale1h@0.5%)

| Pair | Trades | WR% | PnL | $/day | MaxDD | PF |
|------|--------|-----|-----|-------|-------|----|
| ENA | 67 | 63% | $145 | $0.50 | $12 | 3.17 |
| OP | 67 | 66% | $137 | $0.47 | $9 | 3.63 |
| LDO | 66 | 68% | $135 | $0.46 | $10 | 3.47 |
| DOT | 67 | 69% | $123 | $0.42 | $8 | 3.62 |
| ARB | 67 | 67% | $118 | $0.40 | $9 | 3.36 |
| TRUMP | 67 | 72% | $106 | $0.36 | $7 | 4.44 |
| DOGE | 6 | 83% | $14 | $0.05 | $4 | 4.53 |
| LINK | 5 | 80% | $14 | $0.05 | $2 | 8.99 |
| APT | 5 | 80% | $13 | $0.04 | $4 | 4.09 |
| ADA | 5 | 80% | $10 | $0.03 | $2 | 6.33 |
| WLD | 5 | 60% | $8 | $0.03 | $2 | 4.29 |
| XRP | 4 | 75% | $4 | $0.02 | $2 | 3.66 |

Top performers: ENA, OP, LDO, DOT, ARB, TRUMP (all with 60+ trades, 63-72% WR, PF 3.17-4.44). Lower-volume pairs (DOGE, LINK, APT, ADA, WLD, XRP) show high WR but too few trades for statistical significance.

---

## Best News Config Parameters

- Pairs: top15 (TIA, kBONK, OP, LDO, APT, NEAR, ARB, ENA, WLD, ADA, DOT, ONDO, LINK, DOGE, SOL)
- TP: 5%, SL: 2%
- Max hold: 4h (12h gives $3.45/day but extends risk window)
- Stale exit: 1h@0.3% best on $/day ($3.17/day); 1h@0.5% best Sharpe
- Result: $3.26/day, 68% WR, $57 MaxDD, Sharpe 7.91, PF 3.99

Optimal TP/SL: wider SL3% + wider TP10% wins ($3.63/day, 69% WR, $46 MaxDD, PF 4.92)

---

## News Pair Set Comparison

| Pairs | Trades | WR% | $/day | MaxDD | Sharpe | PF |
|-------|--------|-----|-------|-------|--------|-----|
| all20 | 431 | 68% | $2.83 | $84 | 7.60 | 3.61 |
| top15 | 431 | 68% | $3.26 | $57 | 7.91 | 3.99 |
| top10 | 421 | 67% | $3.14 | $57 | 7.94 | 3.89 |
| top5 | 301 | 67% | $2.23 | $52 | 7.77 | 3.98 |

top15 > top10 > all20 > top5. Adding bottom 5 pairs hurts (noise). top15 is sweet spot.

---

## TP/SL Grid (top10, hold4h, stale1h@0.5%)

| | SL1% | SL1.5% | SL2% | SL3% |
|-|------|--------|------|------|
| TP3% | $2.57/d WR63% | $2.69/d WR67% | $2.81/d WR70% | $2.96/d WR71% |
| TP5% | $2.93/d WR60% | $3.05/d WR65% | $3.14/d WR67% | $3.31/d WR69% |
| TP7% | $3.11/d WR60% | $3.24/d WR65% | $3.34/d WR67% | $3.52/d WR69% |
| TP10% | $3.18/d WR60% | $3.34/d WR65% | $3.44/d WR67% | $3.63/d WR69% |

Wider SL consistently better. Wider TP consistently better. Best: TP10%/SL3% ($3.63/day, PF 4.92).

---

## Stale Exit Impact

| Config | $/day | WR% | MaxDD | Sharpe |
|--------|-------|-----|-------|--------|
| no-stale | $2.32 | 56% | $132 | 5.45 |
| 1h@0.3% | $3.17 | 68% | $57 | 8.01 |
| 1h@0.5% | $3.14 | 67% | $57 | 7.94 |
| 1h@1% | $2.88 | 64% | $57 | 7.45 |
| 2h@0.5% | $2.88 | 63% | $102 | 6.72 |

Stale exit remains CRITICAL - without it: WR drops from 67% to 56%, MaxDD more than doubles, $/day drops 26%. The 1h@0.3% stale wins on $/day with same low MaxDD.

---

## Max Hold Impact

| Hold | $/day | WR% | MaxDD | Sharpe |
|------|-------|-----|-------|--------|
| 2h | $2.65 | 69% | $61 | 7.72 |
| 4h | $3.14 | 67% | $57 | 7.94 |
| 6h | $3.12 | 66% | $55 | 8.51 |
| 8h | $3.25 | 66% | $55 | 8.50 |
| 12h | $3.45 | 66% | $55 | 8.79 |

Longer hold = better Sharpe + lower MaxDD + higher $/day. 12h optimal but 4-8h is safe default.

---

## Key Findings vs Prior Research

Prior research showed news-only best at $12.84/day (187 events). This corrected run shows $3.26/day (163 events).

Remaining gap explained by:
1. Prior research likely used minute-level entry (exact event timestamp) - we use hourly bar open as proxy
2. With same-bar entry fix, we now enter within the event hour (not next hour), but hourly granularity still misses the first 0-55 minutes of move
3. Tighter keywords reduced events from 356 to 163 (fewer false positives = fewer trades = less total PnL but better quality)

Key improvements in v2:
- News WR jumped from 52% to 67-69% (much closer to prior's 60.5%)
- MaxDD for news dropped from $185 to $57 (mark-to-market is honest, but news positions are short-lived so unrealized doesn't add much)
- GARCH MaxDD now $320 (mark-to-market reveals true drawdown including unrealized losses on open positions)
- PF improved from ~1.5 to 3.89-4.92 (higher quality signals from tighter keywords)

GARCH baseline: $5.37/day (same as before - GARCH code unchanged)

---

## Recommendation

**Build the news trading engine.** Combined-no-defense delivers $8.20/day vs GARCH alone $5.37/day (+53%).

**Optimal combined config:**
- GARCH v2 as-is (separate cap, 6/dir)
- News engine: top15 pairs, TP10%, SL3%, max hold 4-8h, stale exit 1h@0.3%
- No defense (defense costs -$0.54/day; real-time RSS detection makes it unnecessary since we enter fast)
- Separate position caps (separate-cap > shared-cap by $0.62/day)

**Best risk-adjusted news config:**
- top10, TP10%, SL3%, hold4h, stale1h@0.5%
- $3.63/day, 69% WR, $46 MaxDD, PF 4.92, Sharpe 8.12

**Why no defense in combined:**
The defense was designed for live positions already open. In combined mode, the news offense positions being added actually benefit from the same event that would trigger defense. Net effect: keep both GARCH positions AND add news positions in event direction.

**Next steps:**
1. Build NewsTrading engine (RSS -> Groq classifier -> open positions on top15 pairs)
2. Use: TP10%, SL3%, max hold 4-8h, stale exit 1h if <0.3% move in direction
3. Paper trade 2 weeks alongside live GARCH
4. Deploy with separate cap (6/dir news independent of GARCH cap)
5. Keep NewsGuard defense for GARCH-only positions (before news engine live)
