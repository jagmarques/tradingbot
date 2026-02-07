import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  discoverTraders,
  runDiscoveryAll,
  DISCOVERY_CONFIG,
  DiscoveryResult,
} from "./discovery.js";

// Mock storage
vi.mock("./storage.js", () => ({
  upsertTrader: vi.fn(),
  getTrader: vi.fn(),
}));

// Mock etherscan (required by existing code in discovery.ts)
vi.mock("./etherscan.js", () => ({
  isEtherscanConfigured: vi.fn().mockReturnValue(false),
  discoverTradersFromTokens: vi.fn(),
  initProfitabilityCache: vi.fn(),
  cleanupCache: vi.fn(),
}));

// Mock dexscreener
vi.mock("./dexscreener.js", () => ({
  getAllActiveTokens: vi.fn().mockResolvedValue([]),
}));

// Mock helius
vi.mock("./helius.js", () => ({
  isHeliusConfigured: vi.fn().mockReturnValue(false),
  analyzeWalletPnl: vi.fn(),
  getRecentPumpfunTokens: vi.fn().mockResolvedValue([]),
  findEarlyBuyers: vi.fn().mockResolvedValue([]),
}));

import { upsertTrader, getTrader } from "./storage.js";

const mockUpsertTrader = upsertTrader as ReturnType<typeof vi.fn>;
const mockGetTrader = getTrader as ReturnType<typeof vi.fn>;

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Realistic Birdeye API response
function makeBirdeyeResponse(
  items: Array<{
    owner: string;
    trade_count: number;
    total_pnl: number;
    volume: number;
    win_rate?: number;
  }>,
) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        success: true,
        data: { items },
      }),
  };
}

describe("Birdeye Trader Discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTrader.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("discoverSolanaTraders via discoverTraders('solana')", () => {
    it("should discover and add qualifying wallets", async () => {
      // 5 wallets, 3 qualify (trades >= 20, pnl >= 1000), 2 below threshold
      const qualifiedWallets = [
        { owner: "wallet1_qualified_aaaa", trade_count: 50, total_pnl: 5000, volume: 100000, win_rate: 0.7 },
        { owner: "wallet2_qualified_bbbb", trade_count: 30, total_pnl: 2000, volume: 50000, win_rate: 0.6 },
        { owner: "wallet3_qualified_cccc", trade_count: 25, total_pnl: 1500, volume: 30000, win_rate: 0.65 },
      ];
      const belowThreshold = [
        { owner: "wallet4_low_trades_dd", trade_count: 5, total_pnl: 500, volume: 10000, win_rate: 0.8 },
        { owner: "wallet5_low_pnl_eeee", trade_count: 25, total_pnl: 100, volume: 5000, win_rate: 0.5 },
      ];

      // SOL token response
      mockFetch.mockResolvedValueOnce(
        makeBirdeyeResponse([...qualifiedWallets, ...belowThreshold]),
      );
      // USDC token response (empty)
      mockFetch.mockResolvedValueOnce(makeBirdeyeResponse([]));

      const result = await discoverTraders("solana");

      expect(result.chain).toBe("solana");
      expect(result.discovered).toBe(5);
      expect(result.qualified).toBe(3);
      expect(result.added).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(mockUpsertTrader).toHaveBeenCalledTimes(3);
    });

    it("should skip wallets below MIN_TOTAL_TRADES", async () => {
      mockFetch.mockResolvedValueOnce(
        makeBirdeyeResponse([
          { owner: "low_trades_wallet_aaa", trade_count: 5, total_pnl: 5000, volume: 10000, win_rate: 0.9 },
          { owner: "low_trades_wallet_bbb", trade_count: 10, total_pnl: 3000, volume: 8000, win_rate: 0.8 },
        ]),
      );
      mockFetch.mockResolvedValueOnce(makeBirdeyeResponse([]));

      const result = await discoverTraders("solana");

      expect(result.qualified).toBe(0);
      expect(result.added).toBe(0);
      expect(mockUpsertTrader).not.toHaveBeenCalled();
    });

    it("should handle Birdeye API 500 error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });

      const result = await discoverTraders("solana");

      expect(result.discovered).toBe(0);
      expect(result.qualified).toBe(0);
      expect(result.added).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("500");
    });

    it("should handle Birdeye API timeout", async () => {
      mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));
      mockFetch.mockResolvedValueOnce(makeBirdeyeResponse([]));

      const result = await discoverTraders("solana");

      expect(result.discovered).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("timeout");
    });

    it("should handle empty Birdeye response gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { items: [] } }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: {} }),
      });

      const result = await discoverTraders("solana");

      expect(result.discovered).toBe(0);
      expect(result.qualified).toBe(0);
      expect(result.added).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should skip already tracked wallets", async () => {
      mockFetch.mockResolvedValueOnce(
        makeBirdeyeResponse([
          { owner: "already_tracked_wallet", trade_count: 30, total_pnl: 5000, volume: 80000, win_rate: 0.7 },
          { owner: "new_wallet_to_add_abc", trade_count: 25, total_pnl: 2000, volume: 50000, win_rate: 0.65 },
        ]),
      );
      mockFetch.mockResolvedValueOnce(makeBirdeyeResponse([]));

      // First wallet already tracked
      mockGetTrader.mockImplementation((address: string) => {
        if (address === "already_tracked_wallet") {
          return { address, chain: "solana", score: 80 };
        }
        return null;
      });

      const result = await discoverTraders("solana");

      expect(result.qualified).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.added).toBe(1);
      expect(mockUpsertTrader).toHaveBeenCalledTimes(1);
    });

    it("should call upsertTrader with correct initial score for qualifying wallets", async () => {
      mockFetch.mockResolvedValueOnce(
        makeBirdeyeResponse([
          { owner: "score_test_wallet_abc", trade_count: 40, total_pnl: 3000, volume: 100000, win_rate: 0.75 },
        ]),
      );
      mockFetch.mockResolvedValueOnce(makeBirdeyeResponse([]));

      await discoverTraders("solana");

      expect(mockUpsertTrader).toHaveBeenCalledTimes(1);

      const call = mockUpsertTrader.mock.calls[0][0];
      expect(call.address).toBe("score_test_wallet_abc");
      expect(call.chain).toBe("solana");
      expect(call.totalTrades).toBe(40);
      expect(call.totalPnlUsd).toBe(3000);
      expect(call.winRate).toBe(75); // 0.75 * 100
      expect(call.winningTrades).toBe(30); // round(40 * 0.75)
      expect(call.losingTrades).toBe(10); // 40 - 30
      expect(call.score).toBeGreaterThan(0);
      expect(call.score).toBeLessThanOrEqual(100);
      expect(call.discoveredAt).toBeGreaterThan(0);
      expect(call.updatedAt).toBeGreaterThan(0);
    });

    it("should respect MAX_NEW_TRADERS_PER_RUN limit", async () => {
      // Create 15 qualifying wallets
      const manyWallets = Array.from({ length: 15 }, (_, i) => ({
        owner: `bulk_wallet_${String(i).padStart(8, "0")}`,
        trade_count: 50,
        total_pnl: 5000,
        volume: 100000,
        win_rate: 0.7,
      }));

      mockFetch.mockResolvedValueOnce(makeBirdeyeResponse(manyWallets));
      mockFetch.mockResolvedValueOnce(makeBirdeyeResponse([]));

      const result = await discoverTraders("solana");

      expect(result.qualified).toBe(15);
      expect(result.added).toBe(DISCOVERY_CONFIG.MAX_NEW_TRADERS_PER_RUN);
      expect(mockUpsertTrader).toHaveBeenCalledTimes(DISCOVERY_CONFIG.MAX_NEW_TRADERS_PER_RUN);
    });
  });

  describe("discoverEvmTraders via discoverTraders(evm chain)", () => {
    it("should return stub result for EVM chains", async () => {
      const result = await discoverTraders("ethereum");

      expect(result.chain).toBe("ethereum");
      expect(result.discovered).toBe(0);
      expect(result.added).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("not yet implemented");
      expect(result.errors[0]).toContain("ethereum");
    });

    it("should return stub for any EVM chain", async () => {
      const result = await discoverTraders("base");

      expect(result.chain).toBe("base");
      expect(result.discovered).toBe(0);
      expect(result.qualified).toBe(0);
      expect(result.added).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe("discoverTraders routing", () => {
    it("should route solana to Solana discovery", async () => {
      mockFetch.mockResolvedValue(makeBirdeyeResponse([]));

      const result = await discoverTraders("solana");

      expect(result.chain).toBe("solana");
      // Verify fetch was called (Birdeye API)
      expect(mockFetch).toHaveBeenCalled();
    });

    it("should route EVM chains to EVM discovery stub", async () => {
      const result = await discoverTraders("polygon");

      expect(result.chain).toBe("polygon");
      expect(result.errors[0]).toContain("not yet implemented");
      // No fetch calls for EVM stub
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("runDiscoveryAll", () => {
    it("should run Solana discovery and return results array", async () => {
      mockFetch.mockResolvedValue(makeBirdeyeResponse([]));

      const results = await runDiscoveryAll();

      expect(results).toHaveLength(1);
      expect(results[0].chain).toBe("solana");
    });

    it("should log summary of discovery", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      mockFetch.mockResolvedValue(makeBirdeyeResponse([]));

      await runDiscoveryAll();

      const summaryLog = consoleSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("Discovered"),
      );
      expect(summaryLog).toBeDefined();

      consoleSpy.mockRestore();
    });
  });
});
