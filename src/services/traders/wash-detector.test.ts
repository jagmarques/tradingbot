import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./storage.js", () => ({
  getTraderTrades: vi.fn(),
  getClusterWallets: vi.fn(),
}));

import {
  analyzeWashTrading,
  WASH_TRADING_THRESHOLDS,
} from "./wash-detector.js";
import { getTraderTrades, getClusterWallets } from "./storage.js";
import type { TraderTrade, Chain } from "./types.js";

const mockGetTraderTrades = getTraderTrades as unknown as ReturnType<
  typeof vi.fn
>;
const mockGetClusterWallets = getClusterWallets as unknown as ReturnType<
  typeof vi.fn
>;

const WALLET = "0xTrader1";
const CHAIN: Chain = "ethereum";
const NOW = Date.now();

function makeTrade(overrides: Partial<TraderTrade> = {}): TraderTrade {
  return {
    id: `trade_${Math.random().toString(36).slice(2, 8)}`,
    walletAddress: WALLET,
    chain: CHAIN,
    tokenAddress: "0xTokenA",
    tokenSymbol: "TOKA",
    type: "BUY",
    amountUsd: 1000,
    price: 1.5,
    txHash: `0x${Math.random().toString(36).slice(2, 10)}`,
    timestamp: NOW - 60_000,
    ...overrides,
  };
}

/** Generate N distinct normal trades (varied tokens, spaced out). */
function makeNormalTrades(count: number): TraderTrade[] {
  const trades: TraderTrade[] = [];
  for (let i = 0; i < count; i++) {
    trades.push(
      makeTrade({
        tokenAddress: `0xToken${i}`,
        tokenSymbol: `TK${i}`,
        type: i % 2 === 0 ? "BUY" : "SELL",
        price: 1.0 + i * 0.5,
        amountUsd: 500 + i * 100,
        timestamp: NOW - i * 3600_000, // 1 hour apart
      })
    );
  }
  return trades;
}

/** Generate offsetting pairs: BUY then SELL same token within seconds at same price. */
function makeOffsettingPairs(
  pairCount: number,
  token: string = "0xWashToken"
): TraderTrade[] {
  const trades: TraderTrade[] = [];
  for (let i = 0; i < pairCount; i++) {
    const buyTime = NOW - (i + 1) * 600_000;
    trades.push(
      makeTrade({
        tokenAddress: token,
        tokenSymbol: "WASH",
        type: "BUY",
        price: 2.0,
        amountUsd: 1000,
        timestamp: buyTime,
      })
    );
    trades.push(
      makeTrade({
        tokenAddress: token,
        tokenSymbol: "WASH",
        type: "SELL",
        price: 2.01, // Within 2% tolerance
        amountUsd: 1050, // Within 20% tolerance
        timestamp: buyTime + 120_000, // 2 minutes later
      })
    );
  }
  return trades;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClusterWallets.mockReturnValue([WALLET]); // Default: no cluster
});

describe("analyzeWashTrading", () => {
  // === Clean trader scenarios ===

  it("returns clean result for fewer than 10 trades", () => {
    mockGetTraderTrades.mockReturnValue([makeTrade(), makeTrade(), makeTrade()]);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.isWashTrader).toBe(false);
    expect(result.washScore).toBe(0);
    expect(result.totalTradesAnalyzed).toBe(3);
    expect(result.scorePenalty).toBe(0);
  });

  it("returns clean result for normal trading patterns", () => {
    const trades = makeNormalTrades(15);
    mockGetTraderTrades.mockReturnValue(trades);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.isWashTrader).toBe(false);
    expect(result.washScore).toBeLessThan(WASH_TRADING_THRESHOLDS.WASH_SCORE_THRESHOLD);
    expect(result.offsettingPairsCount).toBe(0);
    expect(result.scorePenalty).toBe(0);
  });

  it("returns clean for day trader with different prices (> 2% spread)", () => {
    const trades: TraderTrade[] = [];
    for (let i = 0; i < 12; i++) {
      trades.push(
        makeTrade({
          tokenAddress: "0xDayTrade",
          type: i % 2 === 0 ? "BUY" : "SELL",
          price: i % 2 === 0 ? 1.0 : 1.5, // 50% price diff, far above 2%
          amountUsd: 1000,
          timestamp: NOW - i * 60_000,
        })
      );
    }
    mockGetTraderTrades.mockReturnValue(trades);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.offsettingPairsCount).toBe(0);
    expect(result.isWashTrader).toBe(false);
  });

  it("returns clusterSyncCount 0 when no cluster wallets", () => {
    mockGetTraderTrades.mockReturnValue(makeNormalTrades(15));
    mockGetClusterWallets.mockReturnValue([WALLET]); // Only self

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.clusterSyncCount).toBe(0);
  });

  // === Wash trading scenarios ===

  it("flags trader with 3+ offsetting pairs at same price", () => {
    // 3 wash pairs + enough filler to reach 10 trades
    const washTrades = makeOffsettingPairs(3);
    const filler = makeNormalTrades(4);
    mockGetTraderTrades.mockReturnValue([...washTrades, ...filler]);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.offsettingPairsCount).toBeGreaterThanOrEqual(3);
    expect(result.washScore).toBeGreaterThan(0);
    expect(result.suspiciousPatterns.length).toBeGreaterThanOrEqual(3);
  });

  it("calculates washScore reflecting offsetting ratio", () => {
    // 5 offsetting pairs on one token + 10 normal trades on different tokens
    const washTrades = makeOffsettingPairs(5);
    const filler = makeNormalTrades(10);
    mockGetTraderTrades.mockReturnValue([...washTrades, ...filler]);

    const result = analyzeWashTrading(WALLET, CHAIN);

    // offsettingRatio = 5/5 = 1.0 (only wash token has pairs), washScore = 1.0 * 0.6 = 0.6
    expect(result.washScore).toBeGreaterThan(0);
    expect(result.offsettingPairsCount).toBe(5);
  });

  it("detects cluster syncs when linked wallets trade same token within 1 min", () => {
    const primaryTrades = makeNormalTrades(12);
    // Put a specific token in the primary trades
    primaryTrades[0] = makeTrade({
      tokenAddress: "0xSyncToken",
      tokenSymbol: "SYNC",
      type: "BUY",
      timestamp: NOW - 30_000,
    });

    mockGetTraderTrades.mockImplementation(
      (wallet: string, _chain: Chain, _since?: number) => {
        if (wallet === WALLET) return primaryTrades;
        if (wallet === "0xLinkedWallet") {
          // Linked wallet sells same token 20 seconds later
          return [
            makeTrade({
              walletAddress: "0xLinkedWallet",
              tokenAddress: "0xSyncToken",
              tokenSymbol: "SYNC",
              type: "SELL",
              timestamp: NOW - 10_000, // 20s after primary buy
            }),
          ];
        }
        return [];
      }
    );

    mockGetClusterWallets.mockReturnValue([WALLET, "0xLinkedWallet"]);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.clusterSyncCount).toBeGreaterThanOrEqual(1);
    expect(result.suspiciousPatterns.some((p) => p.includes("Coordinated"))).toBe(
      true
    );
  });

  it("flags one wallet buys, linked wallet sells same token within 60s", () => {
    const primaryTrades = makeNormalTrades(12);
    primaryTrades[0] = makeTrade({
      tokenAddress: "0xPumpToken",
      tokenSymbol: "PUMP",
      type: "BUY",
      timestamp: NOW - 45_000,
    });

    mockGetTraderTrades.mockImplementation(
      (wallet: string, _chain: Chain, _since?: number) => {
        if (wallet === WALLET) return primaryTrades;
        if (wallet === "0xLinked2") {
          return [
            makeTrade({
              walletAddress: "0xLinked2",
              tokenAddress: "0xPumpToken",
              tokenSymbol: "PUMP",
              type: "SELL",
              timestamp: NOW - 5_000, // 40s later
            }),
          ];
        }
        return [];
      }
    );

    mockGetClusterWallets.mockReturnValue([WALLET, "0xLinked2"]);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.clusterSyncCount).toBe(1);
  });

  it("combines offsetting + cluster for high washScore", () => {
    const washTrades = makeOffsettingPairs(5);
    const filler = makeNormalTrades(5);
    const primaryTrades = [...washTrades, ...filler];

    // Add a sync-able trade
    primaryTrades.push(
      makeTrade({
        tokenAddress: "0xSyncToken2",
        tokenSymbol: "SYN2",
        type: "BUY",
        timestamp: NOW - 20_000,
      })
    );

    mockGetTraderTrades.mockImplementation(
      (wallet: string, _chain: Chain, _since?: number) => {
        if (wallet === WALLET) return primaryTrades;
        if (wallet === "0xClusterPal") {
          return [
            makeTrade({
              walletAddress: "0xClusterPal",
              tokenAddress: "0xSyncToken2",
              tokenSymbol: "SYN2",
              type: "SELL",
              timestamp: NOW - 10_000,
            }),
            makeTrade({
              walletAddress: "0xClusterPal",
              tokenAddress: "0xWashToken",
              tokenSymbol: "WASH",
              type: "SELL",
              timestamp: washTrades[0].timestamp + 30_000,
            }),
          ];
        }
        return [];
      }
    );

    mockGetClusterWallets.mockReturnValue([WALLET, "0xClusterPal"]);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.isWashTrader).toBe(true);
    expect(result.washScore).toBeGreaterThanOrEqual(
      WASH_TRADING_THRESHOLDS.WASH_SCORE_THRESHOLD
    );
    expect(result.offsettingPairsCount).toBeGreaterThan(0);
    expect(result.clusterSyncCount).toBeGreaterThan(0);
  });

  // === Score penalty scenarios ===

  it("returns penalty 0 for washScore 0.2", () => {
    // Create scenario with low offsetting ratio
    const trades: TraderTrade[] = [];
    // 1 offsetting pair among many diverse trades
    trades.push(
      makeTrade({
        tokenAddress: "0xLow",
        type: "BUY",
        price: 1.0,
        amountUsd: 500,
        timestamp: NOW - 60_000,
      })
    );
    trades.push(
      makeTrade({
        tokenAddress: "0xLow",
        type: "SELL",
        price: 1.0,
        amountUsd: 500,
        timestamp: NOW - 0,
      })
    );
    // Add many other pairs to dilute the ratio
    for (let i = 0; i < 5; i++) {
      trades.push(
        makeTrade({
          tokenAddress: `0xOther${i}`,
          type: "BUY",
          price: 1.0 + i,
          amountUsd: 500,
          timestamp: NOW - (i + 2) * 3600_000,
        })
      );
      trades.push(
        makeTrade({
          tokenAddress: `0xOther${i}`,
          type: "SELL",
          price: 2.0 + i, // Very different price, not offsetting
          amountUsd: 500,
          timestamp: NOW - (i + 2) * 3600_000 - 7200_000, // Far apart
        })
      );
    }
    mockGetTraderTrades.mockReturnValue(trades);

    const result = analyzeWashTrading(WALLET, CHAIN);

    // 1 pair / 6 total pairs = 0.167, * 0.6 = 0.1 washScore
    expect(result.washScore).toBeLessThan(0.3);
    expect(result.scorePenalty).toBe(0);
  });

  it("returns penalty 10 for washScore around 0.4", () => {
    // 2 offsetting pairs out of 5 total pairs = ratio 0.4, * 0.6 = 0.24... need higher
    // Use 3 offsetting out of 4 total = 0.75, * 0.6 = 0.45 -> penalty 10
    const washTrades = makeOffsettingPairs(3, "0xMedWash");
    const filler = [
      makeTrade({
        tokenAddress: "0xNorm",
        type: "BUY",
        price: 5.0,
        timestamp: NOW - 7200_000,
      }),
      makeTrade({
        tokenAddress: "0xNorm",
        type: "SELL",
        price: 10.0, // 100% price diff, not wash
        timestamp: NOW - 3600_000,
      }),
      // Need 10 total trades minimum
      ...makeNormalTrades(4),
    ];
    mockGetTraderTrades.mockReturnValue([...washTrades, ...filler]);

    const result = analyzeWashTrading(WALLET, CHAIN);

    // Verify penalty is in the suspicious range
    expect(result.washScore).toBeGreaterThanOrEqual(0.3);
    expect(result.washScore).toBeLessThan(0.5);
    expect(result.scorePenalty).toBe(10);
  });

  it("returns penalty 25 for washScore around 0.6", () => {
    // 5 offsetting pairs out of 5 total = ratio 1.0, * 0.6 = 0.6 -> penalty 25
    const washTrades = makeOffsettingPairs(5);
    mockGetTraderTrades.mockReturnValue(washTrades);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.washScore).toBeGreaterThanOrEqual(0.5);
    expect(result.washScore).toBeLessThan(0.7);
    expect(result.scorePenalty).toBe(25);
  });

  it("returns penalty 50 for washScore >= 0.7", () => {
    // High offsetting + heavy cluster coordination to push score above 0.7
    const washTrades = makeOffsettingPairs(6);
    const primaryTrades = [
      ...washTrades,
      makeTrade({
        tokenAddress: "0xSync",
        type: "BUY",
        timestamp: NOW - 5_000,
      }),
    ];

    // Need many cluster syncs to push clusterRatio high
    // totalClusterTrades = primaryTrades.length = 13
    // Need enough syncs so (syncs/13)*0.4 + 0.6 >= 0.7, meaning syncs/13 >= 0.25, syncs >= 4
    const linkedSyncs: TraderTrade[] = [];
    for (let i = 0; i < 6; i++) {
      linkedSyncs.push(
        makeTrade({
          walletAddress: "0xHighCluster",
          tokenAddress: "0xWashToken",
          tokenSymbol: "WASH",
          type: i % 2 === 0 ? "SELL" : "BUY",
          timestamp: washTrades[i * 2].timestamp + 15_000,
        })
      );
    }
    linkedSyncs.push(
      makeTrade({
        walletAddress: "0xHighCluster",
        tokenAddress: "0xSync",
        type: "SELL",
        timestamp: NOW - 3_000,
      })
    );

    mockGetTraderTrades.mockImplementation(
      (wallet: string, _chain: Chain, _since?: number) => {
        if (wallet === WALLET) return primaryTrades;
        if (wallet === "0xHighCluster") return linkedSyncs;
        return [];
      }
    );

    mockGetClusterWallets.mockReturnValue([WALLET, "0xHighCluster"]);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.washScore).toBeGreaterThanOrEqual(0.7);
    expect(result.scorePenalty).toBe(50);
  });

  // === Suspicious patterns output ===

  it("includes human-readable pattern descriptions", () => {
    const washTrades = makeOffsettingPairs(3);
    const filler = makeNormalTrades(4);
    mockGetTraderTrades.mockReturnValue([...washTrades, ...filler]);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.suspiciousPatterns.length).toBeGreaterThanOrEqual(3);
    for (const pattern of result.suspiciousPatterns) {
      expect(pattern).toMatch(/BUY\/SELL .+ within \d+s at similar price/);
    }
  });

  it("reports correct totalTradesAnalyzed count", () => {
    const trades = makeNormalTrades(20);
    mockGetTraderTrades.mockReturnValue(trades);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.totalTradesAnalyzed).toBe(20);
  });

  // === Edge cases ===

  it("handles empty cluster wallets gracefully", () => {
    mockGetTraderTrades.mockReturnValue(makeNormalTrades(12));
    mockGetClusterWallets.mockReturnValue([]);

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.clusterSyncCount).toBe(0);
    expect(result.isWashTrader).toBe(false);
  });

  it("returns clean for exactly 10 trades with no wash patterns", () => {
    mockGetTraderTrades.mockReturnValue(makeNormalTrades(10));

    const result = analyzeWashTrading(WALLET, CHAIN);

    expect(result.totalTradesAnalyzed).toBe(10);
    expect(result.isWashTrader).toBe(false);
  });
});
