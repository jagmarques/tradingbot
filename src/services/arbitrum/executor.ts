import { ethers } from "ethers";
import { loadEnv } from "../../config/env.js";

let provider: ethers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    const env = loadEnv();
    provider = new ethers.JsonRpcProvider(env.RPC_URL_ARBITRUM, undefined, { batchMaxCount: 1 });
  }
  return provider;
}

function getWallet(): ethers.Wallet {
  if (!wallet) {
    const env = loadEnv();
    const privateKey = env.PRIVATE_KEY_EVM || env.POLYGON_PRIVATE_KEY;
    wallet = new ethers.Wallet(privateKey, getProvider());
  }
  return wallet;
}

export async function getEthBalance(): Promise<bigint> {
  const w = getWallet();
  return await getProvider().getBalance(w.address);
}
