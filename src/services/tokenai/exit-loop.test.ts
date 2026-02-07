import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TokenPosition } from "../database/tokenai.js";

// Mock dependencies before importing module under test
vi.mock("../database/tokenai.js", () => ({
  loadOpenTokenPositions: vi.fn().mockReturnValue([]),
  updateTokenPosition: vi.fn(),
}));

vi.mock("./position-manager.js", () => ({
  shouldExitTokenPosition: vi.fn().mockResolvedValue({
    shouldExit: false,
    reason: "",
  }),
  updatePeakPrice: vi.fn(),
  clearPeakPrice: vi.fn(),
}));

vi.mock("../telegram/notifications.js", () => ({
  notifyTokenAIExit: vi.fn().mockResolvedValue(undefined),
}));

import {
  startTokenExitLoop,
  stopTokenExitLoop,
  priceFeed,
} from "./exit-loop.js";
import {
  loadOpenTokenPositions,
  updateTokenPosition,
} from "../database/tokenai.js";
import {
  shouldExitTokenPosition,
  updatePeakPrice,
  clearPeakPrice,
} from "./position-manager.js";

const mockedLoadOpenPositions = vi.mocked(loadOpenTokenPositions);
const mockedUpdatePosition = vi.mocked(updateTokenPosition);
const mockedShouldExit = vi.mocked(shouldExitTokenPosition);
const mockedUpdatePeak = vi.mocked(updatePeakPrice);
const mockedClearPeak = vi.mocked(clearPeakPrice);

function makePosition(overrides: Partial<TokenPosition> = {}): TokenPosition {
  return {
    id: `pos_${Math.random().toString(36).slice(2, 8)}`,
    tokenAddress: "0xabc123def456",
    chain: "solana",
    tokenSymbol: "TEST",
    side: "long",
    entryPrice: 1.0,
    sizeUsd: 10,
    amountTokens: 10,
    aiProbability: 0.7,
    confidence: 0.6,
    kellyFraction: 0.2,
    status: "open",
    entryTimestamp: Date.now(),
    ...overrides,
  };
}

// Store original price getter to restore in afterEach
const originalGetPrice = priceFeed.getCurrentTokenPrice;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockedLoadOpenPositions.mockReturnValue([]);
  // Reset price feed to default (returns null)
  priceFeed.getCurrentTokenPrice = originalGetPrice;
});

afterEach(() => {
  stopTokenExitLoop();
  vi.useRealTimers();
  priceFeed.getCurrentTokenPrice = originalGetPrice;
});

describe("startTokenExitLoop / stopTokenExitLoop", () => {
  it("checks positions immediately on start", async () => {
    const position = makePosition();
    mockedLoadOpenPositions.mockReturnValue([position]);

    startTokenExitLoop(1000);

    // Flush the immediate async call
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedLoadOpenPositions).toHaveBeenCalledOnce();
  });

  it("checks positions on each interval tick", async () => {
    mockedLoadOpenPositions.mockReturnValue([]);

    startTokenExitLoop(1000);

    // Flush immediate call
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedLoadOpenPositions).toHaveBeenCalledTimes(1);

    // Advance by one interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockedLoadOpenPositions).toHaveBeenCalledTimes(2);
  });

  it("triggers exit and updates database", async () => {
    const position = makePosition({ id: "pos_exit_test", entryPrice: 1.0 });
    mockedLoadOpenPositions.mockReturnValue([position]);

    // Inject price feed that returns a value
    priceFeed.getCurrentTokenPrice = async () => 0.7;

    mockedShouldExit.mockResolvedValueOnce({
      shouldExit: true,
      reason: "Stop-loss: -30.0% loss",
    });

    startTokenExitLoop(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedUpdatePeak).toHaveBeenCalledWith("pos_exit_test", 0.7);
    expect(mockedShouldExit).toHaveBeenCalledWith(position, 0.7);
    expect(mockedUpdatePosition).toHaveBeenCalledWith("pos_exit_test", {
      status: "closed",
      exitTimestamp: expect.any(Number),
      exitPrice: 0.7,
      exitReason: "Stop-loss: -30.0% loss",
      pnl: expect.any(Number),
    });
    expect(mockedClearPeak).toHaveBeenCalledWith("pos_exit_test");
  });

  it("hold does not update database", async () => {
    const position = makePosition({ id: "pos_hold" });
    mockedLoadOpenPositions.mockReturnValue([position]);

    priceFeed.getCurrentTokenPrice = async () => 1.05;

    mockedShouldExit.mockResolvedValueOnce({
      shouldExit: false,
      reason: "",
    });

    startTokenExitLoop(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedShouldExit).toHaveBeenCalledWith(position, 1.05);
    expect(mockedUpdatePosition).not.toHaveBeenCalled();
  });

  it("null price skips position entirely", async () => {
    const position = makePosition({ id: "pos_no_price" });
    mockedLoadOpenPositions.mockReturnValue([position]);

    // Default price feed returns null (placeholder)
    startTokenExitLoop(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedShouldExit).not.toHaveBeenCalled();
    expect(mockedUpdatePosition).not.toHaveBeenCalled();
    expect(mockedUpdatePeak).not.toHaveBeenCalled();
  });

  it("stop clears the interval", async () => {
    mockedLoadOpenPositions.mockReturnValue([]);

    startTokenExitLoop(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedLoadOpenPositions).toHaveBeenCalledTimes(1);

    stopTokenExitLoop();

    // Advance timer - should NOT trigger more calls
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockedLoadOpenPositions).toHaveBeenCalledTimes(1);
  });

  it("double start is ignored", async () => {
    mockedLoadOpenPositions.mockReturnValue([]);

    startTokenExitLoop(1000);
    startTokenExitLoop(1000); // second call should be ignored

    await vi.advanceTimersByTimeAsync(0);

    // Only 1 immediate call (not 2)
    expect(mockedLoadOpenPositions).toHaveBeenCalledTimes(1);

    // Advance by 1 interval
    await vi.advanceTimersByTimeAsync(1000);

    // Only 2 calls total (1 immediate + 1 interval), not 3
    expect(mockedLoadOpenPositions).toHaveBeenCalledTimes(2);
  });
});
