import type { TokenPosition } from "../database/tokenai.js";
import {
  loadOpenTokenPositions,
  updateTokenPosition,
} from "../database/tokenai.js";
import {
  shouldExitTokenPosition,
  updatePeakPrice,
  clearPeakPrice,
} from "./position-manager.js";
import { notifyTokenAIExit } from "../telegram/notifications.js";
import { getTokenPairs } from "../traders/dexscreener.js";

const DEFAULT_INTERVAL_MS = 30_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// DexScreener chain ID mapping for price feed filtering
const CHAIN_TO_DEXSCREENER: Record<string, string> = {
  solana: "solana",
  ethereum: "ethereum",
  base: "base",
  bnb: "bsc",
  arbitrum: "arbitrum",
  avalanche: "avalanche",
};

async function defaultGetCurrentTokenPrice(
  tokenAddress: string,
  chain: string,
): Promise<number | null> {
  try {
    const pairs = await getTokenPairs(tokenAddress);
    if (pairs.length === 0) return null;

    const dexChainId = CHAIN_TO_DEXSCREENER[chain];
    const match = dexChainId
      ? pairs.find((p) => p.chainId === dexChainId)
      : null;
    const pair = match ?? pairs[0];
    const price = parseFloat(pair.priceUsd);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

// Exported for dependency injection in tests
export const priceFeed = {
  getCurrentTokenPrice: defaultGetCurrentTokenPrice,
};

async function checkSinglePosition(position: TokenPosition): Promise<boolean> {
  const currentPrice = await priceFeed.getCurrentTokenPrice(
    position.tokenAddress,
    position.chain,
  );

  if (currentPrice === null) {
    console.log(
      `[TokenExitLoop] No price for ${position.tokenSymbol || position.tokenAddress.slice(0, 8)} on ${position.chain}, skipping`,
    );
    return false;
  }

  updatePeakPrice(position.id, currentPrice);

  const { shouldExit, reason, newAnalysis } = await shouldExitTokenPosition(
    position,
    currentPrice,
  );

  if (shouldExit) {
    const pnl =
      ((currentPrice - position.entryPrice) / position.entryPrice) *
      position.sizeUsd;

    updateTokenPosition(position.id, {
      status: "closed",
      exitTimestamp: Date.now(),
      exitPrice: currentPrice,
      exitReason: reason,
      pnl,
    });

    clearPeakPrice(position.id);

    void notifyTokenAIExit({
      tokenSymbol: position.tokenSymbol || position.tokenAddress.slice(0, 8),
      chain: position.chain,
      sizeUsd: position.sizeUsd,
      entryPrice: position.entryPrice,
      exitPrice: currentPrice,
      pnl,
      exitReason: reason,
    });

    console.log(
      `[TokenExitLoop] EXIT ${position.tokenSymbol || position.tokenAddress.slice(0, 8)} on ${position.chain}: ${reason}`,
    );
    return true;
  }

  if (newAnalysis) {
    console.log(
      `[TokenExitLoop] HOLD ${position.tokenSymbol || position.tokenAddress.slice(0, 8)} - AI reconfirmed at ${(newAnalysis.successProbability * 100).toFixed(0)}%`,
    );
  }

  return false;
}

async function checkAllPositions(): Promise<void> {
  const positions = loadOpenTokenPositions();

  if (positions.length === 0) {
    return;
  }

  let exitCount = 0;

  for (const position of positions) {
    const exited = await checkSinglePosition(position);
    if (exited) {
      exitCount++;
    }
  }

  console.log(
    `[TokenExitLoop] Checked ${positions.length} positions, ${exitCount} exits triggered`,
  );
}

export function startTokenExitLoop(intervalMs?: number): void {
  if (intervalHandle !== null) {
    console.warn("[TokenExitLoop] Already running, ignoring start request");
    return;
  }

  const interval = intervalMs ?? DEFAULT_INTERVAL_MS;
  console.log(`[TokenExitLoop] Started (interval: ${interval}ms)`);

  // Run immediately on start
  void checkAllPositions();

  intervalHandle = setInterval(() => {
    void checkAllPositions();
  }, interval);
}

export function stopTokenExitLoop(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[TokenExitLoop] Stopped");
  }
}
