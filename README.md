# Trading Bot

Polymarket AI betting, Polymarket copy trading, EVM insider copy trading, Hyperliquid quant trading, rug monitoring. TypeScript, Docker, Coolify.

## Strategies

### AI Betting (Polymarket)

Scans markets, fetches news via GDELT, runs blind probability estimation with DeepSeek R1, evaluates with Kelly criterion, places bets.

**Pipeline:** Scanner (GAMMA API) -> News (GDELT + Readability) -> Analyzer (DeepSeek R1) -> Evaluator (Kelly) -> Executor (CLOB/Paper)

- Blind probability: market prices hidden from AI to prevent anchoring
- Round-number debiasing: R1 avoids 40%, 35%, uses 37%, 43%
- Sibling detection: injects competitor names for multi-candidate markets
- 8h analysis cache, auto-invalidated on new news
- Prediction market article filter: drops Polymarket/Kalshi articles

**Edge modifiers:** extremization 1.3x, category bonuses, NO-side +1.5% bias

**Exit rules:** stop-loss -15%, take-profit +40%, conviction flip, settlement risk <6h

### Copy Betting (Polymarket)

Tracks top Polymarket bettors by ROI, copies their trades with configurable sizing. Penny-collector filter removes traders with median entry >95c or <5c. Settlement-trader filter excludes traders where >50% of trades are within 2h of expiry.

### Insider Copy Trading

Copies EVM token buys from high-scoring insider wallets.

- Auto-sells when the insider sells
- Real-time rug detection via Alchemy WebSocket (Uniswap V2/V3 Burn events)
- Trailing stop-loss ladder, +500% target, -80% floor
- GoPlus security checks (honeypot, high tax, scam detection)
- $200 max exposure, $10 per position, 15% rug exit fee

### Rug Monitor

Real-time WebSocket monitoring for EVM token rugs via Alchemy (Uniswap V2/V3 Burn events).

- Monitors all open insider copy trade positions
- Auto-sells on rug detection
- Tracks rugged tokens in DB to skip future buys
- /status shows total rug count and USD lost

### Hyperliquid Quant Trading

AI-driven directional trades on BTC/ETH/SOL via Hyperliquid perpetual futures.

- DeepSeek analysis with market data pipeline (technical indicators, regime classification)
- Kelly criterion position sizing (quarter Kelly, 20% balance cap)
- Funding rate arbitrage (short when funding > 15% APR, close when < 5%)
- Max 5x leverage, 6 concurrent positions, $25 daily drawdown limit
- 14-day paper validation required before live trading

## Telegram

**Slash commands:**

| Command | Description |
|---------|-------------|
| `/status` | Positions across all strategies |
| `/balance` | Wallet balances (Polygon, Base, Arbitrum, Avax) |
| `/pnl` | P&L with period tabs (today/7d/30d/all-time) |
| `/trades` | Open positions and recent trades |
| `/insiders` | Insider wallets and holdings (2 tabs + chain filter) |
| `/stop` / `/resume` | Kill switch |
| `/mode` | Switch paper/live |
| `/resetpaper` | Wipe paper data |
| `/clearcopies` | Clear copied positions |
| `/ai <question>` | Query DeepSeek |
| `/timezone` | Set display timezone |

**Menu buttons:** Status, Balance, P&L, Trades, Bets, Quant, Insiders, Bettors, Mode, Settings, Stop, Resume, Manage

- **Bets** - AI bet positions (open/closed/copy/copy_closed tabs)
- **Bettors** - Tracked Polymarket bettors by ROI
- **Quant** - Hyperliquid quant positions, P&L, paper validation status
- **Settings** - Copy trading and AI betting configuration
- **Manage** - Close all positions, clear copies

## Paper vs Live

| | Paper | Live |
|---|-------|------|
| Bankroll | Virtual $10k | Real USDC |
| Position limits | None | 5 |
| Exposure limit | None | $50 |
| Orders | Midpoint prices | Real orderbook (CLOB/1inch) |
| Set via | `TRADING_MODE=paper` | `TRADING_MODE=live` |

## Config

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_MODE` | `paper` | paper or live |
| `AIBETTING_ENABLED` | `false` | Enable AI betting |
| `AIBETTING_MAX_BET` | `$10` | Max per position |
| `AIBETTING_MAX_EXPOSURE` | `$50` | Total open exposure |
| `AIBETTING_MIN_EDGE` | `8%` | Min edge vs market |
| `AIBETTING_MIN_CONFIDENCE` | `60%` | Min AI confidence |
| `AIBETTING_SCAN_INTERVAL` | `30min` | Scan cycle interval |
| `AIBETTING_STOP_LOSS` | `15%` | Stop-loss threshold |
| `AIBETTING_TAKE_PROFIT` | `40%` | Take-profit threshold |
| `DAILY_LOSS_LIMIT_USD` | `$25` | Daily loss limit |
| `DEEPSEEK_DAILY_BUDGET` | `$1.00` | Daily DeepSeek spend cap |
| `QUANT_ENABLED` | `false` | Enable Hyperliquid quant trading |
| `QUANT_VIRTUAL_BALANCE` | `$100` | Quant paper trading balance |
| `ALCHEMY_API_KEY` | - | Alchemy API key for real-time rug detection |

**Required keys:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `POLYMARKET_API_KEY`, `POLYMARKET_SECRET`, `POLYGON_PRIVATE_KEY`, `DEEPSEEK_API_KEY`

**Optional keys:** `POLYMARKET_PASSPHRASE`, `HYPERLIQUID_PRIVATE_KEY`, `HYPERLIQUID_WALLET_ADDRESS`, `PRIVATE_KEY_EVM`, `ETHERSCAN_API_KEY`, `SNOWTRACE_API_KEY`, `ALCHEMY_API_KEY`, `ONEINCH_API_KEY`

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

TypeScript (strict), Node 22, Vitest, SQLite, Grammy (Telegram), ethers.js, Hyperliquid SDK, Docker, Coolify

## License

MIT
