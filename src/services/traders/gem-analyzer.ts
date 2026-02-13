import { callDeepSeek } from "../shared/llm.js";
import { getCachedGemAnalysis, saveGemAnalysis, insertGemPaperTrade, getGemPaperTrade, type GemAnalysis } from "./storage.js";
import { isPaperMode } from "../../config/env.js";

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

// NOTE: GDELT won't find most new meme coins (they're too small/new for news articles).
// Most tokens will return "No recent mentions found" - this is expected and normal.
// The AI should still evaluate based on token name/concept and whatever it can find.
export async function searchTokenSocials(symbol: string): Promise<string> {
  const query = `"${symbol}" crypto twitter community website`;
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
    console.warn(`[GemAnalyzer] GDELT social search failed for ${symbol}:`, error instanceof Error ? error.message : "unknown");
    return "No recent mentions found";
  }
}

export async function analyzeGem(
  symbol: string,
  chain: string,
  _currentPump: number,
  _peakPump: number,
  _insiderCount: number
): Promise<GemAnalysis> {
  // Check cache first
  const cached = getCachedGemAnalysis(symbol, chain);
  if (cached) return cached;

  // Fetch web context from both general and social searches in parallel
  const [webResults, socialResults] = await Promise.all([
    searchTokenInfo(symbol),
    searchTokenSocials(symbol),
  ]);

  // Build prompt - focuses PURELY on social presence and legitimacy
  // Price metrics (currentPump, peakPump, insiderCount) are NOT included per user instruction
  const userPrompt = `You are a meme coin analyst evaluating new tokens based PURELY on social presence and project legitimacy.

IMPORTANT: Judge based ONLY on:

1. SOCIAL PRESENCE (most important):
   - Does the token have an official X/Twitter account?
   - Are people discussing it on social media?
   - Is there organic community engagement (not just bots)?

2. PROJECT LEGITIMACY:
   - Does it have an official website?
   - Is there a clear use case or narrative?
   - Does the token name/symbol sound legitimate vs. generic scam?

3. YOUR OWN KNOWLEDGE:
   - Do you recognize this token from your training data?
   - Is it a known meme or legitimate project?

Token: ${symbol} on ${chain}

Web search results:
${webResults}

Social/community search results:
${socialResults}

SCORING GUIDE:
- 80-100: Active X account + website + community buzz + you recognize it as legitimate
- 60-79: Some social presence, people talking about it, seems real
- 40-59: Minimal presence, no official accounts found, generic name
- 20-39: No social presence, likely bot-created or dead
- 1-19: Red flags (obvious scam name, copy of existing token, etc.)

IMPORTANT: If both searches found "No recent mentions", the score should be LOW (20-40) because real tokens have SOME web footprint. However, this is common for new meme coins - they're too small for news coverage yet.

Respond JSON only: {"score": <number>, "summary": "<1-2 sentences focusing on social presence and legitimacy>"}`;

  try {
    const response = await callDeepSeek(
      userPrompt,
      "deepseek-chat",
      "You are a meme coin social presence analyst. Respond with JSON only, no markdown.",
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

export async function paperBuyGems(
  tokens: Array<{ symbol: string; chain: string; currentPump: number; score: number }>
): Promise<void> {
  if (!isPaperMode()) return;

  for (const token of tokens) {
    if (token.score < 60) continue;
    const existing = getGemPaperTrade(token.symbol, token.chain);
    if (existing) continue;

    insertGemPaperTrade({
      tokenSymbol: token.symbol,
      chain: token.chain,
      buyPumpMultiple: token.currentPump,
      currentPumpMultiple: token.currentPump,
      buyTimestamp: Date.now(),
      amountUsd: 10,
      pnlPct: 0,
      aiScore: token.score,
      status: "open",
    });

    console.log(`[GemAnalyzer] Paper buy: ${token.symbol} (${token.chain}) at ${token.currentPump.toFixed(1)}x, score: ${token.score}`);
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
    const results: Array<{symbol: string; chain: string; currentPump: number; score: number}> = [];

    for (const token of tokens) {
      try {
        const analysis = await analyzeGem(token.symbol, token.chain, token.currentPump, token.peakPump, token.insiderCount);
        results.push({ symbol: token.symbol, chain: token.chain, currentPump: token.currentPump, score: analysis.score });
        // 2s delay between analyses to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`[GemAnalyzer] Background analysis error for ${token.symbol}:`, error);
      }
    }

    // Auto-buy scored gems as paper trades
    await paperBuyGems(results);
  })();
}
