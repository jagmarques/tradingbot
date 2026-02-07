# Trading Bot

Multi-strategy crypto trading bot with Telegram controls. TypeScript, Docker, Coolify.

## Strategies

### AI Betting (Polymarket)

Scans Polymarket markets, fetches news, runs 3 parallel DeepSeek analyses with different reasoning perspectives and temperatures, averages into consensus, evaluates edge with Kelly criterion, and places bets.

**Pipeline:** Scanner (GAMMA API) -> Pre-filter -> News (Google RSS) -> Analyzer (DeepSeek x3 perspectives) -> Ensemble Consensus -> Evaluator (Kelly) -> Executor (CLOB/Paper)

| Config | Default | Description |
|--------|---------|-------------|
| `AIBETTING_ENABLED` | `false` | Enable/disable |
| `AIBETTING_MAX_BET` | `$10` | Max per position |
| `AIBETTING_MAX_EXPOSURE` | `$50` | Total open exposure |
| `AIBETTING_MAX_POSITIONS` | `5` | Concurrent positions |
| `AIBETTING_MIN_CONFIDENCE` | `60%` | Min AI confidence to bet |
| `AIBETTING_MIN_EDGE` | `12%` | Min edge vs market price |
| `AIBETTING_SCAN_INTERVAL` | `30min` | Time between scan cycles |

**Ensemble:** Each analysis uses a different reasoning perspective (structural/institutional, recent news/momentum, historical base rates) at temperatures 0.2/0.4/0.6 to create genuine diversity.

**Filters:**
- Pre-filter: skip ensemble if scanner price makes edge mathematically impossible
- Market disagreement cap: 30pp (if AI disagrees with market by >30 percentage points, skip)
- Correlated bet limit: 1 per event group (no 6 Super Bowl bets)
- Ensemble disagreement: skip if variance > 0.025, any member >15pp from mean, or ratio > 5x
- Auto-skip list: markets that trigger disagreement 3 times are permanently skipped
- Dynamic confidence floor: edge >= 20% lowers confidence requirement to 50% (Telegram alert sent)
- 4-hour cache on analyses, auto-invalidated when new news matches open positions

**Exit rules:**
- Stop-loss at -25%
- AI re-analysis when price moves >15% against position
- Exit on negative EV or conviction flip
- Settlement risk exit <6h before resolution

### Token AI (DexScreener)

Discovers high-momentum tokens from DexScreener, analyzes with DeepSeek, sizes with Kelly criterion.

| Config | Default | Description |
|--------|---------|-------------|
| `TOKENAI_ENABLED` | `false` | Enable/disable |
| `TOKENAI_MAX_BET` | `$10` | Max per position |
| `TOKENAI_MAX_EXPOSURE` | `$50` | Total open exposure |
| `TOKENAI_MAX_POSITIONS` | `5` | Concurrent positions |
| `TOKENAI_MIN_CONFIDENCE` | `medium` | low/medium/high |
| `TOKENAI_DAILY_LOSS_LIMIT` | `$25` | Daily loss cap |
| `TOKENAI_KELLY_MULTIPLIER` | `0.25` | Fractional Kelly (1/4) |
| `TOKENAI_SCAN_INTERVAL` | `15min` | Time between scans |

### Pump.fun Sniper (Solana)

Auto-buy new Solana tokens with Jito MEV protection, split buys (3 txs over 10s), auto-sell at 2x/5x/10x.

| Config | Default | Description |
|--------|---------|-------------|
| `MAX_SNIPE_AMOUNT_SOL` | `0.05` | SOL per snipe |
| `MAX_SLIPPAGE_PUMPFUN` | `1%` | Max slippage |
| `DAILY_LOSS_LIMIT_USD` | `$25` | Daily loss cap |

### Copy Trading

Copy profitable wallets on Solana + EVM chains (Base, BNB, Arbitrum, Avalanche). Includes wash trade detection.

### Polymarket Tracker

Monitor top Polymarket bettors (>5% ROI) and copy their positions automatically. Resolved market cache prevents repeated attempts on closed markets.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Open positions across all strategies |
| `/balance` | Wallet balances |
| `/pnl` | P&L breakdown (daily/7d/30d/all-time) |
| `/bets` | AI bet positions (Open/Closed tabs) |
| `/trades` | Recent trades |
| `/traders` | Top tracked wallets |
| `/bettors` | Copied Polymarket bettors |
| `/tokenai` | Token AI status |
| `/settings` | Auto-snipe, auto-copy config |
| `/stop` / `/resume` | Kill switch (all strategies) |
| `Manage` button | Close all bets, copy trades, or everything |
| `/resetpaper` | Wipe paper trading data |
| `/ai <question>` | Query bot data with DeepSeek |

## Paper vs Live Mode

| | Paper | Live |
|---|-------|------|
| Bankroll | Virtual $10k | Real USDC balance |
| Position limits | None | 5 per strategy |
| Exposure limit | None | $50 per strategy |
| Orders | Midpoint prices | Real CLOB orderbook |
| Set via | `TRADING_MODE=paper` | `TRADING_MODE=live` |

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

TypeScript (strict), Node 22, Vitest, SQLite, Grammy (Telegram), ethers.js, @solana/web3.js, Docker, Coolify

## License

MIT
