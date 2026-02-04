export {
  getProvider,
  loadWallet,
  getAddress,
  getMaticBalance,
  getMaticBalanceFormatted,
  getUsdcBalance,
  getUsdcBalanceFormatted,
  approveUsdc,
  getUsdcAllowance,
  validateConnection,
  resetProvider,
  USDC_CONTRACT,
  USDC_DECIMALS,
} from "./wallet.js";

export {
  getMarket,
  getOrderbook as getOrderbookRest,
  getMidpointPrice,
  placeOrder,
  placeFokOrder,
  cancelOrder,
  getOpenOrders,
  cancelAllOrders,
  validateApiConnection,
} from "./polymarket.js";

export {
  connect as connectOrderbook,
  disconnect as disconnectOrderbook,
  getOrderbook,
  getBestBid,
  getBestAsk,
  getMidPrice,
  getSpread,
  onOrderbookUpdate,
  isConnected as isOrderbookConnected,
  type Orderbook,
  type OrderbookLevel,
} from "./orderbook.js";

export {
  executeTrade,
  startMonitoring,
  stopMonitoring,
  onOpportunity,
  isMonitoring,
  type PolymarketOpportunity,
  type TradeResult,
} from "./arbitrage.js";
