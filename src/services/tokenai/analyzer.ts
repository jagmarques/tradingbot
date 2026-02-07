import type {
  SupportedChain,
  TokenSignals,
  TokenAnalysisResult,
} from "./types.js";
import { collectAllSignals } from "./collect.js";
import { callDeepSeek } from "../shared/llm.js";
import {
  saveTokenAnalysis,
  getTokenAnalysisHistory,
} from "../database/tokenai.js";
import {
  buildTokenPrompt,
  formatSecurityData,
  formatOnchainData,
  formatSocialData,
} from "./prompts.js";

const SYSTEM_MESSAGE =
  "You are an expert crypto token analyst. Always respond with valid JSON only, no markdown or extra text.";

const CONFIDENCE_MAP: Record<string, number> = {
  low: 0.3,
  medium: 0.6,
  high: 0.85,
};

interface DeepSeekTokenResponse {
  successProbability: number;
  confidence: "low" | "medium" | "high";
  reasoning: string;
  keyFactors: string[];
  riskFactors: string[];
  evidenceCited: string[];
}

function parseResponse(response: string): DeepSeekTokenResponse | null {
  try {
    let jsonStr = response;
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr) as DeepSeekTokenResponse;

    if (
      typeof parsed.successProbability !== "number" ||
      typeof parsed.confidence !== "string"
    ) {
      console.error("[TokenAnalyzer] Invalid response structure:", parsed);
      return null;
    }

    const validConfidence = ["low", "medium", "high"];
    if (!validConfidence.includes(parsed.confidence)) {
      console.error(
        "[TokenAnalyzer] Invalid confidence value:",
        parsed.confidence,
      );
      return null;
    }

    parsed.successProbability = Math.max(
      0,
      Math.min(1, parsed.successProbability),
    );

    return {
      successProbability: parsed.successProbability,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning || "No reasoning provided",
      keyFactors: parsed.keyFactors || [],
      riskFactors: parsed.riskFactors || [],
      evidenceCited: parsed.evidenceCited || [],
    };
  } catch (error) {
    console.error("[TokenAnalyzer] Failed to parse response:", error);
    console.error("[TokenAnalyzer] Raw response:", response);
    return null;
  }
}

function verifyCitations(
  evidenceCited: string[],
  signals: TokenSignals,
): number {
  if (evidenceCited.length === 0) return 1.0;

  // Build searchable content from all signal data
  const parts: string[] = [];
  if (signals.security) {
    parts.push(formatSecurityData(signals.security));
  }
  if (signals.onchain) {
    parts.push(formatOnchainData(signals.onchain));
  }
  if (signals.social) {
    parts.push(formatSocialData(signals.social));
  }
  const allContent = parts.join(" ").toLowerCase();

  let verified = 0;
  for (const claim of evidenceCited) {
    const keywords = claim
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    if (keywords.length === 0) continue;

    const matchRate =
      keywords.filter((kw) => allContent.includes(kw)).length / keywords.length;

    if (matchRate > 0.6) verified++;
  }

  return verified / evidenceCited.length;
}

export async function analyzeToken(
  tokenAddress: string,
  chain: SupportedChain,
  tokenSymbol?: string,
): Promise<TokenAnalysisResult | null> {
  const symbol = tokenSymbol || tokenAddress.slice(0, 8);

  try {
    // Collect all signals
    const signals = await collectAllSignals(tokenAddress, chain, tokenSymbol);

    // Get prior analysis history
    const history = getTokenAnalysisHistory(tokenAddress, chain, 3);

    // Build chain-specific prompt and call DeepSeek
    const prompt = buildTokenPrompt(
      tokenAddress,
      chain,
      tokenSymbol,
      signals,
      history,
    );

    const response = await callDeepSeek(
      prompt,
      "deepseek-chat",
      SYSTEM_MESSAGE,
      0.4,
      "tokenai",
    );

    // Parse response
    const parsed = parseResponse(response);
    if (!parsed) {
      console.error(
        `[TokenAnalyzer] Failed to parse response for ${symbol} on ${chain}`,
      );
      return null;
    }

    // Build result
    const result: TokenAnalysisResult = {
      tokenAddress,
      chain,
      successProbability: parsed.successProbability,
      confidence: parsed.confidence,
      confidenceScore: CONFIDENCE_MAP[parsed.confidence] ?? 0.3,
      reasoning: parsed.reasoning,
      keyFactors: parsed.keyFactors,
      riskFactors: parsed.riskFactors,
      evidenceCited: parsed.evidenceCited,
      securityScore: signals.security?.riskScore,
      analyzedAt: new Date().toISOString(),
    };

    // Verify citations
    if (parsed.evidenceCited.length > 0) {
      result.citationAccuracy = verifyCitations(parsed.evidenceCited, signals);
      if (result.citationAccuracy < 0.5) {
        console.warn(
          `[TokenAnalyzer] Low citation accuracy: ${(result.citationAccuracy * 100).toFixed(0)}% for ${symbol}`,
        );
      }
    }

    // Persist to database
    saveTokenAnalysis({
      tokenAddress,
      chain,
      tokenSymbol,
      probability: result.successProbability,
      confidence: result.confidenceScore,
      reasoning: result.reasoning,
      keyFactors: result.keyFactors,
      securityScore: signals.security?.riskScore,
      analyzedAt: result.analyzedAt,
    });

    console.log(
      `[TokenAnalyzer] ${symbol} on ${chain}: P=${(result.successProbability * 100).toFixed(1)}% C=${result.confidence} (${result.reasoning.slice(0, 80)})`,
    );

    return result;
  } catch (error) {
    console.error(`[TokenAnalyzer] Error analyzing ${symbol} on ${chain}:`, error);
    return null;
  }
}
