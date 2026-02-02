export * as binance from "./binance.js";
export * as coinbase from "./coinbase.js";
export * as priceManager from "./manager.js";

// Re-export commonly used functions from manager
export {
  start,
  stop,
  getPrice,
  getPriceWithMeta,
  getAllPrices,
  onPrice,
  isHealthy,
  getStatus,
} from "./manager.js";
