# Trading Bot

Hyperliquid GARCH quant engine, EVM insider copy trading. TypeScript, Docker, Coolify.

## Strategy

### GARCH v2 Long-Only (LIVE)

1-bar momentum z-score with mixed vol windows (1h:vw15, 4h:vw20). Enters longs when BOTH z-scores > 2.0. Shorts disabled.

| Parameter | Value |
|-----------|-------|
| Entry | 1h z>2.0 AND 4h z>2.0 (long-only) |
| SL | 3.0% (10x pairs), 2.5% (3x/5x pairs) |
| Breakeven | SL -> entry at peak +8% leveraged |
| Trail | 3-stage: 15/6 -> 30/5 -> 50/3 (tightens as profit grows) |
| Margin | $15 fixed |
| Max concurrent | 10 |
| Max hold | 48h |
| Cooldown | 1h per pair after SL |
| Blocked hours | 22-23 UTC |
| Scheduler | 3-min cycle |
| Pairs | 125 perpetual futures, leverage cap 10x |

**Verified (297 days, 1m resolution backtest):** $6.80/day, MDD $33, PF 2.42, WR 49%

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
