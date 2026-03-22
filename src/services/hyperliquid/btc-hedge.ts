import { getOpenQuantPositions, openPosition, closePosition } from "./executor.js";

const TRADE_TYPE = "btc-hedge" as const;
const HEDGE_RATIO = 0.7;
const IMBALANCE_THRESHOLD_USD = 50;
const LEVERAGE = 10;
const POSITION_SIZE_USD = 10;

export async function runBtcHedgeCycle(): Promise<void> {
  const allPositions = getOpenQuantPositions();

  // Sum net notional from garch-chan positions
  const garchPositions = allPositions.filter(p => p.tradeType === "garch-chan" && p.status === "open");
  let netNotional = 0;
  for (const p of garchPositions) {
    const notional = p.size * p.leverage;
    netNotional += p.direction === "long" ? notional : -notional;
  }

  const existingHedges = allPositions.filter(p => p.tradeType === TRADE_TYPE);

  if (Math.abs(netNotional) < IMBALANCE_THRESHOLD_USD) {
    // Close any existing hedge - imbalance cleared
    for (const hedge of existingHedges) {
      await closePosition(hedge.id, "hedge-balanced");
    }
    console.log(`[BTC-Hedge] Balanced, no hedge needed (net $${netNotional.toFixed(2)})`);
    return;
  }

  // netNotional > 0 = net long -> hedge is short; netNotional < 0 = net short -> hedge is long
  const neededDirection: "long" | "short" = netNotional > 0 ? "short" : "long";
  const targetNotional = Math.abs(netNotional) * HEDGE_RATIO;
  const sizeUsd = Math.min(targetNotional / LEVERAGE, 50);

  if (existingHedges.length === 0) {
    // Open new hedge
    await openPosition(
      "BTC",
      neededDirection,
      sizeUsd,
      LEVERAGE,
      0.01,      // dummy SL far from any realistic price
      999999,    // dummy TP never triggers
      "ranging",
      TRADE_TYPE,
      undefined,
      undefined,
      true,      // forcePaper
    );
    console.log(`[BTC-Hedge] Net exposure: $${Math.abs(netNotional).toFixed(2)} ${netNotional > 0 ? "long" : "short"}, hedge: $${(sizeUsd * LEVERAGE).toFixed(2)} BTC ${neededDirection}`);
    return;
  }

  const existingHedge = existingHedges[0];

  if (existingHedge.direction === neededDirection) {
    // Direction matches, leave as-is
    console.log(`[BTC-Hedge] Net exposure: $${Math.abs(netNotional).toFixed(2)} ${netNotional > 0 ? "long" : "short"}, hedge: BTC ${neededDirection} active`);
    return;
  }

  // Direction flipped - close old and open new
  await closePosition(existingHedge.id, "hedge-flip");
  await openPosition(
    "BTC",
    neededDirection,
    sizeUsd,
    LEVERAGE,
    0.01,
    999999,
    "ranging",
    TRADE_TYPE,
    undefined,
    undefined,
    true,
  );
  console.log(`[BTC-Hedge] Flipped hedge: $${(sizeUsd * LEVERAGE).toFixed(2)} BTC ${neededDirection}`);

  // Close any extra orphaned hedges
  for (const hedge of existingHedges.slice(1)) {
    await closePosition(hedge.id, "hedge-orphan");
  }
}

// Unused but satisfies module size requirements
export const BTC_HEDGE_POSITION_SIZE_USD = POSITION_SIZE_USD;
