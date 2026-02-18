import type {
  PolymarketEvent,
  MarketOutcome,
  MarketCategory,
  AIBettingConfig,
} from "./types.js";
import { parseDate } from "../../utils/dates.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { GAMMA_API_URL } from "../../config/constants.js";

interface GammaMarket {
  conditionId: string;
  questionID: string;
  slug: string;
  question: string;
  description: string;
  endDate: string;
  volume24hr: number;
  liquidity: number;
  liquidityNum: number;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  active: boolean;
  closed: boolean;
  events?: { title: string }[];
}

function mapCategory(category: string): MarketCategory {
  const lower = category.toLowerCase();
  if (lower.includes("politic") || lower.includes("election")) return "politics";
  if (lower.includes("crypto") || lower.includes("bitcoin") || lower.includes("ethereum"))
    return "crypto";
  if (lower.includes("sport") || lower.includes("nfl") || lower.includes("nba"))
    return "sports";
  if (lower.includes("entertainment") || lower.includes("celebrity"))
    return "entertainment";
  if (lower.includes("science") || lower.includes("tech")) return "science";
  if (lower.includes("business") || lower.includes("company")) return "business";
  return "other";
}

function parseOutcomes(market: GammaMarket): MarketOutcome[] {
  const outcomes: MarketOutcome[] = [];

  try {
    const names = JSON.parse(market.outcomes) as string[];
    const prices = JSON.parse(market.outcomePrices) as string[];
    const tokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) as string[] : [];

    for (let i = 0; i < names.length; i++) {
      outcomes.push({
        tokenId: tokenIds[i] || "",
        name: names[i],
        price: parseFloat(prices[i]) || 0,
      });
    }
  } catch {
    // Fallback for simple Yes/No markets
    outcomes.push({ tokenId: "", name: "Yes", price: 0.5 });
    outcomes.push({ tokenId: "", name: "No", price: 0.5 });
  }

  return outcomes;
}

function mapToPolymarketEvent(market: GammaMarket): PolymarketEvent {
  // Get category from events if available
  const eventTitle = market.events?.[0]?.title || market.question || "";

  return {
    conditionId: market.conditionId,
    questionId: market.questionID,
    slug: market.slug,
    title: market.question,
    description: market.description || "",
    category: mapCategory(eventTitle),
    endDate: market.endDate,
    volume24h: market.volume24hr || 0,
    liquidity: market.liquidityNum || market.liquidity || 0,
    outcomes: parseOutcomes(market),
  };
}

export async function fetchActiveMarkets(maxMarkets: number = 500): Promise<PolymarketEvent[]> {
  const allMarkets: GammaMarket[] = [];
  const pageSize = 100;
  let offset = 0;

  try {
    while (allMarkets.length < maxMarkets) {
      const response = await fetchWithTimeout(
        `${GAMMA_API_URL}/markets?active=true&closed=false&limit=${pageSize}&offset=${offset}`
      );

      if (!response.ok) {
        throw new Error(`Gamma API error: ${response.status}`);
      }

      const markets = (await response.json()) as GammaMarket[];
      if (markets.length === 0) break;

      allMarkets.push(...markets);
      offset += pageSize;

      // Stop if we got less than a full page (no more results)
      if (markets.length < pageSize) break;
    }

    console.log(`[Scanner] Fetched ${allMarkets.length} markets via pagination`);
    return allMarkets.slice(0, maxMarkets).map(mapToPolymarketEvent);
  } catch (error) {
    console.error("[Scanner] Failed to fetch markets:", error);
    return [];
  }
}

export function filterCandidateMarkets(
  markets: PolymarketEvent[],
  config: AIBettingConfig,
  existingPositionMarketIds: Set<string>
): PolymarketEvent[] {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const maxDaysMs = 365 * oneDayMs;

  // Sports events resolve instantly (match ends -> 0c or 100c), so require more buffer
  const sportsMinDays = 7;
  const defaultMinDays = 1;

  const rejectReasons = {
    existingPosition: 0,
    volume: 0,
    noTokens: 0,
    endDate: 0,
    category: 0,
    extremePrice: 0,
  };

  const passed: PolymarketEvent[] = [];

  for (const market of markets) {
    // Skip markets we already have positions in
    if (existingPositionMarketIds.has(market.conditionId)) {
      rejectReasons.existingPosition++;
      continue;
    }

    // Must have sufficient volume (lowered from 500 to 100 for more opportunities)
    if (market.volume24h < 100) {
      rejectReasons.volume++;
      continue;
    }

    // Must have valid outcomes with token IDs
    if (!market.outcomes.some((o) => o.tokenId)) {
      rejectReasons.noTokens++;
      continue;
    }

    // Check end date - sports need 7+ days (instant resolution risk), others 1+ days
    const endTime = parseDate(market.endDate);
    if (endTime === null) {
      rejectReasons.endDate++;
      continue;
    }
    const timeUntilEnd = endTime - now;
    const minDays = market.category === "sports" ? sportsMinDays : defaultMinDays;

    if (timeUntilEnd < minDays * oneDayMs || timeUntilEnd > maxDaysMs) {
      rejectReasons.endDate++;
      continue;
    }

    // Check category is enabled
    if (!config.categoriesEnabled.includes(market.category)) {
      rejectReasons.category++;
      continue;
    }

    // Skip markets at extreme prices (likely already resolved in practice)
    const yesPrice = market.outcomes.find((o) => o.name === "Yes")?.price || 0.5;
    if (yesPrice < 0.05 || yesPrice > 0.95) {
      rejectReasons.extremePrice++;
      continue;
    }

    passed.push(market);
  }

  const rejected = markets.length - passed.length;
  if (rejected > 0) {
    const parts = Object.entries(rejectReasons)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${count}`);
    console.log(`[Scanner] Rejected: ${rejected} markets (${parts.join(", ")})`);
  }

  return passed;
}

export function scoreMarket(market: PolymarketEvent): number {
  let score = 0;

  // Higher volume = more liquid, easier to trade
  score += Math.min(market.volume24h / 10000, 10);

  // Higher liquidity = less slippage
  score += Math.min(market.liquidity / 5000, 5);

  // Prefer prices closer to 0.5 (more uncertainty = more opportunity)
  const yesPrice = market.outcomes.find((o) => o.name === "Yes")?.price || 0.5;
  const distanceFrom50 = Math.abs(yesPrice - 0.5);
  score += (0.5 - distanceFrom50) * 10;

  return score;
}

export async function fetchMarketByConditionId(conditionId: string, tokenId?: string): Promise<PolymarketEvent | null> {
  try {
    // Use clob_token_ids if available (reliable), fall back to condition_id
    const query = tokenId
      ? `clob_token_ids=${tokenId}`
      : `condition_id=${conditionId}`;
    const response = await fetchWithTimeout(
      `${GAMMA_API_URL}/markets?${query}&limit=1`
    );
    if (!response.ok) return null;
    const markets = (await response.json()) as GammaMarket[];
    if (markets.length === 0) return null;

    // Verify the returned market matches the expected conditionId
    if (markets[0].conditionId !== conditionId) {
      console.warn(`[Scanner] Market mismatch: expected ${conditionId}, got ${markets[0].conditionId} (${markets[0].question})`);
      return null;
    }

    return mapToPolymarketEvent(markets[0]);
  } catch (error) {
    console.error(`[Scanner] Failed to fetch market ${conditionId}:`, error);
    return null;
  }
}

export async function discoverMarkets(
  config: AIBettingConfig,
  existingPositionMarketIds: Set<string>,
  limit: number = 10
): Promise<PolymarketEvent[]> {
  console.log("[Scanner] Fetching active markets...");

  const allMarkets = await fetchActiveMarkets();
  console.log(`[Scanner] Found ${allMarkets.length} active markets`);

  const candidates = filterCandidateMarkets(
    allMarkets,
    config,
    existingPositionMarketIds
  );
  console.log(`[Scanner] ${candidates.length} markets pass filters`);

  // Sort by score and return top N
  const sorted = candidates.sort((a, b) => scoreMarket(b) - scoreMarket(a));

  return sorted.slice(0, limit);
}
