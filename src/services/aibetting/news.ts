import type { PolymarketEvent, NewsItem } from "./types.js";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

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
    const sourceUrl = itemXml.match(/<source[^>]*url="([^"]*)"[^>]*>/)?.[1] || "";

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
        summary: cleanTitle,
        url: sourceUrl || link,
        publishedAt: pubDate,
      });
    }
  }

  return items;
}

function buildSearchQuery(market: PolymarketEvent): string {
  return market.title
    .replace(/^(Will|Is|Does|Has|Can|Are)\s+/i, "")
    .replace(/\?$/, "")
    .replace(/\bby\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}\b/gi, "")
    .replace(/\b(before|by)\s+(March|April|May|June|July|August|September|October|November|December|January|February)\s+\d{4}\b/gi, "")
    .replace(/\b\d{4}\b/g, "") // strip years
    .replace(/\bx\b/gi, "") // "Russia x Ukraine" -> "Russia Ukraine"
    .replace(/\bvs\.?\b/gi, "") // "Team A vs Team B"
    .replace(/[^\w\s'-]/g, " ") // strip special chars, keep apostrophes/hyphens
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function isArticleRelevant(articleText: string, marketTitle: string): boolean {
  const stopWords = new Set([
    "will", "the", "and", "for", "are", "but", "not", "has", "have",
    "been", "this", "that", "from", "with", "what", "when", "where",
    "how", "does", "can", "its", "his", "her", "they", "than", "more",
    "about", "before", "after", "between", "into", "over",
  ]);
  const keywords = marketTitle
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));
  if (keywords.length === 0) return true;
  const lowerContent = articleText.toLowerCase();
  const matched = keywords.filter((kw) => lowerContent.includes(kw)).length;
  return matched / keywords.length >= 0.15;
}

const PREDICTION_MARKET_TERMS = [
  "polymarket", "prediction market", "prediction markets",
  "betting odds", "betting market", "bettors lean",
  "bettors bet", "bettors wager", "kalshi", "metaculus",
  "manifold market", "predictit",
];

function isPredictionMarketContent(text: string): boolean {
  const lower = text.toLowerCase();
  return PREDICTION_MARKET_TERMS.some((term) => lower.includes(term));
}

function extractArticleText(html: string, url: string): string | null {
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document, { charThreshold: 100 });
    const article = reader.parse();
    if (article?.textContent) {
      const text = article.textContent.replace(/\s+/g, " ").trim();
      if (text.length > 200) return text.slice(0, 5000);
    }
  } catch {
    console.warn(`[News] Readability failed for ${url}`);
  }
  return null;
}

// Fetch article content from URL and extract text
async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();
    return extractArticleText(html, url);
  } catch {
    return null;
  }
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

    // Filter to last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentItems = items.filter((item) => {
      const pubTime = new Date(item.publishedAt).getTime();
      return pubTime > sevenDaysAgo;
    });

    // Filter out articles about prediction markets (circular contamination)
    const cleanItems = recentItems.filter((item) => {
      if (isPredictionMarketContent(item.title)) {
        console.log(`[News] Dropped prediction market article: ${item.title.slice(0, 80)}`);
        return false;
      }
      return true;
    });

    // Fetch article content for top 3 items in parallel
    const top3 = cleanItems.slice(0, 3);
    const contentResults = await Promise.allSettled(
      top3.map((item) => fetchArticleContent(item.url))
    );

    let contentFetched = 0;
    let contentDropped = 0;
    contentResults.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value) {
        // Check first 500 chars for prediction market content (circular contamination)
        if (isPredictionMarketContent(result.value.slice(0, 500))) {
          contentDropped++;
          console.log(`[News] Dropped prediction market content (${top3[index].source}): ${top3[index].title.slice(0, 80)}`);
        } else if (isArticleRelevant(result.value, market.title)) {
          top3[index].content = result.value;
          contentFetched++;
          console.log(`[News] Content preview (${top3[index].source}): ${result.value.slice(0, 200).replace(/\n/g, " ")}`);
        } else {
          contentDropped++;
          console.log(`[News] Dropped irrelevant article (${top3[index].source}): ${top3[index].title.slice(0, 80)}`);
        }
      }
    });

    const dropped = recentItems.length - cleanItems.length;
    console.log(
      `[News] Found ${recentItems.length} recent articles for "${query}"${dropped > 0 ? ` (${dropped} prediction market articles filtered)` : ""}`
    );
    if (contentFetched > 0) {
      console.log(`[News] Fetched content for ${contentFetched}/3 articles for "${query}"`);
    }

    return cleanItems;
  } catch (error) {
    console.error(`[News] Failed to fetch news for "${query}":`, error);
    return [];
  }
}

