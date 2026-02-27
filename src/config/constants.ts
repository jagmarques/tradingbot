// Stagnation timeout - exit at break-even if stuck too long
export const STAGNATION_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

// Capital allocation
export const STARTING_CAPITAL_USD = 100;
export const CAPITAL_PER_STRATEGY_USD = 50;

// Loss limits
export const CAPITAL_LOSS_PAUSE_PERCENTAGE = 30;

// Polymarket trading
export const ARBITRAGE_PAIR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max hold time

// Realistic fee estimation for paper trading
export const ESTIMATED_GAS_FEE_MATIC = 0.1; // ~$0.10 per Polygon tx (sourced from Polymarket docs 2026)
export const ESTIMATED_SLIPPAGE_POLYMARKET = 0.005; // 0.5% slippage on Polymarket CLOB
export const POLYMARKET_TAKER_FEE_PCT = 0.0015; // 0.15% per side (Polymarket CLOB taker fee)

// EVM chain gas fees (in native token)
export const ESTIMATED_GAS_FEE_EVM: Record<string, number> = {
  ethereum: 0.003, // ~$6-10 in ETH gas
  polygon: 0.001, // ~$0.001 MATIC
  base: 0.0001, // Base is cheap
  arbitrum: 0.0001, // Arbitrum is cheap
  optimism: 0.0001, // OP is cheap
  avalanche: 0.01, // AVAX gas
};

// Slippage estimates for copy trading
export const ESTIMATED_SLIPPAGE_DEX = 0.01; // 1% slippage on DEX swaps (entry + exit)

// Polymarket API URLs
export const CLOB_API_URL = "https://clob.polymarket.com";
export const GAMMA_API_URL = "https://gamma-api.polymarket.com";
export const DATA_API_URL = "https://data-api.polymarket.com/v1";

// Hyperliquid Quant Trading
export const HYPERLIQUID_MAX_LEVERAGE = 10; // Hard cap
export const QUANT_DEFAULT_VIRTUAL_BALANCE = 100; // $100 paper trading
export const QUANT_MAX_POSITIONS = 8; // Max concurrent positions (5 pairs x ~1-2 engines active)
export const HYPERLIQUID_API_TIMEOUT_MS = 10_000; // 10s timeout for API calls

// Quant Market Data Pipeline
export const QUANT_TRADING_PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE"];
export const QUANT_CANDLE_LOOKBACK_COUNT = 100;
export const QUANT_PIPELINE_TIMEOUT_MS = 30_000;

// Quant AI Decision Engine
export const QUANT_AI_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min - balance freshness vs flip-flopping
export const QUANT_AI_STOP_LOSS_MAX_PCT = 2; // 10% account risk at 5x
export const QUANT_AI_KELLY_FRACTION = 0.25; // Quarter Kelly - conservative

// Quant Risk Management
export const QUANT_DAILY_DRAWDOWN_LIMIT = 25; // $25 max daily loss before trading halt
export const QUANT_POSITION_MONITOR_INTERVAL_MS = 10_000; // 10 seconds between stop-loss checks

// Funding Rate Arbitrage
export const FUNDING_ARB_MIN_APR = 0.12; // 12% annualized minimum to open (delta-neutral threshold)
export const FUNDING_ARB_CLOSE_APR = 0.05; // 5% annualized - close when rate normalizes below this
export const FUNDING_ARB_DELTA_NEUTRAL = true; // Record virtual spot long hedge for delta-neutral mode
export const FUNDING_ARB_LEVERAGE = 10;
export const FUNDING_ARB_MAX_SIZE_USD = 10; // $10 max per funding position
export const FUNDING_ARB_MAX_POSITIONS = 3; // Max 3 funding positions ($30 total, leaves $70 for directional)
export const FUNDING_ARB_SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour between scans
export const FUNDING_ARB_MONITOR_INTERVAL_MS = 10 * 60 * 1000; // 10 min between normalization checks
export const FUNDING_ARB_STOP_LOSS_PCT = 5; // 5% stop-loss on collateral (wider than directional)
export const FUNDING_ARB_TAKE_PROFIT_PCT = 10; // 10% take-profit

// Directional Trading Scheduler
export const QUANT_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Paper Trading Validation
export const QUANT_PAPER_VALIDATION_DAYS = 14; // 2-week minimum paper trading period

// Quant liquidation simulation
export const QUANT_LIQUIDATION_PENALTY_PCT = 1.5; // 1.5% of position size as liquidation penalty fee

// Rule-Based Decision Engine
export const RULE_RSI_OVERSOLD = 35;
export const RULE_RSI_OVERBOUGHT = 65;
export const RULE_RSI_PULLBACK_LOW = 40;
export const RULE_RSI_PULLBACK_HIGH = 60;
export const RULE_STOP_ATR_MULTIPLIER = 1.5;
export const RULE_REWARD_RISK_RATIO = 2.0;
export const RULE_BB_PROXIMITY_PCT = 1.5;
export const RULE_MIN_CONFIDENCE = 60; // Minimum confidence to generate a signal

// Microstructure Decision Engine
export const MICRO_IMBALANCE_LONG_THRESHOLD = 0.60;
export const MICRO_IMBALANCE_SHORT_THRESHOLD = 0.40;
export const MICRO_OI_MIN_PCT = -0.5;
export const MICRO_BASE_CONFIDENCE = 65;
export const MICRO_OI_SURGE_PCT = 2;
export const MICRO_STOP_ATR_MULTIPLIER = 1.5;
export const MICRO_REWARD_RISK_RATIO = 2.0;

// VWAP Deviation Mean Reversion Engine
export const VWAP_DEVIATION_LONG_PCT = -3.0;   // Long when price is 3%+ below VWAP
export const VWAP_DEVIATION_SHORT_PCT = 3.0;    // Short when price is 3%+ above VWAP
export const VWAP_TREND_CONFLICT_PCT = 3.0;     // Skip if 4h opposes by 3%+
export const VWAP_BASE_CONFIDENCE = 65;
export const VWAP_STOP_ATR_MULTIPLIER = 1.5;
export const VWAP_REWARD_RISK_RATIO = 2.0;

// Per-pair maintenance margin rates matching real Hyperliquid Tier 1
export const HYPERLIQUID_MAINTENANCE_MARGIN_RATE: Record<string, number> = {
  BTC: 0.02,   // 40x max
  ETH: 0.0125, // 25x max
  SOL: 0.01,   // 20x max
  XRP: 0.02,   // 50x max
  DOGE: 0.02,  // 50x max
  AVAX: 0.01,
  LINK: 0.01,
  ARB: 0.01,
  OP: 0.01,
};
