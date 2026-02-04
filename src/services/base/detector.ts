import { ethers } from "ethers";
import { WEBSOCKET_RECONNECT_BASE_MS, WEBSOCKET_RECONNECT_MAX_MS } from "../../config/constants.js";

// Base chain configuration
const BASE_WSS_URL = "wss://base-mainnet.g.alchemy.com/v2/demo"; // Replace with your Alchemy key

// Uniswap V2 Factory on Base
const UNISWAP_V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";
// Uniswap V3 Factory on Base
const UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
// Aerodrome (Base native DEX)
const AERODROME_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

// WETH on Base
const WETH_BASE = "0x4200000000000000000000000000000000000006";
// USDC on Base
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Factory ABIs (PairCreated event)
const UNISWAP_V2_FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)"
];

const UNISWAP_V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
];

export interface NewPair {
  chain: "base";
  dex: "uniswap_v2" | "uniswap_v3" | "aerodrome";
  token0: string;
  token1: string;
  pairAddress: string;
  newToken: string; // The non-WETH/USDC token
  baseToken: string; // WETH or USDC
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
  return lower === WETH_BASE.toLowerCase() || lower === USDC_BASE.toLowerCase();
}

function getNewToken(token0: string, token1: string): { newToken: string; baseToken: string } | null {
  const isToken0Base = isBaseToken(token0);
  const isToken1Base = isBaseToken(token1);

  // We want pairs where exactly one token is WETH/USDC
  if (isToken0Base && !isToken1Base) {
    return { newToken: token1, baseToken: token0 };
  }
  if (!isToken0Base && isToken1Base) {
    return { newToken: token0, baseToken: token1 };
  }

  // Both are base tokens or neither - not interesting
  return null;
}

function notifyCallbacks(pair: NewPair): void {
  for (const callback of pairCallbacks) {
    try {
      callback(pair);
    } catch (err) {
      console.error("[Base] Callback error:", err);
    }
  }
}

async function setupSubscriptions(): Promise<void> {
  if (!provider) return;

  // Uniswap V2 Factory
  const v2Factory = new ethers.Contract(UNISWAP_V2_FACTORY, UNISWAP_V2_FACTORY_ABI, provider);
  v2Factory.on("PairCreated", (token0, token1, pairAddress, _, event) => {
    reconnectAttempts = 0; // Reset on successful event

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "base",
      dex: "uniswap_v2",
      token0,
      token1,
      pairAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[Base] New Uniswap V2 pair: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  // Uniswap V3 Factory
  const v3Factory = new ethers.Contract(UNISWAP_V3_FACTORY, UNISWAP_V3_FACTORY_ABI, provider);
  v3Factory.on("PoolCreated", (token0, token1, _fee, _tickSpacing, poolAddress, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "base",
      dex: "uniswap_v3",
      token0,
      token1,
      pairAddress: poolAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[Base] New Uniswap V3 pool: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  // Aerodrome Factory (same event signature as V2)
  const aeroFactory = new ethers.Contract(AERODROME_FACTORY, UNISWAP_V2_FACTORY_ABI, provider);
  aeroFactory.on("PairCreated", (token0, token1, pairAddress, _, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "base",
      dex: "aerodrome",
      token0,
      token1,
      pairAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[Base] New Aerodrome pair: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  console.log("[Base] Subscribed to V2, V3, and Aerodrome factories");
}

async function handleDisconnect(): Promise<void> {
  if (!isRunning) return;

  const delay = Math.min(
    WEBSOCKET_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
    WEBSOCKET_RECONNECT_MAX_MS
  );
  reconnectAttempts++;

  console.error(`[Base] WebSocket disconnected. Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(async () => {
    try {
      if (provider) {
        await provider.destroy();
      }
      provider = new ethers.WebSocketProvider(BASE_WSS_URL);
      await setupSubscriptions();
      console.log("[Base] Reconnected successfully");
    } catch (err) {
      console.error("[Base] Reconnection failed:", err);
      handleDisconnect();
    }
  }, delay);
}

export async function startDetector(): Promise<void> {
  if (isRunning) {
    console.log("[Base] Detector already running");
    return;
  }

  isRunning = true;
  reconnectAttempts = 0;

  console.log("[Base] Starting new pair detector...");

  try {
    provider = new ethers.WebSocketProvider(BASE_WSS_URL);

    // Handle disconnection - use provider events instead of websocket directly
    provider.on("error", (err: Error) => {
      console.error("[Base] Provider error:", err.message);
      if (isRunning) {
        handleDisconnect();
      }
    });

    await setupSubscriptions();
    console.log("[Base] Detector started with auto-reconnect");
  } catch (err) {
    console.error("[Base] Failed to start detector:", err);
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

  console.log("[Base] Detector stopped");
}

export function onNewPair(callback: PairCallback): () => void {
  pairCallbacks.add(callback);
  return () => pairCallbacks.delete(callback);
}

export function isDetectorRunning(): boolean {
  return isRunning;
}
