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
export const LOW_SOL_GAS_THRESHOLD = 0.1;

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

// Jito retry configuration
export const JITO_MAX_RETRIES = 3;
export const JITO_RETRY_BASE_MS = 500;
export const JITO_RETRY_MAX_MS = 4000;

// Realistic fee estimation for paper trading
export const ESTIMATED_GAS_FEE_SOL = 0.003; // 3000 lamports typical Solana gas
export const ESTIMATED_GAS_FEE_MATIC = 0.001; // ~0.001 MATIC (~$0.00011) for Polygon gas
export const ESTIMATED_SLIPPAGE_POLYMARKET = 0.005; // 0.5% estimated slippage on Polymarket

// EVM chain gas fees (in native token)
export const ESTIMATED_GAS_FEE_EVM: Record<string, number> = {
  ethereum: 0.003, // ~$6-10 in ETH gas
  polygon: 0.001, // ~$0.001 MATIC
  base: 0.0001, // Base is cheap
  arbitrum: 0.0001, // Arbitrum is cheap
  bsc: 0.0005, // BNB gas
  optimism: 0.0001, // OP is cheap
  avalanche: 0.01, // AVAX gas
  sonic: 0.001, // Sonic gas
};

// Slippage estimates for copy trading
export const ESTIMATED_SLIPPAGE_DEX = 0.01; // 1% slippage on DEX swaps (entry + exit)
