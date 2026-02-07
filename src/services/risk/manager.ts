import { loadEnv, isPaperMode } from "../../config/env.js";
import { getSolBalance } from "../solana/wallet.js";
import { getMaticBalance } from "../polygon/wallet.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  CAPITAL_LOSS_PAUSE_PERCENTAGE,
  STARTING_CAPITAL_USD,
} from "../../config/constants.js";
import {
  insertTrade as dbInsertTrade,
  getTodayTrades as dbGetTodayTrades,
} from "../database/trades.js";
import { getDb } from "../database/db.js";

export interface RiskStatus {
  tradingEnabled: boolean;
  killSwitchActive: boolean;
  dailyPnl: number;
  dailyPnlPercentage: number;
  solBalance: number;
  maticBalance: number;
  hasMinGas: boolean;
  isPaperMode: boolean;
  pauseReason?: string;
}

export interface Trade {
  id: string;
  strategy: "pumpfun" | "polymarket" | "base" | "bnb" | "arbitrum" | "avalanche";
  type: "BUY" | "SELL";
  amount: number;
  price: number;
  pnl: number;
  timestamp: number;
}

// State
let killSwitchActive = false;
let tradingPaused = false;
let pauseReason: string | undefined;

let dailyStartBalance = STARTING_CAPITAL_USD;
let lastDayReset = new Date().toDateString();

// Reset daily stats at midnight
function checkDayReset(): void {
  const today = new Date().toDateString();
  if (today !== lastDayReset) {
    // Database automatically handles day separation via timestamps
    lastDayReset = today;
    console.log("[Risk] Daily stats reset");
  }
}

// Set initial balance (call once at startup)
export function setDailyStartBalance(balanceSol: number): void {
  dailyStartBalance = balanceSol;
  console.log(`[Risk] Daily balance baseline set to ${balanceSol} SOL`);
}

// Calculate daily P&L (from database)
export function getDailyPnl(): number {
  checkDayReset();
  const trades = dbGetTodayTrades();
  return trades.reduce((sum, trade) => sum + trade.pnl, 0);
}

// Get daily P&L breakdown by source
export function getDailyPnlBreakdown(): {
  total: number;
  cryptoCopy: number;
  pumpfun: number;
  polyCopy: number;
  aiBetting: number;
} {
  checkDayReset();
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];
  const startOfDay = today + "T00:00:00.000Z";

  // Crypto copy (base, bnb, arbitrum, avalanche from trades table)
  const cryptoCopyResult = db.prepare(`
    SELECT SUM(pnl) as total
    FROM trades
    WHERE strategy IN ('base', 'bnb', 'arbitrum', 'avalanche')
      AND created_at >= ?
  `).get(startOfDay) as { total: number | null };
  const cryptoCopy = cryptoCopyResult.total || 0;

  // Pump.fun (from trades table)
  const pumpfunResult = db.prepare(`
    SELECT SUM(pnl) as total
    FROM trades
    WHERE strategy = 'pumpfun'
      AND created_at >= ?
  `).get(startOfDay) as { total: number | null };
  const pumpfun = pumpfunResult.total || 0;

  // Polymarket copy (from polytrader_copies table)
  const polyCopyResult = db.prepare(`
    SELECT SUM(pnl) as total
    FROM polytrader_copies
    WHERE status = 'closed'
      AND updated_at >= ?
  `).get(startOfDay) as { total: number | null };
  const polyCopy = polyCopyResult.total || 0;

  // AI betting (from aibetting_positions table)
  const aiBettingResult = db.prepare(`
    SELECT SUM(pnl) as total
    FROM aibetting_positions
    WHERE status = 'closed'
      AND exit_timestamp >= ?
  `).get(new Date(startOfDay).getTime()) as { total: number | null };
  const aiBetting = aiBettingResult.total || 0;

  return {
    total: cryptoCopy + pumpfun + polyCopy + aiBetting,
    cryptoCopy,
    pumpfun,
    polyCopy,
    aiBetting,
  };
}

// Calculate daily P&L percentage
export function getDailyPnlPercentage(): number {
  const pnl = getDailyPnl();
  return dailyStartBalance > 0 ? (pnl / dailyStartBalance) * 100 : 0;
}

// Record a trade (persisted to database)
export function recordTrade(trade: Omit<Trade, "id" | "timestamp">): void {
  checkDayReset();

  // Save to database for persistence
  dbInsertTrade({
    strategy: trade.strategy,
    type: trade.type,
    amountUsd: trade.amount,
    price: trade.price,
    pnl: trade.pnl,
    pnlPercentage: trade.amount > 0 ? (trade.pnl / trade.amount) * 100 : 0,
    fees: 0,
    status: "completed",
  });

  console.log(`[Risk] Trade recorded: ${trade.type} ${trade.amount} (P&L: ${trade.pnl})`);

  // Check if we hit daily loss limit
  checkDailyLossLimit();
}

// Check daily loss limit
function checkDailyLossLimit(): void {
  const env = loadEnv();
  const dailyPnl = getDailyPnl();

  if (dailyPnl < 0 && Math.abs(dailyPnl) >= env.DAILY_LOSS_LIMIT_USD) {
    pauseTrading(`Daily loss limit reached: $${Math.abs(dailyPnl).toFixed(2)}`);
  }

  // Also check percentage-based limit
  const pnlPercentage = getDailyPnlPercentage();
  if (pnlPercentage < 0 && Math.abs(pnlPercentage) >= CAPITAL_LOSS_PAUSE_PERCENTAGE) {
    pauseTrading(`Capital loss limit reached: ${Math.abs(pnlPercentage).toFixed(1)}%`);
  }
}

// Pause trading
export function pauseTrading(reason: string): void {
  tradingPaused = true;
  pauseReason = reason;
  console.log(`[Risk] Trading paused: ${reason}`);
}

// Resume trading
export function resumeTrading(): void {
  tradingPaused = false;
  pauseReason = undefined;
  console.log("[Risk] Trading resumed");
}

// Activate kill switch
export function activateKillSwitch(): void {
  killSwitchActive = true;
  tradingPaused = true;
  pauseReason = "Kill switch activated";
  console.log("[Risk] KILL SWITCH ACTIVATED - All trading stopped");
}

// Deactivate kill switch
export function deactivateKillSwitch(): void {
  killSwitchActive = false;
  tradingPaused = false;
  pauseReason = undefined;
  console.log("[Risk] Kill switch deactivated");
}

// Check if trading is allowed
export function canTrade(): boolean {
  if (killSwitchActive) return false;
  if (tradingPaused) return false;
  return true;
}

// Check slippage
export function checkSlippage(
  expectedPrice: number,
  actualPrice: number,
  maxSlippage: number
): { allowed: boolean; slippage: number } {
  if (expectedPrice <= 0) {
    return { allowed: false, slippage: 1 }; // 100% slippage if no expected price
  }
  const slippage = Math.abs(actualPrice - expectedPrice) / expectedPrice;
  return {
    allowed: slippage <= maxSlippage,
    slippage,
  };
}

// Verify gas balance
export async function verifyGasBalances(): Promise<{
  sol: { balance: number; sufficient: boolean };
  matic: { balance: number; sufficient: boolean };
}> {
  const env = loadEnv();

  const solLamports = await getSolBalance();
  const solBalance = Number(solLamports) / LAMPORTS_PER_SOL;
  const solSufficient = solBalance >= env.MIN_SOL_RESERVE;

  const maticWei = await getMaticBalance();
  const maticBalance = Number(maticWei) / 1e18;
  const maticSufficient = maticBalance >= 0.1; // Min 0.1 MATIC for gas

  return {
    sol: { balance: solBalance, sufficient: solSufficient },
    matic: { balance: maticBalance, sufficient: maticSufficient },
  };
}

// Get full risk status
export async function getRiskStatus(): Promise<RiskStatus> {
  checkDayReset();

  const gasBalances = await verifyGasBalances();
  const dailyPnl = getDailyPnl();
  const dailyPnlPercentage = getDailyPnlPercentage();

  return {
    tradingEnabled: canTrade(),
    killSwitchActive,
    dailyPnl,
    dailyPnlPercentage,
    solBalance: gasBalances.sol.balance,
    maticBalance: gasBalances.matic.balance,
    hasMinGas: gasBalances.sol.sufficient && gasBalances.matic.sufficient,
    isPaperMode: isPaperMode(),
    pauseReason,
  };
}

// Pre-trade validation
export async function validateTrade(params: {
  strategy: "pumpfun" | "polymarket" | "base" | "bnb" | "arbitrum" | "avalanche";
  type: "BUY" | "SELL";
  amountUsd: number;
  expectedPrice: number;
  actualPrice: number;
}): Promise<{ allowed: boolean; reason?: string }> {
  const env = loadEnv();

  // Check kill switch
  if (killSwitchActive) {
    return { allowed: false, reason: "Kill switch active" };
  }

  // Check if trading is paused
  if (tradingPaused) {
    return { allowed: false, reason: pauseReason || "Trading paused" };
  }

  // Check daily loss limit
  const potentialLoss = params.type === "BUY" ? params.amountUsd : 0;
  const projectedDailyPnl = getDailyPnl() - potentialLoss;
  if (projectedDailyPnl < 0 && Math.abs(projectedDailyPnl) > env.DAILY_LOSS_LIMIT_USD) {
    return { allowed: false, reason: "Would exceed daily loss limit" };
  }

  // Check slippage - use pumpfun slippage for Solana, polymarket for EVM chains
  const maxSlippage =
    params.strategy === "pumpfun" ? env.MAX_SLIPPAGE_PUMPFUN : env.MAX_SLIPPAGE_POLYMARKET;
  const slippageCheck = checkSlippage(params.expectedPrice, params.actualPrice, maxSlippage);
  if (!slippageCheck.allowed) {
    return {
      allowed: false,
      reason: `Slippage ${(slippageCheck.slippage * 100).toFixed(2)}% exceeds max ${maxSlippage * 100}%`,
    };
  }

  // Check gas balances for Solana strategies
  const gasBalances = await verifyGasBalances();
  if (params.strategy === "pumpfun" && !gasBalances.sol.sufficient) {
    return { allowed: false, reason: `Insufficient SOL: ${gasBalances.sol.balance.toFixed(4)}` };
  }
  if (params.strategy === "polymarket" && !gasBalances.matic.sufficient) {
    return {
      allowed: false,
      reason: `Insufficient MATIC: ${gasBalances.matic.balance.toFixed(4)}`,
    };
  }
  // EVM chains (base, bnb, arbitrum, avalanche) use native gas tokens
  // Gas check handled in executor before trade

  return { allowed: true };
}

// Get today's trades (from database)
export function getTodayTrades(): Trade[] {
  checkDayReset();
  const dbTrades = dbGetTodayTrades();
  return dbTrades.map((t): Trade => ({
    id: t.id,
    strategy: t.strategy,
    type: t.type,
    amount: t.amountUsd,
    price: t.price,
    pnl: t.pnl,
    timestamp: new Date(t.createdAt).getTime(),
  }));
}

// Check if in paper mode
export function isInPaperMode(): boolean {
  return isPaperMode();
}
