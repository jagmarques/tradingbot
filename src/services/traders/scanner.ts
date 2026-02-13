import type { EvmChain, PumpedToken, GemHit, InsiderScanResult } from "./types.js";
import { INSIDER_CONFIG } from "./types.js";
import { upsertGemHit, upsertInsiderWallet, getInsiderWallets, getGemHitsForWallet, updateGemHitPnl, getAllHeldGemHits, updateGemHitPumpMultiple, updateGemPaperTradePrice } from "./storage.js";
import { getDb } from "../database/db.js";
import { KNOWN_EXCHANGES, KNOWN_DEX_ROUTERS } from "./types.js";

function stripEmoji(s: string): string {
  return s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\u{E0067}\u{E0062}\u{E007F}\u{1F3F4}]/gu, "").trim();
}

// GeckoTerminal API
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_NETWORK_IDS: Record<EvmChain, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  optimism: "optimism",
};

// Etherscan V2 API
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

// Chain IDs for Etherscan V2
const ETHERSCAN_CHAIN_IDS: Record<EvmChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  optimism: 10,
};

// Zero address
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// GeckoTerminal free tier: 30 req/min -> use 2500ms base interval (24 req/min) for safety
const GECKO_BASE_INTERVAL_MS = 2500;
let geckoIntervalMs = GECKO_BASE_INTERVAL_MS;
let geckoFetchQueue: Promise<void> = Promise.resolve();
let geckoConsecutive429s = 0;
let geckoPausedUntil = 0;

async function geckoRateLimitedFetch(url: string): Promise<Response> {
  // Circuit breaker: if paused after too many 429s, return synthetic 429
  if (Date.now() < geckoPausedUntil) {
    return new Response(null, { status: 429, statusText: "Rate limit cooldown" });
  }

  const myTurn = geckoFetchQueue.then(async () => {
    await new Promise((r) => setTimeout(r, geckoIntervalMs));
  });
  geckoFetchQueue = myTurn;
  await myTurn;

  // Check again after waiting in queue (cooldown may have started)
  if (Date.now() < geckoPausedUntil) {
    return new Response(null, { status: 429, statusText: "Rate limit cooldown" });
  }

  const response = await fetch(url);
  if (response.status === 429) {
    geckoConsecutive429s++;
    if (geckoConsecutive429s >= 3) {
      // Exponential cooldown: 30s, 60s, 120s (max 2 min)
      const cooldownMs = Math.min(30_000 * Math.pow(2, geckoConsecutive429s - 3), 120_000);
      geckoPausedUntil = Date.now() + cooldownMs;
      geckoIntervalMs = Math.min(geckoIntervalMs * 2, 10_000); // Double interval, max 10s
      console.warn(`[InsiderScanner] GeckoTerminal ${geckoConsecutive429s} consecutive 429s, pausing ${cooldownMs / 1000}s, interval now ${geckoIntervalMs}ms`);
    }
    return response; // Return 429 to caller, don't retry outside queue
  }

  // Success: gradually recover interval
  if (geckoConsecutive429s > 0) {
    geckoConsecutive429s = 0;
    geckoIntervalMs = Math.max(geckoIntervalMs - 500, GECKO_BASE_INTERVAL_MS);
  }
  return response;
}

// Rate limiting for Etherscan (220ms between requests, per chain)
const ETHERSCAN_INTERVAL_MS = 220;
const etherscanQueueByChain = new Map<string, Promise<void>>();

async function etherscanRateLimitedFetch(url: string, chain: string): Promise<Response> {
  const currentQueue = etherscanQueueByChain.get(chain) || Promise.resolve();
  const myTurn = currentQueue.then(async () => {
    await new Promise((r) => setTimeout(r, ETHERSCAN_INTERVAL_MS));
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
export async function findPumpedTokens(chain: EvmChain): Promise<PumpedToken[]> {
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
      const tokenAddress = parts.slice(1).join("_").toLowerCase();

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

// Find wallets that bought a token early (within first 50-100 transfers)
export async function findEarlyBuyers(token: PumpedToken): Promise<string[]> {
  const chainId = ETHERSCAN_CHAIN_IDS[token.chain];
  const apiKey = process.env.ETHERSCAN_API_KEY || "";

  const url = `${ETHERSCAN_V2_URL}?chainid=${chainId}&module=account&action=tokentx&contractaddress=${token.tokenAddress}&startblock=0&endblock=99999999&sort=asc${apiKey ? `&apikey=${apiKey}` : ""}`;

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
  walletAddress: string, tokenAddress: string, chain: EvmChain
): Promise<WalletTokenPnl> {
  const chainId = ETHERSCAN_CHAIN_IDS[chain];
  const apiKey = process.env.ETHERSCAN_API_KEY || "";

  const url = `${ETHERSCAN_V2_URL}?chainid=${chainId}&module=account&action=tokentx&address=${walletAddress}&contractaddress=${tokenAddress}&startblock=0&endblock=99999999&sort=asc${apiKey ? `&apikey=${apiKey}` : ""}`;

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
    try {
      const chainId = ETHERSCAN_CHAIN_IDS[wallet.chain];
      const apiKey = process.env.ETHERSCAN_API_KEY || "";

      // Query all token transfers for this wallet (no contractaddress filter)
      const url = `${ETHERSCAN_V2_URL}?chainid=${chainId}&module=account&action=tokentx&address=${wallet.address}&startblock=0&endblock=99999999&sort=asc${apiKey ? `&apikey=${apiKey}` : ""}`;
      const response = await etherscanRateLimitedFetch(url, wallet.chain);
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

      // Check each token on GeckoTerminal
      const networkId = GECKO_NETWORK_IDS[wallet.chain];
      for (const [tokenAddress, tokenInfo] of newTokens) {
        try {
          const geckoUrl = `${GECKO_BASE}/networks/${networkId}/tokens/${tokenAddress}`;
          const geckoResponse = await geckoRateLimitedFetch(geckoUrl);

          checkedCount++;

          if (!geckoResponse.ok) {
            // Token doesn't exist on GeckoTerminal, skip
            continue;
          }

          const geckoData = (await geckoResponse.json()) as {
            data: {
              attributes: {
                symbol: string;
                fdv_usd: string;
                volume_usd: { h24: string };
                price_usd: string;
                total_reserve_in_usd: string;
              };
            };
          };

          const fdvUsd = parseFloat(geckoData.data.attributes.fdv_usd || "0");
          const reserveUsd = parseFloat(geckoData.data.attributes.total_reserve_in_usd || "0");

          // FDV or liquidity must qualify
          if (fdvUsd < INSIDER_CONFIG.HISTORY_MIN_FDV_USD && reserveUsd < 1000) {
            continue;
          }

          // Pump multiple from FDV ratio
          const pumpMultiple = Math.min(fdvUsd / INSIDER_CONFIG.HISTORY_MIN_FDV_USD, 100);

          // Store as gem hit
          const hit: GemHit = {
            walletAddress: wallet.address,
            chain: wallet.chain,
            tokenAddress,
            tokenSymbol: stripEmoji(geckoData.data.attributes.symbol || tokenInfo.symbol),
            buyTxHash: "",
            buyTimestamp: tokenInfo.firstTx,
            buyBlockNumber: 0,
            pumpMultiple,
          };
          upsertGemHit(hit);
          newGemsCount++;
        } catch {
          // Skip individual token errors, continue scanning
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
  const uniqueTokens = new Map<string, { tokenAddress: string; chain: EvmChain; symbol: string; oldMultiple: number }>();
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

  for (const [, token] of uniqueTokens) {
    try {
      const networkId = GECKO_NETWORK_IDS[token.chain];
      if (!networkId) continue;

      const geckoUrl = `${GECKO_BASE}/networks/${networkId}/tokens/${token.tokenAddress}`;
      const response = await geckoRateLimitedFetch(geckoUrl);

      if (!response.ok) continue;

      const data = (await response.json()) as {
        data: {
          attributes: {
            fdv_usd: string;
          };
        };
      };

      const fdvUsd = parseFloat(data.data.attributes.fdv_usd || "0");
      if (fdvUsd <= 0) continue;

      const newMultiple = Math.min(fdvUsd / INSIDER_CONFIG.HISTORY_MIN_FDV_USD, 100);

      // Only update if changed significantly (>10% difference)
      const changeRatio = Math.abs(newMultiple - token.oldMultiple) / Math.max(token.oldMultiple, 0.01);
      if (changeRatio > 0.1) {
        updateGemHitPumpMultiple(token.tokenAddress, token.chain, newMultiple);
        updateGemPaperTradePrice(token.symbol, token.chain, newMultiple);
        console.log(`[InsiderScanner] Price update: ${token.symbol} ${token.oldMultiple.toFixed(1)}x -> ${newMultiple.toFixed(1)}x`);
        updated++;
      }
    } catch {
      // Skip individual token errors
      continue;
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

  await Promise.all(INSIDER_CONFIG.SCAN_CHAINS.map(async (chain) => {
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
  }));

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
      upsertInsiderWallet({
        address: group.wallet_address,
        chain: group.chain,
        gemHitCount: group.gem_count,
        gems,
        score: group.gem_count * 10, // Simple scoring
        firstSeenAt: group.first_seen,
        lastSeenAt: group.last_seen,
      });
    }

    result.insidersFound = walletGroups.length;
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

  console.log(
    `[InsiderScanner] Scan complete: ${result.pumpedTokensFound} pumped tokens, ${result.walletsAnalyzed} wallets, ${result.insidersFound} insiders`
  );

  return result;
}
