import { ethers } from "ethers";
import { loadEnv, isPaperMode } from "../../config/env.js";
import { NewPair } from "./detector.js";
import { insertTrade, insertPosition, closePosition, getOpenPositions } from "../database/trades.js";
import { recordTrade, validateTrade } from "../risk/manager.js";

// BNB Chain configuration - RPC URL loaded from env

// Security: Validate EVM addresses before use
function isValidAddress(address: string): boolean {
  return ethers.isAddress(address);
}

// WBNB on BSC
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

// PancakeSwap V2 Router
const PANCAKESWAP_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

// Router ABI
const ROUTER_ABI = [
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
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
    provider = new ethers.JsonRpcProvider(env.RPC_URL_BNB);
  }
  return provider;
}

function getWallet(): ethers.Wallet {
  if (!wallet) {
    const env = loadEnv();
    // Use PRIVATE_KEY_EVM if set, otherwise fall back to POLYGON_PRIVATE_KEY
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
  bnbReceived?: bigint;
  pnl?: number;
  error?: string;
}

// Get current price from router
export async function getTokenPrice(tokenAddress: string): Promise<number> {
  try {
    const router = new ethers.Contract(PANCAKESWAP_V2_ROUTER, ROUTER_ABI, getProvider());
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider());

    const decimals = await token.decimals();
    const amountIn = ethers.parseUnits("1", decimals);

    const path = [tokenAddress, WBNB];
    const amounts = await router.getAmountsOut(amountIn, path);

    return Number(amounts[1]) / 1e18;
  } catch {
    return 0;
  }
}

// Execute buy
export async function executeBuy(
  pair: NewPair,
  amountBnb: number,
  slippageBps: number = 500 // 5% default
): Promise<BuyResult> {
  const paper = isPaperMode();

  // Validate trade
  const validation = await validateTrade({
    strategy: "bnb",
    type: "BUY",
    amountUsd: amountBnb * 600, // Rough BNB price
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
  if (amountBnb <= 0) {
    return { success: false, error: "Invalid amount (must be positive)" };
  }

  if (paper) {
    console.log(`[BNB Paper] Would buy ${amountBnb} BNB of ${pair.newToken}`);

    const mockTokens = BigInt(Math.floor(amountBnb * 1e18 * 1000000));

    insertTrade({
      strategy: "bnb",
      type: "BUY",
      tokenAddress: pair.newToken,
      amountUsd: amountBnb * 600,
      amountTokens: Number(mockTokens),
      price: amountBnb / Number(mockTokens),
      pnl: 0,
      pnlPercentage: 0,
      fees: amountBnb * 0.003 * 600,
      status: "completed",
    });

    insertPosition({
      strategy: "bnb",
      tokenAddress: pair.newToken,
      entryPrice: amountBnb / Number(mockTokens),
      amountTokens: Number(mockTokens),
      amountUsd: amountBnb * 600,
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
    const router = new ethers.Contract(PANCAKESWAP_V2_ROUTER, ROUTER_ABI, w);

    const amountInWei = ethers.parseEther(amountBnb.toString());
    const path = [WBNB, pair.newToken];

    // Get expected output
    const amounts = await router.getAmountsOut(amountInWei, path);
    const expectedOut = amounts[1];
    const minOut = (expectedOut * BigInt(10000 - slippageBps)) / BigInt(10000);

    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min

    const tx = await router.swapExactETHForTokens(
      minOut,
      path,
      w.address,
      deadline,
      { value: amountInWei, gasLimit: 300000 }
    );

    const receipt = await tx.wait();

    console.log(`[BNB] Buy executed: ${receipt.hash}`);

    insertTrade({
      strategy: "bnb",
      type: "BUY",
      tokenAddress: pair.newToken,
      amountUsd: amountBnb * 600,
      amountTokens: Number(expectedOut),
      price: amountBnb / Number(expectedOut),
      pnl: 0,
      pnlPercentage: 0,
      fees: amountBnb * 0.003 * 600,
      txHash: receipt.hash,
      status: "completed",
    });

    insertPosition({
      strategy: "bnb",
      tokenAddress: pair.newToken,
      entryPrice: amountBnb / Number(expectedOut),
      amountTokens: Number(expectedOut),
      amountUsd: amountBnb * 600,
      unrealizedPnl: 0,
      realizedPnl: 0,
      status: "open",
    });

    recordTrade({
      strategy: "bnb",
      type: "BUY",
      amount: amountBnb * 600,
      price: amountBnb / Number(expectedOut),
      pnl: 0,
    });

    return {
      success: true,
      txHash: receipt.hash,
      tokensReceived: expectedOut,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[BNB] Buy failed:", error);

    insertTrade({
      strategy: "bnb",
      type: "BUY",
      tokenAddress: pair.newToken,
      amountUsd: amountBnb * 600,
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
    console.log(`[BNB Paper] Would sell ${amountTokens} of ${tokenAddress}`);

    const mockBnb = BigInt(Math.floor(Number(amountTokens) / 1000000));

    const positions = getOpenPositions("bnb");
    const position = positions.find(p => p.tokenAddress === tokenAddress);

    if (position) {
      const pnl = (Number(mockBnb) / 1e18 - position.amountUsd / 600) * 600;
      closePosition(position.id, pnl);

      insertTrade({
        strategy: "bnb",
        type: "SELL",
        tokenAddress,
        amountUsd: Number(mockBnb) / 1e18 * 600,
        amountTokens: Number(amountTokens),
        price: Number(mockBnb) / Number(amountTokens),
        pnl,
        pnlPercentage: (pnl / position.amountUsd) * 100,
        fees: Number(mockBnb) / 1e18 * 0.003 * 600,
        status: "completed",
      });

      recordTrade({
        strategy: "bnb",
        type: "SELL",
        amount: Number(mockBnb) / 1e18 * 600,
        price: Number(mockBnb) / Number(amountTokens),
        pnl,
      });
    }

    return {
      success: true,
      txHash: `paper_${Date.now()}`,
      bnbReceived: mockBnb,
      pnl: position ? (Number(mockBnb) / 1e18 - position.amountUsd / 600) * 600 : 0,
    };
  }

  // Live trading
  try {
    const w = getWallet();
    const router = new ethers.Contract(PANCAKESWAP_V2_ROUTER, ROUTER_ABI, w);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, w);

    // Approve router
    const approveTx = await token.approve(PANCAKESWAP_V2_ROUTER, amountTokens);
    await approveTx.wait();

    const path = [tokenAddress, WBNB];

    // Get expected output
    const amounts = await router.getAmountsOut(amountTokens, path);
    const expectedOut = amounts[1];
    const minOut = (expectedOut * BigInt(10000 - slippageBps)) / BigInt(10000);

    const deadline = Math.floor(Date.now() / 1000) + 300;

    const tx = await router.swapExactTokensForETH(
      amountTokens,
      minOut,
      path,
      w.address,
      deadline,
      { gasLimit: 300000 }
    );

    const receipt = await tx.wait();

    console.log(`[BNB] Sell executed: ${receipt.hash}`);

    const positions = getOpenPositions("bnb");
    const position = positions.find(p => p.tokenAddress === tokenAddress);

    let pnl = 0;
    if (position) {
      pnl = (Number(expectedOut) / 1e18 - position.amountUsd / 600) * 600;
      closePosition(position.id, pnl);
    }

    insertTrade({
      strategy: "bnb",
      type: "SELL",
      tokenAddress,
      amountUsd: Number(expectedOut) / 1e18 * 600,
      amountTokens: Number(amountTokens),
      price: Number(expectedOut) / Number(amountTokens),
      pnl,
      pnlPercentage: position ? (pnl / position.amountUsd) * 100 : 0,
      fees: Number(expectedOut) / 1e18 * 0.003 * 600,
      txHash: receipt.hash,
      status: "completed",
    });

    recordTrade({
      strategy: "bnb",
      type: "SELL",
      amount: Number(expectedOut) / 1e18 * 600,
      price: Number(expectedOut) / Number(amountTokens),
      pnl,
    });

    return {
      success: true,
      txHash: receipt.hash,
      bnbReceived: expectedOut,
      pnl,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[BNB] Sell failed:", error);

    insertTrade({
      strategy: "bnb",
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

// Get BNB balance
export async function getBnbBalance(): Promise<bigint> {
  const w = getWallet();
  return await getProvider().getBalance(w.address);
}

// Get token balance
export async function getTokenBalance(tokenAddress: string): Promise<bigint> {
  const w = getWallet();
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider());
  return await token.balanceOf(w.address);
}
