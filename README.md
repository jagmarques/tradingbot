# Trading Bot

Hyperliquid 2-engine quant portfolio, EVM insider copy trading. TypeScript, Docker, Coolify.

## Strategies

Two uncorrelated engines (correlation ~0.1) trade in parallel with exchange-level stops and multi-stage trailing. Auto-compounding scales margin with equity growth.

### Engine A: GARCH v2 lb1/vw30 Long-Only (LIVE)

1-bar momentum z-score with 30-bar volatility window. Enters longs when 1h and 4h z-scores are both elevated. No ATR regime filter needed (lb1/vw30 is self-filtering). Shorts disabled (all lost money OOS).

### Engine B: Range Expansion (LIVE)

Detects 1h bars where range > 2x ATR(14) with close in upper/lower 25% of bar. Takes continuation in the close direction. Uses ATR vol regime filter (1.6 threshold). Uncorrelated with GARCH momentum.

### Portfolio config

| Engine | Entry | SL | Trail | Margin | Max Hold |
|--------|-------|-----|-------|--------|----------|
| GARCH v2 lb1/vw30 | 1h z>2, 4h z>1.5, no ATR filter | 0.15% exch | 3/1 -> 9/0.5 -> 20/0.5 | auto (5% equity) | 72h |
| Range Expansion | range>2xATR, close in 25%, ATR>1.6 | 0.15% exch | 3/1 -> 9/0.5 -> 20/0.5 | $15 | 72h |

**Shared features:**
- 127 perpetual futures pairs, real per-pair leverage (3x/5x/10x) capped at 10x
- Max 7 concurrent positions across all engines
- Hours 22-23 UTC blocked (negative expectancy)
- Exchange stop-loss placed at entry (tick-level fill)
- Multi-stage trailing stop checked at 1h bar boundaries
- No SL cooldown (re-entry after SL is profitable)
- Long-only on GARCH; Range Expansion takes both directions

**Auto-compounding (GARCH v2):**
- Margin = 5% of account equity (fetched each cycle)
- Clamped between $3 (minimum) and $50 (maximum)
- As equity grows, margin scales automatically
- At $60 equity: $3 margin. At $400 equity: $20 margin. At $1000 equity: $50 margin.

**Verified performance (297 days, corrected MTM backtest):**
- GARCH v2 at $20 margin mc7: $2.40/day, MTM MDD $32, PF 1.88, Calmar 0.074
- MDD scales linearly with margin; Calmar ratio is constant at 0.074

### TrumpGuard

Monitors Trump Truth Social, Fed FOMC, Powell, White House RSS feeds. Opens paper positions on BTC/ETH/SOL on HIGH impact events. Does not close live positions.

### Insider Copy Trading (EVM)

Copies EVM token buys from high-scoring insider wallets.

- Real-time buy/sell detection via Alchemy WebSocket
- Tracked wallets on Ethereum
- GoPlus security checks, $20k min liquidity
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
