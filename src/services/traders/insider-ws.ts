import WebSocket from "ws";
import { id as keccak256, AbiCoder } from "ethers";
import { loadEnv } from "../../config/env.js";
import { getInsiderWallets, getWalletCopyTradeStats, getInsiderWalletScore } from "./storage.js";
import { WATCHER_CONFIG, INSIDER_WS_CONFIG, KNOWN_DEX_ROUTERS, ALCHEMY_CHAIN_MAP, getAlchemyWssUrl, checkCircuitBreaker, SKIP_TOKEN_ADDRESSES } from "./types.js";
import { isBotOrBurnAddress } from "./scanner.js";
import { processInsiderBuy, processInsiderSell, markTransferProcessed, isTransferProcessed, setWebSocketActive, pauseWallet, isWalletPaused, cleanupProcessedTxHashes, isLpOrStable } from "./watcher.js";
import { fetchWithTimeout } from "../../utils/fetch.js";

const TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");

const connections = new Map<string, WebSocket>();
const buySubIds = new Map<string, string>();   // chain -> subscription id
const sellSubIds = new Map<string, string>();  // chain -> subscription id
const reconnectAttempts = new Map<string, number>();
const consecutiveRateLimits = new Map<string, number>();
const pendingRequests = new Map<number, { chain: string; type: "buy" | "sell" }>();
const currentWalletsByChain = new Map<string, string[]>();

let monitorRunning = false;
let syncInterval: NodeJS.Timeout | null = null;
let rpcId = 10000; // offset from rug-monitor's rpcId
let syncingWs = false;
const watchedWalletsByChain = new Map<string, Set<string>>();

const processingLock = new Set<string>();

const tokenSymbolCache = new Map<string, string>();

function nextRpcId(): number {
  return rpcId++;
}

function padAddress(address: string): string {
  const clean = address.toLowerCase().replace("0x", "");
  return "0x" + "0".repeat(24) + clean;
}

function unpadAddress(topic: string): string {
  return "0x" + topic.slice(26).toLowerCase();
}

function getQualifiedWalletsByChain(): Map<string, string[]> {
  const allWallets = getInsiderWallets();
  const qualified = allWallets
    .filter(w => w.score > WATCHER_CONFIG.MIN_WALLET_SCORE)
    .sort((a, b) => b.score - a.score);

  const byChain = new Map<string, string[]>();
  for (const w of qualified) {
    if (!ALCHEMY_CHAIN_MAP[w.chain]) continue;
    const addr = w.address.toLowerCase();
    if (isBotOrBurnAddress(addr)) continue;
    const list = byChain.get(w.chain) || [];
    list.push(addr);
    byChain.set(w.chain, list);
  }
  return byChain;
}

async function resolveTokenSymbol(tokenAddress: string, chain: string): Promise<string> {
  const cacheKey = `${chain}:${tokenAddress}`;
  const cached = tokenSymbolCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const env = loadEnv();
    const alchemyChain = ALCHEMY_CHAIN_MAP[chain];
    if (!alchemyChain || !env.ALCHEMY_API_KEY) {
      tokenSymbolCache.set(cacheKey, "UNKNOWN");
      return "UNKNOWN";
    }

    const httpsUrl = `https://${alchemyChain}-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
    const response = await fetchWithTimeout(httpsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: tokenAddress, data: "0x95d89b41" }, "latest"],
      }),
      timeoutMs: 5_000,
      retries: 1,
    });

    if (!response.ok) {
      tokenSymbolCache.set(cacheKey, "UNKNOWN");
      return "UNKNOWN";
    }

    const json = (await response.json()) as { result?: string; error?: unknown };
    const result = json.result;

    if (!result || result === "0x" || result.length < 2) {
      tokenSymbolCache.set(cacheKey, "UNKNOWN");
      return "UNKNOWN";
    }

    const decoded = new AbiCoder().decode(["string"], result)[0] as string;
    const symbol = decoded.replace(/\0/g, "").trim() || "UNKNOWN";
    tokenSymbolCache.set(cacheKey, symbol);
    return symbol;
  } catch {
    tokenSymbolCache.set(cacheKey, "UNKNOWN");
    return "UNKNOWN";
  }
}

function subscribeBuys(chain: string, wallets: string[]): void {
  const ws = connections.get(chain);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (wallets.length === 0) return;

  const paddedWallets = wallets.map(padAddress);
  const id = nextRpcId();
  pendingRequests.set(id, { chain, type: "buy" });

  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "eth_subscribe",
    params: [
      "logs",
      {
        topics: [[TRANSFER_TOPIC], null, paddedWallets],
      },
    ],
  }));
}

function subscribeSells(chain: string, wallets: string[]): void {
  const ws = connections.get(chain);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (wallets.length === 0) return;

  const paddedWallets = wallets.map(padAddress);
  const id = nextRpcId();
  pendingRequests.set(id, { chain, type: "sell" });

  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "eth_subscribe",
    params: [
      "logs",
      {
        topics: [[TRANSFER_TOPIC], paddedWallets, null],
      },
    ],
  }));
}

function unsubscribe(chain: string, subId: string): void {
  const ws = connections.get(chain);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: nextRpcId(),
    method: "eth_unsubscribe",
    params: [subId],
  }));
}

function isDexRouter(address: string, chain: string): boolean {
  const routers = KNOWN_DEX_ROUTERS[chain];
  if (!routers) return false;
  return routers.some(r => r.toLowerCase() === address);
}

async function handleTransferLog(chain: string, log: {
  address: string;
  topics: string[];
  transactionHash: string;
}): Promise<void> {
  if (!log.topics || log.topics.length < 3) return;
  if (log.topics[0] !== TRANSFER_TOPIC) return;

  const tokenAddress = log.address.toLowerCase();

  const skipTokens = SKIP_TOKEN_ADDRESSES[chain];
  if (skipTokens?.has(tokenAddress)) return;

  const fromAddress = unpadAddress(log.topics[1]);
  const toAddress = unpadAddress(log.topics[2]);
  const txHash = log.transactionHash;

  if (txHash && isTransferProcessed(txHash)) return;

  const wallets = watchedWalletsByChain.get(chain);
  if (!wallets) return;

  const isBuy = wallets.has(toAddress);
  const isSell = wallets.has(fromAddress) && isDexRouter(toAddress, chain);

  if (isBuy) {
    if (isWalletPaused(toAddress)) return;

    const lockKey = `buy_${toAddress}_${tokenAddress}_${chain}`;
    if (processingLock.has(lockKey)) return;
    processingLock.add(lockKey);
    try {
      const copyStats = getWalletCopyTradeStats(toAddress);
      const cb = checkCircuitBreaker(copyStats);
      if (cb.blocked) {
        if (copyStats.consecutiveLosses >= 3) {
          console.log(`[InsiderWS] Pausing ${toAddress.slice(0, 8)} for 24h: ${cb.reason}`);
          pauseWallet(toAddress);
        } else {
          console.log(`[InsiderWS] Rejecting ${toAddress.slice(0, 8)}: ${cb.reason}`);
        }
        return;
      }
      const tokenSymbol = await resolveTokenSymbol(tokenAddress, chain);
      if (isLpOrStable(tokenSymbol)) return;
      console.log(`[InsiderWS] Transfer IN: ${toAddress.slice(0, 8)} bought ${tokenSymbol} (${chain})`);
      const walletScore = getInsiderWalletScore(toAddress, chain);
      await processInsiderBuy({
        walletAddress: toAddress,
        walletScore,
        tokenAddress,
        tokenSymbol,
        chain,
        hasTradeHistory: copyStats.totalTrades > 0,
      });
      if (txHash) markTransferProcessed(txHash);
    } catch (err) {
      console.error(`[InsiderWS] Buy processing error:`, err);
    } finally {
      processingLock.delete(lockKey);
    }
  } else if (isSell) {
    if (isWalletPaused(fromAddress)) return;

    const lockKey = `sell_${fromAddress}_${tokenAddress}_${chain}`;
    if (processingLock.has(lockKey)) return;
    processingLock.add(lockKey);
    try {
      const soldSymbol = await resolveTokenSymbol(tokenAddress, chain);
      console.log(`[InsiderWS] Transfer OUT: ${fromAddress.slice(0, 8)} sold ${soldSymbol} (${chain})`);
      await processInsiderSell(fromAddress, tokenAddress, chain, true);
      if (txHash) markTransferProcessed(txHash);
    } catch (err) {
      console.error(`[InsiderWS] Sell processing error:`, err);
    } finally {
      processingLock.delete(lockKey);
    }
  }

  if (!isBuy && !isSell && txHash) markTransferProcessed(txHash);
}

function handleMessage(chain: string, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  if (typeof msg.id === "number" && msg.result && typeof msg.result === "string") {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      if (pending.type === "buy") {
        buySubIds.set(pending.chain, msg.result);
        console.log(`[InsiderWS] Buy subscription active (${pending.chain}): ${msg.result}`);
      } else {
        sellSubIds.set(pending.chain, msg.result);
        console.log(`[InsiderWS] Sell subscription active (${pending.chain}): ${msg.result}`);
      }
      pendingRequests.delete(msg.id);
    }
    return;
  }

  if (typeof msg.id === "number" && msg.error) {
    const pending = pendingRequests.get(msg.id);
    const errorObj = msg.error as Record<string, unknown>;
    console.error(`[InsiderWS] Subscription failed (${pending?.chain ?? "unknown"}, ${pending?.type ?? "unknown"}): code=${errorObj.code} message=${errorObj.message}`);
    if (pending) {
      pendingRequests.delete(msg.id);
    }
    return;
  }

  if (msg.method === "eth_subscription") {
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params) return;
    const result = params.result as Record<string, unknown> | undefined;
    if (!result) return;

    const log = {
      address: (result.address as string) || "",
      topics: (result.topics as string[]) || [],
      transactionHash: (result.transactionHash as string) || "",
    };

    handleTransferLog(chain, log).catch(err =>
      console.error(`[InsiderWS] handleTransferLog error:`, err)
    );
  }
}

function connectChain(chain: string, wallets: string[]): WebSocket | null {
  const url = getAlchemyWssUrl(chain);
  if (!url) return null;

  const ws = new WebSocket(url);
  connections.set(chain, ws);

  ws.on("open", () => {
    console.log(`[InsiderWS] Connected to Alchemy (${chain}), ${wallets.length} wallets`);
    reconnectAttempts.set(chain, 0);
    consecutiveRateLimits.set(chain, 0);

    watchedWalletsByChain.set(chain, new Set(wallets));

    buySubIds.delete(chain);
    sellSubIds.delete(chain);

    subscribeBuys(chain, wallets);
    subscribeSells(chain, wallets);
  });

  ws.on("message", (data: WebSocket.RawData) => {
    handleMessage(chain, data.toString());
  });

  ws.on("close", () => {
    console.log(`[InsiderWS] Disconnected from Alchemy (${chain})`);
    connections.delete(chain);
    buySubIds.delete(chain);
    sellSubIds.delete(chain);
    watchedWalletsByChain.delete(chain);

    for (const [id, req] of pendingRequests) {
      if (req.chain === chain) pendingRequests.delete(id);
    }

    if (!monitorRunning) return;
    if ((consecutiveRateLimits.get(chain) ?? 0) >= 5) return;

    const attempts = reconnectAttempts.get(chain) ?? 0;
    const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
    reconnectAttempts.set(chain, attempts + 1);

    console.log(`[InsiderWS] Reconnecting (${chain}) in ${delay}ms (attempt ${attempts + 1})`);
    setTimeout(() => {
      if (!monitorRunning) return;
      const walletsByChain = getQualifiedWalletsByChain();
      const chainWallets = walletsByChain.get(chain) || [];
      if (chainWallets.length > 0) {
        connectChain(chain, chainWallets);
      }
    }, delay);
  });

  ws.on("error", (err: Error) => {
    if (err.message.includes("429")) {
      const count = (consecutiveRateLimits.get(chain) ?? 0) + 1;
      consecutiveRateLimits.set(chain, count);
      if (count >= 5) {
        console.log(`[InsiderWS] Alchemy rate-limited on ${chain} (${count}x), giving up. Falling back to polling.`);
      } else {
        console.log(`[InsiderWS] Alchemy 429 on ${chain} (${count}/5)`);
      }
    } else {
      consecutiveRateLimits.set(chain, 0);
      console.error(`[InsiderWS] WebSocket error (${chain}):`, err.message);
    }
  });

  return ws;
}

function walletsChanged(chain: string, newWallets: string[]): boolean {
  const current = currentWalletsByChain.get(chain);
  if (!current) return true;
  if (current.length !== newWallets.length) return true;
  const currentSet = new Set(current);
  return newWallets.some(w => !currentSet.has(w));
}

async function syncSubscriptions(): Promise<void> {
  if (!monitorRunning) return;
  if (syncingWs) return;
  syncingWs = true;
  try {
    const walletsByChain = getQualifiedWalletsByChain();

    for (const [chain, wallets] of walletsByChain) {
      const ws = connections.get(chain);

      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        console.log(`[InsiderWS] Connecting to Alchemy (${chain}) for ${wallets.length} wallets`);
        connectChain(chain, wallets);
        currentWalletsByChain.set(chain, wallets);
      } else if (ws.readyState === WebSocket.OPEN && walletsChanged(chain, wallets)) {
        console.log(`[InsiderWS] Wallet list changed (${chain}), resubscribing ${wallets.length} wallets`);

        const oldBuySub = buySubIds.get(chain);
        if (oldBuySub) unsubscribe(chain, oldBuySub);
        const oldSellSub = sellSubIds.get(chain);
        if (oldSellSub) unsubscribe(chain, oldSellSub);

        buySubIds.delete(chain);
        sellSubIds.delete(chain);

        watchedWalletsByChain.set(chain, new Set(wallets));
        currentWalletsByChain.set(chain, wallets);

        subscribeBuys(chain, wallets);
        subscribeSells(chain, wallets);
      }
    }

    for (const [chain] of connections) {
      if (!walletsByChain.has(chain)) {
        const ws = connections.get(chain);
        if (ws) {
          ws.close();
          connections.delete(chain);
          buySubIds.delete(chain);
          sellSubIds.delete(chain);
          watchedWalletsByChain.delete(chain);
          currentWalletsByChain.delete(chain);
          console.log(`[InsiderWS] Closed connection (${chain}) - no qualified wallets`);
        }
      }
    }

    const totalChains = connections.size;
    const totalWallets = Array.from(watchedWalletsByChain.values()).reduce((sum, s) => sum + s.size, 0);
    console.log(`[InsiderWS] Sync: ${totalWallets} wallets across ${totalChains} chains`);

    cleanupProcessedTxHashes();
  } finally {
    syncingWs = false;
  }
}

export function startInsiderWebSocket(): void {
  const env = loadEnv();
  if (!env.ALCHEMY_API_KEY) {
    console.log("[InsiderWS] No ALCHEMY_API_KEY, skipping real-time insider detection");
    return;
  }

  if (monitorRunning) return;
  monitorRunning = true;

  setWebSocketActive(true);

  console.log("[InsiderWS] Started");

  syncSubscriptions().catch((err) => console.error("[InsiderWS] syncSubscriptions error:", err));

  syncInterval = setInterval(() => {
    syncSubscriptions().catch((err) => console.error("[InsiderWS] syncSubscriptions error:", err));
  }, INSIDER_WS_CONFIG.SYNC_INTERVAL_MS);
}

export function stopInsiderWebSocket(): void {
  if (!monitorRunning) return;
  monitorRunning = false;

  setWebSocketActive(false);

  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }

  buySubIds.clear();
  sellSubIds.clear();
  pendingRequests.clear();
  reconnectAttempts.clear();
  consecutiveRateLimits.clear();
  watchedWalletsByChain.clear();
  currentWalletsByChain.clear();
  processingLock.clear();

  for (const [chain, ws] of connections) {
    ws.close();
    connections.delete(chain);
    console.log(`[InsiderWS] Closed connection (${chain})`);
  }

  console.log("[InsiderWS] Stopped");
}
