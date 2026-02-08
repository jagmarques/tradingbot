import { PublicKey } from "@solana/web3.js";
import { getConnection, resetConnection } from "../solana/wallet.js";
import { PUMPFUN_PROGRAM_ID, WEBSOCKET_RECONNECT_BASE_MS, WEBSOCKET_RECONNECT_MAX_MS } from "../../config/constants.js";

export interface TokenLaunch {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  timestamp: number;
  signature: string;
}

type LaunchCallback = (launch: TokenLaunch) => void;

let subscriptionId: number | null = null;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let isShuttingDown = false;
const launchCallbacks: Set<LaunchCallback> = new Set();

const PUMPFUN_PUBKEY = new PublicKey(PUMPFUN_PROGRAM_ID);

// Retry config for transient RPC errors
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

// RPC rate limiting - serialize calls with minimum spacing to avoid 429s
const MIN_RPC_INTERVAL_MS = 200; // 5 req/sec max, well under Helius free tier
const MAX_PENDING_RPC = 10; // Drop excess if queue gets too deep
let rpcQueue: Promise<void> = Promise.resolve();
let pendingRpcCount = 0;

async function throttledRpc<T>(fn: () => Promise<T>): Promise<T | null> {
  if (pendingRpcCount >= MAX_PENDING_RPC) {
    return null; // Backpressure: drop to prevent unbounded queue growth
  }

  pendingRpcCount++;
  const myTurn = rpcQueue.then(() =>
    new Promise<void>((r) => setTimeout(r, MIN_RPC_INTERVAL_MS))
  );
  rpcQueue = myTurn;

  try {
    await myTurn;
    return await fn();
  } finally {
    pendingRpcCount--;
  }
}

// Pump.fun instruction discriminators
const CREATE_INSTRUCTION = Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]);

function parseTokenLaunch(
  data: Buffer,
  accountKeys: string[],
  signature: string
): TokenLaunch | null {
  try {
    // Check if this is a create instruction
    const discriminator = data.subarray(0, 8);
    if (!discriminator.equals(CREATE_INSTRUCTION)) {
      return null;
    }

    // Parse the instruction data
    // Pump.fun create instruction layout:
    // 8 bytes: discriminator
    // 32 bytes: name (string with length prefix)
    // 32 bytes: symbol (string with length prefix)
    // variable: uri (string with length prefix)

    let offset = 8;

    // Read name
    const nameLen = data.readUInt32LE(offset);
    offset += 4;
    const name = data.subarray(offset, offset + nameLen).toString("utf8");
    offset += nameLen;

    // Read symbol
    const symbolLen = data.readUInt32LE(offset);
    offset += 4;
    const symbol = data.subarray(offset, offset + symbolLen).toString("utf8");
    offset += symbolLen;

    // Read uri
    const uriLen = data.readUInt32LE(offset);
    offset += 4;
    const uri = data.subarray(offset, offset + uriLen).toString("utf8");

    // The mint address is typically the first account after the program
    const mint = accountKeys[1] || "unknown";
    const creator = accountKeys[0] || "unknown";

    return {
      mint,
      name,
      symbol,
      uri,
      creator,
      timestamp: Date.now(),
      signature,
    };
  } catch (err) {
    console.error("[PumpFun] Failed to parse token launch:", err);
    return null;
  }
}

function notifyCallbacks(launch: TokenLaunch): void {
  for (const callback of launchCallbacks) {
    try {
      callback(launch);
    } catch (err) {
      console.error("[PumpFun] Callback error:", err);
    }
  }
}

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("503") || msg.includes("429") || msg.includes("Service unavailable") || msg.includes("timeout") || msg.includes("Too Many Requests");
}

async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  retries: number = MAX_RETRIES
): Promise<T | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientError(err) || attempt === retries) {
        throw err;
      }
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

async function setupSubscription(): Promise<void> {
  const connection = getConnection();

  subscriptionId = connection.onLogs(
    PUMPFUN_PUBKEY,
    async (logs) => {
      // Reset reconnect counter on successful message
      reconnectAttempts = 0;

      // Check if this is a create transaction
      if (!logs.logs.some((log) => log.includes("Program log: Instruction: Create"))) {
        return;
      }

      try {
        // Throttle + retry for RPC calls to avoid 429 rate limits
        const tx = await throttledRpc(() =>
          fetchWithRetry(() =>
            connection.getParsedTransaction(logs.signature, {
              maxSupportedTransactionVersion: 0,
            })
          )
        );

        if (!tx?.meta || tx.meta.err) return;

        const message = tx.transaction.message;
        const instructions = message.instructions;

        for (const ix of instructions) {
          if ("programId" in ix && ix.programId.equals(PUMPFUN_PUBKEY)) {
            if ("data" in ix && typeof ix.data === "string") {
              const data = Buffer.from(ix.data, "base64");
              const accountKeys = message.accountKeys.map((k) =>
                typeof k === "string" ? k : k.pubkey.toBase58()
              );

              const launch = parseTokenLaunch(data, accountKeys, logs.signature);
              if (launch) {
                console.log(`[PumpFun] New token detected: ${launch.symbol} (${launch.mint})`);
                notifyCallbacks(launch);
              }
            }
          }
        }
      } catch (err) {
        if (!isTransientError(err)) {
          console.error("[PumpFun] Error processing transaction:", err);
        }
      }
    },
    "confirmed"
  );

  console.log(`[PumpFun] Subscription active (id: ${subscriptionId})`);
}

async function handleDisconnect(): Promise<void> {
  if (isShuttingDown) return;

  subscriptionId = null;

  // Calculate backoff delay
  const delay = Math.min(
    WEBSOCKET_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
    WEBSOCKET_RECONNECT_MAX_MS
  );
  reconnectAttempts++;

  console.error(`[PumpFun] WebSocket disconnected. Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(async () => {
    try {
      // Reset the connection to get a fresh WebSocket
      resetConnection();
      await setupSubscription();
      console.log("[PumpFun] Reconnected successfully");
    } catch (err) {
      console.error("[PumpFun] Reconnection failed:", err);
      handleDisconnect();
    }
  }, delay);
}

export async function startDetector(): Promise<void> {
  if (subscriptionId !== null) {
    console.log("[PumpFun] Detector already running");
    return;
  }

  isShuttingDown = false;
  reconnectAttempts = 0;

  console.log("[PumpFun] Starting token launch detector...");

  try {
    await setupSubscription();

    // Monitor connection health with periodic checks
    const healthCheck = setInterval(async () => {
      if (isShuttingDown) {
        clearInterval(healthCheck);
        return;
      }

      try {
        const connection = getConnection();
        await connection.getSlot();
      } catch {
        console.error("[PumpFun] Health check failed, reconnecting...");
        if (subscriptionId !== null) {
          try {
            const connection = getConnection();
            await connection.removeOnLogsListener(subscriptionId);
          } catch {
            // Ignore cleanup errors
          }
        }
        handleDisconnect();
      }
    }, 30000); // Check every 30 seconds

    console.log("[PumpFun] Detector started with auto-reconnect");
  } catch (err) {
    console.error("[PumpFun] Failed to start detector:", err);
    handleDisconnect();
  }
}

export async function stopDetector(): Promise<void> {
  isShuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (subscriptionId === null) {
    return;
  }

  try {
    const connection = getConnection();
    await connection.removeOnLogsListener(subscriptionId);
  } catch (err) {
    console.error("[PumpFun] Error stopping subscription:", err);
  }

  subscriptionId = null;
  console.log("[PumpFun] Detector stopped");
}

export function onTokenLaunch(callback: LaunchCallback): () => void {
  launchCallbacks.add(callback);
  return () => launchCallbacks.delete(callback);
}

export function isRunning(): boolean {
  return subscriptionId !== null;
}
