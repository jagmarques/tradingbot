import { ensureConnected, getClient } from "./client.js";
import type { QuantAccountState, QuantPosition } from "./types.js";

export async function getAccountBalance(walletAddress: string): Promise<{
  balance: number;
  equity: number;
  unrealizedPnl: number;
}> {
  try {
    await ensureConnected();
    const sdk = getClient();
    const state = await sdk.info.perpetuals.getClearinghouseState(walletAddress);

    const equity = parseFloat(state.marginSummary.accountValue);
    const totalMarginUsed = parseFloat(state.marginSummary.totalMarginUsed);
    const balance = equity - totalMarginUsed;

    const unrealizedPnl = state.assetPositions.reduce((sum, ap) => {
      return sum + parseFloat(ap.position.unrealizedPnl);
    }, 0);

    console.log(`[Hyperliquid] Balance: $${equity.toFixed(2)} equity`);
    return { balance, equity, unrealizedPnl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hyperliquid] Failed to fetch balance: ${msg}`);
    return { balance: 0, equity: 0, unrealizedPnl: 0 };
  }
}

export async function getOpenPositions(
  walletAddress: string,
): Promise<QuantPosition[]> {
  try {
    await ensureConnected();
    const sdk = getClient();
    const state = await sdk.info.perpetuals.getClearinghouseState(walletAddress);

    const positions: QuantPosition[] = state.assetPositions
      .filter((ap) => parseFloat(ap.position.szi) !== 0)
      .map((ap) => {
        const p = ap.position;
        const szi = parseFloat(p.szi);
        return {
          id: `${p.coin}-${p.entryPx}`,
          pair: p.coin.replace(/-PERP$/, ""),
          direction: szi > 0 ? "long" : "short",
          entryPrice: parseFloat(p.entryPx),
          size: Math.abs(szi),
          leverage: p.leverage.value,
          unrealizedPnl: parseFloat(p.unrealizedPnl),
          mode: "live" as const,
          openedAt: new Date().toISOString(),
          closedAt: undefined,
          exitPrice: undefined,
          realizedPnl: undefined,
          exitReason: undefined,
          status: "open" as const,
        };
      });

    console.log(`[Hyperliquid] Found ${positions.length} open positions`);
    return positions;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hyperliquid] Failed to fetch positions: ${msg}`);
    return [];
  }
}

export async function getRecentFills(
  walletAddress: string,
  limit: number = 20,
): Promise<
  Array<{
    pair: string;
    direction: string;
    price: number;
    size: number;
    fee: number;
    time: string;
  }>
> {
  try {
    await ensureConnected();
    const sdk = getClient();
    const fills = await sdk.info.getUserFills(walletAddress);

    const mapped = fills.slice(0, limit).map((f) => ({
      pair: f.coin,
      direction: f.side,
      price: parseFloat(f.px),
      size: parseFloat(f.sz),
      fee: parseFloat(f.fee),
      time: new Date(f.time).toISOString(),
    }));

    console.log(`[Hyperliquid] Fetched ${mapped.length} recent fills`);
    return mapped;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hyperliquid] Failed to fetch fills: ${msg}`);
    return [];
  }
}

export async function getAccountState(
  walletAddress: string,
): Promise<QuantAccountState> {
  const [{ balance, equity, unrealizedPnl }, positions] = await Promise.all([
    getAccountBalance(walletAddress),
    getOpenPositions(walletAddress),
  ]);

  return { balance, equity, unrealizedPnl, positions };
}
