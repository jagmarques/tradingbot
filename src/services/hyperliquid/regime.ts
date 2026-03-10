import type { TechnicalIndicators, MarketRegime } from "./types.js";

const ADX_TRENDING_MIN = 25;
const ADX_RANGING_MAX = 20;
const BB_WIDTH_VOLATILE_MIN = 0.08;
const BB_WIDTH_TRENDING_MIN = 0.03;
const ATR_RATIO_VOLATILE_MIN = 0.03;

export function classifyRegime(indicators: TechnicalIndicators, label?: string): MarketRegime {
  const adx = indicators.adx;
  const bbWidth = indicators.bollingerBands?.width ?? null;
  const atr = indicators.atr;
  const vwap = indicators.vwap;
  const atrRatio = atr !== null && vwap !== null && vwap > 0 ? atr / vwap : null;

  let regime: MarketRegime;

  if (bbWidth !== null && bbWidth > BB_WIDTH_VOLATILE_MIN && atrRatio !== null && atrRatio > ATR_RATIO_VOLATILE_MIN) {
    regime = "volatile";
  } else if (adx !== null && adx > ADX_TRENDING_MIN) {
    regime = "trending";
  } else if (adx !== null && adx < ADX_RANGING_MAX) {
    regime = "ranging";
  } else if (bbWidth !== null && bbWidth < BB_WIDTH_TRENDING_MIN) {
    regime = "ranging";
  } else {
    regime = "ranging";
  }

  if (label !== undefined) {
    console.log(`[Regime] ${label}: adx=${adx?.toFixed(1) ?? "null"}, bbWidth=${bbWidth?.toFixed(4) ?? "null"}, atrRatio=${atrRatio?.toFixed(4) ?? "null"} -> ${regime}`);
  }

  return regime;
}
