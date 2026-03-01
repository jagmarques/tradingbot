export const STAGNATION_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h

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
export const QUANT_MAX_POSITIONS = 15; // Max concurrent positions (3 engines x ~3-5 active pairs each)
export const HYPERLIQUID_API_TIMEOUT_MS = 10_000; // 10s timeout for API calls

// Quant Market Data Pipeline
export const QUANT_TRADING_PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK", "ARB", "BNB", "OP", "SUI", "INJ", "ATOM", "APT", "WIF"];
export const QUANT_CANDLE_LOOKBACK_COUNT = 100;
export const QUANT_PIPELINE_TIMEOUT_MS = 30_000;

// Quant AI Decision Engine
export const QUANT_AI_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min - balance freshness vs flip-flopping
export const QUANT_AI_STOP_LOSS_MAX_PCT = 2; // 10% account risk at 5x
export const QUANT_AI_KELLY_FRACTION = 0.25; // Quarter Kelly - conservative

// Quant Risk Management
export const QUANT_DAILY_DRAWDOWN_LIMIT = 25; // $25 max daily loss before trading halt
export const QUANT_POSITION_MONITOR_INTERVAL_MS = 10_000; // 10 seconds between stop-loss checks

// Directional Trading Scheduler
export const QUANT_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Paper Trading Validation
export const QUANT_PAPER_VALIDATION_DAYS = 14; // 2-week minimum paper trading period

// Quant liquidation simulation
export const QUANT_LIQUIDATION_PENALTY_PCT = 1.5; // 1.5% of position size as liquidation penalty fee

// BB Squeeze Engine
export const BB_SQUEEZE_DAILY_SMA_PERIOD = 70;
export const BB_SQUEEZE_DAILY_ADX_MIN = 15;
export const BB_SQUEEZE_BB_PERIOD = 15;
export const BB_SQUEEZE_BB_STDDEV = 1.5;
export const BB_SQUEEZE_WINDOW = 50;
export const BB_SQUEEZE_THRESH = 0.30;
export const BB_SQUEEZE_STOP_ATR_MULT = 2.5;
export const BB_SQUEEZE_REWARD_RISK = 4.0;
export const BB_SQUEEZE_STAGNATION_BARS = 12; // 12 x 4h = 48h (backtest optimal)
export const BB_SQUEEZE_BASE_CONFIDENCE = 65;
export const BB_SQUEEZE_DAILY_LOOKBACK_DAYS = 120;

// DEMA Cross Engine (optimal: +0.415%/day, Sharpe 5.77)
export const DEMA_CROSS_DAILY_SMA_PERIOD = 100;
export const DEMA_CROSS_DAILY_ADX_MIN = 18;
export const DEMA_CROSS_FAST = 5;
export const DEMA_CROSS_SLOW = 21;
export const DEMA_CROSS_STOP_ATR_MULT = 2.5;
export const DEMA_CROSS_REWARD_RISK = 2.5;
export const DEMA_CROSS_STAGNATION_BARS = 12; // 12 x 4h = 48h
export const DEMA_CROSS_BASE_CONFIDENCE = 65;
export const DEMA_CROSS_DAILY_LOOKBACK_DAYS = 150;

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
  BNB: 0.01,
  OP: 0.01,
  SUI: 0.01,
  INJ: 0.01,
  ATOM: 0.01,
  APT: 0.01,
  WIF: 0.01,
};
