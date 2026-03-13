import WebSocket from "ws";
import axios from "axios";
import { getMarketIndex } from "./client.js";

const WSS_URL = "wss://mainnet.zklighter.elliot.ai/stream";
const REST_BASE = "https://mainnet.zklighter.elliot.ai";
const STALE_MS = 10_000;
const RECONNECT_DELAY_MS = 3_000;
const CANDLE_MS = 5 * 60 * 1000;
const MAX_CLOSED_CANDLES = 50;

interface StreamPrice {
  mid: number;
  updatedAt: number;
}

export interface LighterCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // USD volume
}

interface CandleBuilder {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PairCandles {
  current: CandleBuilder | null;
  closed: LighterCandle[];
}

const prices = new Map<string, StreamPrice>();
const candles = new Map<string, PairCandles>();
const marketToPair = new Map<number, string>();
let ws: WebSocket | null = null;
let started = false;

export function getStreamPrice(pair: string): number | null {
  const entry = prices.get(pair);
  if (!entry || Date.now() - entry.updatedAt > STALE_MS) return null;
  return entry.mid;
}

export function getLighterStreamCandles(pair: string, limit = 35): LighterCandle[] | null {
  const state = candles.get(pair);
  if (!state || state.closed.length === 0) return null;
  return state.closed.slice(-limit);
}

function bucketStart(tsMs: number): number {
  return Math.floor(tsMs / CANDLE_MS) * CANDLE_MS;
}

function processTrade(pair: string, price: number, usdVolume: number, tsMs: number): void {
  let state = candles.get(pair);
  if (!state) {
    state = { current: null, closed: [] };
    candles.set(pair, state);
  }

  const bucket = bucketStart(tsMs);

  if (!state.current) {
    state.current = { openTime: bucket, open: price, high: price, low: price, close: price, volume: usdVolume };
    return;
  }

  if (bucket === state.current.openTime) {
    state.current.high = Math.max(state.current.high, price);
    state.current.low = Math.min(state.current.low, price);
    state.current.close = price;
    state.current.volume += usdVolume;
    return;
  }

  // New bucket — close current candle, start new one
  state.closed.push({ ...state.current });
  if (state.closed.length > MAX_CLOSED_CANDLES) state.closed.shift();
  state.current = { openTime: bucket, open: price, high: price, low: price, close: price, volume: usdVolume };
}

async function bootstrapCandles(marketId: number, pair: string): Promise<void> {
  try {
    const resp = await axios.get<{ trades: Array<{ price: string; size: string; usd_amount: string; timestamp: number }> }>(
      `${REST_BASE}/api/v1/recentTrades?market_id=${marketId}&limit=100`,
      { timeout: 8000 },
    );
    const trades = resp.data.trades ?? [];
    // Oldest first — leave current candle open so live stream continues it
    for (const t of trades.slice().reverse()) {
      const price = parseFloat(t.price);
      const usdVol = parseFloat(t.usd_amount ?? "") || parseFloat(t.size) * price;
      processTrade(pair, price, usdVol, t.timestamp);
    }
  } catch {
    // Non-fatal: candles build up from live trades
  }
}

export async function startLighterPriceStream(pairs: string[]): Promise<void> {
  if (started) return;
  started = true;

  try {
    const resolved = await Promise.all(pairs.map(async p => ({ pair: p, id: await getMarketIndex(p) })));
    for (const { pair, id } of resolved) {
      if (id !== null) marketToPair.set(id, pair);
      else console.warn(`[LighterStream] No market index for ${pair} — will not stream`);
    }
    if (marketToPair.size === 0) throw new Error("No market IDs resolved");
    console.log(`[LighterStream] Resolved ${marketToPair.size}/${pairs.length} pairs`);
  } catch (err) {
    console.error(`[LighterStream] Init failed: ${err instanceof Error ? err.message : String(err)}, retrying in 30s`);
    started = false;
    setTimeout(() => void startLighterPriceStream(pairs), 30_000);
    return;
  }

  // Bootstrap candle history from recentTrades (current candle left open intentionally)
  await Promise.all(
    Array.from(marketToPair.entries()).map(([id, pair]) => bootstrapCandles(id, pair)),
  );

  connect();
}

function connect(): void {
  ws = new WebSocket(WSS_URL);

  ws.on("open", () => {
    console.log("[LighterStream] Connected");
    const sock = ws;
    if (!sock) return;
    for (const marketId of marketToPair.keys()) {
      sock.send(JSON.stringify({ type: "subscribe", channel: `ticker/${marketId}` }));
      sock.send(JSON.stringify({ type: "subscribe", channel: `trade/${marketId}` }));
    }
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;

      if (msg.type === "ping") {
        const sock = ws;
        if (sock) sock.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type === "update/ticker" && msg.ticker) {
        const ticker = msg.ticker as { s: string; a: { price: string }; b: { price: string } };
        const channel = (msg.channel as string) ?? "";
        const marketId = parseInt(channel.split(/[:/]/).pop() ?? "");
        const pair = marketToPair.get(marketId);
        if (!pair) return;
        const ask = parseFloat(ticker.a.price);
        const bid = parseFloat(ticker.b.price);
        if (isFinite(ask) && isFinite(bid) && ask > 0 && bid > 0) {
          prices.set(pair, { mid: (ask + bid) / 2, updatedAt: Date.now() });
        }
        return;
      }

      // Only handle live trade updates — skip subscribed/trade (overlaps with REST bootstrap)
      if (msg.type === "update/trade" && Array.isArray(msg.trades)) {
        const channel = (msg.channel as string) ?? "";
        const marketId = parseInt(channel.split(/[:/]/).pop() ?? "");
        const pair = marketToPair.get(marketId);
        if (!pair) return;
        for (const t of msg.trades as Array<{ price: string; size: string; usd_amount?: string; timestamp: number }>) {
          const price = parseFloat(t.price);
          const usdVol = parseFloat(t.usd_amount ?? "") || parseFloat(t.size) * price;
          if (isFinite(price) && isFinite(usdVol) && price > 0) {
            processTrade(pair, price, usdVol, t.timestamp);
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on("error", (err: Error) => {
    console.error(`[LighterStream] Error: ${err.message}`);
  });

  ws.on("close", () => {
    console.log(`[LighterStream] Disconnected — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
    ws = null;
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
}
