import { loadEnv } from "../../config/env.js";
import { classifyPost } from "./classifier.js";
import { closePosition, getOpenQuantPositions } from "../hyperliquid/executor.js";

const RSS_URL = "https://trumpstruth.org/feed";
const RSS_INTERVAL_MS = 3_000;
const TAVILY_INTERVAL_MS = 90_000;
const COOLDOWN_MS = 30 * 60 * 1000;
const TRADE_TYPE = "garch-chan";

let cooldownUntil = 0;
let rssInterval: ReturnType<typeof setInterval> | null = null;
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

async function pollRss(isInit: boolean): Promise<void> {
  try {
    const res = await fetch(RSS_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      console.log(`[TrumpGuard] RSS fetch error ${res.status}`);
      return;
    }
    const xml = await res.text();
    const items = extractItems(xml);

    if (isInit) {
      // Seed seen guids without triggering actions
      for (const item of items) {
        seenGuids.add(item.guid);
      }
      console.log(`[TrumpGuard] RSS initialized, seeded ${items.length} existing posts`);
      return;
    }

    for (const item of items) {
      if (seenGuids.has(item.guid)) continue;
      seenGuids.add(item.guid);
      await classifyAndAct(item.content);
    }
  } catch (err) {
    console.log(`[TrumpGuard] RSS error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function pollTavily(): Promise<void> {
  const env = loadEnv();
  const apiKey = env.TAVILY_API_KEY_1;
  if (!apiKey) return;

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        api_key: apiKey,
        query: "Trump crypto Bitcoin latest",
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
  console.log("[TrumpGuard] Starting RSS + Tavily monitoring");

  // Seed initial state, then begin polling
  void pollRss(true).then(() => {
    rssInterval = setInterval(() => {
      void pollRss(false);
    }, RSS_INTERVAL_MS);
  });

  // Tavily: first run immediately (no init seed needed, dedup by URL), then every 90s
  void pollTavily();
  tavilyInterval = setInterval(() => {
    void pollTavily();
  }, TAVILY_INTERVAL_MS);
}

export function stopTrumpGuard(): void {
  if (rssInterval) {
    clearInterval(rssInterval);
    rssInterval = null;
  }
  if (tavilyInterval) {
    clearInterval(tavilyInterval);
    tavilyInterval = null;
  }
  console.log("[TrumpGuard] Stopped");
}
