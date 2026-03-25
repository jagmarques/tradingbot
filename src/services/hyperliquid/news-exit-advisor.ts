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

const holdStreakCount = new Map<number, number>(); // eventTs -> consecutive HOLD count

function cleanCache(): void {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [ts] of adviceCache) {
    if (ts < cutoff) adviceCache.delete(ts);
  }
  for (const [ts] of holdStreakCount) {
    if (ts < cutoff) holdStreakCount.delete(ts);
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

  const prompt = `You are a crypto trading exit advisor. A news event opened these positions. Your job is to let winners RUN and cut losers fast. We have trailing stops that will lock in profits automatically - do NOT take profit early.

News: ${newsContent.slice(0, 200)}
Impact level: ${impact}

Open positions (held for ~${positions[0]?.holdMinutes ?? 60} minutes):
${positionList}

For each pair, decide ONE action:
- HOLD: let it run, trailing stop will protect profits
- TAKE_PROFIT: only if profit is VERY large and momentum is clearly fading
- CLOSE: dead trade or moving against us

CRITICAL RULES - DO NOT take profit too early:
- HIGH impact: NEVER take profit below +2%. These events can move 3-5%. Let the trailing stop (activates at 5%, trails at 2%) do its job.
- MEDIUM impact: NEVER take profit below +1%. Trailing stop activates at 2%, trails at 1%.
- profit < +0.1% after 15min: CLOSE (not reacting to the news)
- profit +0.1% to +1%: HOLD (still building, too early to exit)
- profit +1% to +2%: HOLD for HIGH, TAKE_PROFIT for MEDIUM only if held > 30min and momentum fading
- profit > +2%: TAKE_PROFIT for MEDIUM, HOLD for HIGH (let trail catch it)
- profit > +3%: TAKE_PROFIT (exceptional move, lock it in)
- loss 0 to -0.3% and held < 15min: HOLD (give it time)
- loss 0 to -0.3% and held > 15min: CLOSE (dead trade)
- loss > -0.3%: HOLD (SL on exchange protects us at -2%)

DEFAULT IS HOLD. Only CLOSE dead trades and TAKE_PROFIT on large moves.

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

    const holdCount = [...result.values()].filter(d => d === "HOLD").length;
    const totalCount = result.size;

    // If all positions are HOLD, increment streak
    if (holdCount === totalCount && totalCount > 0) {
      const streak = (holdStreakCount.get(eventTs) ?? 0) + 1;
      holdStreakCount.set(eventTs, streak);
      // After 3 consecutive all-HOLD results, extend cache to 60s
      if (streak >= 3) {
        adviceCache.set(eventTs, { advice: result, fetchedAt: Date.now() + 45_000 }); // extra 45s on top of 15s TTL = 60s
        console.log(`[ExitAdvisor] All HOLD x${streak}, next check in 60s`);
      }
    } else {
      holdStreakCount.set(eventTs, 0);
    }

    console.log(`[ExitAdvisor] AI decisions: ${positions.map(p => `${p.pair}=${result.get(p.pair) ?? "?"}(${p.pricePct > 0 ? "+" : ""}${(p.pricePct * 100).toFixed(2)}%)`).join(", ")}`);
    return result;
  } catch (err) {
    console.error(`[ExitAdvisor] Failed: ${err instanceof Error ? err.message : String(err)}`);
    // Return empty map - caller falls back to fixed rules
    return new Map();
  }
}
