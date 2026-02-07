import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { collectSocialSignals, clearSocialCache } from "./social.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper: build a Twitter API response with tweets
function buildTwitterResponse(
  tweets: Array<{ text: string }>,
): { ok: boolean; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: () => Promise.resolve({ tweets }),
  };
}

// Helper: build a Google News RSS XML response
function buildNewsResponse(
  items: Array<{ title: string; pubDate: string }>,
): { ok: boolean; text: () => Promise<string> } {
  const itemsXml = items
    .map(
      (item) =>
        `<item><title>${item.title}</title><pubDate>${item.pubDate}</pubDate></item>`,
    )
    .join("");
  return {
    ok: true,
    text: () => Promise.resolve(`<rss><channel>${itemsXml}</channel></rss>`),
  };
}

// Recent date string for news items (within 3 days)
const recentDate = new Date(
  Date.now() - 1 * 24 * 60 * 60 * 1000,
).toUTCString();

describe("Token Social Collector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSocialCache();
    delete process.env.TWITTER_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return bullish sentiment from Twitter + News headlines", async () => {
    process.env.TWITTER_API_KEY = "test-key";

    // Build 15 tweets with bullish keywords
    const tweets = Array.from({ length: 15 }, (_, i) => ({
      text: `$PEPE to the moon! pump it! gem ${i}`,
    }));

    // First call: Twitter POST
    mockFetch.mockResolvedValueOnce(buildTwitterResponse(tweets));
    // Second call: Google News GET
    mockFetch.mockResolvedValueOnce(
      buildNewsResponse([
        { title: "PEPE crypto surges 50%", pubDate: recentDate },
        { title: "Memecoin rally continues", pubDate: recentDate },
      ]),
    );

    const result = await collectSocialSignals("PEPE", "0xpepe123", "base");

    expect(result).not.toBeNull();
    expect(result!.tweetCount24h).toBe(15);
    expect(result!.sentiment).toBe("bullish");
    expect(result!.topHeadlines).toHaveLength(2);
    expect(result!.newsItemCount).toBe(2);
    expect(result!.narrativeTags).toContain("memecoin");
  });

  it("should work without Twitter API key (news-only)", async () => {
    // No TWITTER_API_KEY set
    mockFetch.mockResolvedValueOnce(
      buildNewsResponse([
        { title: "SOL DeFi liquidity pools expand", pubDate: recentDate },
      ]),
    );

    const result = await collectSocialSignals(
      "SOL",
      "SoLaNaAddress123",
      "solana",
    );

    expect(result).not.toBeNull();
    expect(result!.tweetCount24h).toBe(0);
    expect(result!.sentiment).toBe("unknown");
    expect(result!.topHeadlines).toHaveLength(1);
    expect(result!.newsItemCount).toBe(1);
    // Only news fetch should have been called (no Twitter call)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should return news-only when Twitter fails", async () => {
    process.env.TWITTER_API_KEY = "test-key";

    // Twitter throws
    mockFetch.mockRejectedValueOnce(new Error("Twitter API down"));
    // News succeeds
    mockFetch.mockResolvedValueOnce(
      buildNewsResponse([
        { title: "Token launch on DEX", pubDate: recentDate },
      ]),
    );

    const result = await collectSocialSignals("TEST", "0xtest123", "base");

    expect(result).not.toBeNull();
    expect(result!.tweetCount24h).toBe(0);
    expect(result!.sentiment).toBe("unknown");
    expect(result!.topHeadlines).toHaveLength(1);
  });

  it("should return null when both Twitter and News fail", async () => {
    process.env.TWITTER_API_KEY = "test-key";

    // Twitter throws
    mockFetch.mockRejectedValueOnce(new Error("Twitter down"));
    // News throws
    mockFetch.mockRejectedValueOnce(new Error("News down"));

    const result = await collectSocialSignals(
      "FAIL",
      "0xfail123",
      "ethereum",
    );

    expect(result).toBeNull();
  });

  it("should extract narrative tags from news headlines", async () => {
    // No Twitter key
    mockFetch.mockResolvedValueOnce(
      buildNewsResponse([
        {
          title: "AI memecoin launched on DEX with massive liquidity",
          pubDate: recentDate,
        },
      ]),
    );

    const result = await collectSocialSignals("AIDOG", "0xaidog123", "base");

    expect(result).not.toBeNull();
    expect(result!.narrativeTags).toContain("AI");
    expect(result!.narrativeTags).toContain("memecoin");
    expect(result!.narrativeTags).toContain("defi");
  });

  it("should return cached result on second call", async () => {
    // No Twitter key
    mockFetch.mockResolvedValueOnce(
      buildNewsResponse([
        { title: "Cached token headline", pubDate: recentDate },
      ]),
    );

    const result1 = await collectSocialSignals(
      "CACHE",
      "0xcache123",
      "base",
    );
    expect(result1).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call should hit cache
    const result2 = await collectSocialSignals(
      "CACHE",
      "0xcache123",
      "base",
    );
    expect(result2).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, cache hit
    expect(result1).toEqual(result2);
  });
});
