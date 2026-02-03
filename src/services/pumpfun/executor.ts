import {
  PublicKey,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { loadKeypair, hasMinimumSolReserve } from "../solana/wallet.js";
import { createAndSubmitBundledTransaction, waitForBundleConfirmation } from "../solana/jito.js";
import { isPaperMode } from "../../config/env.js";
import {
  PUMPFUN_PROGRAM_ID,
  SPLIT_BUY,
  SPLIT_BUY_DELAY_MS,
  SELL_TARGETS,
  TRAILING_STOP_ACTIVATION,
  TRAILING_STOP_PERCENTAGE,
  STAGNATION_TIMEOUT_MS,
  ESTIMATED_GAS_FEE_SOL,
  ESTIMATED_SLIPPAGE_PUMPFUN,
} from "../../config/constants.js";
import { TokenLaunch } from "./detector.js";
import { insertTrade } from "../database/trades.js";
import { validateTrade, getDailyPnlPercentage } from "../risk/manager.js";

const PUMPFUN_PUBKEY = new PublicKey(PUMPFUN_PROGRAM_ID);

export interface Position {
  mint: string;
  symbol: string;
  entryPrice: number;
  totalTokens: bigint;
  totalCostLamports: bigint;
  buyPhase: 1 | 2 | 3;
  peakPrice: number;
  trailingStopActive: boolean;
  soldPortions: { first: boolean; second: boolean; third: boolean };
  createdAt: number;
}

export interface ExecutionResult {
  success: boolean;
  signature?: string;
  error?: string;
  isPaper: boolean;
  tokensReceived?: bigint;
}

// Active positions
const positions: Map<string, Position> = new Map();

// Build buy instruction for Pump.fun
function buildBuyInstruction(
  mint: string,
  buyer: PublicKey,
  amountLamports: bigint
): TransactionInstruction {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
    PUMPFUN_PUBKEY
  );

  const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);

  const data = Buffer.alloc(24);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amountLamports, 8);
  data.writeBigUInt64LE(BigInt(0), 16);

  return new TransactionInstruction({
    programId: PUMPFUN_PUBKEY,
    keys: [
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: buyer, isSigner: true, isWritable: true },
    ],
    data,
  });
}

// Build sell instruction for Pump.fun
function buildSellInstruction(
  mint: string,
  seller: PublicKey,
  tokenAmount: bigint
): TransactionInstruction {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
    PUMPFUN_PUBKEY
  );

  const SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

  const data = Buffer.alloc(24);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(BigInt(0), 16); // min SOL out

  return new TransactionInstruction({
    programId: PUMPFUN_PUBKEY,
    keys: [
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: seller, isSigner: true, isWritable: true },
    ],
    data,
  });
}

// Execute split buy strategy
export async function executeSplitBuy(
  launch: TokenLaunch,
  totalAmountSol: number
): Promise<void> {
  const mint = launch.mint;

  // Phase 1: Initial buy (30%)
  const phase1Amount = totalAmountSol * SPLIT_BUY.INITIAL;
  console.log(`[Executor] Phase 1: Buying ${phase1Amount} SOL of ${launch.symbol}`);

  const result1 = await executeBuy(mint, phase1Amount);
  if (!result1.success) {
    console.error(`[Executor] Phase 1 failed: ${result1.error}`);
    return;
  }

  // Record buy in database
  try {
    const entryPrice = phase1Amount / Number(result1.tokensReceived || 1n);
    const estimatedSlippage = phase1Amount * ESTIMATED_SLIPPAGE_PUMPFUN;
    const totalFees = ESTIMATED_GAS_FEE_SOL + estimatedSlippage;
    await insertTrade({
      strategy: "pumpfun",
      type: "BUY",
      tokenAddress: mint,
      tokenSymbol: launch.symbol,
      amountUsd: phase1Amount, // SOL as USD equivalent for simplicity
      amountTokens: Number(result1.tokensReceived || 0n),
      price: entryPrice,
      pnl: 0,
      pnlPercentage: 0,
      fees: totalFees,
      txHash: result1.signature,
      status: "completed",
    });
  } catch (err) {
    console.error(`[Executor] Failed to record trade: ${err}`);
  }

  // Create position with calculated entry price
  const calculatedEntryPrice = phase1Amount / Number(result1.tokensReceived || 1n);
  const position: Position = {
    mint,
    symbol: launch.symbol,
    entryPrice: calculatedEntryPrice,
    totalTokens: result1.tokensReceived || BigInt(0),
    totalCostLamports: BigInt(Math.floor(phase1Amount * LAMPORTS_PER_SOL)),
    buyPhase: 1,
    peakPrice: 0,
    trailingStopActive: false,
    soldPortions: { first: false, second: false, third: false },
    createdAt: Date.now(),
  };
  positions.set(mint, position);

  // Schedule Phase 2 (30% after delay)
  setTimeout(async () => {
    const pos = positions.get(mint);
    if (!pos || pos.buyPhase !== 1) return;

    const phase2Amount = totalAmountSol * SPLIT_BUY.SECOND;
    console.log(`[Executor] Phase 2: Buying ${phase2Amount} SOL of ${launch.symbol}`);

    const result2 = await executeBuy(mint, phase2Amount);
    if (result2.success) {
      pos.buyPhase = 2;
      pos.totalTokens += result2.tokensReceived || BigInt(0);
      pos.totalCostLamports += BigInt(Math.floor(phase2Amount * LAMPORTS_PER_SOL));
    }

    // Schedule Phase 3 (40% after another delay)
    setTimeout(async () => {
      const pos = positions.get(mint);
      if (!pos || pos.buyPhase !== 2) return;

      const phase3Amount = totalAmountSol * SPLIT_BUY.THIRD;
      console.log(`[Executor] Phase 3: Buying ${phase3Amount} SOL of ${launch.symbol}`);

      const result3 = await executeBuy(mint, phase3Amount);
      if (result3.success) {
        pos.buyPhase = 3;
        pos.totalTokens += result3.tokensReceived || BigInt(0);
        pos.totalCostLamports += BigInt(Math.floor(phase3Amount * LAMPORTS_PER_SOL));
        console.log(`[Executor] Split buy complete for ${launch.symbol}`);
      }
    }, SPLIT_BUY_DELAY_MS);
  }, SPLIT_BUY_DELAY_MS);
}

// Execute a single buy
async function executeBuy(mint: string, amountSol: number): Promise<ExecutionResult> {
  const amountLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

  // Check daily loss limit
  const dailyLoss = getDailyPnlPercentage();
  if (dailyLoss >= 100) {
    console.error("[Executor] Daily loss limit reached");
    return { success: false, error: "Daily loss limit reached", isPaper: false };
  }

  // Validate trade
  const validation = await validateTrade({
    strategy: "pumpfun",
    type: "BUY",
    amountUsd: amountSol,
    expectedPrice: 1, // SOL price
    actualPrice: 1,
  });

  if (!validation.allowed) {
    console.error(`[Executor] Trade validation failed: ${validation.reason}`);
    return { success: false, error: validation.reason || "Trade validation failed", isPaper: false };
  }

  if (isPaperMode()) {
    console.log(`[Executor] PAPER: Buy ${amountSol} SOL of ${mint}`);
    return {
      success: true,
      signature: `paper_buy_${Date.now()}`,
      isPaper: true,
      tokensReceived: BigInt(Math.floor(amountSol * 1_000_000)), // Simulated tokens
    };
  }

  try {
    if (!(await hasMinimumSolReserve())) {
      return { success: false, error: "Insufficient SOL reserve", isPaper: false };
    }

    const keypair = loadKeypair();
    const buyIx = buildBuyInstruction(mint, keypair.publicKey, amountLamports);
    const bundleId = await createAndSubmitBundledTransaction([buyIx]);

    if (!bundleId) {
      return { success: false, error: "Bundle submission failed", isPaper: false };
    }

    const confirmed = await waitForBundleConfirmation(bundleId);
    if (!confirmed) {
      return { success: false, error: "Bundle not confirmed", isPaper: false };
    }

    return {
      success: true,
      signature: bundleId,
      isPaper: false,
      tokensReceived: BigInt(Math.floor(amountSol * 1_000_000)), // Estimated - actual parsing requires tx simulation
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      isPaper: false,
    };
  }
}

// Execute a sell
async function executeSell(mint: string, tokenAmount: bigint): Promise<ExecutionResult> {
  if (isPaperMode()) {
    console.log(`[Executor] PAPER: Sell ${tokenAmount} tokens of ${mint}`);
    return {
      success: true,
      signature: `paper_sell_${Date.now()}`,
      isPaper: true,
    };
  }

  try {
    const keypair = loadKeypair();
    const sellIx = buildSellInstruction(mint, keypair.publicKey, tokenAmount);
    const bundleId = await createAndSubmitBundledTransaction([sellIx]);

    if (!bundleId) {
      return { success: false, error: "Bundle submission failed", isPaper: false };
    }

    const confirmed = await waitForBundleConfirmation(bundleId);
    return {
      success: confirmed,
      signature: bundleId,
      isPaper: false,
      error: confirmed ? undefined : "Bundle not confirmed",
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      isPaper: false,
    };
  }
}

// Check and execute auto-sell at targets
export async function checkAutoSell(mint: string, currentPrice: number): Promise<void> {
  const position = positions.get(mint);
  if (!position) return;

  const multiplier = position.entryPrice > 0 ? currentPrice / position.entryPrice : 0;

  // Update peak price for trailing stop
  if (currentPrice > position.peakPrice) {
    position.peakPrice = currentPrice;
  }

  // Check trailing stop
  if (position.trailingStopActive) {
    const dropFromPeak = (position.peakPrice - currentPrice) / position.peakPrice;
    if (dropFromPeak >= TRAILING_STOP_PERCENTAGE) {
      console.log(`[Executor] Trailing stop triggered for ${position.symbol}`);
      await sellRemainingPosition(position);
      return;
    }
  }

  // Check stagnation timeout - exit at break-even if stuck too long
  const positionAge = Date.now() - position.createdAt;
  const noPortionsSold = !position.soldPortions.first && !position.soldPortions.second && !position.soldPortions.third;

  if (positionAge >= STAGNATION_TIMEOUT_MS && multiplier < TRAILING_STOP_ACTIVATION && noPortionsSold) {
    // Only exit if current price is at or above entry (break-even or small profit)
    if (currentPrice >= position.entryPrice) {
      console.log(`[Executor] Stagnation timeout for ${position.symbol} - exiting at ${multiplier.toFixed(2)}x after ${Math.floor(positionAge / 3600000)}h`);
      await sellRemainingPosition(position);
      return;
    } else {
      // Below break-even, log but wait (might recover)
      console.log(`[Executor] ${position.symbol} stagnating at ${multiplier.toFixed(2)}x for ${Math.floor(positionAge / 3600000)}h - below break-even, holding`);
    }
  }

  // Activate trailing stop at 5x
  if (multiplier >= TRAILING_STOP_ACTIVATION && !position.trailingStopActive) {
    console.log(`[Executor] Trailing stop activated for ${position.symbol} at ${multiplier}x`);
    position.trailingStopActive = true;
  }

  // Auto-sell at targets
  const portionSize = position.totalTokens / BigInt(3);

  // First sell at 10x
  if (multiplier >= SELL_TARGETS.FIRST && !position.soldPortions.first) {
    console.log(`[Executor] Selling 1/3 at ${SELL_TARGETS.FIRST}x for ${position.symbol}`);
    const result = await executeSell(mint, portionSize);
    if (result.success) {
      position.soldPortions.first = true;

      // Record sell in database
      try {
        const sellValue = Number(portionSize) * currentPrice;
        const costBasis = Number(portionSize) * position.entryPrice;
        const pnl = sellValue - costBasis;
        const estimatedSlippage = sellValue * ESTIMATED_SLIPPAGE_PUMPFUN;
        const totalFees = ESTIMATED_GAS_FEE_SOL + estimatedSlippage;
        await insertTrade({
          strategy: "pumpfun",
          type: "SELL",
          tokenAddress: mint,
          tokenSymbol: position.symbol,
          amountUsd: sellValue,
          amountTokens: Number(portionSize),
          price: currentPrice,
          pnl: pnl - totalFees,
          pnlPercentage: ((pnl - totalFees) / costBasis) * 100,
          fees: totalFees,
          txHash: result.signature,
          status: "completed",
        });
      } catch (err) {
        console.error(`[Executor] Failed to record trade: ${err}`);
      }
    }
  }

  // Second sell at 50x
  if (multiplier >= SELL_TARGETS.SECOND && !position.soldPortions.second) {
    console.log(`[Executor] Selling 1/3 at ${SELL_TARGETS.SECOND}x for ${position.symbol}`);
    const result = await executeSell(mint, portionSize);
    if (result.success) {
      position.soldPortions.second = true;

      // Record sell in database
      try {
        const sellValue = Number(portionSize) * currentPrice;
        const costBasis = Number(portionSize) * position.entryPrice;
        const pnl = sellValue - costBasis;
        const estimatedSlippage = sellValue * ESTIMATED_SLIPPAGE_PUMPFUN;
        const totalFees = ESTIMATED_GAS_FEE_SOL + estimatedSlippage;
        await insertTrade({
          strategy: "pumpfun",
          type: "SELL",
          tokenAddress: mint,
          tokenSymbol: position.symbol,
          amountUsd: sellValue,
          amountTokens: Number(portionSize),
          price: currentPrice,
          pnl: pnl - totalFees,
          pnlPercentage: ((pnl - totalFees) / costBasis) * 100,
          fees: totalFees,
          txHash: result.signature,
          status: "completed",
        });
      } catch (err) {
        console.error(`[Executor] Failed to record trade: ${err}`);
      }
    }
  }

  // Third sell at 100x
  if (multiplier >= SELL_TARGETS.THIRD && !position.soldPortions.third) {
    console.log(`[Executor] Selling final 1/3 at ${SELL_TARGETS.THIRD}x for ${position.symbol}`);
    const result = await executeSell(mint, portionSize);
    if (result.success) {
      position.soldPortions.third = true;

      // Record sell in database
      try {
        const sellValue = Number(portionSize) * currentPrice;
        const costBasis = Number(portionSize) * position.entryPrice;
        const pnl = sellValue - costBasis;
        const estimatedSlippage = sellValue * ESTIMATED_SLIPPAGE_PUMPFUN;
        const totalFees = ESTIMATED_GAS_FEE_SOL + estimatedSlippage;
        await insertTrade({
          strategy: "pumpfun",
          type: "SELL",
          tokenAddress: mint,
          tokenSymbol: position.symbol,
          amountUsd: sellValue,
          amountTokens: Number(portionSize),
          price: currentPrice,
          pnl: pnl - totalFees,
          pnlPercentage: ((pnl - totalFees) / costBasis) * 100,
          fees: totalFees,
          txHash: result.signature,
          status: "completed",
        });
      } catch (err) {
        console.error(`[Executor] Failed to record trade: ${err}`);
      }

      positions.delete(mint); // Position fully closed
    }
  }
}

// Sell all remaining tokens
async function sellRemainingPosition(position: Position): Promise<void> {
  const remaining =
    position.totalTokens -
    (position.soldPortions.first ? position.totalTokens / BigInt(3) : BigInt(0)) -
    (position.soldPortions.second ? position.totalTokens / BigInt(3) : BigInt(0)) -
    (position.soldPortions.third ? position.totalTokens / BigInt(3) : BigInt(0));

  if (remaining > BigInt(0)) {
    const result = await executeSell(position.mint, remaining);
    if (result.success) {
      console.log(`[Executor] Sold remaining position for ${position.symbol}`);

      // Record sell in database
      try {
        const sellValue = Number(remaining) * position.peakPrice;
        const costBasis = Number(remaining) * position.entryPrice;
        const pnl = sellValue - costBasis;
        const estimatedSlippage = sellValue * ESTIMATED_SLIPPAGE_PUMPFUN;
        const totalFees = ESTIMATED_GAS_FEE_SOL + estimatedSlippage;
        await insertTrade({
          strategy: "pumpfun",
          type: "SELL",
          tokenAddress: position.mint,
          tokenSymbol: position.symbol,
          amountUsd: sellValue,
          amountTokens: Number(remaining),
          price: position.peakPrice,
          pnl: pnl - totalFees,
          pnlPercentage: position.entryPrice > 0 ? ((pnl - totalFees) / costBasis) * 100 : 0,
          fees: totalFees,
          txHash: result.signature,
          status: "completed",
        });
      } catch (err) {
        console.error(`[Executor] Failed to record trade: ${err}`);
      }

      positions.delete(position.mint);
    }
  }
}

// Get all active positions
export function getPositions(): Map<string, Position> {
  return new Map(positions);
}

// Get a specific position
export function getPosition(mint: string): Position | undefined {
  return positions.get(mint);
}

// Close a position manually
export async function closePosition(mint: string): Promise<ExecutionResult> {
  const position = positions.get(mint);
  if (!position) {
    return { success: false, error: "Position not found", isPaper: isPaperMode() };
  }

  await sellRemainingPosition(position);
  return { success: true, isPaper: isPaperMode() };
}

// Get current token price from bonding curve
export async function getTokenPrice(mint: string): Promise<number | null> {
  try {
    const connection = (await import("../solana/wallet.js")).getConnection();
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
      PUMPFUN_PUBKEY
    );

    // Get bonding curve SOL balance (liquidity)
    const solBalance = await connection.getBalance(bondingCurve);
    if (solBalance === 0) return null;

    // Estimate price based on bonding curve formula
    // Price = SOL_reserve / token_supply (simplified)
    // For more accurate pricing, would need to parse bonding curve account data
    const solReserve = solBalance / LAMPORTS_PER_SOL;

    // Get position to calculate relative price change
    const position = positions.get(mint);
    if (!position || position.totalTokens === BigInt(0)) return null;

    // Estimate current price based on liquidity change
    const initialLiquidity = Number(position.totalCostLamports) / LAMPORTS_PER_SOL;
    const liquidityRatio = solReserve / (initialLiquidity || 1);

    // Price moves with liquidity (bonding curve)
    return position.entryPrice * Math.sqrt(liquidityRatio);
  } catch (err) {
    console.error(`[Executor] Failed to get token price for ${mint}:`, err);
    return null;
  }
}
