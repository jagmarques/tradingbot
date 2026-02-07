import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  collectOnchainSignals,
  clearOnchainCache,
} from "./onchain.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("Token Onchain Collectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOnchainCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Birdeye (Solana)", () => {
    it("should parse Birdeye response for Solana token", async () => {
      const tokenAddress = "SoLaNaTokenAddress123456789ABCDEFGHIJK";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              holder: 1500,
              v24hUSD: 250000,
              liquidity: 80000,
              mc: 5000000,
              priceChange24hPercent: 12.5,
              top10HolderPercent: 45.2,
            },
          }),
      });

      const result = await collectOnchainSignals(tokenAddress, "solana");

      expect(result).not.toBeNull();
      expect(result!.holderCount).toBe(1500);
      expect(result!.whalePercentage).toBe(45.2);
      expect(result!.liquidityUsd).toBe(80000);
      expect(result!.volume24hUsd).toBe(250000);
      expect(result!.priceChangePercent24h).toBe(12.5);
      expect(result!.marketCapUsd).toBe(5000000);
      expect(result!.provider).toBe("birdeye");
    });

    it("should handle partial data with missing fields", async () => {
      const tokenAddress = "PartialDataToken123456789ABCDEFGHIJKLM";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              v24hUSD: 100000,
              mc: 2000000,
              // Missing: holder, liquidity, priceChange24hPercent, top10HolderPercent
            },
          }),
      });

      const result = await collectOnchainSignals(tokenAddress, "solana");

      expect(result).not.toBeNull();
      expect(result!.holderCount).toBe(0);
      expect(result!.whalePercentage).toBe(0);
      expect(result!.liquidityUsd).toBe(0);
      expect(result!.volume24hUsd).toBe(100000);
      expect(result!.priceChangePercent24h).toBe(0);
      expect(result!.marketCapUsd).toBe(2000000);
      expect(result!.provider).toBe("birdeye");
    });
  });

  describe("CoinGecko (EVM chains)", () => {
    it("should parse CoinGecko response for EVM token", async () => {
      const tokenAddress = "0xabcdef1234567890abcdef1234567890abcdef12";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            market_data: {
              total_volume: { usd: 500000 },
              market_cap: { usd: 10000000 },
              price_change_percentage_24h: -3.7,
            },
          }),
      });

      const result = await collectOnchainSignals(tokenAddress, "base");

      expect(result).not.toBeNull();
      expect(result!.volume24hUsd).toBe(500000);
      expect(result!.marketCapUsd).toBe(10000000);
      expect(result!.priceChangePercent24h).toBe(-3.7);
      expect(result!.liquidityUsd).toBe(50000); // volume * 0.1
      expect(result!.holderCount).toBe(0); // CoinGecko limitation
      expect(result!.whalePercentage).toBe(0); // CoinGecko limitation
      expect(result!.provider).toBe("coingecko");
    });
  });

  describe("Error handling", () => {
    it("should return null on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await collectOnchainSignals(
        "0xfailed0000000000000000000000000000000001",
        "base",
      );

      expect(result).toBeNull();
    });

    it("should return null on non-ok HTTP response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
      });

      const result = await collectOnchainSignals(
        "RateLimitedTokenAddr123456789ABCDEFGHIJK",
        "solana",
      );

      expect(result).toBeNull();
    });
  });

  describe("Caching", () => {
    it("should return cached result on second call", async () => {
      const tokenAddress = "CachedTokenAddr1234567890ABCDEFGHIJKLM";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              holder: 500,
              v24hUSD: 50000,
              liquidity: 20000,
              mc: 1000000,
              priceChange24hPercent: 5.0,
            },
          }),
      });

      // First call - hits API
      const result1 = await collectOnchainSignals(tokenAddress, "solana");
      expect(result1).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call - should hit cache
      const result2 = await collectOnchainSignals(tokenAddress, "solana");
      expect(result2).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, cache hit

      expect(result1).toEqual(result2);
    });
  });

  describe("Chain routing", () => {
    it("should route solana to Birdeye URL", async () => {
      const tokenAddress = "SolRouteTest12345678901234567890ABCDEF";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              holder: 100,
              v24hUSD: 10000,
              liquidity: 5000,
              mc: 500000,
            },
          }),
      });

      await collectOnchainSignals(tokenAddress, "solana");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("public-api.birdeye.so/defi/token_overview"),
        expect.any(Object),
      );
    });

    it("should route base to CoinGecko URL with base platform", async () => {
      const tokenAddress = "0xbase000000000000000000000000000000000001";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            market_data: {
              total_volume: { usd: 1000 },
              market_cap: { usd: 50000 },
              price_change_percentage_24h: 0,
            },
          }),
      });

      await collectOnchainSignals(tokenAddress, "base");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api.coingecko.com/api/v3/coins/base/contract"),
        expect.any(Object),
      );
    });
  });
});
