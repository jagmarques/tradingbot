# Hyperliquid Fee Reduction Research
Date: 2026-03-29
Account context: ~$90 equity, 2-engine bot (GARCH $15 + ST $5), ALO (maker) orders with taker fallback

---

## Current Fees (Confirmed from Official Docs)

- Perps Tier 0 (base): 0.015% maker, 0.045% taker
- The bot uses ALO (post-only maker), so the relevant rate is **0.015% maker**
- Taker fallback: 0.045%

Source: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees

---

## FINDING 1: HYPE Staking Discounts (ACTIVE — live since May 5, 2025)

Staking HYPE tokens gives a percentage discount on all trading fees. Applied to current base rates:

| Tier    | HYPE Staked | Discount | Effective Maker | Effective Taker |
|---------|-------------|----------|-----------------|-----------------|
| Wood    | >10         | 5%       | 0.01425%        | 0.04275%        |
| Bronze  | >100        | 10%      | 0.01350%        | 0.04050%        |
| Silver  | >1,000      | 15%      | 0.01275%        | 0.03825%        |
| Gold    | >10,000     | 20%      | 0.01200%        | 0.03600%        |
| Platinum| >100,000    | 30%      | 0.01050%        | 0.03150%        |
| Diamond | >500,000    | 40%      | 0.00900%        | 0.02700%        |

HYPE price is ~$15 as of late March 2026, so Wood tier (>10 HYPE) costs ~$150. Bronze (>100 HYPE) costs ~$1,500. These amounts are larger than the $90 account equity.

**Practical takeaway:** Wood tier (5% discount) requires ~$150 in HYPE staked, which exceeds the account size. Not cost-effective for a $90 account unless HYPE is already held separately.

SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
SOURCE: https://x.com/HyperliquidX/status/1917107760694759920

---

## FINDING 2: Referral Code — 4% Discount on First $25M Volume

Using a referral code at signup gives a 4% discount on all trading fees for the first $25M in cumulative volume. Applied to the maker rate:

- Current: 0.015% maker
- With referral: 0.01440% maker (saves 0.0006% per trade)

**Critical constraint:** The discount must be applied at account creation. Existing accounts cannot retroactively add a referral code. The discount does NOT apply to vaults or sub-accounts.

For a new account, this is a free and permanent improvement for the foreseeable future (bot will never approach $25M volume at this scale).

SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/referrals
SOURCE: https://x.com/HyperliquidX/status/1720093921660084470

---

## FINDING 3: Volume Tiers — Far Out of Reach for This Account

Fee tiers are based on 14-day weighted volume. Spot volume counts double.

| Tier | Volume Threshold | Maker Fee |
|------|------------------|-----------|
| 0    | Base             | 0.015%    |
| 1    | >$5M/14d         | 0.012%    |
| 2    | >$25M/14d        | 0.008%    |
| 3    | >$100M/14d       | 0.004%    |
| 4    | >$500M/14d       | 0.000%    |

At $20 per position, ~10 positions/month, the bot generates roughly $200-$500/month in notional volume. Tier 1 requires $5M in 14 days. **Volume tiers are completely irrelevant for this account size.**

SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees

---

## FINDING 4: Maker Rebates (Negative Fees) — Not Achievable

Maker rebates (negative maker fees) are available only if the account's 14-day maker volume represents a meaningful share of the entire Hyperliquid venue's maker volume:

| Rebate Tier | Required Maker Volume Share | Maker Fee   |
|-------------|----------------------------|-------------|
| 1           | >0.5% of venue             | -0.001%     |
| 2           | >1.5% of venue             | -0.002%     |
| 3           | >3.0% of venue             | -0.003%     |

Hyperliquid processes $50B+/day in volume. 0.5% of venue maker volume = hundreds of millions of dollars. **Completely unreachable for this account.**

SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees

---

## FINDING 5: Builder Codes — Add Cost, Do Not Reduce Fees

Builder codes allow frontend/app developers to charge an additional fee on top of Hyperliquid's base fees. They do NOT reduce trading fees. The builder takes an extra cut; the user pays more, not less.

The user must explicitly approve a builder via `ApproveBuilderFee` signed by the main wallet. Some builders run zero-fee promotions (absorbing their own builder fee), but there is no mechanism for a builder to reduce the underlying Hyperliquid exchange fee.

There is no vault or builder that offers fee-sharing back to the trading account to reduce net costs below Hyperliquid's published rates.

**Conclusion: Builder codes are irrelevant or harmful for a self-operated bot. Do not implement.**

SOURCE: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes
SOURCE: https://www.dwellir.com/blog/hyperliquid-builder-codes

---

## FINDING 6: HYPE Fee Rebate (100% Refund Claim) — UNVERIFIED, Likely Inaccurate

One secondary source (CoinReporter, March 23, 2026) claimed Hyperliquid rebates 100% of maker and taker fees back in HYPE tokens for all retail perp traders, effectively making trading gasless. This was cited as causing $1.4B in new deposits.

**Official docs (https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees) contain NO mention of this program.** The fee tables show normal positive rates at Tier 0. This claim does not appear in Hyperliquid's own documentation.

**Assessment: This claim is unreliable. The CoinReporter article may be AI-generated or fabricated. Do not count on 100% fee rebates. Treat current fees as 0.015% maker / 0.045% taker until official confirmation appears.**

SOURCE (unreliable): https://www.coinreporter.io/2026/03/hyperliquid-introduces-gasless-trading-for-all-perps-via-hype-fee-rebates/
SOURCE (authoritative, no mention of rebate): https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees

---

## FINDING 7: HIP-3 Growth Mode — Potential 90% Fee Cut on New Markets

HIP-3 (Builder-Deployed Perpetuals) introduced a "growth mode" that slashes taker fees by up to 90% for newly launched markets (from ~0.045% to ~0.004-0.009%). This applies only to newly listed HIP-3 perpetual markets during their promotional window — not to existing established pairs like ETH, SOL, BTC, etc.

The 25 pairs in the bot's current universe are all established and would not qualify. However, if the bot were to trade newly listed HIP-3 pairs during their growth window, the fee impact would be dramatically lower.

SOURCE: https://www.coindesk.com/markets/2025/11/19/hyperliquid-unveils-hip-3-growth-mode-slashing-fees-by-90-to-boost-new-markets

---

## Summary: What Can Actually Be Done

| Option                       | Feasibility       | Maker Fee After | Notes                                   |
|------------------------------|-------------------|-----------------|-----------------------------------------|
| Referral code at signup      | Free, immediate   | 0.01440%        | New account only. Permanent up to $25M  |
| HYPE staking Wood (>10 HYPE) | ~$150 cost        | 0.01425%        | Only 5% discount. Not worth the capital lock |
| Volume tier upgrade          | Unreachable       | 0.015%          | Needs $5M+ / 14 days                    |
| Maker rebate (negative fee)  | Unreachable       | 0.015%          | Needs 0.5%+ of venue maker volume       |
| Builder codes                | Not applicable    | 0.015%+         | Only adds cost for self-operated bots   |
| HIP-3 growth mode pairs      | Possible but risky| ~0.004-0.009%   | Newly listed, unproven markets          |
| HYPE 100% rebate             | Unverified        | 0.015% nominal  | Not in official docs, claim unreliable  |

**Best actionable option for $90 account:** If starting fresh (new wallet), use a referral code at signup — free 4% discount on all fees permanently (within $25M volume cap, which this account will never reach).

**If the account already exists:** No material fee reduction is available without locking more capital in HYPE than the trading account itself holds. Focus on maximizing ALO (maker) order hit rate to stay at 0.015% and avoid 0.045% taker fills.
