import { ethers } from "ethers";
import { WEBSOCKET_RECONNECT_BASE_MS, WEBSOCKET_RECONNECT_MAX_MS } from "../../config/constants.js";

// Arbitrum configuration
const ARBITRUM_WSS_URL = "wss://arb1.arbitrum.io/ws";

// Uniswap V3 Factory on Arbitrum
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
// Camelot V2 Factory on Arbitrum
const CAMELOT_V2_FACTORY = "0x6EcCab422D763aC031210895C81787E87B43A652";
// SushiSwap V2 Factory
const SUSHISWAP_FACTORY = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4";

// WETH on Arbitrum
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
// USDC on Arbitrum
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
// USDT on Arbitrum
const USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";

// Factory ABIs
const V2_FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)"
];

const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
];

export interface NewPair {
  chain: "arbitrum";
  dex: "uniswap_v3" | "camelot" | "sushiswap";
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
    lower === WETH.toLowerCase() ||
    lower === USDC.toLowerCase() ||
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
      console.error("[Arbitrum] Callback error:", err);
    }
  }
}

async function setupSubscriptions(): Promise<void> {
  if (!provider) return;

  // Uniswap V3 Factory
  const v3Factory = new ethers.Contract(UNISWAP_V3_FACTORY, V3_FACTORY_ABI, provider);
  v3Factory.on("PoolCreated", (token0, token1, _fee, _tickSpacing, poolAddress, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "arbitrum",
      dex: "uniswap_v3",
      token0,
      token1,
      pairAddress: poolAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[Arbitrum] New Uniswap V3 pool: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  // Camelot V2 Factory
  const camelotFactory = new ethers.Contract(CAMELOT_V2_FACTORY, V2_FACTORY_ABI, provider);
  camelotFactory.on("PairCreated", (token0, token1, pairAddress, _, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "arbitrum",
      dex: "camelot",
      token0,
      token1,
      pairAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[Arbitrum] New Camelot pair: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  // SushiSwap Factory
  const sushiFactory = new ethers.Contract(SUSHISWAP_FACTORY, V2_FACTORY_ABI, provider);
  sushiFactory.on("PairCreated", (token0, token1, pairAddress, _, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "arbitrum",
      dex: "sushiswap",
      token0,
      token1,
      pairAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[Arbitrum] New SushiSwap pair: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  console.log("[Arbitrum] Subscribed to Uniswap V3, Camelot, and SushiSwap factories");
}

async function handleDisconnect(): Promise<void> {
  if (!isRunning) return;

  const delay = Math.min(
    WEBSOCKET_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
    WEBSOCKET_RECONNECT_MAX_MS
  );
  reconnectAttempts++;

  console.error(`[Arbitrum] WebSocket disconnected. Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(async () => {
    try {
      if (provider) {
        await provider.destroy();
      }
      provider = new ethers.WebSocketProvider(ARBITRUM_WSS_URL);
      await setupSubscriptions();
      console.log("[Arbitrum] Reconnected successfully");
    } catch (err) {
      console.error("[Arbitrum] Reconnection failed:", err);
      handleDisconnect();
    }
  }, delay);
}

export async function startDetector(): Promise<void> {
  if (isRunning) {
    console.log("[Arbitrum] Detector already running");
    return;
  }

  isRunning = true;
  reconnectAttempts = 0;

  console.log("[Arbitrum] Starting new pair detector...");

  try {
    provider = new ethers.WebSocketProvider(ARBITRUM_WSS_URL);

    provider.on("error", (err: Error) => {
      console.error("[Arbitrum] Provider error:", err.message);
      if (isRunning) {
        handleDisconnect();
      }
    });

    await setupSubscriptions();
    console.log("[Arbitrum] Detector started with auto-reconnect");
  } catch (err) {
    console.error("[Arbitrum] Failed to start detector:", err);
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

  console.log("[Arbitrum] Detector stopped");
}

export function onNewPair(callback: PairCallback): () => void {
  pairCallbacks.add(callback);
  return () => pairCallbacks.delete(callback);
}

export function isDetectorRunning(): boolean {
  return isRunning;
}
