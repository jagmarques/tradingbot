export { initDb, closeDb, getDb, isDbInitialized } from "./db.js";

export {
  insertTrade,
  getTrade,
  getTrades,
  getTodayTrades,
  updateTrade,
  insertPosition,
  getOpenPositions,
  closePosition,
  getDailyStats,
  updateDailyStats,
  getStatsRange,
  type TradeRecord,
  type PositionRecord,
  type DailyStats,
} from "./trades.js";

export {
  exportTradesToCsv,
  exportStatsToCsv,
  exportTaxReport,
  getMonthlyReport,
} from "./export.js";

export {
  initSheets,
  appendTrade,
  updateDailyStatsSheet,
  updateSummarySheet,
  isSheetsInitialized,
} from "./sheets.js";
