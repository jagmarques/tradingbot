import { ethers } from "ethers";
import { isPaperMode, loadEnv } from "../../config/env.js";
import { NewPair } from "./detector.js";
import { insertTrade } from "../database/trades.js";
import { validateTrade, getDailyPnlPercentage } from "../risk/manager.js";

// Base chain configuration - RPC URL loaded from env

// Security: Validate EVM addresses before use
function isValidAddress(address: string): boolean {
  return ethers.isAddress(address);
}

// Uniswap V2 Router on Base
const UNISWAP_V2_ROUTER = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";

// WETH on Base
const WETH_BASE = "0x4200000000000000000000000000000000000006";

// Router ABIs
const UNISWAP_V2_ROUTER_ABI = [
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)"
];

export interface BasePosition {
  token: string;
  symbol: string;
  entryPrice: number;
  tokenBalance: bigint;
  ethSpent: bigint;
  pairAddress: string;
  dex: "uniswap_v2" | "uniswap_v3" | "aerodrome";
  createdAt: number;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  isPaper: boolean;
  tokensReceived?: bigint;
}

// Active positions
const positions: Map<string, BasePosition> = new Map();

let provider: ethers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    const env = loadEnv();
    provider = new ethers.JsonRpcProvider(env.RPC_URL_BASE);
  }
  return provider;
}

function getWallet(): ethers.Wallet {
  if (!wallet) {
    const env = loadEnv();
    wallet = new ethers.Wallet(env.POLYGON_PRIVATE_KEY, getProvider());
  }
  return wallet;
}

export async function getEthBalance(): Promise<bigint> {
  const w = getWallet();
  return await getProvider().getBalance(w.address);
}

export async function executeBuy(
  pair: NewPair,
  amountEth: number
): Promise<ExecutionResult> {
  // Security: Validate token address
  if (!isValidAddress(pair.newToken)) {
    console.error(`[Base] Invalid token address: ${pair.newToken}`);
    return { success: false, error: "Invalid token address", isPaper: false };
  }
  if (!isValidAddress(pair.pairAddress)) {
    console.error(`[Base] Invalid pair address: ${pair.pairAddress}`);
    return { success: false, error: "Invalid pair address", isPaper: false };
  }

  // Validate amount
  if (amountEth <= 0) {
    return { success: false, error: "Invalid amount (must be positive)", isPaper: false };
  }

  const amountWei = ethers.parseEther(amountEth.toString());

  // Check daily loss limit
  const dailyLoss = getDailyPnlPercentage();
  if (dailyLoss >= 100) {
    console.error("[Base] Daily loss limit reached");
    return { success: false, error: "Daily loss limit reached", isPaper: false };
  }

  // Validate trade
  const validation = await validateTrade({
    strategy: "base",
    type: "BUY",
    amountUsd: amountEth * 3000, // Rough ETH price estimate
    expectedPrice: 1,
    actualPrice: 1,
  });

  if (!validation.allowed) {
    console.error(`[Base] Trade validation failed: ${validation.reason}`);
    return { success: false, error: validation.reason || "Trade validation failed", isPaper: false };
  }

  if (isPaperMode()) {
    console.log(`[Base] PAPER: Buy ${amountEth} ETH of ${pair.newToken}`);

    // Simulate receiving tokens
    const simulatedTokens = BigInt(Math.floor(amountEth * 1_000_000_000));

    // Create position
    const position: BasePosition = {
      token: pair.newToken,
      symbol: "UNKNOWN",
      entryPrice: amountEth / Number(simulatedTokens),
      tokenBalance: simulatedTokens,
      ethSpent: amountWei,
      pairAddress: pair.pairAddress,
      dex: pair.dex,
      createdAt: Date.now(),
    };
    positions.set(pair.newToken, position);

    return {
      success: true,
      txHash: `paper_buy_${Date.now()}`,
      isPaper: true,
      tokensReceived: simulatedTokens,
    };
  }

  try {
    const w = getWallet();
    const router = new ethers.Contract(UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, w);

    // Get expected output
    const path = [WETH_BASE, pair.newToken];
    const amounts = await router.getAmountsOut(amountWei, path);
    const expectedOut = amounts[1];

    // Apply 10% slippage tolerance for new tokens
    const minOut = (expectedOut * BigInt(90)) / BigInt(100);

    // Execute swap
    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes
    const tx = await router.swapExactETHForTokens(
      minOut,
      path,
      w.address,
      deadline,
      { value: amountWei, gasLimit: 300000 }
    );

    console.log(`[Base] Buy tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      return { success: false, error: "Transaction failed", isPaper: false };
    }

    // Get token info
    const token = new ethers.Contract(pair.newToken, ERC20_ABI, getProvider());
    const [balance, decimals, symbol] = await Promise.all([
      token.balanceOf(w.address),
      token.decimals(),
      token.symbol().catch(() => "UNKNOWN"),
    ]);

    // Create position
    const position: BasePosition = {
      token: pair.newToken,
      symbol,
      entryPrice: amountEth / (Number(balance) / Math.pow(10, decimals)),
      tokenBalance: balance,
      ethSpent: amountWei,
      pairAddress: pair.pairAddress,
      dex: pair.dex,
      createdAt: Date.now(),
    };
    positions.set(pair.newToken, position);

    // Record trade
    try {
      await insertTrade({
        strategy: "base",
        type: "BUY",
        tokenAddress: pair.newToken,
        tokenSymbol: symbol,
        amountUsd: amountEth * 3000,
        amountTokens: Number(balance) / Math.pow(10, decimals),
        price: position.entryPrice,
        pnl: 0,
        pnlPercentage: 0,
        fees: 0.001, // Estimated gas
        txHash: tx.hash,
        status: "completed",
      });
    } catch (err) {
      console.error("[Base] Failed to record trade:", err);
    }

    return {
      success: true,
      txHash: tx.hash,
      isPaper: false,
      tokensReceived: balance,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Base] Buy failed:", message);
    return { success: false, error: message, isPaper: false };
  }
}

export async function executeSell(
  token: string,
  percentage: number = 100
): Promise<ExecutionResult> {
  // Security: Validate token address
  if (!isValidAddress(token)) {
    return { success: false, error: "Invalid token address", isPaper: false };
  }

  // Validate percentage
  if (percentage <= 0 || percentage > 100) {
    return { success: false, error: "Invalid percentage (must be 1-100)", isPaper: false };
  }

  const position = positions.get(token);
  if (!position) {
    return { success: false, error: "Position not found", isPaper: isPaperMode() };
  }

  const sellAmount = (position.tokenBalance * BigInt(percentage)) / BigInt(100);

  if (isPaperMode()) {
    console.log(`[Base] PAPER: Sell ${percentage}% of ${position.symbol}`);

    if (percentage >= 100) {
      positions.delete(token);
    } else {
      position.tokenBalance -= sellAmount;
    }

    return {
      success: true,
      txHash: `paper_sell_${Date.now()}`,
      isPaper: true,
    };
  }

  try {
    const w = getWallet();
    const tokenContract = new ethers.Contract(token, ERC20_ABI, w);
    const router = new ethers.Contract(UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, w);

    // Approve router
    const approveTx = await tokenContract.approve(UNISWAP_V2_ROUTER, sellAmount);
    await approveTx.wait();

    // Get expected output
    const path = [token, WETH_BASE];
    const amounts = await router.getAmountsOut(sellAmount, path);
    const expectedOut = amounts[1];

    // Apply 15% slippage for sells (liquidity might be thin)
    const minOut = (expectedOut * BigInt(85)) / BigInt(100);

    // Execute swap
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const tx = await router.swapExactTokensForETH(
      sellAmount,
      minOut,
      path,
      w.address,
      deadline,
      { gasLimit: 300000 }
    );

    console.log(`[Base] Sell tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      return { success: false, error: "Transaction failed", isPaper: false };
    }

    // Update or remove position
    if (percentage >= 100) {
      positions.delete(token);
    } else {
      position.tokenBalance -= sellAmount;
    }

    // Record trade
    try {
      const ethReceived = Number(expectedOut) / 1e18;
      const ethSpent = Number(position.ethSpent) / 1e18;
      const pnl = (ethReceived - ethSpent * (percentage / 100)) * 3000;

      await insertTrade({
        strategy: "base",
        type: "SELL",
        tokenAddress: token,
        tokenSymbol: position.symbol,
        amountUsd: ethReceived * 3000,
        amountTokens: Number(sellAmount),
        price: ethReceived / Number(sellAmount),
        pnl,
        pnlPercentage: (pnl / (ethSpent * (percentage / 100) * 3000)) * 100,
        fees: 0.001,
        txHash: tx.hash,
        status: "completed",
      });
    } catch (err) {
      console.error("[Base] Failed to record trade:", err);
    }

    return {
      success: true,
      txHash: tx.hash,
      isPaper: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Base] Sell failed:", message);
    return { success: false, error: message, isPaper: false };
  }
}

export function getPositions(): Map<string, BasePosition> {
  return new Map(positions);
}

export function getPosition(token: string): BasePosition | undefined {
  return positions.get(token);
}

export async function closePosition(token: string): Promise<ExecutionResult> {
  return executeSell(token, 100);
}
