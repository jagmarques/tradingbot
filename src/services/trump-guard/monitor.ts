import { loadEnv } from "../../config/env.js";
import { classifyPost } from "./classifier.js";
import { closePosition, getOpenQuantPositions } from "../hyperliquid/executor.js";
import { sendMessage } from "../telegram/bot.js";

// All RSS feeds to monitor
const RSS_FEEDS = [
  // Crypto-specific (fast polling)
  { name: "Trump Truth Social", url: "https://trumpstruth.org/feed", intervalMs: 3_000 },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", intervalMs: 15_000 },
  { name: "CoinTelegraph", url: "https://cointelegraph.com/rss", intervalMs: 15_000 },
  // Central banks & regulators
  { name: "Fed FOMC", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", intervalMs: 5_000 },
  { name: "Fed All Press", url: "https://www.federalreserve.gov/feeds/press_all.xml", intervalMs: 10_000 },
  { name: "Powell Speeches", url: "https://www.federalreserve.gov/feeds/s_t_powell.xml", intervalMs: 10_000 },
  { name: "White House", url: "https://www.whitehouse.gov/news/feed/", intervalMs: 30_000 },
  { name: "CFTC Enforcement", url: "https://www.cftc.gov/RSS/RSSENF/rssenf.xml", intervalMs: 30_000 },
  { name: "CFTC General", url: "https://www.cftc.gov/RSS/RSSGP/rssgp.xml", intervalMs: 30_000 },
  // Global news (geopolitical, oil, war, economy)
  { name: "MarketWatch", url: "https://feeds.marketwatch.com/marketwatch/topstories/", intervalMs: 30_000 },
  { name: "Google News Business", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB", intervalMs: 60_000 },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", intervalMs: 60_000 },
  { name: "CNBC Economy", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258", intervalMs: 30_000 },
];

const TAVILY_INTERVAL_MS = 180_000;
const COOLDOWN_MS = 30 * 60 * 1000;

let cooldownUntil = 0;
let cooldownBlockedDir: "long" | "short" | null = null;
const feedIntervals: ReturnType<typeof setInterval>[] = [];
let tavilyInterval: ReturnType<typeof setInterval> | null = null;

const seenGuids = new Set<string>();
const seenUrls = new Set<string>();

// Source defaults from analysis of 3837 posts
// Trump: 68% noise, AI decides actual impact per post
const SOURCE_IMPACT: Record<string, "high" | "medium" | "low"> = {
  "Trump Truth Social": "medium",
  "Fed FOMC": "high",
  "White House": "medium",
  "CoinDesk": "medium",
  "CoinTelegraph": "medium",
  "CFTC Enforcement": "medium",
  "CFTC General": "low",
  "Fed All Press": "medium",
  "Powell Speeches": "high",
  "MarketWatch": "medium",
  "Google News Business": "low",
  "BBC World": "low",
  "CNBC Economy": "medium",
};

const IMPACT_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };

// News event emission for news-trading engine
let lastNewsEvent: { ts: number; direction: "long" | "short"; content: string; impact: "high" | "medium" | "low"; source: string; isBreaking: boolean } | null = null;

export function getLastNewsEvent() { return lastNewsEvent; }

export function isTrumpCooldownActive(direction?: "long" | "short"): boolean {
  if (Date.now() >= cooldownUntil) return false;
  if (!direction || !cooldownBlockedDir) return true;
  return direction === cooldownBlockedDir;
}

// Rate limit Groq calls (max 1 per 3 seconds)
let lastGroqCall = 0;

async function classifyAndAct(content: string, feedName?: string): Promise<void> {
  const now = Date.now();
  if (now - lastGroqCall < 3_000) return; // skip if called too recently
  lastGroqCall = now;

  // Cooldown only blocks GARCH defense, not news classification
  // We always classify so the news-trading engine gets events
  // Strip HTML for clean preview
  const cleanContent = content.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, " ").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  const preview = cleanContent.slice(0, 80) || content.slice(0, 80);
  const result = await classifyPost(content);

  if (result.sentiment === "NEUTRAL") return; // silent on neutral

  // Use higher of AI-classified impact and source default
  const sourceImpact = feedName ? (SOURCE_IMPACT[feedName] ?? "low") : "low";
  const impact = IMPACT_ORDER[result.impact] >= IMPACT_ORDER[sourceImpact] ? result.impact : sourceImpact;

  // Emit news event for offensive news-trading engine (always, even during cooldown)
  const newsDirection = result.sentiment === "BULLISH" ? "long" : "short";
  lastNewsEvent = { ts: Date.now(), direction: newsDirection as "long" | "short", content: preview, impact, source: feedName ?? "tavily", isBreaking: result.isBreaking };

  // Trigger news-trading immediately (dynamic import avoids circular dependency)
  import("../hyperliquid/news-trading-engine.js").then(m => m.runNewsTradingCycle()).catch(err => {
    console.error(`[TrumpGuard] News-trade error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Defense: only runs if not in cooldown (avoid closing the same direction twice)
  if (isTrumpCooldownActive()) {
    console.log(`[TrumpGuard] ${result.sentiment} event emitted for news-trade, defense skipped (cooldown)`);
    return;
  }

  const closeDirection = result.sentiment === "BULLISH" ? "short" : "long";
  console.log(`[TrumpGuard] New post: ${preview} -> ${result.sentiment} [${impact}] -> closing ${closeDirection}s`);

  cooldownUntil = Date.now() + COOLDOWN_MS;
  cooldownBlockedDir = closeDirection === "short" ? "short" : "long";

  // Close GARCH positions in hurt direction (not news-trade, it manages its own)
  const positions = getOpenQuantPositions();
  const targets = positions.filter(p => p.direction === closeDirection && p.mode === "live" && p.tradeType === "garch-chan");

  for (const pos of targets) {
    try {
      await closePosition(pos.id, `trump-guard-${result.sentiment.toLowerCase()}`);
    } catch (err) {
      console.error(`[TrumpGuard] Failed to close ${pos.pair} ${pos.direction}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const action = targets.length === 0
    ? `No ${closeDirection}s open`
    : `Closed ${targets.length} ${closeDirection}(s)`;
  console.log(`[TrumpGuard] ${action}, cooldown 30min`);

  const nlTime = new Date().toLocaleString("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  void sendMessage(
    `<b>NEWS ALERT</b> ${nlTime}\n` +
    `${result.sentiment}: ${preview}\n` +
    `Impact: ${impact.toUpperCase()}\n` +
    `Action: ${action}\n` +
    `Cooldown: 30min (${closeDirection}s blocked)`
  );
}

// Keywords for market-moving news (crypto + global macro)
const MARKET_MOVING_KEYWORDS = /bitcoin|btc|crypto|ethereum|eth|regulation|sec |cftc|federal reserve|fomc|interest rate|tariff|executive order|ban|approve|etf|stablecoin|digital asset|trump|elon|musk|doge|oil price|crude oil|opec|sanctions|war |ceasefire|peace deal|nuclear|iran|missile|invasion|recession|inflation|gdp |unemployment|debt ceiling|default|treasury|bond yield|dollar |stimulus|rate cut|rate hike|trade war|china.*trade|emergency/i;

function extractItems(xml: string): Array<{ guid: string; content: string }> {
  const items: Array<{ guid: string; content: string }> = [];
  // Match <item>...</item> blocks
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(xml)) !== null) {
    const block = im[1];
    // Extract guid or link as unique ID
    const guidMatch = block.match(/<guid[^>]*>(.*?)<\/guid>/);
    const linkMatch = block.match(/<link[^>]*>(.*?)<\/link>/);
    const guid = guidMatch?.[1]?.trim() || linkMatch?.[1]?.trim() || "";
    if (!guid) continue;
    // Extract content: try CDATA first, then plain description, then title
    const cdataMatch = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
    const plainDescMatch = block.match(/<description>([\s\S]*?)<\/description>/);
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const titleCdata = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
    let content = cdataMatch?.[1] || plainDescMatch?.[1] || titleCdata?.[1] || titleMatch?.[1] || guid;
    // Strip HTML tags
    content = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    items.push({ guid, content });
  }
  return items;
}

// Cap seenGuids at 5000 to prevent memory leak
function trimSeen(): void {
  if (seenGuids.size > 5000) {
    const arr = [...seenGuids];
    seenGuids.clear();
    for (const g of arr.slice(-3000)) seenGuids.add(g);
  }
  if (seenUrls.size > 2000) {
    const arr = [...seenUrls];
    seenUrls.clear();
    for (const u of arr.slice(-1000)) seenUrls.add(u);
  }
}

async function pollRss(feedName: string, feedUrl: string, isInit: boolean): Promise<void> {
  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return; // silent on errors to avoid log spam from many feeds
    const xml = await res.text();
    const items = extractItems(xml);

    if (isInit) {
      for (const item of items) seenGuids.add(item.guid);
      console.log(`[NewsGuard] ${feedName}: seeded ${items.length} posts`);
      return;
    }

    for (const item of items) {
      if (seenGuids.has(item.guid)) continue;
      const isCriticalFeed = feedName.includes("Trump") || feedName.includes("Fed") || feedName.includes("White House");
      if (!isCriticalFeed && !MARKET_MOVING_KEYWORDS.test(item.content)) {
        seenGuids.add(item.guid); // safe to mark non-crypto as seen
        continue;
      }
      console.log(`[NewsGuard] ${feedName}: new post detected`);
      await classifyAndAct(item.content, feedName);
      seenGuids.add(item.guid); // only mark as seen AFTER classification
    }
    trimSeen();
  } catch {
    // silent - feeds may occasionally timeout
  }
}

// Rotate through multiple queries covering key people who move crypto
const TAVILY_QUERIES = [
  // Crypto-specific
  "Trump crypto Bitcoin latest statement",
  "Elon Musk Bitcoin Dogecoin crypto tweet",
  "SEC crypto regulation breaking news",
  "Federal Reserve interest rate decision",
  "FOMC decision Bitcoin impact",
  "US government crypto executive order",
  // Global macro (moves crypto indirectly)
  "Iran war oil price breaking news",
  "Russia Ukraine ceasefire sanctions",
  "China trade tariff breaking news",
  "global economic crisis recession breaking",
  "oil price OPEC production cut",
  "US dollar treasury bond yield breaking",
];
let tavilyQueryIndex = 0;

async function pollTavily(): Promise<void> {
  const env = loadEnv();
  const apiKey = env.TAVILY_API_KEY_1;
  if (!apiKey) return;

  const query = TAVILY_QUERIES[tavilyQueryIndex % TAVILY_QUERIES.length];
  tavilyQueryIndex++;

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        topic: "news",
        time_range: "d",
        max_results: 3,
      }),
    });

    if (!res.ok) {
      if (res.status !== 432) console.log(`[TrumpGuard] Tavily error ${res.status}`);
      return;
    }

    const data = (await res.json()) as { results?: Array<{ url?: string; content?: string; title?: string }> };
    const results = data.results ?? [];

    for (const r of results) {
      const url = r.url ?? "";
      if (!url || seenUrls.has(url)) continue;
      const content = r.content ?? r.title ?? url;
      await classifyAndAct(content, "tavily");
      seenUrls.add(url); // only mark as seen AFTER classification
    }
  } catch (err) {
    console.log(`[TrumpGuard] Tavily error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function startTrumpGuard(): void {
  console.log(`[NewsGuard] Starting ${RSS_FEEDS.length} RSS feeds + Tavily monitoring`);

  // Init all feeds: seed existing posts, then start polling
  for (const feed of RSS_FEEDS) {
    void pollRss(feed.name, feed.url, true).then(() => {
      const interval = setInterval(() => {
        void pollRss(feed.name, feed.url, false);
      }, feed.intervalMs);
      feedIntervals.push(interval);
    });
  }

  // Tavily: rotating queries every 90s
  void pollTavily();
  tavilyInterval = setInterval(() => {
    void pollTavily();
  }, TAVILY_INTERVAL_MS);
}

export function stopTrumpGuard(): void {
  for (const interval of feedIntervals) clearInterval(interval);
  feedIntervals.length = 0;
  if (tavilyInterval) {
    clearInterval(tavilyInterval);
    tavilyInterval = null;
  }
  console.log("[NewsGuard] Stopped");
}
