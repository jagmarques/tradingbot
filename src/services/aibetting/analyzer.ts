import type { PolymarketEvent, NewsItem, AIAnalysis } from "./types.js";
import { callDeepSeek } from "./deepseek.js";
import { getMarketAnalysisHistory, getBettingStats, saveAnalysis, savePrediction } from "../database/aibetting.js";

interface DeepSeekAnalysisResponse {
  probability: number;
  confidence: number;
  reasoning: string;
  keyFactors: string[];
  changeReason?: string;
  evidenceCited: string[];
  consistencyNote: string;
  timeline: string | null;
}

// Bayesian update: weight prior + new evidence -> posterior
function bayesianUpdate(
  prior: number,
  newEstimate: number,
  priorWeight: number,
  evidenceStrength: number
): { probability: number; uncertainty: number } {
  const totalWeight = priorWeight + evidenceStrength;
  const posterior = (prior * priorWeight + newEstimate * evidenceStrength) / totalWeight;
  const uncertainty = 1 - (evidenceStrength / totalWeight);

  // Clamp values
  return {
    probability: Math.max(0.01, Math.min(0.99, posterior)),
    uncertainty: Math.max(0.05, Math.min(0.95, uncertainty)),
  };
}

function buildAnalysisPrompt(
  market: PolymarketEvent,
  news: NewsItem[],
  history: AIAnalysis[],
  stats: { winRate: number; totalBets: number }
): string {
  const yesPrice = market.outcomes.find((o) => o.name === "Yes")?.price || 0.5;
  const noPrice = market.outcomes.find((o) => o.name === "No")?.price || 0.5;
  const resolveDate = new Date(market.endDate).toLocaleDateString();

  // Build news section with article content for top 3
  let newsSection = "";
  if (news.length === 0) {
    newsSection = "No recent news. Use your background knowledge and the market context to estimate probability.";
  } else {
    const top3 = news.slice(0, 3);
    const remaining = news.slice(3);

    // Show full content for top 3 articles
    top3.forEach((n, i) => {
      newsSection += `ARTICLE ${i + 1}: [${n.source}] ${n.title}\n`;
      const content = n.content || n.summary || "No content available";
      newsSection += `Content: ${content.slice(0, 5000)}\n\n`;
    });

    // Show titles only for remaining articles
    if (remaining.length > 0) {
      newsSection += "OTHER ARTICLES:\n";
      remaining.forEach((n) => {
        newsSection += `- [${n.source}] ${n.title}\n`;
      });
    }
  }

  const historySection =
    history.length > 0
      ? history
          .map((h) => `- ${new Date(h.timestamp).toLocaleDateString()}: P=${(h.probability * 100).toFixed(0)}% C=${(h.confidence * 100).toFixed(0)}% "${h.reasoning}"`)
          .join("\n")
      : "";

  const contextSection = historySection
    ? `PREVIOUS ANALYSES:\n${historySection}\n\n`
    : "";

  const performanceNote =
    stats.totalBets > 5
      ? `Your recent win rate: ${stats.winRate.toFixed(0)}% (${stats.totalBets} bets).\n\n`
      : "";

  return `You are an expert prediction market analyst. Your job: find where markets are mispriced based on EVIDENCE.

${performanceNote}MARKET: ${market.title}
Category: ${market.category}
Resolves: ${resolveDate}
Current odds: YES ${(yesPrice * 100).toFixed(0)}c / NO ${(noPrice * 100).toFixed(0)}c

${contextSection}NEWS AND EVIDENCE:
${newsSection}

INSTRUCTIONS:
Analyze this market using the following steps. You MUST complete each step.

STEP 1 - EVIDENCE GATHERING:
List 3-5 specific facts from the articles above that are relevant to this market's outcome.
Use key phrases and words directly from the articles when citing evidence.
If no articles have useful content, state what you know from background knowledge and note the evidence is weak.

STEP 1.5 - TIMELINE ANALYSIS (for date-based markets):
${market.title.match(/by|before|in (202\d|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i) ? `What needs to happen by ${resolveDate} for each outcome?\nWhat is the current trajectory? What milestones remain?` : "Skip this step - market is not date-based."}

STEP 2 - PROBABILITY REASONING:
Based ONLY on the evidence from Step 1, reason through the likelihood of each outcome.
Consider base rates, historical precedent, and current trajectory.

STEP 3 - CONSISTENCY CHECK:
${historySection ? `Your previous estimate was ${(history[0].probability * 100).toFixed(0)}%. If your new estimate differs by more than 10 percentage points, you MUST identify the specific NEW evidence that justifies the change. Changing estimates without new evidence is a reasoning error.` : "This is your first analysis of this market. State your confidence level honestly."}

STEP 4 - FINAL ESTIMATE:
Based on Steps 1-3, provide your probability estimate and confidence.

Confidence calibration (how sure you are about YOUR estimate, not how much evidence exists):
- 0.80-0.95: You have a clear, well-supported view
- 0.65-0.80: You have a reasonable view with some uncertainty
- 0.50-0.65: Evidence is mixed but you lean one way
- Below 0.50: Genuinely uncertain, close to a coin flip

OUTPUT JSON ONLY (no other text):
{
  "probability": 0.XX,
  "confidence": 0.XX,
  "reasoning": "2-3 sentence summary of your conclusion from Step 2",
  "keyFactors": ["factor1", "factor2", "factor3"],
  "evidenceCited": ["quote key phrases from articles verbatim", "another direct quote or key phrase"],
  "consistencyNote": "why different from prior OR 'consistent with prior estimate' OR 'first analysis'",
  "changeReason": "what new evidence caused the change, or null",
  "timeline": "what needs to happen by when, or null"
}`;
}

// Verify cited evidence against actual article content
function verifyCitations(
  evidenceCited: string[],
  articles: NewsItem[]
): number {
  if (evidenceCited.length === 0) return 1.0; // No claims = no hallucinations

  const allContent = articles
    .map(a => a.content || a.summary || a.title)
    .join(' ')
    .toLowerCase();

  let verified = 0;
  for (const claim of evidenceCited) {
    // Fuzzy match: check if key words from claim appear in article content
    const keywords = claim.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3); // Ignore short words (the, and, for, etc.)

    if (keywords.length === 0) continue; // Skip empty/trivial claims

    const matchRate = keywords.filter(kw => allContent.includes(kw)).length / keywords.length;

    if (matchRate > 0.4) verified++; // 40% keyword match = verified
  }

  return verified / evidenceCited.length;
}

// Validate reasoning for internal consistency
function validateReasoning(
  analysis: AIAnalysis
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check 1: If high probability (>70%), must have reasonable confidence
  if (analysis.probability > 0.7 && analysis.confidence < 0.6) {
    issues.push("High probability estimate with low confidence - inconsistent");
  }

  // Check 2: If low confidence (<50%), probability should be near 50% (uncertain)
  if (analysis.confidence < 0.5 && Math.abs(analysis.probability - 0.5) > 0.2) {
    issues.push("Low confidence but extreme probability - inconsistent");
  }

  // Check 3: Evidence cited should not be empty for confident predictions
  if (analysis.confidence > 0.7 && (!analysis.evidenceCited || analysis.evidenceCited.length === 0)) {
    issues.push("High confidence with no evidence cited");
  }

  return { valid: issues.length === 0, issues };
}

function parseAnalysisResponse(
  response: string,
  marketId: string
): AIAnalysis | null {
  try {
    // Extract JSON from response
    let jsonStr = response;
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr) as DeepSeekAnalysisResponse;

    // Validate fields
    if (
      typeof parsed.probability !== "number" ||
      typeof parsed.confidence !== "number"
    ) {
      console.error("[Analyzer] Invalid response structure:", parsed);
      return null;
    }

    // Clamp values
    const probability = Math.max(0, Math.min(1, parsed.probability));
    const confidence = Math.max(0, Math.min(1, parsed.confidence));

    if (parsed.changeReason) {
      console.log(`[Analyzer] Change reason: ${parsed.changeReason}`);
    }

    // Parse new evidence fields
    const evidenceCited = parsed.evidenceCited || [];
    const consistencyNote = parsed.consistencyNote || "";
    const timeline = parsed.timeline !== undefined ? parsed.timeline : undefined;

    if (evidenceCited.length === 0) {
      console.warn(`[Analyzer] Warning: No evidence cited for ${marketId}`);
    }

    return {
      marketId,
      probability,
      confidence,
      reasoning: parsed.reasoning || "No reasoning provided",
      keyFactors: parsed.keyFactors || [],
      timestamp: Date.now(),
      evidenceCited,
      consistencyNote,
      timeline,
    };
  } catch (error) {
    console.error("[Analyzer] Failed to parse response:", error);
    console.error("[Analyzer] Raw response:", response);
    return null;
  }
}

export async function analyzeMarket(
  market: PolymarketEvent,
  news: NewsItem[],
  temperature?: number,
  systemMessage?: string
): Promise<AIAnalysis | null> {
  console.log(`[Analyzer] Analyzing: ${market.title}`);

  // Get historical context from DB
  const history = getMarketAnalysisHistory(market.conditionId, 3);
  const dbStats = getBettingStats();
  const stats = { winRate: dbStats.winRate, totalBets: dbStats.totalBets };

  const prompt = buildAnalysisPrompt(market, news, history, stats);

  try {
    const response = await callDeepSeek(prompt, "deepseek-chat", systemMessage, temperature ?? 0.4, "aibetting");
    const analysis = parseAnalysisResponse(response, market.conditionId);

    if (analysis) {
      // Log citation accuracy as metric (warn-only, don't reject)
      const articlesWithContent = news.filter(n => n.content);
      if (analysis.evidenceCited && analysis.evidenceCited.length > 0 && articlesWithContent.length >= 2) {
        analysis.citationAccuracy = verifyCitations(analysis.evidenceCited, news);
        if (analysis.citationAccuracy < 0.5) {
          console.warn(`[Analyzer] Low citation accuracy: ${(analysis.citationAccuracy * 100).toFixed(0)}% for ${market.title}`);
        }
      }

      // Validate reasoning consistency
      const validation = validateReasoning(analysis);
      if (!validation.valid) {
        console.warn(
          `[Analyzer] Reasoning issues for ${market.title}: ${validation.issues.join("; ")}`
        );
        // Log warning but do NOT reject
      }

      const rawProbability = analysis.probability;

      // Apply Bayesian weighting
      if (history.length > 0) {
        // Weighted prior from recent analyses
        let prior: number;
        if (history.length === 1) {
          prior = history[0].probability;
        } else if (history.length === 2) {
          prior = history[0].probability * 0.6 + history[1].probability * 0.4;
        } else {
          prior = history[0].probability * 0.6 + history[1].probability * 0.3 + history[2].probability * 0.1;
        }

        // More history = stronger prior
        const priorWeight = 0.3 * Math.min(history.length, 3);

        // More news = stronger evidence
        const evidenceStrength = Math.min(0.3 + news.length * 0.1, 1.0);

        const { probability, uncertainty } = bayesianUpdate(prior, rawProbability, priorWeight, evidenceStrength);

        analysis.probability = probability;
        analysis.uncertainty = uncertainty;

        console.log(
          `[Analyzer] Bayesian update: raw=${(rawProbability * 100).toFixed(1)}% prior=${(prior * 100).toFixed(1)}% -> posterior=${(probability * 100).toFixed(1)}% (uncertainty=${(uncertainty * 100).toFixed(1)}%)`
        );
      } else {
        // No history - max uncertainty
        analysis.uncertainty = 0.5;
      }

      saveAnalysis(analysis, market.title);

      // Save calibration prediction for both YES and NO sides
      const yesOutcome = market.outcomes.find((o) => o.name === "Yes");
      const noOutcome = market.outcomes.find((o) => o.name === "No");

      if (yesOutcome) {
        savePrediction(
          market.conditionId,
          market.title,
          yesOutcome.tokenId,
          "YES",
          analysis.probability,
          analysis.confidence,
          market.category
        );
      }

      if (noOutcome) {
        savePrediction(
          market.conditionId,
          market.title,
          noOutcome.tokenId,
          "NO",
          1 - analysis.probability,
          analysis.confidence,
          market.category
        );
      }

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

    await new Promise((r) => setTimeout(r, 1000));
  }

  return analyses;
}
