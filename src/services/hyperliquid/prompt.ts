import type {
  PairAnalysis,
  OhlcvCandle,
  TechnicalIndicators,
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

  return `You are a professional quantitative trader at a hedge fund. You trade crypto perpetual futures. You DO NOT use traditional indicators as primary signals — they are lagging and crowded. Instead you read raw price action, volume dynamics, orderbook structure, and positioning data to find short-term edge.

=== RAW DATA ===
Pair: ${analysis.pair}-PERP
Mark: ${formatNum(analysis.markPrice, 2)} | Oracle: ${formatNum(analysis.oraclePrice, 2)}
24h Vol: ${formatNum(analysis.dayVolume, 0)} | OI: ${formatNum(analysis.openInterest, 0)}
Funding: ${fundingPct}%/1h (positive = longs pay, negative = shorts pay)

${timeframeSections}

=== MICROSTRUCTURE ===
${formatMicrostructure(analysis.microstructure)}

${dailyTrend ? formatDailyTrend(dailyTrend) + "\n\n" : ""}=== HOW YOU THINK ===
You are NOT a retail trader. Ignore what indicators "say." Instead:

1. READ THE CANDLES: What is the actual price doing? Is it making higher highs? Lower lows? Compressing? Expanding? Where did it open vs close? What is the body-to-wick ratio telling you about buyer/seller conviction?

2. READ THE VOLUME: Is volume increasing into moves (conviction) or decreasing (exhaustion)? Volume spikes at extremes = capitulation/climax. Low volume breakout = likely false.

3. READ THE ORDERBOOK: Which side has more depth? If bids are 2x asks, there is a floor. If asks dominate, there is a ceiling. Large imbalances precede moves.

4. READ THE FUNDING: Extreme positive funding = overleveraged longs = ripe for liquidation cascade down. Extreme negative = overleveraged shorts = squeeze up. This is a positioning signal, not a technical one.

5. THINK IN PROBABILITIES: What is the expected value of this trade? If the setup has a 55% chance of a 1% move in your favor and 45% chance of a 0.8% move against, that's +EV. If it's a coin flip, return flat.

6. SPREAD COST: Every trade costs ~0.08% round trip. Your edge must exceed this. Marginal setups are negative EV after costs. Be selective — flat is profitable when there's no clear edge.

=== RISK ===
ATR(4h): ${formatNum(analysis.indicators["4h"].atr, 4)}
Stop distance: 2-3x ATR from entry (max 5% capped).
Be decisive. Take trades when you see edge. Only return flat when the data is truly contradictory or there is no identifiable setup.

=== CONFIDENCE CALIBRATION ===
Your confidence MUST reflect actual setup quality. Do NOT default to the same number for every trade.
- 55-64: Marginal edge, weak signal alignment, one timeframe agrees
- 65-74: Moderate edge, two timeframes agree, some volume confirmation
- 75-84: Strong setup, multiple signals align (price action + volume + orderbook + funding)
- 85-95: Exceptional, rare — extreme positioning (funding/OI), climax volume, clear multi-TF trend
Think about what SPECIFICALLY makes this setup stronger or weaker than average, and let that drive your number. Avoid round numbers like 65, 70, 75 — use precise values like 67, 73, 81.

OUTPUT JSON ONLY:
{
  "bullCase": "<why price goes up>",
  "bearCase": "<why price goes down>",
  "direction": "long" | "short" | "flat",
  "entryPrice": <number>,
  "stopLoss": <number>,
  "takeProfit": <number>,
  "confidence": <55-95, calibrated to setup quality — see above>,
  "reasoning": "<2-3 sentences: what raw data pattern convinced you>"
}`;
}
