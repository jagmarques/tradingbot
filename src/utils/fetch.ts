export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  url: string | URL,
  options?: RequestInit & { timeoutMs?: number }
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal: callerSignal, ...fetchOptions } = options || {};

  // If caller already passed a signal, respect it and skip our timeout
  if (callerSignal) {
    return fetch(url, { ...fetchOptions, signal: callerSignal });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    const urlStr = url.toString().slice(0, 80);
    controller.abort(new Error(`Fetch timeout after ${timeoutMs}ms: ${urlStr}`));
  }, timeoutMs);

  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
