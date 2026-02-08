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
        url: link || sourceUrl,
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

// Decode Google News redirect URLs to real article URLs
async function decodeGoogleNewsUrl(sourceUrl: string): Promise<string> {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname !== "news.google.com") return sourceUrl;

    const pathSegments = url.pathname.split("/");
    const articlesIdx = pathSegments.indexOf("articles");
    if (articlesIdx === -1 || articlesIdx >= pathSegments.length - 1) return sourceUrl;

    const articleId = pathSegments[articlesIdx + 1];

    // Fast path: older format has real URL embedded in base64 payload
    const decoded = Buffer.from(articleId.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const urlMatch = decoded.toString("latin1").match(/https?:\/\/[^\s\x00-\x1f"]+/);
    if (urlMatch && !urlMatch[0].includes("news.google.com")) return urlMatch[0];

    // Newer AU_yqL format: resolve via Google's batchexecute API
    return await fetchDecodedBatchExecute(articleId);
  } catch {
    console.warn(`[News] Failed to decode Google News URL: ${sourceUrl.slice(0, 80)}`);
    return sourceUrl;
  }
}

let lastGoogleDecode = 0;

async function fetchDecodedBatchExecute(articleId: string): Promise<string> {
  const fallbackUrl = "https://news.google.com/rss/articles/" + articleId;
  try {
    // Rate limit: wait at least 1s between Google News page fetches
    const wait = Math.max(0, lastGoogleDecode + 1000 - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGoogleDecode = Date.now();

    // Step 1: Fetch Google News article page to get signature + timestamp
    const pageUrl = `https://news.google.com/articles/${articleId}?hl=en-US&gl=US&ceid=US:en`;
    const controller1 = new AbortController();
    const timeout1 = setTimeout(() => controller1.abort(), 8000);

    const pageResp = await fetch(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": "CONSENT=PENDING+987",
      },
      signal: controller1.signal,
      redirect: "follow",
    });
    clearTimeout(timeout1);
    const html = await pageResp.text();

    const sgMatch = html.match(/data-n-a-sg="([^"]+)"/);
    const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);
    if (!sgMatch?.[1] || !tsMatch?.[1]) {
      console.warn(`[News] No signature/timestamp (${html.length} bytes, status ${pageResp.status})`);
      return fallbackUrl;
    }

    // Step 2: Call batchexecute with signature + timestamp to decode URL
    const payload = [
      "Fbv4je",
      `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${articleId}",${tsMatch[1]},"${sgMatch[1]}"]`,
    ];

    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), 5000);

    const batchResp = await fetch(
      "https://news.google.com/_/DotsSplashUi/data/batchexecute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal: controller2.signal,
        body: `f.req=${encodeURIComponent(JSON.stringify([[payload]]))}`,
      }
    );
    clearTimeout(timeout2);

    const batchText = await batchResp.text();
    const jsonLine = batchText.split("\n\n")[1];
    if (jsonLine) {
      const parsed = JSON.parse(JSON.parse(jsonLine)[0][2]);
      if (parsed[1] && typeof parsed[1] === "string" && parsed[1].startsWith("http")) {
        return parsed[1];
      }
    }

    return fallbackUrl;
  } catch {
    console.warn(`[News] batchexecute decode failed for article`);
    return fallbackUrl;
  }
}

// Fetch article content from URL and extract text
async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    const realUrl = await decodeGoogleNewsUrl(url);
    if (realUrl !== url) {
      console.log(`[News] Decoded: ${url.slice(0, 60)} -> ${realUrl.slice(0, 80)}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(realUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[News] Fetch failed (${response.status}): ${response.url}`);
      return null;
    }

    const html = await response.text();
    const finalUrl = response.url;
    const text = extractArticleText(html, finalUrl);
    if (!text) {
      console.warn(`[News] Readability extracted nothing from: ${finalUrl}`);
    }
    return text;
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    console.warn(`[News] Fetch error (${reason}): ${url.slice(0, 80)}`);
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

    // Fetch article content for top 3 items sequentially (avoid Google 429 rate limit)
    const top3 = cleanItems.slice(0, 3);
    let contentFetched = 0;
    for (let i = 0; i < top3.length; i++) {
      try {
        const content = await fetchArticleContent(top3[i].url);
        if (content) {
          if (isPredictionMarketContent(content.slice(0, 500))) {
            console.log(`[News] Dropped prediction market content (${top3[i].source}): ${top3[i].title.slice(0, 80)}`);
          } else if (isArticleRelevant(content, market.title)) {
            top3[i].content = content;
            contentFetched++;
            console.log(`[News] Content preview (${top3[i].source}): ${content.slice(0, 200).replace(/\n/g, " ")}`);
          } else {
            console.log(`[News] Dropped irrelevant article (${top3[i].source}): ${top3[i].title.slice(0, 80)}`);
          }
        }
      } catch {
        // continue to next article
      }
    }

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

