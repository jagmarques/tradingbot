import { loadEnv } from "../../config/env.js";

export interface ClassificationResult {
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  impact: "high" | "medium" | "low";
}

const DEFAULT_RESULT: ClassificationResult = { sentiment: "NEUTRAL", impact: "low" };

// Pre-filter: skip obvious noise before calling AI (saves Groq rate limit)
// Based on analysis of 3837 posts: "other" category has 21% hit rate vs 30%+ for financial
const MARKET_KEYWORDS = /tariff|trade war|trade deal|china.*trade|crypto\b|cryptocurrency|bitcoin|btc\b|blockchain|digital asset|strategic reserve|sec |cftc|regulation|etf |stablecoin|rate cut|rate hike|interest rate|federal reserve|fed |powell|inflation|recession|economy|gdp|jobs|unemployment|stimulus|debt ceiling|executive order|sanctions|elon|musk|doge\b|ban |tax |hack|exchange|oil price|crude oil|opec|war |ceasefire|peace deal|nuclear|iran.*deal|russia.*sanction|china.*sanction/i;
const NOISE_KEYWORDS = /immigration|border|illegal|deport|fentanyl|hollywood|movie|actor|actress|nfl|nba|mlb|baseball|football|basketball|golf|super bowl|grammy|oscar|emmy|concert|album|song|music|birthday|wedding|funeral|church|pastor|prayer|god bless/i;

function stripHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ") // strip URLs
    .replace(/\s+/g, " ").trim();
}

function preFilter(content: string): "skip" | "classify" {
  const clean = stripHtml(content);
  if (clean.length < 30) return "skip";
  const alphaCount = (clean.match(/[a-zA-Z]/g) ?? []).length;
  if (alphaCount < 20) return "skip";
  if (clean.startsWith("RT: ") && clean.length < 100) return "skip";
  // Must contain at least one market-relevant keyword to proceed to AI
  if (!MARKET_KEYWORDS.test(clean)) return "skip";
  return "classify";
}

// Known keyword-based quick classification (no AI needed)
// Based on research: tariffs = 64% bearish, crypto reserve = always bullish
function quickClassify(content: string): ClassificationResult | null {
  const lower = content.toLowerCase();
  if (lower.match(/strategic.*reserve.*crypto|bitcoin.*reserve|crypto.*reserve/)) return { sentiment: "BULLISH", impact: "high" };
  if (lower.match(/ban.*crypto|crypto.*ban|bitcoin.*ban/)) return { sentiment: "BEARISH", impact: "high" };
  if (lower.match(/rate.*cut|cut.*rate|lower.*rate/)) return { sentiment: "BULLISH", impact: "high" };
  if (lower.match(/rate.*hike|hike.*rate|raise.*rate/)) return { sentiment: "BEARISH", impact: "high" };
  if (lower.match(/new.*tariff|raise.*tariff|increase.*tariff|tariff.*increase/)) return { sentiment: "BEARISH", impact: "high" };
  if (lower.match(/remove.*tariff|lower.*tariff|tariff.*deal|tariff.*pause/)) return { sentiment: "BULLISH", impact: "high" };
  return null;
}

export async function classifyPost(content: string): Promise<ClassificationResult> {
  // Strip HTML and pre-filter noise
  content = stripHtml(content);
  if (preFilter(content) === "skip") return DEFAULT_RESULT;

  // Quick keyword-based classification for obvious cases
  const quick = quickClassify(content);
  if (quick) return quick;

  const env = loadEnv();
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) return DEFAULT_RESULT;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Does this news DIRECTLY affect cryptocurrency/financial markets? Answer NEUTRAL unless it clearly moves markets.

Format: SENTIMENT IMPACT
SENTIMENT = BULLISH, BEARISH, or NEUTRAL
IMPACT = HIGH, MEDIUM, or LOW

Categories that move crypto (from historical analysis):
- Tariffs/trade war: usually BEARISH HIGH (64% bearish historically)
- SEC/CFTC regulation: BEARISH or BULLISH HIGH depending on direction
- Rate decisions (Fed): cuts = BULLISH, hikes = BEARISH HIGH
- Crypto-specific (reserve, ETF, adoption): BULLISH or BEARISH HIGH
- Elon Musk crypto mentions: MEDIUM impact
- Economy (GDP, jobs, recession): MEDIUM impact
- Geopolitical (sanctions, war): MEDIUM if affects trade/economy

NOT market-moving (answer NEUTRAL LOW):
- Immigration, border, deportation
- Military operations, veterans
- Sports, entertainment, celebrities
- Social issues, religion, culture
- General political commentary without economic content
- Retweets without substantive content

When in doubt: NEUTRAL LOW

Content: ${content.slice(0, 500)}`,
          },
        ],
      }),
    });

    if (!res.ok) return DEFAULT_RESULT;

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";

    let sentiment: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
    if (text.includes("BULLISH")) sentiment = "BULLISH";
    else if (text.includes("BEARISH")) sentiment = "BEARISH";

    let impact: "high" | "medium" | "low" = "low";
    if (text.includes("HIGH")) impact = "high";
    else if (text.includes("MEDIUM")) impact = "medium";

    return { sentiment, impact };
  } catch (err) {
    console.log(`[TrumpGuard] Classifier error: ${err instanceof Error ? err.message : String(err)}`);
    return DEFAULT_RESULT;
  }
}
