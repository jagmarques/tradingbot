import { loadEnv } from "../../config/env.js";

export async function classifyPost(content: string): Promise<"BULLISH" | "BEARISH" | "NEUTRAL"> {
  const env = loadEnv();
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) {
    console.log("[TrumpGuard] GROQ_API_KEY not set, defaulting to NEUTRAL");
    return "NEUTRAL";
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
            content: `Is this news/statement bullish or bearish for cryptocurrency prices (Bitcoin, altcoins)? Consider: rate cuts and pro-crypto regulation are BULLISH, rate hikes and bans/crackdowns are BEARISH. Answer ONLY one word: BULLISH, BEARISH, or NEUTRAL. Content: ${content.slice(0, 500)}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.log(`[TrumpGuard] Groq API error ${res.status}, defaulting to NEUTRAL`);
      return "NEUTRAL";
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";

    if (text.includes("BULLISH")) return "BULLISH";
    if (text.includes("BEARISH")) return "BEARISH";
    return "NEUTRAL";
  } catch (err) {
    console.log(`[TrumpGuard] Classifier error: ${err instanceof Error ? err.message : String(err)}, defaulting to NEUTRAL`);
    return "NEUTRAL";
  }
}
