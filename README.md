# Trading Bot

Polymarket AI betting, high-frequency crypto markets, high-probability bonds, Polymarket copy trading, EVM insider copy trading, Hyperliquid quant trading. TypeScript, Docker, Coolify.

## Strategies

### AI Betting (Polymarket)

Scans markets, fetches news via GDELT, runs blind probability estimation with Cerebras (Llama 3.3 70B), evaluates with Kelly criterion, places bets.

**Pipeline:** Scanner (GAMMA API) -> News (GDELT + Readability) -> Analyzer (Cerebras) -> Evaluator (Kelly) -> Executor (CLOB/Paper)

- Blind probability: market prices hidden from AI to prevent anchoring
- Round-number debiasing: avoids 40%, 35%, uses 37%, 43%
- Sibling detection: injects competitor names for multi-candidate markets
- 8h analysis cache, auto-invalidated on new news
- GDELT circuit breaker: 3 consecutive timeout failures pauses news fetching 30min
- Prediction market article filter: drops Polymarket/Kalshi articles
- KL divergence scoring: detects significant AI vs market disagreement

**Edge modifiers:** category bonuses, NO-side +1.5% bias, price zone multiplier

**Exit rules:** stop-loss -15%, take-profit +40%, -10% price drop triggers re-analysis (exits if conviction flips or EV negative), settlement risk <6h

### HF Maker (Polymarket 15-min Crypto Markets)

Late-entry maker strategy on BTC/ETH/SOL 15-minute up/down markets.

- Binance WebSocket for real-time price feeds
- Only enters in last 45-60 seconds of each 15-min window
- Requires 0.3%+ price move from window start to confirm direction
- Entry prices scale with move magnitude: 70c (0.3% move), 75c (0.5% move), 80c (0.8%+ move)
- Resolution compares final price to window start price (not entry price)
- Handles flat price (down wins) and missing price (cancel + refund)
- Paper mode with simulated fills

### High-Probability Bonds (Polymarket)

Buys markets with YES or NO price > 90c resolving within 120 days.

- Scans via shared GAMMA API fetch (15s interval)
- Min volume $100, min annualized yield 20%
- Stop-loss at 80c
- Paper mode with position tracking to resolution
- 1-hour guard before counting disappeared markets as resolved

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
- Polling fallback every 10 min when WebSocket active, 2.5 min standalone
- Exit on insider sell only (plus safety exits: rug, honeypot, stale price)
- Real-time rug detection via Alchemy WebSocket (Uniswap V2/V3 Burn events)
- Pre-pump token discovery: catches tokens with 10-99% change and high tx count
- GoPlus security checks, $20k min liquidity, $200 max exposure, 30s price refresh
- Dynamic position sizing: $3-$20 based on score + copy trade performance (profit factor, win rate)
- Live mode: buys/sells via 1inch routing
- Block-based early buyer detection (first 50 blocks of pair creation)
- Pump guard: skip tokens already pumped 20x+
- Pair age guard: skip tokens older than 30 days
- Scans Ethereum, Arbitrum, Polygon, Avalanche
- Quality gates: 5+ gem hits across 3+ unique tokens, no wallet cap

**Wallet scoring (score > 60 required):**
- Legacy (no copy trades): gems + avg pump + hold rate + recency = 100pts
- Advanced (with copy trades): gems + median pump + Wilson WR + profit factor + expectancy + recency = 100pts
- Rug rate penalty: applied after main formula if wallet has 5+ gems and 2+ rugged; >40% rug rate caps at 50, >20% applies -15, >10% applies -8
- Dynamic sizing: proven profitable wallets (PF>2, WR>50%) get 1.5x, losing wallets get 0.5x
- Circuit breaker: 3 consecutive losses = 24h pause

### Rug Monitor

Real-time WebSocket monitoring for EVM token rugs via Alchemy (Uniswap V2/V3 Burn events).

- Monitors all open insider copy trade positions
- Auto-sells on rug detection (WebSocket burn events + periodic liquidity check every 30s)
- Liquidity rug triggers: absolute floor below $5k OR 30% drop from entry liquidity
- GoPlus re-check every 5 min: auto-sells if token becomes honeypot, sell-tax >50%, or transfers paused
- Tracks rugged tokens in DB to skip future buys
- Rug count and USD lost shown in Status view

### Hyperliquid Quant Trading (GARCH-chan)

GARCH z-score momentum with Chandelier ATR stop-loss on 19 perpetual futures pairs.

**Pairs:** OP, WIF, ARB, LDO, AVAX, TRUMP, DASH, DOT, ENA, DOGE, APT, SEI, LINK, ADA, WLD, XRP, SUI, TON, UNI

**Engine:**
- GARCH(1,1) volatility model with z-score entry signals
- Chandelier ATR trailing stop-loss
- 15-minute scheduler cycle
- $10 fixed margin per trade, 10x leverage

**Execution:**
- $25 rolling 24h drawdown limit per strategy
- 10s position monitor
- ATR-based stop-loss (capped 3.5%), trailing stop activation/distance configurable
- Bidirectional reconciliation: orphan close + phantom detection
- Paper spread: 0.04% per side
- Exchange-level stop-loss orders on Hyperliquid

**Unified Account (Hyperliquid):**
- `getSpotClearinghouseState` returns real portfolio value
- When perps equity <= marginUsed, use spot USDC as equity

## Trading Modes

| | Paper | Hybrid | Live |
|---|-------|--------|------|
| Description | All strategies paper | Quant live, rest paper | All live |
| AI Betting | Virtual bankroll | Virtual bankroll | Real USDC |
| HF Maker | Paper simulation | Paper simulation | Real CLOB |
| Bonds | Paper simulation | Paper simulation | Real CLOB |
| Quant (GARCH-chan) | Paper | Live ($10 margin) | Live |
| Set via | `TRADING_MODE=paper` | `TRADING_MODE=hybrid` | `TRADING_MODE=live` |

**Paper simulation:**
- Virtual $100 AI betting bankroll
- Simulated fees: 0.15%/side CLOB + 0.5% slippage (Polymarket), dynamic 3-15% (insider copy)
- Simulated funding: accrued hourly from live predicted rates
- Simulated liquidation: per-pair maintenance margin rates

## Telegram

**Slash commands:**

| Command | Description |
|---------|-------------|
| `/balance` | Portfolio value (HL equity) |
| `/pnl` | P&L with period tabs (today/7d/30d/all-time) |
| `/trades` | Open positions and recent trades |
| `/insiders` | Insider wallets and holdings (2 tabs + chain filter) |
| `/poly` | Polymarket strategies (AI bets, HF Maker, Bonds) |
| `/stop` / `/resume` | Kill switch |
| `/mode` | Switch paper/hybrid/live |
| `/resetpaper` | Wipe paper data (preserves scoring history) |
| `/clearcopies` | Clear copied positions |
| `/ai <question>` | Query AI |
| `/timezone` | Set display timezone |

**Menu buttons:** Status, Balance, Trades, Bets, Quant, Insiders, Bettors, Mode, Settings, Stop, Resume, Manage

- **Status** - P&L summary (live/paper split in hybrid mode), HF Maker stats, Bonds stats
- **Bets** - AI bet positions (open/closed/copy/copy_closed tabs)
- **Bettors** - Tracked Polymarket bettors by ROI
- **Quant** - Quant positions, engine stats, live/paper P&L split in hybrid
- **Settings** - Copy trading and AI betting configuration
- **Manage** - Close all positions, clear copies

## Config

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_MODE` | `paper` | paper, hybrid, or live |
| `AIBETTING_ENABLED` | `false` | Enable AI betting + HF Maker + Bonds |
| `AIBETTING_MAX_BET` | `$10` | Max per position |
| `AIBETTING_MAX_EXPOSURE` | `$50` | Total open exposure |
| `AIBETTING_MIN_EDGE` | `8%` | Min edge vs market |
| `AIBETTING_MIN_CONFIDENCE` | `60%` | Min AI confidence |
| `AIBETTING_SCAN_INTERVAL` | `30min` | Scan cycle interval |
| `AIBETTING_STOP_LOSS` | `15%` | Stop-loss threshold |
| `AIBETTING_TAKE_PROFIT` | `40%` | Take-profit threshold |
| `DAILY_LOSS_LIMIT_USD` | `$25` | Daily loss limit |
| `QUANT_ENABLED` | `false` | Enable Hyperliquid quant trading |
| `ALCHEMY_API_KEY` | - | Alchemy API key for real-time rug detection |

**Required keys:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `POLYMARKET_API_KEY`, `POLYMARKET_SECRET`, `POLYGON_PRIVATE_KEY`, `GROQ_API_KEY`

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
