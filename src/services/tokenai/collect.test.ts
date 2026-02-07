import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the collector modules and database
vi.mock("./security.js", () => ({
  collectSecuritySignals: vi.fn(),
}));
vi.mock("./onchain.js", () => ({
  collectOnchainSignals: vi.fn(),
}));
vi.mock("./social.js", () => ({
  collectSocialSignals: vi.fn(),
}));
vi.mock("../database/tokenai.js", () => ({
  saveTokenSignals: vi.fn(),
}));

import { collectAllSignals } from "./collect.js";
import { collectSecuritySignals } from "./security.js";
import { collectOnchainSignals } from "./onchain.js";
import { collectSocialSignals } from "./social.js";
import { saveTokenSignals } from "../database/tokenai.js";

const mockSecurity = collectSecuritySignals as unknown as ReturnType<
  typeof vi.fn
>;
const mockOnchain = collectOnchainSignals as unknown as ReturnType<
  typeof vi.fn
>;
const mockSocial = collectSocialSignals as unknown as ReturnType<
  typeof vi.fn
>;
const mockSaveSignals = saveTokenSignals as unknown as ReturnType<
  typeof vi.fn
>;

describe("Token Signal Orchestrator (collectAllSignals)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should collect all signals in parallel and save to DB", async () => {
    const securityData = {
      isHoneypot: false,
      riskScore: 10,
      provider: "goplus",
    };
    const onchainData = {
      holderCount: 1000,
      liquidityUsd: 50000,
      provider: "birdeye",
    };
    const socialData = {
      tweetCount24h: 20,
      sentiment: "bullish",
      provider: "twitter",
    };

    mockSecurity.mockResolvedValueOnce(securityData);
    mockOnchain.mockResolvedValueOnce(onchainData);
    mockSocial.mockResolvedValueOnce(socialData);

    const result = await collectAllSignals("0xtoken123", "base", "TEST");

    expect(result.security).toEqual(securityData);
    expect(result.onchain).toEqual(onchainData);
    expect(result.social).toEqual(socialData);
    expect(result.tokenAddress).toBe("0xtoken123");
    expect(result.chain).toBe("base");
    expect(result.collectedAt).toBeTruthy();

    // saveTokenSignals called with 3 signal records
    expect(mockSaveSignals).toHaveBeenCalledTimes(1);
    const savedSignals = mockSaveSignals.mock.calls[0][0];
    expect(savedSignals).toHaveLength(3);
    expect(
      savedSignals.map((s: { signalType: string }) => s.signalType),
    ).toEqual(["security", "onchain", "social"]);
  });

  it("should handle partial failure (security null)", async () => {
    mockSecurity.mockResolvedValueOnce(null);
    mockOnchain.mockResolvedValueOnce({
      holderCount: 500,
      provider: "birdeye",
    });
    mockSocial.mockResolvedValueOnce({
      tweetCount24h: 5,
      sentiment: "neutral",
      provider: "google-news",
    });

    const result = await collectAllSignals("0xpartial123", "ethereum");

    expect(result.security).toBeNull();
    expect(result.onchain).not.toBeNull();
    expect(result.social).not.toBeNull();

    // saveTokenSignals called with 2 signal records (skips null security)
    expect(mockSaveSignals).toHaveBeenCalledTimes(1);
    const savedSignals = mockSaveSignals.mock.calls[0][0];
    expect(savedSignals).toHaveLength(2);
    expect(
      savedSignals.map((s: { signalType: string }) => s.signalType),
    ).toEqual(["onchain", "social"]);
  });
});
