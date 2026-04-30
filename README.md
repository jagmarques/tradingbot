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
| Margin | $3 (sized for $45 wallet; raise to $10 at $200) |
| Max concurrent | 7 |
| Max hold | 120h |
| Cooldown | 4h per pair+direction after SL |
| Blocked hours | 22-23 UTC |
| Scheduler | 3-min cycle, 1h-boundary entries |
| Pairs | 15 (top-Calmar prune from 50 universe) |
| Leverage | per-pair max via HL meta, capped 10x |

**Pairs (15):** ETH, ZEC, YGG, STRAX, WLD, PENGU, DOGE, ARB, FIL, OP, AVAX, NEO, JTO, KAITO, SUSHI

**Backtest (297 days OOS, 1m resolution, $10 margin):**
- $0.55/day, MDD $18.7, Calmar 0.029, WR ~76%
- ~0.5 trades/day, mix of longs and shorts
- Validated: 648-config sweep + walk-forward + parity reconciliation across 2 engines

**Live expected at $45 wallet ($3 margin):**
- ~$0.16/day = ~$5/month, MDD ~$5

**Live expected at $200 wallet ($10 margin):**
- ~$0.55/day = ~$16/month, MDD ~$19

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
