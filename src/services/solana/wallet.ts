import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadEnv } from "../../config/env.js";

const SOLANA_RPC = process.env.ALCHEMY_SOLANA_RPC || "https://api.mainnet-beta.solana.com";

let connection: Connection | null = null;
let heliusConnection: Connection | null = null;
let keypair: Keypair | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(SOLANA_RPC, {
      commitment: "confirmed",
    });
    const provider = process.env.ALCHEMY_SOLANA_RPC ? "Alchemy" : "public";
    console.log(`[Solana] Connection established (${provider} RPC)`);
  }
  return connection;
}

/** Helius RPC connection for transaction submission (Jupiter swaps via Jito) */
export function getHeliusConnection(): Connection {
  if (!heliusConnection) {
    const env = loadEnv();
    heliusConnection = new Connection(
      `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`,
      { commitment: "confirmed" }
    );
    console.log("[Solana] Helius connection established (for tx submission)");
  }
  return heliusConnection;
}

export function loadKeypair(): Keypair {
  if (!keypair) {
    const env = loadEnv();
    const privateKeyBytes = bs58.decode(env.SOLANA_PRIVATE_KEY);
    keypair = Keypair.fromSecretKey(privateKeyBytes);
    // Only log truncated address for security
    const addr = keypair.publicKey.toBase58();
    console.log(`[Solana] Wallet loaded: ${addr.slice(0, 8)}...${addr.slice(-4)}`);
  }
  return keypair;
}

export function getPublicKey(): PublicKey {
  return loadKeypair().publicKey;
}

export async function getSolBalance(): Promise<bigint> {
  const conn = getConnection();
  const pubkey = getPublicKey();
  const lamports = await conn.getBalance(pubkey);
  return BigInt(lamports);
}

export async function getSolBalanceFormatted(): Promise<string> {
  const lamports = await getSolBalance();
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  return sol.toFixed(4);
}

export async function hasMinimumSolReserve(): Promise<boolean> {
  const env = loadEnv();
  const lamports = await getSolBalance();
  const minReserveLamports = BigInt(Math.floor(env.MIN_SOL_RESERVE * LAMPORTS_PER_SOL));
  return lamports >= minReserveLamports;
}

export async function validateConnection(): Promise<boolean> {
  try {
    const conn = getConnection();
    const slot = await conn.getSlot();
    console.log(`[Solana] Connection valid, current slot: ${slot}`);
    return true;
  } catch (error) {
    console.error("[Solana] Connection validation failed:", error);
    return false;
  }
}

export function resetConnection(): void {
  connection = null;
  heliusConnection = null;
  console.log("[Solana] Connection reset");
}
