import type { SocialSignal, SupportedChain } from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const GOOGLE_NEWS_RSS_URL = "https://news.google.com/rss/search";

// In-memory cache to avoid hammering APIs
const socialCache = new Map<
  string,
  { data: SocialSignal; expiresAt: number }
>();

/** Clear cache (exposed for testing) */
export function clearSocialCache(): void {
  socialCache.clear();
}

// Bullish/bearish keyword lists for sentiment heuristic
const BULLISH_KEYWORDS = ["moon", "pump", "buy", "bullish", "gem", "100x"];
const BEARISH_KEYWORDS = [
  "dump",
  "scam",
  "rug",
  "sell",
  "bearish",
  "honeypot",
];

// Narrative tag keyword mapping
const NARRATIVE_TAGS: Record<string, string[]> = {
  memecoin: ["meme", "memecoin"],
  AI: ["ai", "artificial intelligence"],
  defi: ["defi", "dex", "liquidity"],
  nft: ["nft"],
  gaming: ["gaming", "game"],
  rwa: ["rwa", "real world"],
};

/**
 * Collect social/news signals for a token.
 * Fetches Twitter and Google News in parallel.
 * Degrades gracefully: works without Twitter API key (news-only).
 * Returns null only if both sources fail.
 */
export async function collectSocialSignals(
  tokenSymbol: string,
  tokenAddress: string,
  chain: SupportedChain,
): Promise<SocialSignal | null> {
  const cacheKey = `${chain}:${tokenAddress}`;
  const cached = socialCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    console.log(
      `[TokenSocial] Cache hit for ${tokenSymbol} on ${chain}`,
    );
    return cached.data;
  }

  try {
    const [twitterResult, newsResult] = await Promise.allSettled([
      fetchTwitterSentiment(tokenSymbol),
      fetchTokenNews(tokenSymbol),
    ]);

    const twitter =
      twitterResult.status === "fulfilled" ? twitterResult.value : null;
    const news =
      newsResult.status === "fulfilled" ? newsResult.value : null;

    // Both failed -> return null
    if (!twitter && !news) {
      console.warn(
        `[TokenSocial] Both Twitter and News failed for ${tokenSymbol}`,
      );
      return null;
    }

    const result: SocialSignal = {
      tweetCount24h: twitter?.tweetCount ?? 0,
      sentiment: twitter?.sentiment ?? "unknown",
      newsItemCount: news?.itemCount ?? 0,
      topHeadlines: news?.headlines ?? [],
      narrativeTags: news?.narrativeTags ?? [],
      provider: twitter ? "twitter" : "google-news",
      raw: {
        ...(twitter?.raw ?? {}),
        newsHeadlines: news?.headlines ?? [],
      },
    };

    socialCache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    console.log(
      `[TokenSocial] Collected for ${tokenSymbol}: tweets=${result.tweetCount24h}, sentiment=${result.sentiment}, news=${result.newsItemCount}`,
    );

    return result;
  } catch (error) {
    console.warn(
      `[TokenSocial] Unexpected error for ${tokenSymbol}:`,
      error,
    );
    return null;
  }
}

/**
 * Fetch Twitter sentiment via twitterapi.io.
 * Returns null if no API key or on error.
 */
async function fetchTwitterSentiment(
  tokenSymbol: string,
): Promise<{
  tweetCount: number;
  sentiment: "bullish" | "bearish" | "neutral";
  raw: Record<string, unknown>;
} | null> {
  const apiKey = process.env.TWITTER_API_KEY;

  if (!apiKey) {
    console.log("[TokenSocial] No TWITTER_API_KEY, skipping Twitter");
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(
      "https://api.twitterapi.io/twitter/tweet/advanced_search",
      {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `$${tokenSymbol} OR ${tokenSymbol} crypto`,
          queryType: "Latest",
          cursor: "",
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[TokenSocial] Twitter API HTTP ${response.status} for ${tokenSymbol}`,
      );
      return null;
    }

    const json = (await response.json()) as {
      tweets?: Array<{ text?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };

    const tweets = json.tweets || [];
    const tweetCount = tweets.length;

    // Sentiment heuristic: count bullish vs bearish keyword matches
    let bullishCount = 0;
    let bearishCount = 0;

    for (const tweet of tweets) {
      const text = (tweet.text || "").toLowerCase();
      for (const keyword of BULLISH_KEYWORDS) {
        if (text.includes(keyword)) {
          bullishCount++;
          break;
        }
      }
      for (const keyword of BEARISH_KEYWORDS) {
        if (text.includes(keyword)) {
          bearishCount++;
          break;
        }
      }
    }

    let sentiment: "bullish" | "bearish" | "neutral" = "neutral";
    if (bullishCount > bearishCount * 1.5) {
      sentiment = "bullish";
    } else if (bearishCount > bullishCount * 1.5) {
      sentiment = "bearish";
    }

    return {
      tweetCount,
      sentiment,
      raw: json as Record<string, unknown>,
    };
  } catch (error) {
    console.warn(
      `[TokenSocial] Twitter fetch failed for ${tokenSymbol}:`,
      error,
    );
    return null;
  }
}

// Simple XML parser for RSS feed (adapted from aibetting/news.ts)
function parseRssItems(
  xml: string,
): Array<{ title: string; pubDate: string }> {
  const items: Array<{ title: string; pubDate: string }> = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const itemXml of itemMatches.slice(0, 10)) {
    const title = itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "";
    const pubDate =
      itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "";

    // Clean up HTML entities
    const cleanTitle = title
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1");

    if (cleanTitle) {
      items.push({ title: cleanTitle, pubDate });
    }
  }

  return items;
}

/**
 * Fetch Google News RSS headlines for a token.
 * Filters to last 3 days, extracts narrative tags.
 */
async function fetchTokenNews(
  tokenSymbol: string,
): Promise<{
  headlines: string[];
  itemCount: number;
  narrativeTags: string[];
} | null> {
  try {
    const query = encodeURIComponent(`${tokenSymbol} crypto`);
    const url = `${GOOGLE_NEWS_RSS_URL}?q=${query}&hl=en-US&gl=US&ceid=US:en`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TradingBot/1.0)",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[TokenSocial] Google News HTTP ${response.status} for ${tokenSymbol}`,
      );
      return null;
    }

    const xml = await response.text();
    const items = parseRssItems(xml);

    // Filter to last 3 days (tokens move faster than prediction markets)
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const recentItems = items.filter((item) => {
      const pubTime = new Date(item.pubDate).getTime();
      return pubTime > threeDaysAgo;
    });

    // Top 5 headlines
    const headlines = recentItems.slice(0, 5).map((item) => item.title);
    const itemCount = recentItems.length;

    // Extract narrative tags from headlines
    const allText = headlines.join(" ").toLowerCase();
    const narrativeTags: string[] = [];

    for (const [tag, keywords] of Object.entries(NARRATIVE_TAGS)) {
      if (keywords.some((kw) => allText.includes(kw))) {
        narrativeTags.push(tag);
      }
    }

    return { headlines, itemCount, narrativeTags };
  } catch (error) {
    console.warn(
      `[TokenSocial] Google News fetch failed for ${tokenSymbol}:`,
      error,
    );
    return null;
  }
}
