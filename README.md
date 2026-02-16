# Trading Bot

Polymarket AI betting, copy trading, and insider gem scanner. TypeScript, Docker, Coolify.

## Strategies

### AI Betting (Polymarket)

Scans markets, fetches news via GDELT, runs blind probability estimation with DeepSeek R1, evaluates with Kelly criterion, places bets.

**Pipeline:** Scanner (GAMMA API) -> News (GDELT + Readability) -> Analyzer (DeepSeek R1 x2 ensemble) -> Evaluator (Kelly + Bayesian) -> Executor (CLOB/Paper)

- Blind probability: market prices hidden from AI to prevent anchoring
- Round-number debiasing: R1 avoids 40%, 35%, uses 37%, 43%
- Sibling detection: injects competitor names for multi-candidate markets
- 8h analysis cache, auto-invalidated on new news
- Prediction market article filter: drops Polymarket/Kalshi articles

**Edge modifiers:** extremization 1.3x, category bonuses, NO-side +1.5% bias

**Exit rules:** stop-loss -15%, take-profit +40%, conviction flip, settlement risk <6h

### Copy Trading (Polymarket)

Tracks top Polymarket bettors by ROI, copies their trades with configurable sizing. Penny-collector filter removes traders with avg entry >90c or <10c. 30-minute buffer before market end.

### Insider Gem Scanner

Scans 7 chains for pumped tokens, identifies early buyers, tracks repeat winners as insiders.

**Chains:** Ethereum, Base, Arbitrum, Polygon, Optimism, Avalanche, Solana

**Pipeline:** GeckoTerminal (trending/new/top pools) -> Early buyer detection (Etherscan/Helius RPC) -> Wallet tracking -> Insider scoring -> Security checks -> Paper/live buy

**Insider qualification:** 5+ gem hits, sniper bot filter (<24h hold excluded)

**Wallet scoring (0-100):**

| Factor | Weight | Description |
|--------|--------|-------------|
| Gem count | 30pts | Log-scaled, need 100+ for max |
| Avg pump | 30pts | Sqrt curve, need 50x+ for max |
| Hold rate | 20pts | % of gems still held |
| Recency | 20pts | Decays over 90 days |

**Gem scoring (0-100):**

| Factor | Weight | Tiers |
|--------|--------|-------|
| Insider count | 40pts | 20+=40, 10+=25, 5+=15 |
| Hold rate | 30pts | 80%+=30, 60%+=20, 40%+=10 |
| Avg insider quality | 30pts | 8+=30, 5+=20, 3+=10 |

**Security checks:** GoPlus kill-switch (all chains): honeypot, mintable, hidden owner, high tax = score 0. Solana: on-chain freeze/mint authority check (revoked = safe, active = blocked).

**Buy filters:** score >= 80, min liquidity $2k, max FDV $500k, max 24h pump 10x, no duplicates.

**Exit rules:** stop-loss -70%, auto-sell when high-score insider (80+) sells, auto-close on rug (liquidity < $500).

**Display:** Pump from Pump.fun graduation ($69k FDV) for Solana tokens. DexScreener batch pricing.

## Telegram

| Command | Description |
|---------|-------------|
| `/status` | Positions across all strategies |
| `/balance` | Wallet balances |
| `/pnl` | P&L (daily/7d/30d/all-time) |
| `/bets` | AI bets (Open/Closed/Copy tabs) |
| `/trades` | Recent trades |
| `/insiders` | Insider wallets, holdings, gems |
| `/stop` / `/resume` | Kill switch |
| `/mode` | Switch paper/live |
| `/settings` | Auto-copy config |
| `/resetpaper` | Wipe paper data |
| `/ai <question>` | Query bot with DeepSeek |

**Insider tabs:** Wallets (address, score, gem count, avg gain) | Holding (tokens insiders hold) | Gems (paper-bought positions with P&L)

**Chain filter:** persists across tab switches (ETH, Base, Arb, Poly, Opt, Avax, SOL, All)

## Paper vs Live

| | Paper | Live |
|---|-------|------|
| Bankroll | Virtual $10k | Real USDC/SOL |
| Position limits | None | 5 |
| Exposure limit | None | $50 |
| Orders | Midpoint prices | Real orderbook (CLOB/Jupiter/1inch) |
| Gem trades | DexScreener prices | Jupiter (SOL) / 1inch (EVM) |
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

**Required keys:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `POLYMARKET_API_KEY`, `POLYMARKET_SECRET`, `POLYMARKET_PASSPHRASE`, `POLYGON_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, `ALCHEMY_SOLANA_RPC`, `DEEPSEEK_API_KEY`

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
