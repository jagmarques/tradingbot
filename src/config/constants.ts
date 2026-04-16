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
export const QUANT_TRADING_PAIRS = [
  // Original 18
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
  // Batch 2
  "ZEC", "AVAX", "NEAR", "kPEPE", "SUI", "HYPE", "FET",
  // Batch 3
  "FIL", "ALGO", "BCH", "JTO", "SAND", "BLUR", "TAO", "RENDER", "TRX", "AAVE",
  "JUP", "POL", "CRV", "PYTH", "IMX", "BNB", "ONDO", "XLM", "DYDX", "ICP", "LTC", "MKR",
  // Batch 4
  "PENDLE", "PNUT", "ATOM", "TON", "SEI", "STX",
  // Batch 5 (74 new pairs, validated PF > 1.1 OOS on GARCH v2, 1h CD, $7)
  "DYM", "CFX", "ALT", "BIO", "OMNI", "ORDI", "XAI", "SUSHI", "ME", "ZEN",
  "TNSR", "CATI", "TURBO", "MOVE", "GALA", "STRK", "SAGA", "ILV", "GMX", "OM",
  "CYBER", "NTRN", "BOME", "MEME", "ANIME", "BANANA", "ETC", "USUAL", "UMA", "USTC",
  "MAV", "REZ", "NOT", "PENGU", "BIGTIME", "WCT", "EIGEN", "MANTA", "POLYX", "W",
  "FXS", "GMT", "RSR", "PEOPLE", "YGG", "TRB", "ETHFI", "ENS", "OGN", "AXS",
  "MINA", "LISTA", "NEO", "AI", "SCR", "APE", "KAITO", "AR", "BNT", "PIXEL",
  "LAYER", "ZRO", "CELO", "ACE", "COMP", "RDNT", "ZK", "MET", "STG", "REQ",
  "CAKE", "SUPER", "FTT", "STRAX",
]; // 127 pairs total
export const QUANT_CANDLE_LOOKBACK_COUNT = 100;
export const QUANT_PIPELINE_TIMEOUT_MS = 30_000;

// Quant Position Sizing
export const QUANT_FIXED_POSITION_SIZE_USD = 10;

// Quant Risk Management
export const QUANT_DAILY_DRAWDOWN_LIMIT = 25;
export const QUANT_MAX_SL_PCT = 1.0; // cap at SL + 0.5% (SL 0.5%, cap 1%)
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

// GARCH lb1/vw30 $20 mc7 — verified: $2.40/day MTM MDD $32 on $60 equity
export const ENSEMBLE_POSITION_SIZE_USD = 1; // Legacy fallback
export const ENSEMBLE_MAX_CONCURRENT = 15; // mc15 = ultra sweep winner
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


