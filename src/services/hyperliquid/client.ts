import { Hyperliquid } from "hyperliquid";
import { HYPERLIQUID_API_TIMEOUT_MS } from "../../config/constants.js";

let sdk: Hyperliquid | null = null;
let connected = false;

export function initHyperliquid(
  privateKey: string,
  walletAddress?: string,
): Hyperliquid {
  sdk = new Hyperliquid({
    privateKey,
    enableWs: false,
    ...(walletAddress ? { walletAddress } : {}),
  });
  connected = false;
  console.log("[Hyperliquid] SDK initialized");
  return sdk;
}

export function getClient(): Hyperliquid {
  if (!sdk) {
    throw new Error(
      "[Hyperliquid] SDK not initialized. Call initHyperliquid first.",
    );
  }
  return sdk;
}

export function isHyperliquidInitialized(): boolean {
  return sdk !== null;
}

export async function ensureConnected(): Promise<void> {
  if (!sdk) {
    throw new Error(
      "[Hyperliquid] SDK not initialized. Call initHyperliquid first.",
    );
  }

  if (connected) return;

  const RETRY_DELAY_MS = 2_000;
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const connectPromise = sdk.connect();
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Connection timed out")),
          HYPERLIQUID_API_TIMEOUT_MS,
        ),
      );
      await Promise.race([connectPromise, timeout]);
      connected = true;
      console.log("[Hyperliquid] Connected");
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Hyperliquid] Connection attempt ${attempt} failed: ${msg}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error("[Hyperliquid] Failed to connect after retries");
}
