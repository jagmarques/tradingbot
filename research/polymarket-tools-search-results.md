# Polymarket Open-Source Trading Tools & Strategies Research
**Date: 2026-03-19**

---

## CRITICAL WARNING: Spam/Scam Repos Dominate GitHub Search Results

The majority of repos returned when searching "polymarket trading bot" on GitHub are **SEO-spam keyword-stuffed repos**. Signs of spam: repeated keywords in description, all updated on the same day, suspiciously high fork-to-star ratios, TypeScript repos claiming to be Python bots. These are likely honeypots or low-quality clones. The legitimate repos are listed below.

---

## TIER 1: HIGH-QUALITY, LEGITIMATE TOOLS (Use/Learn From These)

### 1. Polymarket/agents (Official)
- **URL**: https://github.com/Polymarket/agents
- **Stars**: 2,566 | **Forks**: 599
- **Language**: Python | **License**: MIT
- **Last commit**: 2024-11-05 (STALE - no commits in 4+ months)
- **Strategy**: Framework for building AI trading agents, not a specific strategy. Uses OpenAI for probability estimation, RAG for data retrieval, LangChain for orchestration
- **Key features**: Polymarket API integration, Chroma vector DB, multi-source data (news, betting services, web search), CLI interface
- **Documented results**: None
- **Verdict**: Good reference architecture but effectively abandoned. The framework is a starting point, not a ready-to-run bot. Dependencies (OpenAI, LangChain) match our stack options
- **Learn from**: Agent architecture, API integration patterns, RAG approach

### 2. warproxxx/poly-maker (Featured on Polymarket Blog)
- **URL**: https://github.com/warproxxx/poly-maker
- **Stars**: 945 | **Forks**: 379
- **Language**: Python | **License**: MIT
- **Last commit**: 2026-01-23 (recently active)
- **Strategy**: Automated market making - provides liquidity on both sides of the order book. Targets low-volatility markets with high reward rates
- **Key features**: Google Sheets config interface, WebSocket order book monitoring, position merging, risk controls, volatility ranking
- **Documented results**: Author earned $200/day starting with $10K, peaked at $700-800/day. **BUT the README now explicitly warns: "In today's market, this bot is not profitable and will lose money"**
- **Verdict**: The BEST reference implementation for market making. Real code from a real trader who was featured on Polymarket's official blog. Honest about current profitability issues
- **Learn from**: Market making mechanics, Google Sheets config pattern, position merging, reward optimization

### 3. Polymarket/poly-market-maker (Official)
- **URL**: https://github.com/Polymarket/poly-market-maker
- **Stars**: 269 | **Forks**: 93
- **Language**: Python | **License**: MIT
- **Created**: 2022-02-24 | **Last release**: v0.0.3 (Feb 2023)
- **Strategy**: Two modes - AMM strategy and Bands strategy. Both sync every 30 seconds, fetch midpoint, compute target orders, cancel/replace
- **Key features**: Docker deployment, configurable sync interval, graceful shutdown, condition ID based market selection
- **Documented results**: None. Marked as "experimental"
- **Verdict**: Official but outdated. Useful as reference for how Polymarket intends market makers to interact with their CLOB
- **Learn from**: Official API patterns, AMM vs Bands strategy approaches

### 4. humanplane/cross-market-state-fusion
- **URL**: https://github.com/humanplane/cross-market-state-fusion
- **Stars**: 360 | **Forks**: 102
- **Language**: Python | **License**: Unknown
- **Last commit**: 2026-01-03
- **Strategy**: RL agent exploiting information lag between Binance futures (fast) and Polymarket prediction markets (slow). Uses PPO with custom temporal architecture. Fuses 18-dimensional observations from both markets
- **Key features**: MLX (Apple Silicon optimized), WebSocket feeds from Binance + Polymarket, share-based PnL optimization, TemporalEncoder for momentum features
- **Documented results**: $50K paper trading profit / 2,500% ROI in 10+ hours. BUT paper only - authors warn real execution would see 20-50% degradation from slippage/latency
- **Verdict**: Most technically interesting project. The cross-market information lag concept is a real alpha source. MLX optimization relevant since we're on Apple Silicon
- **Learn from**: Cross-market data fusion, RL approach, information lag exploitation, Apple Silicon ML optimization

### 5. evan-kolberg/prediction-market-backtesting
- **URL**: https://github.com/evan-kolberg/prediction-market-backtesting
- **Stars**: Unknown (smaller repo)
- **Language**: Python 3.12+ (Rust extensions)
- **Strategy**: Backtesting framework, not a trading bot. Built on NautilusTrader
- **Key features**: Full L2 order book replay via PMXT, realistic fee/slippage modeling, 8+ strategy examples (EMA crossover, final-period momentum, VWAP reversion, spread capture, panic fade, breakout), interactive HTML charting with Bokeh/Plotly
- **Documented results**: Framework for testing, not results themselves
- **Verdict**: Essential tool for validating any strategy before live trading. The included strategy examples are a goldmine of ideas
- **Learn from**: Backtesting methodology, NautilusTrader integration, strategy templates

### 6. valory-xyz/trader
- **URL**: https://github.com/valory-xyz/trader
- **Stars**: 65 | **Forks**: 29
- **Language**: Python
- **Last release**: v0.31.9 (2026-03-19) - VERY actively maintained (4,290 commits, 210 releases)
- **Strategy**: Confidence-based tiered betting. Uses "AI Mech" to estimate probabilities, then bets when AI confidence diverges from market price. Kelly Criterion and threshold-based sizing
- **Key features**: Multi-agent distributed trading, Safe multisig wallet, supports Omen (Gnosis) + Polymarket (Polygon), modular strategy system
- **Documented results**: None specific
- **Verdict**: Most actively maintained project. Production-grade architecture with multi-agent coordination. The confidence-threshold approach is sound
- **Learn from**: Production deployment patterns, multi-agent architecture, confidence-based betting, Kelly Criterion implementation

### 7. ent0n29/polybot
- **URL**: https://github.com/ent0n29/polybot
- **Stars**: Unknown
- **Language**: Java 21
- **Strategy**: Complete-set arbitrage on Up/Down binaries, plus research tools for replication scoring and strategy analysis
- **Key features**: Kafka/Redpanda event streaming, ClickHouse data warehouse, Grafana/Prometheus monitoring, paper + live modes, 5 microservices
- **Documented results**: None
- **Verdict**: Enterprise-grade infrastructure. Overkill for a solo operation but excellent reference for production data pipelines
- **Learn from**: Event streaming architecture, monitoring setup, research/replication scoring methodology

---

## TIER 2: INTERESTING / NICHE TOOLS

### 8. YichengYang-Ethan/oracle3
- **URL**: https://github.com/YichengYang-Ethan/oracle3
- **Stars**: 117
- **Language**: Python 3.10+
- **Strategy**: 8 arbitrage strategies across Polymarket, Kalshi, and Solana. Cross-market, exclusivity, implication, conditional, event-sum, structural, cointegration spread, and lead-lag
- **Key features**: OpenAI Agents SDK + LiteLLM, Solana transaction signing, Jito MEV protection, position state machine
- **Learn from**: Cross-platform arbitrage taxonomy, fee-aware edge calculation

### 9. LainNet-42/polymarket-auto-trading-agent
- **URL**: https://github.com/LainNet-42/polymarket-auto-trading-agent
- **Stars**: 28
- **Language**: Python 3.11+
- **Strategy**: Expiry convergence - buys obvious outcomes that haven't fully priced in yet near settlement. Verifies results via web search
- **Claimed results**: 19 trades, 18 wins (94.7% win rate), 2-week live test
- **Key features**: Built on Claude Code + MCP, agent leaves itself "d-mail" messages about when to wake up, non-custodial
- **Learn from**: Expiry convergence is a real edge, MCP integration with Claude, self-scheduling agent pattern

### 10. jparedesDS/polymarket-autobetting
- **URL**: https://github.com/jparedesDS/polymarket-autobetting
- **Stars**: 5
- **Language**: Python 3.10+
- **Strategy**: Limit orders at 0.45 on 5-min BTC Up/Down markets, Kelly Criterion sizing, bail-out at 0.68
- **Key features**: Monte Carlo backtesting, Telegram dashboard, gasless auto-redeem via Builder API
- **Learn from**: Kelly Criterion implementation, Monte Carlo backtesting approach, bail-out logic

### 11. blockchainhansi/market_maker_polymarket
- **URL**: https://github.com/blockchainhansi/market_maker_polymarket
- **Stars**: 4
- **Language**: Python 3.10+
- **Strategy**: Optimal market making for 15-min BTC markets using Fushimi et al. (2018). Price skew, dynamic order sizing, join-or-improve logic
- **Key features**: Since YES+NO always sum to $1, buying both at <$1 total guarantees profit
- **Learn from**: Academic market making theory applied to prediction markets

### 12. llSourcell/Poly-Trader (Siraj Raval)
- **URL**: https://github.com/llSourcell/Poly-Trader
- **Stars**: 127
- **Language**: Python
- **Strategy**: Edge detection - compare ChatGPT probability estimates against market odds, bet on divergence
- **Learn from**: Simple but effective concept. The AI-vs-market edge detection is the foundation of most profitable approaches

### 13. alsk1992/CloddsBot
- **URL**: https://github.com/alsk1992/CloddsBot
- **Stars**: 68
- **Language**: TypeScript
- **Strategy**: 118+ strategies across 10 prediction markets, 7 futures exchanges, Solana DEXs. Built on Claude
- **Learn from**: Multi-venue architecture, risk engine design (circuit breaker, VaR/CVaR, Kelly sizing)

### 14. second-state/fintool
- **URL**: https://github.com/second-state/fintool
- **Stars**: 133
- **Language**: Rust
- **Strategy**: CLI toolkit for agentic trading. Separate binary per exchange including Polymarket. JSON output mode for agent integration
- **Learn from**: Rust CLI design for trading, agent-friendly API patterns

---

## TIER 3: ECOSYSTEM TOOLS & INFRASTRUCTURE

### 15. aarora4/Awesome-Prediction-Market-Tools
- **URL**: https://github.com/aarora4/Awesome-Prediction-Market-Tools
- **Stars**: 110
- **What**: Curated directory of 200+ prediction market tools across 17 categories
- **Notable entries**:
  - **Oddpool** (oddpool.com) - "Bloomberg for prediction markets"
  - **PMXT** (github.com/qoery-com/pmxt) - Open-source cross-exchange prediction market API
  - **PolyBackTest** (polybacktest.com) - Historical order book backtesting at 1-min resolution
  - **PolySimulator** (polysimulator.com) - Strategy backtesting
  - **Eventarb** (eventarb.com) - Free cross-platform arbitrage calculator
  - **Ostium** (app.ostium.com) - First app for automating PM strategies
  - **PolyRewards** (polyrewards.netlify.app) - Liquidity rewards tracking
  - **Polyseer** (polyseer.xyz) - Open-source multi-agent Bayesian analysis

### 16. Polymarket/agent-skills
- **URL**: https://github.com/Polymarket/agent-skills
- **Stars**: 50
- **What**: Official skill definitions for Polymarket agents

### 17. IQ AI MCP Servers
- **URL**: https://blog.iqai.com/iq-ai-open-sources-mcp-servers-for-polymarket-kalshi-and-opinion-trade/
- **What**: Open-source MCP servers on npm connecting AI agents to Polymarket, Kalshi, and Opinion.trade

---

## STRATEGIES THAT ACTUALLY WORK (From Real Data)

### Strategy 1: Market Making with Liquidity Rewards
- **How**: Place two-sided orders on low-volatility markets, earn spread + Polymarket's liquidity rewards
- **Historical returns**: $200-800/day on $10K capital (peak)
- **Current status**: DEGRADED. Rewards decreased post-2024 election, competition increased
- **Risk**: Directional risk is "the real P&L killer" per actual market maker experience

### Strategy 2: Expiry Convergence
- **How**: Buy obvious outcomes near settlement where price hasn't fully converged to $1.00
- **Historical returns**: 94.7% win rate claimed (19 trades)
- **Edge**: 1-4 cents per trade, high frequency
- **Risk**: Low per trade but thin margins

### Strategy 3: Cross-Market Information Lag
- **How**: Binance futures move before Polymarket catches up. Trade the lag
- **Historical returns**: 2,500% ROI paper trading (not live)
- **Edge**: Sub-second reaction to crypto price movements
- **Risk**: Requires sub-100ms execution for real profitability

### Strategy 4: AI Probability Edge Detection
- **How**: Use LLMs to estimate event probabilities, bet when AI diverges from market
- **Historical returns**: No verified public results
- **Edge**: Works best on long-tail events where market is thin/inefficient
- **Risk**: AI hallucination, model confidence calibration

### Strategy 5: Complete-Set Arbitrage on Short-Duration Markets
- **How**: Buy YES + NO when combined price < $1.00 on 5-15 min BTC markets
- **Historical returns**: Theoretical 4.2% per cycle
- **Edge**: Mathematically guaranteed profit if both sides fill
- **Risk**: Execution risk - both sides must fill

---

## KEY MARKET STATISTICS

- **92% of Polymarket traders lose money**
- **14 of top 20 most profitable wallets are bots**
- **Only 0.51% of wallets achieved >$1K profit**
- **$40M extracted by arbitrage bots** (Apr 2024 - Apr 2025)
- **73% of arb profits captured by sub-100ms bots**
- **Median arb spread dropped to 0.3%** (barely profitable after gas)
- **Average arb opportunity duration: 2.7 seconds**

---

## BLOG POSTS & ARTICLES WORTH READING

1. **Polymarket Official: "Automated Market Making on Polymarket"**
   https://news.polymarket.com/p/automated-market-making-on-polymarket
   - Interview with poly-maker creator, real P&L numbers

2. **"I cloned a Polymarket market-making bot: Here's what I learned"** (Substack)
   https://tezlee.substack.com/p/i-cloned-a-polymarket-market-making
   - Honest failure report. Made no net profit. Best learning: "pilot manually before automating"

3. **"Building a Polymarket BTC 15-Min Trading Bot with NautilusTrader"** (Medium)
   https://medium.com/@aulegabriel381/the-ultimate-guide-building-a-polymarket-btc-15-minute-trading-bot-with-nautilustrader-ef04eb5edfcb

4. **"Building an Automated Polymarket Trading System with Claude Code"** (Medium)
   https://medium.com/@rvarkarlsson/building-an-automated-polymarket-trading-system-with-claude-code-1982ff60cc74

5. **"Make profit on Polymarket: A Deep Dive into Our Python Framework"** (QuantJourney Substack - paywalled)
   https://quantjourney.substack.com/p/make-profit-on-polymarket-a-deep

6. **"AI agents are quietly rewriting prediction market trading"** (CoinDesk, March 2026)
   https://www.coindesk.com/tech/2026/03/15/ai-agents-are-quietly-rewriting-prediction-market-trading

7. **BSIC Bocconi: "Backtesting Trading Strategies on Prediction Markets' Cryptocurrency Contracts"**
   https://bsic.it/well-can-we-predict-backtesting-trading-strategies-on-prediction-markets-cryptocurrency-contracts/

---

## BACKTESTING PLATFORMS

1. **PolyBackTest** - https://polybacktest.com/ - Historical order book data at 1-min resolution
2. **PolySimulator** - https://polysimulator.com/backtesting - Strategy tester
3. **prediction-market-backtesting** (GitHub) - NautilusTrader-based framework with L2 replay
4. **PMXT** - Open-source cross-exchange API for historical data

---

## RECOMMENDATIONS FOR OUR BOT

### Repos to study first (in order):
1. **warproxxx/poly-maker** - Best real-world market making reference
2. **Polymarket/agents** - Official agent framework patterns
3. **evan-kolberg/prediction-market-backtesting** - Backtesting before going live
4. **humanplane/cross-market-state-fusion** - Cross-market RL approach (Apple Silicon MLX)
5. **LainNet-42/polymarket-auto-trading-agent** - Expiry convergence + Claude Code MCP pattern

### Most promising strategy combination:
- **Primary**: AI probability edge detection (our differentiator)
- **Secondary**: Expiry convergence (high win rate, automatable)
- **Tertiary**: Short-duration BTC market making (frequent opportunities)
- **Avoid**: Pure arbitrage (requires sub-100ms infra we don't have)

### Key integrations to consider:
- **PMXT** for cross-exchange data
- **NautilusTrader** for backtesting
- **IQ AI MCP Servers** for agent integration
- **PolyBackTest** for historical data
- **Polyseer** for multi-agent probability estimation
