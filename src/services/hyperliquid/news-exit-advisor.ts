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
- HOLD: expect more movement, keep running
- TAKE_PROFIT: lock in gains now
- CLOSE: not moving or moving against us, cut it

Historical data: avg news event moves BTC 0.3-0.5% in 1h. Only 15% reach 1%+.
68% of moves continue at 1h, 32% reverse.

Per-pair BTC multipliers (how much each alt moves vs BTC):
OP=3.4x, DOGE=2.6x, ADA=2.6x, ARB=2.5x, LDO=2.8x, TIA=3.0x, kBONK=3.2x
APT=2.3x, ENA=2.5x, WLD=2.0x, DOT=2.2x, LINK=2.0x, NEAR=2.5x
SOL=1.8x, XRP=1.5x, BNB=1.3x, TRUMP=2.8x, ONDO=2.3x, kSHIB=2.5x, HYPE=2.5x

Adjust thresholds per pair. Example: OP at +0.3% is like BTC at +0.09% (still early). OP at +1% is like BTC at +0.3% (normal peak).

Rules:
- profit > 0.5%: TAKE_PROFIT for MEDIUM. For HIGH: HOLD if pair multiplier > 2x (expects bigger move)
- profit 0.2-0.5%: TAKE_PROFIT if held > 20min. HOLD if held < 10min
- profit < 0.1% after 10min: CLOSE (not reacting)
- loss 0-0.3%: CLOSE (dead trade)
- loss > 0.3%: HOLD (SL protects, 68% chance it continues in direction)
- HIGH impact: be patient, HOLD longer especially on high-multiplier pairs (OP, TIA, kBONK)
- Slow pairs (BNB=1.3x, XRP=1.5x): take profit faster, they move less

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
