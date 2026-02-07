import type { TokenSignals, SupportedChain } from "./types.js";
import type { TokenSignal } from "../database/tokenai.js";
import { collectSecuritySignals } from "./security.js";
import { collectOnchainSignals } from "./onchain.js";
import { collectSocialSignals } from "./social.js";
import { saveTokenSignals } from "../database/tokenai.js";

/**
 * Collect all token signals in parallel (security + onchain + social).
 * Single entry point for Phase 19 analyzer.
 * Saves results to database, returns combined TokenSignals object.
 * Partial failures are handled gracefully (null for failed collectors).
 */
export async function collectAllSignals(
  tokenAddress: string,
  chain: SupportedChain,
  tokenSymbol?: string,
): Promise<TokenSignals> {
  const symbol = tokenSymbol || tokenAddress.slice(0, 6);
  const collectedAt = new Date().toISOString();

  const [securityResult, onchainResult, socialResult] =
    await Promise.allSettled([
      collectSecuritySignals(tokenAddress, chain),
      collectOnchainSignals(tokenAddress, chain),
      collectSocialSignals(symbol, tokenAddress, chain),
    ]);

  const security =
    securityResult.status === "fulfilled" ? securityResult.value : null;
  const onchain =
    onchainResult.status === "fulfilled" ? onchainResult.value : null;
  const social =
    socialResult.status === "fulfilled" ? socialResult.value : null;

  // Save non-null signals to database
  const signals: TokenSignal[] = [];

  if (security) {
    signals.push({
      tokenAddress,
      chain,
      signalType: "security",
      signalData: security as unknown as Record<string, unknown>,
      collectedAt,
    });
  }

  if (onchain) {
    signals.push({
      tokenAddress,
      chain,
      signalType: "onchain",
      signalData: onchain as unknown as Record<string, unknown>,
      collectedAt,
    });
  }

  if (social) {
    signals.push({
      tokenAddress,
      chain,
      signalType: "social",
      signalData: social as unknown as Record<string, unknown>,
      collectedAt,
    });
  }

  if (signals.length > 0) {
    saveTokenSignals(signals);
  }

  console.log(
    `[TokenCollect] Collected signals for ${tokenAddress} on ${chain}: security=${!!security}, onchain=${!!onchain}, social=${!!social}`,
  );

  return {
    tokenAddress,
    chain,
    security,
    onchain,
    social,
    collectedAt,
  };
}
