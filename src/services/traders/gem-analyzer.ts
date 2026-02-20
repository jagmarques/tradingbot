import { getOpenCopyTrades, updateCopyTradePrice, closeCopyTrade, updateCopyTradePeakPnl } from "./storage.js";
import type { CopyExitReason } from "./types.js";
import { COPY_TRADE_CONFIG } from "./types.js";
import { dexScreenerFetch, dexScreenerFetchBatch } from "../shared/dexscreener.js";
import { notifyCopyTrade } from "../telegram/notifications.js";
// Price failure tracking (shared across copy trades)
const MAX_PRICE_FAILURES = 3;
const PRICE_FAILURE_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours
const copyPriceFailures = new Map<string, { count: number; lastFailAt: number }>();

const GOPLUS_CHAIN_IDS: Record<string, string> = {
  ethereum: "1",
  base: "8453",
  arbitrum: "42161",
  polygon: "137",
  optimism: "10",
  avalanche: "43114",
};

export async function fetchGoPlusData(tokenAddress: string, chain: string): Promise<Record<string, unknown> | null> {
  const chainId = GOPLUS_CHAIN_IDS[chain];
  if (!chainId) {
    console.warn(`[GemAnalyzer] Unsupported chain: ${chain}`);
    return null;
  }

  const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    console.log(`[GemAnalyzer] GoPlus fetch for ${tokenAddress} on ${chain}`);

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      console.warn(`[GemAnalyzer] GoPlus API error: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      code: number;
      result: Record<string, Record<string, unknown>>;
    };

    if (data.code !== 1) {
      console.warn(`[GemAnalyzer] GoPlus error code ${data.code}`);
      return null;
    }
    if (!data.result) return null;

    const key = tokenAddress.toLowerCase();
    const tokenData = data.result[key];
    return tokenData || null;
  } catch (error) {
    console.warn(`[GemAnalyzer] GoPlus fetch failed for ${tokenAddress}:`, error instanceof Error ? error.message : "unknown");
    return null;
  }
}

export function isGoPlusKillSwitch(data: Record<string, unknown>): boolean {
  if (
    data.is_honeypot === "1" ||
    data.is_mintable === "1" ||
    data.owner_change_balance === "1" ||
    data.can_take_back_ownership === "1" ||
    data.hidden_owner === "1" ||
    data.selfdestruct === "1" ||
    data.is_blacklisted === "1" ||
    data.slippage_modifiable === "1" ||
    data.is_proxy === "1" ||
    data.transfer_pausable === "1" ||
    data.anti_whale_modifiable === "1" ||
    data.cannot_sell_all === "1" ||
    data.cannot_buy === "1" ||
    data.is_whitelisted === "1" ||
    data.is_airdrop_scam === "1" ||
    (typeof data.is_true_token === "string" && data.is_true_token === "0")
  ) {
    return true;
  }

  if (typeof data.honeypot_with_same_creator === "string") {
    const count = parseInt(data.honeypot_with_same_creator, 10);
    if (!isNaN(count) && count > 0) return true;
  }

  if (typeof data.buy_tax === "string" && data.buy_tax !== "") {
    const buyTaxPct = parseFloat(data.buy_tax) * 100;
    if (!isNaN(buyTaxPct) && buyTaxPct > 10) return true;
  }

  if (typeof data.sell_tax === "string" && data.sell_tax !== "") {
    const sellTaxPct = parseFloat(data.sell_tax) * 100;
    if (!isNaN(sellTaxPct) && sellTaxPct > 10) return true;
  }

  return false;
}

export async function refreshCopyTradePrices(): Promise<void> {
  const openTrades = getOpenCopyTrades();
  if (openTrades.length === 0) return;

  // Build list of tokens to fetch prices for
  const tokensToFetch: Array<{ chain: string; tokenAddress: string; walletAddress: string }> = [];
  for (const trade of openTrades) {
    tokensToFetch.push({ chain: trade.chain, tokenAddress: trade.tokenAddress, walletAddress: trade.walletAddress });
  }

  if (tokensToFetch.length === 0) return;

  // Batch fetch prices
  const priceMap = await dexScreenerFetchBatch(
    tokensToFetch.map(t => ({ chain: t.chain, tokenAddress: t.tokenAddress }))
  );

  let updated = 0;
  for (const token of tokensToFetch) {
    const addrKey = token.tokenAddress.toLowerCase();
    let pair = priceMap.get(addrKey);

    // Single fetch fallback (includes Gecko)
    if (!pair || parseFloat(pair.priceUsd || "0") <= 0) {
      pair = (await dexScreenerFetch(token.chain, token.tokenAddress)) ?? undefined;
    }

    const priceUsd = pair ? parseFloat(pair.priceUsd || "0") : 0;
    const failKey = `${token.tokenAddress}_${token.chain}`;

    if (priceUsd > 0) {
      updateCopyTradePrice(token.walletAddress, token.tokenAddress, token.chain, priceUsd);
      copyPriceFailures.delete(failKey);
      updated++;
    } else {
      // Track price fetch failures - auto-close after repeated failures
      const prev = copyPriceFailures.get(failKey);
      if (prev && Date.now() - prev.lastFailAt > PRICE_FAILURE_EXPIRY_MS) {
        copyPriceFailures.delete(failKey);
      }
      const entry = copyPriceFailures.get(failKey);
      const newCount = (entry?.count ?? 0) + 1;
      copyPriceFailures.set(failKey, { count: newCount, lastFailAt: Date.now() });
      if (newCount >= MAX_PRICE_FAILURES) {
        const trade = openTrades.find(t => t.tokenAddress.toLowerCase() === addrKey);
        if (trade) {
          console.log(`[CopyTrade] AUTO CLOSE: ${trade.tokenSymbol} (${trade.chain}) - no price after ${MAX_PRICE_FAILURES} attempts`);
          closeCopyTrade(trade.walletAddress, trade.tokenAddress, trade.chain, "stale_price");
          notifyCopyTrade({
            walletAddress: trade.walletAddress, tokenSymbol: trade.tokenSymbol, chain: trade.chain,
            side: "sell", priceUsd: 0, liquidityOk: false, liquidityUsd: 0,
            skipReason: "stale price", pnlPct: trade.pnlPct,
          }).catch(() => {});
        }
        copyPriceFailures.delete(failKey);
      }
    }
  }

  if (updated > 0) {
    console.log(`[CopyTrade] Refreshed prices for ${updated} open copy trades`);
  }

  // Trailing stop-loss check
  const refreshedTrades = getOpenCopyTrades();
  for (const trade of refreshedTrades) {
    // Track peak P&L for trailing stop
    if (trade.pnlPct > trade.peakPnlPct) {
      updateCopyTradePeakPnl(trade.id, trade.pnlPct);
    }
    const peak = Math.max(trade.peakPnlPct, trade.pnlPct);

    // Auto-close at +500%
    if (trade.pnlPct >= 500) {
      console.log(`[CopyTrade] AUTO CLOSE: ${trade.tokenSymbol} (${trade.chain}) at +${trade.pnlPct.toFixed(0)}% (target reached)`);
      closeCopyTrade(trade.walletAddress, trade.tokenAddress, trade.chain, "target_500");
      notifyCopyTrade({
        walletAddress: trade.walletAddress, tokenSymbol: trade.tokenSymbol, chain: trade.chain,
        side: "sell", priceUsd: trade.currentPriceUsd, liquidityOk: true, liquidityUsd: 0,
        skipReason: "target +500%", pnlPct: trade.pnlPct,
      }).catch(() => {});
      continue;
    }

    // Trailing stop ladder based on peak profit (aggressive for micro-caps)
    let stopLevel = COPY_TRADE_CONFIG.STOP_LOSS_PCT; // -80% floor
    if (peak >= 200) {
      stopLevel = 100; // lock in +100% if we hit +200%
    } else if (peak >= 100) {
      stopLevel = 50; // lock in +50% if we hit +100%
    } else if (peak >= 50) {
      stopLevel = 0; // breakeven if we hit +50%
    }

    if (trade.pnlPct <= stopLevel) {
      const reason = stopLevel >= 0 ? `trailing stop at +${stopLevel}% (peak +${peak.toFixed(0)}%)` : `stop loss at ${stopLevel}%`;
      const exitReason: CopyExitReason = stopLevel >= 0 ? "trailing_stop" : "stop_loss";
      console.log(`[CopyTrade] STOP: ${trade.tokenSymbol} (${trade.chain}) at ${trade.pnlPct.toFixed(0)}% - ${reason}`);
      closeCopyTrade(trade.walletAddress, trade.tokenAddress, trade.chain, exitReason);
      notifyCopyTrade({
        walletAddress: trade.walletAddress, tokenSymbol: trade.tokenSymbol, chain: trade.chain,
        side: "sell", priceUsd: trade.currentPriceUsd, liquidityOk: true, liquidityUsd: 0,
        skipReason: reason, pnlPct: trade.pnlPct,
      }).catch(() => {});
    }
  }
}

export function clearCopyPriceFailures(): void {
  copyPriceFailures.clear();
}

