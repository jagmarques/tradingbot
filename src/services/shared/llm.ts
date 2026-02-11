import { loadEnv } from "../../config/env.js";
import { trackUsage } from "./cost-monitor.js";

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export type DeepSeekModel = "deepseek-chat" | "deepseek-reasoner";

interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface DeepSeekResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
      reasoning_content?: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function callDeepSeek(
  prompt: string,
  model: DeepSeekModel = "deepseek-chat",
  systemMessage?: string,
  temperature?: number,
  caller: string = "unknown"
): Promise<string> {
  const env = loadEnv();

  if (!env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY not configured");
  }

  const isReasoner = model === "deepseek-reasoner";

  // R1 doesn't support system messages - merge into user prompt
  const messages: DeepSeekMessage[] = isReasoner
    ? [
        {
          role: "user",
          content: systemMessage
            ? `${systemMessage}\n\n${prompt}`
            : prompt,
        },
      ]
    : [
        {
          role: "system",
          content: systemMessage ||
            "You are an expert prediction market analyst. Always respond with valid JSON only, no markdown or extra text.",
        },
        {
          role: "user",
          content: prompt,
        },
      ];

  // R1 doesn't support temperature (ignored but skip for cleanliness)
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: isReasoner ? 4000 : 1000,
  };
  if (!isReasoner) {
    body.temperature = temperature ?? 0.3;
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      // R1 chain-of-thought takes longer
      const timeout = setTimeout(() => controller.abort(), isReasoner ? 60000 : 30000);

      const response = await fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        // Retry on 5xx errors or rate limits
        if (response.status >= 500 || response.status === 429) {
          lastError = new Error(`DeepSeek ${response.status}: ${errorText}`);
          console.warn(`[DeepSeek] Attempt ${attempt}/${MAX_RETRIES} failed (${response.status})`);
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        throw new Error(`DeepSeek API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as DeepSeekResponse;

      if (!data.choices || data.choices.length === 0) {
        lastError = new Error("DeepSeek returned no choices");
        console.warn(`[DeepSeek] Attempt ${attempt}/${MAX_RETRIES}: no choices`);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      let content = data.choices[0].message.content;
      const reasoning = data.choices[0].message.reasoning_content;

      // R1: if content is empty, try to extract JSON from reasoning_content
      if (isReasoner && (!content || content.trim().length === 0) && reasoning) {
        const jsonMatch = reasoning.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          content = jsonMatch[0];
          console.log(`[DeepSeek] R1: extracted JSON from reasoning_content`);
        }
      }

      if (reasoning) {
        console.log(`[DeepSeek] R1 reasoning (${reasoning.length} chars): ${reasoning.slice(0, 500).replace(/\n/g, " ")}`);
      }

      if (!content || content.trim().length === 0) {
        lastError = new Error("DeepSeek returned empty content");
        console.warn(`[DeepSeek] Attempt ${attempt}/${MAX_RETRIES}: empty content`);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      // Track usage and cost
      trackUsage(data.usage.prompt_tokens, data.usage.completion_tokens, caller);

      console.log(`[DeepSeek] ${data.usage.total_tokens} tokens (${caller})`);
      return content;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isTimeout = lastError.name === "AbortError";
      console.warn(`[DeepSeek] Attempt ${attempt}/${MAX_RETRIES}: ${isTimeout ? "timeout" : lastError.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  console.error(`[DeepSeek] All ${MAX_RETRIES} attempts failed`);
  throw lastError || new Error("DeepSeek call failed");
}

export async function validateDeepSeekConnection(): Promise<boolean> {
  try {
    const response = await callDeepSeek(
      'Respond with exactly: {"status": "ok"}',
      "deepseek-chat",
      undefined,
      undefined,
      "validation"
    );
    const parsed = JSON.parse(response);
    return parsed.status === "ok";
  } catch (error) {
    console.error("[DeepSeek] Connection validation failed:", error);
    return false;
  }
}
