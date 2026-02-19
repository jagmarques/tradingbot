import type {
  PairAnalysis,
  OhlcvCandle,
  TechnicalIndicators,
  MarketRegime,
  CandleInterval,
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
        "Market is RANGING. Favor mean-reversion entries. Look for price at Bollinger Band extremes " +
        "with RSI overbought/oversold. Set tighter stops near range boundaries. Target the opposite band."
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
Funding Rate: ${fundingPct}% (per 8h)
Open Interest: ${formatNum(analysis.openInterest, 0)}

=== MULTI-TIMEFRAME ANALYSIS ===
${timeframeSections}

=== REGIME ===
Detected regime: ${analysis.regime.toUpperCase()}
${getRegimeInstruction(analysis.regime)}

=== INSTRUCTIONS ===
If no clear setup exists or risk/reward is unfavorable, return direction: flat with confidence below 50 and reasoning explaining why.

OUTPUT JSON ONLY (no markdown, no extra text):
{
  "direction": "long" | "short" | "flat",
  "entryPrice": <number - suggested entry price near current mark>,
  "stopLoss": <number - stop-loss price>,
  "takeProfit": <number - take-profit price>,
  "confidence": <number 0-100 - how confident in this trade>,
  "reasoning": "<2-3 sentences explaining the trade thesis based on the data>"
}`;
}
