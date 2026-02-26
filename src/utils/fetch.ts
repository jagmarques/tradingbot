export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  url: string | URL,
  options?: RequestInit & { timeoutMs?: number; retries?: number; retryDelayMs?: number }
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    retries = 2,
    retryDelayMs = 1000,
    signal: callerSignal,
    ...fetchOptions
  } = options || {};

  if (callerSignal) {
    return fetch(url, { ...fetchOptions, signal: callerSignal });
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = retryDelayMs * attempt;
      console.warn(`[Fetch] Retry ${attempt}/${retries} for ${url.toString().slice(0, 80)}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
      await new Promise(r => setTimeout(r, delay));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const urlStr = url.toString().slice(0, 80);
      controller.abort(new Error(`Fetch timeout after ${timeoutMs}ms: ${urlStr}`));
    }, timeoutMs);

    try {
      const response = await fetch(url, { ...fetchOptions, signal: controller.signal });

      if (response.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }

      return response;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (err.message?.includes("Fetch timeout") && attempt < retries) {
          lastError = err;
          continue;
        }
        throw err;
      }
      if (err instanceof TypeError) {
        lastError = err;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}
