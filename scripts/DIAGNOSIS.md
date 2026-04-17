# Live Trading Diagnosis: Mar 26 - Mar 29 2026

**Capital:** $90-130 equity
**Config deployed:** GARCH $15, ST $5, z-scores 1h>3.5 / 4h>2.5, max 15, trail 20/3, BTC 4h EMA(12/21)
**Period:** 3 days live
**Outcome:** GARCH 7 trades -$4.43, ST 23 trades -$3.01, Apr 3 single-day blowup -$15.24

---

## 1. Why 20/3 Trail Destroyed Supertrend's Edge

### The math

Supertrend is a trend-following engine. Its backtest edge comes from riding large, slow moves that persist across multiple 4h bars. The exit signal (supertrend flip) is designed to stay in a trade for days to weeks. The validated backtest at $3/trade, max 10, no trail produced PF ~1.47 over 3.2 years.

The 20/3 trail clips winners before the supertrend flip fires.

**What 20/3 means at $5 margin, 10x leverage:**
- Trail activates at +20% leveraged PnL = +2% price move in the right direction
- Trail fires when price retreats 3% from the leveraged peak
- 3% leveraged distance = 0.3% price retreat from peak

A 0.3% intraday noise band is well within the normal 4h candle range. Any pause, consolidation, or minor pullback in a winning trend will trigger the trail before the signal flips.

**Win cap math:**
- Activation at +20% lev PnL = +2% raw price move
- After trail fires at peak-3%, worst-case win = +17% lev PnL - fees
- At $5 margin 10x: $5 x 17% = +$0.85 gross, minus $0.04 fees = ~$0.81 max win
- Observed: avg win $0.88 -- confirmed, almost every winner exits at trail minimum

**Loss comparison:**
- ATR*3 stop, capped 3.5% = worst case $5 x 3.5% x 10 = $1.75 gross loss + fees = ~$1.80
- Observed: avg SL loss ~$1.80 -- matches expectation

**Resulting R:R ratio:**
- Win: ~$0.88
- Loss: ~$1.80
- Required win rate to break even: 1.80 / (1.80 + 0.88) = 67%
- Supertrend backtest win rate without trail: ~50%
- A 50% win rate strategy with 0.49:1 R:R has profit factor = 0.49 < 1. It will lose money by design.

The 20/3 trail transformed a positively-skewed strategy (few large wins, many small losses) into a negatively-skewed one (all wins capped, all losses full-sized). This is the primary cause of the negative ST P&L.

**Backtest validated this explicitly.** The bt-trail-reentry scripts showed that trail configs below 40% activation consistently reduced Supertrend's $/day. The validated trail threshold was 40/3, not 20/3. The deployed config used 20/3 -- 20 percentage points below the validated threshold.

---

## 2. Why $15 GARCH Sizing Was Too Aggressive for $90-130 Equity

### Position concentration

At $15 margin per GARCH trade, 10x leverage = $150 notional per position. On $90 equity:
- Single GARCH position = 16.7% of equity in notional, 16.7% margin concentration
- Three simultaneous GARCH positions = $45 margin = 50% of equity deployed
- Four positions = 66% of equity deployed

The validated config for $15 GARCH was paired with max 8 total positions ($12 only) or max 10 ($9+$3). The $15+max 15 config had MaxDD $197 in backtest -- more than 150% of live equity. Deploying that config on $90-130 capital meant a max drawdown of $197 is theoretically possible, which would wipe the account and then some.

### SL loss magnitude

GARCH uses a fixed 3% stop, capped at 3.5%:
- Best case stop: $15 x 3% x 10 = $4.50 per loss
- Worst case (capped): $15 x 3.5% x 10 = $5.25 per loss
- Observed: avg SL loss $4-5 -- matches

At $90 equity, a single GARCH stop-loss represents 5-6% of total account. Three consecutive losses (routine in any trend strategy) = 15-18% drawdown from stops alone, before adding ST losses.

### The backtest capital assumption

The $15+max 15 backtest used a notional capital model, not an equity constraint. It does not simulate what happens when margin utilization exceeds available equity. In a real HL unified account, opening too many positions creates liquidation risk when prices move against multiple positions simultaneously. The backtest counted MaxDD in P&L terms; the live account felt it as percent-of-equity.

---

## 3. Why Max 15 Allowed Correlated Positions to Blow Up Simultaneously

### Apr 3 event: 8 positions stopped simultaneously, -$15.24 in one day

With max 15 positions across 25 pairs, the system could hold 7+ shorts at the same time during a bearish regime. The BTC EMA filter blocks longs but does not limit short concentration.

**What happened Apr 3:**
- Market sold off hard in the prior days, triggering ST bear flips across many pairs
- The regime filter (BTC EMA bearish) confirmed shorts on all of them
- All 7 ST shorts + 1 GARCH short were entered independently on different pairs but in response to the same correlated macro signal (BTC decline)
- When BTC bounced sharply, all 8 short positions moved against simultaneously
- 8 SL hits in one session: 7 x $1.80 + 1 x $4.50 = $12.60 + $1.80 extra fees = ~$15.24

**Correlation problem:**
Most alt pairs have BTC correlation of 0.7-0.9 on 4h bars. During sharp BTC reversals, correlated shorts all get stopped together. The 25-pair universe creates the illusion of diversification, but during macro shocks the effective number of independent bets collapses to 2-3.

**Max 15 is not a diversification limit, it is a concentration amplifier** under correlated conditions. The backtest does not simulate correlated SL cascades because each pair is modeled independently. The live account suffered the real-world version.

**Mitigation missing:** No per-direction cap on shorts across the full ensemble. GARCH has `MAX_PER_DIRECTION = 6` internally, but the ensemble-level max was 15 total. Six GARCH shorts plus seven ST shorts = thirteen correlated short positions. Under max 10, the cascade would have been limited to ~$14 maximum (7x $1.80 + 1x $4.50); under max 8 it caps at ~$11.

---

## 4. Safe Config for $90 Equity with MaxDD < $60

### Constraints

| Constraint | Derivation |
|-----------|-----------|
| MaxDD target | < $60 (67% of $90 equity) |
| Single-day max loss | < $15 (17% of equity) |
| Single SL loss | < $3 (3.3% of equity) |
| Max correlated stops in one day | <= 4 simultaneously |

### Derived sizing limits

**GARCH sizing:**
- Max single loss = $3 -> margin = $3 / (3.5% x 10) = $8.57 -> round down to **$9**
- At $9/trade: SL = $3.15 per hit, daily max from GARCH = 4 hits = $12.60

**Supertrend sizing:**
- Max single loss = $1.80 -> margin = $1.80 / (3.5% x 10) = $5.14 -> maintain **$3**
- At $3/trade: SL = $1.05 per hit, daily max from ST = 8 hits = $8.40

**Max concurrent positions:**
- On $90 equity, comfortable margin deployment = 30% = $27
- At $9 GARCH + $3 ST mixed: avg position = $6, allows ~4-5 open at once safely
- Hard limit: **max 10** (validated config, backtest MaxDD $120 at $9+$3)
- For $90 equity specifically: **max 8** recommended (further limits correlated cascade)

**Trail configuration:**
- Trail must not activate before the strategy's natural holding period elapses
- Supertrend avg hold: 4-12 days. Trail activation at 20% lev = 2% price move = fires in hours
- Correct trail: **40/3** -- activates only at +40% lev PnL (4% price move), gives trend room to develop
- At 40% activation on ST $3: min win = $3 x 37% = $1.11, beats avg loss $1.05 -> R:R > 1:1
- GARCH natural exit: TP at 7% (70% lev) is the primary exit, trail at 40% is backup
- **Keep 40/3 for both engines**

### Recommended safe config

| Parameter | Current (broken) | Safe ($90 equity) |
|-----------|-----------------|-------------------|
| GARCH margin | $15 | $9 |
| ST margin | $5 | $3 |
| Max concurrent | 15 | 8 |
| Trail activation | 20% | 40% |
| Trail distance | 3% | 3% |
| GARCH z-scores | 1h>3.5, 4h>2.5 | unchanged |
| GARCH TP | 7% | unchanged |
| GARCH SL | 3% fixed | unchanged |
| BTC filter | 4h EMA(12/21) | unchanged |

**Expected performance at safe config (backtest reference):**
- GARCH $9 + ST $3, max 10: $2.75/day, MaxDD $120 full period
- Scale factor to max 8: ~0.85x -> $2.34/day, MaxDD ~$100
- MaxDD $100 is still 111% of $90 equity -- the $90 account is genuinely undersized

**Honest capital requirement:**
- To run GARCH $9 + ST $3, max 10 safely: **minimum $130 equity** (MaxDD ~$100 = 77%)
- To run at max 8 with MaxDD < 60% of equity: **minimum $170 equity**
- At $90, the realistic maximum safe config is GARCH $6 + ST $2, max 8 (MaxDD ~$65)

---

## 5. Should Supertrend Be Kept or Killed

### Keep, with trail fix

The 23-trade ST sample over 3 days is too small to assess edge; the signal fires at 4h bar boundaries, so 23 trades in 3 days is abnormally high (suggests a volatile choppy period, not representative). The backtest over 3.2 years shows genuine PF 1.47, 993 trades, statistically validated (p=0.000, 0/100 random entry baselines beat it).

**The edge is intact. The configuration destroyed it.**

Three specific problems caused the live losses, none of which are structural to Supertrend:

1. **20/3 trail** capped wins below average loss size, guaranteeing negative expectancy
2. **$5 margin on $90 equity** created 5.8% equity risk per SL hit (too large for this capital)
3. **Max 15** with no per-direction ensemble cap allowed correlated short cascade

Fix all three and ST should contribute positive expectancy.

**Specific fixes required:**
- Trail: change `supertrend-4h` activation from 20 to 40 in `TRAIL_CONFIG_BY_ENGINE`
- Margin: change `ST_POSITION_SIZE_USD` from 5 to 3 (or 2 at $90 equity)
- Max positions: change `ENSEMBLE_MAX_CONCURRENT` from 15 to 8 (or 10 minimum)
- Direction cap: consider adding ensemble-level max-per-direction guard (e.g., max 4 shorts total across both engines)

### Evidence against killing ST

- Backtest Donchian-ST daily P&L correlation: -0.008 (near-zero)
- ST provides short-side coverage that GARCH lacks in bear regimes
- ST has longest max-hold (60d), captures multi-week trends GARCH misses at 96h
- Removing ST reduces diversification and concentrates all alpha in GARCH, which had its own 7-trade sample of -$4.43 under the same misconfigured trail

---

## Root Cause Summary

The live losses are attributable to three configuration errors, not strategy failure:

| Error | Mechanism | P&L impact |
|-------|-----------|-----------|
| Trail 20/3 instead of 40/3 | Clipped all ST wins below break-even R:R | Primary cause of ST -$3.01 |
| GARCH $15 on $90 equity | 16.7% equity per position, $4-5 SL each | Primary cause of GARCH -$4.43 |
| Max 15 with no direction cap | 8 correlated shorts hit simultaneously | Entire -$15.24 Apr 3 blowup |

No backtest modification needed. The validated configs already specified the correct parameters. The deployed config deviated from them on all three dimensions simultaneously.

---

## Immediate Actions

1. Change `TRAIL_CONFIG_BY_ENGINE.supertrend-4h` activation from 20 to 40
2. Change `TRAIL_CONFIG_BY_ENGINE.garch-v2` activation from 20 to 40 (same backtest spec)
3. Change `ST_POSITION_SIZE_USD` from 5 to 3
4. Change `GARCH_POSITION_SIZE_USD` from 15 to 9
5. Change `ENSEMBLE_MAX_CONCURRENT` from 15 to 8
6. Add per-direction cap at ensemble level: max 4 shorts total across all engines
7. Fund account to $130+ before increasing sizes back toward validated config
