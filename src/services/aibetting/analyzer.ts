import type { PolymarketEvent, NewsItem, AIAnalysis } from "./types.js";
import { callDeepSeek } from "./deepseek.js";
import { getMarketAnalysisHistory, getBettingStats, saveAnalysis } from "../database/aibetting.js";

interface DeepSeekAnalysisResponse {
  probability: number;
  confidence: number;
  reasoning: string;
  keyFactors: string[];
}

function buildAnalysisPrompt(
  market: PolymarketEvent,
  news: NewsItem[],
  history: AIAnalysis[],
  stats: { winRate: number; totalBets: number }
): string {
  const yesPrice = market.outcomes.find((o) => o.name === "Yes")?.price || 0.5;
  const noPrice = market.outcomes.find((o) => o.name === "No")?.price || 0.5;

  const newsSection =
    news.length > 0
      ? news
          .map((n) => `- [${n.source}] ${n.title}`)
          .join("\n")
      : "No recent news.";

  // Include previous analyses if available
  const historySection =
    history.length > 0
      ? history
          .map((h) => `- ${new Date(h.timestamp).toLocaleDateString()}: P=${(h.probability * 100).toFixed(0)}% C=${(h.confidence * 100).toFixed(0)}% "${h.reasoning}"`)
          .join("\n")
      : "";

  const contextSection = historySection
    ? `\nPREVIOUS ANALYSES:\n${historySection}\n`
    : "";

  const performanceNote =
    stats.totalBets > 5
      ? `\nYour recent win rate: ${stats.winRate.toFixed(0)}% (${stats.totalBets} bets)`
      : "";

  return `You are an expert prediction market analyst.${performanceNote}

MARKET: ${market.title}
Category: ${market.category}
Resolves: ${new Date(market.endDate).toLocaleDateString()}
Odds: YES ${(yesPrice * 100).toFixed(0)}c / NO ${(noPrice * 100).toFixed(0)}c
${contextSection}
NEWS:
${newsSection}

Estimate TRUE probability. Be specific (0.63 not "about 60%"). Lower confidence if uncertain.

OUTPUT JSON ONLY:
{"probability": 0.XX, "confidence": 0.XX, "reasoning": "brief", "keyFactors": ["f1", "f2"]}`;
}

function parseAnalysisResponse(
  response: string,
  marketId: string
): AIAnalysis | null {
  try {
    // Try to extract JSON from response (handle markdown code blocks)
    let jsonStr = response;
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr) as DeepSeekAnalysisResponse;

    // Validate required fields
    if (
      typeof parsed.probability !== "number" ||
      typeof parsed.confidence !== "number"
    ) {
      console.error("[Analyzer] Invalid response structure:", parsed);
      return null;
    }

    // Clamp values to valid range
    const probability = Math.max(0, Math.min(1, parsed.probability));
    const confidence = Math.max(0, Math.min(1, parsed.confidence));

    return {
      marketId,
      probability,
      confidence,
      reasoning: parsed.reasoning || "No reasoning provided",
      keyFactors: parsed.keyFactors || [],
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error("[Analyzer] Failed to parse response:", error);
    console.error("[Analyzer] Raw response:", response);
    return null;
  }
}

export async function analyzeMarket(
  market: PolymarketEvent,
  news: NewsItem[]
): Promise<AIAnalysis | null> {
  console.log(`[Analyzer] Analyzing: ${market.title}`);

  // Get historical context from DB (fail if DB is down)
  const history = getMarketAnalysisHistory(market.conditionId, 3);
  const dbStats = getBettingStats();
  const stats = { winRate: dbStats.winRate, totalBets: dbStats.totalBets };

  const prompt = buildAnalysisPrompt(market, news, history, stats);

  try {
    const response = await callDeepSeek(prompt, "deepseek-chat");
    const analysis = parseAnalysisResponse(response, market.conditionId);

    if (analysis) {
      saveAnalysis(analysis, market.title);
      console.log(
        `[Analyzer] ${market.title}: P=${(analysis.probability * 100).toFixed(1)}% C=${(analysis.confidence * 100).toFixed(0)}%`
      );
    } else {
      console.warn(`[Analyzer] Could not parse AI response for ${market.title}`);
    }

    return analysis;
  } catch (error) {
    console.error(`[Analyzer] Failed: ${market.title}:`, error);
    return null;
  }
}

export async function analyzeMarkets(
  markets: PolymarketEvent[],
  newsMap: Map<string, NewsItem[]>
): Promise<Map<string, AIAnalysis>> {
  const analyses = new Map<string, AIAnalysis>();

  for (const market of markets) {
    const news = newsMap.get(market.conditionId) || [];
    const analysis = await analyzeMarket(market, news);

    if (analysis) {
      analyses.set(market.conditionId, analysis);
    }

    // Small delay between API calls
    await new Promise((r) => setTimeout(r, 1000));
  }

  return analyses;
}
