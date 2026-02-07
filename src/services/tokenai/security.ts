import type { SecuritySignal, SupportedChain } from "./types.js";
import { GOPLUS_CHAIN_IDS } from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// In-memory cache to avoid hammering free-tier APIs
const securityCache = new Map<
  string,
  { data: SecuritySignal; expiresAt: number }
>();

/** Clear cache (exposed for testing) */
export function clearSecurityCache(): void {
  securityCache.clear();
}

/**
 * Collect security signals for a token.
 * Routes Solana tokens to RugCheck, EVM tokens to GoPlusLabs.
 * Returns null on complete failure (never throws).
 */
export async function collectSecuritySignals(
  tokenAddress: string,
  chain: SupportedChain,
): Promise<SecuritySignal | null> {
  const cacheKey = `${chain}:${tokenAddress}`;
  const cached = securityCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    console.log(
      `[TokenSecurity] Cache hit for ${tokenAddress} on ${chain}`,
    );
    return cached.data;
  }

  try {
    let result: SecuritySignal | null = null;

    if (chain === "solana") {
      result = await fetchRugCheckSecurity(tokenAddress);
    } else {
      const chainId = GOPLUS_CHAIN_IDS[chain];
      if (!chainId) {
        console.warn(
          `[TokenSecurity] Unsupported chain for GoPlusLabs: ${chain}`,
        );
        return null;
      }
      result = await fetchGoPlusSecurity(tokenAddress, chainId);
    }

    if (result) {
      securityCache.set(cacheKey, {
        data: result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }

    return result;
  } catch (error) {
    console.warn(
      `[TokenSecurity] Unexpected error for ${tokenAddress} on ${chain}:`,
      error,
    );
    return null;
  }
}

/**
 * Fetch security data from GoPlusLabs (EVM chains).
 * Free tier, no API key needed.
 */
async function fetchGoPlusSecurity(
  tokenAddress: string,
  chainId: string,
): Promise<SecuritySignal | null> {
  try {
    const url = `https://api.gopluslabs.com/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[TokenSecurity] GoPlusLabs HTTP ${response.status} for ${tokenAddress}`,
      );
      return null;
    }

    const json = (await response.json()) as {
      result?: Record<
        string,
        {
          is_honeypot?: string;
          is_open_source?: string;
          is_proxy?: string;
          is_mintable?: string;
          owner_change_balance?: string;
          buy_tax?: string;
          sell_tax?: string;
          is_anti_whale?: string;
          is_blacklisted?: string;
          is_whitelisted?: string;
          external_call?: string;
          selfdestruct?: string;
          [key: string]: unknown;
        }
      >;
    };

    const addressLower = tokenAddress.toLowerCase();
    const tokenData = json.result?.[addressLower];

    if (!tokenData) {
      console.warn(
        `[TokenSecurity] GoPlusLabs: no data for ${tokenAddress} on chain ${chainId}`,
      );
      return null;
    }

    const isHoneypot = tokenData.is_honeypot === "1";
    const isOpenSource = tokenData.is_open_source === "1";
    const hasProxy = tokenData.is_proxy === "1";
    const hasMintFunction = tokenData.is_mintable === "1";
    const ownerCanChangeBalance = tokenData.owner_change_balance === "1";
    const buyTax = parseFloat(tokenData.buy_tax || "0");
    const sellTax = parseFloat(tokenData.sell_tax || "0");

    // Scam flag heuristic: external calls, selfdestruct, blacklist
    const hasScamFlags =
      tokenData.external_call === "1" ||
      tokenData.selfdestruct === "1" ||
      tokenData.is_blacklisted === "1";

    const riskScore = calculateGoPlusRiskScore({
      isHoneypot,
      hasScamFlags,
      hasProxy,
      hasMintFunction,
      ownerCanChangeBalance,
      buyTax,
      sellTax,
    });

    return {
      isHoneypot,
      hasScamFlags,
      isOpenSource,
      hasProxy,
      hasMintFunction,
      ownerCanChangeBalance,
      buyTax,
      sellTax,
      riskScore,
      auditStatus: isOpenSource ? "unaudited" : "unknown",
      provider: "goplus",
      raw: tokenData as Record<string, unknown>,
    };
  } catch (error) {
    console.warn(`[TokenSecurity] GoPlusLabs fetch failed:`, error);
    return null;
  }
}

/**
 * Calculate risk score from GoPlusLabs fields.
 * 0 = safe, 100 = dangerous.
 */
function calculateGoPlusRiskScore(fields: {
  isHoneypot: boolean;
  hasScamFlags: boolean;
  hasProxy: boolean;
  hasMintFunction: boolean;
  ownerCanChangeBalance: boolean;
  buyTax: number;
  sellTax: number;
}): number {
  let score = 0;

  if (fields.isHoneypot) score += 30;
  if (fields.hasScamFlags) score += 20;
  if (fields.hasProxy) score += 15;
  if (fields.hasMintFunction) score += 15;
  if (fields.ownerCanChangeBalance) score += 10;

  // +5 per 5% tax above 5% threshold
  const buyTaxPercent = fields.buyTax * 100;
  if (buyTaxPercent > 5) {
    score += Math.floor((buyTaxPercent - 5) / 5) * 5;
  }
  const sellTaxPercent = fields.sellTax * 100;
  if (sellTaxPercent > 5) {
    score += Math.floor((sellTaxPercent - 5) / 5) * 5;
  }

  return Math.min(score, 100);
}

/**
 * Fetch security data from RugCheck (Solana).
 * Free tier, no API key needed.
 */
async function fetchRugCheckSecurity(
  tokenAddress: string,
): Promise<SecuritySignal | null> {
  try {
    const url = `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[TokenSecurity] RugCheck HTTP ${response.status} for ${tokenAddress}`,
      );
      return null;
    }

    const json = (await response.json()) as {
      score?: number;
      risks?: Array<{
        name: string;
        level: string;
        description?: string;
      }>;
      [key: string]: unknown;
    };

    const risks = json.risks || [];
    const dangerRisks = risks.filter((r) => r.level === "danger");
    const warnRisks = risks.filter((r) => r.level === "warn");

    // Map RugCheck risks to SecuritySignal fields
    const riskNames = risks.map((r) => r.name.toLowerCase());
    const hasFreezeAuthority = riskNames.some(
      (n) => n.includes("freeze") && n.includes("authority"),
    );
    const hasMintAuthority = riskNames.some(
      (n) => n.includes("mint") && n.includes("authority"),
    );
    const isHoneypot = riskNames.some(
      (n) => n.includes("honeypot") || n.includes("non-transferable"),
    );

    // Any danger-level risk = scam flag
    const hasScamFlags = dangerRisks.length > 0;

    // RugCheck score: higher = safer. Invert to our 0-100 (higher = riskier)
    let riskScore: number;
    if (typeof json.score === "number") {
      // RugCheck score is 0-1000 where higher = safer
      riskScore = Math.max(0, Math.min(100, 100 - Math.round(json.score / 10)));
    } else {
      // Derive from risk count: each danger = 20, each warn = 5
      riskScore = Math.min(
        100,
        dangerRisks.length * 20 + warnRisks.length * 5,
      );
    }

    return {
      isHoneypot,
      hasScamFlags,
      isOpenSource: true, // Solana programs are on-chain
      hasProxy: false, // Not applicable to Solana
      hasMintFunction: hasMintAuthority,
      ownerCanChangeBalance: hasFreezeAuthority,
      buyTax: 0, // Solana tokens don't have on-contract tax
      sellTax: 0,
      riskScore,
      auditStatus: "unknown",
      provider: "rugcheck",
      raw: json as Record<string, unknown>,
    };
  } catch (error) {
    console.warn(`[TokenSecurity] RugCheck fetch failed:`, error);
    return null;
  }
}
