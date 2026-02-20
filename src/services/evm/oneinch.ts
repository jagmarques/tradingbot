// 1inch DEX aggregator for EVM swaps
import { ethers, JsonRpcProvider, Wallet } from "ethers";
import type { Chain } from "../traders/types.js";
import { loadEnv, isPaperMode } from "../../config/env.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { dexScreenerFetch } from "../shared/dexscreener.js";

const ONEINCH_API = "https://api.1inch.dev/swap/v6.0";

// Chain IDs for 1inch API
const CHAIN_IDS: Partial<Record<Chain, number>> = {
  ethereum: 1,
  polygon: 137,
  arbitrum: 42161,
  base: 8453,
  optimism: 10,
  avalanche: 43114,
};

// Native token address (same across all chains)
const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// RPC endpoints for each chain
const RPC_ENDPOINTS: Partial<Record<Chain, string>> = {
  ethereum: "https://eth.llamarpc.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  optimism: "https://mainnet.optimism.io",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
};

interface OneInchQuote {
  dstAmount: string;
  tx: {
    from: string;
    to: string;
    data: string;
    value: string;
    gas: number;
    gasPrice: string;
  };
}

export interface OneInchSwapResult {
  success: boolean;
  txHash?: string;
  error?: string;
  isPaper?: boolean;
  tokensReceived?: string;
}

// Provider cache
const providers = new Map<Chain, JsonRpcProvider>();

function getProvider(chain: Chain): JsonRpcProvider | null {
  const cached = providers.get(chain);
  if (cached) {
    return cached;
  }

  const envKey = `RPC_URL_${chain.toUpperCase()}`;
  const rpcUrl = process.env[envKey] || RPC_ENDPOINTS[chain];
  if (!rpcUrl) {
    return null;
  }

  const provider = new JsonRpcProvider(rpcUrl);
  providers.set(chain, provider);
  return provider;
}

function getWallet(chain: Chain): Wallet | null {
  const provider = getProvider(chain);
  if (!provider) return null;

  const env = loadEnv();

  // Use chain-specific private key or fall back to Polygon key for EVM
  let privateKey: string | undefined;

  if (chain === "polygon") {
    privateKey = env.POLYGON_PRIVATE_KEY;
  } else {
    // Check for chain-specific env var or use Polygon key as fallback
    const envKey = `${chain.toUpperCase()}_PRIVATE_KEY`;
    privateKey = (process.env[envKey] as string) || env.POLYGON_PRIVATE_KEY;
  }

  if (!privateKey) {
    return null;
  }

  return new Wallet(privateKey, provider);
}

export function isChainSupported(chain: Chain): boolean {
  return CHAIN_IDS[chain] !== undefined;
}

export async function get1inchQuote(
  chain: Chain,
  tokenAddress: string,
  amountNative: number,
  slippage: number = 1
): Promise<OneInchQuote | null> {
  const chainId = CHAIN_IDS[chain];
  if (!chainId) {
    console.error(`[1inch] Chain ${chain} not supported`);
    return null;
  }

  const wallet = getWallet(chain);
  if (!wallet) {
    console.error(`[1inch] No wallet configured for ${chain}`);
    return null;
  }

  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) {
    console.error("[1inch] ONEINCH_API_KEY not set");
    return null;
  }

  try {
    const amountWei = BigInt(Math.floor(amountNative * 1e18)).toString();

    const url = `${ONEINCH_API}/${chainId}/swap?` +
      `src=${NATIVE_TOKEN}&` +
      `dst=${tokenAddress}&` +
      `amount=${amountWei}&` +
      `from=${wallet.address}&` +
      `slippage=${slippage}&` +
      `disableEstimate=false`;

    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[1inch] Quote error ${response.status}: ${errorText}`);
      return null;
    }

    return (await response.json()) as OneInchQuote;
  } catch (err) {
    console.error("[1inch] Quote fetch error:", err);
    return null;
  }
}

export interface OneInchSellResult {
  success: boolean;
  txHash?: string;
  error?: string;
  isPaper?: boolean;
  amountReceived?: number;
}

export async function get1inchSellQuote(
  chain: Chain,
  tokenAddress: string,
  amountTokens: string,
  slippage: number = 1
): Promise<OneInchQuote | null> {
  const chainId = CHAIN_IDS[chain];
  if (!chainId) {
    console.error(`[1inch] Chain ${chain} not supported`);
    return null;
  }

  const wallet = getWallet(chain);
  if (!wallet) {
    console.error(`[1inch] No wallet configured for ${chain}`);
    return null;
  }

  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) {
    console.error("[1inch] ONEINCH_API_KEY not set");
    return null;
  }

  try {
    const url = `${ONEINCH_API}/${chainId}/swap?` +
      `src=${tokenAddress}&` +
      `dst=${NATIVE_TOKEN}&` +
      `amount=${amountTokens}&` +
      `from=${wallet.address}&` +
      `slippage=${slippage}&` +
      `disableEstimate=false`;

    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[1inch] Sell quote error ${response.status}: ${errorText}`);
      return null;
    }

    return (await response.json()) as OneInchQuote;
  } catch (err) {
    console.error("[1inch] Sell quote fetch error:", err);
    return null;
  }
}

export async function execute1inchSell(
  chain: Chain,
  tokenAddress: string,
  amountTokens: string,
  slippage: number = 1
): Promise<OneInchSellResult> {
  console.log(`[1inch] Selling ${amountTokens} tokens on ${chain} for native`);

  // Paper mode - simulate with DexScreener price
  if (isPaperMode()) {
    console.log(`[1inch] PAPER: Sell ${amountTokens} tokens on ${chain}`);
    let amountReceived = 0.1; // fallback
    try {
      const pair = await dexScreenerFetch(chain, tokenAddress);
      if (pair?.priceUsd) {
        const tokenPriceUsd = parseFloat(pair.priceUsd);
        const APPROX_NATIVE_PRICES: Partial<Record<Chain, number>> = {
          ethereum: 3000, polygon: 0.75, base: 3000,
          arbitrum: 3000, optimism: 3000, avalanche: 35,
        };
        const nativePriceUsd = APPROX_NATIVE_PRICES[chain] ?? 1;
        const tokensHeld = parseFloat(amountTokens) / 1e18;
        if (tokenPriceUsd > 0 && nativePriceUsd > 0 && tokensHeld > 0) {
          const valueUsd = tokensHeld * tokenPriceUsd;
          amountReceived = valueUsd / nativePriceUsd;
        }
      }
    } catch (err) {
      console.log(`[1inch] PAPER: Sell price lookup failed, using fallback:`, err instanceof Error ? err.message : err);
    }
    return {
      success: true,
      txHash: `paper_1inch_sell_${chain}_${Date.now()}`,
      isPaper: true,
      amountReceived,
    };
  }

  const wallet = getWallet(chain);
  if (!wallet) {
    return { success: false, error: `No wallet configured for ${chain}` };
  }

  try {
    // Get sell quote with transaction data
    const quote = await get1inchSellQuote(chain, tokenAddress, amountTokens, slippage);
    if (!quote) {
      return { success: false, error: "Failed to get sell quote" };
    }

    const nativeReceived = Number(quote.dstAmount) / 1e18;
    console.log(`[1inch] Sell quote: ${amountTokens} tokens -> ${nativeReceived.toFixed(6)} native`);

    // Execute the transaction
    const tx = await wallet.sendTransaction({
      to: quote.tx.to,
      data: quote.tx.data,
      value: BigInt(quote.tx.value),
      gasLimit: BigInt(Math.floor(quote.tx.gas * 1.2)), // 20% buffer
    });

    console.log(`[1inch] Sell transaction sent: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();

    if (receipt && receipt.status === 1) {
      console.log(`[1inch] Sell confirmed: ${tx.hash}`);
      return {
        success: true,
        txHash: tx.hash,
        amountReceived: nativeReceived,
      };
    } else {
      return { success: false, error: "Sell transaction failed" };
    }
  } catch (err) {
    console.error("[1inch] Sell execution error:", err);
    return { success: false, error: String(err) };
  }
}

export async function execute1inchSwap(
  chain: Chain,
  tokenAddress: string,
  amountNative: number,
  slippage: number = 1
): Promise<OneInchSwapResult> {
  console.log(`[1inch] Swapping ${amountNative} native on ${chain} for ${tokenAddress.slice(0, 10)}...`);

  // Paper mode - simulate with DexScreener price
  if (isPaperMode()) {
    console.log(`[1inch] PAPER: Swap ${amountNative} native on ${chain} for ${tokenAddress}`);
    let tokensReceived = "1000000000000000000"; // fallback: 1 token
    try {
      const pair = await dexScreenerFetch(chain, tokenAddress);
      if (pair?.priceUsd) {
        const tokenPriceUsd = parseFloat(pair.priceUsd);
        const APPROX_NATIVE_PRICES: Partial<Record<Chain, number>> = {
          ethereum: 3000, polygon: 0.75, base: 3000,
          arbitrum: 3000, optimism: 3000, avalanche: 35,
        };
        const nativePriceUsd = APPROX_NATIVE_PRICES[chain] ?? 1;
        if (tokenPriceUsd > 0) {
          const valueUsd = amountNative * nativePriceUsd;
          const tokens = valueUsd / tokenPriceUsd;
          tokensReceived = BigInt(Math.floor(tokens * 1e18)).toString();
        }
      }
    } catch (err) {
      console.log(`[1inch] PAPER: Price lookup failed, using fallback:`, err instanceof Error ? err.message : err);
    }
    return {
      success: true,
      txHash: `paper_1inch_${chain}_${Date.now()}`,
      isPaper: true,
      tokensReceived,
    };
  }

  const wallet = getWallet(chain);
  if (!wallet) {
    return { success: false, error: `No wallet configured for ${chain}` };
  }

  try {
    // Get quote with transaction data
    const quote = await get1inchQuote(chain, tokenAddress, amountNative, slippage);
    if (!quote) {
      return { success: false, error: "Failed to get quote" };
    }

    console.log(`[1inch] Quote: ${amountNative} native -> ${quote.dstAmount} tokens`);

    // Execute the transaction
    const tx = await wallet.sendTransaction({
      to: quote.tx.to,
      data: quote.tx.data,
      value: BigInt(quote.tx.value),
      gasLimit: BigInt(Math.floor(quote.tx.gas * 1.2)), // 20% buffer
    });

    console.log(`[1inch] Transaction sent: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();

    if (receipt && receipt.status === 1) {
      console.log(`[1inch] Swap confirmed: ${tx.hash}`);
      return {
        success: true,
        txHash: tx.hash,
        tokensReceived: quote.dstAmount,
      };
    } else {
      return { success: false, error: "Transaction failed" };
    }
  } catch (err) {
    console.error("[1inch] Swap execution error:", err);
    return { success: false, error: String(err) };
  }
}

export async function getNativeBalance(chain: Chain): Promise<bigint | null> {
  const wallet = getWallet(chain);
  if (!wallet) return null;

  const provider = getProvider(chain);
  if (!provider) return null;

  try {
    return await provider.getBalance(wallet.address);
  } catch (err) {
    console.error(`[1inch] Balance fetch error on ${chain}:`, err);
    return null;
  }
}

export async function getNativeBalanceFormatted(chain: Chain): Promise<string | null> {
  const balance = await getNativeBalance(chain);
  if (balance === null) return null;
  return ethers.formatEther(balance);
}

// Test which chains are actually working
export async function validateCopyChains(): Promise<{ working: Chain[]; failed: Chain[] }> {
  const working: Chain[] = [];
  const failed: Chain[] = [];

  const chains = Object.keys(CHAIN_IDS) as Chain[];

  for (const chain of chains) {
    try {
      // Test RPC connection
      const provider = getProvider(chain);
      if (!provider) {
        failed.push(chain);
        continue;
      }

      await provider.getBlockNumber();
      working.push(chain);
    } catch {
      failed.push(chain);
    }
  }

  console.log(`[1inch] Working chains: ${working.join(", ") || "none"}`);
  if (failed.length > 0) {
    console.log(`[1inch] Failed chains: ${failed.join(", ")}`);
  }

  return { working, failed };
}

export function getSupportedChains(): Chain[] {
  return Object.keys(CHAIN_IDS) as Chain[];
}

export async function getTokenBalance(chain: Chain, tokenAddress: string): Promise<string | null> {
  const wallet = getWallet(chain);
  if (!wallet) return null;

  try {
    const token = new ethers.Contract(
      tokenAddress,
      ["function balanceOf(address) returns (uint256)"],
      wallet
    );
    const balance = await token.balanceOf(wallet.address);
    return balance.toString();
  } catch (err) {
    console.error(`[1inch] Token balance fetch error on ${chain}:`, err);
    return null;
  }
}

export async function approveAndSell1inch(
  chain: Chain,
  tokenAddress: string,
  slippage: number = 3
): Promise<OneInchSellResult> {
  console.log(`[1inch] Approve+Sell: ${tokenAddress.slice(0, 10)}... on ${chain}`);

  // Paper mode - skip approve, just call execute1inchSell
  if (isPaperMode()) {
    return await execute1inchSell(chain, tokenAddress, "0", slippage);
  }

  const wallet = getWallet(chain);
  if (!wallet) {
    return { success: false, error: `No wallet configured for ${chain}` };
  }

  try {
    // Get token balance
    const balance = await getTokenBalance(chain, tokenAddress);
    if (!balance || balance === "0") {
      return { success: false, error: "No token balance" };
    }

    console.log(`[1inch] Approve+Sell: balance=${balance}`);

    // Get sell quote to find router address
    const quote = await get1inchSellQuote(chain, tokenAddress, balance, slippage);
    if (!quote) {
      return { success: false, error: "Failed to get sell quote for approval" };
    }

    const routerAddress = quote.tx.to;
    console.log(`[1inch] Approve+Sell: approving ${routerAddress} to spend ${balance}`);

    // Approve router to spend tokens
    const token = new ethers.Contract(
      tokenAddress,
      ["function approve(address, uint256) returns (bool)"],
      wallet
    );

    const approveTx = await token.approve(routerAddress, balance);
    console.log(`[1inch] Approve+Sell: approval tx sent ${approveTx.hash}`);

    await approveTx.wait();
    console.log(`[1inch] Approve+Sell: approval confirmed`);

    // Execute sell
    return await execute1inchSell(chain, tokenAddress, balance, slippage);
  } catch (err) {
    console.error("[1inch] Approve+Sell error:", err);
    return { success: false, error: String(err) };
  }
}
