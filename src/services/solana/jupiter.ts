// Jupiter DEX aggregator for Solana swaps
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { loadKeypair } from "./wallet.js";
import { submitBundleWithRetry, waitForBundleConfirmation } from "./jito.js";
import { isPaperMode } from "../../config/env.js";

const JUPITER_API = "https://quote-api.jup.ag/v6";
const SOL_MINT = "So11111111111111111111111111111111111111112";

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

interface JupiterSwapResponse {
  swapTransaction: string;
}

export async function getJupiterQuote(
  outputMint: string,
  amountSol: number,
  slippageBps: number = 100
): Promise<JupiterQuote | null> {
  try {
    const amountLamports = Math.floor(amountSol * 1e9);

    const url = `${JUPITER_API}/quote?inputMint=${SOL_MINT}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`[Jupiter] Quote error: ${response.status}`);
      return null;
    }

    return (await response.json()) as JupiterQuote;
  } catch (err) {
    console.error("[Jupiter] Quote fetch error:", err);
    return null;
  }
}

export async function buildJupiterSwap(
  quote: JupiterQuote,
  walletPubkey: PublicKey
): Promise<VersionedTransaction | null> {
  try {
    const response = await fetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: walletPubkey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    });

    if (!response.ok) {
      console.error(`[Jupiter] Swap build error: ${response.status}`);
      return null;
    }

    const swapResponse = (await response.json()) as JupiterSwapResponse;
    const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    return transaction;
  } catch (err) {
    console.error("[Jupiter] Swap build error:", err);
    return null;
  }
}

export interface JupiterSwapResult {
  success: boolean;
  signature?: string;
  error?: string;
  isPaper?: boolean;
  tokensReceived?: string;
}

export interface JupiterSellResult {
  success: boolean;
  signature?: string;
  error?: string;
  isPaper?: boolean;
  amountReceived?: number;
}

export async function getSellQuote(
  inputMint: string,
  amountTokens: string,
  slippageBps: number = 100
): Promise<JupiterQuote | null> {
  try {
    const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${SOL_MINT}&amount=${amountTokens}&slippageBps=${slippageBps}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`[Jupiter] Sell quote error: ${response.status}`);
      return null;
    }

    return (await response.json()) as JupiterQuote;
  } catch (err) {
    console.error("[Jupiter] Sell quote fetch error:", err);
    return null;
  }
}

export async function executeJupiterSell(
  tokenMint: string,
  amountTokens: string,
  slippageBps: number = 100
): Promise<JupiterSellResult> {
  console.log(`[Jupiter] Selling ${amountTokens} of ${tokenMint.slice(0, 8)}... for SOL`);

  // Paper mode - simulate
  if (isPaperMode()) {
    console.log(`[Jupiter] PAPER: Sell ${amountTokens} tokens for SOL`);
    return {
      success: true,
      signature: `paper_jupiter_sell_${Date.now()}`,
      isPaper: true,
      amountReceived: 0.1, // Simulated SOL received
    };
  }

  try {
    // Get sell quote
    const quote = await getSellQuote(tokenMint, amountTokens, slippageBps);
    if (!quote) {
      return { success: false, error: "Failed to get sell quote" };
    }

    const solReceived = Number(quote.outAmount) / 1e9;
    console.log(`[Jupiter] Sell quote: ${amountTokens} tokens -> ${solReceived.toFixed(6)} SOL`);
    console.log(`[Jupiter] Price impact: ${quote.priceImpactPct}%`);

    // Check price impact
    const priceImpact = parseFloat(quote.priceImpactPct);
    if (priceImpact > 10) {
      return { success: false, error: `Price impact too high: ${priceImpact}%` };
    }

    // Load wallet
    const keypair = loadKeypair();
    if (!keypair) {
      return { success: false, error: "Failed to load keypair" };
    }

    // Build swap transaction
    const transaction = await buildJupiterSwap(quote, keypair.publicKey);
    if (!transaction) {
      return { success: false, error: "Failed to build sell transaction" };
    }

    // Sign transaction
    transaction.sign([keypair]);

    // Submit via Jito for MEV protection
    const bundleId = await submitBundleWithRetry([transaction]);

    if (!bundleId) {
      return { success: false, error: "Failed to submit bundle" };
    }

    console.log(`[Jupiter] Sell bundle submitted: ${bundleId}`);

    // Wait for confirmation
    const confirmed = await waitForBundleConfirmation(bundleId);

    if (confirmed) {
      console.log(`[Jupiter] Sell confirmed: ${bundleId}`);
      return {
        success: true,
        signature: bundleId,
        amountReceived: solReceived,
      };
    } else {
      return { success: false, error: "Sell bundle failed to land" };
    }
  } catch (err) {
    console.error("[Jupiter] Sell execution error:", err);
    return { success: false, error: String(err) };
  }
}

export async function executeJupiterSwap(
  outputMint: string,
  amountSol: number,
  slippageBps: number = 100
): Promise<JupiterSwapResult> {
  console.log(`[Jupiter] Swapping ${amountSol} SOL for ${outputMint.slice(0, 8)}...`);

  // Paper mode - simulate
  if (isPaperMode()) {
    console.log(`[Jupiter] PAPER: Swap ${amountSol} SOL for ${outputMint}`);
    return {
      success: true,
      signature: `paper_jupiter_${Date.now()}`,
      isPaper: true,
      tokensReceived: "1000000", // Simulated
    };
  }

  try {
    // Get quote
    const quote = await getJupiterQuote(outputMint, amountSol, slippageBps);
    if (!quote) {
      return { success: false, error: "Failed to get quote" };
    }

    console.log(`[Jupiter] Quote: ${quote.inAmount} lamports -> ${quote.outAmount} tokens`);
    console.log(`[Jupiter] Price impact: ${quote.priceImpactPct}%`);

    // Check price impact
    const priceImpact = parseFloat(quote.priceImpactPct);
    if (priceImpact > 5) {
      return { success: false, error: `Price impact too high: ${priceImpact}%` };
    }

    // Load wallet
    const keypair = loadKeypair();
    if (!keypair) {
      return { success: false, error: "Failed to load keypair" };
    }

    // Build swap transaction
    const transaction = await buildJupiterSwap(quote, keypair.publicKey);
    if (!transaction) {
      return { success: false, error: "Failed to build swap transaction" };
    }

    // Sign transaction
    transaction.sign([keypair]);

    // Submit via Jito for MEV protection
    const bundleId = await submitBundleWithRetry([transaction]);

    if (!bundleId) {
      return { success: false, error: "Failed to submit bundle" };
    }

    console.log(`[Jupiter] Bundle submitted: ${bundleId}`);

    // Wait for confirmation
    const confirmed = await waitForBundleConfirmation(bundleId);

    if (confirmed) {
      console.log(`[Jupiter] Swap confirmed: ${bundleId}`);
      return {
        success: true,
        signature: bundleId,
        tokensReceived: quote.outAmount,
      };
    } else {
      return { success: false, error: "Bundle failed to land" };
    }
  } catch (err) {
    console.error("[Jupiter] Swap execution error:", err);
    return { success: false, error: String(err) };
  }
}
