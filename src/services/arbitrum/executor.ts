import { ethers } from "ethers";
import { loadEnv, isPaperMode } from "../../config/env.js";
import { NewPair } from "./detector.js";
import { insertTrade, insertPosition, closePosition, getOpenPositions } from "../database/trades.js";
import { recordTrade, validateTrade } from "../risk/manager.js";

// Arbitrum configuration - RPC URL loaded from env

// Security: Validate EVM addresses before use
function isValidAddress(address: string): boolean {
  return ethers.isAddress(address);
}

// WETH on Arbitrum
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// Camelot V2 Router (supports most pairs)
const CAMELOT_ROUTER = "0xc873fEcbd354f5A56E00E710B90EF4201db2448d";

// Router ABI
const ROUTER_ABI = [
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, address referrer, uint deadline) external payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, address referrer, uint deadline) external",
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

// ERC20 ABI
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

let provider: ethers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    const env = loadEnv();
    provider = new ethers.JsonRpcProvider(env.RPC_URL_ARBITRUM);
  }
  return provider;
}

function getWallet(): ethers.Wallet {
  if (!wallet) {
    const env = loadEnv();
    const privateKey = env.PRIVATE_KEY_EVM || env.POLYGON_PRIVATE_KEY;
    wallet = new ethers.Wallet(privateKey, getProvider());
  }
  return wallet;
}

export interface BuyResult {
  success: boolean;
  txHash?: string;
  tokensReceived?: bigint;
  error?: string;
}

export interface SellResult {
  success: boolean;
  txHash?: string;
  ethReceived?: bigint;
  pnl?: number;
  error?: string;
}

// Get current price from router
export async function getTokenPrice(tokenAddress: string): Promise<number> {
  try {
    const router = new ethers.Contract(CAMELOT_ROUTER, ROUTER_ABI, getProvider());
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider());

    const decimals = await token.decimals();
    const amountIn = ethers.parseUnits("1", decimals);

    const path = [tokenAddress, WETH];
    const amounts = await router.getAmountsOut(amountIn, path);

    return Number(amounts[1]) / 1e18;
  } catch {
    return 0;
  }
}

// Execute buy
export async function executeBuy(
  pair: NewPair,
  amountEth: number,
  slippageBps: number = 500
): Promise<BuyResult> {
  const paper = isPaperMode();

  // Validate trade
  const validation = await validateTrade({
    strategy: "arbitrum",
    type: "BUY",
    amountUsd: amountEth * 3500, // Rough ETH price
    expectedPrice: 0,
    actualPrice: 0,
  });

  if (!validation.allowed) {
    return { success: false, error: validation.reason };
  }

  // Validate token address
  if (!isValidAddress(pair.newToken)) {
    return { success: false, error: "Invalid token address" };
  }

  // Validate amount
  if (amountEth <= 0) {
    return { success: false, error: "Invalid amount (must be positive)" };
  }

  if (paper) {
    console.log(`[Arbitrum Paper] Would buy ${amountEth} ETH of ${pair.newToken}`);

    const mockTokens = BigInt(Math.floor(amountEth * 1e18 * 1000000));

    insertTrade({
      strategy: "arbitrum",
      type: "BUY",
      tokenAddress: pair.newToken,
      amountUsd: amountEth * 3500,
      amountTokens: Number(mockTokens),
      price: amountEth / Number(mockTokens),
      pnl: 0,
      pnlPercentage: 0,
      fees: amountEth * 0.003 * 3500,
      status: "completed",
    });

    insertPosition({
      strategy: "arbitrum",
      tokenAddress: pair.newToken,
      entryPrice: amountEth / Number(mockTokens),
      amountTokens: Number(mockTokens),
      amountUsd: amountEth * 3500,
      unrealizedPnl: 0,
      realizedPnl: 0,
      status: "open",
    });

    return {
      success: true,
      txHash: `paper_${Date.now()}`,
      tokensReceived: mockTokens,
    };
  }

  // Live trading
  try {
    const w = getWallet();
    const router = new ethers.Contract(CAMELOT_ROUTER, ROUTER_ABI, w);

    const amountInWei = ethers.parseEther(amountEth.toString());
    const path = [WETH, pair.newToken];

    // Get expected output
    const amounts = await router.getAmountsOut(amountInWei, path);
    const expectedOut = amounts[1];
    const minOut = (expectedOut * BigInt(10000 - slippageBps)) / BigInt(10000);

    const deadline = Math.floor(Date.now() / 1000) + 300;

    const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      minOut,
      path,
      w.address,
      ethers.ZeroAddress, // No referrer
      deadline,
      { value: amountInWei, gasLimit: 500000 }
    );

    const receipt = await tx.wait();

    console.log(`[Arbitrum] Buy executed: ${receipt.hash}`);

    insertTrade({
      strategy: "arbitrum",
      type: "BUY",
      tokenAddress: pair.newToken,
      amountUsd: amountEth * 3500,
      amountTokens: Number(expectedOut),
      price: amountEth / Number(expectedOut),
      pnl: 0,
      pnlPercentage: 0,
      fees: amountEth * 0.003 * 3500,
      txHash: receipt.hash,
      status: "completed",
    });

    insertPosition({
      strategy: "arbitrum",
      tokenAddress: pair.newToken,
      entryPrice: amountEth / Number(expectedOut),
      amountTokens: Number(expectedOut),
      amountUsd: amountEth * 3500,
      unrealizedPnl: 0,
      realizedPnl: 0,
      status: "open",
    });

    recordTrade({
      strategy: "arbitrum",
      type: "BUY",
      amount: amountEth * 3500,
      price: amountEth / Number(expectedOut),
      pnl: 0,
    });

    return {
      success: true,
      txHash: receipt.hash,
      tokensReceived: expectedOut,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[Arbitrum] Buy failed:", error);

    insertTrade({
      strategy: "arbitrum",
      type: "BUY",
      tokenAddress: pair.newToken,
      amountUsd: amountEth * 3500,
      price: 0,
      pnl: 0,
      pnlPercentage: 0,
      fees: 0,
      status: "failed",
      errorMessage: error,
    });

    return { success: false, error };
  }
}

// Execute sell
export async function executeSell(
  tokenAddress: string,
  amountTokens: bigint,
  slippageBps: number = 500
): Promise<SellResult> {
  // Security: Validate token address
  if (!isValidAddress(tokenAddress)) {
    return { success: false, error: "Invalid token address" };
  }

  // Validate amount
  if (amountTokens <= BigInt(0)) {
    return { success: false, error: "Invalid amount (must be positive)" };
  }

  const paper = isPaperMode();

  if (paper) {
    console.log(`[Arbitrum Paper] Would sell ${amountTokens} of ${tokenAddress}`);

    const mockEth = BigInt(Math.floor(Number(amountTokens) / 1000000));

    const positions = getOpenPositions("arbitrum");
    const position = positions.find(p => p.tokenAddress === tokenAddress);

    if (position) {
      const pnl = (Number(mockEth) / 1e18 - position.amountUsd / 3500) * 3500;
      closePosition(position.id, pnl);

      insertTrade({
        strategy: "arbitrum",
        type: "SELL",
        tokenAddress,
        amountUsd: Number(mockEth) / 1e18 * 3500,
        amountTokens: Number(amountTokens),
        price: Number(mockEth) / Number(amountTokens),
        pnl,
        pnlPercentage: (pnl / position.amountUsd) * 100,
        fees: Number(mockEth) / 1e18 * 0.003 * 3500,
        status: "completed",
      });

      recordTrade({
        strategy: "arbitrum",
        type: "SELL",
        amount: Number(mockEth) / 1e18 * 3500,
        price: Number(mockEth) / Number(amountTokens),
        pnl,
      });
    }

    return {
      success: true,
      txHash: `paper_${Date.now()}`,
      ethReceived: mockEth,
      pnl: position ? (Number(mockEth) / 1e18 - position.amountUsd / 3500) * 3500 : 0,
    };
  }

  // Live trading
  try {
    const w = getWallet();
    const router = new ethers.Contract(CAMELOT_ROUTER, ROUTER_ABI, w);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, w);

    // Approve router
    const approveTx = await token.approve(CAMELOT_ROUTER, amountTokens);
    await approveTx.wait();

    const path = [tokenAddress, WETH];

    // Get expected output
    const amounts = await router.getAmountsOut(amountTokens, path);
    const expectedOut = amounts[1];
    const minOut = (expectedOut * BigInt(10000 - slippageBps)) / BigInt(10000);

    const deadline = Math.floor(Date.now() / 1000) + 300;

    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      amountTokens,
      minOut,
      path,
      w.address,
      ethers.ZeroAddress,
      deadline,
      { gasLimit: 500000 }
    );

    const receipt = await tx.wait();

    console.log(`[Arbitrum] Sell executed: ${receipt.hash}`);

    const positions = getOpenPositions("arbitrum");
    const position = positions.find(p => p.tokenAddress === tokenAddress);

    let pnl = 0;
    if (position) {
      pnl = (Number(expectedOut) / 1e18 - position.amountUsd / 3500) * 3500;
      closePosition(position.id, pnl);
    }

    insertTrade({
      strategy: "arbitrum",
      type: "SELL",
      tokenAddress,
      amountUsd: Number(expectedOut) / 1e18 * 3500,
      amountTokens: Number(amountTokens),
      price: Number(expectedOut) / Number(amountTokens),
      pnl,
      pnlPercentage: position ? (pnl / position.amountUsd) * 100 : 0,
      fees: Number(expectedOut) / 1e18 * 0.003 * 3500,
      txHash: receipt.hash,
      status: "completed",
    });

    recordTrade({
      strategy: "arbitrum",
      type: "SELL",
      amount: Number(expectedOut) / 1e18 * 3500,
      price: Number(expectedOut) / Number(amountTokens),
      pnl,
    });

    return {
      success: true,
      txHash: receipt.hash,
      ethReceived: expectedOut,
      pnl,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[Arbitrum] Sell failed:", error);

    insertTrade({
      strategy: "arbitrum",
      type: "SELL",
      tokenAddress,
      amountUsd: 0,
      price: 0,
      pnl: 0,
      pnlPercentage: 0,
      fees: 0,
      status: "failed",
      errorMessage: error,
    });

    return { success: false, error };
  }
}

// Get ETH balance
export async function getEthBalance(): Promise<bigint> {
  const w = getWallet();
  return await getProvider().getBalance(w.address);
}

// Get token balance
export async function getTokenBalance(tokenAddress: string): Promise<bigint> {
  const w = getWallet();
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider());
  return await token.balanceOf(w.address);
}
