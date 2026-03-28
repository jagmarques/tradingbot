# Trading Bot

Hyperliquid 5-engine trend ensemble, EVM insider copy trading. TypeScript, Docker, Coolify.

## Strategies

### Hyperliquid Quant Ensemble (LIVE)

5-engine trend-following system on 25 perpetual futures pairs. Max 20 concurrent positions, 10x leverage.

| Engine | Entry Signal | Exit Signal | Size | Max Hold |
|--------|-------------|-------------|------|----------|
| Donchian Trend | SMA(20/50) daily cross | 15d close channel break | $7 | 60d |
| Supertrend 4h | ST(14,1.75) flip | ST flip | $5 | 60d |
| GARCH v2 MTF | 1h+4h z-score extremes | 3% SL, 7% TP | $3 | 96h |
| Carry Momentum | Weekly funding rebalance | Rebalance | $7 | 8d |
| Momentum Confirm | Vol+funding+price z-scores | 3% SL | $3 | 48h |

- BTC EMA(20)>EMA(50) filter for longs, shorts always allowed
- ATR(14)x3 stop-loss capped at 3.5%
- No trailing stops (backtest proven: costs 65% profit)
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
