import {
  HFT_FADE_INTERVAL_MS,
  HFT_FADE_MIN_RETURN_PCT,
  HFT_FADE_POSITION_SIZE_USD,
  HFT_FADE_LEVERAGE,
  HFT_FADE_TP_PCT,
  HFT_FADE_SL_PCT,
  HFT_FADE_MIN_VOLUME_24H,
  HFT_FADE_LIVE_ENABLED,
  HFT_FADE_MAX_CONCURRENT,
  HFT_FADE_DAILY_LOSS_LIMIT,
  HFT_T8_TP40_SL3_THRESHOLD_PCT,
  HFT_T8_TP40_SL3_TP_PCT,
  HFT_T8_TP40_SL3_SL_PCT,
  HFT_T10_TP35_SL4_THRESHOLD_PCT,
  HFT_T10_TP35_SL4_TP_PCT,
  HFT_T10_TP35_SL4_SL_PCT,
  HFT_T8_TP35_SL4_THRESHOLD_PCT,
  HFT_T8_TP35_SL4_TP_PCT,
  HFT_T8_TP35_SL4_SL_PCT,
  HFT_T8_TP25_SL5_THRESHOLD_PCT,
  HFT_T8_TP25_SL5_TP_PCT,
  HFT_T8_TP25_SL5_SL_PCT,
  HFT_T8_TP30_SL5_THRESHOLD_PCT,
  HFT_T8_TP30_SL5_TP_PCT,
  HFT_T8_TP30_SL5_SL_PCT,
  HFT_T12_TP40_SL3_THRESHOLD_PCT,
  HFT_T12_TP40_SL3_TP_PCT,
  HFT_T12_TP40_SL3_SL_PCT,
  HFT_T10_TP40_SL3_THRESHOLD_PCT,
  HFT_T10_TP40_SL3_TP_PCT,
  HFT_T10_TP40_SL3_SL_PCT,
  HFT_T8_TP30_SL3_THRESHOLD_PCT,
  HFT_T8_TP30_SL3_TP_PCT,
  HFT_T8_TP30_SL3_SL_PCT,
  HFT_T8_TP35_SL3_THRESHOLD_PCT,
  HFT_T8_TP35_SL3_TP_PCT,
  HFT_T8_TP35_SL3_SL_PCT,
  HFT_T8_TP25_SL3_THRESHOLD_PCT,
  HFT_T8_TP25_SL3_TP_PCT,
  HFT_T8_TP25_SL3_SL_PCT,
  QUANT_TRADING_PAIRS,
  HFT_PAPER_SPREAD_PCT,
} from "../../config/constants.js";
import type { TradeType } from "./types.js";
import { callDeepSeek } from "../shared/llm.js";
import { validateRiskGates, isQuantKilled } from "./risk-manager.js";
import { paperOpenPosition, paperClosePosition, getPaperPositions } from "./paper.js";
import { lighterOpenPosition } from "../lighter/executor.js";
import { isLighterInitialized } from "../lighter/client.js";
import { loadOpenQuantPositions } from "../database/quant.js";

export interface HftVariantConfig {
  tradeType: TradeType;
  label: string;
  thresholdPct: number;
  tpPct: number;
  slPct: number;
  regimeAdaptive?: boolean;
  aiFilter?: boolean;
  llmFilter?: boolean;
}

interface OhlcCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface OhlcCache {
  candles: OhlcCandle[];
  expiresAt: number;
}

const HFT_VARIANTS: HftVariantConfig[] = [
  { tradeType: "hft-fade", label: "HFT-Fade", thresholdPct: HFT_FADE_MIN_RETURN_PCT, tpPct: HFT_FADE_TP_PCT, slPct: HFT_FADE_SL_PCT },
  { tradeType: "hft-t8-tp40-sl3", label: "HFT-t8-tp40-sl3", thresholdPct: HFT_T8_TP40_SL3_THRESHOLD_PCT, tpPct: HFT_T8_TP40_SL3_TP_PCT, slPct: HFT_T8_TP40_SL3_SL_PCT },
  { tradeType: "hft-t10-tp35-sl4", label: "HFT-t10-tp35-sl4", thresholdPct: HFT_T10_TP35_SL4_THRESHOLD_PCT, tpPct: HFT_T10_TP35_SL4_TP_PCT, slPct: HFT_T10_TP35_SL4_SL_PCT },
  { tradeType: "hft-t8-tp35-sl4", label: "HFT-t8-tp35-sl4", thresholdPct: HFT_T8_TP35_SL4_THRESHOLD_PCT, tpPct: HFT_T8_TP35_SL4_TP_PCT, slPct: HFT_T8_TP35_SL4_SL_PCT },
  { tradeType: "hft-t8-tp25-sl5", label: "HFT-t8-tp25-sl5", thresholdPct: HFT_T8_TP25_SL5_THRESHOLD_PCT, tpPct: HFT_T8_TP25_SL5_TP_PCT, slPct: HFT_T8_TP25_SL5_SL_PCT },
  { tradeType: "hft-t8-tp30-sl5", label: "HFT-t8-tp30-sl5", thresholdPct: HFT_T8_TP30_SL5_THRESHOLD_PCT, tpPct: HFT_T8_TP30_SL5_TP_PCT, slPct: HFT_T8_TP30_SL5_SL_PCT },
  { tradeType: "hft-t12-tp40-sl3", label: "HFT-t12-tp40-sl3", thresholdPct: HFT_T12_TP40_SL3_THRESHOLD_PCT, tpPct: HFT_T12_TP40_SL3_TP_PCT, slPct: HFT_T12_TP40_SL3_SL_PCT },
  { tradeType: "hft-t10-tp40-sl3", label: "HFT-t10-tp40-sl3", thresholdPct: HFT_T10_TP40_SL3_THRESHOLD_PCT, tpPct: HFT_T10_TP40_SL3_TP_PCT, slPct: HFT_T10_TP40_SL3_SL_PCT },
  { tradeType: "hft-t8-tp30-sl3", label: "HFT-t8-tp30-sl3", thresholdPct: HFT_T8_TP30_SL3_THRESHOLD_PCT, tpPct: HFT_T8_TP30_SL3_TP_PCT, slPct: HFT_T8_TP30_SL3_SL_PCT },
  { tradeType: "hft-t8-tp35-sl3", label: "HFT-t8-tp35-sl3", thresholdPct: HFT_T8_TP35_SL3_THRESHOLD_PCT, tpPct: HFT_T8_TP35_SL3_TP_PCT, slPct: HFT_T8_TP35_SL3_SL_PCT },
  { tradeType: "hft-t8-tp25-sl3", label: "HFT-t8-tp25-sl3", thresholdPct: HFT_T8_TP25_SL3_THRESHOLD_PCT, tpPct: HFT_T8_TP25_SL3_TP_PCT, slPct: HFT_T8_TP25_SL3_SL_PCT },
  { tradeType: "hft-regime", label: "HFT-Regime", thresholdPct: 0.08, tpPct: 0.40, slPct: 0.03, regimeAdaptive: true },
  { tradeType: "hft-smart", label: "HFT-Smart", thresholdPct: 0.08, tpPct: 0.40, slPct: 0.03, regimeAdaptive: true, aiFilter: true },
  { tradeType: "hft-ai", label: "HFT-AI", thresholdPct: 0.08, tpPct: 0.40, slPct: 0.03, regimeAdaptive: true, aiFilter: true, llmFilter: true },
];

const BINANCE_SYMBOL_MAP: Record<string, string> = {
  OP: "OPUSDT",
  WIF: "WIFUSDT",
  ARB: "ARBUSDT",
  LDO: "LDOUSDT",
  AVAX: "AVAXUSDT",
  TRUMP: "TRUMPUSDT",
  DASH: "DASHUSDT",
  DOT: "DOTUSDT",
  ENA: "ENAUSDT",
  DOGE: "DOGEUSDT",
  APT: "APTUSDT",
  SEI: "SEIUSDT",
  LINK: "LINKUSDT",
  ADA: "ADAUSDT",
  WLD: "WLDUSDT",
  XRP: "XRPUSDT",
  SUI: "SUIUSDT",
  TON: "TONUSDT",
  UNI: "UNIUSDT",
};

interface VolumeCache {
  value: number;
  expiresAt: number;
}

const volumeCache = new Map<string, VolumeCache>();
const VOLUME_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

const ohlcCache = new Map<string, OhlcCache>();
const OHLC_CACHE_TTL_MS = 5 * 60 * 1000; // 5min

interface LlmRegime {
  regime: "trending" | "ranging" | "volatile";
  bias: "long" | "short" | "neutral";
  skipFades: boolean;
}

interface LlmRegimeEntry {
  data: LlmRegime;
  expiresAt: number;
}

const llmRegimeCache = new Map<string, LlmRegimeEntry>();
const LLM_REGIME_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

async function fetchLlmRegime(pair: string, candles: OhlcCandle[]): Promise<LlmRegime | null> {
  try {
    const cached = llmRegimeCache.get(pair);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    const closes = candles.map(c => c.close);
    const last14 = candles.slice(-14);

    // RSI7
    const rsi7 = computeRsiN(closes, 7) ?? 50;

    // BB position
    let bbPos = "inside";
    if (closes.length >= 20) {
      const win = closes.slice(-20);
      const mean = win.reduce((a, b) => a + b, 0) / 20;
      const std = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
      const last = closes[closes.length - 1];
      if (last > mean + 2 * std) bbPos = "above";
      else if (last < mean - 2 * std) bbPos = "below";
    }

    // EMA21 slope
    let emaSlope = "flat";
    if (closes.length >= 21) {
      const ema = computeEma(closes, 21);
      if (ema.length >= 3) {
        const slopePct = (ema[ema.length - 1] - ema[ema.length - 3]) / ema[ema.length - 3] * 100;
        if (slopePct > 0.1) emaSlope = "up";
        else if (slopePct < -0.1) emaSlope = "down";
      }
    }

    // ATR%
    const atrPct = last14.reduce((acc, c) => acc + (c.high - c.low) / c.close * 100, 0) / last14.length;

    // Last 5 closes
    const last5 = closes.slice(-5).map(c => c.toFixed(2)).join(",");

    const prompt = `${pair} 5m mean-reversion fade: RSI7=${rsi7.toFixed(0)}, BB=${bbPos}, EMA21=${emaSlope}, ATR=${atrPct.toFixed(2)}%, closes=[${last5}]. skipFades:true ONLY if strong momentum trending where fade will fail (e.g. RSI climbing fast on news/breakout). skipFades:false if ranging, oscillating, or at typical reversion point.\n{"regime":"trending"|"ranging"|"volatile","bias":"long"|"short"|"neutral","skipFades":boolean}`;

    const raw = await callDeepSeek(prompt, "deepseek-chat", "Return JSON only.", 0.1, "hft-llm");
    console.log(`[HFT-AI] LLM raw for ${pair}: ${raw.slice(0, 200)}`);

    // Parse JSON from response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn(`[HFT-AI] LLM no JSON for ${pair}`);
      return null;
    }
    const parsed = JSON.parse(match[0]) as Partial<LlmRegime>;
    const validRegimes = ["trending", "ranging", "volatile"];
    const validBias = ["long", "short", "neutral"];
    if (!validRegimes.includes(parsed.regime ?? "") || !validBias.includes(parsed.bias ?? "") || typeof parsed.skipFades !== "boolean") {
      console.warn(`[HFT-AI] LLM invalid fields for ${pair}`);
      return null;
    }
    const result: LlmRegime = { regime: parsed.regime!, bias: parsed.bias!, skipFades: parsed.skipFades };
    llmRegimeCache.set(pair, { data: result, expiresAt: Date.now() + LLM_REGIME_CACHE_TTL_MS });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[HFT-AI] LLM call failed for ${pair}: ${msg}`);
    return null;
  }
}

async function fetchBinance24hVolume(symbol: string): Promise<number | null> {
  const cached = volumeCache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      console.error(`[HFT-Fade] Binance 24hr ticker error for ${symbol}: HTTP ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as { quoteVolume?: string };
    const volume = parseFloat(data.quoteVolume ?? "0");
    if (isNaN(volume)) return null;
    volumeCache.set(symbol, { value: volume, expiresAt: Date.now() + VOLUME_CACHE_TTL_MS });
    return volume;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[HFT-Fade] Binance 24hr ticker fetch failed for ${symbol}: ${msg}`);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchBinanceOhlcCandles(symbol: string): Promise<OhlcCandle[] | null> {
  const cached = ohlcCache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.candles;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=35`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      console.error(`[HFT-Regime] Binance klines error for ${symbol}: HTTP ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as unknown[][];
    if (!Array.isArray(data) || data.length < 1) return null;
    // skip current open candle
    const closed = data.slice(0, 34);
    const candles: OhlcCandle[] = [];
    for (const kline of closed) {
      if (!Array.isArray(kline) || kline.length < 5) continue;
      const open = parseFloat(kline[1] as string);
      const high = parseFloat(kline[2] as string);
      const low = parseFloat(kline[3] as string);
      const close = parseFloat(kline[4] as string);
      const volume = parseFloat(kline[5] as string);
      if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;
      candles.push({ open, high, low, close, volume: isNaN(volume) ? 0 : volume });
    }
    if (!candles.length) return null;
    ohlcCache.set(symbol, { candles, expiresAt: Date.now() + OHLC_CACHE_TTL_MS });
    return candles;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[HFT-Regime] Binance klines fetch failed for ${symbol}: ${msg}`);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function computeRegimeParams(candles: OhlcCandle[]): { thresholdPct: number; tpPct: number; slPct: number } {
  const last14 = candles.slice(-14);
  const atrPct = last14.reduce((acc, c) => acc + (c.high - c.low) / c.close * 100, 0) / last14.length;

  if (atrPct > 0.60) {
    return { thresholdPct: 0.06, tpPct: 0.35, slPct: 0.03 }; // high-vol: wider TP
  }
  return { thresholdPct: 0.06, tpPct: 0.20, slPct: 0.03 }; // ranging: tight TP
}

function computeRsiN(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeEma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result: number[] = [ema];
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// Multi-signal AI score (0-4). Enter only at ≥ 3.
// Signal 1: RSI(7) extreme — fast momentum exhaustion (>75 short, <25 long)
// Signal 2: Bollinger Band breach — price outside 20-period 2σ band
// Signal 3: Volume surge — current candle volume > 1.5x 20-period mean
// Signal 4: EMA(21) flat — not in a strong trend (slope < 0.15% over 2 candles)
function computeAiScore(candles: OhlcCandle[], direction: "long" | "short"): { score: number; label: string } {
  const closes = candles.map(c => c.close);
  const current = candles[candles.length - 1];
  let score = 0;
  const parts: string[] = [];

  // RSI(7)
  const rsi7 = computeRsiN(closes, 7);
  if (rsi7 !== null) {
    if ((direction === "short" && rsi7 > 75) || (direction === "long" && rsi7 < 25)) {
      score++;
      parts.push(`RSI7=${rsi7.toFixed(0)}`);
    }
  }

  // Bollinger Bands (20-period, 2σ)
  if (closes.length >= 20) {
    const window = closes.slice(-20);
    const mean = window.reduce((a, b) => a + b, 0) / 20;
    const std = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
    if ((direction === "short" && current.close > mean + 2 * std) ||
        (direction === "long" && current.close < mean - 2 * std)) {
      score++;
      parts.push("BB");
    }
  }

  // Volume surge (1.5x 20-period mean)
  if (candles.length >= 21 && current.volume > 0) {
    const avgVol = candles.slice(-21, -1).reduce((a, c) => a + c.volume, 0) / 20;
    if (avgVol > 0 && current.volume > avgVol * 1.5) {
      score++;
      parts.push(`Vol=${(current.volume / avgVol).toFixed(1)}x`);
    }
  }

  // EMA(21) flat — not trending
  if (closes.length >= 21) {
    const ema = computeEma(closes, 21);
    if (ema.length >= 3) {
      const slopePct = Math.abs(ema[ema.length - 1] - ema[ema.length - 3]) / ema[ema.length - 3] * 100;
      if (slopePct < 0.15) {
        score++;
        parts.push("flat");
      }
    }
  }

  return { score, label: parts.join(",") };
}

interface Candle5m {
  open: number;
  close: number;
}

async function fetchBinance5mCandle(symbol: string): Promise<Candle5m | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=2`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      console.error(`[HFT-Fade] Binance klines error for ${symbol}: HTTP ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as unknown[][];
    // index 0 = just-closed candle
    if (!Array.isArray(data) || data.length < 1) return null;
    const candle = data[0];
    if (!Array.isArray(candle) || candle.length < 5) return null;
    const open = parseFloat(candle[1] as string);
    const close = parseFloat(candle[4] as string);
    if (isNaN(open) || isNaN(close)) return null;
    return { open, close };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[HFT-Fade] Binance klines fetch failed for ${symbol}: ${msg}`);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

const cycleRunning = new Map<string, boolean>();

async function runHftFadeCycle(config: HftVariantConfig): Promise<void> {
  if (isQuantKilled()) return;
  if (cycleRunning.get(config.tradeType)) {
    console.log(`[${config.label}] Cycle already running, skipping`);
    return;
  }
  cycleRunning.set(config.tradeType, true);

  const goLive = HFT_FADE_LIVE_ENABLED && config.tradeType === "hft-fade" && isLighterInitialized();
  const mode = goLive ? "live" : "paper";

  let signals = 0;
  let opened = 0;

  try {
    for (const pair of QUANT_TRADING_PAIRS) {
      if (isQuantKilled()) break;

      const symbol = BINANCE_SYMBOL_MAP[pair];
      if (!symbol) continue;

      const volume24h = await fetchBinance24hVolume(symbol);
      if (volume24h === null || volume24h < HFT_FADE_MIN_VOLUME_24H) {
        if (volume24h !== null) {
          console.log(`[${config.label}] ${pair} skipped: 24h volume $${volume24h.toFixed(0)} < $${HFT_FADE_MIN_VOLUME_24H}`);
        }
        continue;
      }

      let effectiveThreshold = config.thresholdPct;
      let effectiveTp = config.tpPct;
      let effectiveSl = config.slPct;
      let ohlcCandles: OhlcCandle[] | null = null;

      if (config.regimeAdaptive || config.aiFilter) {
        ohlcCandles = await fetchBinanceOhlcCandles(symbol);
        if (!ohlcCandles) continue;
        if (config.regimeAdaptive) {
          const regime = computeRegimeParams(ohlcCandles);
          effectiveThreshold = regime.thresholdPct;
          effectiveTp = regime.tpPct;
          effectiveSl = regime.slPct;
        }
      }

      const candle = await fetchBinance5mCandle(symbol);
      if (!candle) continue;

      const returnPct = ((candle.close - candle.open) / candle.open) * 100;
      if (Math.abs(returnPct) < effectiveThreshold) continue;

      const direction: "long" | "short" = returnPct > 0 ? "short" : "long";

      if (config.aiFilter) {
        const { score, label } = computeAiScore(ohlcCandles!, direction);
        if (score < 3) continue;
        console.log(`[${config.label}] ${pair} score=${score}/4 [${label}] → ${direction}`);
      }

      if (config.llmFilter) {
        const llm = await fetchLlmRegime(pair, ohlcCandles!);
        if (!llm) continue;
        if (llm.skipFades) {
          console.log(`[${config.label}] ${pair} skipped: LLM skipFades`);
          continue;
        }
        if (llm.bias === "long" && direction !== "long") {
          console.log(`[${config.label}] ${pair} skipped: LLM bias=long, signal=${direction}`);
          continue;
        }
        if (llm.bias === "short" && direction !== "short") {
          console.log(`[${config.label}] ${pair} skipped: LLM bias=short, signal=${direction}`);
          continue;
        }
        console.log(`[${config.label}] ${pair} LLM: regime=${llm.regime} bias=${llm.bias}`);
      }

      signals++;
      const entryPrice = candle.close;

      let sl: number;
      let tp: number;
      if (direction === "long") {
        sl = entryPrice * (1 - effectiveSl / 100);
        tp = entryPrice * (1 + effectiveTp / 100);
      } else {
        sl = entryPrice * (1 + effectiveSl / 100);
        tp = entryPrice * (1 - effectiveTp / 100);
      }

      const openHftCount = goLive
        ? loadOpenQuantPositions().filter(p => p.tradeType === config.tradeType && p.mode === "live").length
        : getPaperPositions().filter(p => p.tradeType === config.tradeType).length;
      if (openHftCount >= HFT_FADE_MAX_CONCURRENT) {
        console.log(`[${config.label}] At max concurrent (${openHftCount}/${HFT_FADE_MAX_CONCURRENT}), skipping ${pair}`);
        continue;
      }

      const gate = validateRiskGates({
        leverage: HFT_FADE_LEVERAGE,
        stopLoss: sl,
        regime: "ranging",
        strategy: config.tradeType,
        mode,
        dailyLossLimit: HFT_FADE_DAILY_LOSS_LIMIT,
      });
      if (!gate.allowed) {
        console.log(`[${config.label}] ${pair} blocked by risk gate: ${gate.reason}`);
        continue;
      }

      let position;
      if (goLive) {
        position = await lighterOpenPosition(
          pair,
          direction,
          HFT_FADE_POSITION_SIZE_USD,
          HFT_FADE_LEVERAGE,
          sl,
          tp,
          config.tradeType,
          undefined,
          entryPrice,
          true,  // allowMultiple
          true,  // skipExchangeOrders
        );
      } else {
        // Entry at ask/bid
        const spreadEntry = direction === "long"
          ? entryPrice * (1 + HFT_PAPER_SPREAD_PCT)
          : entryPrice * (1 - HFT_PAPER_SPREAD_PCT);
        position = await paperOpenPosition(
          pair,
          direction,
          HFT_FADE_POSITION_SIZE_USD,
          HFT_FADE_LEVERAGE,
          sl,
          tp,
          config.tradeType,
          undefined,
          spreadEntry,
          "lighter",
        );
      }

      if (position) {
        opened++;
        const sign = returnPct > 0 ? "+" : "";
        console.log(
          `[${config.label}] ${pair} ${direction.toUpperCase()} ${mode} (candle return ${sign}${returnPct.toFixed(3)}%, entry ${entryPrice})`,
        );
      }
    }
  } finally {
    cycleRunning.set(config.tradeType, false);
  }

  console.log(`[${config.label}] Cycle complete: ${signals} signals, ${opened} opened (${mode})`);
}

async function fetchBinancePrices(symbols: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (!symbols.length) return prices;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3_000);
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbols=${JSON.stringify(symbols)}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return prices;
    const data = (await resp.json()) as { symbol: string; price: string }[];
    for (const item of data) prices.set(item.symbol, parseFloat(item.price));
  } catch { /* best effort */ } finally {
    clearTimeout(timeoutId);
  }
  return prices;
}

async function runHftMonitor(config: HftVariantConfig): Promise<void> {
  const positions = getPaperPositions().filter(p => p.tradeType === config.tradeType && p.status === "open");
  if (!positions.length) return;

  const symbols = [...new Set(positions.map(p => BINANCE_SYMBOL_MAP[p.pair]).filter(Boolean))];
  const prices = await fetchBinancePrices(symbols);

  for (const pos of positions) {
    const symbol = BINANCE_SYMBOL_MAP[pos.pair];
    if (!symbol) continue;
    const price = prices.get(symbol);
    if (!price) continue;
    const sl = pos.stopLoss;
    const tp = pos.takeProfit;
    const slHit = sl && (pos.direction === "long" ? price <= sl : price >= sl);
    const tpHit = tp && (pos.direction === "long" ? price >= tp : price <= tp);
    // Exit at bid/ask
    const spreadExit = (p: number) => pos.direction === "long"
      ? p * (1 - HFT_PAPER_SPREAD_PCT)
      : p * (1 + HFT_PAPER_SPREAD_PCT);
    if (slHit) await paperClosePosition(pos.id, "stop-loss", spreadExit(sl));
    else if (tpHit) await paperClosePosition(pos.id, "take-profit", spreadExit(tp));
  }
}

// ms until next 5m candle close + 3s buffer
function msUntilNextCandle(): number {
  const now = Date.now();
  const cycleMs = HFT_FADE_INTERVAL_MS;
  const buffer = 3_000;
  const nextClose = Math.ceil((now - buffer) / cycleMs) * cycleMs + buffer;
  return Math.max(0, nextClose - now);
}

const hftIntervals = new Map<string, ReturnType<typeof setInterval>>();
const hftInitialTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const hftMonitorIntervals = new Map<string, ReturnType<typeof setInterval>>();

export function startAllHftSchedulers(): void {
  for (const config of HFT_VARIANTS) {
    if (hftIntervals.has(config.tradeType)) {
      console.log(`[${config.label}] Already running, skipping start`);
      continue;
    }
    const delay = msUntilNextCandle();
    const startMode = HFT_FADE_LIVE_ENABLED && config.tradeType === "hft-fade" ? "live" : "paper";
    console.log(`[${config.label}] Started (${startMode}) — first cycle in ${Math.round(delay / 1000)}s`);
    const timeout = setTimeout(() => {
      void runHftFadeCycle(config);
      const interval = setInterval(() => {
        void runHftFadeCycle(config);
      }, HFT_FADE_INTERVAL_MS);
      hftIntervals.set(config.tradeType, interval);
    }, delay);
    hftInitialTimeouts.set(config.tradeType, timeout);
    const monitorInterval = setInterval(() => { void runHftMonitor(config); }, 2_000);
    hftMonitorIntervals.set(config.tradeType, monitorInterval);
  }
}

export function stopAllHftSchedulers(): void {
  for (const timeout of hftInitialTimeouts.values()) clearTimeout(timeout);
  hftInitialTimeouts.clear();
  for (const interval of hftIntervals.values()) clearInterval(interval);
  hftIntervals.clear();
  for (const interval of hftMonitorIntervals.values()) clearInterval(interval);
  hftMonitorIntervals.clear();
  console.log("[HFT] All schedulers stopped");
}
