import { loadEnv } from "../../config/env.js";
import { trackUsage } from "./cost-monitor.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "moonshotai/kimi-k2-instruct";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;


interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMResponse {
  choices: {
    index: number;
    message: { role: string; content: string };
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

// Rate limiter: Groq free tier = 10K TPM, ~2.5K per call = max 4 calls/min
let lastCallTime = 0;
const MIN_CALL_GAP_MS = 15000; // 15s between calls = 4/min = ~10K TPM

export async function callDeepSeek(
  prompt: string,
  _model?: string,
  systemMessage?: string,
  temperature?: number,
  caller: string = "unknown"
): Promise<string> {
  const env = loadEnv();

  // Respect Groq rate limits
  const now = Date.now();
  const gap = MIN_CALL_GAP_MS - (now - lastCallTime);
  if (gap > 0) {
    await sleep(gap);
  }
  lastCallTime = Date.now();

  if (!env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not configured");
  }

  const messages: LLMMessage[] = [
    {
      role: "system",
      content: systemMessage ||
        "You are an expert prediction market analyst. Always respond with valid JSON only, no markdown or extra text.",
    },
    { role: "user", content: prompt },
  ];

  const body = {
    model: GROQ_MODEL,
    messages,
    max_tokens: 1000,
    temperature: temperature ?? 0.3,
  };

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status >= 500 || response.status === 429) {
          lastError = new Error(`Groq ${response.status}: ${errorText}`);
          const delay = response.status === 429 ? 20000 : RETRY_DELAY_MS * attempt;
          console.warn(`[Groq] Attempt ${attempt}/${MAX_RETRIES} failed (${response.status}), wait ${(delay/1000).toFixed(0)}s`);
          await sleep(delay);
          continue;
        }
        throw new Error(`Groq API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as LLMResponse;

      if (!data.choices?.length) {
        lastError = new Error("Groq returned no choices");
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      const content = data.choices[0].message.content;
      if (!content?.trim()) {
        lastError = new Error("Groq returned empty content");
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      trackUsage(data.usage.prompt_tokens, data.usage.completion_tokens, caller);
      console.log(`[Groq/K2] ${data.usage.total_tokens} tokens (${caller})`);
      return content;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isTimeout = lastError.name === "AbortError";
      console.warn(`[Groq] Attempt ${attempt}/${MAX_RETRIES}: ${isTimeout ? "timeout" : lastError.message}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError || new Error("Groq call failed");
}
