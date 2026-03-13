import WebSocket from "ws";
import { getMarketIndex } from "./client.js";

const WSS_URL = "wss://mainnet.zklighter.elliot.ai/stream";
const STALE_MS = 10_000;
const RECONNECT_DELAY_MS = 3_000;

interface StreamPrice {
  mid: number;
  updatedAt: number;
}

const prices = new Map<string, StreamPrice>();
const marketToPair = new Map<number, string>();
let ws: WebSocket | null = null;
let started = false;

export function getStreamPrice(pair: string): number | null {
  const entry = prices.get(pair);
  if (!entry || Date.now() - entry.updatedAt > STALE_MS) return null;
  return entry.mid;
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
    console.error(`[LighterStream] Init failed: ${err instanceof Error ? err.message : String(err)}`);
    started = false; // allow retry
    return;
  }

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
