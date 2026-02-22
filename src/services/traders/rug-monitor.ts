import WebSocket from "ws";
import { id as keccak256 } from "ethers";
import { loadEnv } from "../../config/env.js";
import {
  getOpenCopyTrades,
  updateCopyTradePriceWithRugFee,
  incrementRugCount,
  updateCopyTradePairAddress,
} from "./storage.js";
import { exitCopyTrade } from "./gem-analyzer.js";
import { COPY_TRADE_CONFIG, getAlchemyWssUrl } from "./types.js";
import { dexScreenerFetch } from "../shared/dexscreener.js";
import { notifyCopyTrade } from "../telegram/notifications.js";

const V2_BURN_TOPIC = keccak256("Burn(address,uint256,uint256,address)"); // Uniswap V2
const V3_BURN_TOPIC = keccak256("Burn(address,int24,int24,uint128,uint256,uint256)"); // Uniswap V3
const V3_DECREASE_LIQUIDITY_TOPIC = keccak256("DecreaseLiquidity(uint256,uint128,uint256,uint256)"); // Uniswap V3 NonfungiblePositionManager

const connections = new Map<string, WebSocket>(); // per chain
const subscriptions = new Map<string, Map<string, string>>(); // chain -> (pair -> subId)
const pairToToken = new Map<string, { tokenAddress: string; tokenSymbol: string; chain: string }>();
const reconnectAttempts = new Map<string, number>();
const pendingRequests = new Map<number, { chain: string; pairAddress: string }>();

let monitorRunning = false;
let syncInterval: NodeJS.Timeout | null = null;
let rpcId = 1;
let syncing = false;
const pendingRechecks = new Set<string>();
const intentionalClose = new Set<string>();

function nextRpcId(): number {
  return rpcId++;
}

function getChainSubscriptions(chain: string): Map<string, string> {
  let subs = subscriptions.get(chain);
  if (!subs) {
    subs = new Map();
    subscriptions.set(chain, subs);
  }
  return subs;
}

function subscribePair(chain: string, pairAddress: string, token: { tokenAddress: string; tokenSymbol: string }): void {
  const ws = connections.get(chain);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const normalizedPair = pairAddress.toLowerCase();

  const chainSubs = getChainSubscriptions(chain);
  if (chainSubs.has(normalizedPair)) return;

  // Also check pending (RPC sent, awaiting subscription ID)
  for (const req of pendingRequests.values()) {
    if (req.chain === chain && req.pairAddress === normalizedPair) return;
  }

  const tradeKey = `${normalizedPair}_${chain}`;
  pairToToken.set(tradeKey, { ...token, chain });
  console.log(`[RugMonitor] Subscribing to ${token.tokenSymbol} (${chain}) pair ${pairAddress.slice(0, 10)}...`);

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
        topics: [[V2_BURN_TOPIC, V3_BURN_TOPIC, V3_DECREASE_LIQUIDITY_TOPIC]],
      },
    ],
  }));
}

type TradeWithPair = { pairAddress: string; tokenAddress: string; tokenSymbol: string };

function subscribeUniquePairs(chain: string, trades: TradeWithPair[]): void {
  const seen = new Set<string>();
  for (const trade of trades) {
    const normalizedPair = trade.pairAddress.toLowerCase();
    if (seen.has(normalizedPair)) continue;
    seen.add(normalizedPair);
    subscribePair(chain, trade.pairAddress, {
      tokenAddress: trade.tokenAddress,
      tokenSymbol: trade.tokenSymbol,
    });
  }
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
  pairToToken.delete(tradeKey);
  console.log(`[RugMonitor] Unsubscribed from ${pairAddress.slice(0, 10)}... (${chain})`);
}

async function handleBurnEvent(chain: string, pairAddress: string): Promise<void> {
  const normalizedPair = pairAddress.toLowerCase();
  const tradeKey = `${normalizedPair}_${chain}`;
  const tradeInfo = pairToToken.get(tradeKey);

  if (!tradeInfo) {
    // Already closed
    return;
  }

  const { tokenAddress, tokenSymbol } = tradeInfo;
  console.log(`[RugMonitor] Burn event: ${tokenSymbol} (${chain})`);

  try {
    const pair = await dexScreenerFetch(chain, tokenAddress);
    const liquidityUsd = pair?.liquidity?.usd ?? 0;
    const priceUsd = pair ? parseFloat(pair.priceUsd || "0") : 0;

    // Close ALL trades for this token, not just one
    const openTrades = getOpenCopyTrades();
    const matchingTrades = openTrades.filter(
      t => t.tokenAddress.toLowerCase() === tokenAddress.toLowerCase() && t.chain === chain
    );

    if (matchingTrades.length === 0) {
      unsubscribePair(chain, pairAddress);
      return;
    }

    // Use max entry liquidity for threshold
    const maxEntryLiq = Math.max(...matchingTrades.map(t => t.liquidityUsd));
    const belowFloor = maxEntryLiq >= COPY_TRADE_CONFIG.LIQUIDITY_RUG_FLOOR_USD && liquidityUsd < COPY_TRADE_CONFIG.LIQUIDITY_RUG_FLOOR_USD;
    const droppedFromEntry = maxEntryLiq > 0 && liquidityUsd >= 0 && liquidityUsd < maxEntryLiq * (1 - COPY_TRADE_CONFIG.LIQUIDITY_RUG_DROP_PCT / 100);

    if (belowFloor || droppedFromEntry) {
      const reason = liquidityUsd === 0
        ? "liquidity is zero"
        : droppedFromEntry
          ? `liquidity dropped ${((1 - liquidityUsd / maxEntryLiq) * 100).toFixed(0)}% ($${maxEntryLiq.toFixed(0)} -> $${liquidityUsd.toFixed(0)})`
          : `liquidity $${liquidityUsd.toFixed(0)} < $${COPY_TRADE_CONFIG.LIQUIDITY_RUG_FLOOR_USD}`;

      console.log(`[RugMonitor] REALTIME RUG: ${tokenSymbol} (${chain}) - ${reason} (${matchingTrades.length} trades)`);

      const rugFeePct = COPY_TRADE_CONFIG.ESTIMATED_RUG_FEE_PCT;
      for (const trade of matchingTrades) {
        updateCopyTradePriceWithRugFee(trade.walletAddress, tokenAddress, chain, priceUsd);
        const computedPnl = trade.buyPriceUsd > 0 && priceUsd > 0
          ? ((priceUsd / trade.buyPriceUsd - 1) * 100 - rugFeePct)
          : 0;
        trade.currentPriceUsd = priceUsd;
        const closed = await exitCopyTrade(trade, "liquidity_rug", computedPnl, "liquidity_rug");
        if (!closed) continue;
        notifyCopyTrade({
          walletAddress: trade.walletAddress,
          tokenSymbol,
          chain,
          side: "sell",
          priceUsd,
          liquidityOk: false,
          liquidityUsd,
          skipReason: "liquidity rug",
          pnlPct: computedPnl,
        }).catch(() => {});
      }
      incrementRugCount(tokenAddress, chain);
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
    const tradesForChain = getOpenCopyTrades()
      .filter((t): t is typeof t & { pairAddress: string } => t.chain === chain && !!t.pairAddress);
    subscribeUniquePairs(chain, tradesForChain);
  });

  ws.on("message", (data: WebSocket.RawData) => {
    handleMessage(chain, data.toString());
  });

  ws.on("close", () => {
    console.log(`[RugMonitor] Disconnected from Alchemy (${chain})`);
    connections.delete(chain);

    // Clear stale pending requests for this chain
    for (const [id, req] of pendingRequests) {
      if (req.chain === chain) pendingRequests.delete(id);
    }

    if (!monitorRunning) return;

    if (intentionalClose.delete(chain)) return; // planned disconnect, don't reconnect

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
  if (syncing) return;
  syncing = true;

  try {
  const openTrades = getOpenCopyTrades();

  // Backfill missing pairAddress (dedup by token+chain)
  const missingPair = openTrades.filter(t => !t.pairAddress);
  if (missingPair.length > 0) {
    const seen = new Set<string>();
    for (const trade of missingPair) {
      const key = `${trade.tokenAddress.toLowerCase()}_${trade.chain}`;
      if (seen.has(key)) {
        // Apply cached pairAddress from openTrades (missingPair has no pairAddress by definition)
        const donor = openTrades.find(t =>
          t.tokenAddress.toLowerCase() === trade.tokenAddress.toLowerCase() &&
          t.chain === trade.chain && t.pairAddress
        );
        if (donor?.pairAddress) {
          updateCopyTradePairAddress(trade.walletAddress, trade.tokenAddress, trade.chain, donor.pairAddress);
          trade.pairAddress = donor.pairAddress;
        }
        continue;
      }
      seen.add(key);
      try {
        const pair = await dexScreenerFetch(trade.chain, trade.tokenAddress);
        if (pair?.pairAddress) {
          // Apply to all trades with this token
          for (const t of missingPair) {
            if (t.tokenAddress.toLowerCase() === trade.tokenAddress.toLowerCase() && t.chain === trade.chain) {
              updateCopyTradePairAddress(t.walletAddress, t.tokenAddress, t.chain, pair.pairAddress);
              t.pairAddress = pair.pairAddress;
            }
          }
          console.log(`[RugMonitor] Backfilled pairAddress for ${trade.tokenSymbol} (${trade.chain}): ${pair.pairAddress.slice(0, 10)}...`);
        }
      } catch {
        // Skip this token, try again next sync
      }
    }
  }

  const tradesByChain = new Map<string, typeof openTrades>();

  for (const trade of openTrades) {
    if (!trade.pairAddress) continue;
    const chain = trade.chain;
    let chainList = tradesByChain.get(chain);
    if (!chainList) {
      chainList = [];
      tradesByChain.set(chain, chainList);
    }
    chainList.push(trade);
  }

  for (const [chain, trades] of tradesByChain) {
    const ws = connections.get(chain);
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      console.log(`[RugMonitor] Connecting to Alchemy (${chain}) for ${trades.length} open trade(s)`);
      connectChain(chain);
    } else if (ws.readyState === WebSocket.OPEN) {
      const chainSubs = getChainSubscriptions(chain);
      const newTrades = trades.filter(t => t.pairAddress && !chainSubs.has(t.pairAddress.toLowerCase()));
      subscribeUniquePairs(chain, newTrades as TradeWithPair[]);
    }
  }

  for (const [chain, chainSubs] of subscriptions) {
    const chainsOpenPairs = new Set(
      (tradesByChain.get(chain) ?? []).map(t => t.pairAddress?.toLowerCase() ?? "")
    );
    for (const [pairAddress] of chainSubs) {
      if (!chainsOpenPairs.has(pairAddress)) {
        unsubscribePair(chain, pairAddress);
      }
    }

    if (chainSubs.size === 0 && !tradesByChain.has(chain)) {
      const ws = connections.get(chain);
      if (ws) {
        intentionalClose.add(chain);
        ws.close();
        connections.delete(chain);
        console.log(`[RugMonitor] Closed Alchemy connection (${chain}) - no open trades`);
      }
    }
  }

  const totalSubs = Array.from(subscriptions.values()).reduce((sum, m) => sum + m.size, 0);
  const connectedChains = connections.size;
  console.log(`[RugMonitor] Sync: ${totalSubs} subscriptions across ${connectedChains} chains`);
  } finally {
    syncing = false;
  }
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
  pairToToken.clear();
  pendingRequests.clear();
  pendingRechecks.clear();
  reconnectAttempts.clear();
  intentionalClose.clear();

  for (const [chain, ws] of connections) {
    ws.close();
    connections.delete(chain);
    console.log(`[RugMonitor] Closed Alchemy connection (${chain})`);
  }
}
