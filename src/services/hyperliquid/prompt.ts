import type {
  PairAnalysis,
  OhlcvCandle,
  TechnicalIndicators,
  MarketRegime,
  CandleInterval,
  MicrostructureData,
} from "./types.js";

function formatNum(value: number | null | undefined, decimals = 4): string {
  if (value === null || value === undefined) return "n/a";
  return value.toFixed(decimals);
}

function formatCandles(candles: OhlcvCandle[], count: number): string {
  const last = candles.slice(-count);
  if (last.length === 0) return "  (no data)";
  return last
    .map((c) => {
      const ts = new Date(c.timestamp).toISOString().slice(0, 16).replace("T", " ");
      return `  [${ts}] O:${formatNum(c.open, 2)} H:${formatNum(c.high, 2)} L:${formatNum(c.low, 2)} C:${formatNum(c.close, 2)} V:${formatNum(c.volume, 0)}`;
    })
    .join("\n");
}

function formatIndicators(ind: TechnicalIndicators): string {
  const macd = ind.macd
    ? `macd=${formatNum(ind.macd.macd)} sig=${formatNum(ind.macd.signal)} hist=${formatNum(ind.macd.histogram)}`
    : "macd=n/a sig=n/a hist=n/a";

  const bb = ind.bollingerBands
    ? `upper=${formatNum(ind.bollingerBands.upper, 2)} mid=${formatNum(ind.bollingerBands.middle, 2)} lower=${formatNum(ind.bollingerBands.lower, 2)} width=${formatNum(ind.bollingerBands.width)}`
    : "upper=n/a mid=n/a lower=n/a width=n/a";

  return [
    `  RSI: ${formatNum(ind.rsi, 2)}`,
    `  MACD: ${macd}`,
    `  BB: ${bb}`,
    `  ATR: ${formatNum(ind.atr, 4)}`,
    `  VWAP: ${formatNum(ind.vwap, 2)}`,
    `  ADX: ${formatNum(ind.adx, 2)}`,
  ].join("\n");
}

function formatMicrostructure(ms: MicrostructureData | undefined): string {
  if (!ms) {
    return "Microstructure data unavailable this cycle.";
  }

  const ls = ms.longShortRatio;
  const ob = ms.orderbookImbalance;

  const lsSection = ls
    ? [
        `  Global accounts: ${ls.global.toFixed(3)} (${ls.globalTrend} trend)`,
        `  Top traders: ${ls.topTraders.toFixed(3)}`,
        `  [Interpretation: >1 = more longs in market, <1 = more shorts. Extreme readings (>2 or <0.5) suggest crowded positioning - potential contrarian signal.]`,
      ].join("\n")
    : "  n/a (data unavailable)";

  const obSection = ob
    ? [
        `  Bid depth: $${ob.bidDepthUsd.toFixed(0)}`,
        `  Ask depth: $${ob.askDepthUsd.toFixed(0)}`,
        `  Imbalance: ${ob.imbalanceRatio.toFixed(3)} (0.5=balanced, >0.6=bid heavy/bullish, <0.4=ask heavy/bearish)`,
        `  Spread: ${ob.spreadBps.toFixed(1)} bps`,
      ].join("\n")
    : "  n/a (data unavailable)";

  let oiSection: string;
  if (ms.oiDelta !== null && ms.oiDeltaPct !== null) {
    const sign = ms.oiDelta > 0 ? "+" : "";
    oiSection = [
      `  Change: ${sign}${ms.oiDelta.toFixed(0)} (${sign}${ms.oiDeltaPct.toFixed(2)}%)`,
      `  [Interpretation: Rising OI + rising price = new longs (bullish). Rising OI + falling price = new shorts (bearish). Falling OI = position unwinding.]`,
    ].join("\n");
  } else {
    oiSection = "  n/a (first cycle - no baseline yet)";
  }

  return [
    `Long/Short Ratio (Binance, 1h):`,
    lsSection,
    ``,
    `Orderbook Depth (Hyperliquid, within 2% of mid):`,
    obSection,
    ``,
    `Open Interest Delta (vs previous cycle):`,
    oiSection,
  ].join("\n");
}

function getRegimeInstruction(regime: MarketRegime): string {
  switch (regime) {
    case "trending":
      return (
        "Market is TRENDING. Favor trend-following entries. Look for pullbacks to support/resistance " +
        "with momentum confirmation (RSI not overbought/oversold, MACD aligned with trend). " +
        "Set wider stops to ride the trend."
      );
    case "ranging":
      return (
        "Market is RANGING. Look for mean-reversion setups at extremes only. " +
        "If price is near the upper Bollinger Band AND RSI > 70, go short. " +
        "If price is near the lower Bollinger Band AND RSI < 30, go long. " +
        "Return flat if price is NOT at an extreme. " +
        "Only trade with 75%+ confidence when multiple indicators align."
      );
    case "volatile":
      return (
        "Market is VOLATILE. Risk is elevated. You MUST return direction: flat. " +
        "Do not enter new positions in volatile regimes."
      );
  }
}

export function buildQuantPrompt(analysis: PairAnalysis & { candles?: Record<CandleInterval, OhlcvCandle[]> }): string {
  const intervals: CandleInterval[] = ["15m", "1h", "4h"];
  const fundingPct = (analysis.fundingRate * 100).toFixed(4);

  const timeframeSections = intervals
    .map((interval) => {
      const ind = analysis.indicators[interval];
      const candleRows =
        analysis.candles && analysis.candles[interval]
          ? formatCandles(analysis.candles[interval], 5)
          : "  (candle data not provided)";

      return [
        `--- ${interval} Timeframe ---`,
        "Last 5 candles:",
        candleRows,
        "Indicators:",
        formatIndicators(ind),
      ].join("\n");
    })
    .join("\n\n");

  return `You are a quantitative crypto trading analyst. Analyze the following market data and provide a trading decision. Respond with valid JSON only.

=== MARKET SUMMARY ===
Pair: ${analysis.pair}-PERP
Mark Price: ${formatNum(analysis.markPrice, 2)}
Oracle Price: ${formatNum(analysis.oraclePrice, 2)}
24h Volume: ${formatNum(analysis.dayVolume, 0)}
Funding Rate: ${fundingPct}% (per 1h)
Open Interest: ${formatNum(analysis.openInterest, 0)}

=== MULTI-TIMEFRAME ANALYSIS ===
${timeframeSections}

=== MARKET MICROSTRUCTURE ===
${formatMicrostructure(analysis.microstructure)}

=== REGIME ===
Detected regime: ${analysis.regime.toUpperCase()}
${getRegimeInstruction(analysis.regime)}

=== INSTRUCTIONS ===
Stop-loss MUST be within 2% of entry price. Stops beyond 2% will be capped automatically.

Return flat only when signals clearly contradict each other or there is no identifiable directional edge. Use microstructure data (long/short ratio, orderbook imbalance, OI delta) to confirm or contradict technical signals. Crowded positioning or orderbook imbalance can strengthen or weaken a setup.

OUTPUT JSON ONLY (no markdown, no extra text):
{
  "direction": "long" | "short" | "flat",
  "entryPrice": <number - suggested entry price near current mark>,
  "stopLoss": <number - within 2% of entry>,
  "takeProfit": <number - take-profit price>,
  "confidence": <number 0-100 - how confident in this trade>,
  "reasoning": "<2-3 sentences explaining the trade thesis based on the data>"
}`;
}
