export const STAGNATION_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h

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
export const QUANT_DEFAULT_VIRTUAL_BALANCE = 1000; // $100/engine x 10 engines
export const HYPERLIQUID_API_TIMEOUT_MS = 10_000;
export const API_PRICE_TIMEOUT_MS = 10_000;
export const API_ORDER_TIMEOUT_MS = 15_000;

// Quant Market Data Pipeline
export const QUANT_TRADING_PAIRS = ["TIA", "OP", "WIF", "ARB", "LDO", "AVAX", "JUP", "ONDO", "DOT", "ENA", "DOGE", "APT", "SOL", "SEI", "LINK"];
export const QUANT_CANDLE_LOOKBACK_COUNT = 100;
export const QUANT_PIPELINE_TIMEOUT_MS = 30_000;

// Quant Position Sizing
export const QUANT_AI_KELLY_FRACTION = 0.25;
export const QUANT_AI_CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8h cache on AI analyses
export const QUANT_FIXED_POSITION_SIZE_USD = 10;
export const QUANT_COMPOUND_SIZE_PCT = 0.025; // 2.5% of equity per trade
export const QUANT_COMPOUND_MIN_SIZE = 5; // minimum $5 per trade

// Quant Risk Management
export const QUANT_DAILY_DRAWDOWN_LIMIT = 25;
export const QUANT_MAX_SL_PCT = 3;
export const QUANT_POSITION_MONITOR_INTERVAL_MS = 10_000;

// Directional Trading Scheduler
export const QUANT_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;
export const QUANT_MAX_PER_PAIR = 2;       // Max engines with open position on same pair
export const QUANT_MAX_PER_DIRECTION = 10; // Max positions in same direction across all engines

// Paper Trading Validation
export const QUANT_PAPER_VALIDATION_DAYS = 14;

// Quant liquidation simulation
export const QUANT_LIQUIDATION_PENALTY_PCT = 1.5;

// PSAR
export const PSAR_DAILY_SMA_PERIOD = 50;
export const PSAR_DAILY_ADX_MIN = 18;
export const PSAR_STEP = 0.02;
export const PSAR_MAX = 0.1;
export const PSAR_STOP_ATR_MULT = 5.0;
export const PSAR_REWARD_RISK = 6.0;
export const PSAR_STAGNATION_BARS = 8;
export const PSAR_BASE_CONFIDENCE = 65;
export const PSAR_DAILY_LOOKBACK_DAYS = 150;
export const PSAR_REVERSE_EXIT = 1;
export const PSAR_ADX_NOT_DECL = 0;
export const PSAR_TRAIL_ACTIVATION = 9;
export const PSAR_TRAIL_DISTANCE = 2.5;

// ZLEMA
export const ZLEMA_DAILY_SMA_PERIOD = 75;
export const ZLEMA_DAILY_ADX_MIN = 10;
export const ZLEMA_FAST = 10;
export const ZLEMA_SLOW = 34;
export const ZLEMA_STOP_ATR_MULT = 4.0;
export const ZLEMA_REWARD_RISK = 4.0;
export const ZLEMA_STAGNATION_BARS = 10;
export const ZLEMA_BASE_CONFIDENCE = 65;
export const ZLEMA_DAILY_LOOKBACK_DAYS = 150;
export const ZLEMA_ADX_NOT_DECL = 0;
export const ZLEMA_REVERSE_EXIT = 0;
export const ZLEMA_TRAIL_ACTIVATION = 1;
export const ZLEMA_TRAIL_DISTANCE = 2;



// Vortex
export const VORTEX_DAILY_SMA_PERIOD = 50;
export const VORTEX_DAILY_ADX_MIN = 14;
export const VORTEX_VORTEX_PERIOD = 14;
export const VORTEX_STOP_ATR_MULT = 5.0;
export const VORTEX_REWARD_RISK = 4.0;
export const VORTEX_STAGNATION_BARS = 10;
export const VORTEX_BASE_CONFIDENCE = 65;
export const VORTEX_DAILY_LOOKBACK_DAYS = 150;
export const VORTEX_ADX_NOT_DECL = 1;
export const VORTEX_REVERSE_EXIT = 0;
export const VORTEX_TRAIL_ACTIVATION = 6;
export const VORTEX_TRAIL_DISTANCE = 3;

// Schaff
export const SCHAFF_DAILY_SMA_PERIOD = 30;
export const SCHAFF_DAILY_ADX_MIN = 22;
export const SCHAFF_STC_FAST = 10;
export const SCHAFF_STC_SLOW = 26;
export const SCHAFF_STC_CYCLE = 10;
export const SCHAFF_STC_THRESHOLD = 30;
export const SCHAFF_STOP_ATR_MULT = 3.0;
export const SCHAFF_REWARD_RISK = 3.0;
export const SCHAFF_STAGNATION_BARS = 12;
export const SCHAFF_BASE_CONFIDENCE = 65;
export const SCHAFF_DAILY_LOOKBACK_DAYS = 150;
export const SCHAFF_ADX_NOT_DECL = 0;
export const SCHAFF_REVERSE_EXIT = 0;
export const SCHAFF_TRAIL_ACTIVATION = 5;
export const SCHAFF_TRAIL_DISTANCE = 2.5;

// DEMA
export const DEMA_DAILY_SMA_PERIOD = 50;
export const DEMA_DAILY_ADX_MIN = 10;
export const DEMA_FAST = 5;
export const DEMA_SLOW = 21;
export const DEMA_STOP_ATR_MULT = 3.5;
export const DEMA_REWARD_RISK = 3.0;
export const DEMA_STAGNATION_BARS = 16;
export const DEMA_BASE_CONFIDENCE = 65;
export const DEMA_DAILY_LOOKBACK_DAYS = 150;
export const DEMA_ADX_NOT_DECL = 0;
export const DEMA_REVERSE_EXIT = 0;
export const DEMA_TRAIL_ACTIVATION = 4;
export const DEMA_TRAIL_DISTANCE = 2;

// HMA
export const HMA_DAILY_SMA_PERIOD = 50;
export const HMA_DAILY_ADX_MIN = 8;
export const HMA_FAST = 12;
export const HMA_SLOW = 34;
export const HMA_STOP_ATR_MULT = 4.0;
export const HMA_REWARD_RISK = 3.0;
export const HMA_STAGNATION_BARS = 10;
export const HMA_BASE_CONFIDENCE = 65;
export const HMA_DAILY_LOOKBACK_DAYS = 150;
export const HMA_ADX_NOT_DECL = 0;
export const HMA_REVERSE_EXIT = 0;
export const HMA_TRAIL_ACTIVATION = 10;
export const HMA_TRAIL_DISTANCE = 1;

// CCI
export const CCI_DAILY_SMA_PERIOD = 50;
export const CCI_DAILY_ADX_MIN = 8;
export const CCI_PERIOD = 14;
export const CCI_THRESHOLD = 100;
export const CCI_STOP_ATR_MULT = 3.5;
export const CCI_REWARD_RISK = 4.0;
export const CCI_STAGNATION_BARS = 10;
export const CCI_BASE_CONFIDENCE = 65;
export const CCI_DAILY_LOOKBACK_DAYS = 150;
export const CCI_ADX_NOT_DECL = 0;
export const CCI_REVERSE_EXIT = 1;
export const CCI_TRAIL_ACTIVATION = 3;
export const CCI_TRAIL_DISTANCE = 2.5;


// Exchange routing per engine
export type QuantExchange = "hyperliquid" | "lighter";

export const QUANT_ENGINE_EXCHANGE: Record<string, QuantExchange> = {
  "psar-directional": "lighter",
  "zlema-directional": "lighter",
  "vortex-directional": "lighter",
  "schaff-directional": "lighter",
  "dema-directional": "lighter",
  "hma-directional": "lighter",
  "cci-directional": "lighter",
};

// Engines that go live in hybrid mode (rest stay paper)
export const QUANT_HYBRID_LIVE_ENGINES = new Set([
  "schaff-directional",
  "zlema-directional",
]);

export function getEngineExchange(tradeType: string): QuantExchange {
  return QUANT_ENGINE_EXCHANGE[tradeType] ?? "hyperliquid";
}

export const LIGHTER_TAKER_FEE_PCT = 0;

// Hyperliquid Tier 1 maintenance margin rates
export const HYPERLIQUID_MAINTENANCE_MARGIN_RATE: Record<string, number> = {
  BTC: 0.0125,  // 40x max (table 56)
  ETH: 0.02,    // 25x max (table 55)
  SOL: 0.025,   // 20x max (table 54)
  XRP: 0.025,   // 20x max (table 53)
  DOGE: 0.05,   // 10x max (table 52)
  AVAX: 0.05,   // 10x max (table 52)
  LINK: 0.05,   // 10x max (table 52)
  ARB: 0.05,    // 10x max (table 51)
  BNB: 0.05,    // 10x max (table 51)
  OP: 0.05,     // 10x max (table 51)
  SUI: 0.05,    // 10x max (table 52)
  DOT: 0.05,    // 10x max (table 51)
  TIA: 0.05,    // 10x max (table 52)
  APT: 0.05,    // 10x max (table 52)
  WIF: 0.1,     // 5x max
  ENA: 0.05,    // 10x max (table 52)
  LDO: 0.05,    // 10x max (table 51)
  SEI: 0.05,    // 10x max (table 51)
  ONDO: 0.05,   // 10x max (table 51)
  JUP: 0.05,    // 10x max (table 51)
  WLD: 0.05,    // 10x max (table 52)
};
