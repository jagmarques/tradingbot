import { ethers } from "ethers";
import { loadEnv, isPaperMode } from "../../config/env.js";
import { insertTrade, insertPosition, closePosition, getOpenPositions } from "../database/trades.js";

export interface NewPair {
  newToken: string;
  pairAddress: string;
  dex: string;
}
import { recordTrade, validateTrade } from "../risk/manager.js";

// Avalanche configuration - RPC URL loaded from env

// Security: Validate EVM addresses before use
function isValidAddress(address: string): boolean {
  return ethers.isAddress(address);
}

// WAVAX on Avalanche
const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";

// Pangolin Router (V2 compatible, easier to use)
const PANGOLIN_ROUTER = "0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106";

// Router ABI
const ROUTER_ABI = [
  "function swapExactAVAXForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
  "function swapExactTokensForAVAX(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
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
    provider = new ethers.JsonRpcProvider(env.RPC_URL_AVALANCHE, undefined, { batchMaxCount: 1 });
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
  avaxReceived?: bigint;
  pnl?: number;
  error?: string;
}

// Get current price from router
export async function getTokenPrice(tokenAddress: string): Promise<number> {
  try {
    const router = new ethers.Contract(PANGOLIN_ROUTER, ROUTER_ABI, getProvider());
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider());

    const decimals = await token.decimals();
    const amountIn = ethers.parseUnits("1", decimals);

    const path = [tokenAddress, WAVAX];
    const amounts = await router.getAmountsOut(amountIn, path);

    return Number(amounts[1]) / 1e18;
  } catch {
    return 0;
  }
}

// Execute buy
export async function executeBuy(
  pair: NewPair,
  amountAvax: number,
  slippageBps: number = 500
): Promise<BuyResult> {
  const paper = isPaperMode();

  // Validate trade
  const validation = await validateTrade({
    strategy: "avalanche",
    type: "BUY",
    amountUsd: amountAvax * 40, // Rough AVAX price
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
  if (amountAvax <= 0) {
    return { success: false, error: "Invalid amount (must be positive)" };
  }

  if (paper) {
    console.log(`[Avalanche Paper] Would buy ${amountAvax} AVAX of ${pair.newToken}`);

    const mockTokens = BigInt(Math.floor(amountAvax * 1e18 * 1000000));

    insertTrade({
      strategy: "avalanche",
      type: "BUY",
      tokenAddress: pair.newToken,
      amountUsd: amountAvax * 40,
      amountTokens: Number(mockTokens),
      price: amountAvax / Number(mockTokens),
      pnl: 0,
      pnlPercentage: 0,
      fees: amountAvax * 0.003 * 40,
      status: "completed",
    });

    insertPosition({
      strategy: "avalanche",
      tokenAddress: pair.newToken,
      entryPrice: amountAvax / Number(mockTokens),
      amountTokens: Number(mockTokens),
      amountUsd: amountAvax * 40,
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
    const router = new ethers.Contract(PANGOLIN_ROUTER, ROUTER_ABI, w);

    const amountInWei = ethers.parseEther(amountAvax.toString());
    const path = [WAVAX, pair.newToken];

    // Get expected output
    const amounts = await router.getAmountsOut(amountInWei, path);
    const expectedOut = amounts[1];
    const minOut = (expectedOut * BigInt(10000 - slippageBps)) / BigInt(10000);

    const deadline = Math.floor(Date.now() / 1000) + 300;

    const tx = await router.swapExactAVAXForTokens(
      minOut,
      path,
      w.address,
      deadline,
      { value: amountInWei, gasLimit: 400000 }
    );

    const receipt = await tx.wait();

    console.log(`[Avalanche] Buy executed: ${receipt.hash}`);

    insertTrade({
      strategy: "avalanche",
      type: "BUY",
      tokenAddress: pair.newToken,
      amountUsd: amountAvax * 40,
      amountTokens: Number(expectedOut),
      price: amountAvax / Number(expectedOut),
      pnl: 0,
      pnlPercentage: 0,
      fees: amountAvax * 0.003 * 40,
      txHash: receipt.hash,
      status: "completed",
    });

    insertPosition({
      strategy: "avalanche",
      tokenAddress: pair.newToken,
      entryPrice: amountAvax / Number(expectedOut),
      amountTokens: Number(expectedOut),
      amountUsd: amountAvax * 40,
      unrealizedPnl: 0,
      realizedPnl: 0,
      status: "open",
    });

    recordTrade({
      strategy: "avalanche",
      type: "BUY",
      amount: amountAvax * 40,
      price: amountAvax / Number(expectedOut),
      pnl: 0,
    });

    return {
      success: true,
      txHash: receipt.hash,
      tokensReceived: expectedOut,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[Avalanche] Buy failed:", error);

    insertTrade({
      strategy: "avalanche",
      type: "BUY",
      tokenAddress: pair.newToken,
      amountUsd: amountAvax * 40,
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
    console.log(`[Avalanche Paper] Would sell ${amountTokens} of ${tokenAddress}`);

    const mockAvax = BigInt(Math.floor(Number(amountTokens) / 1000000));

    const positions = getOpenPositions("avalanche");
    const position = positions.find(p => p.tokenAddress === tokenAddress);

    if (position) {
      const pnl = (Number(mockAvax) / 1e18 - position.amountUsd / 40) * 40;
      closePosition(position.id, pnl);

      insertTrade({
        strategy: "avalanche",
        type: "SELL",
        tokenAddress,
        amountUsd: Number(mockAvax) / 1e18 * 40,
        amountTokens: Number(amountTokens),
        price: Number(mockAvax) / Number(amountTokens),
        pnl,
        pnlPercentage: (pnl / position.amountUsd) * 100,
        fees: Number(mockAvax) / 1e18 * 0.003 * 40,
        status: "completed",
      });

      recordTrade({
        strategy: "avalanche",
        type: "SELL",
        amount: Number(mockAvax) / 1e18 * 40,
        price: Number(mockAvax) / Number(amountTokens),
        pnl,
      });
    }

    return {
      success: true,
      txHash: `paper_${Date.now()}`,
      avaxReceived: mockAvax,
      pnl: position ? (Number(mockAvax) / 1e18 - position.amountUsd / 40) * 40 : 0,
    };
  }

  // Live trading
  try {
    const w = getWallet();
    const router = new ethers.Contract(PANGOLIN_ROUTER, ROUTER_ABI, w);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, w);

    // Approve router
    const approveTx = await token.approve(PANGOLIN_ROUTER, amountTokens);
    await approveTx.wait();

    const path = [tokenAddress, WAVAX];

    // Get expected output
    const amounts = await router.getAmountsOut(amountTokens, path);
    const expectedOut = amounts[1];
    const minOut = (expectedOut * BigInt(10000 - slippageBps)) / BigInt(10000);

    const deadline = Math.floor(Date.now() / 1000) + 300;

    const tx = await router.swapExactTokensForAVAX(
      amountTokens,
      minOut,
      path,
      w.address,
      deadline,
      { gasLimit: 400000 }
    );

    const receipt = await tx.wait();

    console.log(`[Avalanche] Sell executed: ${receipt.hash}`);

    const positions = getOpenPositions("avalanche");
    const position = positions.find(p => p.tokenAddress === tokenAddress);

    let pnl = 0;
    if (position) {
      pnl = (Number(expectedOut) / 1e18 - position.amountUsd / 40) * 40;
      closePosition(position.id, pnl);
    }

    insertTrade({
      strategy: "avalanche",
      type: "SELL",
      tokenAddress,
      amountUsd: Number(expectedOut) / 1e18 * 40,
      amountTokens: Number(amountTokens),
      price: Number(expectedOut) / Number(amountTokens),
      pnl,
      pnlPercentage: position ? (pnl / position.amountUsd) * 100 : 0,
      fees: Number(expectedOut) / 1e18 * 0.003 * 40,
      txHash: receipt.hash,
      status: "completed",
    });

    recordTrade({
      strategy: "avalanche",
      type: "SELL",
      amount: Number(expectedOut) / 1e18 * 40,
      price: Number(expectedOut) / Number(amountTokens),
      pnl,
    });

    return {
      success: true,
      txHash: receipt.hash,
      avaxReceived: expectedOut,
      pnl,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[Avalanche] Sell failed:", error);

    insertTrade({
      strategy: "avalanche",
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

// Get AVAX balance
export async function getAvaxBalance(): Promise<bigint> {
  const w = getWallet();
  return await getProvider().getBalance(w.address);
}

// Get token balance
export async function getTokenBalance(tokenAddress: string): Promise<bigint> {
  const w = getWallet();
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider());
  return await token.balanceOf(w.address);
}
