import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TokenLaunch } from "./detector.js";

vi.mock("../solana/wallet.js", () => ({
  getConnection: vi.fn(() => ({
    getBalance: vi.fn().mockResolvedValue(2_000_000_000), // 2 SOL
    getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] }),
    getParsedAccountInfo: vi.fn().mockResolvedValue({
      value: { data: { parsed: { info: { supply: "1000000000000" } } } },
    }),
    getSignaturesForAddress: vi.fn().mockResolvedValue([
      { signature: "sig1" },
      { signature: "sig2" },
      { signature: "sig3" },
      { signature: "sig4" },
      { signature: "sig5" },
    ]),
    getParsedTransaction: vi.fn().mockResolvedValue({
      transaction: {
        message: {
          accountKeys: [{ pubkey: { toBase58: (): string => "other-program" } }],
        },
      },
    }),
  })),
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

describe("Pump.fun Filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkMetadata", () => {
    it("should pass for valid metadata", async () => {
      const { checkMetadata } = await import("./filters.js");

      const launch: TokenLaunch = {
        mint: "mint123",
        name: "Good Token",
        symbol: "GOOD",
        uri: "https://example.com/metadata.json",
        creator: "creator123",
        timestamp: Date.now(),
        signature: "sig123",
      };

      const result = checkMetadata(launch);
      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
    });

    it("should fail for suspicious names", async () => {
      const { checkMetadata } = await import("./filters.js");

      const launch: TokenLaunch = {
        mint: "mint123",
        name: "SCAM Token",
        symbol: "RUG",
        uri: "https://example.com/metadata.json",
        creator: "creator123",
        timestamp: Date.now(),
        signature: "sig123",
      };

      const result = checkMetadata(launch);
      expect(result.passed).toBe(false);
      expect(result.score).toBeLessThan(100);
    });

    it("should fail for empty name", async () => {
      const { checkMetadata } = await import("./filters.js");

      const launch: TokenLaunch = {
        mint: "mint123",
        name: "",
        symbol: "TEST",
        uri: "https://example.com/metadata.json",
        creator: "creator123",
        timestamp: Date.now(),
        signature: "sig123",
      };

      const result = checkMetadata(launch);
      expect(result.passed).toBe(false);
    });

    it("should fail for invalid URI", async () => {
      const { checkMetadata } = await import("./filters.js");

      const launch: TokenLaunch = {
        mint: "mint123",
        name: "Token",
        symbol: "TKN",
        uri: "invalid-uri",
        creator: "creator123",
        timestamp: Date.now(),
        signature: "sig123",
      };

      const result = checkMetadata(launch);
      expect(result.passed).toBe(false);
    });
  });

  describe("analyzeToken", () => {
    it("should return analysis with recommendation", async () => {
      vi.resetModules();
      const { analyzeToken } = await import("./filters.js");

      const launch: TokenLaunch = {
        mint: "mint123",
        name: "Good Token",
        symbol: "GOOD",
        uri: "https://example.com/metadata.json",
        creator: "creator123",
        timestamp: Date.now(),
        signature: "sig123",
      };

      const analysis = await analyzeToken(launch);

      expect(analysis.launch).toBe(launch);
      expect(analysis.filters).toBeDefined();
      expect(analysis.overallScore).toBeGreaterThanOrEqual(0);
      expect(analysis.overallScore).toBeLessThanOrEqual(100);
      expect(["BUY", "SKIP", "CAUTION"]).toContain(analysis.recommendation);
    });
  });
});
