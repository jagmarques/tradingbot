import { loadEnv } from "../../config/env.js";

export interface ClassificationResult {
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  impact: "high" | "medium" | "low";
}

const DEFAULT_RESULT: ClassificationResult = { sentiment: "NEUTRAL", impact: "low" };

export async function classifyPost(content: string): Promise<ClassificationResult> {
  const env = loadEnv();
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) {
    console.log("[TrumpGuard] GROQ_API_KEY not set, defaulting to NEUTRAL");
    return DEFAULT_RESULT;
  }

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
            content: `Does this news DIRECTLY affect cryptocurrency prices? Answer NEUTRAL unless it clearly moves crypto markets.

Answer in EXACTLY this format: SENTIMENT IMPACT
SENTIMENT = BULLISH, BEARISH, or NEUTRAL
IMPACT = HIGH, MEDIUM, or LOW

BULLISH examples: crypto strategic reserve, pro-crypto regulation, rate cuts, ETF approval, major adoption
BEARISH examples: crypto ban, exchange hack, rate hikes, major tariffs, SEC crackdown
NEUTRAL examples: immigration, military, sports, elections, general politics, social issues, anything not directly about money/markets/crypto

HIGH = directly mentions crypto/bitcoin/blockchain/rates/tariffs
MEDIUM = economic policy that indirectly affects markets
LOW = vague or indirect connection to markets

When in doubt, answer NEUTRAL LOW. Only classify as BULLISH or BEARISH if the content CLEARLY and DIRECTLY impacts crypto.

Content: ${content.slice(0, 500)}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.log(`[TrumpGuard] Groq API error ${res.status}, defaulting to NEUTRAL`);
      return DEFAULT_RESULT;
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";

    // Parse sentiment
    let sentiment: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
    if (text.includes("BULLISH")) sentiment = "BULLISH";
    else if (text.includes("BEARISH")) sentiment = "BEARISH";

    // Parse impact
    let impact: "high" | "medium" | "low" = "low";
    if (text.includes("HIGH")) impact = "high";
    else if (text.includes("MEDIUM")) impact = "medium";

    return { sentiment, impact };
  } catch (err) {
    console.log(`[TrumpGuard] Classifier error: ${err instanceof Error ? err.message : String(err)}, defaulting to NEUTRAL`);
    return DEFAULT_RESULT;
  }
}
