import { fetchWithTimeout } from "../../utils/fetch.js";
import { GAMMA_API_URL } from "../../config/constants.js";

export async function checkMarketResolution(tokenId: string): Promise<{ resolved: boolean; finalPrice: number | null }> {
  try {
    const response = await fetchWithTimeout(`${GAMMA_API_URL}/markets?clob_token_ids=${tokenId}`);
    if (!response.ok) return { resolved: false, finalPrice: null };

    const markets = await response.json() as Array<{
      closed: boolean;
      clobTokenIds: string;
      outcomePrices: string;
    }>;

    if (markets.length === 0) return { resolved: false, finalPrice: null };

    const market = markets[0];
    if (!market.closed) return { resolved: false, finalPrice: null };

    const tokenIds = JSON.parse(market.clobTokenIds) as string[];
    const prices = JSON.parse(market.outcomePrices) as string[];
    const idx = tokenIds.indexOf(tokenId);

    if (idx >= 0) {
      const price = parseFloat(prices[idx]);
      return { resolved: true, finalPrice: isNaN(price) ? null : price };
    }

    return { resolved: false, finalPrice: null };
  } catch {
    return { resolved: false, finalPrice: null };
  }
}
