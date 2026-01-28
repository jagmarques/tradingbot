// Pump.fun program ID on Solana
export const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// Auto-sell profit targets (multipliers)
export const SELL_TARGETS = {
  FIRST: 10,
  SECOND: 50,
  THIRD: 100,
} as const;

// Trailing stop-loss activates after this multiplier
export const TRAILING_STOP_ACTIVATION = 5;
export const TRAILING_STOP_PERCENTAGE = 0.2; // 20% drop from peak triggers sell

// Split buy percentages for pump.fun snipes
export const SPLIT_BUY = {
  INITIAL: 0.3, // 30% at launch
  SECOND: 0.3, // 30% after 30s if no dump
  THIRD: 0.4, // 40% if trend holds
} as const;

// Timing
export const SPLIT_BUY_DELAY_MS = 30_000; // 30 seconds between split buys
export const WEBSOCKET_PING_INTERVAL_MS = 10_000; // 10 seconds
export const WEBSOCKET_RECONNECT_BASE_MS = 1_000; // 1 second base for exponential backoff
export const WEBSOCKET_RECONNECT_MAX_MS = 60_000; // 60 seconds max backoff

// Token filter thresholds
export const MIN_LIQUIDITY_SOL = 1;
export const MAX_DEV_SUPPLY_PERCENTAGE = 20;

// Polymarket confidence threshold (85%)
export const MIN_CONFIDENCE_PERCENTAGE = 85;

// Health check
export const HEALTH_PORT = 3000;
export const HEALTH_TIMEOUT_MS = 5_000;

// Alerts
export const LOW_BALANCE_THRESHOLD_USD = 10;
export const LOW_SOL_GAS_THRESHOLD = 0.1;

// Capital allocation
export const STARTING_CAPITAL_USD = 100;
export const CAPITAL_PER_STRATEGY_USD = 50;

// Loss limits
export const CAPITAL_LOSS_PAUSE_PERCENTAGE = 30;
