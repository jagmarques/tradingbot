import { ethers, JsonRpcProvider, Wallet, formatUnits } from "ethers";
import { loadEnv } from "../../config/env.js";

const USDC_CONTRACT = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // USDC on Polygon
const USDC_DECIMALS = 6;

// Minimal ERC20 ABI for balance queries
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

let provider: JsonRpcProvider | null = null;
let wallet: Wallet | null = null;

export function getProvider(): JsonRpcProvider {
  if (!provider) {
    const env = loadEnv();
    provider = new JsonRpcProvider(env.RPC_URL_POLYGON, undefined, { batchMaxCount: 1 });
    console.log("[Polygon] Provider connected");
  }
  return provider;
}

export function loadWallet(): Wallet {
  if (!wallet) {
    const env = loadEnv();
    wallet = new Wallet(env.POLYGON_PRIVATE_KEY, getProvider());
    console.log(`[Polygon] Wallet loaded: ${wallet.address}`);
  }
  return wallet;
}

export function getAddress(): string {
  return loadWallet().address;
}

export async function getMaticBalance(): Promise<bigint> {
  const w = loadWallet();
  const balance = await getProvider().getBalance(w.address);
  return balance;
}

export async function getMaticBalanceFormatted(): Promise<string> {
  const balance = await getMaticBalance();
  return formatUnits(balance, 18);
}

export async function getUsdcBalance(): Promise<bigint> {
  const w = loadWallet();
  const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, getProvider());
  const balance = await usdc.balanceOf(w.address);
  return balance;
}

export async function getUsdcBalanceFormatted(): Promise<string> {
  const balance = await getUsdcBalance();
  return formatUnits(balance, USDC_DECIMALS);
}

export async function approveUsdc(spender: string, amount: bigint): Promise<string> {
  const w = loadWallet();
  const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, w);
  const tx = await usdc.approve(spender, amount);
  await tx.wait();
  console.log(`[Polygon] Approved ${formatUnits(amount, USDC_DECIMALS)} USDC for ${spender}`);
  return tx.hash;
}

export async function getUsdcAllowance(spender: string): Promise<bigint> {
  const w = loadWallet();
  const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, getProvider());
  return usdc.allowance(w.address, spender);
}

export async function validateConnection(): Promise<boolean> {
  try {
    const blockNumber = await getProvider().getBlockNumber();
    console.log(`[Polygon] Connection valid, block: ${blockNumber}`);
    return true;
  } catch (error) {
    console.error("[Polygon] Connection validation failed:", error);
    return false;
  }
}

export function resetProvider(): void {
  provider = null;
  wallet = null;
  console.log("[Polygon] Provider reset");
}

export { USDC_CONTRACT, USDC_DECIMALS };
