// AI-powered exit decisions for news-trade positions using Cerebras
import { callDeepSeek } from "../shared/llm.js";

interface PositionInfo {
  pair: string;
  direction: "long" | "short";
  pricePct: number; // directional: positive = in our favor
  holdMinutes: number;
}

type ExitDecision = "HOLD" | "TAKE_PROFIT" | "CLOSE";

// Cache: eventTs -> Map<pair, decision>
const adviceCache = new Map<number, Map<string, ExitDecision>>();

function cleanCache(): void {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [ts] of adviceCache) {
    if (ts < cutoff) adviceCache.delete(ts);
  }
}

export async function getExitAdvice(
  newsContent: string,
  impact: string,
  positions: PositionInfo[],
  eventTs: number,
): Promise<Map<string, ExitDecision>> {
  cleanCache();

  const cached = adviceCache.get(eventTs);
  if (cached) return cached;

  const positionList = positions
    .map(p => `${p.pair}: ${p.direction} ${p.pricePct > 0 ? "+" : ""}${(p.pricePct * 100).toFixed(2)}% (${p.holdMinutes}min)`)
    .join("\n");

  const prompt = `You are a crypto trading exit advisor. A news event opened these positions.

News: ${newsContent.slice(0, 200)}
Impact level: ${impact}

Open positions (held for ~${positions[0]?.holdMinutes ?? 60} minutes):
${positionList}

For each pair, decide ONE action:
- HOLD: the news is significant enough that this pair should keep running (expect more movement)
- TAKE_PROFIT: this pair has some profit, lock it in now (the move is fading)
- CLOSE: this pair isn't reacting to the news, cut it (dead trade)

Rules:
- If a position is profitable, prefer TAKE_PROFIT unless the news is very high impact and the pair typically reacts strongly
- If a position is slightly negative (<0.5% loss), CLOSE it
- If a position is more than 0.5% against, HOLD it (might recover, SL protects downside)
- HIGH impact news (crypto regulation, strategic reserve): more HOLDs
- LOW impact news (vague economy talk): more TAKE_PROFIT and CLOSE

Respond with ONLY valid JSON, no markdown:
{${positions.map(p => `"${p.pair}": "DECISION"`).join(", ")}}`;

  try {
    const response = await callDeepSeek(
      prompt,
      undefined,
      "You are a crypto trading exit advisor. Respond with valid JSON only.",
      0,
      "news-exit-advisor",
    );

    const jsonStr = response.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(jsonStr) as Record<string, string>;

    const result = new Map<string, ExitDecision>();
    for (const [pair, decision] of Object.entries(parsed)) {
      const upper = decision.toUpperCase().trim();
      if (upper === "HOLD" || upper === "TAKE_PROFIT" || upper === "CLOSE") {
        result.set(pair, upper as ExitDecision);
      }
    }

    adviceCache.set(eventTs, result);
    console.log(`[ExitAdvisor] AI decisions for ${positions.length} positions: ${[...result.entries()].map(([p, d]) => `${p}=${d}`).join(", ")}`);
    return result;
  } catch (err) {
    console.error(`[ExitAdvisor] Failed: ${err instanceof Error ? err.message : String(err)}`);
    // Return empty map - caller falls back to fixed rules
    return new Map();
  }
}
