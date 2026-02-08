# Trading Bot

Polymarket trading bot with AI betting, copy trading, and Telegram controls. TypeScript, Docker, Coolify.

## Strategies

### AI Betting (Polymarket)

Scans Polymarket markets, fetches news via GDELT, extracts article content with Mozilla Readability, runs blind probability estimation with DeepSeek R1 (chain-of-thought reasoning), applies edge modifiers, evaluates with Kelly criterion, and places bets.

**Pipeline:** Scanner (GAMMA API) -> News (GDELT + Readability) -> Analyzer (DeepSeek R1) -> Evaluator (Kelly + edge modifiers) -> Executor (CLOB/Paper)

| Config | Default | Description |
|--------|---------|-------------|
| `AIBETTING_ENABLED` | `false` | Enable/disable |
| `AIBETTING_MAX_BET` | `$10` | Max per position |
| `AIBETTING_MAX_EXPOSURE` | `$50` | Total open exposure |
| `AIBETTING_MAX_POSITIONS` | `5` | Concurrent positions |
| `AIBETTING_MIN_CONFIDENCE` | `60%` | Min AI confidence to bet |
| `AIBETTING_MIN_EDGE` | `12%` | Min edge vs market price |
| `AIBETTING_SCAN_INTERVAL` | `30min` | Time between scan cycles |

**Blind probability:** Market prices are not shown to the AI. R1 estimates probability independently from news evidence only. This prevents anchoring on market consensus.

**Round-number debiasing:** Prompt instructs R1 to avoid round numbers (40%, 35%, 50%) and use precise estimates (37%, 43%, 52%). Multi-candidate races include sibling market context to differentiate between similar markets.

**Edge modifiers:**
- Extremization (1.3x): pushes AI estimates away from center
- Category bonuses: entertainment +3%, other +2%, politics +1%, crypto -3%
- NO-side bias (+1.5%): corrects for retail YES overpricing

**Filters:**
- Pre-filter: skip if scanner price makes edge mathematically impossible
- Market disagreement cap: 30pp (if AI disagrees with market by >30pp, skip)
- Correlated bet limit: 1 per event group
- Dynamic confidence floor: edge >= 20% lowers confidence requirement to 50%
- 8-hour cache on analyses, auto-invalidated when new news matches open positions
- Prediction market article filter: drops articles about Polymarket/Kalshi odds to prevent circular contamination

**Exit rules:**
- Stop-loss at -25%
- AI re-analysis when price moves >15% against position
- Exit on negative EV or conviction flip
- Settlement risk exit <6h before resolution
- Auto-resolve on market settlement

### Copy Trading

Copy profitable wallets on Solana + EVM chains (Base, BNB, Arbitrum, Avalanche). Includes wash trade detection.

### Polymarket Tracker

Monitor top Polymarket bettors and copy their positions. 30-minute buffer before market end, 90-second trade age window. Resolved market cache prevents repeated attempts on closed markets. Filters out penny-collector traders (average entry price >90c or <10c) to track only actionable signals.

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
| `/settings` | Auto-copy config |
| `/stop` / `/resume` | Kill switch (all strategies) |
| `Manage` button | Close bets, copy bets, or reset paper data |
| `/resetpaper` | Wipe paper trading data |
| `/ai <question>` | Query bot data with DeepSeek |

## Paper vs Live Mode

| | Paper | Live |
|---|-------|------|
| Bankroll | Virtual $10k | Real USDC balance |
| Position limits | None | 5 |
| Exposure limit | None | $50 |
| Copy limit | None | 10/day |
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
