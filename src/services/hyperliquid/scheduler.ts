import { analyzeWithAI, clearAICacheForPair } from "./ai-analyzer.js";
import { fetchDailyCandles, computeDailySma } from "./daily-indicators.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { isQuantKilled } from "./risk-manager.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_HYBRID_LIVE_ENGINES, QUANT_AI_DIRECTIONAL_ENABLED, QUANT_DTF_MR_ENABLED } from "../../config/constants.js";
import type { QuantAIDecision } from "./types.js";
import { runDtfMrCycle } from "./dtf-mr.js";
import { runMomentumCycle } from "./momentum-engine.js";
import { runWickflowCycle } from "./wickflow-engine.js";
import { runSkewMrCycle } from "./skewmr-engine.js";
// import { runOrderbookCycle } from "./orderbook-engine.js";

let fastInterval: ReturnType<typeof setInterval> | null = null;
let slowInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;
let aiCycleRunning = false;
let slowCycleRunning = false;

const AI_CYCLE_MS = 60 * 1000; // 1 min for AI
const SLOW_CYCLE_MS = 15 * 60 * 1000; // 15 min for Chandelier/EMA

const STOP_LOSS_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const FLIP_COOLDOWN_MS = 30 * 60 * 1000; // 30 min after signal-flip before re-entering same pair
const stopLossCooldowns = new Map<string, number>();
const flipCooldowns = new Map<string, number>(); // pair -> timestamp of last flip close

export function recordStopLossCooldown(pair: string, direction: string, tradeType = "directional"): void {
  const key = `${pair}:${direction}:${tradeType}`;
  stopLossCooldowns.set(key, Date.now());
  console.log(`[QuantScheduler] SL cooldown: ${pair} ${direction} (${tradeType}, 2h)`);
}

function isInStopLossCooldown(pair: string, direction: string, tradeType = "directional"): boolean {
  const key = `${pair}:${direction}:${tradeType}`;
  const ts = stopLossCooldowns.get(key);
  if (!ts) return false;
  if (Date.now() - ts > STOP_LOSS_COOLDOWN_MS) { stopLossCooldowns.delete(key); return false; }
  return true;
}

function recordFlipCooldown(pair: string): void {
  flipCooldowns.set(pair, Date.now());
  console.log(`[QuantScheduler] Flip cooldown: ${pair} (30m)`);
}

function isInFlipCooldown(pair: string): boolean {
  const ts = flipCooldowns.get(pair);
  if (!ts) return false;
  if (Date.now() - ts > FLIP_COOLDOWN_MS) { flipCooldowns.delete(pair); return false; }
  return true;
}

// Cache pipeline results to avoid hammering exchange APIs every minute
let pipelineCache: Awaited<ReturnType<typeof runMarketDataPipeline>> | null = null;
let pipelineCacheAt = 0;
const PIPELINE_CACHE_MS = 2 * 60 * 1000; // 2 min

async function getCachedPipeline(): Promise<Awaited<ReturnType<typeof runMarketDataPipeline>>> {
  if (pipelineCache && Date.now() - pipelineCacheAt < PIPELINE_CACHE_MS) return pipelineCache;
  pipelineCache = await runMarketDataPipeline();
  pipelineCacheAt = Date.now();
  return pipelineCache;
}

// Fast cycle: AI engine every 1 min
async function runAICycle(): Promise<void> {
  if (aiCycleRunning || !QUANT_AI_DIRECTIONAL_ENABLED) return;
  aiCycleRunning = true;
  try {
    if (isQuantKilled()) return;
    const analyses = await getCachedPipeline();
    const openPositions = getOpenQuantPositions();
    const aiDecisions: QuantAIDecision[] = [];
    const aiSignals = new Map<string, "long" | "short" | "flat">();

    for (const analysis of analyses) {
      const dailyCandles = await fetchDailyCandles(analysis.pair, 150);
      const closes = dailyCandles.map((c) => c.close);
      const sma50 = computeDailySma(closes, 50, closes.length - 1);
      const markPrice = analysis.markPrice;
      let dailyTrend: { direction: "bullish" | "bearish" | "neutral"; price: number; sma50: number } | null = null;
      if (sma50 !== null) {
        const direction = markPrice > sma50 * 1.01 ? "bullish" : markPrice < sma50 * 0.99 ? "bearish" : "neutral";
        dailyTrend = { direction, price: markPrice, sma50 };
      }
      const decision = await analyzeWithAI(analysis, dailyTrend);
      if (!decision) continue;
      aiSignals.set(decision.pair, decision.direction);
      if (decision.direction === "flat") continue;
      const sizeUsd = calculateQuantPositionSize(decision.confidence, decision.entryPrice, decision.stopLoss, "ai-directional");
      if (sizeUsd <= 0) continue;
      aiDecisions.push({ ...decision, suggestedSizeUsd: sizeUsd });
    }

    const aiOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "ai-directional" || p.tradeType === "directional" || !p.tradeType).map(p => p.pair),
    );

    // Signal-flip exits
    const aiPositions = openPositions.filter(p => p.tradeType === "ai-directional" || p.tradeType === "directional" || !p.tradeType);
    for (const pos of aiPositions) {
      const signal = aiSignals.get(pos.pair);
      if (!signal) continue;
      if (signal !== "flat" && signal !== pos.direction) {
        console.log(`[QuantScheduler] Signal flip: ${pos.pair} ${pos.direction}->${signal}`);
        const result = await closePosition(pos.id, `signal-flip (${pos.direction}->${signal})`);
        if (result.success) { aiOpenPairs.delete(pos.pair); clearAICacheForPair(pos.pair); recordFlipCooldown(pos.pair); }
      }
    }

    // New entries
    let aiExecuted = 0;
    for (const decision of aiDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      if (aiOpenPairs.has(decision.pair)) continue;
      if (isInStopLossCooldown(decision.pair, decision.direction, "ai-directional")) continue;
      if (isInFlipCooldown(decision.pair)) continue;
      const invConflict = openPositions.find(p => p.mode === "live" && p.exchange === "lighter" && QUANT_HYBRID_LIVE_ENGINES.has(p.tradeType ?? "") && p.pair === decision.pair && p.direction !== decision.direction);
      if (invConflict) continue;
      const position = await openPosition(decision.pair, decision.direction, QUANT_FIXED_POSITION_SIZE_USD, 10, decision.stopLoss, decision.takeProfit, decision.regime, "ai-directional", undefined, decision.entryPrice);
      if (position) { aiExecuted++; aiOpenPairs.add(decision.pair); }
    }

    console.log(`[QuantScheduler] AI cycle: ${aiExecuted}/${aiDecisions.length} trades`);
  } finally { aiCycleRunning = false; }
}

// Slow cycle: Chandelier, EMA cross, orderbook every 15 min
async function runSlowCycle(): Promise<void> {
  if (slowCycleRunning) return;
  slowCycleRunning = true;
  try {
    if (isQuantKilled()) return;

    let dtfMrExecuted = 0;
    if (QUANT_DTF_MR_ENABLED) {
      try { dtfMrExecuted = await runDtfMrCycle(); }
      catch (err) { console.error(`[QuantScheduler] DtfMR error: ${err instanceof Error ? err.message : String(err)}`); }
    }

    let momExecuted = 0;
    try { momExecuted = await runMomentumCycle(); }
    catch (err) { console.error(`[QuantScheduler] Mom4h error: ${err instanceof Error ? err.message : String(err)}`); }

    let emaExecuted = 0;
    try { const { runEmaCrossCycle } = await import("./ema-cross.js"); emaExecuted = await runEmaCrossCycle(); }
    catch (err) { console.error(`[QuantScheduler] EMA error: ${err instanceof Error ? err.message : String(err)}`); }

    let wfExecuted = 0;
    try { wfExecuted = await runWickflowCycle(); }
    catch (err) { console.error(`[QuantScheduler] WickFlow error: ${err instanceof Error ? err.message : String(err)}`); }

    let skewExecuted = 0;
    try { skewExecuted = await runSkewMrCycle(); }
    catch (err) { console.error(`[QuantScheduler] SkewMR error: ${err instanceof Error ? err.message : String(err)}`); }

    // OB disabled to reduce API load
    // try { await runOrderbookCycle(); } catch {}

    const dtfLog = QUANT_DTF_MR_ENABLED ? `MR ${dtfMrExecuted}` : "MR OFF";
    console.log(`[QuantScheduler] Slow cycle: ${dtfLog}, Mom ${momExecuted}, EMA ${emaExecuted}, WF ${wfExecuted}, Skew ${skewExecuted}`);
  } finally { slowCycleRunning = false; }
}

// Combined first run
export async function runDirectionalCycle(): Promise<void> {
  await Promise.all([runAICycle(), runSlowCycle()]);
}

export function startQuantScheduler(): void {
  if (fastInterval !== null || initialRunTimeout !== null) return;
  console.log("[QuantScheduler] Started (AI 1m, slow 15m)");
  initialRunTimeout = setTimeout(() => { void runDirectionalCycle(); }, 15_000);
  fastInterval = setInterval(() => { void runAICycle(); }, AI_CYCLE_MS);
  slowInterval = setInterval(() => { void runSlowCycle(); }, SLOW_CYCLE_MS);
}

export function stopQuantScheduler(): void {
  if (fastInterval !== null) { clearInterval(fastInterval); fastInterval = null; }
  if (slowInterval !== null) { clearInterval(slowInterval); slowInterval = null; }
  if (initialRunTimeout !== null) { clearTimeout(initialRunTimeout); initialRunTimeout = null; }
  console.log("[QuantScheduler] Stopped");
}
