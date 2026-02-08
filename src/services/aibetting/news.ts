import type { PolymarketEvent, NewsItem } from "./types.js";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const GDELT_API_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

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
    .replace(/\b([A-Z])\.([A-Z])\.?/g, "$1$2")
    .replace(/\bby\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}\b/gi, "")
    .replace(/\b(before|by)\s+(March|April|May|June|July|August|September|October|November|December|January|February)\s+\d{4}\b/gi, "")
    .replace(/\b\d{4}\b/g, "")
    .replace(/\bx\b/gi, "")
    .replace(/\bvs\.?\b/gi, "")
    .replace(/\b(between|from)\s+\$?[\d.,]+\s*[bmkt]?\s*(and|to)\s+\$?[\d.,]+\s*[bmkt]?\b/gi, "")
    .replace(/\$[\d.,]+\s*(b|m|k|billion|million|thousand|trillion)?/gi, "")
    .replace(/\b[\d.,]+\s*(billion|million|thousand|trillion|percent)\b/gi, "")
    .replace(/\b\d[\d.,]*[bmkt]?\b/gi, "")
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
  const query = buildSearchQuery(market);

  if (!query) {
    console.log(`[News] No keywords for market: ${market.title}`);
    return [];
  }

  try {
    const url = `${GDELT_API_URL}?query=${encodeURIComponent(query)}+sourcelang:eng&mode=artlist&format=json&maxrecords=10&timespan=7d`;

    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.status !== 429) break;
        const backoff = (attempt + 1) * 5000;
        console.warn(`[News] GDELT 429, retrying in ${backoff / 1000}s...`);
        await new Promise(r => setTimeout(r, backoff));
      } catch {
        clearTimeout(timeout);
        if (attempt === 2) throw new Error("GDELT fetch failed after retries");
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (!response || !response.ok) {
      console.error(`[News] GDELT error: ${response?.status ?? "no response"}`);
      return [];
    }

    const text = await response.text();
    if (!text.startsWith("{")) {
      console.log(`[News] No GDELT results for "${query}"`);
      return [];
    }
    const data = JSON.parse(text) as { articles?: GdeltArticle[] };
    const articles = data.articles ?? [];

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
          } else if (isArticleRelevant(content, market.title)) {
            top3[i].content = content;
            contentFetched++;
            console.log(`[News] Content (${top3[i].source}): ${content.slice(0, 150).replace(/\n/g, " ")}`);
          } else {
            console.log(`[News] Dropped irrelevant (${top3[i].source}): ${top3[i].title.slice(0, 80)}`);
          }
        }
      } catch {
        // continue
      }
    }

    console.log(`[News] ${items.length} articles for "${query}", ${contentFetched}/3 fetched`);
    return items;
  } catch (error) {
    console.error(`[News] Failed for "${query}":`, error);
    return [];
  }
}
