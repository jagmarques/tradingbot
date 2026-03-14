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

  const ob = ms.orderbookImbalance;

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
        "Market is RANGING/SIDEWAYS. Most ranging trades lose money - default to FLAT unless you see a clear extreme. " +
        "ONLY trade if ALL of these conditions are met: " +
        "(1) Price is at a Bollinger Band extreme (touching upper or lower band), " +
        "(2) RSI confirms (>70 for short at upper band, <30 for long at lower band), " +
        "(3) Orderbook imbalance supports the reversal direction. " +
        "If ANY condition is missing, return flat. Ranging markets chop - sitting out IS the edge. " +
        "Do NOT use daily trend bias in ranging markets - trend-following loses when there is no trend."
      );
    case "volatile":
      return (
        "Market is VOLATILE. Risk is elevated. You MUST return direction: flat. " +
        "Do not enter new positions in volatile regimes."
      );
  }
}

export interface DailyTrend {
  direction: "bullish" | "bearish" | "neutral";
  price: number;
  sma50: number;
}

function formatDailyTrend(trend: DailyTrend): string {
  const pct = (((trend.price - trend.sma50) / trend.sma50) * 100).toFixed(2);
  const aboveBelow = trend.price >= trend.sma50 ? "above" : "below";
  const aboveBelowAbs = Math.abs(parseFloat(pct));
  let bias: string;
  if (trend.direction === "bearish") {
    bias =
      "Price is below the daily SMA50. The macro trend leans bearish. In TRENDING regimes, this favors shorts. In RANGING regimes, ignore this - there is no trend to follow.";
  } else if (trend.direction === "bullish") {
    bias =
      "Price is above the daily SMA50. The macro trend leans bullish. In TRENDING regimes, this favors longs. In RANGING regimes, ignore this - there is no trend to follow.";
  } else {
    bias = "Price is near the daily SMA50. No clear macro trend bias. Consider both directions equally.";
  }
  return [
    `=== DAILY TREND ===`,
    `Daily SMA50: ${trend.sma50.toFixed(2)}`,
    `Current Price vs SMA50: ${trend.price.toFixed(2)} is ${aboveBelow} SMA50 (${aboveBelowAbs.toFixed(2)}% ${aboveBelow})`,
    `Daily Trend: ${trend.direction.toUpperCase()}`,
    bias,
  ].join("\n");
}

export function buildQuantPrompt(analysis: PairAnalysis & { candles?: Record<CandleInterval, OhlcvCandle[]> }, dailyTrend?: DailyTrend | null): string {
  const intervals: CandleInterval[] = ["15m", "1h", "4h", "1d"];
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

=== FUNDING RATE INTERPRETATION ===
Positive funding (${fundingPct}% > 0): Longs pay shorts. Market is crowded long -- contrarian short signal.
Negative funding (${fundingPct}% < 0): Shorts pay longs. Market is crowded short -- contrarian long signal.
Extreme rates (|rate| > 0.01%): Strong contrarian signal -- crowded positioning often precedes reversals.
Use funding as confirmation, not primary signal. High funding also erodes edge on longer holds.

=== REGIME ===
Detected regime: ${analysis.regime.toUpperCase()}
${getRegimeInstruction(analysis.regime)}

${dailyTrend ? formatDailyTrend(dailyTrend) + "\n\n" : ""}=== INSTRUCTIONS ===
The 4h ATR is ${formatNum(analysis.indicators["4h"].atr, 4)}. Use 2-3x ATR for stop-loss distance (${formatNum((analysis.indicators["4h"].atr ?? 0) * 2, 4)} to ${formatNum((analysis.indicators["4h"].atr ?? 0) * 3, 4)} from entry). Stops beyond 5% of entry will be capped automatically.

Return flat when signals contradict, the market is choppy, or there is no clear edge. FLAT IS A VALID AND PROFITABLE DECISION - not trading bad setups preserves capital. You should return flat at least 40-60% of the time across all pairs. Do not force trades.

CRITICAL RULES:
1. In RANGING markets: Return flat unless price is at a clear Bollinger Band extreme with RSI confirmation. Most ranging trades lose money.
2. BOTH directions are valid: Do not develop a bias toward only long or only short. Actively consider both directions - a balanced trader takes longs AND shorts depending on the setup.
3. Microstructure confirms, not drives: Use long/short ratio, orderbook imbalance, and OI delta to confirm or reject a technical setup, not as standalone signals.
4. Confidence calibration: 50-60% = weak/skip, 60-70% = moderate, 70-80% = good, 80%+ = very strong. Be honest about uncertainty.

Before deciding direction, you MUST reason through BOTH sides:
- Write a bull case (why price goes up)
- Write a bear case (why price goes down)
- Only then decide direction based on which case is stronger
- If both cases are roughly equal, return flat

OUTPUT JSON ONLY (no markdown, no extra text):
{
  "bullCase": "<1-2 sentences: strongest argument for price going UP>",
  "bearCase": "<1-2 sentences: strongest argument for price going DOWN>",
  "direction": "long" | "short" | "flat",
  "entryPrice": <number - suggested entry price near current mark>,
  "stopLoss": <number - use 2-3x ATR for stop distance, max 5% from entry>,
  "takeProfit": <number - take-profit price>,
  "confidence": <number 0-100 - how confident in this trade>,
  "reasoning": "<2-3 sentences explaining why the chosen direction wins over the other>"
}`;
}
