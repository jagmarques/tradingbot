import { buildQuantPrompt } from "./prompt.js";
import { callDeepSeek } from "../shared/llm.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { isQuantKilled } from "./risk-manager.js";
import type { PairAnalysis, QuantAIDecision, MarketRegime } from "./types.js";
import { QUANT_AI_CACHE_TTL_MS } from "../../config/constants.js";

// --- In-memory cache ---

interface CacheEntry {
  decision: QuantAIDecision;
  expiresAt: number;
}

const analysisCache = new Map<string, CacheEntry>();

function getCached(pair: string): QuantAIDecision | null {
  const entry = analysisCache.get(pair);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    analysisCache.delete(pair);
    return null;
  }
  return entry.decision;
}

function setCache(pair: string, decision: QuantAIDecision): void {
  analysisCache.set(pair, {
    decision,
    expiresAt: Date.now() + QUANT_AI_CACHE_TTL_MS,
  });
}

export function clearAICache(): void {
  analysisCache.clear();
}

// --- Response parser and validator ---

function parseAIResponse(
  raw: string,
  pair: string,
  regime: MarketRegime,
  markPrice: number,
): QuantAIDecision | null {
  // Strip markdown fences
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  }

  // Extract JSON
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error(`[QuantAI] Validation failed for ${pair}: no JSON object found in response`);
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[QuantAI] Validation failed for ${pair}: JSON parse error - ${msg}`);
    return null;
  }

  // Direction
  const direction = parsed["direction"];
  if (direction !== "long" && direction !== "short" && direction !== "flat") {
    console.error(`[QuantAI] Validation failed for ${pair}: invalid direction "${String(direction)}"`);
    return null;
  }

  // Volatile override
  let finalDirection: "long" | "short" | "flat" = direction;
  if (regime === "volatile" && direction !== "flat") {
    console.log(`[QuantAI] Overriding to flat: volatile regime for ${pair}`);
    finalDirection = "flat";
  }

  // Flat: skip SL/TP validation
  if (finalDirection === "flat") {
    const rawConf = Number(parsed["confidence"]);
    const flatConfidence = isFinite(rawConf) ? Math.max(0, Math.min(100, rawConf)) : 0;
    const flatReasoning =
      typeof parsed["reasoning"] === "string" && parsed["reasoning"].trim().length > 0
        ? (parsed["reasoning"] as string).trim()
        : "Flat - no setup";
    return {
      pair,
      direction: "flat" as const,
      entryPrice: markPrice,
      stopLoss: 0,
      takeProfit: 0,
      confidence: flatConfidence,
      reasoning: flatReasoning,
      regime,
      suggestedSizeUsd: 0,
      analyzedAt: new Date().toISOString(),
    };
  }

  // Long/short: validate entry/SL/TP
  const entryPrice = Number(parsed["entryPrice"]);
  if (!isFinite(entryPrice) || entryPrice <= 0) {
    console.error(`[QuantAI] Validation failed for ${pair}: invalid entryPrice ${String(parsed["entryPrice"])}`);
    return null;
  }

  const stopLoss = Number(parsed["stopLoss"]);
  if (!isFinite(stopLoss) || stopLoss <= 0) {
    console.error(`[QuantAI] Validation failed for ${pair}: invalid stopLoss ${String(parsed["stopLoss"])}`);
    return null;
  }

  const takeProfit = Number(parsed["takeProfit"]);
  if (!isFinite(takeProfit) || takeProfit <= 0) {
    console.error(`[QuantAI] Validation failed for ${pair}: invalid takeProfit ${String(parsed["takeProfit"])}`);
    return null;
  }

  const rawConfidence = Number(parsed["confidence"]);
  if (!isFinite(rawConfidence)) {
    console.error(`[QuantAI] Validation failed for ${pair}: invalid confidence ${String(parsed["confidence"])}`);
    return null;
  }

  const reasoning = parsed["reasoning"];
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    console.error(`[QuantAI] Validation failed for ${pair}: missing or empty reasoning`);
    return null;
  }

  // SL direction
  if (finalDirection === "long" && stopLoss >= entryPrice) {
    console.error(`[QuantAI] Validation failed for ${pair}: long stop-loss ${stopLoss} must be below entry ${entryPrice}`);
    return null;
  }
  if (finalDirection === "short" && stopLoss <= entryPrice) {
    console.error(`[QuantAI] Validation failed for ${pair}: short stop-loss ${stopLoss} must be above entry ${entryPrice}`);
    return null;
  }

  // TP direction
  if (finalDirection === "long" && takeProfit <= entryPrice) {
    console.error(`[QuantAI] Validation failed for ${pair}: long take-profit ${takeProfit} must be above entry ${entryPrice}`);
    return null;
  }
  if (finalDirection === "short" && takeProfit >= entryPrice) {
    console.error(`[QuantAI] Validation failed for ${pair}: short take-profit ${takeProfit} must be below entry ${entryPrice}`);
    return null;
  }

  // Clamp 0-100
  const confidence = Math.max(0, Math.min(100, rawConfidence));

  return {
    pair,
    direction: finalDirection,
    entryPrice,
    stopLoss,
    takeProfit,
    confidence,
    reasoning: reasoning.trim(),
    regime,
    suggestedSizeUsd: 0, // Filled by Kelly sizer in runAIDecisionEngine
    analyzedAt: new Date().toISOString(),
  };
}

// --- Main analyzer function ---

export async function analyzeWithAI(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair } = analysis;

  // Check cache first
  const cached = getCached(pair);
  if (cached) {
    console.log(`[QuantAI] Cache hit for ${pair}`);
    return cached;
  }

  // Build prompt from analysis
  const prompt = buildQuantPrompt(analysis);

  // Call DeepSeek
  let raw: string;
  try {
    raw = await callDeepSeek(prompt, "deepseek-chat", undefined, 0.3, "quant");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[QuantAI] DeepSeek call failed for ${pair}: ${msg}`);
    return null;
  }

  // Parse and validate response
  const decision = parseAIResponse(raw, pair, analysis.regime, analysis.markPrice);
  if (!decision) {
    return null;
  }

  // Cache the validated decision
  setCache(pair, decision);

  console.log(
    `[QuantAI] ${pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice} stop=${decision.stopLoss} tp=${decision.takeProfit}`,
  );

  return decision;
}

// --- Orchestrator ---

export async function runAIDecisionEngine(): Promise<QuantAIDecision[]> {
  if (isQuantKilled()) {
    console.log("[QuantAI] Engine skipped: kill switch active");
    return [];
  }

  const analyses = await runMarketDataPipeline();

  const actionable: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    const decision = await analyzeWithAI(analysis);
    if (!decision || decision.direction === "flat") continue;

    // Fill suggestedSizeUsd via Kelly sizer
    const sizeUsd = calculateQuantPositionSize(
      decision.confidence,
      decision.entryPrice,
      decision.stopLoss,
      1, // Leverage passed to executor/risk layer (Phase 28), not used for sizing here
    );

    actionable.push({ ...decision, suggestedSizeUsd: sizeUsd });
  }

  console.log(`[QuantAI] Engine complete: ${actionable.length} actionable decisions from ${analyses.length} pairs`);
  return actionable;
}
