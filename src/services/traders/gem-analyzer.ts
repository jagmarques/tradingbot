import { callDeepSeek } from "../shared/llm.js";
import { getCachedGemAnalysis, saveGemAnalysis, type GemAnalysis } from "./storage.js";

const GDELT_API_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

export async function searchTokenInfo(symbol: string): Promise<string> {
  const query = `${symbol} crypto token`;
  const url = `${GDELT_API_URL}?query=${encodeURIComponent(query)}+sourcelang:eng&mode=artlist&format=json&maxrecords=5&timespan=30d`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return "No recent mentions found";

    const text = await response.text();
    if (!text.startsWith("{")) return "No recent mentions found";

    const data = JSON.parse(text) as { articles?: Array<{ title: string }> };
    if (!data.articles || data.articles.length === 0) return "No recent mentions found";

    const titles = data.articles.map((a) => a.title).join("\n");
    return titles;
  } catch (error) {
    console.warn(`[GemAnalyzer] GDELT search failed for ${symbol}:`, error instanceof Error ? error.message : "unknown");
    return "No recent mentions found";
  }
}

export async function analyzeGem(
  symbol: string,
  chain: string,
  currentPump: number,
  peakPump: number,
  insiderCount: number
): Promise<GemAnalysis> {
  // Check cache first
  const cached = getCachedGemAnalysis(symbol, chain);
  if (cached) return cached;

  // Fetch web context
  const searchResults = await searchTokenInfo(symbol);

  // Build prompt
  const userPrompt = `Rate this token as a buying opportunity.

Token: ${symbol} on ${chain}
Current pump: ${currentPump.toFixed(1)}x (from baseline)
Peak pump: ${peakPump.toFixed(1)}x
Insider wallets holding: ${insiderCount}

Recent web mentions:
${searchResults}

Score 1-100:
90-100: Strong buy - growing community, active development
70-89: Good buy - solid potential
50-69: Neutral - mixed signals
30-49: Risky - red flags
1-29: Avoid - likely scam or dead

Respond JSON only: {"score": <number>, "summary": "<1-2 sentences>"}`;

  try {
    const response = await callDeepSeek(
      userPrompt,
      "deepseek-chat",
      "You are a crypto token analyst. Respond with JSON only, no markdown.",
      undefined,
      "gem-analyzer"
    );

    // Strip markdown code fences if present
    const cleaned = response.replace(/^```json\n?/i, "").replace(/\n?```$/i, "").trim();

    const parsed = JSON.parse(cleaned) as { score: number; summary: string };
    const score = typeof parsed.score === "number" ? Math.max(1, Math.min(100, parsed.score)) : 50;
    const summary = typeof parsed.summary === "string" ? parsed.summary : "Analysis failed";

    const analysis: GemAnalysis = {
      tokenSymbol: symbol,
      chain,
      score,
      summary,
      analyzedAt: Date.now(),
    };

    saveGemAnalysis(analysis);
    console.log(`[GemAnalyzer] ${symbol} (${chain}): score=${score}`);

    return analysis;
  } catch (error) {
    console.error(`[GemAnalyzer] Analysis failed for ${symbol}:`, error);

    // Return default on failure
    const analysis: GemAnalysis = {
      tokenSymbol: symbol,
      chain,
      score: 50,
      summary: "Analysis failed",
      analyzedAt: Date.now(),
    };

    saveGemAnalysis(analysis);
    return analysis;
  }
}

export function analyzeGemsBackground(
  tokens: Array<{
    symbol: string;
    chain: string;
    currentPump: number;
    peakPump: number;
    insiderCount: number;
  }>
): void {
  console.log(`[GemAnalyzer] Background analysis started for ${tokens.length} tokens`);

  (async () => {
    for (const token of tokens) {
      try {
        await analyzeGem(token.symbol, token.chain, token.currentPump, token.peakPump, token.insiderCount);
        // 2s delay between analyses to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`[GemAnalyzer] Background analysis error for ${token.symbol}:`, error);
      }
    }
  })();
}
