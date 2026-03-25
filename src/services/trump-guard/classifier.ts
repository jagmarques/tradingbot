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

// Boilerplate/non-news patterns - government docs, legal text, academic papers
const BOILERPLATE_RE = /using these categories|pursuant to|hereinafter|whereas|in accordance with|the commission (shall|may|will)|section \d+\(|subsection|notwithstanding|promulgated|codified at/i;

function preFilter(content: string): "skip" | "classify" {
  const clean = stripHtml(content);
  if (clean.length < 30) return "skip";
  const alphaCount = (clean.match(/[a-zA-Z]/g) ?? []).length;
  if (alphaCount < 20) return "skip";
  if (clean.startsWith("RT: ") && clean.length < 100) return "skip";
  // Must contain at least one market-relevant keyword to proceed to AI
  if (!MARKET_KEYWORDS.test(clean)) return "skip";
  // Skip government boilerplate, legal text, academic content
  if (BOILERPLATE_RE.test(clean)) return "skip";
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
  if (lower.match(/new.*tariff|raise.*tariff|increase.*tariff|tariff.*increase/)) return { sentiment: "BEARISH", impact: "medium", isBreaking: true };
  if (lower.match(/remove.*tariff|lower.*tariff|tariff.*deal|tariff.*pause/)) return { sentiment: "BULLISH", impact: "medium", isBreaking: true };
  // War/geopolitical = MEDIUM (crypto decoupled from war since 2022)
  if (lower.match(/drone.*strike|missile.*strike|air.*strike|bomb|invasion|attack.*port|attack.*base/)) return { sentiment: "BEARISH", impact: "medium", isBreaking: true };
  if (lower.match(/ceasefire|peace.*deal|peace.*agreement|truce/)) return { sentiment: "BULLISH", impact: "medium", isBreaking: true };
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
    const prompt = `You are a crypto market analyst. Analyze this news and decide if crypto traders should act.

Content: ${content.slice(0, 500)}

Step 1 - Is this market-moving? Answer NEUTRAL if not directly about money/markets/crypto.
Step 2 - Impact:
HIGH = ONLY direct crypto events: crypto regulation, ETF approval/rejection, strategic reserve, major exchange hack, stablecoin ban, rate decisions by Fed/ECB
MEDIUM = indirect: tariffs, trade war, sanctions, war/peace, oil prices, geopolitical events, economic data
LOW = vague connection to markets
War/military/drone strikes/oil disruptions are MEDIUM, NOT HIGH. Crypto has decoupled from war headlines since 2022.
Step 3 - Type: Is this BREAKING or OPINION?
BREAKING = a specific NEW event just happened RIGHT NOW. Examples:
  "Trump announces 25% tariff on China" = BREAKING
  "Fed cuts rates by 50bps" = BREAKING
  "Binance hacked for $500M" = BREAKING
  "Iran strikes Israel" = BREAKING (but MEDIUM impact, not HIGH)
OPINION = analysis, editorial, recap, prediction, market summary, commentary. Examples:
  "The everything shock" = OPINION
  "Why Bitcoin could reach $100K" = OPINION
  "Wall Street won't tame DeFi" = OPINION
  "Energy Crisis Will Not Be Resolved" = OPINION
  "Wall Street mixed after relief rally" = OPINION (market recap/summary)
  "Middle East uncertainty lingers" = OPINION (analysis of ongoing situation)
  "Here's what to expect" = OPINION
  "Markets react to..." = OPINION (recap, already happened)
  "As War in Iran Disrupts..." = OPINION (analysis of existing situation)
  Words that signal OPINION: mixed, lingers, uncertainty, could, might, may, expected, outlook, analysis, recap, review, what to know, here's
BREAKING must describe a NEW action: "announces", "approves", "bans", "cuts", "strikes", "hacked", "signs"
If unsure: OPINION (safer to miss than trade on commentary)

Step 4 - Direction: LONG or SHORT?

Historical patterns:
- Rate cuts: LONG (HIGH). Rate hikes: SHORT (HIGH)
- Crypto reserve/ETF/adoption: LONG (HIGH)
- Crypto ban/hack/crackdown: SHORT (HIGH)
- Tariffs/trade war: SHORT (MEDIUM - indirect effect)
- War/sanctions/tension: SHORT (MEDIUM - crypto decoupled from war news)
- Ceasefire/peace: LONG (MEDIUM)
- Oil disruption/drone strike: SHORT (MEDIUM - oil != crypto)
- Economic data (GDP, jobs, inflation): direction depends (MEDIUM)

NOT market-moving (NEUTRAL):
- Immigration, sports, entertainment, social issues, general politics

Answer EXACTLY one line:
SENTIMENT IMPACT TYPE DIRECTION
Example: BEARISH HIGH BREAKING SHORT
Example: NEUTRAL LOW OPINION NONE`;

    const response = await callLLM(prompt, undefined, "Respond with exactly one line: SENTIMENT IMPACT TYPE DIRECTION", 0, "news-classifier");
    const text = response.trim().toUpperCase();

    let sentiment: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
    if (text.includes("BULLISH")) sentiment = "BULLISH";
    else if (text.includes("BEARISH")) sentiment = "BEARISH";

    let impact: "high" | "medium" | "low" = "low";
    if (text.includes("HIGH")) impact = "high";
    else if (text.includes("MEDIUM")) impact = "medium";

    let isBreaking = text.includes("BREAKING");

    // Post-classification sanity: BREAKING must have action verbs in original content
    if (isBreaking) {
      const ACTION_VERBS = /\b(announces?|approves?|bans?|cuts?|strikes?|hacked|signs?|launches?|passes?|rejects?|suspends?|halts?|blocks?|seizes?|arrests?|crashes?|surges?|plunges?|tumbles?|soars?|files?|proposes?|unveils?)\b/i;
      if (!ACTION_VERBS.test(content)) {
        isBreaking = false; // no action verb = not breaking news
        console.log(`[TrumpGuard] Downgrade: BREAKING -> OPINION (no action verb in content)`);
      }
    }

    // Override sentiment with explicit direction if present
    if (text.includes("SHORT")) sentiment = "BEARISH";
    else if (text.includes("LONG") && !text.includes("NEUTRAL")) sentiment = "BULLISH";

    if (sentiment !== "NEUTRAL") {
      console.log(`[TrumpGuard] AI analysis: ${sentiment} ${impact} ${isBreaking ? "BREAKING" : "OPINION"}`);
    }

    return { sentiment, impact, isBreaking };
  } catch (err) {
    console.log(`[TrumpGuard] Classifier error: ${err instanceof Error ? err.message : String(err)}`);
    return DEFAULT_RESULT;
  }
}
