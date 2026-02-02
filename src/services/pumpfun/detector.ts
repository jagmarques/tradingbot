import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../solana/wallet.js";
import { PUMPFUN_PROGRAM_ID } from "../../config/constants.js";

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
const launchCallbacks: Set<LaunchCallback> = new Set();

const PUMPFUN_PUBKEY = new PublicKey(PUMPFUN_PROGRAM_ID);

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

export async function startDetector(): Promise<void> {
  if (subscriptionId !== null) {
    console.log("[PumpFun] Detector already running");
    return;
  }

  const connection = getConnection();

  console.log("[PumpFun] Starting token launch detector...");

  subscriptionId = connection.onLogs(
    PUMPFUN_PUBKEY,
    async (logs) => {
      // Check if this is a create transaction
      if (!logs.logs.some((log) => log.includes("Program log: Instruction: Create"))) {
        return;
      }

      try {
        // Fetch the full transaction to parse details
        const tx = await connection.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx?.meta || tx.meta.err) return;

        const message = tx.transaction.message;
        const instructions = message.instructions;

        for (const ix of instructions) {
          if ("programId" in ix && ix.programId.equals(PUMPFUN_PUBKEY)) {
            // This is a Pump.fun instruction
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
        console.error("[PumpFun] Error processing transaction:", err);
      }
    },
    "confirmed"
  );

  console.log(`[PumpFun] Detector started (subscription: ${subscriptionId})`);
}

export async function stopDetector(): Promise<void> {
  if (subscriptionId === null) {
    return;
  }

  const connection = getConnection();
  await connection.removeOnLogsListener(subscriptionId);
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
