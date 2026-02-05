import type {
  PolymarketEvent,
  MarketOutcome,
  MarketCategory,
  AIBettingConfig,
} from "./types.js";
import { parseDate } from "../../utils/dates.js";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";

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
      const response = await fetch(
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
  const ninetyDaysMs = 90 * oneDayMs; // Extended from 7 to 90 days

  return markets.filter((market) => {
    // Skip markets we already have positions in
    if (existingPositionMarketIds.has(market.conditionId)) {
      return false;
    }

    // Must have sufficient volume (lowered from 1000 to 500 for more opportunities)
    if (market.volume24h < 500) {
      return false;
    }

    // Must have valid outcomes with token IDs
    if (!market.outcomes.some((o) => o.tokenId)) {
      return false;
    }

    // Check end date is within 1-90 days (extended window for more opportunities)
    const endTime = parseDate(market.endDate);
    if (endTime === null) {
      return false;
    }
    const timeUntilEnd = endTime - now;

    if (timeUntilEnd < oneDayMs || timeUntilEnd > ninetyDaysMs) {
      return false;
    }

    // Check category is enabled
    if (!config.categoriesEnabled.includes(market.category)) {
      return false;
    }

    // Skip markets at extreme prices (likely already resolved in practice)
    const yesPrice = market.outcomes.find((o) => o.name === "Yes")?.price || 0.5;
    if (yesPrice < 0.05 || yesPrice > 0.95) {
      return false;
    }

    return true;
  });
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
