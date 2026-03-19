/**
 * High-Frequency Math-Only Scanner for Polymarket
 *
 * Two strategies:
 *
 * 1. MOMENTUM ARB (15-min Up/Down markets):
 *    Binance BTC price WebSocket -> detect momentum -> place maker limit orders
 *    on Polymarket before odds adjust. Uses maker orders for 20% fee rebate.
 *
 * 2. FAST SCAN (regular markets):
 *    30s cycle scanning markets with pure math (no LLM).
 *    Detects NegRisk arb (binary markets where Yes+No != 1.0).
 *    Flags opportunities for the slow R1 cycle to deep-analyze.
 */

import WebSocket from "ws";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { GAMMA_API_URL } from "../../config/constants.js";

// ---- Types ---------------------------------------------------------------

interface BinanceTicker {
  u: number;  // order book updateId
  s: string;  // symbol (BTCUSDT)
  b: string;  // best bid price
  B: string;  // best bid qty
  a: string;  // best ask price
  A: string;  // best ask qty
}

// Binance combined stream wraps payload in { stream, data }
interface BinanceCombinedMessage {
  stream: string;
  data: BinanceTicker;
}

interface PriceState {
  symbol: string;
  price: number;
  prevPrice: number;
  timestamp: number;
  momentum: number;       // fractional change over window (0.003 = 0.3%)
  volatility: number;     // rolling std dev of returns
  priceHistory: number[]; // sampled prices for calculations
}

export interface MomentumSignal {
  symbol: string;
  direction: "up" | "down";
  magnitude: number;      // % move (e.g. 0.30 = 0.30%)
  confidence: number;     // 0-1 based on consistency
  timestamp: number;
  binancePrice: number;
}

export interface FastScanResult {
  marketId: string;
  title: string;
  marketPrice: number;
  mathEstimate: number;
  edge: number;
  source: string;
  flagForR1: boolean;
}

// ---- Configuration -------------------------------------------------------

const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws";
const MOMENTUM_WINDOW_MS = 30_000;
const MOMENTUM_THRESHOLD_PCT = 0.15;     // 0.15% move triggers signal
const PRICE_SAMPLE_INTERVAL_MS = 500;
const MAX_PRICE_HISTORY = 120;           // 60s of history at 500ms
const MIN_SAMPLES_FOR_SIGNAL = 40;       // Need 20s of data before signaling
const FAST_SCAN_INTERVAL_MS = 30_000;
const STALE_PRICE_MS = 5_000;
const MAX_PAPER_TRADES = 500;            // Bound memory
const MAX_FLAGGED_R1 = 50;              // Bound memory
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

// ---- Binance Price Feed --------------------------------------------------

const priceStates = new Map<string, PriceState>();
let binanceWs: WebSocket | null = null;
let binanceConnected = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;

const TRACKED_SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt"];

function connectBinance(): void {
  // Don't reconnect if scanner was stopped
  if (!running) return;

  const streams = TRACKED_SYMBOLS.map(s => `${s}@bookTicker`).join("/");
  const url = `${BINANCE_WS_URL}/${streams}`;

  binanceWs = new WebSocket(url);

  binanceWs.on("open", () => {
    binanceConnected = true;
    reconnectAttempts = 0;
    console.log(`[HFScanner] Binance WS connected (${TRACKED_SYMBOLS.length} pairs)`);
  });

  binanceWs.on("message", (data: Buffer) => {
    try {
      const raw = JSON.parse(data.toString());

      // Combined stream format: { stream: "btcusdt@bookTicker", data: { s, b, a, ... } }
      let ticker: BinanceTicker;
      if (raw.data && raw.stream) {
        ticker = (raw as BinanceCombinedMessage).data;
      } else {
        ticker = raw as BinanceTicker;
      }

      // Validate required fields exist
      if (!ticker.s || !ticker.b || !ticker.a) return;

      const bid = parseFloat(ticker.b);
      const ask = parseFloat(ticker.a);
      if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) return;

      updatePrice(ticker);
    } catch {
      // Ignore parse errors
    }
  });

  binanceWs.on("close", () => {
    binanceConnected = false;
    if (!running) return; // Don't reconnect after stop

    // Exponential backoff
    reconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_MS);
    console.log(`[HFScanner] Binance WS closed, reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(connectBinance, delay);
  });

  binanceWs.on("error", (err) => {
    console.error("[HFScanner] Binance WS error:", err.message);
  });

  binanceWs.on("ping", () => {
    binanceWs?.pong();
  });
}

function updatePrice(ticker: BinanceTicker): void {
  const symbol = ticker.s.toLowerCase();
  const mid = (parseFloat(ticker.b) + parseFloat(ticker.a)) / 2;
  const now = Date.now();

  let state = priceStates.get(symbol);
  if (!state) {
    state = {
      symbol,
      price: mid,
      prevPrice: mid,
      timestamp: now,
      momentum: 0,
      volatility: 0,
      priceHistory: [mid],
    };
    priceStates.set(symbol, state);
    return;
  }

  // Only sample at PRICE_SAMPLE_INTERVAL_MS intervals
  if (now - state.timestamp < PRICE_SAMPLE_INTERVAL_MS) return;

  state.prevPrice = state.price;
  state.price = mid;
  state.timestamp = now;

  state.priceHistory.push(mid);
  if (state.priceHistory.length > MAX_PRICE_HISTORY) {
    state.priceHistory.shift();
  }

  // Calculate momentum (fractional change over window)
  const windowSamples = Math.floor(MOMENTUM_WINDOW_MS / PRICE_SAMPLE_INTERVAL_MS);
  const lookbackIdx = Math.max(0, state.priceHistory.length - windowSamples);
  const oldPrice = state.priceHistory[lookbackIdx];
  state.momentum = oldPrice > 0 ? (mid - oldPrice) / oldPrice : 0;

  // Rolling volatility
  if (state.priceHistory.length > 10) {
    const returns: number[] = [];
    const start = Math.max(0, state.priceHistory.length - windowSamples);
    for (let i = start + 1; i < state.priceHistory.length; i++) {
      const ret = (state.priceHistory[i] - state.priceHistory[i - 1]) / state.priceHistory[i - 1];
      returns.push(ret);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    state.volatility = Math.sqrt(variance);
  }
}

// ---- Momentum Detection --------------------------------------------------

const momentumCallbacks: Array<(signal: MomentumSignal) => void> = [];
let momentumCheckInterval: NodeJS.Timeout | null = null;

let lastMomentumLog = 0;

function checkMomentum(): void {
  // Log momentum stats every 60s
  const now = Date.now();
  if (now - lastMomentumLog > 60000) {
    lastMomentumLog = now;
    const btc = priceStates.get("btcusdt");
    if (btc) {
      console.log(`[HFMomentum] BTC $${btc.price.toFixed(0)} mom=${(btc.momentum * 100).toFixed(3)}% samples=${btc.priceHistory.length} vol=${btc.volatility.toFixed(6)}`);
    }
  }

  for (const [symbol, state] of priceStates) {
    if (state.priceHistory.length < MIN_SAMPLES_FOR_SIGNAL) continue;

    const absMomentum = Math.abs(state.momentum) * 100;
    if (absMomentum < MOMENTUM_THRESHOLD_PCT) continue;
    if (Date.now() - state.timestamp > STALE_PRICE_MS) continue;

    // Confidence: consistency of direction
    const windowSamples = Math.floor(MOMENTUM_WINDOW_MS / PRICE_SAMPLE_INTERVAL_MS);
    const start = Math.max(0, state.priceHistory.length - windowSamples);
    let consistentMoves = 0;
    const direction = state.momentum > 0 ? 1 : -1;

    for (let i = start + 1; i < state.priceHistory.length; i++) {
      const move = state.priceHistory[i] - state.priceHistory[i - 1];
      if (Math.sign(move) === direction) consistentMoves++;
    }

    const totalMoves = state.priceHistory.length - start - 1;
    const consistency = totalMoves > 0 ? consistentMoves / totalMoves : 0;

    if (consistency < 0.60) continue;

    const signal: MomentumSignal = {
      symbol,
      direction: state.momentum > 0 ? "up" : "down",
      magnitude: absMomentum,
      confidence: Math.min(1, consistency),
      timestamp: Date.now(),
      binancePrice: state.price,
    };

    for (const cb of momentumCallbacks) {
      try { cb(signal); } catch { /* swallow */ }
    }
  }
}

// ---- 15-Minute Market Discovery ------------------------------------------

interface UpDownMarket {
  conditionId: string;
  slug: string;
  title: string;
  tokenIdUp: string;
  tokenIdDown: string;
  priceUp: number;
  priceDown: number;
  coin: string;
  windowStart: number; // Unix timestamp when 15-min window starts
  windowEnd: number;   // Unix timestamp when 15-min window ends
}

const lastSignalTime = new Map<string, number>();
const SIGNAL_COOLDOWN_MS = 60_000;

// Snapshot of Binance price at each 15-min window boundary
const windowStartPrices = new Map<string, number>(); // "btc-{windowTs}" -> price

async function findCurrent15mMarkets(): Promise<UpDownMarket[]> {
  const markets: UpDownMarket[] = [];
  const coins = ["btc", "eth", "sol"];

  for (const coin of coins) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const windowTs = Math.floor(now / 900) * 900;
      const slug = `${coin}-updown-15m-${windowTs}`;

      // Snapshot window start price from Binance
      const snapshotKey = `${coin}-${windowTs}`;
      if (!windowStartPrices.has(snapshotKey)) {
        const currentState = priceStates.get(mapCoinToSymbol(coin));
        if (currentState) {
          windowStartPrices.set(snapshotKey, currentState.price);
        }
      }

      // Clean old snapshots (keep last 10)
      if (windowStartPrices.size > 30) {
        const keys = Array.from(windowStartPrices.keys()).sort();
        for (let i = 0; i < keys.length - 10; i++) {
          windowStartPrices.delete(keys[i]);
        }
      }

      const response = await fetchWithTimeout(
        `${GAMMA_API_URL}/events?slug=${slug}`,
        { timeoutMs: 5000 }
      );

      if (!response.ok) continue;
      const events = await response.json() as Array<{
        markets: Array<{
          conditionId: string;
          slug: string;
          question: string;
          outcomes: string;
          outcomePrices: string;
          clobTokenIds: string;
        }>;
      }>;

      if (!events?.length || !events[0]?.markets?.length) continue;

      for (const m of events[0].markets) {
        try {
          const outcomes = JSON.parse(m.outcomes) as string[];
          const prices = JSON.parse(m.outcomePrices) as string[];
          const tokenIds = JSON.parse(m.clobTokenIds) as string[];

          const upIdx = outcomes.findIndex(o => o.toLowerCase() === "up");
          const downIdx = outcomes.findIndex(o => o.toLowerCase() === "down");

          if (upIdx === -1 || downIdx === -1) continue;

          markets.push({
            conditionId: m.conditionId,
            slug: m.slug,
            title: m.question,
            tokenIdUp: tokenIds[upIdx],
            tokenIdDown: tokenIds[downIdx],
            priceUp: parseFloat(prices[upIdx]),
            priceDown: parseFloat(prices[downIdx]),
            coin,
            windowStart: windowTs,
            windowEnd: windowTs + 900,
          });
        } catch { /* skip malformed */ }
      }
    } catch {
      // Non-critical
    }
  }

  return markets;
}

// ---- Momentum -> Polymarket Signal ---------------------------------------

interface TradeSignal {
  market: UpDownMarket;
  side: "up" | "down";
  targetPrice: number;
  edgeEstimate: number;
  momentum: MomentumSignal;
  windowStartPrice: number; // Binance price at window open
}

const tradeSignalCallbacks: Array<(signal: TradeSignal) => void> = [];
let activeMarkets: UpDownMarket[] = [];
let marketRefreshInterval: NodeJS.Timeout | null = null;

function mapCoinToSymbol(coin: string): string {
  const map: Record<string, string> = {
    btc: "btcusdt",
    eth: "ethusdt",
    sol: "solusdt",
    xrp: "xrpusdt",
    doge: "dogeusdt",
  };
  return map[coin] || `${coin}usdt`;
}

function handleMomentumSignal(signal: MomentumSignal): void {
  for (const market of activeMarkets) {
    const expectedSymbol = mapCoinToSymbol(market.coin);
    if (signal.symbol !== expectedSymbol) continue;

    const lastTime = lastSignalTime.get(market.coin) || 0;
    if (Date.now() - lastTime < SIGNAL_COOLDOWN_MS) continue;

    const timeLeft = market.windowEnd - Math.floor(Date.now() / 1000);
    if (timeLeft < 120 || timeLeft > 840) continue;

    // Get window start price for this market
    const snapshotKey = `${market.coin}-${market.windowStart}`;
    const windowStartPrice = windowStartPrices.get(snapshotKey);
    if (!windowStartPrice) continue; // Can't trade without reference price

    // Estimate probability: how likely is current price direction to hold?
    // Conservative model: use magnitude relative to volatility if available
    const state = priceStates.get(signal.symbol);
    const vol = state?.volatility || 0.001;
    // Z-score: how many volatility units has price moved
    const zScore = (signal.magnitude / 100) / Math.max(vol, 0.0005);
    // Cap the z-score to prevent overconfidence
    // Cap z-score and use very conservative probability mapping
    // z=1 -> 55%, z=2 -> 60%, z=3 -> 65% (max)
    // A 30s momentum tells you very little about 15-min outcome
    const cappedZ = Math.min(zScore, 3.0);
    const momentumProb = 0.50 + 0.05 * cappedZ;

    const currentPrice = signal.direction === "up" ? market.priceUp : market.priceDown;

    // Skip markets where odds are already extreme (below 35c or above 65c)
    // Momentum is only meaningful when market is uncertain (~50/50)
    if (currentPrice < 0.35 || currentPrice > 0.65) continue;

    const probEstimate = momentumProb;
    const edge = probEstimate - currentPrice;

    if (edge < 0.08) continue; // Need 8%+ edge to overcome noise

    const targetPrice = currentPrice + edge * 0.3;

    lastSignalTime.set(market.coin, Date.now());

    const tradeSignal: TradeSignal = {
      market,
      side: signal.direction,
      targetPrice: Math.round(targetPrice * 100) / 100,
      edgeEstimate: edge,
      momentum: signal,
      windowStartPrice,
    };

    console.log(
      `[HFScanner] SIGNAL: ${market.coin.toUpperCase()} ${signal.direction} ` +
      `momentum=${signal.magnitude.toFixed(2)}% z=${cappedZ.toFixed(1)} ` +
      `market=${(currentPrice * 100).toFixed(0)}c est=${(probEstimate * 100).toFixed(0)}% ` +
      `edge=${(edge * 100).toFixed(1)}% limit=${(targetPrice * 100).toFixed(0)}c ` +
      `timeLeft=${timeLeft}s`
    );

    for (const cb of tradeSignalCallbacks) {
      try { cb(tradeSignal); } catch { /* swallow */ }
    }
  }
}

// ---- Fast Scanner (Regular Markets) --------------------------------------

const flaggedForR1: FastScanResult[] = [];
let fastScanInterval: NodeJS.Timeout | null = null;

async function runFastScan(): Promise<FastScanResult[]> {
  const results: FastScanResult[] = [];

  try {
    const response = await fetchWithTimeout(
      `${GAMMA_API_URL}/markets?active=true&closed=false&limit=200`,
      { timeoutMs: 10000 }
    );

    if (!response.ok) return results;

    const markets = await response.json() as Array<{
      conditionId: string;
      question: string;
      outcomePrices: string;
      volume24hr: number;
      liquidityNum: number;
      endDate: string;
    }>;

    for (const market of markets) {
      try {
        const prices = JSON.parse(market.outcomePrices) as string[];
        // NegRisk only applies to binary markets (Yes/No)
        if (prices.length !== 2) continue;

        const yesPrice = parseFloat(prices[0]);
        const noPrice = parseFloat(prices[1]);
        if (isNaN(yesPrice) || isNaN(noPrice)) continue;
        if (yesPrice < 0.05 || yesPrice > 0.95) continue;
        if (market.volume24hr < 50) continue;

        // Binary market: Yes + No should sum to ~1.0
        const priceSum = yesPrice + noPrice;
        if (Math.abs(priceSum - 1.0) > 0.03) {
          results.push({
            marketId: market.conditionId,
            title: market.question,
            marketPrice: yesPrice,
            mathEstimate: yesPrice,
            edge: Math.abs(priceSum - 1.0) / 2,
            source: `negrisk-sum=${priceSum.toFixed(3)}`,
            flagForR1: false,
          });
        }
      } catch { /* skip */ }
    }

    // Paper trade NegRisk signals
    for (const r of results) {
      if (r.edge >= 0.02) {
        handleNegRiskSignal(r);
      }
    }

    // Check NegRisk position resolutions
    await checkNegRiskResolutions();

    // Flag high-edge for R1, with bounded queue
    for (const r of results) {
      if (r.edge > 0.05 && flaggedForR1.length < MAX_FLAGGED_R1) {
        r.flagForR1 = true;
        flaggedForR1.push(r);
      }
    }

    if (results.length > 0) {
      console.log(`[HFScanner] Fast scan: ${results.length} signals (${results.filter(r => r.flagForR1).length} flagged for R1)`);
    }
  } catch (err) {
    console.error("[HFScanner] Fast scan error:", err);
  }

  return results;
}

// ---- Paper Trading Simulator ---------------------------------------------

export interface HFPaperTrade {
  id: string;
  coin: string;
  side: "up" | "down";
  entryPrice: number;
  shares: number;
  size: number;
  entryTime: number;
  windowStart: number;
  windowEnd: number;
  windowStartPrice: number;
  binancePriceAtEntry: number;
  momentumAtEntry: number;
  edgeAtEntry: number;
  status: "open" | "won" | "lost";
  pnl: number;
  resolvedAt?: number;
  type: "momentum" | "negrisk";
}

export interface NegRiskPaperTrade {
  id: string;
  marketId: string;
  title: string;
  side: "YES" | "NO";
  entryPrice: number;
  shares: number;
  size: number;
  entryTime: number;
  entrySum: number;       // Yes+No sum at entry (e.g. 1.06)
  edgeAtEntry: number;
  status: "open" | "won" | "lost";
  pnl: number;
  resolvedAt?: number;
  type: "negrisk";
}

const PAPER_POSITION_SIZE = 10;
const NEGRISK_POSITION_SIZE = 5;
const NEGRISK_MAX_OPEN = 10;
const NEGRISK_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h max hold
const paperTrades: HFPaperTrade[] = [];
const negRiskTrades: NegRiskPaperTrade[] = [];
let paperBalance = 200;
let negRiskBalance = 100;
let resolutionCheckInterval: NodeJS.Timeout | null = null;

function handleTradeSignalPaper(signal: TradeSignal): void {
  const entryPrice = signal.side === "up" ? signal.market.priceUp : signal.market.priceDown;
  if (entryPrice <= 0.01 || entryPrice >= 0.99) return;
  if (paperBalance < PAPER_POSITION_SIZE) return;

  // Max 1 open trade per coin
  const hasOpen = paperTrades.some(t => t.coin === signal.market.coin && t.status === "open");
  if (hasOpen) return;

  const shares = PAPER_POSITION_SIZE / entryPrice;
  paperBalance -= PAPER_POSITION_SIZE;

  const trade: HFPaperTrade = {
    id: `hf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    coin: signal.market.coin,
    side: signal.side,
    entryPrice,
    shares,
    size: PAPER_POSITION_SIZE,
    entryTime: Date.now(),
    windowStart: signal.market.windowStart,
    windowEnd: signal.market.windowEnd,
    windowStartPrice: signal.windowStartPrice,
    binancePriceAtEntry: signal.momentum.binancePrice,
    momentumAtEntry: signal.momentum.magnitude,
    edgeAtEntry: signal.edgeEstimate,
    status: "open",
    pnl: 0,
    type: "momentum",
  };

  paperTrades.push(trade);

  // Bound paperTrades to prevent memory leak
  if (paperTrades.length > MAX_PAPER_TRADES) {
    // Remove oldest resolved trades
    const oldestResolved = paperTrades.findIndex(t => t.status !== "open");
    if (oldestResolved >= 0) paperTrades.splice(oldestResolved, 1);
  }

  console.log(
    `[HFPaper] OPEN: ${trade.coin.toUpperCase()} ${trade.side} ` +
    `${shares.toFixed(1)} shares @ ${(entryPrice * 100).toFixed(0)}c ($${PAPER_POSITION_SIZE}) ` +
    `edge=${(trade.edgeAtEntry * 100).toFixed(1)}% bal=$${paperBalance.toFixed(2)}`
  );
}

/**
 * Resolve paper trades by checking if Binance price is above/below
 * the WINDOW START PRICE (not entry price).
 */
function checkPaperResolutions(): void {
  const now = Math.floor(Date.now() / 1000);

  for (const trade of paperTrades) {
    if (trade.status !== "open") continue;
    if (now < trade.windowEnd) continue;

    const currentState = priceStates.get(mapCoinToSymbol(trade.coin));
    if (!currentState) {
      if (now - trade.windowEnd > 300) {
        trade.status = "lost";
        trade.pnl = -trade.size;
        trade.resolvedAt = Date.now();
        console.log(`[HFPaper] TIMEOUT: ${trade.coin.toUpperCase()} ${trade.side} -$${trade.size.toFixed(2)}`);
      }
      continue;
    }

    // Resolution: compare current Binance price to WINDOW START price
    // "Up" wins if price > window start, "Down" wins if price < window start
    const priceWentUp = currentState.price > trade.windowStartPrice;
    const won = (trade.side === "up" && priceWentUp) || (trade.side === "down" && !priceWentUp);

    if (won) {
      trade.status = "won";
      const payout = trade.shares * 1.0;
      trade.pnl = payout - trade.size;
      paperBalance += payout;
    } else {
      trade.status = "lost";
      trade.pnl = -trade.size;
    }

    trade.resolvedAt = Date.now();
    const pnlStr = trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;

    console.log(
      `[HFPaper] ${trade.status.toUpperCase()}: ${trade.coin.toUpperCase()} ${trade.side} ` +
      `${pnlStr} (entry=${(trade.entryPrice * 100).toFixed(0)}c, ` +
      `windowStart=$${trade.windowStartPrice.toFixed(2)}, ` +
      `resolved=$${currentState.price.toFixed(2)}) bal=$${paperBalance.toFixed(2)}`
    );
  }
}

// ---- NegRisk Paper Trading -----------------------------------------------

function handleNegRiskSignal(result: FastScanResult): void {
  if (negRiskBalance < NEGRISK_POSITION_SIZE) return;

  const openCount = negRiskTrades.filter(t => t.status === "open").length;
  if (openCount >= NEGRISK_MAX_OPEN) return;

  // Don't double up on same market
  if (negRiskTrades.some(t => t.marketId === result.marketId && t.status === "open")) return;

  // If sum > 1.0, both sides are overpriced. Buy the cheaper side (higher expected return)
  // If sum < 1.0, both sides are underpriced. Buy the cheaper side.
  const side: "YES" | "NO" = result.marketPrice <= 0.5 ? "YES" : "NO";
  const entryPrice = side === "YES" ? result.marketPrice : 1 - result.marketPrice;
  if (entryPrice <= 0.01 || entryPrice >= 0.99) return;

  const shares = NEGRISK_POSITION_SIZE / entryPrice;
  negRiskBalance -= NEGRISK_POSITION_SIZE;

  // Parse the sum from source string
  const sumMatch = result.source.match(/sum=([\d.]+)/);
  const entrySum = sumMatch ? parseFloat(sumMatch[1]) : 1.0;

  const trade: NegRiskPaperTrade = {
    id: `nr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    marketId: result.marketId,
    title: result.title,
    side,
    entryPrice,
    shares,
    size: NEGRISK_POSITION_SIZE,
    entryTime: Date.now(),
    entrySum,
    edgeAtEntry: result.edge,
    status: "open",
    pnl: 0,
    type: "negrisk",
  };

  negRiskTrades.push(trade);

  if (negRiskTrades.length > MAX_PAPER_TRADES) {
    const oldest = negRiskTrades.findIndex(t => t.status !== "open");
    if (oldest >= 0) negRiskTrades.splice(oldest, 1);
  }

  console.log(
    `[NRPaper] OPEN: ${side} "${trade.title.substring(0, 40)}" ` +
    `@ ${(entryPrice * 100).toFixed(0)}c ($${NEGRISK_POSITION_SIZE}) ` +
    `sum=${entrySum.toFixed(3)} edge=${(trade.edgeAtEntry * 100).toFixed(1)}% ` +
    `bal=$${negRiskBalance.toFixed(2)}`
  );
}

/**
 * Check NegRisk trades: resolve if prices converged or max age exceeded.
 * Re-fetches current prices for open positions.
 */
async function checkNegRiskResolutions(): Promise<void> {
  const openTrades = negRiskTrades.filter(t => t.status === "open");
  if (openTrades.length === 0) return;

  try {
    const response = await fetchWithTimeout(
      `${GAMMA_API_URL}/markets?active=true&closed=false&limit=200`,
      { timeoutMs: 10000 }
    );
    if (!response.ok) return;

    const markets = await response.json() as Array<{
      conditionId: string;
      outcomePrices: string;
      closed: boolean;
    }>;

    const priceMap = new Map<string, { yes: number; no: number; sum: number; closed: boolean }>();
    for (const m of markets) {
      try {
        const prices = JSON.parse(m.outcomePrices) as string[];
        if (prices.length !== 2) continue;
        const yes = parseFloat(prices[0]);
        const no = parseFloat(prices[1]);
        if (isNaN(yes) || isNaN(no)) continue;
        priceMap.set(m.conditionId, { yes, no, sum: yes + no, closed: !!m.closed });
      } catch { /* skip */ }
    }

    for (const trade of openTrades) {
      const current = priceMap.get(trade.marketId);
      const age = Date.now() - trade.entryTime;

      if (!current) {
        // Market no longer in active list - likely resolved
        if (age > 5 * 60 * 1000) {
          // Assume win (market resolved, our side likely paid $1)
          trade.status = "won";
          const payout = trade.shares * 1.0;
          trade.pnl = payout - trade.size;
          negRiskBalance += payout;
          trade.resolvedAt = Date.now();
          const pnlStr = `+$${trade.pnl.toFixed(2)}`;
          console.log(`[NRPaper] RESOLVED: "${trade.title.substring(0, 40)}" ${pnlStr}`);
        }
        continue;
      }

      const currentPrice = trade.side === "YES" ? current.yes : current.no;
      const currentSum = current.sum;

      // Exit conditions:
      // 1. Prices converged (sum within 1% of 1.0) - take profit
      // 2. Price moved in our favor by >5% - take profit
      // 3. Max age exceeded - close at current price
      // 4. Price moved against us by >15% - stop loss

      const priceChange = (currentPrice - trade.entryPrice) / trade.entryPrice;
      const converged = Math.abs(currentSum - 1.0) < 0.01;

      let shouldClose = false;
      let reason = "";

      if (converged) {
        shouldClose = true;
        reason = "converged";
      } else if (priceChange > 0.05) {
        shouldClose = true;
        reason = "take-profit";
      } else if (priceChange < -0.15) {
        shouldClose = true;
        reason = "stop-loss";
      } else if (age > NEGRISK_MAX_AGE_MS) {
        shouldClose = true;
        reason = "max-age";
      }

      if (shouldClose) {
        const payout = trade.shares * currentPrice;
        trade.pnl = payout - trade.size;
        trade.status = trade.pnl >= 0 ? "won" : "lost";
        negRiskBalance += payout;
        trade.resolvedAt = Date.now();

        const pnlStr = trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;
        console.log(
          `[NRPaper] ${trade.status.toUpperCase()}: "${trade.title.substring(0, 40)}" ` +
          `${pnlStr} (${reason}, sum=${currentSum.toFixed(3)}) bal=$${negRiskBalance.toFixed(2)}`
        );
      }
    }
  } catch {
    // Non-critical
  }
}

export function getNegRiskPaperStats(): {
  balance: number;
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  recentTrades: NegRiskPaperTrade[];
} {
  const closed = negRiskTrades.filter(t => t.status !== "open");
  const wins = closed.filter(t => t.status === "won").length;
  const losses = closed.filter(t => t.status === "lost").length;
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const recent = negRiskTrades.slice(-10).reverse();

  return {
    balance: negRiskBalance,
    totalTrades: negRiskTrades.length,
    openTrades: negRiskTrades.filter(t => t.status === "open").length,
    wins,
    losses,
    winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    totalPnl,
    recentTrades: recent,
  };
}

export function getHFPaperStats(): {
  balance: number;
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  recentTrades: HFPaperTrade[];
} {
  const closed = paperTrades.filter(t => t.status !== "open");
  const wins = closed.filter(t => t.status === "won").length;
  const losses = closed.filter(t => t.status === "lost").length;
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const recent = paperTrades.slice(-10).reverse();

  return {
    balance: paperBalance,
    totalTrades: paperTrades.length,
    openTrades: paperTrades.filter(t => t.status === "open").length,
    wins,
    losses,
    winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    totalPnl,
    recentTrades: recent,
  };
}

// ---- Public API ----------------------------------------------------------

let running = false;

export function onMomentumSignal(cb: (signal: MomentumSignal) => void): void {
  momentumCallbacks.push(cb);
}

export function onTradeSignal(cb: (signal: TradeSignal) => void): void {
  tradeSignalCallbacks.push(cb);
}

export function getFlaggedForR1(): FastScanResult[] {
  const copy = [...flaggedForR1];
  flaggedForR1.length = 0;
  return copy;
}

export function getPriceState(symbol: string): PriceState | undefined {
  return priceStates.get(symbol);
}

export function isBinanceConnected(): boolean {
  return binanceConnected;
}

export async function startHFScanner(): Promise<void> {
  if (running) return;
  running = true;

  console.log("[HFScanner] Starting high-frequency scanner...");

  connectBinance();

  onMomentumSignal(handleMomentumSignal);
  onTradeSignal(handleTradeSignalPaper);

  momentumCheckInterval = setInterval(checkMomentum, 1000);
  resolutionCheckInterval = setInterval(checkPaperResolutions, 10_000);

  // Non-fatal market fetch
  try {
    activeMarkets = await findCurrent15mMarkets();
    console.log(`[HFScanner] Found ${activeMarkets.length} active 15-min markets`);
  } catch (err) {
    console.warn("[HFScanner] Initial market fetch failed, will retry in 60s:", err);
    activeMarkets = [];
  }

  marketRefreshInterval = setInterval(async () => {
    try {
      activeMarkets = await findCurrent15mMarkets();
    } catch { /* non-critical */ }
  }, 60_000);

  fastScanInterval = setInterval(() => {
    void runFastScan();
  }, FAST_SCAN_INTERVAL_MS);

  console.log("[HFScanner] Running: Binance WS + 1s momentum + 30s fast scan + 60s market refresh");
}

export function stopHFScanner(): void {
  if (!running) return;
  running = false;

  // Cancel pending reconnect BEFORE closing WS
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (binanceWs) {
    // Remove close listener to prevent reconnect
    binanceWs.removeAllListeners("close");
    binanceWs.close();
    binanceWs = null;
  }
  if (momentumCheckInterval) {
    clearInterval(momentumCheckInterval);
    momentumCheckInterval = null;
  }
  if (marketRefreshInterval) {
    clearInterval(marketRefreshInterval);
    marketRefreshInterval = null;
  }
  if (fastScanInterval) {
    clearInterval(fastScanInterval);
    fastScanInterval = null;
  }
  if (resolutionCheckInterval) {
    clearInterval(resolutionCheckInterval);
    resolutionCheckInterval = null;
  }

  binanceConnected = false;
  reconnectAttempts = 0;
  priceStates.clear();
  momentumCallbacks.length = 0;
  tradeSignalCallbacks.length = 0;
  activeMarkets = [];
  lastSignalTime.clear();

  console.log("[HFScanner] Stopped");
}

export function resetHFPaperData(): void {
  paperTrades.length = 0;
  negRiskTrades.length = 0;
  paperBalance = 200;
  negRiskBalance = 100;
  console.log("[HFScanner] Paper data reset");
}

export function getHFScannerStatus(): {
  running: boolean;
  binanceConnected: boolean;
  trackedPairs: number;
  activeUpDownMarkets: number;
  pendingR1Flags: number;
} {
  return {
    running,
    binanceConnected,
    trackedPairs: priceStates.size,
    activeUpDownMarkets: activeMarkets.length,
    pendingR1Flags: flaggedForR1.length,
  };
}
