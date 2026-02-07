import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  collectSecuritySignals,
  clearSecurityCache,
} from "./security.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("Token Security Collectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSecurityCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GoPlusLabs (EVM chains)", () => {
    it("should parse GoPlusLabs response for safe token", async () => {
      const tokenAddress = "0xabcdef1234567890abcdef1234567890abcdef12";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              [tokenAddress.toLowerCase()]: {
                is_honeypot: "0",
                is_open_source: "1",
                is_proxy: "0",
                is_mintable: "0",
                owner_change_balance: "0",
                buy_tax: "0.05",
                sell_tax: "0.03",
                external_call: "0",
                selfdestruct: "0",
                is_blacklisted: "0",
              },
            },
          }),
      });

      const result = await collectSecuritySignals(tokenAddress, "base");

      expect(result).not.toBeNull();
      expect(result!.isHoneypot).toBe(false);
      expect(result!.hasScamFlags).toBe(false);
      expect(result!.isOpenSource).toBe(true);
      expect(result!.hasProxy).toBe(false);
      expect(result!.hasMintFunction).toBe(false);
      expect(result!.ownerCanChangeBalance).toBe(false);
      expect(result!.buyTax).toBe(0.05);
      expect(result!.sellTax).toBe(0.03);
      expect(result!.riskScore).toBe(0); // safe token
      expect(result!.provider).toBe("goplus");
    });

    it("should detect honeypot with riskScore >= 30", async () => {
      const tokenAddress = "0xhoneypot000000000000000000000000deadbeef";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              [tokenAddress.toLowerCase()]: {
                is_honeypot: "1",
                is_open_source: "0",
                is_proxy: "1",
                is_mintable: "1",
                owner_change_balance: "1",
                buy_tax: "0.50",
                sell_tax: "0.90",
                external_call: "1",
                selfdestruct: "0",
                is_blacklisted: "0",
              },
            },
          }),
      });

      const result = await collectSecuritySignals(tokenAddress, "ethereum");

      expect(result).not.toBeNull();
      expect(result!.isHoneypot).toBe(true);
      expect(result!.hasScamFlags).toBe(true);
      expect(result!.riskScore).toBeGreaterThanOrEqual(30);
      expect(result!.provider).toBe("goplus");
    });

    it("should route base chain to GoPlusLabs with correct chainId", async () => {
      const tokenAddress = "0xbase000000000000000000000000000000000001";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              [tokenAddress.toLowerCase()]: {
                is_honeypot: "0",
                is_open_source: "1",
                is_proxy: "0",
                is_mintable: "0",
                owner_change_balance: "0",
                buy_tax: "0",
                sell_tax: "0",
                external_call: "0",
                selfdestruct: "0",
                is_blacklisted: "0",
              },
            },
          }),
      });

      await collectSecuritySignals(tokenAddress, "base");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(
          "api.gopluslabs.com/api/v1/token_security/8453",
        ),
        expect.any(Object),
      );
    });
  });

  describe("RugCheck (Solana)", () => {
    it("should parse RugCheck response for Solana token", async () => {
      const tokenAddress = "SoLaNaTokenAddress123456789ABCDEFGHIJK";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            score: 800,
            risks: [
              {
                name: "Low liquidity",
                level: "warn",
                description: "Liquidity is below threshold",
              },
            ],
          }),
      });

      const result = await collectSecuritySignals(tokenAddress, "solana");

      expect(result).not.toBeNull();
      expect(result!.isHoneypot).toBe(false);
      expect(result!.hasScamFlags).toBe(false);
      expect(result!.isOpenSource).toBe(true); // Solana programs are on-chain
      expect(result!.hasProxy).toBe(false);
      expect(result!.riskScore).toBe(20); // 100 - (800/10) = 20
      expect(result!.provider).toBe("rugcheck");
    });

    it("should route solana chain to RugCheck URL", async () => {
      const tokenAddress = "SoLaNaTokenAddress123456789ABCDEFGHIJK";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            score: 900,
            risks: [],
          }),
      });

      await collectSecuritySignals(tokenAddress, "solana");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(
          `api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`,
        ),
        expect.any(Object),
      );
    });

    it("should flag danger risks as scam flags", async () => {
      const tokenAddress = "DangerTokenAddress123456789ABCDEFGHIJK";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            score: 200,
            risks: [
              {
                name: "Mint Authority still enabled",
                level: "danger",
                description: "Token can be minted",
              },
              {
                name: "Freeze Authority still enabled",
                level: "danger",
                description: "Token can be frozen",
              },
              {
                name: "Low holder count",
                level: "warn",
              },
            ],
          }),
      });

      const result = await collectSecuritySignals(tokenAddress, "solana");

      expect(result).not.toBeNull();
      expect(result!.hasScamFlags).toBe(true);
      expect(result!.hasMintFunction).toBe(true);
      expect(result!.ownerCanChangeBalance).toBe(true);
      expect(result!.riskScore).toBe(80); // 100 - (200/10) = 80
    });
  });

  describe("Error handling", () => {
    it("should return null on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await collectSecuritySignals(
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

      const result = await collectSecuritySignals(
        "0xratelimited000000000000000000000000000001",
        "ethereum",
      );

      expect(result).toBeNull();
    });
  });

  describe("Caching", () => {
    it("should return cached result on second call", async () => {
      const tokenAddress = "0xcached00000000000000000000000000000cache1";
      const mockResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              [tokenAddress.toLowerCase()]: {
                is_honeypot: "0",
                is_open_source: "1",
                is_proxy: "0",
                is_mintable: "0",
                owner_change_balance: "0",
                buy_tax: "0",
                sell_tax: "0",
                external_call: "0",
                selfdestruct: "0",
                is_blacklisted: "0",
              },
            },
          }),
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      // First call - hits API
      const result1 = await collectSecuritySignals(tokenAddress, "base");
      expect(result1).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call - should hit cache
      const result2 = await collectSecuritySignals(tokenAddress, "base");
      expect(result2).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, cache hit

      expect(result1).toEqual(result2);
    });
  });
});
