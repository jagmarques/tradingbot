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
            content: `Is this news bullish or bearish for cryptocurrency? Also rate the expected market impact.
Answer in EXACTLY this format: SENTIMENT IMPACT
Where SENTIMENT is BULLISH, BEARISH, or NEUTRAL
Where IMPACT is HIGH, MEDIUM, or LOW

HIGH = direct crypto regulation, strategic reserve, major tariff, rate decision, exchange hack
MEDIUM = indirect crypto mention, executive order, major exchange listing, whale movement
LOW = general economy, minor regulatory update, vague statement

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
