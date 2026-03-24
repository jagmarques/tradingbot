import { callLLM } from "../shared/llm.js";

export interface ClassificationResult {
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  impact: "high" | "medium" | "low";
  isBreaking: boolean;
}

const DEFAULT_RESULT: ClassificationResult = { sentiment: "NEUTRAL", impact: "low", isBreaking: false };

// Pre-filter: skip obvious noise before calling AI (saves Groq rate limit)
// Based on analysis of 3837 posts: "other" category has 21% hit rate vs 30%+ for financial
const MARKET_KEYWORDS = /tariff|trade war|trade deal|china.*trade|crypto\b|cryptocurrency|bitcoin|btc\b|blockchain|digital asset|strategic reserve|sec |cftc|regulation|etf |stablecoin|rate cut|rate hike|interest rate|federal reserve|fed |powell|inflation|recession|economy|gdp|jobs|unemployment|stimulus|debt ceiling|executive order|sanctions|elon|musk|doge\b|ban |tax |hack|exchange|oil price|crude oil|opec|war |ceasefire|peace deal|nuclear|iran.*deal|russia.*sanction|china.*sanction/i;


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
  if (lower.match(/strategic.*reserve.*crypto|bitcoin.*reserve|crypto.*reserve/)) return { sentiment: "BULLISH", impact: "high", isBreaking: true };
  if (lower.match(/ban.*crypto|crypto.*ban|bitcoin.*ban/)) return { sentiment: "BEARISH", impact: "high", isBreaking: true };
  if (lower.match(/rate.*cut|cut.*rate|lower.*rate/)) return { sentiment: "BULLISH", impact: "high", isBreaking: true };
  if (lower.match(/rate.*hike|hike.*rate|raise.*rate/)) return { sentiment: "BEARISH", impact: "high", isBreaking: true };
  if (lower.match(/new.*tariff|raise.*tariff|increase.*tariff|tariff.*increase/)) return { sentiment: "BEARISH", impact: "high", isBreaking: true };
  if (lower.match(/remove.*tariff|lower.*tariff|tariff.*deal|tariff.*pause/)) return { sentiment: "BULLISH", impact: "high", isBreaking: true };
  return null;
}

export async function classifyPost(content: string): Promise<ClassificationResult> {
  // Strip HTML and pre-filter noise
  content = stripHtml(content);
  if (preFilter(content) === "skip") return DEFAULT_RESULT;

  // Quick keyword-based classification for obvious cases
  const quick = quickClassify(content);
  if (quick) return quick;

  try {
    const prompt = `Does this news DIRECTLY affect cryptocurrency/financial markets? Answer NEUTRAL unless it clearly moves markets.

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

Also classify: BREAKING or OPINION
BREAKING = new event just happened, first report, developing situation
OPINION = analysis, commentary, recap of existing situation, editorial

When in doubt: NEUTRAL LOW

Content: ${content.slice(0, 500)}`;

    const response = await callLLM(
      prompt,
      undefined,
      "You are a financial news classifier. Respond with EXACTLY: SENTIMENT IMPACT BREAKING_OR_OPINION",
      0,
      "news-classifier",
    );

    const text = response.trim().toUpperCase();

    let impact: "high" | "medium" | "low" = "low";
    if (text.includes("HIGH")) impact = "high";
    else if (text.includes("MEDIUM")) impact = "medium";

    const isBreaking = text.includes("BREAKING");

    // Quick sentiment from first pass
    let sentiment: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
    if (text.includes("BULLISH")) sentiment = "BULLISH";
    else if (text.includes("BEARISH")) sentiment = "BEARISH";

    // For HIGH impact: deep AI analysis to decide direction
    if (impact === "high" && sentiment !== "NEUTRAL") {
      try {
        const deepPrompt = `You are a crypto market analyst. This HIGH IMPACT news just broke. Decide: should crypto traders go LONG or SHORT?

News: ${content.slice(0, 500)}

Think step by step:
1. What happened? (one sentence)
2. How does this affect crypto markets? (one sentence)
3. Historical precedent: similar events in the past moved crypto which direction?
4. Your decision: LONG or SHORT

Consider:
- Tariffs/trade war = usually crypto dumps (SHORT)
- Rate cuts = crypto pumps (LONG), rate hikes = dumps (SHORT)
- Crypto-specific good news (reserve, ETF, adoption) = LONG
- Geopolitical tension (war, sanctions) = usually SHORT (risk-off)
- Ceasefire/peace = usually LONG (risk-on)
- Oil price spike = mixed, slight SHORT

Answer with your reasoning then end with exactly: DIRECTION: LONG or DIRECTION: SHORT`;

        const deepResponse = await callLLM(deepPrompt, undefined, "You are a crypto market analyst.", 0, "news-deep-analysis");
        const deepText = deepResponse.trim().toUpperCase();

        if (deepText.includes("DIRECTION: LONG")) {
          sentiment = "BULLISH";
          console.log(`[TrumpGuard] Deep analysis: LONG - ${deepResponse.slice(-100)}`);
        } else if (deepText.includes("DIRECTION: SHORT")) {
          sentiment = "BEARISH";
          console.log(`[TrumpGuard] Deep analysis: SHORT - ${deepResponse.slice(-100)}`);
        }
        // If parsing fails, keep the first-pass sentiment
      } catch {
        // Deep analysis failed, use first-pass sentiment
      }
    }

    return { sentiment, impact, isBreaking };
  } catch (err) {
    console.log(`[TrumpGuard] Classifier error: ${err instanceof Error ? err.message : String(err)}`);
    return DEFAULT_RESULT;
  }
}
