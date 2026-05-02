# Trading Bot

Hyperliquid GARCH quant engine + EVM insider copy trading. TypeScript, Docker, Coolify.

## Strategy

### GARCH v2 LONG+SHORT (LIVE — C2 config)

1-bar momentum z-score with mixed vol windows (1h:vw15, 4h:vw20). Symmetric thresholds for both directions.

| Parameter | Value |
|-----------|-------|
| Entry LONG | 1h z > 3.0 AND 4h z > 1.5 |
| Entry SHORT | 1h z < -3.0 AND 4h z < -1.5 |
| SL | 3.5% (10x pairs), 3.0% (3x/5x pairs) |
| Trail | T15/4 (lock at peak-4pp once peak >= +15% lev) |
| Breakeven | none (trail handles it) |
| Margin | $20 (7 concurrent × $20 = $140 max margin used) |
| Max concurrent | 7 |
| Max hold | 120h |
| Cooldown | 4h per pair+direction after SL only (trail-close: no cooldown, by design — matches backtest) |
| Blocked hours | 22-23 UTC |
| Scheduler | 3-min cycle, 1h-boundary entries |
| Pairs | 15 (top-Calmar prune from 50 universe) |
| Leverage | per-pair max via HL meta, capped 10x |

**Pairs (15):** ETH, ZEC, YGG, STRAX, WLD, PENGU, DOGE, ARB, FIL, OP, AVAX, NEO, JTO, KAITO, SUSHI

**Backtest (297 days OOS, 1m resolution, all 50 universe pairs cached):**
- Top-15 at $20 margin: $1.10/day, MDD $31.5, Calmar 0.035, WR 76%
- Top-15 at $10 margin: $0.55/day, MDD $15.5, Calmar 0.0358, WR 76%
- Walk-forward: 4/4 quarters profitable
- Validated: 648-config sweep + 8-variant trail sweep + 6-variant pair-count sweep
- Top-15 wins Calmar across all sweeps (10/15/20/25/35/50 pair tests; 15 is the optimum)

**Live expected (deployed today at $20 margin):**
- ~$25-35/month average, MDD ~$30
- Per-quarter range: $7-70/month (Q4 strongest, Q1 slowest in OOS)
- Forward expectation reduced ~20% for unmodeled funding cost on shorts

**Backtest caveats** (factor in for forward expectation):
- Funding rate on shorts NOT modeled (~$0.20/day adverse, ~$73/year cost)
- Maker rebate NOT modeled (~$0.05/day favorable when maker fills)
- Spread for micro-caps set at 15bp (realistic for $200 fills)
- Exchange downtime / API failures NOT modeled

### Insider Copy Trading (EVM)

Copies EVM token buys from high-scoring insider wallets via Alchemy WebSocket.

### Unified Account (Hyperliquid)

- `getSpotClearinghouseState` returns real portfolio value
- When perps equity <= marginUsed, use spot USDC as equity
- Leverage cache force-fetches HL meta on init (no stale 3x defaults)

## Trading Modes

| | Paper | Hybrid | Live |
|---|-------|--------|------|
| Quant | Paper | Live | Live |
| Insider Copy | Paper | Paper | Live |
| Set via | `TRADING_MODE=paper` | `TRADING_MODE=hybrid` | `TRADING_MODE=live` |

## Telegram

`/balance` `/pnl` `/trades` `/insiders` `/stop` `/resume` `/mode`

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Deployment (Coolify)

1. Set environment variables in dashboard
2. Mount `/data` volume for SQLite persistence
3. Health check: `GET /health` on port 4000

## Tech Stack

TypeScript (strict), Node 22, Vitest, SQLite, Grammy, ethers.js, Hyperliquid SDK, Docker, Coolify
