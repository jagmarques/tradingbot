import crypto from "crypto";
import { loadEnv } from "../../config/env.js";
import { getAddress } from "./wallet.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { CLOB_API_URL } from "../../config/constants.js";

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
    "POLY_PASSPHRASE": env.POLYMARKET_PASSPHRASE,
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
    const response = await fetchWithTimeout(`${CLOB_API_URL}${path}`, {
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

export async function validateApiConnection(): Promise<boolean> {
  try {
    const address = getAddress();
    const env = loadEnv();
    const hasApiKey = env.POLYMARKET_API_KEY.length > 0;
    const hasSecret = env.POLYMARKET_SECRET.length > 0;
    const hasPassphrase = env.POLYMARKET_PASSPHRASE.length > 0;

    if (hasApiKey && hasSecret && hasPassphrase) {
      console.log(`[Polymarket] Wallet: ${address} | API key configured`);
      return true;
    }

    console.error("[Polymarket] Missing API key, secret, or passphrase");
    return false;
  } catch (error) {
    console.error("[Polymarket] Wallet setup failed:", error);
    return false;
  }
}
