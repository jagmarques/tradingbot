import {
  HFT_FADE_INTERVAL_MS,
  HFT_FADE_MIN_RETURN_PCT,
  HFT_FADE_POSITION_SIZE_USD,
  HFT_FADE_LEVERAGE,
  HFT_FADE_TP_PCT,
  HFT_FADE_SL_PCT,
  HFT_FADE_DAILY_LOSS_LIMIT,
  HFT_FADE_MIN_VOLUME_24H,
  HFT_FADE_LIVE_ENABLED,
  QUANT_TRADING_PAIRS,
} from "../../config/constants.js";
import { validateRiskGates, isQuantKilled } from "./risk-manager.js";
import { paperOpenPosition } from "./paper.js";
import { lighterOpenPosition } from "../lighter/executor.js";
import { isLighterInitialized } from "../lighter/client.js";

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
  MKR: "MKRUSDT",
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
const VOLUME_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (volume doesn't change meaningfully per cycle)

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
    // limit=2 gives [closed_candle, current_candle]; index 0 = just-closed candle
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

let cycleRunning = false;

async function runHftFadeCycle(): Promise<void> {
  if (isQuantKilled()) return;
  if (cycleRunning) {
    console.log("[HFT-Fade] Cycle already running, skipping");
    return;
  }
  cycleRunning = true;

  const goLive = HFT_FADE_LIVE_ENABLED && isLighterInitialized();
  const mode = goLive ? "live" : "paper";

  let signals = 0;
  let opened = 0;

  try {
    for (const pair of QUANT_TRADING_PAIRS) {
      if (isQuantKilled()) break;

      const symbol = BINANCE_SYMBOL_MAP[pair];
      if (!symbol) continue;

      // Volume check
      const volume24h = await fetchBinance24hVolume(symbol);
      if (volume24h === null || volume24h < HFT_FADE_MIN_VOLUME_24H) {
        if (volume24h !== null) {
          console.log(`[HFT-Fade] ${pair} skipped: 24h volume $${volume24h.toFixed(0)} < $${HFT_FADE_MIN_VOLUME_24H}`);
        }
        continue;
      }

      // Fetch closed 5m candle
      const candle = await fetchBinance5mCandle(symbol);
      if (!candle) continue;

      // Compute return
      const returnPct = ((candle.close - candle.open) / candle.open) * 100;
      if (Math.abs(returnPct) < HFT_FADE_MIN_RETURN_PCT) continue;

      signals++;

      // Fade direction: bullish candle -> go SHORT; bearish -> go LONG
      const direction: "long" | "short" = returnPct > 0 ? "short" : "long";
      const entryPrice = candle.close;

      // SL and TP
      let sl: number;
      let tp: number;
      if (direction === "long") {
        sl = entryPrice * (1 - HFT_FADE_SL_PCT / 100);
        tp = entryPrice * (1 + HFT_FADE_TP_PCT / 100);
      } else {
        sl = entryPrice * (1 + HFT_FADE_SL_PCT / 100);
        tp = entryPrice * (1 - HFT_FADE_TP_PCT / 100);
      }

      // Risk gate
      const gate = validateRiskGates({
        leverage: HFT_FADE_LEVERAGE,
        stopLoss: sl,
        regime: "ranging",
        strategy: "hft-fade",
        mode,
        dailyLossLimit: HFT_FADE_DAILY_LOSS_LIMIT,
      });
      if (!gate.allowed) {
        console.log(`[HFT-Fade] ${pair} blocked by risk gate: ${gate.reason}`);
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
          "hft-fade",
          undefined,
          entryPrice,
          true,  // allowMultiple: HFT can open multiple positions per pair
          true,  // skipExchangeOrders: software SL via position monitor (saves rate limit)
        );
      } else {
        position = await paperOpenPosition(
          pair,
          direction,
          HFT_FADE_POSITION_SIZE_USD,
          HFT_FADE_LEVERAGE,
          sl,
          tp,
          "hft-fade",
          undefined,
          entryPrice,
          "lighter",
        );
      }

      if (position) {
        opened++;
        const sign = returnPct > 0 ? "+" : "";
        console.log(
          `[HFT-Fade] ${pair} ${direction.toUpperCase()} ${mode} (candle return ${sign}${returnPct.toFixed(3)}%, entry ${entryPrice})`,
        );
      }
    }
  } finally {
    cycleRunning = false;
  }

  console.log(`[HFT-Fade] Cycle complete: ${signals} signals, ${opened} opened (${mode})`);
}

let hftInterval: ReturnType<typeof setInterval> | null = null;
let hftInitialTimeout: ReturnType<typeof setTimeout> | null = null;

// Returns ms until the next Binance 5m candle close + 3s buffer
function msUntilNextCandle(): number {
  const now = Date.now();
  const cycleMs = HFT_FADE_INTERVAL_MS; // 5 * 60 * 1000
  const buffer = 3_000; // 3s after candle close to ensure it's settled
  const nextClose = Math.ceil((now - buffer) / cycleMs) * cycleMs + buffer;
  return Math.max(0, nextClose - now);
}

export function startHftFadeScheduler(): void {
  if (hftInterval !== null) {
    console.log("[HFT-Fade] Already running, skipping start");
    return;
  }
  const delay = msUntilNextCandle();
  console.log(`[HFT-Fade] Started (paper mode) — first cycle in ${Math.round(delay / 1000)}s`);
  hftInitialTimeout = setTimeout(() => {
    void runHftFadeCycle();
    hftInterval = setInterval(() => {
      void runHftFadeCycle();
    }, HFT_FADE_INTERVAL_MS);
  }, delay);
}

export function stopHftFadeScheduler(): void {
  if (hftInitialTimeout !== null) {
    clearTimeout(hftInitialTimeout);
    hftInitialTimeout = null;
  }
  if (hftInterval !== null) {
    clearInterval(hftInterval);
    hftInterval = null;
  }
  console.log("[HFT-Fade] Stopped");
}
