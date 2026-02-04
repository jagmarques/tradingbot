import { ethers } from "ethers";
import { WEBSOCKET_RECONNECT_BASE_MS, WEBSOCKET_RECONNECT_MAX_MS } from "../../config/constants.js";

// Avalanche configuration
const AVAX_WSS_URL = "wss://api.avax.network/ext/bc/C/ws";

// Trader Joe V2.1 LB Factory
const TRADER_JOE_LB_FACTORY = "0x8e42f2F4101563bF679975178e880FD87d3eFd4e";
// Pangolin Factory
const PANGOLIN_FACTORY = "0xefa94DE7a4656D787667C749f7E1223D71E9FD88";
// SushiSwap Factory on Avalanche
const SUSHISWAP_FACTORY = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4";

// WAVAX on Avalanche
const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
// USDC on Avalanche
const USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
// USDT on Avalanche
const USDT = "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7";

// Factory ABIs
const V2_FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)"
];

const LB_FACTORY_ABI = [
  "event LBPairCreated(address indexed tokenX, address indexed tokenY, uint256 indexed binStep, address LBPair, uint256 pid)"
];

export interface NewPair {
  chain: "avalanche";
  dex: "trader_joe" | "pangolin" | "sushiswap";
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
    lower === WAVAX.toLowerCase() ||
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
      console.error("[Avalanche] Callback error:", err);
    }
  }
}

async function setupSubscriptions(): Promise<void> {
  if (!provider) return;

  // Trader Joe LB Factory
  const tjFactory = new ethers.Contract(TRADER_JOE_LB_FACTORY, LB_FACTORY_ABI, provider);
  tjFactory.on("LBPairCreated", (tokenX, tokenY, _binStep, lbPair, _pid, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(tokenX, tokenY);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "avalanche",
      dex: "trader_joe",
      token0: tokenX,
      token1: tokenY,
      pairAddress: lbPair,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[Avalanche] New Trader Joe LB pair: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  // Pangolin Factory
  const pangolinFactory = new ethers.Contract(PANGOLIN_FACTORY, V2_FACTORY_ABI, provider);
  pangolinFactory.on("PairCreated", (token0, token1, pairAddress, _, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "avalanche",
      dex: "pangolin",
      token0,
      token1,
      pairAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[Avalanche] New Pangolin pair: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  // SushiSwap Factory
  const sushiFactory = new ethers.Contract(SUSHISWAP_FACTORY, V2_FACTORY_ABI, provider);
  sushiFactory.on("PairCreated", (token0, token1, pairAddress, _, event) => {
    reconnectAttempts = 0;

    const tokens = getNewToken(token0, token1);
    if (!tokens) return;

    const pair: NewPair = {
      chain: "avalanche",
      dex: "sushiswap",
      token0,
      token1,
      pairAddress,
      newToken: tokens.newToken,
      baseToken: tokens.baseToken,
      timestamp: Date.now(),
      txHash: event.log.transactionHash,
    };

    console.log(`[Avalanche] New SushiSwap pair: ${pair.newToken}`);
    notifyCallbacks(pair);
  });

  console.log("[Avalanche] Subscribed to Trader Joe, Pangolin, and SushiSwap factories");
}

async function handleDisconnect(): Promise<void> {
  if (!isRunning) return;

  const delay = Math.min(
    WEBSOCKET_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
    WEBSOCKET_RECONNECT_MAX_MS
  );
  reconnectAttempts++;

  console.error(`[Avalanche] WebSocket disconnected. Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(async () => {
    try {
      if (provider) {
        await provider.destroy();
      }
      provider = new ethers.WebSocketProvider(AVAX_WSS_URL);
      await setupSubscriptions();
      console.log("[Avalanche] Reconnected successfully");
    } catch (err) {
      console.error("[Avalanche] Reconnection failed:", err);
      handleDisconnect();
    }
  }, delay);
}

export async function startDetector(): Promise<void> {
  if (isRunning) {
    console.log("[Avalanche] Detector already running");
    return;
  }

  isRunning = true;
  reconnectAttempts = 0;

  console.log("[Avalanche] Starting new pair detector...");

  try {
    provider = new ethers.WebSocketProvider(AVAX_WSS_URL);

    provider.on("error", (err: Error) => {
      console.error("[Avalanche] Provider error:", err.message);
      if (isRunning) {
        handleDisconnect();
      }
    });

    await setupSubscriptions();
    console.log("[Avalanche] Detector started with auto-reconnect");
  } catch (err) {
    console.error("[Avalanche] Failed to start detector:", err);
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

  console.log("[Avalanche] Detector stopped");
}

export function onNewPair(callback: PairCallback): () => void {
  pairCallbacks.add(callback);
  return () => pairCallbacks.delete(callback);
}

export function isDetectorRunning(): boolean {
  return isRunning;
}
