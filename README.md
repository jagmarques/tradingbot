# Trading Bot

Hyperliquid GARCH quant engine, EVM insider copy trading. TypeScript, Docker, Coolify.

## Strategy

### GARCH v2 lb1/vw30 Long-Only (LIVE)

1-bar momentum z-score with 30-bar volatility window. Enters longs when 1h and 4h z-scores are both elevated. Shorts disabled (all lost money OOS).

| Parameter | Value |
|-----------|-------|
| Entry | 1h z>2.0 AND 4h z>1.5 (long-only) |
| SL | 0.3% exchange (10x pairs), 0.15% (3x/5x pairs) |
| Trail | 3/1 -> 9/0.5 -> 20/0.5 (1h boundary) |
| Margin | $20 fixed |
| Max concurrent | 7 |
| Max hold | 72h |
| Cooldown | 1h per pair after SL |
| Blocked hours | 22-23 UTC |
| Pairs | 127 perpetual futures, leverage cap 10x |

**Verified (297 days, MTM backtest):** $2.40/day, MDD $32, PF 1.88, Calmar 0.074

### TrumpGuard

Monitors Trump Truth Social, Fed FOMC, Powell, White House RSS feeds. Opens paper positions on BTC/ETH/SOL on HIGH impact events.

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
