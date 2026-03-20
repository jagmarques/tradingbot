import crypto from "crypto";
import { ethers } from "ethers";
import { ClobClient, Side } from "@polymarket/clob-client";
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

// ---- HMAC Auth (for read operations) -----------------------------------------

function generateSignature(
  method: string,
  path: string,
  timestamp: number,
  body: string = ""
): string {
  const env = loadEnv();
  const message = `${timestamp}${method}${path}${body}`;
  const secretBuffer = Buffer.from(env.POLYMARKET_SECRET, "base64");
  const hmac = crypto.createHmac("sha256", secretBuffer);
  hmac.update(message);
  return hmac.digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
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

// ---- SDK Client (for signed order operations) --------------------------------

let sdkClient: ClobClient | null = null;

function getSdkClient(): ClobClient {
  if (sdkClient) return sdkClient;

  const env = loadEnv();
  const wallet = new ethers.Wallet(env.POLYGON_PRIVATE_KEY);
  // ethers v6 compat: ClobClient expects _signTypedData (v5 method name)
  if (!(wallet as any)._signTypedData && wallet.signTypedData) {
    (wallet as any)._signTypedData = wallet.signTypedData.bind(wallet);
  }

  const clobUrl = process.env.CLOB_PROXY_URL || CLOB_API_URL;
  sdkClient = new ClobClient(clobUrl, 137, wallet as any, {
    key: env.POLYMARKET_API_KEY,
    secret: env.POLYMARKET_SECRET,
    passphrase: env.POLYMARKET_PASSPHRASE,
  });

  return sdkClient;
}

// ---- Public API --------------------------------------------------------------

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
  try {
    const client = getSdkClient();
    console.log(`[Polymarket] Placing ${payload.side} order: ${payload.size} @ ${payload.price}`);

    const resp = await client.createAndPostOrder({
      tokenID: payload.tokenId,
      side: payload.side === "BUY" ? Side.BUY : Side.SELL,
      price: parseFloat(payload.price),
      size: parseFloat(payload.size),
    });

    if (!resp || !resp.orderID) {
      console.error("[Polymarket] Order response missing orderID:", resp);
      return null;
    }

    console.log(`[Polymarket] Order placed: ${resp.orderID} status=${resp.status}`);
    return {
      id: resp.orderID,
      status: resp.status ?? "LIVE",
      tokenId: payload.tokenId,
      side: payload.side,
      price: payload.price,
      size: payload.size,
      sizeMatched: "0",
    };
  } catch (error) {
    console.error("[Polymarket] Order failed:", error);
    return null;
  }
}

export async function placeFokOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: string,
  size: string
): Promise<Order | null> {
  try {
    const client = getSdkClient();

    console.log(`[Polymarket] Placing FOK ${side} order: ${size} @ ${price}`);

    const resp = await client.createAndPostMarketOrder({
      tokenID: tokenId,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      price: parseFloat(price),
      amount: parseFloat(size),
    });

    if (!resp || !resp.orderID) {
      console.error("[Polymarket] FOK order failed");
      return null;
    }

    console.log(`[Polymarket] FOK order: ${resp.orderID} status=${resp.status}`);
    return {
      id: resp.orderID,
      status: resp.status ?? "MATCHED",
      tokenId,
      side,
      price,
      size,
      sizeMatched: size,
    };
  } catch (error) {
    console.error("[Polymarket] FOK order failed:", error);
    return null;
  }
}

export async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    const client = getSdkClient();
    await client.cancelOrder({ orderID: orderId } as any);
    return true;
  } catch (error) {
    console.error("[Polymarket] Cancel failed:", error);
    return false;
  }
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
