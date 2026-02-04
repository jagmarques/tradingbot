import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TokenLaunch } from "./detector.js";

vi.mock("../solana/wallet.js", () => ({
  loadKeypair: vi.fn((): { publicKey: { toBase58: () => string } } => ({
    publicKey: { toBase58: (): string => "test-pubkey" },
  })),
  hasMinimumSolReserve: vi.fn().mockResolvedValue(true),
}));

vi.mock("../solana/jito.js", () => ({
  createAndSubmitBundledTransaction: vi.fn().mockResolvedValue("bundle-123"),
  waitForBundleConfirmation: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../config/env.js", () => ({
  isPaperMode: vi.fn().mockReturnValue(true),
  loadEnv: vi.fn(() => ({
    DAILY_LOSS_LIMIT_USD: 25,
    MIN_SOL_RESERVE: 0.5,
    MAX_SLIPPAGE_PUMPFUN: 0.01,
  })),
}));

vi.mock("../database/trades.js", () => ({
  insertTrade: vi.fn().mockResolvedValue({}),
}));

vi.mock("../risk/manager.js", () => ({
  validateTrade: vi.fn().mockResolvedValue({ allowed: true }),
  getDailyPnlPercentage: vi.fn().mockReturnValue(0),
}));

vi.mock("../database/pumpfun-positions.js", () => ({
  savePosition: vi.fn(),
  deletePosition: vi.fn(),
  loadAllPositions: vi.fn().mockReturnValue([]),
}));

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
  return {
    ...actual,
    PublicKey: class MockPublicKey {
      static findProgramAddressSync(): [{ toBuffer: () => Buffer }, number] {
        return [{ toBuffer: (): Buffer => Buffer.alloc(32) }, 255];
      }
      toBuffer(): Buffer {
        return Buffer.alloc(32);
      }
    },
  };
});

describe("Pump.fun Executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("executeSplitBuy", () => {
    it("should execute phase 1 buy in paper mode", async () => {
      const { executeSplitBuy } = await import("./executor.js");

      const launch: TokenLaunch = {
        mint: "test-mint",
        name: "Test Token",
        symbol: "TEST",
        uri: "https://example.com",
        creator: "creator",
        timestamp: Date.now(),
        signature: "sig",
      };

      // Should not throw
      await executeSplitBuy(launch, 0.05);
    });
  });

  describe("getPositions", () => {
    it("should return empty map initially", async () => {
      const { getPositions } = await import("./executor.js");
      const positions = getPositions();
      expect(positions).toBeInstanceOf(Map);
    });
  });

  describe("getPosition", () => {
    it("should return undefined for non-existent position", async () => {
      const { getPosition } = await import("./executor.js");
      const position = getPosition("non-existent");
      expect(position).toBeUndefined();
    });
  });

  describe("checkAutoSell", () => {
    it("should not throw for non-existent position", async () => {
      const { checkAutoSell } = await import("./executor.js");
      // Should not throw
      await checkAutoSell("non-existent", 100);
    });
  });

  describe("closePosition", () => {
    it("should return error for non-existent position", async () => {
      const { closePosition } = await import("./executor.js");
      const result = await closePosition("non-existent");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Position not found");
    });
  });
});
