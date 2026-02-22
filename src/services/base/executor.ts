import { ethers } from "ethers";
import { loadEnv } from "../../config/env.js";

let provider: ethers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    const env = loadEnv();
    provider = new ethers.JsonRpcProvider(env.RPC_URL_BASE, undefined, { batchMaxCount: 1 });
  }
  return provider;
}

function getWallet(): ethers.Wallet {
  if (!wallet) {
    const env = loadEnv();
    wallet = new ethers.Wallet(env.POLYGON_PRIVATE_KEY, getProvider());
  }
  return wallet;
}

export async function getEthBalance(): Promise<bigint> {
  const w = getWallet();
  return await getProvider().getBalance(w.address);
}
