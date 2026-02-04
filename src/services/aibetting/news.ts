import type { PolymarketEvent, NewsItem } from "./types.js";

const GOOGLE_NEWS_RSS_URL = "https://news.google.com/rss/search";

// Simple XML parser for RSS feed
function parseRssItems(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const itemXml of itemMatches.slice(0, 10)) {
    const title = itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "";
    const link = itemXml.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "";
    const pubDate = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "";
    const source = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || "Unknown";

    // Clean up HTML entities
    const cleanTitle = title
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1");

    if (cleanTitle) {
      items.push({
        source,
        title: cleanTitle,
        summary: cleanTitle, // RSS doesn't always have description
        url: link,
        publishedAt: pubDate,
      });
    }
  }

  return items;
}

function extractKeywords(market: PolymarketEvent): string[] {
  // Focus on TITLE only - description often has noise
  const title = market.title;

  // Extract proper nouns (capitalized words) and numbers/years
  const properNouns = title.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
  const numbers = title.match(/\b\d{4}\b|\b\d+(?:st|nd|rd|th)?\b/g) || [];

  // Common stop words to filter
  const stopWords = new Set([
    "will", "the", "be", "to", "of", "and", "or", "in", "on", "at", "by",
    "for", "with", "this", "that", "it", "as", "from", "has", "have", "had",
    "do", "does", "did", "what", "when", "where", "who", "which", "how",
    "if", "than", "then", "so", "but", "not", "no", "yes", "can", "could",
    "would", "should", "may", "might", "before", "after", "during", "between",
  ]);

  // Filter proper nouns
  const filtered = properNouns.filter(
    (w) => w.length > 2 && !stopWords.has(w.toLowerCase())
  );

  // Combine proper nouns + years
  return [...filtered, ...numbers].slice(0, 5);
}

function buildSearchQuery(market: PolymarketEvent): string {
  const keywords = extractKeywords(market);

  // If no good keywords found, use title directly (cleaned)
  if (keywords.length === 0) {
    // Fall back to cleaned title
    return market.title
      .replace(/^Will\s+/i, "")
      .replace(/\?$/, "")
      .slice(0, 60);
  }

  return keywords.slice(0, 3).join(" ");
}

export async function fetchNewsForMarket(
  market: PolymarketEvent
): Promise<NewsItem[]> {
  const query = buildSearchQuery(market);

  if (!query) {
    console.log(`[News] No keywords for market: ${market.title}`);
    return [];
  }

  try {
    const url = `${GOOGLE_NEWS_RSS_URL}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TradingBot/1.0)",
      },
    });

    if (!response.ok) {
      console.error(`[News] Google News error: ${response.status}`);
      return [];
    }

    const xml = await response.text();
    const items = parseRssItems(xml);

    // Filter to last 24 hours
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentItems = items.filter((item) => {
      const pubTime = new Date(item.publishedAt).getTime();
      return pubTime > oneDayAgo;
    });

    console.log(
      `[News] Found ${recentItems.length} recent articles for "${query}"`
    );

    return recentItems;
  } catch (error) {
    console.error(`[News] Failed to fetch news for "${query}":`, error);
    return [];
  }
}

export async function fetchNewsForMarkets(
  markets: PolymarketEvent[]
): Promise<Map<string, NewsItem[]>> {
  const newsMap = new Map<string, NewsItem[]>();

  // Fetch in parallel with small delay to avoid rate limits
  for (const market of markets) {
    const news = await fetchNewsForMarket(market);
    newsMap.set(market.conditionId, news);

    // Small delay between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  return newsMap;
}
