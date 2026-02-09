import crypto from "crypto";
import { loadEnv } from "../../config/env.js";
import { getAddress } from "./wallet.js";

const CLOB_API_URL = "https://clob.polymarket.com";

interface OrderPayload {
  tokenId: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  feeRateBps?: number;
  nonce?: number;
  expiration?: number;
}

interface Order {
  id: string;
  status: string;
  tokenId: string;
  side: string;
  price: string;
  size: string;
  sizeMatched: string;
}

interface Market {
  conditionId: string;
  questionId: string;
  tokens: Array<{
    tokenId: string;
    outcome: string;
  }>;
}

function generateSignature(
  method: string,
  path: string,
  timestamp: number,
  body: string = ""
): string {
  const env = loadEnv();
  const message = `${timestamp}${method}${path}${body}`;
  const hmac = crypto.createHmac("sha256", env.POLYMARKET_SECRET);
  hmac.update(message);
  return hmac.digest("hex");
}

function getHeaders(method: string, path: string, body: string = ""): Record<string, string> {
  const env = loadEnv();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = generateSignature(method, path, timestamp, body);

  return {
    "Content-Type": "application/json",
    "POLY_ADDRESS": getAddress(),
    "POLY_SIGNATURE": signature,
    "POLY_TIMESTAMP": timestamp.toString(),
    "POLY_API_KEY": env.POLYMARKET_API_KEY,
  };
}

async function request<T>(
  method: string,
  path: string,
  body?: object
): Promise<T | null> {
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = getHeaders(method, path, bodyStr);

  try {
    const response = await fetch(`${CLOB_API_URL}${path}`, {
      method,
      headers,
      body: bodyStr || undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Polymarket] API error ${response.status}: ${error}`);
      return null;
    }

    return (await response.json()) as T;
  } catch (error) {
    console.error("[Polymarket] Request failed:", error);
    return null;
  }
}

export async function getMarket(conditionId: string): Promise<Market | null> {
  return request<Market>("GET", `/markets/${conditionId}`);
}

export async function getOrderbook(
  tokenId: string
): Promise<{ bids: Array<[string, string]>; asks: Array<[string, string]> } | null> {
  return request("GET", `/book?token_id=${tokenId}`);
}

export async function getMidpointPrice(tokenId: string): Promise<number | null> {
  const book = await getOrderbook(tokenId);
  if (!book || book.bids.length === 0 || book.asks.length === 0) {
    return null;
  }

  const bestBid = parseFloat(book.bids[0][0]);
  const bestAsk = parseFloat(book.asks[0][0]);
  return (bestBid + bestAsk) / 2;
}

export async function placeOrder(payload: OrderPayload): Promise<Order | null> {
  const nonce = payload.nonce ?? Date.now();
  const expiration = payload.expiration ?? Math.floor(Date.now() / 1000) + 60;

  const orderPayload = {
    ...payload,
    nonce,
    expiration,
    feeRateBps: payload.feeRateBps ?? 0,
  };

  console.log(`[Polymarket] Placing ${payload.side} order: ${payload.size} @ ${payload.price}`);
  return request<Order>("POST", "/order", orderPayload);
}

export async function placeFokOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: string,
  size: string
): Promise<Order | null> {
  // FOK (Fill or Kill) - order must be filled immediately or cancelled
  const order = await placeOrder({
    tokenId,
    side,
    price,
    size,
  });

  if (!order) {
    console.error("[Polymarket] FOK order failed to place");
    return null;
  }

  // Check if fully filled
  if (order.sizeMatched !== order.size) {
    console.log(`[Polymarket] FOK order partially filled, cancelling remainder`);
    await cancelOrder(order.id);
    return null;
  }

  console.log(`[Polymarket] FOK order filled: ${order.id}`);
  return order;
}

export async function cancelOrder(orderId: string): Promise<boolean> {
  const result = await request<{ success: boolean }>("DELETE", `/order/${orderId}`);
  return result?.success ?? false;
}

export async function getOpenOrders(): Promise<Order[]> {
  const result = await request<Order[]>("GET", "/open-orders");
  return result ?? [];
}

export async function cancelAllOrders(): Promise<number> {
  const orders = await getOpenOrders();
  let cancelled = 0;

  for (const order of orders) {
    if (await cancelOrder(order.id)) {
      cancelled++;
    }
  }

  console.log(`[Polymarket] Cancelled ${cancelled} orders`);
  return cancelled;
}

export async function validateApiConnection(): Promise<boolean> {
  try {
    const address = getAddress();
    const headers = getHeaders("GET", "/open-orders");

    const response = await fetch(`${CLOB_API_URL}/open-orders`, {
      method: "GET",
      headers,
    });

    if (response.ok) {
      console.log(`[Polymarket] API key verified for wallet ${address.slice(0, 6)}...${address.slice(-4)}`);
      return true;
    }

    console.error(`[Polymarket] API key verification failed (HTTP ${response.status}) - key may not match wallet`);
    return false;
  } catch (error) {
    console.error("[Polymarket] API connection failed:", error);
    return false;
  }
}
