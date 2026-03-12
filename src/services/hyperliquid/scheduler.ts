import { analyzeWithAI, clearAICacheForPair } from "./ai-analyzer.js";
import { fetchDailyCandles, computeDailySma } from "./daily-indicators.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { runPsarDecisionEngine } from "./psar-engine.js";
import { runZlemaDecisionEngine } from "./zlema-engine.js";
import { runVortexDecisionEngine } from "./vortex-engine.js";
import { runSchaffDecisionEngine } from "./schaff-engine.js";
import { runDEMADecisionEngine } from "./dema-engine.js";
import { runCCIDecisionEngine } from "./cci-engine.js";
import { runAroonDecisionEngine } from "./aroon-engine.js";
import { runMACDDecisionEngine } from "./macd-engine.js";
import { runZlemaV2DecisionEngine } from "./zlema-v2-engine.js";
import { runSchaffV2DecisionEngine } from "./schaff-v2-engine.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { isQuantKilled } from "./risk-manager.js";
import { QUANT_SCHEDULER_INTERVAL_MS, QUANT_FIXED_POSITION_SIZE_USD } from "../../config/constants.js";
import type { QuantAIDecision, TradeType } from "./types.js";
import type { TechSignal } from "./prompt.js";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;
let cycleRunning = false;


const STOP_LOSS_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const stopLossCooldowns = new Map<string, number>(); // `${pair}:${direction}` -> timestamp

export function recordStopLossCooldown(pair: string, direction: string, tradeType = "directional"): void {
  const key = `${pair}:${direction}:${tradeType}`;
  stopLossCooldowns.set(key, Date.now());
  console.log(`[QuantScheduler] SL cooldown: ${pair} ${direction} (${tradeType}, 2h)`);
}

function isInStopLossCooldown(pair: string, direction: string, tradeType = "directional"): boolean {
  const key = `${pair}:${direction}:${tradeType}`;
  const ts = stopLossCooldowns.get(key);
  if (!ts) return false;
  if (Date.now() - ts > STOP_LOSS_COOLDOWN_MS) {
    stopLossCooldowns.delete(key);
    return false;
  }
  return true;
}

export async function runDirectionalCycle(): Promise<void> {
  if (cycleRunning) {
    console.log("[QuantScheduler] Previous cycle still running, skipping");
    return;
  }
  cycleRunning = true;

  try {
    if (isQuantKilled()) {
      console.log("[QuantScheduler] Kill switch active, skipping cycle");
      return;
    }

    const analyses = await runMarketDataPipeline();

    // Technical engines first (feed signals to AI)
    const psarDecisions = await runPsarDecisionEngine(analyses);
    const zlemaDecisions = await runZlemaDecisionEngine(analyses);
    const vortexDecisions = await runVortexDecisionEngine(analyses);
    const schaffDecisions = await runSchaffDecisionEngine(analyses);
    const demaDecisions = await runDEMADecisionEngine(analyses);
    const cciDecisions = await runCCIDecisionEngine(analyses);
    const aroonDecisions = await runAroonDecisionEngine(analyses);
    const macdDecisions = await runMACDDecisionEngine(analyses);
    const zlemav2Decisions = await runZlemaV2DecisionEngine(analyses);
    const schaffv2Decisions = await runSchaffV2DecisionEngine(analyses);

    // Collect per-pair signals for AI context
    const techSignalsByPair = new Map<string, TechSignal[]>();
    const signalSources: Array<{ engine: string; decisions: typeof demaDecisions }> = [
      { engine: "Schaff 4h", decisions: schaffDecisions },
      { engine: "DEMA 4h", decisions: demaDecisions },
      { engine: "ZLEMA 4h", decisions: zlemaDecisions },
      { engine: "PSAR 4h", decisions: psarDecisions },
      { engine: "Vortex 4h", decisions: vortexDecisions },
      { engine: "CCI 4h", decisions: cciDecisions },
      { engine: "Aroon 4h", decisions: aroonDecisions },
      { engine: "MACD 4h", decisions: macdDecisions },
      { engine: "ZLEMAv2 4h", decisions: zlemav2Decisions },
      { engine: "SchaffV2 4h", decisions: schaffv2Decisions },
    ];
    for (const { engine, decisions } of signalSources) {
      for (const d of decisions) {
        if (!techSignalsByPair.has(d.pair)) techSignalsByPair.set(d.pair, []);
        techSignalsByPair.get(d.pair)!.push({ engine, direction: d.direction });
      }
    }

    // AI engine
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
      const pairSignals = techSignalsByPair.get(analysis.pair);
      const decision = await analyzeWithAI(analysis, dailyTrend, pairSignals);
      if (!decision) continue;
      aiSignals.set(decision.pair, decision.direction);
      if (decision.direction === "flat") continue;
      const sizeUsd = calculateQuantPositionSize(decision.confidence, decision.entryPrice, decision.stopLoss, false, "ai-directional");
      if (sizeUsd <= 0) continue;
      aiDecisions.push({ ...decision, suggestedSizeUsd: sizeUsd });
    }

    const openPositions = getOpenQuantPositions();

    const aiOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "ai-directional" || p.tradeType === "directional" || !p.tradeType).map(p => p.pair),
    );
    // Per-engine open pair tracking (paper only)
    const paperOpenPairsByEngine = new Map<string, Set<string>>();
    for (const tt of ["psar-directional", "zlema-directional", "vortex-directional", "schaff-directional", "dema-directional", "cci-directional", "aroon-directional", "macd-directional", "zlemav2-directional", "schaffv2-directional", "inv-psar-directional", "inv-zlema-directional", "inv-vortex-directional", "inv-schaff-directional", "inv-dema-directional", "inv-cci-directional", "inv-aroon-directional", "inv-macd-directional", "inv-zlemav2-directional", "inv-schaffv2-directional"]) {
      paperOpenPairsByEngine.set(tt, new Set(openPositions.filter(p => p.tradeType === tt && p.mode === "paper").map(p => p.pair)));
    }

    // AI signal flip exits
    const aiPositions = openPositions.filter(p => p.tradeType === "ai-directional" || p.tradeType === "directional" || !p.tradeType);
    for (const pos of aiPositions) {
      const signal = aiSignals.get(pos.pair);
      if (!signal) continue;
      const flipped = signal !== "flat" && signal !== pos.direction;
      if (flipped) {
        console.log(`[QuantScheduler] AI signal flip: ${pos.pair} position=${pos.direction} signal=${signal}, closing`);
        const result = await closePosition(pos.id, `ai-signal-flip (${pos.direction}->${signal})`);
        if (result.success) {
          aiOpenPairs.delete(pos.pair);
          clearAICacheForPair(pos.pair);
        }
      }
    }

    let aiExecuted = 0;
    for (const decision of aiDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      if (aiOpenPairs.has(decision.pair)) continue;
      if (isInStopLossCooldown(decision.pair, decision.direction, "ai-directional")) continue;
      const aiSize = QUANT_FIXED_POSITION_SIZE_USD;
      const position = await openPosition(decision.pair, decision.direction, aiSize, 10, decision.stopLoss, decision.takeProfit, decision.regime, "ai-directional", undefined, decision.entryPrice);
      if (position) {
        aiExecuted++;
        aiOpenPairs.add(decision.pair);
        console.log(`[QuantScheduler] AI: Opened ${decision.pair} ${decision.direction} $${aiSize.toFixed(2)} @ ${decision.entryPrice}`);
      }
    }


    // Paper engines (all 10)
    const paperEngines: Array<{ label: string; tradeType: string; decisions: typeof psarDecisions }> = [
      { label: "Schaff", tradeType: "schaff-directional", decisions: schaffDecisions },
      { label: "ZLEMA", tradeType: "zlema-directional", decisions: zlemaDecisions },
      { label: "DEMA", tradeType: "dema-directional", decisions: demaDecisions },
      { label: "PSAR", tradeType: "psar-directional", decisions: psarDecisions },
      { label: "Vortex", tradeType: "vortex-directional", decisions: vortexDecisions },
      { label: "CCI", tradeType: "cci-directional", decisions: cciDecisions },
      { label: "Aroon", tradeType: "aroon-directional", decisions: aroonDecisions },
      { label: "MACD", tradeType: "macd-directional", decisions: macdDecisions },
      { label: "ZLEMAv2", tradeType: "zlemav2-directional", decisions: zlemav2Decisions },
      { label: "SchaffV2", tradeType: "schaffv2-directional", decisions: schaffv2Decisions },
    ];

    const paperExecuted = new Map<string, number>();
    for (const { label, tradeType, decisions } of paperEngines) {
      let count = 0;
      const openPairs = paperOpenPairsByEngine.get(tradeType)!;
      for (const decision of decisions) {
        if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
        if (openPairs.has(decision.pair)) continue;
        if (isInStopLossCooldown(decision.pair, decision.direction, tradeType)) continue;
        const position = await openPosition(decision.pair, decision.direction, QUANT_FIXED_POSITION_SIZE_USD, 10, decision.stopLoss, decision.takeProfit, decision.regime, tradeType as TradeType, undefined, decision.entryPrice, true);
        if (position) {
          count++;
          openPairs.add(decision.pair);
          console.log(`[QuantScheduler] ${label}(paper): Opened ${decision.pair} ${decision.direction} $${QUANT_FIXED_POSITION_SIZE_USD.toFixed(2)} @ ${decision.entryPrice}`);
        }
      }
      paperExecuted.set(tradeType, count);
    }

    // Re-fetch includes positions opened this cycle
    const currentPositions = getOpenQuantPositions();
    const invertedPairs: Array<{ label: string; normalType: string; invType: string }> = [
      { label: "iSchaff", normalType: "schaff-directional", invType: "inv-schaff-directional" },
      { label: "iZLEMA", normalType: "zlema-directional", invType: "inv-zlema-directional" },
      { label: "iDEMA", normalType: "dema-directional", invType: "inv-dema-directional" },
      { label: "iPSAR", normalType: "psar-directional", invType: "inv-psar-directional" },
      { label: "iVortex", normalType: "vortex-directional", invType: "inv-vortex-directional" },
      { label: "iCCI", normalType: "cci-directional", invType: "inv-cci-directional" },
      { label: "iAroon", normalType: "aroon-directional", invType: "inv-aroon-directional" },
      { label: "iMACD", normalType: "macd-directional", invType: "inv-macd-directional" },
      { label: "iZLEMAv2", normalType: "zlemav2-directional", invType: "inv-zlemav2-directional" },
      { label: "iSchaffV2", normalType: "schaffv2-directional", invType: "inv-schaffv2-directional" },
    ];

    for (const { label, normalType, invType } of invertedPairs) {
      let count = 0;
      const normalPositions = currentPositions.filter(p => p.tradeType === normalType && p.mode === "paper");
      const invOpenPairs = paperOpenPairsByEngine.get(invType)!;
      for (const pos of normalPositions) {
        if (invOpenPairs.has(pos.pair)) continue;
        if (!pos.takeProfit || pos.takeProfit <= 0 || !pos.stopLoss || pos.stopLoss <= 0) {
          console.log(`[QuantScheduler] ${label}: Skip mirror ${pos.pair} — missing SL/TP on normal position`);
          continue;
        }
        const invDir = pos.direction === "long" ? "short" as const : "long" as const;
        const invSl = pos.takeProfit;
        const invTp = pos.stopLoss;
        const position = await openPosition(pos.pair, invDir, QUANT_FIXED_POSITION_SIZE_USD, 10, invSl, invTp, "trending", invType as TradeType, undefined, pos.entryPrice, true);
        if (position) {
          count++;
          invOpenPairs.add(pos.pair);
          console.log(`[QuantScheduler] ${label}(paper): Mirror-opened ${pos.pair} ${invDir} $${QUANT_FIXED_POSITION_SIZE_USD.toFixed(2)} @ ${pos.entryPrice}`);
        }
      }
      paperExecuted.set(invType, count);
    }

    const eP = (tt: string, d: { length: number }) => `${paperExecuted.get(tt) ?? 0}/${d.length}`;
    const normalLog = `AI ${aiExecuted}/${aiDecisions.length}, ZLEMAv2 ${eP("zlemav2-directional", zlemav2Decisions)}P, Vortex ${eP("vortex-directional", vortexDecisions)}P, Schaff ${eP("schaff-directional", schaffDecisions)}P, DEMA ${eP("dema-directional", demaDecisions)}P, ZLEMA ${eP("zlema-directional", zlemaDecisions)}P, PSAR ${eP("psar-directional", psarDecisions)}P, CCI ${eP("cci-directional", cciDecisions)}P, Aroon ${eP("aroon-directional", aroonDecisions)}P, MACD ${eP("macd-directional", macdDecisions)}P, SchaffV2 ${eP("schaffv2-directional", schaffv2Decisions)}P`;
    const invLog = `iZLEMAv2 ${eP("inv-zlemav2-directional", zlemav2Decisions)}P, iVortex ${eP("inv-vortex-directional", vortexDecisions)}P, iSchaff ${eP("inv-schaff-directional", schaffDecisions)}P, iDEMA ${eP("inv-dema-directional", demaDecisions)}P, iZLEMA ${eP("inv-zlema-directional", zlemaDecisions)}P, iPSAR ${eP("inv-psar-directional", psarDecisions)}P, iCCI ${eP("inv-cci-directional", cciDecisions)}P, iAroon ${eP("inv-aroon-directional", aroonDecisions)}P, iMACD ${eP("inv-macd-directional", macdDecisions)}P, iSchaffV2 ${eP("inv-schaffv2-directional", schaffv2Decisions)}P`;
    console.log(`[QuantScheduler] Cycle complete: ${normalLog}`);
    console.log(`[QuantScheduler] Inverted: ${invLog}`);
  } finally {
    cycleRunning = false;
  }
}

export function startQuantScheduler(): void {
  if (schedulerInterval !== null || initialRunTimeout !== null) {
    return;
  }

  console.log("[QuantScheduler] Started (15m interval, 10x leverage)");

  initialRunTimeout = setTimeout(() => {
    void runDirectionalCycle();
  }, 15_000);

  schedulerInterval = setInterval(() => {
    void runDirectionalCycle();
  }, QUANT_SCHEDULER_INTERVAL_MS);
}

export function stopQuantScheduler(): void {
  if (schedulerInterval !== null) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }

  if (initialRunTimeout !== null) {
    clearTimeout(initialRunTimeout);
    initialRunTimeout = null;
  }

  console.log("[QuantScheduler] Stopped");
}
