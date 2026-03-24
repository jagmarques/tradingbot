// AI-powered exit decisions for news-trade positions using Cerebras
import { callLLM } from "../shared/llm.js";

interface PositionInfo {
  pair: string;
  direction: "long" | "short";
  pricePct: number; // directional: positive = in our favor
  holdMinutes: number;
}

type ExitDecision = "HOLD" | "TAKE_PROFIT" | "CLOSE";

// Cache: eventTs -> { advice, fetchedAt } - refreshes every 3 minutes
const adviceCache = new Map<number, { advice: Map<string, ExitDecision>; fetchedAt: number }>();
const CACHE_TTL_MS = 15 * 1000; // refresh every 15 seconds

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

  // Return cached if still fresh
  const cached = adviceCache.get(eventTs);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.advice;

  const positionList = positions
    .map(p => `${p.pair}: ${p.direction} ${p.pricePct > 0 ? "+" : ""}${(p.pricePct * 100).toFixed(2)}% (${p.holdMinutes}min)`)
    .join("\n");

  const prompt = `You are a crypto trading exit advisor. A news event opened these positions.

News: ${newsContent.slice(0, 200)}
Impact level: ${impact}

Open positions (held for ~${positions[0]?.holdMinutes ?? 60} minutes):
${positionList}

For each pair, decide ONE action:
- HOLD: expect more movement in our direction, keep running
- TAKE_PROFIT: position is profitable ABOVE 0.15% (fees cost ~0.1%), lock in real gains
- CLOSE: position is flat or negative, cut it

Rules:
- TAKE_PROFIT only if profit > 0.15% (below that, fees eat the gain - use CLOSE instead)
- If profit > 1%: HOLD for HIGH impact news, TAKE_PROFIT for LOW/MEDIUM
- If profit 0.15%-1%: TAKE_PROFIT (secure small gain)
- If position is flat (between -0.15% and +0.15%): CLOSE (no edge, just fees)
- If position is negative (-0.15% to -0.5%): CLOSE (dead trade)
- If position is more than 0.5% against: HOLD (might recover, SL protects)
- HIGH impact crypto news: more HOLDs (expect bigger moves)
- LOW impact or non-crypto news: more CLOSE (weak signal)

Respond with ONLY valid JSON, no markdown:
{${positions.map(p => `"${p.pair}": "DECISION"`).join(", ")}}`;

  try {
    const response = await callLLM(
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

    adviceCache.set(eventTs, { advice: result, fetchedAt: Date.now() });
    console.log(`[ExitAdvisor] AI decisions for ${positions.length} positions: ${[...result.entries()].map(([p, d]) => `${p}=${d}`).join(", ")}`);
    return result;
  } catch (err) {
    console.error(`[ExitAdvisor] Failed: ${err instanceof Error ? err.message : String(err)}`);
    // Return empty map - caller falls back to fixed rules
    return new Map();
  }
}
