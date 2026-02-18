import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BetDecision, PolymarketEvent } from "./types.js";

// Mock all external deps before importing
vi.mock("../../config/env.js", () => ({
  isPaperMode: vi.fn(() => true),
}));

vi.mock("../polygon/polymarket.js", () => ({
  placeFokOrder: vi.fn(),
  getOrderbook: vi.fn(),
}));

vi.mock("../database/aibetting.js", () => ({
  savePosition: vi.fn(),
  loadOpenPositions: vi.fn(() => []),
  recordOutcome: vi.fn(),
}));

vi.mock("../telegram/notifications.js", () => ({
  notifyAIBetPlaced: vi.fn().mockResolvedValue(undefined),
  notifyAIBetClosed: vi.fn().mockResolvedValue(undefined),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  enterPosition,
  resolvePosition,
  checkMarketResolution,
  getCurrentPrice,
} from "./executor.js";

function makeDecision(overrides: Partial<BetDecision> = {}): BetDecision {
  return {
    shouldBet: true,
    marketId: "market-1",
    tokenId: "token-yes",
    side: "YES",
    marketPrice: 0.5,
    aiProbability: 0.7,
    confidence: 0.8,
    edge: 0.2,
    expectedValue: 0.2,
    recommendedSize: 10,
    reason: "Edge 20%",
    ...overrides,
  };
}

function makeMarket(overrides: Partial<PolymarketEvent> = {}): PolymarketEvent {
  return {
    conditionId: "market-1",
    questionId: "q-1",
    slug: "test-market",
    title: "Test Market",
    description: "A test market",
    category: "politics",
    endDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    volume24h: 50000,
    liquidity: 10000,
    outcomes: [
      { tokenId: "token-yes", name: "Yes", price: 0.5 },
      { tokenId: "token-no", name: "No", price: 0.5 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: midpoint returns 0.50
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ mid: "0.50" }),
  });
});

describe("enterPosition (paper mode)", () => {
  it("should create position using midpoint price", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ mid: "0.55" }),
    });

    const position = await enterPosition(makeDecision(), makeMarket());

    expect(position).not.toBeNull();
    expect(position?.entryPrice).toBe(0.55);
    expect(position?.side).toBe("YES");
    expect(position?.size).toBe(10);
    expect(position?.status).toBe("open");
  });

  it("should fall back to scanner price when midpoint unavailable", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    const position = await enterPosition(
      makeDecision({ marketId: "fallback-test", tokenId: "token-fallback", marketPrice: 0.45 }),
      makeMarket({ conditionId: "fallback-test" })
    );

    expect(position).not.toBeNull();
    expect(position?.entryPrice).toBe(0.45); // Falls back to marketPrice for YES
  });

  it("should not open duplicate position in same market", async () => {
    // First position already created in "market-1" from first test
    // Try to create another one in same market
    const duplicate = await enterPosition(makeDecision(), makeMarket());
    expect(duplicate).toBeNull();
  });
});

describe("resolvePosition", () => {
  it("should calculate WON P&L when finalPrice is 1.0", async () => {
    // Enter a position first
    const position = await enterPosition(
      makeDecision({ marketId: "resolve-win", tokenId: "token-resolve-win", recommendedSize: 10 }),
      makeMarket({ conditionId: "resolve-win" })
    );
    expect(position).not.toBeNull();

    // Resolve as WON (finalPrice = 1.0)
    mockFetch.mockClear();
    if (!position) throw new Error("position should not be null");
    const { success, pnl } = await resolvePosition(position, 1.0);

    expect(success).toBe(true);
    // shares = 10 / 0.50 = 20, pnl = (20 * 1.0) - 10 = 10.0 (minus small fees)
    expect(pnl).toBeGreaterThan(9.5);
    expect(pnl).toBeLessThan(10.5);
    expect(position?.status).toBe("closed");
    expect(position?.exitReason).toContain("WON");
  });

  it("should calculate LOST P&L when finalPrice is 0.0", async () => {
    const position = await enterPosition(
      makeDecision({ marketId: "resolve-loss", tokenId: "token-resolve-loss", recommendedSize: 10 }),
      makeMarket({ conditionId: "resolve-loss" })
    );
    expect(position).not.toBeNull();

    if (!position) throw new Error("position should not be null");
    const { success, pnl } = await resolvePosition(position, 0.0);

    expect(success).toBe(true);
    // shares = 10 / 0.50 = 20, pnl = (20 * 0.0) - 10 = -10.0 (minus fees)
    expect(pnl).toBeLessThan(-9.5);
    expect(position?.status).toBe("closed");
    expect(position?.exitReason).toContain("LOST");
  });
});

describe("checkMarketResolution", () => {
  it("should detect resolved market", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{
        closed: true,
        clobTokenIds: JSON.stringify(["token-yes", "token-no"]),
        outcomePrices: JSON.stringify(["1.0", "0.0"]),
      }]),
    });

    const result = await checkMarketResolution("token-yes");
    expect(result.resolved).toBe(true);
    expect(result.finalPrice).toBe(1.0);
  });

  it("should return not resolved for open market", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{
        closed: false,
        clobTokenIds: JSON.stringify(["token-yes", "token-no"]),
        outcomePrices: JSON.stringify(["0.5", "0.5"]),
      }]),
    });

    const result = await checkMarketResolution("token-yes");
    expect(result.resolved).toBe(false);
  });

  it("should handle API errors gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await checkMarketResolution("token-yes");
    expect(result.resolved).toBe(false);
    expect(result.finalPrice).toBeNull();
  });

  it("should return correct price for NO token", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{
        closed: true,
        clobTokenIds: JSON.stringify(["token-yes", "token-no"]),
        outcomePrices: JSON.stringify(["1.0", "0.0"]),
      }]),
    });

    const result = await checkMarketResolution("token-no");
    expect(result.resolved).toBe(true);
    expect(result.finalPrice).toBe(0.0); // NO lost
  });
});

describe("getCurrentPrice", () => {
  it("should return midpoint price when available", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ mid: "0.65" }),
    });

    const price = await getCurrentPrice("token-test");
    expect(price).toBe(0.65);
  });

  it("should fall back to orderbook when midpoint unavailable", async () => {
    // Midpoint fails
    mockFetch.mockResolvedValueOnce({ ok: false });

    // Mock getOrderbook via polymarket module
    const { getOrderbook } = await import("../polygon/polymarket.js");
    vi.mocked(getOrderbook).mockResolvedValueOnce({
      bids: [["0.48", "100"]],
      asks: [["0.52", "100"]],
    });

    const price = await getCurrentPrice("token-test");
    expect(price).toBe(0.5); // (0.48 + 0.52) / 2
  });
});
