import { loadEnv } from "../../config/env.js";
import { trackUsage } from "./cost-monitor.js";

const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_MODEL = "qwen-3-235b-a22b-instruct-2507";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

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

// Pick provider: Cerebras (1M TPD) > Groq (300K TPD) fallback
function getProvider(): { url: string; key: string; model: string; name: string } {
  const env = loadEnv();

  if (env.CEREBRAS_API_KEY) {
    return { url: CEREBRAS_URL, key: env.CEREBRAS_API_KEY, model: CEREBRAS_MODEL, name: "Cerebras" };
  }
  if (env.GROQ_API_KEY) {
    return { url: GROQ_URL, key: env.GROQ_API_KEY, model: GROQ_MODEL, name: "Groq" };
  }

  throw new Error("No LLM API key (CEREBRAS_API_KEY or GROQ_API_KEY)");
}

export async function callLLM(
  prompt: string,
  _model?: string,
  systemMessage?: string,
  temperature?: number,
  caller: string = "unknown"
): Promise<string> {
  const provider = getProvider();

  const messages: LLMMessage[] = [
    {
      role: "system",
      content: systemMessage ||
        "You are an expert prediction market analyst. Always respond with valid JSON only, no markdown or extra text.",
    },
    { role: "user", content: prompt },
  ];

  const body = {
    model: provider.model,
    messages,
    max_tokens: 1000,
    temperature: temperature ?? 0.3,
  };

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(provider.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status >= 500 || response.status === 429) {
          const delay = response.status === 429 ? 15000 : RETRY_DELAY_MS * attempt;
          lastError = new Error(`${provider.name} ${response.status}: ${errorText.slice(0, 200)}`);
          console.warn(`[${provider.name}] Attempt ${attempt}/${MAX_RETRIES} (${response.status}), wait ${(delay/1000).toFixed(0)}s`);
          await sleep(delay);
          continue;
        }
        throw new Error(`${provider.name} ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const data = (await response.json()) as LLMResponse;

      if (!data.choices?.length) {
        lastError = new Error("No choices");
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      const content = data.choices[0].message.content;
      if (!content?.trim()) {
        lastError = new Error("Empty content");
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      trackUsage(data.usage.prompt_tokens, data.usage.completion_tokens, caller);
      console.log(`[${provider.name}] ${data.usage.total_tokens} tokens (${caller})`);
      return content;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isTimeout = lastError.name === "AbortError";
      console.warn(`[${provider.name}] Attempt ${attempt}/${MAX_RETRIES}: ${isTimeout ? "timeout" : lastError.message.slice(0, 100)}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError || new Error("LLM call failed");
}

export async function callLLMEnsemble(
  prompt: string,
  systemMessage?: string,
  caller: string = "unknown",
  ensembleSize: number = 3
): Promise<string[]> {
  const temps = [0.0, 0.3, 0.7];
  const results: string[] = [];
  for (let i = 0; i < ensembleSize; i++) {
    const temp = temps[i] ?? 0.3;
    const response = await callLLM(prompt, undefined, systemMessage, temp, `${caller}-e${i}`);
    results.push(response);
    if (i < ensembleSize - 1) await sleep(1000);
  }
  return results;
}
