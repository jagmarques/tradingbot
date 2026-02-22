import type { EvmChain, PumpedToken, GemHit, InsiderScanResult } from "./types.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { INSIDER_CONFIG, WATCHER_CONFIG, stripEmoji } from "./types.js";
import { loadEnv } from "../../config/env.js";
import { upsertGemHit, upsertInsiderWallet, getInsiderWallets, getGemHitsForWallet, updateGemHitPnl, getAllHeldGemHits, updateGemHitPumpMultiple, setLaunchPrice, getCachedGemAnalysis, getGemPaperTrade, getPromisingWalletsForHistoryScan, getAllWalletCopyTradeStats, deleteInsiderWalletsBelow } from "./storage.js";
import type { WalletCopyTradeStats } from "./storage.js";
import { getDb } from "../database/db.js";
import { KNOWN_EXCHANGES, KNOWN_DEX_ROUTERS } from "./types.js";
import { analyzeGemsBackground, refreshGemPaperPrices, sellGemPosition } from "./gem-analyzer.js";
import { dexScreenerFetch, dexScreenerFetchBatch } from "../shared/dexscreener.js";
import { formatPrice } from "../../utils/format.js";

// GeckoTerminal API
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_NETWORK_IDS: Record<EvmChain, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  optimism: "optimism",
  avalanche: "avax",
};

// Etherscan V2 API
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

// Routescan API for Avalanche (Snowtrace)
const ROUTESCAN_AVAX_URL = "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api";

const ETHERSCAN_CHAIN_IDS: Record<EvmChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  optimism: 10,
  avalanche: 43114,
};

// Free explorer APIs: eth/arb/polygon (Etherscan V2), avax (Routescan)
export const EXPLORER_SUPPORTED_CHAINS = new Set<string>(["ethereum", "arbitrum", "polygon", "avalanche"]);

export function buildExplorerUrl(chain: EvmChain, params: string): string {
  const env = loadEnv();
  if (chain === "avalanche") {
    const apiKey = env.SNOWTRACE_API_KEY ?? "";
    return `${ROUTESCAN_AVAX_URL}?${params}${apiKey ? `&apikey=${apiKey}` : ""}`;
  }
  const chainId = ETHERSCAN_CHAIN_IDS[chain];
  const apiKey = env.ETHERSCAN_API_KEY ?? "";
  return `${ETHERSCAN_V2_URL}?chainid=${chainId}&${params}${apiKey ? `&apikey=${apiKey}` : ""}`;
}

export const BURN_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000", // zero address
  "0x000000000000000000000000000000000000dead", // common burn (lowercase)
  "0x0000000000000000000000000000000000000001", // ecrecover precompile
  "0x0000000000000000000000000000000000000002", // SHA-256 precompile
  "0x0000000000000000000000000000000000000003", // RIPEMD precompile
]);

export function isBotOrBurnAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  if (BURN_ADDRESSES.has(a)) return true;
  if (a.startsWith("0x00000000")) return true;
  return false;
}

// GeckoTerminal: ~12 calls/cycle, actual limit ~6/min (stricter than documented), 15s spacing
let geckoQueue: Promise<void> = Promise.resolve();

async function geckoRateLimitedFetch(url: string): Promise<Response> {
  const myTurn = geckoQueue.then(() => new Promise<void>((r) => setTimeout(r, 15_000)));
  geckoQueue = myTurn;
  await myTurn;
  const response = await fetchWithTimeout(url);
  if (response.status !== 429) return response;
  const delays = [15_000, 30_000, 60_000];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const delay = delays[attempt - 1];
    const endpoint = url.replace("https://api.geckoterminal.com/api/v2", "").slice(0, 60);
    console.log(`[InsiderScanner] GeckoTerminal 429 on ${endpoint}, retry ${attempt}/3 in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    const retry = await fetchWithTimeout(url);
    if (retry.status !== 429) return retry;
  }
  const exhaustedEndpoint = url.replace("https://api.geckoterminal.com/api/v2", "").slice(0, 60);
  console.log(`[InsiderScanner] GeckoTerminal 429 exhausted retries for ${exhaustedEndpoint}`);
  return response;
}

async function fetchLaunchPrice(chain: EvmChain, pairAddress: string): Promise<number> {
  if (!pairAddress) return 0;
  const network = GECKO_NETWORK_IDS[chain];
  if (!network) return 0;
  try {
    const url = `${GECKO_BASE}/networks/${network}/pools/${pairAddress}/ohlcv/day?limit=200&currency=usd`;
    const resp = await geckoRateLimitedFetch(url);
    if (!resp.ok) return 0;
    const data = await resp.json() as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const candles = data?.data?.attributes?.ohlcv_list;
    if (!candles || candles.length === 0) return 0;
    // Candles are newest-first; last = earliest
    const earliest = candles[candles.length - 1];
    const openPrice = earliest[1];
    return openPrice > 0 ? openPrice : 0;
  } catch {
    return 0;
  }
}

const ETHERSCAN_INTERVAL_MS = 220;
const etherscanQueueByChain = new Map<string, Promise<void>>();

export async function etherscanRateLimitedFetch(url: string, chain: string): Promise<Response> {
  const currentQueue = etherscanQueueByChain.get(chain) || Promise.resolve();
  const interval = chain === "avalanche" ? 550 : ETHERSCAN_INTERVAL_MS;
  const myTurn = currentQueue.then(async () => {
    await new Promise((r) => setTimeout(r, interval));
  });
  etherscanQueueByChain.set(chain, myTurn);
  await myTurn;
  return fetchWithTimeout(url);
}

interface GeckoPool {
  id: string;
  type: string;
  attributes: {
    name: string;
    address: string;
    base_token_price_usd: string;
    price_change_percentage: { h1: string; h24: string };
    transactions: { h24: { buys: number; sells: number } };
    volume_usd: { h24: string };
    reserve_in_usd: string;
  };
  relationships: {
    base_token: { data: { id: string; type: string } };
  };
}

async function findPumpedTokens(chain: EvmChain): Promise<PumpedToken[]> {
  const networkId = GECKO_NETWORK_IDS[chain];
  const seen = new Set<string>();
  const pumped: PumpedToken[] = [];

  try {
    const url = `${GECKO_BASE}/networks/${networkId}/trending_pools`;
    const response = await geckoRateLimitedFetch(url);

    if (!response.ok) {
      console.error(`[InsiderScanner] GeckoTerminal API returned ${response.status} for ${chain}`);
      return [];
    }

    const data = (await response.json()) as { data: GeckoPool[] };
    const pools = data.data || [];

    for (const pool of pools) {
      if (pumped.length >= INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) break;

      const h24Change = parseFloat(pool.attributes.price_change_percentage.h24);
      const volumeH24 = parseFloat(pool.attributes.volume_usd.h24);
      const liquidity = parseFloat(pool.attributes.reserve_in_usd);

      // Filter by thresholds
      if (h24Change < 100 || volumeH24 < 5000 || liquidity < 2000) continue;

      const baseTokenId = pool.relationships.base_token.data.id;
      const parts = baseTokenId.split("_");
      if (parts.length < 2) continue;
      const tokenAddress = parts.slice(1).join("_").toLowerCase();

      // Skip duplicates
      if (seen.has(tokenAddress)) continue;
      seen.add(tokenAddress);

      const nameParts = pool.attributes.name.split(" / ");
      const symbol = nameParts[0] || "UNKNOWN";

      pumped.push({
        tokenAddress,
        chain,
        symbol,
        pairAddress: pool.attributes.address,
        priceChangeH24: h24Change,
        volumeH24,
        liquidity,
        discoveredAt: Date.now(),
      });
    }

    console.log(
      `[InsiderScanner] ${chain}: ${pumped.length} trending tokens passed filters (>=100% change, >=$5k vol, >=$2k liq)`
    );
  } catch (err) {
    console.error(`[InsiderScanner] GeckoTerminal error for ${chain}:`, err);
  }

  // Also check new_pools endpoint
  try {
    if (pumped.length < INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) {
      const newPoolsUrl = `${GECKO_BASE}/networks/${networkId}/new_pools`;
      const newPoolsResponse = await geckoRateLimitedFetch(newPoolsUrl);

      if (newPoolsResponse.ok) {
        const newPoolsData = (await newPoolsResponse.json()) as { data: GeckoPool[] };
        const newPools = newPoolsData.data || [];
        let newCount = 0;

        for (const pool of newPools) {
          if (pumped.length >= INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) break;

          const h24Change = parseFloat(pool.attributes.price_change_percentage.h24);
          const volumeH24 = parseFloat(pool.attributes.volume_usd.h24);
          const liquidity = parseFloat(pool.attributes.reserve_in_usd);

          if (h24Change < 100 || volumeH24 < 5000 || liquidity < 2000) continue;

          const baseTokenId = pool.relationships.base_token.data.id;
          const parts = baseTokenId.split("_");
          if (parts.length < 2) continue;
          const tokenAddress = parts.slice(1).join("_").toLowerCase();

          if (seen.has(tokenAddress)) continue;
          seen.add(tokenAddress);

          const nameParts = pool.attributes.name.split(" / ");
          const symbol = nameParts[0] || "UNKNOWN";

          pumped.push({
            tokenAddress,
            chain,
            symbol,
            pairAddress: pool.attributes.address,
            priceChangeH24: h24Change,
            volumeH24,
            liquidity,
            discoveredAt: Date.now(),
          });
          newCount++;
        }

        console.log(`[InsiderScanner] ${chain}: ${newCount} additional tokens from new_pools`);
      }
    }
  } catch (err) {
    console.error(`[InsiderScanner] new_pools error for ${chain}:`, err);
  }

  // Also check top_pools endpoint (by volume)
  try {
    if (pumped.length < INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) {
      const topPoolsUrl = `${GECKO_BASE}/networks/${networkId}/pools?sort=h24_volume_usd_desc&page=1`;
      const topPoolsResponse = await geckoRateLimitedFetch(topPoolsUrl);

      if (topPoolsResponse.ok) {
        const topPoolsData = (await topPoolsResponse.json()) as { data: GeckoPool[] };
        const topPools = topPoolsData.data || [];
        let topCount = 0;

        for (const pool of topPools) {
          if (pumped.length >= INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) break;

          const h24Change = parseFloat(pool.attributes.price_change_percentage.h24);
          const volumeH24 = parseFloat(pool.attributes.volume_usd.h24);
          const liquidity = parseFloat(pool.attributes.reserve_in_usd);

          if (h24Change < 100 || volumeH24 < 5000 || liquidity < 2000) continue;

          const baseTokenId = pool.relationships.base_token.data.id;
          const parts = baseTokenId.split("_");
          if (parts.length < 2) continue;
          const tokenAddress = parts.slice(1).join("_").toLowerCase();

          if (seen.has(tokenAddress)) continue;
          seen.add(tokenAddress);

          const nameParts = pool.attributes.name.split(" / ");
          const symbol = nameParts[0] || "UNKNOWN";

          pumped.push({
            tokenAddress,
            chain,
            symbol,
            pairAddress: pool.attributes.address,
            priceChangeH24: h24Change,
            volumeH24,
            liquidity,
            discoveredAt: Date.now(),
          });
          topCount++;
        }

        console.log(`[InsiderScanner] ${chain}: ${topCount} additional tokens from top_pools`);
      }
    }
  } catch (err) {
    console.error(`[InsiderScanner] top_pools error for ${chain}:`, err);
  }

  return pumped;
}

async function findEarlyBuyers(token: PumpedToken): Promise<string[]> {
  if (!EXPLORER_SUPPORTED_CHAINS.has(token.chain)) return [];

  const url = buildExplorerUrl(token.chain as EvmChain, `module=account&action=tokentx&contractaddress=${token.tokenAddress}&startblock=0&endblock=99999999&sort=asc`);

  try {
    const response = await etherscanRateLimitedFetch(url, token.chain);
    if (!response.ok) {
      console.log(`[InsiderScanner] findEarlyBuyers HTTP ${response.status} for ${token.tokenAddress.slice(0, 10)}`);
      return [];
    }
    const data = (await response.json()) as {
      status: string;
      result: Array<{
        hash: string;
        from: string;
        to: string;
        blockNumber: string;
        timeStamp: string;
      }>;
    };

    if (data.status !== "1" || !Array.isArray(data.result) || data.result.length === 0) {
      return [];
    }

    // Block-based early buyer filtering
    const firstBlock = parseInt(data.result[0].blockNumber);
    const maxBlock = firstBlock + INSIDER_CONFIG.EARLY_BUYER_BLOCKS;
    const earlyTransfers = data.result.filter(tx => parseInt(tx.blockNumber) <= maxBlock);

    const totalTransfers = earlyTransfers.length;
    const addressCounts = new Map<string, number>();
    for (const tx of earlyTransfers) {
      const to = tx.to.toLowerCase();
      addressCounts.set(to, (addressCounts.get(to) || 0) + 1);
    }

    const chainKey = token.chain as keyof typeof KNOWN_EXCHANGES;
    const exchanges = new Set(
      (KNOWN_EXCHANGES[chainKey] || []).map((a) => a.toLowerCase())
    );

    const buyers = new Set<string>();
    for (const tx of earlyTransfers) {
      const to = tx.to.toLowerCase();

      if (isBotOrBurnAddress(to)) continue;

      if (to === token.tokenAddress) continue;

      if (exchanges.has(to)) continue;

      // Skip addresses appearing in >50% of all transfers (likely router/pool)
      const count = addressCounts.get(to) || 0;
      if (totalTransfers > 10 && count / totalTransfers > 0.5) continue;

      buyers.add(to);
    }

    console.log(`[InsiderScanner] Found ${buyers.size} early buyers for ${token.symbol} on ${token.chain}`);
    return Array.from(buyers);
  } catch (err) {
    console.error(`[InsiderScanner] Etherscan error for ${token.symbol} on ${token.chain}:`, err);
    return [];
  }
}

interface WalletTokenPnl {
  buyTokens: number;
  sellTokens: number;
  status: "holding" | "sold" | "partial" | "transferred" | "unknown";
  buyDate: number;
  sellDate: number;
}

async function getWalletTokenPnl(
  walletAddress: string, tokenAddress: string, chain: EvmChain
): Promise<WalletTokenPnl> {
  if (!EXPLORER_SUPPORTED_CHAINS.has(chain)) {
    return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
  }

  const url = buildExplorerUrl(chain as EvmChain, `module=account&action=tokentx&address=${walletAddress}&contractaddress=${tokenAddress}&startblock=0&endblock=99999999&sort=asc`);

  const response = await etherscanRateLimitedFetch(url, chain);
  if (!response.ok) {
    console.error(`[Scanner] Etherscan HTTP ${response.status} for wallet token PnL: ${walletAddress}`);
    return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
  }
  const data = (await response.json()) as {
    status: string;
    result: Array<{
      from: string;
      to: string;
      value: string;
      tokenDecimal: string;
      timeStamp: string;
    }>;
  };

  const sellDestinations = new Set<string>();
  const routers = KNOWN_DEX_ROUTERS[chain] || [];
  for (const addr of routers) sellDestinations.add(addr.toLowerCase());
  const chainKey = chain as keyof typeof KNOWN_EXCHANGES;
  const exchanges = KNOWN_EXCHANGES[chainKey] || [];
  for (const addr of exchanges) sellDestinations.add(addr.toLowerCase());

  let buyTokens = 0;
  let soldTokens = 0;
  let transferredTokens = 0;
  let buyDate = 0;
  let sellDate = 0;

  if (data.status === "1" && Array.isArray(data.result)) {
    for (const tx of data.result) {
      const amount = parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal));
      const ts = parseInt(tx.timeStamp) * 1000;
      if (tx.to.toLowerCase() === walletAddress.toLowerCase()) {
        buyTokens += amount;
        if (!buyDate) buyDate = ts;
      } else if (tx.from.toLowerCase() === walletAddress.toLowerCase()) {
        const dest = tx.to.toLowerCase();
        if (sellDestinations.has(dest) || isBotOrBurnAddress(dest)) {
          soldTokens += amount;
        } else {
          transferredTokens += amount;
        }
        sellDate = ts;
      }
    }
  }

  const sellTokens = soldTokens + transferredTokens;
  const totalOut = sellTokens;

  let status: "holding" | "sold" | "partial" | "transferred" | "unknown";
  if (buyTokens === 0 && totalOut === 0) {
    status = "unknown";
  } else if (totalOut > 0.9 * buyTokens && transferredTokens > soldTokens) {
    status = "transferred";
  } else if (totalOut > 0.9 * buyTokens) {
    status = "sold";
  } else if (totalOut < 0.1 * buyTokens) {
    status = "holding";
  } else {
    status = "partial";
  }

  return { buyTokens, sellTokens, status, buyDate, sellDate };
}

let historyInProgress = false;

async function scanWalletHistory(): Promise<void> {
  if (historyInProgress) {
    console.log("[InsiderScanner] History: Skipping (previous scan still running)");
    return;
  }
  historyInProgress = true;
  try {
    await _scanWalletHistoryInner();
  } finally {
    historyInProgress = false;
  }
}

async function _scanWalletHistoryInner(): Promise<void> {
  const candidates = getPromisingWalletsForHistoryScan(INSIDER_CONFIG.MIN_GEM_HITS, 20); // Query gem_hits directly, bypass insider_wallets table

  console.log(`[InsiderScanner] History: Scanning ${candidates.length} wallets`);

  for (const wallet of candidates) {
    // Skip chains without working explorer APIs
    if (!EXPLORER_SUPPORTED_CHAINS.has(wallet.chain)) continue;

    try {
      const url = buildExplorerUrl(wallet.chain as EvmChain, `module=account&action=tokentx&address=${wallet.address}&startblock=0&endblock=99999999&sort=asc`);
      const response = await etherscanRateLimitedFetch(url, wallet.chain as EvmChain);
      if (!response.ok) {
        console.log(`[InsiderScanner] History: HTTP ${response.status} for ${wallet.address.slice(0, 8)}`);
        continue;
      }
      const data = (await response.json()) as {
        status: string;
        result: Array<{
          contractAddress: string;
          tokenSymbol: string;
          tokenDecimal: string;
          timeStamp: string;
        }>;
      };

      if (data.status !== "1" || !Array.isArray(data.result)) {
        console.log(
          `[InsiderScanner] History: ${wallet.address.slice(0, 8)} - no transfers found (status=${data.status}, resultType=${typeof data.result}, resultLength=${Array.isArray(data.result) ? data.result.length : String(data.result).slice(0, 80)})`
        );
        continue;
      }

      const tokenMap = new Map<string, { symbol: string; firstTx: number }>();
      for (const tx of data.result) {
        const tokenAddr = tx.contractAddress.toLowerCase();
        if (!tokenMap.has(tokenAddr)) {
          tokenMap.set(tokenAddr, {
            symbol: tx.tokenSymbol || "UNKNOWN",
            firstTx: parseInt(tx.timeStamp) * 1000,
          });
        }
      }

      const existingGems = getGemHitsForWallet(wallet.address, wallet.chain);
      const existingTokens = new Set(existingGems.map(g => g.tokenAddress.toLowerCase()));

      const newTokens = Array.from(tokenMap.entries())
        .filter(([addr]) => !existingTokens.has(addr))
        .slice(0, INSIDER_CONFIG.MAX_HISTORY_TOKENS);

      // Batch fetch (~7 API calls vs ~200 individual)
      const batchTokens = newTokens.map(([addr]) => ({ chain: wallet.chain, tokenAddress: addr }));
      const batchResults = await dexScreenerFetchBatch(batchTokens);
      console.log(`[InsiderScanner] History: Batch fetched ${batchResults.size}/${newTokens.length} tokens for ${wallet.address.slice(0, 8)}`);

      let checkedCount = 0;
      let newGemsCount = 0;

      for (const [tokenAddress, tokenInfo] of newTokens) {
        try {
          let pair = batchResults.get(tokenAddress) ?? null;
          // Fallback for tokens not found in batch (includes GeckoTerminal)
          if (!pair || parseFloat(pair.priceUsd || "0") <= 0) {
            pair = await dexScreenerFetch(wallet.chain, tokenAddress);
          }
          checkedCount++;

          if (!pair) continue;

          const fdvUsd = pair.fdv || 0;
          const reserveUsd = pair.liquidity?.usd || 0;

          if (fdvUsd < INSIDER_CONFIG.HISTORY_MIN_FDV_USD && reserveUsd < 1000) {
            continue;
          }
          if (fdvUsd > 10_000_000) continue;

          let launchPriceUsd = 0;
          const priceUsd = parseFloat(pair.priceUsd || "0");
          if (pair.pairAddress) {
            launchPriceUsd = await fetchLaunchPrice(wallet.chain as EvmChain, pair.pairAddress);
          }
          const pumpMultiple = launchPriceUsd > 0 && priceUsd > 0
            ? priceUsd / launchPriceUsd
            : fdvUsd / INSIDER_CONFIG.HISTORY_MIN_FDV_USD;
          const symbol = pair.baseToken?.symbol || tokenInfo.symbol;

          const hit: GemHit = {
            walletAddress: wallet.address,
            chain: wallet.chain as EvmChain,
            tokenAddress,
            tokenSymbol: stripEmoji(symbol),
            buyTxHash: "",
            buyTimestamp: tokenInfo.firstTx,
            pumpMultiple,
            launchPriceUsd,
          };
          upsertGemHit(hit);
          newGemsCount++;
        } catch {
          continue;
        }
      }

      console.log(
        `[InsiderScanner] History: ${wallet.address.slice(0, 8)} - checked ${checkedCount} tokens, found ${newGemsCount} new gems`
      );

      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`[InsiderScanner] History scan error for ${wallet.address}:`, err);
      continue;
    }
  }
}

async function enrichInsiderPnl(): Promise<void> {
  const insiders = getInsiderWallets(undefined, INSIDER_CONFIG.MIN_GEM_HITS);

  for (const wallet of insiders) {
    const hits = getGemHitsForWallet(wallet.address, wallet.chain);

    for (const hit of hits) {
      if (hit.status === 'sold' || hit.status === 'transferred') continue; // Terminal status, skip

      try {
        const pnl = await getWalletTokenPnl(hit.walletAddress, hit.tokenAddress, hit.chain);
        updateGemHitPnl(hit.walletAddress, hit.tokenAddress, hit.chain, pnl.buyTokens, pnl.sellTokens, pnl.status, pnl.buyDate, pnl.sellDate);
        console.log(`[InsiderScanner] P&L: ${hit.walletAddress.slice(0, 8)} ${hit.tokenSymbol} -> ${pnl.status} (buy: ${pnl.buyTokens.toFixed(0)} sell: ${pnl.sellTokens.toFixed(0)})`);

        // Auto-close paper trade when high-score insider sells
        if ((pnl.status === "sold" || pnl.status === "transferred") && wallet.score >= WATCHER_CONFIG.MIN_WALLET_SCORE) {
          const paperTrade = getGemPaperTrade(hit.tokenSymbol, hit.chain);
          if (paperTrade && paperTrade.status === "open") {
            await sellGemPosition(hit.tokenSymbol, hit.chain);
            console.log(`[InsiderScanner] Auto-close: ${hit.tokenSymbol} (insider score ${wallet.score} ${pnl.status})`);
          }
        }
      } catch (err) {
        console.error(`[InsiderScanner] P&L enrichment failed for ${hit.tokenSymbol}:`, err);
      }

      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function updateHeldGemPrices(): Promise<void> {
  const heldGems = getAllHeldGemHits();

  const uniqueTokens = new Map<string, { tokenAddress: string; chain: EvmChain; symbol: string; oldMultiple: number; launchPrice: number }>();
  for (const gem of heldGems) {
    const key = `${gem.tokenAddress}_${gem.chain}`;
    if (!uniqueTokens.has(key)) {
      uniqueTokens.set(key, {
        tokenAddress: gem.tokenAddress,
        chain: gem.chain,
        symbol: gem.tokenSymbol,
        oldMultiple: gem.pumpMultiple,
        launchPrice: gem.launchPriceUsd || 0,
      });
    }
  }

  if (uniqueTokens.size === 0) return;

  console.log(`[InsiderScanner] Updating prices for ${uniqueTokens.size} held tokens`);
  let updated = 0;

  // Batch fetch all prices at once
  const tokenArray = Array.from(uniqueTokens.values()).map((t) => ({
    chain: t.chain,
    tokenAddress: t.tokenAddress,
  }));
  const priceMap = await dexScreenerFetchBatch(tokenArray);

  // Backfill launch prices for tokens missing them (max 3 per cycle)
  let backfilled = 0;
  for (const [, token] of uniqueTokens) {
    if (token.launchPrice > 0 || token.tokenAddress.endsWith("pump") || backfilled >= 3) continue;
    const addrKey = token.tokenAddress.toLowerCase();
    const pair = priceMap.get(addrKey);
    if (pair?.pairAddress) {
      const lp = await fetchLaunchPrice(token.chain, pair.pairAddress);
      if (lp > 0) {
        token.launchPrice = lp;
        setLaunchPrice(token.tokenAddress, token.chain, lp);
        console.log(`[InsiderScanner] Launch price: ${token.symbol} = $${lp.toFixed(8)}`);
        backfilled++;
      }
    }
  }

  for (const [, token] of uniqueTokens) {
    const addrKey = token.tokenAddress.toLowerCase();
    let pair = priceMap.get(addrKey);

    // Single fetch fallback (includes Gecko)
    if (!pair || parseFloat(pair.priceUsd || "0") <= 0) {
      pair = (await dexScreenerFetch(token.chain, token.tokenAddress)) ?? undefined;
    }
    if (!pair) continue;

    const priceUsd = parseFloat(pair.priceUsd || "0");
    const fdvUsd = pair.fdv || 0;

    if (priceUsd > 0 || fdvUsd > 0) {
      if (fdvUsd > 10_000_000) continue;
      let newMultiple: number;
      if (token.launchPrice > 0 && priceUsd > 0) {
        newMultiple = priceUsd / token.launchPrice;
      } else {
        newMultiple = fdvUsd / INSIDER_CONFIG.HISTORY_MIN_FDV_USD;
      }
      const changeRatio = Math.abs(newMultiple - token.oldMultiple) / Math.max(token.oldMultiple, 0.01);
      if (changeRatio > 0.1) {
        updateGemHitPumpMultiple(token.tokenAddress, token.chain, newMultiple);
        console.log(`[InsiderScanner] Price update: ${token.symbol} ${token.oldMultiple.toFixed(1)}x -> ${newMultiple.toFixed(1)}x (${formatPrice(priceUsd)})`);
        updated++;
      }
    }
  }

  if (updated > 0) {
    console.log(`[InsiderScanner] Updated ${updated}/${uniqueTokens.size} held token prices`);
  }
}

export async function runInsiderScan(): Promise<InsiderScanResult> {
  const result: InsiderScanResult = {
    pumpedTokensFound: 0,
    walletsAnalyzed: 0,
    insidersFound: 0,
    errors: [],
  };

  const cycleChains = INSIDER_CONFIG.SCAN_CHAINS;

  console.log(`[InsiderScanner] Scanning ${cycleChains.length} chains: ${cycleChains.join(", ")}`);

  for (const chain of cycleChains) {
    try {
      const pumpedTokens = await findPumpedTokens(chain);
      result.pumpedTokensFound += pumpedTokens.length;

      for (const token of pumpedTokens) {
        try {
          const earlyBuyers = await findEarlyBuyers(token);
          result.walletsAnalyzed += earlyBuyers.length;

          // Store each (wallet, token) pair as a GemHit
          for (const buyer of earlyBuyers) {
            const hit: GemHit = {
              walletAddress: buyer,
              chain,
              tokenAddress: token.tokenAddress,
              tokenSymbol: stripEmoji(token.symbol),
              buyTxHash: "", // Not tracked individually
              buyTimestamp: token.discoveredAt,
              pumpMultiple: token.priceChangeH24 / 100 + 1, // Convert % to multiple
            };
            upsertGemHit(hit);
          }

          // 500ms delay between tokens
          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          const msg = `Error processing ${token.symbol} on ${chain}: ${err}`;
          console.error(`[InsiderScanner] ${msg}`);
          result.errors.push(msg);
          continue;
        }
      }
    } catch (err) {
      const msg = `Error scanning ${chain}: ${err}`;
      console.error(`[InsiderScanner] ${msg}`);
      result.errors.push(msg);
    }
    await new Promise((r) => setTimeout(r, INSIDER_CONFIG.INTER_CHAIN_DELAY_MS));
  }

  // Wilson Score lower bound: conservative estimate of true win rate given limited samples
  function wilsonLowerBound(wins: number, n: number, z = 1.96): number {
    if (n === 0) return 0;
    const p = wins / n;
    return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
  }

  // Multi-factor wallet scoring (0-100)
  function computeWalletScore(wallet: {
    gem_count: number;
    avg_pump: number;
    holding_count: number;
    unique_tokens: number;
    first_seen: number;
    last_seen: number;
  }, copyStats?: WalletCopyTradeStats, medianPump?: number): number {
    // Legacy formula: gems(30) + avg_pump(30) + hold_rate(20) + recency(20) = 100
    const gemCountScore = Math.min(30, Math.round(30 * Math.log2(Math.max(1, wallet.gem_count)) / Math.log2(20)));
    const avgPumpScore = Math.min(30, Math.round(30 * Math.sqrt(Math.min(wallet.avg_pump, 50)) / Math.sqrt(50)));
    const holdRate = wallet.gem_count > 0 ? wallet.holding_count / wallet.gem_count : 0;
    const holdRateScore = Math.round(20 * holdRate);
    const daysSinceLastSeen = (Date.now() - wallet.last_seen) / (24 * 60 * 60 * 1000);
    const recencyScoreLegacy = Math.max(0, Math.round(20 * Math.max(0, 1 - daysSinceLastSeen / 90)));
    const legacyScore = Math.min(100, gemCountScore + avgPumpScore + holdRateScore + recencyScoreLegacy);

    const totalTrades = copyStats?.totalTrades ?? 0;

    // No copy trade history: use legacy formula
    if (totalTrades < 1) return legacyScore;

    // New formula: gems(15) + median_pump(10) + win_rate(15) + profit_factor(20) + expectancy(20) + recency(20) = 100
    const newGemScore = Math.min(15, Math.round(15 * Math.log2(Math.max(1, wallet.gem_count)) / Math.log2(20)));
    const mp = medianPump ?? wallet.avg_pump;
    const medianPumpScore = Math.min(10, Math.round(10 * Math.sqrt(Math.min(mp, 50)) / Math.sqrt(50)));
    const cs = copyStats as WalletCopyTradeStats;

    // Wilson lower bound as effective win rate: naturally penalises low-sample wallets
    const effectiveWR = wilsonLowerBound(cs.wins, cs.totalTrades);
    const winRateScore = Math.round(15 * effectiveWR);

    const pf = cs.grossProfit / Math.max(cs.grossLoss, 1);
    const profitFactorScore = Math.min(20, Math.round(20 * Math.min(pf, 3) / 3));

    // Expectancy: (effectiveWR * avgWinPct) - ((1 - effectiveWR) * avgLossPct)
    const losses = cs.totalTrades - cs.wins;
    const avgWinPct = cs.wins > 0 ? cs.grossProfit / cs.wins : 0;
    const avgLossPct = losses > 0 ? cs.grossLoss / losses : 0;
    const rawExpectancy = (effectiveWR * avgWinPct) - ((1 - effectiveWR) * avgLossPct);
    const expectancyScore = Math.round(20 * Math.max(0, Math.min(rawExpectancy / 100, 1)));

    // Recency: exponential decay with 14-day half-life
    const recencyScore = Math.round(20 * Math.pow(0.5, daysSinceLastSeen / 14));

    let score = Math.min(100, newGemScore + medianPumpScore + winRateScore + profitFactorScore + expectancyScore + recencyScore);

    // Expectancy floor: negative expectancy after 10+ trades caps score at 50
    if (rawExpectancy <= 0 && cs.totalTrades >= 10) {
      score = Math.min(score, 50);
    }

    return score;
  }

  try {
    const db = getDb();

    const totalGems = (db.prepare("SELECT COUNT(*) as cnt FROM insider_gem_hits").get() as { cnt: number }).cnt;
    const quickFlips = (db.prepare(`
      SELECT COUNT(*) as cnt FROM insider_gem_hits
      WHERE status = 'sold' AND sell_date > 0 AND buy_date > 0
        AND (sell_date - buy_date) < ?
    `).get(INSIDER_CONFIG.SNIPER_MAX_HOLD_MS) as { cnt: number }).cnt;

    if (quickFlips > 0) {
      console.log(`[InsiderScanner] Filtered ${quickFlips}/${totalGems} gem hits as sniper bot flips (<24h hold)`);
    }

    const walletGroups = db.prepare(`
      SELECT wallet_address, chain, COUNT(*) as gem_count,
             GROUP_CONCAT(DISTINCT token_symbol) as token_symbols,
             MIN(buy_timestamp) as first_seen,
             MAX(buy_timestamp) as last_seen,
             AVG(pump_multiple) as avg_pump,
             SUM(CASE WHEN (status = 'holding' OR status IS NULL OR status = 'unknown') THEN 1 ELSE 0 END) as holding_count,
             COUNT(DISTINCT token_address) as unique_tokens
      FROM insider_gem_hits
      WHERE NOT (status = 'sold' AND sell_date > 0 AND buy_date > 0
            AND (sell_date - buy_date) < ?)
        AND wallet_address NOT IN ('0x0000000000000000000000000000000000000000','0x000000000000000000000000000000000000dead','0x0000000000000000000000000000000000000001','0x0000000000000000000000000000000000000002','0x0000000000000000000000000000000000000003')
        AND wallet_address NOT LIKE '0x00000000%'
      GROUP BY wallet_address, chain
      HAVING gem_count >= ? AND unique_tokens >= ?
    `).all(INSIDER_CONFIG.SNIPER_MAX_HOLD_MS, INSIDER_CONFIG.MIN_GEM_HITS, INSIDER_CONFIG.MIN_UNIQUE_TOKENS) as Array<{
      wallet_address: string;
      chain: EvmChain;
      gem_count: number;
      token_symbols: string;
      first_seen: number;
      last_seen: number;
      avg_pump: number;
      holding_count: number;
      unique_tokens: number;
    }>;

    const allPumps = db.prepare(`
      SELECT wallet_address, chain, pump_multiple
      FROM insider_gem_hits
      WHERE NOT (status = 'sold' AND sell_date > 0 AND buy_date > 0
            AND (sell_date - buy_date) < ?)
      ORDER BY wallet_address, chain, pump_multiple ASC
    `).all(INSIDER_CONFIG.SNIPER_MAX_HOLD_MS) as Array<{
      wallet_address: string; chain: string; pump_multiple: number;
    }>;

    const medianPumpMap = new Map<string, number>();
    const pumpsByWallet = new Map<string, number[]>();
    for (const row of allPumps) {
      const key = `${row.wallet_address}_${row.chain}`;
      const arr = pumpsByWallet.get(key) || [];
      arr.push(row.pump_multiple);
      pumpsByWallet.set(key, arr);
    }
    for (const [key, pumps] of pumpsByWallet) {
      const mid = Math.floor(pumps.length / 2);
      medianPumpMap.set(key, pumps.length % 2 === 0 ? (pumps[mid - 1] + pumps[mid]) / 2 : pumps[mid]);
    }

    const copyStatsMap = getAllWalletCopyTradeStats();
    const scores: number[] = [];
    let qualifiedCount = 0;

    const existingQualified = new Set(getInsiderWallets(undefined, undefined)
      .filter(w => w.score >= WATCHER_CONFIG.MIN_WALLET_SCORE)
      .map(w => `${w.address}_${w.chain}`));

    for (const group of walletGroups) {
      const gems = group.token_symbols.split(",").filter(Boolean);
      const copyStats = copyStatsMap.get(group.wallet_address);
      const mpKey = `${group.wallet_address}_${group.chain}`;
      const medianPump = medianPumpMap.get(mpKey);
      const score = computeWalletScore(group, copyStats && copyStats.totalTrades > 0 ? copyStats : undefined, medianPump);
      scores.push(score);

      if (score >= WATCHER_CONFIG.MIN_WALLET_SCORE) {
        upsertInsiderWallet({
          address: group.wallet_address,
          chain: group.chain,
          gemHitCount: group.gem_count,
          gems,
          score,
          firstSeenAt: group.first_seen,
          lastSeenAt: group.last_seen,
        });
        const walletKey = `${group.wallet_address}_${group.chain}`;
        if (!existingQualified.has(walletKey)) {
          console.log(`[InsiderScanner] New qualified wallet: ${group.wallet_address.slice(0, 8)} (${group.chain}) score=${score} gems=${group.gem_count}`);
        }
        qualifiedCount++;
      }
    }

    const deleted = deleteInsiderWalletsBelow(WATCHER_CONFIG.MIN_WALLET_SCORE);
    if (deleted > 0) {
      console.log(`[InsiderScanner] Removed ${deleted} wallets below score ${WATCHER_CONFIG.MIN_WALLET_SCORE}`);
    }

    if (scores.length > 0) {
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      console.log(`[InsiderScanner] Wallet scores: min=${min}, max=${max}, avg=${avg}, count=${scores.length}`);
    }

    result.insidersFound = qualifiedCount;
  } catch (err) {
    const msg = `Error recalculating insiders: ${err}`;
    console.error(`[InsiderScanner] ${msg}`);
    result.errors.push(msg);
  }

  // Enrich P&L
  enrichInsiderPnl().catch(err => {
    console.error("[InsiderScanner] P&L enrichment error:", err);
  });

  // Scan wallet history
  scanWalletHistory().catch(err => {
    console.error("[InsiderScanner] History scan error:", err);
  });

  // Update held gem prices
  updateHeldGemPrices().catch(err => {
    console.error("[InsiderScanner] Held gem price update error:", err);
  });

  // Refresh paper prices
  refreshGemPaperPrices().catch(err => {
    console.error("[InsiderScanner] Paper price refresh error:", err);
  });

  // Auto-score held gems
  try {
    const heldGems = getAllHeldGemHits();
    const tokensToProcess = new Map<string, { symbol: string; chain: string; currentPump: number; tokenAddress: string }>();
    for (const gem of heldGems) {
      const key = `${gem.tokenSymbol.toLowerCase()}_${gem.chain}`;
      if (tokensToProcess.has(key)) continue;
      const cached = getCachedGemAnalysis(gem.tokenSymbol, gem.chain);
      const NEAR_THRESHOLD_RESCORE_MS = 2 * 60 * 60 * 1000;
      const existingTrade = getGemPaperTrade(gem.tokenSymbol, gem.chain);
      const noOpenTrade = !existingTrade || existingTrade.status === "closed";
      if (!cached ||
          (cached.score >= INSIDER_CONFIG.MIN_GEM_SCORE && noOpenTrade) ||
          (cached.score >= INSIDER_CONFIG.RESCORE_THRESHOLD && cached.score < INSIDER_CONFIG.MIN_GEM_SCORE && Date.now() - cached.analyzedAt > NEAR_THRESHOLD_RESCORE_MS)) {
        tokensToProcess.set(key, {
          symbol: gem.tokenSymbol,
          chain: gem.chain,
          currentPump: gem.pumpMultiple,
          tokenAddress: gem.tokenAddress,
        });
      }
    }
    if (tokensToProcess.size > 0) {
      console.log(`[InsiderScanner] Auto-scoring ${tokensToProcess.size} unscored/unbought gems`);
      analyzeGemsBackground(Array.from(tokensToProcess.values()));
    }
  } catch (err) {
    console.error("[InsiderScanner] Auto-score error:", err);
  }

  console.log(
    `[InsiderScanner] Scan complete: ${result.pumpedTokensFound} pumped tokens, ${result.walletsAnalyzed} wallets, ${result.insidersFound} insiders`
  );

  return result;
}
