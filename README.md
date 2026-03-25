# Trading Bot

Hyperliquid GARCH-chan quant, news trading engine, EVM insider copy trading. TypeScript, Docker, Coolify.

## Strategies

### Insider Copy Trading (EVM)

Copies EVM token buys from high-scoring insider wallets.

- Real-time buy/sell detection via Alchemy WebSocket (ERC20 Transfer events, ~2-5s latency)
- Polling fallback every 10 min when WebSocket active, 2.5 min standalone
- Exit on insider sell only (plus safety exits: rug, honeypot, stale price)
- Real-time rug detection via Alchemy WebSocket (Uniswap V2/V3 Burn events)
- Pre-pump token discovery: catches tokens with 10-99% change and high tx count
- GoPlus security checks, $20k min liquidity, $200 max exposure, 30s price refresh
- Dynamic position sizing: $3-$20 based on score + copy trade performance
- Live mode: buys/sells via 1inch routing
- Scans Ethereum, Arbitrum, Avalanche

**Wallet scoring (score > 60 required):**
- Legacy (no copy trades): gems + avg pump + hold rate + recency = 100pts
- Advanced (with copy trades): gems + median pump + Wilson WR + profit factor + expectancy + recency = 100pts
- Circuit breaker: 3 consecutive losses = 24h pause

### Rug Monitor

Real-time WebSocket monitoring for EVM token rugs via Alchemy.

- Monitors all open insider copy trade positions
- Auto-sells on rug detection (WebSocket burn events + periodic liquidity check every 30s)
- Liquidity rug triggers: absolute floor below $5k OR 30% drop from entry liquidity
- GoPlus re-check every 5 min: auto-sells if honeypot, sell-tax >50%, or transfers paused

### Hyperliquid Quant Trading

**GARCH-chan (LIVE)**

GARCH(1,1) z-score momentum on 20 perpetual futures pairs.

- z > 4.5 longs, z < -3.0 shorts, ADX 30/25, EMA 9/21 + BTC trend
- 10x leverage, compound 4% sizing, SL 3%, TP 10%, max hold 48h
- 15-minute scheduler, 10s position monitor, $15/day loss limit

**News Trading Engine (LIVE)**

Opens positions on 20 altcoins immediately on crypto-relevant news.

- 13 RSS feeds + Tavily, 3-30s detection latency
- Cerebras AI classifies BULLISH/BEARISH/NEUTRAL + impact level (HIGH/MEDIUM/LOW)
- Source-based default impact: Trump/FOMC = HIGH, CoinDesk = MEDIUM, CFTC = LOW
- BTC EMA9/21 trend filter, SL 2%, adaptive trailing by impact (HIGH: 5%/2%, MEDIUM: 2%/1%)
- AI exit advisor: Cerebras decides HOLD/TAKE_PROFIT/CLOSE every 15s
- Reversal logic: stronger opposing signal closes positions and reverses
- Stale exit: 1h if < 0.3% directional move, max hold 24h

**BTC Event Engine (PAPER)**

Detects BTC >0.7% 1h moves, trades 10 altcoins with BTC trend filter.

- SL 3%, TP 7%, 24h max hold
- Paper validation before live promotion

**Unified Account (Hyperliquid):**
- `getSpotClearinghouseState` returns real portfolio value
- When perps equity <= marginUsed, use spot USDC as equity

## Trading Modes

| | Paper | Hybrid | Live |
|---|-------|--------|------|
| Description | All strategies paper | Quant live, rest paper | All live |
| Quant (GARCH-chan) | Paper | Live | Live |
| News Trading | Paper | Live | Live |
| Insider Copy | Paper | Paper | Live |
| Set via | `TRADING_MODE=paper` | `TRADING_MODE=hybrid` | `TRADING_MODE=live` |

## Telegram

**Menu buttons:** Status, Balance, Trades, Quant, Insiders, Manage

| Command | Description |
|---------|-------------|
| `/balance` | Portfolio value (HL equity) |
| `/pnl` | P&L with period tabs (today/7d/30d/all-time) |
| `/trades` | Open positions and recent trades |
| `/insiders` | Insider wallets and holdings |
| `/stop` / `/resume` | Kill switch |
| `/mode` | Switch paper/hybrid/live |
| `/ai <question>` | Query AI |
| `/timezone` | Set display timezone |

## Config

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_MODE` | `paper` | paper, hybrid, or live |
| `QUANT_ENABLED` | `false` | Enable Hyperliquid quant trading |
| `DAILY_LOSS_LIMIT_USD` | `$25` | Daily loss limit |
| `ALCHEMY_API_KEY` | - | Alchemy API key for insider detection |

**Required keys:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

**Optional keys:** `HYPERLIQUID_PRIVATE_KEY`, `HYPERLIQUID_WALLET_ADDRESS`, `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `PRIVATE_KEY_EVM`, `ETHERSCAN_API_KEY`, `ALCHEMY_API_KEY`, `TAVILY_API_KEY_1`

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
