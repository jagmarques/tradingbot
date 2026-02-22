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

function buildAnalysisPrompt(
  market: PolymarketEvent,
  news: NewsItem[],
  history: AIAnalysis[],
  stats: { winRate: number; totalBets: number },
  siblingTitles?: string[]
): string {
  const resolveDate = new Date(market.endDate).toLocaleDateString();

  // Multi-candidate context section
  const siblingSection = siblingTitles && siblingTitles.length > 0
    ? `MULTI-CANDIDATE CONTEXT:
This is a multi-candidate race. Other candidates: ${siblingTitles.join(', ')}.
Consider each candidate's specific advantages, endorsements, polling data, and unique factors rather than splitting probability evenly among candidates.

`
    : "";

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
      newsSection += `Content: ${content.slice(0, 2000)}\n\n`;
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
${market.description ? `Description: ${market.description.slice(0, 200)}\n` : ""}Category: ${market.category}
Resolves: ${resolveDate}

${siblingSection}${contextSection}NEWS AND EVIDENCE:
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
Based ONLY on the evidence from Step 1 and your background knowledge, reason through the likelihood of each outcome.
Consider base rates, historical precedent, and current trajectory.

Avoid round numbers like 40%, 35%, 50%, 60%. Use precise estimates like 37%, 43%, 52%, 67%. Round numbers indicate insufficient analysis - always commit to a specific value based on your evidence.

PROBABILITY CALIBRATION - use the full 0-100% range:
- 90-99%: Near certain. Would happen 9+ times out of 10. Example: "Will the sun rise tomorrow?"
- 75-90%: Very likely. Strong evidence, few realistic scenarios where it doesn't happen.
- 60-75%: Likely. More evidence for than against, but meaningful uncertainty remains.
- 40-60%: Uncertain. Evidence is genuinely mixed or insufficient. This is NOT a default.
- 25-40%: Unlikely. More evidence against than for.
- 10-25%: Very unlikely. Would require something surprising to happen.
- 1-10%: Near impossible. Almost no realistic scenario where this happens.

IMPORTANT: Do NOT default to 30-50% when unsure. If evidence clearly favors one side, commit to an extreme estimate. The value of your analysis comes from distinguishing likely from unlikely events.

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

export function parseAnalysisResponse(
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

    if (parsed.changeReason && parsed.changeReason !== "null") {
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
  model?: "deepseek-chat" | "deepseek-reasoner",
  siblingTitles?: string[]
): Promise<AIAnalysis | null> {
  console.log(`[Analyzer] Analyzing: ${market.title}`);

  // Get historical context from DB
  const history = getMarketAnalysisHistory(market.conditionId, 3);
  const dbStats = getBettingStats();
  const stats = { winRate: dbStats.winRate, totalBets: dbStats.totalBets };

  const prompt = buildAnalysisPrompt(market, news, history, stats, siblingTitles);

  try {
    const response = await callDeepSeek(prompt, model ?? "deepseek-chat", undefined, undefined, "aibetting");
    const analysis = parseAnalysisResponse(response, market.conditionId);

    if (analysis) {
      // Store raw R1 probability (Bayesian weighting applied once in scheduler after ensemble)
      analysis.r1RawProbability = analysis.probability;

      // Check citation accuracy and penalize confidence when low
      const articlesWithContent = news.filter(n => n.content);
      if (analysis.evidenceCited && analysis.evidenceCited.length > 0 && articlesWithContent.length >= 2) {
        analysis.citationAccuracy = verifyCitations(analysis.evidenceCited, news);
        if (analysis.citationAccuracy < 0.5) {
          const penalty = 0.15;
          const before = analysis.confidence;
          analysis.confidence = Math.max(0.1, analysis.confidence - penalty);
          console.warn(`[Analyzer] Low citation accuracy: ${(analysis.citationAccuracy * 100).toFixed(0)}% for ${market.title} (confidence ${(before * 100).toFixed(0)}% -> ${(analysis.confidence * 100).toFixed(0)}%)`);
        }
      }

      // Penalize when model can't explain reasoning change (has history but null changeReason)
      if (history.length > 0 && !analysis.consistencyNote) {
        const penalty = 0.10;
        const before = analysis.confidence;
        analysis.confidence = Math.max(0.1, analysis.confidence - penalty);
        console.warn(`[Analyzer] Missing reasoning for change in ${market.title} (confidence ${(before * 100).toFixed(0)}% -> ${(analysis.confidence * 100).toFixed(0)}%)`);
      }

      // Validate reasoning consistency
      const validation = validateReasoning(analysis);
      if (!validation.valid) {
        console.warn(
          `[Analyzer] Reasoning issues for ${market.title}: ${validation.issues.join("; ")}`
        );
        // Log warning but do NOT reject
      }

      saveAnalysis(analysis, market.title);

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

