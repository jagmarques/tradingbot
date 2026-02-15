import type { EvmChain, ScanChain, PumpedToken, GemHit, InsiderScanResult } from "./types.js";
import { INSIDER_CONFIG } from "./types.js";
import { upsertGemHit, upsertInsiderWallet, getInsiderWallets, getGemHitsForWallet, updateGemHitPnl, getAllHeldGemHits, updateGemHitPumpMultiple, getCachedGemAnalysis, getGemPaperTrade } from "./storage.js";
import { getDb } from "../database/db.js";
import { KNOWN_EXCHANGES, KNOWN_DEX_ROUTERS } from "./types.js";
import { analyzeGemsBackground, revalidateHeldGems, refreshGemPaperPrices, sellGemPosition } from "./gem-analyzer.js";
import { dexScreenerFetch, dexScreenerFetchBatch } from "../shared/dexscreener.js";
import { findSolanaEarlyBuyers, getSolanaWalletTokenStatus, scanSolanaWalletHistory } from "../solana/helius.js";

function stripEmoji(s: string): string {
  return s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\u{E0067}\u{E0062}\u{E007F}\u{1F3F4}]/gu, "").trim();
}

// GeckoTerminal API
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_NETWORK_IDS: Record<ScanChain, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  optimism: "optimism",
  avalanche: "avax",
  solana: "solana",
};

// Etherscan V2 API
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

// Routescan API for Avalanche (Snowtrace)
const ROUTESCAN_AVAX_URL = "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api";

// Chain IDs for Etherscan V2
const ETHERSCAN_CHAIN_IDS: Record<EvmChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  optimism: 10,
  avalanche: 43114,
};

// Chains with working free explorer APIs (ethereum=Etherscan, avalanche=Routescan)
const EXPLORER_SUPPORTED_CHAINS = new Set<string>(["ethereum", "avalanche"]);

// Build explorer URL based on chain (Routescan for Avalanche, Etherscan V2 for others)
function buildExplorerUrl(chain: EvmChain, params: string): string {
  if (chain === "avalanche") {
    const apiKey = process.env.SNOWTRACE_API_KEY || "";
    return `${ROUTESCAN_AVAX_URL}?${params}${apiKey ? `&apikey=${apiKey}` : ""}`;
  }
  const chainId = ETHERSCAN_CHAIN_IDS[chain];
  const apiKey = process.env.ETHERSCAN_API_KEY || "";
  return `${ETHERSCAN_V2_URL}?chainid=${chainId}&${params}${apiKey ? `&apikey=${apiKey}` : ""}`;
}

// Zero address
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// GeckoTerminal: ~12 calls/cycle, actual limit ~6/min (stricter than documented)
let geckoQueue: Promise<void> = Promise.resolve();

async function geckoRateLimitedFetch(url: string): Promise<Response> {
  const myTurn = geckoQueue.then(() => new Promise<void>((r) => setTimeout(r, 10_000)));
  geckoQueue = myTurn;
  await myTurn;
  return fetch(url);
}

// Rate limiting for Etherscan (220ms between requests, per chain)
const ETHERSCAN_INTERVAL_MS = 220;
const etherscanQueueByChain = new Map<string, Promise<void>>();

async function etherscanRateLimitedFetch(url: string, chain: string): Promise<Response> {
  const currentQueue = etherscanQueueByChain.get(chain) || Promise.resolve();
  const interval = chain === "avalanche" ? 550 : ETHERSCAN_INTERVAL_MS;
  const myTurn = currentQueue.then(async () => {
    await new Promise((r) => setTimeout(r, interval));
  });
  etherscanQueueByChain.set(chain, myTurn);
  await myTurn;
  return fetch(url);
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

// Find tokens that pumped 3x+ in 24h on a given chain
export async function findPumpedTokens(chain: ScanChain): Promise<PumpedToken[]> {
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

      // Extract token address from relationships.base_token.data.id (format: "network_address")
      const baseTokenId = pool.relationships.base_token.data.id;
      const parts = baseTokenId.split("_");
      if (parts.length < 2) continue;
      // Solana addresses are case-sensitive, EVM addresses should be lowercased
      const tokenAddress = chain === "solana" ? parts.slice(1).join("_") : parts.slice(1).join("_").toLowerCase();

      // Skip duplicates
      if (seen.has(tokenAddress)) continue;
      seen.add(tokenAddress);

      // Extract symbol from pool name (format: "SYMBOL / QUOTE")
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
          const tokenAddress = chain === "solana" ? parts.slice(1).join("_") : parts.slice(1).join("_").toLowerCase();

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
          const tokenAddress = chain === "solana" ? parts.slice(1).join("_") : parts.slice(1).join("_").toLowerCase();

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

// Find wallets that bought a token early (within first 50-100 transfers)
export async function findEarlyBuyers(token: PumpedToken): Promise<string[]> {
  if (token.chain === "solana") {
    return findSolanaEarlyBuyers(token.tokenAddress);
  }
  if (!EXPLORER_SUPPORTED_CHAINS.has(token.chain)) return [];

  const url = buildExplorerUrl(token.chain as EvmChain, `module=account&action=tokentx&contractaddress=${token.tokenAddress}&startblock=0&endblock=99999999&sort=asc`);

  try {
    const response = await etherscanRateLimitedFetch(url, token.chain);
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

    if (data.status !== "1" || !Array.isArray(data.result)) {
      return [];
    }

    // Take the first 100 transfers (earliest buyers)
    const earlyTransfers = data.result.slice(0, 100);

    // Count how many transfers each address appears in (to filter routers/pools)
    const totalTransfers = data.result.length;
    const addressCounts = new Map<string, number>();
    for (const tx of data.result) {
      const to = tx.to.toLowerCase();
      addressCounts.set(to, (addressCounts.get(to) || 0) + 1);
    }

    // Get known exchange addresses for this chain
    const chainKey = token.chain as keyof typeof KNOWN_EXCHANGES;
    const exchanges = new Set(
      (KNOWN_EXCHANGES[chainKey] || []).map((a) => a.toLowerCase())
    );

    // Extract unique buyer addresses from early transfers
    const buyers = new Set<string>();
    for (const tx of earlyTransfers) {
      const to = tx.to.toLowerCase();

      // Skip zero address
      if (to === ZERO_ADDRESS) continue;

      // Skip the token contract itself
      if (to === token.tokenAddress) continue;

      // Skip known exchanges
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

// Query Etherscan for wallet+token transfer history to determine buy/sell status
interface WalletTokenPnl {
  buyTokens: number;
  sellTokens: number;
  status: "holding" | "sold" | "partial" | "transferred" | "unknown";
  buyDate: number;
  sellDate: number;
}

export async function getWalletTokenPnl(
  walletAddress: string, tokenAddress: string, chain: ScanChain
): Promise<WalletTokenPnl> {
  if (chain === "solana") {
    return getSolanaWalletTokenStatus(walletAddress, tokenAddress);
  }
  if (!EXPLORER_SUPPORTED_CHAINS.has(chain)) {
    return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
  }

  const url = buildExplorerUrl(chain as EvmChain, `module=account&action=tokentx&address=${walletAddress}&contractaddress=${tokenAddress}&startblock=0&endblock=99999999&sort=asc`);

  const response = await etherscanRateLimitedFetch(url, chain);
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

  // Build set of known sell destinations (DEX routers + exchanges)
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
        if (sellDestinations.has(dest) || dest === ZERO_ADDRESS) {
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

// Busy guard to prevent overlapping history scans
let historyInProgress = false;

// Scan historical wallet transactions for additional gem hits
export async function scanWalletHistory(): Promise<void> {
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
  const insiders = getInsiderWallets(undefined, 1); // Cast wider net with 1+ gem hits

  console.log(`[InsiderScanner] History: Scanning ${insiders.length} wallets`);

  for (const wallet of insiders) {
    if (wallet.chain === "solana") {
      try {
        const tokens = await scanSolanaWalletHistory(wallet.address);
        const existingGems = getGemHitsForWallet(wallet.address, wallet.chain);
        const existingTokens = new Set(existingGems.map(g => g.tokenAddress));
        let newGemsCount = 0;

        for (const token of tokens.slice(0, INSIDER_CONFIG.MAX_HISTORY_TOKENS)) {
          if (existingTokens.has(token.tokenAddress)) continue;

          const pair = await dexScreenerFetch(wallet.chain, token.tokenAddress);
          if (!pair) continue;

          const fdvUsd = pair.fdv || 0;
          const reserveUsd = pair.liquidity?.usd || 0;
          if (fdvUsd < INSIDER_CONFIG.HISTORY_MIN_FDV_USD && reserveUsd < 1000) continue;

          const pumpMultiple = Math.min(fdvUsd / INSIDER_CONFIG.HISTORY_MIN_FDV_USD, 100);
          const symbol = pair.baseToken?.symbol || token.symbol;

          const hit: GemHit = {
            walletAddress: wallet.address,
            chain: wallet.chain,
            tokenAddress: token.tokenAddress,
            tokenSymbol: stripEmoji(symbol),
            buyTxHash: "",
            buyTimestamp: token.firstTx,
            buyBlockNumber: 0,
            pumpMultiple,
          };
          upsertGemHit(hit);
          newGemsCount++;
        }

        console.log(`[InsiderScanner] History: ${wallet.address.slice(0, 8)} (solana) - found ${newGemsCount} new gems`);
        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        console.error(`[InsiderScanner] Solana history error for ${wallet.address}:`, err);
      }
      continue;
    }

    // Skip chains without working explorer APIs
    if (!EXPLORER_SUPPORTED_CHAINS.has(wallet.chain)) continue;

    try {
      // Query all token transfers for this wallet (no contractaddress filter)
      const url = buildExplorerUrl(wallet.chain as EvmChain, `module=account&action=tokentx&address=${wallet.address}&startblock=0&endblock=99999999&sort=asc`);
      const response = await etherscanRateLimitedFetch(url, wallet.chain as EvmChain);
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

      // Build map of unique token addresses
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

      // Get existing gems for this wallet to avoid duplicates
      const existingGems = getGemHitsForWallet(wallet.address, wallet.chain);
      const existingTokens = new Set(existingGems.map(g => g.tokenAddress.toLowerCase()));

      // Filter to new tokens only, cap at MAX_HISTORY_TOKENS
      const newTokens = Array.from(tokenMap.entries())
        .filter(([addr]) => !existingTokens.has(addr))
        .slice(0, INSIDER_CONFIG.MAX_HISTORY_TOKENS);

      let checkedCount = 0;
      let newGemsCount = 0;

      for (const [tokenAddress, tokenInfo] of newTokens) {
        try {
          const pair = await dexScreenerFetch(wallet.chain, tokenAddress);
          checkedCount++;

          if (!pair) continue;

          const fdvUsd = pair.fdv || 0;
          const reserveUsd = pair.liquidity?.usd || 0;

          if (fdvUsd < INSIDER_CONFIG.HISTORY_MIN_FDV_USD && reserveUsd < 1000) {
            continue;
          }

          const pumpMultiple = Math.min(fdvUsd / INSIDER_CONFIG.HISTORY_MIN_FDV_USD, 100);
          const symbol = pair.baseToken?.symbol || tokenInfo.symbol;

          const hit: GemHit = {
            walletAddress: wallet.address,
            chain: wallet.chain,
            tokenAddress,
            tokenSymbol: stripEmoji(symbol),
            buyTxHash: "",
            buyTimestamp: tokenInfo.firstTx,
            buyBlockNumber: 0,
            pumpMultiple,
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

      // Delay between wallets
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`[InsiderScanner] History scan error for ${wallet.address}:`, err);
      continue;
    }
  }
}

// Enrich gem hits with P&L data (non-blocking, runs after scan)
export async function enrichInsiderPnl(): Promise<void> {
  const insiders = getInsiderWallets(undefined, INSIDER_CONFIG.MIN_GEM_HITS);

  for (const wallet of insiders) {
    const hits = getGemHitsForWallet(wallet.address, wallet.chain);

    for (const hit of hits) {
      if (hit.status) continue; // Already enriched

      try {
        const pnl = await getWalletTokenPnl(hit.walletAddress, hit.tokenAddress, hit.chain);
        updateGemHitPnl(hit.walletAddress, hit.tokenAddress, hit.chain, pnl.buyTokens, pnl.sellTokens, pnl.status, pnl.buyDate, pnl.sellDate);
        console.log(`[InsiderScanner] P&L: ${hit.walletAddress.slice(0, 8)} ${hit.tokenSymbol} -> ${pnl.status} (buy: ${pnl.buyTokens.toFixed(0)} sell: ${pnl.sellTokens.toFixed(0)})`);

        // Auto-close paper trade when insider sells
        if (pnl.status === "sold" || pnl.status === "transferred") {
          const paperTrade = getGemPaperTrade(hit.tokenSymbol, hit.chain);
          if (paperTrade && paperTrade.status === "open") {
            await sellGemPosition(hit.tokenSymbol, hit.chain);
            console.log(`[InsiderScanner] Auto-close paper trade: ${hit.tokenSymbol} (insider ${pnl.status})`);
          }
        }
      } catch (err) {
        console.error(`[InsiderScanner] P&L enrichment failed for ${hit.tokenSymbol}:`, err);
      }

      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export async function updateHeldGemPrices(): Promise<void> {
  const heldGems = getAllHeldGemHits();

  // Deduplicate by token+chain (many wallets may hold same token)
  const uniqueTokens = new Map<string, { tokenAddress: string; chain: ScanChain; symbol: string; oldMultiple: number }>();
  for (const gem of heldGems) {
    const key = `${gem.tokenAddress}_${gem.chain}`;
    if (!uniqueTokens.has(key)) {
      uniqueTokens.set(key, {
        tokenAddress: gem.tokenAddress,
        chain: gem.chain,
        symbol: gem.tokenSymbol,
        oldMultiple: gem.pumpMultiple,
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

  for (const [, token] of uniqueTokens) {
    const addrKey = token.chain === "solana" ? token.tokenAddress : token.tokenAddress.toLowerCase();
    const pair = priceMap.get(addrKey);
    if (!pair) continue;

    const priceUsd = parseFloat(pair.priceUsd || "0");
    const fdvUsd = pair.fdv || 0;

    if (fdvUsd > 0) {
      const newMultiple = Math.min(fdvUsd / INSIDER_CONFIG.HISTORY_MIN_FDV_USD, 100);
      const changeRatio = Math.abs(newMultiple - token.oldMultiple) / Math.max(token.oldMultiple, 0.01);
      if (changeRatio > 0.1) {
        updateGemHitPumpMultiple(token.tokenAddress, token.chain, newMultiple);
        console.log(`[InsiderScanner] Price update: ${token.symbol} ${token.oldMultiple.toFixed(1)}x -> ${newMultiple.toFixed(1)}x ($${priceUsd.toFixed(6)})`);
        updated++;
      }
    }
  }

  if (updated > 0) {
    console.log(`[InsiderScanner] Updated ${updated}/${uniqueTokens.size} held token prices`);
  }
}

// Main scan orchestrator
export async function runInsiderScan(): Promise<InsiderScanResult> {
  const result: InsiderScanResult = {
    pumpedTokensFound: 0,
    walletsAnalyzed: 0,
    insidersFound: 0,
    errors: [],
  };

  console.log(`[InsiderScanner] Scanning ${INSIDER_CONFIG.SCAN_CHAINS.length} chains sequentially to respect rate limits`);

  for (const chain of INSIDER_CONFIG.SCAN_CHAINS) {
    try {
      // Find pumped tokens
      const pumpedTokens = await findPumpedTokens(chain);
      result.pumpedTokensFound += pumpedTokens.length;

      // For each pumped token, find early buyers
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
              buyBlockNumber: 0,
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
  }

  // Recalculate insider wallets from gem_hits
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
             MAX(buy_timestamp) as last_seen
      FROM insider_gem_hits
      WHERE NOT (status = 'sold' AND sell_date > 0 AND buy_date > 0
            AND (sell_date - buy_date) < ?)
      GROUP BY wallet_address, chain
      HAVING gem_count >= ?
    `).all(INSIDER_CONFIG.SNIPER_MAX_HOLD_MS, INSIDER_CONFIG.MIN_GEM_HITS) as Array<{
      wallet_address: string;
      chain: EvmChain;
      gem_count: number;
      token_symbols: string;
      first_seen: number;
      last_seen: number;
    }>;

    for (const group of walletGroups) {
      const gems = group.token_symbols.split(",").filter(Boolean);
      const score = Math.min(100, group.gem_count * 10);

      if (score >= 80) {
        upsertInsiderWallet({
          address: group.wallet_address,
          chain: group.chain,
          gemHitCount: group.gem_count,
          gems,
          score,
          firstSeenAt: group.first_seen,
          lastSeenAt: group.last_seen,
        });
      }
    }

    const { deleteInsiderWalletsBelow } = await import("./storage.js");
    const deleted = deleteInsiderWalletsBelow(80);
    if (deleted > 0) {
      console.log(`[InsiderScanner] Removed ${deleted} wallets below score 80`);
    }

    result.insidersFound = walletGroups.filter((g) => g.gem_count * 10 >= 80).length;
  } catch (err) {
    const msg = `Error recalculating insiders: ${err}`;
    console.error(`[InsiderScanner] ${msg}`);
    result.errors.push(msg);
  }

  // Enrich P&L data (non-blocking)
  enrichInsiderPnl().catch(err => {
    console.error("[InsiderScanner] P&L enrichment error:", err);
  });

  // Scan historical wallet transactions (non-blocking)
  scanWalletHistory().catch(err => {
    console.error("[InsiderScanner] History scan error:", err);
  });

  // Update held gem prices (non-blocking)
  updateHeldGemPrices().catch(err => {
    console.error("[InsiderScanner] Held gem price update error:", err);
  });

  // Refresh gem paper trade prices (non-blocking)
  refreshGemPaperPrices().catch(err => {
    console.error("[InsiderScanner] Paper price refresh error:", err);
  });

  // Revalidate held gems for liquidity rugs (non-blocking)
  revalidateHeldGems().catch(err => {
    console.error("[InsiderScanner] Revalidation error:", err);
  });

  // Auto-score and paper-buy unscored or unbought held gems (non-blocking)
  try {
    const heldGems = getAllHeldGemHits();
    const tokensToProcess = new Map<string, { symbol: string; chain: string; currentPump: number; tokenAddress: string }>();
    for (const gem of heldGems) {
      const key = `${gem.tokenSymbol.toLowerCase()}_${gem.chain}`;
      if (tokensToProcess.has(key)) continue;
      const cached = getCachedGemAnalysis(gem.tokenSymbol, gem.chain);
      // Process if: no score yet, OR scored >= 80 but no paper trade exists
      if (!cached || (cached.score >= 80 && !getGemPaperTrade(gem.tokenSymbol, gem.chain))) {
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
