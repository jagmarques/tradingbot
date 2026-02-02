export {
  BacktestEngine,
  createSMAStrategy,
  generateMockCandles,
  type PriceCandle,
  type BacktestTrade,
  type BacktestPosition,
  type BacktestResult,
  type StrategySignal,
  type StrategyFunction,
} from "./engine.js";

export {
  validatePaperTrading,
  generatePaperReport,
  isReadyForLive,
  type PaperValidationResult,
  type StrategyStats,
  type ValidationCriteria,
} from "./paper.js";
