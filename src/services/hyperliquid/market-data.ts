import { ensureConnected, getClient } from "./client.js";
import type { FundingInfo, FundingOpportunity, LongShortRatio, OrderbookImbalance } from "./types.js";
import { FUNDING_ARB_MIN_APR } from "../../config/constants.js";

const FUNDING_PERIODS_PER_YEAR = 24 * 365; // 1-hour funding periods (Hyperliquid)

export async function fetchFundingRate(pair: string): Promise<FundingInfo | null> {
  try {
    await ensureConnected();
    const sdk = getClient();

    const fundings = await sdk.info.perpetuals.getPredictedFundings(true);
    // SDK returns { [coin]: VenueFunding[] }
    const venueFundingList = fundings[pair];
    if (!venueFundingList || venueFundingList.length === 0) {
      return null;
    }

    const firstVenue = venueFundingList[0];
    const venueName = Object.keys(firstVenue)[0];
    const fundingData = venueName ? firstVenue[venueName] : undefined;

    const currentRate = fundingData ? parseFloat(String(fundingData.fundingRate ?? 0)) : 0;
    const annualizedRate = currentRate * FUNDING_PERIODS_PER_YEAR;
    const nextFundingTime = fundingData?.nextFundingTime
      ? Number(fundingData.nextFundingTime)
      : Date.now() + 8 * 60 * 60 * 1000;

    console.log(
      `[Hyperliquid] Funding rate for ${pair}: ${(currentRate * 100).toFixed(4)}% (${(annualizedRate * 100).toFixed(2)}% annualized)`,
    );

    return {
      pair,
      currentRate,
      annualizedRate,
      nextFundingTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hyperliquid] Failed to fetch funding rate for ${pair}: ${msg}`);
    return null;
  }
}

export async function fetchOpenInterest(pair: string): Promise<number> {
  try {
    await ensureConnected();
    const sdk = getClient();

    const [meta, assetCtxs] = await sdk.info.perpetuals.getMetaAndAssetCtxs(true);
    const idx = meta.universe.findIndex((u) => u.name === pair);
    if (idx === -1) {
      console.warn(`[Hyperliquid] Pair ${pair} not found in universe`);
      return 0;
    }

    const ctx = assetCtxs[idx];
    const oi = parseFloat(String(ctx.openInterest ?? 0));
    console.log(`[Hyperliquid] Open interest for ${pair}: ${oi.toFixed(2)}`);
    return oi;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hyperliquid] Failed to fetch open interest for ${pair}: ${msg}`);
    return 0;
  }
}

export async function fetchAllFundingRates(): Promise<FundingInfo[]> {
  try {
    await ensureConnected();

    type VenueData = { fundingRate: string; nextFundingTime: number; fundingIntervalHours: number };
    const fundings = await getClient().info.perpetuals.getPredictedFundings(true);
    const results: FundingInfo[] = [];

    // SDK returns either array of tuples or object - handle both
    let entries: [string, unknown][];
    if (Array.isArray(fundings)) {
      entries = fundings as [string, unknown][];
    } else if (fundings && typeof fundings === "object") {
      entries = Object.entries(fundings);
    } else {
      console.warn("[FundingArb] Unexpected fundings format:", typeof fundings);
      return [];
    }

    for (const entry of entries) {
      const pair = String(entry[0]);
      const venueList = entry[1];
      if (!Array.isArray(venueList)) continue;

      // Each venue is either [name, data] tuple or {name: data} object
      let hlData: VenueData | undefined;
      for (const venue of venueList) {
        if (Array.isArray(venue) && venue[0] === "HlPerp") {
          hlData = venue[1] as VenueData;
          break;
        } else if (venue && typeof venue === "object" && "HlPerp" in venue) {
          hlData = (venue as Record<string, VenueData>)["HlPerp"];
          break;
        }
      }
      if (!hlData) continue;

      const currentRate = parseFloat(String(hlData.fundingRate ?? 0));
      if (currentRate === 0) continue;

      const intervalHours = hlData.fundingIntervalHours ?? 8;
      const periodsPerYear = 8760 / intervalHours;
      const annualizedRate = currentRate * periodsPerYear;
      const nextFundingTime = Number(hlData.nextFundingTime);

      results.push({ pair, currentRate, annualizedRate, nextFundingTime });
    }

    console.log(`[FundingArb] Scanned ${results.length} pairs for funding rates`);
    return results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FundingArb] Failed to fetch all funding rates: ${msg}`);
    return [];
  }
}

export async function scanFundingOpportunities(): Promise<FundingOpportunity[]> {
  try {
    await ensureConnected();
    const sdk = getClient();

    const [allRates, midsRaw] = await Promise.all([
      fetchAllFundingRates(),
      sdk.info.getAllMids(true) as Promise<Record<string, string>>,
    ]);

    const qualifying = allRates.filter((r) => Math.abs(r.annualizedRate) >= FUNDING_ARB_MIN_APR);

    const opportunities: FundingOpportunity[] = [];
    for (const rate of qualifying) {
      const midStr = midsRaw[rate.pair];
      if (!midStr) continue;

      const markPrice = parseFloat(midStr);
      if (isNaN(markPrice) || markPrice <= 0) continue;

      const direction: "long" | "short" = rate.annualizedRate > 0 ? "short" : "long";

      opportunities.push({
        pair: rate.pair,
        currentRate: rate.currentRate,
        annualizedRate: rate.annualizedRate,
        direction,
        nextFundingTime: rate.nextFundingTime,
        markPrice,
      });
    }

    console.log(`[FundingArb] Found ${opportunities.length} funding opportunities above ${(FUNDING_ARB_MIN_APR * 100).toFixed(0)}% APR`);
    return opportunities;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FundingArb] Failed to scan funding opportunities: ${msg}`);
    return [];
  }
}

export async function fetchMarketContext(pair: string): Promise<{
  markPrice: number;
  oraclePrice: number;
  dayVolume: number;
  fundingRate: number;
  openInterest: number;
}> {
  try {
    await ensureConnected();
    const sdk = getClient();

    const [meta, assetCtxs] = await sdk.info.perpetuals.getMetaAndAssetCtxs(true);
    const idx = meta.universe.findIndex((u) => u.name === pair);
    if (idx === -1) {
      console.warn(`[Hyperliquid] Pair ${pair} not found in universe`);
      return { markPrice: 0, oraclePrice: 0, dayVolume: 0, fundingRate: 0, openInterest: 0 };
    }

    const ctx = assetCtxs[idx];
    const markPrice = parseFloat(String(ctx.markPx ?? 0));
    const oraclePrice = parseFloat(String(ctx.oraclePx ?? 0));
    const dayVolume = parseFloat(String(ctx.dayNtlVlm ?? 0));
    const fundingRate = parseFloat(String(ctx.funding ?? 0));
    const openInterest = parseFloat(String(ctx.openInterest ?? 0));

    console.log(
      `[Hyperliquid] Market context for ${pair}: mark=$${markPrice.toFixed(2)}, oi=${openInterest.toFixed(2)}, funding=${(fundingRate * 100).toFixed(4)}%`,
    );

    return { markPrice, oraclePrice, dayVolume, fundingRate, openInterest };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hyperliquid] Failed to fetch market context for ${pair}: ${msg}`);
    return { markPrice: 0, oraclePrice: 0, dayVolume: 0, fundingRate: 0, openInterest: 0 };
  }
}

const BINANCE_SYMBOL_MAP: Record<string, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  DOGE: "DOGEUSDT",
  AVAX: "AVAXUSDT",
  LINK: "LINKUSDT",
  ARB: "ARBUSDT",
  OP: "OPUSDT",
};

export async function fetchBinanceLongShortRatio(pair: string): Promise<LongShortRatio | null> {
  const symbol = BINANCE_SYMBOL_MAP[pair] ?? `${pair}USDT`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const [globalRes, topRes] = await Promise.all([
      fetch(
        `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=5`,
        { signal: controller.signal },
      ),
      fetch(
        `https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=1h&limit=5`,
        { signal: controller.signal },
      ),
    ]);

    if (!globalRes.ok || !topRes.ok) {
      console.warn(`[Binance] Non-OK response for ${pair}: global=${globalRes.status} top=${topRes.status}`);
      return null;
    }

    const globalData = (await globalRes.json()) as Array<{ longShortRatio: string }>;
    const topData = (await topRes.json()) as Array<{ longShortRatio: string }>;

    if (!Array.isArray(globalData) || globalData.length === 0 || !Array.isArray(topData) || topData.length === 0) {
      console.warn(`[Binance] Empty long/short data for ${pair}`);
      return null;
    }

    const globalLatest = parseFloat(globalData[globalData.length - 1].longShortRatio);
    const topLatest = parseFloat(topData[topData.length - 1].longShortRatio);
    const globalFirst = parseFloat(globalData[0].longShortRatio);

    let globalTrend: "rising" | "falling" | "stable";
    const trendDiff = globalLatest - globalFirst;
    if (trendDiff > 0.05) {
      globalTrend = "rising";
    } else if (trendDiff < -0.05) {
      globalTrend = "falling";
    } else {
      globalTrend = "stable";
    }

    console.log(
      `[Binance] Long/short ratio for ${pair}: global=${globalLatest.toFixed(3)}, top=${topLatest.toFixed(3)}, trend=${globalTrend}`,
    );

    return { global: globalLatest, topTraders: topLatest, globalTrend };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Binance] Failed to fetch long/short ratio for ${pair}: ${msg}`);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchOrderbookDepth(pair: string, markPrice: number): Promise<OrderbookImbalance | null> {
  try {
    await ensureConnected();
    const sdk = getClient();

    const l2Book = await sdk.info.getL2Book(pair, true);
    const bids = l2Book.levels[0] ?? [];
    const asks = l2Book.levels[1] ?? [];

    if (bids.length === 0 || asks.length === 0) {
      console.warn(`[Hyperliquid] Empty L2 book for ${pair}`);
      return null;
    }

    const mid = markPrice > 0 ? markPrice : parseFloat(bids[0].px);
    const bidThreshold = mid * 0.98;
    const askThreshold = mid * 1.02;

    let bidDepthUsd = 0;
    for (const level of bids) {
      const px = parseFloat(level.px);
      if (px >= bidThreshold) {
        bidDepthUsd += parseFloat(level.sz) * px;
      }
    }

    let askDepthUsd = 0;
    for (const level of asks) {
      const px = parseFloat(level.px);
      if (px <= askThreshold) {
        askDepthUsd += parseFloat(level.sz) * px;
      }
    }

    const totalDepth = bidDepthUsd + askDepthUsd;
    const imbalanceRatio = totalDepth > 0 ? bidDepthUsd / totalDepth : 0.5;

    const bestBid = parseFloat(bids[0].px);
    const bestAsk = parseFloat(asks[0].px);
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

    console.log(
      `[Hyperliquid] Orderbook ${pair}: bid=$${bidDepthUsd.toFixed(0)}, ask=$${askDepthUsd.toFixed(0)}, imbalance=${imbalanceRatio.toFixed(3)}`,
    );

    return { bidDepthUsd, askDepthUsd, imbalanceRatio, spreadBps };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Hyperliquid] Failed to fetch orderbook for ${pair}: ${msg}`);
    return null;
  }
}

const previousOI = new Map<string, number>();

export function computeOIDelta(
  pair: string,
  currentOI: number,
): { oiDelta: number; oiDeltaPct: number } | null {
  const prev = previousOI.get(pair);
  previousOI.set(pair, currentOI);

  if (prev === undefined) {
    return null;
  }

  const delta = currentOI - prev;
  const deltaPct = prev !== 0 ? (delta / prev) * 100 : 0;

  const sign = delta > 0 ? "+" : "";
  console.log(`[Hyperliquid] OI delta ${pair}: ${sign}${delta.toFixed(0)} (${deltaPct.toFixed(2)}%)`);

  return { oiDelta: delta, oiDeltaPct: deltaPct };
}
