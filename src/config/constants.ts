// Stagnation timeout - exit at break-even if stuck too long
export const STAGNATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

// Timing
export const WEBSOCKET_PING_INTERVAL_MS = 10_000; // 10 seconds
export const WEBSOCKET_RECONNECT_BASE_MS = 1_000; // 1 second base for exponential backoff
export const WEBSOCKET_RECONNECT_MAX_MS = 60_000; // 60 seconds max backoff

// Polymarket confidence threshold (85%)
export const MIN_CONFIDENCE_PERCENTAGE = 85;

// Health check
export const HEALTH_PORT = 3000;
export const HEALTH_TIMEOUT_MS = 5_000;

// Alerts
export const LOW_BALANCE_THRESHOLD_USD = 10;

// Capital allocation
export const STARTING_CAPITAL_USD = 100;
export const CAPITAL_PER_STRATEGY_USD = 50;

// Loss limits
export const CAPITAL_LOSS_PAUSE_PERCENTAGE = 30;

// Polymarket trading
export const TARGET_ARBITRAGE_PROFIT_PCT = 0.5; // 0.5% net profit target after all fees
export const ARBITRAGE_PAIR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max hold time
export const MAX_ACTIVE_HEDGED_PAIRS = 5; // Capital management
export const POLYMARKET_FEE_BPS = 0; // Polymarket has no trading fees, only gas

// Realistic fee estimation for paper trading
export const ESTIMATED_GAS_FEE_MATIC = 0.1; // ~$0.10 per Polygon tx (sourced from Polymarket docs 2026)
export const ESTIMATED_SLIPPAGE_POLYMARKET = 0.005; // 0.5% slippage on Polymarket CLOB

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
export const HYPERLIQUID_MAX_LEVERAGE = 5; // Hard cap per RISK-01
export const QUANT_DEFAULT_VIRTUAL_BALANCE = 10; // $10 paper trading
export const QUANT_MAX_POSITIONS = 3; // Max concurrent positions
export const HYPERLIQUID_API_TIMEOUT_MS = 10_000; // 10s timeout for API calls

// Quant Market Data Pipeline
export const QUANT_TRADING_PAIRS = ["BTC", "ETH", "SOL"];
export const QUANT_CANDLE_INTERVALS: Array<"15m" | "1h" | "4h"> = ["15m", "1h", "4h"];
export const QUANT_CANDLE_LOOKBACK_COUNT = 100;
export const QUANT_PIPELINE_TIMEOUT_MS = 30_000;

// Quant AI Decision Engine
export const QUANT_AI_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const QUANT_AI_MIN_CONFIDENCE = 60; // Minimum confidence to act (0-100)
export const QUANT_AI_STOP_LOSS_MAX_PCT = 3; // Max stop-loss distance %
export const QUANT_AI_KELLY_FRACTION = 0.25; // Quarter Kelly

// Quant Risk Management
export const QUANT_DAILY_DRAWDOWN_LIMIT = 5; // $5 max daily loss before trading halt
export const QUANT_STOP_LOSS_REQUIRED = true; // Every position must have a stop-loss
export const QUANT_POSITION_MONITOR_INTERVAL_MS = 30_000; // 30 seconds between stop-loss checks

// Funding Rate Arbitrage
export const FUNDING_ARB_MIN_APR = 0.15; // 15% annualized minimum to open
export const FUNDING_ARB_CLOSE_APR = 0.05; // 5% annualized - close when rate normalizes below this
export const FUNDING_ARB_LEVERAGE = 1; // 1x leverage only (minimal directional risk)
export const FUNDING_ARB_MAX_SIZE_USD = 3; // $3 max per funding position (conservative, from $10 balance)
export const FUNDING_ARB_SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour between scans
export const FUNDING_ARB_STOP_LOSS_PCT = 5; // 5% stop-loss (wider than directional, since 1x leverage)
export const FUNDING_ARB_TAKE_PROFIT_PCT = 10; // 10% take-profit

// Directional Trading Scheduler
export const QUANT_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Paper Trading Validation
export const QUANT_PAPER_VALIDATION_DAYS = 14; // 2-week minimum paper trading period
