import { STARTING_CAPITAL_USD } from "../../config/constants.js";

export interface PriceCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestTrade {
  id: string;
  strategy: "pumpfun" | "polymarket";
  type: "BUY" | "SELL";
  price: number;
  amount: number;
  timestamp: number;
  pnl: number;
  pnlPercentage: number;
}

export interface BacktestPosition {
  entryPrice: number;
  amount: number;
  entryTime: number;
  strategy: "pumpfun" | "polymarket";
}

export interface BacktestResult {
  startDate: string;
  endDate: string;
  initialCapital: number;
  finalCapital: number;
  totalPnl: number;
  totalPnlPercentage: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  maxDrawdown: number;
  maxDrawdownPercentage: number;
  sharpeRatio: number;
  trades: BacktestTrade[];
  equityCurve: { timestamp: number; equity: number }[];
}

export interface StrategySignal {
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  price: number;
  amount?: number;
}

export type StrategyFunction = (
  candle: PriceCandle,
  position: BacktestPosition | null,
  history: PriceCandle[]
) => StrategySignal;

export class BacktestEngine {
  private capital: number;
  private initialCapital: number;
  private position: BacktestPosition | null = null;
  private trades: BacktestTrade[] = [];
  private equityCurve: { timestamp: number; equity: number }[] = [];
  private peakEquity: number;
  private maxDrawdown: number = 0;
  private dailyReturns: number[] = [];
  private lastEquity: number;

  constructor(initialCapital: number = STARTING_CAPITAL_USD) {
    this.capital = initialCapital;
    this.initialCapital = initialCapital;
    this.peakEquity = initialCapital;
    this.lastEquity = initialCapital;
  }

  run(
    candles: PriceCandle[],
    strategy: StrategyFunction,
    strategyName: "pumpfun" | "polymarket"
  ): BacktestResult {
    const history: PriceCandle[] = [];

    for (const candle of candles) {
      history.push(candle);

      // Get strategy signal
      const signal = strategy(candle, this.position, history);

      // Execute signal
      this.executeSignal(signal, candle, strategyName);

      // Track equity
      const currentEquity = this.getCurrentEquity(candle.close);
      this.equityCurve.push({ timestamp: candle.timestamp, equity: currentEquity });

      // Track drawdown
      if (currentEquity > this.peakEquity) {
        this.peakEquity = currentEquity;
      }
      const drawdown = this.peakEquity - currentEquity;
      if (drawdown > this.maxDrawdown) {
        this.maxDrawdown = drawdown;
      }

      // Track daily returns (simplified - one per candle)
      const dailyReturn = (currentEquity - this.lastEquity) / this.lastEquity;
      this.dailyReturns.push(dailyReturn);
      this.lastEquity = currentEquity;
    }

    // Close any remaining position at last price
    if (this.position && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      this.closePosition(lastCandle.close, lastCandle.timestamp, strategyName);
    }

    return this.generateResult(candles);
  }

  private executeSignal(
    signal: StrategySignal,
    candle: PriceCandle,
    strategy: "pumpfun" | "polymarket"
  ): void {
    if (signal.action === "BUY" && !this.position) {
      this.openPosition(signal.price, signal.amount || this.capital * 0.1, candle.timestamp, strategy);
    } else if (signal.action === "SELL" && this.position) {
      this.closePosition(signal.price, candle.timestamp, strategy);
    }
  }

  private openPosition(
    price: number,
    amount: number,
    timestamp: number,
    strategy: "pumpfun" | "polymarket"
  ): void {
    if (amount > this.capital) {
      amount = this.capital;
    }

    this.position = {
      entryPrice: price,
      amount,
      entryTime: timestamp,
      strategy,
    };

    this.capital -= amount;

    this.trades.push({
      id: `bt_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
      strategy,
      type: "BUY",
      price,
      amount,
      timestamp,
      pnl: 0,
      pnlPercentage: 0,
    });
  }

  private closePosition(price: number, timestamp: number, strategy: "pumpfun" | "polymarket"): void {
    if (!this.position) return;

    const exitValue = (this.position.amount / this.position.entryPrice) * price;
    const pnl = exitValue - this.position.amount;
    const pnlPercentage = (pnl / this.position.amount) * 100;

    this.capital += exitValue;

    this.trades.push({
      id: `bt_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
      strategy,
      type: "SELL",
      price,
      amount: this.position.amount,
      timestamp,
      pnl,
      pnlPercentage,
    });

    this.position = null;
  }

  private getCurrentEquity(currentPrice: number): number {
    let equity = this.capital;
    if (this.position) {
      equity += (this.position.amount / this.position.entryPrice) * currentPrice;
    }
    return equity;
  }

  private generateResult(candles: PriceCandle[]): BacktestResult {
    const sellTrades = this.trades.filter((t) => t.type === "SELL");
    const winningTrades = sellTrades.filter((t) => t.pnl > 0).length;
    const losingTrades = sellTrades.filter((t) => t.pnl < 0).length;
    const totalPnl = sellTrades.reduce((sum, t) => sum + t.pnl, 0);

    return {
      startDate: candles.length > 0 ? new Date(candles[0].timestamp).toISOString() : "",
      endDate: candles.length > 0 ? new Date(candles[candles.length - 1].timestamp).toISOString() : "",
      initialCapital: this.initialCapital,
      finalCapital: this.capital,
      totalPnl,
      totalPnlPercentage: (totalPnl / this.initialCapital) * 100,
      totalTrades: this.trades.length,
      winningTrades,
      losingTrades,
      winRate: sellTrades.length > 0 ? (winningTrades / sellTrades.length) * 100 : 0,
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPercentage: (this.maxDrawdown / this.peakEquity) * 100,
      sharpeRatio: this.calculateSharpeRatio(),
      trades: this.trades,
      equityCurve: this.equityCurve,
    };
  }

  private calculateSharpeRatio(): number {
    if (this.dailyReturns.length < 2) return 0;

    const avgReturn = this.dailyReturns.reduce((a, b) => a + b, 0) / this.dailyReturns.length;
    const variance =
      this.dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
      (this.dailyReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    // Annualized Sharpe (assuming daily data, 252 trading days)
    return (avgReturn / stdDev) * Math.sqrt(252);
  }

  reset(): void {
    this.capital = this.initialCapital;
    this.position = null;
    this.trades = [];
    this.equityCurve = [];
    this.peakEquity = this.initialCapital;
    this.maxDrawdown = 0;
    this.dailyReturns = [];
    this.lastEquity = this.initialCapital;
  }
}

// Create a simple moving average crossover strategy for testing
export function createSMAStrategy(shortPeriod: number, longPeriod: number): StrategyFunction {
  return (candle: PriceCandle, position: BacktestPosition | null, history: PriceCandle[]) => {
    if (history.length < longPeriod) {
      return { action: "HOLD", confidence: 0, price: candle.close };
    }

    const shortSMA = calculateSMA(history.slice(-shortPeriod));
    const longSMA = calculateSMA(history.slice(-longPeriod));
    const prevShortSMA = calculateSMA(history.slice(-shortPeriod - 1, -1));
    const prevLongSMA = calculateSMA(history.slice(-longPeriod - 1, -1));

    // Golden cross - short crosses above long
    if (prevShortSMA <= prevLongSMA && shortSMA > longSMA && !position) {
      return { action: "BUY", confidence: 80, price: candle.close };
    }

    // Death cross - short crosses below long
    if (prevShortSMA >= prevLongSMA && shortSMA < longSMA && position) {
      return { action: "SELL", confidence: 80, price: candle.close };
    }

    return { action: "HOLD", confidence: 50, price: candle.close };
  };
}

function calculateSMA(candles: PriceCandle[]): number {
  if (candles.length === 0) return 0;
  return candles.reduce((sum, c) => sum + c.close, 0) / candles.length;
}

// Generate mock historical data for testing
export function generateMockCandles(
  days: number,
  startPrice: number = 100,
  volatility: number = 0.02
): PriceCandle[] {
  const candles: PriceCandle[] = [];
  let price = startPrice;
  const startTime = Date.now() - days * 24 * 60 * 60 * 1000;

  for (let i = 0; i < days; i++) {
    const change = (Math.random() - 0.5) * 2 * volatility;
    const open = price;
    const close = price * (1 + change);
    const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.5);
    const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.5);

    candles.push({
      timestamp: startTime + i * 24 * 60 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume: Math.random() * 1000000,
    });

    price = close;
  }

  return candles;
}
