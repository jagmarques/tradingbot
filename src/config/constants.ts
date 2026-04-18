// Capital allocation
export const STARTING_CAPITAL_USD = 100;
export const CAPITAL_PER_STRATEGY_USD = 50;

// Loss limits
export const CAPITAL_LOSS_PAUSE_PERCENTAGE = 30;

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

// Hyperliquid Quant Trading
export const HYPERLIQUID_MAX_LEVERAGE = 10;
export const QUANT_DEFAULT_VIRTUAL_BALANCE = 200; // $200 for AI engine
export const HYPERLIQUID_API_TIMEOUT_MS = 10_000;
export const API_PRICE_TIMEOUT_MS = 10_000;
export const API_ORDER_TIMEOUT_MS = 15_000;

// Quant Market Data Pipeline
// Top-50 pairs by solo backtest profitability (bt-1m-per-pair.ts, live config).
// Pruning from 125 to 50 drops MDD 37% while only losing 14% of $/day (Calmar 0.188 -> 0.256).
export const QUANT_TRADING_PAIRS = [
  "ETH", "ZEC", "YGG", "STRAX", "WLD", "PENGU", "DOGE", "ARB", "FIL", "OP",
  "AVAX", "NEO", "JTO", "KAITO", "SUSHI", "EIGEN", "LINK", "ADA", "ZK", "CELO",
  "STX", "AAVE", "BANANA", "FET", "PEOPLE", "UNI", "ORDI", "TURBO", "WCT", "TIA",
  "MEME", "ETC", "DYDX", "BIO", "CAKE", "APE", "ENA", "SAND", "IMX", "ZEN",
  "SOL", "ICP", "STRK", "APT", "PENDLE", "RSR", "ETHFI", "RENDER", "ACE", "CYBER",
]; // 50 pairs total
export const QUANT_CANDLE_LOOKBACK_COUNT = 100;
export const QUANT_PIPELINE_TIMEOUT_MS = 30_000;

// Quant Position Sizing
export const QUANT_FIXED_POSITION_SIZE_USD = 10;

// Quant Risk Management
export const QUANT_DAILY_DRAWDOWN_LIMIT = 25;
export const QUANT_MAX_SL_PCT = 5.0; // cap at 5% (engine sets 2.5-3%, buffer for slippage)
export const QUANT_ATR_SL_MULTIPLIER = 1.5;
export const QUANT_POSITION_MONITOR_INTERVAL_MS = 3_000;
export const QUANT_TRAIL_FAST_POLL_MS = 3_000;

// Directional Trading Scheduler
export const QUANT_SCHEDULER_INTERVAL_MS = 3 * 60 * 1000;

// Paper Trading Validation
export const QUANT_PAPER_VALIDATION_DAYS = 14;

// Quant liquidation simulation
export const QUANT_LIQUIDATION_PENALTY_PCT = 1.5;

// Exchange routing per engine
export type QuantExchange = "hyperliquid" | "lighter";

export const QUANT_ENGINE_EXCHANGE: Record<string, QuantExchange> = {
  "garch-v2": "hyperliquid",
  "range-expansion": "hyperliquid",
  // Legacy (dead engines, kept for historical position lookups)
  "garch-chan": "hyperliquid",
  "btc-mr": "hyperliquid",
  "btc-event": "hyperliquid",
  "news-trade": "hyperliquid",
  "donchian-trend": "hyperliquid",
  "supertrend-4h": "hyperliquid",
  "carry-momentum": "hyperliquid",
  "alt-rotation": "hyperliquid",
  "momentum-confirm": "hyperliquid",
};

// GARCH $15 mc12 z2/2 SL2.5/3.0 T50/3-30/5-15/8 BE5%+BE2(15->lock5) cd4h mh120h — top-50: $4.74/day MDD $20.5
export const ENSEMBLE_POSITION_SIZE_USD = 1;
export const ENSEMBLE_MAX_CONCURRENT = 12;
export const ENSEMBLE_LEVERAGE = 10;

// Ensemble engine trade types (shared across engines, executor, position-monitor)
export const ENSEMBLE_TRADE_TYPES = new Set<string>(["garch-v2"]);

export const QUANT_HYBRID_LIVE_ENGINES = new Set<string>(["garch-v2"]);

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
  TIA: 0.05,    // 10x max
  SOL: 0.025,   // 20x max
  ZEC: 0.05,    // 10x max
  NEAR: 0.05,   // 10x max
  kPEPE: 0.05,  // 10x max (HL uses kPEPE ticker)
  HYPE: 0.05,   // 10x max
  FET: 0.05,    // 10x max
};


