// Capital allocation
export const STARTING_CAPITAL_USD = 100;
export const CAPITAL_PER_STRATEGY_USD = 50;

// Loss limits
export const CAPITAL_LOSS_PAUSE_PERCENTAGE = 30;

// Polymarket trading
export const ARBITRAGE_PAIR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max hold time

// Fees
export const ESTIMATED_GAS_FEE_MATIC = 0.1;
export const ESTIMATED_SLIPPAGE_POLYMARKET = 0.005;
export const POLYMARKET_TAKER_FEE_PCT = 0.0015;

// EVM gas (native token)
export const ESTIMATED_GAS_FEE_EVM: Record<string, number> = {
  ethereum: 0.003,
  polygon: 0.001,
  base: 0.0001,
  arbitrum: 0.0001,
  optimism: 0.0001,
  avalanche: 0.01,
};

// DEX slippage
export const ESTIMATED_SLIPPAGE_DEX = 0.01;

// Polymarket API URLs
export const CLOB_API_URL = "https://clob.polymarket.com";
export const GAMMA_API_URL = "https://gamma-api.polymarket.com";
export const DATA_API_URL = "https://data-api.polymarket.com/v1";

// Hyperliquid Quant Trading
export const HYPERLIQUID_MAX_LEVERAGE = 10;
export const QUANT_DEFAULT_VIRTUAL_BALANCE = 200; // $200 for AI engine
export const HYPERLIQUID_API_TIMEOUT_MS = 10_000;
export const API_PRICE_TIMEOUT_MS = 10_000;
export const API_ORDER_TIMEOUT_MS = 15_000;

// Quant Market Data Pipeline
export const QUANT_TRADING_PAIRS = ["OP", "WIF", "ARB", "LDO", "AVAX", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT", "SEI", "LINK", "ADA", "WLD", "XRP", "SUI", "TON", "UNI"];
export const QUANT_CANDLE_LOOKBACK_COUNT = 100;
export const QUANT_PIPELINE_TIMEOUT_MS = 30_000;

// Quant Position Sizing
export const QUANT_AI_DIRECTIONAL_ENABLED = false;
export const QUANT_DTF_MR_ENABLED = true;
export const QUANT_EMA_CROSS_ENABLED = true;
export const QUANT_AI_KELLY_FRACTION = 0.25;
export const QUANT_AI_CACHE_TTL_MS = 30 * 60 * 1000; // 30min cache
export const QUANT_FIXED_POSITION_SIZE_USD = 10;

// Quant Risk Management
export const QUANT_DAILY_DRAWDOWN_LIMIT = 25;
export const QUANT_MAX_SL_PCT = 2;
export const QUANT_POSITION_MONITOR_INTERVAL_MS = 10_000;
export const QUANT_TRAIL_FAST_POLL_MS = 3_000;

// Directional Trading Scheduler
export const QUANT_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;

// Paper Trading Validation
export const QUANT_PAPER_VALIDATION_DAYS = 14;

// Quant liquidation simulation
export const QUANT_LIQUIDATION_PENALTY_PCT = 1.5;

// Exchange routing per engine
export type QuantExchange = "hyperliquid" | "lighter";

export const QUANT_ENGINE_EXCHANGE: Record<string, QuantExchange> = {
  "ai-directional": "lighter",
  "dtf-mr": "lighter",
  "ema-cross": "lighter",
  "mom-4h": "lighter",
  "wickflow": "lighter",
  "skew-mr": "lighter",
  "psar": "lighter",
  "ha-psar": "lighter",
  "ift-rsi": "lighter",
  "zl-macd": "lighter",
};

// Engines that go live in hybrid mode (rest stay paper)
export const QUANT_HYBRID_LIVE_ENGINES = new Set<string>();

export function getEngineExchange(tradeType: string): QuantExchange {
  return QUANT_ENGINE_EXCHANGE[tradeType] ?? "hyperliquid";
}

export const LIGHTER_TAKER_FEE_PCT = 0;
export const LIGHTER_PAPER_SPREAD_PCT = 0.0004; // 0.04% half-spread per side

// Hyperliquid Tier 1 maintenance margin rates
export const HYPERLIQUID_MAINTENANCE_MARGIN_RATE: Record<string, number> = {
  BTC: 0.0125,  // 40x max
  ETH: 0.02,    // 25x max
  XRP: 0.025,   // 20x max
  DOGE: 0.05,   // 10x max
  AVAX: 0.05,   // 10x max
  LINK: 0.05,   // 10x max
  ARB: 0.05,    // 10x max
  OP: 0.05,     // 10x max
  DOT: 0.05,    // 10x max
  APT: 0.05,    // 10x max
  WIF: 0.05,    // 10x Lighter
  ENA: 0.05,    // 10x max
  LDO: 0.05,    // 10x max
  SEI: 0.05,    // 10x max
  TRUMP: 0.05,  // 10x Lighter
  DASH: 0.05,   // 10x Lighter
  WLD: 0.05,    // 10x max
  ADA: 0.05,    // 10x max
  SUI: 0.05,    // 10x max
  MKR: 0.05,    // 10x Lighter
  UNI: 0.05,    // 10x max
  TON: 0.05,    // 20x Lighter
};


