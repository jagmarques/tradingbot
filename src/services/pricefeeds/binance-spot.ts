import { createHmac } from "crypto";
import { loadEnv } from "../../config/env.js";

export interface SpotOrderResult {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  executedQty: string;
  avgPrice: string;
  status: string;
}

interface BinanceOrderResponse {
  orderId: number;
  symbol: string;
  side: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  fills?: Array<{ price: string; qty: string }>;
}

const BINANCE_API_URL = "https://api.binance.com";

/**
 * Check if Binance API credentials are configured
 */
export function hasBinanceCredentials(): boolean {
  const env = loadEnv();
  return env.BINANCE_API_KEY !== undefined && env.BINANCE_SECRET !== undefined;
}

/**
 * Generate HMAC-SHA256 signature for Binance API
 */
function generateSignature(queryString: string, secret: string): string {
  return createHmac("sha256", secret).update(queryString).digest("hex");
}

/**
 * Place a market order on Binance Spot
 *
 * @param symbol - Trading pair (e.g., "BTCUSDT")
 * @param side - BUY or SELL
 * @param quoteQty - Amount in quote currency (USDT) to trade
 * @returns SpotOrderResult on success, null on failure
 */
export async function placeMarketOrder(
  symbol: string,
  side: "BUY" | "SELL",
  quoteQty: number
): Promise<SpotOrderResult | null> {
  const env = loadEnv();

  if (!env.BINANCE_API_KEY || !env.BINANCE_SECRET) {
    console.log("[BinanceSpot] Cannot place order: missing API credentials");
    return null;
  }

  try {
    const timestamp = Date.now();
    const params = new URLSearchParams({
      symbol,
      side,
      type: "MARKET",
      quoteOrderQty: quoteQty.toFixed(2),
      timestamp: timestamp.toString(),
    });

    const signature = generateSignature(params.toString(), env.BINANCE_SECRET);
    params.append("signature", signature);

    const url = `${BINANCE_API_URL}/api/v3/order`;

    console.log(`[BinanceSpot] Placing ${side} market order: ${symbol} for $${quoteQty.toFixed(2)}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-MBX-APIKEY": env.BINANCE_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[BinanceSpot] Order failed (${response.status}): ${errorText}`);
      return null;
    }

    const data = (await response.json()) as BinanceOrderResponse;

    // Calculate average price from executed quantity and quote quantity
    const executedQty = parseFloat(data.executedQty);
    const cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty);
    const avgPrice = executedQty > 0 ? (cummulativeQuoteQty / executedQty).toFixed(8) : "0";

    const result: SpotOrderResult = {
      orderId: data.orderId.toString(),
      symbol: data.symbol,
      side: data.side as "BUY" | "SELL",
      executedQty: data.executedQty,
      avgPrice,
      status: data.status,
    };

    console.log(
      `[BinanceSpot] Order filled: ${result.side} ${result.executedQty} ${result.symbol} @ ${result.avgPrice}`
    );

    return result;
  } catch (err) {
    console.error("[BinanceSpot] Order error:", err instanceof Error ? err.message : err);
    return null;
  }
}
