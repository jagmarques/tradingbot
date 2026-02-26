import https from "node:https";
import type { PolymarketEvent, NewsItem } from "./types.js";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const GDELT_API_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

// Cache news results per market (4h TTL) to avoid re-fetching + re-filtering same articles
const NEWS_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const newsCache = new Map<string, { items: NewsItem[]; cachedAt: number }>();

// Circuit breaker: after 3 consecutive full-retry-exhaustions, skip GDELT for 30 minutes
let gdeltConsecutiveFailures = 0;
let gdeltCooldownUntil = 0;
const GDELT_CIRCUIT_OPEN_THRESHOLD = 3;
const GDELT_COOLDOWN_MS = 30 * 60 * 1000;

export function isGdeltCircuitOpen(): boolean {
  return Date.now() < gdeltCooldownUntil;
}

function getCachedNews(marketId: string): NewsItem[] | null {
  const cached = newsCache.get(marketId);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > NEWS_CACHE_TTL_MS) {
    newsCache.delete(marketId);
    return null;
  }
  return cached.items;
}

function cacheNews(marketId: string, items: NewsItem[]): void {
  newsCache.set(marketId, { items, cachedAt: Date.now() });
}

interface GdeltArticle {
  url: string;
  title: string;
  seendate: string;
  domain: string;
  language: string;
  sourcecountry: string;
}

// Topic hints: when the cleaned query is too thin, enrich with context keywords
const TOPIC_HINTS: Record<string, string> = {
  revenue: "government revenue tariffs",
  tariff: "tariffs trade policy",
  deficit: "federal budget deficit spending",
  gdp: "economic growth GDP",
  inflation: "inflation consumer prices CPI",
  unemployment: "unemployment jobs labor market",
  interest: "interest rates federal reserve",
  impeach: "impeachment proceedings",
  approve: "approval rating poll",
  recession: "recession economic downturn",
  shutdown: "government shutdown funding",
  debt: "national debt ceiling",
};

function enrichQuery(query: string, originalTitle: string): string {
  const words = query.split(/\s+/).filter(w => w.length >= 4);
  if (words.length >= 3) return query;

  const lowerTitle = originalTitle.toLowerCase();
  const hints: string[] = [];
  for (const [keyword, expansion] of Object.entries(TOPIC_HINTS)) {
    if (lowerTitle.includes(keyword)) hints.push(expansion);
  }
  if (hints.length > 0) {
    const meaningful = query.split(/\s+/).filter(w => w.length >= 3);
    return (meaningful.join(" ") + " " + hints.join(" ")).trim().slice(0, 80);
  }
  return query;
}

function buildSearchQuery(market: PolymarketEvent): string {
  const cleaned = market.title
    .replace(/^(Will|Is|Does|Has|Can|Are)\s+/i, "")
    .replace(/\?$/, "")
    .replace(/\b([A-Za-z])\.([A-Za-z])(?:\.([A-Za-z]))?\.?/g, (_, a, b, c) => c ? `${a}${b}${c}` : `${a}${b}`)
    .replace(/\bby\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}\b/gi, "")
    .replace(/\b(before|by)\s+(March|April|May|June|July|August|September|October|November|December|January|February)\s+\d{4}\b/gi, "")
    .replace(/\b\d{4}\b/g, "")
    .replace(/\bx\b/gi, "")
    .replace(/\bvs\.?\b/gi, "")
    .replace(/\b(between|from)\s+\$?[\d.,]+\s*(?:b|m|k|t|billion|million|thousand|trillion)?\s*(and|to)\s+\$?[\d.,]+\s*(?:b|m|k|t|billion|million|thousand|trillion)?\b/gi, "")
    .replace(/\$[\d.,]+\s*(b|m|k|billion|million|thousand|trillion)?/gi, "")
    .replace(/\b[\d.,]+\s*(billion|million|thousand|trillion|percent)\b/gi, "")
    .replace(/\b\d+(?:st|nd|rd|th)\b/gi, "")
    .replace(/\b\d[\d.,]*[bmkt%]?\b/gi, "")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(in|of|to|at|by|for|from|between|with|on|the|and|than|over|under|about|into)\s+(in|of|to|at|by|for|from|between|with|on|the|and|than|over|under|about|into)\b/gi, "$1")
    .replace(/\b(in|of|to|at|by|for|from|between|with|on|the|and)\s*$/i, "")
    .replace(/^\s*(in|of|to|at|by|for|from|between|with|on|the|and)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const enriched = enrichQuery(cleaned, market.title);
  // GDELT rejects queries with any word < 3 chars
  return enriched.split(/\s+/).filter(w => w.length >= 3).join(" ");
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
  return matched >= 2 || matched / keywords.length >= 0.15;
}

function buildAlternativeQuery(title: string, originalQuery: string): string | null {
  // Extract key named entities and nouns (capitalized words, 4+ chars)
  const words = title.match(/\b[A-Z][a-z]{3,}\b/g) || [];
  const unique = [...new Set(words)];
  if (unique.length < 2) return null;
  // Take top 3-4 proper nouns, skip any that were already the entire original query
  const alt = unique.slice(0, 4).join(" ");
  if (alt === originalQuery) return null;
  return alt;
}

function httpsGet(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.on("error", reject);
  });
}

async function fetchGdeltArticles(query: string): Promise<GdeltArticle[]> {
  if (!query || query.split(/\s+/).filter(w => w.length >= 3).length === 0) return [];

  if (Date.now() < gdeltCooldownUntil) {
    return [];
  }

  const cleanedQuery = query.split(/\s+/).filter(w => w.length >= 3).join(" ");
  const fullQuery = `${cleanedQuery} sourcelang:eng`;
  const url = `${GDELT_API_URL}?query=${encodeURIComponent(fullQuery)}&mode=artlist&format=json&maxrecords=10&timespan=7d`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  };

  let responseText: string | null = null;
  let rateLimitedCount = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await httpsGet(url, headers, 30000);
      if (result.status === 429) {
        rateLimitedCount++;
        const backoff = (attempt + 1) * 5000;
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      if (result.status !== 200) {
        console.warn(`[News] GDELT HTTP ${result.status}`);
        return [];
      }
      gdeltConsecutiveFailures = 0;
      responseText = result.body;
      break;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`[News] GDELT fetch error after 3 attempts: ${err instanceof Error ? err.message : err}`);
        gdeltConsecutiveFailures++;
        if (gdeltConsecutiveFailures >= GDELT_CIRCUIT_OPEN_THRESHOLD) {
          gdeltCooldownUntil = Date.now() + GDELT_COOLDOWN_MS;
          console.warn(`[News] GDELT circuit open: ${gdeltConsecutiveFailures} consecutive failures, cooling down 30min`);
          gdeltConsecutiveFailures = 0;
        }
        return [];
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (rateLimitedCount === 3) {
    gdeltConsecutiveFailures++;
    if (gdeltConsecutiveFailures >= GDELT_CIRCUIT_OPEN_THRESHOLD) {
      gdeltCooldownUntil = Date.now() + GDELT_COOLDOWN_MS;
      console.warn(`[News] GDELT circuit open: ${gdeltConsecutiveFailures} consecutive 429s, cooling down 30min`);
      gdeltConsecutiveFailures = 0;
    }
    return [];
  }

  if (!responseText) return [];

  if (!responseText.startsWith("{")) {
    if (responseText.toLowerCase().includes("please limit") || responseText.toLowerCase().includes("rate limit")) {
      console.warn(`[News] GDELT rate limited: "${responseText.slice(0, 120)}"`);
    } else {
      console.warn(`[News] GDELT non-JSON response: "${responseText.slice(0, 120)}"`);
    }
    return [];
  }

  const data = JSON.parse(responseText) as { articles?: GdeltArticle[] };
  return data.articles ?? [];
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
      if (text.length > 200) return text.slice(0, 2000);
    }
  } catch {
    console.warn(`[News] Readability failed for ${url}`);
  }
  return null;
}

async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
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
    return extractArticleText(html, response.url);
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    console.warn(`[News] Fetch error (${reason}): ${url.slice(0, 80)}`);
    return null;
  }
}

export async function fetchNewsForMarket(
  market: PolymarketEvent
): Promise<NewsItem[]> {
  const cached = getCachedNews(market.conditionId);
  if (cached) return cached;

  const query = buildSearchQuery(market);

  if (!query) {
    console.log(`[News] No keywords for market: ${market.title}`);
    return [];
  }

  try {
    const articles = await fetchGdeltArticles(query);
    if (articles.length === 0) {
      console.log(`[News] No GDELT results for "${query}"`);
      return [];
    }

    const items: NewsItem[] = articles
      .filter((a) => !isPredictionMarketContent(a.title))
      .map((a) => ({
        source: a.domain,
        title: a.title,
        summary: a.title,
        url: a.url,
        publishedAt: a.seendate,
      }));

    // Fetch content for top 3
    const top3 = items.slice(0, 3);
    let contentFetched = 0;
    for (let i = 0; i < top3.length; i++) {
      try {
        const content = await fetchArticleContent(top3[i].url);
        if (content) {
          if (isPredictionMarketContent(content.slice(0, 500))) {
            console.log(`[News] Dropped prediction market content (${top3[i].source}): ${top3[i].title.slice(0, 80)}`);
          } else if (isArticleRelevant(top3[i].title + " " + content, market.title)) {
            top3[i].content = content;
            contentFetched++;
            console.log(`[News] Content (${top3[i].source}): ${content.slice(0, 150).replace(/\n/g, " ")}`);
          } else {
            console.log(`[News] Dropped irrelevant (${top3[i].source}): ${top3[i].title.slice(0, 80)}`);
          }
        }
      } catch (err) {
        console.warn(`[News] Failed to fetch content from ${top3[i].url}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // If <2 articles have content, retry with simplified query (no API call)
    if (contentFetched < 2) {
      const altQuery = buildAlternativeQuery(market.title, query);
      if (altQuery && altQuery !== query) {
        await new Promise(r => setTimeout(r, 6000));
        const altArticles = await fetchGdeltArticles(altQuery);
        const altItems = altArticles
          .filter(a => !isPredictionMarketContent(a.title))
          .filter(a => !items.some(existing => existing.url === a.url));

        for (const alt of altItems.slice(0, 2)) {
          const content = await fetchArticleContent(alt.url);
          if (content && !isPredictionMarketContent(content.slice(0, 500)) && isArticleRelevant(alt.title + " " + content, market.title)) {
            const item: NewsItem = { source: alt.domain, title: alt.title, summary: alt.title, url: alt.url, publishedAt: alt.seendate, content };
            items.push(item);
            contentFetched++;
            console.log(`[News] Alt content (${alt.domain}): ${content.slice(0, 150).replace(/\n/g, " ")}`);
          }
        }
        console.log(`[News] After retry: ${contentFetched} articles with content`);
      }
    }

    console.log(`[News] ${items.length} articles for "${query}", ${contentFetched}/3 fetched`);
    cacheNews(market.conditionId, items);
    return items;
  } catch (error) {
    console.error(`[News] Failed for "${query}":`, error);
    return [];
  }
}
