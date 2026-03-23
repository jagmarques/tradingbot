import { loadEnv } from "../../config/env.js";
import { classifyPost } from "./classifier.js";
import { closePosition, getOpenQuantPositions } from "../hyperliquid/executor.js";

// All RSS feeds to monitor (polled every few seconds)
const RSS_FEEDS = [
  { name: "Trump Truth Social", url: "https://trumpstruth.org/feed", intervalMs: 3_000 },
  { name: "Fed FOMC", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", intervalMs: 5_000 },
  { name: "Fed All Press", url: "https://www.federalreserve.gov/feeds/press_all.xml", intervalMs: 10_000 },
  { name: "Powell Speeches", url: "https://www.federalreserve.gov/feeds/s_t_powell.xml", intervalMs: 10_000 },
  { name: "White House", url: "https://www.whitehouse.gov/news/feed/", intervalMs: 10_000 },
  { name: "CFTC Enforcement", url: "https://www.cftc.gov/RSS/RSSENF/rssenf.xml", intervalMs: 30_000 },
  { name: "CFTC General", url: "https://www.cftc.gov/RSS/RSSGP/rssgp.xml", intervalMs: 30_000 },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", intervalMs: 15_000 },
  { name: "CoinTelegraph", url: "https://cointelegraph.com/rss", intervalMs: 15_000 },
];

const TAVILY_INTERVAL_MS = 90_000;
const COOLDOWN_MS = 30 * 60 * 1000;
const TRADE_TYPE = "garch-chan";

let cooldownUntil = 0;
const feedIntervals: ReturnType<typeof setInterval>[] = [];
let tavilyInterval: ReturnType<typeof setInterval> | null = null;

const seenGuids = new Set<string>();
const seenUrls = new Set<string>();

export function isTrumpCooldownActive(): boolean {
  return Date.now() < cooldownUntil;
}

async function classifyAndAct(content: string): Promise<void> {
  const preview = content.slice(0, 80);
  const verdict = await classifyPost(content);

  if (verdict === "NEUTRAL") {
    console.log(`[TrumpGuard] New post: ${preview} -> ${verdict} -> no action`);
    return;
  }

  const closeDirection = verdict === "BULLISH" ? "short" : "long";
  console.log(`[TrumpGuard] New post: ${preview} -> ${verdict} -> closing ${closeDirection}s`);

  cooldownUntil = Date.now() + COOLDOWN_MS;

  const positions = getOpenQuantPositions();
  const targets = positions.filter(p => p.tradeType === TRADE_TYPE && p.direction === closeDirection);

  for (const pos of targets) {
    try {
      await closePosition(pos.id, `trump-guard-${verdict.toLowerCase()}`);
    } catch (err) {
      console.error(`[TrumpGuard] Failed to close ${pos.pair} ${pos.direction}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (targets.length === 0) {
    console.log(`[TrumpGuard] No ${closeDirection} positions to close`);
  } else {
    console.log(`[TrumpGuard] Closed ${targets.length} ${closeDirection} position(s), cooldown active 30min`);
  }
}

function extractItems(xml: string): Array<{ guid: string; content: string }> {
  const items: Array<{ guid: string; content: string }> = [];
  const guidRe = /<guid[^>]*>(.*?)<\/guid>/g;
  const descRe = /<description><!\[CDATA\[(.*?)\]\]><\/description>/gs;

  const guids: string[] = [];
  let gm: RegExpExecArray | null;
  while ((gm = guidRe.exec(xml)) !== null) {
    guids.push(gm[1].trim());
  }

  const descs: string[] = [];
  let dm: RegExpExecArray | null;
  while ((dm = descRe.exec(xml)) !== null) {
    descs.push(dm[1].trim());
  }

  for (let i = 0; i < guids.length; i++) {
    items.push({ guid: guids[i], content: descs[i] ?? guids[i] });
  }
  return items;
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
      seenGuids.add(item.guid);
      console.log(`[NewsGuard] ${feedName}: new post detected`);
      await classifyAndAct(item.content);
    }
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
      console.log(`[TrumpGuard] Tavily error ${res.status}`);
      return;
    }

    const data = (await res.json()) as { results?: Array<{ url?: string; content?: string; title?: string }> };
    const results = data.results ?? [];

    for (const r of results) {
      const url = r.url ?? "";
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const content = r.content ?? r.title ?? url;
      await classifyAndAct(content);
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
