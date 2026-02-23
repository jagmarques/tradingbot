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
- GDELT circuit breaker: 3 consecutive timeout failures pauses news fetching 30min
- Prediction market article filter: drops Polymarket/Kalshi articles

**Edge modifiers:** extremization 1.3x, category bonuses, NO-side +1.5% bias

**Exit rules:** stop-loss -15%, take-profit +40%, -10% price drop triggers re-analysis (exits if conviction flips or EV negative), settlement risk <6h

### Copy Betting (Polymarket)

Tracks top Polymarket bettors by ROI, copies their trades with configurable sizing. Penny-collector filter removes traders with median entry >95c or <5c. Settlement-trader filter excludes traders where >50% of trades are within 2h of expiry.

**Quality gates:**
- Win rate gate: traders with <35% win rate after 5+ copy outcomes excluded from tracking pool
- Composite scoring: traders sorted by ROI * winRateBonus (60%+ WR = 1.5x, 45%+ = 1.2x)
- Fast-ban: <25% win rate after 10 trades = multiplier 0 (no copies)
- Profit factor gate: PF < 1.2 after 15 trades = multiplier 0
- Mid-cycle removal: zero-multiplier traders dropped from tracked pool immediately
- Learning threshold: 15 trades before applying per-trader multipliers

### Insider Copy Trading

Copies EVM token buys from high-scoring insider wallets.

- Real-time buy/sell detection via Alchemy WebSocket (ERC20 Transfer events, ~2-5s latency)
- DEX router validation: only treats outgoing transfers to known DEX routers as sells
- Polling fallback every 10 min when WebSocket active, 2.5 min standalone
- Auto-sells when the insider sells (closes all trades for token, idempotent)
- Real-time rug detection via Alchemy WebSocket (Uniswap V2/V3 Burn events)
- Trailing stop: +10%/-15%, +20%/0%, +25%/+10%, +50%/+25%, +100%/+50%, +200%/+100%, +500%+ dynamic (peak-100pts), -50% floor
- Time exits: 4h profit tighten (breakeven stop), 24h stale insider (close if profitable), 48h max hold (unconditional)
- Stablecoin filter: symbol blocklist (60+ tokens) + price-based ($0.90-$1.10 skip)
- GoPlus security checks, $10k min liquidity, $200 max exposure, score-based sizing ($8-$15), 30s price refresh
- Live mode: buys/sells via 1inch routing
- Block-based early buyer detection (first 50 blocks of pair creation, not first 100 transfers)
- Pump guard: skip tokens already pumped 20x+ (DexScreener h24 price change)
- Pair age guard: skip tokens with pair older than 30 days (MAX_GEM_AGE_DAYS) — only copy fresh launches
- Scans Ethereum, Arbitrum, Polygon, Avalanche (chains with free explorer APIs)
- Quality gates: 8+ gem hits across 3+ unique tokens required

**Consistency scoring (score > 75 required, MIN_GEM_HITS = 8):**
- Two formulas: legacy (no copy trade data) and new (with copy trade history)
- Legacy: gems(30, log2 scale, 60-day window) + avg pump(30, sqrt scale, 60-day window) + hold rate(20) + recency(20, 30-day linear)
- New: gems(15, 60-day window) + median pump(10, 60-day window) + win rate(15, Wilson lower bound, 60-day window) + profit factor(20, 60-day window) + expectancy(20, /50 scale, 60-day window) + recency(20, 7-day half-life)
- Hold rate uses enriched_count denominator (only gems with known status count, unenriched gems are neutral)
- Profit factor has confidence scaling: 1 trade = 10% credit, 10+ trades = full credit
- Expectancy floor: negative expectancy after 10+ trades caps score at 50
- Score-based sizing ($8-$15), circuit breaker: 3 consecutive losses = 24h pause

### Rug Monitor

Real-time WebSocket monitoring for EVM token rugs via Alchemy (Uniswap V2/V3 Burn events).

- Monitors all open insider copy trade positions
- Auto-sells on rug detection (WebSocket burn events + periodic liquidity check every 30s)
- Liquidity rug triggers: absolute floor below $5k OR 30% drop from entry liquidity
- GoPlus re-check every 5 min: auto-sells if token becomes honeypot, sell-tax >50%, or transfers paused
- Tracks rugged tokens in DB to skip future buys
- Rug count and USD lost shown in Status view

### Hyperliquid Quant Trading

AI-driven directional trades on BTC/ETH/SOL/DOGE/AVAX/LINK/ARB/OP via Hyperliquid perpetual futures.

- DeepSeek analysis with multi-timeframe data (15m/1h/4h candles, indicators, regime classification)
- Kelly criterion position sizing (half Kelly, stop-distance-adjusted, per-position cap)
- Trailing stop: 50% retracement from peak when profit > 0.5%
- Stagnation exit: 4h max hold for directional positions
- Stop-loss enforced at 2% max (AI prompt + parser cap)
- AI cache: 15min TTL, invalidated on position close
- Funding rate arbitrage (short when funding > 12% APR, close when < 5%)
- Delta-neutral funding arb: equal spot long + perp short for pure yield capture
- 5x leverage, 16 concurrent positions, $25 rolling 24h drawdown limit
- 3-minute directional cycle, 10s stop-loss monitor, overlap protection
- 14-day paper validation required before live trading

## Telegram

**Slash commands:**

| Command | Description |
|---------|-------------|
| `/balance` | Wallet balances (Polygon, Base, Arbitrum, Avax) |
| `/pnl` | P&L with period tabs (today/7d/30d/all-time) |
| `/trades` | Open positions and recent trades |
| `/insiders` | Insider wallets and holdings (2 tabs + chain filter) |
| `/stop` / `/resume` | Kill switch |
| `/mode` | Switch paper/live |
| `/resetpaper` | Wipe paper data (preserves scoring history) |
| `/clearcopies` | Clear copied positions |
| `/ai <question>` | Query DeepSeek |
| `/timezone` | Set display timezone |

**Menu buttons:** Status, Balance, Trades, Bets, Quant, Insiders, Bettors, Mode, Settings, Stop, Resume, Manage

- **Bets** - AI bet positions (open/closed/copy/copy_closed tabs)
- **Bettors** - Tracked Polymarket bettors by ROI
- **Quant** - Hyperliquid quant positions, P&L, paper validation status
- **Settings** - Copy trading and AI betting configuration
- **Manage** - Close all positions, clear copies

## Paper vs Live

| | Paper | Live |
|---|-------|------|
| AI Betting bankroll | Virtual $100 (persists P&L across restarts) | Real USDC |
| Quant bankroll | Virtual $100 (tracks balance, fees, funding) | Real Hyperliquid balance |
| Position limits | Same as live (5 AI bets, 16 quant, $200 copy exposure) | Same |
| AI Betting pricing | Public orderbook bid/ask, midpoint fallback | Real orderbook (CLOB FOK) |
| AI Betting fees | 0.15%/side CLOB + 0.5% slippage + gas | Real CLOB fees |
| Copy trading fees | 3-15% dynamic (liquidity-based) + AMM price impact | Real DEX swap (1inch) |
| Quant fees | 0.045%/side taker (matches Hyperliquid Tier 0) | Real Hyperliquid fees |
| Quant funding | Accrued hourly from live predicted rates | Real funding settlement |
| Quant liquidation | Per-pair rates (BTC 2%, ETH 1.25%, SOL 1% of notional) | Real Hyperliquid margin |
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
