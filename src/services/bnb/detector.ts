import { ethers } from "ethers";
import { WEBSOCKET_RECONNECT_BASE_MS, WEBSOCKET_RECONNECT_MAX_MS } from "../../config/constants.js";

// BNB Chain configuration
const BSC_WSS_URL = "wss://bsc-ws-node.nariox.org:443";

// PancakeSwap V2 Factory on BSC
const PANCAKESWAP_V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
// PancakeSwap V3 Factory on BSC
const PANCAKESWAP_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
// BiSwap Factory
const BISWAP_FACTORY = "0x858E3312ed3A876947EA49d572A7C42DE08af7EE";

// WBNB on BSC
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
// BUSD on BSC
const BUSD = "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56";
// USDT on BSC
const USDT = "0x55d398326f99059fF775485246999027B3197955";

// Factory ABIs
const V2_FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)"
];

const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
];

export interface NewPair {
  chain: "bnb";
  dex: "pancakeswap_v2" | "pancakeswap_v3" | "biswap";
  token0: string;
  token1: string;
  pairAddress: string;
  newToken: string;
  baseToken: string;
  timestamp: number;
  txHash: string;
}

type PairCallback = (pair: NewPair) => void;

let provider: ethers.WebSocketProvider | null = null;
let isRunning = false;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
const pairCallbacks: Set<PairCallback> = new Set();

function isBaseToken(address: string): boolean {
  const lower = address.toLowerCase();
  return (
    lower === WBNB.toLowerCase() ||
    lower === BUSD.toLowerCase() ||
    lower === USDT.toLowerCase()
  );
}

function getNewToken(token0: string, token1: string): { newToken: string; baseToken: string } | null {
  const isToken0Base = isBaseToken(token0);
  const isToken1Base = isBaseToken(token1);

  if (isToken0Base && !isToken1Base) {
    return { newToken: token1, baseToken: token0 };
  }
  if (!isToken0Base && isToken1Base) {
    return { newToken: token0, baseToken: token1 };
  }

  return null;
}

function notifyCallbacks(pair: NewPair): void {
  for (const callback of pairCallbacks) {
    try {
      callback(pair);
    } catch (err) {
      console.error("[BNB] Callback error:", err);
    }
  }
}

async function setupSubscriptions(): Promise<void> {
  if (!provider) return;

  // PancakeSwap V2 Factory
  const v2Factory = new ethers.Contract(PANCAKESWAP_V2_FACTORY, V2_FACTORY_ABI, provider);
  v2Factory.on("PairCreated", (token0, token1, pairAddress, _, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "bnb",
      dex: "pancakeswap_v2",
      token0,
      token1,
      pairAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[BNB] New PancakeSwap V2 pair: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  // PancakeSwap V3 Factory
  const v3Factory = new ethers.Contract(PANCAKESWAP_V3_FACTORY, V3_FACTORY_ABI, provider);
  v3Factory.on("PoolCreated", (token0, token1, _fee, _tickSpacing, poolAddress, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "bnb",
      dex: "pancakeswap_v3",
      token0,
      token1,
      pairAddress: poolAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[BNB] New PancakeSwap V3 pool: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  // BiSwap Factory
  const biswapFactory = new ethers.Contract(BISWAP_FACTORY, V2_FACTORY_ABI, provider);
  biswapFactory.on("PairCreated", (token0, token1, pairAddress, _, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "bnb",
      dex: "biswap",
      token0,
      token1,
      pairAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[BNB] New BiSwap pair: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  console.log("[BNB] Subscribed to PancakeSwap V2, V3, and BiSwap factories");
}

async function handleDisconnect(): Promise<void> {
  if (!isRunning) return;

  const delay = Math.min(
    WEBSOCKET_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
    WEBSOCKET_RECONNECT_MAX_MS
  );
  reconnectAttempts++;

  console.error(`[BNB] WebSocket disconnected. Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(async () => {
    try {
      if (provider) {
        await provider.destroy();
      }
      provider = new ethers.WebSocketProvider(BSC_WSS_URL);
      await setupSubscriptions();
      console.log("[BNB] Reconnected successfully");
    } catch (err) {
      console.error("[BNB] Reconnection failed:", err);
      handleDisconnect();
    }
  }, delay);
}

export async function startDetector(): Promise<void> {
  if (isRunning) {
    console.log("[BNB] Detector already running");
    return;
  }

  isRunning = true;
  reconnectAttempts = 0;

  console.log("[BNB] Starting new pair detector...");

  try {
    provider = new ethers.WebSocketProvider(BSC_WSS_URL);

    provider.on("error", (err: Error) => {
      console.error("[BNB] Provider error:", err.message);
      if (isRunning) {
        handleDisconnect();
      }
    });

    await setupSubscriptions();
    console.log("[BNB] Detector started with auto-reconnect");
  } catch (err) {
    console.error("[BNB] Failed to start detector:", err);
    handleDisconnect();
  }
}

export async function stopDetector(): Promise<void> {
  isRunning = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (provider) {
    await provider.destroy();
    provider = null;
  }

  console.log("[BNB] Detector stopped");
}

export function onNewPair(callback: PairCallback): () => void {
  pairCallbacks.add(callback);
  return () => pairCallbacks.delete(callback);
}

export function isDetectorRunning(): boolean {
  return isRunning;
}
