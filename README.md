# Trading Bot

Hyperliquid GARCH v2 quant engine, EVM insider copy trading. TypeScript, Docker, Coolify.

## Strategies

### Hyperliquid GARCH v2 (LIVE)

Single-engine z-score momentum on 25 perpetual futures pairs. Max 7 concurrent positions, 10x leverage.

| Engine | Entry Signal | Exit Signal | Size | Max Hold |
|--------|-------------|-------------|------|----------|
| GARCH v2 MTF | 1h z>4.5 + 4h z>3.0 | 3% SL, 7% TP | Auto (10% equity, $3-$20) | 72h |

- Auto-scaler: position size = 10% of equity, clamped $3-$20
- BTC 4h EMA(12)>EMA(21) filter for longs, shorts always allowed
- ATR(14)x3 stop-loss capped at 3.5%
- Stepped trailing: 25/6 -> 30/3 -> 35/1 (loose early, tight late)
- Maker entry (ALO) with taker fallback, dead-man switch

### TrumpGuard

Monitors Trump Truth Social, Fed FOMC, Powell, White House RSS feeds. Opens paper positions on BTC/ETH/SOL on HIGH impact events. Does not close live positions.

### Insider Copy Trading (EVM)

Copies EVM token buys from high-scoring insider wallets.

- Real-time buy/sell detection via Alchemy WebSocket
- 47 tracked wallets on Ethereum
- GoPlus security checks, $20k min liquidity
- Dynamic position sizing: $3-$20 based on score
- Rug detection via burn events + liquidity monitoring

### Unified Account (Hyperliquid)

- `getSpotClearinghouseState` returns real portfolio value
- When perps equity <= marginUsed, use spot USDC as equity

## Trading Modes

| | Paper | Hybrid | Live |
|---|-------|--------|------|
| Quant Ensemble | Paper | Live | Live |
| Insider Copy | Paper | Paper | Live |
| Set via | `TRADING_MODE=paper` | `TRADING_MODE=hybrid` | `TRADING_MODE=live` |

## Telegram

| Command | Description |
|---------|-------------|
| `/balance` | Portfolio value |
| `/pnl` | P&L with period tabs |
| `/trades` | Open positions |
| `/insiders` | Insider wallets |
| `/stop` / `/resume` | Kill switch |
| `/mode` | Switch trading mode |

## Config

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_MODE` | `paper` | paper, hybrid, or live |
| `QUANT_ENABLED` | `false` | Enable quant trading |
| `DAILY_LOSS_LIMIT_USD` | `$25` | Daily loss limit per strategy |

**Required:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

**Optional:** `HYPERLIQUID_PRIVATE_KEY`, `HYPERLIQUID_WALLET_ADDRESS`, `PRIVATE_KEY_EVM`, `ETHERSCAN_API_KEY`, `ALCHEMY_API_KEY`

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

## License

MIT
