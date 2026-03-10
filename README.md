# Trading Bot

Polymarket AI betting, Polymarket copy trading, EVM insider copy trading, Hyperliquid + Lighter DEX quant trading, rug monitoring. TypeScript, Docker, Coolify.

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

**Edge modifiers:** category bonuses, NO-side +1.5% bias, price zone multiplier

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

### Hyperliquid Quant Trading

Directional trades on 15 perpetual futures pairs via Hyperliquid and Lighter DEX.

**Pairs:** BTC, ETH, SOL, XRP, DOGE, AVAX, LINK, ARB, BNB, OP, SUI, DOT, TIA, APT, WIF

**10 decision engines:**
- Technical 4h (7): PSAR, ZLEMA, Vortex, Schaff, DEMA, HMA, CCI (all on Lighter)
- Technical 1h (2): HMA 1h, ZLEMA 1h (both on Lighter, 4h HTF filter)
- AI (1): DeepSeek R1 (reasoner) with 15m+1h+4h+1d candles, indicators, microstructure, funding, regime, and technical engine signals as context
- Live (hybrid): HMA 4h, Schaff, DEMA on Lighter + AI on HL. Paper: all 9 technical engines

**Execution:**
- $10 fixed margin per trade, 10x leverage
- 50 max paper positions, 5 max live positions
- $25 rolling 24h drawdown limit per strategy
- 15-minute cycle, 10s position monitor
- Trailing stop (per-engine config), stagnation exit (technical engines only), stop-loss (ATR-based, 5% max)
- AI: no stagnation (uses signal-flip only), closes on reversal (long->short or vice versa), flat signals ignored
- Scheduler runs technical engines first, collects signals per pair, passes to AI as reference context
- Exchange-level stop-loss orders on both HL and Lighter
- Bidirectional reconciliation: orphan close + phantom detection
- 14-day paper validation before live

## Trading Modes

| | Paper | Hybrid | Live |
|---|-------|--------|------|
| Description | All strategies paper | AI + select engines live, rest paper | All live |
| AI Betting | Virtual bankroll | Virtual bankroll | Real USDC |
| Quant AI engine (R1) | Paper | Live ($10 margin, HL) | Live |
| Quant live engines (HMA 4h, Schaff, DEMA) | Paper | Live + Paper (Lighter) | Live |
| Quant paper engines (ZLEMA 4h, HMA 1h, ZLEMA 1h, PSAR, Vortex, CCI) | Paper | Paper (Lighter) | Live |
| Note: live engines also run paper for independent performance tracking ||||
| Set via | `TRADING_MODE=paper` | `TRADING_MODE=hybrid` | `TRADING_MODE=live` |

**Paper simulation:**
- Virtual $1250 quant bankroll ($125/engine x 10 engines)
- Simulated fees: 0.15%/side CLOB + 0.5% slippage (Polymarket), dynamic 3-15% (insider copy)
- Simulated funding: accrued hourly from live predicted rates
- Simulated liquidation: per-pair maintenance margin rates

## Telegram

**Slash commands:**

| Command | Description |
|---------|-------------|
| `/balance` | Portfolio value (HL + LT equity) |
| `/pnl` | P&L with period tabs (today/7d/30d/all-time) |
| `/trades` | Open positions and recent trades |
| `/insiders` | Insider wallets and holdings (2 tabs + chain filter) |
| `/stop` / `/resume` | Kill switch |
| `/mode` | Switch paper/hybrid/live |
| `/resetpaper` | Wipe paper data (preserves scoring history) |
| `/clearcopies` | Clear copied positions |
| `/ai <question>` | Query DeepSeek |
| `/timezone` | Set display timezone |

**Menu buttons:** Status, Balance, Trades, Bets, Quant, Insiders, Bettors, Mode, Settings, Stop, Resume, Manage

- **Status** - P&L summary (live/paper split in hybrid mode)
- **Bets** - AI bet positions (open/closed/copy/copy_closed tabs)
- **Bettors** - Tracked Polymarket bettors by ROI
- **Quant** - Quant positions (HL + LT), engine stats, live/paper P&L split in hybrid
- **Settings** - Copy trading and AI betting configuration
- **Manage** - Close all positions, clear copies

## Config

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_MODE` | `paper` | paper, hybrid, or live |
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
| `QUANT_VIRTUAL_BALANCE` | `$1000` | Quant paper trading balance ($100/engine x 10) |
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

TypeScript (strict), Node 22, Vitest, SQLite, Grammy (Telegram), ethers.js, Hyperliquid SDK, zklighter-sdk, Docker, Coolify

## License

MIT
