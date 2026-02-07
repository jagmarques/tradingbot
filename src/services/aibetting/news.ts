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

function buildSearchQuery(market: PolymarketEvent): string {
  // Clean title: remove question framing, keep substance
  return market.title
    .replace(/^Will\s+/i, "")
    .replace(/^Is\s+/i, "")
    .replace(/^Does\s+/i, "")
    .replace(/^Has\s+/i, "")
    .replace(/\?$/, "")
    .replace(/\bby\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// Fetch article content from URL and extract text
async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    // Strip script and style tags with their content
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[\s\S]*?<\/style>/gi, "");

    // Remove all HTML tags
    text = text.replace(/<[^>]+>/g, " ");

    // Decode HTML entities
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, " ");

    // Collapse whitespace
    text = text.replace(/\s+/g, " ").trim();

    // Truncate to 5000 chars per article
    return text.slice(0, 5000);
  } catch (error) {
    // Silent failure on timeout or network errors
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

    // Fetch article content for top 3 items in parallel
    const top3 = recentItems.slice(0, 3);
    const contentResults = await Promise.allSettled(
      top3.map((item) => fetchArticleContent(item.url))
    );

    let contentFetched = 0;
    contentResults.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value) {
        top3[index].content = result.value;
        contentFetched++;
      }
    });

    console.log(
      `[News] Found ${recentItems.length} recent articles for "${query}"`
    );
    if (contentFetched > 0) {
      console.log(`[News] Fetched content for ${contentFetched}/3 articles for "${query}"`);
    }

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
