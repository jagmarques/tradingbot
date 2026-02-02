# Trading Bot

Hybrid crypto trading bot combining two automated strategies:

1. **Pump.fun Sniper** (Solana) - Detects new token launches and executes split buys with auto-sell targets
2. **Polymarket Arbitrage** (Polygon) - Latency arbitrage on prediction markets

## Requirements

- Node.js 20+
- Solana wallet with SOL for gas
- Polygon wallet with USDC for trading
- Helius API key (Solana RPC)
- Polymarket API credentials
- Telegram bot token (for alerts)

## Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Configure your API keys and wallets in .env

# Run in development
npm run dev

# Build for production
npm run build
npm start
```

## Environment Variables

See `.env.example` for all required variables. Key settings:

- `TRADING_MODE` - `paper` or `live`
- `HELIUS_API_KEY` - Solana RPC via Helius
- `SOLANA_PRIVATE_KEY` - Base58 encoded private key
- `POLYMARKET_API_KEY` / `POLYMARKET_SECRET` - CLOB credentials
- `POLYGON_PRIVATE_KEY` - Polygon wallet private key
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` - Alerts

## Scripts

```bash
npm run dev        # Development with hot reload
npm run build      # TypeScript compilation
npm start          # Run production build
npm test           # Run tests
npm run lint       # ESLint
npm run lint:fix   # ESLint with auto-fix
npm run format     # Prettier formatting
npm run typecheck  # Type checking without build
```

## Strategy 1: Pump.fun Sniper

- Monitors Solana for new Pump.fun token launches
- Filters honeypots and rug pulls
- Split buy execution (30/30/40)
- Auto-sell at 10x/50x/100x
- Trailing stop-loss after 5x gain

## Strategy 2: Polymarket Arbitrage

- Connects to Polymarket CLOB WebSocket
- Maintains local orderbook
- Detects latency vs spot price
- Executes FOK orders when confidence > 85%

## Deployment

Docker and PM2 configs included for production deployment.

```bash
# Docker
docker build -t tradingbot .
docker-compose up -d

# PM2
pm2 start ecosystem.config.cjs
```

## License

MIT
