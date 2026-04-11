# Trading Bot

Hyperliquid 2-engine quant portfolio, EVM insider copy trading. TypeScript, Docker, Coolify.

## Strategies

Two uncorrelated engines (correlation ~0.1) trade in parallel with ATR-based vol regime filter, exchange-level stops, and multi-stage trailing.

### Engine A: GARCH v2 Long-Only (LIVE)

Multi-timeframe z-score momentum. Enters longs when 1h and 4h z-scores are both elevated AND the market is in a high-vol regime. Shorts are disabled — they all lost money in OOS backtests.

### Engine B: Range Expansion (LIVE)

Detects 1h bars where range > 2× ATR(14) with close in the upper/lower 25% of the bar. Takes continuation in the close direction. Uncorrelated with GARCH momentum.

### Portfolio config

| Engine | Entry | SL | Trail | Margin | Max Hold |
|--------|-------|-----|-------|--------|----------|
| GARCH v2 long-only | 1h z>2, 4h z>1.5, ATR regime>1.8 | 0.15% exch | 3/1 → 9/0.5 → 20/0.5 | $30 | 72h |
| Range Expansion | range>2×ATR, close in 25%, ATR regime>1.6 | 0.15% exch | 3/1 → 9/0.5 → 20/0.5 | $15 | 72h |

**Shared features:**
- 127 perpetual futures pairs, real per-pair leverage (3x/5x/10x) capped at 10x
- Hours 22-23 UTC blocked (negative expectancy)
- Exchange stop-loss placed at entry (tick-level fill, no 1h boundary gap)
- Multi-stage trailing stop fires via 3s fast-poll (not bar boundary)
- ATR-based vol regime filter: ATR14_1h_current / ATR14_1h_30d_median must exceed threshold
- No SL cooldown (increases profit without hurting DD)
- Long-only on GARCH; Range Expansion takes both directions

**Expected (OOS walk-forward Dec 2025 - Mar 2026):**
- Combined: ~$5/day, MaxDD ~$14, PF 2.7
- 97-102 pairs trading, ~1500 trades over 114 days

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
