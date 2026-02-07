import type {
  SupportedChain,
  TokenSignals,
  SecuritySignal,
  OnchainSignal,
  SocialSignal,
} from "./types.js";
import type { TokenAnalysis } from "../database/tokenai.js";

function formatSecurityData(security: SecuritySignal | null): string {
  if (!security) {
    return "No security data available - treat as HIGH RISK";
  }

  return [
    `Honeypot: ${security.isHoneypot ? "YES (CRITICAL)" : "No"}`,
    `Scam flags: ${security.hasScamFlags ? "YES" : "No"}`,
    `Open source: ${security.isOpenSource ? "Yes" : "No"}`,
    `Proxy contract: ${security.hasProxy ? "Yes" : "No"}`,
    `Mint function: ${security.hasMintFunction ? "Yes" : "No"}`,
    `Owner can change balance: ${security.ownerCanChangeBalance ? "Yes" : "No"}`,
    `Buy tax: ${(security.buyTax * 100).toFixed(1)}%`,
    `Sell tax: ${(security.sellTax * 100).toFixed(1)}%`,
    `Risk score: ${security.riskScore}/100`,
    `Audit status: ${security.auditStatus}`,
    `Provider: ${security.provider}`,
  ].join("\n");
}

function formatOnchainData(onchain: OnchainSignal | null): string {
  if (!onchain) {
    return "No on-chain data available";
  }

  return [
    `Holder count: ${onchain.holderCount.toLocaleString()}`,
    `Whale concentration (top 10): ${onchain.whalePercentage.toFixed(1)}%`,
    `Liquidity: $${onchain.liquidityUsd.toLocaleString()}`,
    `24h volume: $${onchain.volume24hUsd.toLocaleString()}`,
    `24h price change: ${onchain.priceChangePercent24h.toFixed(1)}%`,
    `Market cap: $${onchain.marketCapUsd.toLocaleString()}`,
    `Provider: ${onchain.provider}`,
  ].join("\n");
}

function formatSocialData(social: SocialSignal | null): string {
  if (!social) {
    return "No social data available";
  }

  const lines = [
    `Tweet count (24h): ${social.tweetCount24h}`,
    `Sentiment: ${social.sentiment}`,
    `News items: ${social.newsItemCount}`,
  ];

  if (social.topHeadlines.length > 0) {
    lines.push(`Top headlines:`);
    social.topHeadlines.forEach((h) => lines.push(`  - ${h}`));
  }

  if (social.narrativeTags.length > 0) {
    lines.push(`Narrative tags: ${social.narrativeTags.join(", ")}`);
  }

  return lines.join("\n");
}

function formatHistory(history: TokenAnalysis[]): string {
  if (history.length === 0) return "";

  const entries = history.map(
    (h) =>
      `- ${new Date(h.analyzedAt).toLocaleDateString()}: P=${(h.probability * 100).toFixed(0)}% C=${(h.confidence * 100).toFixed(0)}% "${h.reasoning}"`,
  );

  return `\nPREVIOUS ANALYSES:\n${entries.join("\n")}`;
}

function getChainContext(chain: SupportedChain): { context: string; baseRate: string } {
  if (chain === "solana") {
    return {
      context: `CHAIN CONTEXT: Solana / Pump.fun Token
This is a Pump.fun memecoin on Solana. Key considerations:
- Bonding curve mechanics: price follows AMM curve, early buyers get exponential advantage
- Rug pull risk is VERY HIGH: most Pump.fun tokens go to zero within hours
- Dev wallet behavior is critical: check if dev holds >10% supply
- Liquidity is typically thin and volatile - slippage can be extreme
- Social hype drives price more than fundamentals
- Time horizon: these tokens move in minutes to hours, not days
- Base rate for 2x: ~3% (lower than general tokens due to higher failure rate)

RISK PROFILE: ULTRA-HIGH RISK
Weight security flags 2x more heavily. Honeypot or freeze authority = immediate 0% probability.
Any dev wallet >20% = cap probability at 15%.`,
      baseRate: "Base rate for Pump.fun tokens is ~3%.",
    };
  }

  const chainName = chain.toUpperCase();
  return {
    context: `CHAIN CONTEXT: ${chainName} / DEX Token
This is a DEX-traded token on ${chain}. Key considerations:
- Contract verification matters: unverified contracts are high risk
- Liquidity pool depth determines executable trade size and exit ability
- Whale concentration risk: top 10 holders controlling >50% = major dump risk
- Price action is typically slower than Pump.fun but still volatile
- Look for genuine utility or narrative catalyst beyond pure speculation
- Time horizon: these tokens can trend over hours to days
- Base rate for 2x: ~5% (standard token base rate)

RISK PROFILE: HIGH RISK
Proxy contracts with unverified implementation = cap probability at 20%.
Buy/sell tax >5% = significant friction warning.`,
    baseRate: "Base rate for random tokens is ~5%.",
  };
}

export function buildTokenPrompt(
  tokenAddress: string,
  chain: SupportedChain,
  tokenSymbol: string | undefined,
  signals: TokenSignals,
  history: TokenAnalysis[],
): string {
  const symbol = tokenSymbol || tokenAddress.slice(0, 8);
  const historySection = formatHistory(history);
  const { context: chainContext, baseRate } = getChainContext(chain);

  const historyInstruction =
    history.length > 0
      ? `\nYour previous estimate was ${(history[0].probability * 100).toFixed(0)}%. If changing by more than 15 points, cite specific new evidence.`
      : "";

  return `TOKEN: ${symbol} on ${chain}
Address: ${tokenAddress}

${chainContext}

SECURITY DATA:
${formatSecurityData(signals.security)}

ON-CHAIN DATA:
${formatOnchainData(signals.onchain)}

SOCIAL/NEWS DATA:
${formatSocialData(signals.social)}
${historySection}

INSTRUCTIONS:
Analyze this token for potential 2x+ price increase within 24 hours.

STEP 1 - SECURITY ASSESSMENT:
Evaluate security flags. Honeypot = immediate reject. High tax (>10%) = major red flag.
Score the contract security from the data above.

STEP 2 - ON-CHAIN MOMENTUM:
Evaluate holder growth, whale concentration risk, liquidity depth, and volume trends.
Is volume increasing or decreasing? Is liquidity sufficient for entry and exit?

STEP 3 - SOCIAL CATALYST:
Is there active social buzz? What narratives are driving attention?
Recent news catalysts that could move price?

STEP 4 - RISK ASSESSMENT:
List the top 3-5 risks for this token. Consider rug pull probability, whale dump risk,
liquidity drain, and narrative fatigue.

STEP 5 - PROBABILITY ESTIMATE:
Based on Steps 1-4, estimate the probability of a 2x+ price increase within 24 hours.
Be conservative - most tokens fail. ${baseRate}
${historyInstruction}

Confidence calibration:
- "high" (0.80-0.95): Clear signals, strong evidence, high conviction
- "medium" (0.55-0.75): Mixed signals, reasonable case either way
- "low" (0.20-0.50): Weak data, mostly guessing

OUTPUT JSON ONLY:
{
  "successProbability": 0.XX,
  "confidence": "low|medium|high",
  "reasoning": "2-3 sentence summary",
  "keyFactors": ["factor1", "factor2", "factor3"],
  "riskFactors": ["risk1", "risk2", "risk3"],
  "evidenceCited": ["specific data point from signals above"]
}`;
}

export { formatSecurityData, formatOnchainData, formatSocialData };
