import { fetchWithTimeout } from "../../utils/fetch.js";

const RATE_LIMIT_MS = 15_000; // 4 req/min (5/min limit has no jitter margin at 12s)
const COOLDOWN_MS = 5 * 60 * 1000;

let nextAvailableAt = 0;
let queue: Promise<void> = Promise.resolve();
let cooldownUntil = 0;

async function geckoMakeFetch(url: string, timeoutMs: number): Promise<Response | null> {
  try {
    const resp = await fetchWithTimeout(url, { timeoutMs, retries: 0 });
    if (resp.status === 429) {
      cooldownUntil = Date.now() + COOLDOWN_MS;
      console.log(`[Gecko] 429 - cooling down 5min: ${url.split("/api/v2")[1]?.slice(0, 60) ?? url.slice(-60)}`);
      return null;
    }
    return resp;
  } catch (err) {
    console.log(`[Gecko] Fetch error:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// Skip-not-queue: returns null if rate-limited. Use for optional/fallback calls.
export async function geckoFetch(url: string, timeoutMs = 10_000): Promise<Response | null> {
  const now = Date.now();
  if (now < cooldownUntil || now < nextAvailableAt) return null;
  nextAvailableAt = now + RATE_LIMIT_MS;
  return geckoMakeFetch(url, timeoutMs);
}

// Queue-and-wait: reserves a rate-limit slot and waits. Use when all calls must go through.
export async function geckoQueuedFetch(url: string, timeoutMs = 10_000): Promise<Response | null> {
  if (Date.now() < cooldownUntil) return null;
  const now = Date.now();
  const reserveAt = Math.max(now, nextAvailableAt);
  nextAvailableAt = reserveAt + RATE_LIMIT_MS;
  const delay = reserveAt - now;
  const myTurn = queue.then(() => new Promise<void>((r) => setTimeout(r, delay)));
  queue = myTurn;
  await myTurn;
  if (Date.now() < cooldownUntil) return null;
  return geckoMakeFetch(url, timeoutMs);
}
