import { getOrderApi, getMarketIndex } from "../lighter/client.js";
import { withTimeout } from "../../utils/timeout.js";
import { API_PRICE_TIMEOUT_MS, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import type { SimpleOrder, OrderBookOrders } from "zklighter-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

const TAG = "[OBMicro]";
const ORDERBOOK_DEPTH = 20;
const OFI_RANGE_PCT = 0.01; // 1% of mid price
const OFI_LONG_THRESHOLD = 0.65;
const OFI_SHORT_THRESHOLD = 0.35;
const DEPTH_LONG_THRESHOLD = 1.5;
const DEPTH_SHORT_THRESHOLD = 0.67;
const LARGE_ORDER_MULT = 3;
const MAX_HOLD_MS = 30 * 60 * 1000; // 30 minutes
const OFI_NEUTRAL_LOW = 0.4;
const OFI_NEUTRAL_HIGH = 0.6;
const SIGNAL_LOG_PATH = process.env.OB_SIGNAL_PATH || "/app/data/ob-signals.json";
const MAX_LOG_ENTRIES = 1000;

interface OrderLevel {
  price: number;
  size: number;
}

interface MicroSignals {
  pair: string;
  midPrice: number;
  spread: number;
  spreadBps: number;
  ofi: number;
  depthRatio: number;
  totalBidDepth: number;
  totalAskDepth: number;
  largeOrders: { side: "bid" | "ask"; price: number; size: number; multiplier: number }[];
  timestamp: number;
}

interface VirtualPosition {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  enteredAt: number;
  ofiAtEntry: number;
}

interface SignalAction {
  pair: string;
  action: "long" | "short" | "exit-neutral" | "exit-time" | "hold" | "none";
  ofi: number;
  depthRatio: number;
  midPrice: number;
  spread: number;
}

// Track virtual positions for signal logging
const virtualPositions = new Map<string, VirtualPosition>();

// Previous spread tracking
const prevSpreads = new Map<string, number>();

function parseLevels(orders: SimpleOrder[]): OrderLevel[] {
  return orders
    .map(o => ({
      price: parseFloat(o.price),
      size: parseFloat(o.remaining_base_amount),
    }))
    .filter(l => isFinite(l.price) && isFinite(l.size) && l.size > 0);
}

function computeSignals(pair: string, bids: OrderLevel[], asks: OrderLevel[]): MicroSignals | null {
  if (bids.length === 0 || asks.length === 0) return null;

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  if (bestBid <= 0 || bestAsk <= 0 || bestAsk <= bestBid) return null;

  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadBps = (spread / midPrice) * 10000;

  // OFI: size within 1% of mid
  const ofiRange = midPrice * OFI_RANGE_PCT;
  const nearBidSize = bids
    .filter(l => l.price >= midPrice - ofiRange)
    .reduce((s, l) => s + l.size, 0);
  const nearAskSize = asks
    .filter(l => l.price <= midPrice + ofiRange)
    .reduce((s, l) => s + l.size, 0);
  const totalNear = nearBidSize + nearAskSize;
  const ofi = totalNear > 0 ? nearBidSize / totalNear : 0.5;

  // Full depth ratio
  const totalBidDepth = bids.reduce((s, l) => s + l.size, 0);
  const totalAskDepth = asks.reduce((s, l) => s + l.size, 0);
  const depthRatio = totalAskDepth > 0 ? totalBidDepth / totalAskDepth : 1;

  // Large order detection
  const allLevels = [
    ...bids.map(l => ({ ...l, side: "bid" as const })),
    ...asks.map(l => ({ ...l, side: "ask" as const })),
  ];
  const avgSize = allLevels.reduce((s, l) => s + l.size, 0) / allLevels.length;
  const largeOrders = allLevels
    .filter(l => avgSize > 0 && l.size > LARGE_ORDER_MULT * avgSize)
    .map(l => ({
      side: l.side,
      price: l.price,
      size: l.size,
      multiplier: parseFloat((l.size / avgSize).toFixed(1)),
    }));

  return {
    pair,
    midPrice,
    spread,
    spreadBps,
    ofi,
    depthRatio,
    totalBidDepth,
    totalAskDepth,
    largeOrders,
    timestamp: Date.now(),
  };
}

function determineAction(pair: string, signals: MicroSignals): SignalAction {
  const base = {
    pair,
    ofi: signals.ofi,
    depthRatio: signals.depthRatio,
    midPrice: signals.midPrice,
    spread: signals.spread,
  };

  const vPos = virtualPositions.get(pair);

  if (vPos) {
    // Check time exit
    if (Date.now() - vPos.enteredAt >= MAX_HOLD_MS) {
      return { ...base, action: "exit-time" };
    }
    // Check neutral exit
    if (signals.ofi >= OFI_NEUTRAL_LOW && signals.ofi <= OFI_NEUTRAL_HIGH) {
      return { ...base, action: "exit-neutral" };
    }
    return { ...base, action: "hold" };
  }

  // Entry conditions
  if (signals.ofi > OFI_LONG_THRESHOLD && signals.depthRatio > DEPTH_LONG_THRESHOLD) {
    return { ...base, action: "long" };
  }
  if (signals.ofi < OFI_SHORT_THRESHOLD && signals.depthRatio < DEPTH_SHORT_THRESHOLD) {
    return { ...base, action: "short" };
  }

  return { ...base, action: "none" };
}

async function fetchOrderbook(pair: string): Promise<OrderBookOrders | null> {
  const marketId = await getMarketIndex(pair);
  if (marketId === null) return null;

  const api = getOrderApi();
  const resp = await withTimeout(
    api.orderBookOrders(marketId, ORDERBOOK_DEPTH),
    API_PRICE_TIMEOUT_MS,
    `OBMicro orderbook ${pair}`,
  );
  return resp.data;
}

function appendSignalLog(entry: MicroSignals & { action: string }): void {
  try {
    const dir = dirname(SIGNAL_LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let entries: unknown[] = [];
    if (existsSync(SIGNAL_LOG_PATH)) {
      try {
        const raw = readFileSync(SIGNAL_LOG_PATH, "utf-8");
        entries = JSON.parse(raw);
        if (!Array.isArray(entries)) entries = [];
      } catch {
        entries = [];
      }
    }

    entries.push(entry);
    // Keep last N entries
    if (entries.length > MAX_LOG_ENTRIES) {
      entries = entries.slice(entries.length - MAX_LOG_ENTRIES);
    }

    writeFileSync(SIGNAL_LOG_PATH, JSON.stringify(entries, null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} Failed to write signal log: ${msg}`);
  }
}

export async function runOrderbookCycle(): Promise<void> {
  let signalCount = 0;
  let errorCount = 0;

  for (const pair of QUANT_TRADING_PAIRS) {
    try {
      const book = await fetchOrderbook(pair);
      if (!book?.bids?.length || !book?.asks?.length) continue;

      const bids = parseLevels(book.bids);
      const asks = parseLevels(book.asks);
      const signals = computeSignals(pair, bids, asks);
      if (!signals) continue;

      const action = determineAction(pair, signals);

      // Track spread changes
      const prevSpread = prevSpreads.get(pair);
      const spreadDelta = prevSpread !== undefined ? signals.spreadBps - prevSpread : 0;
      prevSpreads.set(pair, signals.spreadBps);

      // Log actionable signals
      if (action.action !== "none") {
        signalCount++;
        const spreadNote = Math.abs(spreadDelta) > 1 ? ` spread-delta=${spreadDelta > 0 ? "+" : ""}${spreadDelta.toFixed(1)}bps` : "";
        const largeNote = signals.largeOrders.length > 0
          ? ` large=[${signals.largeOrders.map(o => `${o.side}@${o.price.toFixed(2)}:${o.multiplier}x`).join(",")}]`
          : "";

        if (action.action === "long" || action.action === "short") {
          console.log(
            `${TAG} WOULD ${action.action.toUpperCase()} ${pair} mid=${signals.midPrice.toFixed(4)} ofi=${signals.ofi.toFixed(3)} depth=${signals.depthRatio.toFixed(2)} spread=${signals.spreadBps.toFixed(1)}bps${spreadNote}${largeNote}`,
          );
          // Track virtual position
          virtualPositions.set(pair, {
            pair,
            direction: action.action,
            entryPrice: signals.midPrice,
            enteredAt: Date.now(),
            ofiAtEntry: signals.ofi,
          });
        } else if (action.action === "exit-neutral" || action.action === "exit-time") {
          const vPos = virtualPositions.get(pair);
          if (!vPos) continue;
          const pnlPct = vPos.direction === "long"
            ? ((signals.midPrice - vPos.entryPrice) / vPos.entryPrice) * 100
            : ((vPos.entryPrice - signals.midPrice) / vPos.entryPrice) * 100;
          console.log(
            `${TAG} WOULD EXIT ${pair} ${vPos.direction} reason=${action.action} entry=${vPos.entryPrice.toFixed(4)} now=${signals.midPrice.toFixed(4)} pnl=${pnlPct.toFixed(2)}%`,
          );
          virtualPositions.delete(pair);
        } else if (action.action === "hold") {
          const vPos = virtualPositions.get(pair);
          if (!vPos) continue;
          const pnlPct = vPos.direction === "long"
            ? ((signals.midPrice - vPos.entryPrice) / vPos.entryPrice) * 100
            : ((vPos.entryPrice - signals.midPrice) / vPos.entryPrice) * 100;
          console.log(
            `${TAG} HOLD ${pair} ${vPos.direction} pnl=${pnlPct.toFixed(2)}% ofi=${signals.ofi.toFixed(3)} depth=${signals.depthRatio.toFixed(2)}`,
          );
        }
      }

      // Append to signal log (all pairs, not just actionable)
      appendSignalLog({ ...signals, action: action.action });
    } catch (err) {
      errorCount++;
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("429")) {
        console.error(`${TAG} Error ${pair}: ${msg}`);
      }
    }
  }

  const posCount = virtualPositions.size;
  console.log(`${TAG} Cycle done: ${signalCount} signals, ${posCount} virtual positions, ${errorCount} errors`);
}
