# Trading Bot

Hyperliquid GARCH quant engine + EVM insider copy trading. TypeScript, Docker, Coolify.

## Strategy

### GARCH v2 LONG+SHORT (LIVE)

1-bar momentum z-score with mixed vol windows (1h:vw15, 4h:vw20). Asymmetric thresholds: longs need z>3.0, shorts need z<-3.5 (higher conviction to avoid bull-regime squeezes).

| Parameter | Value |
|-----------|-------|
| Entry LONG | 1h z > 3.0 AND 4h z > 1.5 |
| Entry SHORT | 1h z < -3.5 AND 4h z < -1.5 (asymmetric) |
| SL | 3.0% (10x pairs), 2.5% (3x/5x pairs) |
| Trail | T20/5 (lock at peak-5pp once peak >= +20% lev) |
| Breakeven | none (trail handles it) |
| Margin | $10 fixed |
| Max concurrent | 7 |
| Max hold | 120h |
| Cooldown | 4h per pair+direction after SL |
| Blocked hours | 22-23 UTC |
| Scheduler | 3-min cycle, 1h-boundary entries |
| Pairs | 15 (top-Calmar prune from 50 universe) |
| Leverage | per-pair max via HL meta, capped 10x |

**Pairs (15):** ETH, ZEC, YGG, STRAX, WLD, PENGU, DOGE, ARB, FIL, OP, AVAX, NEO, JTO, KAITO, SUSHI

**Backtest (297 days OOS, 1m resolution, $10 margin):**
- $0.59/day, MDD $20, Calmar 0.029, WR 78%
- 116 longs + 32 shorts = 148 trades = ~0.50/day
- Validated: walk-forward 3/4 quarters, bootstrap p=0.0004, top-1 = 17%

### Insider Copy Trading (EVM)

Copies EVM token buys from high-scoring insider wallets via Alchemy WebSocket.

### Unified Account (Hyperliquid)

- `getSpotClearinghouseState` returns real portfolio value
- When perps equity <= marginUsed, use spot USDC as equity

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
