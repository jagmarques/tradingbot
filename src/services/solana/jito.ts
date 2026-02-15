import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { loadEnv } from "../../config/env.js";
import { getHeliusConnection, loadKeypair } from "./wallet.js";
import {
  JITO_MAX_RETRIES,
  JITO_RETRY_BASE_MS,
  JITO_RETRY_MAX_MS,
} from "../../config/constants.js";

const JITO_BLOCK_ENGINE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bVmkdzGHWAG9X2CMVH9GMX",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

function getRandomTipAccount(): PublicKey {
  const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
}

function getTipAmountLamports(): bigint {
  const env = loadEnv();
  return BigInt(Math.floor(env.JITO_TIP_AMOUNT * LAMPORTS_PER_SOL));
}

export function createTipInstruction(payer: PublicKey): TransactionInstruction {
  const tipAccount = getRandomTipAccount();
  const tipAmount = getTipAmountLamports();

  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: tipAccount,
    lamports: tipAmount,
  });
}

export async function submitBundle(
  transactions: VersionedTransaction[]
): Promise<string | null> {
  const serializedTxs = transactions.map((tx) =>
    Buffer.from(tx.serialize()).toString("base64")
  );

  try {
    const response = await fetch(JITO_BLOCK_ENGINE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serializedTxs],
      }),
    });

    const result = (await response.json()) as {
      result?: string;
      error?: { message: string };
    };

    if (result.error) {
      console.error("[Jito] Bundle submission error:", result.error.message);
      return null;
    }

    console.log(`[Jito] Bundle submitted: ${result.result}`);
    return result.result ?? null;
  } catch (error) {
    console.error("[Jito] Bundle submission failed:", error);
    return null;
  }
}

export async function submitBundleWithRetry(
  transactions: VersionedTransaction[],
  maxRetries = JITO_MAX_RETRIES
): Promise<string | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const bundleId = await submitBundle(transactions);

    if (bundleId) {
      return bundleId;
    }

    // Exponential backoff: 500ms, 1000ms, 2000ms
    const delayMs = Math.min(
      JITO_RETRY_BASE_MS * Math.pow(2, attempt),
      JITO_RETRY_MAX_MS
    );

    console.log(`[Jito] Retry ${attempt + 1}/${maxRetries} after ${delayMs}ms`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  console.error(`[Jito] All ${maxRetries} retries failed`);
  return null;
}

export async function getBundleStatus(bundleId: string): Promise<string | null> {
  try {
    const response = await fetch(JITO_BLOCK_ENGINE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
      }),
    });

    const result = (await response.json()) as {
      result?: { value: Array<{ bundle_id: string; status: string }> };
      error?: { message: string };
    };

    if (result.error) {
      console.error("[Jito] Status check error:", result.error.message);
      return null;
    }

    const status = result.result?.value?.[0]?.status;
    return status ?? null;
  } catch (error) {
    console.error("[Jito] Status check failed:", error);
    return null;
  }
}

export async function createAndSubmitBundledTransaction(
  instructions: TransactionInstruction[]
): Promise<string | null> {
  const connection = getHeliusConnection();
  const keypair = loadKeypair();

  const tipInstruction = createTipInstruction(keypair.publicKey);
  const allInstructions = [...instructions, tipInstruction];

  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const transaction = new Transaction();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = keypair.publicKey;
  allInstructions.forEach((ix) => transaction.add(ix));

  transaction.sign(keypair);

  const versionedTx = VersionedTransaction.deserialize(transaction.serialize());

  return submitBundleWithRetry([versionedTx]);
}

export async function waitForBundleConfirmation(
  bundleId: string,
  maxAttempts = 30,
  delayMs = 1000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const status = await getBundleStatus(bundleId);

    if (status === "Landed") {
      console.log(`[Jito] Bundle ${bundleId} landed on chain`);
      return true;
    }

    if (status === "Failed") {
      console.error(`[Jito] Bundle ${bundleId} failed`);
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  console.error(`[Jito] Bundle ${bundleId} confirmation timeout`);
  return false;
}
