import { analyzeWithAI, clearAICacheForPair } from "./ai-analyzer.js";
import { fetchDailyCandles, computeDailySma } from "./daily-indicators.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { runPsarDecisionEngine } from "./psar-engine.js";
import { runZlemaDecisionEngine } from "./zlema-engine.js";
import { runVortexDecisionEngine } from "./vortex-engine.js";
import { runSchaffDecisionEngine } from "./schaff-engine.js";
import { runDEMADecisionEngine } from "./dema-engine.js";
import { runHMADecisionEngine } from "./hma-engine.js";
import { runCCIDecisionEngine } from "./cci-engine.js";
import { runHMA1hDecisionEngine } from "./hma1h-engine.js";
import { runZlema1hDecisionEngine } from "./zlema1h-engine.js";
import { runAroonDecisionEngine } from "./aroon-engine.js";
import { runMACDDecisionEngine } from "./macd-engine.js";
import { runZlemaV2DecisionEngine } from "./zlema-v2-engine.js";
import { runSchaffV2DecisionEngine } from "./schaff-v2-engine.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { isQuantKilled } from "./risk-manager.js";
import { QUANT_SCHEDULER_INTERVAL_MS, QUANT_MAX_PER_PAIR, QUANT_MAX_PER_DIRECTION, QUANT_COMPOUND_SIZE_PCT, QUANT_COMPOUND_MIN_SIZE, getEngineExchange } from "../../config/constants.js";
import { getLighterAccountInfo } from "../lighter/client.js";
import { ensureConnected, getClient } from "./client.js";
import { loadEnv } from "../../config/env.js";
import type { QuantAIDecision, TradeType } from "./types.js";
import type { TechSignal } from "./prompt.js";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;
let cycleRunning = false;

// Last signal direction per engine:pair (e.g. "zlema-directional:BTC" -> "long")
const lastSignals = new Map<string, string>();

export function getLastSignal(tradeType: string, pair: string): string | undefined {
  return lastSignals.get(`${tradeType}:${pair}`);
}

const STOP_LOSS_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const stopLossCooldowns = new Map<string, number>(); // `${pair}:${direction}` -> timestamp

export function recordStopLossCooldown(pair: string, direction: string): void {
  const key = `${pair}:${direction}`;
  stopLossCooldowns.set(key, Date.now());
  console.log(`[QuantScheduler] Stop-loss cooldown set for ${pair} ${direction} (2h)`);
}

function isInStopLossCooldown(pair: string, direction: string): boolean {
  const key = `${pair}:${direction}`;
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

    // Technical engines run FIRST so we can feed signals to AI
    const psarDecisions = await runPsarDecisionEngine(analyses);
    const zlemaDecisions = await runZlemaDecisionEngine(analyses);
    const vortexDecisions = await runVortexDecisionEngine(analyses);
    const schaffDecisions = await runSchaffDecisionEngine(analyses);
    const demaDecisions = await runDEMADecisionEngine(analyses);
    const hmaDecisions = await runHMADecisionEngine(analyses);
    const cciDecisions = await runCCIDecisionEngine(analyses);
    const hma1hDecisions = await runHMA1hDecisionEngine(analyses);
    const zlema1hDecisions = await runZlema1hDecisionEngine(analyses);
    const aroonDecisions = await runAroonDecisionEngine(analyses);
    const macdDecisions = await runMACDDecisionEngine(analyses);
    const zlemav2Decisions = await runZlemaV2DecisionEngine(analyses);
    const schaffv2Decisions = await runSchaffV2DecisionEngine(analyses);

    // Record latest signals for smart trailing
    const allDecisions: Array<{ tradeType: string; decisions: typeof psarDecisions }> = [
      { tradeType: "psar-directional", decisions: psarDecisions },
      { tradeType: "zlema-directional", decisions: zlemaDecisions },
      { tradeType: "vortex-directional", decisions: vortexDecisions },
      { tradeType: "schaff-directional", decisions: schaffDecisions },
      { tradeType: "dema-directional", decisions: demaDecisions },
      { tradeType: "hma-directional", decisions: hmaDecisions },
      { tradeType: "cci-directional", decisions: cciDecisions },
      { tradeType: "hma1h-directional", decisions: hma1hDecisions },
      { tradeType: "zlema1h-directional", decisions: zlema1hDecisions },
      { tradeType: "aroon-directional", decisions: aroonDecisions },
      { tradeType: "macd-directional", decisions: macdDecisions },
      { tradeType: "zlemav2-directional", decisions: zlemav2Decisions },
      { tradeType: "schaffv2-directional", decisions: schaffv2Decisions },
    ];
    for (const { tradeType, decisions } of allDecisions) {
      for (const d of decisions) {
        const key = `${tradeType}:${d.pair}`;
        if (d.direction === "flat") {
          lastSignals.delete(key);
        } else {
          lastSignals.set(key, d.direction);
        }
      }
    }

    // Collect per-pair signals from live engines (HMA, Schaff, DEMA) for AI context
    const techSignalsByPair = new Map<string, TechSignal[]>();
    const signalSources: Array<{ engine: string; decisions: typeof hmaDecisions }> = [
      { engine: "HMA 4h", decisions: hmaDecisions },
      { engine: "Schaff 4h", decisions: schaffDecisions },
      { engine: "DEMA 1h", decisions: demaDecisions },
    ];
    for (const { engine, decisions } of signalSources) {
      for (const d of decisions) {
        if (!techSignalsByPair.has(d.pair)) techSignalsByPair.set(d.pair, []);
        techSignalsByPair.get(d.pair)!.push({ engine, direction: d.direction });
      }
    }

    // AI engine (DeepSeek, runs on Hyperliquid) - receives technical signals as context
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

    // Record AI signals for smart trailing
    for (const d of aiDecisions) {
      const key = `ai-directional:${d.pair}`;
      if (d.direction === "flat") {
        lastSignals.delete(key);
      } else {
        lastSignals.set(key, d.direction);
      }
    }

    const openPositions = getOpenQuantPositions();

    const aiOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "ai-directional" || p.tradeType === "directional" || !p.tradeType).map(p => p.pair),
    );
    // Separate live/paper pair tracking
    const liveOpenPairsByEngine = new Map<string, Set<string>>();
    const paperOpenPairsByEngine = new Map<string, Set<string>>();
    for (const tt of ["psar-directional", "zlema-directional", "vortex-directional", "schaff-directional", "dema-directional", "hma-directional", "cci-directional", "hma1h-directional", "zlema1h-directional", "aroon-directional", "macd-directional", "zlemav2-directional", "schaffv2-directional"]) {
      liveOpenPairsByEngine.set(tt, new Set(openPositions.filter(p => p.tradeType === tt && p.mode === "live").map(p => p.pair)));
      paperOpenPairsByEngine.set(tt, new Set(openPositions.filter(p => p.tradeType === tt && p.mode === "paper").map(p => p.pair)));
    }

    // Close AI positions if signal flips
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

    // Compound sizing: per-exchange (2.5% of each exchange's equity)
    let lighterCompoundSize = QUANT_COMPOUND_MIN_SIZE;
    try {
      const acct = await getLighterAccountInfo();
      const raw = Math.floor(acct.equity * QUANT_COMPOUND_SIZE_PCT * 100) / 100;
      lighterCompoundSize = Math.max(QUANT_COMPOUND_MIN_SIZE, raw);
      console.log(`[QuantScheduler] Lighter compound: $${lighterCompoundSize.toFixed(2)} (${(QUANT_COMPOUND_SIZE_PCT * 100).toFixed(1)}% of $${acct.equity.toFixed(2)} equity)`);
    } catch (err) {
      console.error(`[QuantScheduler] Failed to fetch Lighter equity for compound sizing, using $${lighterCompoundSize}`);
    }

    let hlCompoundSize = QUANT_COMPOUND_MIN_SIZE;
    try {
      await ensureConnected();
      const sdk = getClient();
      const env = loadEnv();
      const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
      if (wallet) {
        const state = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
        let equity = parseFloat(state.marginSummary.accountValue) || 0;
        const marginUsed = parseFloat(state.marginSummary.totalMarginUsed) || 0;
        if (equity <= marginUsed) {
          try {
            const spotState = await sdk.info.spot.getSpotClearinghouseState(wallet, true);
            const usdcBal = spotState.balances?.find((b: any) => b.coin === "USDC");
            if (usdcBal) equity = parseFloat(usdcBal.total) || 0;
          } catch { /* spot check optional */ }
        }
        const raw = Math.floor(equity * QUANT_COMPOUND_SIZE_PCT * 100) / 100;
        hlCompoundSize = Math.max(QUANT_COMPOUND_MIN_SIZE, raw);
        console.log(`[QuantScheduler] HL compound: $${hlCompoundSize.toFixed(2)} (${(QUANT_COMPOUND_SIZE_PCT * 100).toFixed(1)}% of $${equity.toFixed(2)} equity)`);
      }
    } catch (err) {
      console.error(`[QuantScheduler] Failed to fetch HL equity for compound sizing, using $${hlCompoundSize}`);
    }

    let aiExecuted = 0;
    for (const decision of aiDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      if (aiOpenPairs.has(decision.pair)) continue;
      if (isInStopLossCooldown(decision.pair, decision.direction)) continue;
      const aiSize = hlCompoundSize;
      const position = await openPosition(decision.pair, decision.direction, aiSize, 10, decision.stopLoss, decision.takeProfit, decision.regime, "ai-directional", undefined, decision.entryPrice);
      if (position) {
        aiExecuted++;
        aiOpenPairs.add(decision.pair);
        console.log(`[QuantScheduler] AI: Opened ${decision.pair} ${decision.direction} $${aiSize.toFixed(2)} @ ${decision.entryPrice}`);
      }
    }

    // Live engines ordered by backtest profitability (best first)
    const liveEngines: Array<{ label: string; tradeType: string; decisions: typeof demaDecisions }> = [
      { label: "HMA", tradeType: "hma-directional", decisions: hmaDecisions },
      { label: "Schaff", tradeType: "schaff-directional", decisions: schaffDecisions },
      { label: "DEMA", tradeType: "dema-directional", decisions: demaDecisions },
    ];

    // Track live positions for cross-engine limits (per-exchange)
    const livePositions = openPositions.filter(p => p.mode === "live");
    const liveByPairByExchange = new Map<string, Map<string, number>>();
    const liveByDirByExchange = new Map<string, Map<string, number>>();
    for (const p of livePositions) {
      const ex = p.exchange ?? getEngineExchange(p.tradeType ?? "");
      if (!liveByPairByExchange.has(ex)) liveByPairByExchange.set(ex, new Map());
      if (!liveByDirByExchange.has(ex)) liveByDirByExchange.set(ex, new Map());
      const pairMap = liveByPairByExchange.get(ex)!;
      const dirMap = liveByDirByExchange.get(ex)!;
      pairMap.set(p.pair, (pairMap.get(p.pair) ?? 0) + 1);
      dirMap.set(p.direction, (dirMap.get(p.direction) ?? 0) + 1);
    }

    const executed = new Map<string, number>();
    for (const { label, tradeType, decisions } of liveEngines) {
      let count = 0;
      const openPairs = liveOpenPairsByEngine.get(tradeType)!;
      const ex = getEngineExchange(tradeType);
      const liveByPair = liveByPairByExchange.get(ex) ?? new Map<string, number>();
      const liveByDir = liveByDirByExchange.get(ex) ?? new Map<string, number>();
      for (const decision of decisions) {
        if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
        if (openPairs.has(decision.pair)) continue;
        if (isInStopLossCooldown(decision.pair, decision.direction)) continue;
        if ((liveByPair.get(decision.pair) ?? 0) >= QUANT_MAX_PER_PAIR) continue;
        if ((liveByDir.get(decision.direction) ?? 0) >= QUANT_MAX_PER_DIRECTION) continue;
        const liveSize = lighterCompoundSize;
        const position = await openPosition(decision.pair, decision.direction, liveSize, 10, decision.stopLoss, decision.takeProfit, decision.regime, tradeType as TradeType, undefined, decision.entryPrice);
        if (position) {
          count++;
          openPairs.add(decision.pair);
          liveByPair.set(decision.pair, (liveByPair.get(decision.pair) ?? 0) + 1);
          liveByDir.set(decision.direction, (liveByDir.get(decision.direction) ?? 0) + 1);
          console.log(`[QuantScheduler] ${label}: Opened ${decision.pair} ${decision.direction} $${liveSize.toFixed(2)} @ ${decision.entryPrice}`);
        }
      }
      executed.set(tradeType, count);
    }

    // Paper engines: all 9 run independently for performance tracking
    const paperEngines: Array<{ label: string; tradeType: string; decisions: typeof psarDecisions }> = [
      { label: "Schaff", tradeType: "schaff-directional", decisions: schaffDecisions },
      { label: "ZLEMA", tradeType: "zlema-directional", decisions: zlemaDecisions },
      { label: "DEMA", tradeType: "dema-directional", decisions: demaDecisions },
      { label: "HMA", tradeType: "hma-directional", decisions: hmaDecisions },
      { label: "PSAR", tradeType: "psar-directional", decisions: psarDecisions },
      { label: "Vortex", tradeType: "vortex-directional", decisions: vortexDecisions },
      { label: "CCI", tradeType: "cci-directional", decisions: cciDecisions },
      { label: "HMA1h", tradeType: "hma1h-directional", decisions: hma1hDecisions },
      { label: "ZLEMA1h", tradeType: "zlema1h-directional", decisions: zlema1hDecisions },
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
        if (isInStopLossCooldown(decision.pair, decision.direction)) continue;
        const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, tradeType as TradeType, undefined, decision.entryPrice, true);
        if (position) {
          count++;
          openPairs.add(decision.pair);
          console.log(`[QuantScheduler] ${label}(paper): Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
        }
      }
      paperExecuted.set(tradeType, count);
    }

    const eL = (tt: string, d: { length: number }) => `${executed.get(tt) ?? 0}/${d.length}`;
    const eP = (tt: string, d: { length: number }) => `${paperExecuted.get(tt) ?? 0}/${d.length}`;
    console.log(
      `[QuantScheduler] Cycle complete: AI ${aiExecuted}/${aiDecisions.length}, HMA ${eL("hma-directional", hmaDecisions)}L+${eP("hma-directional", hmaDecisions)}P, Schaff ${eL("schaff-directional", schaffDecisions)}L+${eP("schaff-directional", schaffDecisions)}P, DEMA ${eL("dema-directional", demaDecisions)}L+${eP("dema-directional", demaDecisions)}P, ZLEMA ${eP("zlema-directional", zlemaDecisions)}P, HMA1h ${eP("hma1h-directional", hma1hDecisions)}P, ZLEMA1h ${eP("zlema1h-directional", zlema1hDecisions)}P, PSAR ${eP("psar-directional", psarDecisions)}P, Vortex ${eP("vortex-directional", vortexDecisions)}P, CCI ${eP("cci-directional", cciDecisions)}P, Aroon ${eP("aroon-directional", aroonDecisions)}P, MACD ${eP("macd-directional", macdDecisions)}P, ZLEMAv2 ${eP("zlemav2-directional", zlemav2Decisions)}P, SchaffV2 ${eP("schaffv2-directional", schaffv2Decisions)}P`,
    );
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
