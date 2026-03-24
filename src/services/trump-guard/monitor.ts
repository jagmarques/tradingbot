import { loadEnv } from "../../config/env.js";
import { classifyPost } from "./classifier.js";
import { closePosition, getOpenQuantPositions } from "../hyperliquid/executor.js";
import { sendMessage } from "../telegram/bot.js";

// All RSS feeds to monitor (polled every few seconds)
const RSS_FEEDS = [
  { name: "Trump Truth Social", url: "https://trumpstruth.org/feed", intervalMs: 3_000 },
  { name: "Fed FOMC", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", intervalMs: 5_000 },
  { name: "Fed All Press", url: "https://www.federalreserve.gov/feeds/press_all.xml", intervalMs: 10_000 },
  { name: "Powell Speeches", url: "https://www.federalreserve.gov/feeds/s_t_powell.xml", intervalMs: 10_000 },
  { name: "White House", url: "https://www.whitehouse.gov/news/feed/", intervalMs: 30_000 },
  { name: "CFTC Enforcement", url: "https://www.cftc.gov/RSS/RSSENF/rssenf.xml", intervalMs: 30_000 },
  { name: "CFTC General", url: "https://www.cftc.gov/RSS/RSSGP/rssgp.xml", intervalMs: 30_000 },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", intervalMs: 15_000 },
  { name: "CoinTelegraph", url: "https://cointelegraph.com/rss", intervalMs: 15_000 },
];

const TAVILY_INTERVAL_MS = 180_000;
const COOLDOWN_MS = 30 * 60 * 1000;

let cooldownUntil = 0;
let cooldownBlockedDir: "long" | "short" | null = null;
const feedIntervals: ReturnType<typeof setInterval>[] = [];
let tavilyInterval: ReturnType<typeof setInterval> | null = null;

const seenGuids = new Set<string>();
const seenUrls = new Set<string>();

// News event emission for news-trading engine
let lastNewsEvent: { ts: number; direction: "long" | "short"; content: string } | null = null;

export function getLastNewsEvent() { return lastNewsEvent; }

export function isTrumpCooldownActive(direction?: "long" | "short"): boolean {
  if (Date.now() >= cooldownUntil) return false;
  if (!direction || !cooldownBlockedDir) return true;
  return direction === cooldownBlockedDir;
}

// Rate limit Groq calls (max 1 per 3 seconds)
let lastGroqCall = 0;

async function classifyAndAct(content: string): Promise<void> {
  const now = Date.now();
  if (now - lastGroqCall < 3_000) return; // skip if called too recently
  lastGroqCall = now;

  // Cooldown only blocks GARCH defense, not news classification
  // We always classify so the news-trading engine gets events
  const preview = content.slice(0, 80);
  const verdict = await classifyPost(content);

  if (verdict === "NEUTRAL") return; // silent on neutral

  // Emit news event for offensive news-trading engine (always, even during cooldown)
  const newsDirection = verdict === "BULLISH" ? "long" : "short";
  lastNewsEvent = { ts: Date.now(), direction: newsDirection as "long" | "short", content: preview };

  // Trigger news-trading immediately (dynamic import avoids circular dependency)
  import("../hyperliquid/news-trading-engine.js").then(m => m.runNewsTradingCycle()).catch(err => {
    console.error(`[TrumpGuard] News-trade error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Defense: only runs if not in cooldown (avoid closing the same direction twice)
  if (isTrumpCooldownActive()) {
    console.log(`[TrumpGuard] ${verdict} event emitted for news-trade, defense skipped (cooldown)`);
    return;
  }

  const closeDirection = verdict === "BULLISH" ? "short" : "long";
  console.log(`[TrumpGuard] New post: ${preview} -> ${verdict} -> closing ${closeDirection}s`);

  cooldownUntil = Date.now() + COOLDOWN_MS;
  cooldownBlockedDir = closeDirection === "short" ? "short" : "long";

  // Close GARCH positions in hurt direction (not news-trade, it manages its own)
  const positions = getOpenQuantPositions();
  const targets = positions.filter(p => p.direction === closeDirection && p.mode === "live" && p.tradeType === "garch-chan");

  for (const pos of targets) {
    try {
      await closePosition(pos.id, `trump-guard-${verdict.toLowerCase()}`);
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
    `${verdict}: ${preview}\n` +
    `Action: ${action}\n` +
    `Cooldown: 30min (${closeDirection}s blocked)`
  );
}

// Keywords that indicate crypto-relevant news (filter out noise from CoinDesk/CoinTelegraph)
const CRYPTO_KEYWORDS = /bitcoin|btc|crypto|ethereum|eth|regulation|sec |cftc|federal reserve|fomc|interest rate|tariff|executive order|ban|approve|etf|stablecoin|digital asset|trump|elon|musk|doge/i;

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
      if (!isCriticalFeed && !CRYPTO_KEYWORDS.test(item.content)) {
        seenGuids.add(item.guid); // safe to mark non-crypto as seen
        continue;
      }
      console.log(`[NewsGuard] ${feedName}: new post detected`);
      await classifyAndAct(item.content);
      seenGuids.add(item.guid); // only mark as seen AFTER classification
    }
    trimSeen();
  } catch {
    // silent - feeds may occasionally timeout
  }
}

// Rotate through multiple queries covering key people who move crypto
const TAVILY_QUERIES = [
  "Trump crypto Bitcoin latest statement",
  "Elon Musk Bitcoin Dogecoin crypto tweet",
  "SEC crypto regulation breaking news",
  "Federal Reserve interest rate crypto",
  "FOMC decision Bitcoin impact",
  "US government crypto executive order",
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
      await classifyAndAct(content);
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
