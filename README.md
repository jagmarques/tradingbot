# Trading Bot

Multi-strategy crypto trading bot with Telegram controls.

## Strategies

- **Pump.fun Sniper**: Auto-buy new Solana tokens with Jito MEV protection
- **AI Betting**: DeepSeek-powered Polymarket analysis with edge detection
- **Wallet Copy Trading**: Copy profitable traders on Solana + 8 EVM chains
- **Polymarket Tracker**: Monitor top traders and their positions

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Deployment (Coolify)

1. Set environment variables in dashboard
2. Mount `/data` volume for database persistence

## License

MIT
