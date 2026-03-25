import { classifyPost } from "./classifier.js";
import { closePosition, getOpenQuantPositions } from "../hyperliquid/executor.js";
import { sendMessage } from "../telegram/bot.js";

// Only first-mover sources that actually move crypto before the market prices it in
const RSS_FEEDS = [
  { name: "Trump Truth Social", url: "https://trumpstruth.org/feed", intervalMs: 3_000 },
  { name: "Fed FOMC", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", intervalMs: 5_000 },
  { name: "Powell Speeches", url: "https://www.federalreserve.gov/feeds/s_t_powell.xml", intervalMs: 10_000 },
  { name: "White House", url: "https://www.whitehouse.gov/news/feed/", intervalMs: 30_000 },
];

const COOLDOWN_MS = 30 * 60 * 1000;

let cooldownUntil = 0;
let cooldownBlockedDir: "long" | "short" | null = null;
const feedIntervals: ReturnType<typeof setInterval>[] = [];

const seenGuids = new Set<string>();

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

async function classifyAndAct(content: string, feedName?: string, articleUrl?: string): Promise<void> {
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

  // All remaining sources are first-mover (Trump, Fed, White House) - use AI impact directly
  const impact = result.impact;

  // Emit news event for offensive news-trading engine (always, even during cooldown)
  const newsDirection = result.sentiment === "BULLISH" ? "long" : "short";
  lastNewsEvent = { ts: Date.now(), direction: newsDirection as "long" | "short", content: preview, impact, source: feedName ?? "tavily", isBreaking: result.isBreaking };

  // Send news alert BEFORE opening trades
  const nlTime = new Date().toLocaleString("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const linkLine = articleUrl ? `\n<a href="${articleUrl}">Read article</a>` : "";
  void sendMessage(
    `<b>NEWS DETECTED</b> ${nlTime}\n` +
    `${result.sentiment} ${impact.toUpperCase()} ${result.isBreaking ? "BREAKING" : "OPINION"}\n` +
    `Source: ${feedName ?? "tavily"}\n` +
    `${preview}${linkLine}`
  );

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

  if (targets.length > 0) {
    console.log(`[TrumpGuard] Closed ${targets.length} ${closeDirection}(s), cooldown 30min`);
    const nlTime = new Date().toLocaleString("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    void sendMessage(
      `<b>NEWS ALERT</b> ${nlTime}\n` +
      `${result.sentiment}: ${preview}\n` +
      `Impact: ${impact.toUpperCase()}\n` +
      `Closed ${targets.length} GARCH ${closeDirection}(s)\n` +
      `Cooldown: 30min`
    );
  } else {
    console.log(`[TrumpGuard] No ${closeDirection}s open, cooldown 30min`);
  }
}

// Keywords for market-moving news (crypto + global macro)
const MARKET_MOVING_KEYWORDS = /bitcoin|btc|crypto|ethereum|eth|regulation|sec |cftc|federal reserve|fomc|interest rate|tariff|executive order|ban|approve|etf|stablecoin|digital asset|trump|elon|musk|doge|oil price|crude oil|opec|sanctions|war |ceasefire|peace deal|nuclear|iran|missile|invasion|recession|inflation|gdp |unemployment|debt ceiling|default|treasury|bond yield|dollar |stimulus|rate cut|rate hike|trade war|china.*trade|emergency/i;

function extractItems(xml: string): Array<{ guid: string; content: string; link: string }> {
  const items: Array<{ guid: string; content: string; link: string }> = [];
  // Match <item>...</item> blocks
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(xml)) !== null) {
    const block = im[1];
    // Extract guid or link as unique ID
    const guidMatch = block.match(/<guid[^>]*>(.*?)<\/guid>/);
    const linkMatch = block.match(/<link[^>]*>(.*?)<\/link>/);
    const link = linkMatch?.[1]?.trim() || guidMatch?.[1]?.trim() || "";
    const guid = guidMatch?.[1]?.trim() || link;
    if (!guid) continue;
    // Extract content: try CDATA first, then plain description, then title
    const cdataMatch = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
    const plainDescMatch = block.match(/<description>([\s\S]*?)<\/description>/);
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const titleCdata = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
    let content = cdataMatch?.[1] || plainDescMatch?.[1] || titleCdata?.[1] || titleMatch?.[1] || guid;
    // Strip HTML tags
    content = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    items.push({ guid, content, link });
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
      await classifyAndAct(item.content, feedName, item.link);
      seenGuids.add(item.guid); // only mark as seen AFTER classification
    }
    trimSeen();
  } catch {
    // silent - feeds may occasionally timeout
  }
}

export function startTrumpGuard(): void {
  console.log(`[NewsGuard] Starting ${RSS_FEEDS.length} first-mover RSS feeds (Tavily disabled - too noisy)`);

  // Init all feeds: seed existing posts, then start polling
  for (const feed of RSS_FEEDS) {
    void pollRss(feed.name, feed.url, true).then(() => {
      const interval = setInterval(() => {
        void pollRss(feed.name, feed.url, false);
      }, feed.intervalMs);
      feedIntervals.push(interval);
    });
  }
}

export function stopTrumpGuard(): void {
  for (const interval of feedIntervals) clearInterval(interval);
  feedIntervals.length = 0;
  console.log("[NewsGuard] Stopped");
}
