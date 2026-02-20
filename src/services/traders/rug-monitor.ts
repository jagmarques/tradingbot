import WebSocket from "ws";
import { id as keccak256 } from "ethers";
import { loadEnv } from "../../config/env.js";
import {
  getOpenCopyTrades,
  closeCopyTrade,
  updateCopyTradePriceWithRugFee,
  incrementRugCount,
  updateCopyTradePairAddress,
} from "./storage.js";
import { COPY_TRADE_CONFIG } from "./types.js";
import { dexScreenerFetch } from "../shared/dexscreener.js";
import { notifyCopyTrade } from "../telegram/notifications.js";

const ALCHEMY_CHAIN_MAP: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arb",
  polygon: "polygon",
  optimism: "opt",
  avalanche: "avax",
};

const V2_BURN_TOPIC = keccak256("Burn(address,uint256,uint256,address)"); // Uniswap V2
const V3_BURN_TOPIC = keccak256("Burn(address,int24,int24,uint128,uint256,uint256)"); // Uniswap V3

const connections = new Map<string, WebSocket>(); // per chain
const subscriptions = new Map<string, Map<string, string>>(); // chain -> (pair -> subId)
const pairToTrade = new Map<string, { walletAddress: string; tokenAddress: string; tokenSymbol: string; chain: string }>();
const reconnectAttempts = new Map<string, number>();
const pendingRequests = new Map<number, { chain: string; pairAddress: string }>();

let monitorRunning = false;
let syncInterval: NodeJS.Timeout | null = null;
let rpcId = 1;
const pendingRechecks = new Set<string>();

function nextRpcId(): number {
  return rpcId++;
}

function getAlchemyWssUrl(chain: string): string | null {
  const env = loadEnv();
  const alchemyKey = env.ALCHEMY_API_KEY;
  if (!alchemyKey) return null;
  const alchemyChain = ALCHEMY_CHAIN_MAP[chain];
  if (!alchemyChain) return null;
  return `wss://${alchemyChain}-mainnet.g.alchemy.com/v2/${alchemyKey}`;
}

function getChainSubscriptions(chain: string): Map<string, string> {
  if (!subscriptions.has(chain)) {
    subscriptions.set(chain, new Map());
  }
  return subscriptions.get(chain)!;
}

function subscribePair(chain: string, pairAddress: string, trade: { walletAddress: string; tokenAddress: string; tokenSymbol: string }): void {
  const ws = connections.get(chain);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const normalizedPair = pairAddress.toLowerCase();
  const tradeKey = `${normalizedPair}_${chain}`;
  pairToTrade.set(tradeKey, { ...trade, chain });
  console.log(`[RugMonitor] Subscribed to ${trade.tokenSymbol} (${chain}) pair ${pairAddress.slice(0, 10)}...`);

  const id = nextRpcId();
  pendingRequests.set(id, { chain, pairAddress: normalizedPair });

  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "eth_subscribe",
    params: [
      "logs",
      {
        address: pairAddress,
        topics: [[V2_BURN_TOPIC, V3_BURN_TOPIC]],
      },
    ],
  }));
}

function unsubscribePair(chain: string, pairAddress: string): void {
  const normalizedPair = pairAddress.toLowerCase();
  const chainSubs = subscriptions.get(chain);
  const subId = chainSubs?.get(normalizedPair);

  if (subId) {
    const ws = connections.get(chain);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: nextRpcId(),
        method: "eth_unsubscribe",
        params: [subId],
      }));
    }
    chainSubs?.delete(normalizedPair);
  }

  const tradeKey = `${normalizedPair}_${chain}`;
  pairToTrade.delete(tradeKey);
  console.log(`[RugMonitor] Unsubscribed from ${pairAddress.slice(0, 10)}... (${chain})`);
}

async function handleBurnEvent(chain: string, pairAddress: string): Promise<void> {
  const normalizedPair = pairAddress.toLowerCase();
  const tradeKey = `${normalizedPair}_${chain}`;
  const tradeInfo = pairToTrade.get(tradeKey);

  if (!tradeInfo) {
    // Already closed
    return;
  }

  const { walletAddress, tokenAddress, tokenSymbol } = tradeInfo;
  console.log(`[RugMonitor] Burn event: ${tokenSymbol} (${chain})`);

  try {
    const pair = await dexScreenerFetch(chain, tokenAddress);
    const liquidityUsd = pair?.liquidity?.usd ?? 0;
    const priceUsd = pair ? parseFloat(pair.priceUsd || "0") : 0;

    // Get entry liquidity from DB
    const openTrades = getOpenCopyTrades();
    const trade = openTrades.find(
      t => t.walletAddress.toLowerCase() === walletAddress.toLowerCase() &&
           t.tokenAddress.toLowerCase() === tokenAddress.toLowerCase() &&
           t.chain === chain
    );

    if (!trade) {
      unsubscribePair(chain, pairAddress);
      return;
    }

    const entryLiq = trade.liquidityUsd;
    const belowFloor = entryLiq >= COPY_TRADE_CONFIG.LIQUIDITY_RUG_FLOOR_USD && liquidityUsd < COPY_TRADE_CONFIG.LIQUIDITY_RUG_FLOOR_USD;
    const droppedFromEntry = entryLiq > 0 && liquidityUsd >= 0 && liquidityUsd < entryLiq * (1 - COPY_TRADE_CONFIG.LIQUIDITY_RUG_DROP_PCT / 100);

    if (belowFloor || droppedFromEntry) {
      const reason = liquidityUsd === 0
        ? "liquidity is zero"
        : droppedFromEntry
          ? `liquidity dropped ${((1 - liquidityUsd / entryLiq) * 100).toFixed(0)}% ($${entryLiq.toFixed(0)} -> $${liquidityUsd.toFixed(0)})`
          : `liquidity $${liquidityUsd.toFixed(0)} < $${COPY_TRADE_CONFIG.LIQUIDITY_RUG_FLOOR_USD}`;

      console.log(`[RugMonitor] REALTIME RUG: ${tokenSymbol} (${chain}) - ${reason}`);

      updateCopyTradePriceWithRugFee(walletAddress, tokenAddress, chain, priceUsd);
      closeCopyTrade(walletAddress, tokenAddress, chain, "liquidity_rug");
      incrementRugCount(tokenAddress, chain);
      notifyCopyTrade({
        walletAddress,
        tokenSymbol,
        chain,
        side: "sell",
        priceUsd,
        liquidityOk: false,
        liquidityUsd,
        skipReason: "liquidity rug",
        pnlPct: trade.pnlPct,
      }).catch(() => {});

      unsubscribePair(chain, pairAddress);
    } else {
      if (pendingRechecks.has(tradeKey)) {
        // Already a recheck, don't schedule another
        pendingRechecks.delete(tradeKey);
        console.log(`[RugMonitor] Recheck: ${tokenSymbol} liquidity still ok ($${liquidityUsd.toFixed(0)}), no rug`);
      } else {
        console.log(`[RugMonitor] Burn event for ${tokenSymbol} but liquidity ok ($${liquidityUsd.toFixed(0)}), scheduling recheck in 15s`);
        pendingRechecks.add(tradeKey);
        setTimeout(() => {
          handleBurnEvent(chain, pairAddress).catch(() => {});
        }, 15_000);
      }
    }
  } catch (err) {
    console.error(`[RugMonitor] Error handling burn event for ${tokenSymbol}:`, err instanceof Error ? err.message : err);
  }
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
      const chainSubs = getChainSubscriptions(pending.chain);
      chainSubs.set(pending.pairAddress, msg.result);
      pendingRequests.delete(msg.id);
    }
    return;
  }

  if (msg.method === "eth_subscription") {
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params) return;
    const result = params.result as Record<string, unknown> | undefined;
    if (!result) return;
    const address = result.address as string | undefined;
    if (!address) return;

    handleBurnEvent(chain, address).catch(err =>
      console.error(`[RugMonitor] handleBurnEvent error:`, err)
    );
  }
}

function connectChain(chain: string): WebSocket | null {
  const url = getAlchemyWssUrl(chain);
  if (!url) return null;

  const ws = new WebSocket(url);
  connections.set(chain, ws);

  ws.on("open", () => {
    console.log(`[RugMonitor] Connected to Alchemy (${chain})`);
    reconnectAttempts.set(chain, 0);

    const chainSubs = subscriptions.get(chain);
    if (chainSubs) chainSubs.clear();
    const tradesForChain = getOpenCopyTrades().filter(t => t.chain === chain && t.pairAddress);
    for (const trade of tradesForChain) {
      subscribePair(chain, trade.pairAddress!, {
        walletAddress: trade.walletAddress,
        tokenAddress: trade.tokenAddress,
        tokenSymbol: trade.tokenSymbol,
      });
    }
  });

  ws.on("message", (data: WebSocket.RawData) => {
    handleMessage(chain, data.toString());
  });

  ws.on("close", () => {
    console.log(`[RugMonitor] Disconnected from Alchemy (${chain})`);
    connections.delete(chain);

    if (!monitorRunning) return;

    const attempts = (reconnectAttempts.get(chain) ?? 0);
    const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
    reconnectAttempts.set(chain, attempts + 1);

    console.log(`[RugMonitor] Reconnecting (${chain}) in ${delay}ms (attempt ${attempts + 1})`);
    setTimeout(() => {
      if (monitorRunning) connectChain(chain);
    }, delay);
  });

  ws.on("error", (err: Error) => {
    console.error(`[RugMonitor] WebSocket error (${chain}):`, err.message);
  });

  return ws;
}

async function syncSubscriptions(): Promise<void> {
  if (!monitorRunning) return;

  const openTrades = getOpenCopyTrades();

  // Backfill missing pairAddress from DexScreener
  const missingPair = openTrades.filter(t => !t.pairAddress);
  if (missingPair.length > 0) {
    for (const trade of missingPair) {
      try {
        const pair = await dexScreenerFetch(trade.chain, trade.tokenAddress);
        if (pair?.pairAddress) {
          updateCopyTradePairAddress(trade.walletAddress, trade.tokenAddress, trade.chain, pair.pairAddress);
          trade.pairAddress = pair.pairAddress;
          console.log(`[RugMonitor] Backfilled pairAddress for ${trade.tokenSymbol} (${trade.chain}): ${pair.pairAddress.slice(0, 10)}...`);
        }
      } catch {
        // Skip this trade, try again next sync
      }
    }
  }

  const tradesByChain = new Map<string, typeof openTrades>();

  for (const trade of openTrades) {
    if (!trade.pairAddress) continue;
    const chain = trade.chain;
    if (!tradesByChain.has(chain)) tradesByChain.set(chain, []);
    tradesByChain.get(chain)!.push(trade);
  }

  for (const [chain, trades] of tradesByChain) {
    const ws = connections.get(chain);
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      console.log(`[RugMonitor] Connecting to Alchemy (${chain}) for ${trades.length} open trade(s)`);
      connectChain(chain);
    } else if (ws.readyState === WebSocket.OPEN) {
      const chainSubs = getChainSubscriptions(chain);
      for (const trade of trades) {
        const normalizedPair = trade.pairAddress!.toLowerCase();
        if (!chainSubs.has(normalizedPair)) {
          subscribePair(chain, trade.pairAddress!, {
            walletAddress: trade.walletAddress,
            tokenAddress: trade.tokenAddress,
            tokenSymbol: trade.tokenSymbol,
          });
        }
      }
    }
  }

  for (const [chain, chainSubs] of subscriptions) {
    const chainsOpenPairs = new Set(
      (tradesByChain.get(chain) ?? []).map(t => t.pairAddress!.toLowerCase())
    );
    for (const [pairAddress] of chainSubs) {
      if (!chainsOpenPairs.has(pairAddress)) {
        unsubscribePair(chain, pairAddress);
      }
    }

    if (chainSubs.size === 0 && !tradesByChain.has(chain)) {
      const ws = connections.get(chain);
      if (ws) {
        ws.close();
        connections.delete(chain);
        console.log(`[RugMonitor] Closed Alchemy connection (${chain}) - no open trades`);
      }
    }
  }

  const totalSubs = Array.from(subscriptions.values()).reduce((sum, m) => sum + m.size, 0);
  const connectedChains = connections.size;
  console.log(`[RugMonitor] Sync: ${totalSubs} subscriptions across ${connectedChains} chains`);
}

export function startRugMonitor(): void {
  const env = loadEnv();
  if (!env.ALCHEMY_API_KEY) {
    console.log("[RugMonitor] No ALCHEMY_API_KEY, skipping real-time rug detection");
    return;
  }

  if (monitorRunning) return;
  monitorRunning = true;

  console.log("[RugMonitor] Started (Alchemy WebSocket)");
  const openTrades = getOpenCopyTrades();
  const withPair = openTrades.filter(t => t.pairAddress).length;
  const withoutPair = openTrades.length - withPair;
  console.log(`[RugMonitor] Open trades: ${openTrades.length} total, ${withPair} with pairAddress, ${withoutPair} pending backfill`);
  syncSubscriptions().catch(() => {});

  syncInterval = setInterval(() => {
    syncSubscriptions().catch(() => {});
  }, 30_000);
}

export function stopRugMonitor(): void {
  if (!monitorRunning) return;
  monitorRunning = false;

  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }

  for (const [chain, chainSubs] of subscriptions) {
    for (const [pairAddress] of chainSubs) {
      unsubscribePair(chain, pairAddress);
    }
  }
  subscriptions.clear();
  pairToTrade.clear();
  pendingRequests.clear();
  pendingRechecks.clear();

  for (const [chain, ws] of connections) {
    ws.close();
    connections.delete(chain);
    console.log(`[RugMonitor] Closed Alchemy connection (${chain})`);
  }
}
